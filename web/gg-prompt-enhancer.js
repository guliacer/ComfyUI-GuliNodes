import { app } from "../../scripts/app.js";
import { growOnlyHeight } from "./gg-port-list-layout.js";
import {
  forgetHeight,
  rememberHeight,
  resolveHeight,
  storedHeight,
  visibleBottom,
} from "./gg-prompt-enhancer-height.js";

const NODE_TYPE = "GGPromptEnhancer";
const IMAGE_PREFIX = "图片";
const MAX_IMAGES = 20;
const INPUT_TYPE = globalThis.LiteGraph?.INPUT ?? 1;
const HIDDEN_TAG = "ggHiddenPromptEnhancer";

const MODE_AUTO = "自动";
const MODE_T2I = "文生图";
const MODE_I2I = "图生图";
const METHOD_API = "API";
const METHOD_PE = "本地PE";
const METHOD_LLM = "本地LLM";
const UNLOAD_MODES = ["自动", "保持加载", "运行后自动卸载", "运行前后自动卸载"];
const W_LLM_T2I = "文生图LLM模型";
const W_LLM_I2I = "图生图LLM模型";

const widgetState = {};

function isThisNode(node) {
  return node?.comfyClass === NODE_TYPE || node?.type === NODE_TYPE;
}

function isLegacyImageInput(input) {
  return input?.type === "IMAGE" && new RegExp(`^${IMAGE_PREFIX}\\d+$`).test(String(input.name || ""));
}

function hasNativeAutogrow(node) {
  if (node?.comfyDynamic?.autogrow) return true;
  const nodeData = node?.constructor?.nodeData;
  const imageSpec = nodeData?.input?.required?.[IMAGE_PREFIX] ?? nodeData?.input?.optional?.[IMAGE_PREFIX];
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
  if (!slots.length) node.addInput?.(`${IMAGE_PREFIX}1`, "IMAGE");
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
  if (hasNativeAutogrow(node) || type !== INPUT_TYPE) return;
  const input = node.inputs?.[index];
  if (!isLegacyImageInput(input)) return;
  const stack = new Error().stack || "";
  const loading = stack.includes("loadGraphData") || stack.includes("pasteFromClipboard");
  if (!loading && !connected) trimEmptyImageInputs(node);
  if (!loading && connected) ensureTrailingImage(node);
  node.setDirtyCanvas?.(true, true);
}

// ---------- 按 任务模式 + 增强方式 控制参数可见性（不生效不展示） ----------

function widgetByName(node, name) {
  return (node?.widgets || []).find((widget) => widget?.name === name);
}

function widgetValue(node, name) {
  const widget = widgetByName(node, name);
  return widget ? widget.value : undefined;
}

function toggleWidget(node, widget, show) {
  if (!widget) return;
  if (!widgetState[widget.name]) {
    widgetState[widget.name] = { origType: widget.type, origComputeSize: widget.computeSize };
  }
  const state = widgetState[widget.name];
  // 显示时必须先恢复 type:前端在当前 type 属于隐藏类型时会丢弃 hidden 写入。
  if (show) {
    widget.type = state.origType;
    widget.hidden = false;
  } else {
    widget.hidden = true;
    widget.type = HIDDEN_TAG;
  }
  widget.computeSize = show ? state.origComputeSize : () => [0, -4];
}

// seed 旁边的「控制生成后动作」是前端另加的控件，隐藏 seed 时它不会跟着走，
// 单独留在节点上会变成一个孤零零的 randomize 下拉框。
function toggleControlWidget(node, show) {
  for (const widget of node?.widgets || []) {
    if (String(widget?.name || "").endsWith("control_after_generate")) {
      toggleWidget(node, widget, show);
    }
  }
}

function computeVisibility(task, method) {
  const api = method === METHOD_API;
  const pe = method === METHOD_PE;
  const llm = method === METHOD_LLM;
  const i2i = task === MODE_I2I;
  // 「自动」既可能落到反推（用文生图 PE 模型）也可能落到图生图，
  // 两个 PE 模型都留着，免得选了自动却没地方换图生图模型。
  const auto = task === MODE_AUTO;
  return {
    api_key: api,
    api_base_url: api,
    model: api,
    "文生图PE模型": pe && (!i2i || auto),
    "图生图PE模型": pe && (i2i || auto),
    // 本地LLM 与本地PE 同一套口径：显式任务只显示用得上的那个模型，
    // 「自动」可能落到文生图/图生图/反推，两个都留着让用户分别指定。
    [W_LLM_T2I]: llm && (!i2i || auto),
    [W_LLM_I2I]: llm && (i2i || auto),
    "mmproj": llm && (i2i || auto),
    "上下文长度": llm,
    "最大生成token": pe || llm,
    "seed": pe,
    "卸载策略": pe || llm,
  };
}

