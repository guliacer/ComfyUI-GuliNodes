import { app } from "../../scripts/app.js";

// 「GG 图片超分」节点底部的一行小字提示：点一下打开模型网盘。
//
// 实现方式：加一个真正的 custom widget，而不是往 drawNode 里手画一行再硬撑高度。
//
// 为什么改用 widget（这是 ComfyUI / LiteGraph 官方自己的算法）：
// LGraphNode.computeSize(out) 会对每个 widget 累加高度——
//   if (w.computeSize) h += w.computeSize(width)[1];
//   else if (w.computeLayoutSize) ...
//   else h += LiteGraph.NODE_WIDGET_HEIGHT;
//   h += 4;                       // 每个 widget 后固定 4px 间距
// 全部 widget 走完再 +8，最后 +6。也就是说：只要这个 widget 的 computeSize 返回
// [0, 18]，节点高度天然就多出 22px，用户拖高/拖矮由 node.size 原样存进工作流再恢复。
// 之前那套「包装 computeSize 手动 +18 + 自己记高度 + 自己定高」全是在和官方布局
// 抢方向盘，还踩了 LiteGraph 把 node.size 当 out 传进来的原地累加坑（每帧长高 18px）。
//
// 另外两个官方约定：
//   · widget.draw(ctx, node, width, y, height, lowQuality) —— y 是官方算好的行位置，
//     drawWidgets 在 translate(node.pos) 之后调用，所以这里是节点局部坐标。
//   · serialize: false —— 不参与 widgets_values，不会写进工作流、不会变成节点输入。
//
// 硬约束：本文件**不调用任何 setSize**。高度只由 ComfyUI 从 node.size 存取，
// 一旦有代码去"修正"它，就会表现成「切个工作流高度又变了」。

const NODE_ID = "GGImageSuperResolution";
const HINT_TEXT = "自动下载失败？点击这里查看网盘地址";
const HINT_URL = "https://pan.quark.cn/s/0fa41aaa6576";

const WIDGET_NAME = "gg_model_mirror_hint";
const WIDGET_TYPE = "gg_hint";

const ROW_H = 18; // widget 自身高度，官方还会再补 4px 行距
const FONT_SIZE = 10;
const MIN_FONT_SIZE = 8;
const PAD_RIGHT = 10;

const CACHE_TTL_MS = 1000;
let themeCache = { at: 0, dark: true };
let vueModeCache = { at: 0, on: false };

function isSuperResNode(node) {
  if (!node) return false;
  return node.type === NODE_ID || node.comfyClass === NODE_ID || node.type === `GuliNodes.${NODE_ID}`;
}

function hintFont(size) {
  return `${size}px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`;
}

