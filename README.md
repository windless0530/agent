# cc-bridge

把任意位置运行的 **Claude Code** 的关键消息（人工确认、工具授权、**选择题提问、计划审批**等）通过**飞书交互卡片**推送到手机，在飞书里点「允许 / 拒绝 / 选 2 / 批准」后 Claude Code 继续执行。也支持**反向驱动**：把「飞书群 ↔ 本地目录」配成一组绑定（`bindings` 配置），绑定群里的消息 = 在该目录的终端 claude cli 里输入，回复直接发回该群；该目录（含子目录）下会话的确认卡也自动路由到对应群——多 repo / 多 worktree 各绑各的群，互不串线。

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
   - 确认类 hook：**`PermissionRequest`**（新版 CLI，自动探测；恰好在 Claude Code 要弹权限确认框时触发，已被允许的操作不会重复打扰）或 **`PreToolUse`**（旧版 CLI 回退，每次工具调用都触发）。hook 进程把工具调用详情 POST 给 daemon，按会话能否读到终端分两种模式：
     - **代答模式**（会话在 herdr 管的终端 pane 里，本机交互会话的常态）：daemon 发卡后 **hook 立即放行**，Claude Code 停在本地确认框上无限期等；卡片**没有超时寿命**，点按钮时 daemon 读屏校验确认框还在、选项与卡片一致，再按选项映射发方向键 / `Enter`（拒绝发 `Esc`）代答，并复验框已消失。手机隔一天回来点也有效。本地终端先答的话，卡片由 PostToolUse / Stop / 新确认到达时的读屏清扫自动翻灰。
     - **长轮询模式**（无头 / 远程接入机器，pane 读不到）：hook 阻塞等待，你点卡片后决策以 hook JSON 返回，Claude Code 据此放行或拒绝（拒绝原因会告知 Claude，它会调整方案）。受 `timeoutSec` 约束。
   - `Notification`（可选）：Claude 空闲等待输入等通知，转发为纯通知卡片。其中 `permission_prompt` 类通知（确认框闲置 ~6s 才触发）**在该会话已有挂起确认卡或刚被点击解决的 60s 内自动抑制**，避免与交互确认卡重复打扰；仅当 cc-bridge 未接管审批（发卡失败/并发超限回退本地确认）时才转发，作为手机端唯一提醒。`idle_prompt`（"Claude is waiting for your input"）**在该会话发过回合结果卡/「回合已结束」收尾卡或还挂着提问/审批卡的 10 分钟内同样抑制**（卡片已带最终回复、回合结束状态或待答问题）。
   - **选择题 hook**（`AskUserQuestion|ExitPlanMode`，随 install-hooks 一并安装同事件的 PreToolUse/PostToolUse 两条）：这两类工具在终端渲染「编号选择题」对话框（规划模式提问、计划审批 `Would you like to proceed?`），**不触发 PermissionRequest、也没有阻塞语义**——PreToolUse 仅当触发器（hook 立即空体放行），daemon 起观察器读屏轮询（600ms 起，之后 1500ms，无框 10 拍后放慢到 4s，上限 `questionWatchSec`；到点只停轮询，已发卡片仍可点）逐题发**「❓ 提问卡 / 📋 计划待审批」**：问题、选项（label/描述用 hook payload 的干净文本配对补全，剥掉终端追加的 "Type something" / "Chat about this" 元选项行）、多选题勾选（Space）+「确认提交」、审批卡三键（批准 auto / 批准手动 / 不批）。点卡走与权限代答相同的「读屏验框 → 方向键（含 Up）/Enter/Space/Esc」路径，选项行号按屏幕实况算。多问题的「Review your answers」复审框在**答案全部经卡片代答**时自动提交（纯确认不打扰）；终端答的则照常发卡。PostToolUse 携带 `Your questions have been answered: "Q"="A"` / `User has approved your plan` 把剩余卡片收尾翻「🖥️ 已作答」并带答案。这些卡片同样无寿命、无 timeoutSec 约束（hook 从不阻塞）。
