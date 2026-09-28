import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { databaseConfig } from '../lib/message-store.ts';

// Never fall back to the application's DATABASE_URL. Every test owns a fresh schema.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('PostgreSQL 测试需要 TEST_DATABASE_URL，参见 DEPLOY.md 的本地测试章节');
const schemas = new Set<string>();
export function testDatabase() {
  const schema = `test_wecom_${randomUUID().replaceAll('-', '')}`;
  schemas.add(schema);
  return databaseConfig({ DATABASE_URL: url, DATABASE_SCHEMA: schema });
}
export function databaseEnv() {
  const cfg = testDatabase();
  return { DATABASE_URL: cfg.databaseUrl, DATABASE_SCHEMA: cfg.databaseSchema };
}
after(async () => {
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally { await pool.end(); }
});
