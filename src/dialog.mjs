/**
 * 解析终端里正在渲染的 Claude Code 权限确认框（从 pane 可见文本中取选项列表）。
 *
 * 为什么读屏：确认卡要与终端选项「一一对应」，但 auto 模式行（"Yes, and switch to
 * auto mode"）是否显示由 CLI 运行时状态决定——账号级 gate（isAutoModeAvailable，
 * 权限上下文构建时的快照）、当前模式（只认 default/acceptEdits，manual 不认）、
 * 熔断器等——这些在 hook payload 里一概不存在，从外部推必然猜错（实测同一会话
 * 同一模型先 3 选项后 4 选项）。而 PermissionRequest hook 阻塞期间确认框就渲染
 * 在终端上：直接读 pane 拿 ground truth，有什么渲染什么。
 *
 * 形态（2.1.296 实抓样本，"--" 为虚线分隔行）：
 *   Do you want to proceed?
 *    ❯ 1. Yes
 *      2. Yes, and don’t ask again for: curl *
 *      3. Yes, and switch to auto mode · auto mode handles these prompts for you
 *      4. No
 *
 *    Esc to cancel · Tab to amend
 * 注意 Tip 行（'Tip: auto mode handles these prompts for you — choose
 * "switch to auto mode" below'）也含目标字样——必须只认编号选项行，不能全文子串。
 */

/** 编号选项行：`❯ 1. Yes` / `  2. …`（❯ 是当前选中项的光标标记） */
const NUMBERED = /^\s*(?:[❯>]\s*)?(\d{1,2})\.\s+(\S.*)$/;

/**
 * 从 pane 文本取「最后一个」确认框的选项列表（对话框渲染在 pane 底部，取最后
 * 一个 "Do you want" 锚点之后的连续编号行；窄终端下选项折行，折行内容并入所属
 * 选项）。识别不出（非对话框文本 / 竞态没渲染出来）返回 []。
 */
export function parseDialogOptions(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split('\n');
  let anchor = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/do you want/i.test(lines[i])) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) return [];
  const opts = [];
  for (let i = anchor + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/(^\s*$)|(^|\s)Esc to cancel/.test(line)) break; // 选项块结束
    const m = line.match(NUMBERED);
    if (m) {
      opts.push({ n: Number(m[1]), text: m[2].trim() });
    } else if (opts.length && line.trim()) {
      opts[opts.length - 1].text += ` ${line.trim()}`; // 折行延续
    }
  }
  const ok =
    opts.length >= 2 &&
    /^yes\b/i.test(opts[0].text) &&
    /^no\b/i.test(opts[opts.length - 1].text);
  if (!ok) return [];
  return opts.map((o) => o.text);
}

/** 选项列表里有没有 auto 模式行（终端实际渲染了才为真） */
export function dialogHasAutoRow(options) {
  return (options || []).some((o) => /switch to auto mode/i.test(o));
}
