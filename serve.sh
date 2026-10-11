#!/usr/bin/env bash

set -eu

LOG_FILE="$(cd "$(dirname "$0")" && pwd)/serve.log"
SCRIPT_FILE="$(cd "$(dirname "$0")" && pwd)/cli.mjs"

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

echo "服务已在后台启动"
echo "PID: $pid"
echo "Log: $LOG_FILE"
echo "查看日志: tail -f \"$LOG_FILE\""

