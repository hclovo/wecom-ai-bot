import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cursorAuthenticated, cursorCompletion, ensureCursorLogin, cursorGenerateImage, readGeneratedImage, imageRunDiagnostic, cursorEnvironment } from '../lib/cursor-agent.ts';
import { chatCompletion } from '../lib/llm.ts';
import { generateImage, generateNativeImage } from '../lib/image-generation.ts';
import sharp from 'sharp';
import { loadConfig } from '../server.ts';

async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'wecom-cursor-test-'));
  const bin=join(dir,'fake-agent');
  await writeFile(bin,`#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);
const auth=path.join(process.env.CURSOR_CONFIG_DIR,'test-auth');
if(args[0]==='status'){console.log(JSON.stringify({isAuthenticated:fs.existsSync(auth)}));process.exit(0);}
if(args[0]==='login'){console.log('https://cursor.com/mock-login');fs.writeFileSync(auth,'logged in');process.exit(0);}
if(args.includes('--force')||args.includes('--resume')||args.includes('--continue'))process.exit(2);
if(args[args.indexOf('--mode')+1]!=='ask')process.exit(3);
if(process.env.DATABASE_URL||process.env.WECOM_KF_SECRET||process.env.LLM_API_KEY)process.exit(4);
const permissions=JSON.parse(fs.readFileSync('.cursor/cli.json','utf8')).permissions;
if(!permissions.deny.includes('Shell(*)')||!permissions.deny.includes('Read(/**)')||!permissions.deny.includes('Mcp(*:*)'))process.exit(5);
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);
process.stdin.on('end',()=>{
 const model=args[args.indexOf('--model')+1];
 if(model==='streaming'){
   let n=0;const timer=setInterval(()=>{
     if(++n<10)console.log(JSON.stringify({type:'thinking',subtype:'delta',text:'PRIVATE_THOUGHT'}));
     else {clearInterval(timer);console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'hello'}]}}));console.log(JSON.stringify({type:'result',result:'hello'}));}
   },100);return;
 }
 if(model==='stderr'){setInterval(()=>console.error('noise'),20);return;}
 if(model==='timeout'){setInterval(()=>{},1000);return;}
 if(model==='fail'){console.error('PRIVATE_SECRET_FROM_REMOTE');process.exit(9);}
 if(model==='malformed'){console.log('not json');return;}
 if(model==='svg'){console.log(JSON.stringify({type:'result',is_error:false,result:'<svg><circle cx="500" cy="500" r="300" fill="blue"/></svg>'}));return;}
 const data=JSON.parse(input.slice(input.indexOf('{')));
 const output=JSON.stringify({type:'result',is_error:false,result:JSON.stringify({cwd:process.cwd(),conversation:data.conversation})});
 const bytes=Buffer.from(output);let offset=0;
 const next=()=>{if(offset<bytes.length){process.stdout.write(bytes.subarray(offset,offset+1));offset++;setImmediate(next);}};next();
});
`,{mode:0o700});
  return {cursorBin:bin,cursorStateDir:join(dir,'state'),dir};
}

