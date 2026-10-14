import path from 'node:path';
import { truncate, firstToken, shortId, hostname, now } from './util.mjs';

const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/**
 * 把 tool_input 压缩成适合手机卡片阅读的摘要
 * @returns {{headline: string, detail: string}}
 */
export function summarizeTool(tool, input = {}) {
  const headlineOf = () => {
    switch (tool) {
      case 'Bash':
        return input.description || '执行 Shell 命令';
      case 'Write':
        return `写入文件 ${input.file_path || ''}`;
      case 'Edit':
      case 'MultiEdit':
        return `修改文件 ${input.file_path || ''}`;
      case 'NotebookEdit':
        return `修改 Notebook ${input.notebook_path || ''}`;
      case 'WebFetch':
        return `抓取网页 ${truncate(input.url || '', 120)}`;
      case 'WebSearch':
        return `搜索 ${truncate(input.query || '', 120)}`;
      default:
        if (tool.startsWith('mcp__')) return `MCP 工具调用`;
        return '工具调用';
    }
  };

  const detailOf = () => {
    switch (tool) {
      case 'Bash':
        return '```bash\n' + truncate(input.command, 700) + '\n```';
      case 'Write':
        return '```\n' + truncate(input.content, 400) + '\n```';
      case 'Edit':
        return (
          '```diff\n- ' +
          truncate(input.old_string, 300).replace(/\n/g, '\n- ') +
          '\n+ ' +
          truncate(input.new_string, 300).replace(/\n/g, '\n+ ') +
          '\n```'
        );
      case 'MultiEdit':
        return '```json\n' + truncate(JSON.stringify(input.edits, null, 1), 500) + '\n```';
      case 'WebFetch':
        return '```\n' + truncate(`${input.url || ''}\n${input.prompt || ''}`, 400) + '\n```';
      default:
        return '```json\n' + truncate(JSON.stringify(input, null, 1), 600) + '\n```';
    }
  };

  return { headline: headlineOf(), detail: detailOf() };
}

/** 「总是允许」规则的匹配前缀：Bash 按首命令，文件类工具按目录，其余为空 */
export function rulePrefix(tool, input = {}) {
  if (tool === 'Bash') return firstToken(input.command);
  if (FILE_TOOLS.includes(tool)) {
    const p = input.file_path || input.notebook_path || '';
    return p ? path.dirname(p) : '';
  }
  return '';
}

/** schema 2.0 按钮用 behaviors 配置回传，点击后 card.action.trigger 会原样带回 value */
function button(text, type, value) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value }],
  };
}

// ---------- 确认框选项渲染 ----------
// 模板逐字对照 Claude Code cli.js 确认框（ConsentRow）的渲染逻辑：
// 终端把所有 permission_suggestions 合并成「一个」选项，而不是每条一个选项；
// 点它 = allow + 全部条目原样作为 updatedPermissions 回传。

/** 模式显示名（cli.js br 表），用于 setMode 行「Yes, and switch to <desc> for this session」 */
const MODE_DESCRIPTIONS = {
  default: 'default (ask each time)',
  manual: 'default (ask each time)',
  acceptEdits: 'accept edits (auto-approve file edits and common file commands)',
  auto: 'auto (no routine prompts; a reviewer model screens actions)',
  dontAsk: "don't ask (auto-deny anything that would prompt)",
  plan: 'plan mode (research and propose changes without making them)',
  bypassPermissions: 'BYPASS PERMISSIONS (no further prompts)',
};

/** auto 模式选项（cli.js UI 自加、不出现在 suggestions 里）；是否渲染由终端确认框
 *  实际显示决定（读屏，见 src/dialog.mjs），不再按 permission_mode 猜 */
const AUTO_MODE_LABEL = 'Yes, and switch to auto mode';
const AUTO_MODE_DESC = '· auto mode handles these prompts for you';
export const AUTO_MODE_UPDATE = { type: 'setMode', mode: 'auto', destination: 'session' };

