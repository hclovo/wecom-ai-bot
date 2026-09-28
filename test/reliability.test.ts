import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { MessageStore } from '../lib/message-store.ts';
import { MessageWorker } from '../lib/message-worker.ts';
import { getMedia, clearTokenCache, syncMessages } from '../lib/wecom-api.ts';
import { requestBytes } from '../lib/http-client.ts';
import { waitFileActive } from '../lib/ark-files.ts';
import { createServer, loadConfig, splitReply } from '../server.ts';
import { encrypt, sha1Signature } from '../lib/wecom-crypto.ts';

const cfg = loadConfig({ WECOM_CORP_ID: 'corp', WECOM_KF_SECRET: 'SECRET', WECOM_TOKEN: 'token',
  WECOM_ENCODING_AES_KEY: Buffer.alloc(32, 1).toString('base64').slice(0,43),
  WECOM_OPEN_KFID: 'kf', LLM_BASE_URL: 'https://mock', LLM_API_KEY: 'LLM_SECRET', LLM_MODEL: 'model',
  SQLITE_PATH: ':memory:', RETRY_BASE_MS: '10', UPSTREAM_TIMEOUT_MS: '100', SYNC_POLL_MS: '60000', MAX_HISTORY_TURNS: '2',
});
const msg = (id: string, user = 'user', content = 'hello') => ({ msgid: id, external_userid: user, origin: 3, msgtype: 'text', text: { content } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('condition timed out'); await sleep(10); }
}
function add(store: MessageStore, messages = [msg('one')], cursor = 'next') {
  store.notify('kf'); const job = store.syncReady()!; store.acceptPage(job, messages, cursor, false, 100);
}
function callback(bot: ReturnType<typeof createServer>, receiver = cfg.corpId, kfid = 'kf', bodyOverride?: string): number {
  const encrypted = encrypt(`<xml><Event>kf_msg_or_event</Event><OpenKfId>${kfid}</OpenKfId><Token>cb</Token></xml>`, cfg.aesKey, receiver);
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/webhook?timestamp=1&nonce=n&msg_signature='+sha1Signature(cfg.token,'1','n',encrypted) });
  const res = { status: 0, writeHead(n: number) { this.status=n; return this; }, end() {} };
  bot.emit('request', req, res);
  req.emit('data', Buffer.from(bodyOverride ?? `<xml><Encrypt>${encrypted}</Encrypt></xml>`)); req.emit('end');
  return res.status;
}

test('Unicode reply chunks preserve input and obey UTF-8 byte budget', () => {
  const input = ('中文😀a\n').repeat(1000); const chunks = splitReply(input);
  assert.equal(chunks.join(''), input);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 1000 && !chunk.includes('\uFFFD')));
});

test('media business errors refresh once; real JSON files remain valid; logs never contain credentials', async (t) => {
  clearTokenCache(); let tokens = 0, media = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url).includes('gettoken')) return Response.json({errcode:0, access_token:`token${++tokens}`,expires_in:7200});
    media++;
    assert.equal(new URL(String(url)).pathname, '/cgi-bin/media/get');
    return media === 1 ? Response.json({errcode:42001,errmsg:'expired'}) : Response.json({foo:'bar'});
  });
  assert.equal((await getMedia(cfg, 'media')).toString(), '{"foo":"bar"}');
  assert.equal(tokens, 2); assert.equal(media, 2);
  t.mock.restoreAll(); clearTokenCache();
  t.mock.method(globalThis, 'fetch', async () => new Response('SECRET access_token=token', {status:503}));
  await assert.rejects(syncMessages(cfg, {}), (e: Error) => !e.message.includes('SECRET') && !e.message.includes('token') && e.message.includes('503'));
});

test('download limit stops stream and file polling fails promptly on authentication error', async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; },
  })));
  await assert.rejects(requestBytes('https://mock', {}, {maxBytes:10}), /大小/);
  assert.ok(cancelled);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('', {status:401}));
  await assert.rejects(waitFileActive({baseUrl:'https://mock',apiKey:'secret',fileId:'f',timeoutMs:10000}), /401/);
});

test('POST rejects wrong receiver, filters accounts and bounds request body', async () => {
  const bot = createServer(cfg);
  try {
    assert.equal(callback(bot, 'wrong'), 401);
    assert.equal(callback(bot, cfg.corpId, 'other'), 200);
    assert.equal(bot.worker.store.syncReady(), undefined);
    assert.equal(callback(bot, cfg.corpId, 'kf', 'x'.repeat(65537)), 413);
    assert.equal(bot.worker.store.syncReady(), undefined);
  } finally { await bot.stopWorker(); }
});

