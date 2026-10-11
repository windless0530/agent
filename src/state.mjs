/**
 * daemon 内跨模块共享的桥接状态：镜像队列 + 防回环三件套。
 * 双向打通后消息可能在「群 → CLI → 群 → CLI …」无限往返，防环按三层设防：
 *   1. mirroredMsgIds：以用户本人身份镜像出去的消息 id（此类消息会真实触发 receive
 *      事件）——收到事件先查表，命中即丢弃（主防线，确定性判据）。
 *   2. injections：daemon 注入到会话的 prompt（sid+内容，计数制）——该会话
 *      UserPromptSubmit hook 上报时命中一次扣一次额度（注入内容本就来自群里，镜像
 *      回去即回环）。注入自己的上报消费掉额度后，用户在终端手输同样内容不会再被
 *      误吞（非消费式标记会把 5 分钟内的手输重复内容一并误判为注入）。
 *   3. 断路器：同群同内容短窗高频出现 → 疑似回环，丢弃并告警一次（兜前两层失效）。
 * 所有条目带 TTL，惰性清扫（每次访问顺带检查上次清扫时间），无常驻定时器。
 */

const MIRROR_TTL_MS = 30 * 60_000; // 镜像消息 id 溯源窗口（回环只发生在发出后数秒内，宽裕即可）
const INJECT_TTL_MS = 5 * 60_000; // 注入标记窗口（覆盖 hook 上报延迟即可）
const BREAKER_WINDOW_MS = 60_000; // 断路器统计窗口
const BREAKER_TRIP_AT = 3; // 窗口内同内容出现次数达到即跳闸
const SWEEP_INTERVAL_MS = 60_000;

function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function createBridgeState() {
  const mirrorQueue = new Map(); // session_id -> [{ id, label }] Stop 结果新卡按序串在来源下
  const mirroredMsgIds = new Map(); // message_id -> expiresAt
  const injections = new Map(); // `${sid}:${hash}` -> { n, expiresAt }（一次注入一份额度）
  const breaker = new Map(); // `${chatId}:${hash}` -> [ts…]
  let lastSweep = 0;

  function sweep(now) {
    if (now - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = now;
    for (const [k, t] of mirroredMsgIds) if (t < now) mirroredMsgIds.delete(k);
    for (const [k, e] of injections) if (e.expiresAt < now) injections.delete(k);
    for (const [k, arr] of breaker) {
      const kept = arr.filter((t) => now - t < BREAKER_WINDOW_MS);
      if (kept.length) breaker.set(k, kept);
      else breaker.delete(k);
    }
  }

  return {
    /** 记一条待回复的镜像（或注入来源消息）：label = 指令原文（结果卡标题用）。
     *  完成时在来源消息下**另发**结果卡——受理回执卡保持「已开始」不改动 */
    enqueueMirror(sid, messageId, label = '') {
      if (!sid || !messageId) return;
      const q = mirrorQueue.get(sid) || [];
      q.push({ id: messageId, label });
      if (q.length > 10) q.shift();
      mirrorQueue.set(sid, q);
      if (mirrorQueue.size > 100) mirrorQueue.delete(mirrorQueue.keys().next().value);
    },
    /** 取最旧一条待回复镜像（Stop 时消费；排队多 prompt 按提交顺序配对） */
    takeMirror(sid) {
      const q = mirrorQueue.get(sid);
      if (!q?.length) return null;
      const m = q.shift();
      if (!q.length) mirrorQueue.delete(sid);
      return m;
    },

    markMirroredMsg(messageId) {
      if (messageId) mirroredMsgIds.set(messageId, Date.now() + MIRROR_TTL_MS);
    },
    isMirroredMsg(messageId) {
      if (!messageId) return false;
      const t = mirroredMsgIds.get(messageId);
      if (t === undefined) return false;
      if (t < Date.now()) {
        mirroredMsgIds.delete(messageId);
        return false;
      }
      return true;
    },

    markInjection(sid, prompt) {
      if (!sid || !prompt) return;
      const key = `${sid}:${hashText(prompt)}`;
      const prev = injections.get(key);
      const expiresAt = Date.now() + INJECT_TTL_MS;
      injections.set(key, prev && prev.expiresAt > Date.now() ? { n: prev.n + 1, expiresAt } : { n: 1, expiresAt });
    },
    isInjectedPrompt(sid, prompt) {
      const key = `${sid}:${hashText(prompt)}`;
      const e = injections.get(key);
      if (!e) return false;
      if (e.expiresAt < Date.now()) {
        injections.delete(key);
        return false;
      }
      e.n -= 1;
      if (e.n <= 0) injections.delete(key);
      return true;
    },

    /** 断路器：记录一次入站。返回 { tripped, first }——tripped=同群同内容窗口内达到
     *  阈值（疑似回环，应丢弃）；first=本次是跳闸瞬间（只在这一刻告警一次） */
    noteInbound(chatId, text) {
      const now = Date.now();
      sweep(now);
      const key = `${chatId}:${hashText(text || '')}`;
      const arr = (breaker.get(key) || []).filter((t) => now - t < BREAKER_WINDOW_MS);
      arr.push(now);
      breaker.set(key, arr);
      if (arr.length < BREAKER_TRIP_AT) return { tripped: false, first: false };
      return { tripped: true, first: arr.length === BREAKER_TRIP_AT };
    },
  };
}