/** 单行截断（truncate() 会附加换行提示，不适合按钮文案） */
const clip = (t, n = 120) => {
  t = String(t ?? '');
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

/** 规则显示（cli.js Pn）：有 ruleContent 时 `Tool(rule)`，否则 `Tool` */
const ruleDisplay = (r) =>
  r?.ruleContent !== undefined && r?.ruleContent !== null ? `${r?.toolName}(${r?.ruleContent})` : `${r?.toolName}`;

/**
 * 建议行文案：按建议内容选择与 cli.js 对应的分支模板（xOn / POn / h8t / WebFetch 领域行）。
 * 返回值就是终端上那个「Yes, and …」选项的原话。
 */
export function suggestionsRowLabel(suggestions, cwd) {
  const setMode = suggestions.find((s) => s.type === 'setMode');
  if (setMode) {
    return `Yes, and switch to ${MODE_DESCRIPTIONS[setMode.mode] || setMode.mode || '?'} for this session`;
  }
  const dirs = suggestions.flatMap((s) => (s.type === 'addDirectories' ? s.directories || [] : []));
  if (dirs.length) {
    return `Yes, and always allow access to ${dirs.join(', ')} for this session`;
  }
  const rules = suggestions.flatMap((s) => (s.type === 'addRules' ? s.rules || [] : []));
  const domainRules = rules.filter((r) => typeof r?.ruleContent === 'string' && r.ruleContent.startsWith('domain:'));
  if (domainRules.length) {
    // WebFetch 等域名规则；destination 为 userSettings 时 cli.js 会追加后缀
    const suffix = suggestions.some((s) => s.destination === 'userSettings')
      ? ' in any project (user settings)'
      : '';
    return `Yes, and don’t ask again for ${domainRules.map((r) => r.ruleContent.slice('domain:'.length)).join(' and ')}${suffix}`;
  }
  const bashRules = rules.filter((r) => r?.toolName === 'Bash');
  if (bashRules.length === rules.length && rules.length) {
    // Bash 简单场景：可编辑前缀行「Yes, and don’t ask again for: <prefix>」
    return `Yes, and don’t ask again for: ${bashRules.map((r) => r.ruleContent).join(', ')}`;
  }
  // 通用行（MCP 等）：规则显示用 Pn 格式、以 " and " 连接
  return `Yes, and don’t ask again for ${clip(rules.map(ruleDisplay).join(' and '))}`;
}

/** 按钮文本字符预算：飞书按钮无对齐属性、按渲染像素折行（居中），折行会把首行顶偏。
 *  600px 默认卡宽下 Mac 端单行估算容纳 ~72-78 个 ASCII 字符，取 70 留安全余量
 *  （100 是组件硬上限，但卡 100 在 Mac 端必折行）。超预算时词边界截断加 …，
 *  完整详情左对齐补在卡片正文里。 */
const BTN_TEXT_MAX = 70;

/** 按预算截断按钮文案：优先在词边界截断（避免单词切半），边界太靠后才退回硬截断 */
function clipLabel(text, max) {
  if (text.length <= max) return text;
  let s = text.slice(0, max);
  const sp = s.lastIndexOf(' ');
  if (sp > max * 0.6) s = s.slice(0, sp);
  return `${s.trimEnd()}…`;
}

/**
 * 建议行的补充说明（cli.js 模板去掉 "Yes, and " 前缀的尾部）：
 * 按钮完整文案超出单行预算被截断时，把这段详情左对齐补在卡片正文里，编号与按钮对应。
 */
function suggestionsRowParts(suggestions) {
  const setMode = suggestions.find((s) => s.type === 'setMode');
  if (setMode) {
    return { detail: `switch to ${MODE_DESCRIPTIONS[setMode.mode] || setMode.mode || '?'} for this session` };
  }
  const dirs = suggestions.flatMap((s) => (s.type === 'addDirectories' ? s.directories || [] : []));
  if (dirs.length) {
    return { detail: `always allow access to ${dirs.join(', ')} for this session` };
  }
  const rules = suggestions.flatMap((s) => (s.type === 'addRules' ? s.rules || [] : []));
  const domainRules = rules.filter((r) => typeof r?.ruleContent === 'string' && r.ruleContent.startsWith('domain:'));
  if (domainRules.length) {
    const suffix = suggestions.some((s) => s.destination === 'userSettings')
      ? ' in any project (user settings)'
      : '';
    return {
      detail: `don’t ask again for ${domainRules.map((r) => r.ruleContent.slice('domain:'.length)).join(' and ')}${suffix}`,
    };
  }
  const bashRules = rules.filter((r) => r?.toolName === 'Bash');
  if (bashRules.length === rules.length && rules.length) {
    return { detail: `don’t ask again for: \`${clip(bashRules.map((r) => r.ruleContent).join(', '), 300)}\`` };
  }
  return { detail: `don’t ask again for ${clip(rules.map(ruleDisplay).join(' and '), 300)}` };
}

/**
 * 组装与终端确认框一致的选项列表（含顺序与编号素材）：Yes / 合并建议行 / No，
 * autoRow=true（终端确认框实际渲染了该行，读屏所得）时在建议行后插入 auto 模式行。
 * 不按 permission_mode 猜：该行可见性是 CLI 运行时状态（账号 gate 快照 / 模式 /
 * 熔断器），hook payload 里没有，猜必错——见 src/dialog.mjs。
 */
export function confirmOptions({ suggestions = [], cwd, autoRow = false } = {}) {
  const opts = [{ label: 'Yes', type: 'primary', act: 'allow' }];
  if (suggestions.length) {
    opts.push({
      label: suggestionsRowLabel(suggestions, cwd), // 终端原话
      detail: suggestionsRowParts(suggestions).detail, // 按钮截断时的正文补全
      type: 'default',
      act: 'suggest',
      updates: suggestions, // yes-apply-suggestions：全部条目原样回传
    });
  }
  if (autoRow && suggestions.length) {
    opts.push({
      label: `${AUTO_MODE_LABEL} ${AUTO_MODE_DESC}`,
      detail: AUTO_MODE_DESC.replace(/^·\s*/, ''),
      type: 'default',
      act: 'auto',
      updates: [AUTO_MODE_UPDATE],
    });
  }
  opts.push({ label: 'No', type: 'danger', act: 'deny' });
  return opts;
}

/** 卡片 schema 2.0 已移除 note 组件,用灰色富文本模拟备注行 */
function note(text) {
  return { tag: 'markdown', content: `<font color='grey'>${text}</font>` };
}

/**
 * 待确认交互卡片（schema 2.0）。
 * 带 permission_suggestions 时：选项列表与终端确认框一致（Yes / 合并建议行 /
 * 读屏决定的可选 auto 模式行 / No，带 1. 2. 3. 编号，文案对照 cli.js 渲染模板）。
 * 按钮放完整文案、按单行预算词边界截断（见 BTN_TEXT_MAX）；放不下的详情左对齐
 * 补在正文里。无 suggestions（旧 CLI / 不读该数组的确认框，如文件编辑）时回退固定三键。
 */
export function buildConfirmCard({ rid, tool, summary, cwd, session, timeoutSec, suggestions = [], autoRow = false, dialog = false }) {
  const lines = [
    `**工具**：\`${tool}\`　${summary.headline}`,
    summary.detail,
  ];
  if (cwd) lines.push(`**目录**：\`${truncate(cwd, 200)}\``);
  if (session) lines.push(`**会话**：\`${shortId(session)}\` @ \`${hostname()}\``);

  let buttons;
  if (suggestions.length) {
    lines.push('**Do you want to proceed?**');
    const opts = confirmOptions({ suggestions, cwd, autoRow });
    const labelOf = (o, i) => `${i + 1}. ${o.label}`;
    // 完整文案放不进按钮单行预算的选项：详情左对齐补在正文里，编号与按钮对应
    opts.forEach((o, i) => {
      if (labelOf(o, i).length > BTN_TEXT_MAX && o.detail) lines.push(`${i + 1}. ${o.detail}`);
    });
    buttons = opts.map((o, i) => button(clipLabel(labelOf(o, i), BTN_TEXT_MAX), o.type, { rid, act: o.act }));
  } else {
    buttons = [
      button('✅ 允许', 'primary', { rid, act: 'allow' }),
      button('👍 总是允许', 'default', { rid, act: 'always' }),
      button('❌ 拒绝', 'danger', { rid, act: 'deny' }),
    ];
  }

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '⏳ Claude Code 待确认' },
      subtitle: { tag: 'plain_text', content: tool },
      template: 'orange',
    },
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n') },
        // schema 2.0 已移除 action 组件，按钮直接放在 elements 里（官方文档指引）
        ...buttons,
        note(
          dialog
            ? `${now()} · 无超时，可随时点按（终端同步显示，先到先得）`
            : `${now()} · ${timeoutSec}s 未响应将回退为本地确认`,
        ),
      ],
    },
  };
}

