import { app } from "../../scripts/app.js";
import { ggIcon } from "./gg-ui-icons.js";

const SETTING_ID = "GuliNodes.enableNodeAlign";
const TOP_BUTTON_ID = "gg-node-align-button";
const SNAP_SCREEN_PX = 8;
const GUIDE_COLOR = "#ffffff";
const PMM_FLAG = Symbol.for("GuliNodes.nodeAlign.processMouseMovePatched");
const PMU_FLAG = Symbol.for("GuliNodes.nodeAlign.processMouseUpPatched");
const FG_FLAG = Symbol.for("GuliNodes.nodeAlign.foregroundPatched");

let enabled = true;
let topButton = null;
let topHost = null;
let hostObserver = null;

// 本帧命中的参考线（图坐标）：vertical=[x, y1, y2]，horizontal=[y, x1, x2]。
const guides = { vertical: null, horizontal: null };
// 拖动中算好、松手时一次性吸附的位移：{ nodes, dx, dy }。
let pendingSnap = null;

function getSettingValue(id, fallback) {
  try {
    const value = app.extensionManager?.setting?.get?.(id);
    if (value !== undefined) return value;
  } catch (_) {}
  try {
    return app.ui?.settings?.getSettingValue?.(id, fallback) ?? fallback;
  } catch (_) {
    return fallback;
  }
}

async function setSettingValue(id, value) {
  try {
    if (app.extensionManager?.setting?.set) {
      await app.extensionManager.setting.set(id, value);
      return;
    }
  } catch (_) {}
  try {
    app.ui?.settings?.setSettingValue?.(id, value);
  } catch (_) {}
}

function canvasProto() {
  return globalThis.LGraphCanvas?.prototype
    ?? globalThis.LiteGraph?.LGraphCanvas?.prototype
    ?? null;
}

function nodeBox(node) {
  let b = null;
  try {
    const out = [0, 0, 0, 0];
    const r = node.getBounding?.(out);
    b = Array.isArray(r) && r.length >= 4 ? r : out;
  } catch (_) {
    b = null;
  }
  if (!b || b.length < 4 || !Number.isFinite(Number(b[0])) || !Number.isFinite(Number(b[2]))) {
    const pos = node.pos || [0, 0];
    const size = node.size || [0, 0];
    const th = globalThis.LiteGraph?.NODE_TITLE_HEIGHT || 30;
    const left = Number(pos[0]) || 0;
    const top = (Number(pos[1]) || 0) - th;
    return { left, top, right: left + (Number(size[0]) || 0), bottom: (Number(pos[1]) || 0) + (Number(size[1]) || 0) };
  }
  const left = Number(b[0]);
  const top = Number(b[1]);
  return { left, top, right: left + Number(b[2]), bottom: top + Number(b[3]) };
}

function boxEdges(box) {
  return {
    left: box.left,
    right: box.right,
    top: box.top,
    bottom: box.bottom,
    cx: (box.left + box.right) / 2,
    cy: (box.top + box.bottom) / 2,
  };
}

function graphNodes(canvas) {
  const graph = canvas?.graph || app.graph;
  const nodes = graph?._nodes;
  return Array.isArray(nodes) ? nodes : (nodes ? Object.values(nodes) : []);
}

// 本 litegraph 版本已废弃 canvas.node_dragged；拖动节点的状态在
// canvas.isDragging / canvas.state.draggingItems（区别于拖画布 draggingCanvas）。
function isDraggingNodes(canvas) {
  if (!canvas) return false;
  if (canvas.dragging_canvas === true || canvas.state?.draggingCanvas === true) return false;
  return canvas.isDragging === true || canvas.state?.draggingItems === true;
}

function isNodeLike(item) {
  return item && Array.isArray(item.pos) && Array.isArray(item.size) && typeof item.id !== "undefined";
}

function draggedNodes(canvas) {
  const set = new Set();
  const selected = canvas?.selected_nodes;
  if (selected) {
    for (const key in selected) {
      const node = selected[key];
      if (node) set.add(node);
    }
  }
  const items = canvas?.selectedItems;
  if (items instanceof Set || Array.isArray(items)) {
    for (const item of items) {
      if (isNodeLike(item)) set.add(item);
    }
  }
  return set;
}

function unionBox(nodes) {
  let box = null;
  for (const node of nodes) {
    const b = nodeBox(node);
    if (!box) box = { ...b };
    else {
      box.left = Math.min(box.left, b.left);
      box.top = Math.min(box.top, b.top);
      box.right = Math.max(box.right, b.right);
      box.bottom = Math.max(box.bottom, b.bottom);
    }
  }
  return box;
}

function bestSnap(draggedValues, candidateValues, threshold) {
  // draggedValues / candidateValues: 数值数组（左/中/右 或 上/中/下）。
  let best = null;
  for (const dv of draggedValues) {
    for (const cv of candidateValues) {
      const diff = cv - dv;
      const abs = Math.abs(diff);
      if (abs <= threshold && (!best || abs < best.abs)) {
        best = { delta: diff, aligned: cv, abs };
      }
    }
  }
  return best;
}

