import { loadEnvFile } from '../server.ts';
import { ensureCursorLogin } from '../lib/cursor-agent.ts';
loadEnvFile(new URL('../.env', import.meta.url).pathname);
if (process.env.LLM_PROVIDER === 'cursor') {
  try {
    await ensureCursorLogin({ cursorBin:process.env.CURSOR_AGENT_BIN, cursorStateDir:process.env.CURSOR_STATE_DIR });
  } catch (error) {
    console.error(error instanceof Error && error.name === 'CURSOR_NOT_INSTALLED'
      ? '未找到 Cursor CLI。请先按官方文档安装，或使用已包含 CLI 的 Docker 模式。'
      : 'Cursor 登录检查失败，机器人尚未启动。请检查网络并重新运行启动脚本。');
    process.exitCode=1;
  }
}
