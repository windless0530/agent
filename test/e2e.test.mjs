import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../src/server.mjs';
import { parseDialogOptions, dialogHasAutoRow } from '../src/dialog.mjs';
import { loadConfig, validateServeConfig } from '../src/config.mjs';
import { createChatRunner, extractText } from '../src/agent.mjs';
import {
  buildConfirmCard,
  buildResultCard,
  buildNotifyCard,
  summarizeTool,
  buildTaskAckCard,
  buildTaskResultCard,
} from '../src/cards.mjs';
import { waitFor } from '../src/util.mjs';

/** 假 messenger：记录发送与更新，不访问飞书（无 peer 通道，只有定向发送） */
function fakeMessenger() {
  const sent = [];
  const sentTo = [];
  const updates = [];
  const replies = [];
  const texts = [];
  const userTexts = [];
  let n = 0;
  return {
    sent,
    sentTo,
    updates,
    replies,
    texts,
    async sendCardTo(chatId, card) {
      sent.push(card);
      sentTo.push({ chatId, card });
      return `msg_${++n}`;
    },
    async updateCard(messageId, card) {
      updates.push({ messageId, card });
    },
    async replyCard(messageId, card) {
      replies.push({ messageId, card });
      return `msg_${++n}`;
    },
    async replyText(chatId, text) {
      texts.push({ chatId, text });
    },
    userTexts,
    async sendTextAsUser(chatId, text, accessToken) {
      userTexts.push({ chatId, text, accessToken });
      return `umsg_${++n}`;
    },
  };
}

/** 假 lark client：只实现 daemon 用到的 bot 信息 raw API，形状对齐真实响应 */
function fakeLarkClient({ botOpenId = 'ou_bot' } = {}) {
  return {
    async request({ url }) {
      if (url === 'open-apis/bot/v3/info') {
        // 真实响应体是非标准包装 {bot:{open_id}}
        return { bot: { open_id: botOpenId, app_name: 'cc-bridge' } };
      }
      return { code: -1, msg: 'not found' };
    },
  };
}

/**
 * 构造 im.message.receive_v1 事件报文。
 * SDK 长连接会把 v2 事件的 event 体展平到顶层后调 handler（message/sender 在 data 上），
 * 默认按该真实形状构造；wrapped=true 时保留 event 包装（兼容路径）。
 */
/** 假 herdr：默认无会话（消息回退无头执行），不依赖本机 herdr */
function fakeHerdr(agents = []) {
  return {
    prompts: [],
    async agentsForCwd(cwd) {
      return agents.filter((a) => a.cwd === cwd || a.cwd.startsWith(cwd + '/'));
    },
    async promptAgent(paneId, text) {
      this.prompts.push({ paneId, text });
      const agent = agents.find((a) => a.pane_id === paneId) || null;
      if (agent?.agent_status === 'blocked') return { ok: false, blocked: true, error: 'agent_blocked' };
      return { ok: true, blocked: false, error: '', agent };
    },
  };
}

function msgEvent({
  chatType = 'p2p',
  chatId = 'oc_chat1',
  text,
  mentions,
  messageId,
  sender = 'ou_user',
  senderType = 'user',
  messageType = 'text',
  wrapped = false,
} = {}) {
  const event = {
    sender: { sender_type: senderType, sender_id: { open_id: sender } },
    message: {
      message_id: messageId || `om_${Math.random().toString(36).slice(2, 10)}`,
      chat_id: chatId,
      chat_type: chatType,
      message_type: messageType,
      content: JSON.stringify({ text }),
      ...(mentions ? { mentions } : {}),
    },
  };
  return wrapped ? { event } : event;
}

/** 假 runClaude：记录调用参数并返回可预测结果 */
function fakeRunClaude(runs, resultOf) {
  return async (args) => {
    runs.push(args);
    return resultOf(args);
  };
}

/** 默认绑定：BASH_PAYLOAD / PR_PAYLOAD 的 cwd 都在 /home/user/project 下 */
const DEFAULT_BINDING = { chatId: 'oc_t', cwd: '/home/user/project' };

async function startBridge(cfg = {}, paneReader = async () => '') {
  const messenger = fakeMessenger();
  const merged = { ...cfg, bindings: [...(cfg.bindings || []), DEFAULT_BINDING] };
  // 卡片路由依赖 chat runner 的 chatForCwd，必须一并挂上；paneReader 默认读不到
  // （非 herdr 会话），保证权限类测试不依赖本机真实终端
  const chat = createChatRunner({ herdr: fakeHerdr(), cfg: merged, messenger, client: fakeLarkClient() });
  const bridge = createBridge({ cfg: merged, messenger, chat, paneReader });
  await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  const { port } = bridge.server.address();
  return { bridge, messenger, base: `http://127.0.0.1:${port}`, async close() { bridge.server.close(); } };
}

function post(base, path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function clickRid(card, act) {
  const btn = card.body.elements.find((e) => e.tag === 'button' && e.behaviors?.[0]?.value?.act === act);
  return btn.behaviors[0].value.rid;
}

const BASH_PAYLOAD = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf /tmp/x && echo done', description: '清理临时目录' },
  cwd: '/home/user/project',
  session_id: 'sess-abcdef123456',
};

