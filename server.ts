import { cancelCursorRequests } from './lib/cursor-agent.ts';
import { drawingPrompt, generateImage, generateNativeImage } from './lib/image-generation.ts';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifySignature, decrypt, xmlGet } from './lib/wecom-crypto.ts';
import { getMedia } from './lib/wecom-api.ts';
import { databaseConfig } from './lib/message-store.ts';
import type { DatabaseConfig } from './lib/message-store.ts';
import { MessageWorker } from './lib/message-worker.ts';
import { errorCode } from './lib/http-client.ts';
import type { KfMessage } from './lib/wecom-api.ts';
import { uploadFile, waitFileActive, askFile } from './lib/ark-files.ts';
import { chatCompletion } from './lib/llm.ts';
import type { HistoryMessage } from './lib/llm.ts';
import { conversationReply } from './lib/conversation-reply.ts';
import type { ReplyChunk } from './lib/reply-types.ts';

// ---------- 配置 ----------

export interface Config extends DatabaseConfig {
  llmProvider: 'api' | 'cursor';
  svgProvider: 'api' | 'cursor';
  cursorFallback: boolean;
  imageProvider: 'svg' | 'cursor';
  cursorImageModel: string;
  nativeImageTimeoutMs: number;
  cursorBin: string;
  cursorStateDir: string;
  cursorModel: string;
  cursorTimeoutMs: number;
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
  imageModel: string;
  imageTimeoutMs: number;
  llmVisionModel: string; // 看图模型，需支持视觉
  systemPrompt: string;
  maxTurns: number;
  fileMaxMb: number;
  upstreamTimeoutMs: number;
  fileTaskTimeoutMs: number;
  maxConcurrentJobs: number;
  maxQueueSize: number;
  dailyRequestLimit: number;
  syncPollMs: number;
  retryBaseMs: number;
  maxSendAttempts: number;
  retentionDays: number;
  mediaPath: string;
  autoTakeover: boolean;
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
  const provider = env.LLM_PROVIDER || 'api';
  if (!['api','cursor'].includes(provider)) throw new Error('LLM_PROVIDER 必须为 api 或 cursor');
  const svgProvider = env.SVG_PROVIDER || provider;
  if (!['api','cursor'].includes(svgProvider)) throw new Error('SVG_PROVIDER 必须为 api 或 cursor');
  if (env.CURSOR_FALLBACK && !['true','false'].includes(env.CURSOR_FALLBACK)) throw new Error('CURSOR_FALLBACK 必须为 true 或 false');
  const imageProvider = env.IMAGE_PROVIDER || 'svg';
  if (!['svg', 'cursor'].includes(imageProvider)) throw new Error('IMAGE_PROVIDER 必须为 svg 或 cursor');
  const cfg = {
    llmProvider: provider,
    svgProvider,
    cursorFallback: env.CURSOR_FALLBACK === 'true',
    imageProvider,
    cursorImageModel: env.CURSOR_IMAGE_MODEL || env.CURSOR_MODEL || 'auto',
    nativeImageTimeoutMs: Number(env.IMAGE_TIMEOUT_MS || 180000),
    cursorBin: env.CURSOR_AGENT_BIN || 'cursor-agent',
    cursorStateDir: env.CURSOR_STATE_DIR || './.cursor-agent-state',
    cursorModel: env.CURSOR_MODEL || 'auto',
    cursorTimeoutMs: Number(env.CURSOR_TIMEOUT_MS || 120000),
    port: Number(env.PORT || 8788),
    corpId: env.WECOM_CORP_ID,
    kfSecret: env.WECOM_KF_SECRET,
    token: env.WECOM_TOKEN,
    aesKey: env.WECOM_ENCODING_AES_KEY,
    receiveId: env.WECOM_RECEIVE_ID || env.WECOM_CORP_ID,
    apiBase: env.WECOM_API_BASE || 'https://qyapi.weixin.qq.com',
    openKfId: env.WECOM_OPEN_KFID || '', // 留空则处理所有客服账号的消息
    llmBaseUrl: env.LLM_BASE_URL || '',
    llmApiKey: env.LLM_API_KEY || '',
    llmModel: env.LLM_MODEL || '',
    imageModel: env.SVG_MODEL || (svgProvider === 'cursor' ? (env.CURSOR_MODEL || 'auto') : env.LLM_MODEL),
    imageTimeoutMs: Number(env.SVG_TIMEOUT_MS || 120000),
    llmVisionModel: env.LLM_VISION_MODEL || env.LLM_MODEL, // 看图模型，需支持视觉
    systemPrompt: env.LLM_SYSTEM_PROMPT || '你是一位用户的好朋友，通过微信聊天。回复要口语化、简洁自然，一般不超过 150 字，不用 markdown 格式，分点列表。',
    maxTurns: Number(env.MAX_HISTORY_TURNS || 12),
    fileMaxMb: Number(env.FILE_MAX_MB || 20),
    ...databaseConfig(env),
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS || 30000),
    fileTaskTimeoutMs: Number(env.FILE_TASK_TIMEOUT_MS || 90000),
    maxConcurrentJobs: Number(env.MAX_CONCURRENT_JOBS || 2),
    maxQueueSize: Number(env.MAX_QUEUE_SIZE || 1000),
    dailyRequestLimit: Number(env.DAILY_REQUEST_LIMIT || 100),
    syncPollMs: Number(env.SYNC_POLL_MS || 60000),
    retryBaseMs: Number(env.RETRY_BASE_MS || 1000),
    maxSendAttempts: Number(env.MAX_SEND_ATTEMPTS || 5),
    retentionDays: Number(env.RETENTION_DAYS || 30),
    mediaPath: env.WECOM_MEDIA_PATH || '/cgi-bin/media/get',
    autoTakeover: env.WECOM_AUTO_TAKEOVER === 'true',

  };
  const missing = Object.entries({
    WECOM_CORP_ID: cfg.corpId,
    WECOM_KF_SECRET: cfg.kfSecret,
    WECOM_TOKEN: cfg.token,
    WECOM_ENCODING_AES_KEY: cfg.aesKey,
    ...(provider === 'api' || (imageProvider === 'svg' && svgProvider === 'api') ? { LLM_BASE_URL: cfg.llmBaseUrl, LLM_API_KEY: cfg.llmApiKey, LLM_MODEL: cfg.llmModel } : {}),
  }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) throw new Error(`缺少配置: ${missing.join(', ')}（参考 .env.example）`);
  for (const key of ['port', 'maxTurns', 'fileMaxMb', 'upstreamTimeoutMs', 'fileTaskTimeoutMs',
    'imageTimeoutMs', 'nativeImageTimeoutMs', 'cursorTimeoutMs', 'maxConcurrentJobs', 'maxQueueSize', 'dailyRequestLimit', 'syncPollMs', 'retryBaseMs', 'maxSendAttempts', 'retentionDays'] as const) {
    if (!Number.isSafeInteger(cfg[key]) || cfg[key] < 1) throw new Error(`配置 ${key} 必须为正整数`);
  }
  if (cfg.port > 65535) throw new Error('PORT 超出范围');
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(cfg.mediaPath)) throw new Error('WECOM_MEDIA_PATH 必须是 API 路径');
  if (!/^[A-Za-z0-9+/]{43}$/.test(cfg.aesKey!)) throw new Error('EncodingAESKey 必须为 43 位 Base64 字符');
  if (env.WECOM_AUTO_TAKEOVER && !['true', 'false'].includes(env.WECOM_AUTO_TAKEOVER)) throw new Error('WECOM_AUTO_TAKEOVER 必须为 true 或 false');
  // 走到这里缺失校验已保证必填字段非空
  return cfg as Config;
}

