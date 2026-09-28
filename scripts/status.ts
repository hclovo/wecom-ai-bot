import { DatabaseSync } from 'node:sqlite';
import { loadEnvFile } from '../server.ts';
loadEnvFile(new URL('../.env', import.meta.url).pathname);
const db = new DatabaseSync(process.env.SQLITE_PATH || './data/bot.sqlite', { readOnly: true });
try {
  console.log(JSON.stringify({
    jobs: db.prepare('SELECT status,count(*) AS count FROM inbox GROUP BY status').all(),
    oldestPendingMs: db.prepare("SELECT coalesce(?-min(created_at),0) AS age FROM inbox WHERE status NOT IN ('sent','failed')").get(Date.now())?.age,
    pendingSyncAccounts: db.prepare('SELECT count(*) AS count FROM sync_jobs WHERE dirty=1').get()?.count,
    failedJobIds: db.prepare("SELECT id FROM inbox WHERE status='failed' ORDER BY id LIMIT 100").all(),
  }, null, 2));
} finally { db.close(); }