const RESULT_META = {
  allow: { title: '✅ 已允许', template: 'green' },
  always: { title: '👍 已允许并记住规则', template: 'green' },
  deny: { title: '❌ 已拒绝', template: 'grey' },
  timeout: { title: '⏰ 已超时，回退本地确认', template: 'yellow' },
  cancel: { title: '🚪 已取消（客户端断开）', template: 'grey' },
  'local-allow': { title: '🖥️ 已在终端允许', template: 'green' },
  local: { title: '🖥️ 已在终端处理', template: 'grey' },
  changed: { title: '⚠️ 终端确认框已变化，请在终端处理', template: 'grey' },
};

/** 点了具体选项（suggest/auto）时，按回传条目类型给结果卡片标题 */
const choiceTitle = (choice) =>
  choice?.updates?.[0]?.type === 'setMode' ? '🔄 已允许并切换权限模式' : '👍 已允许并记住规则';

/** 按钮点击 / 超时后，把原卡片更新为结果态；choice = { label, updates } 点中的选项 */
export function buildResultCard({ tool, summary, cwd, session, nativePersist, choice }, { act, operator }) {
  const meta = choice
    ? { title: choiceTitle(choice), template: 'green' }
    : RESULT_META[act] || RESULT_META.timeout;
  const lines = [
    `**工具**：\`${tool}\`　${summary.headline}`,
    summary.detail,
  ];
  if (cwd) lines.push(`**目录**：\`${truncate(cwd, 200)}\``);
  if (session) lines.push(`**会话**：\`${shortId(session)}\``);

  const who = operator?.name
    ? `${operator.name}（${shortId(operator.open_id, 12)}）`
    : operator?.open_id
      ? shortId(operator.open_id, 16)
      : '';
  if (choice) {
    lines.push(`**所选选项**：${choice.label}`);
    if (nativePersist) lines.push('已回传 Claude Code 原生生效（持久化 / 模式切换由其完成）');
  }
  if (act === 'always' && !choice) {
    const rule = summary.__ruleHint || '同工具同类操作';
    lines.push(
      nativePersist
        ? `**规则**：\`${rule}\` 已写入 Claude Code 权限，之后不再询问`
        : `**规则**：已记住 \`${rule}\`（cc-bridge 内，daemon 重启后失效）`,
    );
  }
  if (who && ['allow', 'always', 'deny'].includes(act)) lines.push(`**操作人**：${who}`);
  if (act === 'local-allow' || act === 'local') {
    lines.push('该确认已在 Claude Code 终端处理，卡片按钮已失效');
  }
  if (act === 'changed') {
    lines.push('点卡时终端确认框已不在或选项与卡片不一致，代答未执行，卡片按钮已失效');
  }

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: meta.title },
      subtitle: { tag: 'plain_text', content: tool },
      template: meta.template,
    },
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n') },
        note(`${now()} · cc-bridge`),
      ],
    },
  };
}

