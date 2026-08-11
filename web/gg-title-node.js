import { app } from "../../scripts/app.js";

const NODE_NAME = "GGTitleNode";
const NODE_TITLE = "GG 标题";
const NODE_CATEGORY = "GuliNodes/工作流/标注";
const HIDDEN_WIDGET_TYPE = "ggHiddenTitle";
const NO_TITLE_MODE = 1;
const MIN_SIZE = [40, 22];
const VERTICAL_LAYOUT_RATIO = 1.2;
const LINE_HEIGHT = 1.15;
const MAX_RENDER_FONT_SIZE = 512;
const TOOLBAR_ID = "gg-title-floating-toolbar";
const STYLE_ID = "gg-title-node-style";
const LETTER_SPACING_AMOUNT_KEY = "_gg_title_letter_spacing_amount";
const FONT_OPACITY_KEY = "_gg_title_font_opacity";
const TOOLBAR_STYLE_KEY = "ggTitleToolbarStyle";
const MIN_LETTER_SPACING = -64;
const MAX_LETTER_SPACING = 128;
const LETTER_SPACING_STEP = 3;

const ALIGN_MAP = {
  左对齐: "left",
  居中: "center",
  右对齐: "right",
};

const FIELDS = [
  {
    name: "\u6807\u9898\u6587\u672c",
    defaultValue: NODE_TITLE,
    type: "string",
    multiline: true,
  },
  {
    name: "\u5b57\u4f53\u5927\u5c0f",
    defaultValue: 32,
    type: "number",
    min: 1,
    max: 256,
    step: 1,
  },
  {
    name: "\u5b57\u4f53\u65cf",
    defaultValue: "Arial",
    type: "string",
  },
  {
    name: "\u5b57\u4f53\u989c\u8272",
    defaultValue: "#ffffff",
    type: "string",
  },
  {
    name: "\u5b57\u4f53\u7c97\u7ec6",
    defaultValue: "\u6b63\u5e38",
    type: "combo",
    values: ["\u6b63\u5e38", "\u7c97\u4f53"],
  },
  {
    name: "\u5b57\u4f53\u659c\u4f53",
    defaultValue: "\u6b63\u5e38",
    type: "combo",
    values: ["\u6b63\u5e38", "\u659c\u4f53"],
  },
  {
    name: "\u6587\u672c\u88c5\u9970",
    defaultValue: "\u65e0",
    type: "combo",
    values: ["\u65e0", "\u4e0b\u5212\u7ebf", "\u5220\u9664\u7ebf"],
  },
  {
    name: "\u5b57\u7b26\u95f4\u8ddd",
    defaultValue: "\u6b63\u5e38",
    type: "combo",
    values: ["\u6b63\u5e38", "\u52a0\u5bbd", "\u7d27\u51d1"],
  },
  {
    name: "\u6587\u672c\u5bf9\u9f50",
    defaultValue: "\u5de6\u5bf9\u9f50",
    type: "combo",
    values: ["\u5de6\u5bf9\u9f50", "\u5c45\u4e2d", "\u53f3\u5bf9\u9f50"],
  },
  {
    name: "\u80cc\u666f\u989c\u8272",
    defaultValue: "transparent",
    type: "string",
  },
  {
    name: "\u5185\u8fb9\u8ddd",
    defaultValue: 0,
    type: "number",
    min: 0,
    max: 256,
    step: 1,
  },
  {
    name: "\u5706\u89d2\u534a\u5f84",
    defaultValue: 0,
    type: "number",
    min: 0,
    max: 256,
    step: 1,
  },
  {
    name: "\u65cb\u8f6c\u89d2\u5ea6",
    defaultValue: 0,
    type: "number",
    min: -360,
    max: 360,
    step: 1,
  },
  {
    name: "\u80cc\u666f\u4e0d\u900f\u660e\u5ea6",
    defaultValue: 0,
    type: "number",
    min: 0,
    max: 100,
    step: 1,
  },
];

const FALLBACK_FONTS = [
  "Microsoft YaHei",
  "微软雅黑",
  "SimHei",
  "黑体",
  "SimSun",
  "宋体",
  "DengXian",
  "Arial",
  "Helvetica",
  "Tahoma",
  "Verdana",
  "Times New Roman",
  "Georgia",
  "Courier New",
  "monospace",
  "sans-serif",
  "serif",
];

const COLOR_PRESETS = [
  "#000000", "#262626", "#595959", "#8c8c8c", "#bfbfbf", "#ffffff",
  "#f5222d", "#fa541c", "#fa8c16", "#fadb14", "#52c41a", "#13c2c2",
  "#1677ff", "#2f54eb", "#722ed1", "#eb2f96", "#fff1f0", "#fff7e6",
  "#feffe6", "#f6ffed", "#e6fffb", "#e6f4ff", "#f9f0ff", "#fff0f6",
];

let measureContext = null;
let lastMouseDownEvent = null;
let processingMouseDown = false;
let toolbar = null;
let activeTitleNode = null;
let activeCanvas = null;
let fontLoadPromise = null;
let toolbarPositionFrame = 0;
let activeParameterPanelNode = null;
let toolbarStyleState = loadToolbarStyleState();
let pendingTitlePlacement = null;
let lastTitlePlacementArmAt = 0;

function getLiteGraph() {
  return globalThis.LiteGraph ?? {};
}

function isTitleNode(node) {
  return node?.comfyClass === NODE_NAME || node?.type === NODE_NAME;
}

function getWidget(node, name) {
  return node.widgets?.find((widget) => widget?.name === name) ?? null;
}

function getMeasureContext() {
  if (measureContext) return measureContext;
  const canvas = document.createElement("canvas");
  measureContext = canvas.getContext("2d");
  return measureContext;
}

function numberValue(value, fallback, min = -Infinity, max = Infinity) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function stringValue(value, fallback) {
  const text = String(value ?? "");
  return text ? text : fallback;
}

function hexColorValue(value, fallback = "#ffffff") {
  const color = String(value ?? "").trim();
  const short = color.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  return fallback;
}

