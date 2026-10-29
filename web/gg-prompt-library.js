import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  captureManualHeight,
  lockPanelChildren,
  measurePanelHeight,
  nextWidgetHeight,
  resolveNodeWidth,
  resolveNodeHeight,
  scheduleRefit,
  setPanelNodeSize,
  trackManualHeight,
} from "./gg-panel-fit.js";
import { applySurface, ensureGGDesign } from "./gg-ui-design.js";

// ---------------------------------------------------------------------------
// GG 提示词库
//
// 面板挂在节点文本框下方，列出可点击的预设：点一下把内容追加进 `提示词`，
// 多个预设之间自动换行；预设可新增 / 编辑 / 删除，可自定义分类与颜色。
// 预设存在 ComfyUI 的 user/default/gg-prompt-library.json（后端 prompt_library.py 读写），
// 跨工作流共享；面板只做展示与交互，不自己存一份。
// ---------------------------------------------------------------------------

const NODE_NAME = "GGPromptLibrary";
const PROMPT_WIDGET = "提示词";
const DOM_WIDGET_NAME = "gg_prompt_library";
const ROUTE = "/guli/prompt_library";
// 宽度分三个数，别混用：
// DEFAULT_WIDTH 是新建节点的默认宽度；MIN_NODE_WIDTH 是节点允许拖到的最窄；
// NODE_INSET 是节点左右边框 + 内边距，面板宽度必须扣掉它。
// 以前只有一个 MIN_WIDTH = 380，既当默认宽度又当「面板最小宽度」，
// 结果节点被拖到 340 / 300 / 240 时面板死死卡在 352，右侧整块戳到节点外面。
const DEFAULT_WIDTH = 380;
const MIN_NODE_WIDTH = 200;
const NODE_INSET = 28;
// 卡片的最小可用宽度：再窄名字就只剩省略号了。三列在这个宽度下排得开。
const CARD_MIN_WIDTH = 102;
const CARD_GAP = 5;
// 列表容器左右内边距 + 竖向滚动条，算「一行能放几个」时要扣掉
const LIST_INSET = 18;
const LIST_MAX_HEIGHT = 216;
// DOM 还没排版、量不到内容高度时的兜底面板高度。
const FALLBACK_PANEL_HEIGHT = 240;
// 单击填充、双击编辑：双击会先触发一次单击，得等一小会儿再决定。
const DOUBLE_CLICK_DELAY = 220;
const STYLE_ID = "gg-prompt-library-style";

const COLORS = [
  { key: "rose", label: "玫红", value: "#e11d48" },
  { key: "amber", label: "琥珀", value: "#d97706" },
  { key: "emerald", label: "翠绿", value: "#059669" },
  { key: "sky", label: "天蓝", value: "#0284c7" },
  { key: "violet", label: "紫罗兰", value: "#7c3aed" },
  { key: "slate", label: "石板灰", value: "#64748b" },
];

// 配色只从设计层取。以前这里猜的是 `--input-text` / `--comfy-input-bg` 这类宿主变量：
// 宿主变量在不同主题下取值不一样，猜错了就是深色主题里一行灰字（用户实测报的「发灰」）。
const THEME = {
  accent: "var(--gg-accent, #3b82f6)",
  ink: "var(--gg-ink, #3f4856)",
  muted: "var(--gg-muted, #6b7280)",
  border: "var(--gg-divider, rgba(148, 163, 184, 0.38))",
  field: "var(--gg-field, rgba(127, 127, 127, 0.07))",
  warning: "var(--gg-warning, #d97706)",
};

function colorValue(key) {
  return (COLORS.find((item) => item.key === key) ?? COLORS.at(-1)).value;
}

// ---------------------------------------------------------------- 预设读写

let presetCache = null;
let pendingLoad = null;
const panelListeners = new Set();

function notifyPanels() {
  for (const listener of [...panelListeners]) {
    try {
      listener();
    } catch (error) {
      console.warn("[GuliNodes] 提示词库面板刷新失败：", error);
    }
  }
}

async function loadPresets() {
  if (presetCache) return presetCache;
  if (!pendingLoad) {
    pendingLoad = api
      .fetchApi(ROUTE, { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        presetCache = Array.isArray(data?.presets) ? data.presets : [];
        return presetCache;
      })
      .catch((error) => {
        console.warn("[GuliNodes] 提示词库读取失败：", error);
        presetCache = [];
        return presetCache;
      })
      .finally(() => {
        pendingLoad = null;
      });
  }
  return pendingLoad;
}

async function persistPresets(presets) {
  const response = await api.fetchApi(ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ presets }),
  });
  const data = await response.json().catch(() => null);
  if (!data?.ok) throw new Error(data?.message || "保存失败，请检查 ComfyUI 控制台。");
  presetCache = Array.isArray(data.presets) ? data.presets : presets;
  notifyPanels();
  return presetCache;
}

function makePresetId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------- 填充

function getWidget(node, name) {
  return node?.widgets?.find((widget) => widget?.name === name) ?? null;
}

