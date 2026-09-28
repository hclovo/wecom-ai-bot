import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { createHash } from 'node:crypto';
import type { KfMessage } from './wecom-api.ts';

export interface DatabaseConfig {
  databaseUrl: string;
  databaseSchema: string;
  databaseTimeoutMs: number;
  databasePoolSize: number;
}
export interface Job {
  // PostgreSQL bigint is deliberately kept as a string, avoiding JS integer precision loss.
  id: string; kfid: string; msgid: string; user_key: string; payload: string;
  status: string; attempts: number; charged: number;
}
export interface SyncJob { kfid: string; cursor: string; revision: number; attempts: number }
export interface ReplyPart { part: number; msgid: string; content: string }

export function databaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const databaseUrl = env.DATABASE_URL || '';
  let url: URL;
  try { url = new URL(databaseUrl); } catch { throw new Error('请配置有效的 DATABASE_URL（PostgreSQL 连接地址）'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL 必须使用 PostgreSQL');
  const databaseSchema = env.DATABASE_SCHEMA || 'wecom_bot';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(databaseSchema)) throw new Error('DATABASE_SCHEMA 必须为小写 SQL 标识符');
  const databaseTimeoutMs = Number(env.DATABASE_TIMEOUT_MS || 2000);
  const databasePoolSize = Number(env.DATABASE_POOL_SIZE || 10);
  if (!Number.isSafeInteger(databaseTimeoutMs) || databaseTimeoutMs < 100 || databaseTimeoutMs > 30000) throw new Error('DATABASE_TIMEOUT_MS 范围为 100–30000');
  if (!Number.isSafeInteger(databasePoolSize) || databasePoolSize < 2 || databasePoolSize > 100) throw new Error('DATABASE_POOL_SIZE 范围为 2–100');
  // The schema and server timeouts are controlled here, not by connection-string options.
  url.searchParams.delete('options');
  return { databaseUrl: url.toString(), databaseSchema, databaseTimeoutMs, databasePoolSize };
}

export class MessageStore {
  private pool: Pool;
  private owner?: PoolClient;
  private closed = false;
  private valid = true;
  get healthy(): boolean { return this.valid && !this.closed; }

  private constructor(cfg: DatabaseConfig) {
    this.pool = new Pool({
      connectionString: cfg.databaseUrl,
      max: cfg.databasePoolSize,
      connectionTimeoutMillis: cfg.databaseTimeoutMs,
      statement_timeout: cfg.databaseTimeoutMs,
      query_timeout: cfg.databaseTimeoutMs + 500,
      idleTimeoutMillis: 10000,
      keepAlive: true,
      options: `-c search_path=${cfg.databaseSchema},pg_catalog -c lock_timeout=${cfg.databaseTimeoutMs} -c idle_in_transaction_session_timeout=${cfg.databaseTimeoutMs * 2}`,
    });
    this.pool.on('error', () => console.error('[database]', 'IDLE_CONNECTION_ERROR'));
  }

