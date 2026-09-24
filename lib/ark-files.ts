// 火山方舟文件理解链路：Files API 上传 → 轮询 active → Responses API 以 file_id 提问
// LLM_BASE_URL 统一到版本号一层（如 https://ark.cn-beijing.volces.com/api/v3），
// 三个端点分别为 {base}/chat/completions、{base}/files、{base}/responses

import type { HistoryMessage } from './llm.ts';

const POLL_INTERVAL_MS = 1500;

// Files API 返回的文件对象（用到的字段，其余透传保留）
export interface ArkFileInfo {
  id: string;
  filename?: string;
  status?: string;
  [key: string]: unknown;
}

export interface UploadFileOptions {
  baseUrl: string;
  apiKey: string;
  buffer: Buffer | Uint8Array;
  filename: string;
  purpose?: string;
}

export async function uploadFile({ baseUrl, apiKey, buffer, filename, purpose = 'file-extract' }: UploadFileOptions): Promise<ArkFileInfo> {
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', new Blob([new Uint8Array(buffer)]), filename);
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as ArkFileInfo;
  if (!res.ok) throw new Error(`文件上传 HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  if (!data.id) throw new Error(`文件上传返回异常: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

export interface WaitFileActiveOptions {
  baseUrl: string;
  apiKey: string;
  fileId: string;
  timeoutMs?: number;
}

export async function waitFileActive({ baseUrl, apiKey, fileId, timeoutMs = 60000 }: WaitFileActiveOptions): Promise<ArkFileInfo> {
  const deadline = Date.now() + timeoutMs;
  let last: ArkFileInfo | null = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/files/${fileId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    last = (await res.json().catch(() => ({}))) as ArkFileInfo;
    if (last.status === 'active') return last;
    if (last.status === 'failed') throw new Error(`文件处理失败: ${JSON.stringify(last).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`文件处理超时（${Math.round(timeoutMs / 1000)}s），状态: ${last?.status || 'unknown'}`);
}

// Responses API 响应（只声明用到的字段）
interface ResponsesPayload {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  [key: string]: unknown;
}

// 从 Responses API 响应中提取助手文本（兼容 output[].content[].output_text 与顶层 output_text）
function extractOutputText(data: ResponsesPayload): string {
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  const parts: string[] = [];
  for (const item of data.output || []) {
    for (const c of item.content || []) {
      if (c.type === 'output_text' && c.text) parts.push(c.text);
    }
  }
  return parts.join('');
}

export interface AskFileOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fileId: string;
  question: string;
  history?: HistoryMessage[];
}

// 文档问答：file_id + 提问 + 可选的历史文本消息
export async function askFile({ baseUrl, apiKey, model, fileId, question, history = [] }: AskFileOptions): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        {
          role: 'user',
          content: [
            { type: 'input_file', file_id: fileId },
            { type: 'input_text', text: question },
          ],
        },
      ],
    }),
  });
  const data = (await res.json().catch(() => ({}))) as ResponsesPayload;
  if (!res.ok) throw new Error(`文件问答 HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const text = extractOutputText(data);
  if (!text) throw new Error(`文件问答返回异常: ${JSON.stringify(data).slice(0, 300)}`);
  return text;
}
