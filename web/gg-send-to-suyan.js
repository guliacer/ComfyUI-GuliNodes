import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/**
 * GG 发送到素言：画布顶部按钮。
 * 点击后把当前画布上：
 *   - 非跳过的图像保存节点（GGSaveImage / GGImageCompressSave / SaveImage）的「最新一张」输出，
 *   - 非跳过的图像对比节点（GGImageComparer2/4/8）的「最新一组」图像，
 *   - 非跳过节点链路上的正面提示词（包括 easy positive / CLIPTextEncode 等），
 * 推送为同一批次到素言本地收件服务（http://127.0.0.1:9477/guli/suyan/import）。
 */

const SUYAN_ENDPOINT = "http://127.0.0.1:9477/guli/suyan/import";
// 设置项 id：在 GuliNodes 设置里打开「联动素言」开关后才会在顶部展示发送按钮
const SETTING_ID = "GuliNodes.enableSuyanButton";
const DEFAULT_ENABLED = false;

// 保存类节点（输出 images 的节点）
const SAVE_NODE_NAMES = new Set([
    "GGSaveImage",
    "GGImageCompressSave",
    "SaveImage",
    "PreviewImage",
    "GGPreviewImage",
    "GGImageCompress",
]);

// 对比类节点
const COMPARER_NODE_NAMES = new Set([
    "GGImageComparer2",
    "GGImageComparer4",
    "GGImageComparer8",
]);

// 文本节点白名单。实际选择仍由采样器正面链路和输入语义决定，避免把
// negative 或已连接 CLIP 节点残留的 widget 当成当前提示词。
const TEXT_NODE_NAMES = new Set([
    "CLIPTextEncode",
    "CLIPTextEncodeSDXL",
    "CLIPTextEncodeFlux",
    "GGCLIPTextEncode",
    "GGCLIPText",
    "easy positive",
    "easy negative",
    "easy wildcards",
    "easy prompt",
    "easy promptConcat",
    "easy promptReplace",
]);

const TEXT_INPUT_NAMES = new Set([
    "text",
    "文本",
    "positive",
    "negative",
    "prompt",
    "prompt_text",
    "string",
    "content",
    "value",
    "text1",
    "text2",
    "text_a",
    "text_b",
    "text_g",
    "text_l",
    "prompt_positive",
    "prompt_negative",
    "positive_prompt",
    "negative_prompt",
]);

const POSITIVE_INPUT_NAMES = new Set([
    "positive",
    "positive_conditioning",
    "prompt_positive",
    "positive_prompt",
    "positive_cond",
    "正面",
    "正面提示词",
    "正向",
    "正向提示词",
    "guider",
    "guide",
]);

const NEGATIVE_INPUT_NAMES = new Set([
    "negative",
    "negative_conditioning",
    "prompt_negative",
    "negative_prompt",
    "负面",
    "负面提示词",
]);

const SWITCH_NODE_NAMES = new Set(["ComfySwitchNode", "Switch", "easy switch"]);
const SAMPLER_STAGE_NAMES = new Set([
    "KSampler",
    "KSamplerAdvanced",
    "SamplerCustom",
    "SamplerCustomAdvanced",
    "GGZImageSampler",
]);
const SAMPLER_DIFFUSION_INPUT_NAMES = new Set([
    "latent",
    "latent_image",
    "latent_samples",
    "samples",
    "noise",
    "sigmas",
]);
const SAMPLER_CONTROL_INPUT_NAMES = new Set([
    "model",
    "unet",
    "sampler",
    "sampler_name",
    "scheduler",
    "sigmas",
    "steps",
    "cfg",
    "denoise",
]);
const GUIDER_NODE_NAMES = new Set([
    "BasicGuider",
    "CFGGuider",
    "DualCFGGuider",
    "PerpNegGuider",
    "LTXVDualCFGGuider",
    "T2V_Turbo_Guider",
]);
const PIPE_INPUT_NAMES = new Set(["pipe", "pipeline", "pipe_line", "潜空间管线", "管线"]);
const CONDITIONING_INPUT_NAMES = new Set([
    "conditioning",
    "cond",
    "cond1",
    "cond2",
    "positive_conditioning",
    "prompt_conditioning",
]);
const IMAGE_INPUT_NAME_PATTERN = /image|images|图像|图片|pixel|pixels|latent|samples|采样结果|输入图|source|destination|input|输入|任何/i;
const IMAGE_INPUT_NAMES = new Set(["a", "b"]);
const NON_IMAGE_INPUT_NAME_PATTERN = /model|clip|vae|conditioning|positive|negative|prompt|text|string|guide|guider|sampler|sigma|noise|mask|control|style|cfg|seed|steps|width|height|scale|strength|lora|模型|条件|提示词|文本|字符串|负|正/i;
// 运行记录确认 CLIPTextEncode#96 的 widget 是残留英文提示词。只屏蔽该节点
// 作为提示词文本来源，仍继续沿它的 text 连线追踪到实际的正面文本节点。
const PROMPT_BLACKLIST_NODE_KEYS = new Set(["CLIPTextEncode#96"]);
const MAX_TRACKED_EXECUTION_SNAPSHOTS = 128;
const executionSnapshots = new Map();
const executionHistoryPromises = new Map();
let activePromptId = "";

/** 读取 GuliNodes 设置（兼容新 extensionManager 与旧 app.ui.settings 两套 API）。 */
function getSettingValue(id, fallback) {
    try {
        const managerValue = app.extensionManager?.setting?.get?.(id);
        if (managerValue !== undefined) return managerValue;
    } catch {
        // Fall through to the legacy settings API.
    }
    try {
        const legacyValue = app.ui?.settings?.getSettingValue?.(id, undefined);
        if (legacyValue !== undefined) return legacyValue;
    } catch {
        // Older ComfyUI builds may not expose the legacy settings API.
    }
    return fallback;
}

/** 设置里打开开关后，才显示顶部「发送到素言」按钮。 */
function isSuyanButtonEnabled() {
    return getSettingValue(SETTING_ID, DEFAULT_ENABLED) !== false;
}

function isNodeBypassed(node) {
    // 新前端：node.mode 枚举 BYPASS=4（ALWAYS=0/ON_EVENT=1/NEVER=2/ON_TRIGGER=3/BYPASS=4）
    if (node?.mode === 4) return true;
    // 旧前端/兼容字段
    return Boolean(node?.flags?.isBypassed || node?.flags?.bypass);
}

function getNodeName(node) {
    return node?.comfyClass || node?.type || node?.class_type || "";
}

function isSaveNode(node) {
    const name = getNodeName(node);
    return SAVE_NODE_NAMES.has(name) ||
        (/save.*image|image.*save|preview.*image/i.test(name) && !/video/i.test(name));
}

function isComparerNode(node) {
    return COMPARER_NODE_NAMES.has(getNodeName(node));
}

function isTextNode(node) {
    return TEXT_NODE_NAMES.has(getNodeName(node));
}

function normalizeName(value) {
    return String(value ?? "").trim().toLowerCase();
}

function isNegativeInputName(name) {
    const key = normalizeName(name);
    return NEGATIVE_INPUT_NAMES.has(key) || key.includes("negative") || key.includes("负");
}

function isPositiveInputName(name) {
    const key = normalizeName(name);
    return POSITIVE_INPUT_NAMES.has(key) || key.includes("positive") || key.includes("正");
}