test('Cursor startup login waits for successful status and reuses saved authentication',async()=>{
  const f=await fixture();
  try {
    assert.equal(await cursorAuthenticated(f),false);
    await ensureCursorLogin(f);
    assert.equal(await cursorAuthenticated(f),true);
    await ensureCursorLogin(f);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('Cursor receives context as stdin, no service secrets, no tools, and isolated workspaces',async(t)=>{
  const f=await fixture();const oldDb=process.env.DATABASE_URL,oldSecret=process.env.WECOM_KF_SECRET;
  process.env.DATABASE_URL='PRIVATE_DATABASE';process.env.WECOM_KF_SECRET='PRIVATE_WECOM';
  try{
    const content='你好 $(touch /tmp/do-not-run) --force';
    const first=JSON.parse(await cursorCompletion({...f,systemPrompt:'只回答',history:[{role:'user',content}]}));
    assert.equal(first.conversation[0].content,content);
    const second=JSON.parse(await cursorCompletion({...f,systemPrompt:'只回答',history:[{role:'user',content:'另一位用户'}]}));
    assert.notEqual(first.cwd,second.cwd);assert.equal(second.conversation.length,1);
    await assert.rejects(readFile(join(first.cwd,'.cursor/cli.json')));
    assert.equal(JSON.parse(await readFile(join(f.cursorStateDir,'config','cli-config.json'),'utf8')).permissions.allow.length,0);
  }finally{
    if(oldDb===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldDb;
    if(oldSecret===undefined)delete process.env.WECOM_KF_SECRET;else process.env.WECOM_KF_SECRET=oldSecret;
    await rm(f.dir,{recursive:true,force:true});
  }
});

test('Cursor errors are bounded and do not expose stderr or require an API key',async()=>{
  const f=await fixture();
  try{
    for(const [model,code] of [['timeout','CURSOR_TIMEOUT'],['fail','CURSOR_PROCESS_FAILED'],['malformed','CURSOR_OUTPUT_INVALID']]){
      await assert.rejects(cursorCompletion({...f,model,timeoutMs:model==='timeout'?1000:5000,systemPrompt:'test',history:[{role:'user',content:'hello'}]}),
        (e:Error)=>e.name===code && !e.message.includes('PRIVATE'));
    }
    const result=await chatCompletion({...f,provider:'cursor',baseUrl:'',apiKey:'',model:'auto',systemPrompt:'test',history:[{role:'user',content:'text'}]});
    assert.ok(result.includes('text'));
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('SVG rendering can use Cursor without the images or chat HTTP APIs',async()=>{
  const f=await fixture();
  try{
    const result=await generateImage({...f,provider:'cursor',baseUrl:'',apiKey:'',model:'svg',prompt:'蓝色圆形',timeoutMs:10000});
    assert.equal(result.kind,'image');assert.ok(Buffer.from(result.base64,'base64').length>1000);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('Cursor configuration does not require model API credentials',()=>{
  const cfg=loadConfig({LLM_PROVIDER:'cursor',DATABASE_URL:'postgresql://test:test@localhost/test',WECOM_CORP_ID:'corp',WECOM_KF_SECRET:'secret',WECOM_TOKEN:'token',
    WECOM_ENCODING_AES_KEY:Buffer.alloc(32,1).toString('base64').slice(0,43)});
  assert.equal(cfg.llmProvider,'cursor');assert.equal(cfg.cursorModel,'auto');assert.equal(cfg.imageModel,'auto');assert.equal(cfg.llmApiKey,'');
});

test('API chat falls back once to Cursor with its own model and full text context', async t => {
  const f = await fixture();
  let calls = 0;
  const options = { ...f, provider: 'api' as const, baseUrl: 'https://model.test', apiKey: 'test', model: 'api-model',
    systemPrompt: 'test', history: [{ role: 'user' as const, content: '保留上下文' }], fallbackCursor: { model: 'auto', timeoutMs: 5000 } };
  try {
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 503 }); });
    const result = JSON.parse(await chatCompletion(options));
    assert.equal(result.conversation[0].content, '保留上下文');
    assert.equal(calls, 1);
    await assert.rejects(chatCompletion({ ...options, fallbackCursor: undefined }));
    await assert.rejects(chatCompletion({ ...options, history: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } }] }] }));
    await assert.rejects(chatCompletion({ ...options, fallbackCursor: { model: 'fail', timeoutMs: 5000 } }), /CURSOR_PROCESS_FAILED/);
    t.mock.restoreAll();
    t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: 'API成功' } }] }));
    assert.equal(await chatCompletion({ ...options, cursorBin: '/missing-cursor' }), 'API成功');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('drawing provider and fallback are independent of the main API provider', () => {
  const env = { LLM_PROVIDER: 'api', SVG_PROVIDER: 'cursor', CURSOR_FALLBACK: 'true', CURSOR_MODEL: 'cursor-model',
    LLM_MODEL: 'api-model', LLM_BASE_URL: 'https://model.test', LLM_API_KEY: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test',
    WECOM_CORP_ID: 'corp', WECOM_KF_SECRET: 'secret', WECOM_TOKEN: 'token', WECOM_ENCODING_AES_KEY: Buffer.alloc(32, 1).toString('base64').slice(0, 43) };
  const cfg = loadConfig(env);
  assert.equal(cfg.llmProvider, 'api'); assert.equal(cfg.svgProvider, 'cursor');
  assert.equal(cfg.imageModel, 'cursor-model'); assert.equal(cfg.cursorFallback, true);
  assert.throws(() => loadConfig({ ...env, SVG_PROVIDER: 'bad' }), /SVG_PROVIDER/);
  assert.throws(() => loadConfig({ ...env, CURSOR_FALLBACK: 'bad' }), /CURSOR_FALLBACK/);
  assert.equal(loadConfig({ ...env, IMAGE_PROVIDER: 'cursor', CURSOR_IMAGE_MODEL: 'native-model' }).cursorImageModel, 'native-model');
  assert.throws(() => loadConfig({ ...env, IMAGE_PROVIDER: 'bad' }), /IMAGE_PROVIDER/);
});