// ---------- 文件类型 ----------

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'log', 'xml', 'yml', 'yaml', 'html', 'htm', 'ts', 'tsx', 'js', 'py', 'java', 'c', 'h', 'cpp', 'go', 'rs', 'sql', 'sh', 'ini', 'toml']);
const DOC_EXT = new Set(['pdf']);
const OFFICE_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
const TEXT_FILE_CHAR_LIMIT = 40000;

function extOf(filename = ''): string {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

// ---------- 回复发送 ----------

const CHUNK_LIMIT = 1000; // conservative UTF-8 byte budget, including Chinese and emoji

export function splitReply(text: string, limit = CHUNK_LIMIT): string[] {
  if (!Number.isSafeInteger(limit) || limit < 4) throw new Error('切分字节上限至少为 4');
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > limit) { chunks.push(current); current = ''; bytes = 0; }
    current += char;
    bytes += size;
  }
  if (current) chunks.push(current);
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
  textFile?: { filename: string; content: string };
  updatedAt: number;
}

interface UserStore {
  conversations: Map<number, Conversation>;
  nextId: number;
  activeId: number;
}

function getUserStore(saved?: string): UserStore {
  if (saved) {
    const data = JSON.parse(saved) as { conversations: Conversation[]; nextId: number; activeId: number };
    return { ...data, conversations: new Map(data.conversations.map((c) => [c.id, c])) };
  }
  return { conversations: new Map([[1, { id: 1, title: '闲聊', history: [], pendingFile: null, updatedAt: Date.now() }]]), nextId: 2, activeId: 1 };
}

