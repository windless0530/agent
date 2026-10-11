import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULTS = {
  appId: '',
  appSecret: '',
  /** 群 ↔ 工作目录绑定列表：[{ chatId: "oc_..", cwd: "/repo/path" }]。
   * 绑定群里的消息等价于在该目录的终端输入 claude 指令；
   * 该目录（含子目录）下 Claude Code 会话的确认卡也发到对应群。 */
  bindings: [],
  /** 兜底消息接收方：不属于任何 binding 目录的会话卡片发这里；用户 open_id（ou_）或群 chat_id（oc_） */
  peer: '',
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
  /** 飞书消息驱动 Claude Code 开关（按 bindings 绑定的群触发） */
  chatEnabled: true,
  /** claude 可执行文件，默认 PATH 上的 claude */
  chatBin: 'claude',
  /** 额外传给 claude 的 --model，空 = 使用 claude 默认 */
  chatModel: '',
  /** 单条消息的 claude 执行超时秒数 */
  chatTimeoutSec: 1800,
  /** feishu | lark（国际版） */
  domain: 'feishu',
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
    peer: '',
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
  if (env.CC_BRIDGE_PEER) cfg.peer = env.CC_BRIDGE_PEER;
  if (env.CC_BRIDGE_HOST) cfg.host = env.CC_BRIDGE_HOST;
  if (env.CC_BRIDGE_PORT) cfg.port = env.CC_BRIDGE_PORT;
  if (env.CC_BRIDGE_TOKEN) cfg.token = env.CC_BRIDGE_TOKEN;
  if (env.CC_BRIDGE_TIMEOUT_SEC) cfg.timeoutSec = env.CC_BRIDGE_TIMEOUT_SEC;
  if (env.CC_BRIDGE_URL) cfg.clientUrl = env.CC_BRIDGE_URL;

  cfg.port = Number(cfg.port) || DEFAULTS.port;
  cfg.timeoutSec = Math.min(Number(cfg.timeoutSec) || DEFAULTS.timeoutSec, 580);
  cfg.maxPending = Number(cfg.maxPending) || DEFAULTS.maxPending;
  // bindings 规整：留合法条目、cwd 转绝对路径、chatId 去重（后出现者优先）
  cfg.bindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
  const byChat = new Map();
  for (const b of cfg.bindings) {
    if (!b || typeof b !== 'object') continue;
    const chatId = String(b.chatId || '').trim();
    const cwd = String(b.cwd || '').trim();
    if (!/^oc_\w+$/.test(chatId) || !cwd) continue;
    byChat.set(chatId, { chatId, cwd: path.resolve(cwd), ...(b.name ? { name: String(b.name) } : {}) });
  }
  cfg.bindings = [...byChat.values()];
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
  if (!cfg.bindings?.length && (!cfg.peer || /填入/.test(cfg.peer))) {
    errs.push('bindings（群↔目录绑定）与 peer 至少配置一项');
  }
  for (const b of cfg.bindings || []) {
    if (/填入/.test(b.cwd) || /填入/.test(b.chatId)) {
      errs.push('bindings 存在未填写的占位符（chatId / cwd）');
      break;
    }
    if (!fs.existsSync(b.cwd)) {
      errs.push(`bindings 中目录不存在: ${b.cwd}`);
    }
  }
  return errs;
}

function stripUnderscore(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (!k.startsWith('__')) out[k] = v;
  }
  return out;
}