function isTextInputName(name) {
    const key = normalizeName(name);
    return TEXT_INPUT_NAMES.has(key) || key === "prompt" || key.includes("text");
}

function isSamplerNode(node) {
    const name = getNodeName(node);
    if (!name || /select$|config$|options?$|scheduler|采样器名称/i.test(name)) return false;
    const inputs = Object.keys(node?.inputs ?? {}).map(normalizeName);
    const hasDiffusionInput = inputs.some((key) =>
        SAMPLER_DIFFUSION_INPUT_NAMES.has(key) || key.includes("latent")
    );
    const hasConditioningInput = inputs.some((key) =>
        isPositiveInputName(key) || isNegativeInputName(key) ||
        key.includes("conditioning") || key.includes("guider")
    );
    const hasSamplerControl = inputs.some((key) => SAMPLER_CONTROL_INPUT_NAMES.has(key));
    if (hasDiffusionInput && hasConditioningInput && hasSamplerControl) return true;

    if (SAMPLER_STAGE_NAMES.has(name) || /sampler|采样|采样器|采样节点/i.test(name)) {
        // SamplerSelect/SamplerOptions create sampler configuration objects,
        // not images or latents. They are never the prompt owner.
        return inputs.some((key) =>
            isPositiveInputName(key) ||
            isNegativeInputName(key) ||
            key.includes("conditioning") ||
            key.includes("guider") ||
            PIPE_INPUT_NAMES.has(key) ||
            key.includes("latent")
        );
    }
    return false;
}

function isGuiderNode(node) {
    const name = getNodeName(node);
    if (GUIDER_NODE_NAMES.has(name) || /guider|引导器/i.test(name)) return true;
    return Object.keys(node?.inputs ?? {}).some((key) => normalizeName(key).includes("conditioning")) &&
        /guid|引导/i.test(name);
}

function isSamplingStageNode(node) {
    if (isSamplerNode(node)) return true;
    if (!node) return false;
    const inputs = Object.keys(node.inputs ?? {}).map(normalizeName);
    const hasSamplingInput = inputs.some((key) =>
        isPositiveInputName(key) || isNegativeInputName(key) ||
        key.includes("guider") || PIPE_INPUT_NAMES.has(key)
    );
    const hasImageOrLatentInput = inputs.some((key) => IMAGE_INPUT_NAME_PATTERN.test(key));
    return hasSamplingInput && hasImageOrLatentInput &&
        /(upscale|upscaler|ksampler|sampler|diffusion|采样|放大)/i.test(getNodeName(node));
}

function isSwitchNode(node) {
    const name = getNodeName(node);
    if (SWITCH_NODE_NAMES.has(name)) return true;
    const inputs = node?.inputs;
    return Boolean(inputs?.some?.((input) => normalizeName(input?.name) === "switch")) ||
        Boolean(inputs && typeof inputs === "object" && "switch" in inputs && ("on_true" in inputs || "on_false" in inputs));
}

function toBoolean(value, fallback = false) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["false", "0", "off", "no", "关闭", "否"].includes(normalized)) return false;
        if (["true", "1", "on", "yes", "开启", "是"].includes(normalized)) return true;
    }
    return value === undefined || value === null ? fallback : Boolean(value);
}

function getSwitchValue(node) {
    if (!node) return false;
    if (Array.isArray(node.inputs)) {
        const input = node.inputs.find((item) => normalizeName(item?.name) === "switch");
        if (input?.widget?.value !== undefined) return toBoolean(input.widget.value);
        if (input?.value !== undefined) return toBoolean(input.value);
    }
    if (node.inputs && typeof node.inputs === "object" && !Array.isArray(node.inputs) && node.inputs.switch !== undefined) {
        const input = node.inputs.switch;
        return toBoolean(input?.value ?? input?.widget?.value ?? input);
    }
    const widget = (node.widgets ?? []).find((item) => normalizeName(item?.name) === "switch");
    return toBoolean(widget?.value);
}

function emptyPromptInfo(source = "none") {
    return { text: "", source, nodeId: "", nodeName: "" };
}

function promptInfo(text, source, node) {
    return {
        text: typeof text === "string" ? text.trim() : "",
        source,
        nodeId: node?.id === undefined || node?.id === null ? "" : String(node.id),
        nodeName: getNodeName(node),
    };
}

function isNegativeTextNode(node) {
    const name = normalizeName(getNodeName(node));
    return name === "easy negative" || name.includes("negative") || name.includes("负面");
}

function isTextLikeNode(node) {
    const name = getNodeName(node);
    if (isTextNode(node)) return true;
    return /clip|text|encode|prompt|wildcard|style|conditioning|concat|switch|文本|提示词/i.test(name);
}

function isPromptBlacklistedNode(node, nodeId = node?.id) {
    const key = `${getNodeName(node)}#${String(nodeId ?? "")}`;
    return PROMPT_BLACKLIST_NODE_KEYS.has(key);
}

function getWidgetText(node, preferredNames = []) {
    const widgets = node?.widgets ?? [];
    const names = [...preferredNames, "text", "文本", "positive", "prompt", "prompt_text", "string", "content"];
    for (const name of names) {
        const widget = widgets.find((item) => normalizeName(item?.name) === normalizeName(name));
        if (typeof widget?.value === "string" && widget.value.trim()) return widget.value.trim();
    }
    return "";
}

function getInputByName(node, names) {
    if (!Array.isArray(node?.inputs)) return null;
    const wanted = new Set(names.map(normalizeName));
    return node.inputs.find((input) => wanted.has(normalizeName(input?.name))) ?? null;
}

function getGraphNode(graph, nodeId) {
    if (!graph || nodeId === undefined || nodeId === null) return null;
    return graph.getNodeById?.(nodeId) ??
        graph.getNodeById?.(Number(nodeId)) ??
        graph._nodes?.find?.((item) => String(item?.id) === String(nodeId)) ?? null;
}

function getGraphLink(graph, linkId) {
    if (!graph || linkId === undefined || linkId === null) return null;
    return graph.links?.get?.(linkId) ??
        graph.links?.get?.(Number(linkId)) ??
        graph.links?.find?.((item) => String(item?.id ?? item?.[0]) === String(linkId)) ?? null;
}

function getGraphOriginId(graph, linkId) {
    const link = getGraphLink(graph, linkId);
    if (Array.isArray(link)) return link[1];
    return link?.origin_id ?? link?.originId ?? link?.origin?.id ?? null;
}

function getNamedWidgetEntries(node) {
    const named = node?.widgets_values_named;
    if (Array.isArray(named)) {
        return named.flatMap((item) => {
            if (Array.isArray(item) && item.length >= 2) return [[item[0], item[1]]];
            if (item && typeof item === "object" && item.name) return [[item.name, item.value]];
            return [];
        });
    }
    if (named && typeof named === "object") return Object.entries(named);

    // Some newer node serializers use a named object instead of the legacy
    // widgets array. Keep this as a fallback; the queued execution snapshot
    // remains the preferred source whenever it is available.
    if (node?.widgets_values && typeof node.widgets_values === "object" && !Array.isArray(node.widgets_values)) {
        return Object.entries(node.widgets_values);
    }
    return [];
}

