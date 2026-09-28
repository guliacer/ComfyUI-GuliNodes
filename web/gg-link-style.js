import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ggIcon } from "./gg-ui-icons.js";

const PREFIX = "GuliNodes.linkStyle";
const TOP_BUTTONS_SETTING = "GuliNodes.enableLinkStyleButtons";
const MENU_DISPLAY_SETTING = "Comfy.UseNewMenu";
// A pointer gesture flag that never saw its pointerup (mouse released outside
// the window, alt-tab, a context menu swallowing the event) must stop counting
// as "interacting" after a while, or the custom renderer stays off forever.
const GESTURE_TIMEOUT_MS = 4000;
// Watchdog cadence for the link-style self-heal (see startLinkStyleWatchdog).
const LINK_WATCHDOG_INTERVAL_MS = 2000;

const SETTINGS = {
  enabled: `${PREFIX}.enabled`,
  displayMode: `${PREFIX}.displayMode`,
  pathStyle: `${PREFIX}.pathStyle`,
  lineWidth: `${PREFIX}.lineWidth`,
  opacity: `${PREFIX}.opacity`,
  colorMode: `${PREFIX}.colorMode`,
  customColor: `${PREFIX}.customColor`,
  menuBackgroundColor: `${PREFIX}.menuBackgroundColor`,
  menuBackgroundOpacity: `${PREFIX}.menuBackgroundOpacity`,
  dashStyle: `${PREFIX}.dashStyle`,
  textureDataUrl: `${PREFIX}.textureDataUrl`,
  glow: `${PREFIX}.glow`,
  speed: `${PREFIX}.speed`,
};

const QUICK_PANEL_BG_DEFAULT = "#eef1ec";
const QUICK_PANEL_BG_OPACITY_DEFAULT = 0.94;
const QUICK_PANEL_BG_PRESETS = [
  { name: "雾灰绿", color: "#eef1ec" },
  { name: "鼠尾草", color: "#e3ebe3" },
  { name: "浅雾蓝", color: "#e7edf2" },
  { name: "云杉蓝", color: "#dfe8ec" },
  { name: "淡薰衣草", color: "#ebe7f1" },
  { name: "灰粉", color: "#f1e4e2" },
  { name: "杏米", color: "#f1eadc" },
  { name: "雾黄", color: "#eee8d2" },
  { name: "陶土粉", color: "#eadbd4" },
  { name: "石板青", color: "#dde7e3" },
];

const DISPLAY_ALL = "全部";
const DISPLAY_SELECTED = "选中节点";
const DISPLAY_HOVER = "悬停节点";
const PATH_CURVE = "曲线";
const PATH_DIRECT = "直线";
const PATH_ORTHOGONAL = "直角";
const PATH_CIRCUIT = "电路";
const COLOR_TYPE = "按类型";
const COLOR_CUSTOM = "统一颜色";
const DASH_SOLID = "实线";
const DASH_FLOW = "流动虚线";
const DASH_FLOW_SOLID = "流动实线";
const DASH_PULSE = "脉冲";
const DASH_LIGHTNING = "闪电";
const DASH_METEOR = "流星";
const DASH_ENERGY_WAVE = "能量波";
const DASH_LASER = "激光";
const DASH_PARTICLE = "粒子流";
const DASH_GRADIENT = "渐变流动";
const DASH_AURORA = "极光";
const DASH_HELIX = "双螺旋";
const DASH_WAVE = "波涛";
const DASH_GALAXY = "星河";
const DASH_TEXTURE = "自定义贴图";
const DASH_VOID = "虚空";
const VOID_LINK_COLOR = "#2b3138";
const VOID_STUB_LENGTH_PX = 10;

const ALL_DASH_STYLES = [
  DASH_SOLID, DASH_FLOW, DASH_FLOW_SOLID,
  DASH_PULSE, DASH_LIGHTNING, DASH_METEOR,
  DASH_ENERGY_WAVE, DASH_LASER,
  DASH_PARTICLE, DASH_GRADIENT,
  DASH_AURORA, DASH_HELIX, DASH_WAVE, DASH_GALAXY,
  DASH_TEXTURE, DASH_VOID,
];

// 动画类样式清单：drawOverlay 与 ensureAnimation 共用一份，避免两处列表失步。
const ANIMATED_STYLES = [
  DASH_FLOW, DASH_FLOW_SOLID, DASH_PULSE, DASH_LIGHTNING, DASH_METEOR,
  DASH_ENERGY_WAVE, DASH_LASER, DASH_PARTICLE, DASH_GRADIENT,
  DASH_AURORA, DASH_HELIX, DASH_WAVE, DASH_GALAXY,
];

let animationFrame = null;
let patchedCanvas = null;
let topControls = null;
let quickPanel = null;
let quickPanelCleanup = null;
let cachedTextureImage = null;

function loadTextureImage(dataUrl) {
  if (!dataUrl) { cachedTextureImage = null; return; }
  const img = new Image();
  img.onload = () => { cachedTextureImage = img; markDirty(); };
  img.src = dataUrl;
}

function setting(id, fallback) {
  const managerValue = app.extensionManager?.setting?.get?.(id);
  if (managerValue !== undefined) return managerValue;
  const uiValue = app.ui?.settings?.getSettingValue?.(id, undefined);
  if (uiValue !== undefined) return uiValue;
  return fallback;
}

async function setSettingValue(id, value) {
  try {
    if (app.extensionManager?.setting?.set) {
      await app.extensionManager.setting.set(id, value);
      return;
    }
  } catch (error) {
    console.warn("[GuliNodes] Unable to write extension setting:", id, error);
  } finally {
    markDirty();
    syncTopControls();
  }

  try {
    app.ui?.settings?.setSettingValue?.(id, value);
  } catch (error) {
    console.warn("[GuliNodes] Unable to write UI setting:", id, error);
  } finally {
    markDirty();
    syncTopControls();
  }
}

function numberSetting(id, fallback, min, max) {
  const value = Number(setting(id, fallback));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function config() {
  return {
    enabled: Boolean(setting(SETTINGS.enabled, false)),
    displayMode: setting(SETTINGS.displayMode, DISPLAY_ALL),
    pathStyle: setting(SETTINGS.pathStyle, PATH_CURVE),
    lineWidth: numberSetting(SETTINGS.lineWidth, 2.5, 0.5, 12),
    opacity: numberSetting(SETTINGS.opacity, 0.75, 0.05, 1),
    colorMode: setting(SETTINGS.colorMode, COLOR_TYPE),
    customColor: normalizeColor(setting(SETTINGS.customColor, "#72d6ff")),
    dashStyle: setting(SETTINGS.dashStyle, DASH_SOLID),
    textureDataUrl: setting(SETTINGS.textureDataUrl, ""),
    glow: Boolean(setting(SETTINGS.glow, false)),
    speed: numberSetting(SETTINGS.speed, 1.5, 0.2, 6),
  };
}

function normalizeColor(value) {
  const text = String(value || "").trim();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(text)) return text;
  return "#72d6ff";
}

function normalizePanelColor(value) {
  const text = String(value || "").trim();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(text)) return text;
  return QUICK_PANEL_BG_DEFAULT;
}