test('native Cursor image generation uses GenerateImage permission, reads raster output and rejects missing or symlink output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-native-test-'));
  const bin = join(dir, 'agent');
  const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#0088ff' } }).png().toBuffer();
  await writeFile(bin, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
if(args.includes('--mode')||args.includes('--force'))process.exit(2);
const p=JSON.parse(fs.readFileSync('.cursor/cli.json','utf8')).permissions;
const globalConfig=JSON.parse(fs.readFileSync(path.join(process.env.CURSOR_CONFIG_DIR,'cli-config.json'),'utf8'));
for(const policy of [p,globalConfig.permissions]) {
if(!policy.allow.includes('GenerateImage(*)')||!policy.allow.some(x=>x.startsWith('Write(')&&x.includes('/assets/')))process.exit(3);
if(policy.deny.includes('Write(**)')||policy.deny.includes('Write(/**)')||!policy.deny.includes('Shell(*)'))process.exit(6);
}
const writable=target=>p.allow.filter(x=>x.startsWith('Write(')).some(x=>path.matchesGlob(target,x.slice(6,-1)));
if(!writable(path.resolve('assets/generated.png'))||!writable(path.resolve('data/projects/project/assets/generated.png')))process.exit(8);
if(writable('/etc/passwd')||writable(path.resolve('config/cli-config.json')))process.exit(9);
if(globalConfig.authInfo?.testMarker!=='preserved')process.exit(7);
if(process.env.LLM_API_KEY||process.env.DATABASE_URL)process.exit(4);
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
if(input!=='生成图片：一只猫\\n保存到 assets/ 目录。'||args[args.indexOf('--output-format')+1]!=='stream-json')process.exit(5);
const model=args[args.indexOf('--model')+1];
if(model==='native')fs.writeFileSync('assets/generated.png',Buffer.from('${png.toString('base64')}','base64'));
if(model==='svg')fs.writeFileSync('assets/generated.png','<svg><rect width="10" height="10"/></svg>');
if(model==='link')fs.symlinkSync(${JSON.stringify(bin)},'assets/generated.png');
console.log(JSON.stringify({type:'tool_call',subtype:'completed',tool_call:{generateImageToolCall:{result:{success:{filePath:'assets/generated.png'}}}}}));
console.log(JSON.stringify({type:'result',subtype:'success',result:'完成 /etc/passwd'}));
});