test('inbox, cursor, quota and partial outbox survive restart; capacity rollback is atomic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-store-')); const path = join(dir,'bot.sqlite');
  let store = new MessageStore(path);
  try {
    add(store); const job = store.nextJobs(1)[0];
    assert.equal(store.charge(job, 1, '2026-09-28'), true);
    store.start(job);
    store.saveReply(job, 'saved-session', ['first', 'second']); store.markPart(job, 0);
    const stableId = store.parts(job)[0].msgid;
    store.close(); store = new MessageStore(path);
    assert.equal(store.session(job.user_key), 'saved-session');
    assert.equal(store.parts(job).length, 1); assert.equal(store.parts(job)[0].msgid, stableId);
    assert.equal(store.charge(job, 1, '2026-09-28'), true);
    add(store, [msg('one'),msg('two')]); // duplicate first is ignored
    assert.equal(store.pendingCount(), 2);
    store.notify('kf'); const sync = store.syncReady()!;
    assert.throws(() => store.acceptPage(sync,[msg('three')],'bad-cursor',false,2), /QUEUE_FULL/);
    assert.equal(store.syncReady()!.cursor,'next'); assert.equal(store.pendingCount(),2);
    store.done(job);
    assert.equal(store.charge(store.nextJobs(1)[0],1,'2026-09-28'),false);
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('worker drains empty has_more pages and deduplicates callbacks', async (t) => {
  clearTokenCache(); let pulls = 0, models = 0, sends = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('gettoken')) return Response.json({errcode:0,access_token:'token',expires_in:7200});
    if (String(url).includes('sync_msg')) {
      pulls++; const body = JSON.parse(String(init?.body));
      assert.equal(body.token,'cb');
      return Response.json(pulls === 1 ? {errcode:0,has_more:1,next_cursor:'p1',msg_list:[]} : {errcode:0,has_more:0,next_cursor:'p2',msg_list:[msg('one'),msg('one')]});
    }
    sends++; return Response.json({errcode:0});
  });
  const worker = new MessageWorker(cfg, async () => {models++; return {chunks:['ok']};});
  try {
    worker.notify('kf','cb');
    await until(() => sends === 1 && worker.store.pendingCount() === 0);
    assert.equal(pulls,2); assert.equal(models,1);
    worker.notify('kf','cb'); await until(() => pulls === 3); await sleep(50);
    assert.equal(sends,1);
  } finally { await worker.stop(); }
});

test('worker isolates users, orders same-user commands and retries saved replies without repeating model', async (t) => {
  clearTokenCache(); const handled: string[] = []; const sent: string[] = []; let attempts = 0;
  let release!: () => void; const gate = new Promise<void>((r) => { release=r; });
  t.mock.method(globalThis,'fetch',async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('gettoken')) return Response.json({errcode:0,access_token:'token',expires_in:7200});
    const body = JSON.parse(String(init?.body));
    if (body.text.content === 'fast' && attempts++ === 0) return new Response('',{status:503});
    sent.push(body.text.content); return Response.json({errcode:0});
  });
  const worker = new MessageWorker(cfg,async (m) => {
    handled.push(m.msgid); if (m.msgid === 'slow') await gate;
    return {chunks:[m.msgid]};
  });
  try {
    add(worker.store,[msg('slow','A'),msg('reset','A','/reset'),msg('fast','B')]); worker.start();
    await until(() => sent.includes('fast'));
    assert.deepEqual(handled,['slow','fast']); assert.equal(attempts,2);
    release(); await until(() => worker.store.pendingCount() === 0);
    assert.deepEqual(handled,['slow','fast','reset']);
    assert.deepEqual(sent,['fast','slow','reset']);
  } finally { release(); await worker.stop(); }
});

test('server applies all-modality history bounds and text-file followup, reset removes file context', async (t) => {
  clearTokenCache(); let chats: any[] = [];
  t.mock.method(globalThis,'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const u=String(url);
    if (u.includes('gettoken')) return Response.json({errcode:0,access_token:'token',expires_in:7200});
    if (u.includes('/media/get')) return new Response('预算 123 元');
    if (u.includes('/chat/completions')) {chats.push(JSON.parse(String(init?.body)));return Response.json({choices:[{message:{content:'summary'}}]});}
    if (u.includes('send_msg')) return Response.json({errcode:0});
    throw new Error('unexpected URL');
  });
  const bot = createServer(cfg); const store=bot.worker.store;
  try {
    add(store,[{...msg('file'),msgtype:'file',file:{media_id:'m',file_name:'notes.txt'}}] as any);
    bot.worker.start(); await until(() => store.pendingCount()===0);
    add(store,[msg('followup','user','预算是多少？')]); await until(() => chats.length===2 && store.pendingCount()===0);
    assert.ok(JSON.stringify(chats[1]).includes('123'));
    for (let i=0;i<4;i++) {
      add(store,[{...msg('img'+i),msgtype:'image',image:{media_id:'m'}}] as any);
      await until(() => store.pendingCount()===0);
    }
    const session=JSON.parse(store.session(JSON.stringify(['kf','user']))!);
    assert.equal(session.conversations[0].history.length,4);
    assert.equal(session.conversations[0].history[0].role,'user');
    add(store,[msg('reset','user','/reset'),msg('after')]); await until(() => store.pendingCount()===0);
    assert.equal(chats.at(-1).messages.length,2);
  } finally {await bot.stopWorker();}
});