function parseColorToLuma(color) {
  if (!color || typeof color !== "string") return null;
  const text = color.trim().toLowerCase();
  if (text === "lightgray" || text === "lightgrey") return 211;
  if (text === "white") return 255;
  if (text === "black") return 0;
  if (text === "gray" || text === "grey") return 128;
  if (text === "darkgray" || text === "darkgrey") return 169;
  const match = text.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (match) {
    const [r, g, b] = match.slice(1, 4).map(Number);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const hex = text.match(/^#([0-9a-f]{6})$/);
  if (hex) {
    const value = parseInt(hex[1], 16);
    return 0.299 * ((value >> 16) & 255) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255);
  }
  return null;
}

function canvasIsDark() {
  const now = performance.now();
  if (now - themeCache.at < CACHE_TTL_MS) return themeCache.dark;

  let luma = parseColorToLuma(app.canvas?.clear_background_color);
  if (luma == null) {
    luma = parseColorToLuma(app.ui?.settings?.getSettingValue?.("Comfy.ColorPalette.comfy_base"));
  }
  if (luma == null && typeof document !== "undefined") {
    luma = parseColorToLuma(getComputedStyle(document.body)?.backgroundColor);
  }
  themeCache = { at: now, dark: luma == null ? true : luma < 128 };
  return themeCache.dark;
}

// Nodes 2.0（Vue 渲染）下节点由 DOM 绘制，这个 canvas widget 会变成一条空行，
// 所以直接让它 hidden —— 官方布局会把 hidden widget 的行高一并回收。
function vueNodesMode() {
  const now = performance.now();
  if (now - vueModeCache.at < CACHE_TTL_MS) return vueModeCache.on;
  let on = false;
  try {
    on = !!app.ui?.settings?.getSettingValue?.("Comfy.VueNodes.Enabled");
  } catch {
    on = false;
  }
  vueModeCache = { at: now, on };
  return on;
}

function hintColors(hover) {
  if (canvasIsDark()) {
    return hover
      ? { text: "#ffd479", underline: "rgba(255,212,121,0.85)" }
      : { text: "#8f8f8f", underline: "rgba(143,143,143,0.45)" };
  }
  return hover
    ? { text: "#a35500", underline: "rgba(163,85,0,0.85)" }
    : { text: "#6a6a6a", underline: "rgba(106,106,106,0.4)" };
}

function pointerInHint(node, canvas) {
  const rect = node?.__ggHintRect;
  const mouse = canvas?.graph_mouse;
  if (!rect || !mouse || !node?.pos) return false;
  const x = mouse[0] - node.pos[0];
  const y = mouse[1] - node.pos[1];
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

// 文案比节点宽时长句会消失，所以按 10px 起量、放不下逐级降到 8px。
// 中文字宽约等于字号：19 字 ≈ 190px。
function fitFont(ctx, avail) {
  let size = FONT_SIZE;
  let width = 0;
  for (;;) {
    ctx.font = hintFont(size);
    width = ctx.measureText(HINT_TEXT).width;
    if (width <= avail || size <= MIN_FONT_SIZE) break;
    size -= 1;
  }
  return { size, width };
}

function drawHintRow(ctx, node, width, rowY) {
  if (!ctx || !node) return;
  const avail = width - PAD_RIGHT * 2;
  if (avail < 40) {
    node.__ggHintRect = null;
    return;
  }

  const colors = hintColors(pointerInHint(node, app.canvas));

  // 每段绘制自己设定 alpha，避免继承节点光效留下的 globalAlpha
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  const { size, width: textW } = fitFont(ctx, avail);
  if (textW > avail) {
    node.__ggHintRect = null;
    ctx.restore();
    return;
  }

  const right = width - PAD_RIGHT;
  const middleY = rowY + ROW_H / 2;
  node.__ggHintRect = { x: right - textW, y: rowY, w: textW, h: ROW_H };

  ctx.fillStyle = colors.text;
  ctx.fillText(HINT_TEXT, right, middleY);

  // 常驻细下划线，让「这行字能点」一眼看得出来
  ctx.strokeStyle = colors.underline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const underlineY = middleY + size * 0.62;
  ctx.moveTo(right - textW, underlineY);
  ctx.lineTo(right, underlineY);
  ctx.stroke();

  ctx.restore();
}

function openHint() {
  try {
    // noopener 防止新页面通过 window.opener 反向拿到 ComfyUI 的窗口
    window.open(HINT_URL, "_blank", "noopener,noreferrer");
  } catch (error) {
    console.warn("[GuliNodes] 打开网盘链接失败：", error);
  }
}

// 点击仍走节点的 onMouseDown：widget 的 mouse 回调在各版本里是否被调用不一致，
// onMouseDown 的 pos 本来就是节点局部坐标，命中矩形由 draw 写下来，行为最稳。
function ensureHintClickable(node) {
  if (!node || node.__ggHintClickPatched) return;
  const original = node.onMouseDown;
  node.onMouseDown = function (event, pos, canvas) {
    const rect = this.__ggHintRect;
    if (rect && Array.isArray(pos)
      && pos[0] >= rect.x && pos[0] <= rect.x + rect.w
      && pos[1] >= rect.y && pos[1] <= rect.y + rect.h) {
      openHint();
      return true;
    }
    return typeof original === "function" ? original.call(this, event, pos, canvas) : false;
  };
  node.__ggHintClickPatched = true;
}

function hintWidgetOf(node) {
  const widgets = node?.widgets;
  if (!Array.isArray(widgets)) return null;
  return widgets.find((widget) => widget?.name === WIDGET_NAME) ?? null;
}

// 注意：不能只信 node.__ggHintWidget 缓存。
// 切换工作流 / 重新 configure 时 ComfyUI 会按 schema 重建 widgets 数组，我们的
// widget 会被冲掉，但节点对象上的标记还在——只看标记就永远不会补回来，节点
// 高度随之少掉一行（表现就是「切一下工作流高度又变了」）。
function ensureHintWidget(node) {
  if (!node || typeof node.addCustomWidget !== "function") return;
  if (!Array.isArray(node.widgets)) return;

  const existing = hintWidgetOf(node);
  if (existing) {
    node.__ggHintWidget = existing;
    return;
  }

  const widget = node.addCustomWidget({
    name: WIDGET_NAME,
    type: WIDGET_TYPE,
    // 不进 widgets_values，不改节点接口，旧工作流加载不受影响
    serialize: false,
    value: null,
    options: { hidden: vueNodesMode() },
    // 官方布局就认这个：返回 [宽, 高]，高度被累加进节点
    computeSize: () => [0, ROW_H],
    draw(ctx, node, width, rowY) {
      try {
        drawHintRow(ctx, node, width, rowY);
      } catch (error) {
        console.warn("[GuliNodes] 图片超分提示行绘制失败：", error);
      }
    },
  });

  node.__ggHintWidget = widget ?? null;
}

function ensureGraphNodes() {
  const nodes = app.graph?._nodes ?? app.graph?.nodes ?? [];
  for (const node of nodes) {
    if (!isSuperResNode(node)) continue;
    try {
      ensureHintWidget(node);
      ensureHintClickable(node);
    } catch (error) {
      console.warn("[GuliNodes] 图片超分提示行初始化失败：", error);
    }
  }
}

app.registerExtension({
  name: "ComfyUI.GGNodes.SuperResolutionHint",

  async setup() {
    // 有的版本加载完工作流才把 widgets 建好，afterConfigureGraph 时还装不上，
    // 这里轻量补几次（只在画布上已有超分节点时才真正干活）。
    let tries = 0;
    const timer = setInterval(() => {
      ensureGraphNodes();
      if (++tries >= 20) clearInterval(timer);
    }, 500);
  },

  async nodeCreated(node) {
    if (!isSuperResNode(node)) return;
    ensureHintWidget(node);
    ensureHintClickable(node);
  },

  // 切换/加载工作流时 ComfyUI 会重建节点的 widgets 数组，这个 custom widget 会被
  // 一起冲掉（节点对象上的标记却还在）。所以每次工作流就绪都要按 widgets 里的
  // 实际内容补一遍，只补 widget，绝不碰 node.size。
  async afterConfigureGraph() {
    ensureGraphNodes();
  },
});
