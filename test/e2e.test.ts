import { databaseEnv } from './database.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { encrypt, decrypt, sha1Signature } from '../lib/wecom-crypto.ts';
import { createServer, loadConfig, splitReply } from '../server.ts';
import { clearTokenCache } from '../lib/wecom-api.ts';

type Json = Record<string, any>;

// ---- 测试用配置 ----
const CFG = {
  port: 18788,
  corpId: 'wwtest000000000000',
  kfSecret: 'test-secret',
  token: 'testToken',
  aesKey: Buffer.from('0123456789abcdef0123456789abcdef0123456789', 'utf8').toString('base64').slice(0, 43),
  receiveId: 'wwtest000000000000',
  apiBase: 'http://127.0.0.1:18789',
  openKfId: 'wkAAAABBBBCCCCDDDD',
  llmBaseUrl: 'http://127.0.0.1:18790/v3', // 与方舟一致：chat/completions、files、responses 共用 base
  llmApiKey: 'test-llm-key',
  llmModel: 'test-model',
  systemPrompt: '你是测试机器人',
  maxTurns: 12,
};

const KFID = CFG.openKfId;
const USER = 'wmExternalUser001';

const IMG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]); // JPEG 魔数开头
const PDF_BYTES = Buffer.from('%PDF-1.7 fake pdf content for test');
const TXT_BYTES = Buffer.from('第一行：采购清单\n第二行：预算 100 元');

interface Calls {
  getToken: string[];
  syncMsg: Json[];
  sendMsg: Json[];
  mediaGet: Array<string | null>;
  chat: Json[];
  fileUpload: Array<{ contentType: string | undefined }>;
  responses: Json[];
}

interface StackState {
  pending: unknown[];
  media: Record<string, Buffer>;
}

function envFromCfg(): Record<string, string> {
  return {
    WECOM_CORP_ID: CFG.corpId,
    WECOM_KF_SECRET: CFG.kfSecret,
    WECOM_TOKEN: CFG.token,
    WECOM_ENCODING_AES_KEY: CFG.aesKey,
    WECOM_RECEIVE_ID: CFG.receiveId,
    WECOM_API_BASE: CFG.apiBase,
    WECOM_OPEN_KFID: CFG.openKfId,
    LLM_BASE_URL: CFG.llmBaseUrl,
    LLM_API_KEY: CFG.llmApiKey,
    LLM_MODEL: CFG.llmModel,
    LLM_SYSTEM_PROMPT: CFG.systemPrompt,
    PORT: String(CFG.port),
    ...databaseEnv(),
    RETRY_BASE_MS: '10',
  };
}

function makeCustomerMsg(overrides: Json = {}): Json {
  return {
    msgid: `msg-${Math.random().toString(36).slice(2)}`,
    open_kfid: KFID,
    external_userid: USER,
    origin: 3,
    send_time: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// ---- mock：企业微信 API（token / sync_msg / send_msg / media/get）----
function mockWecom(calls: Calls, state: StackState) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = req.url || '';
      if (url.startsWith('/cgi-bin/gettoken')) {
        calls.getToken.push(url);
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ errcode: 0, access_token: 'MOCK_TOKEN', expires_in: 7200 }));
        return;
      }
      if (url.startsWith('/cgi-bin/kf/sync_msg')) {
        calls.syncMsg.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ errcode: 0, next_cursor: 'cursor-1', msg_list: state.pending.splice(0) }));
        return;
      }
      if (url.startsWith('/cgi-bin/kf/send_msg')) {
        calls.sendMsg.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ errcode: 0, msgid: 'server-msg-1' }));
        return;
      }
      if (url.startsWith('/cgi-bin/media/get')) {
        const mediaId = new URL(url, 'http://x').searchParams.get('media_id');
        calls.mediaGet.push(mediaId);
        const buf = mediaId ? state.media[mediaId] : undefined;
        if (!buf) {
          res.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ errcode: 400306, errmsg: 'media not found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(buf);
        return;
      }
      res.writeHead(404).end();
    });
  });
}

