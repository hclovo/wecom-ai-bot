import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { KfMessage } from './wecom-api.ts';

export interface Job {
  id: number; kfid: string; msgid: string; user_key: string; payload: string;
  status: string; attempts: number; charged: number;
}
export interface SyncJob { kfid: string; cursor: string; revision: number; attempts: number }

export class MessageStore {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 1) { this.db.close(); throw new Error('数据库版本高于程序版本，拒绝启动'); }
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS sessions (user_key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_jobs (
        kfid TEXT PRIMARY KEY, cursor TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS inbox (
        id INTEGER PRIMARY KEY, kfid TEXT NOT NULL, msgid TEXT NOT NULL, user_key TEXT NOT NULL,
        payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        charged INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        UNIQUE(kfid,msgid)
      );
      CREATE INDEX IF NOT EXISTS inbox_ready ON inbox(status,next_at,id);
      CREATE INDEX IF NOT EXISTS inbox_user ON inbox(user_key,id);
      CREATE TABLE IF NOT EXISTS outbox (
        job_id INTEGER NOT NULL REFERENCES inbox(id) ON DELETE CASCADE, part INTEGER NOT NULL,
        msgid TEXT NOT NULL, content TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(job_id,part)
      );
      CREATE TABLE IF NOT EXISTS daily_usage (user_key TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(user_key,day));
      PRAGMA user_version=1;
      COMMIT;
    `);
    // Only one process may own this DB. Interrupted model jobs are retried; saved replies are preserved.
    this.db.exec("UPDATE inbox SET status='pending' WHERE status='processing'");
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  notify(kfid: string): void {
    this.db.prepare(`INSERT INTO sync_jobs(kfid) VALUES (?) ON CONFLICT(kfid) DO UPDATE SET
      dirty=1, revision=revision+1, attempts=0, next_at=0`).run(kfid);
  }
  syncReady(): SyncJob | undefined {
    return this.db.prepare('SELECT * FROM sync_jobs WHERE dirty=1 AND next_at<=? ORDER BY next_at,kfid LIMIT 1').get(Date.now()) as unknown as SyncJob | undefined;
  }
  acceptPage(job: SyncJob, messages: KfMessage[], cursor: string, more: boolean, capacity: number): void {
    this.transaction(() => {
      for (const msg of messages) {
        if (msg.origin !== 3 || !msg.external_userid || !msg.msgid) continue;
        if (msg.open_kfid && msg.open_kfid !== job.kfid) throw new Error('同步返回了其他客服账号的消息');
        this.db.prepare(`INSERT OR IGNORE INTO inbox(kfid,msgid,user_key,payload,created_at) VALUES(?,?,?,?,?)`)
          .run(job.kfid, msg.msgid, JSON.stringify([job.kfid, msg.external_userid]), JSON.stringify(msg), Date.now());
      }
      if (this.pendingCount() > capacity) throw new Error('QUEUE_FULL'); // rollback page AND cursor
      this.db.prepare(`UPDATE sync_jobs SET cursor=?, dirty=CASE WHEN revision=? AND ?=0 THEN 0 ELSE 1 END,
        attempts=0,next_at=0 WHERE kfid=?`).run(cursor, job.revision, Number(more), job.kfid);
    });
  }
  deferSync(job: SyncJob, delay: number): void {
    this.db.prepare('UPDATE sync_jobs SET attempts=attempts+1,next_at=? WHERE kfid=? AND revision=?')
      .run(Date.now() + delay, job.kfid, job.revision);
  }
  pollKnown(): void { this.db.exec('UPDATE sync_jobs SET dirty=1 WHERE dirty=0'); }
  pendingCount(): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM inbox WHERE status NOT IN ('sent','failed')").get()!.n);
  }
  nextJobs(limit: number): Job[] {
    // Earliest live message per user; delayed retries also block later commands for that user.
    return this.db.prepare(`SELECT i.* FROM inbox i WHERE i.status IN ('pending','reply_ready') AND i.next_at<=?
      AND NOT EXISTS (SELECT 1 FROM inbox older WHERE older.user_key=i.user_key AND older.id<i.id AND older.status NOT IN ('sent','failed'))
      ORDER BY i.next_at,i.id LIMIT ?`).all(Date.now(), limit) as unknown as Job[];
  }
  start(job: Job): void {
    if (job.status === 'pending') this.db.prepare("UPDATE inbox SET status='processing' WHERE id=?").run(job.id);
  }
  session(key: string): string | undefined {
    return this.db.prepare('SELECT data FROM sessions WHERE user_key=?').get(key)?.data as string | undefined;
  }
  charge(job: Job, limit: number, day = new Date().toISOString().slice(0, 10)): boolean {
    return this.transaction(() => {
      if (this.db.prepare('SELECT charged FROM inbox WHERE id=?').get(job.id)?.charged) return true;
      const n = Number(this.db.prepare('SELECT count FROM daily_usage WHERE user_key=? AND day=?').get(job.user_key, day)?.count ?? 0);
      if (n >= limit) return false;
      this.db.prepare('INSERT INTO daily_usage VALUES(?,?,1) ON CONFLICT(user_key,day) DO UPDATE SET count=count+1').run(job.user_key, day);
      this.db.prepare('UPDATE inbox SET charged=1 WHERE id=?').run(job.id);
      return true;
    });
  }
  saveReply(job: Job, session: string | undefined, chunks: string[]): void {
    this.transaction(() => {
      if (session !== undefined) this.db.prepare('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(user_key) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at')
        .run(job.user_key, session, Date.now());
      chunks.forEach((content, part) => {
        const msgid = createHash('sha256').update(JSON.stringify([job.kfid, job.msgid, part])).digest('hex').slice(0, 32);
        this.db.prepare('INSERT INTO outbox(job_id,part,msgid,content) VALUES(?,?,?,?)').run(job.id, part, msgid, content);
      });
      this.db.prepare("UPDATE inbox SET status=?,attempts=0,next_at=0,payload='{}' WHERE id=?").run(chunks.length ? 'reply_ready' : 'sent', job.id);
    });
  }
  parts(job: Job): Array<{part: number; msgid: string; content: string}> {
    return this.db.prepare('SELECT part,msgid,content FROM outbox WHERE job_id=? AND sent=0 ORDER BY part').all(job.id) as unknown as Array<{part: number; msgid: string; content: string}>;
  }
  markPart(job: Job, part: number): void {
    this.db.prepare("UPDATE outbox SET sent=1,content='' WHERE job_id=? AND part=?").run(job.id, part);
  }
  done(job: Job): void { this.db.prepare("UPDATE inbox SET status='sent' WHERE id=?").run(job.id); }
  defer(job: Job, delay: number, terminal: boolean): void {
    this.db.prepare('UPDATE inbox SET status=?,attempts=attempts+1,next_at=? WHERE id=?')
      .run(terminal ? 'failed' : 'reply_ready', Date.now() + delay, job.id);
  }
  recoverModel(job: Job): void {
    this.db.prepare("UPDATE inbox SET status='pending',next_at=? WHERE id=?").run(Date.now() + 5000, job.id);
  }
  cleanup(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 86400000;
    this.transaction(() => {
      this.db.prepare("DELETE FROM inbox WHERE status IN ('sent','failed') AND created_at<?").run(cutoff);
      this.db.prepare('DELETE FROM sessions WHERE updated_at<?').run(cutoff);
      this.db.prepare('DELETE FROM daily_usage WHERE day<?').run(new Date(cutoff).toISOString().slice(0, 10));
    });
  }
  close(): void { this.db.close(); }
}
