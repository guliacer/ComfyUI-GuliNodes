import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ggIcon } from "./gg-ui-icons.js";

const NODE_NAME = "GGKeyInput";
const KEY_WIDGET_NAME = "密钥";
const ENDPOINT_WIDGET_NAME = "端点";
const MODEL_WIDGET_NAME = "模型名称";
const DOM_WIDGET_NAME = "gg_key_input";
const HIDDEN_TYPE = "ggHiddenKeyInput";
const STORAGE_KEY = "GuliNodes.ggKeyInput";
const TEST_ROUTE = "/guli/key_input/test";
const MIN_WIDTH = 340;
const PANEL_HEIGHT = 146;
const COMPACT_NODE_HEIGHT = 198;
const LEGACY_COMPACT_NODE_HEIGHT = 236;
const NODE_INSET = 28;
const DEFAULT_MASKED = false;

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

function readStoredConfig(node) {
  const value = readStore()[nodeStoreKey(node)];
  if (typeof value === "string") {
    return { key: value, endpoint: "", model: "" };
  }
  if (!value || typeof value !== "object") {
    return { key: "", endpoint: "", model: "" };
  }
  return {
    key: String(value.key ?? value.apiKey ?? value["密钥"] ?? ""),
    endpoint: String(value.endpoint ?? value.url ?? value["端点"] ?? ""),
    model: String(value.model ?? value.modelName ?? value["模型名称"] ?? ""),
  };
}

function saveStoredConfig(node, config) {
  const store = readStore();
  const storeKey = nodeStoreKey(node);
  const current = readStoredConfig(node);
  const next = {
    key: String(config.key ?? current.key ?? "").trim(),
    endpoint: String(config.endpoint ?? current.endpoint ?? "").trim(),
    model: String(config.model ?? current.model ?? "").trim(),
  };

  if (next.key || next.endpoint || next.model) {
    store[storeKey] = next;
  } else {
    delete store[storeKey];
  }
  writeStore(store);
}

function getWidget(node, name) {
  return node.widgets?.find((widget) => widget?.name === name) ?? null;
}

function syncWidgetValue(widget, value) {
  if (!widget) return;
  const text = String(value || "").trim();
  widget.value = text;
  widget.callback?.(text);
}

function hideConfigWidget(widget) {
  if (!widget || widget._ggKeyInputHidden) return;
  widget._ggKeyInputHidden = true;
  widget._ggKeyInputOriginalType = widget.type;
  widget._ggKeyInputOriginalComputeSize = widget.computeSize;
  widget.hidden = true;
  widget.type = HIDDEN_TYPE;
  widget.computeSize = () => [0, -4];
}

function inputStyle() {
  return {
    width: "100%",
    minWidth: "0",
    height: "30px",
    border: "1px solid rgba(127,127,127,0.35)",
    borderRadius: "6px",
    padding: "0 10px",
    outline: "none",
    color: "var(--input-text, #222)",
    background: "var(--comfy-input-bg, rgba(255,255,255,0.9))",
    boxSizing: "border-box",
  };
}

function buttonStyle() {
  return {
    flex: "0 0 auto",
    width: "32px",
    height: "30px",
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

function statusStyle() {
  return {
    flex: "1 1 auto",
    minWidth: "0",
    height: "26px",
    lineHeight: "26px",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    fontSize: "11px",
    color: "var(--gg-ui-muted, #6b7280)",
    boxSizing: "border-box",
  };
}

function setTestStatus(panel, state, message) {
  if (!panel?.status) return;
  panel.status.textContent = message || "";
  panel.status.title = message || "";
  const colors = {
    idle: "var(--gg-ui-muted, #6b7280)",
    testing: "var(--gg-ui-warning, #f59e0b)",
    success: "var(--gg-ui-success, #22c55e)",
    error: "var(--gg-ui-danger, #ef4444)",
  };
  panel.status.style.color = colors[state] || colors.idle;
  panel.testButton?.classList.toggle("gg-state-success", state === "success");
}

function setTestBusy(panel, busy) {
  if (!panel?.testButton) return;
  panel.testButton.disabled = busy;
  panel.testButton.style.cursor = busy ? "wait" : "pointer";
  panel.testButton.style.opacity = busy ? "0.72" : "1";
  panel.testButton.innerHTML = ggIcon(busy ? "more" : "zap", 16);
}

function maskMiddle(value, prefix = 6, suffix = 4) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= prefix + suffix + 3) {
    if (text.length <= 4) return "*".repeat(text.length);
    return `${text.slice(0, 2)}***${text.slice(-2)}`;
  }
  return `${text.slice(0, prefix)}...${text.slice(-suffix)}`;
}