2. 超时只作用于**长轮询模式**（默认 300s，可配 `timeoutSec`，上限 580）：到点返回空决策，交互式会话回退为本地正常确认流程（**fail-open**，bridge 挂掉也不影响 Claude Code 使用）；无头等无法弹框的会话中，Claude Code 对「无决策」本身会拒绝该工具调用——手机审批就是这类会话唯一的人工通道。上限的根源是 Claude Code 对 hook 运行时长有 **600s 硬上限**：到点 hook 进程被杀，远程从此无法代答——这正是代答模式让 hook 立即放行的原因。
3. **终端本地作答联动**：Claude Code 不会因为你在终端本地回答了确认框而通知任何 hook（hook 进程与飞书卡片都会继续挂着），daemon 靠 `install-hooks` 一并安装的 `PostToolUse` / `Stop` 两个事件感知本地作答：同会话同工具同参数的工具确实执行了（PostToolUse，键序无关严格匹配，防并行同工具任务误伤）→ 卡片刷成「🖥️ 已在终端允许」；回合结束（Stop）→ 该会话剩余挂起卡片一律刷成「🖥️ 已在终端处理」（本地拒绝 / Esc 取消的兜底）。结算同时向仍挂起的 hook 连接回空体释放进程，卡片按钮随之失效。`Stop` 还会**另发**「🏁 已完成 · 指令原文」结果卡（受理不占卡片，见第 5/6 条的 Get 表态），**内容即该回合的最终输出**（读 `transcript_path` 里本回合最后一条 assistant 文本，回溯到本回合发起消息为止；`stop_reason=tool_use` 结尾的消息（steering 插话的回应等）回合还在继续、只是中间输出，跳过不认——只认回合收尾（`end_turn` 等）的文本，飞书群里的最后一张卡不再是 "waiting for your input" 空话），优先串在该回合的来源消息下（终端镜像 / 群注入），没有来源则独立发。**只在读得到 transcript 且取得到本回合最终文本时才发**：读不到（远程机器路径 / 末行尚未落盘——Stop hook 可能抢在末条写盘前触发，隔 300/800ms 重读仍失败）时，有来源消息则发灰色「◌ 回合已结束」收尾卡（不冒充已完成），无来源不发任何卡；`notifyStop: false` 全关。消息驱动会话的 Stop 不推（回复卡片已带结果）。
4. **选项与终端确认框一一对应**：Claude Code 在 `permission_suggestions` 里给出确认框的选项建议，卡片按 cli.js 同款模板渲染为编号按钮（`1. Yes` / `2. Yes, and don't ask again for: <命令>` / …，个数与文案与终端一致）。飞书按钮无对齐属性、按渲染像素折行且居中（折行会把首行「Yes」顶偏），文本硬上限 100 字符，因此按钮文案按单行预算（Mac 端估 ~72-78 字符，取 70）**词边界截断加 `…`**；放不下的完整详情左对齐补在按钮上方的正文里，编号与按钮对应。点建议行 = 全部建议原样回传 `updatedPermissions`，**由 Claude Code 原生持久化**；点 auto 行 = 回传 `setMode{auto, session}` 切换会话权限模式。终端上「switch to auto mode」选项是否出现由 CLI 运行时状态决定（账号级 gate 快照、当前模式——manual 模式不提供、熔断器），hook payload 里没有这些状态——cc-bridge 不猜：**hook 阻塞期间确认框正渲染在终端上，daemon 经 herdr 读 pane 文本取 ground truth**（`herdr agent read --source visible`，解析见 `src/dialog.mjs`），终端有这行卡片才出。会话不在 herdr pane 里（远程机器 / 普通终端）读不到时按「无」处理。
   无 `permission_suggestions` 的确认框（如文件编辑类，不读该数组）或旧 CLI 回退为固定三键「✅ 允许 / 👍 总是允许（cc-bridge 内部规则，Bash 按首命令、文件工具按目录，daemon 重启清空）/ ❌ 拒绝」。
