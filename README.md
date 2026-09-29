# wecom-ai-bot

通过企业微信「微信客服」让微信好友扫码与 AI 对话。支持文本多轮、图片、PDF 和文本文件，方舟文档理解使用 Files + Responses API。**Word/Excel/PPT 目前需先导出 PDF**，不直接上传 Office 文件。

Node ≥ 24.0，TypeScript 源码直接运行，使用 `pg` 驱动连接 PostgreSQL，使用 sharp 和 XML 解析器渲染 SVG（本地验证版本 17）。同一数据库 schema 仅允许一个机器人进程，启动时通过数据库锁强制执行。当前不使用 SQLite。

[启动指南 START.md](START.md) ｜ [需求](REQUIREMENTS.md) ｜ [进度](PROGRESS.md) ｜ [部署与 IP 联调](DEPLOY.md)

## 运行

```bash
cp .env.example .env
# 填写企业微信、方舟及 DATABASE_URL
npm ci --omit=dev
npm start
```

开发验证：`npm ci`、`TEST_DATABASE_URL=postgresql://... npm test`、`npm run typecheck`。测试使用独立随机 schema，不会回退到生产 DATABASE_URL。

连接已有 PostgreSQL 的 Docker 部署：

```bash
docker compose up -d --build
```

也可使用启动脚本：`./start.sh` 前台运行，`./start.sh docker` 后台运行应用容器。只需编辑 `.env`，详见 [START.md](START.md)。PostgreSQL 由你自行部署，本仓库不提供数据库部署文件。

Compose 将服务绑定到 `127.0.0.1:8788`，由 Nginx 转发公网回调。已有域名时使用 `https://你的域名/webhook`。无域名可先准备 `http://服务器公网IP/webhook` 联调，以微信客服后台是否接受该地址为准，详见 DEPLOY 第 9 节。