test('预置 allow 规则命中：直接放行，不发卡片', async () => {
  const t = await startBridge({ timeoutSec: 30, allow: ['Bash:git'] });
  try {
    const res = await post(t.base, '/hook/pretooluse', { ...BASH_PAYLOAD, tool_input: { command: 'git status' } });
    assert.equal(res.status, 200);
    const json = JSON.parse(await res.text());
    assert.equal(json.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(t.messenger.sent.length, 0); // 未发卡片
    assert.equal(t.bridge.pendingSize(), 0);
  } finally {
    await t.close();
  }
});

test('正常确认流：发卡片 → 点「拒绝」→ 返回 deny 决策并更新卡片', async () => {
  const t = await startBridge({ timeoutSec: 30 });
  try {
    const promise = post(t.base, '/hook/pretooluse', BASH_PAYLOAD);
    await new Promise((r) => setTimeout(r, 150)); // 等 daemon 发卡
    assert.equal(t.messenger.sent.length, 1);
    const card = t.messenger.sent[0];
    assert.equal(card.schema, '2.0');
    assert.equal(card.header.template, 'orange');
    const rid = clickRid(card, 'deny');

    await t.bridge.handleCardAction({
      action: { value: { rid, act: 'deny' }, tag: 'button' },
      operator: { open_id: 'ou_user1', name: '张三' },
    });

    const res = await promise;
    const json = JSON.parse(await res.text());
    assert.equal(json.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(json.hookSpecificOutput.permissionDecisionReason.includes('拒绝'));
    assert.equal(t.messenger.updates.length, 1);
    assert.equal(t.messenger.updates[0].card.header.template, 'grey');
    assert.equal(t.bridge.pendingSize(), 0);
  } finally {
    await t.close();
  }
});

test('「总是允许」：先放行本次，同前缀后续请求不再发卡片', async () => {
  const t = await startBridge({ timeoutSec: 30 });
  try {
    const p1 = post(t.base, '/hook/pretooluse', BASH_PAYLOAD);
    await new Promise((r) => setTimeout(r, 150));
    const rid = clickRid(t.messenger.sent[0], 'always');
    await t.bridge.handleCardAction({ action: { value: { rid, act: 'always' } }, operator: { open_id: 'ou_user1' } });
    const j1 = JSON.parse(await (await p1).text());
    assert.equal(j1.hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(t.messenger.updates[0].card.header.template === 'green');

    // 第二个 Bash 命令（首词 rm 相同）→ 规则命中直接放行
    const p2 = await post(t.base, '/hook/pretooluse', BASH_PAYLOAD);
    const j2 = JSON.parse(await p2.text());
    assert.equal(j2.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(t.messenger.sent.length, 1); // 没有新卡片

    // 不同首词的命令仍要确认
    const p3 = post(t.base, '/hook/pretooluse', { ...BASH_PAYLOAD, tool_input: { command: 'npm install' } });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(t.messenger.sent.length, 2);
    const rid3 = clickRid(t.messenger.sent[1], 'allow');
    await t.bridge.handleCardAction({ action: { value: { rid: rid3, act: 'allow' } }, operator: { open_id: 'ou_user1' } });
    const j3 = JSON.parse(await (await p3).text());
    assert.equal(j3.hookSpecificOutput.permissionDecision, 'allow');
  } finally {
    await t.close();
  }
});

test('超时：返回空体（fail-open 回退本地确认），卡片标记超时', async () => {
  const t = await startBridge({ timeoutSec: 1 });
  try {
    const res = await post(t.base, '/hook/pretooluse', BASH_PAYLOAD);
    assert.equal(res.status, 200);
    assert.equal((await res.text()).trim(), '');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.messenger.updates.length, 1);
    assert.match(t.messenger.updates[0].card.header.title.content, /超时/);
    assert.equal(t.bridge.pendingSize(), 0);
  } finally {
    await t.close();
  }
});

test('客户端提前断开：挂起请求取消，卡片标记取消', async () => {
  const t = await startBridge({ timeoutSec: 30 });
  try {
    const ac = new AbortController();
    const promise = fetch(t.base + '/hook/pretooluse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(BASH_PAYLOAD),
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(t.messenger.sent.length, 1);
    ac.abort();
    await promise.catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.bridge.pendingSize(), 0);
    assert.match(t.messenger.updates.at(-1).card.header.title.content, /取消/);
  } finally {
    await t.close();
  }
});

test('终端本地作答：PostToolUse 严格匹配 → 结算挂起并刷卡；Stop 兜底其余', async () => {
  const t = await startBridge({ timeoutSec: 30 });
  try {
    // 1) 同会话同工具同参数（键序不同也算相等）的工具已执行 → 本地允许
    const p1 = post(t.base, '/hook/pretooluse', BASH_PAYLOAD);
    await new Promise((r) => setTimeout(r, 150));
    const rid1 = clickRid(t.messenger.sent[0], 'deny');
    const ptu = await post(t.base, '/hook/posttooluse', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { description: '清理临时目录', command: 'rm -rf /tmp/x && echo done' }, // 键序不同
      cwd: '/home/user/project',
      session_id: 'sess-abcdef123456',
    });
    assert.equal((await ptu.text()).trim(), ''); // PostToolUse 本身无决策、不挂起
    assert.equal((await p1.then((r) => r.text())).trim(), ''); // 挂起的确认请求 fail-open 空体释放
    assert.equal(t.bridge.pendingSize(), 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(t.messenger.updates[0].card.header.title.content, /已在终端允许/);
    assert.equal(t.messenger.updates[0].card.header.template, 'green');
    assert.match(JSON.stringify(t.messenger.updates[0].card), /按钮已失效/);
    assert.equal(t.messenger.sent.length, 1); // 不发任何通知卡

    // 本地结算后的迟到点击被忽略（rid 已出队）
    await t.bridge.handleCardAction({ action: { value: { rid: rid1, act: 'deny' } }, operator: { open_id: 'ou_u' } });
    assert.equal(t.messenger.updates.length, 1);

    // 2) 参数不匹配的 PostToolUse 不结算（并行同工具任务不误伤）
    const p2 = post(t.base, '/hook/pretooluse', BASH_PAYLOAD);
    await new Promise((r) => setTimeout(r, 150));
    await post(t.base, '/hook/posttooluse', {
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
      session_id: 'sess-abcdef123456',
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.bridge.pendingSize(), 1); // 仍挂起

    // 其它会话的 Stop 也不结算
    await post(t.base, '/hook/stop', { session_id: 'sess-other', cwd: '/home/user/project' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.bridge.pendingSize(), 1);

    // 3) 本会话 Stop（回合结束）→ 兜底结算为「已在终端处理」
    const stop = await post(t.base, '/hook/stop', { session_id: 'sess-abcdef123456', cwd: '/home/user/project' });
    assert.equal((await stop.text()).trim(), '');
    assert.equal((await p2.then((r) => r.text())).trim(), '');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.bridge.pendingSize(), 0);
    assert.match(t.messenger.updates[1].card.header.title.content, /已在终端处理/);
    assert.equal(t.messenger.updates[1].card.header.template, 'grey');
    // notifyStop 默认开，但两次 Stop 都没带 transcript → 读不到最终文本，不发结果卡
    assert.equal(t.messenger.sent.length, 2); // 仅 2 张确认卡
  } finally {
    await t.close();
  }
});

test('allowedOpenIds 白名单外的点击被忽略', async () => {
  const t = await startBridge({ timeoutSec: 30, allowedOpenIds: ['ou_allowed'] });
  try {
    const p = post(t.base, '/hook/pretooluse', BASH_PAYLOAD);
    await new Promise((r) => setTimeout(r, 150));
    const rid = clickRid(t.messenger.sent[0], 'allow');
    await t.bridge.handleCardAction({ action: { value: { rid, act: 'allow' } }, operator: { open_id: 'ou_stranger' } });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.bridge.pendingSize(), 1); // 仍挂起

    await t.bridge.handleCardAction({ action: { value: { rid, act: 'allow' } }, operator: { open_id: 'ou_allowed' } });
    const json = JSON.parse(await (await p).text());
    assert.equal(json.hookSpecificOutput.permissionDecision, 'allow');
  } finally {
    await t.close();
  }
});

test('并发上限：超出后立即放行空响应', async () => {
  const t = await startBridge({ timeoutSec: 30, maxPending: 1 });
  try {
    const p1 = post(t.base, '/hook/pretooluse', BASH_PAYLOAD);
    await new Promise((r) => setTimeout(r, 150));
    const res2 = await post(t.base, '/hook/pretooluse', { ...BASH_PAYLOAD, tool_input: { command: 'ls' } });
    assert.equal((await res2.text()).trim(), '');
    const rid = clickRid(t.messenger.sent[0], 'deny');
    await t.bridge.handleCardAction({ action: { value: { rid, act: 'deny' } }, operator: { open_id: 'ou_u' } });
    const j1 = JSON.parse(await (await p1).text());
    assert.equal(j1.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    await t.close();
  }
});

test('token 鉴权：无凭据 401，带 Bearer 正常', async () => {
  const t = await startBridge({ timeoutSec: 30, token: 's3cret' });
  try {
    const no = await post(t.base, '/hook/pretooluse', BASH_PAYLOAD);
    assert.equal(no.status, 401);
    const p = post(t.base, '/hook/pretooluse', BASH_PAYLOAD, { Authorization: 'Bearer s3cret' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(t.messenger.sent.length, 1);
    const rid = clickRid(t.messenger.sent[0], 'deny');
    await t.bridge.handleCardAction({ action: { value: { rid, act: 'deny' } }, operator: { open_id: 'ou_u' } });
    assert.equal((await p).status, 200);
    // /health 不需要鉴权
    assert.equal((await fetch(t.base + '/health')).status, 200);
  } finally {
    await t.close();
  }
});

test('notification / stop / notify 事件：按 binding 路由发卡；未命中不发也不挂起', async () => {
  const t = await startBridge({ timeoutSec: 30 });
  try {
    // 无 session_id 的空闲提醒：没发过 Stop 输出卡 → 照常转发
    const n = await post(t.base, '/hook/notification', { message: 'Claude is waiting for your input', cwd: '/home/user/project' });
    assert.equal((await n.text()).trim(), '');
    // notifyStop 默认开，但 Stop 未带 transcript → 读不到最终文本 → 不发结果卡
    const s = await post(t.base, '/hook/stop', { cwd: '/home/user/project' });
    assert.equal((await s.text()).trim(), '');
    const m = await post(t.base, '/notify', { title: '手动通知', body: 'hello', severity: 'warn', cwd: '/home/user/project' });
    const mj = JSON.parse(await m.text());
    assert.equal(mj.ok, true);
    assert.equal(t.messenger.sent.length, 2); // 空闲提醒 + 手动通知卡
    assert.equal(t.messenger.sent[1].header.template, 'orange'); // severity warn
    assert.ok(t.messenger.sentTo.every((x) => x.chatId === 'oc_t')); // 全部路由到默认绑定群
    assert.equal(t.bridge.pendingSize(), 0);

    // 未命中 binding：通知事件静默跳过（不发卡），/notify 明确报 400
    const n2 = await post(t.base, '/hook/notification', { message: 'x', cwd: '/elsewhere' });
    assert.equal((await n2.text()).trim(), '');
    assert.equal(t.messenger.sent.length, 2);
    const bad = await post(t.base, '/notify', { title: 'x', body: 'y', cwd: '/elsewhere' });
    assert.equal(bad.status, 400);
  } finally {
    await t.close();
  }
});

test('Stop 输出卡：读得到本回合最终 assistant 文本才发；回合边界不越界；其后 idle_prompt 抑制', async () => {
  // 构造 transcript：上一回合的旧文本在前；本回合末尾是纯 tool_use 行与坏行，都应被跳过
  const transcript = path.join(os.tmpdir(), `cc-bridge-stop-${process.pid}-${Date.now()}.jsonl`);
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', message: { content: '上一轮问题' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '上一轮的旧输出' }] } }),
      JSON.stringify({ type: 'user', message: { content: '跑一下' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '中间步骤输出' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '完成。现在的规则：xxx' }] } }),
      '{broken json',
    ].join('\n') + '\n',
  );
  const t = await startBridge({ timeoutSec: 30 });
  try {
    const s = await post(t.base, '/hook/stop', {
      session_id: 'sess-stop-1',
      cwd: '/home/user/project',
      transcript_path: transcript,
    });
    assert.equal((await s.text()).trim(), '');
    assert.equal(t.messenger.sent.length, 1);
    const card = t.messenger.sent[0];
    assert.match(card.header.title.content, /已完成/);
    assert.equal(card.header.template, 'green');
    assert.match(card.body.elements[0].content, /完成。现在的规则：xxx/);
    assert.doesNotMatch(card.body.elements[0].content, /中间步骤输出/);
    assert.doesNotMatch(card.body.elements[0].content, /上一轮的旧输出/);

    // 同会话随后的 idle_prompt（waiting for your input）被抑制——不再是最后那张废话卡
    const idle = await post(t.base, '/hook/notification', {
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
      session_id: 'sess-stop-1',
      cwd: '/home/user/project',
    });
    assert.equal((await idle.text()).trim(), '');
    assert.equal(t.messenger.sent.length, 1);

    // 本回合没有最终文本（末尾只有 tool_use）：不越界捞上一轮旧文本，直接不发卡
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { content: '上一轮问题' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '上一轮的旧输出' }] } }),
        JSON.stringify({ type: 'user', message: { content: '跑一下' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } }),
      ].join('\n') + '\n',
    );
    await post(t.base, '/hook/stop', { session_id: 'sess-stop-2', cwd: '/home/user/project', transcript_path: transcript });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.messenger.sent.length, 1, '读不到本回合最终文本 → 不发结果卡');

    // 没发过 Stop 卡的会话照常转发
    await post(t.base, '/hook/notification', {
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
      session_id: 'sess-idle-other',
      cwd: '/home/user/project',
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.messenger.sent.length, 2);
  } finally {
    fs.unlinkSync(transcript);
    await t.close();
  }
});

