import test from 'node:test';
import assert from 'node:assert/strict';
import { fitReplyBudget, intermediateContent, usefulIntermediate } from '../lib/reply-budget.ts';
import type { ReplyChunk } from '../lib/reply-types.ts';

test('acknowledgements, waiting notices and unfinished fragments are not intermediate results', () => {
  for (const text of ['收到', '好的。', '我先看看。', '正在生成图片，请稍等。', '仍在整理回复，请稍等。']) {
    assert.equal(usefulIntermediate(text), false); assert.equal(intermediateContent(text), '');
  }
  assert.equal(intermediateContent('实际结果尚未写完'), '');
  assert.equal(intermediateContent('计算结果是42。第二段正在'), '计算结果是42。');
});

test('final long text becomes a complete attachment while reserving both image and file slots', () => {
  const text = '完整说明😀'.repeat(1200);
  const attachments: ReplyChunk[] = [{ kind: 'image', base64: 'image' }, { kind: 'file', filename: 'demo.html', base64: 'file' }];
  const result = fitReplyBudget([text, ...attachments], 3);
  assert.equal(result.length, 3);
  const answer = result[0]; assert.ok(typeof answer !== 'string' && answer.kind === 'file');
  assert.equal(answer.filename, '回复内容.txt');
  assert.equal(Buffer.from(answer.base64, 'base64').toString('utf8'), text);
  assert.deepEqual(result.slice(1), attachments);
  assert.deepEqual(fitReplyBudget(['短回复', ...attachments], 3), ['短回复', ...attachments]);
});