function colorWithOpacity(color, opacityPercent) {
  const alpha = numberValue(opacityPercent, 0, 0, 100) / 100;
  if (alpha <= 0) return "transparent";
  const normalized = String(color ?? "").trim().toLowerCase();
  const fallback = `rgba(255, 255, 255, ${alpha})`;
  if (!normalized || normalized === "transparent" || normalized === "#fff0" || normalized === "#ffffff00") return fallback;

  const hex = hexColorValue(normalized, "");
  if (hex) {
    const value = Number.parseInt(hex.slice(1), 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  const rgb = normalized.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(",").map((part) => Number.parseFloat(part.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    }
  }

  return alpha >= 1 ? color : fallback;
}

function readField(node, name) {
  const widget = getWidget(node, name);
  if (widget && widget.value !== undefined && widget.value !== null) return widget.value;
  return node.properties?.[name];
}

function fieldDefault(name) {
  return FIELDS.find((field) => field.name === name)?.defaultValue;
}

function titleText(node) {
  const text = String(readField(node, "标题文本") ?? fieldDefault("标题文本")).replace(/\\n/g, "\n");
  return text.length ? text : " ";
}

function quoteFontFamily(value) {
  const family = String(value ?? "").trim();
  if (!family) return "\"Arial\"";
  if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace)$/i.test(family)) {
    return family;
  }
  if ((family.startsWith("\"") && family.endsWith("\"")) || (family.startsWith("'") && family.endsWith("'"))) {
    return family;
  }
  return `"${family.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function fontCss(family) {
  return String(family ?? "")
    .split(",")
    .map((part) => quoteFontFamily(part))
    .join(", ");
}

function fontWeightCss(value) {
  return value === "\u7c97\u4f53" ? "700" : "400";
}

function fontStyleCss(value) {
  return value === "\u659c\u4f53" ? "italic" : "normal";
}

function textDecorationCss(value) {
  if (value === "\u4e0b\u5212\u7ebf") return "underline";
  if (value === "\u5220\u9664\u7ebf") return "line-through";
  return "none";
}

function loadToolbarStyleState() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOOLBAR_STYLE_KEY) || "{}");
    return {
      backgroundColor: hexColorValue(saved.backgroundColor, "#fcfdff"),
      opacity: numberValue(saved.opacity, 97, 10, 100),
    };
  } catch {
    return { backgroundColor: "#fcfdff", opacity: 97 };
  }
}

function saveToolbarStyleState() {
  try {
    localStorage.setItem(TOOLBAR_STYLE_KEY, JSON.stringify(toolbarStyleState));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

function applyToolbarStyleState() {
  if (!toolbar?.root) return;
  toolbar.root.style.background = colorWithOpacity(toolbarStyleState.backgroundColor, toolbarStyleState.opacity);
  toolbar.root.style.borderColor = toolbarStyleState.opacity < 45 ? "rgba(148, 163, 184, 0.5)" : "rgba(216, 220, 229, 0.92)";
  toolbar.colorPreviews?.toolbar?.style.setProperty("--current-color", toolbarStyleState.backgroundColor);
  if (toolbar.toolbarColorInput && toolbar.toolbarColorInput.value.toLowerCase() !== toolbarStyleState.backgroundColor.toLowerCase()) {
    toolbar.toolbarColorInput.value = toolbarStyleState.backgroundColor;
  }
  if (toolbar.toolbarOpacityInput && Number(toolbar.toolbarOpacityInput.value) !== toolbarStyleState.opacity) {
    toolbar.toolbarOpacityInput.value = String(toolbarStyleState.opacity);
  }
  if (toolbar.toolbarOpacityValue) toolbar.toolbarOpacityValue.textContent = `${toolbarStyleState.opacity}%`;
  if (toolbar.toolbarOpacityMenuValue) toolbar.toolbarOpacityMenuValue.textContent = `${toolbarStyleState.opacity}%`;
  toolbar.root.querySelectorAll('[data-target="toolbar"]').forEach((button) => {
    button.classList.toggle("is-active", String(button.dataset.color).toLowerCase() === toolbarStyleState.backgroundColor.toLowerCase());
  });
}

function fontOpacityFromNode(node) {
  return numberValue(node?.properties?.[FONT_OPACITY_KEY], 100, 0, 100);
}

function textColorStyle(config) {
  return colorWithOpacity(config.fontColor, config.fontOpacity);
}

function defaultLetterSpacingAmount(value, size) {
  if (value === "\u52a0\u5bbd") return Math.max(1, size * 0.08);
  if (value === "\u7d27\u51d1") return -Math.max(0.5, size * 0.035);
  return 0;
}

function letterSpacingAmountFromNode(node, size) {
  const raw = Number(node?.properties?.[LETTER_SPACING_AMOUNT_KEY]);
  if (Number.isFinite(raw)) return Math.max(MIN_LETTER_SPACING, Math.min(MAX_LETTER_SPACING, raw));
  return defaultLetterSpacingAmount(stringValue(readField(node, "\u5b57\u7b26\u95f4\u8ddd"), "\u6b63\u5e38"), size);
}

function spacingModeFromAmount(amount) {
  if (amount > 0.01) return "\u52a0\u5bbd";
  if (amount < -0.01) return "\u7d27\u51d1";
  return "\u6b63\u5e38";
}

function letterSpacingValue(configOrValue, size) {
  if (typeof configOrValue === "object" && configOrValue !== null) {
    const amount = Number(configOrValue.letterSpacingAmount);
    if (Number.isFinite(amount)) return amount;
    return defaultLetterSpacingAmount(configOrValue.letterSpacing, size);
  }
  return defaultLetterSpacingAmount(configOrValue, size);
}

function fontString(size, family, weight = "\u6b63\u5e38", italic = "\u6b63\u5e38") {
  const style = fontStyleCss(italic);
  const fontWeight = fontWeightCss(weight);
  return `${style} ${fontWeight} ${Math.max(1, size)}px ${fontCss(family)}`;
}

function labelConfig(node) {
  const fontSize = numberValue(readField(node, "\u5b57\u4f53\u5927\u5c0f"), 32, 1, 256);
  const padding = numberValue(readField(node, "\u5185\u8fb9\u8ddd"), 0, 0, 256);
  const borderRadius = numberValue(readField(node, "\u5706\u89d2\u534a\u5f84"), 0, 0, 256);
  const angle = numberValue(readField(node, "\u65cb\u8f6c\u89d2\u5ea6"), 0, -360, 360);
  const alignValue = stringValue(readField(node, "\u6587\u672c\u5bf9\u9f50"), "\u5de6\u5bf9\u9f50");
  return {
    text: titleText(node),
    fontSize,
    fontFamily: stringValue(readField(node, "\u5b57\u4f53\u65cf"), "Arial"),
    fontColor: stringValue(readField(node, "\u5b57\u4f53\u989c\u8272"), "#ffffff"),
    fontOpacity: fontOpacityFromNode(node),
    fontWeight: stringValue(readField(node, "\u5b57\u4f53\u7c97\u7ec6"), "\u6b63\u5e38"),
    fontStyle: stringValue(readField(node, "\u5b57\u4f53\u659c\u4f53"), "\u6b63\u5e38"),
    textDecoration: stringValue(readField(node, "\u6587\u672c\u88c5\u9970"), "\u65e0"),
    letterSpacing: stringValue(readField(node, "\u5b57\u7b26\u95f4\u8ddd"), "\u6b63\u5e38"),
    letterSpacingAmount: letterSpacingAmountFromNode(node, fontSize),
    textAlign: ALIGN_MAP[alignValue] ?? "left",
    backgroundColor: stringValue(readField(node, "\u80cc\u666f\u989c\u8272"), "transparent"),
    backgroundOpacity: numberValue(readField(node, "\u80cc\u666f\u4e0d\u900f\u660e\u5ea6"), 0, 0, 100),
    padding,
    borderRadius,
    angle,
  };
}

function titleLines(text) {
  const lines = String(text ?? "").split("\n");
  return lines.length ? lines : [" "];
}

function textChars(text) {
  const chars = Array.from(text || " ");
  return chars.length ? chars : [" "];
}

function shouldUseVerticalLayout(width, height) {
  return height > width * VERTICAL_LAYOUT_RATIO && height > MIN_SIZE[1] * 2;
}

function measureTextLine(context, text, config, size) {
  const value = text || " ";
  const chars = Array.from(value);
  const spacing = letterSpacingValue(config, size);
  const baseWidth = context?.measureText(value).width ?? chars.length * size * 0.55;
  return Math.max(1, baseWidth + Math.max(0, chars.length - 1) * spacing);
}

function measureVerticalTextColumn(context, text, config, size) {
  const chars = textChars(text);
  const spacing = letterSpacingValue(config, size);
  const charAdvance = Math.max(size * 0.35, size + spacing);
  const maxCharWidth = Math.max(size, ...chars.map((char) => context?.measureText(char).width ?? size));
  const height = size + Math.max(0, chars.length - 1) * charAdvance;
  return { chars, width: maxCharWidth, height, charAdvance };
}

function measureTextBlock(config, size = config.fontSize, vertical = false) {
  const context = getMeasureContext();
  const lines = titleLines(config.text);
  if (context) context.font = fontString(size, config.fontFamily, config.fontWeight, config.fontStyle);

  if (vertical) {
    const columns = lines.map((line) => measureVerticalTextColumn(context, line, config, size));
    const columnWidth = Math.max(size, ...columns.map((column) => column.width));
    const columnAdvance = Math.max(columnWidth, size * LINE_HEIGHT);
    const width = columnWidth + Math.max(0, columns.length - 1) * columnAdvance;
    return {
      lines,
      columns,
      width: Math.max(1, width),
      height: Math.max(1, ...columns.map((column) => column.height)),
      lineHeight: columnAdvance,
      columnWidth,
      columnAdvance,
      charAdvance: Math.max(size * 0.35, size + letterSpacingValue(config, size)),
    };
  }

  const maxWidth = Math.max(1, ...lines.map((line) => measureTextLine(context, line, config, size)));

  return {
    lines,
    width: maxWidth,
    height: Math.max(1, size * LINE_HEIGHT * lines.length),
    lineHeight: size * LINE_HEIGHT,
  };
}

function measureTitle(node) {
  const config = labelConfig(node);
  const [width, height] = node?.size ? currentSize(node) : MIN_SIZE;
  const metrics = measureTextBlock(config, config.fontSize, shouldUseVerticalLayout(width, height));
  return [
    Math.max(MIN_SIZE[0], Math.ceil(metrics.width + config.padding * 2)),
    Math.max(MIN_SIZE[1], Math.ceil(metrics.height + config.padding * 2)),
  ];
}

function currentSize(node) {
  return [
    Math.max(MIN_SIZE[0], Number(node.size?.[0]) || MIN_SIZE[0]),
    Math.max(MIN_SIZE[1], Number(node.size?.[1]) || MIN_SIZE[1]),
  ];
}

function setNodeSize(node, size) {
  const next = [
    Math.max(MIN_SIZE[0], Math.ceil(Number(size?.[0]) || MIN_SIZE[0])),
    Math.max(MIN_SIZE[1], Math.ceil(Number(size?.[1]) || MIN_SIZE[1])),
  ];
  node.size = next;
  node.setSize?.(next);
}

function ensureNodeSize(node) {
  if (!node.size) {
    setNodeSize(node, measureTitle(node));
  } else {
    const size = currentSize(node);
    if (node.size[0] !== size[0] || node.size[1] !== size[1]) setNodeSize(node, size);
  }
  return currentSize(node);
}

function fitNodeToText(node) {
  setNodeSize(node, measureTitle(node));
  markDirty(node);
  queueToolbarPosition(node, activeCanvas);
  syncDomTitleNode(node);
}

function markDirty(node) {
  try {
    node.setDirtyCanvas?.(true, true);
  } catch {
    // Canvas can be unavailable while ComfyUI is still constructing a node.
  }
  try {
    node.graph?.setDirtyCanvas?.(true, true);
  } catch {
    // The node may not have been attached to a graph yet.
  }
  try {
    app.graph?.setDirtyCanvas?.(true, true);
  } catch {
    // Some ComfyUI builds throw when app.graph is read before initialization.
  }
}

function setNodeField(node, key, value) {
  try {
    node[key] = value;
  } catch {
    // Some modern ComfyUI node fields are read-only accessors on instances.
  }
}

function syncPropertiesFromWidgets(node) {
  node.properties ??= {};
  for (const field of FIELDS) {
    const widget = getWidget(node, field.name);
    const value = widget?.value ?? node.properties[field.name] ?? field.defaultValue;
    node.properties[field.name] = value;
    if (widget && widget.value !== value) widget.value = value;
  }
}

function syncWidgetFromProperty(node, name) {
  const widget = getWidget(node, name);
  if (!widget) return;
  widget.value = node.properties?.[name] ?? fieldDefault(name);
}

function writeField(node, name, value) {
  if (!isTitleNode(node)) return;
  node.properties ??= {};
  node.properties[name] = value;
  syncWidgetFromProperty(node, name);
  syncToolbarFromNode(node);
  syncDomTitleNode(node);
  markDirty(node);
}

function writeLetterSpacingAmount(node, amount) {
  if (!isTitleNode(node)) return;
  const next = Math.max(MIN_LETTER_SPACING, Math.min(MAX_LETTER_SPACING, Number(amount) || 0));
  node.properties ??= {};
  node.properties[LETTER_SPACING_AMOUNT_KEY] = Math.round(next * 10) / 10;
  writeField(node, "\u5b57\u7b26\u95f4\u8ddd", spacingModeFromAmount(next));
}

function writeFontOpacity(node, opacity) {
  if (!isTitleNode(node)) return;
  node.properties ??= {};
  node.properties[FONT_OPACITY_KEY] = Math.round(numberValue(opacity, 100, 0, 100));
  syncToolbarFromNode(node);
  syncDomTitleNode(node);
  markDirty(node);
}

function hideWidget(node, widget) {
  if (!widget || widget._ggTitleHidden) return;
  widget._ggTitleHidden = true;
  widget._ggTitleOriginalType = widget.type;
  widget._ggTitleOriginalComputeSize = widget.computeSize;
  const originalCallback = widget.callback;

  widget.hidden = true;
  widget.type = HIDDEN_WIDGET_TYPE;
  widget.computeSize = () => [0, -4];
  widget.callback = function (...args) {
    const result = originalCallback?.apply(this, args);
    node.properties ??= {};
    node.properties[widget.name] = widget.value;
    requestAnimationFrame(() => {
      syncToolbarFromNode(node);
      syncDomTitleNode(node);
      markDirty(node);
    });
    return result;
  };
}

function configureNode(node) {
  if (!isTitleNode(node)) return;
  setNodeField(node, "title", "");
  setNodeField(node, "title_mode", getLiteGraph().NO_TITLE ?? NO_TITLE_MODE);
  setNodeField(node, "collapsable", false);
  setNodeField(node, "resizable", true);
  setNodeField(node, "resizeable", true);
  setNodeField(node, "serialize_widgets", true);
  setNodeField(node, "isVirtualNode", true);
  node.badges = [];
  node.title_buttons = [];
  node.properties ??= {};
  node.properties["Node name for S&R"] = NODE_NAME;
  node.color = "transparent";
  node.bgcolor = "transparent";
  node.flags ??= {};
  node.flags.allow_interaction = !node.flags.pinned;
  syncPropertiesFromWidgets(node);
  for (const widget of node.widgets ?? []) hideWidget(node, widget);
  ensureNodeSize(node);
}

function drawRoundRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function backgroundStyle(config) {
  return colorWithOpacity(config.backgroundColor, config.backgroundOpacity);
}

function shouldDrawBackground(config) {
  return backgroundStyle(config) !== "transparent";
}

function drawSelectionFrame(node, ctx, canvas, width, height) {
  const selected = node.selected || canvas?.selected_nodes?.[node.id] !== undefined;
  if (!selected) return;

  ctx.save();
  ctx.strokeStyle = "rgba(109, 168, 255, 0.9)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(109, 168, 255, 0.95)";
  ctx.beginPath();
  ctx.moveTo(width - 11, height - 2.5);
  ctx.lineTo(width - 2.5, height - 11);
  ctx.moveTo(width - 7, height - 2.5);
  ctx.lineTo(width - 2.5, height - 7);
  ctx.stroke();
  ctx.restore();
}

function computeTextLayout(node) {
  const config = labelConfig(node);
  const [width, height] = ensureNodeSize(node);
  const paddingX = Math.min(config.padding, Math.max(0, width / 2 - 1));
  const paddingY = Math.min(config.padding, Math.max(0, height / 2 - 1));
  const availableWidth = Math.max(1, width - paddingX * 2);
  const availableHeight = Math.max(1, height - paddingY * 2);
  const vertical = shouldUseVerticalLayout(availableWidth, availableHeight);
  const baseMetrics = measureTextBlock(config, config.fontSize, vertical);
  const widthScale = availableWidth / Math.max(1, baseMetrics.width);
  const heightScale = availableHeight / Math.max(1, baseMetrics.height);
  const scale = Math.max(0.01, Math.min(widthScale, heightScale));
  const fontSize = Math.max(1, Math.min(MAX_RENDER_FONT_SIZE, config.fontSize * scale));
  const metrics = measureTextBlock(config, fontSize, vertical);

  if (vertical) {
    const blockWidth = metrics.width;
    const blockHeight = metrics.height;
    return {
      config,
      vertical,
      lines: metrics.lines,
      columns: metrics.columns,
      width,
      height,
      fontSize,
      lineHeight: metrics.lineHeight,
      columnWidth: metrics.columnWidth,
      columnAdvance: metrics.columnAdvance,
      charAdvance: metrics.charAdvance,
      blockWidth,
      blockHeight,
      textLeft: paddingX + Math.max(0, (availableWidth - blockWidth) / 2),
      textTop: paddingY + Math.max(0, (availableHeight - blockHeight) / 2),
      paddingX,
      paddingY,
    };
  }

  const blockHeight = metrics.lineHeight * metrics.lines.length;
  const textTop = paddingY + Math.max(0, (availableHeight - blockHeight) / 2);
  let textX = paddingX;
  let canvasAlign = "left";

  if (config.textAlign === "center") {
    textX = width / 2;
    canvasAlign = "center";
  } else if (config.textAlign === "right") {
    textX = width - paddingX;
    canvasAlign = "right";
  }

  return {
    config,
    lines: metrics.lines,
    width,
    height,
    fontSize,
    lineHeight: metrics.lineHeight,
    textTop,
    textX,
    canvasAlign,
    vertical,
    paddingX,
    paddingY,
  };
}

function drawTextLine(ctx, text, x, y, layout) {
  const line = text || " ";
  const { config } = layout;
  const spacing = letterSpacingValue(config, layout.fontSize);
  const width = measureTextLine(ctx, line, config, layout.fontSize);
  let startX = x;

  if (layout.canvasAlign === "center") startX = x - width / 2;
  if (layout.canvasAlign === "right") startX = x - width;

  ctx.textAlign = "left";
  if (Math.abs(spacing) < 0.01) {
    ctx.fillText(line, startX, y);
  } else {
    let cursor = startX;
    for (const char of Array.from(line)) {
      ctx.fillText(char, cursor, y);
      cursor += ctx.measureText(char).width + spacing;
    }
  }

  const isUnderline = config.textDecoration === "\u4e0b\u5212\u7ebf";
  const isStrike = config.textDecoration === "\u5220\u9664\u7ebf";
  if (!isUnderline && !isStrike) return;
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = textColorStyle(config);
  ctx.lineWidth = Math.max(1, layout.fontSize / 16);
  const lineY = isUnderline ? y + layout.fontSize * 0.38 : y - layout.fontSize * 0.05;
  ctx.moveTo(startX, lineY);
  ctx.lineTo(startX + width, lineY);
  ctx.stroke();
  ctx.restore();
}

function drawVerticalTextColumn(ctx, text, x, y, layout, column) {
  const chars = column?.chars ?? textChars(text);
  const { config } = layout;
  const charAdvance = column?.charAdvance ?? layout.charAdvance;

  ctx.textAlign = "center";
  for (let index = 0; index < chars.length; index += 1) {
    ctx.fillText(chars[index], x, y + layout.fontSize / 2 + charAdvance * index);
  }

  const isUnderline = config.textDecoration === "\u4e0b\u5212\u7ebf";
  const isStrike = config.textDecoration === "\u5220\u9664\u7ebf";
  if (!isUnderline && !isStrike) return;
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = textColorStyle(config);
  ctx.lineWidth = Math.max(1, layout.fontSize / 16);
  const lineX = isUnderline ? x + layout.fontSize * 0.45 : x;
  ctx.moveTo(lineX, y);
  ctx.lineTo(lineX, y + (column?.height ?? layout.blockHeight));
  ctx.stroke();
  ctx.restore();
}

function drawTitle(node, ctx, canvas) {
  configureNode(node);
  const layout = computeTextLayout(node);
  const { config, width, height } = layout;

  ctx.save();
  ctx.font = fontString(layout.fontSize, config.fontFamily, config.fontWeight, config.fontStyle);

  if (config.angle) {
    const cx = width / 2;
    const cy = height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((config.angle * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }

  if (shouldDrawBackground(config)) {
    ctx.beginPath();
    drawRoundRect(ctx, 0, 0, width, height, config.borderRadius);
    ctx.fillStyle = backgroundStyle(config);
    ctx.fill();
  }

  ctx.textBaseline = "middle";
  ctx.fillStyle = textColorStyle(config);
  if (layout.vertical) {
    for (let index = 0; index < layout.lines.length; index += 1) {
      const column = layout.columns?.[index];
      const x = layout.textLeft + layout.blockWidth - layout.columnWidth / 2 - layout.columnAdvance * index;
      const y = layout.textTop + Math.max(0, (layout.blockHeight - (column?.height ?? layout.blockHeight)) / 2);
      drawVerticalTextColumn(ctx, layout.lines[index], x, y, layout, column);
    }
  } else {
    for (let index = 0; index < layout.lines.length; index += 1) {
      const y = layout.textTop + layout.lineHeight * (index + 0.5);
      drawTextLine(ctx, layout.lines[index], layout.textX, y, layout);
    }
  }

  ctx.restore();
  drawSelectionFrame(node, ctx, canvas, width, height);
  if (activeTitleNode === node) queueToolbarPosition(node, canvas);
}

function panelHost(canvas) {
  return canvas ?? getLiteGraph().LGraphCanvas?.active_canvas ?? globalThis.LGraphCanvas?.active_canvas ?? app.canvas;
}

function setParameterPanelButtonState(node, open) {
  if (!toolbar?.panelButton) return;
  toolbar.panelButton.classList.toggle("is-active", Boolean(open && activeParameterPanelNode === node));
}

function visibleParameterPanelElement() {
  const selector = [
    ".comfy-node-panel",
    ".node-panel",
    ".p-dialog:has(.property)",
    ".p-drawer:has(.property)",
    "[class*='node'][class*='panel']",
    "[class*='Node'][class*='Panel']",
  ].join(",");
  return [...document.querySelectorAll(selector)].find((element) => {
    const rect = element.getBoundingClientRect?.();
    return rect && rect.width > 0 && rect.height > 0;
  }) ?? null;
}

function isParameterPanelVisible() {
  const active = panelHost(activeCanvas);
  for (const panel of [active?.node_panel, active?.nodePanel, app?.node_panel, app?.nodePanel]) {
    if (panel instanceof HTMLElement) {
      const rect = panel.getBoundingClientRect?.();
      if (rect && rect.width > 0 && rect.height > 0) return true;
    } else if (panel?.isOpen || panel?.visible || panel?.opened) {
      return true;
    }
  }
  return Boolean(visibleParameterPanelElement());
}

function closeNodePanel(canvas) {
  const active = panelHost(canvas);
  let closed = false;
  for (const method of ["hideNodePanel", "closeNodePanel", "closeShowNodePanel", "hideShowNodePanel"]) {
    if (typeof active?.[method] !== "function") continue;
    try {
      active[method]();
      closed = true;
    } catch {
      // Older ComfyUI variants differ here; keep trying fallbacks.
    }
  }

  for (const panel of [active?.node_panel, active?.nodePanel, app?.node_panel, app?.nodePanel]) {
    try {
      if (typeof panel?.close === "function") {
        panel.close();
        closed = true;
      } else if (panel instanceof HTMLElement) {
        panel.style.display = "none";
        closed = true;
      }
    } catch {
      // Optional panel APIs are best-effort only.
    }
  }

  activeParameterPanelNode = null;
  setParameterPanelButtonState(null, false);
  return closed;
}

function openNodePanel(node, canvas) {
  if (activeParameterPanelNode === node && isParameterPanelVisible()) {
    closeNodePanel(canvas);
    return;
  }
  const active = canvas ?? getLiteGraph().LGraphCanvas?.active_canvas ?? globalThis.LGraphCanvas?.active_canvas ?? app.canvas;
  active?.showShowNodePanel?.(node);
  active?.showNodePanel?.(node);
  activeParameterPanelNode = node;
  setParameterPanelButtonState(node, true);
}

function removeNodeFromSelection(node, canvas) {
  for (const selected of [canvas?.selected_nodes, app.canvas?.selected_nodes, node.graph?.selected_nodes, app.graph?.selected_nodes]) {
    if (!selected || typeof selected !== "object") continue;
    delete selected[node.id];
    for (const [key, value] of Object.entries(selected)) {
      if (value === node) delete selected[key];
    }
  }
  node.selected = false;
  if (canvas?.current_node === node) canvas.current_node = null;
  if (app.canvas?.current_node === node) app.canvas.current_node = null;
}

function deleteTitleNode(node, canvas) {
  if (!isTitleNode(node)) return;
  const graph = node.graph ?? app.graph;
  const hostCanvas = canvas ?? activeCanvas ?? app.canvas;

  closeNodePanel(hostCanvas);
  removeNodeFromSelection(node, hostCanvas);
  if (typeof graph?.remove === "function") {
    graph.remove(node);
  } else {
    const nodes = graph?._nodes ?? graph?.nodes;
    const index = Array.isArray(nodes) ? nodes.indexOf(node) : -1;
    if (index >= 0) nodes.splice(index, 1);
  }

  graph?.change?.();
  app.graph?.change?.();
  hostCanvas?.setDirty?.(true, true);
  hostCanvas?.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);
  graph?.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
  hideToolbar();
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${TOOLBAR_ID} {
      position: fixed;
      z-index: 100000;
      display: none;
      width: min(560px, calc(100vw - 24px));
      padding: 10px;
      border: 1px solid rgba(216, 220, 229, 0.92);
      border-radius: 12px;
      background: rgba(252, 253, 255, 0.97);
      box-shadow: 0 16px 40px rgba(15, 23, 42, 0.20);
      color: #1f2329;
      font-family: system-ui, "Microsoft YaHei", sans-serif;
      pointer-events: auto;
      backdrop-filter: blur(16px);
    }
    #${TOOLBAR_ID} textarea {
      box-sizing: border-box;
      width: 100%;
      height: 64px;
      min-height: 42px;
      resize: vertical;
      border: 1px solid #d8dce5;
      border-radius: 10px;
      padding: 8px 10px;
      outline: none;
      background: #ffffff;
      color: #1f2329;
      font: 13px/1.45 system-ui, "Microsoft YaHei", sans-serif;
    }
    #${TOOLBAR_ID} textarea:focus,
    #${TOOLBAR_ID} select:focus,
    #${TOOLBAR_ID} input:focus,
    #${TOOLBAR_ID} button:focus {
      outline: 2px solid rgba(22, 119, 255, 0.38);
      outline-offset: 1px;
    }
    #${TOOLBAR_ID} .gg-title-toolbar-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
      align-items: center;
    }
    #${TOOLBAR_ID} .gg-title-toolbar-group {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-height: 32px;
      padding: 3px;
      border: 1px solid #edf0f5;
      border-radius: 10px;
      background: #f7f8fa;
    }
    #${TOOLBAR_ID} .gg-title-toolbar-label {
      padding: 0 5px;
      color: #646a73;
      font-size: 12px;
      white-space: nowrap;
    }
    #${TOOLBAR_ID} select,
    #${TOOLBAR_ID} button,
    #${TOOLBAR_ID} input[type="number"] {
      height: 28px;
      border: 1px solid transparent;
      border-radius: 7px;
      background: #ffffff;
      color: #1f2329;
      font: 12px system-ui, "Microsoft YaHei", sans-serif;
    }
    #${TOOLBAR_ID} select {
      width: 132px;
      min-width: 0;
      padding: 0 7px;
      color-scheme: light;
    }
    #${TOOLBAR_ID} input[type="number"] {
      width: 54px;
      padding: 0 5px;
      text-align: center;
    }
    #${TOOLBAR_ID} input[type="color"] {
      width: 30px;
      height: 28px;
      border: 1px solid #d8dce5;
      border-radius: 7px;
      padding: 2px;
      background: #ffffff;
      cursor: pointer;
    }
    #${TOOLBAR_ID} .gg-title-opacity-input {
      width: 96px;
      margin: 0 2px;
      accent-color: #1677ff;
    }
    #${TOOLBAR_ID} .gg-title-opacity-value {
      width: 34px;
      color: #646a73;
      font-size: 12px;
      text-align: right;
    }
    #${TOOLBAR_ID} .gg-title-spacing-value {
      min-width: 40px;
      padding: 0 6px;
      color: #646a73;
      font-size: 12px;
      text-align: center;
      white-space: nowrap;
    }
    #${TOOLBAR_ID} button {
      min-width: 28px;
      padding: 0 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    #${TOOLBAR_ID} button:hover,
    #${TOOLBAR_ID} select:hover,
    #${TOOLBAR_ID} input:hover {
      border-color: #c7d7f7;
      background: #eef5ff;
    }
    #${TOOLBAR_ID} button.is-active {
      border-color: #8bb8ff;
      background: #dbeafe;
      color: #0958d9;
    }
    #${TOOLBAR_ID} .gg-title-color-trigger {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 76px;
      justify-content: flex-start;
    }
    #${TOOLBAR_ID} .gg-title-color-dot {
      width: 16px;
      height: 16px;
      border: 1px solid rgba(31, 35, 41, 0.18);
      border-radius: 5px;
      background: var(--current-color, #ffffff);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.55);
      flex: 0 0 auto;
    }
    #${TOOLBAR_ID} .gg-title-color-popover {
      position: absolute;
      left: 0;
      top: calc(100% + 6px);
      z-index: 1;
      display: none;
      width: 244px;
      padding: 10px;
      border: 1px solid rgba(216, 220, 229, 0.92);
      border-radius: 12px;
      background: rgba(252, 253, 255, 0.98);
      box-shadow: 0 14px 34px rgba(15, 23, 42, 0.18);
      backdrop-filter: blur(14px);
    }
    #${TOOLBAR_ID} .gg-title-color-popover[data-color-popover="toolbar"] {
      right: 0;
      left: auto;
    }
    #${TOOLBAR_ID} .gg-title-color-popover.is-open {
      display: block;
    }
    #${TOOLBAR_ID} .gg-title-menu-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }
    #${TOOLBAR_ID} .gg-title-menu-label {
      color: #646a73;
      font-size: 12px;
      white-space: nowrap;
    }
    #${TOOLBAR_ID} .gg-title-swatch {
      width: 18px;
      min-width: 18px;
      height: 18px;
      padding: 0;
      border: 1px solid rgba(31, 35, 41, 0.16);
      border-radius: 999px;
      background: var(--swatch);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.55);
    }
    #${TOOLBAR_ID} .gg-title-palette {
      display: grid;
      grid-template-columns: repeat(12, 18px);
      gap: 3px;
      align-items: center;
    }
    #${TOOLBAR_ID} .gg-title-swatch.is-active {
      border-color: #1677ff;
      box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.22), inset 0 0 0 1px rgba(255, 255, 255, 0.55);
    }
    .lg-node.gg-title-dom-node {
      width: var(--gg-title-node-width, auto) !important;
      height: var(--gg-title-node-height, auto) !important;
      min-width: 0 !important;
      min-height: 0 !important;
      border: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
      overflow: visible !important;
    }
    .lg-node.gg-title-dom-node > :not(.gg-title-dom-label):not([role="button"]) {
      display: none !important;
    }
    .gg-title-dom-label {
      position: absolute;
      inset: 0;
      box-sizing: border-box;
      white-space: pre;
      overflow: hidden;
      pointer-events: none;
      contain: strict;
    }
  `;
  document.head.append(style);
}