function getUiInputEntries(node) {
    if (Array.isArray(node?.inputs)) {
        return node.inputs
            .filter((input) => input?.name)
            .map((input) => [input.name, input]);
    }
    if (node?.inputs && typeof node.inputs === "object") return Object.entries(node.inputs);
    return [];
}

function getExecutionNodes(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    if (snapshot.__ggExecutionSnapshot) return getExecutionNodes(snapshot.__ggExecutionSnapshot);
    if (snapshot.output && typeof snapshot.output === "object") return snapshot.output;
    if (snapshot.prompt && typeof snapshot.prompt === "object" && !Array.isArray(snapshot.prompt)) return snapshot.prompt;
    return snapshot;
}

function getSnapshotTopology(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    if (snapshot.__ggTopology) return snapshot.__ggTopology;
    if (snapshot.__ggExecutionSnapshot) return getSnapshotTopology(snapshot.__ggExecutionSnapshot);
    return null;
}

function getSnapshotInputMeta(snapshot, nodeId, name) {
    const node = getSnapshotTopology(snapshot)?.[String(nodeId)];
    return node?.inputs?.[name] ?? null;
}

function getSnapshotNodeMeta(snapshot, nodeId) {
    return getSnapshotTopology(snapshot)?.[String(nodeId)] ?? null;
}

function buildGraphTopology(graph) {
    const topology = {};
    for (const node of graph?._nodes ?? []) {
        const inputs = {};
        for (const input of node.inputs ?? []) {
            if (!input?.name) continue;
            inputs[input.name] = {
                type: input.type ?? "",
                link: input.link ?? null,
                localizedName: input.localized_name ?? input.label ?? "",
            };
        }
        const outputs = (node.outputs ?? []).map((output) => ({
            name: output?.name ?? output?.label ?? "",
            type: output?.type ?? "",
            links: Array.isArray(output?.links) ? [...output.links] : [],
        }));
        topology[String(node.id)] = {
            class_type: getNodeName(node),
            title: node.title ?? "",
            order: Number.isFinite(node.order) ? node.order : null,
            inputs,
            outputs,
        };
    }
    return topology;
}

function getExecutionNode(nodes, nodeId) {
    if (!nodes || nodeId === undefined || nodeId === null) return null;
    return nodes[String(nodeId)] ?? nodes[nodeId] ?? null;
}

function getExecutionRef(value) {
    if (Array.isArray(value)) {
        if (value.length < 1) return null;
        const nodeId = value[0];
        return nodeId === undefined || nodeId === null ? null : String(nodeId);
    }
    if (!value || typeof value !== "object") return null;
    const nodeId = value.node_id ?? value.nodeId ?? value.source_node_id ?? value.sourceNodeId;
    return nodeId === undefined || nodeId === null ? null : String(nodeId);
}

function getSnapshotInputType(snapshot, nodeId, name) {
    const meta = getSnapshotInputMeta(snapshot, nodeId, name);
    return String(meta?.type ?? "").trim().toUpperCase();
}

function getExecutionInputEntries(snapshot, nodeId, node) {
    const inputs = node?.inputs && typeof node.inputs === "object" ? node.inputs : {};
    return Object.entries(inputs)
        .filter(([, value]) => getExecutionRef(value))
        .map(([name, value]) => ({
            name,
            value,
            ref: getExecutionRef(value),
            type: getSnapshotInputType(snapshot, nodeId, name),
        }));
}

function isImageLineageInput(snapshot, nodeId, name, type) {
    const key = normalizeName(name);
    const normalizedType = String(type || "").toUpperCase();
    if (normalizedType.includes("IMAGE") || normalizedType.includes("LATENT") || normalizedType.includes("VIDEO")) return true;
    if (normalizedType.includes("MASK") || normalizedType.includes("CONDITIONING") || normalizedType.includes("MODEL") ||
        normalizedType.includes("CLIP") || normalizedType.includes("VAE") || normalizedType.includes("STRING") ||
        normalizedType.includes("GUIDER") || normalizedType.includes("SAMPLER")) return false;
    if (NON_IMAGE_INPUT_NAME_PATTERN.test(key)) return false;
    return IMAGE_INPUT_NAMES.has(key) || IMAGE_INPUT_NAME_PATTERN.test(key);
}

function getImageLineageEntries(snapshot, nodeId, node) {
    return getExecutionInputEntries(snapshot, nodeId, node)
        .filter((entry) => isImageLineageInput(snapshot, nodeId, entry.name, entry.type));
}

function isConditioningInputName(name) {
    const key = normalizeName(name);
    return CONDITIONING_INPUT_NAMES.has(key) || key.includes("conditioning") ||
        /^cond(?:itioning)?[_-]?\d+$/i.test(key);
}

function isPositivePromptInput(name) {
    const key = normalizeName(name);
    return isPositiveInputName(name) || isConditioningInputName(name) ||
        key === "cond1" || key === "positive_cond" || key === "positive_condition";
}

function isPromptPipelineInput(name) {
    const key = normalizeName(name);
    return PIPE_INPUT_NAMES.has(key) || key.includes("pipe") || key.includes("pipeline");
}

function getPositivePromptEntries(snapshot, nodeId, node) {
    const entries = getExecutionInputEntries(snapshot, nodeId, node)
        .filter((entry) => !isNegativeInputName(entry.name));
    if (isSwitchNode(node)) {
        const selected = getSwitchValue(node) ? "on_true" : "on_false";
        return entries.filter((entry) => normalizeName(entry.name) === selected);
    }

    if (isSamplingStageNode(node)) {
        const direct = entries.filter((entry) => isPositivePromptInput(entry.name) ||
            normalizeName(entry.name) === "guider" || normalizeName(entry.name) === "guide");
        if (direct.length > 0) return direct;
        const pipeline = entries.filter((entry) => isPromptPipelineInput(entry.name));
        if (pipeline.length > 0) return pipeline;
    }

    if (isGuiderNode(node)) {
        const guiderInputs = entries.filter((entry) => isPositivePromptInput(entry.name) ||
            normalizeName(entry.name) === "conditioning");
        if (guiderInputs.length > 0) return guiderInputs;
    }

    if (isTextLikeNode(node)) {
        const textInputs = entries.filter((entry) => isTextInputName(entry.name) ||
            ["string_a", "string_b"].includes(normalizeName(entry.name)));
        if (textInputs.length > 0) return textInputs;
    }

    const conditioningInputs = entries.filter((entry) =>
        entry.type.includes("CONDITIONING") || isPositivePromptInput(entry.name) || isPromptPipelineInput(entry.name)
    );
    if (conditioningInputs.length > 0) return conditioningInputs;

    // Last-resort bridge for custom nodes whose type metadata is "*". Exclude
    // model/image/noise inputs so an arbitrary helper cannot jump sideways into
    // a negative or unrelated branch.
    return entries.filter((entry) => !NON_IMAGE_INPUT_NAME_PATTERN.test(normalizeName(entry.name)) ||
        isTextInputName(entry.name));
}