test('notifyStop: false 时不发 Stop 卡，其后的 idle 提醒也不再抑制', async () => {
  const t = await startBridge({ timeoutSec: 30, notifyStop: false });
  try {
    const s = await post(t.base, '/hook/stop', { cwd: '/home/user/project', session_id: 'sess-q' });
    assert.equal((await s.text()).trim(), '');
    assert.equal(t.messenger.sent.length, 0);
    await post(t.base, '/hook/notification', {
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
      session_id: 'sess-q',
      cwd: '/home/user/project',
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.messenger.sent.length, 1); // 没有输出卡 → 空闲提醒照常转发
  } finally {
    await t.close();
  }
});

test('sendCard 失败：fail-open 返回空响应', async () => {
  const messenger = {
    async sendCardTo() { throw new Error('boom'); },
    async updateCard() {},
  };
  const bridge = createBridge({
    cfg: { timeoutSec: 30, bindings: [{ chatId: 'oc_t', cwd: '/home/user/project' }] },
    messenger,
  });
  await new Promise((r) => bridge.server.listen(0, '127.0.0.1', r));
  const { port } = bridge.server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hook/pretooluse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(BASH_PAYLOAD),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.text()).trim(), '');
  } finally {
    bridge.server.close();
  }
});

test('卡片内容：各工具摘要与按钮 value', async () => {
  const card = buildConfirmCard({
    rid: 'r1',
    tool: 'Bash',
    summary: summarizeTool('Bash', { command: 'ls -la', description: '列目录' }),
    cwd: '/w',
    session: 'sess-xyz',
    timeoutSec: 300,
  });
  // schema 2.0 无 action 组件：按钮直接在 elements 里，value 挂在 behaviors 回调上
  const acts = card.body.elements.filter((e) => e.tag === 'button').map((b) => b.behaviors[0].value.act);
  assert.deepEqual(acts.sort(), ['allow', 'always', 'deny']);

  const edit = summarizeTool('Edit', { file_path: '/a/b.py', old_string: 'x', new_string: 'y' });
  assert.match(edit.headline, /\/a\/b\.py/);

  const generic = summarizeTool('mcp__git__commit', { repo: 'x' });
  assert.match(generic.detail, /repo/);

  const result = buildResultCard(
    { tool: 'Bash', summary: summarizeTool('Bash', { command: 'ls' }), cwd: '', session: '' },
    { act: 'always', operator: { open_id: 'ou_1', name: '李四' } },
  );
  assert.equal(result.header.template, 'green');
  assert.match(JSON.stringify(result), /已记住/); // 未带原生 suggestion → cc-bridge 内部规则文案

  const notify = buildNotifyCard({ title: 't', message: 'm', severity: 'error' });
  assert.equal(notify.header.template, 'red');
  assert.equal(notify.body.elements.at(-1).tag, 'markdown'); // schema 2.0 无 note,备注行是灰色 markdown
  assert.match(notify.body.elements.at(-1).content, /grey/);
});

const PR_PAYLOAD = {
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf node_modules', description: 'Remove node_modules' },
  cwd: '/home/user/project',
  session_id: 'sess-pr-1',
  permission_suggestions: [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'rm -rf node_modules' }],
      behavior: 'allow',
      destination: 'localSettings',
    },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ],
};

test('PermissionRequest：允许/拒绝返回 decision schema', async () => {
  const t = await startBridge({ timeoutSec: 30 });
  try {
    // allow
    let p = post(t.base, '/hook/permissionrequest', PR_PAYLOAD);
    await new Promise((r) => setTimeout(r, 150));
    let rid = clickRid(t.messenger.sent[0], 'allow');
    await t.bridge.handleCardAction({ action: { value: { rid, act: 'allow' } }, operator: { open_id: 'ou_u' } });
    let j = JSON.parse(await (await p).text());
    assert.equal(j.hookSpecificOutput.hookEventName, 'PermissionRequest');
    assert.equal(j.hookSpecificOutput.decision.behavior, 'allow');
    assert.ok(!j.hookSpecificOutput.decision.updatedPermissions); // 单次允许不带规则

    // deny
    p = post(t.base, '/hook/permissionrequest', { ...PR_PAYLOAD, session_id: 's2' });
    await new Promise((r) => setTimeout(r, 150));
    rid = clickRid(t.messenger.sent[1], 'deny');
    await t.bridge.handleCardAction({ action: { value: { rid, act: 'deny' } }, operator: { open_id: 'ou_u' } });
    j = JSON.parse(await (await p).text());
    assert.equal(j.hookSpecificOutput.decision.behavior, 'deny');
    assert.ok(j.hookSpecificOutput.decision.message.includes('拒绝'));
  } finally {
    await t.close();
  }
});

test('PermissionRequest：选项个数/文案与终端确认框一致（Yes / 合并建议行 / No）', async () => {
  const t = await startBridge({ timeoutSec: 30 });
  try {
    // 场景对齐用户实例：单条 Bash addRules 建议
    const p = post(t.base, '/hook/permissionrequest', {
      ...PR_PAYLOAD,
      permission_suggestions: PR_PAYLOAD.permission_suggestions.slice(0, 1),
      permission_mode: 'default',
    });
    await new Promise((r) => setTimeout(r, 150));
    const card = t.messenger.sent[0];
    const btns = card.body.elements.filter((e) => e.tag === 'button');
    assert.equal(btns.length, 3); // Yes / 建议行 / No，与终端一致
    // 短规则（52 字符）整条放得进单行预算 → 按钮即终端原话，正文无需补全
    assert.equal(btns[0].text.content, '1. Yes');
    assert.equal(btns[1].text.content, `2. Yes, and don’t ask again for: rm -rf node_modules`);
    assert.equal(btns[2].text.content, '3. No');
    for (const b of btns) assert.ok(b.text.content.length <= 100);
    assert.doesNotMatch(card.body.elements[0].content, /2\. don’t ask again/);
    assert.match(card.body.elements[0].content, /Do you want to proceed\?/);
    // paneReader 读不到（默认）→ 不出 auto 行
    assert.ok(!btns.some((b) => /switch to auto mode/.test(b.text.content)));
    assert.equal(btns[1].behaviors[0].value.act, 'suggest');
    assert.equal(btns[2].behaviors[0].value.act, 'deny');

    // 点建议行：全部建议原样回传（yes-apply-suggestions 语义）
    await t.bridge.handleCardAction({
      action: { value: { rid: btns[1].behaviors[0].value.rid, act: 'suggest' } },
      operator: { open_id: 'ou_u' },
    });
    const j = JSON.parse(await (await p).text());
    assert.deepEqual(j.hookSpecificOutput.decision.updatedPermissions, PR_PAYLOAD.permission_suggestions.slice(0, 1));
    assert.match(JSON.stringify(t.messenger.updates[0].card), /已允许并记住规则/);
    assert.match(JSON.stringify(t.messenger.updates[0].card), /所选选项/);
  } finally {
    await t.close();
  }
});

/** 终端确认框实抓样本（claude 2.1.296，220 列 tmux）——读屏对齐的 ground truth */
const DIALOG_WITH_AUTO = ` Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
 Fetch the example.com page content
╌╌╌╌╌╌╌╌╌╌
 curl -s https://example.com
╌╌╌╌╌╌╌╌╌╌
 This command requires approval

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don’t ask again for: curl *
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend`;

/** manual 模式形态：Tip 行含目标字样但选项列表没有 auto 行（不得全文子串误判） */
const DIALOG_WITHOUT_AUTO = ` Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
 This command requires approval

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don’t ask again for: curl *
   3. No

 Esc to cancel · Tab to amend`;

/** 窄终端：选项折行，折行内容并入所属选项 */
const DIALOG_WRAPPED = ` Edit file
 This file requires approval

 Do you want to make this edit?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for
 this session
   3. No

 Esc to cancel · Tab to amend`;

