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

// ---------- 编号选择题对话框（AskUserQuestion / ExitPlanMode） ----------
//
// 这两类工具在终端渲染「编号选择题」无限等待，但不触发 PermissionRequest：
//   AskUserQuestion（实抓样本，│ 是 pane 读屏带来的 CLI 边框）：
//     地图上「被选族群的区域」如何判定？                                        │
//                                                                                │
//       1. 任一被选族群在场即点亮 (Recommended)                                 │
//          被选族群在该区域当年存在（含非主族群）即点亮——…                     │
//     ❯ 2. 仅主族群点亮                                                         │
//          只点亮被选族群为该区域主族群（着色者）的几何——…                     │
//       3. Type something.                                                      │
//     ─────────────────────────────────────────────────────────────────────     │
//       4. Chat about this                                                      │
//                                                                                │
//     Enter to select · Tab/Arrow keys to navigate · Esc to cancel              │
//   多问题时逐题渲染，末尾出复审框（Ready to submit your answers? 1. Submit
//   answers / 2. Cancel）；ExitPlanMode 则是：
//     Claude has written up a plan and is ready to execute. Would you like to proceed?
//      ❯ 1. Yes, and use auto mode
//        2. Yes, manually approve edits
//        3. Tell Claude what to change
// 与权限确认框（parseDialogOptions，"Do you want" 锚点 + Yes/No 首尾）互斥：
// 权限框页脚是 "Esc to cancel · Tab to amend"，问句是 "Do you want"——本解析器
// 锚定 "Enter to select" 页脚或 "has written up a plan" 问句，不会互相误判。

/** 问题/选项行归一化：截掉 CLI 边框（│）及右侧内容（分栏视图下同一行还有
 *  右栏文本——diff/文件预览面板），只留对话框所在左栏。 */
const stripFrame = (line) => String(line ?? '').split(/[│┃]/)[0].trimEnd();

/** 编号选项行：`❯ 1. label` / `  2. …`，可带多选勾选符（☐ ☒ ☑ [ ] [x]） */
const CHOICE_NUMBERED = /^\s*(?:([❯>])\s*)?(?:([☐☒☑]|(?:\[[ xX]\]))\s*)?(\d{1,2})\.\s+(\S.*)$/;
/** 选项块与问题块之间的整行分隔线（─ / ┄ 等） */
const RULE_LINE = /^(?:[─═━┄┈-]\s*){3,}$/;

/** 问题文本归一化为卡片配对 key：截边框右栏、去空白、小写。读屏行已由
 *  stripFrame 截过右栏，这里对入参（payload 问题等）同样防御性处理 */
export function choiceDialogKey(question) {
  return String(question ?? '')
    .split(/[│┃]/)[0]
    .replace(/\s+/g, '')
    .toLowerCase()
    .slice(0, 80);
}

/**
 * 从 pane 文本解析「最后一个」编号选择题对话框。
 * 返回 { kind: 'question'|'review'|'plan', question, options: [{n,label,desc,cursor,checked}] }
 * options 按屏幕顺序排列；cursor 标记当前 ❯ 行（缺省视为第 1 项）；checked 仅多选框有。
 * 识别不出（非选择题 / 竞态没渲染）返回 null。
 *
 * 防 prose 误判（实测踩坑：pane 里正在编辑 README/diff，文档本身引用了
 * "Would you like to proceed?" / "Enter to select" 等锚点文案）：① 对话框渲染在
 * pane 底部，锚点只在最后 45 行里找——历史输出里出现过的锚点是过期框，不认；
 * ② ExitPlanMode 锚点用整句特征 "has written up a plan"，且首选项须以 Yes 起
 * 头（canonical 选项文案）；③ 权限框的 "Do you want" 不参与本解析器。
 */
