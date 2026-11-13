import { app } from "../../scripts/app.js";
import { detectHostTheme } from "./gg-ui-design.js";

// ---------------------------------------------------------------------------
// GG 文本框字数统计
//
// 只给 GuliNodes 节点的**多行文本框**（TEXTAREA）挂一个小角标，单行输入框
// （文件名、API Key、模型名等）不统计，避免满屏都是数字。
//
// 角标直接挂在 textarea 的父容器里（宿主给每个 DOM 控件都套了 .dom-widget），
// 用绝对定位跟随节点移动 / 缩放，不需要每帧读 getBoundingClientRect。
// 统计口径：去掉空白（空格、换行、全角空格）后的字符数，emoji 按 1 个字算。
// ---------------------------------------------------------------------------

const STYLE_ID = "gg-text-count-style";
const COUNTER_CLASS = "gg-text-count";
const SCAN_INTERVAL = 500;

function isGGNode(node) {
  const module = node?.constructor?.nodeData?.python_module
    ?? node?.nodeData?.python_module
    ?? node?.python_module;
  if (typeof module === "string" && module) {
    return module.startsWith("custom_nodes.ComfyUI-GuliNodes")
      || module.startsWith("guli_nodes");
  }
  const type = String(node?.comfyClass ?? node?.type ?? "");
  // 只按前缀判断时要排除第三方 GGUF 节点（GGUFLoader 也以 "GG" 开头）。
  return type.startsWith("GG") && !type.startsWith("GGUF");
}

function graphList() {
  const graphs = [];
  const push = (graph) => {
    if (graph && !graphs.includes(graph)) graphs.push(graph);
  };
  push(app.graph);
  push(app.canvas?.graph);
  for (const value of app.graph?._subgraphs?.values?.() ?? []) {
    push(value?.graph ?? value);
  }
  return graphs;
}

function countChars(text) {
  // elide whitespace so the number matches what users mean by 「字数」；
  // [...text] 按 Unicode 码点切分，emoji 不会被算成两个。
  return [...String(text ?? "").replace(/\s/gu, "")].length;
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.${COUNTER_CLASS} {
  position: absolute;
  right: 8px;
  bottom: 6px;
  z-index: 3;
  padding: 1px 6px;
  border-radius: 999px;
  font: 11px/16px system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: .02em;
  pointer-events: none;
  user-select: none;
  white-space: nowrap;
  opacity: .78;
  transition: opacity .15s ease;
}
.${COUNTER_CLASS}[data-empty="true"] { opacity: .42; }
.${COUNTER_CLASS}[data-theme="dark"] {
  background: rgba(17, 24, 39, .72);
  border: 1px solid rgba(255, 255, 255, .16);
  color: #e5e7eb;
}
.${COUNTER_CLASS}[data-theme="light"] {
  background: rgba(255, 255, 255, .9);
  border: 1px solid rgba(15, 23, 42, .14);
  color: #334155;
}
`;
  document.head.append(style);
}

function updateCounter(counter, textarea) {
  const text = textarea.value ?? "";
  const count = countChars(text);
  counter.textContent = `${count.toLocaleString("zh-CN")} 字`;
  counter.dataset.empty = count === 0 ? "true" : "false";
  counter.dataset.theme = detectHostTheme();
  // 右侧让出滚动条宽度，避免盖住滚动条 / 被滚动条盖住。
  const scrollbar = Math.max(0, textarea.offsetWidth - textarea.clientWidth);
  counter.style.right = `${scrollbar + 8}px`;
}

function attachCounter(textarea) {
  const parent = textarea.parentElement;
  if (!parent) return;
  let counter = parent.querySelector(`:scope > .${COUNTER_CLASS}`);
  if (!counter) {
    counter = document.createElement("span");
    counter.className = COUNTER_CLASS;
    counter.setAttribute("aria-hidden", "true");
    parent.append(counter);
    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
  }
  // 宿主有时会复用父容器、只换里面的 textarea：把监听改挂到当前这个框上。
  if (counter._ggTextarea !== textarea) {
    if (counter._ggTextarea && counter._ggHandler) {
      counter._ggTextarea.removeEventListener("input", counter._ggHandler);
      counter._ggTextarea.removeEventListener("change", counter._ggHandler);
    }
    const handler = () => updateCounter(counter, textarea);
    textarea.addEventListener("input", handler);
    textarea.addEventListener("change", handler);
    counter._ggTextarea = textarea;
    counter._ggHandler = handler;
  }
  updateCounter(counter, textarea);
}

function scanNode(node) {
  if (!isGGNode(node)) return;
  for (const widget of node.widgets ?? []) {
    const element = widget?.element;
    if (!element) continue;
    if (element.tagName === "TEXTAREA") {
      if (element.offsetParent !== null) attachCounter(element);
      continue;
    }
    if (typeof element.querySelectorAll === "function") {
      for (const textarea of element.querySelectorAll("textarea")) {
        if (textarea.offsetParent !== null) attachCounter(textarea);
      }
    }
  }
}

function scan() {
  ensureStyles();
  for (const graph of graphList()) {
    for (const node of graph?._nodes ?? graph?.nodes ?? []) {
      scanNode(node);
    }
  }
}

function install() {
  if (document._ggTextCounterInstalled) return;
  document._ggTextCounterInstalled = true;
  ensureStyles();
  requestAnimationFrame(scan);
  setInterval(scan, SCAN_INTERVAL);
}

app.registerExtension({
  name: "ComfyUI.GGNodes.TextCounter",
  setup() {
    install();
  },
});
