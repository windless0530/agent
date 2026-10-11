# cc-bridge

把任意位置运行的 **Claude Code** 的关键消息（人工确认、工具授权等）通过**飞书交互卡片**推送到手机，在飞书里点「允许 / 拒绝」后 Claude Code 继续执行。也支持**反向驱动**：把「飞书群 ↔ 本地目录」配成一组绑定（`bindings` 配置），绑定群里的消息 = 在该目录的终端 claude cli 里输入，回复直接发回该群；该目录（含子目录）下会话的确认卡也自动路由到对应群——多 repo / 多 worktree 各绑各的群，互不串线。

```
Claude Code（任意机器）              cc-bridge daemon（一台机器）             飞书
┌────────────────────┐   HTTP    ┌──────────────────────────┐   WS 长连接  ┌─────────────┐
│ PreToolUse hook ────┼─────────>│ 挂起请求 → 发送确认卡片 ────┼────────────>│ ⏳ 交互卡片   │
│ （阻塞等待）         │<─────────│ 等待按钮点击 ←─────────────┼<────────────│ ✅❌ 👍 按钮  │
│                     │  决策JSON │ Notification → 纯通知卡片  │             │             │
│ 无头 claude ←────────┼──────────│ 消息 → claude -p --resume ─┼<────────────│ 💬 聊天指令   │
└────────────────────┘          └──────────────────────────┘             └─────────────┘
```

**不需要公网 IP**：daemon 通过飞书官方 SDK 的 WebSocket 长连接接收卡片回调。

## 工作原理

1. `node cli.mjs install-hooks` 往 Claude Code 的 `settings.json` 写入两类 hook：
   - 确认类 hook：**`PermissionRequest`**（新版 CLI，自动探测；恰好在 Claude Code 要弹权限确认框时触发，已被允许的操作不会重复打扰）或 **`PreToolUse`**（旧版 CLI 回退，每次工具调用都触发）。hook 进程把工具调用详情 POST 给 daemon 并**阻塞等待**；daemon 发一张带选项按钮的卡片到飞书，你点击后决策以 hook JSON 返回，Claude Code 据此放行或拒绝（拒绝原因会告知 Claude，它会调整方案）。
   - `Notification`（可选）：Claude 空闲等待输入等通知，转发为纯通知卡片。其中 `permission_prompt` 类通知（确认框闲置 ~6s 才触发）**在该会话已有挂起确认卡或刚被点击解决的 60s 内自动抑制**，避免与交互确认卡重复打扰；仅当 cc-bridge 未接管审批（发卡失败/并发超限回退本地确认）时才转发，作为手机端唯一提醒。`idle_prompt`（"Claude is waiting for your input"）**在该会话发过「🏁 已完成」输出卡的 10 分钟内同样抑制**（输出卡已带最终回复）。
2. 超时（默认 300s）未响应 → 返回空决策，交互式会话回退为本地正常确认流程（**fail-open**，bridge 挂掉也不影响 Claude Code 使用）。注意：headless 等无法弹框的会话中，Claude Code 对「无决策」本身会拒绝该工具调用——手机审批就是这类会话唯一的人工通道。
3. **终端本地作答联动**：Claude Code 不会因为你在终端本地回答了确认框而通知任何 hook（hook 进程与飞书卡片都会继续挂着），daemon 靠 `install-hooks` 一并安装的 `PostToolUse` / `Stop` 两个事件感知本地作答：同会话同工具同参数的工具确实执行了（PostToolUse，键序无关严格匹配，防并行同工具任务误伤）→ 卡片刷成「🖥️ 已在终端允许」；回合结束（Stop）→ 该会话剩余挂起卡片一律刷成「🖥️ 已在终端处理」（本地拒绝 / Esc 取消的兜底）。结算同时向仍挂起的 hook 连接回空体释放进程，卡片按钮随之失效。`Stop` 还会推「🏁 已完成，等待输入」卡片，**内容即该回合的最终输出**（读 `transcript_path` 里最后一条 assistant 文本——飞书群里的最后一张卡不再是 "waiting for your input" 空话；远程机器路径读不到时退化为通用文案，`notifyStop: false` 关闭）。消息驱动会话的 Stop 不推（回复卡片已带结果）。
4. **选项与终端确认框一一对应**：Claude Code 在 `permission_suggestions` 里给出确认框的选项建议，卡片按 cli.js 同款模板渲染为编号按钮（`1. Yes` / `2. Yes, and don't ask again for: <命令>` / …，个数与文案与终端一致）。飞书按钮无对齐属性、按渲染像素折行且居中（折行会把首行「Yes」顶偏），文本硬上限 100 字符，因此按钮文案按单行预算（Mac 端估 ~72-78 字符，取 70）**词边界截断加 `…`**；放不下的完整详情左对齐补在按钮上方的正文里，编号与按钮对应。点建议行 = 全部建议原样回传 `updatedPermissions`，**由 Claude Code 原生持久化**；点 auto 行 = 回传 `setMode{auto, session}` 切换会话权限模式。终端上「switch to auto mode」选项本身不带建议条目（UI 自加），卡片据 `permission_mode`（default/acceptEdits 时提供）复原该选项。
   无 `permission_suggestions` 的确认框（如文件编辑类，不读该数组）或旧 CLI 回退为固定三键「✅ 允许 / 👍 总是允许（cc-bridge 内部规则，Bash 按首命令、文件工具按目录，daemon 重启清空）/ ❌ 拒绝」。
