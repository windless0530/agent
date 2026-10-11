import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log, truncate, shortId } from './util.mjs';
import { extractText } from './agent.mjs';
import {
  summarizeTool,
  rulePrefix,
  confirmOptions,
  buildConfirmCard,
  buildResultCard,
  buildNotifyCard,
} from './cards.mjs';

const PRETOOLUSE_ALLOW = {
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
};
const pretooluseDeny = (reason) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
});

/** PermissionRequest（v2.1.x）：恰好在 Claude Code 要弹权限对话框时触发 */
const permissionrequestAllow = (updates) => ({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: updates ? { behavior: 'allow', updatedPermissions: updates } : { behavior: 'allow' },
  },
});
const permissionrequestDeny = (reason) => ({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'deny', message: reason },
  },
});

/**
 * 从输入的 permission_suggestions 里挑「添加允许规则」的建议。
 * 官方文档：hook 可把收到的 suggestion 原样作为 updatedPermissions 回传，
 * 由 Claude Code 自己持久化 —— 即飞书上点「总是允许」等同在终端对话框里选「总是允许」。
 */
function pickAllowSuggestion(suggestions) {
  return (
    (suggestions || []).find(
      (s) =>
        s && s.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules) && s.rules.length > 0,
    ) || null
  );
}

/** 配置 allow 数组（"Bash:git" / "Edit:/src" / "WebFetch"）解析为规则 */
function parseSeedRules(allow) {
  return (allow || [])
    .map((s) => String(s))
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      if (i <= 0) return { tool: s.trim(), prefix: '' };
      return { tool: s.slice(0, i).trim(), prefix: s.slice(i + 1).trim() };
    });
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body 超过 1MB 限制'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({ __raw: raw });
      }
    });
    req.on('error', reject);
  });
}

/**
 * cc-bridge daemon 核心：HTTP 服务 + 挂起请求队列 + 免确认规则。
 * messenger 只需实现 sendCard(card)->messageId 与 updateCard(messageId, card)。
 */
