import { requestBytes, requestJson } from './http-client.ts';
// 微信客服（kf）服务端 API 封装：access_token、同步消息、发送消息
// 文档：https://developer.work.weixin.qq.com/document/path/94670

// 这些接口实际只用到配置里的这几个字段（结构化最小类型，server.ts 的 Config 可直接传入）
export interface WecomApiConfig {
  apiBase: string;
  corpId: string;
  kfSecret: string;
  upstreamTimeoutMs?: number;
  fileMaxMb?: number;
  mediaPath?: string;
}

const TOKEN_RENEW_MARGIN_MS = 5 * 60 * 1000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function clearTokenCache(): void {
  tokenCache.clear();
}

async function getAccessToken(cfg: WecomApiConfig): Promise<string> {
  const { apiBase, corpId, kfSecret } = cfg;
  const key = JSON.stringify([apiBase, corpId, kfSecret]);
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const url = `${apiBase}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(kfSecret)}`;
  const data = await httpJson(cfg, url);
  if (data.errcode !== 0) throw new WecomApiError('gettoken', data);
  if (typeof data.access_token !== 'string') throw new Error('无效 access_token 响应');
  tokenCache.set(key, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 - TOKEN_RENEW_MARGIN_MS });
  return data.access_token;
}

export class WecomApiError extends Error {
  errcode: number;
  errmsg: string | undefined;

  constructor(api: string, data: { errcode: number; errmsg?: string }) {
    super(`${api} 失败: errcode=${data.errcode}`);
    this.name = 'WecomApiError';
    this.errcode = data.errcode;
    this.errmsg = data.errmsg;
  }
}

async function httpJson(cfg: WecomApiConfig, url: string, body?: unknown): Promise<any> {
  return requestJson(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }, { timeoutMs: cfg.upstreamTimeoutMs });
}

async function withToken<T>(cfg: WecomApiConfig, fn: (accessToken: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await getAccessToken(cfg));
  } catch (err) {
    // token 过期/失效时清缓存重试一次
    if (err instanceof WecomApiError && (err.errcode === 40014 || err.errcode === 42001)) {
      clearTokenCache();
      return await fn(await getAccessToken(cfg));
    }
    throw err;
  }
}

// 微信客服消息（msg_list 里的单条消息；事件/系统消息字段宽松可选）
export interface KfMessage {
  msgid: string;
  open_kfid?: string;
  external_userid?: string;
  origin?: number;
  send_time?: number;
  msgtype?: string;
  text?: { content?: string };
  image?: { media_id?: string };
  file?: { media_id?: string; file_name?: string };
  voice?: { media_id?: string };
  video?: { media_id?: string };
  [key: string]: unknown;
}

export interface WecomResponse {
  errcode: number;
  errmsg?: string;
  [key: string]: unknown;
}

export interface SyncMessagesResult extends WecomResponse {
  next_cursor?: string;
  has_more?: number;
  msg_list?: KfMessage[];
}

export interface SyncMessagesOptions {
  cursor?: string;
  token?: string;
  limit?: number;
  openKfId?: string;
}

// 拉取客服消息。cursor 为空表示从头开始，首次拉取必须带上回调事件里的 token
export function syncMessages(cfg: WecomApiConfig, { cursor = '', token = '', limit = 1000, openKfId = '' }: SyncMessagesOptions): Promise<SyncMessagesResult> {
  return withToken(cfg, async (accessToken) => {
    const body: { cursor: string; limit: number; open_kfid?: string; token?: string } = { cursor, limit, open_kfid: openKfId || undefined };
    if (token) body.token = token;
    const data: SyncMessagesResult = await httpJson(cfg, `${cfg.apiBase}/cgi-bin/kf/sync_msg?access_token=${accessToken}`, body);
    if (data.errcode !== 0) throw new WecomApiError('sync_msg', data);
    return data;
  });
}

export interface SendTextOptions {
  touser: string;
  openKfId: string;
  msgid: string;
  content: string;
}

export function sendText(cfg: WecomApiConfig, { touser, openKfId, msgid, content }: SendTextOptions): Promise<WecomResponse> {
  return withToken(cfg, async (accessToken) => {
    const data: WecomResponse = await httpJson(cfg, `${cfg.apiBase}/cgi-bin/kf/send_msg?access_token=${accessToken}`, {
      touser,
      open_kfid: openKfId,
      msgid,
      msgtype: 'text',
      text: { content },
    });
    if (data.errcode !== 0) throw new WecomApiError('send_msg', data);
    return data;
  });
}

// Media route is configurable for API compatibility; validate against the target account.
export async function getMedia(cfg: WecomApiConfig, mediaId: string): Promise<Buffer> {
  return withToken(cfg, async (accessToken) => {
    const { bytes, contentType } = await requestBytes(
      `${cfg.apiBase}${cfg.mediaPath || '/cgi-bin/media/get'}?access_token=${encodeURIComponent(accessToken)}&media_id=${encodeURIComponent(mediaId)}`,
      {}, { timeoutMs: cfg.upstreamTimeoutMs, maxBytes: (cfg.fileMaxMb ?? 20) * 1024 * 1024 },
    );
    // Successful .json files are allowed; only an API-shaped error envelope is rejected.
    if (contentType.includes('json') || bytes.subarray(0, 1).toString() === '{') {
      let data: { errcode?: number; errmsg?: string } | undefined;
      try { data = JSON.parse(bytes.toString('utf8')); } catch { /* binary / ordinary file */ }
      if (data && typeof data.errcode === 'number' && data.errcode !== 0 && typeof data.errmsg === 'string') {
        throw new WecomApiError('media_get', { errcode: data.errcode, errmsg: data.errmsg });
      }
    }
    return bytes;
  });
}
