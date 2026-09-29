import { testDatabase, databaseEnv } from './database.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
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
  ...databaseEnv(), RETRY_BASE_MS: '10', UPSTREAM_TIMEOUT_MS: '100', LLM_TIMEOUT_MS: '100', SYNC_POLL_MS: '60000', MAX_HISTORY_TURNS: '2',
});
const msg = (id: string, user = 'user', content = 'hello') => ({ msgid: id, external_userid: user, origin: 3, msgtype: 'text', text: { content } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await cond())) { if (Date.now() > end) throw new Error('condition timed out'); await sleep(10); }
}
async function add(store: MessageStore, messages = [msg('one')], cursor = 'next') {
  await store.notify('kf'); const job = (await store.syncReady())!; await store.acceptPage(job, messages, cursor, false, 100);
}
async function callback(bot: Awaited<ReturnType<typeof createServer>>, receiver = cfg.corpId, kfid = 'kf', bodyOverride?: string): Promise<number> {
  const encrypted = encrypt(`<xml><Event>kf_msg_or_event</Event><OpenKfId>${kfid}</OpenKfId><Token>cb</Token></xml>`, cfg.aesKey, receiver);
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/webhook?timestamp=1&nonce=n&msg_signature='+sha1Signature(cfg.token,'1','n',encrypted) });
  let complete!: () => void; const ended = new Promise<void>((r) => { complete = r; });
  const res = { status: 0, headersSent: false, writeHead(n: number) { this.status=n; this.headersSent=true; return this; }, end() { complete(); } };
  bot.emit('request', req, res);
  req.emit('data', Buffer.from(bodyOverride ?? `<xml><Encrypt>${encrypted}</Encrypt></xml>`)); req.emit('end');
  await ended; return res.status;
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
  const bot = await createServer({...cfg,...testDatabase()});
  try {
    assert.equal(await callback(bot, 'wrong'), 401);
    assert.equal(await callback(bot, cfg.corpId, 'other'), 200);
    assert.equal(await bot.worker.store.syncReady(), undefined);
    assert.equal(await callback(bot, cfg.corpId, 'kf', 'x'.repeat(65537)), 413);
    assert.equal(await bot.worker.store.syncReady(), undefined);
  } finally { await bot.stopWorker(); }
});

