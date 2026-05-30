import { app } from "../../scripts/app.js";

const NODE_NAME = "GGPrettyReroute";
const ANY_TYPE = "*";
const DEFAULT_ORIENTATION = "horizontal";
const HIDE_TYPE_DEFAULT_KEY = "GuliNodes.GGPrettyReroute.hideTypeByDefault";
const HORIZONTAL_SIZE = [75, 26];
const VERTICAL_SIZE = [26, 75];
const TYPE_BADGE_HEIGHT = 16;
const TYPE_PADDING = 28;
const ROUND_SHAPE = 2;
const NO_TITLE_MODE = 1;
const STYLE_ID = "gg-pretty-reroute-style";
const DIRECTIONS = {
  UP: 1,
  DOWN: 2,
  LEFT: 3,
  RIGHT: 4,
};
const TYPE_COLORS = {
  MODEL: "#8b6ff6",
  CLIP: "#d9a441",
  VAE: "#c76969",
  IMAGE: "#47a8f5",
  MASK: "#8ed95f",
  LATENT: "#9b86f5",
  CONDITIONING: "#c18b5a",
  INT: "#75a6d5",
  FLOAT: "#78cf8a",
  STRING: "#a9adb8",
  BOOLEAN: "#f2a23a",
};

let measureContext = null;
let domSyncInstalled = false;

function getLiteGraph() {
  return globalThis.LiteGraph ?? {};
}

function isPrettyReroute(node) {
  return node?.comfyClass === NODE_NAME || node?.type === NODE_NAME;
}

function liteDirection(name) {
  return getLiteGraph()[name] ?? DIRECTIONS[name];
}

function shouldHideTypeByDefault() {
  try {
    const stored = localStorage.getItem(HIDE_TYPE_DEFAULT_KEY);
    return stored == null ? true : stored !== "false";
  } catch {
    return true;
  }
}

