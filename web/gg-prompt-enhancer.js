import { app } from "../../scripts/app.js";
import { growOnlyHeight } from "./gg-port-list-layout.js";
import { skinColorsFor } from "./gg-widget-rows.js";
import {
  connectLoaderToInput,
  createLoaderNode,
  findCompatibleLoader,
} from "./gg-loader-migration.js";
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

// ---------- 已接线控件：标出「连在哪」 ----------
// 子图里把「编辑需求」「seed」提升成输入后，前端会把控件藏起来、只留一个没有名字的
// 端口点：文本区还会按原高度（实测 318px）继续占位，节点中间留下一大片空白，
// 用户根本看不出这两条线落在哪。做法：
//   1. 被藏起来的控件收成一行（记住原尺寸，断开后恢复）；
//   2. 在该行画一条和其它参数一致的底格，左边写控件名、右边写「上游输入」，
//      让端口点有了明确的归属。
const WIRED_WIDGETS = ["seed", "输入提示词"];
const WIRED_ROW_H = 20;      // computeSize 返回值，宿主会 +4 得到 24 的行高
const WIRED_ROW_BOX = 24;    // 宿主实际使用的行高
const WIRED_LABEL = "← 上游输入";

function mirrorInput(node, name) {
  return (node?.inputs || []).find((input) => input?.widget?.name === name) ?? null;
}

function isWidgetWired(node, widget) {
  const input = mirrorInput(node, widget?.name);
  return !!input && input.link != null;
}

function syncWiredRows(node) {
  let changed = false;
  let restored = false;
  for (const name of WIRED_WIDGETS) {
    const widget = widgetByName(node, name);
    if (!widget) continue;
    const wired = isWidgetWired(node, widget);
    // 之前被「不生效不展示」藏起来的控件，接线后要还回真实类型：
    // 否则引擎把它当隐藏控件，连端口点的锚定行都不会留。
    if (wired && widget.type === HIDDEN_TAG) {
      const saved = widgetState[widget.name];
      if (saved?.origType) widget.type = saved.origType;
    }
    // 只有被前端藏起来的控件才需要收行：控件还显示着时收行会把多行文本区压成一条。
    const collapse = wired && widget.hidden === true;
    if (collapse === (widget._ggWired === true)) continue;
    if (collapse) {
      // 记下接线前的节点高度：断开时引擎可能已经把节点按「没有多行文本区」收矮过，
      // 这里要能把它还原回接线前的尺寸。
      if (node._ggWiredBaseHeight == null) {
        node._ggWiredBaseHeight = Math.round(Number(node.size?.[1]) || 0);
      }
      widget._ggWired = true;
      widget._ggWiredSize = {
        computeSize: widget.computeSize,
        computedHeight: widget.computedHeight,
      };
      widget.computeSize = () => [0, WIRED_ROW_H];
      widget.computedHeight = WIRED_ROW_BOX;
    } else {
      restored = true;
      delete widget._ggWired;
      const saved = widget._ggWiredSize;
      delete widget._ggWiredSize;
      if (saved) {
        if (saved.computeSize) widget.computeSize = saved.computeSize;
        else delete widget.computeSize;
        if (Number.isFinite(saved.computedHeight)) widget.computedHeight = saved.computedHeight;
      }
      // 前端只在部分断开路径（removeLink）里自己放开 hidden，走 removeLink /
      // disconnectInput 的其它入口时控件会一直藏着——这里补一次，保证断开就能编辑。
      if (widget.hidden) widget.hidden = false;
    }
    changed = true;
  }
  if (changed) {
    // 只改 computedHeight 不会让宿主重排，必须走 arrange 才会把下面的行提上来。
    // arrange 内部可能 setSize，这里要挡住「把自动重排当成用户拖动」记进高度记忆，
    // 否则接线 / 断开一次就会把一个偏矮的临时高度钉成用户偏好。
    node._ggEnhancerApplying = true;
    try {
      node.arrange?.();
      const base = Number(node._ggWiredBaseHeight);
      if (restored && Number.isFinite(base) && base > 0 && Number(node.size?.[1]) < base) {
        node.setSize?.([Number(node.size?.[0]) || 0, base]);
      }
    } finally {
      node._ggEnhancerApplying = false;
    }
    const stillWired = WIRED_WIDGETS.some((name) => widgetByName(node, name)?._ggWired);
    if (!stillWired) {
      if (restored) {
        // 断开这一帧引擎可能先把节点按「没有多行文本区」收矮，下一帧再兜一次：
        // 把接线前的高度和文本区高度一起还原。
        restoreWiredBaseHeight(node);
      } else {
        delete node._ggWiredBaseHeight;
      }
    }
    node._ggAutoHeight = Math.round(Number(node.size?.[1]) || 0);
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
  }
}