5. **消息驱动 Claude Code**（`chatEnabled`，默认开）：在配置文件 `bindings` 里声明「群 ↔ 目录」绑定后，**绑定群里的文本消息免 @ 自动执行**，等价于在绑定目录的终端 `claude` cli 里输入（单聊不驱动执行）。daemon 收到消息后立刻回一张「🚀 处理中」回执卡，用 `claude -p --output-format json [--resume <sid>]` 无头执行（每个群保留各自上下文），跑完把回执卡更新为回复内容（含耗时/轮数/费用）。同一群串行执行（排队时回执显示「已排队」）。执行过程中的权限确认走上面的交互卡片，并按 `cwd` 路由回**该群**。发「**新会话**」（或 `/new`）丢弃上下文重来；未绑定的群 @机器人 会回复配置提示。这些消息驱动的会话不再收「任务完成」重复通知。

## 快速开始

三个脚本各管一段，按「这台机器扮演什么角色」选用：

| 脚本 | 在哪台机器跑 | 什么时候用 |
|---|---|---|
| `./init.sh` | **daemon 机器**（唯一） | 首次部署：装依赖 → 生成 `~/.cc-bridge.json` 配置模板 → 装 hook → 发测试卡验证飞书链路。配置没填好会提示并退出，填好后**重跑一次**完成验证 |
| `./serve.sh` | **daemon 机器**（唯一） | 启动 / 重启 daemon（nohup 后台运行，日志 `serve.log`）。修改配置文件后也要重跑使其生效 |
| `./connect.sh <url> [token]` | **其他接入机器** | 把本机 Claude Code 的 hook 指向远端 daemon（写入 curl 形式命令）。本机无常驻进程、无需 npm install，也**不生成**飞书配置——与 daemon 机器的 `init.sh` 是两条完全不同的初始化路径，client 机器不要跑 init.sh |

> ⚠️ **整个应用只能有一个 daemon 进程在跑**：飞书长连接对同一应用是负载均衡而非广播，多个 serve 并存时会互相抢事件（点击时丢时灵）。多机器场景一律「单 daemon + 其余机器 connect.sh 接入」，不要多处 serve 同一个 appId。

### 1. 飞书应用配置

你已创建应用的话核对以下几项即可：

| 配置项 | 位置 | 说明 |
|---|---|---|
| 机器人能力 | 应用能力 → 添加「机器人」 | 发卡片的前提 |
| `im:message:send_as_bot` | 权限管理 | 以应用身份发消息 |
| `im.message.receive_v1` 事件 | 事件与回调 → 事件配置 | 接收消息（「绑定」引导 + 消息驱动指令） |
| 「获取群组中所有消息」（`im:message.group_msg`） | 权限管理 | **绑定群免 @ 自动执行必须**；只开「获取群组中@机器人消息」（`im:message.group_at_msg`）则绑定群也须 @机器人 |
| **订阅方式：长连接** | 事件与回调 → 订阅方式 | 选「使用长连接接收」，无需公网地址 |
| 卡片回传交互 | 消息卡片 → 回调配置 → 长连接 | 接收按钮点击（`card.action.trigger`） |
| 发布版本 | 版本管理与发布 | 未发布应用只能在测试企业与对应用户可用 |

> 国际版 Lark 在配置文件里把 `domain` 改为 `lark`。

### 2. daemon 机器：./init.sh + ./serve.sh

```bash
./init.sh     # npm install → 生成 ~/.cc-bridge.json 模板 → 装 hook → 发测试卡
```

首次运行会在配置未填好时停下：按提示填写 `appId` / `appSecret`，并在 `bindings` 里加一组「群 ↔ 目录」：

```json
"bindings": [ { "chatId": "oc_xxx", "cwd": "/root/workspace/myrepo" } ]
```

填好后**重跑 `./init.sh`** 完成测试卡验证，然后启动：

```bash
./serve.sh    # 后台启动 daemon（日志 serve.log；改配置后重跑使其生效）
```

