import { MessageStore, databaseConfig } from '../lib/message-store.ts';
import { loadEnvFile } from '../server.ts';
loadEnvFile(new URL('../.env', import.meta.url).pathname);
try {
  const store = await MessageStore.open(databaseConfig(), 'admin');
  try { console.log(JSON.stringify(await store.status(), null, 2)); }
  finally { await store.close(); }
} catch { console.error('无法读取状态：请检查数据库连接和 schema 版本'); process.exitCode = 1; }
