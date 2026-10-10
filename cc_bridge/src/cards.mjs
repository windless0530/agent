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

function button(text, type, value) {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type, value };
}

function note(text) {
  return { tag: 'note', elements: [{ tag: 'plain_text', content: text }] };
}

/** 待确认交互卡片（schema 2.0） */
export function buildConfirmCard({ rid, tool, summary, cwd, session, timeoutSec }) {
  const lines = [
    `**工具**：\`${tool}\`　${summary.headline}`,
    summary.detail,
  ];
  if (cwd) lines.push(`**目录**：\`${truncate(cwd, 200)}\``);
  if (session) lines.push(`**会话**：\`${shortId(session)}\` @ \`${hostname()}\``);

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
        {
          tag: 'action',
          actions: [
            button('✅ 允许', 'primary', { rid, act: 'allow' }),
            button('👍 总是允许', 'turquoise', { rid, act: 'always' }),
            button('❌ 拒绝', 'danger', { rid, act: 'deny' }),
          ],
        },
        note(`${now()} · ${timeoutSec}s 未响应将回退为本地确认`),
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
};

/** 按钮点击 / 超时后，把原卡片更新为结果态 */
export function buildResultCard({ tool, summary, cwd, session, nativePersist }, { act, operator }) {
  const meta = RESULT_META[act] || RESULT_META.timeout;
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
  if (act === 'always') {
    const rule = summary.__ruleHint || '同工具同类操作';
    lines.push(
      nativePersist
        ? `**规则**：\`${rule}\` 已写入 Claude Code 权限，之后不再询问`
        : `**规则**：已记住 \`${rule}\`（cc-bridge 内，daemon 重启后失效）`,
    );
  }
  if (who && ['allow', 'always', 'deny'].includes(act)) lines.push(`**操作人**：${who}`);

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