test('inbox, cursor, quota and partial outbox survive restart; capacity rollback is atomic', async () => {
  const dbConfig = testDatabase();
  let store = await MessageStore.open(dbConfig);
  try {
    await add(store); const job = (await store.nextJobs(1))[0];
    assert.equal(await store.charge(job, 1, '2026-09-28'), true);
    await store.start(job);
    await store.saveReply(job, 'saved-session', ['first', 'second']); await store.markPart(job, 0);
    const stableId = (await store.parts(job))[0].msgid;
    await store.close(); store = await MessageStore.open(dbConfig);
    assert.equal(await store.session(job.user_key), 'saved-session');
    assert.equal((await store.parts(job)).length, 1); assert.equal((await store.parts(job))[0].msgid, stableId);
    assert.equal(await store.charge(job, 1, '2026-09-28'), true);
    await add(store, [msg('one'),msg('two')]); // duplicate first is ignored
    assert.equal((await store.pendingCount()), 2);
    await store.notify('kf'); const sync = (await store.syncReady())!;
    await assert.rejects(() => store.acceptPage(sync,[msg('three')],'bad-cursor',false,2), /QUEUE_FULL/);
    assert.equal((await store.syncReady())!.cursor,'next'); assert.equal((await store.pendingCount()),2);
    await store.done(job);
    assert.equal(await store.charge((await store.nextJobs(1))[0],1,'2026-09-28'),false);
  } finally { await store.close();  }
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
  const worker = await MessageWorker.create({...cfg,...testDatabase()}, async () => {models++; return {chunks:['ok']};});
  try {
    await worker.notify('kf','cb');
    await until(async () => sends === 1 && (await worker.store.pendingCount()) === 0);
    assert.equal(pulls,2); assert.equal(models,1);
    await worker.notify('kf','cb'); await until(async () => pulls === 3); await sleep(50);
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
  const worker = await MessageWorker.create({...cfg,...testDatabase()},async (m) => {
    handled.push(m.msgid); if (m.msgid === 'slow') await gate;
    return {chunks:[m.msgid]};
  });
  try {
    await add(worker.store,[msg('slow','A'),msg('reset','A','/reset'),msg('fast','B')]); worker.start();
    await until(async () => sent.includes('fast'));
    assert.deepEqual(handled,['slow','fast']); assert.equal(attempts,2);
    release(); await until(async () => (await worker.store.pendingCount()) === 0);
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
  const bot = await createServer({...cfg,...testDatabase()}); const store=bot.worker.store;
  try {
    await add(store,[{...msg('file'),msgtype:'file',file:{media_id:'m',file_name:'notes.txt'}}] as any);
    bot.worker.start(); await until(async () => (await store.pendingCount())===0);
    await add(store,[msg('followup','user','预算是多少？')]); await until(async () => chats.length===2 && (await store.pendingCount())===0);
    assert.ok(JSON.stringify(chats[1]).includes('123'));
    for (let i=0;i<4;i++) {
      await add(store,[{...msg('img'+i),msgtype:'image',image:{media_id:'m'}}] as any);
      await until(async () => (await store.pendingCount())===0);
    }
    const session=JSON.parse((await store.session(JSON.stringify(['kf','user'])))!);
    assert.equal(session.conversations[0].history.length,4);
    assert.equal(session.conversations[0].history[0].role,'user');
    await add(store,[msg('reset','user','/reset'),msg('after')]); await until(async () => (await store.pendingCount())===0);
    assert.equal(chats.at(-1).messages.length,2);
  } finally {await bot.stopWorker();}
});

test('PostgreSQL write failure retries the saved result without recharging or rerunning model', async (t) => {
  clearTokenCache(); let models=0, sent=0, writes=0;
  t.mock.method(globalThis,'fetch',async (url: string | URL | Request) => {
    if (String(url).includes('gettoken')) return Response.json({errcode:0,access_token:'token',expires_in:7200});
    sent++; return Response.json({errcode:0});
  });
  const worker=await MessageWorker.create({...cfg,...testDatabase()},async () => {models++; return {chunks:['saved']};});
  const original=worker.store.saveReply.bind(worker.store);
  t.mock.method(worker.store,'saveReply', async (...args: Parameters<typeof original>) => {
    if (++writes===1) throw new Error('DATABASE_WRITE_ERROR'); return original(...args);
  });
  try {
    await add(worker.store); worker.start(); await until(async () => sent===1 && (await worker.store.pendingCount())===0);
    assert.equal(models,1); assert.equal(writes,2);
  } finally {await worker.stop();}
});

test('persisted outbox restart sends only unfinished parts without model invocation', async (t) => {
  const dbConfig=testDatabase();
  const store=await MessageStore.open(dbConfig);await add(store);const job=(await store.nextJobs(1))[0];
  await store.saveReply(job,'session',['already sent','remaining']);await store.markPart(job,0);await store.close();
  clearTokenCache(); const sent: string[]=[]; let models=0;
  t.mock.method(globalThis,'fetch',async (url: string | URL | Request,init?: RequestInit) => {
    if(String(url).includes('gettoken')) return Response.json({errcode:0,access_token:'token',expires_in:7200});
    sent.push(JSON.parse(String(init?.body)).text.content);return Response.json({errcode:0});
  });
  const worker=await MessageWorker.create({...cfg,...dbConfig},async()=>{models++;return {chunks:['unexpected']};});
  try {worker.start();await until(async()=>(await worker.store.pendingCount())===0);assert.deepEqual(sent,['remaining']);assert.equal(models,0);}
  finally {await worker.stop();}
});

test('quota rejects further model requests, permits commands and isolates users', async (t) => {
  clearTokenCache();const models: string[]=[];const sent: string[]=[];
  t.mock.method(globalThis,'fetch',async(url: string | URL | Request,init?: RequestInit)=>{
    if(String(url).includes('gettoken')) return Response.json({errcode:0,access_token:'token',expires_in:7200});
    sent.push(JSON.parse(String(init?.body)).text.content);return Response.json({errcode:0});
  });
  const worker=await MessageWorker.create({...cfg,...testDatabase(),dailyRequestLimit:1},async(m)=>{models.push(m.msgid);return {chunks:[m.msgid]};});
  try {
    await add(worker.store,[msg('first'),msg('blocked'),msg('command','user','/help'),msg('other','B')]);worker.start();
    await until(async()=>(await worker.store.pendingCount())===0);
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
  const bot=await createServer({...cfg,...testDatabase()});
  try {
    await add(bot.worker.store,[{...msg('office'),msgtype:'file',file:{media_id:'office',file_name:'a.docx'}}] as any);
    bot.worker.start();await until(async()=>(await bot.worker.store.pendingCount())===0);
    assert.ok(!calls.some(c=>c.includes('/media/get')));
    await add(bot.worker.store,[{...msg('pdf'),msgtype:'file',file:{media_id:'pdf',file_name:'a.pdf'}}] as any);
    await until(async()=>(await bot.worker.store.pendingCount())===0);
    assert.ok(calls.some(c=>c.endsWith('/responses')));
  } finally {await bot.stopWorker();}
});

test('draw command uses text model, sends a real image, retries without regeneration and consumes quota',async(t)=>{
  clearTokenCache();let models=0,uploads=0,imageSends=0;const texts:string[]=[];
  t.mock.method(globalThis,'fetch',async(url:string|URL|Request,init?:RequestInit)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/gettoken'))return Response.json({errcode:0,access_token:'token',expires_in:7200});
    if(path.endsWith('/chat/completions')){
      models++;const request=JSON.parse(String(init?.body));assert.ok(request.messages[0].content.includes('SVG'));
      return Response.json({choices:[{message:{content:'<svg><rect width="1024" height="1024" fill="#28a"/><text x="100" y="200">你好</text></svg>'}}]});
    }
    if(path.endsWith('/media/upload')){
      uploads++;const media=(init!.body as FormData).get('media') as Blob;
      assert.equal(media.type,'image/jpeg');assert.ok(media.size<2*1024*1024);
      return Response.json({media_id:'generated'});
    }
    assert.ok(path.endsWith('/send_msg'));
    const request=JSON.parse(String(init?.body));
    if(request.msgtype==='image'){
      imageSends++;assert.deepEqual(request.image,{media_id:'generated'});
      if(imageSends===1)return new Response('',{status:503});
    }else texts.push(request.text.content);
    return Response.json({errcode:0});
  });
  const bot=await createServer({...cfg,...testDatabase(),dailyRequestLimit:1});
  try{
    await add(bot.worker.store,[msg('draw-1','user','/draw 猫'),msg('draw-2','user','画图：狗')]);bot.worker.start();
    await until(async()=>await bot.worker.store.pendingCount()===0,5000);
    assert.equal(models,1);assert.equal(uploads,1);assert.equal(imageSends,2);assert.ok(texts.some(s=>s.includes('上限')));
  }finally{await bot.stopWorker();}
});

test('ordinary API conversation uses Cursor drawing and sends text then image without regenerating on retry', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'wecom-mixed-'));
  const bin = join(dir, 'agent');
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'blue' } }).png().toBuffer();
  await writeFile(bin, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[args.indexOf('--model')+1]!=='draw-model')process.exit(2);
