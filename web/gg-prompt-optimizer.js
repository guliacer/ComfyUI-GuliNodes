import { app } from "../../scripts/app.js";

const NODE_TYPE = "GGPromptOptimizer";
const IMAGE_PREFIX = "图像";
const MAX_IMAGES = 20;
const INPUT_TYPE = globalThis.LiteGraph?.INPUT ?? 1;

function isLegacyImageInput(input) {
  return input?.type === "IMAGE" && new RegExp(`^${IMAGE_PREFIX}\\d+$`).test(String(input.name || ""));
}

function hasNativeAutogrow(node) {
  if (node?.comfyDynamic?.autogrow) return true;

  // The native dynamic state can be attached one tick after the node
  // instance is created. Check the schema and generated slot names too, so
  // the legacy fallback cannot add a duplicate input during that window.
  const nodeData = node?.constructor?.nodeData;
  const imageSpec = nodeData?.input?.required?.[IMAGE_PREFIX]
    ?? nodeData?.input?.optional?.[IMAGE_PREFIX];
  return imageSpec?.[0] === "COMFY_AUTOGROW_V3"
    || (node?.inputs || []).some((input) => String(input?.name || "").startsWith(`${IMAGE_PREFIX}.`));
}

function imageInputs(node) {
  return (node?.inputs || []).filter(isLegacyImageInput);
}

