#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  configPath,
  serverUrl,
  validateServeConfig,
} from './src/config.mjs';
import {
  installHooks,
  removeHooks,
  buildHookCommands,
  initConfig,
  supportsPermissionRequest,
  DEFAULT_MATCHER,
} from './src/install.mjs';
import { runHook } from './src/hook-client.mjs';
import { createBridge } from './src/server.mjs';
import { createChatRunner } from './src/agent.mjs';
import { createMessenger, startEventStream } from './src/feishu.mjs';
import { buildNotifyCard } from './src/cards.mjs';
import { log, shortId } from './src/util.mjs';

const CLI_PATH = fileURLToPath(import.meta.url);

const HELP = `cc-bridge — 把 Claude Code 的确认/授权请求转发到飞书交互卡片

用法:
  cc-bridge init                          生成配置模板 ~/.cc-bridge.json
  cc-bridge serve                         启动桥接 daemon（HTTP + 飞书长连接）
                                          消息驱动：bindings 里绑定的群，消息免 @ 自动
                                          等价于在绑定目录的终端 claude cli 输入，
                                          回复发回该群；确认卡也按目录路由到对应群
  cc-bridge install-hooks                 把 hook 写入 Claude Code settings.json
      [--global | --project DIR]          默认 --global
      [--matcher REGEX]                   确认类 hook 的工具匹配，默认: ${DEFAULT_MATCHER}
      [--event permissionrequest|pretooluse]
                                          确认事件；默认自动探测：新 CLI 用
                                          PermissionRequest（仅真正需要授权时触发），
                                          旧 CLI 回退 PreToolUse
      （PostToolUse / Stop / Notification 一并安装：终端本地作答后把
        飞书卡片刷成「已在终端处理」，任务完成通知默认关闭，见 notifyStop）
      [--url URL --token T]               远程模式：写入 curl 形式命令
      [--remove] [--dry-run]
  cc-bridge hook <event> [--url U] [--token T]   hook 进程入口（stdin/stdout 协议）
  cc-bridge test                          健康检查 + 发送测试卡片
  cc-bridge status                        查看 daemon 状态
  cc-bridge rules [--clear]               查看/清空免确认规则

环境变量: CC_BRIDGE_APP_ID / CC_BRIDGE_APP_SECRET /
          CC_BRIDGE_URL / CC_BRIDGE_TOKEN / CC_BRIDGE_CONFIG
`;

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const flags = { _: [] };
  const bool = new Set(['--force', '--global', '--remove', '--dry-run', '--clear', '--help', '-h']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      flags.help = true;
    } else if (bool.has(a)) {
      flags[a.replace(/^-+/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
    } else if (a.startsWith('--')) {
      const key = a.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const eq = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
      if (eq === undefined) continue;
      flags[key] = eq;
      i++;
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

async function fetchJson(url, { token, method = 'GET' } = {}) {
  const res = await fetch(url, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.text();
  return { status: res.status, json: body ? JSON.parse(body) : null };
}

// ---------- 子命令 ----------

async function cmdServe(flags) {
  const cfg = loadConfig(flags);
  const errs = validateServeConfig(cfg);
  if (errs.length) {
    for (const e of errs) log('serve', '配置错误:', e);
    process.stderr.write(`\n先运行 cc-bridge init 并填写 ${configPath()}\n`);
    process.exit(1);
  }

  const messenger = createMessenger(cfg);
  const chat = cfg.chatEnabled
    ? createChatRunner({ cfg, messenger, client: messenger.client })
    : null;
  const bridge = createBridge({ cfg, messenger, chat });

  try {
    await new Promise((resolve, reject) => {
      bridge.server.once('error', reject);
      bridge.server.listen(cfg.port, cfg.host, resolve);
    });
  } catch (e) {
    log('serve', `HTTP 监听失败 (${cfg.host}:${cfg.port}):`, e.message);
    process.exit(1);
  }
  log('serve', `HTTP 服务已启动 http://${cfg.host}:${cfg.port}`);
  log('serve', `等待飞书确认超时: ${cfg.timeoutSec}s，并发上限: ${cfg.maxPending}`);
  if (chat) {
    for (const b of cfg.bindings) {
      log(
        'serve',
        `消息驱动绑定: 群 ${shortId(b.chatId)} ↔ ${b.cwd}` +
          `${b.local === false ? '（仅路由：目录不在本机，消息不驱动执行）' : ''}` +
          `${b.name ? `（${b.name}）` : ''}`,
      );
    }
    log('serve', `消息驱动已开启: ${cfg.chatBin}，单条超时 ${cfg.chatTimeoutSec}s（绑定群消息免 @ 自动执行）`);
  }

  try {
    const ws = await startEventStream(cfg, {
      onCardAction: bridge.handleCardAction,
      onMessage: bridge.handleInboundMessage,
    });
    bridge.setWsState('connected');
    if (typeof ws.getConnectionStatus === 'function') {
      bridge.setWsStatusProvider(() => ws.getConnectionStatus());
    }
  } catch (e) {
    log('serve', '飞书长连接建立失败:', e.message);
    log('serve', '请检查 appId/appSecret，以及飞书后台「事件与回调 → 订阅方式 → 长连接」');
    bridge.server.close();
    process.exit(1);
  }

  const shutdown = (sig) => {
    log('serve', `收到 ${sig}，退出`);
    bridge.server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function cmdHook(flags) {
  const event = (flags._[0] || process.env.CC_BRIDGE_EVENT || 'pretooluse').toLowerCase();
  const cfg = loadConfig(flags);
  const url = flags.url || serverUrl(cfg);
  const token = flags.token || cfg.token;
  const timeoutMs = Math.min(cfg.timeoutSec * 1000 + 15000, 590000);
  await runHook(event, { url, token, timeoutMs });
}

async function cmdInstallHooks(flags) {
  const cfg = loadConfig(flags);
  // 显式给了一个非本机地址 → 写 curl 形式命令（该机器无需安装 cc-bridge）
  const explicitUrl = flags.url || cfg.clientUrl || '';
  const remote = explicitUrl && !/\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(explicitUrl);
  const target = flags.project ? 'project' : 'global';
  const file = flags.file || (target === 'project'
    ? path.join(flags.project === true ? process.cwd() : flags.project, '.claude', 'settings.json')
    : path.join(process.env.HOME || '', '.claude', 'settings.json'));

  if (flags.remove) {
    const r = removeHooks({ file, dryRun: flags.dryRun });
    if (r.changed) {
      process.stdout.write(`${flags.dryRun ? '[dry-run] ' : ''}已移除 ${r.removed} 条 cc-bridge hook（${file}）\n`);
    } else {
      process.stdout.write(`未发现 cc-bridge hook（${file}）\n`);
    }
    return;
  }

  // 确认事件：优先 PermissionRequest（只在真正需要人工授权时触发），旧 CLI 自动回退 PreToolUse
  const confirmEvent =
    flags.event === 'permissionrequest' || flags.event === 'pretooluse'
      ? flags.event
      : supportsPermissionRequest()
        ? 'permissionrequest'
        : 'pretooluse';
  if (confirmEvent === 'pretooluse' && !flags.event) {
    log('install', '未检测到本机 CLI 的 PermissionRequest 支持，改用 PreToolUse（兼容模式，可用 --event 覆盖）');
  }

  const commands = buildHookCommands({
    cliPath: CLI_PATH,
    url: remote ? explicitUrl : undefined,
    token: flags.token || cfg.token,
    confirmEvent,
  });
  const r = installHooks({
    file,
    commands,
    matcher: flags.matcher || DEFAULT_MATCHER,
    dryRun: flags.dryRun,
  });
  process.stdout.write(`${flags.dryRun ? '[dry-run] ' : ''}已写入 ${r.file}:\n`);
  for (const p of r.plan) {
    process.stdout.write(`  ${p.event}${p.matcher ? ` (matcher: ${p.matcher})` : ''} timeout=${p.timeout}s\n    ${p.command}\n`);
  }
  if (r.backup) process.stdout.write(`备份: ${r.backup}\n`);
  process.stdout.write('\n重启 Claude Code 会话后生效。\n');
}

async function cmdTest(flags) {
  const cfg = loadConfig(flags);
  const base = serverUrl(cfg);

  try {
    const { json } = await fetchJson(`${base}/health`, { token: flags.token || cfg.token });
    process.stdout.write(`daemon: 运行中  ws=${json.ws}  pending=${json.pending}\n`);
  } catch {
    process.stdout.write('daemon: 未运行（cc-bridge serve）\n');
  }

  const errs = validateServeConfig(cfg);
  if (errs.length) {
    for (const e of errs) process.stdout.write(`配置问题: ${e}\n`);
    process.exit(1);
  }
  const messenger = createMessenger(cfg);
  for (const b of cfg.bindings) {
    const messageId = await messenger.sendCardTo(
      b.chatId,
      buildNotifyCard({
        title: '✅ cc-bridge 测试消息',
        message: `配置生效！绑定目录 \`${b.cwd}\` 的确认/通知卡片会发到本群。`,
        cwd: b.cwd,
        severity: 'success',
      }),
    );
    process.stdout.write(`测试卡片已发送到群 ${shortId(b.chatId)}（message_id: ${messageId}），请在飞书查看。\n`);
  }
}

async function cmdStatus(flags) {
  const cfg = loadConfig(flags);
  const base = serverUrl(cfg);
  try {
    const { json } = await fetchJson(`${base}/health`, { token: flags.token || cfg.token });
    process.stdout.write(JSON.stringify(json, null, 2) + '\n');
  } catch (e) {
    process.stdout.write(`daemon 不可达: ${base} (${e.message})\n`);
    process.exitCode = 1;
  }
}

async function cmdRules(flags) {
  const cfg = loadConfig(flags);
  const base = serverUrl(cfg);
  const token = flags.token || cfg.token;
  if (flags.clear) {
    const { json } = await fetchJson(`${base}/rules`, { token, method: 'DELETE' });
    process.stdout.write(JSON.stringify(json) + '\n');
    return;
  }
  const { json } = await fetchJson(`${base}/rules`, { token });
  if (!json?.rules?.length) {
    process.stdout.write('（无免确认规则；点击卡片上的「总是允许」会自动添加，daemon 重启后清空）\n');
    return;
  }
  for (const r of json.rules) {
    process.stdout.write(`- ${r.tool}${r.prefix ? ` : ${r.prefix}` : '（全部）'}\n`);
  }
}

async function cmdInit(flags) {
  const r = initConfig({
    file: flags.config || configPath(),
    force: flags.force,
    overrides: {
      ...(flags.appId ? { appId: flags.appId } : {}),
      ...(flags.appSecret ? { appSecret: flags.appSecret } : {}),
    },
  });
  process.stdout.write(r.created ? `已生成配置模板: ${r.file}\n请填写 appId / appSecret，并在 bindings 里配置「群 chat_id ↔ 目录」后运行 cc-bridge serve。\n` : `配置已存在: ${r.file}\n`);
}

// ---------- main ----------

const flags = parseArgs(process.argv.slice(2));
const cmd = flags._.shift();

try {
  switch (cmd) {
    case 'serve': await cmdServe(flags); break;
    case 'hook': await cmdHook(flags); break;
    case 'init': await cmdInit(flags); break;
    case 'install-hooks': await cmdInstallHooks(flags); break;
    case 'test': await cmdTest(flags); break;
    case 'status': await cmdStatus(flags); break;
    case 'rules': await cmdRules(flags); break;
    default:
      process.stdout.write(HELP);
      if (cmd && cmd !== 'help') process.exitCode = 1;
  }
} catch (e) {
  log('cli', '执行失败:', e.message);
  process.exitCode = 1;
}
