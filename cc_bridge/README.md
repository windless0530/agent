# cc-bridge

把任意位置运行的 **Claude Code** 的关键消息（人工确认、工具授权等）通过**飞书交互卡片**推送到手机，在飞书里点「允许 / 拒绝」后 Claude Code 继续执行。

```
Claude Code（任意机器）              cc-bridge daemon（一台机器）             飞书
┌────────────────────┐   HTTP    ┌──────────────────────────┐   WS 长连接  ┌─────────────┐
│ PreToolUse hook ────┼─────────>│ 挂起请求 → 发送确认卡片 ────┼────────────>│ ⏳ 交互卡片   │
│ （阻塞等待）         │<─────────│ 等待按钮点击 ←─────────────┼<────────────│ ✅❌ 👍 按钮  │
│                     │  决策JSON │ Notification → 纯通知卡片  │             │             │
└────────────────────┘          └──────────────────────────┘             └─────────────┘
```

**不需要公网 IP**：daemon 通过飞书官方 SDK 的 WebSocket 长连接接收卡片回调。

## 工作原理

1. `cc-bridge install-hooks` 往 Claude Code 的 `settings.json` 写入两类 hook：
   - 确认类 hook：**`PermissionRequest`**（新版 CLI，自动探测；恰好在 Claude Code 要弹权限确认框时触发，已被允许的操作不会重复打扰）或 **`PreToolUse`**（旧版 CLI 回退，每次工具调用都触发）。hook 进程把工具调用详情 POST 给 daemon 并**阻塞等待**；daemon 发一张带「✅ 允许 / 👍 总是允许 / ❌ 拒绝」按钮的卡片到飞书，你点击后决策以 hook JSON 返回，Claude Code 据此放行或拒绝（拒绝原因会告知 Claude，它会调整方案）。
   - `Notification`（可选）：Claude 空闲等待输入等通知，转发为纯通知卡片（注意：`permission_prompt` 类通知要等确认框闲置约 6s 才触发，仅作辅助提醒，不承担审批）。
2. 超时（默认 300s）未响应 → 返回空决策，交互式会话回退为本地正常确认流程（**fail-open**，bridge 挂掉也不影响 Claude Code 使用）。注意：headless 等无法弹框的会话中，Claude Code 对「无决策」本身会拒绝该工具调用——手机审批就是这类会话唯一的人工通道。
3. 「👍 总是允许」：PermissionRequest 模式下，若 Claude Code 随请求附带了 `permission_suggestions`，会原样回传 `updatedPermissions`，**由 Claude Code 原生持久化**（等同你在终端确认框里选「总是允许」）；同时 daemon 内也记住规则（Bash 按首命令、文件工具按目录）作为兜底，daemon 重启即清空。

## 快速开始

### 1. 飞书应用配置

你已创建应用的话核对以下几项即可：

| 配置项 | 位置 | 说明 |
|---|---|---|
| 机器人能力 | 应用能力 → 添加「机器人」 | 发卡片的前提 |
| `im:message:send_as_bot` | 权限管理 | 以应用身份发消息 |
| `im.message.receive_v1` 事件 | 事件与回调 → 事件配置 | 用于「绑定」获取你的 open_id |
| **订阅方式：长连接** | 事件与回调 → 订阅方式 | 选「使用长连接接收」，无需公网地址 |
| 卡片回传交互 | 消息卡片 → 回调配置 → 长连接 | 接收按钮点击（`card.action.trigger`） |
| 发布版本 | 版本管理与发布 | 未发布应用只能在测试企业与对应用户可用 |

> 国际版 Lark 在配置文件里把 `domain` 改为 `lark`。

### 2. 配置并启动 daemon

```bash
cd cc_bridge && npm install
node cli.mjs init          # 生成 ~/.cc-bridge.json
# 填写 appId / appSecret
node cli.mjs serve
```

获取 `peer`（接收人）：在飞书里给机器人发一条「**绑定**」，daemon 会把你的 `open_id`（私聊）和 `chat_id`（群）回复给你，填进配置里的 `peer` 字段后重启 serve。

### 3. 安装 hook 并验证

```bash
node cli.mjs install-hooks           # 写入 ~/.claude/settings.json（全局）
#   自动探测：CLI 支持 PermissionRequest 则用之，否则回退 PreToolUse
#   --event permissionrequest|pretooluse 可手动指定
node cli.mjs test                    # 发送测试卡片到飞书
```

重启 Claude Code 会话即生效。也可以用 `cc-bridge status` / `cc-bridge rules` 查看 daemon 状态和免确认规则。

### 4. 其他机器上的 Claude Code 接入

daemon 机器上把配置 `host` 改为 `0.0.0.0`（并设置 `token`），远程机器执行：

```bash
node cli.mjs install-hooks --url http://<daemon-ip>:3757 --token <token>
```