function syncSensitiveRawFromInputs(panel) {
  if (!panel || panel.masked) return;
  panel.rawKey = panel.keyInput?.value || "";
  panel.rawEndpoint = panel.endpointInput?.value || "";
}

function setSensitiveReadonly(panel, readonly) {
  if (!panel) return;
  [panel.endpointInput, panel.keyInput].forEach((input) => {
    if (!input) return;
    input.readOnly = readonly;
    input.style.cursor = readonly ? "default" : "text";
    input.style.opacity = readonly ? "0.82" : "1";
  });
}

function refreshSensitiveDisplay(panel) {
  if (!panel) return;
  const masked = Boolean(panel.masked);
  if (panel.endpointInput) {
    panel.endpointInput.value = masked ? maskMiddle(panel.rawEndpoint, 18, 8) : panel.rawEndpoint || "";
  }
  if (panel.keyInput) {
    panel.keyInput.value = masked ? maskMiddle(panel.rawKey, 6, 4) : panel.rawKey || "";
  }
  setSensitiveReadonly(panel, masked);
  if (panel.maskButton) {
    panel.maskButton.innerHTML = ggIcon(masked ? "eye" : "eyeOff", 16);
    panel.maskButton.title = masked ? "显示完整端点和密钥" : "部分隐藏端点和密钥";
    panel.maskButton.setAttribute("aria-label", panel.maskButton.title);
  }
}

function setMaskState(panel, masked) {
  if (!panel) return;
  if (!panel.masked) syncSensitiveRawFromInputs(panel);
  panel.masked = Boolean(masked);
  refreshSensitiveDisplay(panel);
}

async function runConfigTest(panel) {
  if (!panel || panel._testing) return;
  syncSensitiveRawFromInputs(panel);
  panel._testing = true;
  setTestBusy(panel, true);
  setTestStatus(panel, "testing", "测试中...");

  try {
    const response = await api.fetchApi(TEST_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: panel.rawKey || "",
        endpoint: panel.rawEndpoint || "",
        model: panel.modelInput?.value || "",
      }),
      cache: "no-store",
    });

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = { ok: false, message: await response.text() };
    }

    if (!response.ok) {
      throw new Error(data?.message || `HTTP ${response.status}`);
    }

    if (data?.ok) {
      setTestStatus(panel, "success", data.message || "测试成功");
    } else {
      setTestStatus(panel, "error", data?.message || "测试失败");
    }
  } catch (error) {
    setTestStatus(panel, "error", error?.message || String(error));
  } finally {
    panel._testing = false;
    setTestBusy(panel, false);
  }
}

function createInput({ type = "text", placeholder = "", value = "" } = {}) {
  const input = document.createElement("input");
  input.type = type;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.value = String(value || "");
  Object.assign(input.style, inputStyle());
  return input;
}

