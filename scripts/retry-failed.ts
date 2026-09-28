import { DatabaseSync } from 'node:sqlite';
import { loadEnvFile } from '../server.ts';
loadEnvFile(new URL('../.env', import.meta.url).pathname);
const id = Number(process.argv[2]);
if (!Number.isSafeInteger(id) || id < 1) throw new Error('用法: node scripts/retry-failed.ts <任务ID>');
// Do not instantiate MessageStore: recovery of processing jobs belongs only to server startup.
const db = new DatabaseSync(process.env.SQLITE_PATH || './data/bot.sqlite');
try {
  db.exec('PRAGMA busy_timeout=5000;');
  const result = db.prepare("UPDATE inbox SET status='reply_ready',attempts=0,next_at=0 WHERE id=? AND status='failed'").run(id);
  console.log(`重新排队任务数: ${result.changes}`);
} finally { db.close(); }