获取群的 `chat_id`：先把机器人拉进群，在群里发一条「**绑定**」，daemon 会把本群 `chat_id`（和你的 `open_id`）回复给你，填进 `bindings` 后重启 serve。**没有兜底接收方**：未命中任何绑定目录的会话不发卡、不关联（确认请求直接 fail-open 回 Claude Code 本地确认）。每条 binding 必须同时配置 `chatId`（`oc_` 开头）和 `cwd`（绝对路径），配错配漏会在 serve/test 启动时报错退出。

`init.sh` 内部即 `npm install` + `install-hooks` + `test`，无需单独执行；要自定义时才手动跑 `node cli.mjs install-hooks --matcher 'Bash|Write|Edit'`（自动探测：CLI 支持 PermissionRequest 则用之，否则回退 PreToolUse；PostToolUse / Stop / Notification 一并安装，用于本地作答联动与通知转发）。装完 hook 重启 Claude Code 会话即生效；日常用 `node cli.mjs status` / `rules` 查看 daemon 状态和免确认规则。

### 3. 其他机器接入：./connect.sh

daemon 机器把配置 `host` 改为 `0.0.0.0`（并设置 `token`）后 `./serve.sh` 重启，接入机器在仓库副本里执行：

```bash
./connect.sh http://<daemon-ip>:3757 <token>
```

脚本会先检查 curl 存在与 daemon 可达性（不可达会给出排查提示），再写入 **curl 形式**的 hook 命令——本机无常驻进程、无需 npm install（只要 node 跑这一次接入命令 + curl 作为 hook 运行形态），也不生成任何飞书配置。接入后重启本机 Claude Code 会话生效。

远程机器 workspace 的确认卡要路由到**指定群**：在 daemon 的 `bindings` 里加上该机器的目录即可，如 `{ "chatId": "oc_..", "cwd": "/home/user/repo" }`——目录在 daemon 本机不存在也没关系，会作为**「仅路由」绑定**（确认卡照常按 cwd 前缀路由到该群；群消息不驱动执行，@机器人 会回复接入提示）。多台机器各绑各的群，互不串线。

## 配置参考（~/.cc-bridge.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `appId` / `appSecret` | — | 飞书应用凭据（appId 格式为 `cli_` + 16 位十六进制） |
| `bindings` | `[]` | **「群 ↔ 目录」绑定列表**：`[{ "chatId": "oc_..", "cwd": "/repo/path", "name": "可选备注" }]`。绑定群消息免 @ 自动在该目录执行 claude；该目录（含子目录）下会话的确认/通知卡也路由到该群（多绑定目录重叠时最长前缀优先）。**每条必须同时配置 `chatId`（`oc_` 开头）与 `cwd`（绝对路径），配错配漏 serve 启动直接报错**。cwd 不在 daemon 本机时自动成为「仅路由」绑定：卡片照常路由，消息不驱动执行（用于远程机器 workspace）。无兜底接收方：未命中任何绑定的目录不发卡 |
| `host` / `port` | `127.0.0.1` / `3757` | HTTP 监听；跨机器接入改 `0.0.0.0` |
| `timeoutSec` | `300` | 等待飞书确认的超时，上限 580（hook 侧显式配置 600s，保证 daemon 先超时） |
| `maxPending` | `16` | 同时挂起的确认数上限，超出直接放行走本地流程 |
| `token` | 空 | hook 客户端与 daemon 之间的 Bearer 共享密钥（跨机器必设） |
| `allowedOpenIds` | `[]` | 允许点按钮/发指令的飞书用户，空为不限制（**开启消息驱动建议配置**，否则绑定群里的任何人都能在你机器上跑 claude） |
| `allow` | `[]` | 预置免确认规则，如 `["Bash:git", "Edit:/src", "WebFetch"]` |
| `notifyStop` | `true` | Stop 事件推「🏁 已完成」卡，内容为该回合最终输出（读 transcript 最后一条 assistant 文本，读不到退化为通用文案）；发出后 10 分钟内抑制该会话的 idle_prompt 空闲提醒 |
| `domain` | `feishu` | `lark` 为国际版 |
| `wsPingTimeoutSec` | `120` | 飞书长连接看门狗（秒）：ping 后该窗口内收不到任何入站帧即判定连接死亡并主动重连。半开连接不报 socket 错误，关掉它会出现「卡片照发、点击全丢」的假活状态 |
| `chatEnabled` | `true` | 飞书消息驱动 Claude Code（按 `bindings` 绑定的群触发） |
| `chatBin` | `claude` | claude 可执行文件 |
| `chatModel` | 空 | 额外传给 claude 的 `--model`，空 = 用 claude 默认 |
| `chatTimeoutSec` | `1800` | 单条消息的 claude 执行超时 |