test('SQLite write failure retries the saved result without recharging or rerunning model', async (t) => {
  clearTokenCache(); let models=0, sent=0, writes=0;
  t.mock.method(globalThis,'fetch',async (url: string | URL | Request) => {
    if (String(url).includes('gettoken')) return Response.json({errcode:0,access_token:'token',expires_in:7200});
    sent++; return Response.json({errcode:0});
  });
  const worker=new MessageWorker(cfg,async () => {models++; return {chunks:['saved']};});
  const original=worker.store.saveReply.bind(worker.store);
  t.mock.method(worker.store,'saveReply', (...args: Parameters<typeof original>) => {
    if (++writes===1) throw new Error('SQLITE_BUSY'); return original(...args);
  });
  try {
    add(worker.store); worker.start(); await until(() => sent===1 && worker.store.pendingCount()===0);
    assert.equal(models,1); assert.equal(writes,2);
  } finally {await worker.stop();}
});

test('persisted outbox restart sends only unfinished parts without model invocation', async (t) => {
  const dir=mkdtempSync(join(tmpdir(),'wecom-restart-'));const path=join(dir,'db.sqlite');
  const store=new MessageStore(path);add(store);const job=store.nextJobs(1)[0];
  store.saveReply(job,'session',['already sent','remaining']);store.markPart(job,0);store.close();
  clearTokenCache(); const sent: string[]=[]; let models=0;
  t.mock.method(globalThis,'fetch',async (url: string | URL | Request,init?: RequestInit) => {
    if(String(url).includes('gettoken')) return Response.json({errcode:0,access_token:'token',expires_in:7200});
    sent.push(JSON.parse(String(init?.body)).text.content);return Response.json({errcode:0});
  });
  const worker=new MessageWorker({...cfg,sqlitePath:path},async()=>{models++;return {chunks:['unexpected']};});
  try {worker.start();await until(()=>worker.store.pendingCount()===0);assert.deepEqual(sent,['remaining']);assert.equal(models,0);}
  finally {await worker.stop();rmSync(dir,{recursive:true,force:true});}
});

test('quota rejects further model requests, permits commands and isolates users', async (t) => {
  clearTokenCache();const models: string[]=[];const sent: string[]=[];
  t.mock.method(globalThis,'fetch',async(url: string | URL | Request,init?: RequestInit)=>{
    if(String(url).includes('gettoken')) return Response.json({errcode:0,access_token:'token',expires_in:7200});
    sent.push(JSON.parse(String(init?.body)).text.content);return Response.json({errcode:0});
  });
  const worker=new MessageWorker({...cfg,dailyRequestLimit:1},async(m)=>{models.push(m.msgid);return {chunks:[m.msgid]};});
  try {
    add(worker.store,[msg('first'),msg('blocked'),msg('command','user','/help'),msg('other','B')]);worker.start();
    await until(()=>worker.store.pendingCount()===0);
    assert.deepEqual(models.sort(),['command','first','other']);assert.ok(sent.some(s=>s.includes('上限')));
  } finally {await worker.stop();}
});

test('request timeout releases an in-flight fetch', async (t) => {
  t.mock.method(globalThis,'fetch',async(_url: unknown,init?: RequestInit)=>new Promise<Response>((_resolve,reject)=>{
    const signal=init!.signal!;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  }));
  // Keep the test event loop alive: AbortSignal.timeout itself is unref'ed.
  const keepAlive=setInterval(()=>{},100);
  try {await assert.rejects(requestBytes('https://mock',{}, {timeoutMs:20}), (e: Error)=>e.name==='TimeoutError');}
  finally {clearInterval(keepAlive);}
});

test('Office files are rejected before download and PDF upload uses official purpose', async (t) => {
  clearTokenCache();const calls: string[]=[];
  t.mock.method(globalThis,'fetch',async(url: string | URL | Request,init?: RequestInit)=>{
    const u=String(url);calls.push(u);
    if(u.includes('gettoken')) return Response.json({errcode:0,access_token:'token',expires_in:7200});
    if(u.includes('send_msg')) return Response.json({errcode:0});
    if(u.includes('/media/get')) return new Response('%PDF-fake');
    if(u.endsWith('/files')) {assert.equal((init!.body as FormData).get('purpose'),'user_data');return Response.json({id:'f'});}
    if(u.endsWith('/files/f')) return Response.json({id:'f',status:'active'});
    if(u.endsWith('/responses')) return Response.json({output_text:'summary'});
    throw new Error('unexpected');
  });
  const bot=createServer(cfg);
  try {
    add(bot.worker.store,[{...msg('office'),msgtype:'file',file:{media_id:'office',file_name:'a.docx'}}] as any);
    bot.worker.start();await until(()=>bot.worker.store.pendingCount()===0);
    assert.ok(!calls.some(c=>c.includes('/media/get')));
    add(bot.worker.store,[{...msg('pdf'),msgtype:'file',file:{media_id:'pdf',file_name:'a.pdf'}}] as any);
    await until(()=>bot.worker.store.pendingCount()===0);
    assert.ok(calls.some(c=>c.endsWith('/responses')));
  } finally {await bot.stopWorker();}
});
