import { app } from "../../scripts/app.js";
import {
  connectLoaderToInput,
  createLoaderNode,
  findCompatibleLoader,
} from "./gg-loader-migration.js";

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

const LEGACY_MODELS_PROPERTY = "_ggLegacyPromptOptimizerModelsV1";
const LEGACY_MODEL_INPUTS = ["CLIP名称", "CLIP类型", "VAE名称"];

function normalizeLegacyModel(value) {
  const model = String(value ?? "").trim();
  return !model || model.startsWith("（") ? "" : model;
}

function migrateWidgetValues(info) {
  const values = Array.isArray(info?.widgets_values) ? info.widgets_values : null;
  const named = info?.widgets_values_named;
  const inputs = Array.isArray(info?.inputs) ? info.inputs : [];
  const oldNamed = named && LEGACY_MODEL_INPUTS.some((name) => name in named);
  const oldInputs = inputs.some((input) => LEGACY_MODEL_INPUTS.includes(input?.name));
  const oldValues = values && values.length >= 6
    && /\.safetensors$/i.test(String(values[0] ?? ""))
    && /\.safetensors$/i.test(String(values[2] ?? ""));
  if (!values || (!oldNamed && !oldInputs && !oldValues)) return;

  const legacyModels = {
    clip: normalizeLegacyModel(named?.["CLIP名称"] ?? values[0]),
    clipType: String(named?.["CLIP类型"] ?? values[1] ?? "").trim(),
    vae: normalizeLegacyModel(named?.["VAE名称"] ?? values[2]),
  };
  if (legacyModels.clip || legacyModels.vae) {
    info.properties = info.properties && typeof info.properties === "object" ? info.properties : {};
    info.properties[LEGACY_MODELS_PROPERTY] = legacyModels;
  }

  const positive = String(named?.["正向提示词"] ?? values[4] ?? "");
  const negative = String(named?.["负向提示词"] ?? values[5] ?? "");
  const resolution = Number(named?.["分辨率"] ?? values[3] ?? 1024);
  info.widgets_values = [positive, negative, Number.isFinite(resolution) ? resolution : 1024];
  if (named && typeof named === "object") {
    for (const name of LEGACY_MODEL_INPUTS) delete named[name];
    named["正向提示词"] = positive;
    named["负向提示词"] = negative;
    named["分辨率"] = Number.isFinite(resolution) ? resolution : 1024;
  }

  // 旧版把模型选择器也镜像成输入项；保留会让新节点多出一条无法生效的端口。
  info.inputs = inputs.filter((input) => !LEGACY_MODEL_INPUTS.includes(input?.name));
  const connectable = info.properties?.ue_properties?.widget_ue_connectable;
  if (connectable && typeof connectable === "object") {
    for (const name of LEGACY_MODEL_INPUTS) delete connectable[name];
  }
}

function migrateLegacyLoaders(node) {
  const properties = node?.properties;
  const legacy = properties?.[LEGACY_MODELS_PROPERTY];
  if (!legacy || typeof legacy !== "object") return false;
  const graph = node.graph || globalThis.app?.graph;
  if (!graph || typeof graph.add !== "function") return false;

  const x = Number(node.pos?.[0] || 0) - 380;
  const y = Number(node.pos?.[1] || 0);
  const clipModel = normalizeLegacyModel(legacy.clip);
  const vaeModel = normalizeLegacyModel(legacy.vae);
  const clipType = String(legacy.clipType || "qwen_image").trim() || "qwen_image";
  const specs = [
    {
      model: clipModel,
      nodeType: "CLIPLoader",
      inputName: "clip",
      values: { clip_name: clipModel, type: clipType },
      title: "CLIP（提示词优化迁移）",
      position: [x, y - 110],
    },
    {
      model: vaeModel,
      nodeType: "VAELoader",
      inputName: "vae",
      values: { vae_name: vaeModel },
      title: "VAE（提示词优化迁移）",
      position: [x, y + 120],
    },
  ];
  const byKey = new Map();
  let complete = true;
  for (const spec of specs) {
    if (!spec.model) continue;
    const input = (node.inputs || []).find((item) => item?.name === spec.inputName);
    if (!input) {
      complete = false;
      continue;
    }
    if (input.link != null) continue;

    const key = JSON.stringify([spec.nodeType, spec.values]);
    let loader = byKey.get(key) || findCompatibleLoader(graph, spec.nodeType, spec.values);
    let created = false;
    if (!loader) {
      loader = createLoaderNode(graph, spec.nodeType, {
        values: spec.values,
        title: spec.title,
        position: spec.position,
      });
      if (!loader) {
        complete = false;
        continue;
      }
      created = true;
    }
    if (!connectLoaderToInput(loader, node, spec.inputName)) {
      if (created) graph.remove?.(loader);
      complete = false;
      continue;
    }
    byKey.set(key, loader);
  }

  if (complete) {
    delete properties[LEGACY_MODELS_PROPERTY];
    graph.setDirtyCanvas?.(true, true);
  }
  return complete;
}

function setupNode(node) {
  if (node?.comfyClass !== NODE_TYPE && node?.type !== NODE_TYPE) return;
  updateReferenceWidgetVisibility(node);
  migrateLegacyLoaders(node);
  // Newer ComfyUI versions manage this schema with native Autogrow. The
  // fallback below is only for legacy node definitions without that support.
  if (hasNativeAutogrow(node)) return;
  normalizeImageInputs(node);
}

// ---------------------------------------------------------------------------
// 分辨率只在接入参考图时生效；VAE 是外接模型端口，保持原生端口显示。
// ---------------------------------------------------------------------------

const REFERENCE_ONLY_WIDGETS = ["分辨率"];
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
  // 显示时必须先恢复 type:前端在当前 type 属于隐藏类型时会丢弃 hidden 写入。
  if (show) {
    widget.type = state.origType;
    widget.hidden = false;
  } else {
    widget.hidden = true;
    widget.type = REFERENCE_HIDDEN_TAG;
  }
  widget.computeSize = show ? state.origComputeSize : () => [0, -4];
}

function refreshReferenceNodeSize(node) {
  // 对齐官方 Qwen 文本编码节点：完全不接管高度。切换参考图专属的「分辨率」显隐时
  // 只把宽度补足到能容纳控件，高度原样保留，交给原生布局与用户自由拉伸/压低
  // （多行框随节点缩放滚动）。绝不写高度，避免任何「只增不减」的棘轮。
  if (typeof node.computeSize === "function" && typeof node.setSize === "function") {
    const [width] = node.computeSize();
    const currentWidth = Number(node.size?.[0]) || 0;
    const currentHeight = Number(node.size?.[1]) || 0;
    node.setSize([Math.max(currentWidth, Number(width) || 0), currentHeight]);
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

    const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      const result = originalOnConnectionsChange?.apply(this, args);
      handleConnectionChange(this, ...args);
      updateReferenceWidgetVisibility(this);
      return result;
    };

    const originalConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (...args) {
      // 旧存档必须在下发控件值前改布局，否则模型文件名会灌进提示词框。
      migrateWidgetValues(args?.[0]);
      return originalConfigure?.apply(this, args);
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
