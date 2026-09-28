import { loadConfig, loadEnvFile } from '../server.ts';

loadEnvFile(new URL('../.env', import.meta.url).pathname);
try {
  loadConfig();
  const placeholders = ['yourCallbackToken', 'your-ark-api-key', 'ep-2024xxxxxxxxxxxxxxxx'];
  const names = ['WECOM_CORP_ID', 'WECOM_KF_SECRET', 'WECOM_TOKEN', 'WECOM_ENCODING_AES_KEY', 'LLM_API_KEY', 'LLM_MODEL'];
  const unfinished = names.filter((name) => {
    const value = process.env[name] || '';
    return placeholders.includes(value) || /x{6,}/.test(value);
  });
  const database = new URL(process.env.DATABASE_URL!);
  if (database.hostname === 'your-postgres-host' || database.password === 'replace-password') unfinished.push('DATABASE_URL');
  if (unfinished.length) throw new Error(`请编辑 .env，替换示例值：${unfinished.join(', ')}`);
  console.log('配置格式检查通过（未连接数据库或调用微信/模型接口）。');
} catch (error) {
  // Config validation messages contain field names only. Never print process.env or URLs.
  console.error(error instanceof Error ? error.message : '配置检查失败');
  process.exitCode = 1;
}
