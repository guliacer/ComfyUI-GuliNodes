// GuliNodes 界面设计层（GG 设计系统）。
//
// 这套规则是从 `GG 镜头打光提示词` 的面板里总结出来的，现在所有自绘界面共用一份：
// 节点内嵌面板（打光、提示词库、拼接…）、顶栏工具菜单、悬浮框、独立弹窗。
//
// 为什么要有这一层：
//   1) 之前每个文件各写一套内联 style + 零散 CSS，颜色靠 `--comfy-menu-bg` 之类宿主变量猜，
//      一到深色主题就发灰、浅色主题就发白，同一个「主按钮」在三个界面里三种样子。
//   2) 悬停 / 键盘焦点 / 选中 / 禁用这四种状态写不进内联样式，只能进样式表；
//      写进内联之后 `:hover` 永远盖不住，只能靠 JS 逐个切色，越切越乱。
//   3) 面板高度是「量内容 → 交给节点定高 → 前端再按它给面板定高」的闭环（见 gg-panel-fit.js），
//      界面外壳必须统一 `flex: 0 0 auto`，否则带滚动的那一段会被压成 0 高。
//
// 用法：`import { applySurface, panelVars, ensureGGDesign } from "./gg-ui-design.js";`
//   - `applySurface(panel, { mode })` 给面板挂上主题属性（`auto` / `dark` / `light`）
//   - `panelVars()` 返回可直接 Object.assign 进 `host.style` 的调色板变量（画布 / 弹窗用同样一套）
//   - 结构类名统一走 `gg-*` 前缀 + `is-*` 状态类，不要再造第二套

export const GG_DESIGN_VERSION = "gg-design v1";

const STYLE_ID = "gg-design-system";
const THEME_ATTRIBUTE = "data-gg-theme";
const THEME_MODES = ["auto", "dark", "light"];
if (!globalThis.__GG_DESIGN_LOGGED__) {
  globalThis.__GG_DESIGN_LOGGED__ = true;
  console.log(`[GuliNodes] 界面设计层 ${GG_DESIGN_VERSION} 已加载`);
}

// ---------------------------------------------------------------- 调色板

// 深色是基准皮肤，浅色整套覆盖。两套都是显式取值，不靠 color-mix 从宿主色派生——
// 派生出来的中间色在浅色下常常糊在一起，读不出「这是按钮还是输入框」。
export const PALETTES = {
  dark: {
    panel: "#171B24",
    card: "#1D2431",
    btn: "#283244",
    btnHover: "#344158",
    ink: "#F0F3F8",
    muted: "#A5B0C0",
    faint: "#7F8A9C",
    accent: "#3B82F6",
    pickedBg: "#173B70",
    pickedBorder: "#3B82F6",
    divider: "#303949",
    ok: "#34D399",
    danger: "#F87171",
    field: "#11151C",
    warning: "#F59E0B",
  },
  light: {
    panel: "#F4F7FB",
    card: "#FFFFFF",
    btn: "#EEF2F8",
    btnHover: "#E1E8F4",
    ink: "#1E2733",
    muted: "#55617A",
    faint: "#7B879B",
    accent: "#2563EB",
    pickedBg: "#DCE9FD",
    pickedBorder: "#2563EB",
    divider: "#DBE2EC",
    ok: "#059669",
    danger: "#DC2626",
    field: "#FFFFFF",
    warning: "#B45309",
  },
};

const VAR_NAMES = {
  panel: "--gg-panel",
  card: "--gg-card",
  btn: "--gg-btn",
  btnHover: "--gg-btn-hover",
  ink: "--gg-ink",
  muted: "--gg-muted",
  faint: "--gg-faint",
  accent: "--gg-accent",
  pickedBg: "--gg-picked-bg",
  pickedBorder: "--gg-picked-border",
  divider: "--gg-divider",
  ok: "--gg-ok",
  danger: "--gg-danger",
  field: "--gg-field",
  warning: "--gg-warning",
};

// `pickedBg` → `picked-bg`：旧面板里写的是 `--ggl-picked-bg`，
// 直接 toLowerCase 会得到 `--ggl-pickedbg`，别名就对不上了。
const kebab = (key) => key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

/**
 * 生成调色板 CSS 变量。
 * @param {"dark"|"light"} mode
 * @returns {Record<string,string>} 形如 `{"--gg-panel": "#171B24", ...}`，可直接 Object.assign 到 style
 */
