import type { ReplyChunk } from './reply-types.ts';
import { textPrefix } from './task-progress.ts';

export const MAX_REPLY_MESSAGES = 5;
// Reserve room for the remaining answer, one image and one file.
export const MAX_INTERMEDIATE_MESSAGES = 2;

export function usefulIntermediate(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/^(?:好的|收到|明白|了解|没问题|请稍等|稍等一下)[，。！!]?$/u.test(value)) return false;
  return !/^(?:好的[，。！!]?\s*)?(?:正在|仍在|请稍等|稍等|我先|我来|我会|已收到|收到[，。]|(?:文件|图片)(?:已|已经)?(?:生成|做好|准备好))/.test(value);
}

export function intermediateContent(value: string): string {
  if (!usefulIntermediate(value)) return '';
  const prefix = textPrefix(value);
  const boundary = [...prefix.matchAll(/[。！？!?；;\n]/gu)].at(-1);
  if (boundary) return prefix.slice(0, boundary.index! + boundary[0].length);
  return Buffer.byteLength(prefix) >= 600 ? prefix : '';
}

// Preserve long answers as an attachment instead of dropping text or exceeding
// the remaining message budget. Generated replies have at most two attachments.
export function fitReplyBudget(chunks: ReplyChunk[], slots: number): ReplyChunk[] {
  if (chunks.length <= slots && chunks.every(chunk => typeof chunk !== 'string' || Buffer.byteLength(chunk) <= 1000)) return chunks;
  const text = chunks.filter((chunk): chunk is string => typeof chunk === 'string').join('');
  const attachments = chunks.filter(chunk => typeof chunk !== 'string');
  if (attachments.length > slots) throw new Error('回复附件过多');
  const textSlots = slots - attachments.length;
  if (!text) return attachments;
  if (textSlots < 1) throw new Error('回复空间不足');
  const parts: string[] = [];
  let remaining = text;
  while (remaining && parts.length < textSlots) {
    const part = textPrefix(remaining); parts.push(part); remaining = remaining.slice(part.length);
  }
  if (!remaining) return [...parts, ...attachments];
  return [{ kind: 'file', filename: '回复内容.txt', base64: Buffer.from(text, 'utf8').toString('base64') }, ...attachments];
}
