import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULTS = {
  appId: '',
  appSecret: '',
  /** 群 ↔ 工作目录绑定列表：[{ chatId: "oc_..", cwd: "/repo/path" }]。
   * 绑定群里的消息等价于在该目录的终端输入 claude 指令；
   * 该目录（含子目录）下 Claude Code 会话的确认卡也发到对应群。
   * 没有兜底接收方：未命中任何 binding 的目录一律不发卡、不关联。 */
  bindings: [],
  /** HTTP 监听地址；要让其他机器的 Claude Code 接入，改为 0.0.0.0 */
  host: '127.0.0.1',
  port: 3757,
  /** 每个确认请求等待飞书响应的最长秒数（Claude Code hook 上限 600s） */
  timeoutSec: 300,
  /** 同时挂起的确认请求数上限，超出后直接放行走本地流程 */
  maxPending: 16,
  /** hook 客户端访问 daemon 的共享密钥，设置后 /hook/*、/notify 需带 Bearer 头 */
  token: '',
  /** 允许点击卡片/发指令的飞书用户 open_id 白名单，空数组表示不限制 */
  allowedOpenIds: [],
  /** 启动时预置的免确认规则，形如 "Bash:git" / "Write" / "Edit:/src" */
  allow: [],
  /** Stop 事件是否发「🏁 已完成」卡：内容为该回合最终输出（读 transcript 最后一条
   *  assistant 文本，远程机器读不到时退化为通用文案）；发出后 10 分钟内抑制该会话的
   *  idle_prompt（"waiting for your input"）提醒。Stop hook 本身始终安装，
   *  还用于感知终端本地作答并把挂起卡片刷成已处理态 */
  notifyStop: true,
  /** 飞书消息驱动 Claude Code 开关（按 bindings 绑定的群触发） */
  chatEnabled: true,
  /** 受理回执卡的引用行称呼（如 "Elio"）：非空时回执卡引用行为「回复 Elio：<prompt>」，
   *  回执标题「已开始 · 指令」（排队时「已排队」）。注入 / 终端镜像 / 无头三条路径共用 */
  injectAckName: '',
  /** 消息注入模式（默认开）：绑定目录下有 herdr 管理的 claude 会话时，群消息经
   *  `herdr agent prompt` 注入该会话（群与终端共享同一条会话线），而非另起无头进程；
   *  无可用会话自动回退无头执行。/sessions 列表、#序号 定向、/attach 固定 */
  chatInject: true,
  /** 是否把终端里提交的 prompt 镜像到绑定群（UserPromptSubmit hook → 镜像卡，
   *  卡片标题带 herdr 会话主题；该会话的 Stop 输出卡会作为镜像卡的回复串成一串）。
   *  仅同步展示，不影响本地执行；飞书消息驱动的会话不镜像（输入本就来自群里） */
  mirrorPrompt: true,
  /** 镜像是否优先以用户本人身份发文本消息（user_access_token；群里显示为用户自己发的）。
   *  无凭据 / 刷新失败 / 发送失败自动降级为 bot 镜像卡。授权：node cli.mjs auth-url */
  mirrorAsUser: true,
  /** OAuth user_access_token 凭据落盘路径（与 config 分开存，chmod 600） */
  authFile: '',
  /** OAuth 授权回调地址（需先配到飞书开放平台应用的「安全设置 → 重定向 URL」；
   *  本地 daemon 无公网回调，默认值仅作占位，用户从跳转后的地址栏复制 code） */
  authRedirectUri: 'http://localhost:9999/callback',
  /** claude 可执行文件，默认 PATH 上的 claude */
  chatBin: 'claude',
  /** 额外传给 claude 的 --model，空 = 使用 claude 默认 */
  chatModel: '',
  /** 单条消息的 claude 执行超时秒数 */
  chatTimeoutSec: 1800,
  /** feishu | lark（国际版） */
  domain: 'feishu',
  /** 飞书长连接保活看门狗（秒）：ping 后该窗口内无任何入站帧即判定连接死亡并主动重连。
   *  半开/僵尸连接不会触发 socket 错误，SDK 默认只等 socket 报错——不设看门狗会一直假活 */
  wsPingTimeoutSec: 120,
  /** hook 客户端连接 daemon 的地址，默认本机端口 */
  clientUrl: '',
};

export function configPath() {
  return process.env.CC_BRIDGE_CONFIG || path.join(os.homedir(), '.cc-bridge.json');
}