function serializeStore(store: UserStore): string {
  return JSON.stringify({ ...store, conversations: [...store.conversations.values()] });
}

function appendTurn(cfg: Config, conv: Conversation, question: string, answer: string): void {
  conv.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
  while (conv.history.length > cfg.maxTurns * 2 || (conv.history.length > 2 && JSON.stringify(conv.history).length > 80000)) {
    conv.history.splice(0, 2);
  }
  touch(conv);
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
      return '可用指令：\n/new [标题] 开新会话\n/list 列出会话\n/switch 编号 切换会话\n/del 编号 删除会话\n/reset 清空当前会话上下文\n/draw 描述 生成图片（也可在聊天中直接要求配图）';

    case '/new': {
      const id = store.nextId++;
      store.conversations.set(id, { id, title: arg.slice(0, 40) || `会话 ${id}`, history: [], pendingFile: null, updatedAt: Date.now() });
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
      touch(target);
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
      conv.textFile = undefined;
      touch(conv);
      return `已清空当前会话 #${conv.id} 的上下文。`;
  }
  return `未知指令「${cmd}」，发 /help 查看可用指令。`;
}

function cursorFallback(cfg: Config) {
  return cfg.cursorFallback ? { model: cfg.cursorModel, timeoutMs: cfg.cursorTimeoutMs } : undefined;
}

function drawImage(cfg: Config, prompt: string) {
  if (cfg.imageProvider === 'cursor') return generateNativeImage({ cursorBin: cfg.cursorBin, cursorStateDir: cfg.cursorStateDir,
    model: cfg.cursorImageModel, prompt, timeoutMs: cfg.nativeImageTimeoutMs });
  return generateImage({ provider: cfg.svgProvider, cursorBin: cfg.cursorBin, cursorStateDir: cfg.cursorStateDir,
    baseUrl: cfg.llmBaseUrl, apiKey: cfg.llmApiKey, model: cfg.imageModel, prompt, timeoutMs: cfg.imageTimeoutMs });
}

async function handleText(cfg: Config, store: UserStore, conv: Conversation, content: string): Promise<string | ReplyChunk[]> {
  if (content.startsWith('/')) return handleCommand(store, conv, content);
  // 首条消息给默认命名的会话起标题
  if (conv.title === '闲聊' && conv.history.length === 0) conv.title = content.slice(0, 12);
  if (conv.pendingFile) {
    if (cfg.llmProvider === 'cursor') return '暂时无法继续处理这个文件，请发送 /reset 开始新对话。';
    const { fileId, filename } = conv.pendingFile;
    const answer = await askFile({
      timeoutMs: cfg.upstreamTimeoutMs,
      baseUrl: cfg.llmBaseUrl,
      apiKey: cfg.llmApiKey,
      model: cfg.llmModel,
      fileId,
      question: content,
      history: recentHistory(conv),
    });
    appendTurn(cfg, conv, `[文件 ${filename}] 问：${content}`, answer);
    return answer;
  }
  const answer = await conversationReply({
    provider: cfg.llmProvider, cursorBin: cfg.cursorBin, cursorStateDir: cfg.cursorStateDir,
    fallbackCursor: cursorFallback(cfg),
    timeoutMs: cfg.llmProvider === 'cursor' ? cfg.cursorTimeoutMs : cfg.upstreamTimeoutMs,
    baseUrl: cfg.llmBaseUrl,
    apiKey: cfg.llmApiKey,
    model: cfg.llmProvider === 'cursor' ? cfg.cursorModel : cfg.llmModel,
    systemPrompt: cfg.systemPrompt,
    history: [
      ...(conv.textFile ? [{ role: 'user' as const, content: `参考文件「${conv.textFile.filename}」：\n${conv.textFile.content}` }] : []),
      ...conv.history, { role: 'user', content },
    ],
  }, prompt => drawImage(cfg, prompt), cfg.imageProvider === 'cursor' ? 'native' : 'svg');
  appendTurn(cfg, conv, content, answer.historyText);
  return answer.chunks;
}

