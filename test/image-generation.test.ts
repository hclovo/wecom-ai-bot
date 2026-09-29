import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { drawingPrompt, generateImage, renderSvg, safeSvg, WECHAT_IMAGE_MAX_BYTES } from '../lib/image-generation.ts';
import { clearTokenCache, sendText, sendImage, uploadImage } from '../lib/wecom-api.ts';

const cfg={apiBase:'https://wecom.test',corpId:'corp',kfSecret:'SECRET'};
const png=()=>sharp({create:{width:64,height:64,channels:4,background:'#00aaee80'}}).png().toBuffer();

test('drawing routes explicit commands and natural requests, not normal chat',()=>{
  for(const text of ['/draw 猫','画图：猫','帮我画一只猫','给我画一张猫','画一只猫']) assert.equal(drawingPrompt(text),'猫');
  assert.equal(drawingPrompt('/draw'),'');assert.equal(drawingPrompt('/drawback x'),null);
  assert.equal(drawingPrompt('你能画图吗？'),null);assert.equal(drawingPrompt('这张画是什么风格'),null);
});

const SVG='<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect x="10" y="10" width="500" height="500" fill="#08a"/><text x="50" y="120" font-size="40">你好 &amp; SVG</text></svg>';

test('text model SVG is rendered to a bounded JPEG instead of calling image API',async(t)=>{
  t.mock.method(globalThis,'fetch',async(url:string|URL|Request,init?:RequestInit)=>{
    assert.equal(String(url),'https://model.test/v1/chat/completions');
    const body=JSON.parse(String(init?.body));assert.equal(body.model,'text-model');assert.equal(body.messages.at(-1).content,'猫');
    return Response.json({choices:[{message:{content:SVG}}]});
  });
  const result=await generateImage({baseUrl:'https://model.test/v1',apiKey:'key',model:'text-model',prompt:'猫',timeoutMs:1000});
  const image=Buffer.from(result.base64,'base64');const meta=await sharp(image).metadata();
  assert.equal(result.kind,'image');assert.equal(meta.format,'jpeg');assert.equal(meta.width,1024);assert.equal(meta.height,1024);
  assert.ok(image.length<=WECHAT_IMAGE_MAX_BYTES);
});

test('SVG rejects active content, external assets, entity declarations and excessive nesting',async()=>{
  for(const content of [
    '<svg><script>alert(1)</script></svg>', '<svg><image href="http://localhost/private"/></svg>',
    '<svg onload="bad()"></svg>', '<svg><rect fill="url(http://localhost/private)"/></svg>',
    '<svg><style>@import "http://localhost";</style></svg>', '<svg><foreignObject/></svg>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg><text>&x;</text></svg>',
    '<svg><text>&#60;script&#62;</text><use href="#x"/></svg>',
    '<svg>'+ '<g>'.repeat(42)+'</g>'.repeat(42)+'</svg>', '<svg/><svg/>',
  ]) assert.throws(()=>safeSvg(content));
  await assert.rejects(renderSvg('not svg'));
  assert.ok(safeSvg('```svg\n'+SVG+'\n```').includes('&amp;'));
  const large=SVG.replace('width="1024"','width="999999999"');
  assert.ok(safeSvg(large).includes('width="1024"'));
});

test('media upload refreshes expired token and sends image message with stable msgid',async(t)=>{
  clearTokenCache();let uploads=0,tokens=0;
  t.mock.method(globalThis,'fetch',async(url:string|URL|Request,init?:RequestInit)=>{
    const parsed=new URL(String(url));
    if(parsed.pathname.endsWith('gettoken')) return Response.json({errcode:0,access_token:`t${++tokens}`,expires_in:7200});
    if(parsed.pathname==='/cgi-bin/media/upload'){
      uploads++;assert.equal(parsed.searchParams.get('type'),'image');
      assert.ok((init!.body as FormData).get('media') instanceof Blob);
      return Response.json(uploads===1?{errcode:42001}:{media_id:'m-image'});
    }
    const body=JSON.parse(String(init?.body));assert.equal(body.msgtype,'image');assert.deepEqual(body.image,{media_id:'m-image'});assert.equal(body.msgid,'stable');
    return Response.json({errcode:0});
  });
  const media=await uploadImage(cfg,await png());
  await sendImage(cfg,{touser:'u',openKfId:'k',msgid:'stable',mediaId:media});
  assert.equal(uploads,2);assert.equal(tokens,2);
});

test('95018 recovery is opt-in, claims only unassigned state and retries send once',async(t)=>{
  clearTokenCache();let sends=0,trans=0;
  t.mock.method(globalThis,'fetch',async(url:string|URL|Request,init?:RequestInit)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('gettoken'))return Response.json({errcode:0,access_token:'t',expires_in:7200});
    if(path.endsWith('service_state/get'))return Response.json({errcode:0,service_state:0});
    if(path.endsWith('service_state/trans')){trans++;assert.equal(JSON.parse(String(init?.body)).service_state,1);return Response.json({errcode:0});}
    sends++;return Response.json({errcode:95018});
  });
  const options={touser:'u',openKfId:'k',msgid:'id',content:'hello'};
  await assert.rejects(sendText(cfg,options));assert.equal(trans,0);assert.equal(sends,1);
  sends=0;await assert.rejects(sendText({...cfg,autoTakeover:true},options));assert.equal(trans,1);assert.equal(sends,2);
});

test('human, queued and ended sessions are never forcibly transitioned',async(t)=>{
  clearTokenCache();let state=2;
  t.mock.method(globalThis,'fetch',async(url:string|URL|Request)=>{
    const path=new URL(String(url)).pathname;
    assert.ok(!path.endsWith('/trans'));
    if(path.endsWith('gettoken'))return Response.json({errcode:0,access_token:'t',expires_in:7200});
    if(path.endsWith('service_state/get'))return Response.json({errcode:0,service_state:state});
    return Response.json({errcode:95018});
  });
  for(state of [1,2,3,4])await assert.rejects(sendText({...cfg,autoTakeover:true},{touser:'u',openKfId:'k',msgid:'id',content:'hi'}));
});
