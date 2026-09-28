# Code Review Report

## Summary

本轮实施 S1/S2 后完成独立复核。发现并修复 1 项 P1（结果持久化失败导致重复模型调用）；当前 **No actionable findings**，未保留未修复的可行动发现。结论限于本地代码及测试，不等同于真实环境验收。

## Findings

无未修复发现。已关闭的问题：`lib/message-worker.ts` 的 handler 完成后 saveReply 失败原本恢复为 pending，会重复调用模型。现保留当前结果、只重试保存，pendingWrites 暂停新增模型任务。SQLite 写失败回归断言模型仅调用一次；独立审查者复验通过。

上一轮审查中的分页、媒体错误、发送恢复、凭证日志、receiveId、账号过滤、队列阻塞、历史上限和部署命令问题均已在本轮处理。协议核验额外发现方舟 purpose 与 Office 类型假设不正确：改用 user_data，Office 友好提示转 PDF，需求文档如实标为待办。

## Review Scope

基线 c8885e5a53e108f3756f22155f818ae0ea590eee，当前未提交工作树的 server、lib、test、scripts、Docker/Compose、配置示例及需求/部署文档。此前审查报告和 NEXT-STEPS 作为背景，不覆盖其历史内容。新增 message-store/message-worker/http-client 也纳入审查。

## Verification and Test Gaps

- npm test：18/18 通过（本地 Node v26.8.1，包含 3 个原有 mock 端到端和新增行为测试）。
- npm run typecheck：通过；git diff --check：通过。
- 覆盖：Unicode 字节切分、媒体失效 token、下载上限、错误接收者、账号过滤、回调上限、事务容量回滚、重启状态、分页及去重、跨用户隔离、发送重试、全模态历史上限、文本文件追问与 reset、SQLite 写失败、剩余分片续发、限额、请求超时、PDF 上传参数及 Office 降级。
- Docker 镜像构建通过；无外网临时容器中 Node v24.21.0 / UID 1000、匿名卷写入、healthz 与 SQLite 重开恢复均通过。临时容器与卷自动清理。
- 独立审查者复测存储失败、outbox 恢复及限额相关 4 项测试，通过。
- 尚无真实企业微信、方舟模型、云端配置及 24–48 小时运行观测；未跑 Linux systemd 实机流程。

## Residual Risks

- 方舟结果已成功生成但落盘前进程退出仍可能重复调用；发送成功但本地标记前中断仍可能重复投递。稳定 msgid 与持久化降低风险，不保证 exactly-once。
- 微信媒体默认 /cgi-bin/media/get 路径、sync token/频率、发送字节及条数窗口，仍需目标账号验收；WECOM_MEDIA_PATH 可配置。IP/HTTP 回调是否接受以后台验证为准。
- 方舟具体模型需支持 PDF input_file。Office 直接理解、语音没有实现；不宣称它们通过验收。
- SQLite 仅限一个服务器进程使用；本地数据库和备份含用户文本，需限制目录权限并按 DEPLOY 停服备份。清理为逻辑删除，不是物理安全擦除。
- 保存失败时结果暂存在活进程内，存储持续不可用会暂停新模型任务；需要管理员修复磁盘/权限并查看日志。healthz 本身不表示任务健康。
- 模型输出较长可能超微信允许发送条数，永久失败进入 failed，可查看并人工处理。文件到期不自动重传原件，当前没有用户自有对象存储。

## Review Metadata

- 仓库：/Users/zhanghuanming/.zcode/workspace/default/wecom-ai-bot
- 时间：2026-09-28T13:42:14 Asia/Shanghai
- 范围：HEAD c8885e5 + 本轮未提交实现，未执行提交或推送。
- 独立审查：reliability_review 完成首次审查及修复复核，无新增重大可行动问题。
- 外部核验：[方舟 Files API](https://docs.volcengine.com/docs/ark/file-api?lang=zh)、[Node 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)。
