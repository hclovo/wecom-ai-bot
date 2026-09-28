# 部署指南（自有云服务器）

本文面向把 wecom-ai-bot 部署到一台自己的云服务器（VPS）的场景：从裸机初始化到 systemd 守护、HTTPS 暴露、企业微信侧收尾、验证与日常更新。项目介绍与架构说明见 [README.md](./README.md)，本文只讲部署落地。

以 **Ubuntu 22.04 / 24.04** 为例，其他发行版仅包管理器命令不同。

## 1. 前置清单

| 项目 | 说明 |
|---|---|
| 云服务器 | 1 台有**公网 IP** 的机器即可（1C1G 足够，零依赖单进程）。阿里云 / 腾讯云 / 火山引擎等均可 |
| 域名 | 可选但**强烈推荐**：用于 certbot 申请 HTTPS 证书。企业微信回调接受 http，但 https 更安全 |
| 企业微信管理后台 | 能登录 [work.weixin.qq.com](https://work.weixin.qq.com)，且已注册企业、开通微信客服（步骤见 README「部署步骤」第 1 节） |
| 大模型 API Key | 火山方舟 API Key（或任意 OpenAI 兼容接口的 Key） |

部署前请先记录好：企业 ID（CorpID）、微信客服 Secret、方舟 API Key。各项在后台的对应位置见下文第 4 节。

## 2. 服务器初始化

> **走 Docker 路线（推荐，见第 5.1 节）**：只需安装 Docker 本身，可跳过 2.1（Node 安装）和 2.2（专用用户，容器内已用非 root 运行），目录随便放。

### 2.1 安装 Node 24 LTS

项目零运行时依赖，只需 Node 本体。要求 Node ≥ 24.0（原生 type stripping，可直接运行 `.ts`，无需编译），建议装 Node 24 LTS。用 NodeSource 安装：

```bash
# 安装 NodeSource 源并安装 Node 24 LTS
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# 确认版本
node -v   # 应输出 v24.x
```

如果偏好用户级安装（不污染系统），用 nvm：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 24
```

> 注意：nvm 装的 node 在用户家目录下，systemd 无法直接使用其绝对路径，建议用 NodeSource 的系统级安装配合 systemd；坚持用 nvm 的话，`ExecStart` 里写 `nvm which 24` 输出的绝对路径。

### 2.2 创建专用用户与目录

不用 root 跑服务，创建一个无登录 shell 的专用用户：

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin wecomb
sudo mkdir -p /opt/wecom-ai-bot
sudo chown wecomb:wecomb /opt/wecom-ai-bot
```

## 3. 上传代码

零依赖、无需 `npm install`，代码上去就能跑。二选一：

**方式 A：git clone（推荐，便于后续更新）**

```bash
# 仓库为私有时，先在服务器上配置 deploy key 或使用 https + token
sudo -u wecomb git clone <你的仓库地址> /opt/wecom-ai-bot
```

**方式 B：scp 上传（本地执行）**

```bash
# 在你自己的电脑上执行，把项目传到服务器
scp -r ./server.ts ./lib ./test ./package.json ./tsconfig.json ./.env.example \
  <用户名>@<服务器公网IP>:/opt/wecom-ai-bot/

# 回到服务器修正属主
ssh <用户名>@<服务器公网IP> 'sudo chown -R wecomb:wecomb /opt/wecom-ai-bot'
```

上传后目录结构应为：

```
/opt/wecom-ai-bot/
├── server.ts
├── lib/
│   ├── wecom-crypto.ts
│   ├── wecom-api.ts
│   ├── ark-files.ts
│   └── llm.ts
├── test/
├── package.json
├── tsconfig.json
└── .env.example
```

## 4. 配置 .env

```bash
cd /opt/wecom-ai-bot
sudo -u wecomb cp .env.example .env
sudo -u wecomb nano .env    # 或 vim
```

逐项来源：

| 变量 | 填什么 | 来源 |
|---|---|---|
| `WECOM_CORP_ID` | 企业 ID | 管理后台「我的企业 → 企业信息」页底部 |
| `WECOM_KF_SECRET` | 微信客服 Secret | 「应用管理 → 微信客服 → API」页面，启用 API 接收消息时生成 |
| `WECOM_TOKEN` | 回调 Token | 下文第 6 节配置回调 URL 时**自己随机生成**的一串字符，两边保持一致 |
| `WECOM_ENCODING_AES_KEY` | 43 位字符串 | 配置回调时自己生成（企业微信后台可一键随机生成），两边保持一致 |
| `LLM_BASE_URL` | 火山方舟为 `https://ark.cn-beijing.volces.com/api/v3` | 任意 OpenAI 兼容接口均可 |
| `LLM_API_KEY` | 方舟 API Key | 火山方舟控制台「API Key 管理」，或本机 `arkcli` 生成（见 README） |
| `LLM_MODEL` | 接入点 ID（`ep-xxx`）或模型名 | 火山方舟控制台「在线推理」创建的接入点 |

可选项（`WECOM_OPEN_KFID`、`LLM_VISION_MODEL`、`LLM_SYSTEM_PROMPT`、`FILE_MAX_MB` 等）含义见 `.env.example` 内注释与 README「使用」一节。

生成随机 Token / AESKey 也可以在服务器上直接做：

```bash
openssl rand -hex 16    # 可用作 Token
openssl rand -base64 32 | tr -d '=\n' | cut -c1-43   # 可用作 43 位 EncodingAESKey
```

**务必收紧权限（密钥文件，只有运行用户可读）：**

```bash
sudo chmod 600 /opt/wecom-ai-bot/.env
sudo chown wecomb:wecomb /opt/wecom-ai-bot/.env
```

## 5. 守护进程

### 5.1 Docker Compose（推荐）

项目自带 `Dockerfile`（node:24-alpine 基础镜像、非 root 运行、自带 /healthz 探活）和 `compose.yaml`（`restart: unless-stopped`，随 Docker 服务开机自启）。配置从同目录 `.env` 注入，**不会打进镜像**。

安装 Docker（如尚未安装）：

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
```

构建镜像并启动：

```bash
cd /opt/wecom-ai-bot        # 第 4 步的 .env 已就位于此
sudo docker compose up -d --build
```

常用运维命令：

```bash
sudo docker compose ps          # 运行状态
sudo docker compose logs -f     # 实时跟踪日志
sudo docker compose restart     # 重启
sudo docker compose down        # 停止并移除容器
```

本机自测：

```bash
curl http://127.0.0.1:8788/healthz    # 应返回 ok（容器内 HEALTHCHECK 也在自动探活）
```

### 5.2 systemd（不用 Docker 的备选）

创建服务文件：

```bash
sudo nano /etc/systemd/system/wecom-ai-bot.service
```

写入以下内容（可直接复制；Node 路径以 `which node` 实际输出为准）：

```ini
[Unit]
Description=wecom-ai-bot (WeCom WeChat Customer Service AI bot)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=wecomb
Group=wecomb
WorkingDirectory=/opt/wecom-ai-bot
ExecStart=/usr/bin/node /opt/wecom-ai-bot/server.ts
Restart=always
RestartSec=3
TimeoutStopSec=20
UMask=0077
# .env 由服务自身读取（dotenv 逻辑内置于 server.ts），无需 EnvironmentFile
# 如需指定端口可取消下行注释
# Environment=PORT=8788

[Install]
WantedBy=multi-user.target
```

> `ExecStart` 里的 node 路径：`which node` 确认。NodeSource 安装通常是 `/usr/bin/node`；nvm 安装则为 `~/.nvm/versions/node/v24.x.x/bin/node` 的绝对路径，且要保证 wecomb 用户可读。

启动并设置开机自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wecom-ai-bot
```

常用运维命令：

```bash
sudo systemctl status wecom-ai-bot     # 看运行状态
sudo systemctl restart wecom-ai-bot    # 重启
sudo systemctl stop wecom-ai-bot       # 停止
journalctl -u wecom-ai-bot -f          # 实时跟踪日志
journalctl -u wecom-ai-bot --since today  # 看今天的日志
```

先本机自测一下：

```bash
curl http://127.0.0.1:8788/healthz    # 应返回 ok
```

## 6. 对外暴露服务

企业微信回调要求 URL 公网可达。两条路线二选一。

### 路线 A（推荐）：nginx 反向代理 + HTTPS

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

新建站点配置 `/etc/nginx/sites-available/wecom-ai-bot`（先把 `你的域名` 换成实际域名，且 DNS A 记录已指向服务器公网 IP）：

```nginx
server {
    listen 80;
    server_name 你的域名;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用并申请证书：

```bash
sudo ln -s /etc/nginx/sites-available/wecom-ai-bot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 一条命令申请 Let's Encrypt 证书并自动改写为 HTTPS
sudo certbot --nginx -d 你的域名
```

certbot 会自动配置续期，可用 `sudo certbot renew --dry-run` 验证。

之后企业微信回调 URL 填：

```
https://你的域名/webhook
```

云厂商**安全组**放行 80、443 端口（TCP）。

### 路线 B（简易）：无域名，直接 HTTP + 端口

没有域名也可以直接把 8788 暴露出去：

1. 云厂商控制台的**安全组**放行 TCP 8788。
2. 服务器本机防火墙（如已启用 ufw）同样放行：
   ```bash
   sudo ufw allow 8788/tcp
   ```
3. 回调 URL 填：
   ```
   http://服务器公网IP:8788/webhook
   ```

企业微信接受 http 回调，但明文传输意味着 Token/AESKey 参与的签名机制之外没有任何通道加密，长期使用建议回到路线 A。若坚持用此方案，建议用云防火墙/安全组把 8788 的来源限制为企业微信回调的出口网段（若无法穷举，至少限制到可信任范围），并在 `.env` 中使用足够随机的 Token 和 EncodingAESKey。

## 7. 企业微信侧收尾

代码跑起来、公网可达之后，回到管理后台「应用管理 → 微信客服 → API」：

1. **配置接收消息回调**：
   - URL 填 `https://你的域名/webhook`（或路线 B 的 `http://IP:8788/webhook`）；
   - Token、EncodingAESKey 填与 `.env` 中完全一致的值（若后台随机生成了一版，反过来把后台的值复制进 `.env`，再执行 `sudo docker compose up -d --force-recreate`（Docker）或 `sudo systemctl restart wecom-ai-bot`（systemd）也可以）；
   - 点「保存/验证」，企业微信会向 URL 发一条加密的验证请求，本服务解密 echostr 并回传，通过即配置成功。
2. **接待方式**：进入客服账号详情，把接待方式设为「**回调/API 接入**」，否则消息会进人工接待队列，AI 不会回复。
3. **可信 IP**：在该 Secret 的「企业可信 IP」配置里，填入**服务器的公网 IP**（不是内网 IP）。不填的话服务调用微信客服 API 会报 `errcode 60020`。服务器公网 IP 可用下面命令确认：
   ```bash
   curl -s ifconfig.me
   ```
4. **分享入口**：生成/复制客服账号二维码，发给好友，好友用微信扫码即可开始与 AI 对话。

## 8. 验证部署成功的检查单

按顺序逐项确认：

- [ ] `curl http://127.0.0.1:8788/healthz` 在服务器本机返回 `ok`
- [ ] 守护进程在运行：Docker 路线 `sudo docker compose ps` 显示 `Up`（`docker inspect --format '{{.State.Health.Status}}' wecom-ai-bot` 为 `healthy`）；systemd 路线 `systemctl status wecom-ai-bot` 显示 `active (running)` 且 `is-enabled` 为 `enabled`
- [ ] 外网可达：本地电脑执行 `curl https://你的域名/healthz`（路线 B 则为 `curl http://IP:8788/healthz`）返回 `ok`
- [ ] 企业微信后台回调配置「验证」通过（保存时不报 URL/Token 错误）
- [ ] `sudo docker compose logs -f`（Docker）或 `journalctl -u wecom-ai-bot -f`（systemd）中能看到企业微信回调请求进来
- [ ] 用自己的微信扫客服二维码，发一条文本消息，几秒内收到 AI 回复
- [ ] （可选）发一张图片、一个 PDF，确认多模态与文档链路正常

## 9. 更新发布流程

**Docker 路线：**

```bash
cd /opt/wecom-ai-bot
sudo git pull                          # scp 方式部署的则重新 scp 覆盖
sudo docker compose up -d --build      # 重新构建镜像并滚动替换容器
sudo docker compose logs -f            # 确认启动无报错、回调正常进入
```

**systemd 路线：**

```bash
cd /opt/wecom-ai-bot
sudo -u wecomb git pull
sudo systemctl restart wecom-ai-bot
journalctl -u wecom-ai-bot -f
```

零依赖、无构建步骤（Docker 构建也只是拷文件），restart 即生效。注意：会话、游标和待发回复保存在 SQLite；更新前备份数据库，不要删除数据卷。Docker 修改代码后需 `docker compose up -d --build`，修改 .env 后需重新创建容器。

## 10. 常见故障排查

| 现象 | 原因与处理 |
|---|---|
| 日志报 `errcode 60020` | 未配置服务器「可信 IP」：管理后台该 Secret 的「企业可信 IP」加上服务器**公网 IP**（`curl -s ifconfig.me` 确认），保存后无需重启服务 |
| 回调验证失败 / `errcode 40029` / 验签失败 | `.env` 里的 `WECOM_TOKEN`、`WECOM_ENCODING_AES_KEY` 与企业微信后台配置不一致；改完任一侧后需重启服务并重试验证。若仍失败，确认 `WECOM_CORP_ID` 正确（解密校验 receiveId 用） |
| 公网访问不通 / 回调超时 | 云**安全组**未放行 80/443（路线 A）或 8788（路线 B）；服务器本机 ufw 未放行；nginx 未启动或 `nginx -t` 报错。逐步排查：本机 `/healthz` → 公网 `curl /healthz` → 后台验证 |
| 服务起了但马上退出 | Docker 路线 `sudo docker compose logs --since 5m`、systemd 路线 `journalctl -u wecom-ai-bot -n 50` 看报错；常见为 `.env` 缺项（容器日志会打印「缺少配置: …」）、`.env` 不在 compose.yaml 同目录 |
| 回调验证通过但收不到消息 | 客服账号的**接待方式**未设为「回调/API 接入」，消息进了人工队列；或 `.env` 里 `WECOM_OPEN_KFID` 过滤掉了该客服账号 |
| 收到消息但没回复 | 看 `docker compose logs -f`（Docker）或 `journalctl -f`（systemd）里 sync_msg / llm 的报错；LLM 401/404 多为 API Key、`LLM_BASE_URL`、`LLM_MODEL` 配置错误 |
| 回复延迟数秒 | 正常现象：链路是「回调通知 → sync_msg 拉取 → 调模型 → send_msg 补发」的异步流程（见 README「常见问题」），几秒内属正常范围 |
| 证书到期回调失败 | certbot 自动续期失败，手动 `sudo certbot renew` 并确认 80 端口安全组放行 |


## 9. 无域名时的公网 IP 联调

可以先部署 IP 入口，是否接受 IP/HTTP 以目标账号的「微信客服 → API」回调验证结果为准；若后台明确要求域名或 HTTPS，再补齐对应资源。不要将普通 HTTP 服务地址直接写成 https。

本项目 Compose 将 8788 绑定到服务器回环地址。安装 Nginx 后在独立站点中配置（替换实际公网 IP，避免与已有站点冲突）：

```nginx
server {
    listen 80;
    server_name 你的公网IP;
    client_max_body_size 64k;
    location = /webhook {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host $host;
        proxy_read_timeout 10s;
    }
    location / { return 404; }
}
```

运行 `nginx -t` 后 reload；安全组和防火墙放通 80，回调地址填 `http://你的公网IP/webhook`。服务器必须能出站访问企业微信与方舟 HTTPS API，可信 IP 填实际出口公网 IP（有 NAT 时可能与入站地址不同）。healthz 通过服务器本地 `curl http://127.0.0.1:8788/healthz` 检查即可。

## 10. SQLite 运维与恢复

无需购买云数据库，Node 24 内置 SQLite。仅运行一个服务进程/副本。Docker 使用命名卷 `bot-data`，systemd 默认写 `/opt/wecom-ai-bot/data/bot.sqlite`；运行用户必须有目录写权限。目录保存聊天文本与文件引用，请限制备份权限。

默认保留 30 天未活跃会话及完成/失败消息，定期清理；当天请求额度按 UTC 日期计算。等待处理的任务不按保留期清理。远端方舟文件生命周期由服务端管理，本地 /reset 不会删除远端文件。

**一致性备份（短暂停服）**：

```bash
mkdir -p backups
chmod 700 backups
backup_dir="backups/$(date +%Y%m%d-%H%M%S)"
mkdir "$backup_dir"
sudo docker compose stop
sudo docker compose cp wecom-ai-bot:/app/data/. "$backup_dir/"
sudo docker compose start
```

复制整个数据目录，包含可能存在的 WAL/SHM；不要运行中仅复制主数据库。systemd 同样先 stop，再复制整个 data 目录后 start。备份应存放到服务器以外的位置。

**恢复**：先 stop；保留当前 data 目录副本，在停止状态下用同一次备份的完整文件集合替换卷/目录内容，避免混用旧 WAL；Docker 确保 UID/GID 为 1000:1000（镜像 node 用户），systemd 确保归属 wecomb；启动后检查 healthz 与消息恢复。不要执行 `docker compose down -v`，该命令会删除数据卷。

状态检查可在本机执行 `node scripts/status.ts`（Docker：`docker compose exec wecom-ai-bot node scripts/status.ts`）。只输出任务计数、最老待处理年龄和待同步账号数，不输出密钥或用户消息。`healthz` 只检测 HTTP 进程存活，不代表上游接口可用。

临时发送故障最多重试 MAX_SEND_ATTEMPTS 次；失败任务保留以供排查。修正凭证/网络后，可用 `node scripts/retry-failed.ts <任务ID>` 重新发送失败任务的剩余分片（不重新调用模型）。此操作可能重复投递已经被微信接受、但本地未记录成功的分片。

更新到新数据库版本前先备份。程序拒绝打开高于自身版本的数据库；不要直接用旧镜像覆盖新数据库，需要回滚镜像时使用兼容版本或恢复迁移前备份。