function setHideTypeByDefault(value) {
  try {
    localStorage.setItem(HIDE_TYPE_DEFAULT_KEY, value ? "true" : "false");
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

function measureText(text, font = "11px sans-serif") {
  const value = String(text ?? "");
  if (!value) return 0;
  const canvas = measureContext ? null : document.createElement("canvas");
  measureContext ??= canvas?.getContext("2d") ?? null;
  if (!measureContext) return value.length * 7;
  measureContext.font = font;
  return measureContext.measureText(value).width;
}

function getLink(graph, linkId) {
  if (linkId == null) return null;
  if (graph?.getLink) return graph.getLink(linkId);
  return graph?._links instanceof Map
    ? graph._links.get(linkId)
    : graph?.links?.[linkId] ?? graph?._links?.[linkId] ?? null;
}

function getNode(graph, id) {
  return graph?.getNodeById?.(id) ?? (graph?.nodes ?? graph?._nodes ?? []).find((node) => String(node.id) === String(id));
}

function firstRealType(type) {
  const text = String(type || ANY_TYPE);
  if (!text || text === ANY_TYPE) return ANY_TYPE;
  return text.split(",").map((part) => part.trim()).find(Boolean) || ANY_TYPE;
}

function connectedInputType(node) {
  const input = node.inputs?.[0];
  const link = getLink(node.graph, input?.link);
  const source = getNode(node.graph, link?.origin_id);
  return firstRealType(source?.outputs?.[link?.origin_slot]?.type || link?.type || input?.type);
}

function connectedOutputType(node) {
  const linkId = node.outputs?.[0]?.links?.[0];
  const link = getLink(node.graph, linkId);
  const target = getNode(node.graph, link?.target_id);
  return firstRealType(target?.inputs?.[link?.target_slot]?.type || link?.type);
}

function inferType(node) {
  const inputType = connectedInputType(node);
  if (inputType !== ANY_TYPE) return inputType;
  const outputType = connectedOutputType(node);
  if (outputType !== ANY_TYPE) return outputType;
  return firstRealType(node.properties?.gg_reroute_type);
}

function typeColor(type) {
  const normalized = firstRealType(type);
  const canvasColor = app.canvas?.default_connection_color_byType?.[normalized];
  return canvasColor || TYPE_COLORS[normalized] || "#7f8494";
}

function ensureProperties(node) {
  node.properties ??= {};
  const props = node.properties;

  if (props.gg_reroute_orientation !== "vertical" && props.gg_reroute_orientation !== "horizontal") {
    props.gg_reroute_orientation = DEFAULT_ORIENTATION;
  }
  if (props.gg_reroute_show_type === undefined) {
    props.gg_reroute_show_type = props.showOutputText === undefined
      ? !shouldHideTypeByDefault()
      : Boolean(props.showOutputText);
  }
  props.gg_reroute_hide_type_by_default ??= true;
  props.gg_reroute_type ??= ANY_TYPE;

  props.showOutputText = Boolean(props.gg_reroute_show_type);
  props.horizontal = props.gg_reroute_orientation === "horizontal";
  return props;
}

function orientation(node) {
  return ensureProperties(node).gg_reroute_orientation === "vertical" ? "vertical" : "horizontal";
}

function typeLabel(node) {
  const type = firstRealType(ensureProperties(node).gg_reroute_type);
  return type === ANY_TYPE ? "ANY" : type;
}

function targetSize(node) {
  const vertical = orientation(node) === "vertical";
  const base = vertical ? VERTICAL_SIZE : HORIZONTAL_SIZE;
  if (!ensureProperties(node).gg_reroute_show_type) return [...base];

  const labelWidth = Math.ceil(measureText(typeLabel(node), "bold 10px sans-serif") + TYPE_PADDING);
  return vertical
    ? [Math.max(base[0], labelWidth), base[1]]
    : [Math.max(base[0], labelWidth), base[1]];
}

function setNodeField(node, key, value) {
  try {
    node[key] = value;
  } catch {
    // Some modern ComfyUI node fields are read-only accessors on instances.
  }
}

function injectDomStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .lg-node.gg-pretty-reroute-dom-node {
      width: var(--gg-reroute-width, auto) !important;
      height: var(--gg-reroute-height, auto) !important;
      min-width: 0 !important;
      min-height: 0 !important;
      border: 0 !important;
      background: transparent !important;
      box-shadow: none !important;
      overflow: visible !important;
    }
    .lg-node.gg-pretty-reroute-dom-node > :not(.gg-pretty-reroute-dom-pill) {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    .gg-pretty-reroute-dom-pill {
      position: absolute;
      inset: 0;
      box-sizing: border-box;
      border: 1px solid #d8dce4;
      border-radius: 999px;
      background: #ffffff;
      box-shadow: none;
      pointer-events: none;
    }
    .gg-pretty-reroute-dom-pill.gg-selected {
      border-width: 2px;
    }
    .gg-pretty-reroute-dom-dot {
      position: absolute;
      width: 9px;
      height: 9px;
      box-sizing: border-box;
      border: 1.5px solid rgba(255, 255, 255, 0.9);
      border-radius: 999px;
      background: #7f8494;
      transform: translate(-50%, -50%);
    }
    .gg-pretty-reroute-dom-label {
      position: absolute;
      left: 50%;
      top: 50%;
      max-width: calc(100% - 10px);
      transform: translate(-50%, -50%);
      border-radius: 999px;
      padding: 2px 6px;
      overflow: hidden;
      background: rgba(31, 35, 45, 0.72);
      color: rgba(255, 255, 255, 0.96);
      font: bold 10px system-ui, sans-serif;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;
  document.head.append(style);
}

function domNodeElement(node) {
  if (!node?.id) return null;
  const id = String(node.id).replace(/"/g, "\\\"");
  return document.querySelector(`.lg-node[data-node-id="${id}"], [data-node-id="${id}"].lg-node`);
}

function syncDomReroute(node) {
  if (!isPrettyReroute(node)) return;
  injectDomStyle();

  const element = domNodeElement(node);
  if (!(element instanceof HTMLElement)) return;

  setupNode(node);
  updateSlotTypes(node);
  updateSlotLayout(node);

  const width = Number(node.size?.[0]) || targetSize(node)[0];
  const height = Number(node.size?.[1]) || targetSize(node)[1];
  const vertical = orientation(node) === "vertical";
  const accent = typeColor(inferType(node));
  const selected = node.selected || app.canvas?.selected_nodes?.[node.id] !== undefined;
  const pill = element.querySelector(":scope > .gg-pretty-reroute-dom-pill") ?? document.createElement("div");
  if (!pill.parentElement) {
    pill.className = "gg-pretty-reroute-dom-pill";
    pill.innerHTML = `
      <span class="gg-pretty-reroute-dom-dot gg-input"></span>
      <span class="gg-pretty-reroute-dom-dot gg-output"></span>
      <span class="gg-pretty-reroute-dom-label"></span>
    `;
    element.append(pill);
  }

  const inputDot = pill.querySelector(".gg-input");
  const outputDot = pill.querySelector(".gg-output");
  const label = pill.querySelector(".gg-pretty-reroute-dom-label");

  element.classList.add("gg-pretty-reroute-dom-node");
  element.style.setProperty("--gg-reroute-width", `${width}px`);
  element.style.setProperty("--gg-reroute-height", `${height}px`);
  element.style.transform = `translate(${node.pos?.[0] ?? 0}px, ${node.pos?.[1] ?? 0}px)`;
  pill.classList.toggle("gg-selected", selected);
  pill.style.borderColor = selected ? accent : "#d8dce4";

  Object.assign(inputDot.style, {
    left: vertical ? "50%" : "0",
    top: vertical ? "0" : "50%",
    background: accent,
  });
  Object.assign(outputDot.style, {
    left: vertical ? "50%" : "100%",
    top: vertical ? "100%" : "50%",
    background: accent,
  });

  if (ensureProperties(node).gg_reroute_show_type) {
    label.textContent = typeLabel(node);
    label.style.display = "block";
  } else {
    label.textContent = "";
    label.style.display = "none";
  }
}

function installDomSyncPatch() {
  if (domSyncInstalled) return;
  domSyncInstalled = true;
  const syncAll = () => {
    for (const node of app.graph?._nodes ?? app.graph?.nodes ?? []) {
      if (isPrettyReroute(node)) syncDomReroute(node);
    }
  };
  requestAnimationFrame(syncAll);
  setInterval(syncAll, 250);
}

function styleAsOfficialReroute(node) {
  const lite = getLiteGraph();
  setNodeField(node, "title", "");
  setNodeField(node, "title_mode", lite.NO_TITLE ?? NO_TITLE_MODE);
  setNodeField(node, "_shape", lite.ROUND_SHAPE ?? ROUND_SHAPE);
  setNodeField(node, "shape", lite.ROUND_SHAPE ?? ROUND_SHAPE);
  setNodeField(node, "color", "transparent");
  setNodeField(node, "bgcolor", "transparent");
  setNodeField(node, "serialize_widgets", false);
  setNodeField(node, "isVirtualNode", true);
  setNodeField(node, "resizable", false);
  setNodeField(node, "resizeable", false);
  node.badges = [];
  node.title_buttons = [];
  node.properties ??= {};
  node.properties["Node name for S&R"] = NODE_NAME;
}

function updateSlotTypes(node) {
  ensureProperties(node);
  const type = inferType(node);
  const accent = typeColor(type);
  const slots = [
    [node.inputs?.[0], true],
    [node.outputs?.[0], false],
  ];

  for (const [slot] of slots) {
    if (!slot) continue;
    slot.type = type;
    slot.label = " ";
    slot.color_on = accent;
  }

  node.properties.gg_reroute_type = type;
}

function updateSlotLayout(node) {
  const vertical = orientation(node) === "vertical";
  const width = Number(node.size?.[0]) || targetSize(node)[0];
  const height = Number(node.size?.[1]) || targetSize(node)[1];
  const input = node.inputs?.[0];
  const output = node.outputs?.[0];

  if (input) {
    input.label = " ";
    input.dir = vertical ? liteDirection("UP") : liteDirection("LEFT");
    input.pos = vertical ? [width / 2, 0] : [0, height / 2];
  }
  if (output) {
    output.label = " ";
    output.dir = vertical ? liteDirection("DOWN") : liteDirection("RIGHT");
    output.pos = vertical ? [width / 2, height] : [width, height / 2];
  }
}

function fitNode(node) {
  const size = targetSize(node);
  node.size = [size[0], size[1]];
  node.setSize?.(node.size);
  updateSlotLayout(node);
}

function setupNode(node) {
  styleAsOfficialReroute(node);
  ensureProperties(node);
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

function refresh(node) {
  setupNode(node);
  updateSlotTypes(node);
  fitNode(node);
  syncDomReroute(node);
  markDirty(node);
}

function drawRoundRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawTypeLabel(node, ctx) {
  if (node.flags?.collapsed || !ensureProperties(node).gg_reroute_show_type) return;

  const text = typeLabel(node);
  const width = Math.min(node.size[0] - 10, measureText(text, "bold 10px sans-serif") + 12);
  const x = (node.size[0] - width) / 2;
  const y = (node.size[1] - TYPE_BADGE_HEIGHT) / 2;

  ctx.save();
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(31, 35, 45, 0.72)";
  ctx.beginPath();
  drawRoundRect(ctx, x, y, width, TYPE_BADGE_HEIGHT, TYPE_BADGE_HEIGHT / 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
  ctx.fillText(text, node.size[0] / 2, y + TYPE_BADGE_HEIGHT / 2);
  ctx.restore();
}

function drawSlot(ctx, x, y, color) {
  ctx.save();
  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawPrettyReroute(node, ctx, canvas) {
  setupNode(node);
  updateSlotTypes(node);
  updateSlotLayout(node);

  const width = Number(node.size?.[0]) || targetSize(node)[0];
  const height = Number(node.size?.[1]) || targetSize(node)[1];
  const radius = Math.max(8, Math.min(width, height) / 2);
  const accent = typeColor(inferType(node));
  const selected = node.selected || canvas?.selected_nodes?.[node.id] !== undefined;

  ctx.save();
  ctx.globalAlpha = typeof canvas?.getNodeModeAlpha === "function" ? canvas.getNodeModeAlpha(node) : 1;
  ctx.shadowColor = "transparent";
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = selected ? accent : "#d8dce4";
  ctx.lineWidth = selected ? 2 : 1;
  ctx.beginPath();
  drawRoundRect(ctx, 0.5, 0.5, width - 1, height - 1, radius);
  ctx.fill();
  ctx.stroke();

  const inputPos = node.inputs?.[0]?.pos ?? [0, height / 2];
  const outputPos = node.outputs?.[0]?.pos ?? [width, height / 2];
  drawSlot(ctx, inputPos[0], inputPos[1], accent);
  drawSlot(ctx, outputPos[0], outputPos[1], accent);

  drawTypeLabel(node, ctx);
  ctx.restore();
}

function installDrawPatch() {
  if (
    !globalThis.LGraphCanvas?.prototype
    || typeof globalThis.LGraphCanvas.prototype.drawNode !== "function"
    || globalThis.LGraphCanvas.prototype._ggPrettyRerouteDrawPatched
  ) return;

  const originalDrawNode = globalThis.LGraphCanvas.prototype.drawNode;
  globalThis.LGraphCanvas.prototype._ggPrettyRerouteDrawPatched = true;
  globalThis.LGraphCanvas.prototype.drawNode = function (node, ctx) {
    if (!isPrettyReroute(node)) return originalDrawNode.apply(this, arguments);
    this.current_node = node;
    drawPrettyReroute(node, ctx, this);
  };
}

function installPrettyReroutePatchesSoon() {
  injectDomStyle();
  installDomSyncPatch();

  let attempts = 0;
  const install = () => {
    attempts += 1;
    installDrawPatch();
    if (globalThis.LGraphCanvas?.prototype?._ggPrettyRerouteDrawPatched || attempts >= 20) return;
    setTimeout(install, 100);
  };
  install();
}

function setOrientation(node, value) {
  const props = ensureProperties(node);
  props.gg_reroute_orientation = value === "vertical" ? "vertical" : "horizontal";
  props.horizontal = props.gg_reroute_orientation === "horizontal";
  refresh(node);
}

function setShowType(node, show) {
  const props = ensureProperties(node);
  props.gg_reroute_show_type = Boolean(show);
  props.showOutputText = Boolean(show);
  refresh(node);
}

function hideTypeByDefault(node) {
  setHideTypeByDefault(true);
  const props = ensureProperties(node);
  props.gg_reroute_hide_type_by_default = true;
  setShowType(node, false);
}

function installPrettyRerouteBehavior(nodeType) {
  if (!nodeType?.prototype || nodeType.prototype._ggPrettyRerouteInstalled) return;
  nodeType.prototype._ggPrettyRerouteInstalled = true;
  nodeType.title_mode = getLiteGraph().NO_TITLE ?? NO_TITLE_MODE;
  nodeType.collapsable = false;

  const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function (...args) {
    const result = originalOnNodeCreated?.apply(this, args);
    refresh(this);
    return result;
  };

  const originalOnConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function (...args) {
    const result = originalOnConfigure?.apply(this, args);
    requestAnimationFrame(() => refresh(this));
    return result;
  };

  const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
  nodeType.prototype.onConnectionsChange = function (...args) {
    const result = originalOnConnectionsChange?.apply(this, args);
    requestAnimationFrame(() => refresh(this));
    return result;
  };

  nodeType.prototype.computeSize = function () {
    setupNode(this);
    return targetSize(this);
  };

  nodeType.prototype.onDrawForeground = function (ctx) {
    setupNode(this);
    drawTypeLabel(this, ctx);
  };

  const originalGetConnectionPos = nodeType.prototype.getConnectionPos;
  nodeType.prototype.getConnectionPos = function (isInput, slotNumber, out) {
    setupNode(this);
    if (slotNumber !== 0) {
      return originalGetConnectionPos?.call(this, isInput, slotNumber, out);
    }
    const vertical = orientation(this) === "vertical";
    const x = this.pos[0] + (vertical ? this.size[0] / 2 : isInput ? 0 : this.size[0]);
    const y = this.pos[1] + (vertical ? isInput ? 0 : this.size[1] : this.size[1] / 2);
    if (out) {
      out[0] = x;
      out[1] = y;
      return out;
    }
    return [x, y];
  };

  const originalMenu = nodeType.prototype.getExtraMenuOptions;
  nodeType.prototype.getExtraMenuOptions = function (canvas, options = []) {
    originalMenu?.call(this, canvas, options);
    ensureProperties(this);
    options.unshift(
      {
        content: this.properties.gg_reroute_show_type ? "隐藏类型" : "显示类型",
        callback: () => setShowType(this, !this.properties.gg_reroute_show_type),
      },
      {
        content: "默认隐藏类型",
        disabled: !this.properties.gg_reroute_show_type,
        callback: () => hideTypeByDefault(this),
      },
      {
        content: "垂直布局",
        disabled: orientation(this) === "vertical",
        callback: () => setOrientation(this, "vertical"),
      },
      {
        content: "水平布局",
        disabled: orientation(this) === "horizontal",
        callback: () => setOrientation(this, "horizontal"),
      },
      null
    );
    return options;
  };
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.PrettyReroute",

  setup() {
    installPrettyReroutePatchesSoon();
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    installPrettyRerouteBehavior(nodeType);
  },

  loadedGraphNode(node) {
    if (node?.comfyClass !== NODE_NAME && node?.type !== NODE_NAME) return;
    requestAnimationFrame(() => refresh(node));
  },
});
