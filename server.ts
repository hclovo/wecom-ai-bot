import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifySignature, decrypt, xmlGet } from './lib/wecom-crypto.ts';
import { syncMessages, sendText, getMedia, clearTokenCache } from './lib/wecom-api.ts';
import type { KfMessage } from './lib/wecom-api.ts';
import { uploadFile, waitFileActive, askFile } from './lib/ark-files.ts';
import { chatCompletion } from './lib/llm.ts';
import type { HistoryMessage } from './lib/llm.ts';

// ---------- 配置 ----------

export interface Config {
  port: number;
  corpId: string;
  kfSecret: string;
  token: string;
  aesKey: string;
  receiveId: string;
  apiBase: string;
  openKfId: string; // 留空则处理所有客服账号的消息
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmVisionModel: string; // 看图模型，需支持视觉
  systemPrompt: string;
  maxTurns: number;
  fileMaxMb: number;
}

export function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = {
    port: Number(env.PORT || 8788),
    corpId: env.WECOM_CORP_ID,
    kfSecret: env.WECOM_KF_SECRET,
    token: env.WECOM_TOKEN,
    aesKey: env.WECOM_ENCODING_AES_KEY,
    receiveId: env.WECOM_RECEIVE_ID || env.WECOM_CORP_ID,
    apiBase: env.WECOM_API_BASE || 'https://qyapi.weixin.qq.com',
    openKfId: env.WECOM_OPEN_KFID || '', // 留空则处理所有客服账号的消息
    llmBaseUrl: env.LLM_BASE_URL,
    llmApiKey: env.LLM_API_KEY,
    llmModel: env.LLM_MODEL,
    llmVisionModel: env.LLM_VISION_MODEL || env.LLM_MODEL, // 看图模型，需支持视觉
    systemPrompt: env.LLM_SYSTEM_PROMPT || '你是一位用户的好朋友，通过微信聊天。回复要口语化、简洁自然，一般不超过 150 字，不用 markdown 格式，分点列表。',
    maxTurns: Number(env.MAX_HISTORY_TURNS || 12),
    fileMaxMb: Number(env.FILE_MAX_MB || 20),
  };
  const missing = Object.entries({
    WECOM_CORP_ID: cfg.corpId,
    WECOM_KF_SECRET: cfg.kfSecret,
    WECOM_TOKEN: cfg.token,
    WECOM_ENCODING_AES_KEY: cfg.aesKey,
    LLM_BASE_URL: cfg.llmBaseUrl,
    LLM_API_KEY: cfg.llmApiKey,
    LLM_MODEL: cfg.llmModel,
  }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) throw new Error(`缺少配置: ${missing.join(', ')}（参考 .env.example）`);
  // 走到这里缺失校验已保证必填字段非空
  return cfg as Config;
}

// ---------- 文件类型 ----------

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'log', 'xml', 'yml', 'yaml', 'html', 'htm', 'ts', 'tsx', 'js', 'py', 'java', 'c', 'h', 'cpp', 'go', 'rs', 'sql', 'sh', 'ini', 'toml']);
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
const TEXT_FILE_CHAR_LIMIT = 40000;

