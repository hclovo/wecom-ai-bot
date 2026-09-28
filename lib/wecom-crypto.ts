import crypto from 'node:crypto';

// 企业微信/微信客服回调的加解密与验签，协议见官方文档「加解密方案」：
// 密文 = Base64(AES-256-CBC(random(16B) + msg_len(4B, BE) + msg + receiveId))，PKCS7 按 32 字节块补齐

export interface SignatureParams {
  msg_signature: string;
  timestamp: string;
  nonce: string;
}

export function sha1Signature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  const items = [token, timestamp, nonce, encrypt].sort();
  return crypto.createHash('sha1').update(items.join('')).digest('hex');
}

export function verifySignature(token: string, { msg_signature, timestamp, nonce }: SignatureParams, encrypt: string): boolean {
  if (!/^[a-f0-9]{40}$/.test(msg_signature)) return false;
  return crypto.timingSafeEqual(Buffer.from(sha1Signature(token, timestamp, nonce, encrypt)), Buffer.from(msg_signature));
}

function keyFromEncodingAESKey(encodingAESKey: string): Buffer {
  const key = Buffer.from(encodingAESKey + '=', 'base64');
  if (key.length !== 32) throw new Error('EncodingAESKey 无效（解码后应为 32 字节）');
  return key;
}

export function decrypt(encryptB64: string, encodingAESKey: string): { message: string; receiveId: string } {
  const key = keyFromEncodingAESKey(encodingAESKey);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  let plain = Buffer.concat([decipher.update(Buffer.from(encryptB64, 'base64')), decipher.final()]);
  const pad = plain[plain.length - 1];
  if (plain.length < 32 || pad < 1 || pad > 32 || !plain.subarray(-pad).every((b) => b === pad)) throw new Error('无效密文 padding');
  plain = plain.subarray(0, plain.length - pad);
  if (plain.length < 20) throw new Error('无效密文长度');
  const msgLen = plain.readUInt32BE(16);
  if (msgLen > plain.length - 20) throw new Error('无效消息长度');
  return {
    message: plain.subarray(20, 20 + msgLen).toString('utf8'),
    receiveId: plain.subarray(20 + msgLen).toString('utf8'),
  };
}

export function encrypt(message: string, encodingAESKey: string, receiveId: string): string {
  const key = keyFromEncodingAESKey(encodingAESKey);
  const msgBuf = Buffer.from(message, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msgBuf.length, 0);
  let data = Buffer.concat([crypto.randomBytes(16), len, msgBuf, Buffer.from(receiveId, 'utf8')]);
  const blockSize = 32;
  const padLen = blockSize - (data.length % blockSize);
  data = Buffer.concat([data, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('base64');
}

export function xmlGet(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
  return m ? m[1] : undefined;
}
