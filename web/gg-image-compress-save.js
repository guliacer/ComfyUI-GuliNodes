import { app } from "../../scripts/app.js";

const NODE_NAME = "GGImageCompressSave";
const FORMAT_WIDGET_NAME = "格式";
const MODE_WIDGET_NAME = "压缩模式";
const QUALITY_WIDGET_NAME = "质量";
const TARGET_SIZE_WIDGET_NAME = "目标大小KB";
const LEGACY_SEGMENT_WIDGET_NAME = "压缩模式选择";
const PREVIEW_WIDGET_NAME = "$$canvas-image-preview";
const DEFAULT_FORMAT = "JPEG";
const DEFAULT_MODE = "civilblur";
const DEFAULT_QUALITY = 85;
const DEFAULT_TARGET_SIZE = 0;
const HIDDEN_TAG = "ggHiddenCompressSave";
const LOCK_CLASS = "gg-compress-save-size-lock";
const STYLE_ID = "gg-compress-save-size-lock-style";
const NEW_NODE_LOCK_DELAY_MS = 50;
const RESTORE_DELAYS_MS = [0, 80];

function isTargetNode(node) {
  return node?.comfyClass === NODE_NAME || node?.type === NODE_NAME;
}

function getWidget(node, name) {
  return node.widgets?.find((widget) => widget?.name === name) ?? null;
}

function coerceModeValue(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "civilblur") return "civilblur";
  if (text === "caesium" || text === "cesium") return "Caesium";
  if (text === "meowtec" || text === "meow") return "meowtec";
  return null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isCollapsed(node) {
  return node?.flags?.collapsed === true || node?.collapsed === true;
}

function isUserResizing(node) {
  const canvas = app.canvas || globalThis.LGraphCanvas?.active_canvas;
  return canvas?.resizing_node === node;
}

function readNodeSize(node) {
  const width = Number(node?.size?.[0]);
  const height = Number(node?.size?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return [width, height];
}

function readContentSize(node) {
  if (typeof node?.computeSize !== "function") return null;
  const size = node.computeSize();
  const width = Number(size?.[0]);
  const height = Number(size?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) return null;
  return [width, height];
}

function rememberSize(node, size = readNodeSize(node)) {
  if (!size) return;
  node._ggCompressSaveSize = [size[0], size[1]];
  node._ggCompressSaveSizeLocked = true;
  node._ggCompressSaveEpoch = (node._ggCompressSaveEpoch || 0) + 1;
}

function sameSize(left, right) {
  return Boolean(left && right)
    && Math.abs(left[0] - right[0]) < 0.5
    && Math.abs(left[1] - right[1]) < 0.5;
}

function applySize(node, size) {
  if (!size || isCollapsed(node)) return;
  const next = [Number(size[0]), Number(size[1])];
  if (!Number.isFinite(next[0]) || !Number.isFinite(next[1]) || next[0] <= 0 || next[1] <= 0) return;
  if (sameSize(readNodeSize(node), next)) {
    pinDom(node);
    return;
  }
  node._ggCompressSaveApplying = true;
  try {
    if (typeof node.setSize === "function") node.setSize(next);
    else node.size = next;
  } finally {
    node._ggCompressSaveApplying = false;
  }
  pinDom(node);
}

function setWidgetValue(node, widget, value) {
  if (!widget || widget.value === value) return;
  const oldValue = widget.value;
  widget.value = value;
  node.properties ??= {};
  node.properties[widget.name] = value;
  try {
    widget.callback?.(value);
  } catch {
    // Widget callbacks differ across ComfyUI versions.
  }
  node.onWidgetChanged?.(widget.name, value, oldValue, widget);
}

function applyDefaultFormat(node) {
  const formatWidget = getWidget(node, FORMAT_WIDGET_NAME);
  if (!formatWidget || node.properties?._ggCompressSaveFormatInitialized) return;
  if (!formatWidget.value || formatWidget.value === "自动") {
    setWidgetValue(node, formatWidget, DEFAULT_FORMAT);
  }
  node.properties ??= {};
  node.properties._ggCompressSaveFormatInitialized = true;
}

function removeLegacySegmentWidgets(node) {
  if (!Array.isArray(node.widgets)) return;
  for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
    const widget = node.widgets[index];
    if (widget?.name !== LEGACY_SEGMENT_WIDGET_NAME) continue;
    widget.onRemoved?.();
    node.widgets.splice(index, 1);
  }
}

