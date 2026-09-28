# Code Review Report

## Summary

依据 REQUIREMENTS.md 与 PROGRESS.md 审查当前完整实现，结论：正常流程已具备，但“P0/P1 已完成”应理解为实现及 mock 验证完成，尚不满足真实部署验收。确认 **11 项问题：P1 4 项、P2 7 项**，无 P0。建议先完成可靠性修复，再做小范围云端联调，之后推进持久化、限流与语音。

## Findings

### R1 · P1 · 同步只拉一页，后续消息滞留

- 位置：`server.ts:407`，`lib/wecom-api.ts:84`。
- 问题与触发：一次事件对应多页消息时，代码只请求一次 sync_msg，没有消费 has_more，也没有补拉任务。若没有后续回调，剩余消息不被处理。
- 证据：主审及独立审查均用 fetch stub 返回 has_more=1、next_cursor=next、空 msg_list，观察到仅一次同步调用。此验证证明实现行为；本次未成功读取微信官方页面，现行协议仍需联调核实。
- 建议：显式定义 has_more，按客服账号循环拉取直至结束；不要以空列表判断结束，增加游标不前进保护与失败重试。

### R2 · P1 · 媒体接口的业务错误被当作文件

- 位置：`lib/wecom-api.ts:130`。
- 问题与触发：媒体请求返回 HTTP 200 的错误 JSON 时，直接返回 Buffer；下载也没有进入 withToken。失效 token 或不存在的媒体会被编码成图片、当文本总结或上传方舟。
- 证据：HTTP 200 的 {errcode:42001,errmsg:expired} 在本地 stub 中原样返回，未刷新 token；现有 test/e2e.test.ts 的媒体 mock 本身也用 HTTP 200 返回错误，只是没有测试此分支。
- 建议：识别错误响应结构并复用 withToken 的一次刷新重试；保留合法 JSON 文件的下载语义，不能仅以“可解析为 JSON”判断失败。

### R3 · P1 · 回复失败后没有恢复路径

- 位置：`server.ts:352`、`server.ts:408`、`server.ts:411`。
- 问题与触发：游标在处理前推进，消息在发送前进入 seenMsgIds，sendReply 遇到网络错误或发送错误只记录日志并返回。即使同一消息被再次拉到，也会被去重跳过；分片发送中途失败则后续片段丢失。
- 证据：静态核对游标、去重和 catch 的控制流，未做真实微信故障注入。
- 建议：分离“已接收”和“已发送”，保存回复及各分片发送状态，有限重试并设置失败终态。不能简单把去重延后，否则会重复调用收费模型或重复发送已成功分片。

### R4 · P1 · HTTP 错误日志泄漏凭证

- 位置：`lib/wecom-api.ts:45`。
- 问题与触发：httpJson 的非 2xx 错误包含完整 URL；gettoken 的 URL 含 corpsecret，其余请求含 access_token。上游 503 等故障会经 worker/send 日志打印凭证。
- 证据：主审以 FAKE_SECRET 和 HTTP 503 stub 复现，Error.message 包含 FAKE_SECRET；未使用真实凭证。
- 建议：日志只保留接口路径、状态码、脱敏后的错误码及请求标识，集中移除 URL 查询凭证与响应中的敏感字段，并补日志断言。

### R5 · P2 · POST 不校验 receiveId

- 位置：`server.ts:464`。
- 问题与触发：GET 校验接收者，POST 丢弃 decrypt 返回的 receiveId。配置复用密钥或接收者配置错误时，其他接收者的有效签名事件仍被接受，违反 FR6。
- 证据：主审和独立审查构造 wrong-corp 的合法签名 POST，返回 200 并触发同步。这不意味着无密钥的外部用户可以伪造签名。
- 建议：共用 GET/POST 解密校验，接收者错误返回 401 且不入队。

### R6 · P2 · 指定客服账号没有过滤效果

- 位置：`server.ts:404`。
- 问题与触发：配置 WECOM_OPEN_KFID=A 时，B 的回调仍优先采用事件值并处理，偏离“留空才处理所有账号”的配置语义，造成额外模型调用和非预期回复。
- 证据：主审复现 cfg.openKfId=allowed、事件账号 other，最终 sync 请求账号仍为 other。
- 建议：入口显式校验账号；全账号模式下按 (open_kfid, external_userid) 隔离状态与任务。

### R7 · P2 · 单个慢任务阻塞所有好友

- 位置：`server.ts:397`、`server.ts:415`，`lib/ark-files.ts:51`，`lib/llm.ts:30`。
- 问题与触发：所有账号和用户共享串行队列，一次文档轮询即可让其他用户等待约 60 秒；所有 fetch 缺少应用级可取消 deadline，轮询超时也无法中断正在等待的 fetch。healthz 此时仍正常。
- 证据：静态控制流确认，未做负载测试。
- 建议：同步与推理解耦，同一用户命令和消息有序，不同用户有限并发；为下载、上传、推理、发送和整体任务设置 deadline，并限制排队长度。

### R8 · P2 · 多模态历史绕过轮数上限