5. **消息驱动 Claude Code**（`chatEnabled`，默认开）：在配置文件 `bindings` 里声明「群 ↔ 目录」绑定后，**绑定群里的文本消息免 @ 自动执行**，等价于在绑定目录的终端 `claude` cli 里输入（单聊不驱动执行）。按目录下是否已有运行中的会话分两种方式：
   - **注入优先**（`chatInject`，默认开）：目录下有 herdr 管理的 claude 会话时，消息经 `herdr agent prompt` **回合级注入该会话**——群与终端共享同一条会话线（就是你终端里正在看的那个）。会话 **busy 中注入的消息默认立即执行**：daemon 自动补一发 `ctrl+enter` 把排队中的消息顶出去（打断式 steering——进行中的工具正常跑完、上下文保留，新指令即刻生效，手机端即发即动）；消息以 **`排队 `** 开头则改为不打断，排队等当前回合结束自动执行；blocked（卡在确认框）拒绝注入并提示——确认卡还挂着时指引去点卡，已超时翻灰（hook 已被 Claude Code 收走、只剩终端本地确认框）则如实提示远程无法代答、需回终端处理。**受理 = 给你的消息加一个 "GET" 表情回复**（不再另发「已开始」卡片），完成后**另发一张**统一结果卡「🏁 已完成 · 指令原文」串在同一来源下（正文为该回合最终输出；Stop 读不到最终文本时发灰色「◌ 回合已结束」收尾卡）。多会话寻址：`/sessions` 列出目录下会话（状态 ◐ 执行中 / ⛔ 等确认 / ○ 空闲，含 💤 已退出的 pane）、`#3 内容` 定向注入 3 号、`/attach 3` 固定默认目标、`/detach` 解除固定（默认注入最近活跃的）。**`/restart` 从手机拉起死掉的会话**：pane 里的 claude 退出后（手动 /exit、崩溃）pane 会留在原地，`/restart` 在绑定目录下找到这类 pane 并用 `herdr agent start` 重新拉起交互式 claude——默认 `--continue` 恢复**该目录最近一条**会话（同目录多会话时可能不是死掉的那条），`/restart new` 全新会话，多个候选时按提示 `/restart <paneId>` 指定；herdr 自带「pane 必须在 shell 提示符」校验，不会把命令敲进运行中的程序，卡在信任目录等确认界面时如实回报。
   - **无头回退**：目录下没有 herdr 会话才另起 `claude -p --output-format json [--resume <sid>]` 无头执行（每个群保留各自上下文），受理同为 GET 表态，跑完**另发**同一款统一结果卡（附耗时/轮数/费用，串在你的消息下），同群串行排队。
   执行过程中的权限确认走上面的交互卡片，并按 `cwd` 路由回**该群**。发「**新会话**」（或 `/new`）丢弃无头会话线与注入目标固定（注入模式不新开会话，重启请在终端操作）；未绑定的群 @机器人 会回复配置提示。这些消息驱动的会话不再收「任务完成」重复通知。
6. **终端输入镜像**（`mirrorPrompt`，默认开）：`UserPromptSubmit` hook 把你在终端提交的 prompt 镜像到绑定目录对应的群，并优先**以用户本人身份发文本消息**（`user_access_token`，群里显示为你自己发的，见下方 OAuth 授权），紧随其后给该消息加一个 "GET" 表情回复作为受理表态；无凭据/刷新失败/发送失败自动降级为 bot 卡（GET 表态加在卡上，标题带 herdr 会话主题或 session_id 前 8 位）。该会话回合结束时**另发**统一结果卡「🏁 已完成 · 指令原文」串在来源消息下（排队连发多条 prompt 时按提交顺序逐条配对；Stop 读不到本回合最终文本时收尾为灰色「◌ 回合已结束」收尾卡）。仅同步展示、不影响本地执行；镜像 hook 立即放行（10s 兜底），daemon 不可达也不拖住终端；消息驱动的会话不镜像（输入本就来自群里）。

### 镜像为「用户本人」消息（OAuth 授权）

bot 发的消息永远显示 bot 身份；要在群里显示为**你自己发的**，需授权一次 user_access_token：

1. 飞书开发者后台 → 本应用 → **权限管理**：开通 `im:message` 与 `im:message.send_as_user`，**发布新版本**生效
2. **安全设置 → 重定向 URL**：添加 `http://localhost:9999/callback`（默认回调地址，可用 `authRedirectUri` 覆盖；本地 daemon 无公网回调，授权后从浏览器地址栏复制 `code` 即可）
3. `node cli.mjs auth-url` → 在已登录飞书的浏览器打开 → 同意授权
4. 跳转后从地址栏复制 `code` 参数（5 分钟内有效）→ `node cli.mjs auth <code>`，凭据落盘 `~/.cc-bridge-auth.json`（chmod 600），daemon 无需重启即生效
5. `node cli.mjs auth-status` 随时查看有效期