// ---- mock：方舟 OpenAI 兼容接口（chat/completions + files + responses）----
function mockArk(calls: Calls) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = req.url || '';
      if (url.includes('/chat/completions')) {
        calls.chat.push(JSON.parse(body));
        const last = calls.chat[calls.chat.length - 1];
        const isVision = JSON.stringify(last.messages).includes('image_url');
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: isVision ? '图片里有秋天的风景。' : '秋风起，落叶飘。' } }],
          }));
        return;
      }
      if (url.endsWith('/files') && req.method === 'POST') {
        calls.fileUpload.push({ contentType: req.headers['content-type'] });
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ id: 'file-test-1', filename: 'report.pdf', status: 'processing' }));
        return;
      }
      if (url.match(/\/files\/[^/]+$/) && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ id: 'file-test-1', status: 'active' }));
        return;
      }
      if (url.includes('/responses')) {
        calls.responses.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({
            output: [{ type: 'message', content: [{ type: 'output_text', text: '这份 PDF 总结了三件事。' }] }],
          }));
        return;
      }
      res.writeHead(404).end();
    });
  });
}

// ---- 工具 ----
function signAndEncrypt(innerXml: string) {
  const enc = encrypt(innerXml, CFG.aesKey, CFG.receiveId);
  const ts = '1700000000';
  const nonce = 'nonce123';
  return { enc, ts, nonce, msg_signature: sha1Signature(CFG.token, ts, nonce, enc) };
}

function kfEventXml(token: string): string {
  return `<xml><ToUserName><![CDATA[${CFG.corpId}]]></ToUserName><FromUserName><![CDATA[sys]]></FromUserName>` +
    `<CreateTime>1700000000</CreateTime><MsgType><![CDATA[event]]></MsgType>` +
    `<Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[${token}]]></Token>` +
    `<OpenKfId><![CDATA[${KFID}]]></OpenKfId></xml>`;
}

