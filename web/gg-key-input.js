import { app } from "../../scripts/app.js";
import { ggIcon } from "./gg-ui-icons.js";

const NODE_NAME = "GGKeyInput";
const KEY_WIDGET_NAME = "密钥";
const DOM_WIDGET_NAME = "gg_key_input";
const HIDDEN_TYPE = "ggHiddenKeyInput";
const STORAGE_KEY = "GuliNodes.ggKeyInput";
const MIN_WIDTH = 220;
const PANEL_HEIGHT = 46;
const COMPACT_NODE_HEIGHT = 112;
const NODE_INSET = 28;

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function nodeStoreKey(node) {
  return String(node.id ?? node.type ?? NODE_NAME);
}

function loadStoredKey(node) {
  return readStore()[nodeStoreKey(node)] || "";
}

function saveStoredKey(node, value) {
  const store = readStore();
  const key = nodeStoreKey(node);
  const text = String(value || "").trim();
  if (text) {
    store[key] = text;
  } else {
    delete store[key];
  }
  writeStore(store);
}

function getKeyWidget(node) {
  return node.widgets?.find((widget) => widget?.name === KEY_WIDGET_NAME) ?? null;
}

function syncWidgetValue(widget, value) {
  const text = String(value || "").trim();
  widget.value = text;
  widget.callback?.(text);
}

function hideKeyWidget(widget) {
  if (!widget || widget._ggKeyInputHidden) return;
  widget._ggKeyInputHidden = true;
  widget._ggKeyInputOriginalType = widget.type;
  widget._ggKeyInputOriginalComputeSize = widget.computeSize;
  widget.hidden = true;
  widget.type = HIDDEN_TYPE;
  widget.computeSize = () => [0, -4];
}

function createPanel(node, keyWidget) {
  const host = document.createElement("div");
  host.className = "gg-key-input-panel";
  Object.assign(host.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    height: `${PANEL_HEIGHT}px`,
    boxSizing: "border-box",
    overflow: "hidden",
    padding: "4px 6px",
    pointerEvents: "auto",
  });

  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "输入 API Key 或访问令牌";
  input.value = String(keyWidget.value || loadStoredKey(node) || "");
  Object.assign(input.style, {
    flex: "1 1 auto",
    minWidth: "0",
    height: "32px",
    border: "1px solid rgba(127,127,127,0.35)",
    borderRadius: "6px",
    padding: "0 10px",
    outline: "none",
    color: "var(--input-text, #222)",
    background: "var(--comfy-input-bg, rgba(255,255,255,0.9))",
    boxSizing: "border-box",
  });

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "gg-key-input-toggle";
  toggle.innerHTML = ggIcon("eye", 18);
  toggle.title = "显示或隐藏密钥";
  toggle.setAttribute("aria-label", "显示密钥");
  Object.assign(toggle.style, buttonStyle());

  const sync = () => {
    syncWidgetValue(keyWidget, input.value);
    saveStoredKey(node, input.value);
  };

  input.addEventListener("input", sync);
  input.addEventListener("change", sync);
  toggle.addEventListener("click", () => {
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    toggle.innerHTML = visible ? ggIcon("eye", 18) : ggIcon("eyeOff", 18);
    toggle.setAttribute("aria-label", visible ? "显示密钥" : "隐藏密钥");
  });
  host.append(input, toggle);
  syncWidgetValue(keyWidget, input.value);
  return { host, input, toggle };
}

function buttonStyle() {
  return {
    flex: "0 0 auto",
    width: "34px",
    height: "32px",
    border: "1px solid rgba(127,127,127,0.35)",
    borderRadius: "8px",
    padding: "0",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--gg-ui-ink)",
    background: "var(--comfy-menu-bg, rgba(245,245,245,0.95))",
    cursor: "pointer",
  };
}

function removeExistingPanel(node) {
  const widget = node.ggKeyInputWidget || node.widgets?.find((item) => item?.name === DOM_WIDGET_NAME);
  if (!widget) return;
  widget.onRemoved?.();
  if (Array.isArray(node.widgets)) {
    node.widgets = node.widgets.filter((item) => item !== widget);
  }
  node.ggKeyInputWidget = null;
  node.ggKeyInputPanel = null;
}

