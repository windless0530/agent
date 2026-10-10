import os from 'node:os';

/** 带时间戳的 stderr 日志（stdout 留给 hook 协议输出） */
export function log(tag, ...args) {
  const ts = new Date().toLocaleString('sv-SE', { hour12: false });
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  process.stderr.write(`[${ts}] [${tag}] ${line}\n`);
}

/** 截断长文本，附加原始长度提示 */
export function truncate(s, n = 500) {
  s = String(s ?? '');
  if (s.length <= n) return s;
  return `${s.slice(0, n)}\n…(已截断，共 ${s.length} 字符)`;
}

/** 取命令第一个词，用于「总是允许」规则的粗粒度匹配 */
export function firstToken(cmd) {
  const s = String(cmd ?? '')
    .trim()
    .replace(/^[;(&|]+/, '');
  return s.split(/\s+/)[0] || '';
}

export function shortId(s, n = 8) {
  return String(s ?? '').slice(0, n);
}

export function hostname() {
  try {
    return os.hostname();
  } catch {
    return 'unknown';
  }
}

export function now() {
  return new Date().toLocaleString('sv-SE', { hour12: false });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询等待条件成立，超时抛错 */
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await sleep(intervalMs);
  }
}
