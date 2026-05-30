import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ggIcon } from "./gg-ui-icons.js";

const PREFIX = "GuliNodes.linkStyle";
const TOP_BUTTONS_SETTING = "GuliNodes.enableLinkStyleButtons";
const MENU_DISPLAY_SETTING = "Comfy.UseNewMenu";

const SETTINGS = {
  enabled: `${PREFIX}.enabled`,
  displayMode: `${PREFIX}.displayMode`,
  pathStyle: `${PREFIX}.pathStyle`,
  lineWidth: `${PREFIX}.lineWidth`,
  opacity: `${PREFIX}.opacity`,
  colorMode: `${PREFIX}.colorMode`,
  customColor: `${PREFIX}.customColor`,
  dashStyle: `${PREFIX}.dashStyle`,
  textureDataUrl: `${PREFIX}.textureDataUrl`,
  glow: `${PREFIX}.glow`,
  speed: `${PREFIX}.speed`,
};

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
const DASH_TEXTURE = "自定义贴图";

const ALL_DASH_STYLES = [
  DASH_SOLID, DASH_FLOW, DASH_FLOW_SOLID,
  DASH_PULSE, DASH_LIGHTNING, DASH_METEOR,
  DASH_ENERGY_WAVE, DASH_LASER,
  DASH_PARTICLE, DASH_GRADIENT, DASH_TEXTURE,
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
  if (graph._links instanceof Map) return [...graph._links.values()];
  const links = graph.links ?? graph._links ?? {};
  return Array.isArray(links) ? links.filter(Boolean) : Object.values(links).filter(Boolean);
}

function linkField(link, objectKey, arrayIndex) {
  return link?.[objectKey] ?? (Array.isArray(link) ? link[arrayIndex] : undefined);
}

function nodeById(graph, id) {
  if (id == null) return null;
  return graph?.getNodeById?.(id) ?? (graph?.nodes ?? graph?._nodes ?? []).find((node) => String(node.id) === String(id));
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

    setInterval(() => { invalidateActiveCache(); }, 200);
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
  if (node?.getConnectionPos) return node.getConnectionPos(isInput, slot, out) || out;
  const x = node?.pos?.[0] ?? 0;
  const y = node?.pos?.[1] ?? 0;
  const width = node?.size?.[0] ?? 180;
  const row = 36 + Number(slot || 0) * 20;
  return [x + (isInput ? 0 : width), y + row];
}