function createPanel(node, keyWidget, endpointWidget, modelWidget) {
  const stored = readStoredConfig(node);
  const host = document.createElement("div");
  host.className = "gg-key-input-panel";
  Object.assign(host.style, {
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-start",
    gap: "5px",
    height: `${PANEL_HEIGHT}px`,
    boxSizing: "border-box",
    overflow: "hidden",
    padding: "4px 6px",
    pointerEvents: "auto",
  });

  const endpointInput = createInput({
    placeholder: "输入 API Endpoint / Base URL（可选）",
    value: endpointWidget?.value || stored.endpoint,
  });
  endpointInput.className = "gg-key-input-endpoint";

  const modelInput = createInput({
    placeholder: "输入 API 模型名称",
    value: modelWidget?.value || stored.model,
  });
  modelInput.className = "gg-key-input-model";

  const keyRow = document.createElement("div");
  Object.assign(keyRow.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: "0",
    width: "100%",
  });

  const keyInput = createInput({
    type: "text",
    placeholder: "输入 API Key 或访问令牌",
    value: keyWidget.value || stored.key,
  });
  keyInput.className = "gg-key-input-secret";
  keyInput.style.flex = "1 1 auto";

  const testRow = document.createElement("div");
  Object.assign(testRow.style, {
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    columnGap: "8px",
    minWidth: "0",
    width: "100%",
  });

  const buttonGroup = document.createElement("div");
  buttonGroup.className = "gg-key-input-button-group";
  Object.assign(buttonGroup.style, {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    gridColumn: "2",
    justifySelf: "center",
  });

  const testButton = document.createElement("button");
  testButton.type = "button";
  testButton.className = "gg-key-input-test";
  testButton.innerHTML = ggIcon("zap", 16);
  testButton.title = "测试当前配置";
  testButton.setAttribute("aria-label", "测试当前配置");
  Object.assign(testButton.style, buttonStyle());

  const maskButton = document.createElement("button");
  maskButton.type = "button";
  maskButton.className = "gg-key-input-mask";
  Object.assign(maskButton.style, buttonStyle());

  const status = document.createElement("div");
  status.className = "gg-key-input-test-status";
  status.title = "";
  Object.assign(status.style, statusStyle());
  Object.assign(status.style, {
    gridColumn: "3",
    justifySelf: "stretch",
  });

  const panel = {
    host,
    keyInput,
    endpointInput,
    modelInput,
    maskButton,
    testButton,
    status,
    masked: DEFAULT_MASKED,
    rawKey: keyWidget.value || stored.key || "",
    rawEndpoint: endpointWidget?.value || stored.endpoint || "",
  };

  const sync = () => {
    syncSensitiveRawFromInputs(panel);
    syncWidgetValue(keyWidget, panel.rawKey);
    syncWidgetValue(endpointWidget, panel.rawEndpoint);
    syncWidgetValue(modelWidget, modelInput.value);
    saveStoredConfig(node, {
      key: panel.rawKey,
      endpoint: panel.rawEndpoint,
      model: modelInput.value,
    });
  };
  const syncAndReset = () => {
    sync();
    if (!panel._testing) setTestStatus(panel, "idle", "未测试");
  };

  keyInput.addEventListener("input", syncAndReset);
  keyInput.addEventListener("change", syncAndReset);
  endpointInput.addEventListener("input", syncAndReset);
  endpointInput.addEventListener("change", syncAndReset);
  modelInput.addEventListener("input", syncAndReset);
  modelInput.addEventListener("change", syncAndReset);
  maskButton.addEventListener("click", () => {
    setMaskState(panel, !panel.masked);
  });
  testButton.addEventListener("click", () => {
    sync();
    runConfigTest(panel);
  });

  keyRow.append(keyInput);
  buttonGroup.append(testButton, maskButton);
  testRow.append(document.createElement("span"), buttonGroup, status);
  host.append(endpointInput, modelInput, keyRow, testRow);
  sync();
  refreshSensitiveDisplay(panel);
  setTestStatus(panel, "idle", "未测试");
  return panel;
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
  const panelWidth = Math.max(220, nodeWidth - NODE_INSET);
  Object.assign(panel.host.style, {
    width: `${panelWidth}px`,
    minWidth: `${panelWidth}px`,
    maxWidth: `${panelWidth}px`,
  });
}