export function paletteVars(mode) {
  const palette = PALETTES[mode === "light" ? "light" : "dark"];
  const vars = {};
  for (const [key, value] of Object.entries(palette)) {
    vars[VAR_NAMES[key]] = value;
    // 兼容旧面板里已经在用 `--ggl-*` 的写法，避免两套变量名并存
    vars[`--ggl-${kebab(key)}`] = value;
  }
  return vars;
}

// ---------------------------------------------------------------- 宿主主题判定

// 宿主变量挂在祖先作用域，用 `:root` / `body` 读不到实际值——只能靠调色板名、画布底色判定。
// `getComputedStyle` 每次都会强制样式计算，按秒缓存：切主题后最多 1 秒内跟上。
let hostThemeCache = { at: 0, value: "dark" };

const NAMED_COLORS = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  darkgray: [169, 169, 169],
  darkgrey: [169, 169, 169],
  silver: [192, 192, 192],
};

export function parseCssColor(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  const named = NAMED_COLORS[text];
  if (named) return named;
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/u);
  if (hex) {
    const raw = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((index) => Number.parseInt(raw.slice(index, index + 2), 16));
  }
  const rgb = text.match(/^rgba?\(([^)]+)\)$/u);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/u).filter(Boolean).slice(0, 3).map(Number);
    if (parts.length === 3 && parts.every((part) => Number.isFinite(part))) return parts;
  }
  return null;
}

export function relativeLuminance([r, g, b]) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function detectHostTheme() {
  const now = Date.now();
  if (now - hostThemeCache.at < 1000) return hostThemeCache.value;

  let resolved = null;
  const palette = globalThis.Comfy?.ColorPalette;
  if (palette === "dark" || palette === "light") resolved = palette;
  if (!resolved) {
    const canvasColor = parseCssColor(globalThis.LGraphCanvas?.clear_background_color);
    if (canvasColor) resolved = relativeLuminance(canvasColor) < 0.5 ? "dark" : "light";
  }
  if (!resolved && typeof getComputedStyle === "function" && globalThis.document?.body) {
    const bodyColor = parseCssColor(getComputedStyle(document.body).backgroundColor);
    if (bodyColor) resolved = relativeLuminance(bodyColor) < 0.5 ? "dark" : "light";
  }

  hostThemeCache = { at: now, value: resolved || "dark" };
  return hostThemeCache.value;
}

/**
 * 把主题模式解析成具体皮肤：`auto` 跟随宿主，`dark` / `light` 由用户钉死。
 * @param {string} mode
 * @returns {"dark"|"light"}
 */
export function resolveThemeMode(mode) {
  if (mode === "dark" || mode === "light") return mode;
  return detectHostTheme();
}

/**
 * 给一个界面外壳挂上主题属性。已经是对应皮肤时不做任何事（避免无谓的样式重算）。
 * @param {HTMLElement} host 界面根元素
 * @param {{mode?: string, force?: boolean}} [options]
 * @returns {"dark"|"light"} 实际生效的皮肤
 */
export function applySurface(host, options = {}) {
  const mode = isThemeMode(options.mode) ? options.mode : "auto";
  const resolved = mode === "auto" ? syncDocumentTheme() : resolveThemeMode(mode);
  if (!host) return resolved;
  if (mode === "auto") {
    // 「自动」不钉死皮肤：把属性摘掉，让 `.gg-surface` 直接吃 `<html>` 上的全局令牌。
    // 以前这里把「创建那一刻的判定结果」写成属性，页面切了主题之后旧面板还停在原来的颜色上
    // （实测：底部工具栏在深色主题里一直是浅色）。只有用户手动指定深/浅时才钉死。
    if (host.hasAttribute(THEME_ATTRIBUTE)) host.removeAttribute(THEME_ATTRIBUTE);
    return resolved;
  }
  if (!options.force && host.getAttribute(THEME_ATTRIBUTE) === resolved) return resolved;
  host.setAttribute(THEME_ATTRIBUTE, resolved);
  return resolved;
}

// ---------------------------------------------------------------- 文档级主题

// 顶栏按钮、ComfyUI 自己容器里的浮动控件都不在任何一个 `.gg-surface` 里，
// 拿不到局部变量，只能把同一套令牌挂到 `<html>` 上做全局默认。
// 宿主切主题没有可靠的事件（老前端 `app.ui` 与新前端 `Comfy.ColorPalette` 两套），
// 所以用「读一次属性、变了才写」的低频轮询兜底；`detectHostTheme` 自带 1 秒缓存。
let documentThemeTimer = null;