function isPromptInstruction(text) {
    return /you are an?\s+(expert|assistant|prompt)|your task is|follow these rules|user['’]s input|输出.*提示词|系统提示|提示词工程|只输出|不要输出/i.test(text);
}

function scorePromptText(node, name, text, depth) {
    const key = normalizeName(name);
    const nodeName = normalizeName(getNodeName(node));
    let score = 0;
    if (isPositiveInputName(name)) score += 80;
    if (key === "positive" || key === "prompt_positive" || key === "positive_prompt") score += 20;
    if (key === "text" || key === "文本") score += 24;
    if (key === "string_b") score += 14;
    if (nodeName === "easy positive") score += 60;
    if (nodeName.includes("positive")) score += 35;
    if (nodeName.includes("prompt")) score += 16;
    if (nodeName.includes("clip") || nodeName.includes("encode")) score += 20;
    if (isPromptInstruction(text)) score -= 100;
    return score - depth;
}

function readExecutionTextCandidates(node, nodeId, negativePath, source, depth) {
    if (!node || negativePath || isNegativeTextNode(node) || isPromptBlacklistedNode(node, nodeId)) return [];
    const inputs = node.inputs && typeof node.inputs === "object" ? node.inputs : {};
    const textEntries = Object.entries(inputs).filter(([name]) =>
        isTextInputName(name) || isPositivePromptInput(name)
    );

    return textEntries
        // A linked CLIP text input is only a transport node. Its widget commonly
        // keeps the previous prompt, so never read that widget while a link exists.
        .filter(([, value]) => !getExecutionRef(value))
        .filter(([name, value]) => !isNegativeInputName(name) && typeof value === "string" && value.trim())
        .map(([name, value]) => ({
            info: promptInfo(value, source, { ...node, id: nodeId }),
            score: scorePromptText(node, name, value, depth),
        }));
}

function findSamplerCandidates(snapshot, targetNodeId) {
    const nodes = getExecutionNodes(snapshot);
    if (!nodes) return [];
    const queue = [{ nodeId: String(targetNodeId), distance: 0, path: [] }];
    const bestDistance = new Map();
    const candidates = [];
    let visits = 0;
    while (queue.length > 0 && visits < 512) {
        const current = queue.shift();
        if (bestDistance.has(current.nodeId) && bestDistance.get(current.nodeId) <= current.distance) continue;
        bestDistance.set(current.nodeId, current.distance);
        visits += 1;
        const node = getExecutionNode(nodes, current.nodeId);
        if (!node) continue;
        if (isSamplingStageNode(node)) {
            const meta = getSnapshotNodeMeta(snapshot, current.nodeId);
            candidates.push({
                nodeId: current.nodeId,
                node,
                distance: current.distance,
                order: Number.isFinite(meta?.order) ? meta.order : -1,
                path: [...current.path, current.nodeId],
            });
            continue;
        }
        for (const entry of getImageLineageEntries(snapshot, current.nodeId, node)) {
            queue.push({
                nodeId: entry.ref,
                distance: current.distance + 1,
                path: [...current.path, current.nodeId],
            });
        }
    }
    return candidates.sort((left, right) => left.distance - right.distance || right.order - left.order);
}

function resolvePromptFromSampler(snapshot, samplerId, source) {
    return resolvePromptFromExecutionSnapshot(snapshot, samplerId, source);
}

function resolvePromptFromExecutionSnapshot(snapshot, targetNodeId, source = "execution-snapshot") {
    const nodes = getExecutionNodes(snapshot);
    if (!nodes) return emptyPromptInfo(source);

    const queue = [{ nodeId: String(targetNodeId), negativePath: false, depth: 0 }];
    const visited = new Set();
    const candidates = [];
    let visits = 0;
    while (queue.length > 0 && visits < 512) {
        const current = queue.shift();
        const key = `${current.nodeId}:${current.negativePath ? "negative" : "positive"}`;
        if (visited.has(key)) continue;
        visited.add(key);
        visits += 1;

        const node = getExecutionNode(nodes, current.nodeId);
        if (!node) continue;
        candidates.push(...readExecutionTextCandidates(node, current.nodeId, current.negativePath, source, current.depth));

        // A negative text node is a terminal guard. It cannot be a valid
        // positive source, and traversing its linked text would reintroduce a
        // negative branch through a custom intermediary.
        if (isNegativeTextNode(node)) continue;

        for (const entry of getPositivePromptEntries(snapshot, current.nodeId, node)) {
            queue.push({ nodeId: entry.ref, negativePath: current.negativePath, depth: current.depth + 1 });
        }
    }

    if (candidates.length === 0) return emptyPromptInfo(source);
    candidates.sort((left, right) => right.score - left.score);
    const best = candidates[0];
    // ConditioningCombine and similar nodes can have multiple real positive
    // text leaves. Include close-scoring leaves, but never add an instruction
    // block that merely prefixes the user prompt.
    const texts = candidates
        .filter((candidate) => candidate.score >= best.score - 35 && !isPromptInstruction(candidate.info.text))
        .map((candidate) => candidate.info.text)
        .filter((text, index, list) => list.indexOf(text) === index);
    return {
        ...best.info,
        text: texts.join("\n\n"),
        samplerId: String(targetNodeId),
        samplerName: getNodeName(getExecutionNode(nodes, targetNodeId)),
    };
}

function buildUiExecutionSnapshot(graph) {
    const output = {};
    for (const node of graph?._nodes ?? []) {
        const inputs = {};
        for (const [name, input] of getUiInputEntries(node)) {
            const linkId = input && typeof input === "object" && !Array.isArray(input)
                ? input.link
                : Array.isArray(input) ? input[0] : null;
            const originId = linkId === undefined || linkId === null
                ? Array.isArray(input) ? input[0] : null
                : getGraphOriginId(graph, linkId);
            if (originId !== undefined && originId !== null) {
                const originSlot = Array.isArray(input) && input.length > 1 ? input[1] : 0;
                inputs[name] = [String(originId), originSlot];
            } else if (input && typeof input === "object" && !Array.isArray(input) && input.value !== undefined) {
                inputs[name] = input.value;
            } else if (input !== undefined && input !== null && typeof input !== "object") {
                inputs[name] = input;
            }
        }
        for (const widget of node.widgets ?? []) {
            if (widget?.name && !(widget.name in inputs)) inputs[widget.name] = widget.value;
        }
        for (const [name, value] of getNamedWidgetEntries(node)) {
            if (name && !(name in inputs)) inputs[name] = value;
        }
        output[String(node.id)] = { class_type: getNodeName(node), inputs, id: node.id };
    }
    return { output, __ggTopology: buildGraphTopology(graph) };
}

function resolveTextPromptInfoForNode(node, graph, source = "live-graph") {
    if (!node || !graph) return emptyPromptInfo(source);
    return resolvePromptFromExecutionSnapshot(buildUiExecutionSnapshot(graph), node.id, source);
}

function rememberExecutionSnapshot(promptId, snapshot, graph = app.graph, topology = null) {
    if (!promptId || !snapshot) return;
    const key = String(promptId);
    const previous = executionSnapshots.get(key);
    executionSnapshots.set(key, {
        __ggExecutionSnapshot: snapshot,
        __ggTopology: topology || previous?.__ggTopology || buildGraphTopology(graph),
        outputNodes: previous?.outputNodes || new Set(),
        fetchedFromHistory: previous?.fetchedFromHistory || false,
    });
    while (executionSnapshots.size > MAX_TRACKED_EXECUTION_SNAPSHOTS) {
        executionSnapshots.delete(executionSnapshots.keys().next().value);
    }
}

function getPromptId(detail) {
    const value = detail?.prompt_id ?? detail?.promptId;
    return value === undefined || value === null ? "" : String(value).trim();
}

function resolvePromptInfoForOutput(node, promptId = "") {
    const snapshot = promptId ? executionSnapshots.get(String(promptId)) : null;
    if (snapshot) {
        const source = snapshot.fetchedFromHistory
            ? "history-execution-snapshot"
            : "queued-execution-snapshot";
        // The save node is only the transport endpoint. First follow its image
        // lineage to the sampler that produced this image, then follow only
        // that sampler's positive conditioning branch.
        for (const candidate of findSamplerCandidates(snapshot, node?.id)) {
            const found = resolvePromptFromSampler(snapshot, candidate.nodeId, source);
            if (found.text) return found;
        }

        // Keep a conservative fallback for custom image-producing nodes that
        // do not expose a recognizable sampler or image input type.
        const found = resolvePromptFromExecutionSnapshot(snapshot, node?.id, source);
        if (found.text) return found;
        // An execution snapshot is authoritative even when its prompt is empty.
        return promptInfo("", source, node);
    }
    return resolveTextPromptInfoForNode(node, app.graph, "live-graph");
}

function rememberNodeOutput(node, output, promptId = "") {
    if (!node || !output) return;
    if (promptId) {
        const record = executionSnapshots.get(String(promptId));
        if (record) record.outputNodes.add(node);
    }
    if (Array.isArray(output.images) && output.images.length > 0) {
        node.__ggLastImages = output.images;
        node.__ggLastPromptId = promptId ? String(promptId) : "";
        node.__ggLastPromptInfo = resolvePromptInfoForOutput(node, promptId);
        node.__ggLastPrompt = node.__ggLastPromptInfo.text;
    }
    if (Array.isArray(output.a_images) || Array.isArray(output.b_images)) {
        const images = [];
        if (Array.isArray(output.a_images)) images.push(...output.a_images);
        if (Array.isArray(output.b_images)) images.push(...output.b_images);
        if (images.length > 0) {
            node.__ggLastComparerImages = images;
            node.__ggLastPromptId = promptId ? String(promptId) : "";
            node.__ggLastPromptInfo = resolvePromptInfoForOutput(node, promptId);
            node.__ggLastPrompt = node.__ggLastPromptInfo.text;
        }
    }
}

/** 保存节点执行后，记录这次输出的 images（含最新批次）及当时的关联提示词快照。 */
function rememberSaveOutput(node) {
    const original = node?.onExecuted;
    node.onExecuted = function (output) {
        const result = original?.apply(this, arguments);
        rememberNodeOutput(this, output, activePromptId);
        return result;
    };
}

/** 对比节点执行后，记录 a_images / b_images（{filename,subfolder,type} 列表）。 */
function rememberComparerOutput(node) {
    const original = node?.onExecuted;
    node.onExecuted = function (output) {
        const result = original?.apply(this, arguments);
        rememberNodeOutput(this, output, activePromptId);
        return result;
    };
}

/** 从图像项信息（{filename, subfolder, type}）构建 /view 访问 URL。 */
function buildViewUrl(item) {
    if (!item) return null;
    const filename = item.filename || item.name;
    if (!filename) return null;
    const subfolder = encodeURIComponent(item.subfolder || "");
    const type = item.type || "output";
    return `/view?filename=${encodeURIComponent(filename)}&subfolder=${subfolder}&type=${encodeURIComponent(type)}`;
}

/** 从保存节点取「最新一张图像」的 URL。 */
function getSaveNodeLatestImageUrl(node) {
    const list = node.__ggLastImages;
    if (!Array.isArray(list) || list.length === 0) return null;
    return buildViewUrl(list[list.length - 1]);
}

/** 从对比节点取最新一组图像（{filename,subfolder,type}）的 URL 列表。 */
function getComparerLatestImageUrls(node) {
    const list = node.__ggLastComparerImages;
    if (!Array.isArray(list)) return [];
    return list.map(buildViewUrl).filter(Boolean);
}

function getNodePromptInfo(node, graph) {
    if (node?.__ggLastPromptId && executionSnapshots.has(node.__ggLastPromptId)) {
        const found = resolvePromptInfoForOutput(node, node.__ggLastPromptId);
        node.__ggLastPromptInfo = found;
        node.__ggLastPrompt = found.text;
        return found;
    }
    if (node?.__ggLastPromptInfo) return node.__ggLastPromptInfo;
    if (node?.__ggLastPrompt !== undefined) {
        return promptInfo(node.__ggLastPrompt, "output-snapshot", node);
    }
    return resolveTextPromptInfoForNode(node, graph, "live-graph");
}

function isExecutionSnapshotSource(source) {
    return source === "execution-snapshot" || source === "queued-execution-snapshot" ||
        source === "history-execution-snapshot";
}

/**
 * 收集画布所有相关节点的数据。
 * 每张图记录它对应的提示词（执行时快照优先；未执行过的节点回退实时解析），
 * 供素言分组：提示词相同才归同一组。
 */
function collectCanvasPayload() {
    const graph = app.graph;
    const nodes = graph?._nodes ?? [];
    const images = [];

    for (const node of nodes) {
        if (isNodeBypassed(node)) continue;

        if (isSaveNode(node)) {
            const url = getSaveNodeLatestImageUrl(node);
            if (url) {
                const prompt = getNodePromptInfo(node, graph);
                images.push({
                    nodeName: getNodeName(node),
                    nodeTitle: node.title,
                    nodeId: String(node.id),
                    sourceUrl: url,
                    prompt: prompt.text,
                    promptInfo: prompt,
                });
            }
            continue;
        }

        if (isComparerNode(node)) {
            const urls = getComparerLatestImageUrls(node);
            if (urls.length > 0) {
                const prompt = getNodePromptInfo(node, graph);
                urls.forEach((url) =>
                    images.push({
                        nodeName: getNodeName(node),
                        nodeTitle: node.title,
                        nodeId: String(node.id),
                        sourceUrl: url,
                        prompt: prompt.text,
                        promptInfo: prompt,
                    })
                );
            }
            continue;
        }
    }

    return { images };
}

function decodeBytes(bytes) {
    try {
        return new TextDecoder("utf-8").decode(bytes);
    } catch {
        return "";
    }
}

function readJpegComments(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return [];
    const comments = [];
    let offset = 2;
    while (offset + 3 < bytes.length) {
        if (bytes[offset] !== 0xff) {
            offset += 1;
            continue;
        }
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        const marker = bytes[offset++];
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 1 >= bytes.length) break;
        const length = (bytes[offset] << 8) | bytes[offset + 1];
        if (length < 2 || offset + length > bytes.length) break;
        if (marker === 0xfe) comments.push(bytes.slice(offset + 2, offset + length));
        offset += length;
    }
    return comments;
}

