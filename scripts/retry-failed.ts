import { MessageStore, databaseConfig } from '../lib/message-store.ts';
import { loadEnvFile } from '../server.ts';
loadEnvFile(new URL('../.env', import.meta.url).pathname);
const id = process.argv[2] || '';
if (!/^[1-9][0-9]*$/.test(id) || BigInt(id) > 9223372036854775807n) {
  console.error('用法: node scripts/retry-failed.ts <任务ID>'); process.exitCode = 1;
} else {
  try {
    const store = await MessageStore.open(databaseConfig(), 'admin');
    try { console.log(`重新排队任务数: ${await store.retryFailed(id)}`); }
    finally { await store.close(); }
  } catch { console.error('无法重发：请检查数据库连接和 schema 版本'); process.exitCode = 1; }
}