function applyPanelLayout(panel, width) {
  if (!panel?.host) return;

  const nodeWidth = Math.max(MIN_WIDTH, Number(width) || MIN_WIDTH);
  const panelWidth = Math.max(160, nodeWidth - NODE_INSET);
  Object.assign(panel.host.style, {
    width: `${panelWidth}px`,
    minWidth: `${panelWidth}px`,
    maxWidth: `${panelWidth}px`,
  });
}

function fitNode(node) {
  const width = MIN_WIDTH;
  const height = COMPACT_NODE_HEIGHT;
  if (node.ggKeyInputPanel) applyPanelLayout(node.ggKeyInputPanel, width);
  node.setSize?.([width, height]);
  node.size = [width, height];
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
}

function installResizeHook(node) {
  if (node._ggKeyInputResizeHookInstalled) return;
  node._ggKeyInputResizeHookInstalled = true;

  const originalOnResize = node.onResize;
  node.onResize = function (size) {
    const result = originalOnResize?.apply(this, arguments);
    const width = Math.max(MIN_WIDTH, Number(size?.[0]) || Number(this.size?.[0]) || MIN_WIDTH);
    if (Array.isArray(size) && width !== size[0]) size[0] = width;
    if (this.ggKeyInputPanel) applyPanelLayout(this.ggKeyInputPanel, width);
    return result;
  };
}

function setupNode(node) {
  if (!node || (node.comfyClass !== NODE_NAME && node.type !== NODE_NAME)) return;
  const keyWidget = getKeyWidget(node);
  if (!keyWidget) return;

  node.serialize_widgets = true;
  hideKeyWidget(keyWidget);
  installResizeHook(node);

  if (node.ggKeyInputWidget?.input) {
    node.ggKeyInputWidget.input.value = String(keyWidget.value || loadStoredKey(node) || "");
    syncWidgetValue(keyWidget, node.ggKeyInputWidget.input.value);
    applyPanelLayout(node.ggKeyInputPanel, node.size?.[0] || MIN_WIDTH);
    requestAnimationFrame(() => fitNode(node));
    return;
  }

  removeExistingPanel(node);
  const panel = createPanel(node, keyWidget);
  node.ggKeyInputPanel = panel;
  applyPanelLayout(panel, node.size?.[0] || MIN_WIDTH);
  const widget = node.addDOMWidget(DOM_WIDGET_NAME, "gg_key_input", panel.host, {
    getValue() {
      return "";
    },
    setValue() {},
    serialize: false,
  });

  widget.input = panel.input;
  widget.host = panel.host;
  widget.computeSize = function (width) {
    const nodeWidth = Math.max(MIN_WIDTH, Number(width) || node.size?.[0] || MIN_WIDTH);
    applyPanelLayout(panel, nodeWidth);
    return [nodeWidth, PANEL_HEIGHT];
  };
  widget.onRemoved = function () {
    panel.host.remove();
  };

  node.ggKeyInputWidget = widget;
  requestAnimationFrame(() => fitNode(node));
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.KeyInput",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME || nodeType.prototype._ggKeyInputInstalled) return;
    nodeType.prototype._ggKeyInputInstalled = true;

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalOnNodeCreated?.apply(this, args);
      setTimeout(() => setupNode(this), 0);
      return result;
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = originalOnConfigure?.apply(this, args);
      setTimeout(() => setupNode(this), 0);
      return result;
    };

    const originalComputeSize = nodeType.prototype.computeSize;
    nodeType.prototype.computeSize = function (...args) {
      const size = originalComputeSize?.apply(this, args) ?? [MIN_WIDTH, COMPACT_NODE_HEIGHT];
      if (this?.comfyClass !== NODE_NAME && this?.type !== NODE_NAME) return size;
      return [MIN_WIDTH, COMPACT_NODE_HEIGHT];
    };
  },

  nodeCreated(node) {
    setTimeout(() => setupNode(node), 0);
  },

  loadedGraphNode(node) {
    setTimeout(() => setupNode(node), 0);
  },
});
