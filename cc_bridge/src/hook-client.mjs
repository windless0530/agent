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
    const res = await fetch(`${url.replace(/\/+$/, '')}/hook/${event}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      bodyText = await res.text();
    } else {
      log('hook', `daemon 响应 ${res.status}，放行走默认流程`);
    }
  } catch (e) {
    log('hook', 'daemon 不可达，放行走默认流程:', e.message);
  }

  const out = bodyText.trim();
  if (out) process.stdout.write(out);
}