// 多个预设依次追加、用换行分隔；末尾已经是这条时再点一次视为取消。
function applyPreset(node, preset) {
  const widget = getWidget(node, PROMPT_WIDGET);
  const text = String(preset?.text || "").trim();
  if (!widget || !text) return;

  const current = String(widget.value ?? "");
  const trimmed = current.replace(/\s+$/u, "");
  // 只有「整段就是这条」或「以换行 + 这条结尾」才算已在末尾，避免误删尾部的局部文字。
  if (trimmed === text || trimmed.endsWith(`\n${text}`)) {
    widget.value = trimmed.slice(0, trimmed.length - text.length).replace(/\s+$/u, "");
  } else {
    widget.value = trimmed ? `${trimmed}\n${text}` : text;
  }
  widget.callback?.(widget.value);
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
}

// ---------------------------------------------------------------- DOM 构件

function makeElement(tag, style, text) {
  const element = document.createElement(tag);
  if (style) Object.assign(element.style, style);
  if (text != null) element.textContent = text;
  return element;
}

function baseButtonStyle() {
  return {
    height: "24px",
    padding: "0 8px",
    border: `1px solid ${THEME.border}`,
    borderRadius: "6px",
    background: THEME.field,
    color: THEME.ink,
    fontSize: "11.5px",
    lineHeight: "1",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

function createField(extraStyle = {}) {
  return {
    width: "100%",
    boxSizing: "border-box",
    border: `1px solid ${THEME.border}`,
    borderRadius: "6px",
    padding: "4px 6px",
    background: THEME.field,
    color: THEME.ink,
    fontSize: "11.5px",
    lineHeight: "1.5",
    outline: "none",
    resize: "none",
    fontFamily: "inherit",
    ...extraStyle,
  };
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  ensureGGDesign();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
/* 分类标题：整行是折叠开关。
   负边距让悬浮底色撑满列表宽度，同时文字仍然跟卡片左边缘对齐——
   不用负边距的话，要么底色块缩在文字那么宽，要么整组内容跟着缩进 4px。 */
.gg-plib-group-head {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 18px;
  margin: 0 -4px;
  padding: 0 4px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--gg-muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.gg-plib-group-head:hover {
  background: var(--gg-btn-hover);
  color: var(--gg-ink);
}
.gg-plib-group-head:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--gg-accent) 40%, transparent);
}
/* 收起后名字变淡一点，一眼看出这组里还有东西只是没展开 */
.gg-plib-group-head.is-collapsed .gg-plib-group-name {
  opacity: 0.86;
}
.gg-plib-group-caret {
  flex: 0 0 auto;
  width: 8px;
  font-size: 9px;
  line-height: 1;
  text-align: center;
}
.gg-plib-group-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 10.5px;
}
.gg-plib-group-count {
  flex: 0 0 auto;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.gg-plib-card {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 6px;
  border: 1px solid var(--gg-divider);
  border-left-width: 3px;
  border-radius: 6px;
  background: var(--gg-field);
  color: var(--gg-ink);
  box-sizing: border-box;
  cursor: pointer;
  overflow: hidden;
  user-select: none;
  /* 栅格项默认 min-width:auto，卡片再窄也不会低于内容宽度，会把整列撑出去；
     允许压到 0 之后名字才会走省略号。另外给绝对定位的操作按钮留定位基准。 */
  min-width: 0;
  position: relative;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}
.gg-plib-card:hover {
  background: var(--gg-btn-hover);
}
.gg-plib-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11.5px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 编辑 / 删除按钮悬浮在卡片右侧，不占布局宽度。
   以前它们是 flex 兄弟节点，隐藏时仍占 38px，三列下卡片只有 108px，
   名字被挤成「四视白底…」。改成绝对定位叠在名字尾部，名字就能用满整行。 */
.gg-plib-actions {
  position: absolute;
  right: 5px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  gap: 2px;
  padding: 0 2px;
  border-radius: 5px;
  /* 悬停时卡片底色正好是 --gg-btn-hover，两者同色，看不出接缝 */
  background: var(--gg-btn-hover);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.gg-plib-card:hover .gg-plib-actions {
  opacity: 1;
  pointer-events: auto;
}
.gg-plib-action {
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--gg-muted);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.gg-plib-action:hover {
  background: var(--gg-btn-hover);
  color: var(--gg-ink);
}
.gg-plib-action.gg-plib-del:hover {
  background: color-mix(in srgb, var(--gg-danger) 16%, transparent);
  color: var(--gg-danger);
}
.gg-plib-swatch {
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
}
.gg-plib-swatch[data-active="1"] {
  border-color: var(--gg-ink);
}
/* 分类字段：按钮态（显示当前分类）+ 输入态（起新分类名），右侧箭头始终可点开菜单。
   外壳直接复用 .gg-field（悬停 / 描边都在设计层），这里只补内部排布与输入态聚焦反馈。 */
.gg-plib-group {
  overflow: hidden;
}
/* 焦点在里面的输入框时，外壳要跟着亮，否则点了「自定义」看不出已经能打字 */
.gg-plib-group:focus-within {
  border-color: var(--gg-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--gg-accent) 26%, transparent);
}
.gg-plib-group-trigger {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  padding: 0;
  display: flex;
  align-items: center;
  border: 0;
  background: transparent;
  color: var(--gg-ink);
  font: inherit;
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}
.gg-plib-group-trigger:focus-visible {
  outline: none;
}
.gg-plib-group-label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.gg-plib-group-label.is-placeholder {
  color: var(--gg-faint);
}
.gg-plib-group-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--gg-ink);
  font: inherit;
  font-size: 11.5px;
}
.gg-plib-group-input::placeholder {
  color: var(--gg-faint);
}
.gg-plib-group-caret {
  flex: 0 0 auto;
  width: 14px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--gg-muted);
  font-size: 9px;
  line-height: 1;
  cursor: pointer;
}
.gg-plib-group-caret:hover {
  color: var(--gg-accent);
}
/* 菜单项：分类名前一颗该分类的颜色圆点，与列表分组标题一致 */
.gg-plib-menu-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  margin-right: 5px;
  border-radius: 50%;
}
.gg-popover-label .gg-plib-menu-dot {
  display: inline-block;
  vertical-align: middle;
}
.gg-plib-menu-name {
  vertical-align: middle;
}
.gg-plib-menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--gg-divider);
}
`;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------- 编辑表单

function createEditor() {
  const wrap = makeElement("div", {
    display: "none",
    flexDirection: "column",
    gap: "5px",
    padding: "6px",
    border: `1px solid ${THEME.border}`,
    borderRadius: "6px",
    background: THEME.field,
  });

  const headRow = makeElement("div", { display: "flex", gap: "5px", alignItems: "center" });
  const nameInput = makeElement("input", { ...createField({ flex: "1 1 auto", minWidth: "0", height: "24px" }) });
  nameInput.placeholder = "预设名称";
  nameInput.spellcheck = false;

  // 分类：按钮态显示当前分类，点开是「自定义 + 已有分类」的菜单；选了「自定义」原地变输入框。
  // 以前这里是自由输入框，选已有分类必须把名字一字不差手打一遍，打错一个字就多出一个分类。
  // 尺寸与排布写内联（跟表单其它控件同一口径），配色与状态交给 .gg-field + 本地样式表。
  const groupBox = makeElement("div", {
    flex: "0 0 96px",
    width: "96px",
    height: "24px",
    padding: "0 4px 0 6px",
    display: "flex",
    alignItems: "center",
    gap: "2px",
  });
  groupBox.className = "gg-field gg-plib-group";

  const groupTrigger = makeElement("button", {});
  groupTrigger.type = "button";
  groupTrigger.className = "gg-plib-group-trigger";
  groupTrigger.title = "选择分类，或新建一个分类";
  const groupLabel = makeElement("span", {}, "分类");
  groupLabel.className = "gg-plib-group-label is-placeholder";
  groupTrigger.append(groupLabel);

  const groupInput = makeElement("input", {});
  groupInput.type = "text";
  groupInput.className = "gg-plib-group-input";
  groupInput.placeholder = "新分类名称";
  groupInput.spellcheck = false;
  groupInput.style.display = "none";

  const groupCaret = makeElement("button", {}, "▾");
  groupCaret.type = "button";
  groupCaret.className = "gg-plib-group-caret";
  groupCaret.title = "选择已有分类";

  groupBox.append(groupTrigger, groupInput, groupCaret);
  headRow.append(nameInput, groupBox);

  const colorRow = makeElement("div", { display: "flex", gap: "4px", alignItems: "center" });
  colorRow.append(makeElement("span", { fontSize: "10.5px", color: THEME.muted }, "颜色"));
  const swatches = new Map();
  for (const color of COLORS) {
    const swatch = makeElement("button", {
      width: "18px",
      height: "18px",
      padding: "0",
      borderRadius: "50%",
      border: "2px solid transparent",
      background: color.value,
      cursor: "pointer",
    });
    swatch.type = "button";
    swatch.className = "gg-plib-swatch";
    swatch.title = color.label;
    swatch.dataset.color = color.key;
    swatches.set(color.key, swatch);
    colorRow.append(swatch);
  }

  const textInput = makeElement("textarea", createField({ height: "68px" }));
  textInput.placeholder = "预设内容（点击卡片时会原样填进文本框）";
  textInput.spellcheck = false;

  const footRow = makeElement("div", { display: "flex", gap: "5px", alignItems: "center" });
  const saveButton = makeElement("button", { ...baseButtonStyle(), borderColor: THEME.accent, color: THEME.accent }, "保存");
  saveButton.type = "button";
  const cancelButton = makeElement("button", baseButtonStyle(), "取消");
  cancelButton.type = "button";
  const deleteButton = makeElement("button", { ...baseButtonStyle(), marginLeft: "auto", color: "#e11d48", borderColor: "rgba(225,29,72,0.4)" }, "删除");
  deleteButton.type = "button";
  footRow.append(saveButton, cancelButton, deleteButton);

  wrap.append(headRow, colorRow, textInput, footRow);

  return {
    wrap,
    nameInput,
    groupInput,
    groupBox,
    groupTrigger,
    groupLabel,
    groupCaret,
    groupValue: "",
    groupCustom: false,
    textInput,
    swatches,
    saveButton,
    cancelButton,
    deleteButton,
  };
}

// ---------------------------------------------------------------- 分类下拉
//
// 菜单挂在 `document.body` 上（`.gg-popover` 本身就是 position: fixed）：
// 面板容器 overflow: hidden，在面板里展开的下拉会被裁掉一半，
// 而且节点也不该为了弹一个菜单就变高。
//
// 内容顺序就是用户要的：先「自定义」（默认项，点了原地变输入框起新分类名），
// 分隔线下面是已有分类（带该分类的颜色圆点），点一下直接选中。
const GROUP_MENU_MIN_WIDTH = 168;
let openGroupMenu = null;

// 已有分类按首次出现顺序排，与列表里的分组顺序一致。
function groupNames() {
  const names = [];
  for (const preset of presetCache ?? []) {
    const name = preset.group || "未分类";
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function groupColorOf(name) {
  const preset = (presetCache ?? []).find((item) => (item.group || "未分类") === name);
  return colorValue(preset?.color);
}

function closeGroupMenu() {
  if (!openGroupMenu) return;
  const { dispose } = openGroupMenu;
  openGroupMenu = null;
  dispose();
}

// 一个字段两种形态：按钮态（显示已有分类）+ 输入态（起新分类名）。
// custom 不传时按「这个名字不在已有分类里」自己判断——重开工作流编辑老预设时，
// 手写的分类名要能直接接着改，不能被判成「没选分类」。
function setGroupValue(editor, value, custom) {
  const name = String(value ?? "").trim();
  const isCustom = custom ?? (name !== "" && !groupNames().includes(name));
  editor.groupValue = name;
  editor.groupCustom = isCustom;
  editor.groupTrigger.style.display = isCustom ? "none" : "";
  editor.groupInput.style.display = isCustom ? "" : "none";
  if (isCustom) editor.groupInput.value = name;
  editor.groupLabel.textContent = name || "分类";
  editor.groupLabel.classList.toggle("is-placeholder", !name);
}

// 提交时读哪个值：输入态读输入框本身（永远是最新的），按钮态读选中的分类名。
function readGroup(editor) {
  const raw = editor.groupCustom ? editor.groupInput.value : editor.groupValue;
  return String(raw ?? "").trim();
}

function positionGroupMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.max(GROUP_MENU_MIN_WIDTH, Math.round(rect.width));
  const margin = 6;
  menu.style.width = `${width}px`;
  const height = menu.offsetHeight || 0;
  let left = rect.left;
  if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
  let top = rect.bottom + 4;
  // 下面放不下就翻到上面，别让菜单跑到屏幕外
  if (height && top + height > window.innerHeight - margin) top = rect.top - 4 - height;
  menu.style.left = `${Math.round(Math.max(margin, left))}px`;
  menu.style.top = `${Math.round(Math.max(margin, top))}px`;
}

function openGroupMenuFor(panel) {
  const { editor } = panel ?? {};
  if (!editor) return;
  // 再点一次同一个字段就是收起
  if (openGroupMenu?.panel === panel) {
    closeGroupMenu();
    return;
  }
  closeGroupMenu();

  const menu = makeElement("div", { padding: "5px", visibility: "hidden" });
  menu.className = "gg-surface gg-popover gg-plib-group-menu";
  applySurface(menu);

  const title = makeElement("span", {}, "分类");
  title.className = "gg-popover-title";
  menu.append(title);

  const makeRow = (label, { active = false, hint = "", dot = null, onPick } = {}) => {
    const row = makeElement("button", {});
    row.type = "button";
    row.className = active ? "gg-popover-row is-active" : "gg-popover-row";
    const labelBox = makeElement("span", {});
    labelBox.className = "gg-popover-label";
    if (dot) {
      const dotEl = makeElement("span", { background: dot });
      dotEl.className = "gg-plib-menu-dot";
      labelBox.append(dotEl);
    }
    const nameEl = makeElement("span", {}, label);
    nameEl.className = "gg-plib-menu-name";
    labelBox.append(nameEl);
    const controls = makeElement("span", {}, active ? "✓" : hint);
    controls.className = "gg-popover-controls";
    row.append(labelBox, controls);
    row.addEventListener("click", () => {
      onPick();
      closeGroupMenu();
    });
    return row;
  };

  menu.append(makeRow("自定义", {
    // 还没选分类时「自定义」就是默认项：新预设一打开菜单，第一项是亮的
    active: editor.groupCustom || !editor.groupValue,
    hint: "输入名称",
    onPick: () => {
      // 已经是自定义态就保留正在编辑的名字，否则清空等着输入新分类名
      const keep = editor.groupCustom ? editor.groupValue : "";
      setGroupValue(editor, keep, true);
      editor.groupInput.focus();
      editor.groupInput.select?.();
    },
  }));

  const names = groupNames();
  if (names.length) {
    const sep = makeElement("div", {});
    sep.className = "gg-plib-menu-sep";
    menu.append(sep);
    for (const name of names) {
      menu.append(makeRow(name, {
        active: !editor.groupCustom && editor.groupValue === name,
        dot: groupColorOf(name),
        onPick: () => setGroupValue(editor, name, false),
      }));
    }
  }

  document.body.append(menu);
  positionGroupMenu(menu, editor.groupBox);

  const onPointerDown = (event) => {
    if (menu.contains?.(event.target) || editor.groupBox.contains?.(event.target)) return;
    closeGroupMenu();
  };
  const onKeyDown = (event) => {
    if (event.key !== "Escape") return;
    // 先收菜单，别顺带把整个编辑表单也关掉
    event.stopPropagation();
    closeGroupMenu();
  };
  // 画布缩放 / 页面滚动会让菜单和字段错位，直接收起比跟着乱跑干净
  const onReflow = () => closeGroupMenu();

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onReflow);
  window.addEventListener("scroll", onReflow, true);

  openGroupMenu = {
    panel,
    dispose() {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
      menu.remove?.();
    },
  };
  menu.style.visibility = "";
}

function openEditor(panel, preset) {
  const { editor } = panel;
  if (!editor) return;
  closeGroupMenu();
  panel.editingId = preset?.id ?? null;
  editor.nameInput.value = preset?.name ?? "";
  // 已有分类 → 按钮态；手写的分类名 → 输入态，接着改
  setGroupValue(editor, preset?.group ?? "");
  editor.textInput.value = preset?.text ?? "";
  editor.selectedColor = preset?.color ?? "slate";
  for (const [key, swatch] of editor.swatches) {
    swatch.dataset.active = key === editor.selectedColor ? "1" : "0";
  }
  editor.deleteButton.style.display = panel.editingId ? "" : "none";
  editor.wrap.style.display = "flex";
  fitNode(panel.node);
  editor.nameInput.focus();
}

function closeEditor(panel) {
  const { editor } = panel;
  if (!editor) return;
  closeGroupMenu();
  editor.wrap.style.display = "none";
  panel.editingId = null;
  fitNode(panel.node);
}

async function submitEditor(panel) {
  const { editor } = panel;
  if (!editor) return;
  const text = editor.textInput.value.trim();
  if (!text) {
    setStatus(panel, "预设内容不能为空。", true);
    return;
  }
  const name = editor.nameInput.value.trim() || text.slice(0, 12);
  const group = readGroup(editor) || "未分类";
  // 存进一个已经收起的分类时，卡片会被藏在折叠区里，看着像「没保存成功」。
  // 与打光面板「有选中项的组自动展开」同一条保护：保存到这个分类就把它展开。
  panel.collapsedGroups.delete(group);
  const presets = [...(presetCache ?? [])];
  const payload = {
    id: panel.editingId ?? makePresetId(),
    name,
    group,
    color: editor.selectedColor,
    text,
  };
  const index = presets.findIndex((item) => item.id === payload.id);
  if (index >= 0) presets[index] = payload;
  else presets.push(payload);

  try {
    await persistPresets(presets);
    closeEditor(panel);
    setStatus(panel, "");
  } catch (error) {
    setStatus(panel, String(error.message || error), true);
  }
}

async function removePreset(panel, preset) {
  const presets = (presetCache ?? []).filter((item) => item.id !== preset.id);
  if (!presets.length) {
    setStatus(panel, "至少要保留一条预设。", true);
    return;
  }
  try {
    await persistPresets(presets);
    if (panel.editingId === preset.id) closeEditor(panel);
    setStatus(panel, "");
  } catch (error) {
    setStatus(panel, String(error.message || error), true);
  }
}

function setStatus(panel, message, isError = false) {
  if (!panel?.status) return;
  panel.status.textContent = message || "";
  panel.status.style.color = isError ? THEME.warning : THEME.muted;
  panel.status.style.display = message ? "" : "none";
}

// ---------------------------------------------------------------- 面板

function createPanel(node) {
  ensureStyle();

  const host = makeElement("div", {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    flex: "0 0 auto",
    boxSizing: "border-box",
    padding: "8px",
    overflow: "hidden",
    pointerEvents: "auto",
  });
  // 面板自带皮肤：深/浅由设计层按宿主主题解析，切主题时随面板重绘一起更新
  host.className = "gg-prompt-library gg-surface";
  applySurface(host);

  // 工具条
  const toolbar = makeElement("div", { display: "flex", alignItems: "center", gap: "6px", height: "22px" });
  const info = makeElement("span", {
    flex: "1 1 auto",
    minWidth: "0",
    fontSize: "11px",
    color: THEME.muted,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  }, "加载中…");
  const addButton = makeElement("button", { ...baseButtonStyle(), height: "22px", fontSize: "11px", padding: "0 8px" }, "＋ 新增");
  addButton.type = "button";
  addButton.title = "新增一条预设";
  toolbar.append(info, addButton);

  // 列表
  const list = makeElement("div", {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    maxHeight: `${LIST_MAX_HEIGHT}px`,
    overflowY: "auto",
    overflowX: "hidden",
    paddingRight: "2px",
    scrollbarWidth: "thin",
  });
  list.addEventListener("wheel", (event) => event.stopPropagation());

  const editor = createEditor();

  const status = makeElement("span", {
    display: "none",
    fontSize: "10.5px",
    lineHeight: "14px",
    color: THEME.muted,
    whiteSpace: "normal",
    wordBreak: "break-word",
  });

  const panel = {
    node,
    host,
    list,
    info,
    addButton,
    status,
    editor,
    editingId: null,
    listener: null,
    // 收起的分类名。纯浏览状态，只存在面板对象上，不写 node.properties：
    // 重开工作流一律展开，否则会出现「一打开提示词库，内容全被自己收起来了」。
    collapsedGroups: new Set(),
    grids: [],
    maxColumns: 1,
    measuredHeight: 0,
    widgetPad: 0,
    requestedHeight: 0,
    // 用户手动拉过的高度。贴合只增不减，点折叠标题、开关编辑表单都不会把它压回去。
    // 跟着 node.size 走（工作流本来就存了节点尺寸），所以不需要另存 properties。
    manualHeight: 0,
    manualTracked: false,
    applyingFit: false,
    // 预设加载完之前不贴合（见 fitNode）：否则会拿空列表的自然高度把工作流存的尺寸压掉
    ready: false,
  };

  host.append(toolbar, list, editor.wrap, status);
  // 列表是面板里唯一带滚动的子元素，被 flex 挤压时会整块压成 0 高，所以各段一律不许收缩。
  lockPanelChildren(host);
  return panel;
}

function createCard(panel, preset) {
  const card = makeElement("div", { borderLeftColor: colorValue(preset.color) });
  card.className = "gg-plib-card";
  card.title = `${preset.name}\n\n${preset.text}`;

  const name = makeElement("span", { color: THEME.ink }, preset.name);
  name.className = "gg-plib-name";

  const actions = makeElement("div", {});
  actions.className = "gg-plib-actions";

  const editButton = makeElement("button", {}, "✎");
  editButton.type = "button";
  editButton.className = "gg-plib-action";
  editButton.title = "编辑（也可以双击卡片）";

  const deleteButton = makeElement("button", {}, "✕");
  deleteButton.type = "button";
  deleteButton.className = "gg-plib-action gg-plib-del";
  deleteButton.title = "删除这条预设";

  actions.append(editButton, deleteButton);
  card.append(name, actions);

  // 单击填充、双击编辑：单击先挂起，双击时取消。
  let clickTimer = null;
  card.addEventListener("click", (event) => {
    if (event.target?.closest?.(".gg-plib-action")) return;
    if (clickTimer) return;
    clickTimer = setTimeout(() => {
      clickTimer = null;
      applyPreset(panel.node, preset);
    }, DOUBLE_CLICK_DELAY);
  });
  card.addEventListener("dblclick", (event) => {
    if (event.target?.closest?.(".gg-plib-action")) return;
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    openEditor(panel, preset);
  });

  editButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openEditor(panel, preset);
  });
  deleteButton.addEventListener("click", (event) => {
    event.stopPropagation();
    removePreset(panel, preset);
  });

  return card;
}

// 折叠 / 展开一个分类。只动这一组的显示与箭头，不整表重渲染——
// 重建会把列表滚动位置和卡片的悬停态一起丢掉，收起一组还要滚回顶部很烦人。
function applyGroupCollapsed(panel, groupName, head, grid, caret, collapsed) {
  if (!panel || !grid) return;
  // 收起的组直接从布局里拿掉（display: none），不是设 0 高：
  // 0 高的话里面的卡片仍然参与 tab 键顺序，键盘会跳进看不见的按钮里。
  grid.style.display = collapsed ? "none" : "grid";
  if (caret) caret.textContent = collapsed ? "▸" : "▾";
  if (head) {
    head.title = `${collapsed ? "展开" : "收起"}「${groupName}」`;
    head.setAttribute?.("aria-expanded", collapsed ? "false" : "true");
    head.classList?.toggle?.("is-collapsed", collapsed);
  }
  if (collapsed) panel.collapsedGroups.add(groupName);
  else panel.collapsedGroups.delete(groupName);
}

function renderList(panel) {
  const presets = presetCache ?? [];
  panel.list.replaceChildren();
  panel.grids = [];

  if (!presets.length) {
    // 一条都不剩了，折叠记录也就全是失效的组名
    panel.collapsedGroups.clear();
    panel.list.append(
      makeElement("div", {
        padding: "10px 4px",
        fontSize: "11px",
        color: THEME.muted,
        textAlign: "center",
        lineHeight: "16px",
      }, "还没有预设，点右上角「＋ 新增」加一条。"),
    );
    return;
  }

  // 分类按首次出现顺序排，同一条预设只出现在一个分类下。
  const groups = new Map();
  for (const preset of presets) {
    const key = preset.group || "未分类";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(preset);
  }

  for (const [groupName, items] of groups) {
    const section = makeElement("div", { display: "flex", flexDirection: "column", gap: "4px", minWidth: "0" });
    section.className = "gg-plib-section";

    // 分类标题整行就是折叠开关：一个分类攒到十几条时，收起整组比一路往下滚省事。
    // 用 <button> 而不是 <div>，键盘与读屏也能操作；点名字、点箭头、点空白都算，不用去戳那个小三角。
    const head = makeElement("button", {});
    head.type = "button";
    head.className = "gg-plib-group-head";

    const caret = makeElement("span", {}, "");
    caret.className = "gg-plib-group-caret";

    const dot = makeElement("span", {
      flex: "0 0 auto",
      width: "6px",
      height: "6px",
      borderRadius: "50%",
      background: colorValue(items[0]?.color),
    });
    const label = makeElement("span", {}, groupName);
    label.className = "gg-plib-group-name";
    const count = makeElement("span", {}, String(items.length));
    count.className = "gg-plib-group-count";
    head.append(caret, dot, label, count);

    const grid = makeElement("div", {
      display: "grid",
      // 列数按「这一组有几条」算，不写死（见 applyGridColumns）：
      // 固定列数会把 4 条排成 3 + 1，最后一行孤零零一个，右边空一大片。
      gap: `${CARD_GAP}px`,
      minWidth: "0",
    });
    for (const preset of items) grid.append(createCard(panel, preset));
    panel.grids.push({ grid, count: items.length });

    // 重渲染时要恢复之前的收起状态（新增、编辑、删除都会走一遍这里）
    applyGroupCollapsed(panel, groupName, head, grid, caret, panel.collapsedGroups.has(groupName));

    head.addEventListener("click", () => {
      applyGroupCollapsed(panel, groupName, head, grid, caret, !panel.collapsedGroups.has(groupName));
      // 面板高度是「量内容 → 节点定高」的闭环，收起后要先作废旧的测量值，
      // 否则高度会停在收起前的值上，底下留一大块空白。
      panel.measuredHeight = 0;
      fitNode(panel.node);
    });

    section.append(head, grid);
    panel.list.append(section);
  }
  // 分类被删空后，折叠记录里会留下一个已经不存在的组名。不清掉的话，
  // 将来新建一个同名分类会莫名其妙以「收起」状态出现。
  for (const name of panel.collapsedGroups) {
    if (!groups.has(name)) panel.collapsedGroups.delete(name);
  }
  // 列表内容齐了才量得到真实可用宽度（滚动条会占掉一点）
  updateMaxColumns(panel);
  applyGridColumns(panel);
}

function refreshPanel(panel) {
  const presets = presetCache ?? [];
  const groupCount = new Set(presets.map((preset) => preset.group || "未分类")).size;
  panel.info.textContent = presets.length
    ? `共 ${presets.length} 条 · ${groupCount} 个分类`
    : "还没有预设";
  renderList(panel);
  fitNode(panel.node);
}

// ---------------------------------------------------------------- 布局

// 一个分组排几列：先按可用宽度算出最多能放几列，再把这一组**平均摊**到若干行上。
// 直接固定 3 列时，4 条会排成 3 + 1、5 条排成 3 + 2 但第二行只占一半，
// 最后一行总是孤零零的，右边一大片空白。按行数反推列数就没有这个问题：
//   3 条 → 1 行 3 列；4 条 → 2 行 2 列；5 条 → 2 行（3 + 2）；11 条 → 4 行（3/3/3/2）。
function columnsFor(count, maxColumns) {
  if (count <= maxColumns) return maxColumns;
  const rows = Math.ceil(count / maxColumns);
  return Math.ceil(count / rows);
}

function applyGridColumns(panel) {
  if (!panel?.grids?.length) return;
  const maxColumns = Math.max(1, Number(panel.maxColumns) || 1);
  for (const entry of panel.grids) {
    const columns = columnsFor(entry.count, maxColumns);
    entry.grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  }
}

// 可用宽度按列表容器的实际内容宽度算（滚动条出现时它会自己变窄），
// 量不到时退回「面板宽 − 列表左右内边距」。
function updateMaxColumns(panel) {
  const measured = Number(panel?.list?.clientWidth) || 0;
  const available = measured > 0 ? measured : Math.max(0, (Number(panel?.width) || DEFAULT_WIDTH - NODE_INSET) - LIST_INSET);
  panel.maxColumns = Math.max(1, Math.floor((available + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
}

function applyPanelLayout(panel, width) {
  if (!panel?.host) return;
  // 面板永远 = 节点宽度 − 内边距，不再有自己的最小宽度下限：
  // 下限只会让面板比节点宽，右边直接戳出节点（拖到 240 时溢出 112px）。
  const nodeWidth = Math.max(MIN_NODE_WIDTH, Math.round(Number(width) || DEFAULT_WIDTH));
  const panelWidth = nodeWidth - NODE_INSET;
  panel.width = panelWidth;
  Object.assign(panel.host.style, {
    width: `${panelWidth}px`,
    minWidth: `${panelWidth}px`,
    maxWidth: `${panelWidth}px`,
  });
  // 宽度变了，一行能放几个也跟着变
  updateMaxColumns(panel);
  applyGridColumns(panel);
}

function panelHeight(panel) {
  const measured = measurePanelHeight(panel?.host);
  if (measured > 40) panel.measuredHeight = measured;
  return panel?.measuredHeight || FALLBACK_PANEL_HEIGHT;
}

function fitNode(node) {
  const panel = node?.ggPromptLibraryPanel;
  if (!panel) return;
  // 预设还没加载完就不要贴合：这时列表是空的，量到的自然高度远小于真实内容，
  // 一贴就把工作流里存着的尺寸（可能是用户特意拉的）压掉，等加载完再想认领已经晚了。
  if (!panel.ready) return;
  // 宽高都只增不减：用户拖出来的尺寸不许被自动布局收回去（规则见 gg-panel-fit.js）
  const width = resolveNodeWidth(node, MIN_NODE_WIDTH, DEFAULT_WIDTH);
  applyPanelLayout(panel, width);

  const computed = typeof node.computeSize === "function" ? node.computeSize() : null;
  // 用户拉高过就按用户的高度来：贴合只许把节点撑大，不许替他收小。
  const height = resolveNodeHeight(panel, Math.max(Number(computed?.[1]) || 0, panelHeight(panel)));
  const current = [Number(node.size?.[0]) || 0, Number(node.size?.[1]) || 0];
  if (current[0] === width && Math.abs(current[1] - height) <= 1) return;

  setPanelNodeSize(panel, node, [width, height]);
  node.size = [width, height];
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  scheduleRefit(node, fitNode);
}

// ---------------------------------------------------------------- 安装

function bindPanel(panel) {
  panel.addButton.addEventListener("click", () => {
    if (panel.editor?.wrap.style.display === "flex" && !panel.editingId) {
      closeEditor(panel);
      return;
    }
    openEditor(panel, null);
  });

  const { editor } = panel;
  if (!editor) return;

  for (const [key, swatch] of editor.swatches) {
    swatch.addEventListener("click", () => {
      editor.selectedColor = key;
      for (const [otherKey, other] of editor.swatches) {
        other.dataset.active = otherKey === key ? "1" : "0";
      }
    });
  }

  editor.saveButton.addEventListener("click", () => submitEditor(panel));
  editor.cancelButton.addEventListener("click", () => closeEditor(panel));
  editor.deleteButton.addEventListener("click", () => {
    const preset = (presetCache ?? []).find((item) => item.id === panel.editingId);
    if (preset) removePreset(panel, preset);
  });

  // 分类：按钮态点名字或箭头都开菜单；输入态边打边记到 groupValue（提交时只读它）
  editor.groupTrigger.addEventListener("click", () => openGroupMenuFor(panel));
  editor.groupCaret.addEventListener("click", () => openGroupMenuFor(panel));
  editor.groupInput.addEventListener("input", () => {
    editor.groupValue = editor.groupInput.value;
  });

  for (const input of [editor.nameInput, editor.groupInput, editor.textInput]) {
    input.addEventListener("wheel", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        // 正在起新分类名时，Esc 先退出输入态（退回「分类」按钮），不整个关掉表单——
        // 输错一个字就丢掉整张表单太重了。
        if (input === editor.groupInput && editor.groupCustom) {
          setGroupValue(editor, "", false);
          return;
        }
        closeEditor(panel);
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) submitEditor(panel);
    });
  }

  panel.listener = () => refreshPanel(panel);
  panelListeners.add(panel.listener);
}

function isLibraryNode(node) {
  return Boolean(node) && (node.comfyClass === NODE_NAME || node.type === NODE_NAME);
}

function setupNode(node) {
  if (!isLibraryNode(node)) return;
  const widget = getWidget(node, PROMPT_WIDGET);
  if (!widget) return;

  if (node.ggPromptLibraryPanel) {
    refreshPanel(node.ggPromptLibraryPanel);
    return;
  }
  if (typeof node.addDOMWidget !== "function") return;

  const panel = createPanel(node);
  node.ggPromptLibraryPanel = panel;
  bindPanel(panel);

  let domWidget = null;
  try {
    domWidget = node.addDOMWidget(DOM_WIDGET_NAME, "gg_prompt_library", panel.host, {
      getValue() {
        return "";
      },
      setValue() {},
      serialize: false,
    });
  } catch (error) {
    console.warn("[GuliNodes] GG 提示词库面板创建失败：", error);
    node.ggPromptLibraryPanel = null;
    if (panel.listener) panelListeners.delete(panel.listener);
    return;
  }

  domWidget.computeSize = function (width) {
    const nodeWidth = Math.max(MIN_NODE_WIDTH, Number(width) || node.size?.[0] || DEFAULT_WIDTH);
    applyPanelLayout(panel, nodeWidth);
    return [nodeWidth, nextWidgetHeight(panel, panelHeight(panel))];
  };
  domWidget.onRemoved = function () {
    closeGroupMenu();
    if (panel.listener) panelListeners.delete(panel.listener);
    panel.listener = null;
    panel.host.remove?.();
  };

  // 用户手动拉过高度之后，贴合只许撑大不许收小：点折叠标题、开关编辑表单都不再把节点压回去。
  trackManualHeight(panel, node);

  const settle = () => {
    panel.ready = true;
    refreshPanel(panel);
    // 内容齐了才能判断「工作流里存的高度是不是用户自己拉的」：预设还没进来时自然高度偏小，
    // 会把默认高度误判成手动高度，之后节点就再也缩不回去了。
    panel.measuredHeight = 0;
    captureManualHeight(
      panel,
      node,
      Math.max(Number(node.computeSize?.()?.[1]) || 0, panelHeight(panel)),
      node._ggPlSavedHeight,
    );
    fitNode(node);
  };
  loadPresets().then(settle).catch(settle);

  requestAnimationFrame(() => fitNode(node));
  setTimeout(() => fitNode(node), 120);
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.PromptLibrary",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME || nodeType.prototype._ggPromptLibraryProtoPatched) return;
    nodeType.prototype._ggPromptLibraryProtoPatched = true;

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalOnNodeCreated?.apply(this, args);
      setTimeout(() => setupNode(this), 0);
      return result;
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      // 前端挂 DOM 控件时会把节点压回内容高度，等预设加载完再读 node.size 已经晚了，
      // 读到的是被压过的值。工作流里存的原始尺寸在这里先记下来，贴合时用它认领。
      const info = args?.[0];
      if (info?.size && typeof info.size.length === "number" && info.size.length >= 2) {
        this._ggPlSavedHeight = Math.round(Number(info.size[1]) || 0);
      }
      const result = originalOnConfigure?.apply(this, args);
      setTimeout(() => setupNode(this), 0);
      return result;
    };

    const originalOnResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      const result = originalOnResize?.apply(this, arguments);
      const width = Math.max(MIN_NODE_WIDTH, Number(size?.[0]) || Number(this.size?.[0]) || DEFAULT_WIDTH);
      applyPanelLayout(this.ggPromptLibraryPanel, width);
      return result;
    };
  },

  nodeCreated(node) {
    if (isLibraryNode(node)) setTimeout(() => setupNode(node), 0);
  },

  loadedGraphNode(node) {
    if (isLibraryNode(node)) setTimeout(() => setupNode(node), 0);
  },
});