test('parseDialogOptions：真实样本逐行解析；Tip 行不误判；折行合并；非对话框返回空', () => {
  const opts = parseDialogOptions(DIALOG_WITH_AUTO);
  assert.equal(opts.length, 4);
  assert.equal(opts[0], 'Yes');
  assert.equal(opts[1], 'Yes, and don’t ask again for: curl *');
  assert.equal(opts[3], 'No');
  assert.ok(dialogHasAutoRow(opts));

  const manual = parseDialogOptions(DIALOG_WITHOUT_AUTO);
  assert.equal(manual.length, 3);
  assert.ok(!dialogHasAutoRow(manual), 'Tip 行含字样但选项无 auto 行 → 不得误判');

  const wrapped = parseDialogOptions(DIALOG_WRAPPED);
  assert.equal(wrapped.length, 3);
  assert.match(wrapped[1], /for this session$/);

  assert.deepEqual(parseDialogOptions('❯ 随便一段终端输出\n没有对话框'), []);
  assert.deepEqual(parseDialogOptions(''), []);
});

test('auto 模式行读屏对齐：终端渲染了 → 卡片出该键并回传 setMode；没渲染/读不到 → 不出', async () => {
  // 1) 终端有 auto 行 → 卡片 4 键；点它回传 setMode{auto, session}
  let t = await startBridge({ timeoutSec: 30 }, async () => DIALOG_WITH_AUTO);
  try {
    const p = post(t.base, '/hook/permissionrequest', {
      ...PR_PAYLOAD,
      permission_suggestions: PR_PAYLOAD.permission_suggestions.slice(0, 1),
    });
    await new Promise((r) => setTimeout(r, 150));
    const card = t.messenger.sent[0];
    const btns = card.body.elements.filter((e) => e.tag === 'button');
    assert.equal(btns.length, 4);
    assert.match(btns[2].text.content, /^3\. Yes, and switch to auto mode/);
    assert.equal(btns[2].behaviors[0].value.act, 'auto');
    await t.bridge.handleCardAction({
      action: { value: { rid: clickRid(card, 'auto'), act: 'auto' } },
      operator: { open_id: 'ou_u' },
    });
    const j = JSON.parse(await (await p).text());
    assert.deepEqual(j.hookSpecificOutput.decision.updatedPermissions, [
      { type: 'setMode', mode: 'auto', destination: 'session' },
    ]);
    assert.match(JSON.stringify(t.messenger.updates[0].card), /切换权限模式/);
  } finally {
    await t.close();
  }

  // 2) 终端没有 auto 行（manual 模式 + Tip 干扰）→ 卡片 3 键
  t = await startBridge({ timeoutSec: 2 }, async () => DIALOG_WITHOUT_AUTO);
  try {
    const p = post(t.base, '/hook/permissionrequest', {
      ...PR_PAYLOAD,
      permission_suggestions: PR_PAYLOAD.permission_suggestions.slice(0, 1),
    });
    await new Promise((r) => setTimeout(r, 150));
    const btns = t.messenger.sent[0].body.elements.filter((e) => e.tag === 'button');
    assert.equal(btns.length, 3);
    assert.ok(!btns.some((b) => /switch to auto mode/.test(b.text.content)));
    await (await p).text(); // 超时结算，释放挂起连接
  } finally {
    await t.close();
  }

  // 3) 读不到 pane（非 herdr 会话 / 远程机器）→ 不出 auto 行
  t = await startBridge({ timeoutSec: 2 }, async () => '');
  try {
    const p = post(t.base, '/hook/permissionrequest', {
      ...PR_PAYLOAD,
      permission_suggestions: PR_PAYLOAD.permission_suggestions.slice(0, 1),
    });
    await new Promise((r) => setTimeout(r, 150));
    const btns = t.messenger.sent[0].body.elements.filter((e) => e.tag === 'button');
    assert.equal(btns.length, 3);
    await (await p).text();
  } finally {
    await t.close();
  }
});

test('PermissionRequest：建议合并行按建议内容选 cli.js 模板；垃圾条目被过滤；无建议回退三键', async () => {
  const t = await startBridge({ timeoutSec: 30 });
  try {
    // setMode 建议 → 按钮截断的完整文案 + 正文里的完整模式描述（cli.js 模板文案）
    let p = post(t.base, '/hook/permissionrequest', PR_PAYLOAD); // 含 setMode acceptEdits 建议
    await new Promise((r) => setTimeout(r, 150));
    let btn = t.messenger.sent[0].body.elements.find((e) => e.behaviors?.[0]?.value?.act === 'suggest');
    assert.ok(btn.text.content.startsWith('2. Yes, and switch to accept edits'));
    assert.ok(btn.text.content.endsWith('…'));
    assert.ok(btn.text.content.length <= 71);
    assert.match(
      t.messenger.sent[0].body.elements[0].content,
      /2\. switch to accept edits \(auto-approve file edits and common file commands\) for this session/,
    );
    let rid = btn.behaviors[0].value.rid;
    await t.bridge.handleCardAction({ action: { value: { rid, act: 'suggest' } }, operator: { open_id: 'ou_u' } });
    let j = JSON.parse(await (await p).text());
    assert.deepEqual(j.hookSpecificOutput.decision.updatedPermissions, PR_PAYLOAD.permission_suggestions); // 全部条目回传

    // 域名规则（WebFetch 类）+ userSettings 后缀；垃圾条目被过滤
    p = post(t.base, '/hook/permissionrequest', {
      ...PR_PAYLOAD,
      permission_suggestions: [
        null,
        'junk',
        { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'userSettings' },
      ],
    });
    await new Promise((r) => setTimeout(r, 150));
    btn = t.messenger.sent[1].body.elements.find((e) => e.behaviors?.[0]?.value?.act === 'suggest');
    assert.ok(btn.text.content.startsWith("2. Yes, and don’t ask again for example.com"));
    assert.ok(btn.text.content.endsWith('…'));
    assert.ok(btn.text.content.length <= 71);
    assert.match(
      t.messenger.sent[1].body.elements[0].content,
      /2\. don’t ask again for example\.com in any project \(user settings\)/,
    );

    // 无 suggestions（Edit 对话框不读该数组 / 旧 CLI）→ 固定三键，含「总是允许」
    p = post(t.base, '/hook/permissionrequest', { ...PR_PAYLOAD, permission_suggestions: undefined });
    await new Promise((r) => setTimeout(r, 150));
    const acts = t.messenger.sent[2].body.elements
      .filter((e) => e.tag === 'button')
      .map((b) => b.behaviors[0].value.act);
    assert.deepEqual(acts, ['allow', 'always', 'deny']);
    rid = clickRid(t.messenger.sent[2], 'always');
    await t.bridge.handleCardAction({ action: { value: { rid, act: 'always' } }, operator: { open_id: 'ou_u' } });
    j = JSON.parse(await (await p).text());
    assert.equal(j.hookSpecificOutput.decision.behavior, 'allow');
    assert.ok(!j.hookSpecificOutput.decision.updatedPermissions); // 无原生建议 → 不带 updatedPermissions
  } finally {
    await t.close();
  }
});

test('PermissionRequest：兼容旧卡片 act=always → 回传第一条 addRules 建议 + 内部规则兜底', async () => {
  const t = await startBridge({ timeoutSec: 30 });
  try {
    const p = post(t.base, '/hook/permissionrequest', PR_PAYLOAD);
    await new Promise((r) => setTimeout(r, 150));
    // 新卡片在有 suggestions 时不再渲染「总是允许」键；此路径只服务升级前已发出的旧卡，直接模拟其点击
    const rid = clickRid(t.messenger.sent[0], 'deny'); // 任意按钮都带同一 rid
    await t.bridge.handleCardAction({ action: { value: { rid, act: 'always' } }, operator: { open_id: 'ou_u' } });

    const j = JSON.parse(await (await p).text());
    const d = j.hookSpecificOutput.decision;
    assert.equal(d.behavior, 'allow');
    // 原样回传 addRules 建议（含 destination），持久化交给 Claude Code
    assert.deepEqual(d.updatedPermissions, [PR_PAYLOAD.permission_suggestions[0]]);
    // 结果卡片提示已写入 Claude Code 权限
    assert.match(JSON.stringify(t.messenger.updates[0].card), /Claude Code 权限/);
    // 同时 daemon 内部规则生效：后续同类请求直接放行
    const p2 = await post(t.base, '/hook/permissionrequest', PR_PAYLOAD);
    const j2 = JSON.parse(await p2.text());
    assert.equal(j2.hookSpecificOutput.decision.behavior, 'allow');
    assert.equal(t.messenger.sent.length, 1); // 无新卡片
  } finally {
    await t.close();
  }
});