export function createBridge({ cfg, messenger, chat = null }) {
  const pending = new Map(); // rid -> { res, messageId, meta, timer, settled }
  const recentResolved = new Map(); // session_id -> resolve 时间戳（抑制迟到的 permission_prompt 通知）
  const recentStop = new Map(); // session_id -> Stop 输出卡时间戳（抑制其后的 idle_prompt 空闲提醒）
  const allowRules = parseSeedRules(cfg.allow);
  const state = { ws: 'init', startedAt: Date.now(), wsStatusProvider: null };

  // ---------- 卡片路由 ----------

  /** 按 cwd 路由发卡：会话目录命中某个 binding → 发到对应群；未命中 → null（无兜底，不发） */
  function sendCardRouted(cwd, card) {
    const target = chat?.chatForCwd(cwd)?.chatId;
    if (target && messenger.sendCardTo) return messenger.sendCardTo(target, card);
    return null;
  }

  // ---------- 免确认规则 ----------

  function ruleMatches(tool, input) {
    return allowRules.some((r) => {
      if (r.tool !== tool) return false;
      if (!r.prefix) return true;
      if (tool === 'Bash') return rulePrefix('Bash', input) === r.prefix;
      const p = input?.file_path || input?.notebook_path || '';
      return p === r.prefix || p.startsWith(r.prefix + path.sep) || p.startsWith(r.prefix + '/');
    });
  }

  function addRuleFromRequest(meta) {
    const prefix = rulePrefix(meta.tool, meta.input);
    const rule = { tool: meta.tool, prefix };
    if (!allowRules.some((r) => r.tool === rule.tool && r.prefix === rule.prefix)) {
      allowRules.push(rule);
      log('rule', '新增免确认规则:', describeRule(rule));
    }
    return rule;
  }

  function describeRule(r) {
    return r.prefix
      ? r.tool === 'Bash'
        ? `${r.tool}（命令 ${r.prefix} …）`
        : `${r.tool}（目录 ${r.prefix}）`
      : `${r.tool}（全部）`;
  }

  // ---------- 挂起请求生命周期 ----------

  async function settle(rid, { act, operator, choice }) {
    const entry = pending.get(rid);
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    pending.delete(rid);
    const { res, messageId, meta } = entry;
    if (meta.session) recentResolved.set(meta.session, Date.now());
    const DENY_REASON = '用户在飞书上拒绝了该操作';
    const isPR = meta.event === 'permissionrequest';

    // 点了 suggest/auto 选项 → 该选项的 updates 数组原样作为 updatedPermissions 回传
    // （原生持久化/切模式，等同终端选同一选项）；旧三键卡片的「总是允许」仍走兼容路径
    let nativeUpdate = null;
    if (isPR) {
      if (choice?.updates?.length) nativeUpdate = choice.updates;
      else if (act === 'always') {
        const u = pickAllowSuggestion(meta.suggestions);
        if (u) nativeUpdate = [u];
      }
    }
    if (nativeUpdate) meta.nativePersist = true;

    // 先回复 hook（Claude Code 侧立即继续），再异步刷新卡片
    if (act === 'deny') {
      sendJson(res, 200, isPR ? permissionrequestDeny(DENY_REASON) : pretooluseDeny(DENY_REASON));
    } else if (act === 'allow' || act === 'always') {
      sendJson(res, 200, isPR ? permissionrequestAllow(nativeUpdate) : PRETOOLUSE_ALLOW);
    } else if (act === 'timeout' || act === 'local-allow' || act === 'local') {
      // fail-open：无决策返回，Claude Code 继续走它本地已完成的流程
      sendJson(res, 200, '');
    } else {
      // cancel：客户端连接已断开，无需回复
    }
    log('resolve', rid, meta.tool, `act=${act}`, choice?.label || '', operator?.open_id || '');

    const resultMeta = { ...meta };
    if (choice) resultMeta.choice = choice;
    if (act === 'always') resultMeta.summary = { ...meta.summary, __ruleHint: describeRule(ruleOf(meta)) };
    messenger
      .updateCard(messageId, buildResultCard(resultMeta, { act, operator }))
      .catch((e) => log('error', '更新结果卡片失败:', e.message));
  }

  function ruleOf(meta) {
    return { tool: meta.tool, prefix: rulePrefix(meta.tool, meta.input) };
  }

  // ---------- 终端本地作答感知 ----------
  // Claude Code 不会因为用户在终端本地回答了确认框而通知 hook（hook 进程也不被杀），
  // 飞书卡片只能靠以下事件推断「已在本地解决」：
  //   PostToolUse：同一会话同工具同参数的工具确实执行了 → 本地允许（严格匹配，避免
  //               并行同工具任务误伤；每次执行只结算一条挂起）
  //   Stop：回合结束 → 该会话剩余挂起确认一律视为已在本地处理（允许/拒绝/Esc 兜底）
  // 结算时向仍挂起的 hook 连接回空体（fail-open），hook 进程随即退出，卡片刷为结果态。

  /** 键序无关的稳定 JSON 序列化，用于 tool_input 等值比较 */
  function canonicalJson(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }

  function settleLocalFromPostToolUse(payload) {
    const sid = payload.session_id;
    if (!sid) return 0;
    const match = [...pending.entries()].find(
      ([, e]) =>
        !e.settled &&
        e.meta.session === sid &&
        e.meta.tool === payload.tool_name &&
        canonicalJson(e.meta.input) === canonicalJson(payload.tool_input),
    );
    if (!match) return 0;
    settle(match[0], { act: 'local-allow' });
    return 1;
  }

  function settleLocalFromStop(payload) {
    const sid = payload.session_id;
    if (!sid) return 0;
    const matches = [...pending.entries()].filter(([, e]) => !e.settled && e.meta.session === sid);
    for (const [rid] of matches) settle(rid, { act: 'local' });
    return matches.length;
  }

  /** 从会话 transcript（JSONL）取最后一条 assistant 文本消息，即该回合的最终输出。
   *  Stop 触发时 transcript 已写完整回合；从后向前找，跳过纯 tool_use / 坏行。
   *  远程机器的本地路径读不到时返回空（退化为通用文案）。 */
  function lastAssistantText(transcriptPath) {
    if (!transcriptPath || typeof transcriptPath !== 'string') return '';
    try {
      const lines = fs.readFileSync(transcriptPath, 'utf8').trimEnd().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        let entry;
        try {
          entry = JSON.parse(lines[i]);
        } catch {
          continue; // 半行 / 坏行
        }
        if (entry?.type !== 'assistant') continue;
        const blocks = entry.message?.content;
        const texts = Array.isArray(blocks)
          ? blocks.filter((b) => b?.type === 'text' && b.text).map((b) => b.text)
          : typeof blocks === 'string' && blocks
            ? [blocks]
            : [];
        if (texts.length) return texts.join('\n').trim();
      }
    } catch {
      // 路径不存在（远程机器）/ 无权限 → 空串
    }
    return '';
  }


  // ---------- hook 事件处理 ----------

  async function handleConfirmation(req, res, payload, event = 'pretooluse') {
    const tool = payload.tool_name || 'Unknown';
    const input = payload.tool_input || {};

    if (ruleMatches(tool, input)) {
      log('auto-allow', tool, truncate(JSON.stringify(input), 120));
      return sendJson(res, 200, event === 'permissionrequest' ? permissionrequestAllow() : PRETOOLUSE_ALLOW);
    }

    if (pending.size >= cfg.maxPending) {
      log('busy', `挂起请求已达上限 ${cfg.maxPending}，${tool} 放行走本地流程`);
      return sendJson(res, 200, '');
    }

    const summary = summarizeTool(tool, input);
    // 只保留结构合法的条目，与卡片/回传共用同一数组
    const suggestions = (Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions : [])
      .filter((s) => s && typeof s === 'object' && typeof s.type === 'string');
    // 与终端确认框一致的选项（Yes / 合并建议行 / 可选 auto 行 / No）；按钮与点击处理共用
    const options = confirmOptions({ suggestions, cwd: payload.cwd, permissionMode: payload.permission_mode });
    const rid = crypto.randomUUID();
    let messageId;
    try {
      messageId = await sendCardRouted(
        payload.cwd,
        buildConfirmCard({
          rid,
          tool,
          summary,
          cwd: payload.cwd,
          session: payload.session_id,
          timeoutSec: cfg.timeoutSec,
          suggestions,
          permissionMode: payload.permission_mode,
        }),
      );
    } catch (e) {
      log('error', '发送确认卡片失败，放行走本地流程:', e.message);
      return sendJson(res, 200, '');
    }
    if (!messageId) {
      log('route', `cwd ${payload.cwd || '(空)'} 未命中任何 binding，不发确认卡，放行走本地流程`);
      return sendJson(res, 200, '');
    }
    log('card', `确认卡 ${rid.slice(0, 8)} message_id=${messageId}`);

    const entry = {
      res,
      messageId,
      settled: false,
      timer: null,
      meta: {
        rid,
        tool,
        input,
        summary,
        cwd: payload.cwd,
        session: payload.session_id,
        event,
        suggestions,
        options,
      },
    };
    pending.set(rid, entry);
    log('pending', rid, tool, `（当前 ${pending.size} 个待确认）`);
    entry.timer = setTimeout(() => settle(rid, { act: 'timeout' }), cfg.timeoutSec * 1000);
    res.on('close', () => {
      if (!entry.settled) settle(rid, { act: 'cancel' });
    });
  }

  async function handleAlertEvent(req, res, payload, event) {
    if (event === 'stop') {
      // 回合结束：该会话仍挂起的确认视为已在终端本地处理（允许/拒绝/Esc 的统一兜底）
      const n = settleLocalFromStop(payload);
      if (n) log('resolve', `Stop：会话 ${shortId(payload.session_id)} 的 ${n} 个挂起确认已在终端处理`);
      // 飞书消息驱动的会话：结果由聊天里的回复卡片给出，Stop 卡纯重复
      if (payload.__fromChat === 1) {
        return sendJson(res, 200, '');
      }
      // 「任务完成」卡（notifyStop: false 关闭，默认开）：内容为该回合最终输出
      // （读 transcript 最后一条 assistant 文本），读不到时退化为通用文案
      if (cfg.notifyStop !== false) {
        const output = lastAssistantText(payload.transcript_path);
        if (payload.session_id) recentStop.set(payload.session_id, Date.now());
        try {
          const messageId = await sendCardRouted(
            payload.cwd,
            buildNotifyCard({
              title: '🏁 Claude Code 已完成，等待输入',
              message: output || '回合结束，已在终端等待输入。',
              cwd: payload.cwd,
              severity: 'success',
            }),
          );
          if (messageId) {
            log('card', `Stop 输出卡 message_id=${messageId}${output ? '' : '（未读到 transcript，通用文案）'}`);
          } else {
            log('route', `cwd ${payload.cwd || '(空)'} 未命中任何 binding，跳过 Stop 输出卡`);
          }
        } catch (e) {
          log('error', '发送 Stop 输出卡失败:', e.message);
        }
      }
      return sendJson(res, 200, '');
    }
    if (event === 'notification') {
      // idle_prompt（"Claude is waiting for your input"）：刚发过 Stop 输出卡的会话
      // 已在等输入且卡片带走了最终回复，10 分钟内抑制；消息驱动的会话同理（结果卡已回复）
      const idle =
        payload.notification_type === 'idle_prompt' ||
        /waiting for your input/i.test(String(payload.message || ''));
      const stoppedRecently =
        Date.now() - (recentStop.get(payload.session_id) || 0) < 600_000;
      if (idle && (payload.__fromChat === 1 || (payload.session_id && stoppedRecently))) {
        log('notify', `抑制 idle_prompt 通知（会话 ${shortId(payload.session_id || '')} 已有回合输出卡）`);
        return sendJson(res, 200, '');
      }
      // permission_prompt 类通知在确认框闲置 ~6s 后才触发：此时若该会话已有挂起的
      // 交互确认卡（cc-bridge 已接管审批）或刚被点击解决，纯通知卡纯属重复打扰，抑制；
      // 若两者皆无（发卡失败/并发超限回退本地确认），保留通知作为手机端唯一提醒。
      if (payload.notification_type === 'permission_prompt') {
        const recently = Date.now() - (recentResolved.get(payload.session_id) || 0) < 60_000;
        const hasPending = [...pending.values()].some((e) => e.meta.session === payload.session_id);
        if (hasPending || recently) {
          log('notify', `抑制 permission_prompt 通知（会话 ${String(payload.session_id || '').slice(0, 8)} 已由确认卡接管）`);
          return sendJson(res, 200, '');
        }
      }
    }
    const title = '🔔 Claude Code 通知';
    const message =
      payload.message || payload.__raw || payload.title || '(无内容)';
    try {
      const messageId = await sendCardRouted(
        payload.cwd,
        buildNotifyCard({
          title,
          message,
          cwd: payload.cwd,
          severity: 'info',
        }),
      );
      if (messageId) log('card', `通知卡 ${event} message_id=${messageId}`);
      else log('route', `cwd ${payload.cwd || '(空)'} 未命中任何 binding，跳过 ${event} 通知卡`);
    } catch (e) {
      log('error', '发送通知卡片失败:', e.message);
    }
    sendJson(res, 200, '');
  }

  async function handleNotify(req, res, payload) {
    if (!payload.title && !payload.body && !payload.message) {
      return sendJson(res, 400, { error: '需要 title 或 body 字段' });
    }
    const messageId = await sendCardRouted(
      payload.cwd,
      buildNotifyCard({
        title: payload.title || '📢 cc-bridge 消息',
        message: payload.body || payload.message,
        cwd: payload.cwd,
        severity: payload.severity || 'info',
      }),
    );
    if (!messageId) {
      return sendJson(res, 400, { error: `cwd ${payload.cwd || '(空)'} 未命中任何 binding，无发送目标` });
    }
    sendJson(res, 200, { ok: true, message_id: messageId });
  }

  // ---------- 飞书回调 ----------

  async function handleCardAction(data) {
    // behaviors 回传的 value 一般是对象，个别回调路径会序列化成 JSON 字符串
    const raw = data?.action?.value ?? {};
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const operator = {
      open_id: data?.operator?.open_id,
      user_id: data?.operator?.user_id,
      name: data?.operator?.name,
    };
    const { rid, act } = value;
    if (!rid || !act) {
      log('card-cb', '回调缺少 rid/act，忽略:', truncate(JSON.stringify(value), 120));
      return;
    }

    if (cfg.allowedOpenIds?.length && !cfg.allowedOpenIds.includes(operator.open_id)) {
      log('warn', `忽略未授权用户 ${operator.open_id} 的卡片点击`);
      return;
    }
    if (!pending.has(rid)) {
      log('card-cb', `忽略点击：${rid.slice(0, 8)} 不在待确认队列（已解决/超时后的重复点击）`);
      return;
    }

    const { meta } = pending.get(rid);
    if (act === 'always') addRuleFromRequest(meta);

    // suggest / auto：点的是与终端确认框对应的选项，其 updates 原样回传给 Claude Code
    let choice = null;
    if (act === 'suggest' || act === 'auto') {
      const opt = (meta.options || []).find((o) => o.act === act);
      if (!opt?.updates?.length) return; // 该选项不存在（数据异常），忽略本次点击
      choice = { label: opt.label, updates: opt.updates };
    }
    const normAct =
      act === 'deny'
        ? 'deny'
        : act === 'always'
          ? 'always'
          : act === 'allow' || act === 'suggest' || act === 'auto'
            ? 'allow'
            : 'timeout';
    await settle(rid, { act: normAct, operator, choice });
  }

  async function handleInboundMessage(data) {
    // SDK 长连接派发时把 v2 事件的 event 体展平到顶层（message/sender 在 data 上）
    const evt = data?.event?.message ? data.event : data;
    const msg = evt?.message || {};
    const senderId = evt?.sender?.sender_id || {};
    const chatId = msg.chat_id;
    log('msg', `收到飞书消息 open_id=${senderId.open_id || '?'} chat_id=${chatId || '?'}`);

    // 「绑定」引导：精确匹配，避免劫持含「绑定」字样的正常指令
    const text = extractText(msg.content);
    if (/^(绑定|\/?bind)$/i.test(text) && chatId) {
      await messenger.replyText(
        chatId,
        [
          'cc-bridge 绑定信息：',
          `你的 open_id: ${senderId.open_id}`,
          `本会话 chat_id: ${chatId}`,
          '在 ~/.cc-bridge.json 的 "bindings" 数组里添加',
          `{ "chatId": "${chatId}", "cwd": "<repo 本地目录>" }`,
          '并重启 cc-bridge serve，本群消息即等价于在该目录的终端里输入 claude 指令。',
        ].join('\n'),
      );
      log('msg', '已回复绑定信息');
      return;
    }

    // 其余消息交给聊天驱动模块（bindings 绑定的群 → 等价终端输入）
    if (chat) {
      try {
        await chat.handleMessage(data);
      } catch (e) {
        log('error', '处理消息指令失败:', e.message);
      }
    } else {
      log('msg', `忽略消息（chatEnabled=false）chat=${shortId(chatId || '')}`);
    }
  }

  // ---------- HTTP 路由 ----------

  function authOk(req) {
    if (!cfg.token) return true;
    const header = req.headers.authorization || '';
    return header === `Bearer ${cfg.token}`;
  }

  function sendJson(res, code, obj) {
    if (res.writableEnded || res.destroyed) return;
    const body = obj === '' ? '' : JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        const wsStatus = state.wsStatusProvider?.() || null;
        return sendJson(res, 200, {
          ok: true,
          // 优先用 SDK 实时状态（connected/reconnecting/failed + 重连计数），
          // 标志位只是回退——僵尸连接时标志位仍显示 connected，具有误导性
          ws: wsStatus ? wsStatus.state : state.ws,
          ...(wsStatus ? { wsDetail: wsStatus } : {}),
          pending: pending.size,
          rules: allowRules.map(describeRule),
          chat: chat ? chat.status() : { enabled: false },
          uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
        });
      }
      if (!authOk(req)) return sendJson(res, 401, { error: 'unauthorized' });

      if (req.method === 'POST' && url.pathname.startsWith('/hook/')) {
        const payload = await readBody(req);
        const event = url.pathname.slice('/hook/'.length).toLowerCase();
        if (event === 'pretooluse' || event === 'permissionrequest') {
          return await handleConfirmation(req, res, payload, event);
        }
        if (event === 'posttooluse') {
          // 工具已执行 = 对应确认在终端被本地允许：结算挂起卡（不发通知卡）
          const n = settleLocalFromPostToolUse(payload);
          if (n) log('resolve', `PostToolUse：${payload.tool_name} 已在终端允许，结算挂起确认`);
          return sendJson(res, 200, '');
        }
        if (['notification', 'stop', 'sessionstart'].includes(event)) {
          return await handleAlertEvent(req, res, payload, event);
        }
        return sendJson(res, 404, { error: `unknown hook event: ${event}` });
      }

      if (req.method === 'POST' && url.pathname === '/notify') {
        return await handleNotify(req, res, await readBody(req));
      }
      if (req.method === 'GET' && url.pathname === '/rules') {
        return sendJson(res, 200, { rules: allowRules });
      }
      if (req.method === 'DELETE' && url.pathname === '/rules') {
        allowRules.length = 0;
        log('rule', '已清空全部免确认规则');
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      log('error', req.method, url.pathname, e.message);
      if (!res.writableEnded) sendJson(res, 500, { error: String(e.message) });
    }
  });

  return {
    server,
    handleCardAction,
    handleInboundMessage,
    setWsState: (s) => {
      state.ws = s;
    },
    setWsStatusProvider: (fn) => {
      state.wsStatusProvider = fn;
    },
    pendingSize: () => pending.size,
    rules: () => allowRules,
  };
}