export function templateConfig() {
  return {
    appId: 'cli_xxxxxxxxxxxxxxxx',
    appSecret: '填入飞书应用的 App Secret',
    bindings: [
      {
        chatId: '填入群 chat_id（oc_ 开头，给机器人发「绑定」可获取）',
        cwd: '填入该群绑定的本地目录，如 /root/workspace/myrepo',
      },
    ],
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    timeoutSec: DEFAULTS.timeoutSec,
    token: '',
    allowedOpenIds: [],
    allow: [],
    domain: 'feishu',
    chatEnabled: true,
    chatBin: 'claude',
    chatModel: '',
    chatTimeoutSec: DEFAULTS.chatTimeoutSec,
  };
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 配置合并优先级：命令行显式参数 > 环境变量 > 配置文件 > 默认值
 */
export function loadConfig(explicit = {}) {
  const file = readJsonFile(explicit.__configFile || configPath()) || {};
  const cfg = { ...DEFAULTS, ...file, ...stripUnderscore(explicit) };

  const env = process.env;
  if (env.CC_BRIDGE_APP_ID) cfg.appId = env.CC_BRIDGE_APP_ID;
  if (env.CC_BRIDGE_APP_SECRET) cfg.appSecret = env.CC_BRIDGE_APP_SECRET;
  if (env.CC_BRIDGE_HOST) cfg.host = env.CC_BRIDGE_HOST;
  if (env.CC_BRIDGE_PORT) cfg.port = env.CC_BRIDGE_PORT;
  if (env.CC_BRIDGE_TOKEN) cfg.token = env.CC_BRIDGE_TOKEN;
  if (env.CC_BRIDGE_TIMEOUT_SEC) cfg.timeoutSec = env.CC_BRIDGE_TIMEOUT_SEC;
  if (env.CC_BRIDGE_URL) cfg.clientUrl = env.CC_BRIDGE_URL;

  cfg.port = Number(cfg.port) || DEFAULTS.port;
  cfg.wsPingTimeoutSec = Number(cfg.wsPingTimeoutSec) || DEFAULTS.wsPingTimeoutSec;
  cfg.timeoutSec = Math.min(Number(cfg.timeoutSec) || DEFAULTS.timeoutSec, 580);
  cfg.maxPending = Number(cfg.maxPending) || DEFAULTS.maxPending;
  // bindings 规整：每条必须同时配置 chatId（oc_ 开头）与 cwd（绝对路径），
  // 配错/配漏的条目不进入运行时绑定，问题集中收集到 bindingErrors，由
  // validateServeConfig 在 serve/test 启动时直接报错退出（hook 客户端不受影响）。
  // local 标记目录是否在 daemon 本机：不在 → 「仅路由」绑定（确认卡照常按目录路由到群，
  // 但群消息不驱动执行——claude 只能跑在该目录所在的机器上）
  cfg.bindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
  const bindingErrors = [];
  const byChat = new Map();
  cfg.bindings.forEach((b, i) => {
    const label = `bindings[${i}]`;
    if (!b || typeof b !== 'object') {
      bindingErrors.push(`${label} 不是对象，应为 { "chatId": "oc_..", "cwd": "/绝对路径" }`);
      return;
    }
    const chatId = String(b.chatId || '').trim();
    const cwd = String(b.cwd || '').trim();
    const problems = [];
    if (!chatId || /填入/.test(chatId)) problems.push('chatId 未配置');
    else if (!/^oc_\w+$/.test(chatId)) problems.push(`chatId 应为 oc_ 开头的群 chat_id（当前: ${chatId}）`);
    if (!cwd || /填入/.test(cwd)) problems.push('cwd 未配置');
    else if (!path.isAbsolute(cwd)) problems.push(`cwd 应为绝对路径（当前: ${cwd}）`);
    if (problems.length) {
      bindingErrors.push(`${label} ${problems.join('；')}`);
      return;
    }
    // chatId 去重：后出现者优先
    byChat.set(chatId, {
      chatId,
      cwd: path.resolve(cwd),
      local: fs.existsSync(path.resolve(cwd)),
      ...(b.name ? { name: String(b.name) } : {}),
    });
  });
  cfg.bindings = [...byChat.values()];
  cfg.bindingErrors = bindingErrors;
  return cfg;
}

/** hook 客户端使用的 daemon 地址 */
export function serverUrl(cfg) {
  return (cfg.clientUrl || `http://127.0.0.1:${cfg.port}`).replace(/\/+$/, '');
}

/** 校验 daemon 启动所需配置，返回错误信息数组 */
export function validateServeConfig(cfg) {
  const errs = [];
  if (!cfg.appId || !cfg.appSecret || /填入/.test(cfg.appSecret)) {
    errs.push('appId / appSecret 未配置');
  }
  if (cfg.appId && !/^cli_[0-9a-fA-F]{16}$/.test(cfg.appId)) {
    errs.push(`appId 格式应为 cli_ + 16 位十六进制（当前: ${cfg.appId}）`);
  }
  if (!cfg.bindings?.length && !cfg.bindingErrors?.length) {
    errs.push('bindings 未配置：至少需要一条 { "chatId": "oc_..", "cwd": "/绝对路径" } 绑定（无兜底接收方，未绑定目录不发卡）');
  }
  // 每条 binding 的 chatId / cwd 缺一不可，配错配漏直接报出（不再静默丢弃）
  for (const e of cfg.bindingErrors || []) errs.push(e);
  // 目录不在本机不是错误：作为「仅路由」绑定（hook 上报的 cwd 按字符串前缀路由，
  // 与路径是否存在于 daemon 本机无关）
  return errs;
}

function stripUnderscore(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (!k.startsWith('__')) out[k] = v;
  }
  return out;
}