// ---------- 选择题 / 计划审批卡片（AskUserQuestion / ExitPlanMode） ----------

/** 提问/审批卡的选项按钮文案（含勾选态）；沿用确认卡的按钮单行预算 */
function questionButtonLabel(o, i, toggled, multi) {
  const mark = multi ? (toggled.includes(o.n) ? '☑' : '☐') : '';
  return clipLabel(`${mark ? `${mark} ` : ''}${i + 1}. ${o.label}`, BTN_TEXT_MAX);
}

/**
 * 终端「编号选择题」对话框的飞书镜像卡：一题一卡（多问题逐题出卡），
 * 点按走与权限代答相同的「读屏验框 → 方向键/Enter/Space/Esc」路径。
 * options 来自读屏（[{n,label,desc,cursor,checked}]），desc 用 hook payload 的
 * 干净描述补全（按问题文本配对）。plan=true 为 ExitPlanMode 审批卡。
 */
export function buildQuestionCard({ rid, tool, session, cwd, question, header = '', options = [], multi = false, plan = false, planBody = '', planPath = '', toggled = [] }) {
  const lines = [];
  if (header) lines.push(`**${header}**`);
  lines.push(`**${question}**`);
  if (plan && planBody) {
    lines.push(truncate(planBody, 2000));
    if (planPath) lines.push(`<font color='grey'>计划全文：\`${truncate(planPath, 160)}\`</font>`);
  } else {
    for (const o of options) {
      lines.push(`**${o.n}. ${o.label}**`);
      if (o.desc) lines.push(truncate(o.desc, 400));
    }
  }
  if (cwd) lines.push(`**目录**：\`${truncate(cwd, 200)}\``);
  if (session) lines.push(`**会话**：\`${shortId(session)}\` @ \`${hostname()}\``);

  let buttons;
  if (plan) {
    buttons = [
      button('1. ✅ 批准（auto 模式执行）', 'primary', { rid, act: 'q-opt', opt: 1 }),
      button('2. ✅ 批准（手动确认编辑）', 'default', { rid, act: 'q-opt', opt: 2 }),
      button('3. ✋ 不批，我要再改', 'danger', { rid, act: 'q-deny' }),
    ];
  } else if (multi) {
    buttons = [
      ...options.map((o, i) =>
        button(questionButtonLabel(o, i, toggled, true), toggled.includes(o.n) ? 'primary' : 'default', { rid, act: 'q-toggle', opt: o.n }),
      ),
      button(`确认提交（已选 ${toggled.length}）`, 'primary', { rid, act: 'q-submit' }),
    ];
  } else {
    buttons = options.map((o, i) => button(questionButtonLabel(o, i, [], false), 'default', { rid, act: 'q-opt', opt: o.n }));
  }

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: plan ? '📋 计划待审批' : '❓ Claude 提问' },
      subtitle: { tag: 'plain_text', content: header || tool },
      template: plan ? 'blue' : 'orange',
    },
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n') },
        ...buttons,
        note(`${now()} · 无超时，可随时点按（终端同步显示，先到先得）`),
      ],
    },
  };
}

