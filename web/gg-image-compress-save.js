import { app } from "../../scripts/app.js";

const NODE_NAME = "GGImageCompressSave";
const FORMAT_WIDGET_NAME = "格式";
const MODE_WIDGET_NAME = "压缩模式";
const QUALITY_WIDGET_NAME = "质量";
const TARGET_SIZE_WIDGET_NAME = "目标大小KB";
const LEGACY_SEGMENT_WIDGET_NAME = "压缩模式选择";
const DEFAULT_FORMAT = "JPEG";
const DEFAULT_MODE = "civilblur";
const DEFAULT_QUALITY = 85;
const DEFAULT_TARGET_SIZE = 0;

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

function setupNode(node) {
  if (!isTargetNode(node)) return;
  node.serialize_widgets = true;
  removeLegacySegmentWidgets(node);
  restoreModeWidget(getWidget(node, MODE_WIDGET_NAME));
  sanitizeWidgetValues(node);
  applyDefaultFormat(node);
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.ImageCompressSave",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalOnNodeCreated?.apply(this, args);
      requestAnimationFrame(() => setupNode(this));
      return result;
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = originalOnConfigure?.apply(this, args);
      requestAnimationFrame(() => setupNode(this));
      return result;
    };
  },

  loadedGraphNode(node) {
    if (!isTargetNode(node)) return;
    requestAnimationFrame(() => setupNode(node));
  },
});
