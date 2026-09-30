import { chatCompletion } from './llm.ts';
import type { ChatOptions } from './llm.ts';
import type { ImageReply, FileReply, ReplyChunk } from './reply-types.ts';
import { errorCode } from './http-client.ts';
import { textFileReply } from './file-reply.ts';

const REPLY_FORMAT = `回复格式：只输出 JSON 对象 {"text":"给用户的文字回复","image_prompt":null,"files":[]}，text 必须是第一个字段，不要 Markdown 代码围栏。text 会先展示给用户，只包含可直接发送的答复，不包含内部思考过程、模型或工具信息。
每轮包括最终结果在内最多发送5条消息，图片和文件各占1条。中间只输出已经完成、有信息量的内容，最多2段，为最终结果预留位置。不要输出首次确认、寒暄或等待话术，例如“收到”“我先看看”“我来处理”“正在生成”“请稍等”。没有实际中间结果就等到完成再回复，不必凑消息数。答案很长时整理成文件，不要拆成大量聊天消息；仅需附件时 text 可以为空。
你可以生成并发送真正的文件附件。用户要求 HTML、文本或代码文件，或要求把之前的内容发成文件时，files 填 [{"filename":"名称.html","content":"完整文件内容"}]，系统会上传并发送文件。不要再说只能打字、不能发文件，不要让用户自己复制另存，不要被历史中的旧能力说明误导。每轮最多一个文件，内容最多40000字符且不超过200KB。支持 html/htm/txt/md/csv/json/svg/css/js/ts/py/xml/yaml/yml；不支持生成 PDF、Office 或其他二进制附件，不得用文本伪装这些格式。HTML 使用 UTF-8，尽量包含完整样式与脚本，避免依赖外部资源。文件内容放在 content 中，不重复粘贴到 text；没有附件时 files 为 []。生成的代码只作为文件发送，系统不会执行。
用户要求图片，或示意图、流程图、图表、简单插画能明显帮助说明时，将 image_prompt 设为完整、独立的中文绘图描述（最多4000字符），系统会绘图并作为真正的图片附件发送。无需用户使用 /draw。根据上下文理解“画出来”“配张图”等追问。
普通闲聊只回复文字，image_prompt 为 null。每轮最多配一张图。不支持网络图片检索或修改上传图片。不要编造下载链接；未提供附件内容时不要声称生成了文件。不要把绘图描述放进 text。配图描述须包含必要的数据、标注和布局，不能只写“如上所述”。`;

export function parseConversationReply(raw: string): { text: string; imagePrompt: string | null; files: FileReply[] } {
  const input = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  let value: unknown;
  try { value = JSON.parse(input); } catch { return { text: raw, imagePrompt: null, files: [] }; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('text' in value) || !('image_prompt' in value)) {
    return { text: raw, imagePrompt: null, files: [] };
  }
  const reply = value as { text: unknown; image_prompt: unknown; files?: unknown };
  if (typeof reply.text !== 'string' || !(reply.image_prompt === null || typeof reply.image_prompt === 'string')) throw new Error('无效对话回复');
  const imagePrompt = typeof reply.image_prompt === 'string' ? reply.image_prompt.trim() || null : null;
  if (imagePrompt && imagePrompt.length > 4000) throw new Error('配图描述过长');
  if (reply.files !== undefined && (!Array.isArray(reply.files) || reply.files.length > 1)) throw new Error('文件列表无效');
  const files = ((reply.files || []) as unknown[]).map(file => {
    if (!file || typeof file !== 'object') throw new Error('文件格式无效');
    const data = file as { filename?: unknown; content?: unknown };
    return textFileReply(data.filename, data.content);
  });
  if (!reply.text.trim() && !imagePrompt && !files.length) throw new Error('空对话回复');
  return { text: reply.text.trim(), imagePrompt, files };
}

// Decode only the first public text string as it arrives. Never cross its closing
// quote into reasoning, image prompts or file contents; hold incomplete escapes.
export function publicReplyText(raw: string): string | undefined {
  const match = raw.match(/^\s*(?:```(?:json)?\s*)?\{\s*"text"\s*:\s*"/);
  if (!match) return undefined;
  let text = '';
  for (let i = match[0].length; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"') break;
    if (char === '\\') {
      const length = raw[i + 1] === 'u' ? 6 : 2;
      if (i + length > raw.length) break;
      const escape = raw.slice(i, i + length);
      try { text += JSON.parse(`"${escape}"`); } catch { return undefined; }
      i += length - 1;
    } else {
      if (char.charCodeAt(0) < 32) return undefined;
      text += char;
    }
  }
  // A split UTF-16 surrogate pair is not a displayable character yet.
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return text.trim();
}

export async function conversationReply(options: ChatOptions, draw: (prompt: string) => Promise<ImageReply>, mode: 'native' | 'svg' = 'svg'): Promise<{ chunks: ReplyChunk[]; historyText: string }> {
  const capability = mode === 'native' ? '配图使用原生图片生成工具，可生成插画、写实风格图片等。' : '配图使用 SVG 渲染，只支持示意图、图表、简单插画，不支持照片级效果。';
  const reply = parseConversationReply(await chatCompletion({ ...options, systemPrompt: `${options.systemPrompt}\n\n${REPLY_FORMAT}\n${capability}`,
    onText: raw => { const text = publicReplyText(raw); if (text !== undefined) options.onText?.(text); },
  }));
  const chunks: ReplyChunk[] = reply.text ? [reply.text] : [];
  let historyText = reply.text;
  for (const file of reply.files) {
    chunks.push(file);
    historyText += `\n[已生成文件：${file.filename}]\n${Buffer.from(file.base64, 'base64').toString('utf8')}`;
  }
  if (reply.imagePrompt) {
    try {
      chunks.push(await draw(reply.imagePrompt));
      historyText += `\n[已生成配图：${reply.imagePrompt}]`;
    } catch (error) {
      console.error('[conversation-draw]', errorCode(error));
      const notice = '配图生成失败，请稍后重试。';
      chunks.push(notice);
      historyText += `\n${notice}`;
    }
  }
  return { chunks, historyText };
}
