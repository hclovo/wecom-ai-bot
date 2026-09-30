import test from 'node:test';
import assert from 'node:assert/strict';
import { clearTokenCache, WecomApiError } from '../lib/wecom-api.ts';
import { diagnoseSendFailure } from '../lib/send-diagnostics.ts';

const cfg = { apiBase: 'https://wecom.test', corpId: 'corp', kfSecret: 'PRIVATE_SECRET' };
const failure = new WecomApiError('send_msg', { errcode: 95018, errmsg: 'PRIVATE_UPSTREAM' });

test('95018 diagnosis queries exact session read-only and describes each state', async (t) => {
  clearTokenCache();
  let state = 0;
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === '/cgi-bin/gettoken') return Response.json({ errcode: 0, access_token: 'PRIVATE_TOKEN', expires_in: 7200 });
    assert.equal(path, '/cgi-bin/kf/service_state/get');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { open_kfid: 'PRIVATE_KF', external_userid: 'PRIVATE_USER' });
    return Response.json({ errcode: 0, service_state: state, servicer_userid: 'PRIVATE_SERVICER' });
  });
  for (const hint of ['未处理', '智能助手接待', '人工排队中', '人工接待中', '已结束或未开始']) {
    const result = await diagnoseSendFailure(cfg, failure, 'PRIVATE_KF', 'PRIVATE_USER');
    assert.ok(result?.includes(`service_state=${state}`));
    assert.ok(result?.includes(hint));
    assert.ok(!result?.includes('PRIVATE'));
    state++;
  }
  assert.equal(paths.length, 6);
});

test('unrelated errors do not trigger diagnosis requests', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected request'); });
  for (const error of [new Error('network'), new WecomApiError('send_msg', { errcode: 45009 })]) {
    assert.equal(await diagnoseSendFailure(cfg, error, 'kf', 'user'), undefined);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('95001 explains the shared message allowance without querying or exposing provider details', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not query'); });
  const result = await diagnoseSendFailure(cfg, new WecomApiError('send_msg', { errcode: 95001, errmsg: 'PRIVATE' }), 'kf', 'user');
  assert.match(result!, /回复次数已用尽/);
  assert.match(result!, /无需重新生成/);
  assert.ok(!result!.includes('PRIVATE'));
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('query errors and malformed states stay diagnostic-only and never expose remote content', async (t) => {
  clearTokenCache();
  let reply: unknown;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url).includes('/gettoken')) return Response.json({ errcode: 0, access_token: 'PRIVATE_TOKEN', expires_in: 7200 });
    return Response.json(reply);
  });
  for (reply of [{ errcode: 48002, errmsg: 'PRIVATE_SECRET' }, { errcode: 0 }, { errcode: 0, service_state: 'PRIVATE_SECRET' }, { errcode: 0, service_state: 5 }]) {
    const result = await diagnoseSendFailure(cfg, failure, 'kf', 'user');
    assert.ok(result?.includes('service_state=UNKNOWN'));
    assert.ok(!result?.includes('PRIVATE'));
  }
});

test('expired query token refreshes once without retrying the send', async (t) => {
  clearTokenCache();
  let tokens = 0, queries = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === '/cgi-bin/gettoken') return Response.json({ errcode: 0, access_token: `token${++tokens}`, expires_in: 7200 });
    assert.equal(path, '/cgi-bin/kf/service_state/get');
    return Response.json(++queries === 1 ? { errcode: 42001 } : { errcode: 0, service_state: 3 });
  });
  assert.match((await diagnoseSendFailure(cfg, failure, 'kf', 'user'))!, /service_state=3/);
  assert.equal(tokens, 2);
  assert.equal(queries, 2);
});