// 断开接线后把节点恢复成接线前的尺寸。用一帧延迟是因为引擎的重排可能排在本帧之后，
// 当场设回去会被它按「没有多行文本区」重新收矮。
function restoreWiredBaseHeight(node) {
  const base = Number(node._ggWiredBaseHeight);
  if (!Number.isFinite(base) || base <= 0) {
    delete node._ggWiredBaseHeight;
    return;
  }
  requestAnimationFrame(() => {
    node._ggEnhancerApplying = true;
    try {
      if (Number(node.size?.[1]) < base) {
        node.setSize?.([Number(node.size?.[0]) || 0, base]);
      }
      node.arrange?.();
    } finally {
      node._ggEnhancerApplying = false;
    }
    node._ggAutoHeight = Math.round(Number(node.size?.[1]) || 0);
    delete node._ggWiredBaseHeight;
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
  });
}

function drawWiredRows(node, ctx) {
  if (!node?.widgets || !ctx) return;
  // 折叠状态只显示标题条，画在内容区会盖到标题上。
  if (node.flags?.collapsed === true || node.collapsed === true) return;
  const wired = WIRED_WIDGETS
    .map((name) => widgetByName(node, name))
    .filter((widget) => widget && isWidgetWired(node, widget));
  if (!wired.length) return;
  const colors = skinColorsFor(node);
  const width = Number(node.size?.[0]) || 260;
  ctx.save();
  ctx.font = "12px Inter, sans-serif";
  ctx.textBaseline = "middle";
  for (const widget of wired) {
    const y = Number(widget.y);
    if (!Number.isFinite(y)) continue;
    if (widget.hidden) {
      // 控件被藏起来：整行重画成「种子 / 文本 ← 上游输入」，端口点仍在左侧
      const boxX = 15;
      const boxW = Math.max(60, width - 30);
      ctx.beginPath();
      ctx.roundRect(boxX, y, boxW, WIRED_ROW_BOX, 6);
      ctx.fillStyle = colors.field;
      ctx.fill();
      ctx.strokeStyle = colors.divider;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.textAlign = "left";
      ctx.fillStyle = colors.muted;
      ctx.fillText(String(widget.name), boxX + 9, y + WIRED_ROW_BOX / 2);
      ctx.textAlign = "right";
      ctx.fillStyle = colors.accent;
      ctx.fillText(WIRED_LABEL, boxX + boxW - 9, y + WIRED_ROW_BOX / 2);
      ctx.textAlign = "left";
      continue;
    }
    // 控件还显示着：只在右端加一枚角标，不盖住它的取值
    const textW = ctx.measureText(WIRED_LABEL).width + 14;
    const badgeX = Math.max(20, width - 15 - textW);
    const badgeY = y + (WIRED_ROW_BOX - 18) / 2;
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, textW, 18, 9);
    ctx.fillStyle = colors.field;
    ctx.fill();
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillStyle = colors.accent;
    ctx.fillText(WIRED_LABEL, badgeX + textW / 2, badgeY + 9);
  }
  ctx.restore();
}