function restoreModeWidget(widget) {
  if (!widget) return;
  widget.hidden = false;
  widget.serialize = true;

  const hadCustomState = Boolean(
    widget._ggOriginalType ||
    widget._ggOriginalComputeSize ||
    widget._ggCompressModeHidden ||
    widget._ggCompressModeSegmentInstalled
  );
  if (!hadCustomState) return;

  widget.type = widget._ggOriginalType || "combo";

  if (widget._ggOriginalComputeSize) {
    widget.computeSize = widget._ggOriginalComputeSize;
  } else {
    delete widget.computeSize;
  }

  delete widget.draw;
  delete widget.mouse;
  delete widget._ggCompressModeHidden;
  delete widget._ggCompressModeSegmentInstalled;
}

function sanitizeWidgetValues(node) {
  const modeWidget = getWidget(node, MODE_WIDGET_NAME);
  const qualityWidget = getWidget(node, QUALITY_WIDGET_NAME);
  const targetWidget = getWidget(node, TARGET_SIZE_WIDGET_NAME);

  const mode =
    coerceModeValue(modeWidget?.value) ??
    coerceModeValue(qualityWidget?.value) ??
    coerceModeValue(node.properties?.[MODE_WIDGET_NAME]) ??
    DEFAULT_MODE;
  if (modeWidget) setWidgetValue(node, modeWidget, mode);

  let quality = finiteNumber(qualityWidget?.value);
  let targetSize = finiteNumber(targetWidget?.value);

  if (quality == null && qualityWidget) {
    if (targetSize != null && targetSize >= 1 && targetSize <= 100) {
      setWidgetValue(node, qualityWidget, Math.round(targetSize));
      if (targetWidget) setWidgetValue(node, targetWidget, DEFAULT_TARGET_SIZE);
      targetSize = DEFAULT_TARGET_SIZE;
    } else {
      setWidgetValue(node, qualityWidget, DEFAULT_QUALITY);
    }
    quality = finiteNumber(qualityWidget.value);
  }

  if (qualityWidget && quality != null) {
    const clampedQuality = Math.max(1, Math.min(100, Math.round(quality)));
    setWidgetValue(node, qualityWidget, clampedQuality);
  }

  if (targetWidget) {
    if (targetSize == null) targetSize = DEFAULT_TARGET_SIZE;
    const clampedTarget = Math.max(0, Math.round(targetSize));
    setWidgetValue(node, targetWidget, clampedTarget);
  }
}

function widgetOriginalState(widget) {
  if (!widget._ggCompressSaveOriginal) {
    widget._ggCompressSaveOriginal = {
      type: widget.type,
      computeSize: widget.computeSize,
    };
  }
  const state = widget._ggCompressSaveOriginal;
  if (state.type === HIDDEN_TAG && widget.type && widget.type !== HIDDEN_TAG) {
    state.type = widget.type;
    state.computeSize = widget.computeSize;
  }
  return state;
}

function toggleHiddenWidget(widget, show) {
  if (!widget) return;
  const state = widgetOriginalState(widget);
  widget.hidden = !show;
  widget.type = show ? state.type : HIDDEN_TAG;
  widget.computeSize = show ? state.computeSize : () => [0, -4];
}

function updateFormatVisibility(node, { resize = false, lock = false } = {}) {
  const formatWidget = getWidget(node, FORMAT_WIDGET_NAME);
  const show = String(formatWidget?.value ?? "") !== "PNG";
  const before = resize ? readContentSize(node) : null;
  const current = resize ? readNodeSize(node) : null;
  toggleHiddenWidget(getWidget(node, QUALITY_WIDGET_NAME), show);
  toggleHiddenWidget(getWidget(node, TARGET_SIZE_WIDGET_NAME), show);
  if (resize && before && current && !isCollapsed(node)) {
    const after = readContentSize(node);
    if (after) {
      const nextHeight = Math.max(after[1], current[1] + after[1] - before[1]);
      const nextWidth = Math.max(current[0], after[0]);
      applySize(node, [nextWidth, nextHeight]);
      if (lock) rememberSize(node);
    }
  }
  pinDom(node);
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function installFormatVisibility(node) {
  const formatWidget = getWidget(node, FORMAT_WIDGET_NAME);
  if (!formatWidget || formatWidget._ggCompressSaveVisibilityInstalled) return;
  const originalCallback = formatWidget.callback;
  formatWidget.callback = function (...args) {
    const result = originalCallback?.apply(this, args);
    if (node._ggCompressSaveSuppressResize) return result;
    updateFormatVisibility(node, { resize: true, lock: true });
    return result;
  };
  formatWidget._ggCompressSaveVisibilityInstalled = true;
}

function relaxPreviewWidgets(node) {
  for (const widget of node?.widgets ?? []) {
    if (widget?.name !== PREVIEW_WIDGET_NAME || widget._ggCompressSavePreviewRelaxed) continue;
    widget._ggCompressSavePreviewRelaxed = true;
    widget.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 8192, minWidth: 1 });
  }
}

