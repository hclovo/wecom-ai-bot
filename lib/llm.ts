import { cursorCompletion } from './cursor-agent.ts';
import { requestJson } from './http-client.ts';
// 调用 OpenAI 兼容的 chat completions 接口（火山方舟 /api/v3 即此协议）

export type ChatContentPart =
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'text'; text: string };

export type ChatContent = string | ChatContentPart[];

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: ChatContent;
}

// 会话历史里只存纯文本消息（图片等多模态内容仅在调用时临时构造）
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  history: ChatMessage[];
  timeoutMs?: number;
  provider?: 'api' | 'cursor';
  cursorBin?: string;
  cursorStateDir?: string;
}

export async function chatCompletion(options: ChatOptions): Promise<string> {
  if (options.provider === 'cursor') return cursorCompletion(options);
  const { baseUrl, apiKey, model, systemPrompt, history, timeoutMs } = options;
  const messages = [{ role: 'system', content: systemPrompt }, ...history];
  const data = await requestJson<{ choices?: Array<{ message?: { content?: unknown } }> }>(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.8 }),
  }, { timeoutMs });
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content === '') throw new Error('LLM 返回异常');
  return content;
}