test('PermissionRequest：无 suggestions 时「总是允许」仅内部记住；超时空响应', async () => {
  const t = await startBridge({ timeoutSec: 1 });
  try {
    // Edit 类对话框不读 suggestions → 输入里没有该字段
    const p = post(t.base, '/hook/permissionrequest', {
      ...PR_PAYLOAD,
      tool_name: 'Edit',
      tool_input: { file_path: '/a/b.py', old_string: 'x', new_string: 'y' },
      permission_suggestions: undefined,
    });
    await new Promise((r) => setTimeout(r, 150));
    const rid = clickRid(t.messenger.sent[0], 'always');
    await t.bridge.handleCardAction({ action: { value: { rid, act: 'always' } }, operator: { open_id: 'ou_u' } });
    const j = JSON.parse(await (await p).text());
    assert.equal(j.hookSpecificOutput.decision.behavior, 'allow');
    assert.ok(!j.hookSpecificOutput.decision.updatedPermissions);
    assert.match(JSON.stringify(t.messenger.updates[0].card), /cc-bridge 内/);

    // 超时 → 空体 fail-open
    const p2 = await post(t.base, '/hook/permissionrequest', PR_PAYLOAD);
    assert.equal((await p2.text()).trim(), '');
  } finally {
    await t.close();
  }
});

test('permission_prompt 通知：有挂起确认卡或刚解决时抑制，否则转发', async () => {
  // 额外绑定 /a：转发场景的通知卡需要命中 binding 才有发送目标
  const t = await startBridge({ timeoutSec: 30, bindings: [{ chatId: 'oc_f', cwd: '/a' }] });
  try {
    // 会话挂起确认卡期间 → 抑制
    const p = post(t.base, '/hook/permissionrequest', PR_PAYLOAD);
    await new Promise((r) => setTimeout(r, 150));
    const n1 = await post(t.base, '/hook/notification', {
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission',
      session_id: 'sess-pr-1',
      cwd: '/a',
    });
    assert.equal((await n1.text()).trim(), '');
    assert.equal(t.messenger.sent.length, 1); // 只有确认卡，无重复通知卡

    // 点掉确认卡后 60s 内的迟到通知 → 仍抑制
    const rid = clickRid(t.messenger.sent[0], 'deny');
    await t.bridge.handleCardAction({ action: { value: { rid, act: 'deny' } }, operator: { open_id: 'ou_u' } });
    await p;
    const n2 = await post(t.base, '/hook/notification', {
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission',
      session_id: 'sess-pr-1',
      cwd: '/a',
    });
    assert.equal((await n2.text()).trim(), '');
    assert.equal(t.messenger.sent.length, 1);

    // 无挂起且非刚解决（发卡失败/并发超限回退本地确认的场景）→ 转发为唯一提醒
    const n3 = await post(t.base, '/hook/notification', {
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission',
      session_id: 'sess-other',
      cwd: '/a',
    });
    assert.equal((await n3.text()).trim(), '');
    assert.equal(t.messenger.sent.length, 2); // 通知卡发出

    // 其它类型通知（idle_prompt 等）不受影响
    await post(t.base, '/hook/notification', {
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
      session_id: 'sess-other',
      cwd: '/a',
    });
    assert.equal(t.messenger.sent.length, 3);
  } finally {
    await t.close();
  }
});

test('rules 管理：GET /rules 列出，DELETE /rules 清空', async () => {
  const t = await startBridge({ timeoutSec: 30, allow: ['WebFetch'] });
  try {
    const g = await (await fetch(t.base + '/rules')).json();
    assert.deepEqual(g.rules, [{ tool: 'WebFetch', prefix: '' }]);
    const d = await fetch(t.base + '/rules', { method: 'DELETE' });
    assert.equal((await d.json()).ok, true);
    const g2 = await (await fetch(t.base + '/rules')).json();
    assert.deepEqual(g2.rules, []);
  } finally {
    await t.close();
  }
});

test('bindings 校验：配错配漏直接报错，不静默丢弃', () => {
  const cfg = loadConfig({
    __configFile: '/nonexistent.cc-bridge.json',
    bindings: [
      { chatId: 'oc_ok', cwd: '/repo/a' },
      { chatId: '', cwd: '/repo/b' }, // chatId 空
      { cwd: '/repo/c' }, // 整个缺 chatId
      { chatId: 'ou_wrong', cwd: '/repo/d' }, // open_id 冒充群 chat_id
      { chatId: 'oc_rel', cwd: 'relative/path' }, // cwd 非绝对路径
      'junk', // 不是对象
    ],
  });
  // 合法条目进入运行时绑定，其余每条都有对应错误
  assert.deepEqual(cfg.bindings.map((b) => b.chatId), ['oc_ok']);
  assert.equal(cfg.bindingErrors.length, 5);
  const all = cfg.bindingErrors.join('\n');
  assert.match(all, /chatId 未配置/);
  assert.match(all, /oc_ 开头/);
  assert.match(all, /绝对路径/);
  assert.match(all, /不是对象/);

  // validateServeConfig 把这些错误透出；serve/test 启动时直接失败
  const errs = validateServeConfig(cfg);
  assert.ok(errs.length >= 5);
  // 一个 binding 都没配也是配置错误（无兜底接收方）
  const empty = validateServeConfig(loadConfig({ __configFile: '/nonexistent.cc-bridge.json' }));
  assert.ok(empty.some((e) => /bindings 未配置/.test(e)));
});

// ---------- 消息驱动 Claude Code（bindings：群 ↔ 目录） ----------

const CHAT_CFG = {
  timeoutSec: 30,
  chatBin: 'claude',
  chatTimeoutSec: 60,
  bindings: [
    { chatId: 'oc_chat1', cwd: '/repo/a' },
    { chatId: 'oc_chat2', cwd: '/repo/b' },
  ],
};

function newRunner({ cfg = {}, client = fakeLarkClient(), runClaude } = {}) {
  const messenger = fakeMessenger();
  const runs = [];
  const runner = createChatRunner({ herdr: fakeHerdr(),
    cfg: { ...CHAT_CFG, ...cfg },
    messenger,
    client,
    runClaude: runClaude || fakeRunClaude(runs, (a) => ({
      ok: true,
      result: `echo:${a.prompt}`,
      sessionId: a.sessionId || 'sess-1',
      numTurns: 1,
      costUsd: 0.01,
      durationMs: 5,
    })),
  });
  return { runner, messenger, runs };
}

