# 项目执行进度

> 更新时间：2026-09-28
> 仓库：github.com:hclovo/wecom-ai-bot（master）
> 关联文档：[REQUIREMENTS](REQUIREMENTS.md)（需求）、[README](README.md)、[DEPLOY](DEPLOY.md)

## 当前状态一览

| 模块 | 状态 | 验证方式 |
|---|---|---|
| 回调、文本、会话指令 | 已实现，本地验证通过 | mock 端到端及负向测试 |
| 图片、PDF、文本文件与追问 | 已实现，真实模型待验收 | mock 端到端及协议参数断言 |
| Word/Excel/PPT 直接理解 | **尚未实现**，提示先转 PDF | 根据方舟官方文件格式约束纠正旧结论 |
| PostgreSQL 会话/游标/inbox/outbox | 已实现，已替换当前 SQLite 运行路径 | 真实 PG 17 的重启、事务、并发与续发测试 |
| 限额、并发隔离、超时、有限发送重试 | 已实现 | 故障注入与多用户测试 |
| 安全校验及日志脱敏 | 已修复 | 负向测试与独立复核 |
| TypeScript strict | 通过 | npm run typecheck |
| PostgreSQL Docker 部署 | 仅部署应用，连接已有独立数据库 | PostgreSQL 17 + Node 24.21.0 非 root 应用容器、healthz 验证通过 |
| 云服务器联调 | 待办 | 已有服务器，域名暂缺，可先准备 IP 入口 |
| Office 转换、语音 | 待办 | 可靠性及真实链路验收后安排 |

测试基线：**28 项通过**（包括单元、存储及 mock 端到端测试），typecheck 通过。数据库使用真实 PostgreSQL 17；微信及方舟仍为 mock。

## 执行记录（时间线）

### 2026-09-28 · PostgreSQL 版本

- 按用户要求暂不使用 SQLite，切换 DATABASE_URL + pg 异步连接池；旧 SQLite 文件未读取/删除，不做隐式迁移。
- 重写事务存储与异步调度，保留收件游标原子性、重启续发、限额、会话隔离；补充重复提交幂等保护。
- 增加 schema 版本和单实例数据库锁，避免第二实例重置在途任务；锁丢失时停止主程序，交给 Compose/systemd 重启。
- 状态/重发脚本使用独立管理连接，不触发迁移或任务恢复。提供 PostgreSQL 连接与备份说明，不保留数据库部署文件。
- 25 项数据库及消息测试在真实临时 PostgreSQL 17 上通过，覆盖并发额度、事务回滚、重复提交、实例锁丢失与版本拒绝。
- 根据后续要求增加 start.sh、START.md 和配置检查命令，生成待编辑 .env（Git 忽略）；删除 PostgreSQL 部署文件，仅连接用户已有实例。
- 新增 3 项启动测试，总计 28/28 通过；typecheck、shell 语法和 Compose 配置验证通过；镜像构建及 Node 24.21.0 / UID 1000 连接 PostgreSQL + healthz 冒烟通过。

以下 SQLite 记录为历史实现，当前运行配置以 PostgreSQL 章节为准。

### 2026-09-28 · 审查后可靠性落地（未提交工作树）

- 修复分页、媒体业务错误、POST receiveId、客服账号过滤、日志凭证泄漏及历史裁剪；按 UTF-8 字节切分回复。
- 新增 SQLite 事务收件/游标、持久化回复、分片重试、单用户有序与跨用户并发、每日额度及数据清理。
- 补充下载流式上限、请求超时、回调体积限制与密文校验；修改 Docker 卷权限、部署用户、密钥生成及环境更新说明。
- 独立审查发现 SQLite 保存失败可能重跑模型，已修复为保留结果仅重试保存并增加回归测试。
- 核对方舟官方 Files 文档，修正 purpose=user_data；文档类别仅列 PDF，因此 Office 直接理解从“完成”改为待办。
- 容器验证：镜像构建通过；Node v24.21.0、UID 1000、匿名数据卷写入、healthz、SQLite 重开恢复均通过。没有访问真实微信或方舟。
- 当前不需要额外数据库或对象存储：SQLite 在服务器本地；PDF 原件由方舟托管，图片只在内存，文本截断原文保存于 SQLite。

