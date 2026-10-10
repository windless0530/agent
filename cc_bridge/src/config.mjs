import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULTS = {
  appId: '',
  appSecret: '',
  /** 消息接收方：用户 open_id（ou_ 开头）或群聊 chat_id（oc_ 开头） */
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
  /** 允许点击卡片的飞书用户 open_id 白名单，空数组表示不限制 */
  allowedOpenIds: [],
  /** 启动时预置的免确认规则，形如 "Bash:git" / "Write" / "Edit:/src" */
  allow: [],
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
    peer: '填入你的 open_id（ou_ 开头）或群 chat_id（oc_ 开头）',
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    timeoutSec: DEFAULTS.timeoutSec,
    token: '',
    allowedOpenIds: [],
    allow: [],
    domain: 'feishu',
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
  if (!cfg.peer || /填入/.test(cfg.peer)) {
    errs.push('peer 未配置（接收卡片的 open_id 或 chat_id）');
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