function computeSnap(canvas) {
  guides.vertical = null;
  guides.horizontal = null;
  pendingSnap = null;
  if (!enabled || !canvas || !isDraggingNodes(canvas) || canvas.resizing_node) return;

  const dragged = draggedNodes(canvas);
  if (!dragged.size) return;
  const union = unionBox([...dragged]);
  if (!union) return;
  const u = boxEdges(union);

  const scale = Math.max(0.05, Number(canvas.ds?.scale) || 1);
  const threshold = SNAP_SCREEN_PX / scale;

  const others = graphNodes(canvas).filter((node) => node && !dragged.has(node));

  let bestX = null;
  let bestY = null;
  let matchX = null;
  let matchY = null;
  for (const node of others) {
    const e = boxEdges(nodeBox(node));
    // 只对齐节点四边（左/右、上/下），不对齐中线。
    const sx = bestSnap([u.left, u.right], [e.left, e.right], threshold);
    if (sx && (!bestX || sx.abs < bestX.abs)) {
      bestX = sx;
      matchX = e;
    }
    const sy = bestSnap([u.top, u.bottom], [e.top, e.bottom], threshold);
    if (sy && (!bestY || sy.abs < bestY.abs)) {
      bestY = sy;
      matchY = e;
    }
  }

  const dx = bestX ? bestX.delta : 0;
  const dy = bestY ? bestY.delta : 0;
  // 拖动中只画参考线提示；命中的位移记到 pendingSnap，松手时由 processMouseUp 一次性吸附。
  if (dx || dy) pendingSnap = { nodes: [...dragged], dx, dy };

  if (bestX && matchX) {
    guides.vertical = [bestX.aligned, Math.min(u.top, matchX.top), Math.max(u.bottom, matchX.bottom)];
  }
  if (bestY && matchY) {
    guides.horizontal = [bestY.aligned, Math.min(u.left, matchY.left), Math.max(u.right, matchY.right)];
  }
}

function applyPendingSnap(canvas) {
  if (!pendingSnap) return;
  const { nodes, dx, dy } = pendingSnap;
  pendingSnap = null;
  if (!dx && !dy) return;
  for (const node of nodes) {
    if (Array.isArray(node.pos)) {
      node.pos[0] += dx;
      node.pos[1] += dy;
    }
  }
  canvas?.setDirty?.(true, true);
  canvas?.graph?.setDirtyCanvas?.(true, true);
}

function clearGuides(canvas) {
  if (guides.vertical || guides.horizontal) {
    guides.vertical = null;
    guides.horizontal = null;
    canvas?.setDirty?.(true, true);
  }
}