  static async open(cfg: DatabaseConfig, mode: 'worker' | 'admin' = 'worker'): Promise<MessageStore> {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(cfg.databaseSchema)) throw new Error('无效数据库 schema');
    const store = new MessageStore(cfg);
    try {
      if (mode === 'worker') {
        // A dedicated session owns this lock for the entire server lifetime. A second
        // worker must not reset processing jobs or reorder work in the same schema.
        store.owner = await store.pool.connect();
        store.owner.on('error', () => { store.valid = false; console.error('[database]', 'WORKER_LOCK_CONNECTION_LOST'); });
        store.owner.on('end', () => { store.valid = false; });
        const lock = await store.owner.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext($1)) AS locked', [`wecom-ai-bot:${cfg.databaseSchema}`],
        );
        if (!lock.rows[0].locked) throw new Error('已有机器人实例使用此数据库 schema，拒绝重复启动');
        await store.transaction(async (client) => {
          await client.query(`CREATE SCHEMA IF NOT EXISTS "${cfg.databaseSchema}"`);
          await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
          const versions = await client.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
          if ((versions.rows[0]?.version ?? 0) > 1) throw new Error('数据库版本高于程序版本，拒绝启动');
          if (!versions.rows.length) {
            await client.query(`
              CREATE TABLE sessions (user_key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at BIGINT NOT NULL);
              CREATE TABLE sync_jobs (
                kfid TEXT PRIMARY KEY, cursor TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
                dirty INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0, next_at BIGINT NOT NULL DEFAULT 0
              );
              CREATE TABLE inbox (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, kfid TEXT NOT NULL, msgid TEXT NOT NULL, user_key TEXT NOT NULL,
                payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                charged INTEGER NOT NULL DEFAULT 0, next_at BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL,
                UNIQUE(kfid,msgid)
              );
              CREATE INDEX inbox_ready ON inbox(status,next_at,id);
              CREATE INDEX inbox_user ON inbox(user_key,id);
              CREATE TABLE outbox (
                job_id BIGINT NOT NULL REFERENCES inbox(id) ON DELETE CASCADE, part INTEGER NOT NULL,
                msgid TEXT NOT NULL, content TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(job_id,part)
              );
              CREATE TABLE daily_usage (user_key TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(user_key,day));
              INSERT INTO schema_migrations VALUES (1);
            `);
          }
          await client.query("UPDATE inbox SET status='pending' WHERE status='processing'");
        });
      } else {
        // Admin tools must not acquire a worker lease, migrate, or recover in-flight jobs.
        const version = await store.query<{ version: number }>('SELECT max(version) AS version FROM schema_migrations');
        if (version.rows[0]?.version !== 1) throw new Error('不支持的数据库版本，请先启动对应版本服务');
      }
      return store;
    } catch (error) { await store.close(); throw error; }
  }

  private assertHealthy(): void { if (!this.healthy) throw new Error('DATABASE_UNAVAILABLE'); }
  private async query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    this.assertHealthy();
    return this.pool.query<T>(sql, values);
  }
  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    this.assertHealthy();
    const client = await this.pool.connect();
    let destroy = false;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      this.assertHealthy();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { destroy = true; }
      throw error;
    } finally { client.release(destroy); }
  }
  async notify(kfid: string): Promise<void> {
    await this.query(`INSERT INTO sync_jobs(kfid) VALUES ($1) ON CONFLICT(kfid) DO UPDATE SET
      dirty=1, revision=sync_jobs.revision+1, attempts=0, next_at=0`, [kfid]);
  }
  async syncReady(): Promise<SyncJob | undefined> {
    return (await this.query<SyncJob>('SELECT * FROM sync_jobs WHERE dirty=1 AND next_at<=$1 ORDER BY next_at,kfid LIMIT 1', [Date.now()])).rows[0];
  }
  async acceptPage(job: SyncJob, messages: KfMessage[], cursor: string, more: boolean, capacity: number): Promise<void> {
    await this.transaction(async (client) => {
      // Serialize page commits. Incoming notifications can still increase revision before this lock is acquired.
      await client.query('SELECT kfid FROM sync_jobs WHERE kfid=$1 FOR UPDATE', [job.kfid]);
      for (const msg of messages) {
        if (msg.origin !== 3 || !msg.external_userid || !msg.msgid) continue;
        if (msg.open_kfid && msg.open_kfid !== job.kfid) throw new Error('同步返回了其他客服账号的消息');
        await client.query(`INSERT INTO inbox(kfid,msgid,user_key,payload,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(kfid,msgid) DO NOTHING`,
          [job.kfid, msg.msgid, JSON.stringify([job.kfid, msg.external_userid]), JSON.stringify(msg), Date.now()]);
      }
      const count = await client.query("SELECT count(*) AS n FROM inbox WHERE status NOT IN ('sent','failed')");
      if (Number(count.rows[0].n) > capacity) throw new Error('QUEUE_FULL');
      await client.query(`UPDATE sync_jobs SET cursor=$1, dirty=CASE WHEN revision=$2 AND $3=0 THEN 0 ELSE 1 END,
        attempts=0,next_at=0 WHERE kfid=$4`, [cursor, job.revision, Number(more), job.kfid]);
    });
  }
  async deferSync(job: SyncJob, delay: number): Promise<void> {
    await this.query('UPDATE sync_jobs SET attempts=attempts+1,next_at=$1 WHERE kfid=$2 AND revision=$3',
      [Date.now() + Math.round(delay), job.kfid, job.revision]);
  }
  async pollKnown(): Promise<void> { await this.query('UPDATE sync_jobs SET dirty=1 WHERE dirty=0'); }
  async pendingCount(): Promise<number> {
    return Number((await this.query("SELECT count(*) AS n FROM inbox WHERE status NOT IN ('sent','failed')")).rows[0].n);
  }
  async nextJobs(limit: number): Promise<Job[]> {
    return (await this.query<Job>(`SELECT i.* FROM inbox i WHERE i.status IN ('pending','reply_ready') AND i.next_at<=$1
      AND NOT EXISTS (SELECT 1 FROM inbox older WHERE older.user_key=i.user_key AND older.id<i.id AND older.status NOT IN ('sent','failed'))
      ORDER BY i.next_at,i.id LIMIT $2`, [Date.now(), limit])).rows;
  }
  async start(job: Job): Promise<void> {
    if (job.status === 'pending') await this.query("UPDATE inbox SET status='processing' WHERE id=$1 AND status='pending'", [job.id]);
  }
  async session(key: string): Promise<string | undefined> {
    return (await this.query<{ data: string }>('SELECT data FROM sessions WHERE user_key=$1', [key])).rows[0]?.data;
  }
  async charge(job: Job, limit: number, day = new Date().toISOString().slice(0, 10)): Promise<boolean> {
    return this.transaction(async (client) => {
      const row = await client.query('SELECT charged FROM inbox WHERE id=$1 FOR UPDATE', [job.id]);
      if (!row.rows.length) throw new Error('消息任务不存在');
      if (row.rows[0].charged) return true;
      const quota = await client.query(`INSERT INTO daily_usage VALUES($1,$2,1)
        ON CONFLICT(user_key,day) DO UPDATE SET count=daily_usage.count+1 WHERE daily_usage.count<$3 RETURNING count`, [job.user_key, day, limit]);
      if (!quota.rows.length) return false;
      await client.query('UPDATE inbox SET charged=1 WHERE id=$1', [job.id]);
      return true;
    });
  }
  async saveReply(job: Job, session: string | undefined, chunks: string[]): Promise<void> {
    await this.transaction(async (client) => {
      const row = await client.query('SELECT status FROM inbox WHERE id=$1 FOR UPDATE', [job.id]);
      if (!row.rows.length) throw new Error('消息任务不存在');
      // COMMIT may succeed while its network acknowledgement is lost. Repeating this
      // transaction must not duplicate parts or overwrite a later session snapshot.
      if (['reply_ready', 'sent', 'failed'].includes(row.rows[0].status)) return;
      if (session !== undefined) await client.query('INSERT INTO sessions VALUES($1,$2,$3) ON CONFLICT(user_key) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
        [job.user_key, session, Date.now()]);
      for (const [part, content] of chunks.entries()) {
        const msgid = createHash('sha256').update(JSON.stringify([job.kfid, job.msgid, part])).digest('hex').slice(0, 32);
        await client.query('INSERT INTO outbox(job_id,part,msgid,content) VALUES($1,$2,$3,$4)', [job.id, part, msgid, content]);
      }
      await client.query("UPDATE inbox SET status=$1,attempts=0,next_at=0,payload='{}' WHERE id=$2", [chunks.length ? 'reply_ready' : 'sent', job.id]);
    });
  }
  async parts(job: Job): Promise<ReplyPart[]> {
    return (await this.query<ReplyPart>('SELECT part,msgid,content FROM outbox WHERE job_id=$1 AND sent=0 ORDER BY part', [job.id])).rows;
  }
  async markPart(job: Job, part: number): Promise<void> {
    await this.query("UPDATE outbox SET sent=1,content='' WHERE job_id=$1 AND part=$2", [job.id, part]);
  }
  async done(job: Job): Promise<void> { await this.query("UPDATE inbox SET status='sent' WHERE id=$1", [job.id]); }
  async defer(job: Job, delay: number, terminal: boolean): Promise<void> {
    await this.query('UPDATE inbox SET status=$1,attempts=attempts+1,next_at=$2 WHERE id=$3',
      [terminal ? 'failed' : 'reply_ready', Date.now() + Math.round(delay), job.id]);
  }
  async cleanup(retentionDays: number): Promise<void> {
    const cutoff = Date.now() - retentionDays * 86400000;
    await this.transaction(async (client) => {
      await client.query("DELETE FROM inbox WHERE status IN ('sent','failed') AND created_at<$1", [cutoff]);
      await client.query(`DELETE FROM sessions s WHERE updated_at<$1 AND NOT EXISTS
        (SELECT 1 FROM inbox i WHERE i.user_key=s.user_key AND i.status NOT IN ('sent','failed'))`, [cutoff]);
      await client.query('DELETE FROM daily_usage WHERE day<$1', [new Date(cutoff).toISOString().slice(0, 10)]);
    });
  }
  async status(): Promise<object> {
    const jobs = await this.query('SELECT status,count(*)::integer AS count FROM inbox GROUP BY status');
    const oldest = await this.query("SELECT coalesce($1::bigint-min(created_at),0) AS age FROM inbox WHERE status NOT IN ('sent','failed')", [Date.now()]);
    const sync = await this.query('SELECT count(*)::integer AS count FROM sync_jobs WHERE dirty=1');
    const failed = await this.query("SELECT id FROM inbox WHERE status='failed' ORDER BY id LIMIT 100");
    return { jobs: jobs.rows, oldestPendingMs: Number(oldest.rows[0].age), pendingSyncAccounts: sync.rows[0].count, failedJobIds: failed.rows };
  }
  async retryFailed(id: string): Promise<number> {
    const result = await this.query("UPDATE inbox SET status='reply_ready',attempts=0,next_at=0 WHERE id=$1 AND status='failed'", [id]);
    return result.rowCount ?? 0;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Destroying this connection releases the session-scoped advisory lock even when
    // a prior statement failed or the backend already disconnected.
    this.owner?.release(true);
    await this.pool.end();
  }
}