function imageNumber(input) {
  const match = String(input?.name || "").match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function updateImageLabel(input) {
  if (!input) return;
  const number = imageNumber(input);
  input.label = number ? `${IMAGE_PREFIX}${number}` : IMAGE_PREFIX;
}

function ensureTrailingImage(node) {
  const slots = imageInputs(node).sort((a, b) => imageNumber(a) - imageNumber(b));
  if (!slots.length) {
    node.addInput?.(`${IMAGE_PREFIX}1`, "IMAGE");
  }
  const current = imageInputs(node).sort((a, b) => imageNumber(a) - imageNumber(b));
  current.forEach(updateImageLabel);
  const last = current.at(-1);
  if (last?.link != null && current.length < MAX_IMAGES) {
    const next = imageNumber(last) + 1;
    if (next <= MAX_IMAGES && !current.some((input) => input.name === `${IMAGE_PREFIX}${next}`)) {
      node.addInput?.(`${IMAGE_PREFIX}${next}`, "IMAGE");
      updateImageLabel(node.inputs?.at(-1));
    }
  }
}

function trimEmptyImageInputs(node) {
  let slots = imageInputs(node).sort((a, b) => imageNumber(a) - imageNumber(b));
  while (slots.length > 1) {
    const last = slots.at(-1);
    const previous = slots.at(-2);
    if (last?.link != null || previous?.link != null) break;
    const index = node.inputs.indexOf(last);
    if (index < 0 || !node.removeInput) break;
    node.removeInput(index);
    slots = imageInputs(node).sort((a, b) => imageNumber(a) - imageNumber(b));
  }
  slots.forEach(updateImageLabel);
}

function normalizeImageInputs(node) {
  if (!node || !node.addInput) return;
  trimEmptyImageInputs(node);
  ensureTrailingImage(node);
  node.setDirtyCanvas?.(true, true);
}

function handleConnectionChange(node, type, index, connected) {
  if (hasNativeAutogrow(node)) return;
  if (type !== INPUT_TYPE) return;
  const input = node.inputs?.[index];
  if (!isLegacyImageInput(input)) return;

  const stack = new Error().stack || "";
  const loading = stack.includes("loadGraphData") || stack.includes("pasteFromClipboard");
  if (!loading && !connected) trimEmptyImageInputs(node);
  if (!loading && connected) ensureTrailingImage(node);
  node.setDirtyCanvas?.(true, true);
}

function setupNode(node) {
  if (node?.comfyClass !== NODE_TYPE && node?.type !== NODE_TYPE) return;
  updateReferenceWidgetVisibility(node);
  // Newer ComfyUI versions manage this schema with native Autogrow. The
  // fallback below is only for legacy node definitions without that support.
  if (hasNativeAutogrow(node)) return;
  normalizeImageInputs(node);
}

function markManualHeightResize(node) {
  if (!node || (node.comfyClass !== NODE_TYPE && node.type !== NODE_TYPE)) return;
  const canvas = app.canvas || globalThis.LGraphCanvas?.active_canvas;
  if (canvas?.resizing_node === node) {
    node._ggPromptOptimizerManualHeight = true;
  }
}

// ---------------------------------------------------------------------------
// 参考图相关参数只在接入了参考图时生效
// （guli_nodes/prompt_optimizer.py → _encode_qwen_image21：VAE 与 分辨率 都只在
// 遍历 _ordered_images(images) 时被读取，没有参考图时两者都不会被用到）。
// 因此未接入参考图时把「VAE名称」「分辨率」隐藏，接入后自动恢复。
// ---------------------------------------------------------------------------

const REFERENCE_ONLY_WIDGETS = ["VAE名称", "分辨率"];
const REFERENCE_HIDDEN_TAG = "ggHiddenPromptOptimizer";
const referenceWidgetState = {};

function hasReferenceImage(node) {
  return (node?.inputs || []).some((input) => input?.type === "IMAGE" && input.link != null);
}

function toggleReferenceWidget(node, widget, show) {
  if (!widget) return;
  if (!referenceWidgetState[widget.name]) {
    referenceWidgetState[widget.name] = {
      origType: widget.type,
      origComputeSize: widget.computeSize,
    };
  }
  const state = referenceWidgetState[widget.name];
  widget.hidden = !show;
  widget.type = show ? state.origType : REFERENCE_HIDDEN_TAG;
  widget.computeSize = show ? state.origComputeSize : () => [0, -4];
}

function refreshReferenceNodeSize(node) {
  if (typeof node.computeSize === "function" && typeof node.setSize === "function") {
    const [width, height] = node.computeSize();
      const currentHeight = Number(node.size?.[1]) || 0;
      const preservedHeight = node._ggPromptOptimizerManualHeight === true
        ? currentHeight
        : height;
      node.setSize([Math.max(Number(node.size?.[0]) || 0, width), preservedHeight]);
  }
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function updateReferenceWidgetVisibility(node) {
  if (node?.comfyClass !== NODE_TYPE && node?.type !== NODE_TYPE) return;
  const show = hasReferenceImage(node);
  for (const name of REFERENCE_ONLY_WIDGETS) {
    toggleReferenceWidget(node, (node.widgets || []).find((widget) => widget?.name === name), show);
  }
  refreshReferenceNodeSize(node);
  requestAnimationFrame(() => refreshReferenceNodeSize(node));
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.PromptOptimizer",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE || nodeType.prototype._ggPromptOptimizerInstalled) return;
    nodeType.prototype._ggPromptOptimizerInstalled = true;

      const originalOnResize = nodeType.prototype.onResize;
      nodeType.prototype.onResize = function (...args) {
        markManualHeightResize(this);
        return originalOnResize?.apply(this, args);
      };

      const originalComputeSize = nodeType.prototype.computeSize;
      nodeType.prototype.computeSize = function (...args) {
        const size = originalComputeSize?.apply(this, args);
        if (this?._ggPromptOptimizerManualHeight === true && Array.isArray(size)) {
          return [size[0], Number(this.size?.[1]) || size[1]];
        }
        return size;
      };

    const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      const result = originalOnConnectionsChange?.apply(this, args);
      handleConnectionChange(this, ...args);
      updateReferenceWidgetVisibility(this);
      return result;
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = originalOnConfigure?.apply(this, args);
      setTimeout(() => setupNode(this), 0);
      return result;
    };
  },

  nodeCreated(node) {
    setTimeout(() => setupNode(node), 0);
  },

  loadedGraphNode(node) {
    setTimeout(() => setupNode(node), 0);
  },
});
