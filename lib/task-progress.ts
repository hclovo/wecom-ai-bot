export type ProgressStage = 'reply' | 'image' | 'file';
export interface TaskProgress {
  activity(stage?: ProgressStage): void;
  text(value: string): void;
}

export function textPrefix(value: string, maxBytes = 1000): string {
  let text = '', bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    text += char; bytes += size;
  }
  return text;
}
