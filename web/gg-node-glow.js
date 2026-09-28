import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ggIcon } from "./gg-ui-icons.js";

const PREFIX = "GuliNodes.nodeGlow";
const SETTINGS = {
  enabled: `${PREFIX}.enabled`,
  mode: `${PREFIX}.mode`,
  intensity: `${PREFIX}.intensity`,
  effectPool: `${PREFIX}.effectPool`,
  colorTheme: `${PREFIX}.colorTheme`,
};

const MODE_SMART = "智能";
const MODE_CUSTOM = "自定义";
const MODE_RANDOM = "随机";
const MODES = [MODE_SMART, MODE_CUSTOM, MODE_RANDOM];
const INTENSITIES = ["低", "标准", "梦幻", "沉浸"];
const INTENSITY_SCALES = {
  "低": 0.5,
  "标准": 1,
  "梦幻": 1.7,
  "沉浸": 2.35,
};

const EFFECTS = [
  "stardust",
  "rainbow",
  "musicNote",
  "cosmicDust",
  "heart",
];
const DEFAULT_EFFECT_POOL = ["stardust", "cosmicDust", "rainbow"];
const EFFECT_LABELS = {
  stardust: "星尘",
  rainbow: "彩虹",
  musicNote: "音符",
  cosmicDust: "宇宙尘埃",
  heart: "爱心",
};
const EFFECT_KEYWORDS = {
  stardust: ["text", "clip", "prompt", "encode", "文本", "提示词"],
  rainbow: ["image", "图像", "preview", "compare", "对比"],
  musicNote: ["math", "seed", "integer", "数学", "种子", "整数"],
  cosmicDust: ["model", "vae", "latent", "模型", "潜空间"],
  heart: ["save", "output", "保存", "输出"],
};

const NODE_DRAW_PATCH_FLAG = Symbol.for("GuliNodes.nodeGlow.nodeDrawPatched");
const RECENT_EXECUTION_TTL = 1100;

// The reference implementation keeps its effect inside a band this wide around
// the card and clamps every particle target to that band, so 76px is its real
// outward reach. Adopting the same number keeps the diffusion range familiar.
const EFFECT_BLEED = 76;
// Intensity tops out here: "沉浸" would otherwise double the particle budget
// and push the diffusion far past the neighbouring nodes.
const MAX_INTENSITY_FACTOR = 1.45;

// Per-effect particle ceiling, taken from the reference's table.
const PARTICLE_LIMITS = {
  stardust: 58,
  rainbow: 3,
  musicNote: 10,
  cosmicDust: 42,
  heart: 8,
};
// 全音符 / 四分音符 / 八分音符 / 十六分音符 / 双八分音符
const MUSIC_NOTE_VARIANTS = 5;
// Share of hearts that an arrow strikes before they dissolve.
const HEART_STRUCK_RATIO = 0.42;
// How many particles the very first painted frame already holds, so a freshly
// selected node is never empty for its first second.
const INITIAL_BURST = {
  stardust: 28,
  rainbow: 2,
  musicNote: 6,
  cosmicDust: 18,
  heart: 0,
};
const MAX_PARTICLES_PER_NODE = 60;
const SPAWN_INTERVAL_MS = 28;
const POOL_IDLE_TTL = 4000;

// Several modules in this plugin wrap LGraphCanvas.prototype.drawNode, and
// gg-port-list-toggle also installs its wrapper as an own property on the
// canvas instance. Both our prototype patch and our instance patch can end up
// in the same call chain for one node, which would paint the glow twice and
// double the shadow cost. This guard keeps it to exactly one paint per node.
const glowDrawingNodes = new WeakSet();

const animationState = {
  frame: null,
  executionIds: new Set(),
  recentExecutionIds: new Map(),
  randomEffects: new Map(),
  lastPoolSignature: "",
};

// The reference seeds one generator per hover session, so a card never repeats
// the same layout twice. A node stays lit for as long as it is selected, so we
// seed per node instead and bump the nonce whenever the configuration changes.
const particlePools = new Map();
let sequenceNonce = 0;

// Reading the canvas background per node per frame would be expensive, and the
// value only changes when the user switches color palette.
const THEME_CACHE_TTL = 1000;
let themeCache = { light: false, expiresAt: 0 };

let topControls = null;
let canvasHookWatchdog = null;
let glowSettingsPanel = null;
let glowSettingsButton = null;