function readPngTextChunks(bytes) {
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return [];
    const entries = [];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
        const type = decodeBytes(bytes.slice(offset + 4, offset + 8));
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > bytes.length) break;
        const data = bytes.slice(dataStart, dataEnd);
        if (type === "tEXt") {
            const separator = data.indexOf(0);
            if (separator > 0) {
                entries.push({ keyword: decodeBytes(data.slice(0, separator)), value: decodeBytes(data.slice(separator + 1)) });
            }
        } else if (type === "iTXt") {
            const keywordEnd = data.indexOf(0);
            if (keywordEnd > 0 && keywordEnd + 2 < data.length && data[keywordEnd + 1] === 0) {
                let cursor = keywordEnd + 3;
                const languageEnd = data.indexOf(0, cursor);
                if (languageEnd >= 0) {
                    cursor = languageEnd + 1;
                    const translatedEnd = data.indexOf(0, cursor);
                    if (translatedEnd >= 0) {
                        entries.push({
                            keyword: decodeBytes(data.slice(0, keywordEnd)),
                            value: decodeBytes(data.slice(translatedEnd + 1)),
                        });
                    }
                }
            }
        }
        offset = dataEnd + 4;
        if (type === "IEND") break;
    }
    return entries;
}

function readWebpExifChunks(bytes) {
    if (bytes.length < 20 || decodeBytes(bytes.slice(0, 4)) !== "RIFF" || decodeBytes(bytes.slice(8, 12)) !== "WEBP") {
        return [];
    }
    const entries = [];
    let offset = 12;
    while (offset + 8 <= bytes.length) {
        const type = decodeBytes(bytes.slice(offset, offset + 4));
        const length = bytes[offset + 4]
            | (bytes[offset + 5] << 8)
            | (bytes[offset + 6] << 16)
            | (bytes[offset + 7] << 24);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (!Number.isSafeInteger(length) || length < 0 || dataEnd > bytes.length) break;
        if (type === "EXIF") entries.push(bytes.slice(dataStart, dataEnd));
        offset = dataEnd + (length % 2);
    }
    return entries;
}

