// Strings remain plain text for compatibility with existing handlers and stored replies.
export interface ImageReply { kind: 'image'; base64: string }
export interface FileReply { kind: 'file'; filename: string; base64: string }
export type ReplyChunk = string | ImageReply | FileReply;
export interface BotReply { session?: string; chunks: ReplyChunk[] }
