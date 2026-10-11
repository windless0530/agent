import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../src/server.mjs';
import { loadConfig, validateServeConfig } from '../src/config.mjs';
import { createChatRunner, extractText } from '../src/agent.mjs';
import {
  buildConfirmCard,
  buildResultCard,
  buildNotifyCard,
  summarizeTool,
  buildChatAckCard,
  buildChatResultCard,
} from '../src/cards.mjs';
import { waitFor } from '../src/util.mjs';

/** 假 messenger：记录发送与更新，不访问飞书（无 peer 通道，只有定向发送） */
function fakeMessenger() {
  const sent = [];
  const sentTo = [];
  const updates = [];
  const replies = [];
  const texts = [];
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

async function startBridge(cfg = {}) {
  const messenger = fakeMessenger();
  const merged = { ...cfg, bindings: [...(cfg.bindings || []), DEFAULT_BINDING] };
  // 卡片路由依赖 chat runner 的 chatForCwd，必须一并挂上
  const chat = createChatRunner({ cfg: merged, messenger, client: fakeLarkClient() });
  const bridge = createBridge({ cfg: merged, messenger, chat });
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
    assert.equal(t.messenger.sent.length, 2); // 只有确认卡，无 stop 通知卡（notifyStop 默认关）
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
    const n = await post(t.base, '/hook/notification', { message: 'Claude is waiting for your input', cwd: '/home/user/project' });
    assert.equal((await n.text()).trim(), '');
    // notifyStop 默认关：Stop 只用于结算挂起确认，不发「任务完成」卡
    const s = await post(t.base, '/hook/stop', { cwd: '/home/user/project' });
    assert.equal((await s.text()).trim(), '');
    const m = await post(t.base, '/notify', { title: '手动通知', body: 'hello', severity: 'warn', cwd: '/home/user/project' });
    const mj = JSON.parse(await m.text());
    assert.equal(mj.ok, true);
    assert.equal(t.messenger.sent.length, 2); // 通知卡 + 手动通知卡，无 stop 卡
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

test('notifyStop: true 时 Stop 事件发「任务完成」通知卡', async () => {
  const t = await startBridge({ timeoutSec: 30, notifyStop: true });
  try {
    const s = await post(t.base, '/hook/stop', { cwd: '/home/user/project', session_id: 'sess-none' });
    assert.equal((await s.text()).trim(), '');
    assert.equal(t.messenger.sent.length, 1);
    assert.match(t.messenger.sent[0].header.title.content, /完成/);
    assert.equal(t.messenger.sent[0].header.template, 'green');
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

test('PermissionRequest：选项个数/文案与终端确认框一致（Yes / 合并建议行 / auto / No）', async () => {
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
    assert.equal(btns.length, 4); // Yes / 建议行 / auto 行 / No，与终端 4 选项一致
    assert.equal(btns[0].text.content, '1. Yes');
    // 建议行 = 终端原话（cli.js POn 模板），不再笼统为「总是允许」
    assert.equal(btns[1].text.content, `2. Yes, and don't ask again for: rm -rf node_modules`);
    assert.equal(btns[2].text.content, '3. Yes, and switch to auto mode · auto mode handles these prompts for you');
    assert.equal(btns[3].text.content, '4. No');
    assert.match(card.body.elements[0].content, /Do you want to proceed\?/);
    assert.equal(btns[1].behaviors[0].value.act, 'suggest');
    assert.equal(btns[2].behaviors[0].value.act, 'auto');

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

test('PermissionRequest：点 auto 选项 → 回传 setMode{auto,session}；模式门控对齐 cli.js', async () => {
  const t = await startBridge({ timeoutSec: 30 });
  try {
    let p = post(t.base, '/hook/permissionrequest', PR_PAYLOAD); // permission_mode 缺省按 default
    await new Promise((r) => setTimeout(r, 150));
    let rid = clickRid(t.messenger.sent[0], 'auto');
    await t.bridge.handleCardAction({ action: { value: { rid, act: 'auto' } }, operator: { open_id: 'ou_u' } });
    let j = JSON.parse(await (await p).text());
    assert.deepEqual(j.hookSpecificOutput.decision.updatedPermissions, [
      { type: 'setMode', mode: 'auto', destination: 'session' },
    ]);
    assert.match(JSON.stringify(t.messenger.updates[0].card), /切换权限模式/);

    // acceptEdits 下也提供 auto（对齐 cli.js wTt 条件）
    p = post(t.base, '/hook/permissionrequest', { ...PR_PAYLOAD, permission_mode: 'acceptEdits' });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(clickRid(t.messenger.sent[1], 'auto'));

    // plan 模式不提供 auto
    p = post(t.base, '/hook/permissionrequest', { ...PR_PAYLOAD, permission_mode: 'plan' });
    await new Promise((r) => setTimeout(r, 150));
    const acts = t.messenger.sent[2].body.elements
      .filter((e) => e.tag === 'button')
      .map((b) => b.behaviors[0].value.act);
    assert.deepEqual(acts, ['allow', 'suggest', 'deny']);
    rid = clickRid(t.messenger.sent[2], 'deny');
    await t.bridge.handleCardAction({ action: { value: { rid, act: 'deny' } }, operator: { open_id: 'ou_u' } });
    j = JSON.parse(await (await p).text());
    assert.equal(j.hookSpecificOutput.decision.behavior, 'deny');
  } finally {
    await t.close();
  }
});

test('PermissionRequest：建议合并行按建议内容选 cli.js 模板；垃圾条目被过滤；无建议回退三键', async () => {
  const t = await startBridge({ timeoutSec: 30 });
  try {
    // setMode 建议 → 「Yes, and switch to <模式描述> for this session」
    let p = post(t.base, '/hook/permissionrequest', PR_PAYLOAD); // 含 setMode acceptEdits 建议
    await new Promise((r) => setTimeout(r, 150));
    let btn = t.messenger.sent[0].body.elements.find((e) => e.behaviors?.[0]?.value?.act === 'suggest');
    assert.equal(
      btn.text.content,
      '2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session',
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
    assert.equal(btn.text.content, '2. Yes, and don\'t ask again for example.com in any project (user settings)');

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
  const runner = createChatRunner({
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
  await waitFor(() => messenger.updates.length === 1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].prompt, '查看git状态'); // 压缩空白
  assert.equal(runs[0].cwd, '/repo/a'); // 在绑定目录执行
  assert.equal(runs[0].sessionId, ''); // 首条无会话
  assert.equal(runs[0].env.CC_BRIDGE_FROM_CHAT, '1');
  // 回执卡片先发（蓝色处理中），跑完 patch 成结果卡片（绿色含回复）
  assert.equal(messenger.replies[0].card.header.template, 'blue');
  assert.equal(messenger.updates[0].card.header.template, 'green');
  assert.match(messenger.updates[0].card.body.elements[0].content, /echo:查看git状态/);

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
  const runner = createChatRunner({
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
  const runner = createChatRunner({
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
  // 一：受理回执→结果；二：受理回执(黄)→开始处理(蓝)→结果(绿)
  await waitFor(() => messenger.updates.filter((u) => u.card.header.template === 'green').length === 2);
  assert.equal(messenger.updates[1].card.header.template, 'blue');
  assert.match(messenger.updates[2].card.body.elements[0].content, /二/);
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

test('消息驱动：runClaude 失败/超时 → 回执更新为失败/超时卡片', async () => {
  const messenger = fakeMessenger();
  const runner = createChatRunner({
    cfg: CHAT_CFG,
    messenger,
    client: fakeLarkClient(),
    runClaude: async () => ({ ok: false, timedOut: true, error: '超过 60s 未完成，已终止' }),
  });
  await runner.handleMessage(msgEvent({ chatType: 'group', text: '慢任务' }));
  await waitFor(() => messenger.updates.length === 1);
  const card = messenger.updates[0].card;
  assert.equal(card.header.template, 'yellow');
  assert.match(card.header.title.content, /超时/);
  assert.match(card.body.elements[0].content, /超过 60s/);

  const runner2 = createChatRunner({
    cfg: CHAT_CFG,
    messenger,
    client: fakeLarkClient(),
    runClaude: async () => ({ ok: false, error: 'claude 退出码 1' }),
  });
  await runner2.handleMessage(msgEvent({ chatType: 'group', text: '会失败', chatId: 'oc_chat2', messageId: 'om_2' }));
  await waitFor(() => messenger.updates.length === 2);
  assert.equal(messenger.updates[1].card.header.template, 'orange');
  assert.match(messenger.updates[1].card.body.elements[0].content, /claude 退出码 1/);
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
  const chat = createChatRunner({ cfg: { ...CHAT_CFG }, messenger, client: fakeLarkClient() });
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

  const ack = buildChatAckCard({ prompt: 'p', queued: true });
  assert.equal(ack.header.template, 'yellow');
  const ok = buildChatResultCard({
    ok: true, result: '答案', sessionId: 'sess-abc12345', cwd: '/w',
    durationMs: 1500, costUsd: 0.005, numTurns: 2,
  });
  assert.equal(ok.header.template, 'green');
  assert.match(ok.body.elements[0].content, /答案/);
  assert.match(ok.body.elements.at(-1).content, /2s.*2 轮/);
  const fail = buildChatResultCard({ ok: false, error: '崩了' });
  assert.equal(fail.header.template, 'orange');
  assert.match(fail.body.elements[0].content, /崩了/);
});

test('health：包含消息驱动状态；__fromChat 的 stop 事件被抑制', async () => {
  const messenger = fakeMessenger();
  const chat = createChatRunner({
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
