import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { MessageStore, databaseConfig } from '../lib/message-store.ts';
import type { DatabaseConfig } from '../lib/message-store.ts';
import { testDatabase } from './database.ts';

const message = (msgid: string) => ({ msgid, origin: 3, external_userid: 'user', msgtype: 'text', text: {content:'hello'} });
async function seed(store: MessageStore, ids: string[]) {
  await store.notify('kf');
  await store.acceptPage((await store.syncReady())!, ids.map(message), 'cursor', false, 100);
}
function admin(cfg: DatabaseConfig) {
  return new Pool({connectionString:cfg.databaseUrl,options:`-c search_path=${cfg.databaseSchema},pg_catalog`,connectionTimeoutMillis:2000});
}

test('PostgreSQL config is required; SQLite cannot be selected implicitly', () => {
  assert.throws(() => databaseConfig({SQLITE_PATH:':memory:'}), /DATABASE_URL/);
  assert.throws(() => databaseConfig({DATABASE_URL:'sqlite:///tmp/bot'}), /PostgreSQL/);
  assert.throws(() => databaseConfig({DATABASE_URL:'postgres://u:p@localhost/db',DATABASE_SCHEMA:'x;drop schema public'}), /标识符/);
  assert.throws(() => databaseConfig({DATABASE_URL:'postgres://u:p@localhost/db',DATABASE_POOL_SIZE:'1'}), /2–100/);
});

test('worker ownership prevents a second instance from resetting processing jobs; admin is read-only at open', async () => {
  const cfg=testDatabase();const store=await MessageStore.open(cfg);const sql=admin(cfg);
  let inspector: MessageStore | undefined;
  try {
    await seed(store,['one']);const job=(await store.nextJobs(1))[0];await store.start(job);
    await assert.rejects(MessageStore.open(cfg), /已有机器人/);
    inspector=await MessageStore.open(cfg,'admin');await inspector.status();
    assert.equal((await sql.query('SELECT status FROM inbox WHERE id=$1',[job.id])).rows[0].status,'processing');
  } finally {await inspector?.close();await store.close();await sql.end();}
  const restarted=await MessageStore.open(cfg);
  try {assert.equal((await restarted.nextJobs(1))[0].status,'pending');} finally {await restarted.close();}
});

test('concurrent quota reservations never exceed the limit or double-charge the same message', async () => {
  const cfg=testDatabase();const store=await MessageStore.open(cfg);const sql=admin(cfg);
  try {
    await seed(store,['a','b','c','d','e']);
    const jobs=(await sql.query('SELECT * FROM inbox ORDER BY id')).rows;
    const allowed=await Promise.all(jobs.map(job=>store.charge(job,2,'2026-09-28')));
    assert.equal(allowed.filter(Boolean).length,2);
    const charged=jobs[allowed.indexOf(true)];
    assert.deepEqual(await Promise.all(Array.from({length:5},()=>store.charge(charged,2,'2026-09-28'))),[true,true,true,true,true]);
    assert.equal((await sql.query('SELECT count FROM daily_usage')).rows[0].count,2);
  } finally {await store.close();await sql.end();}
});

test('reply commit is atomic and idempotent, including retries after subsequent session changes', async () => {
  const store=await MessageStore.open(testDatabase());
  try {
    await seed(store,['one','two']);const first=(await store.nextJobs(1))[0];await store.start(first);
    await assert.rejects(store.saveReply(first,'must roll back',['first','invalid\0text']));
    assert.equal(await store.session(first.user_key),undefined);assert.deepEqual(await store.parts(first),[]);
    await Promise.all([store.saveReply(first,'original',['one','two']),store.saveReply(first,'original',['one','two'])]);
    assert.equal((await store.parts(first)).length,2);
    await store.done(first);const second=(await store.nextJobs(1))[0];
    await store.saveReply(second,'new session',['later']);
    await store.saveReply(first,'stale session',['duplicate']);
    assert.equal(await store.session(first.user_key),'new session');
    assert.equal((await store.parts(first)).length,2);
  } finally {await store.close();}
});

test('page transaction rolls back all messages and preserves notifications arriving during a pull', async () => {
  const store=await MessageStore.open(testDatabase());
  try {
    await store.notify('kf');const snapshot=(await store.syncReady())!;
    await assert.rejects(store.acceptPage(snapshot,[message('one'),{...message('two'),open_kfid:'other'}],'bad',false,100),/其他客服/);
    assert.equal(await store.pendingCount(),0);assert.equal((await store.syncReady())!.cursor,'');
    await store.notify('kf'); // arrives after the snapshot was taken
    await store.acceptPage(snapshot,[message('one')],'next',false,100);
    assert.equal((await store.syncReady())!.cursor,'next');
  } finally {await store.close();}
});

test('losing the advisory-lock connection fences the old worker', async () => {
  const cfg=testDatabase();const store=await MessageStore.open(cfg);const sql=admin(cfg);
  try {
    const lock=await sql.query(`SELECT pid FROM pg_locks WHERE locktype='advisory'
      AND classid::bigint=(hashtext(current_database())::bigint & 4294967295)
      AND objid::bigint=(hashtext($1)::bigint & 4294967295)`,[`wecom-ai-bot:${cfg.databaseSchema}`]);
    assert.equal(lock.rows.length,1);
    await sql.query('SELECT pg_terminate_backend($1)',[lock.rows[0].pid]);
    for(let i=0;i<100 && store.healthy;i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(store.healthy,false);
    await assert.rejects(store.notify('kf'),/DATABASE_UNAVAILABLE/);
    const replacement=await MessageStore.open(cfg);await replacement.close();
  } finally {await store.close();await sql.end();}
});

test('newer migration version rejects startup without resetting jobs', async () => {
  const cfg=testDatabase();const store=await MessageStore.open(cfg);const sql=admin(cfg);
  await seed(store,['one']);const job=(await store.nextJobs(1))[0];await store.start(job);await store.close();
  try {
    await sql.query('INSERT INTO schema_migrations VALUES(2)');
    await assert.rejects(MessageStore.open(cfg),/版本/);
    assert.equal((await sql.query('SELECT status FROM inbox')).rows[0].status,'processing');
  } finally {await sql.end();}
});
