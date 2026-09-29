import { loadConfig, loadEnvFile } from '../server.ts';
import { cursorGenerateImage, cursorVersion } from '../lib/cursor-agent.ts';
import { errorCode } from '../lib/http-client.ts';

loadEnvFile(new URL('../.env', import.meta.url).pathname);
try {
  const cfg = loadConfig();
  const options = { cursorBin: cfg.cursorBin, cursorStateDir: cfg.cursorStateDir,
    model: cfg.cursorImageModel, timeoutMs: cfg.nativeImageTimeoutMs };
  console.log(JSON.stringify({ version: await cursorVersion(options), imageProvider: cfg.imageProvider, model: options.model }));
  console.log('开始一次原生生图诊断，可能消耗 Cursor 额度；不连接数据库，不发送微信消息。');
  const image = await cursorGenerateImage({ ...options, prompt: '白色背景上的一只蓝色卡通小猫，只生成一张图片。',
    onDiagnostic: diagnostic => console.log(JSON.stringify({ diagnostic }, null, 2)) });
  console.log(JSON.stringify({ imageReceived: true, bytes: image.length }));
} catch (error) {
  console.error(JSON.stringify({ error: errorCode(error) }));
  process.exitCode = 1;
}