function extOf(filename = ''): string {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

// ---------- 回复发送 ----------

const CHUNK_LIMIT = 1000; // 企业微信文本消息上限约 2048 字节，留足余量
const SEND_GAP_MS = 400;

// 短段落合并为一条消息；超长段落按上限硬切
export function splitReply(text: string, limit = CHUNK_LIMIT): string[] {
  const chunks = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    if (para.length > limit) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < para.length; i += limit) chunks.push(para.slice(i, i + limit));
      continue;
    }
    if (cur && (cur + '\n\n' + para).length > limit) {
      chunks.push(cur);
      cur = para;
    } else {
      cur = cur ? cur + '\n\n' + para : para;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ---------- 多会话（每个用户可开多个会话，防止单一上下文无限膨胀）----------

const MAX_SESSIONS_PER_USER = 10;

// 用户正在追问的文件（已上传到方舟 Files API）
interface PendingFile {
  fileId: string;
  filename: string;
}

interface Conversation {
  id: number;
  title: string;
  history: HistoryMessage[];
  pendingFile: PendingFile | null;
  updatedAt: number;
}

interface UserStore {
  conversations: Map<number, Conversation>;
  nextId: number;
  activeId: number;
}

interface BotState {
  sessions: Map<string, UserStore>; // external_userid -> 会话组
  cursors: Map<string, string>;     // open_kfid -> next_cursor
  seenMsgIds: Set<string>;
}

function getUserStore(state: BotState, user: string): UserStore {
  let store = state.sessions.get(user);
  if (!store) {
    // 会话 #1 固定为默认闲聊会话，编号从 2 起
    store = { conversations: new Map(), nextId: 2, activeId: 1 };
    store.conversations.set(1, { id: 1, title: '闲聊', history: [], pendingFile: null, updatedAt: Date.now() });
    state.sessions.set(user, store);
  }
  return store;
}

function getActive(store: UserStore): Conversation {
  return store.conversations.get(store.activeId) || [...store.conversations.values()].at(-1)!;
}

function touch(conv: Conversation): void {
  conv.updatedAt = Date.now();
}

function recentHistory(conv: Conversation, n = 6): HistoryMessage[] {
  return conv.history.slice(-n);
}

function handleCommand(store: UserStore, conv: Conversation, content: string): string {
  const [cmd, ...rest] = content.split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (cmd.toLowerCase()) {
    case '/help':
      return '可用指令：\n/new [标题] 开新会话\n/list 列出会话\n/switch 编号 切换会话\n/del 编号 删除会话\n/reset 清空当前会话上下文';

    case '/new': {
      const id = store.nextId++;
      store.conversations.set(id, { id, title: arg || `会话 ${id}`, history: [], pendingFile: null, updatedAt: Date.now() });
      store.activeId = id;
      // 会话数超限时淘汰最旧的非活跃会话
      if (store.conversations.size > MAX_SESSIONS_PER_USER) {
        const oldest = [...store.conversations.values()]
          .filter((c) => c.id !== store.activeId)
          .sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (oldest) store.conversations.delete(oldest.id);
      }
      return `已开启新会话 #${id}「${store.conversations.get(id)!.title}」，之前的话题不会跟过来。发 /list 可随时切回。`;
    }

    case '/list': {
      const lines = [...store.conversations.values()]
        .sort((a, b) => a.id - b.id)
        .map((c) => `${c.id === store.activeId ? '▸' : ' '} #${c.id} ${c.title}（${c.history.length}条${c.pendingFile ? '，追问中：' + c.pendingFile.filename : ''}）`);
      return `你的会话：\n${lines.join('\n')}\n\n用 /switch 编号 切换`;
    }

    case '/switch': {
      const id = Number(arg);
      const target = store.conversations.get(id);
      if (!target) return `没有 #${arg || '?'} 这个会话，发 /list 查看。`;
      store.activeId = id;
      return `已切换到 #${id}「${target.title}」（${target.history.length} 条消息）。`;
    }

    case '/del': {
      const id = Number(arg);
      const target = store.conversations.get(id);
      if (!target) return `没有 #${arg || '?'} 这个会话，发 /list 查看。`;
      if (store.conversations.size === 1) return '只剩最后一个会话了，用 /reset 清空它就行。';
      store.conversations.delete(id);
      if (store.activeId === id) {
        store.activeId = [...store.conversations.keys()].sort((a, b) => b - a)[0];
        const now = getActive(store);
        return `已删除 #${id}，当前在 #${now.id}「${now.title}」。`;
      }
      return `已删除 #${id}。`;
    }

    case '/reset':
      conv.history = [];
      conv.pendingFile = null;
      return `已清空当前会话 #${conv.id} 的上下文。`;
  }
  return `未知指令「${cmd}」，发 /help 查看可用指令。`;
}

async function handleText(cfg: Config, state: BotState, user: string, store: UserStore, conv: Conversation, content: string): Promise<string> {
  if (content.startsWith('/')) return handleCommand(store, conv, content);
  // 首条消息给默认命名的会话起标题
  if (conv.title === '闲聊' && conv.history.length === 0) conv.title = content.slice(0, 12);
  if (conv.pendingFile) {
    const { fileId, filename } = conv.pendingFile;
    const answer = await askFile({
      baseUrl: cfg.llmBaseUrl,
      apiKey: cfg.llmApiKey,
      model: cfg.llmModel,
      fileId,
      question: content,
      history: recentHistory(conv),
    });
    conv.history.push({ role: 'user', content: `[文件 ${filename}] 问：${content}` });
    conv.history.push({ role: 'assistant', content: answer });
    touch(conv);
    return answer;
  }
  conv.history.push({ role: 'user', content });
  while (conv.history.length > cfg.maxTurns * 2) conv.history.shift();
  const answer = await chatCompletion({
    baseUrl: cfg.llmBaseUrl,
    apiKey: cfg.llmApiKey,
    model: cfg.llmModel,
    systemPrompt: cfg.systemPrompt,
    history: conv.history,
  });
  conv.history.push({ role: 'assistant', content: answer });
  touch(conv);
  return answer;
}

async function handleImage(cfg: Config, conv: Conversation, msg: KfMessage): Promise<string | null> {
  const mediaId = msg.image?.media_id;
  if (!mediaId) return null;
  const buf = await getMedia(cfg, mediaId);
  if (buf.length > cfg.fileMaxMb * 1024 * 1024) return `图片超过 ${cfg.fileMaxMb}MB 了，我收不动～`;
  const dataUri = `data:image/jpeg;base64,${buf.toString('base64')}`;
  const answer = await chatCompletion({
    baseUrl: cfg.llmBaseUrl,
    apiKey: cfg.llmApiKey,
    model: cfg.llmVisionModel,
    systemPrompt: cfg.systemPrompt,
    history: [...recentHistory(conv), {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUri } },
        { type: 'text', text: '用户发来一张图片，请描述并解读它。' },
      ],
    }],
  });
  conv.history.push({ role: 'user', content: '[图片]' });
  conv.history.push({ role: 'assistant', content: answer });
  conv.pendingFile = null;
  touch(conv);
  return answer;
}

