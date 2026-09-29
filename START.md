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

默认复用已配置的文本模型，不用额外生图 API。可在 .env 添加 `SVG_MODEL=同一文本接口中的模型ID` 和 `SVG_TIMEOUT_MS=300000`，不填则使用默认值。已有聊天模型需要能按提示输出完整 SVG。

升级前先备份 PostgreSQL；本版自动将 schema 升至 3，保留旧文本和图片待发记录。Docker 构建会安装 SVG 渲染依赖和中文字体。已有 95018 问题仍需根据日志的 service_state 排查，生成图片成功不代表微信一定允许发送。


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
IMAGE_TIMEOUT_MS=300000
```

执行 `bash start.sh docker` 重建并启动，按需完成 Cursor 登录。普通聊天可直接说“解释一下这个流程，配一张图”，API 决定文字和配图内容，Cursor 使用内置 GenerateImage 生成图片；`/draw` 同样切到原生生图。API 文字调用失败才使用 Cursor 聊天兜底。不要把 API 接入点 ID 填入 CURSOR_MODEL 或 CURSOR_IMAGE_MODEL。

未设置 IMAGE_PROVIDER 时仍使用原来的 SVG 方式。SVG_MODEL、SVG_PROVIDER、SVG_TIMEOUT_MS 只控制 SVG 方式，不影响原生生图。原生生图失败会明确提示，不偷偷改成 SVG。图片理解/PDF 问答仍由 API 处理；支持生成 HTML、文本及代码文件附件，暂不支持生成 PDF/Office 二进制附件。

验收：发送普通文字、要求配图的文字和 `/draw` 各一条，确认微信收到真正的图片；在测试环境模拟 API 失败确认 Cursor 兜底。日志 `[llm-fallback]` 表示触发兜底，`[conversation-draw]`/`[draw]` 表示生图失败，`CURSOR_IMAGE_NOT_CALLED` 表示没有观测到原生生图工具调用；`CURSOR_IMAGE_TOOL_FAILED` 表示工具明确返回错误；`CURSOR_IMAGE_RESULT_UNRECOGNIZED` 表示完成事件没有可识别的成功或错误结构；`CURSOR_IMAGE_MISSING` 表示工具报告成功，但没有有效的内嵌图片数据或本次临时目录中可读取的实际图片文件。新版本从工具事件取回图片，不依赖固定的 generated.png 文件名。


### 原生生图未调用的诊断

若日志出现 `CURSOR_IMAGE_NOT_CALLED`，该错误仅说明未识别到 GenerateImage 事件，不能直接判断是账号权限或 CLI 版本问题。同步代码并重建后，在运行容器中执行：

```bash
docker compose exec wecom-ai-bot node scripts/diagnose-cursor-image.ts
```

命令使用相同的 Cursor 配置和一个固定的小猫提示，可能消耗一次生图额度，不连接数据库或发送微信消息。输出 CLI 版本、选用模型、事件类型数量、工具名称和截断脱敏的最终回复。将这些诊断结果用于区分模型未调用、工具不可用、权限提示、额度提示与事件格式不兼容；`responseHint` 只是对模型文字的分类，不是服务端权威错误码。普通聊天失败日志只打印 `[cursor-image-diagnosis]` 元数据，不打印模型回复或用户内容。

原生生图诊断的 `imageTools` 字段包含 GenerateImage 完成事件的状态、结果字段名和脱敏错误正文。普通日志只记录 `imageResults` 的状态与权限关键词标记，不打印工具错误正文；定位失败时应优先看 `imageTools[].error`，不要只凭模型最终解释判断原因。

若旧版出现 `Failed to save generated image ... Blocked by permissions configuration`，更新代码并重建即可使用独立绘图权限配置。无需删除 cursor-state 卷或手工清空共享权限：绘图调用会从已有登录配置创建临时副本，放行本次 assets 输出目录，并在结束后删除副本；聊天仍禁止写入。

模型任务默认超时为 5 分钟：`LLM_TIMEOUT_MS=300000`。`CURSOR_TIMEOUT_MS`、`IMAGE_TIMEOUT_MS`、`SVG_TIMEOUT_MS`、`FILE_TASK_TIMEOUT_MS` 未单独设置时继承该值；已有显式配置仍优先，请删除旧值或统一设为 300000。`UPSTREAM_TIMEOUT_MS` 仅控制微信接口请求，默认仍为 30000。超时按调用阶段计算，API 超时后 Cursor 兜底另有 5 分钟；对话后配图也单独计时，不是整条消息 5 分钟总上限。

文件发送无需新增配置：更新后执行 `bash start.sh docker`，启动会迁移到 schema 3。可以直接说“把骑车的鹈鹕做成完整 HTML 动画文件发给我”。生成的文件每轮最多一个，最多 40000 字符且不超过 200KB；旧对话中“只能打字、不能发送文件”的说法不再适用。


## 耗时任务等待提示

任务开始处理后超过 3 秒仍未完成，会先发“正在处理，请稍等，完成后会发给你。”，然后继续处理并发送最终结果。快速回复、会话管理指令及额度不足不会额外提示。每条入站消息最多尝试一次提示，重启及最终回复重试不会重复发送；提示失败不影响任务结果，也不会把模型信息发给用户。

可设置 `PROGRESS_NOTICE_MS=3000` 调整触发时间，`0` 关闭。计时从任务开始执行起算，排队等待不计入；不会定时刷屏或虚构进度百分比。已发起的提示发送结束后再发最终回复，避免结果之后又出现“正在处理”。等待提示在 outbox 中用 part=-1 记录，不进入聊天历史，也不会作为最终回复重试。