export function syncDocumentTheme(options = {}) {
  const resolved = resolveThemeMode(options.mode);
  const root = globalThis.document?.documentElement;
  if (!root) return resolved;
  if (root.getAttribute(THEME_ATTRIBUTE) !== resolved) {
    root.setAttribute(THEME_ATTRIBUTE, resolved);
  }
  return resolved;
}

function startDocumentThemeWatch() {
  if (documentThemeTimer) return;
  if (typeof setInterval !== "function") return;
  documentThemeTimer = setInterval(() => {
    if (globalThis.document?.hidden) return;
    syncDocumentTheme();
  }, 2000);
  // Node 里跑无头测试时别让这个定时器把进程钉住
  documentThemeTimer?.unref?.();
}

// ---------------------------------------------------------------- 样式表

/**
 * 注入设计系统样式表（幂等）。
 */
export function ensureGGDesign() {
  if (typeof document === "undefined" || !document.head) return;
  syncDocumentTheme();
  startDocumentThemeWatch();
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
/* ===== 0. 全局默认令牌：给不在 .gg-surface 里的控件（顶栏按钮等）用 ===== */
:root[${THEME_ATTRIBUTE}="dark"] { ${cssVarsBlock("dark")} }
:root[${THEME_ATTRIBUTE}="light"] { ${cssVarsBlock("light")} }

/* ===== 1. 皮肤与基础排版 ===== */
.gg-surface {
  color: var(--gg-ink);
  background: var(--gg-panel);
  border-radius: 10px;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
.gg-surface[${THEME_ATTRIBUTE}="dark"] { ${cssVarsBlock("dark")} }
.gg-surface[${THEME_ATTRIBUTE}="light"] { ${cssVarsBlock("light")} }
.gg-surface *,
.gg-surface *::before,
.gg-surface *::after { box-sizing: border-box; }
.gg-surface ::selection { background: var(--gg-picked-bg); color: var(--gg-ink); }

/* ===== 2. 表面层级：卡片 / 分区 ===== */
.gg-card {
  display: flex; flex-direction: column; gap: 6px; min-width: 0;
  padding: 7px 8px 8px;
  border: 1px solid var(--gg-divider);
  border-radius: 8px;
  background: var(--gg-card);
}
.gg-sub { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.gg-sub + .gg-sub { border-top: 1px solid var(--gg-divider); padding-top: 6px; }
.gg-bar {
  display: flex; align-items: center; gap: 6px;
  min-width: 0; height: 22px;
}
.gg-hint {
  flex: 1 1 auto; min-width: 0;
  font-size: 11px; color: var(--gg-muted);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}

/* ===== 3. 按钮：默认 / 悬停 / 选中 / 焦点 / 禁用 五态齐备 ===== */
.gg-btn {
  flex: 0 0 auto;
  height: 24px; padding: 0 9px;
  border: 1px solid var(--gg-divider);
  border-radius: 6px;
  background: transparent;
  color: var(--gg-ink);
  font: inherit; font-size: 11.5px; line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .14s ease, border-color .14s ease, color .14s ease;
}
.gg-btn:hover { background: var(--gg-btn-hover); }
.gg-btn:focus-visible { outline: 2px solid var(--gg-accent); outline-offset: 1px; }
.gg-btn[aria-pressed="true"],
.gg-btn.is-active {
  background: var(--gg-picked-bg);
  border-color: var(--gg-picked-border);
  color: var(--gg-ink);
}
.gg-btn.is-primary { border-color: var(--gg-picked-border); color: var(--gg-accent); }
.gg-btn.is-primary:hover { background: var(--gg-picked-bg); }
.gg-btn.is-danger { color: var(--gg-danger); border-color: color-mix(in srgb, var(--gg-danger) 45%, transparent); }
.gg-btn.is-danger:hover { background: color-mix(in srgb, var(--gg-danger) 14%, transparent); }
.gg-btn:disabled,
.gg-btn[aria-disabled="true"] { opacity: .42; cursor: default; }
.gg-btn:disabled:hover { background: transparent; }

/* 胶囊小组件（工具条上的「清空」「主题」这类） */
.gg-pill {
  flex: 0 0 auto;
  height: 22px; padding: 0 10px;
  border: 1px solid var(--gg-divider);
  border-radius: 999px;
  background: var(--gg-btn);
  color: var(--gg-muted);
  font: inherit; font-size: 11px; line-height: 1;
  cursor: pointer;
  transition: color .14s ease, border-color .14s ease, background-color .14s ease;
}
.gg-pill:hover { color: var(--gg-ink); background: var(--gg-btn-hover); border-color: var(--gg-accent); }
.gg-pill:focus-visible { outline: 2px solid var(--gg-accent); outline-offset: 1px; }
.gg-pill:disabled { opacity: .42; cursor: default; }
.gg-pill:disabled:hover { color: var(--gg-muted); background: var(--gg-btn); border-color: var(--gg-divider); }

/* 分段控件：基础 / 高级 */
.gg-seg {
  display: inline-flex; flex: 0 0 auto;
  padding: 2px; gap: 2px;
  border: 1px solid var(--gg-divider);
  border-radius: 999px;
  background: var(--gg-panel);
}
.gg-seg > button {
  height: 18px; padding: 0 9px;
  border: 0; border-radius: 999px;
  background: transparent; color: var(--gg-muted);
  font: inherit; font-size: 11px; line-height: 1; cursor: pointer;
  transition: color .14s ease, background-color .14s ease;
}
.gg-seg > button:hover { color: var(--gg-ink); }
.gg-seg > button[aria-pressed="true"] { background: var(--gg-picked-bg); color: var(--gg-ink); }
.gg-seg > button:focus-visible { outline: 2px solid var(--gg-accent); outline-offset: 1px; }

/* ===== 4. 输入控件 ===== */
.gg-field {
  width: 100%;
  border: 1px solid var(--gg-divider);
  border-radius: 6px;
  padding: 5px 7px;
  background: var(--gg-field);
  color: var(--gg-ink);
  font: inherit; font-size: 11.5px; line-height: 1.5;
  outline: none;
  resize: none;
  transition: border-color .14s ease, box-shadow .14s ease;
}
.gg-field::placeholder { color: var(--gg-faint); }
.gg-field:hover { border-color: color-mix(in srgb, var(--gg-accent) 45%, var(--gg-divider)); }
.gg-field:focus { border-color: var(--gg-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--gg-accent) 26%, transparent); }
.gg-field:disabled { opacity: .55; cursor: default; }

/* 复选行 */
.gg-check {
  display: inline-flex; align-items: center; gap: 6px;
  height: 22px; padding: 0 7px;
  border-radius: 6px;
  color: var(--gg-ink); font-size: 11.5px;
  cursor: pointer;
  transition: background-color .14s ease;
}
.gg-check:hover { background: var(--gg-btn-hover); }
.gg-check input { margin: 0; accent-color: var(--gg-accent); cursor: pointer; }

/* ===== 5. 可折叠分组 ===== */
.gg-fold {
  width: 100%;
  display: flex; align-items: center; gap: 6px;
  height: 18px; padding: 0;
  border: 0; background: transparent;
  color: var(--gg-ink); text-align: left; font: inherit;
  cursor: pointer;
}
.gg-fold:hover .gg-fold-title { color: var(--gg-accent); }
.gg-fold:focus-visible { outline: 2px solid var(--gg-accent); outline-offset: 1px; border-radius: 4px; }
.gg-fold-caret { flex: 0 0 auto; width: 9px; color: var(--gg-muted); font-size: 9px; line-height: 1; }
.gg-fold-title {
  flex: 1 1 auto; min-width: 0;
  font-size: 11.5px; font-weight: 600;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  transition: color .14s ease;
}
.gg-fold-count {
  flex: 0 0 auto;
  min-width: 30px; height: 16px; padding: 0 6px;
  display: inline-flex; align-items: center; justify-content: flex-end;
  border-radius: 999px;
  background: var(--gg-btn); color: var(--gg-faint);
  font-size: 10px; line-height: 1;
}
.gg-fold-count.is-active { background: var(--gg-picked-bg); color: var(--gg-ink); }
.gg-fold-count.is-over { background: color-mix(in srgb, var(--gg-warning) 20%, transparent); color: var(--gg-warning); }

/* ===== 6. 列表与卡片行 ===== */
.gg-list {
  display: flex; flex-direction: column; gap: 6px; min-width: 0;
  overflow-y: auto; overflow-x: hidden;
  padding-right: 2px;
  scrollbar-width: thin;
  scrollbar-color: var(--gg-btn-hover) transparent;
}
.gg-row {
  display: flex; align-items: center; gap: 6px;
  min-width: 0; padding: 0 8px;
  border: 1px solid var(--gg-divider);
  border-radius: 6px;
  background: var(--gg-field);
  color: var(--gg-ink);
  cursor: pointer;
  transition: background-color .12s ease, border-color .12s ease;
}
.gg-row:hover { background: var(--gg-btn-hover); border-color: color-mix(in srgb, var(--gg-accent) 40%, var(--gg-divider)); }
.gg-row:focus-visible { outline: 2px solid var(--gg-accent); outline-offset: 1px; }
.gg-row-label {
  flex: 1 1 auto; min-width: 0;
  font-size: 11.5px;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.gg-row-actions { flex: 0 0 auto; display: flex; gap: 2px; opacity: 0; pointer-events: none; transition: opacity .12s ease; }
.gg-row:hover .gg-row-actions,
.gg-row:focus-within .gg-row-actions { opacity: 1; pointer-events: auto; }
.gg-icon-btn {
  width: 18px; height: 18px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 4px;
  background: transparent; color: var(--gg-muted);
  font: inherit; font-size: 11px; line-height: 1; cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.gg-icon-btn:hover { background: var(--gg-btn-hover); color: var(--gg-ink); }
.gg-icon-btn:focus-visible { outline: 2px solid var(--gg-accent); outline-offset: 1px; }
.gg-icon-btn.is-danger:hover { background: color-mix(in srgb, var(--gg-danger) 16%, transparent); color: var(--gg-danger); }
/* 描边变体：悬浮工具条、输入框旁的图标按钮。尺寸仍由使用方给（24 / 30 各不相同），
   这一层只管颜色与四态——以前这些按钮把白底写在 JS 内联样式里，深色主题下就是一块白。 */
.gg-icon-btn.is-outline {
  border: 1px solid var(--gg-divider);
  border-radius: 7px;
  background: transparent;
  color: var(--gg-muted);
}
.gg-icon-btn.is-outline:hover {
  border-color: color-mix(in srgb, var(--gg-accent) 45%, var(--gg-divider));
  background: var(--gg-btn-hover);
  color: var(--gg-ink);
}
.gg-icon-btn.is-outline:disabled { opacity: .42; cursor: default; }
.gg-icon-btn.is-outline:disabled:hover {
  border-color: var(--gg-divider);
  background: transparent;
  color: var(--gg-muted);
}
/* 成功 / 失败态：只换颜色，不改尺寸 */
.gg-icon-btn.is-success,
.gg-icon-btn.gg-state-success { color: var(--gg-ok); }
.gg-icon-btn.is-success:hover,
.gg-icon-btn.gg-state-success:hover { background: color-mix(in srgb, var(--gg-ok) 14%, transparent); color: var(--gg-ok); }
.gg-icon-btn.is-error,
.gg-icon-btn.gg-state-error { color: var(--gg-danger); }
.gg-icon-btn.is-error:hover,
.gg-icon-btn.gg-state-error:hover { background: color-mix(in srgb, var(--gg-danger) 14%, transparent); color: var(--gg-danger); }

/* 小号文字按钮：跟随主题 / 恢复默认这类「回退入口」。
   以前把颜色写在 JS 内联里，悬停没有任何反馈、看着不像能点；
   而且内联永远盖不住伪类，只能靠 mouseenter 逐个改色。 */
.gg-chip {
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--gg-divider);
  border-radius: 6px;
  background: transparent;
  color: var(--gg-muted);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 0.16s ease, border-color 0.16s ease, color 0.16s ease;
}
.gg-chip:hover { background: var(--gg-btn-hover); border-color: var(--gg-accent); color: var(--gg-ink); }
.gg-chip:focus-visible { outline: 2px solid var(--gg-accent); outline-offset: 1px; }
/* 当前就处在「跟随主题」状态：用主题色标出来，同时置灰不可点 */
.gg-chip[aria-pressed="true"] {
  border-color: var(--gg-accent);
  color: var(--gg-accent);
  cursor: default;
  opacity: 0.72;
}
.gg-chip[aria-pressed="true"]:hover { background: transparent; color: var(--gg-accent); }
.gg-chip:disabled { cursor: default; opacity: 0.5; }
.gg-chip:disabled:hover { background: transparent; border-color: var(--gg-divider); color: var(--gg-muted); }

/* ===== 7. 滚动条：跟随皮肤，不用系统白条 ===== */
.gg-surface ::-webkit-scrollbar { width: 8px; height: 8px; }
.gg-surface ::-webkit-scrollbar-thumb { background: var(--gg-btn-hover); border-radius: 999px; }
.gg-surface ::-webkit-scrollbar-thumb:hover { background: var(--gg-accent); }
.gg-surface ::-webkit-scrollbar-track { background: transparent; }

/* ===== 8. 弹层（悬浮框 / 菜单 / 弹窗共用外壳） ===== */
.gg-popover {
  position: fixed;
  z-index: 100006;
  width: min(360px, calc(100vw - 16px));
  max-height: min(82vh, 700px);
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--gg-divider);
  border-radius: 10px;
  background: var(--gg-panel);
  color: var(--gg-ink);
  box-shadow: 0 18px 44px rgba(15, 23, 42, .28);
  font-size: 12px;
}
.gg-popover-title {
  display: block;
  padding: 2px 6px 7px;
  color: var(--gg-muted);
  font-size: 11px; font-weight: 700;
  letter-spacing: .2px;
}
.gg-popover-row {
  width: 100%; min-height: 38px;
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: center; gap: 10px;
  padding: 4px 6px;
  border: 1px solid transparent; border-radius: 7px;
  background: transparent; color: var(--gg-ink);
  font: inherit; text-align: left;
  transition: background-color .14s ease, border-color .14s ease;
}
.gg-popover-row:hover { background: var(--gg-btn-hover); }
.gg-popover-row.is-active { border-color: color-mix(in srgb, var(--gg-accent) 42%, transparent); background: color-mix(in srgb, var(--gg-accent) 12%, transparent); }
.gg-popover-label { min-width: 0; font-size: 12.5px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.gg-popover-controls { display: inline-flex; align-items: center; gap: 4px; }

/* ===== 9. 开关按钮（顶栏用）：关 = 灰、开 = 主题色 ===== */
.gg-switch {
  width: 30px; min-width: 30px; height: 30px; min-height: 30px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--gg-divider); border-radius: 7px;
  background: transparent; color: var(--gg-muted);
  cursor: pointer;
  transition: color .14s ease, background-color .14s ease, border-color .14s ease;
}
/* 悬停只加深底色、不改颜色：否则「没开」的按钮一悬停就像「开了」 */
.gg-switch:hover { color: var(--gg-ink); background: var(--gg-btn-hover); }
.gg-switch:focus-visible { outline: 2px solid var(--gg-accent); outline-offset: 1px; }
/* 三态别名兼容：老代码分别写过 is-on / gg-state-on / active，这里一次收齐 */
.gg-switch.is-on,
.gg-switch.gg-state-on,
.gg-switch.active,
.gg-switch[aria-pressed="true"] {
  color: var(--gg-accent);
  background: color-mix(in srgb, var(--gg-accent) 16%, transparent);
  border-color: color-mix(in srgb, var(--gg-accent) 55%, transparent);
}
.gg-switch.is-on:hover,
.gg-switch.gg-state-on:hover,
.gg-switch.active:hover,
.gg-switch[aria-pressed="true"]:hover {
  background: color-mix(in srgb, var(--gg-accent) 24%, transparent);
}
.gg-switch.gg-state-off { color: var(--gg-muted); background: transparent; border-color: var(--gg-divider); }
.gg-switch.gg-state-off:hover { color: var(--gg-ink); background: var(--gg-btn-hover); }
.gg-switch:disabled { opacity: .42; cursor: default; }
.gg-switch:disabled:hover { color: var(--gg-muted); background: transparent; }

/* ===== 10. 状态条 ===== */
.gg-status { font-size: 10.5px; line-height: 14px; color: var(--gg-muted); white-space: normal; word-break: break-word; }
.gg-status.is-ok { color: var(--gg-ok); }
.gg-status.is-error { color: var(--gg-danger); }
.gg-empty { padding: 12px 6px; text-align: center; font-size: 11px; color: var(--gg-faint); }
`;
  document.head.append(style);
}

function cssVarsBlock(mode) {
  return Object.entries(paletteVars(mode)).map(([name, value]) => `${name}: ${value};`).join(" ");
}

/**
 * 判断一个主题模式是否合法（给 normalizeState 用）。
 * @param {unknown} mode
 */
export function isThemeMode(mode) {
  return THEME_MODES.includes(mode);
}

export const THEME_MODE_LABELS = { auto: "自动", dark: "深色", light: "浅色" };

/**
 * 按 自动 → 深色 → 浅色 循环取下一个模式。
 * @param {string} mode
 */
export function nextThemeMode(mode) {
  const index = THEME_MODES.indexOf(mode);
  return THEME_MODES[(index + 1) % THEME_MODES.length];
}
