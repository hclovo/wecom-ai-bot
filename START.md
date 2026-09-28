# 启动项目

你只需要编辑项目根目录的 **`.env`**。PostgreSQL 由你自行部署，本项目不创建数据库服务。

## 1. 填写配置

如果没有 `.env`，先运行 `cp .env.example .env`，或者运行一次 `./start.sh` 自动生成。已有文件不会被覆盖。

```bash
nano .env
```

必须填写：

| 配置 | 填写内容 |
|---|---|
| `DATABASE_URL` | 已有 PostgreSQL 的连接串：`postgresql://用户名:URL编码后的密码@数据库地址:5432/数据库名` |
| `WECOM_CORP_ID` | 企业 ID |
| `WECOM_KF_SECRET` | 微信客服 API Secret |
| `WECOM_TOKEN` | 企业微信回调 Token |
| `WECOM_ENCODING_AES_KEY` | 回调 EncodingAESKey，43 位 |
| `LLM_BASE_URL` | 模型接口地址，方舟默认为 `https://ark.cn-beijing.volces.com/api/v3` |
| `LLM_API_KEY` | 模型 API Key |
| `LLM_MODEL` | 文本/PDF 模型或接入点 ID |

可选填写 `WECOM_OPEN_KFID` 限定客服账号、`LLM_VISION_MODEL` 指定视觉模型。数据库默认 schema 为 `wecom_bot`，可用 `DATABASE_SCHEMA` 修改。账号需能创建 schema/表，或请数据库管理员预建 schema 并授予相应权限。密码含 `@`、`:`、`/` 等字符时要 URL 编码。

`.env` 不提交 Git，不写入镜像。编辑后可运行 `chmod 600 .env`。

## 2. 启动（二选一）

**直接运行：需要 Node.js ≥ 24 和 npm。**

```bash
./start.sh check   # 检查配置格式；缺少依赖时自动安装，不连接数据库
./start.sh         # 前台启动，数据库就绪后开始监听；Ctrl+C 停止
```

脚本会在缺少或版本不匹配时安装生产依赖。等效手工命令：

```bash
npm ci --omit=dev
node scripts/check-config.ts
npm start
```

**Docker 后台运行：需要 Docker 和 Docker Compose，不要求宿主机安装 Node。**

```bash
./start.sh docker
docker compose logs --tail=100 -f wecom-ai-bot
```

脚本只构建并启动机器人容器，连接 `.env` 中已有 PostgreSQL。容器中的 `127.0.0.1` 指容器自身，数据库地址必须可从容器访问。Linux 若数据库在同一宿主机，请填写可达的宿主机地址并配置数据库网络访问规则。

## 3. 检查、停止和更新

```bash
curl http://127.0.0.1:8788/healthz
# Docker 查看消息任务状态
docker compose exec wecom-ai-bot node scripts/status.ts
# Docker 停止机器人（不会操作你的数据库服务）
docker compose stop wecom-ai-bot
```

直接运行时 `PORT` 默认 8788；Docker 固定将应用映射到宿主机 `127.0.0.1:8788`。公网回调需要 Nginx，IP/域名配置见 [DEPLOY.md](DEPLOY.md)。healthz 只证明 HTTP 存活，真实微信与模型调用仍需联调。

修改 `.env` 或更新代码后，Docker 重新运行 `./start.sh docker`；直接运行则 Ctrl+C 后重新 `./start.sh`。同一数据库 schema 仅允许一个机器人实例。

已有 SQLite 文件不会使用、迁移或删除。数据库备份恢复由 PostgreSQL 工具处理，详见 DEPLOY 第 10 节。
