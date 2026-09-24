# wecom-ai-bot

通过**企业微信「微信客服」**把 AI 大模型（火山方舟 GLM 等，OpenAI 兼容接口均可）接入微信：你的好友用普通微信扫客服二维码，即可像聊天一样使用 AI，还能发图片和文档让 AI 解读。

零依赖运行（Node ≥ 23.6 自带全部能力，原生直接执行 `.ts`，无需编译），单进程即可运行。`npm install` 仅用于类型检查（devDependencies：typescript、@types/node）。

```
微信用户 ──微信──▶ 微信客服（官方通道，合规无封号风险）
                      │ 事件回调（AES 加密 XML）
                      ▼
              本服务 /webhook（验签 → 解密）
                      │ sync_msg 拉取消息
                      ▼
┌─────────────────────────────────────────────┐
│ 文本   → chat/completions（多轮会话）        │
│ 图片   → media/get 下载 → 视觉模型解读       │
│ 文档   → media/get 下载 →                    │
│   · PDF/Word/Excel/PPT → 方舟 Files API 上传 │
│     → Responses API（file_id）问答与追问     │
│   · 文本类文件 → 内容直读进 prompt           │
└─────────────────────────────────────────────┘
                      │
                      ▼
              send_msg 回复（超长自动切分）
```

## 项目结构

| 文件 | 职责 |
|---|---|
| `server.ts` | 入口：HTTP 服务、回调验签/解密、消息分发（文本/图片/文件/语音）、会话管理 |
| `lib/wecom-crypto.ts` | 企业微信加解密与签名校验（AES-256-CBC / SHA1） |
| `lib/wecom-api.ts` | 微信客服 API：access_token 缓存、sync_msg、send_msg、媒体下载 |
| `lib/ark-files.ts` | 方舟文件理解：Files API 上传 → 轮询 → Responses API（file_id）问答 |
| `lib/llm.ts` | OpenAI 兼容 chat/completions 调用 |
| `test/e2e.test.ts` | 端到端测试：模拟微信回调 + 模拟方舟，验证文本/图片/PDF/文本文件全链路 |

## 部署步骤

### 1. 注册企业微信并开通微信客服

1. 在 [work.weixin.qq.com](https://work.weixin.qq.com) 免费注册企业微信（个人即可注册）。
2. 管理后台 →「我的企业 → 企业信息」→ 记下 **企业 ID（CorpID）**。
3. 「应用管理 → 微信客服」→ 创建一个**客服账号**（`wk` 开头的 open_kfid），并生成**客服账号二维码**——这就是好友添加 AI 的入口。
4. 在「微信客服 → API」页面：
   - 启用 API 接收消息，记下 **Secret**；
   - 配置「接收消息」回调：URL、Token、EncodingAESKey（先看第 3 步把服务跑起来再回来配）。

### 2. 配置大模型

`.env` 里填三样：

- `LLM_BASE_URL`：火山方舟为 `https://ark.cn-beijing.volces.com/api/v3`
- `LLM_API_KEY`：方舟 API Key（本机已装 arkcli 的话，可用 `arkcli auth apikey` 相关命令生成/查看）
- `LLM_MODEL`：接入点 ID（`ep-xxx`）或模型名

### 3. 运行

```bash
cp .env.example .env   # 填好所有配置
npm start              # 运行时零依赖，无需 npm install（需要 Node ≥ 23.6）
```

或用 Docker（服务器部署推荐，完整流程见 DEPLOY.md）：

```bash
docker compose up -d --build
```

服务默认监听 `:8788`，回调路径为 `/webhook`。

### 4. 配置回调 URL 并让好友接入

1. 回到企业微信管理后台，把回调 URL 填为 `https://<你的域名>:8788/webhook`。
   - 服务必须能被公网访问。部署到 VPS 最省事；本机运行可临时用内网穿透（cloudflared / frp / ngrok）。
2. 填入你在 `.env` 里设置的 Token 和 EncodingAESKey，点验证（本服务会解密 echostr 完成校验）。
3. 在客服账号详情里把**接待方式设为回调/API 接入**，否则消息会进人工接待队列。
4. 把客服账号二维码发给好友：好友用微信扫码 → 直接在微信里和 AI 对话。

## 使用

- 好友发消息 → AI 回复；多轮上下文按用户隔离（默认保留最近 12 轮）。
- **会话指令**（每个好友可开多个会话，防止单一上下文越滚越大）：
  - `/new [标题]` 开启新会话并切换过去，旧话题的上下文和文件追问都不会跟过来
  - `/list` 列出所有会话（标注活跃会话、消息数、追问中的文件）
  - `/switch 编号` 切换到指定会话
  - `/del 编号` 删除会话
  - `/reset` 清空当前会话的上下文
  - `/help` 查看指令列表
- 回复超过 1000 字自动切分为多条发送。
- **图片**：直接发图，AI 用视觉模型描述并解读（`LLM_VISION_MODEL` 可单独指定模型）。
- **文档**：发 PDF/Word/Excel/PPT，AI 上传到方舟 Files API 后自动总结；之后的文字消息会作为**针对该文件的追问**继续解答，直到发新文件、切换会话或 `/reset`。
- **文本类文件**（txt/md/csv/代码等）：内容直接读进 prompt 总结。
- 语音/视频暂不支持，会收到友好提示。
- 大小上限默认 20MB（`FILE_MAX_MB` 可调）。
- 修改人设/风格：`.env` 里的 `LLM_SYSTEM_PROMPT`。

## 模型能力要求

- `LLM_MODEL`：文本对话 + 文档理解（文档走方舟 Responses API，需模型支持 `input_file`，如 doubao-seed 系列）。
- `LLM_VISION_MODEL`：看图（需支持 `image_url` 输入），不填则复用 `LLM_MODEL`。
- 模型选择可用 `arkcli models search` 核对多模态支持情况。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| `errcode 60020` | 企业微信要求在管理端为该 Secret 配置服务器「可信 IP」，把部署机器的公网 IP 加进去 |
| `errcode 40029` / 验证失败 | Token、EncodingAESKey 与管理端不一致，或 receiveId 不是 CorpID |
| 收到消息但没回复 | 检查客服账号接待方式是否为「回调/API」；看服务日志里 sync_msg / llm 的报错 |
| LLM 报 401/404 | API Key 或 BASE_URL / MODEL 配置错误，可用 `curl $LLM_BASE_URL/chat/completions` 排查 |
| 回复延迟数秒 | 正常：微信客服链路是「回调通知 → 拉取 → 调模型 → 补发」的异步流程 |

## 验证测试

```bash
npm test            # 端到端测试
npm run typecheck   # TypeScript 类型检查（tsc --noEmit）
```

测试不依赖任何外部服务：用 mock 模拟企业微信回调整条链路（验签 → 解密 → 拉消息 → 调 LLM → 发回复）。

## 已知边界（P2 可扩展）

- 语音消息未接入（微信语音是 silk/amr 格式，需先转码再走 ASR）；视频未接入。
- 会话与文件追问上下文存内存，重启即清空；需要持久化可加 SQLite。
- 文件理解的 file_id 由方舟服务端保留一段时间，过期后追问会报错（重新发文件即可）。
- 未做每用户限流；若担心 token 消耗可在 `handleMessage` 加每日计数。
