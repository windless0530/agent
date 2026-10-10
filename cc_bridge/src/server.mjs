import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { log, truncate } from './util.mjs';
import {
  summarizeTool,
  rulePrefix,
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
export function createBridge({ cfg, messenger }) {
  const pending = new Map(); // rid -> { res, messageId, meta, timer, settled }
  const allowRules = parseSeedRules(cfg.allow);
  const state = { ws: 'init', startedAt: Date.now() };

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

  async function settle(rid, { act, operator }) {
    const entry = pending.get(rid);
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    pending.delete(rid);
    const { res, messageId, meta } = entry;
    const DENY_REASON = '用户在飞书上拒绝了该操作';
    const isPR = meta.event === 'permissionrequest';

    // 先回复 hook（Claude Code 侧立即继续），再异步刷新卡片
    if (act === 'deny') {
      sendJson(res, 200, isPR ? permissionrequestDeny(DENY_REASON) : pretooluseDeny(DENY_REASON));
    } else if (act === 'allow' || act === 'always') {
      const nativeUpdate = act === 'always' && isPR ? pickAllowSuggestion(meta.suggestions) : null;
      if (nativeUpdate) meta.nativePersist = true;
      sendJson(res, 200, isPR ? permissionrequestAllow(nativeUpdate ? [nativeUpdate] : undefined) : PRETOOLUSE_ALLOW);
    } else if (act === 'timeout') {
      sendJson(res, 200, ''); // fail-open：回退 Claude Code 本地确认
    } else {
      // cancel：客户端连接已断开，无需回复
    }
    log('resolve', rid, meta.tool, `act=${act}`, operator?.open_id || '');

    const resultMeta = { ...meta };
    if (act === 'always') resultMeta.summary = { ...meta.summary, __ruleHint: describeRule(ruleOf(meta)) };
    messenger
      .updateCard(messageId, buildResultCard(resultMeta, { act, operator }))
      .catch((e) => log('error', '更新结果卡片失败:', e.message));
  }

  function ruleOf(meta) {
    return { tool: meta.tool, prefix: rulePrefix(meta.tool, meta.input) };
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
    const rid = crypto.randomUUID();
    let messageId;
    try {
      messageId = await messenger.sendCard(
        buildConfirmCard({
          rid,
          tool,
          summary,
          cwd: payload.cwd,
          session: payload.session_id,
          timeoutSec: cfg.timeoutSec,
        }),
      );
    } catch (e) {
      log('error', '发送确认卡片失败，放行走本地流程:', e.message);
      return sendJson(res, 200, '');
    }

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
        suggestions: payload.permission_suggestions || [],
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
    const isStop = event === 'stop';
    const title = isStop ? '🏁 Claude Code 已完成任务' : '🔔 Claude Code 通知';
    const message =
      payload.message || payload.__raw || payload.title || '(无内容)';
    try {
      await messenger.sendCard(
        buildNotifyCard({
          title,
          message,
          cwd: payload.cwd,
          severity: isStop ? 'success' : 'info',
        }),
      );
    } catch (e) {
      log('error', '发送通知卡片失败:', e.message);
    }
    sendJson(res, 200, '');
  }

  async function handleNotify(req, res, payload) {
    if (!payload.title && !payload.body && !payload.message) {
      return sendJson(res, 400, { error: '需要 title 或 body 字段' });
    }
    const messageId = await messenger.sendCard(
      buildNotifyCard({
        title: payload.title || '📢 cc-bridge 消息',
        message: payload.body || payload.message,
        cwd: payload.cwd,
        severity: payload.severity || 'info',
      }),
    );
    sendJson(res, 200, { ok: true, message_id: messageId });
  }

  // ---------- 飞书回调 ----------

  async function handleCardAction(data) {
    const value = data?.action?.value || {};
    const operator = {
      open_id: data?.operator?.open_id,
      user_id: data?.operator?.user_id,
      name: data?.operator?.name,
    };
    const { rid, act } = value;
    if (!rid || !act) return;

    if (cfg.allowedOpenIds?.length && !cfg.allowedOpenIds.includes(operator.open_id)) {
      log('warn', `忽略未授权用户 ${operator.open_id} 的卡片点击`);
      return;
    }
    if (!pending.has(rid)) return; // 重复回调 / 迟到的点击

    if (act === 'always') addRuleFromRequest(pending.get(rid).meta);
    await settle(rid, { act: ['allow', 'always', 'deny'].includes(act) ? act : 'timeout', operator });
  }

  async function handleInboundMessage(data) {
    const msg = data?.event?.message || {};
    const senderId = data?.event?.sender?.sender_id || {};
    const chatId = msg.chat_id;
    log('msg', `收到飞书消息 open_id=${senderId.open_id || '?'} chat_id=${chatId || '?'}`);

    let text = '';
    try {
      text = JSON.parse(msg.content || '{}').text || '';
    } catch { /* 非文本消息 */ }

    if (/绑定|bind/i.test(text) && chatId) {
      await messenger.replyText(
        chatId,
        [
          'cc-bridge 绑定信息：',
          `你的 open_id: ${senderId.open_id}`,
          `本会话 chat_id: ${chatId}`,
          '将其中一个填入 ~/.cc-bridge.json 的 "peer" 字段后重启 cc-bridge serve 即可。',
        ].join('\n'),
      );
      log('msg', '已回复绑定信息');
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
        return sendJson(res, 200, {
          ok: true,
          ws: state.ws,
          pending: pending.size,
          rules: allowRules.map(describeRule),
          peer: cfg.peer && !/填入/.test(cfg.peer) ? 'configured' : 'missing',
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
        if (['notification', 'stop', 'posttooluse', 'sessionstart'].includes(event)) {
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
    pendingSize: () => pending.size,
    rules: () => allowRules,
  };
}
