# 项目执行进度

> 更新时间：2026-09-28
> 仓库：github.com:hclovo/wecom-ai-bot（master）
> 关联文档：[REQUIREMENTS](REQUIREMENTS.md)（需求）、[README](README.md)、[DEPLOY](DEPLOY.md)

## 当前状态一览

| 模块 | 状态 | 验证方式 |
|---|---|---|
| 微信客服回调接入（验签/解密/拉取/回复） | ✅ 完成 | 端到端测试 |
| 文本多轮对话（方舟 /api/v3） | ✅ 完成 | 端到端测试 |
| 图片理解（视觉模型） | ✅ 完成 | 端到端测试 |
| 文档理解（Files API + Responses）与追问 | ✅ 完成 | 端到端测试 |
| 多会话与指令（/new /list /switch /del /reset /help） | ✅ 完成 | 端到端测试 |
| TypeScript strict 化 | ✅ 完成 | `tsc --noEmit` 零错误 |
| Docker 部署（Dockerfile + compose） | ✅ 完成 | 本机构建 + 容器 healthz 实测 |
| 部署文档 DEPLOY.md | ✅ 完成 | — |
| **云服务器部署实测** | ⬜ 待办 | 检查单见 DEPLOY 第 8 节 |
| 语音 ASR / SQLite 持久化 / 限流（P2） | ⬜ 待办 | — |

测试基线：**5/5 端到端用例通过，typecheck 零错误**（`npm test`、`npm run typecheck`）。

## 执行记录（时间线）

### 2026-09-28 · 方案设计与 P0 搭建

- 评估微信接入五条通道（个人号 wechaty / 公众号 / 企业微信 / 元器等），**决策：企业微信「微信客服」**，理由是好友零门槛 + 官方接口零封号风险
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

### 待办

1. **云服务器部署实测**（下一步）：按 DEPLOY.md 检查单执行；重点确认回调验证、可信 IP（60020）、接待方式设为「回调/API」
2. 真实环境验证 `media/get` 接口路径（编写时官方文档站为 JS 渲染无法直接核实，若 404 优先排查此处）
3. P2：语音消息（微信 silk/amr 转码 → 方舟 ASR）、SQLite 会话持久化（重启不清空）、每用户每日限流
4. 真机联调后确认 `LLM_MODEL` 支持 `input_file`（doubao-seed 系列可；GLM 文字模型可能不支持文档链路）

### 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 企业微信未验证企业功能限制（客服账号数/部分接口） | 部署时可能受阻 | 遇到限制再评估企业认证；或迁移公众号路线 |
| 会话存内存，重启清空 | 发布时打断对话 | 发布窗口避开使用时段；P2 持久化 |
| 无每用户限流 | token 费用被刷 | P2 加每日计数；短期靠圈子内使用 |
| 文件理解 file_id 服务端保留期有限 | 过期后追问报错 | 报错提示重发文件即可 |
