import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, copyFileSync, existsSync, statSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);

test('startup help needs no database or configuration', async () => {
  const result = await exec('sh', ['start.sh', '--help']);
  assert.match(result.stdout, /local\|docker\|check/);
});

test('first startup creates a private editable env and never overwrites it', async () => {
  const dir=mkdtempSync(join(tmpdir(),'wecom-start-'));
  try {
    copyFileSync('start.sh',join(dir,'start.sh'));copyFileSync('.env.example',join(dir,'.env.example'));
    await assert.rejects(exec('sh',[join(dir,'start.sh')]), (e: any)=>e.code===2 && e.stdout.includes('已生成 .env'));
    const target=join(dir,'.env');assert.ok(existsSync(target));assert.equal(statSync(target).mode & 0o777,0o600);
    const original=readFileSync(target,'utf8');
    await exec('sh',[join(dir,'start.sh'),'--help']);
    assert.equal(readFileSync(target,'utf8'),original);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('configuration check validates fields without connecting or leaking credentials', async () => {
  const env={...process.env,WECOM_CORP_ID:'test-corp',WECOM_KF_SECRET:'FAKE_SECRET',WECOM_TOKEN:'test-token',
    WECOM_ENCODING_AES_KEY:Buffer.alloc(32,1).toString('base64').slice(0,43),LLM_API_KEY:'FAKE_KEY',LLM_MODEL:'test-model',
    DATABASE_URL:'postgresql://test:DO_NOT_PRINT_PASSWORD@127.0.0.1:1/test'};
  const result=await exec(process.execPath,[resolve('scripts/check-config.ts')],{env,timeout:3000});
  assert.match(result.stdout,/未连接数据库/);
  assert.ok(!result.stdout.includes('DO_NOT_PRINT_PASSWORD'));
  await assert.rejects(exec(process.execPath,[resolve('scripts/check-config.ts')],{env:{...env,LLM_MODEL:'ep-2024xxxxxxxxxxxxxxxx'}}),
    (e:any)=>e.code===1 && e.stderr.includes('LLM_MODEL') && !e.stderr.includes('DO_NOT_PRINT_PASSWORD') && !e.stderr.includes('FAKE_SECRET'));
});