function fitNode(node) {
  const currentWidth = Number(node.size?.[0]) || MIN_WIDTH;
  const currentHeight = Number(node.size?.[1]) || COMPACT_NODE_HEIGHT;
  const width = Math.max(MIN_WIDTH, currentWidth);
  const shouldShrinkLegacyHeight = currentHeight >= LEGACY_COMPACT_NODE_HEIGHT - 1;
  const height = shouldShrinkLegacyHeight ? COMPACT_NODE_HEIGHT : Math.max(COMPACT_NODE_HEIGHT, currentHeight);
  if (node.ggKeyInputPanel) applyPanelLayout(node.ggKeyInputPanel, width);
  if (width === currentWidth && height === currentHeight) return;
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
    if (Array.isArray(size) && Number(size[1]) < COMPACT_NODE_HEIGHT) size[1] = COMPACT_NODE_HEIGHT;
    if (this.ggKeyInputPanel) applyPanelLayout(this.ggKeyInputPanel, width);
    return result;
  };
}

function syncPanelFromWidgets(node, keyWidget, endpointWidget, modelWidget) {
  const panel = node.ggKeyInputPanel;
  const stored = readStoredConfig(node);
  if (!panel?.keyInput) return;

  panel.rawKey = String(keyWidget.value || stored.key || "");
  panel.rawEndpoint = String(endpointWidget?.value || stored.endpoint || "");
  if (panel.modelInput) {
    panel.modelInput.value = String(modelWidget?.value || stored.model || "");
  }
  refreshSensitiveDisplay(panel);
  syncWidgetValue(keyWidget, panel.rawKey);
  syncWidgetValue(endpointWidget, panel.rawEndpoint);
  syncWidgetValue(modelWidget, panel.modelInput?.value || "");
  saveStoredConfig(node, {
    key: panel.rawKey,
    endpoint: panel.rawEndpoint,
    model: panel.modelInput?.value || "",
  });
  if (!panel._testing) setTestStatus(panel, "idle", "未测试");
}

function setupNode(node) {
  if (!node || (node.comfyClass !== NODE_NAME && node.type !== NODE_NAME)) return;
  const keyWidget = getWidget(node, KEY_WIDGET_NAME);
  const endpointWidget = getWidget(node, ENDPOINT_WIDGET_NAME);
  const modelWidget = getWidget(node, MODEL_WIDGET_NAME);
  if (!keyWidget) return;

  node.serialize_widgets = true;
  hideConfigWidget(keyWidget);
  hideConfigWidget(endpointWidget);
  hideConfigWidget(modelWidget);
  installResizeHook(node);

  if (node.ggKeyInputWidget?.keyInput) {
    syncPanelFromWidgets(node, keyWidget, endpointWidget, modelWidget);
    applyPanelLayout(node.ggKeyInputPanel, node.size?.[0] || MIN_WIDTH);
    requestAnimationFrame(() => fitNode(node));
    return;
  }

  removeExistingPanel(node);
  const panel = createPanel(node, keyWidget, endpointWidget, modelWidget);
  node.ggKeyInputPanel = panel;
  applyPanelLayout(panel, node.size?.[0] || MIN_WIDTH);
  const widget = node.addDOMWidget(DOM_WIDGET_NAME, "gg_key_input", panel.host, {
    getValue() {
      return "";
    },
    setValue() {},
    serialize: false,
  });

  widget.input = panel.keyInput;
  widget.keyInput = panel.keyInput;
  widget.endpointInput = panel.endpointInput;
  widget.modelInput = panel.modelInput;
  widget.maskButton = panel.maskButton;
  widget.testButton = panel.testButton;
  widget.status = panel.status;
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
      return [Math.max(MIN_WIDTH, Number(size?.[0]) || MIN_WIDTH), COMPACT_NODE_HEIGHT];
    };
  },

  nodeCreated(node) {
    setTimeout(() => setupNode(node), 0);
  },

  loadedGraphNode(node) {
    setTimeout(() => setupNode(node), 0);
  },
});
