#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR"

usage() {
  printf '%s\n' '用法: ./start.sh [local|docker|check]' \
    '  local   前台启动（默认），需要 Node >= 24 和 npm' \
    '  docker  构建并后台启动应用容器，需要 Docker Compose' \
    '  check   检查 .env 配置，不连接数据库（需要 Node 和 npm）' \
    '只启动机器人，PostgreSQL 由你自行部署；配置见 .env 和 START.md。'
}

MODE=${1:-local}
case "$MODE" in
  -h|--help) usage; exit 0 ;;
  local|docker|check) ;;
  *) usage; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then usage; exit 2; fi

if [ ! -f .env ]; then
  umask 077
  cp .env.example .env
  printf '%s\n' '已生成 .env。请先填写数据库、企业微信及模型配置，然后重新运行本命令。'
  exit 2
fi

if [ "$MODE" = docker ]; then
  command -v docker >/dev/null 2>&1 || { printf '%s\n' '请先安装 Docker 和 Docker Compose。' >&2; exit 1; }
  docker compose version >/dev/null
  docker compose build
  docker compose run --rm --no-deps wecom-ai-bot node scripts/check-config.ts
  docker compose up -d
  printf '%s\n' '应用已后台启动。查看日志: docker compose logs --tail=100 -f wecom-ai-bot' \
    '查看健康状态: curl http://127.0.0.1:8788/healthz' \
    '停止应用: docker compose stop wecom-ai-bot'
  exit 0
fi

command -v node >/dev/null 2>&1 || { printf '%s\n' '请先安装 Node.js 24 或更高版本。' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf '%s\n' '请先安装 npm。' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("需要 Node.js >= 24"); process.exit(1); }'
if ! npm ls --omit=dev --depth=0 >/dev/null 2>&1; then
  printf '%s\n' '安装项目生产依赖…'
  npm ci --omit=dev
fi
node scripts/check-config.ts
if [ "$MODE" = check ]; then exit 0; fi
printf '%s\n' '正在启动机器人，按 Ctrl+C 停止。'
exec node server.ts