token 自动刷新（`offline_access` scope 换取 refresh_token，单次有效、刷新即轮换、原子落盘；单飞防并发重复刷新）。飞书限制：用户授权 **365 天后必须重新授权**；refresh_token 过期/凭据属白名单外用户时镜像自动降级 bot 卡，不影响其他功能。

## 快速开始

三个脚本各管一段，按「这台机器扮演什么角色」选用：

| 脚本 | 在哪台机器跑 | 什么时候用 |
|---|---|---|
| `./init.sh` | **daemon 机器**（唯一） | 首次部署：装依赖 → 生成 `~/.cc-bridge.json` 配置模板 → 装 hook → 发测试卡验证飞书链路。配置没填好会提示并退出，填好后**重跑一次**完成验证 |
| `./serve.sh` | **daemon 机器**（唯一） | 启动 / 重启 daemon：有 systemd 时自动接管（写入用户级 unit、开机自启、崩溃自动拉起，日志仍写 `serve.log`），无 systemd（容器等）回退 nohup。修改配置文件后也要重跑使其生效 |
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

`init.sh` 内部即 `npm install` + `install-hooks` + `test`，无需单独执行；要自定义时才手动跑 `node cli.mjs install-hooks --matcher 'Bash|Write|Edit'`（自动探测：CLI 支持 PermissionRequest 则用之，否则回退 PreToolUse；另装 `AskUserQuestion|ExitPlanMode` 的 PreToolUse/PostToolUse：计划提问与计划审批也镜像为可点按的「提问/审批卡」，点卡远程代答；PostToolUse / Stop / Notification 一并安装，用于本地作答联动与通知转发；同一事件多条 matcher 并存，重装幂等替换）。装完 hook 重启 Claude Code 会话即生效；日常用 `node cli.mjs status` / `rules` 查看 daemon 状态和免确认规则。

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
| `timeoutSec` | `300` | **长轮询模式**等待飞书确认的超时（无头 / 远程机器会话），上限 580。herdr pane 会话走代答模式，不受此限（卡片无寿命）。为什么长轮询有上限：Claude Code 对 hook 有 600s 硬上限（hook 侧已显式配 600s，保证 daemon 先超时优雅返回），到点 hook 被杀后仅剩终端本地确认框 |
| `questionWatchSec` | `1800` | 提问/审批卡观察器（AskUserQuestion/ExitPlanMode）读屏轮询时长上限；到点只停轮询，已发卡片仍可点按（点按时重新读屏校验） |
| `maxPending` | `16` | 同时挂起的确认数上限，超出直接放行走本地流程 |
| `token` | 空 | hook 客户端与 daemon 之间的 Bearer 共享密钥（跨机器必设） |
| `allowedOpenIds` | `[]` | 允许点按钮/发指令的飞书用户，空为不限制（**开启消息驱动建议配置**，否则绑定群里的任何人都能在你机器上跑 claude） |
| `allow` | `[]` | 预置免确认规则，如 `["Bash:git", "Edit:/src", "WebFetch"]` |
| `notifyStop` | `true` | Stop 事件**另发**「🏁 已完成」新卡（受理是来源消息上的 GET 表态，不占卡片），内容为该回合最终输出（读 transcript 本回合最后一条 assistant 文本）；**读不到本回合最终文本时**：有来源消息（镜像/注入）发灰色「◌ 回合已结束」收尾卡，否则不发卡；发卡后 10 分钟内抑制该会话的 idle_prompt 空闲提醒 |
| `mirrorPrompt` | `true` | 把终端提交的 prompt 镜像到绑定群（详见工作原理第 6 条），不影响本地执行 |
| `mirrorAsUser` | `true` | 镜像优先以用户本人身份发文本（user_access_token）；无凭据/失败降级 bot 卡。授权见「镜像为用户本人消息」小节 |
| `authFile` | `~/.cc-bridge-auth.json` | OAuth 凭据落盘路径（chmod 600） |
| `authRedirectUri` | `http://localhost:9999/callback` | OAuth 回调地址（需配到飞书应用「安全设置 → 重定向 URL」） |
| `domain` | `feishu` | `lark` 为国际版 |
| `wsPingTimeoutSec` | `120` | 飞书长连接看门狗（秒）：ping 后该窗口内收不到任何入站帧即判定连接死亡并主动重连。半开连接不报 socket 错误，关掉它会出现「卡片照发、点击全丢」的假活状态 |
| `chatEnabled` | `true` | 飞书消息驱动 Claude Code（按 `bindings` 绑定的群触发） |
| `chatInject` | `true` | 注入模式：目录下有 herdr 管理的 claude 会话时，群消息经 `herdr agent prompt` 注入该会话（共享会话线）而非另起无头进程；无可用会话自动回退无头执行。`/sessions` 列表、`#序号` 定向、`/attach` 固定 |
| `chatBin` | `claude` | claude 可执行文件 |
| `chatModel` | 空 | 额外传给 claude 的 `--model`，空 = 用 claude 默认 |
| `chatTimeoutSec` | `1800` | 单条消息的 claude 执行超时 |

