import { app } from "../../scripts/app.js";

// 面板类 DOM 控件的公共贴合逻辑（GG 镜头打光提示词、GG 提示词库、GG 密钥输入共用）。
// 这里只解决「面板高度怎么算、怎么不被挤压、用户拉过的尺寸怎么留住」这三件事，
// 具体面板长什么样不归它管。几个坑都踩过，别再在各自的节点里重复实现：
//
// 1) 面板高度是个闭环：量内容高度 → 交给节点定高 → 前端再按它给面板定高。
//    直接在受限状态下读 scrollHeight，读到的是「被挤压后」的高度，错误值会被当成正确值锁死（棘轮），
//    而且面板里唯一带 overflow 的那一段会被压成 0 高（CSS 规定滚动容器的 min-height: auto 解析为 0，
//    于是所有挤压都由它独自承担，整块内容凭空消失）。量之前必须先解除父级给的高度约束。
// 2) 前端分配的高度会比 computeSize 请求的少一点（实测 16px，控件区间距），少掉的那截会把面板底部裁一条。
//    按「上次请求 vs 实际拿到」的差额补回去，不写死像素值，换前端版本也能自己跟上。
// 3) 贴合只许把节点撑大，不许替用户收小。用户拉高节点是为了看内容（尤其是多行文本框），
//    点一下折叠标题、切一次模式就把高度压回内容高度，等于逼用户再拉一次。手动高度靠
//    `resolveNodeHeight` 兜住，来源见 `trackManualHeight` / `captureManualHeight`。

// 版本标记：排查「面板没显示/被压扁」时，先看控制台有没有这行——没有就是浏览器还在跑旧的扩展代码。
export const PANEL_FIT_VERSION = "panel-fit v2";

if (!globalThis.__GG_PANEL_FIT_LOGGED__) {
  globalThis.__GG_PANEL_FIT_LOGGED__ = true;
  console.log(`[GuliNodes] 面板贴合逻辑 ${PANEL_FIT_VERSION} 已加载`);
}

/**
 * 量面板的自然内容高度。
 * @param {HTMLElement|null|undefined} host 面板根元素
 * @returns {number} CSS 像素高度；元素还没排版时返回 0
 */
export function measurePanelHeight(host) {
  if (!host) return 0;
  const saved = { height: host.style.height, maxHeight: host.style.maxHeight, overflow: host.style.overflow };
  host.style.height = "auto";
  host.style.maxHeight = "none";
  host.style.overflow = "visible";
  // 不能用 getBoundingClientRect：它带画布缩放，量出来的不是 CSS 像素
  const measured = Math.max(
    Math.round(Number(host.scrollHeight) || 0),
    Math.round(Number(host.offsetHeight) || 0),
  );
  Object.assign(host.style, saved);
  return measured;
}

/**
 * 给 computeSize 用的高度：自然高度 + 观测到的前端差额。
 * 每次调用都会更新差额与「上次请求值」，所以必须由 computeSize 调用（同一帧多次调用是幂等的）。
 * @param {object} panel 面板对象，需要 `host`、`requestedHeight`、`widgetPad` 三个字段
 * @param {number} natural 自然内容高度
 * @returns {number} 应该向 computeSize 返回的高度
 */
export function nextWidgetHeight(panel, natural) {
  const wrapper = panel?.host?.parentElement;
  const applied = wrapper ? Math.round(Number.parseFloat(wrapper.style.height) || 0) : 0;
  const requested = Number(panel?.requestedHeight) || 0;
  if (requested > 120 && applied > 120) {
    const delta = requested - applied;
    // 只接受合理范围，避免把布局瞬间的异常值当成差额
    if (delta >= 0 && delta <= 48) panel.widgetPad = delta;
  }
  const total = Math.round(natural) + (Number(panel?.widgetPad) || 0);
  if (panel) panel.requestedHeight = total;
  return total;
}

/**
 * 面板各段一律不许被 flex 挤压。
 * 宁可内容溢出被裁，也不能让一整段（尤其是带滚动的列表）消失。
 * @param {HTMLElement|null|undefined} host 面板根元素
 */
export function lockPanelChildren(host) {
  if (!host?.children) return;
  for (const child of host.children) child.style.flex = "0 0 auto";
}

/**
 * 尺寸变化后再贴合一次：差额是上一轮观测出来的，改完尺寸可能还需要再对一次。
 * 尺寸不再变化时 fit 会提前返回，不会再排新的定时器，所以不会自己喂自己。
 * @param {object} node 节点
 * @param {Function} fitNode 贴合函数
 * @param {number} delay 延迟毫秒
 */