配置 `WECOM_CORP_ID`、`WECOM_KF_SECRET`、`WECOM_TOKEN`、`WECOM_ENCODING_AES_KEY`，在企业微信后台设置回调和可信 IP。方舟需设置 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`；图片可用 `LLM_VISION_MODEL`，PDF 需要具体模型支持 Responses `input_file`。真实账号权限及各项模型能力仍需联调验收。

## 使用

| 指令 | 行为 |
|---|---|
| `/new [标题]` | 新建会话并切换，最多 10 个；超限淘汰最久未使用的非活跃会话 |
| `/list` | 列出会话及当前 PDF 追问目标 |
| `/switch 编号` | 恢复该会话的上下文与文件目标 |
| `/del 编号` | 删除会话，至少保留一个 |
| `/reset` | 清空当前历史与文件目标 |
| `/help` | 显示指令 |
| `/draw 描述` | 按 IMAGE_PROVIDER 生成图片；普通聊天也可要求配图 |

会话 #1 是初始默认会话，也可以删除或淘汰。首条文字为默认会话命名。每个客服账号、好友的状态独立，默认保留最近 12 个完整轮次，同时有历史字符预算。

图片直接解读；PDF 自动摘要后可继续追问；文本文件最多保留 4 万字符用于摘要及追问。新图片会清除文件追问目标；成功处理新文件会替换目标。文件处理失败时保留原会话状态。语音/视频暂未支持。

回复按 UTF-8 字节预算切分，默认每片最多 1000 字节，保留完整 Unicode 字符。微信自身发送窗口/条数限制仍需真实账号验收，超出限制可能进入发送失败状态。

## 消息可靠性与资源限制

回调验签、解密、receiveId 校验及账号过滤后，先持久化同步任务再 ack；数据库失败返回 503，超过 4.5 秒也返回 503，允许微信重试。同步按 has_more 分页，消息与游标在同一事务落盘。不同好友默认并发 2，同一好友的消息及命令按序处理。

回复先写 PostgreSQL，再逐片发送；临时发送失败有限重试，重启继续未发送片段，不重新调用模型。进程仍在运行时，保存答案失败只重试存储；若模型服务端成功后进程在结果落盘前退出，仍可能重复调用。发送成功但本地未记账的故障窗口也可能重复投递，不承诺 exactly-once。

默认每日每个账号/好友组合限 100 个请求（UTC 零点刷新，指令免费；失败模型请求也计一次），总待处理上限 1000；队列满时暂停拉取、不推进游标。媒体流式限 20MB、回调体限 64KB，上游请求默认 30 秒超时，PDF 上传/轮询/问答另有总时限 90 秒。

相关配置及范围见 [.env.example](.env.example)。按实际小圈子使用量调整，避免超过微信平台的保存期限与调用频率。

## 文件与数据存放

| 内容 | 存放方式 |
|---|---|
| 微信图片原件 | 临时下载到内存并发送视觉模型，本地不保存原件 |
| PDF 原件 | 临时内存 → 方舟 Files API 托管，本地保存 file_id 和文件名 |
| 文本文件 | PostgreSQL 中保存最多 4 万字符及文件名 |
| 聊天历史、会话、同步游标、限额 | 本机 PostgreSQL |
| 待发回复 | PostgreSQL outbox；已确认发送的分片清除正文 |

无需额外对象存储；需要连接你已有的 PostgreSQL 数据库。通过 `DATABASE_URL` 连接，默认在 `wecom_bot` schema 中建表。数据库部署和数据目录由你现有的数据库服务管理。数据库含用户文本，备份需限制权限。默认清理 30 天未活跃会话及完成/失败任务；正在排队的任务保留。文本删除是逻辑删除，不承诺数据库物理页或既有备份的擦除。

方舟文件过期后需重新发送；`/reset` 与 `/del` 清除本地会话，不删除方舟托管文件。如果未来需要长期保留原件及自动重新上传，再接入对象存储。

## 运维

- `node scripts/status.ts`：查看任务计数、失败任务 ID 和最老待处理时长。
- `node scripts/retry-failed.ts <任务ID>`：排查并修复原因后，重发失败任务剩余分片。
- Docker 中在上述命令前加 `docker compose exec wecom-ai-bot`。
- 修改 `.env`：`docker compose up -d --force-recreate`；修改源码：`docker compose up -d --build`。
- 备份、恢复与回滚见 DEPLOY 第 10 节。不要删除数据卷。

`/healthz` 只代表 HTTP 存活，不代表微信或模型可用。日志仅记录阶段和脱敏错误码，不记录上游响应正文、凭证或用户消息。60020 需核对可信 IP；发送终态失败在状态命令中可见。

## 实现与验证边界

真实 PostgreSQL 17 及模拟 Cursor CLI 的本地测试和类型检查通过；尚未完成真实企业微信/方舟/云服务器联调。媒体默认路径为 `/cgi-bin/media/get`，可通过 `WECOM_MEDIA_PATH` 调整，需在目标账号核验。Office 转换与语音为待办。

方舟上传参数使用 `purpose=user_data`，文档输入限制依据 [Files API 官方说明](https://docs.volcengine.com/docs/ark/file-api?lang=zh)。PostgreSQL 事务通过单一连接执行，参见 [node-postgres 事务文档](https://node-postgres.com/features/transactions)。


数据库配置：`DATABASE_URL` 必填；`DATABASE_SCHEMA=wecom_bot`、`DATABASE_POOL_SIZE=10`、`DATABASE_TIMEOUT_MS=2000` 可调整。schema 标识符仅允许小写字母、数字和下划线。使用直连或会话池模式，不能使用事务池模式的 PgBouncer（单实例锁属于数据库会话）。锁连接断开后主程序停止工作并退出，由 Compose/systemd 重启后恢复。

旧 SQLite 文件不会读取、转换或删除；如果已有需保留的历史数据，应另行执行显式迁移。历史审查报告中的 SQLite 描述仅代表当时版本。


## SVG 绘图

本节适用于 `IMAGE_PROVIDER=svg`（兼容旧配置的默认值）。使用 Cursor 原生生图见下一节。

直接发送 `/draw 一只穿宇航服的猫`、`画图：订单处理流程图` 或 `帮我画一张生日贺卡`。使用现有文本模型生成 SVG，经白名单校验后渲染为 1024×1024 JPEG 并发回微信。适合流程图、信息图、图标、简洁插画；不适合写实照片，也不支持基于上传图片的编辑。

默认复用 LLM_MODEL/LLM_BASE_URL/LLM_API_KEY；可设置 SVG_MODEL（同一接口下的文本模型）和 SVG_TIMEOUT_MS。**不需要图片生成模型、图片 API Key 或对象存储**。仍会产生文本模型调用费用，/draw 纳入每日请求限额。

禁止 SVG 脚本、样式表、外部图片/链接、实体声明和嵌入 HTML；固定画布并限制 SVG 大小/层级/节点数及渲染时间。图片临时保存到 PostgreSQL outbox，发送成功后清除图片正文；失败或重启使用已保存图片重发，微信 media_id 过期时重新上传，不重新调用模型。

Docker 镜像包含中文字体。直接在 Linux 上运行时，需要自行安装中文字体（例如 Noto Sans CJK），否则文字可能显示为方框。升级涉及数据库 schema 1/2→3，请先备份 PostgreSQL；迁移保留已有文本和图片任务，旧应用版本不能直接打开升级后的库。

对于 95018，默认仅查询状态并诊断。若确认采用机器人接待，可显式设置 WECOM_AUTO_TAKEOVER=true：仅当发送失败后查询到 state=0 时尝试转到 state=1，再用原 msgid 重试一次；不强制转出人工、排队或已结束会话。该操作仍受微信实际账号权限及会话规则限制，不保证解决所有 95018。


## Cursor Agent 作为文本模型

`.env` 设置 `LLM_PROVIDER=cursor`、`CURSOR_MODEL=auto`，然后 `bash start.sh docker`。首次启动会显示 Cursor 官方登录链接，浏览器授权完成后才启动服务；后续启动复用 `cursor-state` 数据卷。镜像改为 Debian/glibc 并预装官方 CLI。

Cursor 模式覆盖文字聊天、文本文件与 SVG 绘图，不使用模型 HTTP API Key；图片理解和 PDF 暂保留在 API 模式。`LLM_PROVIDER=api` 保持原有功能和配置要求。两种模式使用同一个 PostgreSQL 会话库，切换前已有 PDF 目标需要 /reset 或切回 API 继续使用。

子进程使用独立工作区与工具拒绝规则，输入通过 stdin 传入，不拼接 shell 命令；有超时、输出上限及关闭时取消。Cursor 登录凭证单独持久化，不写入镜像或 Git。具体操作见 [START.md](START.md)。

Cursor 相关测试使用模拟 CLI 验证登录门控、上下文隔离、权限参数、超时和 SVG 兼容；真实 CLI 已验证可在容器中启动并识别未登录状态。实际账号授权和真实模型回复仍需你在部署服务器上完成验收。

## API 主聊、Cursor 原生生图和兜底

在 `.env` 中设置以下配置，并保留有效的 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`：