环境变量等价覆盖：`CC_BRIDGE_APP_ID` / `CC_BRIDGE_APP_SECRET` / `CC_BRIDGE_URL` / `CC_BRIDGE_TOKEN` / `CC_BRIDGE_CONFIG`。

## HTTP 接口

| 方法 & 路径 | 说明 |
|---|---|
| `POST /hook/permissionrequest` `POST /hook/pretooluse` | 确认类 hook 的 stdin JSON → 挂起等待决策；响应体即 hook stdout（空 = 无意见），按事件返回对应决策 schema。`pretooluse` 收到 `AskUserQuestion`/`ExitPlanMode` 时**立即空体放行**并转入读屏观察发提问/审批卡（不阻塞） |
| `POST /hook/posttooluse` | 工具已执行 → 严格匹配（会话+工具+参数）结算对应挂起确认，卡片刷为「已在终端允许」；本身不挂起、不发卡 |
| `POST /hook/notification` | 转通知卡片 |
| `POST /hook/stop` | 回合结束 → 该会话挂起确认结算为「已在终端处理」；读得到本回合最终输出时另发「🏁 已完成」结果卡（串在来源消息下；`notifyStop: false` 关闭） |
| `POST /notify` | `{title, body, severity}` 手动推送卡片 |
| `GET /health` | 状态（免鉴权） |
| `GET/DELETE /rules` | 查看 / 清空免确认规则 |

除 `/health` 外，配置了 `token` 时需带 `Authorization: Bearer <token>`。

## 卸载

```bash
node cli.mjs install-hooks --remove   # 从 settings.json 移除 hook（原文件备份为 *.bak-cc-bridge）
systemctl --user disable --now cc-bridge 2>/dev/null || true   # 停用 systemd 托管（serve.sh 回退模式跑的则直接停进程）
# 无其他残留
```

## 让 daemon 常驻

`./serve.sh` 会自动做：检测到 systemd 用户会话时，每次运行都重写 `~/.config/systemd/user/cc-bridge.service`（node 绝对路径、当前 PATH、`Restart=on-failure`、stdout/stderr 追加写 `serve.log`）→ `daemon-reload` → `enable` + `restart`，并尝试 `loginctl enable-linger`（SSH 全退出后用户级 systemd 仍在，多天无人值守的前提；自动开启失败时按提示手动 `sudo loginctl enable-linger <user>`）。首次运行会把历史 nohup daemon 一并迁移（杀旧进程释放端口）。崩溃后约 3s 自动拉起，验证过 `kill -9` 4s 内恢复。

管理命令照常：`systemctl --user restart/stop/status cc-bridge`、日志 `tail -f serve.log`（或 `journalctl --user -u cc-bridge -f`）。没有 systemd 用户会话（容器等）时 serve.sh 回退 nohup 后台运行（无常驻保障），此时如需手动配 systemd 可参考 serve.sh 里生成的 unit 内容。

## 常见问题

