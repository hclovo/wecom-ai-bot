import test from 'node:test';
import assert from 'node:assert/strict';
import { textFileReply } from '../lib/file-reply.ts';
import { conversationReply, parseConversationReply } from '../lib/conversation-reply.ts';
import { clearTokenCache, uploadFileMedia, sendFile } from '../lib/wecom-api.ts';

const html = '<!doctype html><html lang="zh"><meta charset="UTF-8"><title>骑车的鹈鹕</title><script>document.body.dataset.ready="yes"</script></html>';

test('ordinary conversation produces a real HTML attachment and keeps its source for follow-up edits', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    assert.match(request.messages[0].content, /真正的文件附件/);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ text: '文件做好了。', image_prompt: null,
      files: [{ filename: '骑车的鹈鹕.html', content: html }] }) } }] });
  });
  const result = await conversationReply({ baseUrl: 'https://model.test', apiKey: 'test', model: 'test', systemPrompt: '简洁回复',
    history: [{ role: 'user', content: '把刚才那个动画发成HTML文件' }] }, async () => { throw new Error('must not draw'); });
  assert.deepEqual(result.chunks, ['文件做好了。', textFileReply('骑车的鹈鹕.html', html)]);
  assert.match(result.historyText, /<!doctype html>/);
  const file = result.chunks[1];
  assert.ok(typeof file !== 'string' && file.kind === 'file');
  assert.equal(Buffer.from(file.base64, 'base64').toString('utf8'), html);
  assert.equal(parseConversationReply(JSON.stringify({ text: '', image_prompt: null, files: [{ filename: 'a.html', content: html }] })).files.length, 1);
});

test('file artifacts reject paths, binary formats, empty bodies, oversized content and multiple attachments', () => {
  for (const filename of ['../a.html', '/a.html', 'a\\b.html', 'a\n.html', 'a.pdf', 'a.docx', '.env', 'a.exe']) assert.throws(() => textFileReply(filename, html));
  assert.throws(() => textFileReply('a.html', ' '));
  assert.throws(() => textFileReply('a.html', 'x'.repeat(40001)));
  assert.throws(() => parseConversationReply(JSON.stringify({ text: 'hi', image_prompt: null, files: [
    { filename: 'a.html', content: html }, { filename: 'b.html', content: html },
  ] })));
});

test('file upload retains filename and bytes, refreshes token, and sends a file media message', async t => {
  clearTokenCache(); let uploads = 0, tokens = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/gettoken')) return Response.json({ errcode: 0, access_token: `token${++tokens}`, expires_in: 7200 });
    if (parsed.pathname.endsWith('/media/upload')) {
      assert.equal(parsed.searchParams.get('type'), 'file');
      const media = (init!.body as FormData).get('media') as File;
      assert.equal(media.name, '骑车的鹈鹕.html');
      assert.equal(await media.text(), html);
      return Response.json(++uploads === 1 ? { errcode: 42001 } : { media_id: 'file-media' });
    }
    assert.ok(parsed.pathname.endsWith('/kf/send_msg'));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.msgtype, 'file'); assert.deepEqual(body.file, { media_id: 'file-media' }); assert.equal(body.msgid, 'stable-file-id');
    return Response.json({ errcode: 0 });
  });
  const cfg = { apiBase: 'https://wecom.test', corpId: 'corp', kfSecret: 'test' };
  const mediaId = await uploadFileMedia(cfg, Buffer.from(html), '骑车的鹈鹕.html');
  await sendFile(cfg, { touser: 'u', openKfId: 'kf', msgid: 'stable-file-id', mediaId });
  assert.equal(tokens, 2); assert.equal(uploads, 2);
});