function uniqueFonts(fonts) {
  const seen = new Set();
  const names = [];
  for (const font of fonts) {
    const name = String(font ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function setFontOptions(select, fonts, selected) {
  const current = selected || select.value || "Arial";
  const names = uniqueFonts([current, ...fonts, ...FALLBACK_FONTS]).sort((a, b) => a.localeCompare(b, "zh-Hans"));
  select.replaceChildren(
    ...names.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      option.style.fontFamily = fontCss(name);
      return option;
    })
  );
  select.value = current;
}

async function loadFontOptions() {
  const ui = ensureToolbar();
  if (fontLoadPromise) return fontLoadPromise;

  fontLoadPromise = (async () => {
    let fonts = FALLBACK_FONTS;
    try {
      if (typeof globalThis.queryLocalFonts === "function") {
        const localFonts = await globalThis.queryLocalFonts();
        fonts = uniqueFonts(localFonts.map((font) => font.family));
      }
    } catch {
      fonts = FALLBACK_FONTS;
    }
    setFontOptions(ui.fontSelect, fonts, readField(activeTitleNode, "字体族") ?? "Arial");
    return fonts;
  })();

  return fontLoadPromise;
}

function ensureToolbar() {
  if (toolbar) return toolbar;
  injectStyles();

  const root = document.createElement("div");
  root.id = TOOLBAR_ID;
  root.innerHTML = `
    <textarea aria-label="\u6807\u9898\u6587\u672c"></textarea>
    <div class="gg-title-toolbar-row">
      <div class="gg-title-toolbar-group">
        <span class="gg-title-toolbar-label">\u5b57\u4f53</span>
        <select aria-label="\u5b57\u4f53\u65cf"></select>
        <button type="button" data-action="font-smaller" title="\u51cf\u5c0f\u5b57\u53f7">A-</button>
        <input class="gg-title-size-input" aria-label="\u81ea\u5b9a\u4e49\u5b57\u53f7" type="number" min="1" max="256" step="1" />
        <button type="button" data-action="font-larger" title="\u589e\u5927\u5b57\u53f7">A+</button>
      </div>
      <div class="gg-title-toolbar-group">
        <button type="button" data-style="normal" title="\u6b63\u5e38">\u6b63\u5e38</button>
        <button type="button" data-style="bold" title="\u7c97\u4f53"><b>B</b></button>
        <button type="button" data-style="italic" title="\u659c\u4f53"><i>I</i></button>
        <button type="button" data-style="underline" title="\u4e0b\u5212\u7ebf"><u>U</u></button>
        <button type="button" data-style="strike" title="\u5220\u9664\u53f7"><s>S</s></button>
      </div>
      <div class="gg-title-toolbar-group">
        <span class="gg-title-toolbar-label">\u95f4\u8ddd</span>
        <button type="button" data-spacing="\u7d27\u51d1" title="\u6301\u7eed\u51cf\u5c0f\u5b57\u7b26\u95f4\u8ddd">\u7d27\u51d1</button>
        <button type="button" data-spacing="\u6b63\u5e38" title="\u91cd\u7f6e\u5b57\u7b26\u95f4\u8ddd">\u6b63\u5e38</button>
        <button type="button" data-spacing="\u52a0\u5bbd" title="\u6301\u7eed\u589e\u5927\u5b57\u7b26\u95f4\u8ddd">\u52a0\u5bbd</button>
        <span class="gg-title-spacing-value">0px</span>
      </div>
      <div class="gg-title-toolbar-group">
        <button type="button" data-action="uppercase">\u82f1\u6587\u5927\u5199</button>
        <button type="button" data-action="lowercase">\u82f1\u6587\u5c0f\u5199</button>
      </div>
      <div class="gg-title-toolbar-group">
        <button type="button" data-action="fit">\u9002\u914d</button>
        <button type="button" data-action="panel">\u53c2\u6570</button>
        <button type="button" data-action="delete" title="\u5220\u9664\u8fd9\u4e2a\u6807\u9898\u8282\u70b9">\u5220\u9664</button>
      </div>
    </div>
    <div class="gg-title-toolbar-row">
      <div class="gg-title-toolbar-group gg-title-color-group">
        <span class="gg-title-toolbar-label">\u5b57\u4f53\u989c\u8272</span>
        <button type="button" class="gg-title-color-trigger" data-color-menu="font" aria-expanded="false">
          <span class="gg-title-color-dot" data-color-preview="font"></span>
          <span>\u9884\u8bbe</span>
        </button>
        <div class="gg-title-color-popover" data-color-popover="font">
          <div class="gg-title-menu-row">
            <span class="gg-title-menu-label">\u81ea\u5b9a\u4e49\u989c\u8272</span>
            <input aria-label="\u81ea\u5b9a\u4e49\u5b57\u4f53\u989c\u8272" data-color-input="font" type="color" />
          </div>
          <div class="gg-title-palette" data-palette="font">
            ${COLOR_PRESETS.map((color) => `<button type="button" class="gg-title-swatch" data-color="${color}" data-target="font" style="--swatch:${color}" title="${color}"></button>`).join("")}
          </div>
          <div class="gg-title-menu-row" style="margin-top:10px;margin-bottom:0;">
            <span class="gg-title-menu-label">\u5b57\u4f53\u4e0d\u900f\u660e\u5ea6</span>
            <input aria-label="\u5b57\u4f53\u4e0d\u900f\u660e\u5ea6" class="gg-title-opacity-input" data-opacity-input="font" type="range" min="0" max="100" step="1" />
            <span class="gg-title-opacity-value" data-font-opacity-value>100%</span>
          </div>
        </div>
      </div>
      <div class="gg-title-toolbar-group gg-title-color-group">
        <span class="gg-title-toolbar-label">\u80cc\u666f</span>
        <button type="button" class="gg-title-color-trigger" data-color-menu="background" aria-expanded="false">
          <span class="gg-title-color-dot" data-color-preview="background"></span>
          <span>\u989c\u8272</span>
        </button>
        <span class="gg-title-opacity-value" data-background-opacity-value>0%</span>
        <div class="gg-title-color-popover" data-color-popover="background">
          <div class="gg-title-menu-row">
            <span class="gg-title-menu-label">\u80cc\u666f\u989c\u8272</span>
            <input aria-label="\u81ea\u5b9a\u4e49\u80cc\u666f\u989c\u8272" data-color-input="background" type="color" />
          </div>
          <div class="gg-title-palette" data-palette="background">
            ${COLOR_PRESETS.map((color) => `<button type="button" class="gg-title-swatch" data-color="${color}" data-target="background" style="--swatch:${color}" title="${color}"></button>`).join("")}
          </div>
          <div class="gg-title-menu-row" style="margin-top:10px;margin-bottom:0;">
            <span class="gg-title-menu-label">\u4e0d\u900f\u660e\u5ea6</span>
            <input aria-label="\u80cc\u666f\u4e0d\u900f\u660e\u5ea6" class="gg-title-opacity-input" data-opacity-input="background" type="range" min="0" max="100" step="1" />
            <span class="gg-title-opacity-value" data-opacity-menu-value>0%</span>
          </div>
        </div>
      </div>
      <div class="gg-title-toolbar-group gg-title-color-group">
        <span class="gg-title-toolbar-label">\u83dc\u5355</span>
        <button type="button" class="gg-title-color-trigger" data-color-menu="toolbar" aria-expanded="false">
          <span class="gg-title-color-dot" data-color-preview="toolbar"></span>
          <span>\u80cc\u666f</span>
        </button>
        <span class="gg-title-opacity-value" data-toolbar-opacity-value>97%</span>
        <div class="gg-title-color-popover" data-color-popover="toolbar">
          <div class="gg-title-menu-row">
            <span class="gg-title-menu-label">\u83dc\u5355\u80cc\u666f</span>
            <input aria-label="\u83dc\u5355\u80cc\u666f\u989c\u8272" data-color-input="toolbar" type="color" />
          </div>
          <div class="gg-title-palette" data-palette="toolbar">
            ${COLOR_PRESETS.map((color) => `<button type="button" class="gg-title-swatch" data-color="${color}" data-target="toolbar" style="--swatch:${color}" title="${color}"></button>`).join("")}
          </div>
          <div class="gg-title-menu-row" style="margin-top:10px;margin-bottom:0;">
            <span class="gg-title-menu-label">\u4e0d\u900f\u660e\u5ea6</span>
            <input aria-label="\u83dc\u5355\u4e0d\u900f\u660e\u5ea6" class="gg-title-opacity-input" data-opacity-input="toolbar" type="range" min="10" max="100" step="1" />
            <span class="gg-title-opacity-value" data-toolbar-opacity-menu-value>97%</span>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.append(root);

  const textarea = root.querySelector("textarea");
  const fontSelect = root.querySelector("select");
  const fontSizeInput = root.querySelector(".gg-title-size-input");
  const colorInput = root.querySelector('input[data-color-input="font"]');
  const backgroundColorInput = root.querySelector('input[data-color-input="background"]');
  const toolbarColorInput = root.querySelector('input[data-color-input="toolbar"]');
  const fontOpacityInput = root.querySelector('input[data-opacity-input="font"]');
  const backgroundOpacityInput = root.querySelector('input[data-opacity-input="background"]');
  const toolbarOpacityInput = root.querySelector('input[data-opacity-input="toolbar"]');
  const backgroundOpacityValue = root.querySelector("[data-background-opacity-value]");
  const backgroundOpacityMenuValue = root.querySelector("[data-opacity-menu-value]");
  const fontOpacityValue = root.querySelector("[data-font-opacity-value]");
  const toolbarOpacityValue = root.querySelector("[data-toolbar-opacity-value]");
  const toolbarOpacityMenuValue = root.querySelector("[data-toolbar-opacity-menu-value]");
  const spacingValue = root.querySelector(".gg-title-spacing-value");
  const colorPreviews = {
    font: root.querySelector('[data-color-preview="font"]'),
    background: root.querySelector('[data-color-preview="background"]'),
    toolbar: root.querySelector('[data-color-preview="toolbar"]'),
  };
  const fitButton = root.querySelector('button[data-action="fit"]');
  const panelButton = root.querySelector('button[data-action="panel"]');
  const deleteButton = root.querySelector('button[data-action="delete"]');

  const updateFontSize = (delta) => {
    if (!activeTitleNode) return;
    const current = numberValue(readField(activeTitleNode, "\u5b57\u4f53\u5927\u5c0f"), 32, 1, 256);
    writeField(activeTitleNode, "\u5b57\u4f53\u5927\u5c0f", Math.max(1, Math.min(256, current + delta)));
    fitNodeToText(activeTitleNode);
  };

  const transformText = (transformer) => {
    if (!activeTitleNode) return;
    const next = transformer(textarea.value);
    textarea.value = next;
    writeField(activeTitleNode, "\u6807\u9898\u6587\u672c", next);
  };

  const closeColorMenus = (except = null) => {
    root.querySelectorAll(".gg-title-color-popover").forEach((popover) => {
      if (popover === except) return;
      popover.classList.remove("is-open");
    });
    root.querySelectorAll("[data-color-menu]").forEach((button) => {
      const popover = root.querySelector(`[data-color-popover="${button.dataset.colorMenu}"]`);
      button.setAttribute("aria-expanded", popover?.classList.contains("is-open") ? "true" : "false");
    });
  };

  const updateLetterSpacing = (delta) => {
    if (!activeTitleNode) return;
    const size = currentSize(activeTitleNode);
    const fontSize = numberValue(readField(activeTitleNode, "\u5b57\u4f53\u5927\u5c0f"), 32, 1, 256);
    const current = letterSpacingAmountFromNode(activeTitleNode, fontSize);
    writeLetterSpacingAmount(activeTitleNode, current + delta);
    setNodeSize(activeTitleNode, size);
    syncDomTitleNode(activeTitleNode);
    queueToolbarPosition(activeTitleNode, activeCanvas);
  };

  const resetLetterSpacing = () => {
    if (!activeTitleNode) return;
    const size = currentSize(activeTitleNode);
    writeLetterSpacingAmount(activeTitleNode, 0);
    setNodeSize(activeTitleNode, size);
    syncDomTitleNode(activeTitleNode);
    queueToolbarPosition(activeTitleNode, activeCanvas);
  };

  const bindHoldAction = (button, action) => {
    let delayTimer = 0;
    let repeatTimer = 0;
    const stop = () => {
      clearTimeout(delayTimer);
      clearInterval(repeatTimer);
      delayTimer = 0;
      repeatTimer = 0;
    };
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      action();
      button.setPointerCapture?.(event.pointerId);
      delayTimer = setTimeout(() => {
        repeatTimer = setInterval(action, 72);
      }, 320);
    });
    button.addEventListener("pointerup", stop);
    button.addEventListener("pointerleave", stop);
    button.addEventListener("pointercancel", stop);
    button.addEventListener("click", (event) => event.preventDefault());
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      action();
    });
  };

  root.addEventListener("mousedown", (event) => event.stopPropagation());
  root.addEventListener("pointerdown", (event) => event.stopPropagation());
  root.addEventListener("click", (event) => {
    if (!event.target.closest(".gg-title-color-group")) closeColorMenus();
  });
  textarea.addEventListener("input", () => {
    if (!activeTitleNode) return;
    writeField(activeTitleNode, "\u6807\u9898\u6587\u672c", textarea.value);
  });
  fontSelect.addEventListener("pointerdown", () => void loadFontOptions());
  fontSelect.addEventListener("focus", () => void loadFontOptions());
  fontSelect.addEventListener("change", () => {
    if (!activeTitleNode) return;
    writeField(activeTitleNode, "\u5b57\u4f53\u65cf", fontSelect.value);
  });
  fontSizeInput.addEventListener("input", () => {
    if (!activeTitleNode) return;
    writeField(activeTitleNode, "\u5b57\u4f53\u5927\u5c0f", numberValue(fontSizeInput.value, 32, 1, 256));
  });
  colorInput.addEventListener("input", () => {
    if (!activeTitleNode) return;
    writeField(activeTitleNode, "\u5b57\u4f53\u989c\u8272", colorInput.value);
  });
  fontOpacityInput.addEventListener("input", () => {
    if (!activeTitleNode) return;
    writeFontOpacity(activeTitleNode, Number(fontOpacityInput.value));
  });
  backgroundColorInput.addEventListener("input", () => {
    if (!activeTitleNode) return;
    writeField(activeTitleNode, "\u80cc\u666f\u989c\u8272", backgroundColorInput.value);
    if (numberValue(readField(activeTitleNode, "\u80cc\u666f\u4e0d\u900f\u660e\u5ea6"), 0, 0, 100) <= 0) {
      writeField(activeTitleNode, "\u80cc\u666f\u4e0d\u900f\u660e\u5ea6", 100);
    }
  });
  backgroundOpacityInput.addEventListener("input", () => {
    if (!activeTitleNode) return;
    writeField(activeTitleNode, "\u80cc\u666f\u4e0d\u900f\u660e\u5ea6", Number(backgroundOpacityInput.value));
  });
  toolbarColorInput.addEventListener("input", () => {
    toolbarStyleState.backgroundColor = toolbarColorInput.value;
    saveToolbarStyleState();
    applyToolbarStyleState();
  });
  toolbarOpacityInput.addEventListener("input", () => {
    toolbarStyleState.opacity = numberValue(toolbarOpacityInput.value, 97, 10, 100);
    saveToolbarStyleState();
    applyToolbarStyleState();
  });

  root.querySelectorAll("[data-color-menu]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const popover = root.querySelector(`[data-color-popover="${button.dataset.colorMenu}"]`);
      if (!popover) return;
      const willOpen = !popover.classList.contains("is-open");
      closeColorMenus(popover);
      popover.classList.toggle("is-open", willOpen);
      button.setAttribute("aria-expanded", willOpen ? "true" : "false");
      queueToolbarPosition(activeTitleNode, activeCanvas);
    });
  });

  root.querySelectorAll(".gg-title-swatch").forEach((button) => {
    button.addEventListener("click", () => {
      if (!activeTitleNode) return;
      const color = button.dataset.color;
      if (button.dataset.target === "font") {
        writeField(activeTitleNode, "\u5b57\u4f53\u989c\u8272", color);
      } else if (button.dataset.target === "toolbar") {
        toolbarStyleState.backgroundColor = color;
        saveToolbarStyleState();
        applyToolbarStyleState();
      } else {
        writeField(activeTitleNode, "\u80cc\u666f\u989c\u8272", color);
        if (numberValue(readField(activeTitleNode, "\u80cc\u666f\u4e0d\u900f\u660e\u5ea6"), 0, 0, 100) <= 0) {
          writeField(activeTitleNode, "\u80cc\u666f\u4e0d\u900f\u660e\u5ea6", 100);
        }
      }
    });
  });

  root.querySelectorAll("[data-style]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!activeTitleNode) return;
      const style = button.dataset.style;
      if (style === "normal") {
        writeField(activeTitleNode, "\u5b57\u4f53\u7c97\u7ec6", "\u6b63\u5e38");
        writeField(activeTitleNode, "\u5b57\u4f53\u659c\u4f53", "\u6b63\u5e38");
        writeField(activeTitleNode, "\u6587\u672c\u88c5\u9970", "\u65e0");
      } else if (style === "bold") {
        const current = stringValue(readField(activeTitleNode, "\u5b57\u4f53\u7c97\u7ec6"), "\u6b63\u5e38");
        writeField(activeTitleNode, "\u5b57\u4f53\u7c97\u7ec6", current === "\u7c97\u4f53" ? "\u6b63\u5e38" : "\u7c97\u4f53");
      } else if (style === "italic") {
        const current = stringValue(readField(activeTitleNode, "\u5b57\u4f53\u659c\u4f53"), "\u6b63\u5e38");
        writeField(activeTitleNode, "\u5b57\u4f53\u659c\u4f53", current === "\u659c\u4f53" ? "\u6b63\u5e38" : "\u659c\u4f53");
      } else if (style === "underline") {
        const current = stringValue(readField(activeTitleNode, "\u6587\u672c\u88c5\u9970"), "\u65e0");
        writeField(activeTitleNode, "\u6587\u672c\u88c5\u9970", current === "\u4e0b\u5212\u7ebf" ? "\u65e0" : "\u4e0b\u5212\u7ebf");
      } else if (style === "strike") {
        const current = stringValue(readField(activeTitleNode, "\u6587\u672c\u88c5\u9970"), "\u65e0");
        writeField(activeTitleNode, "\u6587\u672c\u88c5\u9970", current === "\u5220\u9664\u7ebf" ? "\u65e0" : "\u5220\u9664\u7ebf");
      }
    });
  });

  root.querySelectorAll("[data-spacing]").forEach((button) => {
    const spacing = button.dataset.spacing;
    if (spacing === "\u7d27\u51d1") bindHoldAction(button, () => updateLetterSpacing(-LETTER_SPACING_STEP));
    else if (spacing === "\u52a0\u5bbd") bindHoldAction(button, () => updateLetterSpacing(LETTER_SPACING_STEP));
    else button.addEventListener("click", resetLetterSpacing);
  });

  bindHoldAction(root.querySelector('button[data-action="font-smaller"]'), () => updateFontSize(-2));
  bindHoldAction(root.querySelector('button[data-action="font-larger"]'), () => updateFontSize(2));
  root.querySelector('button[data-action="uppercase"]').addEventListener("click", () => transformText((value) => value.replace(/[a-z]/g, (char) => char.toUpperCase())));
  root.querySelector('button[data-action="lowercase"]').addEventListener("click", () => transformText((value) => value.replace(/[A-Z]/g, (char) => char.toLowerCase())));

  fitButton.addEventListener("click", () => {
    if (!activeTitleNode) return;
    fitNodeToText(activeTitleNode);
  });
  panelButton.addEventListener("click", () => {
    if (!activeTitleNode) return;
    openNodePanel(activeTitleNode, activeCanvas);
  });
  deleteButton.addEventListener("click", () => {
    if (!activeTitleNode) return;
    closeColorMenus();
    deleteTitleNode(activeTitleNode, activeCanvas);
  });

  setFontOptions(fontSelect, FALLBACK_FONTS, "Arial");

  toolbar = {
    root,
    textarea,
    fontSelect,
    fontSizeInput,
    colorInput,
    toolbarColorInput,
    fontOpacityInput,
    backgroundColorInput,
    backgroundOpacityInput,
    toolbarOpacityInput,
    backgroundOpacityValue,
    backgroundOpacityMenuValue,
    fontOpacityValue,
    toolbarOpacityValue,
    toolbarOpacityMenuValue,
    spacingValue,
    colorPreviews,
    fitButton,
    panelButton,
    deleteButton,
  };
  applyToolbarStyleState();
  return toolbar;
}

function syncToolbarFromNode(node) {
  if (!toolbar || !isTitleNode(node) || activeTitleNode !== node) return;
  const text = String(readField(node, "\u6807\u9898\u6587\u672c") ?? NODE_TITLE).replace(/\\n/g, "\n");
  const fontFamily = stringValue(readField(node, "\u5b57\u4f53\u65cf"), "Arial");
  const fontSize = numberValue(readField(node, "\u5b57\u4f53\u5927\u5c0f"), 32, 1, 256);
  const fontColor = hexColorValue(readField(node, "\u5b57\u4f53\u989c\u8272"), "#ffffff");
  const fontOpacity = fontOpacityFromNode(node);
  const backgroundColor = hexColorValue(readField(node, "\u80cc\u666f\u989c\u8272"), "#ffffff");
  const backgroundOpacity = numberValue(readField(node, "\u80cc\u666f\u4e0d\u900f\u660e\u5ea6"), 0, 0, 100);
  const fontWeight = stringValue(readField(node, "\u5b57\u4f53\u7c97\u7ec6"), "\u6b63\u5e38");
  const fontStyle = stringValue(readField(node, "\u5b57\u4f53\u659c\u4f53"), "\u6b63\u5e38");
  const textDecoration = stringValue(readField(node, "\u6587\u672c\u88c5\u9970"), "\u65e0");
  const letterSpacing = stringValue(readField(node, "\u5b57\u7b26\u95f4\u8ddd"), "\u6b63\u5e38");
  const letterSpacingAmount = letterSpacingAmountFromNode(node, fontSize);

  if (toolbar.textarea.value !== text) toolbar.textarea.value = text;
  if (![...toolbar.fontSelect.options].some((option) => option.value === fontFamily)) {
    setFontOptions(toolbar.fontSelect, FALLBACK_FONTS, fontFamily);
  }
  if (toolbar.fontSelect.value !== fontFamily) toolbar.fontSelect.value = fontFamily;
  if (Number(toolbar.fontSizeInput.value) !== fontSize) toolbar.fontSizeInput.value = String(fontSize);
  if (toolbar.colorInput.value.toLowerCase() !== fontColor.toLowerCase()) toolbar.colorInput.value = fontColor;
  if (Number(toolbar.fontOpacityInput.value) !== fontOpacity) toolbar.fontOpacityInput.value = String(fontOpacity);
  if (toolbar.backgroundColorInput.value.toLowerCase() !== backgroundColor.toLowerCase()) {
    toolbar.backgroundColorInput.value = backgroundColor;
  }
  if (Number(toolbar.backgroundOpacityInput.value) !== backgroundOpacity) {
    toolbar.backgroundOpacityInput.value = String(backgroundOpacity);
  }
  if (toolbar.backgroundOpacityValue) toolbar.backgroundOpacityValue.textContent = `${backgroundOpacity}%`;
  if (toolbar.backgroundOpacityMenuValue) toolbar.backgroundOpacityMenuValue.textContent = `${backgroundOpacity}%`;
  if (toolbar.fontOpacityValue) toolbar.fontOpacityValue.textContent = `${fontOpacity}%`;
  toolbar.colorPreviews?.font?.style.setProperty("--current-color", fontColor);
  if (toolbar.colorPreviews?.font) toolbar.colorPreviews.font.style.opacity = String(Math.max(0.16, fontOpacity / 100));
  toolbar.colorPreviews?.background?.style.setProperty("--current-color", backgroundOpacity > 0 ? backgroundColor : "transparent");
  toolbar.root.querySelectorAll(".gg-title-swatch").forEach((button) => {
    const targetColor = button.dataset.target === "font" ? fontColor : backgroundColor;
    button.classList.toggle("is-active", String(button.dataset.color).toLowerCase() === targetColor.toLowerCase());
  });
  applyToolbarStyleState();

  toolbar.root.querySelectorAll("[data-style]").forEach((button) => {
    const style = button.dataset.style;
    const hasDecoration = textDecoration === "\u4e0b\u5212\u7ebf" || textDecoration === "\u5220\u9664\u7ebf";
    const active =
      (style === "normal" && fontWeight === "\u6b63\u5e38" && fontStyle === "\u6b63\u5e38" && !hasDecoration) ||
      (style === "bold" && fontWeight === "\u7c97\u4f53") ||
      (style === "italic" && fontStyle === "\u659c\u4f53") ||
      (style === "underline" && textDecoration === "\u4e0b\u5212\u7ebf") ||
      (style === "strike" && textDecoration === "\u5220\u9664\u7ebf");
    button.classList.toggle("is-active", active);
  });
  toolbar.root.querySelectorAll("[data-spacing]").forEach((button) => {
    const spacing = button.dataset.spacing;
    const active =
      (spacing === "\u7d27\u51d1" && letterSpacingAmount < -0.01) ||
      (spacing === "\u52a0\u5bbd" && letterSpacingAmount > 0.01) ||
      (spacing === "\u6b63\u5e38" && Math.abs(letterSpacingAmount) <= 0.01 && letterSpacing === "\u6b63\u5e38");
    button.classList.toggle("is-active", active);
  });
  if (toolbar.spacingValue) {
    const rounded = Math.round(letterSpacingAmount * 10) / 10;
    toolbar.spacingValue.textContent = `${rounded > 0 ? "+" : ""}${rounded}px`;
  }
  setParameterPanelButtonState(node, activeParameterPanelNode === node);
}

function graphToScreen(node, canvas) {
  const active = canvas ?? activeCanvas ?? getLiteGraph().LGraphCanvas?.active_canvas ?? globalThis.LGraphCanvas?.active_canvas ?? app.canvas;
  const element = active?.canvas;
  const rect = element?.getBoundingClientRect?.();
  const ds = active?.ds;
  const offset = ds?.offset ?? [0, 0];
  const scale = Number(ds?.scale) || 1;
  const pos = node.pos ?? [0, 0];
  const size = currentSize(node);

  if (!rect) {
    return {
      left: pos[0],
      top: pos[1],
      width: size[0] * scale,
      height: size[1] * scale,
    };
  }

  if (typeof ds?.convertOffsetToCanvas === "function") {
    const [x, y] = ds.convertOffsetToCanvas(pos);
    return {
      left: rect.left + x,
      top: rect.top + y,
      width: size[0] * scale,
      height: size[1] * scale,
    };
  }

  return {
    left: rect.left + (pos[0] + offset[0]) * scale,
    top: rect.top + (pos[1] + offset[1]) * scale,
    width: size[0] * scale,
    height: size[1] * scale,
  };
}

function updateToolbarPosition(node, canvas) {
  if (!toolbar || !isTitleNode(node) || toolbar.root.style.display === "none") return;

  const box = graphToScreen(node, canvas);
  const toolbarRect = toolbar.root.getBoundingClientRect();
  const gap = 8;
  let left = box.left + box.width / 2 - toolbarRect.width / 2;
  let top = box.top - toolbarRect.height - gap;

  if (top < gap) top = box.top + box.height + gap;
  left = Math.max(gap, Math.min(left, window.innerWidth - toolbarRect.width - gap));
  top = Math.max(gap, Math.min(top, window.innerHeight - toolbarRect.height - gap));

  toolbar.root.style.left = `${left}px`;
  toolbar.root.style.top = `${top}px`;
}

function queueToolbarPosition(node, canvas) {
  if (toolbarPositionFrame) return;
  toolbarPositionFrame = requestAnimationFrame(() => {
    toolbarPositionFrame = 0;
    updateToolbarPosition(node, canvas);
  });
}

function showToolbar(node, canvas) {
  if (!isTitleNode(node)) return;
  if (isPendingTitlePlacementNode(node)) return;
  configureNode(node);
  activeTitleNode = node;
  activeCanvas = canvas ?? activeCanvas ?? app.canvas;
  const ui = ensureToolbar();
  syncToolbarFromNode(node);
  ui.root.style.display = "block";
  queueToolbarPosition(node, activeCanvas);
}

function hideToolbar() {
  activeTitleNode = null;
  activeCanvas = null;
  activeParameterPanelNode = null;
  if (toolbar) toolbar.root.style.display = "none";
}

function isSelected(node) {
  if (!node) return false;
  const selected = activeCanvas?.selected_nodes ?? app.canvas?.selected_nodes ?? {};
  return node.selected || selected[node.id] !== undefined || Object.values(selected).includes(node);
}

function refreshToolbarVisibility() {
  if (activeTitleNode && isSelected(activeTitleNode)) {
    showToolbar(activeTitleNode, activeCanvas);
    return;
  }

  const selected = activeCanvas?.selected_nodes ?? app.canvas?.selected_nodes ?? {};
  const nextNode = Object.values(selected).find((node) => isTitleNode(node));
  if (nextNode) {
    showToolbar(nextNode, activeCanvas);
    return;
  }

  hideToolbar();
}

function installToolbarDismiss() {
  if (document._ggTitleToolbarDismissInstalled) return;
  document._ggTitleToolbarDismissInstalled = true;

  document.addEventListener(
    "mousedown",
    (event) => {
      if (toolbar?.root.contains(event.target)) return;
      requestAnimationFrame(refreshToolbarVisibility);
    },
    true
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideToolbar();
  });
  window.addEventListener("resize", () => {
    if (activeTitleNode) queueToolbarPosition(activeTitleNode, activeCanvas);
  });
}

function domNodeElement(node) {
  if (!node?.id) return null;
  const id = String(node.id).replace(/"/g, "\\\"");
  const candidates = document.querySelectorAll(`.lg-node[data-node-id="${id}"], [data-node-id="${id}"].lg-node`);
  return candidates[0] ?? null;
}

function syncDomTitleNode(node) {
  if (!isTitleNode(node)) return;
  injectStyles();
  const element = domNodeElement(node);
  if (!(element instanceof HTMLElement)) return;

  const [width, height] = currentSize(node);
  const layout = computeTextLayout(node);
  const label = element.querySelector(":scope > .gg-title-dom-label") ?? document.createElement("div");
  if (!label.parentElement) {
    label.className = "gg-title-dom-label";
    element.append(label);
  }

  element.classList.add("gg-title-dom-node");
  element.style.setProperty("--gg-title-node-width", `${width}px`);
  element.style.setProperty("--gg-title-node-height", `${height}px`);
  element.style.transform = `translate(${node.pos?.[0] ?? 0}px, ${node.pos?.[1] ?? 0}px)`;

  Object.assign(label.style, {
    color: textColorStyle(layout.config),
    background: shouldDrawBackground(layout.config) ? backgroundStyle(layout.config) : "transparent",
    borderRadius: `${layout.config.borderRadius}px`,
    fontFamily: fontCss(layout.config.fontFamily),
    fontSize: `${layout.fontSize}px`,
    fontWeight: fontWeightCss(layout.config.fontWeight),
    fontStyle: fontStyleCss(layout.config.fontStyle),
    textDecoration: textDecorationCss(layout.config.textDecoration),
    letterSpacing: `${letterSpacingValue(layout.config, layout.fontSize)}px`,
    lineHeight: `${layout.lineHeight}px`,
    textAlign: layout.vertical ? "center" : layout.config.textAlign,
    padding: `${layout.paddingY}px ${layout.paddingX}px`,
    display: layout.vertical ? "flex" : "block",
    alignItems: layout.vertical ? "center" : "",
    justifyContent: layout.vertical ? "center" : "",
    writingMode: layout.vertical ? "vertical-rl" : "horizontal-tb",
    textOrientation: layout.vertical ? "upright" : "mixed",
    transform: layout.config.angle ? `rotate(${layout.config.angle}deg)` : "",
    transformOrigin: "center",
  });
  label.textContent = layout.config.text;
}

function installTitleBehavior(nodeType) {
  if (!nodeType?.prototype || nodeType.prototype._ggTitleInstalled) return;
  nodeType.prototype._ggTitleInstalled = true;
  nodeType.title = NODE_TITLE;
  nodeType.category = NODE_CATEGORY;
  nodeType.title_mode = getLiteGraph().NO_TITLE ?? NO_TITLE_MODE;
  nodeType.collapsable = false;
  nodeType.resizable = true;
  nodeType.resizeable = true;

  for (const field of FIELDS) {
    nodeType[`@${field.name}`] = Object.fromEntries(
      Object.entries(field).filter(([key]) => key !== "name" && key !== "defaultValue")
    );
  }

  const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function (...args) {
    const result = originalOnNodeCreated?.apply(this, args);
    configureNode(this);
    armTitlePlacement(this);
    return result;
  };

  const originalOnConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function (...args) {
    const result = originalOnConfigure?.apply(this, args);
    requestAnimationFrame(() => {
      configureNode(this);
      syncDomTitleNode(this);
    });
    return result;
  };

  nodeType.prototype.computeSize = function () {
    return [...MIN_SIZE];
  };

  const originalOnResize = nodeType.prototype.onResize;
  nodeType.prototype.onResize = function (size, ...args) {
    const result = originalOnResize?.call(this, size, ...args);
    const requested = size != null && typeof size === "object" && typeof size.length === "number" ? size : this.size;
    const next = [
      Math.max(MIN_SIZE[0], Number(requested?.[0]) || MIN_SIZE[0]),
      Math.max(MIN_SIZE[1], Number(requested?.[1]) || MIN_SIZE[1]),
    ];
    this.size = next;
    if (size != null && typeof size === "object" && typeof size.length === "number") {
      size[0] = next[0];
      size[1] = next[1];
    }
    syncDomTitleNode(this);
    queueToolbarPosition(this, activeCanvas);
    markDirty(this);
    return result;
  };

  const originalOnMouseDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (event, pos, canvas) {
    showToolbar(this, canvas);
    return originalOnMouseDown?.call(this, event, pos, canvas) ?? false;
  };

  const originalOnSelected = nodeType.prototype.onSelected;
  nodeType.prototype.onSelected = function (...args) {
    const result = originalOnSelected?.apply(this, args);
    showToolbar(this, app.canvas);
    return result;
  };

  const originalOnDeselected = nodeType.prototype.onDeselected;
  nodeType.prototype.onDeselected = function (...args) {
    const result = originalOnDeselected?.apply(this, args);
    requestAnimationFrame(refreshToolbarVisibility);
    return result;
  };

  nodeType.prototype.onDblClick = function (event, pos, canvas) {
    showToolbar(this, canvas);
    openNodePanel(this, canvas);
  };

  const originalOnPropertyChanged = nodeType.prototype.onPropertyChanged;
  nodeType.prototype.onPropertyChanged = function (name, value, ...args) {
    const result = originalOnPropertyChanged?.call(this, name, value, ...args);
    if (FIELDS.some((field) => field.name === name)) {
      this.properties ??= {};
      this.properties[name] = value;
      syncWidgetFromProperty(this, name);
      requestAnimationFrame(() => {
        syncToolbarFromNode(this);
        syncDomTitleNode(this);
        markDirty(this);
      });
    }
    return result;
  };

  const originalPanelInfo = nodeType.prototype.onShowCustomPanelInfo;
  nodeType.prototype.onShowCustomPanelInfo = function (panel) {
    originalPanelInfo?.call(this, panel);
    panel.querySelector('div.property[data-property="Mode"]')?.remove();
    panel.querySelector('div.property[data-property="Color"]')?.remove();
  };

  const originalMenu = nodeType.prototype.getExtraMenuOptions;
  nodeType.prototype.getExtraMenuOptions = function (canvas, options = []) {
    originalMenu?.call(this, canvas, options);
    options.unshift(
      {
        content: "编辑标题文本",
        callback: () => showToolbar(this, canvas),
      },
      {
        content: "按文字适配尺寸",
        callback: () => fitNodeToText(this),
      },
      {
        content: "打开标题参数",
        callback: () => openNodePanel(this, canvas),
      },
      null
    );
    return options;
  };
}

function installDrawPatch() {
  if (
    !globalThis.LGraphCanvas?.prototype
    || typeof globalThis.LGraphCanvas.prototype.drawNode !== "function"
    || globalThis.LGraphCanvas.prototype._ggTitleDrawPatched
  ) return;
  const originalDrawNode = globalThis.LGraphCanvas.prototype.drawNode;
  globalThis.LGraphCanvas.prototype._ggTitleDrawPatched = true;
  globalThis.LGraphCanvas.prototype.drawNode = function (node, ctx) {
    if (!isTitleNode(node)) return originalDrawNode.apply(this, arguments);
    this.current_node = node;
    drawTitle(node, ctx, this);
  };
}

function isLeftMouseDown(event) {
  return event?.type?.includes("down") && (event.which === 1 || event.button === 0);
}

function isDoubleClick() {
  const lite = getLiteGraph();
  const canvas = globalThis.LGraphCanvas?.active_canvas ?? app.canvas;
  const now = typeof lite.getTime === "function" ? lite.getTime() : Date.now();
  return now - Number(canvas?.last_mouseclick ?? 0) < 300;
}

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function currentCanvas() {
  return globalThis.LGraphCanvas?.active_canvas ?? app.canvas ?? activeCanvas ?? null;
}

function currentGraph(canvas = currentCanvas()) {
  return canvas?.getCurrentGraph?.() ?? canvas?.graph ?? app.graph ?? null;
}

function graphNodes(graph) {
  return graph?._nodes ?? graph?.nodes ?? [];
}

function graphHasNode(graph, node) {
  return graphNodes(graph).includes(node);
}

function nodeIdentity(node) {
  return node?.id ?? node;
}

function titleNodeIdSet(graph) {
  return new Set(graphNodes(graph).filter((node) => isTitleNode(node)).map(nodeIdentity));
}

function clearPendingTitlePlacement() {
  pendingTitlePlacement = null;
}

function hasActiveTitlePlacement() {
  if (!pendingTitlePlacement) return false;
  if (nowMs() > pendingTitlePlacement.expiresAt) {
    clearPendingTitlePlacement();
    return false;
  }
  return true;
}

function resolvePendingTitleNode(canvas = currentCanvas()) {
  if (!pendingTitlePlacement) return null;
  if (isTitleNode(pendingTitlePlacement.node)) return pendingTitlePlacement.node;

  const graph = pendingTitlePlacement.graph ?? currentGraph(canvas);
  const known = pendingTitlePlacement.titleIds ?? new Set();
  const nodes = graphNodes(graph).filter((node) => isTitleNode(node));
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (!known.has(nodeIdentity(node))) {
      pendingTitlePlacement.node = node;
      return node;
    }
  }

  const transient = pendingCanvasTitleNode(canvas);
  if (transient) pendingTitlePlacement.node = transient;
  return transient;
}

function isPendingTitlePlacementNode(node) {
  if (!hasActiveTitlePlacement() || !isTitleNode(node)) return false;
  return resolvePendingTitleNode() === node;
}

function armTitlePlacement(node = null) {
  const canvas = currentCanvas();
  const graph = currentGraph(canvas);
  const now = nowMs();
  hideToolbar();
  lastTitlePlacementArmAt = now;
  pendingTitlePlacement = {
    graph,
    node: isTitleNode(node) ? node : null,
    titleIds: titleNodeIdSet(graph),
    expiresAt: now + 15000,
  };
}

function titleSelectionTextMatches(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 140) return false;
  return text === NODE_TITLE || text === NODE_NAME || text.includes(NODE_NAME) || /(^|\s)GG\s*标题(\s|$)/.test(text);
}

function isLikelyTitleMenuElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.id === TOOLBAR_ID || element.closest?.(`#${TOOLBAR_ID}`)) return false;
  if (element.closest?.(".gg-title-dom-node, .gg-title-dom-label")) return false;

  const tag = element.tagName.toLowerCase();
  if (["body", "html", "canvas", "input", "textarea", "select"].includes(tag)) return false;

  const role = String(element.getAttribute("role") ?? "").toLowerCase();
  const className = String(element.className ?? "").toLowerCase();
  if (className.includes("lg-node")) return false;
  if (["button", "a", "li"].includes(tag)) return true;
  if (role.includes("menuitem") || role.includes("option") || role.includes("treeitem") || role === "button") return true;
  return /(option|result|item|entry|node-search|node-item|p-menuitem|p-tree-node|p-autocomplete-option)/.test(className);
}

function eventTargetsTitleSelection(event) {
  const path = event.composedPath?.() ?? [event.target];
  for (const target of path) {
    if (!isLikelyTitleMenuElement(target)) continue;

    const dataset = target.dataset ?? {};
    const values = [
      dataset.nodeName,
      dataset.nodeType,
      dataset.type,
      dataset.value,
      target.getAttribute("data-node-name"),
      target.getAttribute("data-node-type"),
      target.getAttribute("data-type"),
      target.getAttribute("title"),
      target.getAttribute("aria-label"),
      target.textContent,
    ];
    if (values.some(titleSelectionTextMatches)) return true;
  }
  return false;
}

function isIgnoredTitlePlacementTarget(event) {
  const path = event.composedPath?.() ?? [event.target];
  for (const target of path) {
    if (!(target instanceof HTMLElement)) continue;
    if (target.id === TOOLBAR_ID || target.closest?.(`#${TOOLBAR_ID}`)) return true;
    const tag = target.tagName.toLowerCase();
    if (["button", "input", "textarea", "select", "option", "a"].includes(tag)) return true;
    const role = String(target.getAttribute("role") ?? "").toLowerCase();
    if (role === "button" || role === "menuitem") return true;
  }
  return false;
}

function isEventInsideCanvas(canvas, event) {
  const rect = canvas?.canvas?.getBoundingClientRect?.();
  if (!rect || !Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) return false;
  return event.clientX >= rect.left
    && event.clientX <= rect.right
    && event.clientY >= rect.top
    && event.clientY <= rect.bottom;
}

function eventToGraphPosition(canvas, event) {
  if (Number.isFinite(event?.canvasX) && Number.isFinite(event?.canvasY)) {
    return [event.canvasX, event.canvasY];
  }

  const element = canvas?.canvas;
  const rect = element?.getBoundingClientRect?.();
  if (!element || !rect) return [...(canvas?.graph_mouse ?? [0, 0])];

  const offset = [Number(event.clientX) - rect.left, Number(event.clientY) - rect.top];
  const ds = canvas?.ds;
  if (typeof ds?.convertOffsetToCanvas === "function") {
    try {
      const converted = ds.convertOffsetToCanvas(offset);
      if (Array.isArray(converted) && converted.every(Number.isFinite)) return converted;
    } catch {
      // Fall back to the basic DragAndScale calculation.
    }
  }

  const scale = Math.max(0.01, Number(ds?.scale) || 1);
  const pan = Array.isArray(ds?.offset) ? ds.offset : [0, 0];
  return [(offset[0] - (Number(pan[0]) || 0)) / scale, (offset[1] - (Number(pan[1]) || 0)) / scale];
}

function pendingCanvasTitleNode(canvas) {
  const keys = [
    "node_dragged",
    "_node_dragged",
    "dragged_node",
    "_dragged_node",
    "node_to_add",
    "_node_to_add",
    "new_node",
    "_new_node",
    "pending_node",
    "_pending_node",
  ];
  for (const key of keys) {
    const node = canvas?.[key];
    if (isTitleNode(node)) return node;
  }
  return null;
}

function clearPendingCanvasTitleNode(canvas, node) {
  for (const key of [
    "node_dragged",
    "_node_dragged",
    "dragged_node",
    "_dragged_node",
    "node_to_add",
    "_node_to_add",
    "new_node",
    "_new_node",
    "pending_node",
    "_pending_node",
  ]) {
    if (canvas?.[key] === node) canvas[key] = null;
  }
}

function placeTitleNodeFromEvent(canvas, event) {
  const graph = currentGraph(canvas);
  if (!graph) return false;

  const lite = getLiteGraph();
  const node = resolvePendingTitleNode(canvas) ?? pendingCanvasTitleNode(canvas) ?? lite.createNode?.(NODE_NAME);
  if (!node) return false;

  node.pos = eventToGraphPosition(canvas, event);
  configureNode(node);
  if (!graphHasNode(graph, node) && typeof graph.add === "function") graph.add(node);
  clearPendingCanvasTitleNode(canvas, node);
  configureNode(node);
  syncDomTitleNode(node);

  canvas?.selectNode?.(node, false);
  requestAnimationFrame(() => showToolbar(node, canvas));
  graph.change?.();
  markDirty(node);
  return true;
}

function handleTitlePlacementCanvasDown(event) {
  if (event?.button !== undefined && event.button !== 0) return;
  if (!hasActiveTitlePlacement()) return;

  const canvas = currentCanvas();
  if (!canvas?.canvas || !isEventInsideCanvas(canvas, event) || isIgnoredTitlePlacementTarget(event)) return;

  if (placeTitleNodeFromEvent(canvas, event)) {
    clearPendingTitlePlacement();
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
  }
}

function installTitlePlacementPatch() {
  if (!document._ggTitlePlacementMenuInstalled) {
    document._ggTitlePlacementMenuInstalled = true;
    const onMenuPick = (event) => {
      if (event.type === "click" && nowMs() - lastTitlePlacementArmAt < 700) return;
      if (eventTargetsTitleSelection(event)) armTitlePlacement();
    };
    document.addEventListener("pointerdown", onMenuPick, true);
    document.addEventListener("click", onMenuPick, true);
  }

  if (document._ggTitlePlacementCanvasInstalled) return;
  document._ggTitlePlacementCanvasInstalled = true;
  document.addEventListener("pointerdown", handleTitlePlacementCanvasDown, true);
  document.addEventListener("mousedown", handleTitlePlacementCanvasDown, true);
}

function installPinnedClickThroughPatch() {
  if (
    !globalThis.LGraph?.prototype
    || typeof globalThis.LGraph.prototype.getNodeOnPos !== "function"
    || globalThis.LGraph.prototype._ggTitleClickThroughPatched
  ) return;
  const originalGetNodeOnPos = globalThis.LGraph.prototype.getNodeOnPos;
  globalThis.LGraph.prototype._ggTitleClickThroughPatched = true;

  document.addEventListener(
    "mousedown",
    (event) => {
      lastMouseDownEvent = event;
      processingMouseDown = true;
      setTimeout(() => {
        processingMouseDown = false;
      }, 0);
    },
    true
  );

  globalThis.LGraph.prototype.getNodeOnPos = function (x, y, nodesList) {
    let filteredNodes = nodesList;
    if (nodesList && processingMouseDown && isLeftMouseDown(lastMouseDownEvent) && !isDoubleClick()) {
      filteredNodes = [...nodesList].filter((node) => !isTitleNode(node) || !node.flags?.pinned);
    }
    return originalGetNodeOnPos.apply(this, [x, y, filteredNodes]);
  };
}

function installDomSyncPatch() {
  if (document._ggTitleDomSyncInstalled) return;
  document._ggTitleDomSyncInstalled = true;
  const syncAll = () => {
    for (const node of app.graph?._nodes ?? app.graph?.nodes ?? []) {
      if (isTitleNode(node)) syncDomTitleNode(node);
    }
  };
  requestAnimationFrame(syncAll);
  setInterval(syncAll, 250);
}

function installTitlePatchesSoon() {
  injectStyles();
  installToolbarDismiss();
  installDomSyncPatch();
  installTitlePlacementPatch();

  let attempts = 0;
  const install = () => {
    attempts += 1;
    installDrawPatch();
    installPinnedClickThroughPatch();

    const drawReady = Boolean(globalThis.LGraphCanvas?.prototype?._ggTitleDrawPatched);
    const clickReady = Boolean(globalThis.LGraph?.prototype?._ggTitleClickThroughPatched);
    if ((drawReady && clickReady) || attempts >= 20) return;
    setTimeout(install, 100);
  };
  install();
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.TitleNode",

  setup() {
    installTitlePatchesSoon();
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    installTitleBehavior(nodeType);
  },

  loadedGraphNode(node) {
    if (!isTitleNode(node)) return;
    if (pendingTitlePlacement?.node === node) clearPendingTitlePlacement();
    requestAnimationFrame(() => {
      configureNode(node);
      syncDomTitleNode(node);
      markDirty(node);
    });
  },
});