export function parseChoiceDialog(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.split('\n').map(stripFrame);
  const floor = Math.max(0, lines.length - 45); // 对话框只在 pane 底部区域

  // ExitPlanMode：问句本身即锚点（其下才是选项）
  let anchor = -1;
  for (let i = lines.length - 1; i >= floor; i--) {
    if (/has\s+written\s+up\s+a\s+plan/i.test(lines[i])) {
      anchor = i;
      break;
    }
  }
  if (anchor >= 0) return parsePlanDialog(lines, anchor);

  // AskUserQuestion 族：找最后一个选择页脚（单选 "Enter to select"；多选可能为
  // Space/Enter 提示措辞），选项在页脚上方
  let footer = -1;
  for (let i = lines.length - 1; i >= floor; i--) {
    if (/enter to select|space to (select|toggle)|enter to (submit|confirm)/i.test(lines[i])) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return null;
  return parseQuestionDialog(lines, footer);
}

/** ExitPlanMode 审批框：问句行 → 空行 → 编号选项（向下收集） */
function parsePlanDialog(lines, anchor) {
  const question = lines[anchor].trim();
  const opts = [];
  let i = anchor + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/(^|\s)ctrl\+g to edit/i.test(line)) break; // 页脚提示
    const m = line.match(CHOICE_NUMBERED);
    if (m) {
      opts.push({ n: Number(m[3]), label: m[4].trim(), desc: '', cursor: !!m[1], checked: m[2] ? /[☒☑xX]/.test(m[2]) : undefined });
    } else if (opts.length && line.trim() && !/^\s*$/.test(line)) {
      opts[opts.length - 1].desc += ` ${line.trim()}`; // 折行/说明并入上一选项
    } else if (opts.length && /^\s*$/.test(line)) {
      break; // 选项块结束
    }
  }
  // canonical 选项以 Yes 起头（"Yes, and use auto mode" …）；对不上按识别失败处理
  if (opts.length < 2 || !/^yes/i.test(opts[0].label)) return null;
  return { kind: 'plan', question, options: opts };
}

/** AskUserQuestion 族：从页脚向上收选项（说明行并入其上方选项），再越过空行收问题 */
function parseQuestionDialog(lines, footer) {
  const opts = []; // 向上收集，最后 reverse
  let pendingDesc = []; // 暂存说明行：属于向上遇到的下一个（更靠上的）选项
  let i = footer - 1;
  let questionLines = [];
  let inQuestion = false;
  for (; i >= 0; i--) {
    const line = lines[i];
    if (inQuestion) {
      // 问题块到头（分隔线 / 结构行）。注意 "Ready to submit your answers?" 是复审框
      // 的问题文本本身，不能当结构行——否则复审框被识别成普通问题
      if (!line.trim() || /^(─|═|━)?\s*(Planning:|Review your answers)/i.test(line.trim()) || RULE_LINE.test(line.trim())) {
        break;
      }
      questionLines.push(line.trim());
      if (questionLines.length >= 3) break; // 问题最多收 3 行（折行保护）
      continue;
    }
    if (RULE_LINE.test(line.trim())) continue; // 选项块内的分隔线（3. 与 4. 之间）
    const m = line.match(CHOICE_NUMBERED);
    if (m) {
      opts.push({
        n: Number(m[3]),
        label: m[4].trim(),
        desc: pendingDesc.reverse().join(' '),
        cursor: !!m[1],
        checked: m[2] ? /[☒☑xX]/.test(m[2]) : undefined,
      });
      pendingDesc = [];
      continue;
    }
    if (!line.trim()) {
      if (opts.length) {
        inQuestion = true; // 选项块结束，向上进问题块
        continue;
      }
      continue; // 页脚与最后一个选项之间的空行
    }
    pendingDesc.push(line.trim()); // 选项说明/折行（属于上方选项）
  }
  if (opts.length < 2) return null;
  opts.reverse();
  const question = questionLines.reverse().join(' ').trim() || '(未识别到问题文本)';
  const kind = /ready to submit your answers\?/i.test(question) ? 'review' : 'question';
  return { kind, question, options: opts };
}