function readSetting(id, fallback) {
  try {
    const value = app.extensionManager?.setting?.get?.(id);
    if (value !== undefined) return value;
  } catch (error) {
    console.warn("[GuliNodes] Unable to read node glow setting:", id, error);
  }
  try {
    return app.ui?.settings?.getSettingValue?.(id, fallback) ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeSetting(id, value) {
  try {
    if (app.extensionManager?.setting?.set) {
      await app.extensionManager.setting.set(id, value);
      markDirty();
      syncTopButton();
      return;
    }
  } catch (error) {
    console.warn("[GuliNodes] Unable to write node glow setting:", id, error);
  }
  try {
    app.ui?.settings?.setSettingValue?.(id, value);
  } catch (error) {
    console.warn("[GuliNodes] Unable to write UI node glow setting:", id, error);
  }
  markDirty();
  syncTopButton();
}

function normalizePool(value) {
  let values = value;
  if (typeof value === "string") {
    try {
      values = JSON.parse(value);
    } catch {
      values = value.split(",");
    }
  }
  const pool = Array.isArray(values)
    ? [...new Set(values.filter((item) => EFFECTS.includes(item)))]
    : [];
  return pool.length > 0 ? pool : [...DEFAULT_EFFECT_POOL];
}

function config() {
  const mode = readSetting(SETTINGS.mode, MODE_CUSTOM);
  const intensity = readSetting(SETTINGS.intensity, "标准");
  const pool = normalizePool(readSetting(SETTINGS.effectPool, DEFAULT_EFFECT_POOL));
  const signature = pool.join(",");
  if (signature !== animationState.lastPoolSignature) {
    animationState.lastPoolSignature = signature;
    resetGlowSequences();
  }
  return {
    enabled: readSetting(SETTINGS.enabled, false) === true,
    mode: MODES.includes(mode) ? mode : MODE_CUSTOM,
    intensity: INTENSITIES.includes(intensity) ? intensity : "标准",
    intensityScale: INTENSITY_SCALES[intensity] || 1,
    effectPool: pool,
    colorTheme: currentColorTheme(),
  };
}

function markDirty() {
  app.canvas?.setDirty?.(true, true);
  app.canvas?.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function normalizeNodeId(value) {
  if (value == null) return null;
  const id = typeof value === "object"
    ? (value.display_node ?? value.id ?? value.node ?? value.node_id)
    : value;
  return id == null ? null : String(id);
}

function rememberExecutionNode(value, ttl = RECENT_EXECUTION_TTL) {
  const id = normalizeNodeId(value);
  if (!id) return;
  animationState.executionIds.add(id);
  animationState.recentExecutionIds.set(id, performance.now() + ttl);
  markDirty();
  ensureAnimation();
}

function clearExecutionNodes(keepRecent = true) {
  if (keepRecent) {
    const expiresAt = performance.now() + RECENT_EXECUTION_TTL;
    for (const id of animationState.executionIds) animationState.recentExecutionIds.set(id, expiresAt);
  }
  animationState.executionIds.clear();
  markDirty();
  ensureAnimation();
}

function activeExecutionIds() {
  const active = new Set(animationState.executionIds);
  const now = performance.now();
  for (const [id, expiresAt] of animationState.recentExecutionIds) {
    if (expiresAt > now) active.add(id);
    else animationState.recentExecutionIds.delete(id);
  }
  return active;
}

function getGraph(canvas) {
  return canvas?.graph || app.graph;
}

function getGraphNodes(graph) {
  if (!graph) return [];
  if (Array.isArray(graph._nodes)) return graph._nodes;
  if (Array.isArray(graph.nodes)) return graph.nodes;
  return Object.values(graph._nodes_by_id || {});
}

function getSelectedIds(canvas, graph) {
  const ids = new Set();
  for (const node of Object.values(canvas?.selected_nodes || {})) {
    const id = normalizeNodeId(node);
    if (id) ids.add(id);
  }
  for (const node of graph?.selected_nodes ? Object.values(graph.selected_nodes) : []) {
    const id = normalizeNodeId(node);
    if (id) ids.add(id);
  }
  const selectedItems = canvas?.selectedItems ?? canvas?.selected_items;
  if (selectedItems instanceof Set || Array.isArray(selectedItems)) {
    for (const node of selectedItems) {
      const id = normalizeNodeId(node);
      if (id) ids.add(id);
    }
  }
  for (const node of getGraphNodes(graph)) {
    if (node?.selected) ids.add(String(node.id));
  }
  return ids;
}

function isNodeHidden(node) {
  return node.mode === 4 || globalThis.__ggGroupStylerIsNodeScaleHidden?.(node) === true;
}

// Whether any node currently warrants animation. Stops at the first hit — the
// caller only needs to know if the list is empty, so the node list is never
// materialised.
function hasActiveNodes(canvas) {
  const graph = getGraph(canvas);
  const selectedIds = getSelectedIds(canvas, graph);
  const executingIds = activeExecutionIds();
  for (const node of getGraphNodes(graph)) {
    const id = String(node?.id ?? "");
    if (!id || (!selectedIds.has(id) && !executingIds.has(id))) continue;
    if (isNodeHidden(node)) continue;
    return true;
  }
  return false;
}

function isActiveNode(canvas, node, cfg) {
  if (!cfg.enabled || !node) return false;
  const id = normalizeNodeId(node);
  if (!id) return false;
  if (!getSelectedIds(canvas, getGraph(canvas)).has(id) && !activeExecutionIds().has(id)) return false;
  return !isNodeHidden(node);
}

function stableHash(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

// Same linear congruential generator the reference uses. It is seeded from a
// string so a node's particle stream is stable while it stays lit, but the
// nonce below makes every new session draw a different sequence.
function createRandom(seed) {
  let value = stableHash(seed) || 1;
  return () => {
    value = Math.imul(value * 1664525 + 1013904223, 1) >>> 0;
    return value / 0x100000000;
  };
}

function resetGlowSequences() {
  sequenceNonce += 1;
  particlePools.clear();
  animationState.randomEffects.clear();
}

function intensityFactor(intensityScale) {
  return Math.min(MAX_INTENSITY_FACTOR, Math.max(0.2, intensityScale));
}

function particleLimit(effect, intensityScale) {
  const base = PARTICLE_LIMITS[effect] || 12;
  return Math.min(MAX_PARTICLES_PER_NODE, Math.max(1, Math.round(base * intensityFactor(intensityScale))));
}

function particleRange(intensityScale, scale) {
  return EFFECT_BLEED * intensityFactor(intensityScale) / scale;
}

function resetParticlePool(pool, geometrySignature) {
  pool.particles.length = 0;
  pool.lastSpawn = 0;
  pool.nextSpawnAt = 0;
  pool.staggered = 0;
  pool.primed = false;
  pool.geometrySignature = geometrySignature;
}

function particlePoolFor(node, effect, now, geometrySignature) {
  const key = `${node?.id ?? ""}:${effect}`;
  let pool = particlePools.get(key);
  if (!pool) {
    pool = {
      random: createRandom(`${key}:${sequenceNonce}`),
      particles: [],
      lastSpawn: 0,
      nextSpawnAt: 0,
      staggered: 0,
      primed: false,
      geometrySignature,
      touchedAt: now,
    };
    particlePools.set(key, pool);
  } else if (pool.geometrySignature !== geometrySignature) {
    // A collapsed node uses a title-only rectangle, while an expanded node uses
    // its content rectangle. Never let particles born in the old geometry keep
    // drawing after that transition; their targets can be hundreds of pixels
    // away from the newly visible node.
    resetParticlePool(pool, geometrySignature);
  }
  pool.touchedAt = now;
  return pool;
}

// Pools are keyed by node + effect, so a node whose effect changed would leave
// its old pool behind. Drop the ones nothing has painted recently.
function pruneParticlePools(now) {
  for (const [key, pool] of particlePools) {
    if (now - pool.touchedAt > POOL_IDLE_TTL) particlePools.delete(key);
  }
}

function chooseEffect(node, cfg) {
  const pool = cfg.effectPool;
  const nodeText = `${node?.type || ""} ${node?.title || ""}`.toLocaleLowerCase();
  if (cfg.mode === MODE_SMART) {
    for (const effect of pool) {
      if (EFFECT_KEYWORDS[effect]?.some((keyword) => nodeText.includes(keyword.toLocaleLowerCase()))) return effect;
    }
  }
  if (cfg.mode === MODE_RANDOM) {
    const id = String(node?.id ?? "");
    if (!animationState.randomEffects.has(id)) {
      animationState.randomEffects.set(id, pool[stableHash(`${id}:${performance.now()}`) % pool.length]);
    }
    return animationState.randomEffects.get(id) || pool[0];
  }
  return pool[stableHash(`${node?.id ?? ""}:${node?.type ?? ""}`) % pool.length];
}

function isNodeCollapsed(node) {
  return node?.flags?.collapsed === true || node?.collapsed === true;
}

function nodeTitleHeight(node) {
  const candidates = [
    node?.title_height,
    node?.constructor?.title_height,
    globalThis.LiteGraph?.NODE_TITLE_HEIGHT,
    30,
  ];
  for (const value of candidates) {
    const height = Number(value);
    if (Number.isFinite(height) && height >= 18) return height;
  }
  return 30;
}

function collapsedNodeWidth(node, fallbackWidth) {
  const candidates = [
    node?._collapsed_width,
    node?.width,
    globalThis.LiteGraph?.NODE_COLLAPSED_WIDTH,
    fallbackWidth,
  ];
  for (const value of candidates) {
    const width = Number(value);
    if (Number.isFinite(width) && width > 0) return width;
  }
  return Math.max(1, fallbackWidth);
}

function nodeBounds(node) {
  // drawNode runs inside LiteGraph's translate(node.pos) transform, so the node
  // origin is already in node-local units here. LiteGraph draws a collapsed
  // title bar above that origin (-titleHeight..0), while node.size can still
  // contain the former expanded content size in some ComfyUI builds.
  const sizeWidth = Number(node?.size?.[0] ?? node?._size?.[0] ?? 160);
  const sizeHeight = Number(node?.size?.[1] ?? node?._size?.[1] ?? 80);
  const collapsed = isNodeCollapsed(node);
  const width = Math.max(1, collapsed ? collapsedNodeWidth(node, sizeWidth) : sizeWidth);
  const titleHeight = nodeTitleHeight(node);
  const top = collapsed ? -titleHeight : 0;
  const height = Math.max(1, collapsed ? titleHeight : sizeHeight);
  const bottom = top + height;
  return {
    left: 0,
    top,
    right: width,
    bottom,
    width,
    height,
    collapsed,
    geometrySignature: `${collapsed ? "collapsed" : "expanded"}:${width}x${height}:${top}`,
  };
}

function withAlpha(color, alpha) {
  const value = String(color || "");
  const normalizedAlpha = Math.max(0, Math.min(1, Number(alpha) || 0));
  const match = value.match(/^#([0-9a-f]{6})$/i);
  if (!match) return value;
  const red = Number.parseInt(match[1].slice(0, 2), 16);
  const green = Number.parseInt(match[1].slice(2, 4), 16);
  const blue = Number.parseInt(match[1].slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${normalizedAlpha})`;
}

// ComfyUI's built-in light palette fills the canvas with the CSS named color
// "lightgray", so named colors have to resolve here rather than falling through
// to the palette-id fallback.
const NAMED_COLOR_LUMINANCE = {
  white: 1,
  whitesmoke: 0.96,
  gainsboro: 0.86,
  lightgray: 0.83,
  lightgrey: 0.83,
  silver: 0.75,
  gray: 0.5,
  grey: 0.5,
  darkgray: 0.34,
  darkgrey: 0.34,
  dimgray: 0.41,
  dimgrey: 0.41,
  black: 0,
};

function parseColorLuminance(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (text in NAMED_COLOR_LUMINANCE) return NAMED_COLOR_LUMINANCE[text];
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)?.[1];
  if (hex) {
    const full = hex.length === 3 ? hex.split("").map((channel) => channel + channel).join("") : hex;
    const [red, green, blue] = [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16));
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  }
  const rgb = text.match(/^rgba?\(([^)]+)\)$/)?.[1];
  if (!rgb) return null;
  const channels = rgb.split(/[ ,/]+/).filter(Boolean).slice(0, 3).map(Number);
  if (channels.length !== 3 || !channels.every(Number.isFinite)) return null;
  return (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255;
}

function computeLightCanvas() {
  // canvas.clear_background_color is literally the color LiteGraph fills the
  // graph with, so it is the most direct signal available. It reads
  // "transparent" whenever the user set a canvas background image, hence the
  // fallbacks below.
  const canvasLuminance = parseColorLuminance(app.canvas?.clear_background_color);
  if (canvasLuminance != null) return canvasLuminance >= 0.55;

  const paletteId = String(readSetting("Comfy.ColorPalette", "") || "").toLowerCase();
  if (paletteId) return paletteId.includes("light");

  try {
    const bodyLuminance = parseColorLuminance(getComputedStyle(document.body).backgroundColor);
    if (bodyLuminance != null) return bodyLuminance >= 0.55;
  } catch {
    // Fall through to the dark default below.
  }
  return false;
}

function isLightCanvas() {
  const now = performance.now();
  if (now < themeCache.expiresAt) return themeCache.light;
  const light = computeLightCanvas();
  themeCache = { light, expiresAt: now + THEME_CACHE_TTL };
  return light;
}

// Slot order is [accent, core, secondary]: the accent drives the halo, the
// shadow color and the mid gradient stop; the core is the main ink — the fill of
// a sparkle, the stroke of a rainbow band; the secondary lights the trailing edge.
//
// The two sets are deliberately built on different tonal levels. On a dark canvas
// light has to be *lighter* than its surroundings, so the core is near-white. On a
// light canvas nothing can be lighter than the background, so the previous set
// reached for 600/700-level shades to stay legible — and that is exactly why it
// looked like dried ink rather than light. The light set instead sits one full
// step brighter (400 for the halo, 500 for the ink), which keeps roughly 1.7-1.9
// contrast against ComfyUI's lightgray canvas while reading as translucent colour
// rather than as paint.
const DARK_PALETTES = {
  stardust: ["#c4b5fd", "#ffffff", "#67e8f9"],
  rainbow: ["#f472b6", "#facc15", "#38bdf8"],
  musicNote: ["#f472b6", "#fce7f3", "#c084fc"],
  cosmicDust: ["#818cf8", "#f5f3ff", "#67e8f9"],
  heart: ["#fb7185", "#fff1f2", "#f9a8d4"],
};

const LIGHT_PALETTES = {
  stardust: ["#a78bfa", "#8b5cf6", "#67e8f9"],
  rainbow: ["#f472b6", "#ec4899", "#60a5fa"],
  musicNote: ["#f472b6", "#ec4899", "#a78bfa"],
  cosmicDust: ["#818cf8", "#6366f1", "#06b6d4"],
  heart: ["#fb7185", "#f43f5e", "#ec4899"],
};

function paletteFor(effect) {
  const theme = currentColorTheme();
  if (theme !== COLOR_THEME_AUTO) {
    const set = COLOR_THEMES[theme];
    return isLightCanvas() ? set.light : set.dark;
  }
  const palettes = isLightCanvas() ? LIGHT_PALETTES : DARK_PALETTES;
  return palettes[effect] || palettes.stardust;
}

// 光效色彩主题：「自动」沿用每个效果各自的默认配色；其余主题把全部效果的
// 三色槽统一为该主题的色阶。每个主题都按画布明暗各备一套——暗色画布上光要
// 比背景更亮（core 接近纯白），浅色画布上则用 500-600 级的深色保持对比。
const COLOR_THEME_AUTO = "自动";
const COLOR_THEMES = {
  "自动": null,
  "梦幻紫": { dark: ["#a78bfa", "#ffffff", "#67e8f9"], light: ["#8b5cf6", "#7c3aed", "#06b6d4"] },
  "星河蓝": { dark: ["#60a5fa", "#eff6ff", "#c4b5fd"], light: ["#3b82f6", "#2563eb", "#6366f1"] },
  "樱花粉": { dark: ["#f9a8d4", "#fff1f8", "#fb7185"], light: ["#ec4899", "#db2777", "#f43f5e"] },
  "落日橙": { dark: ["#fbbf24", "#fffbeb", "#fb923c"], light: ["#f59e0b", "#d97706", "#ea580c"] },
  "翡翠绿": { dark: ["#4ade80", "#f0fdf4", "#2dd4bf"], light: ["#10b981", "#059669", "#0d9488"] },
  "冰晶青": { dark: ["#67e8f9", "#f0f9ff", "#38bdf8"], light: ["#06b6d4", "#0891b2", "#0284c7"] },
  "玫瑰红": { dark: ["#fb7185", "#fff1f2", "#f9a8d4"], light: ["#f43f5e", "#e11d48", "#ec4899"] },
  "鎏金": { dark: ["#fde68a", "#fffbeb", "#fbbf24"], light: ["#eab308", "#ca8a04", "#f59e0b"] },
};

function currentColorTheme() {
  const value = readSetting(SETTINGS.colorTheme, COLOR_THEME_AUTO);
  return Object.prototype.hasOwnProperty.call(COLOR_THEMES, value) ? value : COLOR_THEME_AUTO;
}

// 彩虹效果的色带是固定色相，套用色彩主题时改为围绕主题色相的邻近色渐变，
// 既保留“彩虹”的层次感又不跳出主题。结果按「主题 + 画布明暗」缓存。
function hexToHsl(hex) {
  const value = String(hex || "").replace("#", "").trim();
  if (value.length !== 6) return [0, 0, 100];
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const lig = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0]
    : hue < 120 ? [x, c, 0]
    : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c]
    : hue < 300 ? [x, 0, c]
    : [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

const themedRainbowCache = new Map();
function themedRainbowBands(theme) {
  const mode = isLightCanvas() ? "light" : "dark";
  const key = `${theme}:${mode}`;
  if (themedRainbowCache.has(key)) return themedRainbowCache.get(key);
  const [hue, sat, light] = hexToHsl(COLOR_THEMES[theme][mode][0]);
  const bands = [-40, -20, 0, 20, 40].map((offset) => hslToHex(
    hue + offset,
    Math.min(100, sat + 8),
    mode === "dark" ? Math.min(82, light + 2) : Math.max(46, light - 6),
  ));
  themedRainbowCache.set(key, bands);
  return bands;
}

// The rainbow bands are fixed hues rather than palette slots, so they need
// their own theme split: the light yellow/green of the dark set composites to
// roughly the same luminance as a light canvas and disappears there.
const RAINBOW_BANDS = {
  dark: ["#fb7185", "#facc15", "#4ade80", "#38bdf8", "#a78bfa"],
  light: ["#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6"],
};

function rainbowBands() {
  const theme = currentColorTheme();
  if (theme !== COLOR_THEME_AUTO) return themedRainbowBands(theme);
  return isLightCanvas() ? RAINBOW_BANDS.light : RAINBOW_BANDS.dark;
}

// Particles are spawned on one edge of the node and travel outward along that
// edge's normal, with a random lateral drift. Every property is drawn from the
// per-node generator (edge, offset along the edge, distance, life, radius,
// speed, phase), so the diffusion never repeats the same layout — the reference
// spawns the same way, and its shape table is reproduced here.
function spawnParticles(pool, effect, rect, now, scale, intensityScale) {
  const random = pool.random;
  const px = 1 / scale;
  const range = particleRange(intensityScale, scale);
  const rangeScale = intensityFactor(intensityScale);
  const limit = particleLimit(effect, intensityScale);
  const { left, right, top, bottom, width: spanX, height: spanY } = rect;
  const emit = (fromX, fromY, targetX, targetY, options = {}) => {
    if (pool.particles.length >= limit) return null;
    const particle = {
      angle: Math.atan2(targetY - fromY, targetX - fromX),
      born: options.born ?? now,
      life: options.life,
      phase: random() * Math.PI * 2,
      radius: options.radius * px,
      speed: options.speed,
      x: fromX,
      y: fromY,
      targetX,
      targetY,
    };
    if (options.extra) Object.assign(particle, options.extra);
    pool.particles.push(particle);
    return particle;
  };

  const edge = Math.floor(random() * 4);
  const distance = range * (0.25 + random() * 0.75);
  const alongX = left + random() * spanX;
  const alongY = top + random() * spanY;
  const fromX = edge === 0 ? left : edge === 1 ? right : alongX;
  const fromY = edge === 2 ? top : edge === 3 ? bottom : alongY;
  const targetX = edge === 0 ? fromX - distance : edge === 1 ? fromX + distance : fromX + (random() - 0.5) * range;
  const targetY = edge === 2 ? fromY - distance : edge === 3 ? fromY + distance : fromY + (random() - 0.5) * range;

  if (effect === "cosmicDust") {
    // Three size tiers give the field some depth: faint specks, mid motes and a
    // few larger stars that also get a flare. Colour is picked per particle so
    // the dust is not one flat hue.
    const roll = random();
    const tier = roll > 0.82 ? 2 : roll > 0.4 ? 1 : 0;
    emit(fromX, fromY, targetX, targetY, {
      life: 2500 + random() * 1600,
      radius: tier === 2 ? 2.6 + random() * 1.7 : tier === 1 ? 1.8 + random() * 1.1 : 1 + random() * 0.8,
      speed: 0.55 + random() * 0.7,
      extra: { tier, tint: Math.floor(random() * 3) },
    });
    return;
  }

  if (effect === "musicNote") {
    emit(fromX, fromY, targetX, targetY, {
      life: 1800 + random() * 1900,
      radius: 2.4 + random() * 4.6,
      speed: 0.55 + random() * 0.7,
      extra: { variant: Math.floor(random() * MUSIC_NOTE_VARIANTS) },
    });
    return;
  }

  if (effect === "heart") {
    const struck = random() < HEART_STRUCK_RATIO;
    const speed = 0.64 + random() * 0.24;
    const impactAt = 0.58;
    const extra = { struck };
    if (struck) {
      // The arrow has to be aimed at where the heart actually is when it lands,
      // so the impact point is the interpolated position rather than the final
      // target, and the approach line starts behind it from a random bearing.
      const impactTravel = 1 - Math.pow(1 - impactAt, speed);
      const impactX = fromX + (targetX - fromX) * impactTravel;
      const impactY = fromY + (targetY - fromY) * impactTravel;
      const arrowAngle = random() * Math.PI * 2;
      const arrowDistance = (78 + random() * 74) * px;
      Object.assign(extra, {
        impactAt,
        arrowAngle,
        arrowImpactX: impactX,
        arrowImpactY: impactY,
        arrowFromX: impactX - Math.cos(arrowAngle) * arrowDistance,
        arrowFromY: impactY - Math.sin(arrowAngle) * arrowDistance,
      });
    }
    emit(fromX, fromY, targetX, targetY, {
      life: struck ? 1750 + random() * 650 : 2200 + random() * 1300,
      radius: 3.8 + random() * 5.2,
      speed,
      extra,
    });
    return;
  }

  emit(fromX, fromY, targetX, targetY, {
    life: effect === "rainbow" ? 2800 + random() * 1500 : 1800 + random() * 1900,
    radius: effect === "rainbow" ? 1.6 + random() * 6.8 : 2 + random() * 4.6,
    speed: 0.55 + random() * 0.7,
  });
}

function updateParticlePool(pool, effect, rect, now, scale, intensityScale) {
  const staggered = effect === "heart";
  const limit = particleLimit(effect, intensityScale);

  if (!pool.primed) {
    pool.primed = true;
    pool.staggered = staggered ? 2 + Math.floor(pool.random() * 4) : 0;
    if (staggered) {
      pool.nextSpawnAt = now + 260 + pool.random() * 540;
    }
    const burst = Math.round((INITIAL_BURST[effect] ?? 8) * intensityFactor(intensityScale));
    for (let index = 0; index < burst; index += 1) {
      spawnParticles(pool, effect, rect, now - index * 31, scale, intensityScale);
    }
  }

  pool.particles = pool.particles.filter((particle) => now - particle.born < particle.life);

  const ready = now - pool.lastSpawn > SPAWN_INTERVAL_MS
    && now >= pool.nextSpawnAt
    && (!staggered || pool.staggered > 0)
    && pool.particles.length < limit;
  if (ready) {
    spawnParticles(pool, effect, rect, now, scale, intensityScale);
    pool.lastSpawn = now;
    if (staggered) {
      pool.staggered -= 1;
      // The reference spends its whole staggered budget in one hover session
      // because its overlay unmounts on mouse-leave. A node here can stay
      // selected for minutes, so the budget is re-armed after a longer pause —
      // hearts keep arriving in occasional small groups instead of stopping for
      // good once the first group is spent.
      pool.nextSpawnAt = pool.staggered > 0
        ? now + 300 + pool.random() * 700
        : now + 1600 + pool.random() * 2600;
      if (pool.staggered <= 0) pool.staggered = 2 + Math.floor(pool.random() * 4);
    }
  }
  return pool.particles;
}

function drawSparkle(ctx, x, y, radius) {
  // Four-point star with concave sides — the shape a lens flare actually takes,
  // rather than an eight-point polygon.
  ctx.beginPath();
  ctx.moveTo(x, y - radius);
  ctx.quadraticCurveTo(x + radius * 0.14, y - radius * 0.14, x + radius, y);
  ctx.quadraticCurveTo(x + radius * 0.14, y + radius * 0.14, x, y + radius);
  ctx.quadraticCurveTo(x - radius * 0.14, y + radius * 0.14, x - radius, y);
  ctx.quadraticCurveTo(x - radius * 0.14, y - radius * 0.14, x, y - radius);
  ctx.closePath();
}

// Staff-notation glyphs. The previous version drew a single "♪" with fillText,
// so every note was the same character rendered in the system font.
// 0 全音符 / 1 四分音符 / 2 八分音符 / 3 十六分音符 / 4 双八分音符（带符杠）
function drawMusicNote(ctx, x, y, size, variant) {
  const head = Math.max(1.2, size);
  const stem = head * 3.4;
  const headY = y + stem * 0.4;
  const stemX = (cx) => cx + head * 0.92;
  const noteHead = (cx, cy) => {
    ctx.beginPath();
    ctx.ellipse(cx, cy, head * 1.06, head * 0.78, -0.34, 0, Math.PI * 2);
    ctx.fill();
  };
  const drawStems = (...centers) => {
    ctx.lineWidth = Math.max(head * 0.19, 0.8);
    ctx.beginPath();
    for (const cx of centers) {
      ctx.moveTo(stemX(cx), headY);
      ctx.lineTo(stemX(cx), headY - stem);
    }
    ctx.stroke();
  };
  const drawFlags = (sx, count) => {
    ctx.lineWidth = Math.max(head * 0.2, 0.8);
    for (let index = 0; index < count; index += 1) {
      const top = headY - stem + index * head * 0.8;
      ctx.beginPath();
      ctx.moveTo(sx, top);
      ctx.quadraticCurveTo(sx + head * 1.4, top + head * 0.55, sx + head * 0.85, top + head * 1.6);
      ctx.stroke();
    }
  };

  if (variant === 0) {
    ctx.lineWidth = Math.max(head * 0.26, 0.9);
    ctx.beginPath();
    ctx.ellipse(x, y, head * 1.32, head * 0.96, -0.34, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  if (variant === 4) {
    const gap = head * 3.4;
    const leftX = x - gap / 2;
    const rightX = x + gap / 2;
    noteHead(leftX, headY);
    noteHead(rightX, headY);
    drawStems(leftX, rightX);
    ctx.lineWidth = Math.max(head * 0.3, 1);
    ctx.beginPath();
    ctx.moveTo(stemX(leftX), headY - stem);
    ctx.lineTo(stemX(rightX), headY - stem);
    ctx.stroke();
    return;
  }
  noteHead(x, headY);
  drawStems(x);
  if (variant === 2 || variant === 3) drawFlags(stemX(x), variant - 1);
}

// A quiver arrow. `angle` is the bearing it travels along, so the head sits at
// (x, y) and the shaft trails behind it.
function drawArrow(ctx, x, y, angle, size) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const nx = -sin;
  const ny = cos;
  const shaft = size * 3.6;
  const head = size * 1.7;
  const tailX = x - cos * shaft;
  const tailY = y - sin * shaft;
  ctx.lineWidth = Math.max(size * 0.26, 0.9);
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(x - cos * head * 0.6, y - sin * head * 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - cos * head + nx * size * 0.6, y - sin * head + ny * size * 0.6);
  ctx.lineTo(x - cos * head - nx * size * 0.6, y - sin * head - ny * size * 0.6);
  ctx.closePath();
  ctx.fill();
  const fletch = size * 0.85;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(tailX + cos * fletch + nx * fletch * 0.75, tailY + sin * fletch + ny * fletch * 0.75);
  ctx.lineTo(tailX + cos * fletch * 1.9, tailY + sin * fletch * 1.9);
  ctx.lineTo(tailX + cos * fletch - nx * fletch * 0.75, tailY + sin * fletch - ny * fletch * 0.75);
  ctx.closePath();
  ctx.fill();
}

// Pointed bottom, two full lobes, and a dip between them. The earlier path was
// shallow enough that at particle sizes it read as a rounded blob.
function drawHeartPath(ctx, x, y, size) {
  const tip = y + size;
  const shoulder = y - size * 0.08;
  ctx.beginPath();
  ctx.moveTo(x, tip);
  ctx.bezierCurveTo(x - size * 0.5, y + size * 0.36, x - size * 1.12, shoulder, x - size * 0.95, y - size * 0.42);
  ctx.bezierCurveTo(x - size * 0.84, y - size * 0.98, x - size * 0.12, y - size * 0.92, x, y - size * 0.3);
  ctx.bezierCurveTo(x + size * 0.12, y - size * 0.92, x + size * 0.84, y - size * 0.98, x + size * 0.95, y - size * 0.42);
  ctx.bezierCurveTo(x + size * 1.12, shoulder, x + size * 0.5, y + size * 0.36, x, tip);
  ctx.closePath();
}

function paintHeartBody(ctx, x, y, size, palette, alpha) {
  const gradient = ctx.createLinearGradient(x - size, y - size, x + size, y + size);
  gradient.addColorStop(0, withAlpha(palette[1], alpha));
  gradient.addColorStop(0.5, withAlpha(palette[0], alpha));
  gradient.addColorStop(1, withAlpha(palette[2], alpha));
  ctx.fillStyle = gradient;
  drawHeartPath(ctx, x, y, size);
  ctx.fill();
  // One soft highlight across the left lobe is what stops the heart reading as a
  // flat sticker.
  ctx.fillStyle = withAlpha(palette[1], alpha * 0.55);
  ctx.beginPath();
  ctx.ellipse(x - size * 0.42, y - size * 0.46, size * 0.2, size * 0.12, -0.7, 0, Math.PI * 2);
  ctx.fill();
}

function drawParticle(ctx, particle, effect, now, palette, scale) {
  const progress = (now - particle.born) / particle.life;
  if (!(progress >= 0 && progress <= 1)) return;
  const px = 1 / scale;
  // Fade in quickly and out slowly, and ease the travel towards the target —
  // the reference's motion curve, which is what makes the particles read as
  // drifting light rather than dots oscillating on a fixed ring.
  const fade = Math.min(1, progress / 0.06, (1 - progress) / 0.22);
  const travel = 1 - Math.pow(1 - progress, particle.speed);
  const drift = Math.sin(particle.phase + progress * Math.PI * 2) * 10 * px * Math.sin(progress * Math.PI);
  const x = particle.x
    + (particle.targetX - particle.x) * travel
    + Math.cos(particle.angle + Math.PI / 2) * drift;
  const y = particle.y
    + (particle.targetY - particle.y) * travel
    + Math.sin(particle.angle + Math.PI / 2) * drift;
  const radius = particle.radius;
  // Alpha is carried in the colors rather than in globalAlpha, so the painted
  // color itself is what fades and the glow never dims by two factors at once.
  const base = fade * (effect === "cosmicDust" ? 0.74 : 0.88);

  ctx.save();
  // Drawing segments inside this function leave globalAlpha at a partial value;
  // reset it so the particle is drawn at exactly the alpha its color carries.
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 10 * px;
  ctx.shadowColor = withAlpha(palette[0], base);
  ctx.fillStyle = withAlpha(palette[1], base);
  ctx.strokeStyle = withAlpha(palette[1], base);
  ctx.lineWidth = Math.max(0.9 * px, 1);

  if (effect === "stardust") {
    ctx.shadowBlur = 11 * px;
    ctx.fillStyle = withAlpha(palette[1], base);
    drawSparkle(ctx, x, y, radius * 1.8);
    ctx.fill();
  } else if (effect === "rainbow") {
    rainbowBands().forEach((color, colorIndex) => {
      ctx.strokeStyle = withAlpha(color, base * 0.8);
      ctx.lineWidth = Math.max(0.9 * px, 1);
      ctx.beginPath();
      ctx.arc(x, y, (6 + colorIndex * 2) * px, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    });
  } else if (effect === "musicNote") {
    drawMusicNote(ctx, x, y, radius, particle.variant, palette);
  } else if (effect === "cosmicDust") {
    // Twinkle plus a per-particle tint, with the blur radius standing in for the
    // halo so no gradient object is allocated per mote.
    const twinkle = 0.5 + 0.5 * Math.sin(particle.phase + progress * Math.PI * 5.2);
    const alpha = base * (0.5 + twinkle * 0.5);
    const tint = particle.tint === 0 ? palette[0] : particle.tint === 1 ? palette[1] : palette[2];
    const tier = particle.tier || 0;
    ctx.shadowBlur = (tier === 2 ? 20 : tier === 1 ? 14 : 8) * px;
    ctx.shadowColor = withAlpha(tint, alpha * 0.9);
    ctx.fillStyle = withAlpha(tint, alpha);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = withAlpha(palette[1], alpha * 0.9);
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.45, 0, Math.PI * 2);
    ctx.fill();
    if (tier === 2) {
      ctx.strokeStyle = withAlpha(tint, alpha * 0.55);
      ctx.lineWidth = Math.max(0.7 * px, 0.7);
      ctx.beginPath();
      ctx.moveTo(x - radius * 3.2, y);
      ctx.lineTo(x + radius * 3.2, y);
      ctx.moveTo(x, y - radius * 3.2);
      ctx.lineTo(x, y + radius * 3.2);
      ctx.stroke();
    }
  } else if (effect === "heart") {
    const size = radius * 1.45;
    if (!particle.struck) {
      paintHeartBody(ctx, x, y, size, palette, base);
    } else {
      const impactAt = particle.impactAt || 0.6;
      if (progress < impactAt) {
        paintHeartBody(ctx, x, y, size, palette, base);
        // The arrow only shows up for the last stretch and accelerates into the
        // heart, so it reads as a shot rather than a prop drifting alongside.
        const approach = Math.max(0, (progress - impactAt * 0.3) / (impactAt * 0.7));
        if (approach > 0) {
          const eased = approach * approach;
          const arrowX = particle.arrowFromX + (particle.arrowImpactX - particle.arrowFromX) * eased;
          const arrowY = particle.arrowFromY + (particle.arrowImpactY - particle.arrowFromY) * eased;
          ctx.shadowBlur = 8 * px;
          ctx.shadowColor = withAlpha(palette[2], base * 0.8);
          ctx.strokeStyle = withAlpha(palette[2], base);
          ctx.fillStyle = withAlpha(palette[2], base);
          drawArrow(ctx, arrowX, arrowY, particle.arrowAngle, size * 0.42);
        }
      } else {
        const after = Math.min(1, (progress - impactAt) / Math.max(0.08, 1 - impactAt));
        const impactX = particle.arrowImpactX;
        const impactY = particle.arrowImpactY;
        const flash = Math.max(0, 1 - after / 0.34);
        if (flash > 0) {
          ctx.shadowBlur = 12 * px;
          ctx.shadowColor = withAlpha(palette[1], base * flash);
          ctx.strokeStyle = withAlpha(palette[1], base * flash);
          ctx.lineWidth = Math.max(1.2 * px, 1.2);
          ctx.beginPath();
          ctx.arc(impactX, impactY, size * (0.6 + (1 - flash) * 2.4), 0, Math.PI * 2);
          ctx.stroke();
        }
        // The heart breaks into shards that fly out and fall away.
        const shardCount = 6;
        for (let index = 0; index < shardCount; index += 1) {
          const shardSize = size * (0.42 - after * 0.3);
          if (shardSize <= 0.3) continue;
          const spread = after * size * 3.4;
          const shardAngle = particle.phase + (index / shardCount) * Math.PI * 2;
          const shardX = impactX + Math.cos(shardAngle) * spread;
          const shardY = impactY + Math.sin(shardAngle) * spread + after * after * size * 2;
          ctx.save();
          ctx.translate(shardX, shardY);
          ctx.rotate(shardAngle + after * 4);
          ctx.fillStyle = withAlpha(index % 2 === 0 ? palette[0] : palette[2], base * (1 - after));
          ctx.beginPath();
          ctx.moveTo(0, -shardSize);
          ctx.lineTo(shardSize * 0.8, shardSize * 0.7);
          ctx.lineTo(-shardSize * 0.8, shardSize * 0.7);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        // The arrow stays stuck in the burst for a moment.
        const arrowAlpha = Math.max(0, 1 - after / 0.6);
        if (arrowAlpha > 0) {
          ctx.shadowBlur = 6 * px;
          ctx.shadowColor = withAlpha(palette[2], base * arrowAlpha * 0.7);
          ctx.strokeStyle = withAlpha(palette[2], base * arrowAlpha);
          ctx.fillStyle = withAlpha(palette[2], base * arrowAlpha);
          drawArrow(ctx, impactX, impactY, particle.arrowAngle, size * 0.42);
        }
      }
    }
  }
  ctx.restore();
}

function drawNodeGlow(ctx, node, effect, now, scale, intensityScale) {
  const rect = nodeBounds(node);
  const palette = paletteFor(effect);

  // The effect is nothing but light leaving the node: particles are spawned on
  // the node edge and radiate outwards, each with its own soft bloom.
  //
  // There is deliberately no contour, band, halo or overlay of any kind. A
  // stroked ring hugging the edge — however soft — has a crisp inner edge and
  // therefore reads as a colored plate *behind* the node, i.e. as a background
  // layer rather than as light. That is exactly what the reference's
  // erase-the-interior trick exists to hide, and what we are told we do not want.
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  const pool = particlePoolFor(node, effect, now, rect.geometrySignature);
  const particles = updateParticlePool(pool, effect, rect, now, scale, intensityScale);
  for (const particle of particles) drawParticle(ctx, particle, effect, now, palette, scale);
  ctx.restore();
}

function resolveCanvas() {
  return app.canvas
    || globalThis.LGraphCanvas?.active_canvas
    || globalThis.LiteGraph?.LGraphCanvas?.active_canvas
    || null;
}

function resolveCanvasProto() {
  return globalThis.LGraphCanvas?.prototype
    ?? globalThis.LiteGraph?.LGraphCanvas?.prototype
    ?? null;
}

function patchNodeDrawTarget(target) {
  if (!target || typeof target.drawNode !== "function") return false;
  const original = target.drawNode;
  if (original[NODE_DRAW_PATCH_FLAG]) return true;
  const wrapped = function(node, ctx, ...args) {
    // Reentrant when our own prototype patch and instance patch are both in the
    // chain for the same node; the outer call already painted the glow.
    const reentrant = glowDrawingNodes.has(node);
    if (!reentrant) glowDrawingNodes.add(node);
    try {
      // Draw the node body FIRST, then the glow on top. The title bar is part
      // of what the original drawNode paints and is opaque, so if the glow
      // ran first, every particle born on the top edge (y = 0) would be
      // covered by the title bar for the first ~24 px of its travel — that
      // looked exactly like "the top diffusion is shorter than the other
      // sides". Painting after the original makes the full range visible.
      const result = original.call(this, node, ctx, ...args);
      const cfg = config();
      if (!reentrant && cfg.enabled && node && ctx) {
        try {
          if (isActiveNode(this, node, cfg)) {
            const scale = Math.max(0.05, Number(this?.ds?.scale) || 1);
            drawNodeGlow(ctx, node, chooseEffect(node, cfg), performance.now(), scale, cfg.intensityScale);
            // Painting proves there is something worth animating, so this is
            // where the loop is armed. Merely selecting a node fires no event
            // at all, so without this the glow would paint the single frame
            // that the selection redraw happens to produce and then sit still
            // until some unrelated setting changed.
            ensureAnimation();
          }
        } catch (error) {
          console.warn("[GuliNodes] Failed to draw node glow at node boundary:", error);
        }
      }
      return result;
    } finally {
      if (!reentrant) glowDrawingNodes.delete(node);
    }
  };
  wrapped[NODE_DRAW_PATCH_FLAG] = true;
  target.drawNode = wrapped;
  return true;
}

function ensureAnimation() {
  if (animationState.frame != null) return;
  animationState.frame = requestAnimationFrame(() => {
    animationState.frame = null;
    const cfg = config();
    const hasDynamic = cfg.enabled && hasActiveNodes(app.canvas);
    if (hasDynamic) {
      pruneParticlePools(performance.now());
      markDirty();
      ensureAnimation();
    } else {
      particlePools.clear();
    }
  });
}

function installNodeDrawHook() {
  const proto = resolveCanvasProto();
  let ready = patchNodeDrawTarget(proto);

  // gg-port-list-toggle installs its drawNode wrapper as an own property on the
  // canvas instance. An own property shadows the prototype method, so a
  // prototype-only patch would never be called and the glow would stay
  // invisible while the setting still reads "on". Patch the instance as well
  // whenever it shadows the prototype chain (the same guard the title node
  // uses).
  const canvas = resolveCanvas();
  if (canvas && typeof canvas.drawNode === "function" && canvas.drawNode !== proto?.drawNode) {
    ready = patchNodeDrawTarget(canvas) || ready;
  }
  return ready;
}

function installCanvasHooks() {
  // drawNode is the only hook the glow needs. It runs once per node inside that
  // node's own transform, so the effect is painted directly at the node
  // boundary and diffuses outwards from there.
  //
  // There is deliberately no frame-level pass: drawing the glow from
  // drawFrontCanvas would put it on a second layer on top of the graph, and
  // with both hooks live every node would be painted twice.
  return installNodeDrawHook();
}

function patchCanvasSoon() {
  let attempts = 0;
  const tick = () => {
    attempts += 1;
    const ready = installCanvasHooks();
    if (!ready && attempts < 80) setTimeout(tick, 150);
  };
  tick();

  if (canvasHookWatchdog == null) {
    canvasHookWatchdog = window.setInterval(installCanvasHooks, 1000);
  }
}

function startExecutionWatcher() {
  api.addEventListener("execution_start", () => {
    animationState.executionIds.clear();
    animationState.recentExecutionIds.clear();
    markDirty();
  });
  api.addEventListener("executing", ({ detail }) => {
    if (detail == null) {
      clearExecutionNodes(true);
      return;
    }
    animationState.executionIds.clear();
    rememberExecutionNode(detail);
  });
  api.addEventListener("progress", ({ detail }) => rememberExecutionNode(detail));
  api.addEventListener("executed", ({ detail }) => rememberExecutionNode(detail));
  api.addEventListener("execution_cached", ({ detail }) => {
    for (const id of detail?.nodes || []) rememberExecutionNode(id);
  });
  api.addEventListener("execution_success", () => clearExecutionNodes(true));
  api.addEventListener("execution_error", () => clearExecutionNodes(true));
}

function createTopButton(title, icon, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "comfyui-button gg-ui-top-button gg-node-glow-btn";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = ggIcon(icon, 18);
  button.addEventListener("click", action);
  return button;
}

function syncTopButton() {
  if (!topControls) return;
  const enabled = config().enabled;
  topControls.toggleButton.classList.toggle("active", enabled);
  topControls.toggleButton.title = enabled ? "关闭节点光效" : "开启节点光效";
  topControls.toggleButton.setAttribute("aria-label", topControls.toggleButton.title);
  topControls.settingsButton?.classList.toggle("active", glowSettingsPanel?.style.display === "block");
  syncGlowSettingsPanel();
}

function closeGlowSettingsPanel() {
  if (!glowSettingsPanel) return;
  glowSettingsPanel.style.display = "none";
  syncTopButton();
}

function positionGlowSettingsPanel() {
  if (!glowSettingsPanel || !glowSettingsButton) return;
  // A panel embedded in the top-tools menu must remain in normal flow. Only
  // the standalone fallback uses viewport coordinates.
  if (glowSettingsPanel.dataset.ggTopDetailPanel === "true") return;
  const rect = glowSettingsButton.getBoundingClientRect();
  const width = 292;
  const left = Math.min(window.innerWidth - width - 10, Math.max(10, rect.right - width));
  const top = Math.min(window.innerHeight - glowSettingsPanel.offsetHeight - 10, Math.max(10, rect.bottom + 8));
  glowSettingsPanel.style.left = `${left}px`;
  glowSettingsPanel.style.top = `${top}px`;
}

function syncGlowSettingsPanel() {
  if (!glowSettingsPanel) return;
  const cfg = config();
  glowSettingsPanel.querySelectorAll("button[data-glow-mode]").forEach((button) => {
    const selected = button.dataset.glowMode === cfg.mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
  glowSettingsPanel.querySelectorAll("button[data-glow-intensity]").forEach((button) => {
    const selected = button.dataset.glowIntensity === cfg.intensity;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
  glowSettingsPanel.querySelectorAll("button[data-glow-color]").forEach((chip) => {
    const selected = chip.dataset.glowColor === cfg.colorTheme;
    chip.classList.toggle("active", selected);
    chip.setAttribute("aria-pressed", selected ? "true" : "false");
  });
  glowSettingsPanel.querySelectorAll("input[data-glow-effect]").forEach((input) => {
    input.checked = cfg.effectPool.includes(input.dataset.glowEffect);
  });
}

function createGlowSettingsPanel() {
  if (glowSettingsPanel) return;
  const panel = document.createElement("div");
  panel.id = "gg-node-glow-settings-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "节点光效设置");
  panel.innerHTML = `
    <div class="gg-node-glow-settings-title">节点光效设置</div>
    <div class="gg-node-glow-settings-block">
      <div class="gg-node-glow-settings-label">效果模式</div>
      <div class="gg-node-glow-mode" role="group" aria-label="效果模式"></div>
    </div>
    <div class="gg-node-glow-settings-block">
      <div class="gg-node-glow-settings-label">效果强度</div>
      <div class="gg-node-glow-intensity" role="group" aria-label="效果强度"></div>
    </div>
    <div class="gg-node-glow-settings-block">
      <div class="gg-node-glow-settings-label">光效色彩</div>
      <div class="gg-node-glow-colors" role="group" aria-label="光效色彩"></div>
    </div>
    <div class="gg-node-glow-settings-block">
      <div class="gg-node-glow-settings-label">光效效果池</div>
      <div class="gg-node-glow-effects"></div>
    </div>
  `;
  const modeHost = panel.querySelector(".gg-node-glow-mode");
  MODES.forEach((mode) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.glowMode = mode;
    button.textContent = mode;
    button.addEventListener("click", () => {
      void writeSetting(SETTINGS.mode, mode);
      syncGlowSettingsPanel();
    });
    modeHost.appendChild(button);
  });

  const intensityHost = panel.querySelector(".gg-node-glow-intensity");
  INTENSITIES.forEach((intensity) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.glowIntensity = intensity;
    button.textContent = intensity;
    button.addEventListener("click", () => {
      void writeSetting(SETTINGS.intensity, intensity);
      syncGlowSettingsPanel();
    });
    intensityHost.appendChild(button);
  });

  const colorHost = panel.querySelector(".gg-node-glow-colors");
  Object.keys(COLOR_THEMES).forEach((label) => {
    const spec = COLOR_THEMES[label];
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "gg-node-glow-color-chip";
    chip.dataset.glowColor = label;
    chip.title = label;
    chip.setAttribute("aria-label", `光效色彩：${label}`);
    chip.setAttribute("aria-pressed", "false");
    if (spec) {
      const [accent, core, secondary] = spec.dark;
      chip.style.background = `linear-gradient(135deg, ${accent} 0%, ${core} 52%, ${secondary} 100%)`;
    } else {
      chip.style.background = "conic-gradient(from 210deg, #f472b6, #fbbf24, #4ade80, #38bdf8, #a78bfa, #f472b6)";
    }
    chip.addEventListener("click", () => {
      void writeSetting(SETTINGS.colorTheme, label);
      syncGlowSettingsPanel();
    });
    colorHost.appendChild(chip);
  });

  const effectsHost = panel.querySelector(".gg-node-glow-effects");
  EFFECTS.forEach((effect) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.glowEffect = effect;
    input.addEventListener("change", () => {
      const selected = normalizePool(readSetting(SETTINGS.effectPool, DEFAULT_EFFECT_POOL));
      let next = selected.filter((item) => item !== effect);
      if (input.checked) next = [...next, effect];
      if (next.length === 0) {
        input.checked = true;
        return;
      }
      void writeSetting(SETTINGS.effectPool, next);
      if (config().mode !== MODE_CUSTOM) void writeSetting(SETTINGS.mode, MODE_CUSTOM);
      syncGlowSettingsPanel();
    });
    label.append(input, document.createTextNode(EFFECT_LABELS[effect]));
    effectsHost.appendChild(label);
  });
  panel.addEventListener("click", (event) => event.stopPropagation());
  document.body.appendChild(panel);
  glowSettingsPanel = panel;
  syncGlowSettingsPanel();
}

function toggleGlowSettings(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  createGlowSettingsPanel();
  const opening = glowSettingsPanel.style.display !== "block";
  if (opening) {
    glowSettingsPanel.style.display = "block";
    const menuOpen = window.__ggTopToolsMenuOpen?.() === true;
    const embedded = menuOpen
      && window.__ggEmbedTopDetailPanel?.("gg-node-glow-buttons") === true;
    if (!embedded) positionGlowSettingsPanel();
    syncGlowSettingsPanel();
  } else {
    closeGlowSettingsPanel();
  }
  syncTopButton();
}

function installTopStyles() {
  if (document.getElementById("gg-node-glow-top-style")) return;
  const style = document.createElement("style");
  style.id = "gg-node-glow-top-style";
  style.textContent = `
    #gg-node-glow-buttons {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      height: 34px;
      flex: 0 0 auto;
      margin-inline: 2px;
    }
    #gg-node-glow-buttons .gg-node-glow-btn {
      width: 34px;
      height: 34px;
      min-width: 34px;
      max-width: 34px;
      padding: 0 !important;
      margin: 0 !important;
      border-radius: 8px;
      border: 1px solid rgba(148,163,184,0.28) !important;
      background: rgba(148,163,184,0.10) !important;
      color: var(--gg-ui-muted, #64748b) !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      box-sizing: border-box;
      line-height: 0 !important;
      cursor: pointer;
      transition: background-color 0.16s ease, border-color 0.16s ease, color 0.16s ease;
    }
    #gg-node-glow-buttons .gg-node-glow-btn:hover {
      background: rgba(148,163,184,0.18) !important;
    }
    #gg-node-glow-buttons .gg-node-glow-btn.active {
      border: 1px solid var(--gg-ui-accent-border) !important;
      background: rgba(59,130,246,0.17) !important;
      color: var(--gg-ui-accent) !important;
    }
    #gg-node-glow-buttons .gg-node-glow-btn.active:hover {
      background: rgba(59,130,246,0.26) !important;
    }
    #gg-node-glow-settings-panel {
      position: fixed;
      z-index: 100004;
      display: none;
      width: 292px;
      padding: 14px;
      border: 1px solid var(--gg-ui-accent-border, rgba(100,116,139,0.3));
      border-radius: 14px;
      background: color-mix(in srgb, var(--comfy-menu-bg, #fff) 94%, var(--gg-ui-accent, #3b82f6));
      color: var(--gg-ui-ink, #3f4856);
      box-shadow: 0 16px 36px rgba(15,23,42,0.2);
      backdrop-filter: blur(16px);
      box-sizing: border-box;
    }
    #gg-node-glow-settings-panel .gg-node-glow-settings-title {
      padding-bottom: 9px;
      margin-bottom: 2px;
      border-bottom: 1px solid color-mix(in srgb, var(--gg-ui-accent-border, rgba(100,116,139,0.3)) 55%, transparent);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    #gg-node-glow-settings-panel .gg-node-glow-settings-block {
      display: grid;
      gap: 7px;
      margin-top: 11px;
      font-size: 12px;
    }
    #gg-node-glow-settings-panel .gg-node-glow-settings-label {
      color: var(--gg-ui-muted, #6b7280);
      font-weight: 600;
    }
    #gg-node-glow-settings-panel button,
    #gg-node-glow-settings-panel label {
      font: inherit;
    }
    #gg-node-glow-settings-panel .gg-node-glow-mode {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    #gg-node-glow-settings-panel .gg-node-glow-intensity {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
    }
    #gg-node-glow-settings-panel .gg-node-glow-mode button,
    #gg-node-glow-settings-panel .gg-node-glow-intensity button {
      min-width: 0;
      padding: 6px 4px;
      border: 1px solid var(--gg-ui-accent-border, rgba(100,116,139,0.3));
      border-radius: 8px;
      background: color-mix(in srgb, var(--comfy-menu-bg, #fff) 70%, transparent);
      color: inherit;
      font-weight: 550;
      cursor: pointer;
      transition: background-color 0.14s ease, border-color 0.14s ease, color 0.14s ease, box-shadow 0.14s ease;
    }
    #gg-node-glow-settings-panel .gg-node-glow-mode button:hover,
    #gg-node-glow-settings-panel .gg-node-glow-intensity button:hover {
      border-color: var(--gg-ui-accent, #3b82f6);
      background: var(--gg-ui-accent-soft, rgba(59,130,246,0.13));
    }
    #gg-node-glow-settings-panel .gg-node-glow-mode button.active,
    #gg-node-glow-settings-panel .gg-node-glow-intensity button.active {
      background: var(--gg-ui-accent-soft, rgba(59,130,246,0.13));
      border-color: var(--gg-ui-accent, #3b82f6);
      color: var(--gg-ui-accent, #3b82f6);
      font-weight: 650;
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--gg-ui-accent, #3b82f6) 14%, transparent);
    }
    #gg-node-glow-settings-panel .gg-node-glow-colors {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 7px;
      justify-items: center;
    }
    #gg-node-glow-settings-panel .gg-node-glow-color-chip {
      width: 30px;
      height: 30px;
      padding: 0;
      border: 2px solid transparent;
      border-radius: 50%;
      box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.55), 0 1px 3px rgba(15, 23, 42, 0.18);
      cursor: pointer;
      box-sizing: border-box;
      transition: transform 0.14s ease, box-shadow 0.14s ease, border-color 0.14s ease;
    }
    #gg-node-glow-settings-panel .gg-node-glow-color-chip:hover {
      transform: translateY(-1px) scale(1.08);
    }
    #gg-node-glow-settings-panel .gg-node-glow-color-chip.active {
      border-color: var(--gg-ui-accent, #3b82f6);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--gg-ui-accent, #3b82f6) 22%, transparent), inset 0 1px 2px rgba(255, 255, 255, 0.55);
    }
    #gg-node-glow-settings-panel .gg-node-glow-effects {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }
    #gg-node-glow-settings-panel .gg-node-glow-effects label {
      position: relative;
      display: flex;
      align-items: center;
      min-width: 0;
      padding: 6px 9px 6px 28px;
      border: 1px solid var(--gg-ui-accent-border, rgba(100,116,139,0.3));
      border-radius: 9px;
      background: color-mix(in srgb, var(--comfy-menu-bg, #fff) 70%, transparent);
      color: inherit;
      cursor: pointer;
      user-select: none;
      transition: background-color 0.14s ease, border-color 0.14s ease, color 0.14s ease;
    }
    #gg-node-glow-settings-panel .gg-node-glow-effects label:hover {
      border-color: var(--gg-ui-accent, #3b82f6);
    }
    #gg-node-glow-settings-panel .gg-node-glow-effects label::before {
      content: "";
      position: absolute;
      left: 9px;
      top: 50%;
      translate: 0 -50%;
      width: 13px;
      height: 13px;
      border: 1.5px solid color-mix(in srgb, var(--gg-ui-muted, #6b7280) 65%, transparent);
      border-radius: 4.5px;
      background: transparent;
      box-sizing: border-box;
      transition: background-color 0.14s ease, border-color 0.14s ease;
    }
    #gg-node-glow-settings-panel .gg-node-glow-effects input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
    #gg-node-glow-settings-panel .gg-node-glow-effects label:has(input:checked) {
      border-color: var(--gg-ui-accent-border, rgba(59,130,246,0.28));
      background: var(--gg-ui-accent-soft, rgba(59,130,246,0.13));
      color: var(--gg-ui-accent, #3b82f6);
      font-weight: 600;
    }
    #gg-node-glow-settings-panel .gg-node-glow-effects label:has(input:checked)::before {
      border-color: var(--gg-ui-accent, #3b82f6);
      background-color: var(--gg-ui-accent, #3b82f6);
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m5 13 5 5 9-11'/%3E%3C/svg%3E");
      background-size: 9px;
      background-position: center;
      background-repeat: no-repeat;
    }
    #gg-node-glow-settings-panel .gg-node-glow-effects label:has(input:focus-visible) {
      outline: 2px solid var(--gg-ui-accent, #3b82f6);
      outline-offset: 2px;
    }
  `;
  document.head.appendChild(style);
}

async function setupTopControls() {
  if (topControls) return;
  installTopStyles();
  let ComfyButtonGroup;
  try {
    ({ ComfyButtonGroup } = await import("../../scripts/ui/components/buttonGroup.js"));
  } catch (error) {
    console.warn("[GuliNodes] Comfy button group unavailable for node glow.", error);
  }

  const toggleButton = createTopButton("开启节点光效", "sparkle", () => {
    void writeSetting(SETTINGS.enabled, !config().enabled);
  });
  glowSettingsButton = createTopButton("节点光效设置", "settings", toggleGlowSettings);
  const groupEl = ComfyButtonGroup ? new ComfyButtonGroup().element : document.createElement("div");
  groupEl.id = "gg-node-glow-buttons";
  groupEl.append(toggleButton, glowSettingsButton);
  topControls = { groupEl, toggleButton, settingsButton: glowSettingsButton };

  const placeGroup = () => {
    if (window.__ggMountTopGroup?.(groupEl)) return true;
    const clearFloatingPosition = () => {
      groupEl.style.position = "";
      groupEl.style.top = "";
      groupEl.style.right = "";
      groupEl.style.zIndex = "";
    };
    const settingsGroup = app.menu?.settingsGroup?.element;
    if (settingsGroup?.parentElement) {
      clearFloatingPosition();
      settingsGroup.before(groupEl);
      return true;
    }
    const linkButtons = document.getElementById("gg-link-style-buttons");
    if (linkButtons?.parentElement) {
      clearFloatingPosition();
      linkButtons.insertAdjacentElement("afterend", groupEl);
      return true;
    }
    const queueButton = document.getElementById("queue-button");
    if (queueButton?.parentElement) {
      clearFloatingPosition();
      queueButton.insertAdjacentElement("afterend", groupEl);
      return true;
    }
    if (groupEl.parentElement !== document.body) document.body.appendChild(groupEl);
    groupEl.style.position = "fixed";
    groupEl.style.top = "18px";
    groupEl.style.right = "160px";
    groupEl.style.zIndex = "99999";
    return false;
  };

  placeGroup();
  syncTopButton();
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (placeGroup() || attempts >= 12) clearInterval(timer);
    syncTopButton();
  }, 500);

  document.addEventListener("pointerdown", (event) => {
    if (!glowSettingsPanel || glowSettingsPanel.style.display !== "block") return;
    if (glowSettingsPanel.contains(event.target) || glowSettingsButton?.contains(event.target)) return;
    closeGlowSettingsPanel();
  });
  window.addEventListener("resize", () => {
    if (glowSettingsPanel?.style.display === "block") positionGlowSettingsPanel();
  });
}

function createEffectPoolSettingRow() {
  const row = document.createElement("tr");
  row.className = "gg-node-glow-effect-pool-row";
  const labelCell = document.createElement("td");
  labelCell.textContent = "光效效果池";
  labelCell.style.verticalAlign = "top";
  labelCell.style.paddingTop = "12px";
  const valueCell = document.createElement("td");
  const description = document.createElement("div");
  description.textContent = "选择节点外部光效可使用的效果，至少保留一种。";
  description.style.cssText = "font-size:11px;color:var(--descrip-text,#888);margin-bottom:7px;line-height:1.4;";
  const pool = document.createElement("div");
  pool.style.cssText = "display:flex;flex-wrap:wrap;gap:5px;max-width:430px;";
  const refresh = () => {
    const selected = normalizePool(readSetting(SETTINGS.effectPool, DEFAULT_EFFECT_POOL));
    pool.querySelectorAll("input").forEach((input) => { input.checked = selected.includes(input.value); });
  };
  for (const effect of EFFECTS) {
    const label = document.createElement("label");
    label.style.cssText = "display:inline-flex;align-items:center;gap:4px;padding:4px 7px;border:1px solid var(--border-color,#555);border-radius:5px;cursor:pointer;font-size:12px;";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = effect;
    input.addEventListener("change", () => {
      const selected = normalizePool(readSetting(SETTINGS.effectPool, DEFAULT_EFFECT_POOL));
      let next = selected.filter((item) => item !== effect);
      if (input.checked) next = [...next, effect];
      if (next.length === 0) {
        input.checked = true;
        return;
      }
      void writeSetting(SETTINGS.effectPool, next).then(refresh);
      if (config().mode !== MODE_CUSTOM) void writeSetting(SETTINGS.mode, MODE_CUSTOM);
    });
    label.append(input, document.createTextNode(EFFECT_LABELS[effect]));
    pool.append(label);
  }
  refresh();
  valueCell.append(description, pool);
  row.append(labelCell, valueCell);
  return row;
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.NodeGlow",

  async setup() {
    patchCanvasSoon();
    startExecutionWatcher();
    await setupTopControls();
  },

  settings: [
    {
      id: SETTINGS.enabled,
      category: ["GuliNodes", "节点光效"],
      name: "光效开关",
      type: "boolean",
      defaultValue: false,
      tooltip: "开启后，选中节点和当前执行节点会显示外部光效。",
      onChange: () => {
        resetGlowSequences();
        markDirty();
        syncTopButton();
        if (config().enabled) ensureAnimation();
      },
    },
    {
      id: SETTINGS.mode,
      category: ["GuliNodes", "节点光效"],
      name: "效果模式",
      type: "combo",
      options: MODES,
      defaultValue: MODE_CUSTOM,
      onChange: () => {
        resetGlowSequences();
        markDirty();
        ensureAnimation();
      },
    },
    {
      id: SETTINGS.intensity,
      category: ["GuliNodes", "节点光效"],
      name: "效果强度",
      type: "combo",
      options: INTENSITIES,
      defaultValue: "标准",
      tooltip: "调整光效的扩散范围、光晕强度和粒子数量。",
      onChange: () => {
        resetGlowSequences();
        markDirty();
        syncGlowSettingsPanel();
        ensureAnimation();
      },
    },
    {
      id: SETTINGS.colorTheme,
      category: ["GuliNodes", "节点光效"],
      name: "光效色彩",
      type: "combo",
      options: Object.keys(COLOR_THEMES),
      defaultValue: COLOR_THEME_AUTO,
      tooltip: "统一光效的整体色彩。深色与浅色画布各有一套匹配色阶；「自动」按效果各自的默认配色。彩虹效果会转为该色彩的邻近色渐变。",
      onChange: () => {
        resetGlowSequences();
        markDirty();
        syncGlowSettingsPanel();
        ensureAnimation();
      },
    },
    {
      id: SETTINGS.effectPool,
      category: ["GuliNodes", "节点光效"],
      name: "光效效果池",
      type: createEffectPoolSettingRow,
      defaultValue: DEFAULT_EFFECT_POOL,
    },
  ],
});
