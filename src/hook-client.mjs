import http from 'node:http';
import { log } from './util.mjs';

function readStdin(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => {
      cleanup();
      resolve(data);
    }, timeoutMs);
    const ondata = (c) => (data += c);
    const onend = () => {
      cleanup();
      resolve(data);
    };
    const onerr = (e) => {
      cleanup();
      reject(e);
    };
    function cleanup() {
      clearTimeout(timer);
      process.stdin.off('data', ondata);
      process.stdin.off('end', onend);
      process.stdin.off('error', onerr);
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', ondata);
    process.stdin.on('end', onend);
    process.stdin.on('error', onerr);
  });
}

/**
 * 把 payload POST 给 daemon，等响应体全文。必须用 node:http 而非全局 fetch：
 * Node 的 fetch（undici）自带默认 300s 响应头超时（headersTimeout），长轮询恰好
 * 300s 一到就被掐断——daemon 侧记成 act=cancel「客户端断开」，确认卡提前翻灰，
 * timeoutSec 配多少都没用。node:http 没有默认响应超时，等待上限完全由调用方的
 * timeoutMs 控制（daemon timeoutSec + 15s，先于 Claude Code 杀 hook 的 600s）。
 */
export function postHookJson(url, body, { token, timeoutMs = 590000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume(); // 丢弃响应体
          log('hook', `daemon 响应 ${res.statusCode}，放行走默认流程`);
          return resolve('');
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    // 长轮询期间无任何数据到达，socket 空闲超时即整体等待上限
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`等待 daemon 超过 ${Math.round(timeoutMs / 1000)}s`)));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * hook 进程侧逻辑：把 Claude Code 传入的 stdin JSON 转发给 daemon，
 * 阻塞等待飞书侧决策，把决策 JSON 原样打到 stdout。
 * 任何失败都静默放行（exit 0、无输出），保证 Claude Code 走默认流程。
 */
export async function runHook(event, { url, token, timeoutMs = 590000 }) {
  let raw = '';
  try {
    raw = await readStdin();
  } catch (e) {
    log('hook', '读取 stdin 失败:', e.message);
  }

  let bodyText = '';
  try {
    let body = raw || '{}';
    // daemon 由飞书消息拉起的 claude 会带此环境变量（hook 进程继承）：
    // 打上标记，daemon 据此抑制该会话的 Stop「任务完成」通知（结果由聊天卡片回复）
    if (process.env.CC_BRIDGE_FROM_CHAT === '1') {
      try {
        body = JSON.stringify({ ...JSON.parse(body), __fromChat: 1 });
      } catch { /* 原样转发 */ }
    }
    const res = await postHookJson(`${url.replace(/\/+$/, '')}/hook/${event}`, body, { token, timeoutMs });
    bodyText = res;
  } catch (e) {
    log('hook', 'daemon 不可达，放行走默认流程:', e.message);
  }

  const out = bodyText.trim();
  if (out) process.stdout.write(out);
}