async function postEvent(token = 'CALLBACK-TOKEN-1'): Promise<Response> {
  const { enc, ts, nonce, msg_signature: sig } = signAndEncrypt(kfEventXml(token));
  return fetch(`http://127.0.0.1:${CFG.port}/webhook?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`, {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body: `<xml><ToUserName><![CDATA[${CFG.corpId}]]></ToUserName><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`,
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = ''): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function freshCalls(): Calls {
  return { getToken: [], syncMsg: [], sendMsg: [], mediaGet: [], chat: [], fileUpload: [], responses: [] };
}

async function startStack(calls: Calls, state: StackState): Promise<{ stop: () => Promise<void> }> {
  clearTokenCache();
  const wecomMock = mockWecom(calls, state);
  const arkMock = mockArk(calls);
  const bot = await createServer(loadConfig(envFromCfg()));
  await Promise.all([[wecomMock, 18789], [arkMock, 18790], [bot, CFG.port]].map(([server, port]) =>
    new Promise<void>((resolve, reject) => (server as http.Server).once('error', reject).listen(port as number, '127.0.0.1', resolve))));
  const stop = async () => {
    await bot.stopWorker();
    wecomMock.closeAllConnections?.();
    arkMock.closeAllConnections?.();
    bot.closeAllConnections?.();
    await Promise.all([wecomMock, arkMock, bot].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  };
  return { stop };
}

// ---- 测试 ----

test('加解密往返', () => {
  const plain = '<xml><hello><![CDATA[world]]></hello></xml>';
  const enc = encrypt(plain, CFG.aesKey, CFG.corpId);
  const out = decrypt(enc, CFG.aesKey);
  assert.equal(out.message, plain);
  assert.equal(out.receiveId, CFG.corpId);
});

test('splitReply：短段落合并，超长切分', () => {
  assert.deepEqual(splitReply('a\n\nb'), ['a\n\nb']);
  assert.equal(splitReply('a\n\n' + 'x'.repeat(1001)).join(''), 'a\n\n' + 'x'.repeat(1001));
  assert.deepEqual(splitReply('y'.repeat(2500)), ['y'.repeat(1000), 'y'.repeat(1000), 'y'.repeat(500)]);
});

test('端到端：文本对话（验证回调 → 拉消息 → LLM → 回复 → 多轮历史）', async () => {
  const calls = freshCalls();
  const state: StackState = { pending: [], media: {} };
  const { stop } = await startStack(calls, state);
  try {
    state.pending = [makeCustomerMsg({ msgtype: 'text', text: { content: '在吗？帮我写首关于秋天的短诗' } })];

    // GET 验证：echostr 解密后原样返回
    const echostr = 'ECHO-PLAINTEXT-12345';
    const encEcho = encrypt(echostr, CFG.aesKey, CFG.receiveId);
    const ts = '1700000001', nonce = 'n1';
    const sig = sha1Signature(CFG.token, ts, nonce, encEcho);
    const verifyRes = await fetch(`http://127.0.0.1:${CFG.port}/webhook?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=${encodeURIComponent(encEcho)}`);
    assert.equal(await verifyRes.text(), echostr);

    // POST 回调事件（带 Token，触发 sync_msg）
    const postRes = await postEvent('CALLBACK-TOKEN-1');
    assert.equal(postRes.status, 200);

    await waitFor(() => calls.syncMsg.length >= 1, 5000, 'sync_msg 被调用');
    assert.equal(calls.syncMsg[0].token, 'CALLBACK-TOKEN-1');
    assert.equal(calls.syncMsg[0].cursor, '');

    // gettoken 必须带上真实的 kfSecret（防止字段名错位发出 corpsecret=undefined）
    await waitFor(() => calls.getToken.length >= 1, 5000, 'gettoken 被调用');
    const tokenQuery = new URL(calls.getToken[0], 'http://x').searchParams;
    assert.equal(tokenQuery.get('corpid'), CFG.corpId);
    assert.equal(tokenQuery.get('corpsecret'), CFG.kfSecret);

    await waitFor(() => calls.chat.length >= 1, 5000, 'LLM 被调用');
    const llmReq = calls.chat[0];
    assert.equal(llmReq.model, CFG.llmModel);
    assert.equal(llmReq.messages[0].role, 'system');
    assert.ok(llmReq.messages[0].content.startsWith(CFG.systemPrompt));
    assert.match(llmReq.messages[0].content, /image_prompt/);
    assert.deepEqual(llmReq.messages[llmReq.messages.length - 1], { role: 'user', content: '在吗？帮我写首关于秋天的短诗' });

    await waitFor(() => calls.sendMsg.length >= 1, 5000, 'send_msg 发出');
    assert.equal(calls.sendMsg[0].touser, USER);
    assert.equal(calls.sendMsg[0].open_kfid, KFID);
    assert.equal(calls.sendMsg[0].msgtype, 'text');
    assert.equal(calls.sendMsg[0].text.content, '秋风起，落叶飘。');
    assert.equal(calls.sendMsg.length, 1);

    // 第二轮对话带上历史（system + user + assistant + user）
    state.pending = [makeCustomerMsg({ msgtype: 'text', text: { content: '再写一句吧' } })];
    await postEvent('CALLBACK-TOKEN-2');
    await waitFor(() => calls.chat.length >= 2, 5000, '第二次 LLM 调用');
    const second = calls.chat[1].messages;
    assert.equal(second.length, 4); // system, user, assistant, user
    assert.deepEqual(second[1], { role: 'user', content: '在吗？帮我写首关于秋天的短诗' });
    assert.equal(second[2].content, '秋风起，落叶飘。');
    assert.equal(second[3].content, '再写一句吧');

    // 错误签名被拒
    const badRes = await fetch(`http://127.0.0.1:${CFG.port}/webhook?msg_signature=bad&timestamp=1&nonce=2&echostr=x`);
    assert.equal(badRes.status, 401);
  } finally {
    await stop();
  }
});

test('端到端：图片、PDF、文本文件与文件追问', async () => {
  const calls = freshCalls();
  const state: StackState = { pending: [], media: {} };
  const { stop } = await startStack(calls, state);
  try {
    // 1. 图片 → 媒体下载 → 视觉模型（image_url data URI）→ 回复
    state.media['m-img'] = IMG_BYTES;
    state.pending = [makeCustomerMsg({ msgtype: 'image', image: { media_id: 'm-img' } })];
    await postEvent('TOKEN-IMG');
    await waitFor(() => calls.sendMsg.length >= 1, 5000, '图片回复');
    assert.deepEqual(calls.mediaGet, ['m-img']);
    const visionReq = calls.chat[0];
    const visionContent = visionReq.messages[visionReq.messages.length - 1].content;
    assert.equal(visionContent[0].type, 'image_url');
    assert.ok(visionContent[0].image_url.url.startsWith('data:image/jpeg;base64,'));
    assert.equal(calls.sendMsg[0].text.content, '图片里有秋天的风景。');

    // 2. PDF → 媒体下载 → Files API 上传 → 轮询 active → Responses API → 回复 + 引导追问
    state.media['m-pdf'] = PDF_BYTES;
    state.pending = [makeCustomerMsg({ msgtype: 'file', file: { media_id: 'm-pdf', file_name: 'report.pdf' } })];
    await postEvent('TOKEN-PDF');
    await waitFor(() => calls.responses.length >= 1, 5000, 'PDF 问答');
    assert.deepEqual(calls.mediaGet, ['m-img', 'm-pdf']);
    assert.equal(calls.fileUpload.length, 1);
    assert.ok(calls.fileUpload[0].contentType!.startsWith('multipart/form-data'));
    const pdfReq = calls.responses[0];
    const pdfContent = pdfReq.input[pdfReq.input.length - 1].content;
    assert.deepEqual(pdfContent[0], { type: 'input_file', file_id: 'file-test-1' });
    assert.equal(pdfContent[1].type, 'input_text');
    await waitFor(() => calls.sendMsg.length >= 2, 5000, 'PDF 回复');
    assert.ok(calls.sendMsg[1].text.content.includes('这份 PDF 总结了三件事。'));
    assert.ok(calls.sendMsg[1].text.content.includes('继续追问'));

    // 3. 文本消息 → 继续追问同一个文件（Responses API 带 file_id + 历史）
    state.pending = [makeCustomerMsg({ msgtype: 'text', text: { content: '第二章讲了什么？' } })];
    await postEvent('TOKEN-FOLLOWUP');
    await waitFor(() => calls.responses.length >= 2, 5000, '文件追问');
    const followReq = calls.responses[1];
    const followContent = followReq.input[followReq.input.length - 1].content;
    assert.deepEqual(followContent[0], { type: 'input_file', file_id: 'file-test-1' });
    assert.equal(followContent[1].text, '第二章讲了什么？');
    // 历史里带上了之前的图片与文档两轮（2 轮 × 2 条）+ 本次提问
    assert.equal(followReq.input.length, 5);
    assert.ok(JSON.stringify(followReq.input[0]).includes('[图片]'));
    await waitFor(() => calls.sendMsg.length >= 3, 5000, '追问回复');

    // 4. 文本文件 → 直接读内容进 prompt（不走 Files API）
    state.media['m-txt'] = TXT_BYTES;
    state.pending = [makeCustomerMsg({ msgtype: 'file', file: { media_id: 'm-txt', file_name: 'notes.txt' } })];
    await postEvent('TOKEN-TXT');
    await waitFor(() => calls.chat.length >= 2, 5000, '文本文件处理');
    assert.equal(calls.fileUpload.length, 1); // 没有新上传
    const txtReq = calls.chat[1];
    const txtUser = txtReq.messages[txtReq.messages.length - 1];
    assert.equal(txtUser.role, 'user');
    assert.ok(txtUser.content.includes('采购清单'));
    assert.ok(txtUser.content.includes('notes.txt'));
    await waitFor(() => calls.sendMsg.length >= 4, 5000, '文本文件回复');
    assert.equal(calls.sendMsg[calls.sendMsg.length - 1].text.content, '秋风起，落叶飘。');

    // 5. 语音 → 友好提示
    state.pending = [makeCustomerMsg({ msgtype: 'voice', voice: { media_id: 'm-voice' } })];
    await postEvent('TOKEN-VOICE');
    await waitFor(() => calls.sendMsg.length >= 5, 5000, '语音提示');
    assert.ok(calls.sendMsg[calls.sendMsg.length - 1].text.content.includes('语音'));

    // 6. 不支持的格式 → 提示支持范围
    state.media['m-zip'] = Buffer.from('PK-zip-bytes');
    state.pending = [makeCustomerMsg({ msgtype: 'file', file: { media_id: 'm-zip', file_name: 'backup.zip' } })];
    await postEvent('TOKEN-ZIP');
    await waitFor(() => calls.sendMsg.length >= 6, 5000, '不支持格式提示');
    assert.ok(calls.sendMsg[calls.sendMsg.length - 1].text.content.includes('.zip'));
  } finally {
    await stop();
  }
});

test('端到端：会话指令（/new /list /switch /del /help）与上下文隔离', async () => {
  const calls = freshCalls();
  const state: StackState = { pending: [], media: {} };
  const { stop } = await startStack(calls, state);
  try {
    const sendTexts = async (expect: number, label: string): Promise<string[]> => {
      await waitFor(() => calls.sendMsg.length >= expect, 5000, label);
      return calls.sendMsg.map((m) => m.text.content);
    };

    // 1. 会话 #1 的首条消息成为标题
    state.pending = [makeCustomerMsg({ msgtype: 'text', text: { content: '帮我看看采购的事' } })];
    await postEvent('TOKEN-C1');
    let texts = await sendTexts(1, '会话1回复');
    assert.ok(texts[0].includes('秋风起'));

    // 2. /new 开新会话 #2
    state.pending = [makeCustomerMsg({ msgtype: 'text', text: { content: '/new 报告讨论' } })];
    await postEvent('TOKEN-C2');
    texts = await sendTexts(2, '/new 回复');

    // 3. 新会话里的消息不带旧上下文（LLM 只收到 system + 本条）
    state.pending = [makeCustomerMsg({ msgtype: 'text', text: { content: '继续' } })];
    await postEvent('TOKEN-C3');
    texts = await sendTexts(3, '新会话回复');
    await waitFor(() => calls.chat.length >= 2, 5000, '第二次 chat');
    const msgs = calls.chat[1].messages;
    assert.equal(msgs.length, 2); // system + user，没有会话 #1 的历史
    assert.equal(msgs[1].content, '继续');

    // 4. /list 展示两个会话，#2 是活跃的
    state.pending = [makeCustomerMsg({ msgtype: 'text', text: { content: '/list' } })];
    await postEvent('TOKEN-C4');
    texts = await sendTexts(4, '/list 回复');
    assert.ok(texts[3].includes('▸ #2'));
    assert.ok(texts[3].includes('#1 帮我看看采购的事'));

    // 5. /switch 回 #1，/del 删除 #2
    state.pending = [makeCustomerMsg({ msgtype: 'text', text: { content: '/switch 1' } })];
    await postEvent('TOKEN-C5');
    texts = await sendTexts(5, '/switch 回复');
    assert.ok(texts[4].includes('#1'));

    state.pending = [makeCustomerMsg({ msgtype: 'text', text: { content: '/del 2' } })];
    await postEvent('TOKEN-C6');
    texts = await sendTexts(6, '/del 回复');
    assert.ok(texts[5].includes('已删除'));

    // 6. /help 与未知指令
    state.pending = [makeCustomerMsg({ msgtype: 'text', text: { content: '/help' } })];
    await postEvent('TOKEN-C7');
    texts = await sendTexts(7, '/help 回复');
    assert.ok(texts[6].includes('/switch'));

    state.pending = [makeCustomerMsg({ msgtype: 'text', text: { content: '/foobar' } })];
    await postEvent('TOKEN-C8');
    texts = await sendTexts(8, '未知指令回复');
    assert.ok(texts[7].includes('未知指令'));
  } finally {
    await stop();
  }
});