const QUESTION_RESULT_META = {
  'q-answered': { title: '✅ 已代答', template: 'green' },
  deny: { title: '✋ 已取消', template: 'grey' },
  local: { title: '🖥️ 已在终端处理', template: 'grey' },
  changed: { title: '⚠️ 终端选择框已变化，请在终端处理', template: 'grey' },
  answers: { title: '🖥️ 已作答', template: 'green' },
};

/** 提问/审批卡的结果态：choice.label 为代答所选（或 PostToolUse 带回的答案） */
export function buildQuestionResultCard({ tool, summary, cwd, session, question = '', header = '', plan = false }, { act, operator, choice }) {
  const meta = QUESTION_RESULT_META[act] || QUESTION_RESULT_META.local;
  const lines = [`**${plan ? '计划审批' : header || '提问'}**：${truncate(question, 120)}`];
  if (summary?.headline && summary.headline !== 'Claude 提问' && summary.headline !== '计划待审批') {
    lines.push(`**工具**：\`${tool}\``);
  }
  if (choice?.label) lines.push(`**${act === 'answers' ? '终端答案' : '所选'}**：${truncate(choice.label, 300)}`);
  if (cwd) lines.push(`**目录**：\`${truncate(cwd, 200)}\``);
  if (session) lines.push(`**会话**：\`${shortId(session)}\``);
  const who = operator?.name
    ? `${operator.name}（${shortId(operator.open_id, 12)}）`
    : operator?.open_id
      ? shortId(operator.open_id, 16)
      : '';
  if (who && ['q-answered', 'deny'].includes(act)) lines.push(`**操作人**：${who}`);
  if (act === 'local' || act === 'answers') lines.push('该问题已在 Claude Code 终端处理，卡片按钮已失效');
  if (act === 'changed') lines.push('点卡时终端选择框已不在或问题与卡片不一致，代答未执行，卡片按钮已失效');
  if (act === 'deny' && plan) lines.push('已取消审批回到计划模式；修改意见可直接发到本群（会注入该会话）');

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: meta.title },
      subtitle: { tag: 'plain_text', content: header || tool },
      template: meta.template,
    },
    body: {
      elements: [{ tag: 'markdown', content: lines.join('\n') }, note(`${now()} · cc-bridge`)],
    },
  };
}