function drawGuides(canvas, ctx) {
  if (!enabled || (!guides.vertical && !guides.horizontal) || !ctx) return;
  const scale = Math.max(0.05, Number(canvas.ds?.scale) || 1);
  const pad = 12 / scale;
  ctx.save();
  ctx.strokeStyle = GUIDE_COLOR;
  ctx.lineWidth = 1.5 / scale;
  ctx.setLineDash([6 / scale, 4 / scale]);
  // 白线在浅色画布上加一圈淡阴影，保证可见。
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 3 / scale;
  ctx.beginPath();
  if (guides.vertical) {
    const [x, y1, y2] = guides.vertical;
    ctx.moveTo(x, y1 - pad);
    ctx.lineTo(x, y2 + pad);
  }
  if (guides.horizontal) {
    const [y, x1, x2] = guides.horizontal;
    ctx.moveTo(x1 - pad, y);
    ctx.lineTo(x2 + pad, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function alignFrame(canvas, ctx) {
  // 每帧：拖动中就地重算吸附并画参考线；否则清线。
  try {
    if (enabled && isDraggingNodes(canvas)) computeSnap(canvas);
    else { guides.vertical = null; guides.horizontal = null; }
    drawGuides(canvas, ctx);
  } catch (_) {}
}

function installPatches() {
  const proto = canvasProto();
  if (!proto) return false;

  if (typeof proto.processMouseMove === "function" && !proto.processMouseMove[PMM_FLAG]) {
    const original = proto.processMouseMove;
    const wrapped = function (...args) {
      const result = original.apply(this, args);
      try { if (enabled && isDraggingNodes(this)) computeSnap(this); } catch (_) {}
      return result;
    };
    wrapped[PMM_FLAG] = true;
    proto.processMouseMove = wrapped;
  }

  if (typeof proto.processMouseUp === "function" && !proto.processMouseUp[PMU_FLAG]) {
    const original = proto.processMouseUp;
    const wrapped = function (...args) {
      try { applyPendingSnap(this); } catch (_) {}
      try { clearGuides(this); } catch (_) {}
      return original.apply(this, args);
    };
    wrapped[PMU_FLAG] = true;
    proto.processMouseUp = wrapped;
  }

  if (!proto.onDrawForeground || !proto.onDrawForeground[FG_FLAG]) {
    const original = proto.onDrawForeground;
    const wrapped = function (ctx, area) {
      const result = typeof original === "function" ? original.call(this, ctx, area) : undefined;
      alignFrame(this, ctx);
      return result;
    };
    wrapped[FG_FLAG] = true;
    proto.onDrawForeground = wrapped;
  }

  // 若画布实例自带了 onDrawForeground（遮蔽原型），补包实例，保证参考线一定被画。
  const canvas = app.canvas || globalThis.LGraphCanvas?.active_canvas
    || globalThis.LiteGraph?.LGraphCanvas?.active_canvas;
  if (canvas && typeof canvas.onDrawForeground === "function"
      && canvas.onDrawForeground !== proto.onDrawForeground
      && !canvas.onDrawForeground[FG_FLAG]) {
    const original = canvas.onDrawForeground;
    const wrapped = function (ctx, area) {
      const result = original.call(this, ctx, area);
      alignFrame(this, ctx);
      return result;
    };
    wrapped[FG_FLAG] = true;
    canvas.onDrawForeground = wrapped;
  }
  return true;
}

function updateTopButton() {
  if (!topButton) return;
  const title = enabled ? "关闭移动对齐吸附" : "启用移动对齐吸附";
  topButton.title = title;
  topButton.setAttribute("aria-label", title);
  topButton.setAttribute("aria-pressed", enabled ? "true" : "false");
  topButton.classList.toggle("active", enabled);
  topButton.style.color = enabled ? "var(--gg-ui-accent, #3b82f6)" : "var(--gg-ui-ink, #3f4856)";
  topButton.style.background = enabled ? "rgba(59,130,246,0.17)" : "var(--gg-toolbar-button-bg, rgba(255,255,255,0.94))";
  topButton.style.borderColor = enabled ? "var(--gg-ui-accent-border, rgba(59,130,246,0.28))" : "rgba(148,163,184,0.24)";
  topButton.innerHTML = ggIcon("nodeAlign", 18);
}

function placeTopButton() {
  if (!topHost || !topButton) return;
  if (window.__ggMountTopGroup?.(topHost)) return;
  const host = document.getElementById("gg-toolbar-top-switch");
  if (host) {
    if (topHost.parentElement !== host) host.appendChild(topHost);
    topHost.style.position = "";
    topHost.style.top = "";
    topHost.style.right = "";
    topHost.style.zIndex = "";
    return;
  }
  if (topHost.parentElement !== document.body) document.body.appendChild(topHost);
  topHost.style.position = "fixed";
  topHost.style.top = "18px";
  topHost.style.right = "clamp(180px, 28vw, 480px)";
  topHost.style.zIndex = "100002";
}

function createTopButton() {
  if (topButton) return;
  const host = document.createElement("div");
  host.id = TOP_BUTTON_ID;
  host.style.cssText = "display:inline-flex;align-items:center;flex:0 0 auto;";
  topHost = host;
  topButton = document.createElement("button");
  topButton.type = "button";
  topButton.className = "gg-toolbar-top-button gg-node-align-top-button";
  topButton.style.cssText = [
    "width: 40px", "min-width: 40px", "height: 40px",
    "border: 1px solid rgba(148,163,184,0.24)", "border-radius: 10px", "padding: 0",
    "display: inline-flex", "align-items: center", "justify-content: center", "cursor: pointer",
    "color: var(--gg-ui-ink, #3f4856)", "background: var(--gg-toolbar-button-bg, rgba(255,255,255,0.94))",
    "box-shadow: var(--gg-top-switch-shadow, 0 8px 22px rgba(15,23,42,0.14))",
  ].join(";");
  topButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    applyEnabled(!enabled);
    await setSettingValue(SETTING_ID, enabled);
  });
  host.append(topButton);
  document.body.appendChild(topHost);
  updateTopButton();
  placeTopButton();

  if (document.getElementById("gg-toolbar-top-switch") || hostObserver) return;
  let timer = null;
  hostObserver = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; placeTopButton(); }, 200);
  });
  hostObserver.observe(document.body, { childList: true, subtree: true });
}

function applyEnabled(value) {
  enabled = value !== false;
  updateTopButton();
  if (!enabled) {
    guides.vertical = null;
    guides.horizontal = null;
  }
  app.canvas?.setDirty?.(true, true);
}

window.__ggApplyNodeAlign = applyEnabled;

app.registerExtension({
  name: "ComfyUI.GuliNodes.NodeAlign",
  async setup() {
    enabled = getSettingValue(SETTING_ID, true) !== false;
    installPatches();
    createTopButton();
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (installPatches() && attempts >= 3) clearInterval(timer);
      if (attempts >= 20) clearInterval(timer);
    }, 500);
  },
});