function parseMetadataPromptValue(value) {
    if (typeof value === "string" && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            if (parsed !== value) return parseMetadataPromptValue(parsed);
        } catch {
            return promptInfo(value, "image-metadata", { id: "", comfyClass: "image metadata" });
        }
        return promptInfo(value, "image-metadata", { id: "", comfyClass: "image metadata" });
    }
    if (!value || typeof value !== "object") return emptyPromptInfo("image-metadata");

    if (value.prompt !== undefined) {
        const nested = parseMetadataPromptValue(value.prompt);
        if (nested.text) return nested;
    }
    const graph = getExecutionNodes(value) ? value : null;
    if (graph) {
        const samplerInfo = resolveBestPromptFromExecutionGraph(graph);
        if (samplerInfo.text) return { ...samplerInfo, source: "image-metadata" };
    }
    for (const key of ["positive", "positive_prompt", "prompt_positive", "正面提示词"]) {
        if (typeof value[key] === "string" && value[key].trim()) {
            return promptInfo(value[key], "image-metadata", { id: "", comfyClass: "image metadata" });
        }
    }
    return emptyPromptInfo("image-metadata");
}

function resolveBestPromptFromExecutionGraph(snapshot) {
    const nodes = getExecutionNodes(snapshot);
    if (!nodes) return emptyPromptInfo("image-metadata");
    let best = emptyPromptInfo("image-metadata");
    for (const [nodeId, node] of Object.entries(nodes)) {
        if (!isSamplerNode(node)) continue;
        const found = resolvePromptFromExecutionSnapshot({ output: nodes }, nodeId, "image-metadata");
        if (found.text.length > best.text.length) best = found;
    }
    return best;
}

function parseEmbeddedPrompt(bytes) {
    const jpegComments = readJpegComments(bytes);
    if (jpegComments.length > 0) {
        const first = decodeBytes(jpegComments[0]);
        if (first.startsWith("GGMETA1")) {
            try {
                const encoded = decodeBytes(new Uint8Array(jpegComments.flatMap((part) => [...part])).slice(7));
                const binary = atob(encoded);
                const decoded = new Uint8Array(binary.length);
                for (let index = 0; index < binary.length; index += 1) decoded[index] = binary.charCodeAt(index);
                return parseMetadataPromptValue(decodeBytes(decoded));
            } catch {
                return emptyPromptInfo("image-metadata");
            }
        }
        for (const comment of jpegComments) {
            const found = parseMetadataPromptValue(decodeBytes(comment));
            if (found.text) return found;
        }
    }

    const pngEntries = readPngTextChunks(bytes);
    for (const entry of pngEntries) {
        if (!/^(prompt|parameters|workflow)$/i.test(entry.keyword)) continue;
        const found = parseMetadataPromptValue(entry.value);
        if (found.text) return found;
    }

    for (const entry of readWebpExifChunks(bytes)) {
        const text = decodeBytes(entry).replace(/^EXIF/, "");
        const found = parseMetadataPromptValue(text);
        if (found.text) return found;
    }
    return emptyPromptInfo("image-metadata");
}

async function fetchImageBlob(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取图像失败: ${response.status}`);
    return await response.blob();
}

async function getImageBlob(image) {
    if (!image.blob) image.blob = await fetchImageBlob(image.sourceUrl);
    return image.blob;
}

async function enrichPromptFromImageMetadata(images) {
    for (const image of images) {
        // An empty prompt in an execution snapshot is intentional. Do not
        // replace it with metadata that may belong to an older file version.
        if (image.prompt || isExecutionSnapshotSource(image.promptInfo?.source)) continue;
        try {
            const blob = await getImageBlob(image);
            const found = parseEmbeddedPrompt(new Uint8Array(await blob.arrayBuffer()));
            if (found.text) {
                image.prompt = found.text;
                image.promptInfo = found;
            }
        } catch (error) {
            console.debug("[GuliNodes/SuYan] 读取图片提示词元数据失败", error);
        }
    }
}

/** 发送一组图片（提示词相同的一组）到素言；返回素言响应 JSON。 */
async function sendImageGroupToSuyan(group) {
    const form = new FormData();

    // 每张图各自关联的提示词已解析（prompt 相同才会在这一组里），作为本组 fallback。
    // PNG 内嵌元数据优先；JPEG/WEBP 用此 prompt 落库，从而按提示词正确分组。
    const prompt = group.prompt || "";
    if (prompt) {
        form.append("prompt", prompt);
        form.append("title", prompt.slice(0, 24));
    }
    form.append("generationMethod", "comfyui");

    let index = 0;
    for (const image of group.images) {
        const blob = await getImageBlob(image);
        // 文件后缀跟随真实格式（素言按扩展名与 MIME 处理）
        const mime = blob.type || "image/png";
        let name = `comfyui_${String(index + 1).padStart(3, "0")}.png`;
        if (mime.includes("jpeg") || mime.includes("jpg")) name = name.replace(".png", ".jpg");
        else if (mime.includes("webp")) name = name.replace(".png", ".webp");
        form.append("images", blob, name);
        index += 1;
    }

    const response = await fetch(SUYAN_ENDPOINT, {
        method: "POST",
        body: form,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`素言收件失败(${response.status}): ${text}`);
    }

    return await response.json();
}

export async function collectAndSend() {
    // execution_success starts a history refresh asynchronously. Wait for it
    // so the button cannot race the server's authoritative prompt graph.
    if (executionHistoryPromises.size > 0) {
        await Promise.all([...executionHistoryPromises.values()]);
    }
    const { images } = collectCanvasPayload();

    if (images.length === 0) {
        return {
            ok: false,
            error: {
                code: "NO_IMAGES",
                message: "画布上没有已执行过的图像保存/对比节点（请先运行一次工作流生成图像）。",
            },
        };
    }

    await enrichPromptFromImageMetadata(images);
    console.info(
        "[GuliNodes/SuYan] 推送来源诊断",
        images.map((image) => ({
            image: image.sourceUrl,
            saveNode: `${image.nodeName}#${image.nodeId}`,
            promptSource: image.promptInfo?.source || "none",
            promptNode: image.promptInfo?.nodeName ? `${image.promptInfo.nodeName}#${image.promptInfo.nodeId}` : "none",
            promptLength: image.prompt?.length || 0,
            promptPreview: image.prompt ? image.prompt.slice(0, 80).replace(/\s+/g, " ") : "",
        }))
    );

    // 按提示词分组：相同提示词的图一并发送（素言归同一提示词组），
    // 不同提示词的图分批发送（素言按 fallback prompt 各自成组）。无提示词的图单独一批。
    const groups = new Map();
    for (const image of images) {
        const key = image.prompt || "__no_prompt__";
        if (!groups.has(key)) groups.set(key, { prompt: image.prompt || "", images: [] });
        groups.get(key).images.push(image);
    }

    try {
        let sentImages = 0;
        for (const group of groups.values()) {
            const result = await sendImageGroupToSuyan(group);
            sentImages += group.images.length;
        }
        return { ok: true, data: { sentImages }, sentImages };
    } catch (error) {
        return {
            ok: false,
            error: { code: "NETWORK", message: error instanceof Error ? error.message : String(error) },
        };
    }
}

