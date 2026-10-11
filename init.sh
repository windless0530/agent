#!/usr/bin/env bash

# cc-bridge 一次性初始化（daemon 机器上跑）：装依赖 → 生成配置 → 装 hook → 发测试卡验证飞书链路
# 配置没填好时会提示填写并退出；填好后重新运行 ./init.sh 完成验证，之后用 ./serve.sh 启动 daemon

set -eu

cd "$(dirname "$0")"

echo "==> npm install（安装 @larksuiteoapi/node-sdk 等依赖）"
npm install

echo "==> init（生成配置模板 ~/.cc-bridge.json，已存在则跳过）"
node cli.mjs init

echo "==> install-hooks（把 cc-bridge hook 写入 ~/.claude/settings.json）"
node cli.mjs install-hooks

echo "==> test（校验配置 + 发送测试卡片到绑定群）"
if ! node cli.mjs test; then
    echo
    echo "配置尚未填好：请编辑 ~/.cc-bridge.json（appId / appSecret / bindings），"
    echo "然后重新运行 ./init.sh 完成验证，再运行 ./serve.sh 启动 daemon。"
    exit 1
fi

echo "==> 初始化完成，运行 ./serve.sh 启动 daemon"
