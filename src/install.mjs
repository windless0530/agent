import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { log } from './util.mjs';
import { configPath, templateConfig } from './config.mjs';

export const DEFAULT_MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|mcp__.*';

/** matcher 按工具名过滤的事件：确认类 + PostToolUse（本地允许信号，与确认同一匹配范围） */
const TOOL_MATCHER_EVENTS = ['PreToolUse', 'PermissionRequest', 'PostToolUse'];

/**
 * 探测本机 Claude Code CLI 是否支持 PermissionRequest hook（v2.1.x 引入）。
 * 在 CLI 可执行文件里找该事件名的内部标识；找不到或无法读取则视为不支持。
 */
export function supportsPermissionRequest() {
  try {
    const bin = execSync('command -v claude', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
      .toString()
      .trim();
    if (!bin) return false;
    const buf = fs.readFileSync(fs.realpathSync(bin));
    return buf.includes('PermissionRequestHooks') || buf.includes('"PermissionRequest"');
  } catch {
    return false;
  }
}

/**
 * 生成 hook 命令：本机用 node 直调，远程用 curl（只要装了 curl）。
 * confirmEvent: 'permissionrequest'（新 CLI，只在真正要弹确认框时触发）或 'pretooluse'（旧 CLI 兼容）。
 * PostToolUse / Stop 常驻安装：用户在终端本地回答确认框后 Claude Code 不会通知 hook，
 * daemon 靠这两个事件得知（工具已执行=本地允许 / 回合结束=兜底），把飞书卡片刷成已处理态。
 */
export function buildHookCommands({ cliPath, url, token, confirmEvent = 'pretooluse' }) {
  const mk = (event, timeout) => {
    if (url) {
      const auth = token ? ` -H 'Authorization: Bearer ${token}'` : '';
      return `curl -s --max-time ${Math.min(timeout, 590)} -H 'Content-Type: application/json'${auth} --data-binary @- ${url}/hook/${event}`;
    }
    return `"${process.execPath}" "${cliPath}" hook ${event}${token ? ` --token ${token}` : ''}`;
  };
  const confirmKey = confirmEvent === 'permissionrequest' ? 'PermissionRequest' : 'PreToolUse';
  const cmds = {
    [confirmKey]: { event: confirmEvent, timeout: 600 },
    PostToolUse: { event: 'posttooluse', timeout: 60 },
    Notification: { event: 'notification', timeout: 60 },
    Stop: { event: 'stop', timeout: 60 },
    // prompt 镜像：daemon 立即放行，10s 兜底防 daemon 不可达时拖住终端
    UserPromptSubmit: { event: 'userpromptsubmit', timeout: 10 },
  };
  const out = {};
  for (const [k, v] of Object.entries(cmds)) out[k] = { command: mk(v.event, v.timeout), timeout: v.timeout };
  return out;
}

function isOurHookCommand(command) {
  return (
    /cc[-_]bridge/.test(command) ||
    /\/hook\/(pretooluse|permissionrequest|posttooluse|notification|stop|userpromptsubmit)/.test(command)
  );
}

function isOurEntry(entry) {
  return (entry?.hooks || []).some((h) => isOurHookCommand(h.command || ''));
}

export function settingsFilePath(target, projectDir) {
  if (target === 'project') {
    return path.join(projectDir || process.cwd(), '.claude', 'settings.json');
  }
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readSettings(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 把 cc-bridge hook 合并进 Claude Code settings.json（幂等：先移除旧条目再写入）
 */
export function installHooks({ file, commands, matcher = DEFAULT_MATCHER, dryRun = false }) {
  const settings = readSettings(file);
  settings.hooks = settings.hooks || {};

  const plan = [];
  for (const [event, { command, timeout }] of Object.entries(commands)) {
    const list = settings.hooks[event] || [];
    const kept = list.filter((e) => !isOurEntry(e));
    const entry = {
      matcher: TOOL_MATCHER_EVENTS.includes(event) ? matcher : '',
      hooks: [{ type: 'command', command, timeout }],
    };
    kept.push(entry);
    settings.hooks[event] = kept;
    plan.push({ event, matcher: entry.matcher, command, timeout });
  }

  if (dryRun) return { plan, file, changed: true };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bak = `${file}.bak-cc-bridge`;
  if (fs.existsSync(file)) fs.copyFileSync(file, bak);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { plan, file, backup: bak, changed: true };
}

/** 移除 settings.json 中所有 cc-bridge hook 条目 */
export function removeHooks({ file, dryRun = false }) {
  const settings = readSettings(file);
  if (!settings.hooks) return { file, changed: false };
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter((e) => !isOurEntry(e));
    removed += before - settings.hooks[event].length;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (removed === 0) return { file, changed: false, removed };
  if (!dryRun) {
    const bak = `${file}.bak-cc-bridge`;
    if (fs.existsSync(file)) fs.copyFileSync(file, bak);
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  }
  return { file, changed: true, removed };
}

/** 生成配置文件模板（已存在则跳过，除非 force） */
export function initConfig({ file = configPath(), force = false, overrides = {} } = {}) {
  if (fs.existsSync(file) && !force) {
    log('init', `配置已存在: ${file}（用 --force 覆盖）`);
    return { file, created: false };
  }
  const cfg = { ...templateConfig(), ...overrides };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return { file, created: true };
}