function rememberSnapshotFromCurrentGraph(promptId) {
    if (!promptId || typeof app.graphToPrompt !== "function") return;
    Promise.resolve(app.graphToPrompt())
        .then((snapshot) => {
            if (snapshot?.output) rememberExecutionSnapshot(promptId, snapshot, app.graph);
        })
        .catch(() => {
            // queuePrompt normally provides the authoritative snapshot.
        });
}

async function rememberSnapshotFromHistory(promptId) {
    if (!promptId) return;
    try {
        const response = await fetch(`/history/${encodeURIComponent(promptId)}`);
        if (!response.ok) return;
        const history = await response.json();
        const entry = history?.[promptId] ?? history;
        const promptRecord = entry?.prompt;
        const historyGraph = Array.isArray(promptRecord) ? promptRecord[2] : promptRecord;
        if (!historyGraph || typeof historyGraph !== "object" || Array.isArray(historyGraph)) return;

        // ComfyUI history has shipped both shapes: newer builds may return
        // graphToPrompt-style { output }, while the established /history
        // response stores the execution graph directly in prompt[2].
        const snapshot = historyGraph.output && typeof historyGraph.output === "object"
            ? historyGraph
            : { output: historyGraph };

        const existing = executionSnapshots.get(String(promptId));
        rememberExecutionSnapshot(promptId, snapshot, app.graph, existing?.__ggTopology || buildGraphTopology(app.graph));
        const record = executionSnapshots.get(String(promptId));
        if (record) record.fetchedFromHistory = true;
    } catch {
        // History is a strengthening fallback. The queued graph snapshot is
        // still usable when an older ComfyUI build does not expose this route.
    }
}

function findQueuedPrompt(args) {
    for (let index = args.length - 1; index >= 0; index -= 1) {
        const value = args[index];
        if (value && typeof value === "object" && value.output && typeof value.output === "object") return value;
    }
    return null;
}

function installExecutionHooks() {
    const eventApi = app.api ?? api;
    if (!eventApi) return;

    if (typeof eventApi.queuePrompt === "function" && !eventApi.__ggSuyanQueueWrapped) {
        eventApi.__ggSuyanQueueWrapped = true;
        const originalQueuePrompt = eventApi.queuePrompt;
        eventApi.queuePrompt = async function (...args) {
            let queuedPrompt = findQueuedPrompt(args);
            // Newer ComfyUI queuePrompt calls graphToPrompt internally and do
            // not pass the generated prompt as an argument. Capture it before
            // the request starts so a later canvas edit cannot change lineage.
            if (!queuedPrompt && typeof app.graphToPrompt === "function") {
                try {
                    queuedPrompt = await Promise.resolve(app.graphToPrompt());
                } catch {
                    // execution_start still provides a live-graph fallback.
                }
            }
            const queuedTopology = buildGraphTopology(app.graph);
            const response = await originalQueuePrompt.apply(this, args);
            const promptId = getPromptId(response);
            if (promptId && queuedPrompt) rememberExecutionSnapshot(promptId, queuedPrompt, app.graph, queuedTopology);
            return response;
        };
    }

    if (eventApi.__ggSuyanEventsInstalled || typeof eventApi.addEventListener !== "function") return;
    eventApi.__ggSuyanEventsInstalled = true;

    eventApi.addEventListener("execution_start", ({ detail }) => {
        activePromptId = getPromptId(detail);
        if (activePromptId && !executionSnapshots.has(activePromptId)) {
            rememberSnapshotFromCurrentGraph(activePromptId);
        }
    });

    eventApi.addEventListener("executed", ({ detail }) => {
        const node = getGraphNode(app.graph, detail?.node);
        if (!node || (!isSaveNode(node) && !isComparerNode(node))) return;
        const promptId = getPromptId(detail) || activePromptId;
        rememberNodeOutput(node, detail?.output, promptId);
    });

    eventApi.addEventListener("execution_success", ({ detail }) => {
        const promptId = getPromptId(detail) || activePromptId;
        if (promptId) {
            const historyPromise = rememberSnapshotFromHistory(promptId);
            executionHistoryPromises.set(promptId, historyPromise);
            historyPromise.finally(() => executionHistoryPromises.delete(promptId));
        }
        if (promptId && promptId === activePromptId) activePromptId = "";
    });

    eventApi.addEventListener("execution_error", ({ detail }) => {
        const promptId = getPromptId(detail) || activePromptId;
        if (promptId && promptId === activePromptId) activePromptId = "";
    });
}

// —— 安装 ——
// 扫描画布上的保存/对比节点并挂 onExecuted；按节点级 __ggSuyanHooked 幂等，
// 可重复安全调用。configure(加载工作流) 会重建 _nodes，所以同时包一层 configure
// 在重建后重扫；add 包一层用于运行期新建的节点。
function scanAndHookNodes(graph) {
    for (const node of graph?._nodes ?? []) {
        if (node.__ggSuyanHooked) continue;
        if (isSaveNode(node)) {
            rememberSaveOutput(node);
            node.__ggSuyanHooked = true;
        } else if (isComparerNode(node)) {
            rememberComparerOutput(node);
            node.__ggSuyanHooked = true;
        }
    }
}

function installNodeHooks() {
    const graph = app.graph;
    if (!graph) return;

    scanAndHookNodes(graph);

    // 包 configure：加载/切换工作流时 _nodes 会被重建，旧实例钩子随实例消失，
    // 新实例需要重扫。标记位防重复包装。
    if (typeof graph.configure === "function" && !graph.__ggSuyanConfigureWrapped) {
        graph.__ggSuyanConfigureWrapped = true;
        const originalConfigure = graph.configure;
        graph.configure = function (...args) {
            const result = originalConfigure.apply(this, args);
            scanAndHookNodes(this);
            return result;
        };
    }
}

