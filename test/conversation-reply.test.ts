import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationReply, parseConversationReply } from '../lib/conversation-reply.ts';

const options = { baseUrl: 'https://model.test/v1', apiKey: 'test', model: 'chat-model', systemPrompt: '友好回答',
  history: [{ role: 'user' as const, content: '解释一下循环，配张图' }] };

test('ordinary conversation returns text and an actual image, retaining context for follow-ups', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    assert.match(request.messages[0].content, /image_prompt/);
    assert.equal(request.messages.at(-1).content, '解释一下循环，配张图');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ text: '循环会重复执行。', image_prompt: '循环流程图：开始、判断条件、执行、返回判断、结束' }) } }] });
  });
  const result = await conversationReply(options, async prompt => {
    assert.match(prompt, /判断条件/);
    return { kind: 'image', base64: 'IMAGE_BYTES' };
  });
  assert.deepEqual(result.chunks, ['循环会重复执行。', { kind: 'image', base64: 'IMAGE_BYTES' }]);
  assert.match(result.historyText, /已生成配图：循环流程图/);
  assert.ok(!result.historyText.includes('IMAGE_BYTES'));
});

test('plain chat never draws and remains compatible with non-JSON model responses', async t => {
  let output = JSON.stringify({ text: '你好', image_prompt: null });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: output } }] }));
  const draw = async (): Promise<never> => { throw new Error('must not draw'); };
  assert.deepEqual((await conversationReply(options, draw)).chunks, ['你好']);
  output = '普通文字';
  assert.deepEqual((await conversationReply(options, draw)).chunks, ['普通文字']);
  assert.throws(() => parseConversationReply('{"text":"","image_prompt":null}'));
  assert.throws(() => parseConversationReply(JSON.stringify({ text: 'hi', image_prompt: 'a'.repeat(4001) })));
});

test('drawing failure preserves text and does not falsely record an image as generated', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: '{"text":"讲解内容","image_prompt":"示意图"}' } }] }));
  const result = await conversationReply(options, async () => { throw new Error('SECRET'); });
  assert.equal(result.chunks[0], '讲解内容');
  assert.match(String(result.chunks[1]), /配图生成失败/);
  assert.ok(!result.historyText.includes('已生成配图'));
  assert.ok(!result.historyText.includes('SECRET'));
});