function hexToRgb(hex) {
  const normalized = normalizePanelColor(hex).replace("#", "");
  const full = normalized.length === 3 ? normalized.split("").map((char) => char + char).join("") : normalized;
  const value = parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hexToRgba(hex, alpha = 1) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function panelBackgroundColor() {
  return normalizePanelColor(setting(SETTINGS.menuBackgroundColor, QUICK_PANEL_BG_DEFAULT));
}

function panelBackgroundOpacity() {
  return numberSetting(SETTINGS.menuBackgroundOpacity, QUICK_PANEL_BG_OPACITY_DEFAULT, 0.35, 1);
}

function applyQuickPanelBackground(panel = quickPanel, nextColor = null, nextOpacity = null) {
  if (!panel) return;
  const color = normalizePanelColor(nextColor || panel.dataset.backgroundColor || panelBackgroundColor());
  const opacity = Math.max(0.35, Math.min(1, Number(nextOpacity ?? panelBackgroundOpacity())));
  panel.style.setProperty("--gg-link-panel-bg", hexToRgba(color, opacity));
  panel.style.setProperty("--gg-link-panel-bg-strong", hexToRgba(color, Math.min(1, opacity + 0.04)));
  panel.style.setProperty("--gg-link-panel-bg-soft", hexToRgba(color, Math.max(0.2, opacity * 0.62)));
  panel.style.setProperty("--gg-link-panel-border", hexToRgba(color, 0.72));
  panel.dataset.backgroundColor = color;
  panel.dataset.backgroundOpacity = String(opacity);
  panel.querySelectorAll(".gg-link-style-bg-swatch").forEach((button) => {
    button.classList.toggle("active", button.dataset.color?.toLowerCase() === color.toLowerCase());
  });
  const colorInput = panel.querySelector(".gg-link-style-bg-input");
  if (colorInput) colorInput.value = color;
  const opacityInput = panel.querySelector(".gg-link-style-bg-opacity-input");
  if (opacityInput) opacityInput.value = String(Math.round(opacity * 100));
  const opacityValue = panel.querySelector(".gg-link-style-bg-opacity-value");
  if (opacityValue) opacityValue.textContent = `${Math.round(opacity * 100)}%`;
}

function markDirty() {
  const canvas = app.canvas || patchedCanvas;
  canvas?.setDirty?.(true, true);
  canvas?.setDirtyCanvas?.(true, true);
}

function onStyleSettingChanged() {
  markDirty();
  syncTopControls();
}

function getLinks(graph) {
  if (!graph) return [];
  // 新版 litegraph 的连线存放在 graph.links —— 一个 Map-like 的 Proxy（对 LinkMap 的
  // 代理），`instanceof Map` 未必为真，但一定有 values()。旧版用 graph._links(Map)。
  // 只要对象带 values() 就当 Map-like 遍历，避免因 instanceof 判断失败而读空、导致
  // 自定义连线画不出来（连线消失）。
  for (const container of [graph.links, graph._links]) {
    if (!container) continue;
    try {
      if (typeof container.values === "function") {
        const arr = [...container.values()].filter(Boolean);
        if (arr.length) return arr;
      } else if (Array.isArray(container)) {
        const arr = container.filter(Boolean);
        if (arr.length) return arr;
      } else if (typeof container === "object") {
        const arr = Object.values(container).filter(Boolean);
        if (arr.length) return arr;
      }
    } catch (_) {
      // 某些代理在图切换瞬间可能抛错，忽略后尝试下一个来源。
    }
  }
  return [];
}

function linkField(link, objectKey, arrayIndex) {
  return link?.[objectKey] ?? (Array.isArray(link) ? link[arrayIndex] : undefined);
}

// 子图边界 I/O 节点（inputNode.id=-10 / outputNode.id=-20）不在 _nodes_by_id 里，
// getNodeById 找不到它们；连往边界的连线因此无法解析。这里补上解析，让子图页面
// 的边界连线也能画出来。
function isSubgraphBoundaryNode(node) {
  const sg = node?.subgraph;
  return !!sg && (node === sg.inputNode || node === sg.outputNode);
}

function nodeById(graph, id) {
  if (id == null) return null;
  const direct = graph?.getNodeById?.(id) ?? (graph?.nodes ?? graph?._nodes ?? []).find((node) => String(node.id) === String(id));
  if (direct) return direct;
  const input = graph?.inputNode;
  if (input && String(input.id) === String(id)) return input;
  const output = graph?.outputNode;
  if (output && String(output.id) === String(id)) return output;
  return null;
}

// 子图边界节点的连线锚点就是对应 SubgraphSlot 的 pos（图坐标），与原生 drawConnections
// 里 `t.pos` 一致。取不到时返回 null，交回通用路径兜底。
function boundarySlotPos(node, slot) {
  const pos = node?.slots?.[slot]?.pos;
  if (Array.isArray(pos) && pos.length >= 2 && Number.isFinite(pos[0]) && Number.isFinite(pos[1])) {
    return [pos[0], pos[1]];
  }
  return null;
}

let _activeNodeCache = null;
let _activeNodeCacheTime = 0;
const ACTIVE_CACHE_TTL = 80;
const RECENT_EXECUTION_TTL = 900;
let _executionWatcherStarted = false;
const _runningNodeIds = new Set();
const _recentExecutionNodeIds = new Map();

function normalizeNodeId(value) {
  if (value == null) return null;
  const id = typeof value === "object" ? (value.id ?? value.node ?? value.node_id) : value;
  return id == null ? null : String(id);
}

function rememberExecutionNode(value, ttl = RECENT_EXECUTION_TTL) {
  const id = normalizeNodeId(value);
  if (!id) return;

  _runningNodeIds.add(id);
  _recentExecutionNodeIds.set(id, performance.now() + ttl);
  invalidateActiveCache();
  markDirty();
  ensureAnimation();
}

function clearRunningExecutionNodes(keepRecent = true) {
  if (keepRecent) {
    const expiresAt = performance.now() + RECENT_EXECUTION_TTL;
    for (const id of _runningNodeIds) _recentExecutionNodeIds.set(id, expiresAt);
  }
  _runningNodeIds.clear();
  invalidateActiveCache();
  markDirty();
}

function addExecutionNodeIds(active) {
  const now = performance.now();

  for (const id of _runningNodeIds) active.add(id);

  for (const [id, expiresAt] of _recentExecutionNodeIds) {
    if (expiresAt > now) active.add(id);
    else _recentExecutionNodeIds.delete(id);
  }
}

function selectedNodeIds(canvas) {
  const now = performance.now();
  if (_activeNodeCache && (now - _activeNodeCacheTime) < ACTIVE_CACHE_TTL) {
    return _activeNodeCache;
  }

  const active = new Set();
  const graph = canvas?.graph || app?.graph;

  const manualNodes = Object.values(canvas?.selected_nodes || {});
  for (const n of manualNodes) { active.add(String(n.id)); }
  addExecutionNodeIds(active);

  if (!graph) { _activeNodeCache = active; _activeNodeCacheTime = now; return active; }

  const allNodes = Object.values(graph._nodes_by_id || {});

  for (const node of allNodes) {
    if (!node || active.has(String(node.id))) continue;

    const nid = String(node.id);

    if (node.status != null && node.status !== 0 && node.mode !== 4) {
      active.add(nid);
      continue;
    }
  }

  try {
    const canvasEl = canvas?.canvas || document.getElementById("graph-canvas");
    if (canvasEl) {
      const nodeEls = canvasEl.querySelectorAll(".comfy-node");
      for (const el of nodeEls) {
        const nodeId = el.getAttribute("data-id") || el.id?.replace("COMFY-", "");
        if (!nodeId || active.has(String(nodeId))) continue;

        const cls = el.className || "";
        const style = el.getAttribute("style") || "";

        if (/executing|running|processing|active|comfyui-node-status-1|status_executing/i.test(cls)) {
          active.add(String(nodeId));
          continue;
        }

        const borderStyle = el.style?.borderColor || getComputedStyle(el).borderColor;
        if (borderStyle && /#98ff|#0f0|rgb\(.*152.*255|rgb\(0.*255/i.test(borderStyle)) {
          active.add(String(nodeId));
        }
      }
    }
  } catch (_) {}

  if (typeof app !== "undefined" && app.canvas) {
    try {
      const runningNodeId = app.canvas?.running_node_id ||
                            app?.running_node_id ||
                            app?._last_running_node_id;
      if (runningNodeId != null) {
        active.add(String(runningNodeId));
      }
      if (app?.last_node_id != null) {
        active.add(String(app.last_node_id));
      }
    } catch (_) {}
  }

  try {
    for (const node of allNodes) {
      if (!node || active.has(String(node.id))) continue;
      if (node.mode === 4) continue;

      const el = document.querySelector(`[data-id="${node.id}"]`) ||
                 document.querySelector(`#COMFY-${node.id}`);
      if (!el) continue;

      const computed = getComputedStyle(el);
      const outline = computed.outlineColor || "";
      const boxShadow = computed.boxShadow || "";

      if (/#98ff|#0f0|rgb\(.*152.*255/i.test(outline + boxShadow)) {
        active.add(String(node.id));
        continue;
      }

      if (el.classList.contains("comfy-node-executing") ||
          el.classList.contains("node-execute") ||
          el.classList.contains("executing")) {
        active.add(String(node.id));
      }
    }
  } catch (_) {}

  _activeNodeCache = active;
  _activeNodeCacheTime = now;
  return active;
}

function invalidateActiveCache() {
  _activeNodeCache = null;
  _activeNodeCacheTime = 0;
}

let _nodeWatcherStarted = false;
function startNodeStateWatcher() {
  if (_nodeWatcherStarted) return;
  _nodeWatcherStarted = true;

  const tryStart = () => {
    const canvasEl = document.getElementById("graph-canvas") || document.querySelector("#app .comfy-canvas");
    if (!canvasEl) { setTimeout(tryStart, 500); return; }

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "class" &&
            m.target?.classList?.contains?.("comfy-node")) {
          invalidateActiveCache();
          break;
        }
        if (m.addedNodes?.length || m.removedNodes?.length) {
          for (const node of [...(m.addedNodes || []), ...(m.removedNodes || [])]) {
            if (node?.classList?.contains?.("comfy-node")) {
              invalidateActiveCache();
              break;
            }
          }
        }
      }
    });

    observer.observe(canvasEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const styleObserver = new MutationObserver(() => { invalidateActiveCache(); });
    canvasEl.querySelectorAll(".comfy-node").forEach(el => {
      styleObserver.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
    });

  };
  setTimeout(tryStart, 1000);
}

function startExecutionWatcher() {
  if (_executionWatcherStarted) return;
  _executionWatcherStarted = true;

  api.addEventListener("execution_start", () => {
    clearRunningExecutionNodes(false);
    ensureAnimation();
  });

  api.addEventListener("executing", ({ detail }) => {
    if (detail == null) {
      clearRunningExecutionNodes(true);
      return;
    }
    _runningNodeIds.clear();
    rememberExecutionNode(detail, RECENT_EXECUTION_TTL);
  });

  api.addEventListener("progress", ({ detail }) => {
    rememberExecutionNode(detail?.node ?? detail?.node_id, RECENT_EXECUTION_TTL);
  });

  api.addEventListener("executed", ({ detail }) => {
    rememberExecutionNode(detail?.node ?? detail?.node_id, RECENT_EXECUTION_TTL);
  });

  api.addEventListener("execution_cached", ({ detail }) => {
    for (const nodeId of detail?.nodes || []) rememberExecutionNode(nodeId, RECENT_EXECUTION_TTL);
  });

  api.addEventListener("execution_success", () => clearRunningExecutionNodes(true));
  api.addEventListener("execution_error", () => clearRunningExecutionNodes(true));
}

function shouldDraw(canvas, link, cfg) {
  if (cfg.displayMode === DISPLAY_ALL) return true;

  const originId = String(linkField(link, "origin_id", 1));
  const targetId = String(linkField(link, "target_id", 3));

  if (cfg.displayMode === DISPLAY_HOVER) {
    const hoverId = canvas?.node_over?.id;
    return hoverId != null && (String(hoverId) === originId || String(hoverId) === targetId);
  }

  const selected = selectedNodeIds(canvas);
  return selected.has(originId) || selected.has(targetId);
}

function connectionPos(node, isInput, slot) {
  const out = [0, 0];
  if (isSubgraphBoundaryNode(node)) {
    const pos = boundarySlotPos(node, slot);
    if (pos) return pos;
  }
  if (globalThis.LiteGraph?.vueNodesMode && node?.getSlotPosition) {
    const vuePosition = node.getSlotPosition(slot, isInput);
    if (Array.isArray(vuePosition) && vuePosition.length >= 2) return vuePosition;
  }
  if (node?.getConnectionPos) return node.getConnectionPos(isInput, slot, out) || out;
  const x = node?.pos?.[0] ?? 0;
  const y = node?.pos?.[1] ?? 0;
  const width = node?.size?.[0] ?? 180;
  const row = 36 + Number(slot || 0) * 20;
  return [x + (isInput ? 0 : width), y + row];
}

function linkColor(canvas, link, originNode, cfg) {
  if (cfg.dashStyle === DASH_VOID && cfg.colorMode !== COLOR_CUSTOM) return VOID_LINK_COLOR;
  if (cfg.colorMode === COLOR_CUSTOM) return cfg.customColor;
  const originSlot = linkField(link, "origin_slot", 2) ?? 0;
  // 普通节点从 outputs 取端口；子图输入边界节点没有 outputs，改从 slots 取。
  const output = originNode?.outputs?.[originSlot] ?? originNode?.slots?.[originSlot];
  const type = output?.type || linkField(link, "type", 5);
  return output?.color
    || canvas?.default_connection_color_byType?.[type]
    || canvas?.default_connection_color?.input_on
    || cfg.customColor;
}

function drawPath(ctx, from, to, style) {
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);

  if (style === PATH_DIRECT) {
    ctx.lineTo(to[0], to[1]);
  } else if (style === PATH_ORTHOGONAL) {
    const midX = (from[0] + to[0]) / 2;
    ctx.lineTo(midX, from[1]);
    ctx.lineTo(midX, to[1]);
    ctx.lineTo(to[0], to[1]);
  } else if (style === PATH_CIRCUIT) {
    const direction = to[0] >= from[0] ? 1 : -1;
    const offset = Math.max(48, Math.min(180, Math.abs(to[0] - from[0]) * 0.45));
    const turnX = from[0] + direction * offset;
    ctx.lineTo(turnX, from[1]);
    ctx.lineTo(turnX, to[1]);
    ctx.lineTo(to[0], to[1]);
  } else {
    const distance = Math.abs(to[0] - from[0]);
    const offset = Math.max(60, Math.min(220, distance * 0.5));
    ctx.bezierCurveTo(from[0] + offset, from[1], to[0] - offset, to[1], to[0], to[1]);
  }

  ctx.stroke();
}

function applyDash(ctx, cfg) {
  switch (cfg.dashStyle) {
    case DASH_FLOW:
      ctx.setLineDash([14, 10]);
      ctx.lineDashOffset = -(performance.now() / 40) * cfg.speed;
      break;
    case DASH_FLOW_SOLID:
      ctx.setLineDash([]);
      ctx.lineDashOffset = -(performance.now() / 20) * cfg.speed;
      break;
    case DASH_PARTICLE:
    case DASH_GRADIENT:
    case DASH_TEXTURE:
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      break;
    default:
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
  }
}

function drawVoidLink(ctx, from, to, color, cfg, canvas) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < 0.1) return;

  const scale = Number(canvas?.ds?.scale) || 1;
  const stubLength = Math.min(VOID_STUB_LENGTH_PX / scale, distance / 2);
  const horizontal = Math.abs(dx) >= Math.abs(dy) * 0.35;
  const direction = horizontal
    ? [Math.sign(dx) || 1, 0]
    : [0, Math.sign(dy) || 1];

  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.strokeStyle = color;
  ctx.lineWidth = cfg.lineWidth;
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(from[0] + direction[0] * stubLength, from[1] + direction[1] * stubLength);
  ctx.moveTo(to[0], to[1]);
  ctx.lineTo(to[0] - direction[0] * stubLength, to[1] - direction[1] * stubLength);
  ctx.stroke();
}

