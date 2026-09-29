import { HttpError } from './http-client.ts';

export interface ModelActivity {
  onActivity?: () => void;
  onText?: (text: string) => void;
}

// Model requests use an inactivity deadline, not a total-duration deadline.
// SSE keepalive comments do not count as model output.
export async function modelStream(url: string, init: RequestInit, options: {
  timeoutMs?: number; signal?: AbortSignal; onEvent: (event: any) => boolean; onActivity?: () => void;
}): Promise<any | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DOMException('Model idle timeout', 'TimeoutError')), options.timeoutMs ?? 600000);
  };
  touch();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abortRead = () => { void reader?.cancel().catch(() => {}); };
  try {
    const response = await fetch(url, { ...init, signal });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
    reader = response.body?.getReader();
    if (!reader) throw new Error('模型返回为空');
    signal.addEventListener('abort', abortRead, { once: true });
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    const decoder = new TextDecoder(); let buffer = '', bytes = 0, data: string[] = [];
    const dispatch = () => {
      if (!data.length) return;
      const value = data.join('\n'); data = [];
      if (value === '[DONE]') return;
      let event: unknown;
      try { event = JSON.parse(value); } catch { throw new Error('模型事件格式无效'); }
      if (options.onEvent(event)) { touch(); options.onActivity?.(); }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error('模型输出过大');
      buffer += decoder.decode(value, { stream: true });
      if (!sse) { touch(); options.onActivity?.(); continue; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (!line) dispatch();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    buffer += decoder.decode();
    if (!sse) {
      try { return JSON.parse(buffer); } catch { throw new Error('模型返回格式无效'); }
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim());
    dispatch();
    return undefined;
  } catch (error) {
    await reader?.cancel().catch(() => {});
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally { clearTimeout(timer!); signal.removeEventListener('abort', abortRead); reader?.releaseLock(); }
}