/** 通知类卡片（Notification / Stop / 手动 notify） */
export function buildNotifyCard({ title, message, cwd, severity = 'info' }) {
  const template = { info: 'blue', warn: 'orange', error: 'red', success: 'green' }[severity] || 'blue';
  const lines = [];
  if (message) lines.push(truncate(message, 1500));
  if (cwd) lines.push(`**目录**：\`${truncate(cwd, 200)}\``);

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template,
    },
    body: {
      elements: [
        ...(lines.length ? [{ tag: 'markdown', content: lines.join('\n') }] : []),
        note(`${now()} · ${hostname()}`),
      ],
    },
  };
}

// ---------- 飞书消息驱动 Claude Code ----------

/** CLI 输入镜像卡：把用户在终端提交的 prompt 镜像到绑定群（UserPromptSubmit hook）。
 *  title 取 herdr 的会话主题（terminal_title_stripped），herdr 不可用时退化为 sid。 */
export function buildPromptMirrorCard({ prompt, title = '', sid = '', cwd = '' }) {
  const sid8 = sid ? shortId(sid) : '';
  const headerTitle = title
    ? `⌨️ CLI 输入 · ${truncate(title, 40)}`
    : sid8
      ? `⌨️ CLI 输入 · ${sid8}`
      : '⌨️ CLI 输入';
  const lines = [];
  if (prompt) lines.push(truncate(prompt, 1500));
  if (cwd) lines.push(`**目录**：\`${truncate(cwd, 200)}\``);
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: headerTitle },
      template: 'blue',
    },
    body: {
      elements: [
        ...(lines.length ? [{ tag: 'markdown', content: lines.join('\n') }] : []),
        note(`${now()} · ${hostname()}`),
      ],
    },
  };
}

/** 卡片标题里的指令原文：单行截断（truncate 会附加换行提示，标题必须单行） */
const headOf = (prompt, n = 30) => (prompt ? ` · ${clip(prompt, n)}` : '');

/** 任务结果卡：完成时**另发的新卡**（受理是来源消息上的 Get 表态，不再有受理卡），串在来源
 *  消息下；无来源消息的 Stop 输出独立发。标题带指令原文（prompt），正文为最终输出；
 *  失败/超时为橙/黄变体；muted 为灰色「回合已结束」——Stop 读不到本回合最终文本时的
 *  收尾（给回合一个结束信号，但不冒充「已完成」）。三条路径（注入/镜像/无头）共用 */
export function buildTaskResultCard({ ok = true, timedOut = false, muted = false, body = '', prompt = '', sessionId = '', cwd = '', durationMs, costUsd, numTurns } = {}) {
  const head = headOf(prompt);
  const meta = timedOut
    ? { title: `⏰ 超时${head}`, template: 'yellow' }
    : muted
      ? { title: `◌ 回合已结束${head}`, template: 'grey' }
      : ok
        ? { title: `🏁 已完成${head}`, template: 'green' }
        : { title: `⚠️ 未成功${head}`, template: 'orange' };
  const stats = [
    sessionId ? `会话 \`${shortId(sessionId)}\`` : '',
    cwd ? `\`${truncate(cwd, 80)}\`` : '',
    durationMs != null && Number.isFinite(Number(durationMs)) ? `${Math.round(Number(durationMs) / 1000)}s` : '',
    numTurns != null ? `${numTurns} 轮` : '',
    Number(costUsd) > 0 ? `$${Number(costUsd).toFixed(4)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: meta.title },
      template: meta.template,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: truncate(
            body || (muted ? '本回合已结束，未读到最终输出（transcript 不可读或尚未落盘），详见终端。' : '(无输出)'),
            3800,
          ),
        },
        note(`${now()}${stats ? ` · ${stats}` : ''}`),
      ],
    },
  };
}