function drawStyledLink(ctx, from, to, color, cfg, canvas) {
  ctx.save();
  ctx.globalAlpha = cfg.opacity;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const style = cfg.dashStyle;

  if (style === DASH_VOID) {
    drawVoidLink(ctx, from, to, color, cfg, canvas);
  } else if (style === DASH_PULSE) {
    drawPulseLink(ctx, from, to, color, cfg);
  } else if (style === DASH_LIGHTNING) {
    drawLightningLink(ctx, from, to, color, cfg);
  } else if (style === DASH_METEOR) {
    drawMeteorLink(ctx, from, to, color, cfg);
  } else if (style === DASH_ENERGY_WAVE) {
    drawEnergyWaveLink(ctx, from, to, color, cfg);
  } else if (style === DASH_LASER) {
    drawLaserLink(ctx, from, to, color, cfg);
  } else if (style === DASH_PARTICLE) {
    drawParticleLink(ctx, from, to, color, cfg);
  } else if (style === DASH_GRADIENT) {
    drawGradientLink(ctx, from, to, color, cfg);
  } else if (style === DASH_AURORA) {
    drawAuroraLink(ctx, from, to, color, cfg);
  } else if (style === DASH_HELIX) {
    drawHelixLink(ctx, from, to, color, cfg);
  } else if (style === DASH_WAVE) {
    drawWaveLink(ctx, from, to, color, cfg);
  } else if (style === DASH_GALAXY) {
    drawGalaxyLink(ctx, from, to, color, cfg);
  } else if (style === DASH_TEXTURE && cachedTextureImage) {
    drawTextureLink(ctx, from, to, color, cfg);
  } else if (style === DASH_FLOW_SOLID) {
    applyDash(ctx, cfg);
    ctx.strokeStyle = color;
    ctx.lineWidth = cfg.lineWidth;
    drawPath(ctx, from, to, cfg.pathStyle);
  } else {
    applyDash(ctx, cfg);

    // 走到这里只剩实线/流动虚线/流动实线/无贴图回退，都是简单描边，可直接发光。
    if (cfg.glow) {
      ctx.strokeStyle = color;
      ctx.lineWidth = cfg.lineWidth + 4;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      drawPath(ctx, from, to, cfg.pathStyle);
      ctx.shadowBlur = 0;
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = cfg.lineWidth;
    drawPath(ctx, from, to, cfg.pathStyle);
  }
  ctx.restore();
}

function buildPathPoints(from, to, pathStyle) {
  const points = [from];
  if (pathStyle === PATH_DIRECT) {
    points.push(to);
  } else if (pathStyle === PATH_ORTHOGONAL) {
    const midX = (from[0] + to[0]) / 2;
    points.push([midX, from[1]], [midX, to[1]], to);
  } else if (pathStyle === PATH_CIRCUIT) {
    const direction = to[0] >= from[0] ? 1 : -1;
    const offset = Math.max(48, Math.min(180, Math.abs(to[0] - from[0]) * 0.45));
    const turnX = from[0] + direction * offset;
    points.push([turnX, from[1]], [turnX, to[1]], to);
  } else {
    points.push([from[0] + Math.max(60, Math.min(220, Math.abs(to[0] - from[0]) * 0.5)), from[1]],
      [to[0] - Math.max(60, Math.min(220, Math.abs(to[0] - from[0]) * 0.5)), to[1]], to);
  }
  return points;
}

function pathLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i][0] - points[i-1][0], points[i][1] - points[i-1][1]);
  }
  return len || 1;
}

function pointOnPath(points, t) {
  const totalLen = pathLength(points);
  let targetDist = ((t % 1) + 1) % 1 * totalLen;
  for (let i = 1; i < points.length; i++) {
    const segLen = Math.hypot(points[i][0] - points[i-1][0], points[i][1] - points[i-1][1]);
    if (targetDist <= segLen) {
      const ratio = segLen > 0 ? targetDist / segLen : 0;
      return [
        points[i-1][0] + (points[i][0] - points[i-1][0]) * ratio,
        points[i-1][1] + (points[i][1] - points[i-1][1]) * ratio,
      ];
    }
    targetDist -= segLen;
  }
  // 浮点边界下 targetDist 可能略超总长，此时直接取终点；
  // 旧实现 return to 引用了不存在的变量，一旦触发会让整帧绘制抛错回退原生渲染。
  return points[points.length - 1];
}

function drawNeonLink(ctx, from, to, color, cfg) {
  const baseWidth = cfg.lineWidth;
  const time = performance.now() / 1000;

  for (let layer = 3; layer >= 0; layer--) {
    const glowAlpha = 0.08 + layer * 0.06;
    const glowWidth = baseWidth + (4 - layer) * 6;
    ctx.globalAlpha = cfg.opacity * glowAlpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = glowWidth;
    ctx.shadowColor = color;
    ctx.shadowBlur = (4 - layer) * 8 + Math.sin(time * 2 + layer) * 3;
    ctx.lineDashOffset = 0;
    setLineDashEmpty(ctx);
    drawPath(ctx, from, to, cfg.pathStyle);
  }
  ctx.shadowBlur = 0;

  ctx.globalAlpha = cfg.opacity;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = baseWidth * 0.6;
  setLineDashEmpty(ctx);
  drawPath(ctx, from, to, cfg.pathStyle);

  ctx.globalAlpha = cfg.opacity * 0.9;
  ctx.strokeStyle = color;
  ctx.lineWidth = baseWidth;
  setLineDashEmpty(ctx);
  drawPath(ctx, from, to, cfg.pathStyle);
}