```dotenv
LLM_PROVIDER=api
IMAGE_PROVIDER=cursor
CURSOR_FALLBACK=true
CURSOR_MODEL=auto
CURSOR_IMAGE_MODEL=auto
IMAGE_TIMEOUT_MS=300000
```

普通聊天由 API 回复，通过结构化回复决定是否配图，例如“解释付款流程，配张图”或接着说“把刚才的过程画出来”。需要配图时，Cursor 在独立临时工作区调用内置 GenerateImage 工具，机器人读取实际生成的位图、转换为微信大小限制内的 JPEG，按文字、图片顺序发送。`/draw` 也使用此通道。原生生图不经过 SVG；只有 `IMAGE_PROVIDER=svg` 才使用旧通道，旧通道的模型可通过 `SVG_PROVIDER=api|cursor` 和 `SVG_MODEL` 独立指定。

API 文字调用失败时，开启的 `CURSOR_FALLBACK` 会将同一文字上下文交给 Cursor，使用 CURSOR_MODEL 和 CURSOR_TIMEOUT_MS，最多兜底一次。API 正常时不调用 Cursor 聊天；图片输入及 PDF Files/Responses 链路不兜底到仅支持文本的 Cursor 接入。配图生成失败保留文字并提示失败；微信发送重试复用已保存的图片，不重新生图。每条入站消息计一次请求配额，模型调用可能包含对话、绘图和兜底等多次调用。

运行 `bash start.sh docker` 会在启用任何 Cursor 通道时检查登录。原生生图需要支持 GenerateImage 的较新 Cursor CLI 和账号权限；代码核验基于 CLI 2026.09.18-9a7762b，绘图调用复制登录配置到独立临时配置目录，同时在全局与项目层授予 `GenerateImage(*)` 和本次临时工作区内 assets 目录的写入权限，移除会覆盖该授权的 `Write(**)` / `Write(/**)`。共享登录配置及文字聊天的禁止写入规则保持不变；不启用 `--force` 或 Shell。通过 stream-json 检查 GenerateImage 工具成功事件，优先取回 imageData；没有内嵌数据时，只读取工具返回的本次临时工作区内实际文件路径，并校验真实路径和文件类型。不读取最终回复文字里的路径，不下载模型返回的 URL。模拟 CLI 和数据库测试覆盖路由、图文发送、失败重试及文件校验；真实账号生图和微信收图仍需部署验收。

参考：[Cursor 原生生图说明](https://cursor.com/changelog/page/12)、[CLI 更新日志](https://cursor.com/docs/cli/changelog)。当前支持文本类文件附件，仍不包含网络图片检索或上传图片编辑。


## 生成文件附件

普通聊天可说“把骑车的鹈鹕做成完整 HTML 动画文件发给我”“把刚才的内容保存成 Markdown”。API 或 Cursor 文字兜底生成结构化文件内容，程序将它作为微信客服 `file` 消息发送，不需要模型读取或写入服务器文件，不执行生成的代码。

目前支持 HTML、TXT、Markdown、CSV、JSON、SVG、CSS、JS、TS、Python、XML、YAML 文本文件，每轮最多一个，最多 40000 字符且不超过 200KB。PDF、Word、Excel、PPT 二进制文件生成尚未实现，不用改扩展名伪装。附件内容暂存在 PostgreSQL outbox；发送成功后清除正文、文件名和素材 ID。会话历史保留生成文件源码以供近期追问修改，沿用历史裁剪和保留期规则。

启动自动升级数据库到 schema 3，新增 outbox.filename 和 file 类型；旧版本不能直接打开升级后的数据库。文件发送失败可重试，重启后继续发送保存的文件，不重新调用模型。接口测试使用模拟微信服务，真实微信附件送达仍需上线确认。

耗时任务开始执行 3 秒后会发送一次通用等待提示，最终结果完成后正常发送。`PROGRESS_NOTICE_MS` 控制延迟，设为 0 可关闭。提示是尽力发送，不占额外模型请求配额，不进入聊天历史；排队阶段暂不提示。