export function scheduleRefit(node, fitNode, delay = 90) {
  clearTimeout(node._ggPanelFitTimer);
  node._ggPanelFitTimer = setTimeout(() => fitNode(node), delay);
}

/**
 * 画布是不是正握着这个节点的边在拖。
 * ComfyUI 与其他扩展的布局也会走 setSize / onResize，只有「正在拖这个节点」才算用户改的尺寸。
 * @param {object} node 节点
 * @returns {boolean}
 */
function isUserResizingNode(node) {
  if (!node) return false;
  const canvas = app?.canvas || globalThis.LGraphCanvas?.active_canvas;
  return canvas?.resizing_node === node;
}

/**
 * 记住用户手动拉过的高度。装一次就够，重复调用直接返回。
 * 只在画布真的在拖这个节点时记录：把布局过程里的 onResize 当成手动高度，
 * 节点就再也收不回去了（每次贴合都会被一个假的手动高度顶住）。
 * @param {object} panel 面板对象，会写入 `manualHeight`
 * @param {object} node 节点
 */
export function trackManualHeight(panel, node) {
  if (!panel || !node || panel.manualTracked) return;
  panel.manualTracked = true;
  const originalOnResize = node.onResize;
  node.onResize = function (size) {
    const result = originalOnResize?.apply(this, arguments);
    if (!panel.applyingFit && isUserResizingNode(this)) {
      const height = Math.round(Number(size?.[1] ?? this.size?.[1]) || 0);
      if (height > 0) panel.manualHeight = height;
    }
    return result;
  };
}

/**
 * 认领工作流里存着的手动高度：重开工作流时 node.size 就是上次的尺寸，
 * 比内容还高说明是用户自己拉出来的，记下来，别在首次贴合时又收回去。
 * 必须在内容加载完之后调用——内容还没进来时量到的自然高度偏小，
 * 会把默认高度误判成手动高度，之后节点再也缩不回去。
 * @param {object} panel 面板对象
 * @param {object} node 节点
 * @param {number} natural 自然内容高度
 * @param {number} preferredHeight 工作流里存着的原始高度（优先于 node.size 判断）
 */
export function captureManualHeight(panel, node, natural, preferredHeight = 0) {
  if (!panel || panel.manualHeight) return;
  const current = Math.round(Number(preferredHeight) || Number(node?.size?.[1]) || 0);
  const need = Math.round(Number(natural) || 0);
  if (current > need + 2) panel.manualHeight = current;
}

/**
 * 贴合目标宽度：绝不比节点当前的宽度窄。
 * 用户拉宽是为了看清卡片与多行提示词，自动布局算出来的宽度只当下限用——
 * 把宽度收回去和把高度收回去是同一种冒犯。
 * @param {object} node 节点
 * @param {number} minimum 允许的最窄宽度
 * @param {number} fallback 节点还没有尺寸时的默认宽度
 * @returns {number}
 */
export function resolveNodeWidth(node, minimum = 0, fallback = 0) {
  const current = Math.round(Number(node?.size?.[0]) || 0);
  const floor = Math.round(Number(minimum) || 0);
  const base = current > 0 ? current : Math.round(Number(fallback) || 0);
  return Math.max(base, floor);
}

/**
 * 贴合目标高度：内容需要多少给多少，但绝不低于用户手动拉过的高度。
 * 只增不减——用户拉高是为了看内容，替他把高度收回去等于让他再拉一次。
 * @param {object} panel 面板对象
 * @param {number} natural 自然内容高度
 * @returns {number}
 */
export function resolveNodeHeight(panel, natural) {
  const need = Math.round(Number(natural) || 0);
  const manual = Math.round(Number(panel?.manualHeight) || 0);
  return Math.max(need, manual);
}

/**
 * 由我们主动改节点尺寸。改之前先打标记，免得自己的 setSize 被 `trackManualHeight`
 * 当成用户拖动记成手动高度。
 * @param {object} panel 面板对象
 * @param {object} node 节点
 * @param {number[]} size `[宽, 高]`
 */
export function setPanelNodeSize(panel, node, size) {
  if (!node || !size) return;
  if (panel) panel.applyingFit = true;
  try {
    if (typeof node.setSize === "function") node.setSize([size[0], size[1]]);
    else if (Array.isArray(node.size)) {
      node.size[0] = size[0];
      node.size[1] = size[1];
      node.onResize?.(node.size);
    }
  } finally {
    if (panel) panel.applyingFit = false;
  }
}