function setupButton() {
    // 顶部菜单区图标按钮（与内存清理 / TapRelay 等按钮同款样式）
    const host = document.createElement("div");
    host.id = "gg-send-to-suyan-host";
    host.classList.add("gg-send-to-suyan-host");

    const button = document.createElement("button");
    button.id = "gg-send-to-suyan-btn";
    button.type = "button";
    button.className = "comfyui-button gg-ui-top-button gg-send-to-suyan-btn";
    button.title = "发送到素言";
    button.setAttribute("aria-label", "发送到素言");
    // 素言应用图标做展示（内嵌 data URI，不依赖静态资源路由）
    const SUYAN_LOGO_DATA_URI = "data:image/png;base64,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";
    button.innerHTML = `<img src="${SUYAN_LOGO_DATA_URI}" alt="素言" class="gg-suyan-logo">`;
    host.appendChild(button);

    const style = document.createElement("style");
    style.textContent = `
        #gg-send-to-suyan-host {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            height: 34px;
            flex: 0 0 auto;
        }
        #gg-send-to-suyan-host.gg-suyan-menu-host,
        #gg-send-to-suyan-host.gg-suyan-legacy-host {
            position: static;
            margin-inline: 2px;
            z-index: auto;
        }
        #gg-send-to-suyan-host.gg-suyan-floating-host {
            position: fixed;
            top: 18px;
            right: 18px;
            z-index: 99999;
            padding: 2px;
            border: 1px solid rgba(148,163,184,0.22);
            border-radius: 10px;
            background: rgba(255,255,255,0.84);
            box-shadow: 0 8px 22px rgba(15,23,42,0.1);
            backdrop-filter: blur(14px);
        }
        #gg-send-to-suyan-host.gg-suyan-hidden {
            display: none !important;
        }
        #gg-send-to-suyan-btn {
            width: 34px !important;
            min-width: 34px !important;
            max-width: 34px !important;
            height: 34px !important;
            padding: 0 !important;
            border-radius: 8px !important;
            box-sizing: border-box;
            line-height: 0 !important;
            appearance: none;
            cursor: pointer;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            border: 1px solid rgba(148,163,184,0.22) !important;
            background: rgba(255,255,255,0.42) !important;
        }
        #gg-send-to-suyan-btn:hover {
            transform: scale(1.08);
        }
        #gg-send-to-suyan-host.gg-suyan-sending #gg-send-to-suyan-btn {
            opacity: 0.68;
            pointer-events: none;
            cursor: wait;
        }
        #gg-send-to-suyan-btn .gg-suyan-logo {
            width: 22px;
            height: 22px;
            border-radius: 5px;
            display: block;
            pointer-events: none;
            object-fit: contain;
        }
        @media (max-width: 760px) {
            #gg-send-to-suyan-host.gg-suyan-floating-host {
                top: 12px;
                right: 12px;
            }
        }
    `;
    document.head.appendChild(style);

    const placeHost = () => {
        host.classList.remove("gg-suyan-menu-host", "gg-suyan-legacy-host", "gg-suyan-floating-host");

        const settingsGroup = app.menu?.settingsGroup?.element;
        if (settingsGroup?.parentElement) {
            settingsGroup.before(host);
            host.classList.add("gg-suyan-menu-host");
            return true;
        }

        const queueButton = document.getElementById("queue-button");
        if (queueButton?.parentElement) {
            queueButton.insertAdjacentElement("afterend", host);
            host.classList.add("gg-suyan-legacy-host");
            return true;
        }

        if (host.parentElement !== document.body) {
            document.body.appendChild(host);
        }
        host.classList.add("gg-suyan-floating-host");
        return false;
    };

    const notify = (summary, detail = "", severity = "success") => {
        try {
            const toast = app.extensionManager?.toast;
            if (toast?.add) {
                toast.add({ severity, summary, detail, life: 3200 });
                return;
            }
        } catch {
            // Toast 可选
        }
        console.info(`[GuliNodes/SuYan] ${summary}${detail ? ": " + detail : ""}`);
    };

    button.addEventListener("click", async () => {
        button.disabled = true;
        host.classList.add("gg-suyan-sending");
        notify("正在发送到素言…", "", "info");
        try {
            const result = await collectAndSend();
            if (result.ok) {
                notify(`已发送 ${result.sentImages ?? 0} 张到素言`, "素材已导入素言素材库；若素言界面未显示，请切换视图或重启素言。");
            } else {
                notify("发送到素言失败", result.error?.message ?? "未知错误", "error");
            }
        } catch (error) {
            notify("发送到素言失败", error instanceof Error ? error.message : String(error), "error");
        } finally {
            button.disabled = false;
            host.classList.remove("gg-suyan-sending");
        }
    });
    button.addEventListener("contextmenu", (event) => event.preventDefault());

    placeHost();
    let attempts = 0;
    const timer = setInterval(() => {
        attempts += 1;
        const placed = placeHost();
        if (placed || attempts >= 10) clearInterval(timer);
    }, 500);

    // 根据设置开关控制按钮显隐（开=显示）
    const applyVisibility = (value) => {
        const enabled = value !== false;
        host.classList.toggle("gg-suyan-hidden", !enabled);
        host.style.display = enabled ? "inline-flex" : "none";
    };
    window.__ggApplySuyanButton = applyVisibility;

    return { button, applyVisibility };
}

app.registerExtension({
    name: "ComfyUI.GGNodes.SendToSuyan",
    async setup() {
        // 按设置开关的当前值决定按钮显隐（默认隐藏，设置中打开「联动素言」后显示）
        const { applyVisibility } = setupButton();
        applyVisibility(isSuyanButtonEnabled());

        try {
            app.ui?.settings?.addEventListener?.(`${"Comfy.UseNewMenu"}.change`, () => {
                requestAnimationFrame(() => applyVisibility(isSuyanButtonEnabled()));
            });
        } catch {
            // Older ComfyUI builds may not expose this settings event.
        }

        installExecutionHooks();
        installNodeHooks();

        // 画布新增节点时扫描挂钩。installNodeHooks 内已包 configure，
        // 这里只包 add；都用 graph.__ggSuyan*Wrapped 幂等保护，避免重复包装。
        const graph = app.graph;
        if (graph && typeof graph.add === "function" && !graph.__ggSuyanAddWrapped) {
            graph.__ggSuyanAddWrapped = true;
            const originalAdd = graph.add;
            graph.add = function (...args) {
                const result = originalAdd.apply(this, args);
                // add 返回的节点此刻可能还没进 _nodes，下一拍再扫，确保新建的
                // 保存/对比节点也能挂上 onExecuted。
                setTimeout(() => scanAndHookNodes(this), 0);
                return result;
            };
        }
        // 延迟再挂一次（节点可能异步创建：加载工作流 / 撤销重做 / 复制粘贴）
        setTimeout(installNodeHooks, 1500);
        setTimeout(installNodeHooks, 4000);
    },

    settings: [
        {
            id: SETTING_ID,
            category: ["GuliNodes", "素言联动"],
            name: "显示「发送到素言」按钮",
            type: "boolean",
            defaultValue: DEFAULT_ENABLED,
            tooltip: "打开后才会在顶部菜单区显示「发送到素言」图标按钮（默认关闭）。",
            onChange: (value) => window.__ggApplySuyanButton?.(value),
        },
    ],
});