function installPreviewGuard(node) {
  if (!node || node._ggCompressSavePreviewGuard || typeof node.addCustomWidget !== "function") return;
  node._ggCompressSavePreviewGuard = true;
  const original = node.addCustomWidget;
  node.addCustomWidget = function (widget, ...args) {
    const result = original.call(this, widget, ...args);
    relaxPreviewWidgets(this);
    return result;
  };
}

function injectStyle() {
  if (typeof document === "undefined" || !document.head || document.getElementById?.(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .lg-node.${LOCK_CLASS} .image-preview {
      min-height: 0 !important;
      overflow: hidden;
    }
  `;
  document.head.append(style);
}

function findLiveNode(id) {
  const text = String(id ?? "");
  if (!text) return null;
  const graphs = [];
  const canvasGraph = app.canvas?.graph;
  const appGraph = app.graph;
  if (canvasGraph) graphs.push(canvasGraph);
  if (appGraph && appGraph !== canvasGraph) graphs.push(appGraph);
  for (const graph of graphs) {
    const numeric = Number(text);
    const direct = graph.getNodeById?.(text) ?? (Number.isFinite(numeric) ? graph.getNodeById?.(numeric) : null);
    if (direct) return direct;
    const nodes = graph._nodes || graph.nodes;
    if (!Array.isArray(nodes)) continue;
    const found = nodes.find((node) => String(node?.id) === text);
    if (found) return found;
  }
  return null;
}

function domNodeElement(node) {
  if (!node?.id || typeof document === "undefined" || typeof document.querySelectorAll !== "function") return null;
  const id = String(node.id).replace(/"/g, "");
  if (!id) return null;
  const candidates = document.querySelectorAll(`.lg-node[data-node-id="${id}"], [data-node-id="${id}"].lg-node`);
  return candidates[0] ?? null;
}

function isHtmlElement(value) {
  return typeof HTMLElement !== "undefined" && value instanceof HTMLElement;
}

function pinDom(node) {
  if (!isTargetNode(node)) return;
  injectStyle();
  const cached = node._ggCompressSaveElement;
  if (cached?.isConnected) {
    cached.classList.add(LOCK_CLASS);
    return;
  }
  const element = domNodeElement(node);
  if (!isHtmlElement(element)) return;
  element.classList.add(LOCK_CLASS);
  node._ggCompressSaveElement = element;
}

function tagAdded(root) {
  if (!isHtmlElement(root)) return;
  const elements = [];
  if (root.matches?.(".lg-node[data-node-id], [data-node-id].lg-node")) elements.push(root);
  if (typeof root.querySelectorAll === "function") {
    for (const element of root.querySelectorAll(".lg-node[data-node-id], [data-node-id].lg-node")) {
      elements.push(element);
    }
  }
  for (const element of elements) {
    const node = findLiveNode(element.dataset?.nodeId);
    if (!isTargetNode(node)) continue;
    element.classList.add(LOCK_CLASS);
    node._ggCompressSaveElement = element;
  }
}

function installMountWatcher() {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  if (installMountWatcher.root?.isConnected && installMountWatcher.observer) return;
  let attempts = installMountWatcher.attempts || 0;
  const start = () => {
    if (installMountWatcher.root?.isConnected && installMountWatcher.observer) return;
    const root = document.querySelector?.("[data-testid='transform-pane']");
    if (!root) {
      installMountWatcher.attempts = attempts + 1;
      if (installMountWatcher.attempts < 180) requestAnimationFrame(start);
      return;
    }
    attempts = 0;
    installMountWatcher.attempts = 0;
    installMountWatcher.root = root;
    const pending = [];
    let queued = false;
    const flush = () => {
      queued = false;
      const batch = pending.splice(0);
      for (const added of batch) tagAdded(added);
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) {
          if (added instanceof HTMLElement) pending.push(added);
        }
      }
      if (!queued && pending.length) {
        queued = true;
        requestAnimationFrame(flush);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    installMountWatcher.observer = observer;
    tagAdded(root);
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(start);
  else start();
}

function scheduleRestore(node) {
  const epoch = node._ggCompressSaveEpoch || 0;
  const run = () => {
    if ((node._ggCompressSaveEpoch || 0) !== epoch) return;
    if (!node._ggCompressSaveSizeLocked) return;
    relaxPreviewWidgets(node);
    applySize(node, node._ggCompressSaveSize);
    pinDom(node);
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  for (const delay of RESTORE_DELAYS_MS) setTimeout(run, delay);
}

function scheduleLockNewNode(node) {
  setTimeout(() => {
    if (node._ggCompressSaveSizeLocked) return;
    const size = readNodeSize(node);
    if (size) node._ggCompressSaveSize = size;
    node._ggCompressSaveSizeLocked = true;
    pinDom(node);
  }, NEW_NODE_LOCK_DELAY_MS);
}

function setupNode(node, mode) {
  if (!isTargetNode(node)) return;
  node.serialize_widgets = true;
  node._ggCompressSaveSuppressResize = true;
  try {
    removeLegacySegmentWidgets(node);
    restoreModeWidget(getWidget(node, MODE_WIDGET_NAME));
    sanitizeWidgetValues(node);
    installPreviewGuard(node);
    installFormatVisibility(node);
    updateFormatVisibility(node, { resize: mode === "create", lock: false });
    applyDefaultFormat(node);
  } finally {
    node._ggCompressSaveSuppressResize = false;
  }
  relaxPreviewWidgets(node);
  if (mode === "restore") scheduleRestore(node);
  else scheduleLockNewNode(node);
  pinDom(node);
  node.setDirtyCanvas?.(true, true);
}

function installPrototypeHooks(nodeType) {
  if (nodeType.prototype._ggCompressSaveHooksInstalled) return;
  nodeType.prototype._ggCompressSaveHooksInstalled = true;

  const originalOnResize = nodeType.prototype.onResize;
  nodeType.prototype.onResize = function (...args) {
    if (isTargetNode(this) && !this._ggCompressSaveApplying && isUserResizing(this)) {
      const size = readNodeSize(this);
      if (size) this._ggCompressSaveSize = size;
      this._ggCompressSaveSizeLocked = true;
      this._ggCompressSaveEpoch = (this._ggCompressSaveEpoch || 0) + 1;
      pinDom(this);
    }
    return originalOnResize?.apply(this, args);
  };

  const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function (...args) {
    if (isTargetNode(this)) {
      relaxPreviewWidgets(this);
      pinDom(this);
    }
    return originalOnDrawBackground?.apply(this, args);
  };

  const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function (...args) {
    const result = originalOnNodeCreated?.apply(this, args);
    installPreviewGuard(this);
    requestAnimationFrame(() => {
      setupNode(this, this._ggCompressSaveSizeLocked ? "restore" : "create");
    });
    return result;
  };

  const originalOnConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function (...args) {
    this._ggCompressSaveSizeLocked = true;
    const size = readNodeSize(this);
    if (size) this._ggCompressSaveSize = size;
    this._ggCompressSaveEpoch = (this._ggCompressSaveEpoch || 0) + 1;
    installPreviewGuard(this);
    const result = originalOnConfigure?.apply(this, args);
    requestAnimationFrame(() => setupNode(this, "restore"));
    return result;
  };
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.ImageCompressSave",

  setup() {
    injectStyle();
    installMountWatcher();
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    installPrototypeHooks(nodeType);
  },

  nodeCreated(node) {
    if (!isTargetNode(node)) return;
    installPreviewGuard(node);
  },

  loadedGraphNode(node) {
    if (!isTargetNode(node)) return;
    installPreviewGuard(node);
    requestAnimationFrame(() => setupNode(node, "restore"));
  },
});
