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
}

export async function chatCompletion({ baseUrl, apiKey, model, systemPrompt, history }: ChatOptions): Promise<string> {
  const messages = [{ role: 'system', content: systemPrompt }, ...history];
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.8 }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`LLM HTTP ${res.status}: ${detail.slice(0, 500)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content === '') throw new Error(`LLM 返回异常: ${JSON.stringify(data).slice(0, 300)}`);
  return content;
}