- 位置：`server.ts:236`、`server.ts:274`、`server.ts:304`、`server.ts:322`；普通文本裁剪位于 `server.ts:242`。
- 问题与触发：连续图片、文件或文件追问只追加 history，不裁剪，MAX_HISTORY_TURNS 不生效，内存持续增长。recentHistory 只限制出站请求，不释放保存的历史。普通文本在追加 assistant 前裁剪，最终可有 2N+1 条并从孤立 assistant 开始。
- 证据：静态核对全部历史写入点。
- 建议：所有模态复用完整轮次提交/裁剪函数；模型失败不提交半轮，另设置字符或 token 预算。

### R9 · P2 · 部署用户名称不一致

- 位置：`DEPLOY.md:50`、`DEPLOY.md:52`、`DEPLOY.md:182`。
- 问题与触发：新机器创建 wecombot，后续 chown、sudo 和 systemd 使用 wecomb，按文档部署会因用户不存在失败。
- 证据：静态逐项核对命令；未在服务器执行。
- 建议：统一用户名，并在干净 Linux 环境核对 systemd 路径及权限。

### R10 · P2 · AESKey 生成命令随机产生无效密钥

- 位置：`DEPLOY.md:119`。
- 问题与触发：tr -d '=+/' 删除合法 Base64 字符 + 和 /。随机输出含这些字符时，key 不足 43 位，解码后不足 32 字节，触发 keyFromEncodingAESKey 拒绝。
- 证据：命令与 `lib/wecom-crypto.ts:21` 的长度校验直接冲突。
- 建议：仅移除末尾 padding，保留 +/，优先使用管理后台生成值；验证长度 43 且解码为 32 字节。

### R11 · P2 · Docker 更新密钥后 restart 不会加载新环境

- 位置：`DEPLOY.md:290`，`compose.yaml:10`。
- 问题与触发：文档让用户改 .env 后 compose restart，但 env_file 在创建容器时注入。回调后台与容器可能仍使用不同密钥。
- 证据：配置静态核对，Docker 官方明确说明 restart 不应用环境变量变更；本次未运行 Docker。
- 建议：修改环境后重新创建容器，例如 docker compose up -d --force-recreate；源码更新则另需构建新镜像。
- 来源：[Docker compose restart 官方文档](https://docs.docker.com/reference/cli/docker/compose/restart/)。

## Review Scope

- 用户指定按 REQUIREMENTS / PROGRESS 审查需求完成度，因此范围为 HEAD 的完整现有实现，而非仅最后一次文档提交。审查前工作树干净。
- 阅读 server.ts、lib/*.ts、test/e2e.test.ts、package.json、Dockerfile、compose.yaml、.dockerignore、README、REQUIREMENTS、PROGRESS 和 DEPLOY 相关部署流程。
- 已检查适用目录，未发现 AGENTS.md。未修改源代码、原始需求或历史进度。

## Verification and Test Gaps

- npm test：5/5 通过。其中 2 项是加解密/切分测试，3 项是 mock 端到端测试，并非文档所称“5 个端到端用例”。沙箱首次因 listen EPERM 失败，获得工具许可后重新执行通过。
- npm run typecheck：通过。
- 主审无网络 fetch stub：复现 R1、R2、R4、R5、R6；独立审查另外完成同类复现和静态核对。
- 缺少分页、发送失败恢复、重复消息、跨用户、token 失效、媒体错误、receiveId 不符、配置账号过滤、历史边界、超时和 /reset 的关键负向断言。
- 未连接真实企业微信、方舟或云主机；未重新构建 Docker。通过现有 mock 不能证明真实 API 路径、模型能力和文件状态契约正确。

## Residual Risks

1. `lib/wecom-api.ts:132` 的 /cgi-bin/kf/media/get 正确性仍未确认；本次访问微信官方文档失败。保持为上线阻断核验项，不能用与实现相同的 mock 路径证明接口正确。
2. `server.ts:86` 注释称 2048 字节，但按 UTF-16 长度切片。已复现 700 个中文字产生 2100 字节单条；官方当前限额未核实，暂不计入确认缺陷。按 Unicode 完整字符和字节预算设计，同时核实发送窗口、条数及 msgid 约束。
3. 方舟 file-extract、文件状态、Office 类型、input_file 和具体模型兼容性未真实验证；默认文本模型不应被直接认定可完成所有文档任务。
4. 重启丢失历史之外，游标、去重和未完成任务也丢失。后续 SQLite 设计必须同时覆盖消息可靠性。
5. FILE_MAX_MB 在完整 arrayBuffer 下载之后才检查，无法限制下载峰值内存；HTTP 回调也没有体积限制。下载时计数中止、回调体积限制及限流纳入下一阶段。
6. 文本文件摘要后只保留文件名和摘要，无法保证原文细节追问；需求需明确文本文件追问边界。默认会话 #1 是否永久保留、切回旧会话是否恢复文件目标，也需明确验收语义。
7. 官方通道不等于“无任何账号风险”，成本也不能在没有真实用量时标记为已验证；文档应改为使用条件与待实测项。

## Review Metadata

- 仓库：/Users/zhanghuanming/.zcode/workspace/default/wecom-ai-bot
- 修订：c8885e5a53e108f3756f22155f818ae0ea590eee（master）
- 报告时间：2026-09-28T11:34:23 Asia/Shanghai
- 独立子代理：independent_review，已成功完成只读审查；主审重新核对保留发现。
- 报告与后续设计为本轮新增文档，不属于被审查基线。