async function handleFile(cfg: Config, conv: Conversation, msg: KfMessage): Promise<string | null> {
  const mediaId = msg.file?.media_id;
  const filename = msg.file?.file_name || '未命名文件';
  if (!mediaId) return null;
  const buf = await getMedia(cfg, mediaId);
  if (buf.length > cfg.fileMaxMb * 1024 * 1024) return `文件超过 ${cfg.fileMaxMb}MB 了，我收不动～`;
  const ext = extOf(filename);

  if (TEXT_EXT.has(ext)) {
    let content = buf.toString('utf8');
    if (content.length > TEXT_FILE_CHAR_LIMIT) {
      content = `${content.slice(0, TEXT_FILE_CHAR_LIMIT)}\n（文件过长，已截断）`;
    }
    const answer = await chatCompletion({
      baseUrl: cfg.llmBaseUrl,
      apiKey: cfg.llmApiKey,
      model: cfg.llmModel,
      systemPrompt: cfg.systemPrompt,
      history: [{
        role: 'user',
        content: `用户发来文本文件「${filename}」，内容如下：\n\n${content}\n\n请用中文简要总结这个文件的要点。`,
      }],
    });
    conv.history.push({ role: 'user', content: `[文本文件] ${filename}` });
    conv.history.push({ role: 'assistant', content: answer });
    conv.pendingFile = null;
    touch(conv);
    return answer;
  }

  if (DOC_EXT.has(ext)) {
    const up = await uploadFile({ baseUrl: cfg.llmBaseUrl, apiKey: cfg.llmApiKey, buffer: buf, filename });
    await waitFileActive({ baseUrl: cfg.llmBaseUrl, apiKey: cfg.llmApiKey, fileId: up.id });
    const answer = await askFile({
      baseUrl: cfg.llmBaseUrl,
      apiKey: cfg.llmApiKey,
      model: cfg.llmModel,
      fileId: up.id,
      question: '请用中文简要总结这个文件的要点。',
    });
    conv.pendingFile = { fileId: up.id, filename };
    conv.history.push({ role: 'user', content: `[文档] ${filename}` });
    conv.history.push({ role: 'assistant', content: answer });
    touch(conv);
    return `${answer}\n\n文件已就绪，你可以继续追问。`;
  }

  return `这个格式（.${ext || '未知'}）我还处理不了。支持：图片、PDF/Word/Excel/PPT、常见文本文件。`;
}

// ---------- HTTP 服务 ----------

