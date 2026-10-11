#!/usr/bin/env bash

# cc-bridge 一次性初始化：装依赖 → 装 hook → 发测试卡验证飞书链路
# 用法: ./init.sh （之后用 ./serve.sh 启动 daemon）

set -eu

cd "$(dirname "$0")"

echo "==> npm install（安装 @larksuiteoapi/node-sdk 等依赖）"
npm install

echo "==> install-hooks（把 cc-bridge hook 写入 ~/.claude/settings.json）"
node cli.mjs install-hooks

echo "==> test（发送测试卡片到飞书）"
node cli.mjs test

echo "==> 初始化完成，运行 ./serve.sh 启动 daemon"
