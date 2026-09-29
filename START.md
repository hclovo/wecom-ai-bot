# 启动项目

你只需要编辑项目根目录的 **`.env`**。PostgreSQL 由你自行部署，本项目不创建数据库服务。

## 1. 填写配置

如果没有 `.env`，先运行 `cp .env.example .env`，或者运行一次 `./start.sh` 自动生成。已有文件不会被覆盖。

```bash
nano .env
```

企业微信和数据库配置必须填写；模型配置根据下面选择的模式填写：

| 配置 | 填写内容 |
|---|---|
| `DATABASE_URL` | 已有 PostgreSQL 的连接串：`postgresql://用户名:URL编码后的密码@数据库地址:5432/数据库名` |
| `WECOM_CORP_ID` | 企业 ID |
| `WECOM_KF_SECRET` | 微信客服 API Secret |
| `WECOM_TOKEN` | 企业微信回调 Token |
| `WECOM_ENCODING_AES_KEY` | 回调 EncodingAESKey，43 位 |
| `LLM_BASE_URL`（API 模式） | 模型接口地址，方舟默认为 `https://ark.cn-beijing.volces.com/api/v3` |
| `LLM_API_KEY`（API 模式） | 模型 API Key |
| `LLM_MODEL`（API 模式） | 文本/PDF 模型或接入点 ID |

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


## 使用 SVG 绘图

以下是兼容旧配置的 SVG 通道。需要 Cursor 自带生图能力，请使用文末的混合模式配置。

更新代码后重新执行 `./start.sh docker`（本机运行用 `./start.sh`）。在微信里发送：

```text
/draw 一只穿宇航服的猫，简洁卡通风格
画图：用户下单到付款成功的流程图
```

默认复用已配置的文本模型，不用额外生图 API。可在 .env 添加 `SVG_MODEL=同一文本接口中的模型ID` 和 `SVG_TIMEOUT_MS=120000`，不填则使用默认值。已有聊天模型需要能按提示输出完整 SVG。

升级前先备份 PostgreSQL；本版自动将 schema 升至 2，保留旧文本待发记录。Docker 构建会安装 SVG 渲染依赖和中文字体。已有 95018 问题仍需根据日志的 service_state 排查，生成图片成功不代表微信一定允许发送。


## Cursor 账号登录模式

在服务器的 `.env` 中设置：

```dotenv
LLM_PROVIDER=cursor
CURSOR_MODEL=auto
```

此模式不要求填写 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。企业微信和 DATABASE_URL 仍需填写。SVG_MODEL 留空时也使用 CURSOR_MODEL；不要把旧的方舟接入点 ID 填到 Cursor 模型配置中。

然后执行：

```bash
bash start.sh docker
```

启动流程：构建包含官方 Cursor CLI 的镜像 → 检查项目配置 → 检查 Cursor 登录 → 未登录时终端打印官方登录 URL → 在电脑浏览器打开链接、登录并授权 → CLI 确认登录成功 → 自动后台启动机器人。服务器不需要图形界面，登录使用官方 NO_OPEN_BROWSER=1 模式。

不要在授权完成前关闭终端。登录失败时脚本退出，不会启动新的机器人容器。已有有效登录状态时跳过登录；Docker 重建后继续使用 `cursor-state` 命名卷中的凭证。不要删除该数据卷，否则需要重新登录。

目前支持：文字多轮对话、文本文件摘要/追问、/draw SVG 绘图。图片理解和 PDF 文件问答在 Cursor 模式下会明确提示暂不支持；需要这些功能时切回 `LLM_PROVIDER=api` 并填写原 API 配置。

模型调用通过 Cursor CLI `--print --mode ask --output-format json`，每条消息使用独立临时工作区，不复用其他好友的 CLI 会话。工具权限配置拒绝文件读取/写入、Shell、WebFetch 和 MCP；数据库/微信/API 密钥不传给子进程。聊天上下文仍由 PostgreSQL 管理。

如果直接在宿主机启动，先按 [Cursor 官方安装说明](https://cursor.com/docs/cli/installation) 安装 CLI，再运行 `./start.sh`。本机 macOS 的认证存储由 Cursor CLI 管理，可能复用该系统用户已有的 Cursor 登录；服务器建议使用 Docker 的独立状态卷。

登录过期后重新执行 `bash start.sh docker`，或单独运行 `docker compose run --rm --no-deps wecom-ai-bot node scripts/cursor-login.ts` 完成授权。模型可用性和额度以你的 Cursor 账号为准；账号登录不等于无限调用。

官方依据：[登录与 NO_OPEN_BROWSER](https://prod.cursor.com/docs/cli/reference/authentication)、[命令参数](https://prod.cursor.com/docs/cli/reference/parameters)。

## API 日常对话 + Cursor 原生生图 + Cursor 兜底

保留真实 API 配置，修改 `.env`：

```dotenv
LLM_PROVIDER=api
IMAGE_PROVIDER=cursor
CURSOR_FALLBACK=true
CURSOR_MODEL=auto
CURSOR_IMAGE_MODEL=auto
IMAGE_TIMEOUT_MS=180000
```

执行 `bash start.sh docker` 重建并启动，按需完成 Cursor 登录。普通聊天可直接说“解释一下这个流程，配一张图”，API 决定文字和配图内容，Cursor 使用内置 GenerateImage 生成图片；`/draw` 同样切到原生生图。API 文字调用失败才使用 Cursor 聊天兜底。不要把 API 接入点 ID 填入 CURSOR_MODEL 或 CURSOR_IMAGE_MODEL。

未设置 IMAGE_PROVIDER 时仍使用原来的 SVG 方式。SVG_MODEL、SVG_PROVIDER、SVG_TIMEOUT_MS 只控制 SVG 方式，不影响原生生图。原生生图失败会明确提示，不偷偷改成 SVG。图片理解/PDF 问答仍由 API 处理；文件附件发送尚未实现。

验收：发送普通文字、要求配图的文字和 `/draw` 各一条，确认微信收到真正的图片；在测试环境模拟 API 失败确认 Cursor 兜底。日志 `[llm-fallback]` 表示触发兜底，`[conversation-draw]`/`[draw]` 表示生图失败，`CURSOR_IMAGE_NOT_CALLED` 表示没有观测到原生生图工具调用；`CURSOR_IMAGE_TOOL_FAILED` 表示工具没有返回成功结果；`CURSOR_IMAGE_MISSING` 表示工具报告成功，但没有有效的内嵌图片数据或本次临时目录中可读取的实际图片文件。新版本从工具事件取回图片，不依赖固定的 generated.png 文件名。
