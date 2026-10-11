import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../src/server.mjs';
import { buildConfirmCard, buildResultCard, buildNotifyCard, summarizeTool } from '../src/cards.mjs';

/** 假 messenger：记录发送与更新，不访问飞书 */
function fakeMessenger() {
  const sent = [];
  const updates = [];
  let n = 0;
  return {
    sent,
    updates,
    async sendCard(card) {
      sent.push(card);
      return `msg_${++n}`;
    },
    async updateCard(messageId, card) {
      updates.push({ messageId, card });
    },
  };
}

async function startBridge(cfg) {
  const messenger = fakeMessenger();
  const bridge = createBridge({ cfg, messenger });
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

test('notification / stop / notify 事件：只发通知卡片不挂起', async () => {
  const t = await startBridge({ timeoutSec: 30 });
  try {
    const n = await post(t.base, '/hook/notification', { message: 'Claude is waiting for your input', cwd: '/a' });
    assert.equal((await n.text()).trim(), '');
    const s = await post(t.base, '/hook/stop', { cwd: '/a' });
    assert.equal((await s.text()).trim(), '');
    const m = await post(t.base, '/notify', { title: '手动通知', body: 'hello', severity: 'warn' });
    const mj = JSON.parse(await m.text());
    assert.equal(mj.ok, true);
    assert.equal(t.messenger.sent.length, 3);
    assert.equal(t.messenger.sent[2].header.template, 'orange'); // severity warn
    assert.equal(t.bridge.pendingSize(), 0);
  } finally {
    await t.close();
  }
});

test('sendCard 失败：fail-open 返回空响应', async () => {
  const messenger = {
    async sendCard() { throw new Error('boom'); },
    async updateCard() {},
  };
  const bridge = createBridge({ cfg: { timeoutSec: 30 }, messenger });
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
  const t = await startBridge({ timeoutSec: 30 });
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