function drawParticleLink(ctx, from, to, color, cfg) {
  setLineDashEmpty(ctx);
  ctx.strokeStyle = color;
  ctx.lineWidth = cfg.lineWidth * 0.5;
  ctx.globalAlpha = cfg.opacity * 0.25;
  drawPath(ctx, from, to, cfg.pathStyle);

  const points = buildPathPoints(from, to, cfg.pathStyle);
  const time = performance.now() / (800 / cfg.speed);
  const count = Math.max(6, Math.floor(pathLength(points) / 30));

  for (let i = 0; i < count; i++) {
    const t = ((time / count) + i / count) % 1;
    const pos = pointOnPath(points, t);
    const size = cfg.lineWidth * (1.2 + 0.8 * Math.sin(t * Math.PI));
    const alpha = 0.5 + 0.5 * Math.sin((t + i * 0.15) * Math.PI * 2);

    ctx.beginPath();
    ctx.arc(pos[0], pos[1], size, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = cfg.opacity * alpha;
    ctx.shadowColor = color;
    ctx.shadowBlur = size * 2;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawPulseLink(ctx, from, to, color, cfg) {
  setLineDashEmpty(ctx);
  ctx.strokeStyle = color;
  ctx.lineWidth = cfg.lineWidth;
  ctx.globalAlpha = cfg.opacity * 0.35;
  drawPath(ctx, from, to, cfg.pathStyle);

  const points = buildPathPoints(from, to, cfg.pathStyle);
  const time = performance.now() / (600 / cfg.speed);
  const pulseCount = 2;

  for (let p = 0; p < pulseCount; p++) {
    const baseT = ((time * 0.3) + p / pulseCount) % 1;
    const pulseWidth = 0.18;

    for (let step = 0; step < 20; step++) {
      const t = baseT - step * 0.008;
      if (t < 0 || t > 1) continue;
      const pos = pointOnPath(points, t);
      const distFromCenter = Math.abs(step * 0.008);
      const fade = Math.max(0, 1 - distFromCenter / pulseWidth);
      const radius = cfg.lineWidth * (1.5 - distFromCenter * 4);

      if (radius > 0.3) {
        ctx.beginPath();
        ctx.arc(pos[0], pos[1], radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = cfg.opacity * fade * 0.9;
        ctx.fill();
      }
    }
  }
}

function drawLightningLink(ctx, from, to, color, cfg) {
  setLineDashEmpty(ctx);
  const points = buildPathPoints(from, to, cfg.pathStyle);
  const c = parseColor(color);
  const time = performance.now() / (80 / cfg.speed);

  for (let bolt = 0; bolt < 2; bolt++) {
    const basePhase = ((time * 0.6) + bolt * 0.5) % 1;

    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= Math.min(points.length - 1, 60); i += Math.max(1, Math.floor((points.length - 1) / 40))) {
      const idx = Math.min(i, points.length - 1);
      const pt = points[idx];
      const tAlong = idx / Math.max(1, points.length - 1);

      const phaseDist = Math.abs(tAlong - basePhase);
      if (phaseDist > 0.35 && phaseDist < 0.65) continue;

      const jagX = pt[0] + (Math.random() - 0.5) * cfg.lineWidth * 2.5;
      const jagY = pt[1] + (Math.random() - 0.5) * cfg.lineWidth * 2.5;

      if (!started) { ctx.moveTo(jagX, jagY); started = true; }
      else { ctx.lineTo(jagX, jagY); }
    }

    const flicker = 0.6 + 0.4 * Math.sin(time * 15 + bolt * 3);
    ctx.strokeStyle = `rgba(255,255,255,${cfg.opacity * flicker})`;
    ctx.lineWidth = cfg.lineWidth * 0.7;
    ctx.shadowColor = color;
    ctx.shadowBlur = cfg.lineWidth * 3;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  setLineDashEmpty(ctx);
  ctx.strokeStyle = color;
  ctx.lineWidth = cfg.lineWidth * 0.25;
  ctx.globalAlpha = cfg.opacity * 0.2;
  drawPath(ctx, from, to, cfg.pathStyle);
}

function drawMeteorLink(ctx, from, to, color, cfg) {
  setLineDashEmpty(ctx);
  const points = buildPathPoints(from, to, cfg.pathStyle);
  const time = performance.now() / (900 / cfg.speed);
  const meteorCount = 3;

  setLineDashEmpty(ctx);
  ctx.strokeStyle = color;
  ctx.lineWidth = cfg.lineWidth * 0.3;
  ctx.globalAlpha = cfg.opacity * 0.15;
  drawPath(ctx, from, to, cfg.pathStyle);

  for (let m = 0; m < meteorCount; m++) {
    const baseT = ((time * 0.35) + m / meteorCount) % 1;
    const headPos = pointOnPath(points, baseT);
    const headSize = cfg.lineWidth * (2.2 + 0.6 * Math.sin(baseT * Math.PI));
    const tailLen = cfg.lineWidth * 10;

    for (let seg = 0; seg < 20; seg++) {
      const segT = baseT - seg * 0.012;
      if (segT < 0 || segT > 1) continue;
      const pos = pointOnPath(points, segT);
      const ratio = seg / 20;
      const size = headSize * (1 - ratio * 0.85);
      const alpha = (1 - ratio * ratio) * 0.85;

      if (size > 0.4) {
        ctx.beginPath();
        ctx.arc(pos[0], pos[1], size, 0, Math.PI * 2);
        const r = ratio < 0.3 ? 255 : c.r;
        const g = ratio < 0.3 ? 255 : c.g;
        const b = ratio < 0.3 ? 255 : c.b;
        ctx.fillStyle = `rgba(${r},${g},${b},${cfg.opacity * alpha})`;
        ctx.shadowColor = color;
        ctx.shadowBlur = size * 1.5;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    ctx.beginPath();
    ctx.arc(headPos[0], headPos[1], headSize * 1.3, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = cfg.opacity * 0.95;
    ctx.shadowColor = color;
    ctx.shadowBlur = headSize * 2.5;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawEnergyWaveLink(ctx, from, to, color, cfg) {
  setLineDashEmpty(ctx);
  const points = buildPathPoints(from, to, cfg.pathStyle);
  const time = performance.now() / (700 / cfg.speed);
  const waveCount = 3;

  setLineDashEmpty(ctx);
  ctx.strokeStyle = color;
  ctx.lineWidth = cfg.lineWidth * 0.2;
  ctx.globalAlpha = cfg.opacity * 0.15;
  drawPath(ctx, from, to, cfg.pathStyle);

  for (let w = 0; w < waveCount; w++) {
    const centerT = ((time * 0.22) + w / waveCount) % 1;
    const centerPos = pointOnPath(points, centerT);
    const maxRadius = cfg.lineWidth * 5;

    for (let ring = 0; ring < 12; ring++) {
      const ringT = centerT - ring * 0.03;
      if (ringT < 0 || ringT > 1) continue;
      const ringPos = pointOnPath(points, ringT);
      const radius = maxRadius * (ring / 12);
      const alpha = (1 - ring / 12) * 0.7;

      if (radius > 0.5) {
        ctx.beginPath();
        ctx.arc(ringPos[0], ringPos[1], radius, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(0.5, cfg.lineWidth * 0.3 * (1 - ring / 12));
        ctx.globalAlpha = cfg.opacity * alpha;
        ctx.stroke();
      }
    }

    const coreR = cfg.lineWidth * 0.8;
    ctx.beginPath();
    ctx.arc(centerPos[0], centerPos[1], coreR, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = cfg.opacity * 0.95;
    ctx.shadowColor = color;
    ctx.shadowBlur = coreR * 3;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawLaserLink(ctx, from, to, color, cfg) {
  setLineDashEmpty(ctx);
  const points = buildPathPoints(from, to, cfg.pathStyle);
  const time = performance.now() / (400 / cfg.speed);

  for (let layer = 4; layer >= 0; layer--) {
    const layerW = cfg.lineWidth + (4 - layer) * 5;
    const layerAlpha = 0.04 + layer * 0.05;
    ctx.beginPath();

    for (let i = 0; i < points.length; i++) {
      const perp = perpVector(points, i);
      const wobble = Math.sin(time * 6 + i * 0.4 + layer) * (layer * 0.4);
      const px = points[i][0] + perp[0] * (wobble + layer * 0.3);
      const py = points[i][1] + perp[1] * (wobble + layer * 0.3);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = layerW;
    ctx.globalAlpha = cfg.opacity * layerAlpha;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = color;
    ctx.shadowBlur = (4 - layer) * 6 + Math.sin(time * 4) * 2;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    if (i === 0) ctx.moveTo(points[i][0], points[i][1]);
    else ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = cfg.lineWidth * 0.5;
  ctx.globalAlpha = cfg.opacity * 0.95;
  ctx.shadowColor = "#ffffff";
  ctx.shadowBlur = cfg.lineWidth * 2;
  ctx.stroke();
  ctx.shadowBlur = 0;

  const scanPos = pointOnPath(points, (time * 0.15) % 1);
  const scanR = cfg.lineWidth * 2.5;
  ctx.beginPath();
  ctx.arc(scanPos[0], scanPos[1], scanR, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.globalAlpha = cfg.opacity * (0.7 + 0.3 * Math.sin(time * 10));
  ctx.shadowColor = "#ffffff";
  ctx.shadowBlur = scanR * 3;
  ctx.fill();
  ctx.shadowBlur = 0;
}

function perpVector(points, idx) {
  if (idx >= points.length - 1) {
    const dx = points[idx][0] - points[idx - 1][0];
    const dy = points[idx][1] - points[idx - 1][1];
    const len = Math.hypot(dx, dy) || 1;
    return [-dy / len, dx / len];
  }
  const dx = points[idx + 1][0] - points[idx][0];
  const dy = points[idx + 1][1] - points[idx][1];
  const len = Math.hypot(dx, dy) || 1;
  return [-dy / len, dx / len];
}

// 极光：多层宽柔光带慢速摇曳 + 明暗呼吸，中央一条提亮芯线。安静、优雅，适合长时间挂着的工作流。
function drawAuroraLink(ctx, from, to, color, cfg) {
  const points = samplePathPoints(from, to, cfg.pathStyle);
  if (points.length < 2) return;
  const time = performance.now() / (1600 / cfg.speed);
  const c = parseColor(color);

  const auroraPoint = (i, sway) => {
    const perp = perpVector(points, i);
    return [points[i][0] + perp[0] * sway, points[i][1] + perp[1] * sway];
  };

  for (let layer = 4; layer >= 1; layer--) {
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const t = i / (points.length - 1);
      const sway = Math.sin(t * 5 - time * 2.2 + layer * 1.7) * (layer * 1.1)
        + Math.sin(t * 11 + time * 1.4) * 0.7;
      const p = auroraPoint(i, sway);
      if (i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    }
    const breathe = 0.5 + 0.5 * Math.sin(time * 1.7 + layer * 0.9);
    ctx.strokeStyle = color;
    ctx.lineWidth = cfg.lineWidth + layer * 2.4;
    ctx.globalAlpha = cfg.opacity * (0.1 - (layer - 1) * 0.02 + (0.07 - (layer - 1) * 0.01) * breathe);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = color;
    ctx.shadowBlur = 6 + layer * 2.5;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const sway = Math.sin(i / (points.length - 1) * 5 - time * 2.2) * 0.6
      + Math.sin(i / (points.length - 1) * 11 + time * 1.4) * 0.3;
    const p = auroraPoint(i, sway);
    if (i === 0) ctx.moveTo(p[0], p[1]);
    else ctx.lineTo(p[0], p[1]);
  }
  ctx.strokeStyle = `rgba(${Math.min(255, c.r + 90)},${Math.min(255, c.g + 90)},${Math.min(255, c.b + 90)},1)`;
  ctx.lineWidth = Math.max(0.8, cfg.lineWidth * 0.5);
  ctx.globalAlpha = cfg.opacity * (0.65 + 0.3 * Math.sin(time * 1.7));
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// 双螺旋：两条相位相反的正弦链沿路径缠绕流动，张开处用横档相连，中间留一条淡主线。
function drawHelixLink(ctx, from, to, color, cfg) {
  const points = samplePathPoints(from, to, cfg.pathStyle);
  if (points.length < 2) return;
  const time = performance.now() / (1000 / cfg.speed);
  const totalLen = pathLength(points);
  const amp = cfg.lineWidth * 2.1;
  const cycles = Math.max(1.5, Math.min(7, totalLen / 110));
  const strandA = [];
  const strandB = [];

  for (let i = 0; i < points.length; i++) {
    const perp = perpVector(points, i);
    const t = i / (points.length - 1);
    const offset = Math.sin(t * cycles * Math.PI * 2 - time * 2.4) * amp;
    strandA.push([points[i][0] + perp[0] * offset, points[i][1] + perp[1] * offset]);
    strandB.push([points[i][0] - perp[0] * offset, points[i][1] - perp[1] * offset]);
  }

  // 横档：只在两条链张开最大的位置绘制，交叉附近留白，形成 DNA 的节奏感。
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.7, cfg.lineWidth * 0.4);
  for (let i = 0; i < points.length; i++) {
    const t = i / (points.length - 1);
    const open = Math.abs(Math.sin(t * cycles * Math.PI * 2 - time * 2.4));
    if (open < 0.55) continue;
    ctx.globalAlpha = cfg.opacity * 0.22 * open;
    ctx.beginPath();
    ctx.moveTo(strandA[i][0], strandA[i][1]);
    ctx.lineTo(strandB[i][0], strandB[i][1]);
    ctx.stroke();
  }

  ctx.shadowColor = color;
  ctx.shadowBlur = cfg.glow ? 8 : 0;
  for (const strand of [strandA, strandB]) {
    ctx.beginPath();
    ctx.moveTo(strand[0][0], strand[0][1]);
    for (let i = 1; i < strand.length; i++) ctx.lineTo(strand[i][0], strand[i][1]);
    ctx.strokeStyle = color;
    ctx.lineWidth = cfg.lineWidth;
    ctx.globalAlpha = cfg.opacity;
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  // 中间淡主线，让横档留白处不至于断开
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.6, cfg.lineWidth * 0.3);
  ctx.globalAlpha = cfg.opacity * 0.28;
  drawPath(ctx, from, to, cfg.pathStyle);
}

// 波涛：整条线变成沿法线起伏的正弦波，波峰随时间流动，峰顶带一条提亮高光。
function drawWaveLink(ctx, from, to, color, cfg) {
  const points = samplePathPoints(from, to, cfg.pathStyle);
  if (points.length < 2) return;
  const time = performance.now() / (800 / cfg.speed);
  const totalLen = pathLength(points);
  const amp = cfg.lineWidth * 1.7 + 1.2;
  const cycles = Math.max(2, Math.min(8, totalLen / 80));
  const c = parseColor(color);

  const waveOffset = (i) => {
    const t = i / (points.length - 1);
    return Math.sin(t * cycles * Math.PI * 2 - time * 2.6) * amp;
  };

  if (cfg.glow) {
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const perp = perpVector(points, i);
      const off = waveOffset(i);
      const px = points[i][0] + perp[0] * off;
      const py = points[i][1] + perp[1] * off;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = cfg.lineWidth + 4;
    ctx.globalAlpha = cfg.opacity * 0.35;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const perp = perpVector(points, i);
    const off = waveOffset(i);
    const px = points[i][0] + perp[0] * off;
    const py = points[i][1] + perp[1] * off;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = cfg.lineWidth;
  ctx.globalAlpha = cfg.opacity;
  ctx.stroke();

  // 峰顶高光：只保留波峰段，断续的提亮让波峰更立体
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < points.length; i++) {
    const perp = perpVector(points, i);
    const off = waveOffset(i);
    if (off < amp * 0.7) { started = false; continue; }
    const px = points[i][0] + perp[0] * off;
    const py = points[i][1] + perp[1] * off;
    if (!started) { ctx.moveTo(px, py); started = true; }
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = `rgba(${Math.min(255, c.r + 100)},${Math.min(255, c.g + 100)},${Math.min(255, c.b + 100)},1)`;
  ctx.lineWidth = Math.max(0.7, cfg.lineWidth * 0.45);
  ctx.globalAlpha = cfg.opacity * 0.8;
  ctx.stroke();
}

// 星河：一条细淡主线 + 位置固定、亮度随机闪烁的星点，最亮的星星带十字光芒。
function drawGalaxyLink(ctx, from, to, color, cfg) {
  const points = buildPathPoints(from, to, cfg.pathStyle);
  const time = performance.now() / (1000 / cfg.speed);
  const totalLen = pathLength(points);

  setLineDashEmpty(ctx);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.6, cfg.lineWidth * 0.4);
  ctx.globalAlpha = cfg.opacity * 0.45;
  drawPath(ctx, from, to, cfg.pathStyle);

  const count = Math.max(4, Math.floor(totalLen / 42));
  // 稳定伪随机：星点位置逐帧不变，只有亮度随时间闪烁
  const hash = (n) => {
    const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return v - Math.floor(v);
  };

  for (let i = 0; i < count; i++) {
    const t = hash(i + 1);
    const pos = pointOnPath(points, t);
    const twinkle = 0.5 + 0.5 * Math.sin(time * 2.6 + hash(i + 1000.7) * Math.PI * 2);
    const radius = cfg.lineWidth * (0.45 + 0.75 * hash(i + 77.7)) * (0.55 + 0.45 * twinkle);

    ctx.beginPath();
    ctx.arc(pos[0], pos[1], radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = cfg.opacity * (0.25 + 0.7 * twinkle);
    ctx.shadowColor = color;
    ctx.shadowBlur = radius * 3;
    ctx.fill();
    ctx.shadowBlur = 0;

    if (twinkle > 0.82) {
      const spike = radius * 2.6;
      ctx.beginPath();
      ctx.moveTo(pos[0] - spike, pos[1]);
      ctx.lineTo(pos[0] + spike, pos[1]);
      ctx.moveTo(pos[0], pos[1] - spike);
      ctx.lineTo(pos[0], pos[1] + spike);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.5, radius * 0.35);
      ctx.globalAlpha = cfg.opacity * (twinkle - 0.82) * 2.2;
      ctx.stroke();
    }
  }
}

function drawGradientLink(ctx, from, to, color, cfg) {
  setLineDashEmpty(ctx);
  const points = buildPathPoints(from, to, cfg.pathStyle);
  const grad = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);

  const offsetBase = ((performance.now() / 500) * cfg.speed * 0.05) % 1;
  const c = parseColor(color);

  grad.addColorStop(((offsetBase + 0) % 1), `rgba(${c.r},${c.g},${c.b},1)`);
  grad.addColorStop(((offsetBase + 0.2) % 1), `rgba(${c.r},${c.g},${c.b},0.3)`);
  grad.addColorStop(((offsetBase + 0.5) % 1), `rgba(${c.r},${c.g},${c.b},1)`);
  grad.addColorStop(((offsetBase + 0.7) % 1), `rgba(${c.r},${c.g},${c.b},0.3)`);
  grad.addColorStop(((offsetBase + 1) % 1), `rgba(${c.r},${c.g},${c.b},1)`);

  ctx.strokeStyle = grad;
  ctx.lineWidth = cfg.lineWidth;
  ctx.globalAlpha = cfg.opacity;
  drawPath(ctx, from, to, cfg.pathStyle);

  if (cfg.glow) {
    ctx.strokeStyle = grad;
    ctx.lineWidth = cfg.lineWidth + 4;
    ctx.globalAlpha = cfg.opacity * 0.4;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    drawPath(ctx, from, to, cfg.pathStyle);
    ctx.shadowBlur = 0;
  }
}

function drawTextureLink(ctx, from, to, color, cfg) {
  if (!cachedTextureImage || cachedTextureImage.complete === false || cachedTextureImage.naturalWidth === 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = cfg.lineWidth;
    ctx.globalAlpha = cfg.opacity;
    setLineDashEmpty(ctx);
    drawPath(ctx, from, to, cfg.pathStyle);
    return;
  }

  const img = cachedTextureImage;
  const points = samplePathPoints(from, to, cfg.pathStyle);
  if (points.length < 2) return;

  const tileW = Math.max(6, img.width * (cfg.lineWidth * 0.7 / Math.max(1, img.height)));
  const gapW = tileW * 0.6;
  const cycleLen = tileW + gapW;
  const time = performance.now() / (1000 / cfg.speed);
  const offsetPixels = (time * cfg.lineWidth * 35) % cycleLen;

  ctx.save();
  ctx.globalAlpha = cfg.opacity;

  let accumulatedDist = -offsetPixels;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const segLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (segLen < 0.5) continue;

    const angle = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);

    ctx.save();
    ctx.translate(p0[0], p0[1]);
    ctx.rotate(angle);

    let pos = 0;

    if (accumulatedDist < 0) {
      pos = -accumulatedDist;
      accumulatedDist = 0;
    } else {
      const phaseInCycle = accumulatedDist % cycleLen;
      if (phaseInCycle < tileW) {
        pos = phaseInCycle;
        const w = Math.min(tileW - pos, segLen);
        if (w > 1) ctx.drawImage(img, pos, -cfg.lineWidth / 2, w, cfg.lineWidth);
        pos += cycleLen - phaseInCycle + tileW;
      } else {
        pos = cycleLen - phaseInCycle;
      }
      accumulatedDist -= phaseInCycle;
    }

    while (pos < segLen + 0.5) {
      const w = Math.min(tileW, segLen - pos);
      if (w > 1) {
        ctx.drawImage(img, pos, -cfg.lineWidth / 2, w, cfg.lineWidth);
      }
      pos += cycleLen;
    }

    accumulatedDist += segLen;
    ctx.restore();
  }
  ctx.restore();

  ctx.save();
  clipToPath(ctx, from, to, cfg.pathStyle);
  ctx.globalCompositeOperation = "source-atop";
  ctx.strokeStyle = color;
  ctx.lineWidth = cfg.lineWidth;
  ctx.globalAlpha = cfg.opacity * 0.25;
  setLineDashEmpty(ctx);
  drawPath(ctx, from, to, cfg.pathStyle);
  ctx.restore();
}

function samplePathPoints(from, to, pathStyle) {
  const pts = [];
  if (pathStyle === PATH_DIRECT) {
    pts.push(from, to);
  } else if (pathStyle === PATH_ORTHOGONAL) {
    const midX = (from[0] + to[0]) / 2;
    pts.push(from, [midX, from[1]], [midX, to[1]], to);
  } else if (pathStyle === PATH_CIRCUIT) {
    const dir = to[0] >= from[0] ? 1 : -1;
    const off = Math.max(48, Math.min(180, Math.abs(to[0] - from[0]) * 0.45));
    const turnX = from[0] + dir * off;
    pts.push(from, [turnX, from[1]], [turnX, to[1]], to);
  } else {
    const d = Math.max(60, Math.min(220, Math.abs(to[0] - from[0]) * 0.5));
    const cp1 = [from[0] + d, from[1]];
    const cp2 = [to[0] - d, to[1]];
    const steps = Math.max(24, Math.ceil(Math.hypot(to[0]-from[0], to[1]-from[1]) / 6));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      const x = mt*mt*mt*from[0] + 3*mt*mt*t*cp1[0] + 3*mt*t*t*cp2[0] + t*t*t*to[0];
      const y = mt*mt*mt*from[1] + 3*mt*mt*t*cp1[1] + 3*mt*t*t*cp2[1] + t*t*t*to[1];
      pts.push([x, y]);
    }
  }
  return pts;
}

function clipToPath(ctx, from, to, pathStyle) {
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  if (pathStyle === PATH_DIRECT) {
    ctx.lineTo(to[0], to[1]);
  } else if (pathStyle === PATH_ORTHOGONAL) {
    const midX = (from[0] + to[0]) / 2;
    ctx.lineTo(midX, from[1]); ctx.lineTo(midX, to[1]); ctx.lineTo(to[0], to[1]);
  } else if (pathStyle === PATH_CIRCUIT) {
    const dir = to[0] >= from[0] ? 1 : -1;
    const off = Math.max(48, Math.min(180, Math.abs(to[0] - from[0]) * 0.45));
    ctx.lineTo(from[0] + dir * off, from[1]); ctx.lineTo(from[0] + dir * off, to[1]); ctx.lineTo(to[0], to[1]);
  } else {
    const d = Math.max(60, Math.min(220, Math.abs(to[0] - from[0]) * 0.5));
    ctx.bezierCurveTo(from[0] + d, from[1], to[0] - d, to[1], to[0], to[1]);
  }
  ctx.closePath();
  ctx.clip();
}

function parseColor(value) {
  // 兼容 LiteGraph 部分版本把端口颜色存成 { color_on, color_off } 对象的情况。
  if (value && typeof value === "object") {
    const inner = value.color_on || value.color_off || value.color;
    if (typeof inner === "string") return parseColor(inner);
  }
  const text = String(value ?? "").trim();
  const rgbMatch = text.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (rgbMatch) {
    return { r: Number(rgbMatch[1]) || 0, g: Number(rgbMatch[2]) || 0, b: Number(rgbMatch[3]) || 0 };
  }
  let hex = text.replace("#", "");
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  return {
    r: parseInt(hex.slice(0, 2), 16) || 0,
    g: parseInt(hex.slice(2, 4), 16) || 0,
    b: parseInt(hex.slice(4, 6), 16) || 0,
  };
}

function setLineDashEmpty(ctx) { ctx.setLineDash([]); }

function drawOverlay(canvas, ctx, cfg = config(), graphOverride = null) {
  if (!cfg.enabled) return false;

  const graph = graphOverride || canvas?.graph || app.graph;
  if (!graph) return false;

  const links = getLinks(graph).filter((link) => shouldDraw(canvas, link, cfg));
  if (!links.length) return false;

  // Check the complete batch before painting. During connect/disconnect, the
  // graph can briefly expose a link before one endpoint is available. Native
  // LiteGraph drawing is more reliable for that transient state.
  const resolvedLinks = links.map((link) => ({
    link,
    originNode: nodeById(graph, linkField(link, "origin_id", 1)),
    targetNode: nodeById(graph, linkField(link, "target_id", 3)),
  }));
  if (resolvedLinks.some(({ originNode, targetNode }) => !originNode || !targetNode)) {
    return false;
  }

  for (const item of resolvedLinks) {
    item.from = connectionPos(item.originNode, false, linkField(item.link, "origin_slot", 2) ?? 0);
    item.to = connectionPos(item.targetNode, true, linkField(item.link, "target_slot", 4) ?? 0);
  }
  if (resolvedLinks.some(({ from, to }) => (
    !Array.isArray(from) || !Array.isArray(to)
    || !Number.isFinite(from[0]) || !Number.isFinite(from[1])
    || !Number.isFinite(to[0]) || !Number.isFinite(to[1])
  ))) {
    return false;
  }

  let hasAnimatedLink = false;

  for (const { link, originNode, from, to } of resolvedLinks) {
    hasAnimatedLink = true;

    drawStyledLink(ctx, from, to, linkColor(canvas, link, originNode, cfg), cfg, canvas);
  }

  const isAnimatedStyle = ANIMATED_STYLES.includes(cfg.dashStyle);
  const isTextureAnimated = cfg.dashStyle === DASH_TEXTURE && cachedTextureImage;
  const isAlwaysAnimate = cfg.displayMode !== DISPLAY_ALL && hasAnimatedLink;

  if ((isAnimatedStyle || isTextureAnimated || isAlwaysAnimate) && hasAnimatedLink) {
    ensureAnimation();
  }
  return true;
}

function hasRenderableLink(canvas, cfg, graph = canvas?.graph || app.graph) {
  if (!graph) return false;

  for (const link of getLinks(graph)) {
    if (!shouldDraw(canvas, link, cfg)) continue;
    const originNode = nodeById(graph, linkField(link, "origin_id", 1));
    const targetNode = nodeById(graph, linkField(link, "target_id", 3));
    if (originNode && targetNode) return true;
  }

  return false;
}

function graphFromDrawArguments(canvas, args) {
  const graph = args?.find((value) => (
    value && typeof value === "object"
    && typeof value.getNodeById === "function"
    && (value.links != null || value._links != null)
  ));
  return graph || canvas?.graph || app.graph;
}

// 原生连线是否被设为隐藏（links_render_mode = HIDDEN_LINK，本机取值 -1）。
// 隐藏时交回原生等于画空白，所以这种情况下我们必须自己画。
function nativeLinksHidden(canvas = app.canvas) {
  const mode = canvas?.links_render_mode;
  if (mode == null) return false;
  const LG = globalThis.LiteGraph;
  const hidden = LG?.LinkRenderType?.HIDDEN_LINK ?? LG?.HIDDEN_LINK ?? -1;
  return mode === hidden;
}

function isCanvasInteracting(canvas = app.canvas) {
  const hasState = (value) => value != null && value !== false && typeof value !== "function";
  return canvas?.dragging_canvas === true
    // LiteGraph stores the node currently being moved separately from the
    // canvas-pan flag. Without this check custom links keep rebuilding every
    // path while a node is dragged, which makes the pointer feel sticky.
    || hasState(canvas?.node_dragged)
    || hasState(canvas?.moving_node)
    || hasState(canvas?.resizing_node)
    || canvas?.last_mouse_dragging === true
    || canvas?.pointer_is_down === true
    || canvas?.pointer?.isDown === true
    || canvas?.pointer?.dragStarted === true
    || (canvas?.__ggLinkStylePointerGesture === true
      && performance.now() - Number(canvas?.__ggLinkStyleGestureStartedAt || 0) < GESTURE_TIMEOUT_MS)
    || globalThis.__ggGroupStylerDraggingCanvas === canvas;
}

function ensureAnimation() {
  if (animationFrame != null) return;
  animationFrame = requestAnimationFrame(() => {
    animationFrame = null;
    const cfg = config();
    if (!cfg.enabled || isCanvasInteracting() || !hasRenderableLink(app.canvas, cfg)) return;

    const isAnimatedStyle = ANIMATED_STYLES.includes(cfg.dashStyle);
    const isTextureAnimated = cfg.dashStyle === DASH_TEXTURE && cachedTextureImage;
    const isNonAllMode = cfg.displayMode !== DISPLAY_ALL;

    if ((isAnimatedStyle || isTextureAnimated || isNonAllMode)
        && !isCanvasInteracting()
        && hasRenderableLink(app.canvas, cfg)) {
      markDirty();
      ensureAnimation();
    }
  });
}

function patchCanvas(canvas) {
  if (!canvas || typeof canvas.drawConnections !== "function") return false;
  if (hasLinkStyleWrapper(canvas.drawConnections)) {
    canvas.__ggLinkStylePatched = true;
    patchedCanvas = canvas;
    return true;
  }

  const originalDrawConnections = canvas.drawConnections;
  const wrappedDrawConnections = function(ctx, ...args) {
    const cfg = config();
    if (!cfg.enabled) {
      this.__ggLinkStyleLastNativePaint = performance.now();
      return originalDrawConnections.call(this, ctx, ...args);
    }

    // 关键：若用户把 ComfyUI 原生连线设为「隐藏」（links_render_mode=HIDDEN），
    // 交回原生就是画空白。这种设置下我们必须自己画连线——即便在拖拽/平移中，
    // 否则移动画布时连线就消失。只有当原生连线可见时，交互期间交回原生才安全
    // （原生更省、也仍然看得见）。
    const hidden = nativeLinksHidden(this);
    if (isCanvasInteracting(this) && !hidden) {
      this.__ggLinkStyleLastNativePaint = performance.now();
      return originalDrawConnections.call(this, ctx, ...args);
    }

    let painted = false;
    try {
      painted = drawOverlay(this, ctx, cfg, graphFromDrawArguments(this, args));
    } catch (error) {
      console.warn("[GuliNodes] Failed to draw custom link style:", error);
      // A malformed/stale link or an incompatible canvas context must never
      // blank the entire graph for a frame. Keep ComfyUI's renderer as the
      // reliable fallback and allow the next redraw to retry custom styling.
      this.__ggLinkStyleLastNativePaint = performance.now();
      return originalDrawConnections.call(this, ctx, ...args);
    }

    if (painted) {
      this.__ggLinkStyleLastCustomPaint = performance.now();
      return undefined;
    }

    // 本帧自定义什么都没画（无图/无连线/端点未就绪/坐标未定）。
    // 筛选模式下"没有命中"是刻意隐藏，直接抑制原生即可。
    if (cfg.displayMode !== DISPLAY_ALL) {
      this.__ggLinkStyleLastCustomPaint = performance.now();
      return undefined;
    }
    // 全部模式：交回原生兜底。若原生被隐藏（兜底也是空白），则说明这是瞬态读空，
    // 安排下一帧重画，直到自定义能画出来，绝不停在空白帧上。
    this.__ggLinkStyleLastNativePaint = performance.now();
    if (hidden && hasRenderableLink(this, cfg)) {
      requestAnimationFrame(() => markDirty());
    }
    return originalDrawConnections.call(this, ctx, ...args);
  };
  wrappedDrawConnections.__ggLinkStyleWrapper = true;
  wrappedDrawConnections.__ggLinkStyleOriginal = originalDrawConnections;
  canvas.drawConnections = wrappedDrawConnections;

  canvas.__ggLinkStylePatched = true;
  patchedCanvas = canvas;
  return true;
}

function hasLinkStyleWrapper(drawConnections) {
  const visited = new Set();
  let current = drawConnections;
  while (typeof current === "function" && !visited.has(current)) {
    if (current.__ggLinkStyleWrapper) return true;
    visited.add(current);
    current = current.__ggLinkStyleOriginal || current.__ggGroupStylerConnectionOriginal;
  }
  return false;
}

function installInteractionReleaseHook(canvas) {
  if (!canvas?.canvas || canvas.__ggLinkStyleReleaseHook) return;
  const ownerDocument = canvas.canvas.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;
  const begin = () => {
    canvas.__ggLinkStylePointerGesture = true;
    canvas.__ggLinkStyleGestureStartedAt = performance.now();
  };
  const refresh = () => {
    canvas.__ggLinkStylePointerGesture = false;
    requestAnimationFrame(() => {
      markDirty();
      ensureAnimation();
    });
  };
  ownerWindow.addEventListener("pointerdown", begin, true);
  ownerWindow.addEventListener("pointerup", refresh, true);
  ownerWindow.addEventListener("pointercancel", refresh, true);
  ownerWindow.addEventListener("mouseup", refresh, true);
  ownerWindow.addEventListener("blur", refresh, true);
  canvas.__ggLinkStyleReleaseHook = true;
}

function patchCanvasSoon() {
  let attempts = 0;
  const tick = () => {
    attempts += 1;
    const canvas = app.canvas;
    if (patchCanvas(canvas)) {
      installInteractionReleaseHook(canvas);
      startLinkStyleWatchdog();
      return;
    }
    if (attempts >= 30) {
      // Even if the canvas never appeared, keep the watchdog alive: ComfyUI
      // may build a fresh canvas instance later (workflow load, menu switch).
      startLinkStyleWatchdog();
      return;
    }
    setTimeout(tick, 100);
  };
  tick();
}

// Low-frequency self-heal for every "links sometimes disappear / lose their
// style" path we know of:
//   1. ComfyUI replaced the canvas instance (workflow load, menu switch) and
//      the drawConnections wrapper vanished — reinstall it.
//   2. A pointer gesture flag leaked without a pointerup (released outside
//      the window, alt-tab, context menu) — the GESTURE_TIMEOUT_MS guard in
//      isCanvasInteracting expires it; a repaint then restores the style.
//   3. The release repaint after a drag was swallowed, so the canvas kept the
//      native renderer from the drag frames — repaint once, style returns.
// The stale check only fires when the *most recent* paint was a native one
// while custom styling is enabled, idle, and renderable — so a resting canvas
// whose last frame was already custom-styled never triggers extra repaints.
let linkWatchdogTimer = null;
function startLinkStyleWatchdog() {
  if (linkWatchdogTimer != null) return;
  linkWatchdogTimer = setInterval(() => {
    try {
      const canvas = app.canvas;
      if (!canvas || typeof canvas.drawConnections !== "function") return;
      if (!patchCanvas(canvas)) return;
      installInteractionReleaseHook(canvas);

      const cfg = config();
      if (!cfg.enabled || isCanvasInteracting(canvas)) return;
      if (!hasRenderableLink(canvas, cfg)) return;

      // Fire only when the most recent paint frame was handed to the native
      // renderer (or nothing ever painted). Once custom styling runs again it
      // refreshes __ggLinkStyleLastCustomPaint, so this fires at most once per
      // lost frame — never in a loop over an already-correct canvas.
      const lastNative = Number(canvas.__ggLinkStyleLastNativePaint) || 0;
      const lastCustom = Number(canvas.__ggLinkStyleLastCustomPaint) || 0;
      if (lastCustom >= lastNative) return;

      canvas.__ggLinkStyleLastCustomPaint = performance.now();
      markDirty();
      ensureAnimation();
    } catch (error) {
      // The watchdog must never become the source of a console storm.
      console.warn("[GuliNodes] Link style watchdog tick failed:", error);
    }
  }, LINK_WATCHDOG_INTERVAL_MS);
}

function createTopButton(title, icon, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "comfyui-button gg-ui-top-button gg-link-style-btn";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = ggIcon(icon, 18);
  button.addEventListener("click", action);
  return button;
}

function createControlRow(labelText, control, valueEl = null) {
  const row = document.createElement("label");
  row.className = "gg-link-style-row";

  const label = document.createElement("span");
  label.className = "gg-link-style-label";
  label.textContent = labelText;
  row.append(label, control);
  if (valueEl) row.append(valueEl);
  return row;
}

function createSelect(label, id, options, fallback) {
  const select = document.createElement("select");
  for (const option of options) {
    const item = document.createElement("option");
    item.value = option;
    item.textContent = option;
    select.appendChild(item);
  }
  select.value = setting(id, fallback);
  select.addEventListener("change", () => setSettingValue(id, select.value));
  return createControlRow(label, select);
}

function createRange(label, id, fallback, min, max, step, format = (value) => value) {
  const value = String(numberSetting(id, fallback, min, max));
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = value;

  const valueEl = document.createElement("span");
  valueEl.className = "gg-link-style-value";
  valueEl.textContent = format(Number(value));

  input.addEventListener("input", () => {
    valueEl.textContent = format(Number(input.value));
    setSettingValue(id, Number(input.value));
  });

  return createControlRow(label, input, valueEl);
}

function createToggle(label, id, fallback) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(setting(id, fallback));
  input.addEventListener("change", () => setSettingValue(id, input.checked));
  return createControlRow(label, input);
}

function createColorRow() {
  const row = document.createElement("div");
  row.className = "gg-link-style-row";

  const label = document.createElement("span");
  label.className = "gg-link-style-label";
  label.textContent = "颜色";

  const select = document.createElement("select");
  for (const option of [COLOR_TYPE, COLOR_CUSTOM]) {
    const item = document.createElement("option");
    item.value = option;
    item.textContent = option;
    select.appendChild(item);
  }
  select.value = setting(SETTINGS.colorMode, COLOR_TYPE);
  select.addEventListener("change", () => setSettingValue(SETTINGS.colorMode, select.value));

  const color = document.createElement("input");
  color.type = "color";
  color.value = normalizeColor(setting(SETTINGS.customColor, "#72d6ff"));
  color.title = "统一颜色";
  color.setAttribute("aria-label", "统一颜色");
  color.addEventListener("input", () => setSettingValue(SETTINGS.customColor, color.value));

  row.append(label, select, color);
  return row;
}

function createPanelBackgroundRow() {
  const row = document.createElement("div");
  row.className = "gg-link-style-row gg-link-style-bg-row";

  const label = document.createElement("span");
  label.className = "gg-link-style-label";
  label.textContent = "\u80cc\u666f";

  const presets = document.createElement("div");
  presets.className = "gg-link-style-bg-presets";

  const currentColor = panelBackgroundColor();
  for (const preset of QUICK_PANEL_BG_PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gg-link-style-bg-swatch";
    button.dataset.color = preset.color;
    button.title = preset.name;
    button.setAttribute("aria-label", preset.name);
    button.style.background = preset.color;
    button.classList.toggle("active", preset.color.toLowerCase() === currentColor.toLowerCase());
    button.addEventListener("click", () => {
      setSettingValue(SETTINGS.menuBackgroundColor, preset.color);
      applyQuickPanelBackground(row.closest("#gg-link-style-panel"), preset.color);
    });
    presets.appendChild(button);
  }

  const color = document.createElement("input");
  color.type = "color";
  color.className = "gg-link-style-bg-input";
  color.value = currentColor;
  color.title = "\u81ea\u5b9a\u4e49\u80cc\u666f\u8272";
  color.setAttribute("aria-label", "\u81ea\u5b9a\u4e49\u80cc\u666f\u8272");
  color.addEventListener("input", () => {
    setSettingValue(SETTINGS.menuBackgroundColor, color.value);
    applyQuickPanelBackground(row.closest("#gg-link-style-panel"), color.value);
  });

  row.append(label, presets, color);
  return row;
}

function createPanelBackgroundOpacityRow() {
  const opacity = panelBackgroundOpacity();
  const input = document.createElement("input");
  input.type = "range";
  input.className = "gg-link-style-bg-opacity-input";
  input.min = "35";
  input.max = "100";
  input.step = "1";
  input.value = String(Math.round(opacity * 100));

  const valueEl = document.createElement("span");
  valueEl.className = "gg-link-style-value gg-link-style-bg-opacity-value";
  valueEl.textContent = `${Math.round(opacity * 100)}%`;

  input.addEventListener("input", () => {
    const nextOpacity = Number(input.value) / 100;
    valueEl.textContent = `${input.value}%`;
    setSettingValue(SETTINGS.menuBackgroundOpacity, nextOpacity);
    applyQuickPanelBackground(input.closest("#gg-link-style-panel"), null, nextOpacity);
  });

  return createControlRow("\u4e0d\u900f\u660e\u5ea6", input, valueEl);
}

function buildQuickPanel() {
  const panel = document.createElement("div");
  panel.id = "gg-link-style-panel";

  const head = document.createElement("div");
  head.className = "gg-link-style-panel-head";

  const title = document.createElement("div");
  title.className = "gg-link-style-panel-title";
  title.textContent = "连接线";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "gg-link-style-close";
  close.title = "关闭";
  close.setAttribute("aria-label", "关闭");
  close.innerHTML = ggIcon("close", 16);
  close.addEventListener("click", hideQuickPanel);

  head.append(title, close);

  const styleSelect = createSelect("样式", SETTINGS.dashStyle, ALL_DASH_STYLES, DASH_SOLID);
  const textureRow = createTextureRow();

  const styleSelectEl = styleSelect.querySelector("select");
  const toggleTextureVisibility = () => {
    if (textureRow) textureRow.style.display = styleSelectEl?.value === DASH_TEXTURE ? "" : "none";
  };
  styleSelectEl?.addEventListener("change", toggleTextureVisibility);
  requestAnimationFrame(toggleTextureVisibility);

  panel.append(
    head,
    createPanelBackgroundRow(),
    createPanelBackgroundOpacityRow(),
    createToggle("启用", SETTINGS.enabled, false),
    createSelect("范围", SETTINGS.displayMode, [DISPLAY_ALL, DISPLAY_SELECTED, DISPLAY_HOVER], DISPLAY_ALL),
    createSelect("路径", SETTINGS.pathStyle, [PATH_CURVE, PATH_DIRECT, PATH_ORTHOGONAL, PATH_CIRCUIT], PATH_CURVE),
    styleSelect,
    textureRow,
    createColorRow(),
    createRange("线宽", SETTINGS.lineWidth, 2.5, 0.5, 8, 0.5, (value) => value.toFixed(1)),
    createRange("透明", SETTINGS.opacity, 0.75, 0.05, 1, 0.05, (value) => `${Math.round(value * 100)}%`),
    createRange("速度", SETTINGS.speed, 1.5, 0.2, 6, 0.2, (value) => value.toFixed(1)),
    createToggle("发光", SETTINGS.glow, false),
  );

  applyQuickPanelBackground(panel);

  return panel;
}

function createTextureRow() {
  const row = document.createElement("div");
  row.className = "gg-link-style-row gg-link-style-texture-row";
  row.style.display = "none";

  const label = document.createElement("span");
  label.className = "gg-link-style-label";
  label.textContent = "贴图";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.style.display = "none";

  const uploadBtn = document.createElement("button");
  uploadBtn.type = "button";
  uploadBtn.className = "gg-link-style-upload-btn";
  uploadBtn.textContent = "选择图片";
  uploadBtn.title = "选择贴图图片（PNG/SVG 推荐透明背景）";

  const previewBox = document.createElement("div");
  previewBox.className = "gg-link-style-texture-preview";
  previewBox.title = "当前贴图预览";

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "gg-link-style-clear-btn";
  clearBtn.title = "清除贴图";
  clearBtn.innerHTML = ggIcon("clear", 14);

  const currentUrl = setting(SETTINGS.textureDataUrl, "");
  if (currentUrl) {
    loadTextureImage(currentUrl);
    previewBox.style.backgroundImage = `url(${currentUrl})`;
    previewBox.classList.add("has-image");
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      setSettingValue(SETTINGS.textureDataUrl, dataUrl);
      loadTextureImage(dataUrl);
      previewBox.style.backgroundImage = `url(${dataUrl})`;
      previewBox.classList.add("has-image");
    };
    reader.readAsDataURL(file);
  });

  uploadBtn.addEventListener("click", () => fileInput.click());

  clearBtn.addEventListener("click", () => {
    setSettingValue(SETTINGS.textureDataUrl, "");
    cachedTextureImage = null;
    previewBox.style.backgroundImage = "";
    previewBox.classList.remove("has-image");
    fileInput.value = "";
    markDirty();
  });

  row.append(label, uploadBtn, previewBox, clearBtn);
  return row;
}

function positionQuickPanel() {
  if (!quickPanel || !topControls?.settingsButton) return;
  const rect = topControls.settingsButton.getBoundingClientRect();
  const top = rect.bottom + 8;
  const left = Math.min(
    window.innerWidth - quickPanel.offsetWidth - 8,
    Math.max(8, rect.right - quickPanel.offsetWidth),
  );
  quickPanel.style.top = `${Math.max(8, top)}px`;
  quickPanel.style.left = `${left}px`;
}

function showQuickPanel() {
  hideQuickPanel();
  quickPanel = buildQuickPanel();
  document.body.appendChild(quickPanel);
  positionQuickPanel();

  const onPointerDown = (event) => {
    if (quickPanel?.contains(event.target) || topControls?.groupEl?.contains(event.target)) return;
    hideQuickPanel();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") hideQuickPanel();
  };
  const onResize = () => positionQuickPanel();

  requestAnimationFrame(() => {
    if (!quickPanel) return;
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
  });

  quickPanelCleanup = () => {
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", onResize);
  };
}

function hideQuickPanel() {
  quickPanelCleanup?.();
  quickPanelCleanup = null;
  quickPanel?.remove();
  quickPanel = null;
}

function toggleQuickPanel() {
  if (quickPanel) hideQuickPanel();
  else showQuickPanel();
}

function syncTopControls() {
  if (!topControls) return;
  const enabled = config().enabled;
  topControls.toggleButton.classList.toggle("active", enabled);
  topControls.toggleButton.title = enabled ? "关闭连接线自定义" : "开启连接线自定义";
  topControls.toggleButton.setAttribute("aria-label", topControls.toggleButton.title);
}

function installLinkStyleTopControlsStyles() {
  if (document.getElementById("gg-link-style-top-controls-style")) return;

  const style = document.createElement("style");
  style.id = "gg-link-style-top-controls-style";
  style.textContent = `
    #gg-link-style-buttons {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      height: 34px;
      flex: 0 0 auto;
    }
    #gg-link-style-buttons.gg-link-menu-host,
    #gg-link-style-buttons.gg-link-legacy-host {
      position: static;
      margin-inline: 2px;
      z-index: auto;
    }
    #gg-link-style-buttons.gg-link-floating-host {
      position: fixed;
      top: 18px;
      right: clamp(204px, calc(25vw + 86px), 576px);
      z-index: 99999;
    }
    #gg-link-style-buttons.gg-link-hidden {
      display: none !important;
    }
    #gg-link-style-buttons .gg-link-style-btn {
      width: 34px;
      height: 34px;
      min-width: 34px;
      max-width: 34px;
      padding: 0 !important;
      margin: 0 !important;
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, 0.28) !important;
      background: rgba(148, 163, 184, 0.10) !important;
      color: var(--gg-ui-muted, #64748b) !important;
      box-shadow: none !important;
      appearance: none;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      box-sizing: border-box;
      line-height: 0 !important;
      cursor: pointer;
      overflow: hidden;
      transition: transform 0.16s ease, background 0.16s ease, border-color 0.16s ease, color 0.16s ease, opacity 0.16s ease;
    }
    #gg-link-style-buttons .gg-link-style-btn:hover,
    #gg-link-style-buttons .gg-link-style-btn:focus-visible {
      background: rgba(148, 163, 184, 0.18) !important;
      transform: scale(1.06);
    }
    #gg-link-style-buttons .gg-link-style-btn.active {
      color: var(--gg-ui-accent) !important;
      background: rgba(59, 130, 246, 0.17) !important;
      border-color: var(--gg-ui-accent-border) !important;
      transform: scale(1.06);
    }
    #gg-link-style-buttons .gg-link-style-btn.active:hover {
      background: rgba(59, 130, 246, 0.26) !important;
    }
    #gg-link-style-buttons .gg-link-style-btn .gg-ui-icon {
      width: 18px;
      height: 18px;
      margin: 0;
      flex: 0 0 auto;
      pointer-events: none;
    }
    #gg-link-style-panel {
      position: fixed;
      z-index: 100000;
      width: min(300px, calc(100vw - 16px));
      padding: 10px;
      border: 1px solid color-mix(in srgb, var(--gg-ui-border) 88%, var(--gg-ui-ink));
      border-radius: var(--gg-ui-radius-lg);
      background: linear-gradient(180deg, var(--gg-link-panel-bg-strong, var(--gg-ui-surface)) 0%, var(--gg-link-panel-bg, var(--gg-ui-surface)) 100%);
      color: var(--gg-ui-ink);
      box-shadow: var(--gg-ui-shadow);
      backdrop-filter: blur(12px);
      font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-sizing: border-box;
    }
    #gg-link-style-panel .gg-link-style-panel-head,
    #gg-link-style-panel .gg-link-style-row {
      display: grid;
      grid-template-columns: 64px minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
    }
    #gg-link-style-panel .gg-link-style-panel-head {
      grid-template-columns: minmax(0, 1fr) auto;
      padding: 2px 2px 8px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.2);
      margin-bottom: 8px;
    }
    #gg-link-style-panel .gg-link-style-panel-title {
      font-weight: 650;
      color: var(--gg-ui-ink);
    }
    #gg-link-style-panel .gg-link-style-row {
      min-height: 32px;
      padding: 7px 8px;
      margin: 6px 0;
      border: 1px solid color-mix(in srgb, var(--gg-ui-border) 82%, transparent);
      border-radius: var(--gg-ui-radius);
      background: color-mix(in srgb, var(--gg-link-panel-bg-soft, var(--gg-ui-surface-soft)) 74%, transparent);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28), 0 1px 1px rgba(15, 23, 42, 0.04);
      transition: background-color 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
    }
    #gg-link-style-panel .gg-link-style-row:hover {
      border-color: color-mix(in srgb, var(--gg-ui-accent-border) 72%, var(--gg-ui-border));
      background: color-mix(in srgb, var(--gg-ui-accent) 7%, var(--gg-link-panel-bg-soft, var(--gg-ui-surface-soft)));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.36), 0 2px 6px rgba(15, 23, 42, 0.08);
    }
    #gg-link-style-panel .gg-link-style-row:last-of-type {
      margin-bottom: 0;
    }
    #gg-link-style-panel .gg-link-style-label,
    #gg-link-style-panel .gg-link-style-value {
      color: var(--gg-ui-muted);
      white-space: nowrap;
    }
    #gg-link-style-panel select,
    #gg-link-style-panel input[type="range"],
    #gg-link-style-panel input[type="color"] {
      width: 100%;
      min-width: 0;
      accent-color: var(--gg-ui-accent);
    }
    #gg-link-style-panel select {
      height: 28px;
      border: 1px solid color-mix(in srgb, var(--gg-ui-border) 88%, var(--gg-ui-ink));
      border-radius: var(--gg-ui-radius);
      background: var(--gg-ui-surface-soft);
      color: var(--gg-ui-ink);
      padding: 0 24px 0 8px;
      box-sizing: border-box;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 7px center;
      background-size: 10px;
      cursor: pointer;
      transition: border-color 0.12s ease, box-shadow 0.12s ease;
    }
    #gg-link-style-panel select:hover {
      border-color: var(--gg-ui-accent-border);
    }
    #gg-link-style-panel input[type="checkbox"] {
      width: 16px;
      height: 16px;
      justify-self: start;
      accent-color: var(--gg-ui-accent);
    }
    #gg-link-style-panel input[type="color"] {
      width: 34px;
      height: 28px;
      padding: 0;
      border: 1px solid color-mix(in srgb, var(--gg-ui-border) 88%, var(--gg-ui-ink));
      border-radius: var(--gg-ui-radius);
      background: transparent;
    }
    #gg-link-style-panel .gg-link-style-bg-row {
      grid-template-columns: 64px minmax(0, 1fr) 34px !important;
    }
    #gg-link-style-panel .gg-link-style-bg-presets {
      display: grid;
      grid-template-columns: repeat(5, 20px);
      grid-auto-rows: 20px;
      gap: 5px;
      align-items: center;
    }
    #gg-link-style-panel .gg-link-style-bg-swatch {
      width: 20px;
      height: 20px;
      padding: 0;
      border: 1px solid rgba(71, 85, 105, 0.2);
      border-radius: 6px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.54), 0 1px 2px rgba(15, 23, 42, 0.08);
      cursor: pointer;
      box-sizing: border-box;
      transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
    }
    #gg-link-style-panel .gg-link-style-bg-swatch:hover,
    #gg-link-style-panel .gg-link-style-bg-swatch.active {
      border-color: var(--gg-ui-accent);
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.64);
      transform: translateY(-1px);
    }
    #gg-link-style-panel .gg-link-style-close {
      width: 28px;
      height: 28px;
      border: 1px solid var(--gg-ui-border);
      border-radius: var(--gg-ui-radius);
      background: var(--gg-ui-surface-soft);
      color: var(--gg-ui-muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    #gg-link-style-panel .gg-link-style-texture-row {
      grid-template-columns: 64px auto 36px 28px !important;
    }
    #gg-link-style-panel .gg-link-style-upload-btn {
      height: 26px;
      padding: 0 10px;
      font-size: 11.5px;
      border: 1px solid var(--gg-ui-accent-border);
      border-radius: var(--gg-ui-radius);
      background: var(--gg-ui-soft);
      color: var(--gg-ui-accent);
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s, border-color 0.15s;
    }
    #gg-link-style-panel .gg-link-style-upload-btn:hover {
      background: rgba(99,102,241,0.12);
      border-color: var(--gg-ui-accent);
    }
    #gg-link-style-panel .gg-link-style-texture-preview {
      width: 36px;
      height: 26px;
      border: 1px dashed color-mix(in srgb, var(--gg-ui-border) 68%, var(--gg-ui-ink));
      border-radius: 4px;
      background-size: contain;
      background-repeat: no-repeat;
      background-position: center;
      background-color: transparent;
      transition: border-color 0.15s;
    }
    #gg-link-style-panel .gg-link-style-texture-preview.has-image {
      border-style: solid;
      border-color: rgba(148,163,184,0.3);
    }
    #gg-link-style-panel .gg-link-style-clear-btn {
      width: 28px;
      height: 26px;
      border: 1px solid var(--gg-ui-border);
      border-radius: var(--gg-ui-radius);
      background: var(--gg-ui-surface-soft);
      color: var(--gg-ui-muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: color 0.15s, background 0.15s;
    }
    #gg-link-style-panel .gg-link-style-clear-btn:hover {
      color: #ef4444;
      background: rgba(239,68,68,0.08);
      border-color: rgba(239,68,68,0.3);
    }
    #gg-link-style-panel select:focus-visible,
    #gg-link-style-panel input:focus-visible,
    #gg-link-style-panel button:focus-visible {
      outline: 2px solid var(--gg-ui-focus);
      outline-offset: 2px;
    }
  `;
  document.head.appendChild(style);
}

async function setupTopControls() {
  if (topControls) return;

  let ComfyButtonGroup;
  try {
    ({ ComfyButtonGroup } = await import("../../scripts/ui/components/buttonGroup.js"));
  } catch (error) {
    console.warn("[GuliNodes] Comfy button group unavailable, using link style fallback host.", error);
  }

  installLinkStyleTopControlsStyles();

  const toggleButton = createTopButton("开启连接线自定义", "linkFlow", () => {
    setSettingValue(SETTINGS.enabled, !config().enabled);
  });
  const settingsButton = createTopButton("连接线快速设置", "linkTune", toggleQuickPanel);
  const groupEl = ComfyButtonGroup ? new ComfyButtonGroup().element : document.createElement("div");
  groupEl.id = "gg-link-style-buttons";
  groupEl.classList.add("gg-link-style-host");
  groupEl.append(toggleButton, settingsButton);

  topControls = { groupEl, toggleButton, settingsButton };

  const syncToolbarSpacing = () => {
    const topSwitch = document.getElementById("gg-toolbar-top-switch");
    topSwitch?.classList.toggle("gg-toolbar-after-link-style", groupEl.nextElementSibling === topSwitch);
  };

  const placeGroup = () => {
    if (window.__ggMountTopGroup?.(groupEl)) return true;
    groupEl.classList.remove("gg-link-menu-host", "gg-link-legacy-host", "gg-link-floating-host");

    const settingsGroup = app.menu?.settingsGroup?.element;
    if (settingsGroup?.parentElement) {
      settingsGroup.before(groupEl);
      groupEl.classList.add("gg-link-menu-host");
      syncToolbarSpacing();
      return true;
    }

    const memoryButtons = document.getElementById("gg-memory-cleanup-buttons");
    if (memoryButtons?.parentElement && !memoryButtons.classList.contains("gg-memory-floating-host")) {
      memoryButtons.insertAdjacentElement("afterend", groupEl);
      groupEl.classList.add("gg-link-legacy-host");
      syncToolbarSpacing();
      return true;
    }

    const queueButton = document.getElementById("queue-button");
    if (queueButton?.parentElement) {
      queueButton.insertAdjacentElement("afterend", groupEl);
      groupEl.classList.add("gg-link-legacy-host");
      syncToolbarSpacing();
      return true;
    }

    if (groupEl.parentElement !== document.body) {
      document.body.appendChild(groupEl);
    }
    groupEl.classList.add("gg-link-floating-host");
    syncToolbarSpacing();
    return false;
  };

  const applyVisibility = (enabled) => {
    const isEnabled = enabled !== false;
    placeGroup();
    groupEl.classList.toggle("gg-link-hidden", !isEnabled);
    groupEl.style.display = isEnabled ? "inline-flex" : "none";
    if (!isEnabled) hideQuickPanel();
    syncTopControls();
  };

  window.__ggApplyLinkStyleButtons = applyVisibility;

  const refreshVisibility = () => applyVisibility(setting(TOP_BUTTONS_SETTING, true));
  refreshVisibility();

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    const placed = placeGroup();
    refreshVisibility();
    if (placed || attempts >= 10) clearInterval(timer);
  }, 500);

  try {
    app.ui?.settings?.addEventListener?.(`${MENU_DISPLAY_SETTING}.change`, () => {
      requestAnimationFrame(refreshVisibility);
    });
  } catch {
    // Older ComfyUI builds may not expose this settings event.
  }
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.LinkStyle",

  async setup() {
    patchCanvasSoon();
    await setupTopControls();
    startNodeStateWatcher();
    startExecutionWatcher();
  },

  afterConfigureGraph() {
    if (!config().enabled) return;
    app.canvas?.setDirty?.(true, true);
    ensureAnimation();
  },

  settings: [
    {
      id: SETTINGS.enabled,
      category: ["GuliNodes", "连接线"],
      name: "连接线自定义",
      type: "boolean",
      defaultValue: false,
      tooltip: "启用后由 GG 完全接管连接线绘制，并替换 ComfyUI 原始连接线。",
      onChange: onStyleSettingChanged,
    },
    {
      id: SETTINGS.displayMode,
      category: ["GuliNodes", "连接线"],
      name: "显示范围",
      type: "combo",
      options: [DISPLAY_ALL, DISPLAY_SELECTED, DISPLAY_HOVER],
      defaultValue: DISPLAY_ALL,
      onChange: onStyleSettingChanged,
    },
    {
      id: SETTINGS.pathStyle,
      category: ["GuliNodes", "连接线"],
      name: "线条路径",
      type: "combo",
      options: [PATH_CURVE, PATH_DIRECT, PATH_ORTHOGONAL, PATH_CIRCUIT],
      defaultValue: PATH_CURVE,
      onChange: onStyleSettingChanged,
    },
    {
      id: SETTINGS.lineWidth,
      category: ["GuliNodes", "连接线"],
      name: "线宽",
      type: "slider",
      defaultValue: 2.5,
      attrs: { min: 0.5, max: 8, step: 0.5 },
      onChange: onStyleSettingChanged,
    },
    {
      id: SETTINGS.opacity,
      category: ["GuliNodes", "连接线"],
      name: "透明度",
      type: "slider",
      defaultValue: 0.75,
      attrs: { min: 0.05, max: 1, step: 0.05 },
      onChange: onStyleSettingChanged,
    },
    {
      id: SETTINGS.colorMode,
      category: ["GuliNodes", "连接线"],
      name: "颜色模式",
      type: "combo",
      options: [COLOR_TYPE, COLOR_CUSTOM],
      defaultValue: COLOR_TYPE,
      onChange: onStyleSettingChanged,
    },
    {
      id: SETTINGS.customColor,
      category: ["GuliNodes", "连接线"],
      name: "统一颜色",
      type: "text",
      defaultValue: "#72d6ff",
      tooltip: "颜色模式为统一颜色时生效，格式示例：#72d6ff。",
      onChange: onStyleSettingChanged,
    },
    {
      id: SETTINGS.menuBackgroundColor,
      category: ["GuliNodes", "\u8fde\u63a5\u7ebf"],
      name: "\u5feb\u901f\u8bbe\u7f6e\u80cc\u666f\u8272",
      type: "text",
      defaultValue: QUICK_PANEL_BG_DEFAULT,
      tooltip: "\u8fde\u63a5\u7ebf\u5feb\u901f\u8bbe\u7f6e\u83dc\u5355\u7684\u80cc\u666f\u8272\uff0c\u683c\u5f0f\u793a\u4f8b\uff1a#eef1ec\u3002",
      onChange: () => {
        applyQuickPanelBackground();
        onStyleSettingChanged();
      },
    },
    {
      id: SETTINGS.menuBackgroundOpacity,
      category: ["GuliNodes", "\u8fde\u63a5\u7ebf"],
      name: "\u5feb\u901f\u8bbe\u7f6e\u80cc\u666f\u4e0d\u900f\u660e\u5ea6",
      type: "slider",
      defaultValue: QUICK_PANEL_BG_OPACITY_DEFAULT,
      attrs: { min: 0.35, max: 1, step: 0.01 },
      onChange: () => {
        applyQuickPanelBackground();
        onStyleSettingChanged();
      },
    },
    {
      id: SETTINGS.dashStyle,
      category: ["GuliNodes", "连接线"],
      name: "线条样式",
      type: "combo",
      options: ALL_DASH_STYLES,
      defaultValue: DASH_SOLID,
      onChange: onStyleSettingChanged,
    },
    {
      id: SETTINGS.speed,
      category: ["GuliNodes", "连接线"],
      name: "流动速度",
      type: "slider",
      defaultValue: 1.5,
      attrs: { min: 0.2, max: 6, step: 0.2 },
      onChange: onStyleSettingChanged,
    },
    {
      id: SETTINGS.glow,
      category: ["GuliNodes", "连接线"],
      name: "发光",
      type: "boolean",
      defaultValue: false,
      onChange: onStyleSettingChanged,
    },
  ],
});