export function createServer(cfg: Config) {
  // 每个服务实例独立的运行状态
  const state: BotState = {
    sessions: new Map(),  // external_userid -> { conversations, nextId, activeId }
    cursors: new Map(),   // open_kfid -> next_cursor
    seenMsgIds: new Set(),
  };

  async function sendReply(kfid: string, user: string, msgid: string, reply: string): Promise<void> {
    const chunks = splitReply(reply);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
      try {
        await sendText(cfg, {
          touser: user,
          openKfId: kfid,
          msgid: `bot-${msgid}-${i}`,
          content: chunks[i],
        });
      } catch (err) {
        const e = err as Error & { errcode?: number };
        console.error('[send]:', e.message);
        if (e.errcode === 60020) console.error('（企业微信要求在管理端配置服务器「可信 IP」）');
        if (e.errcode === 40014 || e.errcode === 42001) clearTokenCache();
        return;
      }
    }
  }

  async function handleMessage(kfid: string, msg: KfMessage): Promise<void> {
    // origin=3 表示微信客户发来的消息；客服/系统消息不处理
    if (msg.origin !== 3 || !msg.external_userid) return;
    const user = msg.external_userid;
    const store = getUserStore(state, user);
    const conv = getActive(store);

    let reply: string | null = null;
    try {
      switch (msg.msgtype) {
        case 'text':
          reply = await handleText(cfg, state, user, store, conv, (msg.text?.content || '').trim());
          break;
        case 'image':
          reply = await handleImage(cfg, conv, msg);
          break;
        case 'file':
          reply = await handleFile(cfg, conv, msg);
          break;
        case 'voice':
          reply = '语音消息我还听不了，打字发我吧～';
          break;
        case 'video':
          reply = '视频处理还没上线，先发文字、图片或文档吧';
          break;
        default:
          return; // 事件类消息（进入会话等）静默忽略
      }
    } catch (err) {
      console.error(`[msg ${msg.msgtype}] ${user}:`, (err as Error).message);
      reply = '处理时出了点小问题，稍后再试试？';
    }
    if (reply) await sendReply(kfid, user, msg.msgid, reply);
  }

  let queueTail: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>) => {
    queueTail = queueTail.then(job).catch((err) => console.error('[worker]', err));
  };

  function handleEvent({ openKfId, callbackToken }: { openKfId: string; callbackToken: string }): void {
    enqueue(async () => {
      const kfid = openKfId || cfg.openKfId;
      if (!kfid) return;
      const cursor = state.cursors.get(kfid) || '';
      const data = await syncMessages(cfg, { cursor, token: callbackToken, openKfId: kfid });
      state.cursors.set(kfid, data.next_cursor || cursor);
      for (const msg of data.msg_list || []) {
        if (state.seenMsgIds.has(msg.msgid)) continue;
        state.seenMsgIds.add(msg.msgid);
        if (state.seenMsgIds.size > 10000) {
          for (const id of state.seenMsgIds) { state.seenMsgIds.delete(id); if (state.seenMsgIds.size <= 5000) break; }
        }
        await handleMessage(kfid, msg);
      }
    });
  }

  const recvId = cfg.receiveId || cfg.corpId;
  return http.createServer((req, res) => {
    const url = new URL(req.url as string, 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (url.pathname !== '/webhook') {
      res.writeHead(404).end();
      return;
    }
    const q = url.searchParams;
    const sigParams = {
      msg_signature: q.get('msg_signature') || '',
      timestamp: q.get('timestamp') || '',
      nonce: q.get('nonce') || '',
    };

    if (req.method === 'GET') {
      // URL 配置时的验证请求：解密 echostr 原样返回
      const echostr = q.get('echostr') || '';
      if (!verifySignature(cfg.token, sigParams, echostr)) {
        res.writeHead(401).end('bad signature');
        return;
      }
      const { message, receiveId } = decrypt(echostr, cfg.aesKey);
      if (recvId && receiveId !== recvId) {
        res.writeHead(401).end(`receiveId mismatch: ${receiveId}`);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end(message);
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const encrypt = xmlGet(body, 'Encrypt');
          if (!encrypt || !verifySignature(cfg.token, sigParams, encrypt)) {
            res.writeHead(401).end();
            return;
          }
          const { message } = decrypt(encrypt, cfg.aesKey);
          // 回调事件格式：Event=kf_msg_or_event, Token(用于首次 sync_msg), OpenKfId
          const event = xmlGet(message, 'Event');
          if (event === 'kf_msg_or_event') {
            handleEvent({
              openKfId: xmlGet(message, 'OpenKfId') || '',
              callbackToken: xmlGet(message, 'Token') || '',
            });
          }
          res.writeHead(200, { 'content-type': 'text/plain' }).end(''); // 回空串表示成功且不重推
        } catch (err) {
          console.error('[webhook]', err);
          res.writeHead(500).end();
        }
      });
      return;
    }

    res.writeHead(405).end();
  });
}

// ---------- 入口 ----------

export function main(): void {
  loadEnvFile(new URL('./.env', import.meta.url).pathname);
  const cfg = loadConfig();
  const server = createServer(cfg);
  server.listen(cfg.port, () => {
    console.log(`wecom-ai-bot listening on :${cfg.port}`);
    console.log(`回调 URL: http://<你的域名或IP>:${cfg.port}/webhook`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