写入的是 `curl` 形式的 hook 命令，远程机器**不需要**安装 cc_bridge，有 curl 即可。

## 配置参考（~/.cc-bridge.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `appId` / `appSecret` | — | 飞书应用凭据（appId 格式为 `cli_` + 16 位十六进制） |
| `peer` | — | 接收卡片的 `open_id`（ou_）或群 `chat_id`（oc_） |
| `host` / `port` | `127.0.0.1` / `3757` | HTTP 监听；跨机器接入改 `0.0.0.0` |
| `timeoutSec` | `300` | 等待飞书确认的超时，上限 580（hook 侧显式配置 600s，保证 daemon 先超时） |
| `maxPending` | `16` | 同时挂起的确认数上限，超出直接放行走本地流程 |
| `token` | 空 | hook 客户端与 daemon 之间的 Bearer 共享密钥（跨机器必设） |
| `allowedOpenIds` | `[]` | 允许点按钮的飞书用户，空为不限制 |
| `allow` | `[]` | 预置免确认规则，如 `["Bash:git", "Edit:/src", "WebFetch"]` |
| `domain` | `feishu` | `lark` 为国际版 |

环境变量等价覆盖：`CC_BRIDGE_APP_ID` / `CC_BRIDGE_APP_SECRET` / `CC_BRIDGE_PEER` / `CC_BRIDGE_URL` / `CC_BRIDGE_TOKEN` / `CC_BRIDGE_CONFIG`。

## HTTP 接口

| 方法 & 路径 | 说明 |
|---|---|
| `POST /hook/permissionrequest` `POST /hook/pretooluse` | 确认类 hook 的 stdin JSON → 挂起等待决策；响应体即 hook stdout（空 = 无意见），按事件返回对应决策 schema |
| `POST /hook/notification` `POST /hook/stop` | 转通知卡片 |
| `POST /notify` | `{title, body, severity}` 手动推送卡片 |
| `GET /health` | 状态（免鉴权） |
| `GET/DELETE /rules` | 查看 / 清空免确认规则 |

除 `/health` 外，配置了 `token` 时需带 `Authorization: Bearer <token>`。

## 卸载

```bash
node cli.mjs install-hooks --remove   # 从 settings.json 移除 hook（原文件备份为 *.bak-cc-bridge）
# 停掉 daemon 即可，无其他残留
```

## 让 daemon 常驻

临时跑：`nohup node cli.mjs serve >> ~/.cc-bridge.log 2>&1 &`

systemd（推荐）：

```ini
# ~/.config/systemd/user/cc-bridge.service
[Unit]
Description=cc-bridge Feishu confirmation bridge
[Service]
WorkingDirectory=/path/to/cc_bridge
ExecStart=/usr/bin/node /path/to/cc_bridge/cli.mjs serve
Restart=on-failure
[Install]
WantedBy=default.target
```

`systemctl --user enable --now cc-bridge` 后用 `cc-bridge status` 验证。

## 常见问题

- **收不到卡片**：`cc-bridge test` 先排除配置；确认应用已发布、机器人对你可用（搜索机器人名私聊）、`im:message:send_as_bot` 已开通。
- **装了 hook 但完全不触发**：旧版 Claude Code CLI 不支持 `PermissionRequest` 事件时会被静默忽略，用 `cc-bridge install-hooks --event pretooluse` 回退；`claude --version` 与 `/hooks` 菜单可确认。
- **卡片能收到但按钮无反应**：飞书后台「消息卡片 → 回调配置」需为**长连接**模式；daemon 日志会打印 `card.action.trigger`。
- **长连接日志提示 appId 非法**：appId 必须是 `cli_` + 16 位十六进制，检查是否复制完整。
- **想让某类操作不询问**：点卡片上的「👍 总是允许」，或配置 `allow` 数组。
- **hook 触发太频繁**：`install-hooks --matcher 'Bash|Write|Edit'` 自定义工具匹配范围。

## 设计说明

- **fail-open**：daemon 未启动、网络断开、发卡失败、超时，一律返回空决策（exit 0、无 stdout），Claude Code 回退原生确认流程，永远不会因为 bridge 故障卡死。
- **顺序与超时对齐**：hook 配置 `timeout: 600` > daemon `timeoutSec`（≤580），保证先由 daemon 超时返回、Claude Code 不会先杀 hook。
- 决策 schema 按事件区分（均已对照官方 hooks 文档核实）：`PreToolUse` 返回 `hookSpecificOutput.permissionDecision`（allow/deny）；`PermissionRequest` 返回 `hookSpecificOutput.decision.behavior`（allow/deny），`deny` 的原因/消息会反馈给 Claude，「总是允许」通过 `decision.updatedPermissions`（数组）回传原生规则。
- 挂起请求用 HTTP 长轮询实现，hook 进程无需额外状态；同一卡片重复回调按 rid 幂等处理。
