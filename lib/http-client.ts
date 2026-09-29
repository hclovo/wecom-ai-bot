// Bounded requests. Never include remote bodies or credential-bearing URLs in errors.
export class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`上游 HTTP ${status}`);
    this.status = status;
  }
}

export async function requestBytes(url: string, init: RequestInit = {}, options: {
  timeoutMs?: number; maxBytes?: number; signal?: AbortSignal;
} = {}): Promise<{ bytes: Buffer; contentType: string }> {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 30000);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const res = await fetch(url, { ...init, signal });
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(res.status);
  }
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel();
    throw new Error('响应超过大小上限');
  }
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error('响应超过大小上限');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  return { bytes: Buffer.concat(chunks), contentType: res.headers.get('content-type') || '' };
}

export async function requestJson<T>(url: string, init: RequestInit = {}, options: {
  timeoutMs?: number; signal?: AbortSignal;
} = {}): Promise<T> {
  const { bytes } = await requestBytes(url, init, options);
  try { return JSON.parse(bytes.toString('utf8')) as T; }
  catch { throw new Error('上游返回无效 JSON'); }
}

// Log only structured status codes, never untrusted error text / response content.
export function errorCode(error: unknown): string {
  if (error instanceof Error && ['CURSOR_NOT_INSTALLED','CURSOR_TIMEOUT','CURSOR_OUTPUT_INVALID','CURSOR_PROCESS_FAILED'].includes(error.name)) return error.name;
  if (error instanceof HttpError) return `HTTP_${error.status}`;
  if (error && typeof error === 'object' && 'errcode' in error) return `WECOM_${Number(error.errcode)}`;
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return error.name;
  return 'UPSTREAM_ERROR';
}

export function retryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 429 || error.status >= 500;
  if (error && typeof error === 'object' && 'errcode' in error) return [-1, 45009].includes(Number(error.errcode));
  return true; // network and timeout errors; attempt count always bounded by caller
}
