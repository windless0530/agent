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

function truncateStr(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