`, { mode: 0o700 });
  const options = { cursorBin: bin, cursorStateDir: join(dir, 'state'), model: 'native', timeoutMs: 5000, prompt: '一只猫' };
  const env = await cursorEnvironment(options);
  const configPath = join(env.CURSOR_CONFIG_DIR!, 'cli-config.json');
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  saved.authInfo = { testMarker: 'preserved' };
  await writeFile(configPath, JSON.stringify(saved));
  try {
    assert.deepEqual(await cursorGenerateImage(options), png);
    const image = await generateNativeImage(options);
    assert.equal((await sharp(Buffer.from(image.base64, 'base64')).metadata()).format, 'jpeg');
    for (const model of ['missing', 'link']) await assert.rejects(cursorGenerateImage({ ...options, model }), /CURSOR_IMAGE_MISSING/);
    await assert.rejects(generateNativeImage({ ...options, model: 'svg' }));
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), saved);
    assert.ok(saved.permissions.deny.includes('Write(**)'));
    assert.ok(saved.permissions.deny.includes('Write(/**)'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('native image tool stream handles inline data, actual artifact paths and explicit failure states', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-artifact-test-'));
  const final = { type: 'result', subtype: 'success', result: '完成。/etc/passwd' };
  const completed = (result: unknown) => ({ type: 'tool_call', subtype: 'completed', tool_call: { generateImageToolCall: { result } } });
  const stream = (...events: unknown[]) => [...events, final].map(e => JSON.stringify(e)).join('\n');
  try {
    const bytes = Buffer.from('binary image bytes');
    const success = { filePath: '/different/artifact/path.png', imageData: bytes.toString('base64') };
    assert.deepEqual(await readGeneratedImage(stream(completed({ success })), dir), bytes);
    assert.deepEqual(await readGeneratedImage(stream({ type: 'tool_call', subtype: 'completed', tool_call: {
      tool: { case: 'generateImageToolCall', value: { result: { result: { case: 'success', value: success } } } },
    } }), dir), bytes);
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'actual.webp'), bytes);
    assert.deepEqual(await readGeneratedImage(stream(completed({ success: { filePath: 'assets/actual.webp' } })), dir), bytes);
    await assert.rejects(readGeneratedImage(stream(), dir), /CURSOR_IMAGE_NOT_CALLED/);
    await assert.rejects(readGeneratedImage(stream(completed({ error: { error: 'private provider error' } })), dir), /CURSOR_IMAGE_TOOL_FAILED/);
    await assert.rejects(readGeneratedImage(stream(completed({ otherResult: {} })), dir), /CURSOR_IMAGE_RESULT_UNRECOGNIZED/);
    for (const filePath of ['/etc/passwd', '../secret.png', 'https://example.com/image.png']) {
      await assert.rejects(readGeneratedImage(stream(completed({ success: { filePath } })), dir), /CURSOR_IMAGE_MISSING/);
    }
    const { symlink } = await import('node:fs/promises');
    await symlink('/etc', join(dir, 'outside'));
    await assert.rejects(readGeneratedImage(stream(completed({ success: { filePath: 'outside/passwd' } })), dir), /CURSOR_IMAGE_MISSING/);
    await assert.rejects(readGeneratedImage(stream(completed({ success: { imageData: '%%%' } })), dir), /CURSOR_OUTPUT_INVALID/);
    await assert.rejects(readGeneratedImage(JSON.stringify(completed({ success })), dir), /CURSOR_OUTPUT_INVALID/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('image diagnostics distinguish event shapes and expose only metadata in normal logs', () => {
  const raw = [
    { type: 'system', subtype: 'init', api_key: 'PRIVATE' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'GenerateImage is unavailable' }] } },
    { type: 'tool_call', tool_call: { otherToolCall: { args: { text: 'PRIVATE_PROMPT' } } } },
    { type: 'result', is_error: false, result: 'No access to GenerateImage. https://secret.test/?token=abc user@example.com Bearer abc123' },
  ].map(e => JSON.stringify(e)).join('\n');
  const diagnostic = imageRunDiagnostic(raw);
  assert.equal(diagnostic.responseHint, 'tool_unavailable');
  assert.deepEqual(diagnostic.tools, ['otherToolCall']);
  assert.equal(diagnostic.events.tool_call, 1);
  assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE'));
  assert.ok(!diagnostic.finalReply.includes('abc123'));
  assert.ok(!diagnostic.finalReply.includes('user@example.com'));
  assert.ok(!diagnostic.finalReply.includes('secret.test'));
  const { finalReply, ...metadata } = diagnostic;
  assert.ok(!JSON.stringify(metadata).includes('GenerateImage is unavailable'));
  assert.equal(imageRunDiagnostic(JSON.stringify({type:'result',result:'需要权限批准'})).responseHint, 'permission');
  assert.equal(imageRunDiagnostic(JSON.stringify({type:'result',result:'Insufficient credits'})).responseHint, 'quota_or_billing');
  assert.deepEqual(imageRunDiagnostic(JSON.stringify({type:'result',result:'完成'})).tools, []);
  const discovery = imageRunDiagnostic(JSON.stringify({type:'tool_call',subtype:'completed',tool_call:{
    getMcpToolsToolCall:{args:{pattern:'GenerateImage'},result:{success:{content:'No matching tools. https://secret.test/?token=abc'}}},
  }}));
  assert.deepEqual(discovery.toolDiscovery, [{query:'GenerateImage',status:'success',response:'No matching tools. [URL]'}]);
  const failedImage = imageRunDiagnostic(JSON.stringify({type:'tool_call',subtype:'completed',tool_call:{
    generateImageToolCall:{args:{description:'PRIVATE_PROMPT'},result:{error:{error:'EACCES permission denied https://secret.test/?token=abc'}}},
  }}));
  assert.deepEqual(failedImage.imageTools, [{status:'error',error:'EACCES permission denied [URL]',resultFields:['error']}]);
  assert.ok(!JSON.stringify(failedImage).includes('PRIVATE_PROMPT'));
});


test('Cursor streaming events reset the idle deadline but stderr does not', async () => {
  const f = await fixture();
  try {
    let events = 0; const publicText: string[] = [];
    const options = { ...f, timeoutMs: 600, systemPrompt: 'test', history: [{ role: 'user' as const, content: 'test' }] };
    assert.equal(await cursorCompletion({ ...options, model: 'streaming', onActivity: () => events++, onText: text => publicText.push(text) }), 'hello');
    assert.ok(events >= 5); assert.deepEqual(publicText, ['hello']);
    await assert.rejects(cursorCompletion({ ...options, model: 'stderr' }), /CURSOR_TIMEOUT/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