function toggleWidget(node, widget, show) {
  if (!widget) return;
  // 已接线的控件交给接线状态管：模式切换不许把它藏掉，也不许把行高改回去，
  // 否则端口点会失去归属（见 syncWiredRows / drawWiredRows）。
  if (isWidgetWired(node, widget)) return;
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
    // PE 模型现在是外接 CLIP 端口，不是节点内的下拉加载控件。
    // 本地LLM 显式任务只显示用得上的那个模型，「自动」两个都留着。
    [W_LLM_T2I]: llm && (!i2i || auto),
    [W_LLM_I2I]: llm && (i2i || auto),
    "mmproj": llm && (i2i || auto),
    "上下文长度": llm,
    "最大生成token": pe || llm,
    "seed": pe,
    "卸载策略": llm,
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
  syncWiredRows(node);
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
// PE 文件下拉改成两个外接 CLIP 端口后，当前是 16 个声明控件 + seed 控制项。
// 老工作流按旧布局先完成既有迁移，再删除两个 PE 文件名控件，避免 LLM 参数错位。
const NEW_WIDGET_COUNT = 17;
const LEGACY_WIDGET_COUNT = 19;
const LEGACY_PE_MODELS_PROPERTY = "_ggLegacyPeModelsV1";
function normalizeLegacyPeModel(value) {
  const model = String(value ?? "").trim();
  return !model || model.startsWith("（") ? "" : model;
}

// 旧存档里的 PE 下拉常常是 ComfyUI 默认的 clip_l.safetensors，它并不是
// Qwen Image 文本编码器；拿它自动建 CLIPLoader 只会又加载一个无关模型。
function isQwenPeModel(value) {
  const model = normalizeLegacyPeModel(value);
  return !!model
    && /\.safetensors$/i.test(model)
    && /qwen/i.test(model)
    && !/clip_l/i.test(model);
}

function migrateWidgetValues(info) {
  const values = Array.isArray(info?.widgets_values) ? info.widgets_values : null;
  const named = info?.widgets_values_named;
  const oldPeWidgets = named && ("文生图PE模型" in named || "图生图PE模型" in named);
  const hasTypedPePorts = (info?.inputs || []).some((input) =>
    ["文生图PE模型", "图生图PE模型"].includes(input?.name) && input?.type === "CLIP");
  const hasLegacyPeValues = values && [values[6], values[7]].some((value) =>
    /\.safetensors$/i.test(normalizeLegacyPeModel(value)));
  if (oldPeWidgets || (!hasTypedPePorts && hasLegacyPeValues)) {
    const legacyPeModels = {
      t2i: isQwenPeModel(named?.["文生图PE模型"] ?? values?.[6])
        ? normalizeLegacyPeModel(named?.["文生图PE模型"] ?? values?.[6]) : "",
      i2i: isQwenPeModel(named?.["图生图PE模型"] ?? values?.[7])
        ? normalizeLegacyPeModel(named?.["图生图PE模型"] ?? values?.[7]) : "",
    };
    if (legacyPeModels.t2i || legacyPeModels.i2i) {
      info.properties = info.properties && typeof info.properties === "object" ? info.properties : {};
      info.properties[LEGACY_PE_MODELS_PROPERTY] = legacyPeModels;
    }
  }
  if (!values) return;
  const currentLayout = hasTypedPePorts || (named && !oldPeWidgets
    && (W_LLM_T2I in named || W_LLM_I2I in named));
  if (currentLayout) {
    if (oldPeWidgets && values.length >= LEGACY_WIDGET_COUNT) values.splice(6, 2);
    if (values.length === NEW_WIDGET_COUNT - 1) values.splice(12, 0, "fixed");
    if (named) {
      delete named["文生图PE模型"];
      delete named["图生图PE模型"];
    }
    return;
  }

  // 先把仍使用 PE 控件的旧版本迁移到原 19 项布局。
  if (values.length < LEGACY_WIDGET_COUNT) {
    if (named && (W_LLM_T2I in named || W_LLM_I2I in named)) {
      if (values.length === 18) values.splice(14, 0, "fixed");
    } else {
      const legacyMainModel = values[8] ?? "";
      if (values.length === 18) {
        values.splice(9, 0, legacyMainModel);
      } else if (values.length === 17) {
        values.splice(13, 0, "randomize");
        values.splice(9, 0, legacyMainModel);
      } else if (values.length === 16) {
        values.splice(9, 0, legacyMainModel);
        if (typeof values[14] === "boolean") {
          values[14] = values[14] ? "fixed" : "randomize";
        }
        values.push(false, "默认");
      }
    }
  }

  if (values.length >= LEGACY_WIDGET_COUNT) values.splice(6, 2);
  if (named) {
    delete named["文生图PE模型"];
    delete named["图生图PE模型"];
  }
}



function migrateLegacyPeLoaders(node) {
  const properties = node?.properties;
  const legacy = properties?.[LEGACY_PE_MODELS_PROPERTY];
  if (!legacy || typeof legacy !== "object") return false;
  const graph = node.graph || globalThis.app?.graph;
  if (!graph || typeof graph.add !== "function") return false;

  const models = [legacy.t2i, legacy.i2i].map((value) => (isQwenPeModel(value) ? normalizeLegacyPeModel(value) : ""));
  const inputNames = ["文生图PE模型", "图生图PE模型"];
  const byModel = new Map();
  let complete = true;
  for (let index = 0; index < inputNames.length; index += 1) {
    const model = models[index];
    if (!model) continue;
    const inputIndex = (node.inputs || []).findIndex((input) => input?.name === inputNames[index]);
    if (inputIndex < 0) {
      complete = false;
      continue;
    }
    if (node.inputs[inputIndex].link != null) continue;

    let loader = byModel.get(model) || findCompatibleLoader(graph, "CLIPLoader", {
      clip_name: model,
      type: "qwen_image",
    });
    let created = false;
    if (!loader) {
      loader = createLoaderNode(graph, "CLIPLoader", {
        values: { clip_name: model, type: "qwen_image" },
        title: index === 0 ? "PE 文生图 CLIP（迁移）" : "PE 图生图 CLIP（迁移）",
        position: [Number(node.pos?.[0] || 0) - 360, Number(node.pos?.[1] || 0) + index * 150],
      });
      if (!loader) {
        complete = false;
        continue;
      }
      created = true;
    }
    if (!connectLoaderToInput(loader, node, inputNames[index])) {
      if (created) graph.remove?.(loader);
      complete = false;
      continue;
    }
    byModel.set(model, loader);
  }

  if (complete) {
    delete properties[LEGACY_PE_MODELS_PROPERTY];
    graph.setDirtyCanvas?.(true, true);
  }
  return complete;
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
  migrateLegacyPeLoaders(node);
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
      // 接线会改变控件的隐藏状态：先同步还原/收行（断开后控件要立刻可编辑），
      // 再异步重算整套显隐与高度。
      if (isThisNode(this)) {
        syncWiredRows(this);
        setTimeout(() => updateVisibility(this), 0);
      }
      return result;
    };

    const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const result = originalOnDrawForeground?.apply(this, arguments);
      if (isThisNode(this)) {
        // 每帧只做两次比较；真的接线状态变了才 arrange，不改变时没有额外开销。
        syncWiredRows(this);
        drawWiredRows(this, ctx);
      }
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
      // 接线 / 断开触发的自动重排不是用户拖动，不能写进高度记忆。
      if (this._ggEnhancerApplying) return result;
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
