#!/usr/bin/env bash
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$DIR/serve.log"
SCRIPT_FILE="$DIR/cli.mjs"

# ---------- systemd 优先：开机自启 + 崩溃自动拉起（多天无人值守的前提） ----------
# 每次运行都重写 unit（node 路径 / PATH 变化后跑一次 serve.sh 即同步），
# 已在 systemd 下运行则 restart，首次迁移前清掉历史 nohup 进程释放端口。
# 没有 systemd 用户会话（容器等）时回退文末的 nohup 方式。
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-system-running >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT_FILE="$UNIT_DIR/cc-bridge.service"
  NODE_BIN="$(command -v node)"

  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=cc-bridge Feishu confirmation bridge

[Service]
WorkingDirectory=$DIR
ExecStart=$NODE_BIN $SCRIPT_FILE serve
Restart=on-failure
RestartSec=3
# 日志沿用 serve.log（append: 需 systemd >= 240）
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE
# daemon 会按需 spawn herdr / claude，把当前 PATH 带进去（nvm、~/.local/bin 等）
Environment="PATH=$PATH"
Environment="HOME=$HOME"

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable cc-bridge >/dev/null

  if systemctl --user is-active --quiet cc-bridge; then
    systemctl --user restart cc-bridge
  else
    # 首次迁移：停掉 systemd 之外的历史 daemon（nohup 起的），释放端口
    pkill -f "node .*$SCRIPT_FILE serve" 2>/dev/null || true
    sleep 1
    systemctl --user start cc-bridge
  fi

  # linger：SSH 全退出后用户级 systemd 仍在（不开的话最后一个会话一断服务就停）
  if command -v timeout >/dev/null 2>&1; then
    timeout 5 loginctl enable-linger "$USER" 2>/dev/null \
      || echo "⚠ 开启 linger 失败（不影响本次运行）；建议执行: sudo loginctl enable-linger $USER"
  fi

  echo "服务已由 systemd 接管（开机自启 · 崩溃自动拉起）"
  systemctl --user --no-pager -n 3 status cc-bridge || true
  echo "Log: $LOG_FILE"
  echo "查看日志: tail -f \"$LOG_FILE\""
  exit 0
fi

# ---------- 回退：无 systemd 用户会话时，维持 nohup 后台运行 ----------

# 后台运行器：记录启动、退出时间和退出状态
nohup bash -c '
    log_file="$1"
    script_file="$2"

    echo "[$(date "+%Y-%m-%d %H:%M:%S %z")] START: node $script_file serve"
    start_ts=$(date +%s)

    node "$script_file" serve
    rc=$?

    end_ts=$(date +%s)
    duration=$((end_ts - start_ts))

    echo "[$(date "+%Y-%m-%d %H:%M:%S %z")] EXIT: node $script_file serve"
    echo "Exit code: $rc"
    if [ "$rc" -eq 0 ]; then
        echo "Status: NORMAL"
    else
        echo "Status: ABNORMAL"
    fi
    echo "Duration: ${duration}s"
    exit "$rc"
' _ "$LOG_FILE" "$SCRIPT_FILE" >> "$LOG_FILE" 2>&1 < /dev/null &

pid=$!

echo "服务已在后台启动（nohup 回退模式，无常驻保障）"
echo "PID: $pid"
echo "Log: $LOG_FILE"
echo "查看日志: tail -f \"$LOG_FILE\""
