import { chatCompletion } from './llm.ts';
import type { ChatOptions } from './llm.ts';
import type { ImageReply, ReplyChunk } from './reply-types.ts';
import { errorCode } from './http-client.ts';

const REPLY_FORMAT = `回复格式：只输出 JSON 对象 {"text":"给用户的文字回复","image_prompt":null}，不要 Markdown 代码围栏。
用户要求图片，或示意图、流程图、图表、简单插画能明显帮助说明时，将 image_prompt 设为完整、独立的中文绘图描述（最多4000字符），系统会绘图并作为真正的图片附件发送。无需用户使用 /draw。根据上下文理解“画出来”“配张图”等追问。
普通闲聊只回复文字，image_prompt 为 null。每轮最多配一张图。不支持网络图片检索或修改上传图片。不要编造图片链接、声称已发送文件或把绘图描述放进 text。配图描述须包含必要的数据、标注和布局，不能只写“如上所述”。`;

export function parseConversationReply(raw: string): { text: string; imagePrompt: string | null } {
  const input = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  let value: unknown;
  try { value = JSON.parse(input); } catch { return { text: raw, imagePrompt: null }; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('text' in value) || !('image_prompt' in value)) {
    return { text: raw, imagePrompt: null };
  }
  const reply = value as { text: unknown; image_prompt: unknown };
  if (typeof reply.text !== 'string' || !(reply.image_prompt === null || typeof reply.image_prompt === 'string')) throw new Error('无效对话回复');
  const imagePrompt = typeof reply.image_prompt === 'string' ? reply.image_prompt.trim() || null : null;
  if (imagePrompt && imagePrompt.length > 4000) throw new Error('配图描述过长');
  if (!reply.text.trim() && !imagePrompt) throw new Error('空对话回复');
  return { text: reply.text.trim(), imagePrompt };
}

export async function conversationReply(options: ChatOptions, draw: (prompt: string) => Promise<ImageReply>, mode: 'native' | 'svg' = 'svg'): Promise<{ chunks: ReplyChunk[]; historyText: string }> {
  const capability = mode === 'native' ? '配图使用原生图片生成工具，可生成插画、写实风格图片等。' : '配图使用 SVG 渲染，只支持示意图、图表、简单插画，不支持照片级效果。';
  const reply = parseConversationReply(await chatCompletion({ ...options, systemPrompt: `${options.systemPrompt}\n\n${REPLY_FORMAT}\n${capability}` }));
  const chunks: ReplyChunk[] = reply.text ? [reply.text] : [];
  let historyText = reply.text;
  if (reply.imagePrompt) {
    try {
      chunks.push(await draw(reply.imagePrompt));
      historyText += `\n[已生成配图：${reply.imagePrompt}]`;
    } catch (error) {
      console.error('[conversation-draw]', errorCode(error));
      const notice = '这次配图生成失败了，可以稍后让我重画。';
      chunks.push(notice);
      historyText += `\n${notice}`;
    }
  }
  return { chunks, historyText };
}
