import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion } from '../lib/llm.ts';
import { publicReplyText } from '../lib/conversation-reply.ts';
import { askFile } from '../lib/ark-files.ts';

const options = { baseUrl: 'https://model.test', apiKey: 'test', model: 'test', systemPrompt: 'test', history: [], timeoutMs: 100 };

function events(values: string[], interval = 30): Response {
  let timer: ReturnType<typeof setInterval>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0;
      timer = setInterval(() => {
        if (index === values.length) { clearInterval(timer); controller.close(); return; }
        controller.enqueue(Buffer.from(values[index++]));
      }, interval);
    },
    cancel() { clearInterval(timer); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

test('chat stream can exceed its inactivity timeout while tokens arrive; reasoning is never public text', async t => {
  const publicText: string[] = []; let activity = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return events([
      event({ choices: [{ delta: { reasoning_content: 'PRIVATE_THOUGHT' } }] }),
      event({ choices: [{ delta: { content: '你好' } }] }),
      event({ choices: [{ delta: { content: '，' } }] }),
      event({ choices: [{ delta: { content: '世界' } }] }),
      event({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n',
    ]);
  });
  const start = Date.now();
  assert.equal(await chatCompletion({ ...options, onText: text => publicText.push(text), onActivity: () => activity++ }), '你好，世界');
  assert.ok(Date.now() - start > options.timeoutMs);
  assert.ok(activity >= 4); assert.ok(!publicText.join('').includes('PRIVATE_THOUGHT'));
});

test('SSE keepalives do not prevent an idle timeout and a truncated answer is rejected', async t => {
  t.mock.method(globalThis, 'fetch', async () => events(Array(20).fill(': ping\n\n'), 20));
  await assert.rejects(chatCompletion(options), (error: Error) => error.name === 'TimeoutError');
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => events([event({ choices: [{ delta: { content: 'unfinished' } }] })], 1));
  await assert.rejects(chatCompletion(options), /不完整/);
});

test('only the completed public text JSON field is exposed, not file source or reasoning', () => {
  assert.equal(publicReplyText('{"text":"你好'), undefined);
  assert.equal(publicReplyText('{"text":"你好\\n世界","files":[{"content":"PRIVATE_SOURCE'), '你好\n世界');
  assert.equal(publicReplyText('{"reasoning":"PRIVATE_THOUGHT"}'), undefined);
  assert.equal(publicReplyText('<svg>PRIVATE_SOURCE</svg>'), undefined);
  assert.equal(publicReplyText('{"text":"\\u4f'), undefined);
});

test('Responses file answers also use streaming idle deadlines', async t => {
  t.mock.method(globalThis, 'fetch', async () => events([
    event({ type: 'response.reasoning_summary_text.delta', delta: 'PRIVATE_THOUGHT' }),
    event({ type: 'response.output_text.delta', delta: '文档' }),
    event({ type: 'response.output_text.delta', delta: '摘要' }),
    event({ type: 'response.completed', response: {} }),
  ]));
  const text: string[] = [];
  assert.equal(await askFile({ ...options, fileId: 'f', question: '总结', onText: value => text.push(value) }), '文档摘要');
  assert.ok(!text.join('').includes('PRIVATE_THOUGHT'));
});