function linkColor(canvas, link, originNode, cfg) {
  if (cfg.colorMode === COLOR_CUSTOM) return cfg.customColor;
  const originSlot = linkField(link, "origin_slot", 2) ?? 0;
  const output = originNode?.outputs?.[originSlot];
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

function drawStyledLink(ctx, from, to, color, cfg) {
  ctx.save();
  ctx.globalAlpha = cfg.opacity;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const style = cfg.dashStyle;

  if (style === DASH_PULSE) {
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
  } else if (style === DASH_TEXTURE && cachedTextureImage) {
    drawTextureLink(ctx, from, to, color, cfg);
  } else if (style === DASH_FLOW_SOLID) {
    applyDash(ctx, cfg);
    ctx.strokeStyle = color;
    ctx.lineWidth = cfg.lineWidth;
    drawPath(ctx, from, to, cfg.pathStyle);
  } else {
    applyDash(ctx, cfg);

    if (cfg.glow && style !== DASH_PULSE && style !== DASH_LIGHTNING &&
        style !== DASH_METEOR && style !== DASH_ENERGY_WAVE && style !== DASH_LASER) {
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
  return to;
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

function parseColor(hex) {
  hex = String(hex).replace("#", "");
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  return {
    r: parseInt(hex.slice(0, 2), 16) || 0,
    g: parseInt(hex.slice(2, 4), 16) || 0,
    b: parseInt(hex.slice(4, 6), 16) || 0,
  };
}

function setLineDashEmpty(ctx) { ctx.setLineDash([]); }

function drawOverlay(canvas, ctx, cfg = config()) {
  if (!cfg.enabled) return;

  const graph = canvas?.graph || app.graph;
  if (!graph) return;

  invalidateActiveCache();
  let hasAnimatedLink = false;

  for (const link of getLinks(graph)) {
    if (!shouldDraw(canvas, link, cfg)) continue;
    hasAnimatedLink = true;

    const originNode = nodeById(graph, linkField(link, "origin_id", 1));
    const targetNode = nodeById(graph, linkField(link, "target_id", 3));
    if (!originNode || !targetNode) continue;

    const originSlot = linkField(link, "origin_slot", 2) ?? 0;
    const targetSlot = linkField(link, "target_slot", 4) ?? 0;
    const from = connectionPos(originNode, false, originSlot);
    const to = connectionPos(targetNode, true, targetSlot);
    drawStyledLink(ctx, from, to, linkColor(canvas, link, originNode, cfg), cfg);
  }

  const isAnimatedStyle = [DASH_FLOW, DASH_FLOW_SOLID, DASH_PULSE,
      DASH_LIGHTNING, DASH_METEOR, DASH_ENERGY_WAVE, DASH_LASER,
      DASH_PARTICLE, DASH_GRADIENT].includes(cfg.dashStyle);
  const isTextureAnimated = cfg.dashStyle === DASH_TEXTURE && cachedTextureImage;
  const isAlwaysAnimate = cfg.displayMode !== DISPLAY_ALL && hasAnimatedLink;

  if ((isAnimatedStyle || isTextureAnimated || isAlwaysAnimate) && cfg.enabled) {
    ensureAnimation();
  }
}

function ensureAnimation() {
  if (animationFrame != null) return;
  animationFrame = requestAnimationFrame(() => {
    animationFrame = null;
    const cfg = config();
    if (!cfg.enabled) return;

    const isAnimatedStyle = [DASH_FLOW, DASH_FLOW_SOLID, DASH_PULSE,
        DASH_LIGHTNING, DASH_METEOR, DASH_ENERGY_WAVE, DASH_LASER,
        DASH_PARTICLE, DASH_GRADIENT].includes(cfg.dashStyle);
    const isTextureAnimated = cfg.dashStyle === DASH_TEXTURE && cachedTextureImage;
    const isNonAllMode = cfg.displayMode !== DISPLAY_ALL;

    if (isAnimatedStyle || isTextureAnimated || isNonAllMode) {
      markDirty();
      ensureAnimation();
    }
  });
}

function patchCanvas(canvas) {
  if (!canvas || typeof canvas.drawConnections !== "function") return false;
  if (canvas.__ggLinkStylePatched && canvas.drawConnections.__ggLinkStyleWrapper) return true;

  const originalDrawConnections = canvas.drawConnections;
  const wrappedDrawConnections = function(ctx, ...args) {
    const cfg = config();
    if (!cfg.enabled) {
      return originalDrawConnections.call(this, ctx, ...args);
    }

    try {
      drawOverlay(this, ctx, cfg);
    } catch (error) {
      console.warn("[GuliNodes] Failed to draw custom link style:", error);
    }
    return undefined;
  };
  wrappedDrawConnections.__ggLinkStyleWrapper = true;
  wrappedDrawConnections.__ggLinkStyleOriginal = originalDrawConnections;
  canvas.drawConnections = wrappedDrawConnections;

  canvas.__ggLinkStylePatched = true;
  patchedCanvas = canvas;
  return true;
}

function patchCanvasSoon() {
  let attempts = 0;
  const tick = () => {
    attempts += 1;
    if (patchCanvas(app.canvas) || attempts >= 30) return;
    setTimeout(tick, 100);
  };
  tick();
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
      border: 1px solid var(--gg-ui-accent-border) !important;
      background: var(--gg-ui-accent-soft) !important;
      color: var(--gg-ui-accent) !important;
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
    #gg-link-style-buttons .gg-link-style-btn:focus-visible,
    #gg-link-style-buttons .gg-link-style-btn.active {
      color: var(--gg-ui-accent) !important;
      background: rgba(59, 130, 246, 0.17) !important;
      border-color: var(--gg-ui-accent-border) !important;
      transform: scale(1.08);
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
      background: var(--gg-ui-surface);
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
      background: color-mix(in srgb, var(--gg-ui-surface-soft) 74%, transparent);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28), 0 1px 1px rgba(15, 23, 42, 0.04);
      transition: background-color 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
    }
    #gg-link-style-panel .gg-link-style-row:hover {
      border-color: color-mix(in srgb, var(--gg-ui-accent-border) 72%, var(--gg-ui-border));
      background: color-mix(in srgb, var(--gg-ui-accent) 7%, var(--gg-ui-surface-soft));
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
      padding: 0 8px;
      box-sizing: border-box;
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
