import path from 'node:path';
import { spawn } from 'node:child_process';
import { log, truncate, shortId } from './util.mjs';
import { buildTaskAckCard, buildTaskResultCard } from './cards.mjs';
import { agentsForCwd, promptAgent } from './herdr.mjs';
import { createBridgeState } from './state.mjs';

/** 文本消息正文里的 @ 占位符（@_user_N），还原指令时要剥掉 */
const MENTION_TOKEN = /@_user_\d+/g;
/** 控制命令：丢弃当前会话，下一条消息从新会话开始 */
const RESET_RE = /^(新会话|\/new|\/reset|reset|new)$/i;
/** 注入寻址：#3 内容 → 定向注入 /sessions 列表里的 3 号会话 */
const HASH_TARGET_RE = /^#(\d+)\s+(.+)$/;

/** 解析文本消息正文：去 @ 占位符、压缩空白 */
export function extractText(content) {
  try {
    const text = JSON.parse(content || '{}').text || '';
    return String(text).replace(MENTION_TOKEN, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * 跑一条无头 claude：claude -p --output-format json [--resume sid] <prompt>
 * 解析末尾 result JSON；超时杀进程。永不 reject，结果一律用返回值表达。
 */
export function runClaudeOnce({ bin = 'claude', cwd, prompt, sessionId = '', model = '', timeoutSec = 1800, env = {} } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json'];
    if (sessionId) args.push('--resume', sessionId);
    if (model) args.push('--model', model);
    args.push(prompt);
    let child;
    try {
      child = spawn(bin, args, {
        cwd: cwd || undefined,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, error: `无法启动 ${bin}: ${e.message}` });
      return;
    }
    log('chat', `claude 启动 pid=${child.pid} cwd=${cwd} resume=${sessionId ? shortId(sessionId) : '新会话'}`);
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch { /* 已退出 */ }
      }, 5000);
    }, Math.max(1, timeoutSec) * 1000);
    child.stdout.on('data', (d) => {
      if (out.length < 20_000_000) out += d;
    });
    child.stderr.on('data', (d) => {
      if (err.length < 200_000) err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `claude 启动失败: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, timedOut: true, error: `超过 ${timeoutSec}s 未完成，已终止` });
      try {
        const j = JSON.parse(out);
        resolve({
          ok: code === 0 && !j.is_error,
          result: j.result || '',
          sessionId: j.session_id || sessionId,
          isError: !!j.is_error,
          subtype: j.subtype,
          costUsd: j.total_cost_usd,
          durationMs: j.duration_ms,
          numTurns: j.num_turns,
          stderr: err.trim(),
        });
      } catch {
        resolve({ ok: false, error: err.trim() || `claude 退出码 ${code}，且无 JSON 输出` });
      }
    });
  });
}

/**
 * 飞书消息 → Claude Code 指令，按「群 ↔ 工作目录」绑定（配置文件 bindings 列表）：
 * 绑定群里的消息等价于在该目录的终端输入 claude 指令（免 @，自动执行）；
 * 未绑定的群 @机器人 只回复配置提示；单聊不驱动执行。
 *
 * 注入优先（chatInject，默认开）：绑定目录下有 herdr 管理的 claude 会话时，消息经
 * `herdr agent prompt` 回合级注入该会话（busy 自动排队、blocked 拒绝注入）——群与终端
 * 共享同一条会话线，受理回执卡串在用户消息下、Stop 时另发结果新卡（回执保持不动）。没有可用
 * 会话才回退老行为：每群串行跑无头
 * `claude -p [--resume]`。`#序号 内容` 定向、`/attach 序号` 固定、`/sessions` 列表。
 * 防回环（state 共享给 hook 镜像侧）：镜像出去的本人消息 id 直接丢弃；注入的 prompt
 * 不再镜像（本就来自群里）；同群同内容短窗高频触发断路器丢弃并告警一次。
 */
export function createChatRunner({
  cfg,
  messenger,
  client,
  runClaude = runClaudeOnce,
  state = null,
  herdr = null,
}) {
  const bindings = cfg.bindings || [];
  const byChat = new Map(bindings.map((b) => [b.chatId, b]));
  const bin = cfg.chatBin || 'claude';
  const sessions = new Map(); // chatId -> claude session_id（无头回退线）
  const queues = new Map(); // chatId -> { chain, waiting }
  const sticky = new Map(); // chatId -> { paneId, title }（/attach 固定的注入目标）
  const seen = new Set(); // 已处理的 message_id（飞书可能重推）
  const st = state || createBridgeState();
  const herd = herdr || { agentsForCwd, promptAgent };
  let botOpenIdPromise = null;

  /** 卡片路由：按会话 cwd 找绑定的群（最长前缀优先），找不到返回 null（无兜底，不发卡） */
  function chatForCwd(cwd) {
    if (!cwd) return null;
    const abs = path.resolve(cwd);
    let best = null;
    let bestLen = -1;
    for (const b of bindings) {
      const bc = path.resolve(b.cwd);
      if (abs === bc || abs.startsWith(bc + path.sep)) {
        if (bc.length > bestLen) {
          best = b;
          bestLen = bc.length;
        }
      }
    }
    return best;
  }

  /** 机器人自己的 open_id（bot/v3/info，响应体是 {bot:{open_id}} 非标准包装），失败返回 null */
  function getBotOpenId() {
    if (!botOpenIdPromise) {
      botOpenIdPromise = client
        .request({ url: 'open-apis/bot/v3/info', method: 'GET' })
        .then((res) => res?.bot?.open_id || res?.data?.open_id || null)
        .catch((e) => {
          log('chat', '获取机器人信息失败:', e.response?.data?.msg || e.message);
          return null;
        });
    }
    return botOpenIdPromise;
  }

  /** mentions 里是否 @ 了本机器人；拿不到 bot open_id 时退化为「有 @ 就算」 */
  async function isBotMentioned(mentions) {
    if (!mentions?.length) return false;
    const bot = await getBotOpenId();
    if (!bot) return true;
    return mentions.some((m) => {
      const id = typeof m?.id === 'string' ? m.id : m?.id?.open_id;
      return id === bot;
    });
  }

  function seenOnce(id) {
    if (!id) return false;
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > 500) {
      for (const v of seen) {
        seen.delete(v);
        if (seen.size <= 400) break;
      }
    }
    return false;
  }

  /** 每个群串行执行（同终端一次只能输入一条）；返回排队位置（0 = 立即执行） */
  function enqueue(chatId, task) {
    let q = queues.get(chatId);
    if (!q) {
      q = { chain: Promise.resolve(), waiting: 0 };
      queues.set(chatId, q);
    }
    const position = q.waiting;
    q.waiting++;
    q.chain = q.chain
      .then(() => task())
      .catch((e) => log('chat', '任务异常:', e.message))
      .finally(() => {
        q.waiting--;
        if (q.waiting <= 0) queues.delete(chatId);
      });
    return position;
  }

  async function processPrompt(chatId, { cwd, messageId, prompt, position, ackId }) {
    // 排队中的消息开始执行：把回执从「已排队」刷成「处理中」
    if (ackId && position > 0) {
      await messenger.updateCard(ackId, buildTaskAckCard({ prompt })).catch(() => {});
    }
    const sessionId = sessions.get(chatId) || '';
    const startedAt = Date.now();
    let r;
    try {
      r = await runClaude({
        bin,
        cwd,
        prompt,
        sessionId,
        model: cfg.chatModel || '',
        timeoutSec: cfg.chatTimeoutSec,
        env: { CC_BRIDGE_FROM_CHAT: '1' },
      });
    } catch (e) {
      r = { ok: false, error: `执行异常: ${e.message}` };
    }
    if (r.sessionId) sessions.set(chatId, r.sessionId);
    const card = buildTaskResultCard({
      ok: r.ok,
      timedOut: r.timedOut,
      body: r.result || r.error || '',
      prompt,
      sessionId: r.sessionId || sessionId,
      cwd,
      durationMs: r.durationMs ?? Date.now() - startedAt,
      costUsd: r.costUsd,
      numTurns: r.numTurns,
    });
    try {
      // 结果另发新卡串在来源消息下（受理回执卡保持「已开始」不改动）
      await messenger.replyCard(messageId, card);
    } catch (e) {
      log('error', '发送结果卡片失败，改发文本:', e.message);
      try {
        await messenger.replyText(chatId, truncate(r.result || r.error || '(无输出)', 3000));
      } catch { /* 放弃 */ }
    }
    log(
      'chat',
      `完成 chat=${shortId(chatId)} ${r.ok ? 'ok' : 'fail'} ${Math.round((Date.now() - startedAt) / 1000)}s turns=${r.numTurns ?? '?'}`,
    );
  }

  /** 注入模式状态图标 */
  const statusIcon = (s) => (s === 'working' ? '◐' : s === 'blocked' ? '⛔' : '○');

  /** 注入描述：会话主题（无则 sid/pane） */
  const agentLabel = (a) =>
    a.terminal_title_stripped || shortId(a.agent_session?.value || '') || a.pane_id || '?';

  /**
   * 注入路由：绑定目录下的 herdr 会话列表 → 目标解析（#N 定向 > /attach 固定 > 最近活跃）
   * → `herdr agent prompt` 回合级注入。返回 true 表示消息已消化（含指令/报错回执），
   * false 表示没有可用会话，调用方回退无头执行。
   */
  async function tryInject(chatId, binding, msg, prompt) {
    const agents = await herd.agentsForCwd(binding.cwd);
    if (!agents.length) return false;

    // 会话管理指令（无论有无固定目标都可执行）
    if (/^\/sessions$/i.test(prompt)) {
      await messenger
        .replyText(
          chatId,
          [
            `\`${binding.cwd}\` 下的 herdr 会话：`,
            ...agents.map(
              (a, i) => `${i + 1}. ${statusIcon(a.agent_status)} ${truncate(agentLabel(a), 30)} · ${shortId(a.agent_session?.value || '')}`,
            ),
            '',
            '发 `#序号 内容` 定向注入；`/attach 序号` 固定默认目标；`/detach` 解除固定。',
            sticky.has(chatId)
              ? `当前固定：${truncate(sticky.get(chatId).title || sticky.get(chatId).paneId, 30)}`
              : '当前未固定（默认注入最近活跃的会话）。',
          ].join('\n'),
        )
        .catch(() => {});
      return true;
    }
    const attach = prompt.match(/^\/attach\s+(\d+)$/i);
    if (attach) {
      const a = agents[Number(attach[1]) - 1];
      if (!a) {
        await messenger.replyText(chatId, `没有编号 ${attach[1]} 的会话，发 /sessions 查看。`).catch(() => {});
        return true;
      }
      sticky.set(chatId, { paneId: a.pane_id, title: agentLabel(a) });
      await messenger
        .replyText(chatId, `📌 已固定默认注入目标：${truncate(agentLabel(a), 30)}（${a.pane_id}），/detach 解除。`)
        .catch(() => {});
      return true;
    }
    if (/^\/detach$/i.test(prompt)) {
      sticky.delete(chatId);
      await messenger.replyText(chatId, '已解除固定，恢复默认（注入最近活跃的会话）。').catch(() => {});
      return true;
    }

    // 目标解析与正文剥离
    let target = null;
    let body = prompt;
    const hashMatch = prompt.match(HASH_TARGET_RE);
    if (hashMatch) {
      target = agents[Number(hashMatch[1]) - 1] || null;
      body = hashMatch[2].trim();
      if (!target) {
        await messenger.replyText(chatId, `没有编号 ${hashMatch[1]} 的会话，发 /sessions 查看。`).catch(() => {});
        return true;
      }
    } else {
      const fixed = sticky.get(chatId);
      target = (fixed && agents.find((a) => a.pane_id === fixed.paneId)) || agents[0];
    }
    if (!body) return true;

    const sid = target.agent_session?.value || '';
    const r = await herd.promptAgent(target.pane_id, body);
    if (r.blocked) {
      await messenger
        .replyText(chatId, '⛔ 目标会话正在等待权限确认（先处理群里的确认卡），本条未注入，稍后重发。')
        .catch(() => {});
      log('inject', `blocked pane=${target.pane_id}，未注入`);
      return true;
    }
    if (!r.ok) {
      await messenger.replyText(chatId, `注入失败：${truncate(r.error, 200)}`).catch(() => {});
      log('error', `注入失败 pane=${target.pane_id}:`, r.error);
      return true;
    }

    // 成功：登记防环（此 prompt 不再镜像，额度由 hook 上报消费）+ 受理回执卡 +
    // 来源消息进镜像队列（Stop 结果卡另发新卡串在来源下，标题带指令原文）
    st.markInjection(sid, body);
    const queued = target.agent_status === 'working';
    try {
      await messenger.replyCard(msg.message_id, buildTaskAckCard({ prompt: body, name: cfg.injectAckName, queued }));
    } catch (e) {
      log('error', '发送注入回执卡失败:', e.message);
    }
    st.enqueueMirror(sid, msg.message_id, body);
    log(
      'inject',
      `chat=${shortId(chatId)} pane=${target.pane_id} sid=${shortId(sid)}: ${truncate(body, 100)}`,
    );
    return true;
  }

  async function handleMessage(data) {
    // SDK 长连接派发时把 v2 事件的 event 体展平到顶层（message/sender 在 data 上），
    // 兼容带 event 包装的形状以防万一
    const evt = data?.event?.message ? data.event : data;
    const msg = evt?.message || {};
    const chatId = msg.chat_id;
    if (!chatId || seenOnce(msg.message_id)) return;
    // 防环第 1 层：本人身份镜像出去的消息会真实触发 receive 事件——直接丢弃
    if (st.isMirroredMsg(msg.message_id)) {
      log('loop', `丢弃镜像消息回环 message_id=${msg.message_id}`);
      return;
    }
    if (msg.chat_type !== 'group') return; // 只按群驱动；单聊不执行
    if (evt.sender?.sender_type && evt.sender.sender_type !== 'user') return; // 其它应用发的消息
    if (msg.message_type !== 'text') {
      log('msg', `忽略非文本消息 type=${msg.message_type} chat=${shortId(chatId)}`);
      return;
    }
    const senderId = evt.sender?.sender_id?.open_id || '';
    if (cfg.allowedOpenIds?.length && !cfg.allowedOpenIds.includes(senderId)) {
      log('warn', `忽略白名单外用户 ${senderId} 的消息`);
      return;
    }

    // 未绑定的群：@机器人 时提示如何绑定，否则静默忽略
    const binding = byChat.get(chatId);
    if (!binding) {
      if (await isBotMentioned(msg.mentions)) {
        await messenger
          .replyText(
            chatId,
            [
              '本群未绑定工作目录。cc-bridge 按「群 ↔ 目录」绑定：',
              '在本机 ~/.cc-bridge.json 的 "bindings" 数组里添加',
              `{ "chatId": "${chatId}", "cwd": "/repo/本地目录" }`,
              '然后重启 cc-bridge serve。本群 chat_id 即上面这行里的值。',
            ].join('\n'),
          )
          .catch(() => {});
        log('msg', `未绑定群 ${shortId(chatId)} @机器人，已回复配置提示`);
      }
      return;
    }

    // 「仅路由」绑定（目录不在 daemon 本机，通常对应远程机器的 workspace）：
    // 确认卡照常路由到本群，但消息无法在本机驱动 claude 执行，@ 提示说明
    if (binding.local === false) {
      if (await isBotMentioned(msg.mentions)) {
        await messenger
          .replyText(
            chatId,
            [
              `本群绑定的目录 \`${binding.cwd}\` 不在 daemon 本机，本群仅路由确认卡片，消息不驱动执行。`,
              '远程机器接入方式：在其上执行 `node cli.mjs install-hooks --url http://<daemon>:3757 --token <token>`，',
              '该机器 Claude Code 的确认请求会路由到本群；如需消息驱动执行，请把目录放到 daemon 本机再绑定。',
            ].join('\n'),
          )
          .catch(() => {});
        log('msg', `仅路由绑定群 ${shortId(chatId)} @机器人，已回复接入提示`);
      }
      return;
    }

    const prompt = extractText(msg.content);
    if (!prompt) return;

    // 防环第 3 层：断路器——同群同内容 60s 内高频重复，疑似回环，丢弃并告警一次
    const breaker = st.noteInbound(chatId, prompt);
    if (breaker.tripped) {
      log('warn', `断路器跳闸 chat=${shortId(chatId)}：同内容 60s 内重复 ≥3 次，疑似回环，丢弃`);
      if (breaker.first) {
        await messenger
          .replyText(chatId, '⚡ 疑似消息回环（同内容短时高频重复），已自动丢弃后续重复；确认终端与群双向链路正常后可重发。')
          .catch(() => {});
      }
      return;
    }

    if (RESET_RE.test(prompt)) {
      sessions.delete(chatId);
      sticky.delete(chatId);
      log('chat', `已重置会话 chat=${shortId(chatId)}`);
      await messenger
        .replyText(
          chatId,
          '🧹 已重置：丢弃无头会话线与注入目标固定。注意：注入模式不新开会话，herdr 里的会话请在终端自行重启或 /new。',
        )
        .catch(() => {});
      return;
    }

    // 注入优先：目录下有 herdr 会话 → 直接注入该会话；没有才回退无头执行
    if (cfg.chatInject !== false) {
      const injected = await tryInject(chatId, binding, msg, prompt);
      if (injected) return;
    }

    log('chat', `指令 chat=${shortId(chatId)} from=${shortId(senderId)} cwd=${binding.cwd}: ${truncate(prompt, 120)}`);
    const position = queues.get(chatId)?.waiting || 0;
    // 受理即回执（不等排队，排队为黄色变体；ackId 仅用于排队开始时刷新为「已开始」）。
    // 跑完另发结果卡串在来源消息下，回执卡保持「已开始」不改动
    let ackId = null;
    try {
      ackId = await messenger.replyCard(msg.message_id, buildTaskAckCard({ prompt, queued: position > 0 }));
    } catch (e) {
      log('error', '发送回执卡片失败:', e.message);
    }
    enqueue(chatId, () =>
      processPrompt(chatId, { cwd: binding.cwd, messageId: msg.message_id, prompt, position, ackId }));
  }

  return {
    handleMessage,
    chatForCwd,
    status: () => ({ bindings: bindings.length, busy: queues.size }),
  };
}