环境变量等价覆盖：`CC_BRIDGE_APP_ID` / `CC_BRIDGE_APP_SECRET` / `CC_BRIDGE_URL` / `CC_BRIDGE_TOKEN` / `CC_BRIDGE_CONFIG`。

## HTTP 接口

| 方法 & 路径 | 说明 |
|---|---|
| `POST /hook/permissionrequest` `POST /hook/pretooluse` | 确认类 hook 的 stdin JSON → 挂起等待决策；响应体即 hook stdout（空 = 无意见），按事件返回对应决策 schema |
| `POST /hook/posttooluse` | 工具已执行 → 严格匹配（会话+工具+参数）结算对应挂起确认，卡片刷为「已在终端允许」；本身不挂起、不发卡 |
| `POST /hook/notification` | 转通知卡片 |
| `POST /hook/stop` | 回合结束 → 该会话挂起确认结算为「已在终端处理」；另推「🏁 已完成」输出卡（内容 = 该回合最终输出，`notifyStop: false` 关闭） |
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

日常方式就是 `./serve.sh`（nohup 后台运行，日志 `serve.log`，重启 daemon 同样跑它）。

systemd（开机自启、崩溃自动拉起）：

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

`systemctl --user enable --now cc-bridge` 后用 `node cli.mjs status` 验证。

## 常见问题

- **收不到卡片**：`node cli.mjs test` 先排除配置；确认应用已发布、机器人对你可用（搜索机器人名私聊）、`im:message:send_as_bot` 已开通。
- **装了 hook 但完全不触发**：旧版 Claude Code CLI 不支持 `PermissionRequest` 事件时会被静默忽略，用 `node cli.mjs install-hooks --event pretooluse` 回退；`claude --version` 与 `/hooks` 菜单可确认。
- **卡片能收到但按钮无反应**：飞书后台「消息卡片 → 回调配置」需为**长连接**模式；daemon 日志会打印 `card.action.trigger`。
- **长连接日志提示 appId 非法**：appId 必须是 `cli_` + 16 位十六进制，检查是否复制完整。
- **想让某类操作不询问**：点卡片上的「don't ask again」选项（原生持久化），或配置 `allow` 数组。
- **hook 触发太频繁**：`install-hooks --matcher 'Bash|Write|Edit'` 自定义工具匹配范围。
- **绑定群里发消息没反应**：先确认群在 `bindings` 里且已重启 serve（`node cli.mjs status` 可看绑定数）；再检查应用权限——没有「获取群组中所有消息」（`im:message.group_msg`）权限时飞书不会把未 @ 的群消息推给应用，此时群里须 @机器人 触发（开「获取群组中@机器人消息」`im:message.group_at_msg` 即可）；单聊不驱动执行（绑定以群为单位）。
- **消息驱动在哪台机器/目录跑**：在 daemon 所在机器、该群 `bindings` 里绑定的 `cwd` 下执行，和终端里在该目录开 claude 一致；权限确认照常弹卡片，且路由回该群。

## 设计说明

- **fail-open**：daemon 未启动、网络断开、发卡失败、超时，一律返回空决策（exit 0、无 stdout），Claude Code 回退原生确认流程，永远不会因为 bridge 故障卡死。
- **本地作答感知**：Claude Code 的 hook 体系没有「确认框已被本地回答」的事件，也不会杀掉仍在阻塞的 hook 进程，因此用 `PostToolUse`（工具确实执行 = 本地允许）与 `Stop`（回合结束 = 兜底）推断；卡片状态翻转走飞书官方「更新已发送的消息卡片」接口（`PATCH /im/v1/messages/:message_id`，前后卡片均声明 `update_multi: true`）。
- **回合输出卡**：Stop payload 自带 `transcript_path`（会话 JSONL），从后向前取最后一条 assistant 文本即为该回合最终输出；读不到（远程机器的本地路径）时退化为通用文案。
- **顺序与超时对齐**：hook 配置 `timeout: 600` > daemon `timeoutSec`（≤580），保证先由 daemon 超时返回、Claude Code 不会先杀 hook。
- 决策 schema 按事件区分（均已对照官方 hooks 文档核实）：`PreToolUse` 返回 `hookSpecificOutput.permissionDecision`（allow/deny）；`PermissionRequest` 返回 `hookSpecificOutput.decision.behavior`（allow/deny），`deny` 的原因/消息会反馈给 Claude，建议行/auto 行通过 `decision.updatedPermissions`（数组）回传原生权限更新（addRules / setMode 等，字段见 hooks 文档「Permission update entries」）。
- 挂起请求用 HTTP 长轮询实现，hook 进程无需额外状态；同一卡片重复回调按 rid 幂等处理。
