#!/usr/bin/env bash

# cc-bridge 远程机器接入：把本机 Claude Code 的 hook 指向另一台机器上已运行的 daemon
# 用法: ./connect.sh http://<daemon-ip>:3757 [token]
#   （前提：daemon 机器已按 README 完成 ./init.sh + ./serve.sh，host 配为 0.0.0.0 并设了 token）
# 本机要求：node（仅跑一次接入命令，无需 npm install）+ curl（hook 的运行形态）

set -eu

cd "$(dirname "$0")"

URL="${1:-}"
TOKEN="${2:-}"

if [ -z "$URL" ]; then
    echo "用法: ./connect.sh http://<daemon-ip>:3757 [token]"
    echo "daemon 机器需先把 ~/.cc-bridge.json 的 host 改为 0.0.0.0（跨机器建议设置 token）并重启"
    exit 1
fi

command -v curl >/dev/null 2>&1 || {
    echo "错误: 未找到 curl（hook 以 curl 形式写入，本机必须有 curl）"
    exit 1
}

echo "==> 检查 daemon 可达性: $URL"
if ! curl -s -m 5 "$URL/health" >/dev/null; then
    echo "错误: daemon 不可达（$URL/health）。请确认："
    echo "  - daemon 机器已运行 ./serve.sh"
    echo "  - ~/.cc-bridge.json 的 host 为 0.0.0.0（默认 127.0.0.1 只监听本机）"
    echo "  - 网络 / 防火墙放通该端口"
    exit 1
fi

echo "==> install-hooks（写入 curl 形式 hook，本机无需常驻任何进程）"
# shellcheck disable=SC2086
node cli.mjs install-hooks --url "$URL" ${TOKEN:+--token "$TOKEN"}

cat <<'EOF'

==> 接入完成。别忘了：
  1. 重启本机的 Claude Code 会话后生效
  2. 在 daemon 机器的 ~/.cc-bridge.json bindings 里加上本机 workspace 目录
     （如 { "chatId": "oc_..", "cwd": "/home/user/repo" }），本机确认卡才会路由到群
EOF
