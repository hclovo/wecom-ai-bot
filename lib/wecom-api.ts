// 微信客服（kf）服务端 API 封装：access_token、同步消息、发送消息
// 文档：https://developer.work.weixin.qq.com/document/path/94670

// 这些接口实际只用到配置里的这几个字段（结构化最小类型，server.ts 的 Config 可直接传入）
export interface WecomApiConfig {
  apiBase: string;
  corpId: string;
  kfSecret: string;
}

const TOKEN_RENEW_MARGIN_MS = 5 * 60 * 1000;
let tokenCache: { token: string | null; expiresAt: number } = { token: null, expiresAt: 0 };

export function clearTokenCache(): void {
  tokenCache = { token: null, expiresAt: 0 };
}

async function getAccessToken({ apiBase, corpId, kfSecret }: WecomApiConfig): Promise<string> {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const url = `${apiBase}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(kfSecret)}`;
  const data = await httpJson(url);
  if (data.errcode !== 0) throw new WecomApiError('gettoken', data);
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 - TOKEN_RENEW_MARGIN_MS };
  return tokenCache.token as string;
}

export class WecomApiError extends Error {
  errcode: number;
  errmsg: string | undefined;

  constructor(api: string, data: { errcode: number; errmsg?: string }) {
    super(`${api} 失败: errcode=${data.errcode} errmsg=${data.errmsg}`);
    this.name = 'WecomApiError';
    this.errcode = data.errcode;
    this.errmsg = data.errmsg;
  }
}

async function httpJson(url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}: ${await res.text()}`);
  return res.json();
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
    if (cursor === '' && token) body.token = token;
    const data: SyncMessagesResult = await httpJson(`${cfg.apiBase}/cgi-bin/kf/sync_msg?access_token=${accessToken}`, body);
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
    const data: WecomResponse = await httpJson(`${cfg.apiBase}/cgi-bin/kf/send_msg?access_token=${accessToken}`, {
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

// 下载客户发来的媒体文件（图片/文件的 media_id 均来自 sync_msg 的消息体）
// 文档：微信客服「获取媒体文件」GET /cgi-bin/kf/media/get，成功返回二进制流，失败返回 JSON
export async function getMedia(cfg: WecomApiConfig, mediaId: string): Promise<Buffer> {
  const accessToken = await getAccessToken(cfg);
  const res = await fetch(`${cfg.apiBase}/cgi-bin/kf/media/get?access_token=${accessToken}&media_id=${encodeURIComponent(mediaId)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    try {
      const data = JSON.parse(buf.toString('utf8'));
      if (data && typeof data.errcode === 'number') throw new WecomApiError('media_get', data);
    } catch (err) {
      if (err instanceof WecomApiError) throw err;
    }
    throw new Error(`media_get HTTP ${res.status}（media_id=${mediaId.slice(0, 12)}…）`);
  }
  return buf;
}
