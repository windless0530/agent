import { execFile } from 'node:child_process';
import { log } from './util.mjs';

/** agent list 结果缓存窗口：一次 spawn 换短时间免查（多条 prompt 连续镜像时省开销） */
const TTL_MS = 15_000;
let cache = { at: 0, agents: [], warned: false };

function run(bin, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** 当前 herdr 工作区里的 agent 列表（CLI 输出外层包了一层 {id,result}）；herdr 不可用返回 [] */
export async function listAgents() {
  if (Date.now() - cache.at < TTL_MS) return cache.agents;
  const out = await run(process.env.HERDR_BIN || 'herdr', ['agent', 'list']);
  let agents = [];
  if (out != null) {
    try {
      agents = JSON.parse(out)?.result?.agents || [];
    } catch {
      agents = [];
    }
  } else if (!cache.warned) {
    // 未安装 / 不在 PATH / 无会话：只提示一次，标题退化为 sid
    cache.warned = true;
    log('herdr', 'agent list 不可用（未安装或不在 PATH），镜像卡会话标题退化为 sid');
  }
  cache = { ...cache, at: Date.now(), agents };
  return agents;
}

/** 按 Claude session_id 找对应 herdr agent（terminal_title 等）；找不到返回 null */
export async function findAgentBySession(sessionId) {
  if (!sessionId) return null;
  const agents = await listAgents();
  return agents.find((a) => a?.agent_session?.value === sessionId) || null;
}

/** 全部 pane 列表（含没在跑 agent 的）。claude 退出后 pane 仍在原地：agent 字段
 *  消失、cwd 保留——/restart 靠它找「死了的会话 pane」。herdr 不可用返回 [] */
export async function listPanes() {
  const out = await run(process.env.HERDR_BIN || 'herdr', ['pane', 'list']);
  try {
    return JSON.parse(out)?.result?.panes || [];
  } catch {
    return [];
  }
}

/**
 * 在既有 pane 里拉起交互式 claude（herdr agent start）：pane 必须在交互 shell
 * 提示符（herdr 自带校验），阻塞到就绪（idle）或失败才返回。args 透传给 claude，
 * 如 ['--continue'] 恢复该目录最近一条会话。name 需 ^[a-z][a-z0-9_-]{0,31}$。
 * 返回 { ok, error, agent }；error 形如 "agent_not_ready: ..."（已启动但停在
 * 信任目录等确认界面——进程活着，只是没就绪）。
 */
export function startAgentInPane(paneId, { name = 'ccbridge_agent', args = [], timeoutMs = 120_000 } = {}) {
  const wait = Math.min(Math.max(10_000, timeoutMs), 300_000);
  return new Promise((resolve) => {
    execFile(
      process.env.HERDR_BIN || 'herdr',
      ['agent', 'start', name, '--kind', 'claude', '--pane', paneId, '--timeout', String(wait), ...(args.length ? ['--', ...args] : [])],
      { timeout: wait + 10_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        try {
          const j = JSON.parse(stdout);
          if (j?.result?.agent) return resolve({ ok: true, error: '', agent: j.result.agent });
          if (j?.error) return resolve({ ok: false, error: `${j.error.code}: ${j.error.message || ''}`.trim(), agent: null });
          return resolve({ ok: false, error: truncateStr(stdout || stderr || '未知响应', 300), agent: null });
        } catch { /* 无 JSON 输出，走错误分支 */ }
        const detail = `${stderr || ''} ${err?.message || ''}`.trim();
        resolve({ ok: false, error: truncateStr(detail || 'herdr agent start 失败', 300), agent: null });
      },
    );
  });
}

/** 目录（含子目录）下的 claude 会话，按最近状态变化降序（state_change_seq 越大越活跃） */
export async function agentsForCwd(cwd) {
  if (!cwd) return [];
  const agents = await listAgents();
  const abs = `${cwd}`.replace(/\/+$/, '');
  return agents
    .filter((a) => a?.agent === 'claude' && typeof a.cwd === 'string')
    .filter((a) => {
      const c = a.cwd.replace(/\/+$/, '');
      return c === abs || c.startsWith(abs + '/');
    })
    .sort((x, y) => (y.state_change_seq || 0) - (x.state_change_seq || 0));
}

/**
 * 向运行中的 herdr 会话注入 prompt（回合级提交：busy 自动排队、blocked 拒绝）。
 * 返回 { ok, blocked, error, agent }；blocked=会话正卡在确认框（先处理群里的确认卡）。
 */
export function promptAgent(paneId, text, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.env.HERDR_BIN || 'herdr',
      ['agent', 'prompt', paneId, text],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = `${stderr || ''} ${err.message || ''}`.trim();
          const blocked = /blocked/i.test(detail);
          return resolve({ ok: false, blocked, error: truncateStr(detail || 'herdr agent prompt 失败', 300) });
        }
        try {
          const j = JSON.parse(stdout);
          if (j?.type === 'agent_prompted' || j?.result?.agent) {
            return resolve({ ok: true, blocked: false, error: '', agent: j.result?.agent || null });
          }
          return resolve({ ok: false, blocked: false, error: truncateStr(stdout || '未知响应', 300) });
        } catch {
          return resolve({ ok: false, blocked: false, error: truncateStr(stdout || stderr || '输出解析失败', 300) });
        }
      },
    );
  });
}

/**
 * 向 agent pane 发送按键：busy 中注入的消息只进了 CLI 输入框排队（"ctrl+enter to
 * send now"），发 ctrl+enter 把它立即提交（打断式 steering）。空输入框时是 no-op。
 * 成功返回 true；失败只记日志（消息留在队列，回合结束仍会自动发出）。
 */
export function sendKeys(paneId, key, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.env.HERDR_BIN || 'herdr',
      ['agent', 'send-keys', paneId, key],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = `${stderr || ''} ${err.message || ''}`.trim();
          log('herdr', `send-keys ${key} 失败（pane ${paneId}）: ${truncateStr(detail, 200)}`);
          return resolve(false);
        }
        try {
          resolve(JSON.parse(stdout)?.result?.type === 'ok');
        } catch {
          log('herdr', `send-keys ${key} 响应异常（pane ${paneId}）: ${truncateStr(stdout || '', 200)}`);
          resolve(false);
        }
      },
    );
  });
}

/** 读取 agent pane 当前可见文本（终端确认框的 ground truth，解析见 src/dialog.mjs） */
export function readPane(paneId, { lines = 80, timeoutMs = 5000 } = {}) {
  if (!paneId) return Promise.resolve('');
  return run(
    process.env.HERDR_BIN || 'herdr',
    ['agent', 'read', paneId, '--source', 'visible', '--format', 'text', '--lines', String(lines)],
    timeoutMs,
  ).then((out) => out || '');
}

function truncateStr(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