if(args.includes('--mode'))process.exit(4);
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
if(!input.includes('付款流程图'))process.exit(3);
console.log(JSON.stringify({type:'tool_call',subtype:'completed',tool_call:{generateImageToolCall:{result:{success:{filePath:'assets/actual-output.png',imageData:'${png.toString('base64')}'}}}}}));
console.log(JSON.stringify({type:'result',result:'完成'}));
});
`, { mode: 0o700 });
  clearTokenCache();
  let models = 0, uploads = 0, imageSends = 0;
  const sent: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/gettoken')) return Response.json({ errcode: 0, access_token: 'token', expires_in: 7200 });
    if (path.endsWith('/chat/completions')) {
      models++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, cfg.llmModel);
      assert.equal(body.messages.at(-1).content, '解释付款流程，配张图');
      return Response.json({ choices: [{ message: { content: '{"text":"先下单，再付款。","image_prompt":"付款流程图：下单、付款、完成"}' } }] });
    }
    if (path.endsWith('/media/upload')) { uploads++; return Response.json({ media_id: 'mixed-image' }); }
    assert.ok(path.endsWith('/send_msg'));
    const body = JSON.parse(String(init?.body));
    sent.push(body.msgtype);
    if (body.msgtype === 'image' && ++imageSends === 1) return new Response('', { status: 503 });
    if (body.msgtype === 'text') assert.equal(body.text.content, '先下单，再付款。');
    return Response.json({ errcode: 0 });
  });
  const bot = await createServer({ ...cfg, ...testDatabase(), imageProvider: 'cursor', cursorBin: bin,
    cursorStateDir: join(dir, 'state'), cursorImageModel: 'draw-model', nativeImageTimeoutMs: 5000 });
  try {
    await add(bot.worker.store, [msg('mixed', 'user', '解释付款流程，配张图')]);
    bot.worker.start();
    await until(async () => await bot.worker.store.pendingCount() === 0, 10000);
    assert.deepEqual(sent, ['text', 'image', 'image']);
    assert.equal(models, 1); assert.equal(uploads, 1);
    const session = await bot.worker.store.session(JSON.stringify(['kf', 'user']));
    assert.match(session!, /已生成配图/);
    assert.ok(!session!.includes('image_prompt'));
  } finally { await bot.stopWorker(); await rm(dir, { recursive: true, force: true }); }
});

test('HTML attachment sends after text, refreshes expired media, retries without regeneration and clears delivered content', async t => {
  clearTokenCache(); let models = 0, uploads = 0, sends = 0, texts = 0;
  const ids: string[] = [];
  const html = '<!doctype html><meta charset="utf-8"><h1>骑车的鹈鹕</h1>';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/gettoken')) return Response.json({ errcode: 0, access_token: 'token', expires_in: 7200 });
    if (parsed.pathname.endsWith('/chat/completions')) {
      models++;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ text: '文件做好了。', image_prompt: null,
        files: [{ filename: '动画.html', content: html }] }) } }] });
    }
    if (parsed.pathname.endsWith('/media/upload')) {
      uploads++; assert.equal(parsed.searchParams.get('type'), 'file');
      const media = (init!.body as FormData).get('media') as File;
      assert.equal(media.name, '动画.html'); assert.equal(await media.text(), html);
      return Response.json({ media_id: `file-${uploads}` });
    }
    assert.ok(parsed.pathname.endsWith('/send_msg'));
    const body = JSON.parse(String(init?.body));
    if (body.msgtype === 'text') { texts++; assert.equal(body.text.content, '文件做好了。'); }
    else {
      assert.equal(body.msgtype, 'file'); sends++; ids.push(body.msgid);
      assert.equal(body.file.media_id, sends === 1 ? 'file-1' : 'file-2');
      if (sends === 1) return Response.json({ errcode: 40007 });
      if (sends === 2) return new Response('', { status: 503 });
    }
    return Response.json({ errcode: 0 });
  });
  const db = testDatabase(); const bot = await createServer({ ...cfg, ...db });
  try {
    await add(bot.worker.store, [msg('html', 'user', '把骑车的鹈鹕发成HTML文件')]); bot.worker.start();
    await until(async () => await bot.worker.store.pendingCount() === 0, 10000);
    assert.equal(models, 1); assert.equal(uploads, 2); assert.equal(texts, 1); assert.equal(sends, 3);
    assert.equal(new Set(ids).size, 1);
    assert.match((await bot.worker.store.session(JSON.stringify(['kf', 'user'])))!, /骑车的鹈鹕/);
    const { Pool } = await import('pg'); const pool = new Pool({ connectionString: db.databaseUrl });
    try {
      const row = (await pool.query(`SELECT content,filename,media_id,sent FROM "${db.databaseSchema}".outbox WHERE kind='file'`)).rows[0];
      assert.deepEqual(row, { content: '', filename: null, media_id: null, sent: 1 });
    } finally { await pool.end(); }
  } finally { await bot.stopWorker(); }
});

test('saved file attachment survives restart with its filename and no model invocation', async t => {
  const db = testDatabase(); const store = await MessageStore.open(db);
  const { textFileReply } = await import('../lib/file-reply.ts');
  await add(store, [msg('saved-file')]); const job = (await store.nextJobs(1))[0];
  await store.saveReply(job, 'session', ['done', textFileReply('example.html', '<html>hello</html>')]);
  await store.markPart(job, 0); await store.close();
  clearTokenCache(); let sent = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/gettoken')) return Response.json({ errcode: 0, access_token: 'token', expires_in: 7200 });
    if (path.endsWith('/media/upload')) {
      assert.equal(((init!.body as FormData).get('media') as File).name, 'example.html');
      return Response.json({ media_id: 'saved-file-media' });
    }
    assert.ok(path.endsWith('/send_msg')); assert.equal(JSON.parse(String(init?.body)).msgtype, 'file'); sent++;
    return Response.json({ errcode: 0 });
  });
  let models = 0;
  const worker = await MessageWorker.create({ ...cfg, ...db }, async () => { models++; throw new Error('must not regenerate'); });
  try { worker.start(); await until(async () => await worker.store.pendingCount() === 0); assert.equal(models, 0); assert.equal(sent, 1); }
  finally { await worker.stop(); }
});

test('progress is silent for fast tasks, sent once for slow tasks and never arrives after the answer', async t => {
  clearTokenCache(); const sent: string[] = [];
  let finishModel!: () => void, finishNotice!: () => void;
  const model = new Promise<void>(resolve => { finishModel = resolve; });
  const notice = new Promise<void>(resolve => { finishNotice = resolve; });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/gettoken')) return Response.json({ errcode: 0, access_token: 'token', expires_in: 7200 });
    const body = JSON.parse(String(init?.body)); sent.push(body.text.content);
    if (body.text.content.includes('正在处理')) await notice;
    return Response.json({ errcode: 0 });
  });
  const worker = await MessageWorker.create({ ...cfg, ...testDatabase(), progressNoticeMs: 40 }, async message => {
    if (message.msgid === 'slow') await model;
    return { chunks: [`结果:${message.msgid}`] };
  });
  try {
    await add(worker.store, [msg('fast')]); worker.start();
    await until(async () => await worker.store.pendingCount() === 0);
    assert.deepEqual(sent, ['结果:fast']);
    await add(worker.store, [msg('slow')]);
    await until(() => sent.some(s => s.includes('正在处理')));
    finishModel(); await sleep(30);
    assert.ok(!sent.includes('结果:slow'));
    finishNotice();
    await until(async () => await worker.store.pendingCount() === 0);
    assert.deepEqual(sent, ['结果:fast', '正在处理，请稍等，完成后会发给你。', '结果:slow']);
  } finally { finishModel(); finishNotice(); await worker.stop(); }
});

test('failed progress delivery does not fail the task or enter final-reply retries', async t => {
  clearTokenCache(); const sent: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/gettoken')) return Response.json({ errcode: 0, access_token: 'token', expires_in: 7200 });
    const text = JSON.parse(String(init?.body)).text.content; sent.push(text);
    return text.includes('正在处理') ? new Response('', { status: 503 }) : Response.json({ errcode: 0 });
  });
  const worker = await MessageWorker.create({ ...cfg, ...testDatabase(), progressNoticeMs: 20 }, async () => {
    await sleep(100); return { chunks: ['完成'] };
  });
  try {
    await add(worker.store, [msg('progress-error')]); worker.start();
    await until(async () => await worker.store.pendingCount() === 0);
    assert.deepEqual(sent, ['正在处理，请稍等，完成后会发给你。', '完成']);
  } finally { await worker.stop(); }
});

test('progress reservation survives restart and commands never receive progress notices', async t => {
  const db = testDatabase(); const store = await MessageStore.open(db);
  await add(store, [msg('recovered')]); const job = (await store.nextJobs(1))[0];
  await store.start(job); assert.ok(await store.claimProgress(job, '正在处理'));
  assert.equal(await store.claimProgress(job, '正在处理'), undefined);
  await store.close();
  clearTokenCache(); const sent: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/gettoken')) return Response.json({ errcode: 0, access_token: 'token', expires_in: 7200 });
    sent.push(JSON.parse(String(init?.body)).text.content); return Response.json({ errcode: 0 });
  });
  const worker = await MessageWorker.create({ ...cfg, ...db, progressNoticeMs: 20 }, async () => { await sleep(80); return { chunks: ['完成'] }; });
  try {
    worker.start(); await until(async () => await worker.store.pendingCount() === 0);
    await add(worker.store, [msg('command', 'user', '/help')]);
    await until(async () => await worker.store.pendingCount() === 0);
    assert.deepEqual(sent, ['完成', '完成']);
  } finally { await worker.stop(); }
});

test('new activity produces more than two progress notices without a fixed count cap', async t => {
  clearTokenCache(); const sent: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/gettoken')) return Response.json({ errcode: 0, access_token: 'token', expires_in: 7200 });
    sent.push(JSON.parse(String(init?.body)).text.content); return Response.json({ errcode: 0 });
  });
  const worker = await MessageWorker.create({ ...cfg, ...testDatabase(), progressNoticeMs: 10, progressIntervalMs: 20 }, async (_msg, _session, progress) => {
    const timer = setInterval(() => progress.activity('image'), 10);
    try { await until(() => sent.length >= 4); return { chunks: ['完成'] }; }
    finally { clearInterval(timer); }
  });
  try {
    await add(worker.store, [msg('long-active')]); worker.start();
    await until(async () => await worker.store.pendingCount() === 0);
    assert.ok(sent.length >= 5); assert.equal(sent.at(-1), '完成');
  } finally { await worker.stop(); }
});

test('completed public text is sent during generation and omitted from the final reply', async t => {
  clearTokenCache(); const sent: string[] = [];
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/gettoken')) return Response.json({ errcode: 0, access_token: 'token', expires_in: 7200 });
    sent.push(JSON.parse(String(init?.body)).text.content); return Response.json({ errcode: 0 });
  });
  const worker = await MessageWorker.create({ ...cfg, ...testDatabase(), progressNoticeMs: 10, progressIntervalMs: 20 }, async (_msg, _session, progress) => {
    progress.text('第一部分已完成。'); await wait;
    return { chunks: ['第一部分已完成。', '这是剩余结果。'] };
  });
  try {
    await add(worker.store, [msg('partial')]); worker.start();
    await until(() => sent.includes('第一部分已完成。'));
    assert.ok(await worker.store.pendingCount() > 0);
    finish(); await until(async () => await worker.store.pendingCount() === 0);
    assert.deepEqual(sent, ['第一部分已完成。', '这是剩余结果。']);
  } finally { finish(); await worker.stop(); }
});

test('channel refusal stops progress attempts but generation and final delivery still run', async t => {
  clearTokenCache(); const sent: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/gettoken')) return Response.json({ errcode: 0, access_token: 'token', expires_in: 7200 });
    const text = JSON.parse(String(init?.body)).text.content; sent.push(text);
    return Response.json(text === '完成' ? { errcode: 0 } : { errcode: 45009 });
  });
  const worker = await MessageWorker.create({ ...cfg, ...testDatabase(), progressNoticeMs: 10, progressIntervalMs: 20 }, async (_msg, _session, progress) => {
    const timer = setInterval(() => progress.activity(), 10);
    try { await sleep(120); return { chunks: ['完成'] }; } finally { clearInterval(timer); }
  });
  try {
    await add(worker.store, [msg('channel-limit')]); worker.start();
    await until(async () => await worker.store.pendingCount() === 0);
    assert.equal(sent.length, 2); assert.equal(sent.at(-1), '完成');
  } finally { await worker.stop(); }
});

test('saved generated image survives restart and refreshes expired media without a model call',async(t)=>{
  const dbConfig=testDatabase();const store=await MessageStore.open(dbConfig);
  const {renderSvg}=await import('../lib/image-generation.ts');
  const image=await renderSvg('<svg><circle cx="400" cy="400" r="200" fill="red"/></svg>');
  await add(store);const job=(await store.nextJobs(1))[0];
  await store.saveReply(job,undefined,[image]);await store.setMedia(job,0,'old',Date.now()+60000);await store.close();
  clearTokenCache();let models=0,uploads=0,sends=0;
  t.mock.method(globalThis,'fetch',async(url:string|URL|Request,init?:RequestInit)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/gettoken'))return Response.json({errcode:0,access_token:'token',expires_in:7200});
    if(path.endsWith('/media/upload')){uploads++;return Response.json({media_id:'fresh'});}
    assert.ok(path.endsWith('/send_msg'));sends++;
    const body=JSON.parse(String(init?.body));assert.equal(body.image.media_id,sends===1?'old':'fresh');
    return Response.json({errcode:sends===1?40007:0});
  });
  const worker=await MessageWorker.create({...cfg,...dbConfig},async()=>{models++;return{chunks:['unexpected']};});
  try{worker.start();await until(async()=>await worker.store.pendingCount()===0);assert.equal(models,0);assert.equal(uploads,1);assert.equal(sends,2);}
  finally{await worker.stop();}
});