async function handleImage(cfg: Config, conv: Conversation, msg: KfMessage): Promise<string | null> {
  if (cfg.llmProvider === 'cursor') return '暂时无法识别图片，请用文字描述。';
  const mediaId = msg.image?.media_id;
  if (!mediaId) return null;
  const buf = await getMedia(cfg, mediaId);
  if (buf.length > cfg.fileMaxMb * 1024 * 1024) return `图片超过 ${cfg.fileMaxMb}MB 了，我收不动～`;
  const mime = buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : 'image/jpeg';
  const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
  const answer = await chatCompletion({
    provider: cfg.llmProvider, cursorBin: cfg.cursorBin, cursorStateDir: cfg.cursorStateDir,
    timeoutMs: cfg.upstreamTimeoutMs,
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
  appendTurn(cfg, conv, '[图片]', answer);
  conv.textFile = undefined;
  conv.pendingFile = null;
  touch(conv);
  return answer;
}

async function handleFile(cfg: Config, conv: Conversation, msg: KfMessage): Promise<string | null> {
  const mediaId = msg.file?.media_id;
  const filename = msg.file?.file_name || '未命名文件';
  if (!mediaId) return null;
  const ext = extOf(filename);
  if (cfg.llmProvider === 'cursor' && (OFFICE_EXT.has(ext) || DOC_EXT.has(ext))) return '暂不支持此类文档，请发送 txt 或 md 文本文件。';
  if (OFFICE_EXT.has(ext)) return '目前请先把 Word/Excel/PPT 导出为 PDF，再发给我解读。';
  if (!TEXT_EXT.has(ext) && !DOC_EXT.has(ext)) return `这个格式（.${ext || '未知'}）暂不支持，请发送图片、PDF 或文本文件。`;
  const buf = await getMedia(cfg, mediaId);

  if (TEXT_EXT.has(ext)) {
    let content = buf.toString('utf8');
    if (content.length > TEXT_FILE_CHAR_LIMIT) {
      content = `${content.slice(0, TEXT_FILE_CHAR_LIMIT)}\n（文件过长，已截断）`;
    }
    const answer = await chatCompletion({
      provider: cfg.llmProvider, cursorBin: cfg.cursorBin, cursorStateDir: cfg.cursorStateDir,
      fallbackCursor: cursorFallback(cfg),
      timeoutMs: cfg.llmProvider === 'cursor' ? cfg.cursorTimeoutMs : cfg.upstreamTimeoutMs,
      baseUrl: cfg.llmBaseUrl,
      apiKey: cfg.llmApiKey,
      model: cfg.llmProvider === 'cursor' ? cfg.cursorModel : cfg.llmModel,
      systemPrompt: cfg.systemPrompt,
      history: [{
        role: 'user',
        content: `用户发来文本文件「${filename}」，内容如下：\n\n${content}\n\n请用中文简要总结这个文件的要点。`,
      }],
    });
    appendTurn(cfg, conv, `[文本文件] ${filename}`, answer);
    conv.textFile = { filename, content };
    conv.pendingFile = null;
    touch(conv);
    return answer;
  }

  if (DOC_EXT.has(ext)) {
    const signal = AbortSignal.timeout(cfg.fileTaskTimeoutMs);
    const up = await uploadFile({ signal, timeoutMs: cfg.upstreamTimeoutMs, baseUrl: cfg.llmBaseUrl, apiKey: cfg.llmApiKey, buffer: buf, filename });
    await waitFileActive({ signal, timeoutMs: cfg.fileTaskTimeoutMs, baseUrl: cfg.llmBaseUrl, apiKey: cfg.llmApiKey, fileId: up.id });
    const answer = await askFile({
      timeoutMs: cfg.llmProvider === 'cursor' ? cfg.cursorTimeoutMs : cfg.upstreamTimeoutMs,
      baseUrl: cfg.llmBaseUrl,
      apiKey: cfg.llmApiKey,
      model: cfg.llmProvider === 'cursor' ? cfg.cursorModel : cfg.llmModel,
      signal,
      fileId: up.id,
      question: '请用中文简要总结这个文件的要点。',
    });
    conv.pendingFile = { fileId: up.id, filename };
    appendTurn(cfg, conv, `[文档] ${filename}`, answer);
    conv.textFile = undefined;
    touch(conv);
    return `${answer}\n\n文件已就绪，你可以继续追问。`;
  }

  return null;
}

// ---------- HTTP 服务 ----------

export async function createServer(cfg: Config) {
  const worker = await MessageWorker.create(cfg, async (msg, saved) => {
    const store = getUserStore(saved);
    const conv = getActive(store);
    let reply: string | ReplyChunk[] | null = null;
    try {
      const prompt = msg.msgtype === 'text' ? drawingPrompt(msg.text?.content || '') : null;
      if (prompt !== null) {
        if (!prompt) return { chunks: ['请描述想画的内容，例如：/draw 一只穿宇航服的猫'] };
        if (prompt.length > 4000) return { chunks: ['画图描述请控制在 4000 字以内。'] };
        const picture = await drawImage(cfg, prompt);
        appendTurn(cfg, conv, `[画图] ${prompt}`, '[已生成一张图片]');
        return { session: serializeStore(store), chunks: [picture] };
      }
      switch (msg.msgtype) {
        case 'text': reply = await handleText(cfg, store, conv, (msg.text?.content || '').trim()); break;
        case 'image': reply = await handleImage(cfg, conv, msg); break;
        case 'file': reply = await handleFile(cfg, conv, msg); break;
        case 'voice': reply = '语音消息我还听不了，打字发我吧～'; break;
        case 'video': reply = '视频处理还没上线，先发文字、图片或文档吧'; break;
      }
      const chunks = reply === null ? [] : typeof reply === 'string' ? [reply] : reply;
      return { session: serializeStore(store), chunks: chunks.flatMap<ReplyChunk>(chunk => typeof chunk === 'string' ? splitReply(chunk) : [chunk]) };
    } catch (error) {
      if (msg.msgtype === 'text' && drawingPrompt(msg.text?.content || '') !== null) {
        console.error('[draw]', errorCode(error));
        return { chunks: ['图片生成失败，请稍后重试。'] };
      }
      console.error('[model]', errorCode(error));
      // Discard partial mutations on failure. Persist an error reply for delivery retries.
      return { chunks: ['处理失败，请稍后重试。'] };
    }
  });
  let stopping: Promise<void> | undefined;
  const stopWorker = () => stopping ??= worker.stop();
  const recvId = cfg.receiveId || cfg.corpId;
  const server = http.createServer((req, res) => {
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
      let decoded: ReturnType<typeof decrypt>;
      try { decoded = decrypt(echostr, cfg.aesKey); } catch { res.writeHead(400).end('bad ciphertext'); return; }
      const { message, receiveId } = decoded;
      if (recvId && receiveId !== recvId) {
        res.writeHead(401).end('receiveId mismatch');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end(message);
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      let bodyBytes = 0;
      let tooLarge = false;
      req.on('data', (c: Buffer) => {
        bodyBytes += c.length;
        if (bodyBytes > 65536) {
          if (!tooLarge) res.writeHead(413).end();
          tooLarge = true; body = '';
          return;
        }
        if (!tooLarge) body += c;
      });
      req.on('end', async () => {
        if (tooLarge) return;
        const ackDeadline = setTimeout(() => { if (!res.headersSent) res.writeHead(503).end(); }, 4500);
        try {
          const encrypt = xmlGet(body, 'Encrypt');
          if (!encrypt || !verifySignature(cfg.token, sigParams, encrypt)) {
            res.writeHead(401).end();
            return;
          }
          const { message, receiveId } = decrypt(encrypt, cfg.aesKey);
          if (receiveId !== recvId) { res.writeHead(401).end(); return; }
          // 回调事件格式：Event=kf_msg_or_event, Token(用于首次 sync_msg), OpenKfId
          const event = xmlGet(message, 'Event');
          if (event === 'kf_msg_or_event') {
            const kfid = xmlGet(message, 'OpenKfId') || cfg.openKfId;
            if (kfid && (!cfg.openKfId || kfid === cfg.openKfId)) await worker.notify(kfid, xmlGet(message, 'Token') || '');
          }
          if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/plain' }).end(''); // 回空串表示成功且不重推
        } catch (err) {
          console.error('[webhook]', errorCode(err));
          if (!res.headersSent) res.writeHead(503).end();
        } finally { clearTimeout(ackDeadline); }
      });
      return;
    }

    res.writeHead(405).end();
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('listening', () => worker.start());
  server.on('close', () => { void stopWorker(); });
  return Object.assign(server, { stopWorker, worker });
}

// ---------- 入口 ----------

export async function main(): Promise<void> {
  process.umask(0o077);
  loadEnvFile(new URL('./.env', import.meta.url).pathname);
  const cfg = loadConfig();
  const server = await createServer(cfg);
  const shutdown = () => {
    cancelCursorRequests();
    server.close();
    const deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
    void server.stopWorker().then(() => { clearTimeout(deadline); });
  };
  server.worker.store.ownershipSignal.addEventListener('abort', () => { process.exitCode = 1; shutdown(); }, { once: true });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.listen(cfg.port, () => {
    console.log(`wecom-ai-bot listening on :${cfg.port}`);
    console.log(`回调 URL: http://<你的域名或IP>:${cfg.port}/webhook`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { console.error('[startup] 启动失败，请检查数据库连接、schema 权限、实例占用及必填配置'); process.exitCode = 1; });
}