以下为此前实施记录，其中旧的“已完成”及 API 假设以当前状态表和本轮核验为准。

### 2026-09-28 · 方案设计与 P0 搭建

- 评估微信接入五条通道（个人号 wechaty / 公众号 / 企业微信 / 元器等），**决策：企业微信「微信客服」**，理由是好友零门槛 + 官方接口（旧记录的“零风险”措辞已纠正，实际遵循平台规则）
- 搭建项目骨架（Node 零依赖）：企业微信加解密、微信客服 API（sync_msg/send_msg）、会话管理、LLM 网关
- 端到端测试体系：mock 微信回调 + mock 方舟接口，全链路验证（期间修正 mock 时序与回复切分语义：短段落合并、超长硬切）

### 2026-09-28 · 多模态与多会话（P1）

- 文件处理：媒体下载（`/cgi-bin/kf/media/get`）、方舟 Files API 上传 → Responses `file_id` 问答 → 会话内追问
- 图片走视觉模型（data URI → `image_url`）；文本类文件直读进 prompt；语音/视频友好降级
- 多会话指令集上线，防单一上下文膨胀（期间修复 `/new` 编号覆盖 #1 的 bug）
- 重构：会话/游标/去重状态收进 `createServer` 实例，消除测试间状态泄漏；补修重构引入的"文本消息未写入历史"回归

### 2026-09-28 · 工程化与交付

- **TypeScript 迁移**（strict、verbatimModuleSyntax、`.ts` 真实扩展名 + Node 原生 type stripping，保持零运行时依赖）
- 迁移过程中发现并修复**关键 bug**：`getAccessToken` 取错字段名（`secret` vs `kfSecret`），真实环境会发出 `corpsecret=undefined` 导致 bot 无法工作；已加 gettoken 参数回归断言
- **Docker 化**：node:24-alpine 非 root 镜像、HEALTHCHECK 探活、compose 密钥经 env_file 注入；本机构建 + 容器 healthz 冒烟实测通过
- 云服务器部署文档 DEPLOY.md（Docker 推荐路线 + systemd 备选 + nginx/HTTPS + 可信 IP + 排错表）
- Git 仓库建立并推送 GitHub；补 WebStorm 的 `.idea/vcs.xml` 版本控制映射

## 提交历史

| 提交 | 内容 |
|---|---|
| `9727c97` | 初始提交：完整功能 + 测试 + 文档 |
| `6d0ad55` | gitignore 忽略 .idea |
| `f241a75` | Docker Compose 部署路线 |

## 待办与风险

1. 提供服务器系统/公网 IP/连接方式，以及企业微信和方舟配置文件位置（不要在聊天粘贴密钥），准备部署。IP/HTTP 能否使用需目标微信客服后台验证。
2. 真机核验媒体路径、sync token/频率限制、发送窗口/条数限制，验证具体模型的图片/PDF 能力与文件失效行为。
3. 按 DEPLOY 检查单进行真实回调、两位好友并发、故障恢复、重启与备份恢复验收，并观察 24–48 小时。
4. Office 原件直接理解需要转换/解析链路；语音需要格式验证、转码与 ASR 能力，暂未启动。
5. PostgreSQL 同一 schema 单实例使用，以 pg_dump/pg_restore 备份恢复；恢复前停止机器人并使用新库验证，不要删除命名卷。模型结果尚未落盘时进程退出仍可能重复计费；发送成功未记账时仍可能重复投递。
6. 方舟 file_id 过期后需重发文件；长期保存原件/自动重传时再考虑 TOS/S3。平台规则、企业权限及费用均需实际验证，不能保证“零风险/固定低成本”。