- **收不到卡片**：`node cli.mjs test` 先排除配置；确认应用已发布、机器人对你可用（搜索机器人名私聊）、`im:message:send_as_bot` 已开通。
- **装了 hook 但完全不触发**：旧版 Claude Code CLI 不支持 `PermissionRequest` 事件时会被静默忽略，用 `node cli.mjs install-hooks --event pretooluse` 回退；`claude --version` 与 `/hooks` 菜单可确认。
- **卡片能收到但按钮无反应**：飞书后台「消息卡片 → 回调配置」需为**长连接**模式；daemon 日志会打印 `card.action.trigger`。
- **长连接日志提示 appId 非法**：appId 必须是 `cli_` + 16 位十六进制，检查是否复制完整。
- **想让某类操作不询问**：点卡片上的「don't ask again」选项（原生持久化），或配置 `allow` 数组。
- **hook 触发太频繁**：`install-hooks --matcher 'Bash|Write|Edit'` 自定义工具匹配范围。
- **绑定群里发消息没反应**：先确认群在 `bindings` 里且已重启 serve（`node cli.mjs status` 可看绑定数）；再检查应用权限——没有「获取群组中所有消息」（`im:message.group_msg`）权限时飞书不会把未 @ 的群消息推给应用，此时群里须 @机器人 触发（开「获取群组中@机器人消息」`im:message.group_at_msg` 即可）；单聊不驱动执行（绑定以群为单位）。
- **消息驱动在哪台机器/目录跑**：在 daemon 所在机器、该群 `bindings` 里绑定的 `cwd` 下执行，和终端里在该目录开 claude 一致；权限确认照常弹卡片，且路由回该群。
- **pane 里的 claude 退出/崩溃了，人不在终端**：绑定群发 `/restart`——在绑定目录下找已退出的 pane 重新拉起 claude（默认 `--continue` 恢复该目录最近一条会话；同目录有多条会话时可能恢复到别的，介意就回终端 `claude --resume <sid>`）。`/restart new` 全新会话；`/sessions` 也会列出已退出的 pane。无头会话线不受影响（下一条消息自动新开）。
- **会话卡在选择题/计划审批框上（plan 模式提问、"Would you like to proceed?"）**：这些不触发权限确认 hook，cc-bridge 单独装了 `AskUserQuestion|ExitPlanMode` 的 PreToolUse/PostToolUse hook——终端出选择题的同时群里会出现「❓ 提问卡 / 📋 计划待审批」，点选项即在终端代答（多选题先勾选再「确认提交」；审批卡三键对应 auto 批准 / 手动批准 / 不批回计划模式）。升级 cc-bridge 后记得重跑 `node cli.mjs install-hooks`（旧 settings.json 里没有这两条）。
- **哪些阻塞框仍不会远程发卡**：① 目录信任确认（首次打开目录的 trust 对话框）发生在 agent 就绪前、无任何 hook 触发，且属安全决策——**故意不远程代答**，需回终端处理；② auto-compact（上下文压缩确认）在当前 CLI 版本默认自动执行、无 hook；③ MCP OAuth 授权弹窗无 hook 触发。这三类只能回终端，其余确认/提问/审批均已被卡片接管。
- **daemon 挂了怎么办**：serve.sh 走 systemd 时崩溃约 3s 自动拉起（`node cli.mjs status` 验证）；期间终端本地操作完全不受影响（fail-open），只是手机收不到卡。

## 设计说明

