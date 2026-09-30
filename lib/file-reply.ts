import type { FileReply } from './reply-types.ts';

export const GENERATED_FILE_MAX_BYTES = 200 * 1024;
export const GENERATED_FILE_MAX_CHARS = 40000;
// These are text artifacts. Do not label plain text as a binary Office/PDF file.
const EXTENSIONS = new Set(['html', 'htm', 'txt', 'md', 'csv', 'json', 'svg', 'css', 'js', 'ts', 'py', 'xml', 'yaml', 'yml']);

export function textFileReply(filename: unknown, content: unknown): FileReply {
  if (typeof filename !== 'string' || typeof content !== 'string') throw new Error('文件格式无效');
  if (!filename || Buffer.byteLength(filename) > 180 || filename !== filename.trim() ||
    /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(filename) || filename.startsWith('.') ||
    !EXTENSIONS.has(filename.split('.').at(-1)!.toLowerCase())) throw new Error('文件名无效');
  if (!content.trim() || content.length > GENERATED_FILE_MAX_CHARS || Buffer.byteLength(content) > GENERATED_FILE_MAX_BYTES) throw new Error('文件内容为空或过大');
  return { kind: 'file', filename, base64: Buffer.from(content, 'utf8').toString('base64') };
}

// Extract source only; never execute model-generated HTML or rename prose to HTML.
export function extractHtmlDocument(content: string): { html: string; remainder: string } | undefined {
  const fences = [...content.matchAll(/```(?:html?)?\s*\n([\s\S]*?)```/gi)];
  if (fences.length === 1) {
    const html = fences[0][1].trim();
    if (/^(?:<!doctype\s+html[^>]*>\s*)?<html\b/i.test(html) && /<\/html\s*>\s*$/i.test(html)) {
      return { html, remainder: content.replace(fences[0][0], '').trim() };
    }
  }
  const start = content.search(/<!doctype\s+html\b|<html\b/i);
  const ends = [...content.matchAll(/<\/html\s*>/gi)];
  if (start < 0 || !ends.length) return undefined;
  const last = ends.at(-1)!;
  const end = last.index! + last[0].length;
  return { html: content.slice(start, end).trim(), remainder: (content.slice(0, start) + content.slice(end)).trim() };
}
