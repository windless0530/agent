import path from 'node:path';
import { spawn } from 'node:child_process';
import { log, truncate, shortId } from './util.mjs';
import { buildTaskResultCard } from './cards.mjs';
import { agentsForCwd, promptAgent, sendKeys, listPanes, startAgentInPane } from './herdr.mjs';
import { createBridgeState } from './state.mjs';

/** 文本消息正文里的 @ 占位符（@_user_N），还原指令时要剥掉 */
const MENTION_TOKEN = /@_user_\d+/g;
/** 控制命令：丢弃当前会话，下一条消息从新会话开始 */
const RESET_RE = /^(新会话|\/new|\/reset|reset|new)$/i;
/** 注入寻址：#3 内容 → 定向注入 /sessions 列表里的 3 号会话 */
const HASH_TARGET_RE = /^#(\d+)\s+(.+)$/;
/** /restart 指令：/restart [new|paneId]（/重启 等价） */
const RESTART_RE = /^\/(?:restart|重启)(?:\s+(\S+))?$/i;
/** herdr pane id 形态：w2:p1 */
const PANE_ID_RE = /^[a-z]\d+:p\d+$/i;

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
 * `herdr agent prompt` 回合级注入该会话——群与终端共享同一条会话线，受理给来源消息
 * 加 Get 表态、Stop 时另发结果新卡。busy 中注入的消息默认立即补 ctrl+enter 提交
 * （打断式 steering，即发即生效；`排队 ` 前缀改为等当前回合结束），blocked（卡在
 * 确认框）拒绝注入。没有可用会话才回退老行为：每群串行跑无头
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
  const herd = herdr || { agentsForCwd, promptAgent, sendKeys, listPanes, startAgentInPane };
  let botOpenIdPromise = null;
  // 由 bridge 注入的探针：该会话是否还有挂起的确认卡（blocked 提示文案按卡的死活分流）。
  // chat runner 先于 bridge 创建，只能事后回填（同 server.mjs setWsStatusProvider 模式）。
  let pendingProbe = null;

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

  async function processPrompt(chatId, { cwd, messageId, prompt }) {
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
      // 结果另发新卡串在来源消息下（受理 Get 表态已加在来源消息上，不再发受理卡）
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

  /** pane/agent 的 cwd 是否落在绑定目录（含子目录）下 */
  const cwdUnder = (cwd, base) => {
    const c = String(cwd || '').replace(/\/+$/, '');
    const b = String(base || '').replace(/\/+$/, '');
    return !!c && !!b && (c === b || c.startsWith(b + '/'));
  };

  /**
   * /restart：在绑定目录下找 claude 已退出的 pane（pane 还在、agent 字段消失、
   * cwd 保留），用 `herdr agent start` 在该 pane 重新拉起交互式 claude——手机端
   * 恢复「死了」的会话（/exit、崩溃后），多天无人值守的最后一环。
   * 默认 --continue 恢复该目录最近一条会话；`/restart new` 全新会话；
   * 多个候选时用 `/restart <paneId>` 指定。herdr 自带「pane 必须在 shell 提示符」
   * 校验，不会把命令敲进运行中的程序。
   */
  async function handleRestart(chatId, binding, arg) {
    const reply = (text) => messenger.replyText(chatId, text).catch(() => {});
    if (arg && arg !== 'new' && !PANE_ID_RE.test(arg)) {
      await reply('用法：`/restart`（恢复最近会话）· `/restart new`（全新会话）· `/restart w2:p1`（指定 pane）');
      return;
    }
    let panes = [];
    try {
      panes = await herd.listPanes();
    } catch {
      panes = [];
    }
    // agent 字段缺失 = pane 没在跑 agent（claude 退出后的形态；普通 shell pane 同形，
    // 都可拉起）。运行中的 pane 绝不碰。
    const dead = panes.filter((p) => !p.agent && cwdUnder(p.cwd, binding.cwd));

    let target = null;
    if (arg && PANE_ID_RE.test(arg)) {
      target = dead.find((p) => p.pane_id.toLowerCase() === arg.toLowerCase()) || null;
      if (!target) {
        const occupied = panes.find((p) => p.pane_id.toLowerCase() === arg.toLowerCase());
        await reply(
          occupied?.agent
            ? `\`${occupied.pane_id}\` 上有运行中的会话（${statusIcon(occupied.agent_status)} ${truncate(agentLabel(occupied), 24)}），无需重启。`
            : `\`${arg}\` 不在 \`${binding.cwd}\` 下或不存在；发 /restart 查看，或 /sessions 确认 pane id。`,
        );
        return;
      }
    } else if (dead.length === 0) {
      await reply(
        `\`${binding.cwd}\` 下没有可重启的 pane（claude 退出后 pane 会留在原地等待 /restart）。\n在跑的会话发 /sessions 查看；无头会话线用「新会话」重置。`,
      );
      return;
    } else if (dead.length > 1) {
      await reply(
        [
          `\`${binding.cwd}\` 下有 ${dead.length} 个可重启的 pane，用 \`/restart <pane>\` 指定：`,
          ...dead.map((p) => `- \`${p.pane_id}\` · ${truncate(p.terminal_title_stripped || p.cwd || '', 30)}`),
        ].join('\n'),
      );
      return;
    } else {
      target = dead[0];
    }

    const fresh = arg === 'new';
    const args = fresh ? [] : ['--continue'];
    await reply(
      `⏳ 正在 \`${target.pane_id}\` 拉起 claude（${fresh ? '全新会话' : '--continue 恢复该目录最近会话'}），就绪约需十几秒…`,
    );
    const r = await herd.startAgentInPane(target.pane_id, {
      name: `ccbridge_${String(target.pane_id).toLowerCase().replace(/[^a-z0-9_]/g, '_')}`,
      args,
    });
    if (r.ok) {
      const sid = r.agent?.agent_session?.value || '';
      await reply(
        `✅ \`${target.pane_id}\` 已拉起 claude${fresh ? '' : '（已接续原会话上下文）'}：${shortId(sid)}\n之后的消息照常注入；确认卡按目录路由回本群。`,
      );
      log('restart', `pane=${target.pane_id} sid=${shortId(sid)}${fresh ? ' [new]' : ' [continue]'}`);
      return;
    }
    // agent_not_ready：claude 已启动但停在确认界面（未受信目录的信任确认等），
    // 进程活着、远程点不了——如实说明，用户可回终端看一眼或重试
    await reply(
      `⚠️ \`${target.pane_id}\` 拉起失败：${truncate(r.error, 200)}\n` +
        (/agent_not_ready|blocked/.test(r.error)
          ? 'claude 已启动但停在确认界面（如目录信任确认），需到终端确认一次；pane 未损坏，可稍后重试 /restart。'
          : '常见原因：pane 不在 shell 提示符（有程序在跑）。可回终端处理后再试。'),
    );
    log('error', `restart 失败 pane=${target.pane_id}:`, r.error);
  }

  /**
   * 注入路由：绑定目录下的 herdr 会话列表 → 目标解析（#N 定向 > /attach 固定 > 最近活跃）
   * → `herdr agent prompt` 回合级注入。返回 true 表示消息已消化（含指令回复/报错提示），
   * false 表示没有可用会话，调用方回退无头执行。
   */
  async function tryInject(chatId, binding, msg, prompt) {
    const agents = await herd.agentsForCwd(binding.cwd);
    if (!agents.length) return false;

    // 会话管理指令（无论有无固定目标都可执行）
    if (/^\/sessions$/i.test(prompt)) {
      // 顺带列出已退出的 pane（claude 死掉后 agent 字段消失、pane 留在原地），
      // 手机端好发现「哪个会话没了、该怎么拉回来」
      let deadPanes = [];
      try {
        deadPanes = (await herd.listPanes()).filter((p) => !p.agent && cwdUnder(p.cwd, binding.cwd));
      } catch { /* herdr 不可用时略过 */ }
      await messenger
        .replyText(
          chatId,
          [
            `\`${binding.cwd}\` 下的 herdr 会话：`,
            ...agents.map(
              (a, i) => `${i + 1}. ${statusIcon(a.agent_status)} ${truncate(agentLabel(a), 30)} · ${shortId(a.agent_session?.value || '')}`,
            ),
            ...(deadPanes.length
              ? ['', '💤 已退出（/restart 恢复）：', ...deadPanes.map((p) => `- \`${p.pane_id}\` · ${truncate(p.terminal_title_stripped || p.cwd || '', 30)}`)]
              : []),
            '',
            '发 `#序号 内容` 定向注入；`/attach 序号` 固定默认目标；`/detach` 解除固定。',
            '会话执行中注入默认立即执行（打断当前回合）；`排队 内容` 改为排队等它结束。',
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

    // 「排队 」前缀：busy 中不打断当前回合，排队等它结束自动执行（默认是立即打断）
    let queueMode = false;
    const queuedMatch = body.match(/^排队\s+(\S[\s\S]*)$/);
    if (queuedMatch) {
      queueMode = true;
      body = queuedMatch[1].trim();
    }

    const sid = target.agent_session?.value || '';
    const r = await herd.promptAgent(target.pane_id, body);
    if (r.blocked) {
      // 指引按卡片的死活给：还挂着（确认/提问/审批卡）→ 点卡即可；都不在（hook 早被
      // Claude Code 收走或观察未启动）→ 远程无法代答，只能回终端处理
      const live = sid && pendingProbe ? pendingProbe(sid) : false;
      const hint = live
        ? '先处理群里的卡片（确认/提问）'
        : '卡片已超时失效，远程无法代答，需回终端处理';
      await messenger
        .replyText(chatId, `⛔ 目标会话正在等待交互确认（${hint}），本条未注入，稍后重发。`)
        .catch(() => {});
      log('inject', `blocked pane=${target.pane_id}（卡片${live ? '在挂' : '已失效'}），未注入`);
      return true;
    }
    if (!r.ok) {
      await messenger.replyText(chatId, `注入失败：${truncate(r.error, 200)}`).catch(() => {});
      log('error', `注入失败 pane=${target.pane_id}:`, r.error);
      return true;
    }

    // 成功：登记防环（此 prompt 不再镜像，额度由 hook 上报消费）+ 给来源消息加
    // Get 受理表态（不再另发「已开始」回执卡）+ 来源消息进镜像队列（Stop 结果卡
    // 另发新卡串在来源下，标题带指令原文）
    st.markInjection(sid, body);
    // busy 中 herdr 只把消息敲进 CLI 输入框排队（"ctrl+enter to send now"），不会立刻
    // 执行——默认补一发 ctrl+enter 立即提交（打断式 steering，进行中的工具正常跑完），
    // 手机端即发即生效；「排队 」前缀跳过（回合结束自动发出）。提交可能触发
    // UserPromptSubmit hook，markInjection 必须在此之前登记完
    const status = r.agent?.agent_status || target.agent_status;
    if (status === 'working' && !queueMode) {
      const sent = await herd.sendKeys(target.pane_id, 'ctrl+enter');
      log('inject', `send-now pane=${target.pane_id} ctrl+enter=${sent ? 'ok' : '失败（留在队列）'}`);
    }
    try {
      await messenger.addReaction(msg.message_id, 'Get');
    } catch (e) {
      log('error', '添加注入受理 Get 表态失败:', e.message);
    }
    st.enqueueMirror(sid, msg.message_id, body);
    log(
      'inject',
      `chat=${shortId(chatId)} pane=${target.pane_id} sid=${shortId(sid)}${queueMode ? ' [排队]' : ''}: ${truncate(body, 100)}`,
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
          '🧹 已重置：丢弃无头会话线与注入目标固定。pane 里已退出的会话用 /restart 恢复，无需回终端。',
        )
        .catch(() => {});
      return;
    }

    // /restart 不依赖存活会话（它的服务对象恰恰是死掉的），必须放在注入路由之前
    const restart = prompt.match(RESTART_RE);
    if (restart) {
      await handleRestart(chatId, binding, restart[1]);
      return;
    }

    // 注入优先：目录下有 herdr 会话 → 直接注入该会话；没有才回退无头执行
    if (cfg.chatInject !== false) {
      const injected = await tryInject(chatId, binding, msg, prompt);
      if (injected) return;
    }

    log('chat', `指令 chat=${shortId(chatId)} from=${shortId(senderId)} cwd=${binding.cwd}: ${truncate(prompt, 120)}`);
    // 受理即给来源消息加 Get 表态（不等排队，失败只记日志）；跑完另发结果卡串在来源消息下
    try {
      await messenger.addReaction(msg.message_id, 'Get');
    } catch (e) {
      log('error', '添加受理 Get 表态失败:', e.message);
    }
    enqueue(chatId, () => processPrompt(chatId, { cwd: binding.cwd, messageId: msg.message_id, prompt }));
  }

  return {
    handleMessage,
    chatForCwd,
    setPendingProbe: (fn) => {
      pendingProbe = fn;
    },
    status: () => ({ bindings: bindings.length, busy: queues.size }),
  };
}