// ---------- 节点高度记忆 ----------
// growOnlyHeight 只增不减：这节点在加载时 computeSize 会把还没隐藏的控件先算进去，
// 于是每次打开工作流都会被撑回上一次的高度，用户手动拉矮的高度留不住。
// 记住用户拖出来的高度（节点 properties + localStorage 双写），刷新时以记住的为准。
// 纯逻辑在 gg-prompt-enhancer-height.js，便于 Node 侧直接验证。

function refreshSize(node) {
  if (typeof node.computeSize !== "function" || typeof node.setSize !== "function") return;
  const [width, height] = node.computeSize();
  const target = resolveHeight({
    current: node.size?.[1],
    computed: height,
    remembered: storedHeight(node),
    bottom: visibleBottom(node),
    growOnly: growOnlyHeight,
  });
  node._ggAutoHeight = target;
  node.setSize([Math.max(Number(node.size?.[0]) || 0, width), target]);
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function updateVisibility(node) {
  if (!isThisNode(node)) return;
  const task = widgetValue(node, "任务模式") || MODE_AUTO;
  const method = widgetValue(node, "增强方式") || METHOD_API;
  const visibility = computeVisibility(task, method);
  for (const [name, show] of Object.entries(visibility)) {
    toggleWidget(node, widgetByName(node, name), show);
  }
  toggleControlWidget(node, visibility["seed"]);
  refreshSize(node);
  requestAnimationFrame(() => refreshSize(node));
}

function bindSelectors(node) {
  for (const name of ["任务模式", "增强方式"]) {
    const widget = widgetByName(node, name);
    if (!widget || widget._ggEnhancerBound) continue;
    const original = widget.callback;
    widget.callback = function (...args) {
      const result = original?.apply(this, args);
      updateVisibility(node);
      return result;
    };
    widget._ggEnhancerBound = true;
  }
}

// ---------- 本地LLM 参数按最优值对齐 ----------
// 后端已经按同一套规则兜底（低于最优值自动抬高），前端把显示值也改过来，
// 免得界面显示 8192、实际跑 16384，还让人以为要自己调。
const LOCAL_LLM_CONTEXT = 16384;
const LOCAL_LLM_OUTPUT = 1536;

function normalizeLimits(node) {
  const context = widgetByName(node, "上下文长度");
  if (context && Number.isFinite(Number(context.value)) && Number(context.value) < LOCAL_LLM_CONTEXT) {
    context.value = LOCAL_LLM_CONTEXT;
  }
  const output = widgetByName(node, "最大生成token");
  if (output && Number.isFinite(Number(output.value)) && Number(output.value) > LOCAL_LLM_OUTPUT) {
    output.value = LOCAL_LLM_OUTPUT;
  }
}

// ---------- 旧工作流迁移 ----------
// 「生成后自动卸载模型」是个布尔，现在换成了四档下拉框，位置不变（下标 13），
// 所以老工作流打开后这个控件的值是 true/false。不迁移的话下拉框会显示成 "true"。
// 老工作流的 widgets_values 是按下标存的位置数组。新版在下标 9 多了一个
// 「图生图LLM模型」，老存档不补这一位，mmproj / 输入提示词会整体错位一格，
// 而且新版前端按控件数重建 node.inputs 镜像时会在 configure 阶段丢连线。
// 补进去的值取老「主模型」（下标 8），两个任务仍用同一个 GGUF，行为完全不变。
const NEW_WIDGET_COUNT = 19; // 18 个声明控件 + seed 旁的 control_after_generate
function migrateWidgetValues(info) {
  const values = info?.widgets_values;
  if (!Array.isArray(values) || values.length >= NEW_WIDGET_COUNT) return;
  // 新版存档（含 widgets_values_named 且已经有拆开的双模型）只是少了前端自动生成的
  // control_after_generate。按「老主模型」再插一格会把 mmproj / 上下文长度 / seed
  // 全部顶错位，骨架工具生成的 18 位工作流就是这么坏的。
  const named = info?.widgets_values_named;
  if (named && (W_LLM_T2I in named || W_LLM_I2I in named)) {
    if (values.length === 18) values.splice(14, 0, "fixed");
    return;
  }
  const legacyMainModel = values[8] ?? "";
  if (values.length === 18) {
    values.splice(9, 0, legacyMainModel);
  } else if (values.length === 17) {
    // 更早的存档还没有 control_after_generate，先补在 seed 之后（下标 13）。
    values.splice(13, 0, "randomize");
    values.splice(9, 0, legacyMainModel);
  } else if (values.length === 16) {
    // 本仓库老示例工作流（分区编辑 / 人像精修）的格式：下标 13 已经有
    // control_after_generate（旧前端存 true/false），但还没有「透明背景」「增强方向」。
    // 先在 9 插图生图模型，再把旧布尔 control 换成新前端的字符串枚举，最后补尾部两位。
    values.splice(9, 0, legacyMainModel);
    if (typeof values[14] === "boolean") {
      values[14] = values[14] ? "fixed" : "randomize";
    }
    values.push(false, "默认");
  }
}

function normalizeUnload(node) {
  const widget = widgetByName(node, "卸载策略");
  if (!widget) return;
  if (typeof widget.value === "boolean") {
    widget.value = widget.value ? "运行后自动卸载" : "保持加载";
  } else if (!UNLOAD_MODES.includes(widget.value)) {
    widget.value = "自动";
  }
}

// 老存档迁移后两个模型同源；用户后来改了图生图模型就各自独立，不做二次覆盖。
// 另外把老版本里可能误填进主模型的 mmproj 名字挡掉（视觉投影不能当主模型加载）。
function normalizeLlmModels(node) {
  for (const name of [W_LLM_T2I, W_LLM_I2I]) {
    const widget = widgetByName(node, name);
    if (!widget) continue;
    const value = String(widget.value ?? "");
    if (!value || /mmproj|mm-projector|vision-projector/i.test(value)) {
      const options = widget.options?.values;
      const fallback = Array.isArray(options)
        ? options.find((item) => String(item).toLowerCase().endsWith(".gguf")
            && !/mmproj|mm-projector|vision-projector/i.test(String(item)))
        : null;
      if (fallback) widget.value = fallback;
    }
  }
}

function setupNode(node) {
  if (!isThisNode(node)) return;
  bindSelectors(node);
  if (!hasNativeAutogrow(node)) normalizeImageInputs(node);
  normalizeLimits(node);
  normalizeUnload(node);
  normalizeLlmModels(node);
  updateVisibility(node);
  // 补槽位等自动布局走完再钉基准高度，免得把自动变化当成用户拖动记下来。
  node._ggAutoHeight = Number(node.size?.[1]) || Number(node._ggAutoHeight) || 0;
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.PromptEnhancer",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE || nodeType.prototype._ggPromptEnhancerInstalled) return;
    nodeType.prototype._ggPromptEnhancerInstalled = true;

    const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      const result = originalOnConnectionsChange?.apply(this, args);
      handleConnectionChange(this, ...args);
      return result;
    };

    const originalConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (...args) {
      // 必须在原始 configure 之前改：前端按控件数重建 inputs 镜像时数组长度必须对齐。
      migrateWidgetValues(args?.[0]);
      return originalConfigure?.apply(this, args);
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = originalOnConfigure?.apply(this, args);
      setTimeout(() => setupNode(this), 0);
      return result;
    };

    const originalOnResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (...args) {
      const result = originalOnResize?.apply(this, args);
      const height = Number(this.size?.[1] ?? args?.[0]?.[1]);
      const auto = Number(this._ggAutoHeight);
      // 只记用户手动拖出来的高度：自动布局写入的值与 _ggAutoHeight 相同，直接跳过。
      if (Number.isFinite(height) && Number.isFinite(auto) && Math.abs(height - auto) > 1) {
        rememberHeight(this, height);
      }
      return result;
    };

    const originalGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const result = originalGetExtraMenuOptions?.apply(this, arguments);
      const list = Array.isArray(options) ? options : Array.isArray(result) ? result : null;
      if (list) {
        list.push(null);
        list.push({
          content: "清除记住的节点高度",
          callback: () => {
            forgetHeight(this);
            this._ggAutoHeight = Number(this.size?.[1]) || 0;
            refreshSize(this);
          },
        });
      }
      return result ?? list;
    };
  },

  nodeCreated(node) {
    setTimeout(() => setupNode(node), 0);
  },

  loadedGraphNode(node) {
    setTimeout(() => setupNode(node), 0);
  },
});