test('消息驱动：绑定群消息免 @ 执行（在绑定目录跑 claude）；单聊忽略；会话延续', async () => {
  const { runner, messenger, runs } = newRunner();
  await runner.handleMessage(msgEvent({ chatType: 'group', text: ' 查看git状态 ' }));
  await waitFor(() => messenger.replies.length === 2);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].prompt, '查看git状态'); // 压缩空白
  assert.equal(runs[0].cwd, '/repo/a'); // 在绑定目录执行
  assert.equal(runs[0].sessionId, ''); // 首条无会话
  assert.equal(runs[0].env.CC_BRIDGE_FROM_CHAT, '1');
  // 回执卡先发（蓝色「已开始」），跑完另发结果卡片（绿色含回复），回执不再改动
  assert.equal(messenger.replies[0].card.header.template, 'blue');
  assert.match(messenger.replies[0].card.header.title.content, /已开始/);
  assert.equal(messenger.replies[1].card.header.template, 'green');
  assert.match(messenger.replies[1].card.body.elements[0].content, /echo:查看git状态/);

  // 第二条消息带上一条的 session_id（上下文延续）
  await runner.handleMessage(msgEvent({ chatType: 'group', text: '继续' }));
  await waitFor(() => runs.length === 2);
  assert.equal(runs[1].sessionId, 'sess-1');

  // 单聊不驱动执行（绑定以群为单位）
  await runner.handleMessage(msgEvent({ text: '私聊你好' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(runs.length, 2);

  // 带 event 包装的形状（兼容路径）也能执行
  await runner.handleMessage(msgEvent({ chatType: 'group', text: '包装形状', messageId: 'om_w1', wrapped: true }));
  await waitFor(() => runs.length === 3);
  assert.equal(runs[2].prompt, '包装形状');
});

test('消息驱动：@占位符剥离；未绑定群 @机器人 → 配置提示；@别人/无@ 静默', async () => {
  const { runner, messenger, runs } = newRunner();
  // 绑定群带 @（可有可无）：占位符剥掉后照常执行
  await runner.handleMessage(msgEvent({
    chatType: 'group',
    text: '@_user_1  跑一下测试',
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'cc-bridge' }],
  }));
  await waitFor(() => runs.length === 1);
  assert.equal(runs[0].prompt, '跑一下测试');

  // 未绑定的群 @ 机器人 → 回复 bindings 配置提示
  await runner.handleMessage(msgEvent({
    chatType: 'group',
    chatId: 'oc_other',
    text: '@_user_1 你好',
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'cc-bridge' }],
  }));
  await waitFor(() => messenger.texts.length === 1);
  assert.match(messenger.texts[0].text, /bindings/);
  assert.match(messenger.texts[0].text, /oc_other/); // 提示里带本群 chat_id
  assert.equal(runs.length, 1);

  // 未绑定的群 @ 别人 → 静默；无 @ → 静默
  await runner.handleMessage(msgEvent({
    chatType: 'group',
    chatId: 'oc_other2',
    text: '@_user_1 你好',
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_other' }, name: '张三' }],
  }));
  await runner.handleMessage(msgEvent({ chatType: 'group', chatId: 'oc_other2', text: '随便聊聊' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(runs.length, 1);
  assert.equal(messenger.texts.length, 1);
});

test('消息驱动：新会话命令重置上下文；「绑定」命令回复信息；含「绑定」的正常指令不被劫持', async () => {
  const messenger = fakeMessenger();
  const runs = [];
  const runner = createChatRunner({ herdr: fakeHerdr(),
    cfg: CHAT_CFG,
    messenger,
    client: fakeLarkClient(),
    runClaude: fakeRunClaude(runs, (a) => ({ ok: true, result: 'r', sessionId: a.sessionId || 's9' })),
  });
  await runner.handleMessage(msgEvent({ chatType: 'group', text: 'hi' }));
  await waitFor(() => runs.length === 1);
  assert.equal(runs[0].sessionId, '');

  await runner.handleMessage(msgEvent({ chatType: 'group', text: '新会话' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs.length, 1); // 控制命令不进 claude
  assert.match(messenger.texts[0].text, /已重置/);

  await runner.handleMessage(msgEvent({ chatType: 'group', text: 'again' }));
  await waitFor(() => runs.length === 2);
  assert.equal(runs[1].sessionId, ''); // 重置后从新会话开始

  // 经由 server 的绑定分支：精确匹配才回复绑定信息
  const bridge = createBridge({
    cfg: { timeoutSec: 30, bindings: CHAT_CFG.bindings },
    messenger,
    chat: { handleMessage: async (d) => runner.handleMessage(d) },
  });
  await bridge.handleInboundMessage(msgEvent({ chatType: 'group', text: '绑定' }));
  assert.match(messenger.texts[1].text, /chat_id/);
  assert.match(messenger.texts[1].text, /bindings/);
  await bridge.handleInboundMessage(msgEvent({ chatType: 'group', text: '帮我绑定一个 webhook' }));
  await waitFor(() => runs.length === 3); // 正常指令，交给 claude
  assert.equal(runs[2].prompt, '帮我绑定一个 webhook');
});

test('消息驱动：同一会话串行排队，busy 期间回执标记排队', async () => {
  const messenger = fakeMessenger();
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const runner = createChatRunner({ herdr: fakeHerdr(),
    cfg: CHAT_CFG,
    messenger,
    client: fakeLarkClient(),
    runClaude: async (a) => {
      order.push(`start:${a.prompt}`);
      if (a.prompt === '一') await gate;
      order.push(`end:${a.prompt}`);
      return { ok: true, result: a.prompt, sessionId: 's' };
    },
  });
  await runner.handleMessage(msgEvent({ chatType: 'group', text: '一', messageId: 'om_1' }));
  await runner.handleMessage(msgEvent({ chatType: 'group', text: '二', messageId: 'om_2' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(order, ['start:一']); // 二在排队
  assert.equal(messenger.replies.length, 2); // 两条回执都已发出
  assert.equal(messenger.replies[1].card.header.template, 'yellow'); // 排队态

  release();
  await waitFor(() => order.length === 4);
  assert.deepEqual(order, ['start:一', 'end:一', 'start:二', 'end:二']); // 严格串行
  // 一：回执(蓝)→结果(绿新卡)；二：回执(黄)→开始时刷「已开始」(蓝)→结果(绿新卡)
  await waitFor(() => messenger.replies.filter((r) => r.card.header.template === 'green').length === 2);
  assert.equal(messenger.updates.length, 1);
  assert.equal(messenger.updates[0].card.header.template, 'blue'); // 「已排队」→「已开始」
  assert.match(messenger.updates[0].card.header.title.content, /已开始/);
  assert.match(messenger.replies[3].card.body.elements[0].content, /二/);
});

test('消息驱动：白名单外用户 / 非文本 / 应用消息 / 重复推送被忽略', async () => {
  const { runner, runs } = newRunner({ cfg: { allowedOpenIds: ['ou_user'] } });
  await runner.handleMessage(msgEvent({ chatType: 'group', text: 'hi', sender: 'ou_stranger' }));
  await runner.handleMessage(msgEvent({ chatType: 'group', text: { rich: 1 }, messageType: 'post' }));
  await runner.handleMessage(msgEvent({ chatType: 'group', text: 'hi', senderType: 'app' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(runs.length, 0);

  // 同一 message_id 重推只执行一次
  await runner.handleMessage(msgEvent({ chatType: 'group', text: 'hi', messageId: 'om_dup' }));
  await runner.handleMessage(msgEvent({ chatType: 'group', text: 'hi', messageId: 'om_dup' }));
  await waitFor(() => runs.length === 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs.length, 1);
});

test('消息驱动：runClaude 失败/超时 → 另发失败/超时结果卡片（回执保持已开始）', async () => {
  const messenger = fakeMessenger();
  const runner = createChatRunner({ herdr: fakeHerdr(),
    cfg: CHAT_CFG,
    messenger,
    client: fakeLarkClient(),
    runClaude: async () => ({ ok: false, timedOut: true, error: '超过 60s 未完成，已终止' }),
  });
  await runner.handleMessage(msgEvent({ chatType: 'group', text: '慢任务' }));
  await waitFor(() => messenger.replies.length === 2);
  const card = messenger.replies[1].card;
  assert.equal(card.header.template, 'yellow');
  assert.match(card.header.title.content, /超时/);
  assert.match(card.body.elements[0].content, /超过 60s/);

  const runner2 = createChatRunner({ herdr: fakeHerdr(),
    cfg: CHAT_CFG,
    messenger,
    client: fakeLarkClient(),
    runClaude: async () => ({ ok: false, error: 'claude 退出码 1' }),
  });
  await runner2.handleMessage(msgEvent({ chatType: 'group', text: '会失败', chatId: 'oc_chat2', messageId: 'om_2' }));
  await waitFor(() => messenger.replies.length === 4);
  assert.equal(messenger.replies[3].card.header.template, 'orange');
  assert.match(messenger.replies[3].card.body.elements[0].content, /claude 退出码 1/);
});

test('chatForCwd：绑定目录（含子目录）命中，最长前缀优先，目录边界精确', async () => {
  const { runner } = newRunner({
    cfg: {
      bindings: [
        { chatId: 'oc_top', cwd: '/repo' },
        { chatId: 'oc_deep', cwd: '/repo/b' },
        { chatId: 'oc_other', cwd: '/other' },
      ],
    },
  });
  assert.equal(runner.chatForCwd('/repo/a/src').chatId, 'oc_top');
  assert.equal(runner.chatForCwd('/repo/b/x').chatId, 'oc_deep'); // 最长前缀胜出
  assert.equal(runner.chatForCwd('/repo').chatId, 'oc_top');
  assert.equal(runner.chatForCwd('/repo2'), null); // 前缀必须是目录边界
  assert.equal(runner.chatForCwd('/elsewhere'), null);
  assert.equal(runner.chatForCwd(''), null);
});

test('卡片路由：确认卡按 cwd 发到绑定群，未命中不发卡（无兜底）', async () => {
  const messenger = fakeMessenger();
  const chat = createChatRunner({ herdr: fakeHerdr(), cfg: { ...CHAT_CFG }, messenger, client: fakeLarkClient() });
  const bridge = createBridge({ cfg: { timeoutSec: 30, bindings: CHAT_CFG.bindings }, messenger, chat });
  await new Promise((r) => bridge.server.listen(0, '127.0.0.1', r));
  const { port } = bridge.server.address();
  try {
    // cwd 命中 /repo/a 绑定 → 确认卡发到 oc_chat1 群
    const p = post(`http://127.0.0.1:${port}`, '/hook/permissionrequest', {
      ...PR_PAYLOAD,
      cwd: '/repo/a/sub',
      session_id: 'sess-route-1',
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(messenger.sentTo.length, 1);
    assert.equal(messenger.sentTo[0].chatId, 'oc_chat1');
    const rid = clickRid(messenger.sentTo[0].card, 'deny');
    await bridge.handleCardAction({ action: { value: { rid, act: 'deny' } }, operator: { open_id: 'ou_u' } });
    const j = JSON.parse(await (await p).text());
    assert.equal(j.hookSpecificOutput.decision.behavior, 'deny');
    assert.equal(messenger.updates.length, 1); // 点击后结果卡片照常更新

    // cwd 未命中任何 binding → 不发卡，确认请求 fail-open 空响应回本地流程
    const p2 = await post(`http://127.0.0.1:${port}`, '/hook/permissionrequest', {
      ...PR_PAYLOAD,
      cwd: '/elsewhere',
      session_id: 'sess-route-2',
    });
    assert.equal((await p2.text()).trim(), '');
    assert.equal(messenger.sentTo.length, 1);

    // 未命中的通知事件同样不发卡
    await post(`http://127.0.0.1:${port}`, '/hook/notification', { message: 'm', cwd: '/elsewhere' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(messenger.sentTo.length, 1);
    assert.equal(bridge.pendingSize(), 0);
  } finally {
    bridge.server.close();
  }
});

test('卡片内容：回执/结果卡片与 extractText', () => {
  assert.equal(extractText('{"text":"@_user_1  你好 @_user_2 世界"}'), '你好 世界');
  assert.equal(extractText('not-json'), '');
  assert.equal(extractText('{"text":"@_user_1"}'), '');

  const ack = buildTaskAckCard({ prompt: 'p', name: 'Elio', queued: true });
  assert.equal(ack.header.template, 'yellow');
  assert.match(ack.header.title.content, /^已排队 · p$/);
  assert.match(ack.body.elements[0].content, /回复 Elio：p/);
  assert.match(ack.body.elements[0].content, /排队/);
  assert.doesNotMatch(ack.body.elements.at(-1).content, /完成后/); // 回执不再承诺「完成后更新」
  const ack2 = buildTaskAckCard({ prompt: 'p2' });
  assert.equal(ack2.header.template, 'blue');
  assert.match(ack2.header.title.content, /^已开始 · p2$/);
  // 超长指令标题单行截断（truncate 会附加换行提示，标题必须单行）
  const ack3 = buildTaskAckCard({ prompt: `一${'很长的指令'.repeat(20)}` });
  assert.ok(!ack3.header.title.content.includes('\n'));
  assert.ok(ack3.header.title.content.endsWith('…'));
  const ok = buildTaskResultCard({
    ok: true, body: '答案', prompt: '查状态', sessionId: 'sess-abc12345', cwd: '/w',
    durationMs: 1500, costUsd: 0.005, numTurns: 2,
  });
  assert.equal(ok.header.template, 'green');
  assert.match(ok.header.title.content, /已完成 · 查状态/);
  assert.match(ok.body.elements[0].content, /答案/);
  assert.match(ok.body.elements.at(-1).content, /2s.*2 轮/);
  const fail = buildTaskResultCard({ ok: false, body: '崩了' });
  assert.equal(fail.header.template, 'orange');
  assert.match(fail.body.elements[0].content, /崩了/);
});

test('health：包含消息驱动状态；__fromChat 的 stop 事件被抑制', async () => {
  const messenger = fakeMessenger();
  const chat = createChatRunner({ herdr: fakeHerdr(),
    cfg: { ...CHAT_CFG },
    messenger,
    client: fakeLarkClient(),
    runClaude: async () => ({ ok: true, result: 'r' }),
  });
  const bridge = createBridge({ cfg: { timeoutSec: 30 }, messenger, chat });
  await new Promise((r) => bridge.server.listen(0, '127.0.0.1', r));
  const { port } = bridge.server.address();
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(h.chat.bindings, 2);
    assert.equal(h.chat.busy, 0);

    const s = await fetch(`http://127.0.0.1:${port}/hook/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ __fromChat: 1, cwd: '/a' }),
    });
    assert.equal((await s.text()).trim(), '');
    assert.equal(messenger.sent.length, 0); // 无「任务完成」通知卡
  } finally {
    bridge.server.close();
  }
});

// ---------- 用户身份镜像（OAuth user_access_token） ----------

import {
  buildAuthorizeUrl,
  exchangeCode,
  getUserAccessToken,
  AUTH_SCOPES,
} from '../src/auth.mjs';

test('auth：授权链接含 offline_access / send_as_user，参数齐全', () => {
  const url = buildAuthorizeUrl({ appId: 'cli_x', redirectUri: 'http://localhost:9999/cb', state: 'st1' });
  assert.ok(url.startsWith('https://accounts.feishu.cn/open-apis/authen/v1/authorize?'));
  const params = new URL(url).searchParams;
  assert.equal(params.get('client_id'), 'cli_x');
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('redirect_uri'), 'http://localhost:9999/cb');
  assert.equal(params.get('state'), 'st1');
  const scopes = params.get('scope').split(' ');
  for (const s of AUTH_SCOPES) assert.ok(scopes.includes(s), `缺 scope ${s}`);
});

test('auth：exchangeCode 落盘 → getUserAccessToken 缓存命中不刷新；过期后单飞刷新且落盘新 refresh_token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbridge-auth-'));
  const authFile = path.join(dir, 'auth.json');
  const cfg = { appId: 'cli_x', appSecret: 'sec', domain: 'feishu', authFile };
  let refreshCalls = 0;
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  const fetchImpl = async (url, opts = {}) => {
    const body = JSON.parse(opts.body || '{}');
    if (url.includes('/authen/v2/oauth/token')) {
      if (body.grant_type === 'authorization_code') {
        return ok({ code: 0, access_token: 'u-at-1', expires_in: 3600, refresh_token: 'u-rt-1', refresh_token_expires_in: 604800, scope: 'offline_access im:message' });
      }
      refreshCalls++;
      return ok({ code: 0, access_token: 'u-at-2', expires_in: 3600, refresh_token: 'u-rt-2', refresh_token_expires_in: 604800 });
    }
    if (url.includes('/authen/v1/user_info')) return ok({ code: 0, data: { open_id: 'ou_me', name: '测试者' } });
    throw new Error('unexpected ' + url);
  };

  // 换码 → 落盘带用户身份
  const saved = await exchangeCode({ cfg, code: 'c1', redirectUri: 'http://localhost:9999/cb', fetchImpl });
  assert.equal(saved.open_id, 'ou_me');
  assert.equal(saved.refresh_token, 'u-rt-1');

  // 未过期：直接命中缓存，不刷新
  const t1 = await getUserAccessToken(cfg, { fetchImpl });
  assert.equal(t1.token, 'u-at-1');
  assert.equal(refreshCalls, 0);

  // 把 access 顶到过期线上：并发 3 次只发 1 次刷新（refresh_token 单次有效）
  const stale = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  stale.access_expires_at = Date.now() - 1000;
  fs.writeFileSync(authFile, JSON.stringify(stale));
  const [a, b, c] = await Promise.all([
    getUserAccessToken(cfg, { fetchImpl }),
    getUserAccessToken(cfg, { fetchImpl }),
    getUserAccessToken(cfg, { fetchImpl }),
  ]);
  assert.equal(a.token, 'u-at-2');
  assert.equal(b.token, 'u-at-2');
  assert.equal(c.token, 'u-at-2');
  assert.equal(refreshCalls, 1, '单飞：并发刷新只应请求一次');
  const after = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  assert.equal(after.refresh_token, 'u-rt-2', '刷新后的新 refresh_token 必须落盘');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('镜像：无凭据/白名单外 → bot 卡；有效凭据 → 本人身份文本，Stop 输出串在其下', async () => {
  const prevHerdr = process.env.HERDR_BIN;
  process.env.HERDR_BIN = '/nonexistent-herdr-bin'; // 测试环境不依赖真 herdr
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbridge-mirror-'));
  const bridges = []; // 失败路径也要关掉，否则 server 句柄挂住测试进程
  try {
    // A) 无凭据 → 降级 bot 镜像卡
    const tA = await startBridge({ authFile: path.join(dir, 'none.json') });
    bridges.push(tA.close);
    await post(tA.base, '/hook/userpromptsubmit', { session_id: 'sess-mirror-a', cwd: DEFAULT_BINDING.cwd, prompt: '你好' });
    await waitFor(() => tA.messenger.sentTo.length === 1);
    assert.equal(tA.messenger.userTexts.length, 0);
    assert.match(tA.messenger.sentTo[0].card.header.title.content, /CLI 输入/);
    await waitFor(() => tA.messenger.updates.length === 1); // bot 镜像卡随即 patch 成受理回执卡
    assert.match(tA.messenger.updates[0].card.header.title.content, /^已开始 · 你好$/);
    // Stop 读不到 transcript（远程机器/未落盘）：另发灰色「回合已结束」收尾卡串在镜像卡下，
    // 回执卡保持「已开始」不动（updates 不再增加）
    await post(tA.base, '/hook/stop', {
      session_id: 'sess-mirror-a',
      cwd: DEFAULT_BINDING.cwd,
      transcript_path: path.join(dir, 'nope.jsonl'),
    });
    await waitFor(() => tA.messenger.replies.length === 1);
    assert.equal(tA.messenger.replies[0].messageId, 'msg_1', '收尾卡串在 bot 镜像卡下');
    assert.match(tA.messenger.replies[0].card.header.title.content, /回合已结束/);
    assert.equal(tA.messenger.replies[0].card.header.template, 'grey');
    assert.doesNotMatch(tA.messenger.replies[0].card.header.title.content, /已完成/);
    assert.equal(tA.messenger.updates.length, 1, '回执卡不被改动');
    assert.equal(tA.messenger.sentTo.length, 1, '读不到最终文本时不得独立另发卡片');
    await tA.close();

    // B) 凭据属白名单外用户 → 拒绝本人身份，降级 bot 卡
    const fileB = path.join(dir, 'b.json');
    fs.writeFileSync(fileB, JSON.stringify({ access_token: 'u-at-b', access_expires_at: Date.now() + 3600_000, refresh_token: 'rt-b', open_id: 'ou_someone_else' }));
    const tB = await startBridge({ authFile: fileB, allowedOpenIds: ['ou_me'] });
    bridges.push(tB.close);
    await post(tB.base, '/hook/userpromptsubmit', { session_id: 'sess-mirror-b', cwd: DEFAULT_BINDING.cwd, prompt: '你好B' });
    await waitFor(() => tB.messenger.sentTo.length === 1);
    assert.equal(tB.messenger.userTexts.length, 0);
    await tB.close();

    // C) 有效凭据（白名单内）→ 以本人身份发文本；受理回执卡串在其下，Stop 结果另发新卡串在其下
    const fileC = path.join(dir, 'c.json');
    fs.writeFileSync(fileC, JSON.stringify({ access_token: 'u-at-c', access_expires_at: Date.now() + 3600_000, refresh_token: 'rt-c', open_id: 'ou_me' }));
    const tC = await startBridge({ authFile: fileC, allowedOpenIds: ['ou_me'], injectAckName: 'Elio' });
    bridges.push(tC.close);
    await post(tC.base, '/hook/userpromptsubmit', { session_id: 'sess-mirror-c', cwd: DEFAULT_BINDING.cwd, prompt: '你好C' });
    await waitFor(() => tC.messenger.userTexts.length === 1);
    assert.equal(tC.messenger.userTexts[0].chatId, DEFAULT_BINDING.chatId);
    assert.equal(tC.messenger.userTexts[0].text, '你好C');
    assert.equal(tC.messenger.sentTo.length, 0, '本人身份成功后不应再发 bot 卡');
    await waitFor(() => tC.messenger.replies.length === 1);
    assert.equal(tC.messenger.replies[0].messageId, 'umsg_1', '受理回执卡串在本人身份镜像消息下（fake 计数器从 1 起）');
    assert.match(tC.messenger.replies[0].card.header.title.content, /^已开始 · 你好C$/);
    assert.match(tC.messenger.replies[0].card.body.elements[0].content, /回复 Elio：你好C/);
    // Stop 读到本回合最终输出 → 另发新卡「已完成 · 你好C」串在本人身份镜像消息下，
    // 回执卡保持「已开始」不改动
    const transcriptC = path.join(dir, 'c-transcript.jsonl');
    fs.writeFileSync(
      transcriptC,
      [
        JSON.stringify({ type: 'user', message: { content: '你好C' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '收到，这是最终回复' }] } }),
      ].join('\n') + '\n',
    );
    await post(tC.base, '/hook/stop', { session_id: 'sess-mirror-c', cwd: DEFAULT_BINDING.cwd, transcript_path: transcriptC });
    await waitFor(() => tC.messenger.replies.length === 2);
    assert.equal(tC.messenger.replies[1].messageId, 'umsg_1', 'Stop 结果卡串在本人身份镜像消息下');
    assert.match(tC.messenger.replies[1].card.header.title.content, /已完成 · 你好C/);
    assert.match(tC.messenger.replies[1].card.body.elements[0].content, /收到，这是最终回复/);
    assert.equal(tC.messenger.updates.length, 0, '回执卡不被改动');
  } finally {
    if (prevHerdr === undefined) delete process.env.HERDR_BIN;
    else process.env.HERDR_BIN = prevHerdr;
    for (const close of bridges.splice(0)) await close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 注入模式（herdr agent prompt）与防回环 ----------

import { createBridgeState } from '../src/state.mjs';

function injectFixture(agents, extraCfg = {}) {
  const herd = fakeHerdr(agents);
  const messenger = fakeMessenger();
  const runs = [];
  const state = createBridgeState();
  const runner = createChatRunner({
    herdr: herd,
    cfg: { ...CHAT_CFG, ...extraCfg },
    messenger,
    client: fakeLarkClient(),
    runClaude: fakeRunClaude(runs, (a) => ({ ok: true, result: `echo:${a.prompt}`, sessionId: 's-headless' })),
    state,
  });
  return { herd, messenger, runs, state, runner };
}

test('注入：默认注入最近活跃会话；#N 定向与排队提示；blocked 拒绝；/sessions 列表；无会话回退无头', async () => {
  const agents = [
    { agent: 'claude', pane_id: 'w1:p1', cwd: '/repo/a', agent_status: 'idle', agent_session: { value: 'sid-aaa' }, terminal_title_stripped: '任务A', state_change_seq: 10 },
    { agent: 'claude', pane_id: 'w2:p1', cwd: '/repo/a', agent_status: 'working', agent_session: { value: 'sid-bbb' }, terminal_title_stripped: '任务B', state_change_seq: 20 },
  ];
  const { herd, messenger, runs, state, runner } = injectFixture(agents, { injectAckName: 'Elio' });

  // 默认目标 = 列表第一位；注入成功 + 受理回执卡（引用指令原文）+ 防环登记
  const ev1 = msgEvent({ chatType: 'group', text: '修复登录页', messageId: 'om_inj_1' });
  await runner.handleMessage(ev1);
  await waitFor(() => messenger.replies.length === 1);
  assert.equal(herd.prompts.length, 1, '应注入而非无头执行');
  assert.equal(herd.prompts[0].paneId, 'w1:p1');
  assert.equal(herd.prompts[0].text, '修复登录页');
  assert.equal(runs.length, 0);
  assert.match(messenger.replies[0].card.header.title.content, /^已开始 · 修复登录页$/);
  assert.match(messenger.replies[0].card.body.elements[0].content, /回复 Elio：修复登录页/);
  assert.ok(state.isInjectedPrompt('sid-aaa', '修复登录页'), '注入的 prompt 不应再被镜像');
  assert.ok(!state.isInjectedPrompt('sid-aaa', '修复登录页'), '注入额度已被 hook 上报消费，手输同内容应正常镜像');
  const m1 = state.takeMirror('sid-aaa');
  assert.equal(m1?.id, 'om_inj_1', '结果卡应串在用户消息下');
  assert.equal(m1?.ackId, undefined, '不再记录回执卡 id（结果卡另发新卡，不 patch 回执）');
  assert.equal(m1?.label, '修复登录页', '结果卡标题用指令原文');

  // #2 定向 + working 排队提示（回执卡变体）
  await runner.handleMessage(msgEvent({ chatType: 'group', text: '#2 优化搜索', messageId: 'om_inj_2' }));
  await waitFor(() => messenger.replies.length === 2);
  assert.equal(herd.prompts[1].paneId, 'w2:p1');
  assert.equal(herd.prompts[1].text, '优化搜索');
  assert.match(messenger.replies[1].card.header.title.content, /排队/);
  assert.match(messenger.replies[1].card.body.elements[0].content, /回复 Elio：优化搜索/);

  // blocked：目标会话卡在确认框 → 拒绝注入并提示（文本）
  agents[0].agent_status = 'blocked';
  await runner.handleMessage(msgEvent({ chatType: 'group', text: '再来一条', messageId: 'om_inj_3' }));
  await waitFor(() => messenger.texts.length === 1);
  assert.match(messenger.texts[0].text, /等待权限确认/);
  agents[0].agent_status = 'idle';

  // /sessions 列出会话
  await runner.handleMessage(msgEvent({ chatType: 'group', text: '/sessions' }));
  await waitFor(() => messenger.texts.length === 2);
  assert.match(messenger.texts[1].text, /任务A[\s\S]*任务B/);

  // 目录下没有 herdr 会话（oc_chat2 → /repo/b）→ 回退无头执行（受理回执卡同款）
  await runner.handleMessage(msgEvent({ chatType: 'group', text: '普通任务', chatId: 'oc_chat2', messageId: 'om_fb_1' }));
  await waitFor(() => runs.length === 1);
  await waitFor(() => messenger.replies.length === 4); // 回执 + 结果新卡（两者都是 reply）
  assert.match(messenger.replies[2].card.header.title.content, /已开始/);
  assert.match(messenger.replies[3].card.body.elements[0].content, /echo:普通任务/);
  assert.equal(herd.prompts.length, 3, '/sessions 不注入，blocked 已拒绝一条不新增');
});

test('注入防环：本人镜像消息直接丢弃；断路器同内容高频跳闸只放行前两条', async () => {
  const agents = [
    { agent: 'claude', pane_id: 'w1:p1', cwd: '/repo/a', agent_status: 'idle', agent_session: { value: 'sid-aaa' }, terminal_title_stripped: '任务A', state_change_seq: 10 },
  ];
  const { herd, messenger, state, runner } = injectFixture(agents);

  // 第 1 层：镜像登记过的 message_id → 直接丢弃（不注入也不计数）
  state.markMirroredMsg('om_mirror_1');
  await runner.handleMessage(msgEvent({ chatType: 'group', text: '镜像回来的内容', messageId: 'om_mirror_1' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(herd.prompts.length, 0, '镜像回环消息应被丢弃');

  // 第 3 层：同内容 3 次/60s → 前两次注入，第三次跳闸丢弃并告警
  for (let i = 1; i <= 3; i++) {
    await runner.handleMessage(msgEvent({ chatType: 'group', text: '重复任务', messageId: `om_rep_${i}` }));
  }
  await waitFor(() => messenger.texts.some((t) => /回环/.test(t.text)));
  assert.equal(herd.prompts.length, 2, '断路器只放行前两条');
});