- **fail-open**：daemon 未启动、网络断开、发卡失败、超时，一律返回空决策（exit 0、无 stdout），Claude Code 回退原生确认流程，永远不会因为 bridge 故障卡死。
- **本地作答感知**：Claude Code 的 hook 体系没有「确认框已被本地回答」的事件，也不会杀掉仍在阻塞的 hook 进程，因此用 `PostToolUse`（工具确实执行 = 本地允许）与 `Stop`（回合结束 = 兜底）推断；卡片状态翻转走飞书官方「更新已发送的消息卡片」接口（`PATCH /im/v1/messages/:message_id`，前后卡片均声明 `update_multi: true`）。
- **回合输出卡**：Stop payload 自带 `transcript_path`（会话 JSONL），从后向前取本回合最后一条 assistant 文本（以本回合发起 user 消息为回溯边界，不捞上一轮旧文本；`stop_reason=tool_use` 的消息是回合中间输出（含 steering 插话的回应），跳过——只认回合收尾（`end_turn` 等）文本）即为该回合最终输出。Stop hook 与 transcript 写盘并发、可能抢在末条落盘前触发（半行 JSON 解析失败被跳过）：读不到收尾文本时按 300/800ms 重读，让半截读数顺势落空，而不是把中间输出当结果发卡。完成时**另发新卡**（受理是来源消息上的 GET 表情回复，不占聊天卡片位，完成状态由新卡承载）；读不到输出时若有来源消息发灰色「◌ 回合已结束」收尾卡，无来源不发卡，避免「任务中途冒出空泛的已完成」。
- **选项读屏对齐**：auto 模式行等 UI 自加选项不出现在 `permission_suggestions` 里，可见性还取决于账号 gate / 当前模式 / 熔断器等运行时状态（同一会话同一模型也会变），从 payload 推不出来。daemon 发卡前用 `herdr agent read` 抓终端当前渲染的确认框文本（hook 阻塞期间对话框就显示在 pane 上），解析「Do you want…」锚点后的编号选项行（折行合并、Tip 提示行不误判）决定卡片按钮集，保证两边一一对应。
- **顺序与超时对齐**：hook 配置 `timeout: 600` > daemon `timeoutSec`（≤580）> hook 客户端自毁（`timeoutSec`+15s，上限 590s），保证先由 daemon 超时优雅返回、Claude Code 不会先杀 hook。hook 客户端用 **node:http** 而非全局 fetch：Node fetch（undici）自带默认 300s 响应头超时（headersTimeout），长轮询恰好 300s 被掐断——曾导致确认卡一律 300s 翻灰「客户端断开」，`timeoutSec` 配多大都无效；node:http 无默认响应超时，等待窗口完全由配置决定。
- **代答模式的安全闭环**：往 pane 发键可能误伤（框刚被本地答掉时 `Enter` 会落进输入框、`Esc` 会打断回合），因此绝不盲发——点卡后先读屏验框（框不在 → 翻「已在终端处理」），选项与卡片逐字比对（对不上 → 翻「确认框已变化，请在终端处理」，一个键都不发），发键后隔 500/800ms 两拍复验框消失才认成功（仍在 → 同样翻「确认框已变化」，不硬猜结果）。代答进行中置 `answering` 标记：按键放行引发的 PostToolUse 不会把卡片抢答成「已在终端允许」。旧代答卡有三条回收路径：PostToolUse（本地允许）、Stop（回合结束兜底）、同会话新确认到达时读屏清扫（本地 Esc 拒绝无事件信号的场景）。
- **选择题对话框解析**（`src/dialog.mjs`）：AskUserQuestion 与权限确认框共用「编号选项」视觉但锚点互斥——选择框页脚是 `Enter to select`、权限框页脚是 `Esc to cancel · Tab to amend`；ExitPlanMode 锚定 `Would you like to proceed?` 问句。选项行支持 ❯ 光标与 ☐/☒ 多选勾选符、说明折行并入上方选项、`3. Type something.` / `4. Chat about this` 元选项行（由 hook payload 配对剥除，不给它们出按钮）；问题文本归一化为卡片 key，点卡时逐字复验防串题。多问题逐题渲染 → 逐题发卡；复审框（Ready to submit your answers?）在答案全部经卡片代答时自动提交，终端答的照常发卡由人点。
- 决策 schema 按事件区分（均已对照官方 hooks 文档核实）：`PreToolUse` 返回 `hookSpecificOutput.permissionDecision`（allow/deny）；`PermissionRequest` 返回 `hookSpecificOutput.decision.behavior`（allow/deny），`deny` 的原因/消息会反馈给 Claude，建议行/auto 行通过 `decision.updatedPermissions`（数组）回传原生权限更新（addRules / setMode 等，字段见 hooks 文档「Permission update entries」）。
- 挂起请求用 HTTP 长轮询实现，hook 进程无需额外状态；同一卡片重复回调按 rid 幂等处理。
- **双向防环（三层）**：镜像与注入打通后消息可能在「群 → CLI → 群 → CLI …」无限往返——① 以本人身份镜像出去的消息会真实触发 receive 事件，其 message_id 登记 30 分钟，入站命中直接丢弃；② daemon 注入会话的 prompt（sid+内容哈希，5 分钟）在 UserPromptSubmit 上报时命中则不再镜像；③ 断路器兜底：同群同内容 60s 内 ≥3 次即判定疑似回环，丢弃后续并告警一次。所有条目带 TTL 惰性清扫，无定时器。
