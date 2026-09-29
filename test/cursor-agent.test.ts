import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cursorAuthenticated, cursorCompletion, ensureCursorLogin } from '../lib/cursor-agent.ts';
import { chatCompletion } from '../lib/llm.ts';
import { generateImage } from '../lib/image-generation.ts';
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
