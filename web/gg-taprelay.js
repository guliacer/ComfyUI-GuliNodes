import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ggIcon } from "./gg-ui-icons.js";

const SETTING_ID = "GuliNodes.enableTapRelayNotification";
const MENU_DISPLAY_SETTING = "Comfy.UseNewMenu";
const NOTIFY_ROUTE = "/guli/taprelay/notify";
const TASK_LOG_ROUTE = "/guli/taprelay/task-log";
const COMPLETION_MESSAGE = "ComfyUI 工作流已完成";
const FAILURE_MESSAGE_PREFIX = "ComfyUI 工作流运行失败";
const DEFAULT_SOURCE = "comfyui";
const DEFAULT_STATUS = "completed";
const FAILED_STATUS = "failed";
const MAX_TRACKED_EXECUTIONS = 128;
const MAX_MESSAGE_LENGTH = 500;
const MAX_PROJECT_NAME_LENGTH = 200;

const startedExecutions = new Map();
const notifiedTaskIds = new Set();
let activePromptId = "";
let anonymousStartTime = 0;
let currentWorkflowName = "";
let currentPositivePrompt = "";
let serializedGraph = "";
let serializedWorkflow = "";

/**
 * 先精确匹配已知类型，再按类名包含试探。
 * 用于采样进度日志的去重过滤。
 */
const KNOWN_SAMPLER_TYPES = new Set([
    "KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced",
    "GGZImageSampler", "GG\u91C7\u6837\u5668"
]);

function getWorkflowName() {
    let filename = "";

    const title = document.title || "";
    const suffixIndex = title.lastIndexOf(" - ComfyUI");
    let candidate = suffixIndex !== -1 ? title.slice(0, suffixIndex) : title;
    candidate = candidate.replace(/^\[[0-9]+%\]\s*/, "").trim();
    candidate = candidate.replace(/^\s*\*\s*/, "").trim();
    if (candidate && candidate !== "ComfyUI") {
        filename = candidate;
    }

    if (!filename) {
        const workflowStore = app.ui?.workflowStore;
        filename =
            workflowStore?.activeWorkflow?.filename ||
            workflowStore?.activeWorkflow?.name ||
            app.filename ||
            app.graph?.name;
    }

    if (!filename) return "";
    const stripped = String(filename).replace(/\.json$/i, "").trim();
    return stripped.slice(0, MAX_PROJECT_NAME_LENGTH);
}

/**
 * 从执行 prompt 图的 output 中提取采样器正向提示词文本。
 *
 * 与 PC 端 ComfyUIPromptParser 策略一致：
 * 1. 采样器识别：已知 class_type → 输入契约（latent/noise + conditioning + param）
 * 2. 沿 guider 链穿透：SamplerCustomAdvanced.guider → BasicGuider/CFGGuider.positive
 * 3. 文本质量过滤：节点类名 or 输入键名提示为文本源的才收录
 * 4. BFS + 收集全部候选 → 取最长
 */
function getPositivePrompt(graph) {
    try {
        const prompt = graph?.output ?? graph?.prompt;
        if (!prompt || typeof prompt !== "object") return "";

        const entries = Object.entries(prompt);

        // ── 索引 ──
        const textIndex = {};        // nodeId → string[]
        const edgeIndex = {};        // nodeId → { inputKey: targetNodeId }
        const classTypeIndex = {};   // nodeId → class_type
        const inputKeysByNode = {};  // nodeId → Set<string>

        for (const [nodeId, node] of entries) {
            if (!node || typeof node !== "object") continue;
            if (typeof node.class_type === "string") {
                classTypeIndex[nodeId] = node.class_type;
            }
            if (!node.inputs || typeof node.inputs !== "object") continue;

            const edges = {};
            const inputKeys = new Set();
            const texts = [];

            for (const [key, val] of Object.entries(node.inputs)) {
                inputKeys.add(key);
                if (typeof val === "string" && val.trim().length >= 2) {
                    texts.push(val.trim());
                } else if (Array.isArray(val) && val.length >= 1 && typeof val[0] === "string") {
                    edges[key] = val[0];
                }
            }

            if (texts.length > 0) textIndex[nodeId] = texts;
            if (Object.keys(edges).length > 0) edgeIndex[nodeId] = edges;
            if (inputKeys.size > 0) inputKeysByNode[nodeId] = inputKeys;
        }

        // ── 采样器识别 ──
        const KNOWN_SAMPLERS = new Set([
            "KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced",
            "GGZImageSampler", "GG\u91C7\u6837\u5668"
        ]);
        const NON_SAMPLERS = new Set(["KSamplerSelect", "SamplerSelect"]);

        function isSamplerNode(nodeId, inputKeys) {
            const ct = classTypeIndex[nodeId];
            if (ct && KNOWN_SAMPLERS.has(ct)) return true;
            if (ct && NON_SAMPLERS.has(ct)) return false;
            if (matchesSamplerContract(inputKeys)) return true;
            if (ct && (ct.includes("Sampler") || ct.includes("\u91C7\u6837\u5668"))) return true;
            return false;
        }

        const DIFFUSION_KEYS = new Set(["latent_image", "latent", "samples", "latent_samples", "noise", "sigmas"]);
        const POSITIVE_ONLY_KEYS = new Set(["positive", "positive_conditioning"]);
        const CONDITIONING_KEYS = new Set(["positive", "positive_conditioning", "conditioning", "negative", "negative_conditioning", "guider", "guide"]);
        const EXECUTION_KEYS = new Set(["model", "unet", "sampler", "steps", "cfg", "denoise", "seed", "scheduler", "start_step", "end_step", "return_with_leftover_noise"]);

        function matchesSamplerContract(inputKeys) {
            if (!inputKeys) return false;
            let hasDiff = false, hasCond = false, hasExec = false;
            for (const k of inputKeys) {
                if (DIFFUSION_KEYS.has(k)) hasDiff = true;
                if (CONDITIONING_KEYS.has(k)) hasCond = true;
                if (EXECUTION_KEYS.has(k)) hasExec = true;
                if (hasDiff && hasCond && hasExec) return true;
            }
            return false;
        }

        // ── 文本质量 ──
        const TEXT_CLASS_HINTS = ["CLIP", "Text", "Encode", "Prompt", "Show", "Display", "Wildcard", "Style", "Conditioning"];
        const TEXT_INPUT_KEYS = new Set(["text", "prompt", "prompt_text", "\u6587\u672C", "string", "content", "value", "text1", "text2", "text_a", "text_b", "text_g", "text_l", "prompt_positive", "prompt_negative", "positive_prompt", "negative_prompt"]);

        function isLikelyNoise(text) {
            if (!text) return true;
            const modelExts = [".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft"];
            for (const ext of modelExts) {
                if (text.toLowerCase().endsWith(ext)) return true;
            }
            // Check for path-like noise
            let pathSep = 0, alpha = 0;
            for (let i = 0; i < Math.min(text.length, 60); i++) {
                const c = text[i];
                if (c === '/' || c === '\\') pathSep++;
                if (/[a-zA-Z]/.test(c)) alpha++;
            }
            if (pathSep >= 2 && alpha < 5) return true;
            return false;
        }

        const COND_PATH_HINTS = ['Guider', 'CLIP', 'Text', 'Encode', 'Prompt', 'Show', 'Display',
            'Wildcard', 'Style', 'Conditioning', 'Concat', 'Edit', 'Switch', 'Selector', 'If',
            '引导', '文本', '提示词', 'CR', 'SDXLPromptStyler', 'StringFunction', 'Intermediate'];

        function isConditioningPathNode(nodeId) {
            const ct = classTypeIndex[nodeId];
            if (!ct) return false;
            for (const h of COND_PATH_HINTS) {
                if (ct.toLowerCase().includes(h.toLowerCase())) return true;
            }
            // Also check input keys
            const ik = inputKeysByNode[nodeId];
            if (ik) {
                for (const tk of TEXT_INPUT_KEYS) {
                    if (ik.has(tk)) return true;
                }
            }
            // Fallback: if node has outgoing edges, treat as on-path
            if (edgeIndex[nodeId] && Object.keys(edgeIndex[nodeId]).length > 0) return true;
            return false;
        }

        function isMetaPrompt(text) {
            if (!text) return true;
            return text.startsWith('You are') || text.startsWith('Your task is') ||
                text.startsWith('Think step by step') ||
                text.includes('You are an expert prompt engineer') ||
                text.includes('Your task is to expand') ||
                text.includes('Think step by step about') ||
                text.includes('Then output a single') ||
                text.startsWith('System:') || text.startsWith('Instruction:') ||
                text.startsWith('Assistant:');
        }

        function isPlausibleText(text, nodeId) {
            if (!text || text.length < 2) return false;
            if (isMetaPrompt(text)) return false;
            if (isLikelyNoise(text)) return false;
            const ct = classTypeIndex[nodeId];
            if (ct) {
                for (const hint of TEXT_CLASS_HINTS) {
                    if (ct.toLowerCase().includes(hint.toLowerCase())) return true;
                }
            }
            const ik = inputKeysByNode[nodeId];
            if (ik) {
                for (const k of ik) {
                    if (TEXT_INPUT_KEYS.has(k)) return true;
                }
            }
            return text.length >= 20;
        }

        // ── 遍历采样器，BFS 收集候选 ──
        const collected = [];

        for (const [nodeId] of entries) {
            const ik = inputKeysByNode[nodeId];
            if (!ik) continue;
            if (!isSamplerNode(nodeId, ik)) continue;

            // Inline string positives
            const node = prompt[nodeId];
            if (node?.inputs) {
                for (const key of CONDITIONING_KEYS) {
                    const v = node.inputs[key];
                    if (typeof v === "string" && v.trim().length >= 2) {
                        collected.push(v.trim());
                    }
                }
            }

            // BFS from conditioning edges: only POSITIVE path initially.
            // Skip negative to avoid boilerplate English negatives winning over short Chinese prompts.
            const queue = [];
            const visited = new Set();
            const samplerEdges = edgeIndex[nodeId];
            if (samplerEdges) {
                for (const key of POSITIVE_ONLY_KEYS) {
                    const ref = samplerEdges[key];
                    if (ref && !visited.has(ref)) {
                        visited.add(ref);
                        queue.push(ref);
                    }
                }
                for (const gk of ["guider", "guide"]) {
                    const ref = samplerEdges[gk];
                    if (ref && !visited.has(ref)) {
                        visited.add(ref);
                        queue.push(ref);
                    }
                }
                for (const [key, ref] of Object.entries(samplerEdges)) {
                    if (key.toLowerCase().includes("positive") && !visited.has(ref)) {
                        visited.add(ref);
                        queue.push(ref);
                    }
                }
            }

            let vc = 0;
            while (queue.length > 0 && vc < 128) {
                const curId = queue.shift();
                vc++;
                const curCt = classTypeIndex[curId] || null;
                const isGuider = curCt && (curCt.toLowerCase().includes("guider") || curCt.includes("引导"));

                const texts = textIndex[curId];
                if (texts) {
                    for (const t of texts) {
                        if (isPlausibleText(t, curId)) collected.push(t);
                    }
                }
                const curEdges = edgeIndex[curId];
                if (curEdges) {
                    // Only follow edges from conditioning-path nodes
                    if (!isConditioningPathNode(curId)) {
                        // Dead-end: this node is off the text-condition path
                    } else {
                        for (const [ek, ref] of Object.entries(curEdges)) {
                            if (!visited.has(ref)) {
                                if (isGuider && ek.toLowerCase().includes("negative")) continue;
                                visited.add(ref);
                                queue.push(ref);
                            }
                        }
                    }
                }
            }
        }

        // 取最长
        let best = "";
        for (const t of collected) {
            if (isMetaPrompt(t)) continue;
            if (t.length > best.length) best = t;
        }
        return best ? best.slice(0, MAX_MESSAGE_LENGTH) : "";
    } catch {
        return "";
    }
}

/**
 * 序列化工作流执行图 JSON。
 * 优先使用 app.graphToPrompt()，回退到 JSON.stringify(graph.serialize())。
 */
async function serializeExecutionGraph() {
    try {
        // 新 API：graphToPrompt 返回 { workflow, output }
        if (typeof app.graphToPrompt === "function") {
            const result = await app.graphToPrompt();
            if (result?.output) {
                return JSON.stringify(result.output, null, 2);
            }
        }
    } catch {
        // 降级到序列化
    }

    try {
        const serialized = app.graph?.serialize?.();
        if (serialized) {
            return JSON.stringify(serialized, null, 2);
        }
    } catch {
        // 降级到空
    }

    return "";
}

/**
 * 序列化 UI 工作流 JSON（workflow 块格式：{nodes, links}）。
 * 该格式的 widgets_values 保存的是用户实际输入的文本，
 * 比 API 执行图（prompt 块）更可靠（后者可能在批量生图时沿用上一轮值）。
 */
async function serializeWorkflowGraph() {
    try {
        const serialized = app.graph?.serialize?.();
        if (serialized) {
            return JSON.stringify(serialized, null, 2);
        }
    } catch {
        // 降级到空
    }
    return "";
}

/**
 * 沿采样器节点沿输入边 BFS 溯源寻找正向提示词文本（与 PC 端 BFS 一致），
 * 用于采样进度日志。支持 guider 链穿透（SamplerCustomAdvanced → BasicGuider → CLIPTextEncode）、
 * GuliNodes 中文键，以及中间节点链。
 * 关键：在 guider 节点处跳过 negative 路径，避免负向提示词被误当正反馈。
 */
function resolveKSamplerPrompt(graph, nodeId) {
    try {
        if (!graph) return "";
        const nodes = graph._nodes ?? [];
        const startNode = nodes.find((n) => String(n.id) === String(nodeId));
        if (!startNode) return "";

        const visited = new Set();
        const queue = [{ node: startNode, isNegativePath: false }];
        let bestText = "";
        let visitedCount = 0;

        while (queue.length > 0 && visitedCount < 128) {
            const { node: current, isNegativePath } = queue.shift();
            if (visited.has(current)) continue;
            visited.add(current);
            visitedCount++;

            // ── Guider 检测 ──
            const ct = current.comfyClass || current.type || "";
            const isGuider = ct.toLowerCase().includes("guider") || ct.includes("引导");

            // ── 收集文本（仅非 negative 路径）──
            if (!isNegativePath) {
                const widgets = current.widgets ?? [];
                const textWidget =
                    widgets.find((w) => w?.name === "text") ??
                    widgets.find((w) => w?.name === "文本") ??
                    widgets.find((w) => w?.name === "prompt_text") ??
                    widgets.find((w) => w?.name === "string") ??
                    widgets.find((w) => w?.name === "text1");
                if (textWidget && typeof textWidget.value === "string" && textWidget.value.trim()) {
                    const t = textWidget.value.trim();
                    if (t.length > bestText.length) bestText = t;
                }
            }

            // ── 遍历上游输入边 ──
            for (const input of current.inputs ?? []) {
                const linkId = input?.link;
                if (linkId === undefined || linkId === null) continue;
                const link = graph.links?.get?.(linkId) ?? graph.links?.find?.((l) => l[0] === linkId);
                const originId = Array.isArray(link) ? link[1] : link?.origin_id ?? link?.originId;
                if (originId === undefined || originId === null) continue;
                const originNode = nodes.find((n) => n.id === originId);
                if (originNode && !visited.has(originNode)) {
                    // 在 guider 节点处标记 negative 路径
                    const slotName = input?.name || "";
                    const childNegative = isNegativePath ||
                        (isGuider && slotName.toLowerCase().includes("negative"));
                    queue.push({ node: originNode, isNegativePath: childNegative });
                }
            }
        }

        return (bestText || "").slice(0, MAX_MESSAGE_LENGTH);
    } catch {
        return "";
    }

}

function rememberExecutionContext(graph) {
    currentWorkflowName = getWorkflowName();
    currentPositivePrompt = getPositivePrompt(graph);
}

async function rememberExecutionContextFromGraph() {
    if (typeof app.graphToPrompt !== "function") {
        rememberExecutionContext(null);
        return;
    }
    try {
        const result = await app.graphToPrompt();
        rememberExecutionContext(result);
    } catch {
        rememberExecutionContext(null);
    }
}

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

async function setSettingValue(id, value) {
    try {
        if (app.extensionManager?.setting?.set) {
            await app.extensionManager.setting.set(id, value);
            return;
        }
    } catch (error) {
        console.warn("[GuliNodes] Unable to write extension setting:", id, error);
    }

    try {
        app.ui?.settings?.setSettingValue?.(id, value);
    } catch (error) {
        console.warn("[GuliNodes] Unable to write UI setting:", id, error);
    }
}

function isNotificationEnabled() {
    return getSettingValue(SETTING_ID, true) !== false;
}

function promptIdFromDetail(detail) {
    const value = detail?.prompt_id ?? detail?.promptId;
    return value === undefined || value === null ? "" : String(value).trim();
}

function trimMap(map) {
    while (map.size > MAX_TRACKED_EXECUTIONS) {
        map.delete(map.keys().next().value);
    }
}

function trimSet(set) {
    while (set.size > MAX_TRACKED_EXECUTIONS) {
        set.delete(set.values().next().value);
    }
}

function rememberExecutionStart(detail) {
    const promptId = promptIdFromDetail(detail);
    const startedAt = performance.now();
    anonymousStartTime = startedAt;
    activePromptId = promptId;
    if (promptId) {
        startedExecutions.set(promptId, startedAt);
        trimMap(startedExecutions);
    }
}

function getDurationMs(promptId) {
    const startedAt = promptId ? startedExecutions.get(promptId) : anonymousStartTime;
    if (promptId) startedExecutions.delete(promptId);
    if (!Number.isFinite(startedAt)) return 0;

    const duration = Math.round(performance.now() - startedAt);
    return duration > 0 ? duration : 0;
}

async function notifyTapRelay(promptId, durationMs, { status = DEFAULT_STATUS, message = "" } = {}) {
    if (!isNotificationEnabled()) return;

    const taskId = promptId || `comfyui-${Date.now()}`;
    if (notifiedTaskIds.has(taskId)) return;
    notifiedTaskIds.add(taskId);
    trimSet(notifiedTaskIds);

    const finalMessage =
        status === FAILED_STATUS
            ? message || currentPositivePrompt || COMPLETION_MESSAGE
            : currentPositivePrompt || COMPLETION_MESSAGE;

    const payload = {
        message: finalMessage,
        projectName: currentWorkflowName,
        source: DEFAULT_SOURCE,
        status,
        taskId,
        durationMs,
    };

    // 每次完成都附带序列化后的执行图（prompt）和 UI 工作流（workflow）
    if (serializedGraph) {
        payload.prompt = serializedGraph;
    }
    if (serializedWorkflow) {
        payload.workflow = serializedWorkflow;
    }

    try {
        const response = await fetch(NOTIFY_ROUTE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            let detail = "";
            try {
                const body = await response.json();
                detail = body?.error || "";
            } catch {
                // Keep the HTTP status when the proxy has no JSON response.
            }
            throw new Error(detail || `HTTP ${response.status}`);
        }
    } catch (error) {
        console.warn(`[GuliNodes] TapRelay 通知失败：${error?.message || error}`);
    }
}

/**
 * 向 TapRelay 发送任务日志（采样进度等）。
 * 支持分步推送，每步包含当前 step、总 steps、节点名称和提示词。
 */
async function sendTaskLog(promptId, data) {
    if (!isNotificationEnabled()) return;

    try {
        await fetch(TASK_LOG_ROUTE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                taskId: promptId || activePromptId || `comfyui-${Date.now()}`,
                projectName: currentWorkflowName,
                source: DEFAULT_SOURCE,
                type: "sampling",
                ...data,
            }),
        });
    } catch (error) {
        // 任务日志为可选功能，静默失败
    }
}

app.registerExtension({
    name: "ComfyUI.GGNodes.TapRelay",

    async setup() {
        // 初始序列化执行图
        void serializeExecutionGraph().then((graph) => {
            serializedGraph = graph;
        });
        void serializeWorkflowGraph().then((wf) => {
            serializedWorkflow = wf;
        });

        // 监听画布变更，重新序列化执行图
        const graph = app.graph;
        if (graph && !graph.__ggTapRelayConfigureWrapped) {
            const originalConfigure = graph.configure;
            if (typeof originalConfigure === "function") {
                graph.__ggTapRelayConfigureWrapped = true;
                graph.configure = function (...args) {
                    const result = originalConfigure.apply(this, args);
                    // 延迟执行，确保节点已加载
                    setTimeout(async () => {
                        serializedGraph = await serializeExecutionGraph();
                        serializedWorkflow = await serializeWorkflowGraph();
                    }, 200);
                    return result;
                };
            }
        }

        // 采样进度缓存：按 promptId 和 nodeId 记录已发送的 step，避免重复推送（Set 去重）
        const samplingProgressCache = new Set();

        // 监听 progress_state 事件（新 ComfyUI 前端）
        api.addEventListener("progress_state", ({ detail }) => {
            if (!isNotificationEnabled()) return;
            if (!detail?.nodes) return;

            const promptId = detail.prompt_id || detail.promptId || activePromptId;
            if (!promptId) return;

            const nodes = detail.nodes;
            for (const [nodeId, state] of Object.entries(nodes)) {
                // 只处理运行中的采样节点
                if (state.state !== "running") continue;

                // 通过 display_node_id 或 real_node_id 查找是否为采样器节点
                const displayNodeId = state.display_node_id ?? state.node_id ?? nodeId;
                const graphNodes = app.graph?._nodes ?? [];
                const graphNode = graphNodes.find(
                    (n) => String(n.id) === String(displayNodeId)
                );
                const nodeType = graphNode?.comfyClass || graphNode?.type || "";

                const isSamplerType = KNOWN_SAMPLER_TYPES.has(nodeType) || nodeType.includes("Sampler") || nodeType.includes("采样器");
                if (!isSamplerType) continue;

                const step = Math.round(state.value);
                const maxSteps = Math.round(state.max);

                // 去重：同一步不重复发送
                const cacheKey = `${promptId}:${nodeId}:${step}`;
                if (samplingProgressCache.has(cacheKey)) continue;
                samplingProgressCache.add(cacheKey);
                trimSet(samplingProgressCache);

                // 解析该节点的正向提示词
                const promptText = graphNode
                    ? resolveKSamplerPrompt(app.graph, displayNodeId)
                    : currentPositivePrompt;

                const nodeTitle = graphNode?.title || nodeType || nodeId;

                // 发送任务日志
                void sendTaskLog(promptId, {
                    nodeId: displayNodeId,
                    nodeTitle,
                    nodeType,
                    step,
                    maxSteps,
                    prompt: promptText,
                    timestamp: Date.now(),
                });
            }
        });
        // 每 5 秒清理一次采样进度缓存，防止内存泄漏
        setInterval(() => {
            if (samplingProgressCache.size > 500) {
                const entries = [...samplingProgressCache];
                const toDelete = entries.slice(0, entries.length - 300);
                for (const key of toDelete) {
                    samplingProgressCache.delete(key);
                }
            }
        }, 5000);

        let ComfyButtonGroup;
        try {
            ({ ComfyButtonGroup } = await import("../../scripts/ui/components/buttonGroup.js"));
        } catch (error) {
            console.warn("[GuliNodes] TapRelay 顶部开关将使用回退容器：", error);
        }

        const toggleHost = ComfyButtonGroup ? new ComfyButtonGroup().element : document.createElement("div");
        const toggleButton = document.createElement("button");
        toggleHost.id = "gg-taprelay-toggle-host";
        toggleHost.classList.add("gg-taprelay-toggle-host");
        toggleButton.id = "gg-taprelay-toggle-button";
        toggleButton.type = "button";
        toggleButton.className = "comfyui-button gg-ui-top-button gg-taprelay-toggle-button";
        toggleHost.appendChild(toggleButton);

        const style = document.createElement("style");
        style.textContent = `
            #gg-taprelay-toggle-host {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                height: 34px;
                flex: 0 0 auto;
            }
            #gg-taprelay-toggle-host.gg-taprelay-menu-host,
            #gg-taprelay-toggle-host.gg-taprelay-legacy-host {
                position: static;
                margin-inline: 2px;
                z-index: auto;
            }
            #gg-taprelay-toggle-host.gg-taprelay-floating-host {
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
            #gg-taprelay-toggle-button {
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
            }
            #gg-taprelay-toggle-button.gg-state-on {
                color: var(--gg-ui-accent) !important;
                background: var(--gg-ui-accent-soft) !important;
                border-color: var(--gg-ui-accent-border) !important;
            }
            #gg-taprelay-toggle-button.gg-state-off {
                color: var(--gg-ui-muted) !important;
                background: rgba(148,163,184,0.08) !important;
                border-color: rgba(148,163,184,0.18) !important;
            }
            #gg-taprelay-toggle-button .gg-ui-icon {
                width: 18px;
                height: 18px;
                pointer-events: none;
            }
            @media (max-width: 760px) {
                #gg-taprelay-toggle-host.gg-taprelay-floating-host {
                    top: 12px;
                    right: 12px;
                }
            }
        `;
        document.head.appendChild(style);

        const placeToggleHost = () => {
            if (window.__ggMountTopGroup?.(toggleHost)) return true;
            toggleHost.classList.remove("gg-taprelay-menu-host", "gg-taprelay-legacy-host", "gg-taprelay-floating-host");

            const settingsGroup = app.menu?.settingsGroup?.element;
            if (settingsGroup?.parentElement) {
                settingsGroup.before(toggleHost);
                toggleHost.classList.add("gg-taprelay-menu-host");
                return true;
            }

            const queueButton = document.getElementById("queue-button");
            if (queueButton?.parentElement) {
                queueButton.insertAdjacentElement("afterend", toggleHost);
                toggleHost.classList.add("gg-taprelay-legacy-host");
                return true;
            }

            if (toggleHost.parentElement !== document.body) {
                document.body.appendChild(toggleHost);
            }
            toggleHost.classList.add("gg-taprelay-floating-host");
            return false;
        };

        const updateToggleButton = (value) => {
            const enabled = value !== false;
            toggleButton.classList.toggle("active", enabled);
            toggleButton.classList.toggle("gg-state-on", enabled);
            toggleButton.classList.toggle("gg-state-off", !enabled);
            toggleButton.setAttribute("aria-pressed", enabled ? "true" : "false");
            toggleButton.title = enabled
                ? "关闭 ComfyUI 完成后 TapRelay 通知"
                : "开启 ComfyUI 完成后 TapRelay 通知";
            toggleButton.setAttribute("aria-label", toggleButton.title);
            toggleButton.innerHTML = ggIcon(enabled ? "bell" : "bellOff", 18);
        };

        const refreshToggleButton = () => updateToggleButton(getSettingValue(SETTING_ID, true));
        window.__ggApplyTapRelayToggle = updateToggleButton;
        toggleButton.addEventListener("click", () => {
            const nextEnabled = !isNotificationEnabled();
            updateToggleButton(nextEnabled);
            void setSettingValue(SETTING_ID, nextEnabled);
        });
        toggleButton.addEventListener("contextmenu", (event) => event.preventDefault());

        placeToggleHost();
        refreshToggleButton();
        let placementAttempts = 0;
        const placementTimer = setInterval(() => {
            placementAttempts += 1;
            const placed = placeToggleHost();
            refreshToggleButton();
            if (placed || placementAttempts >= 10) clearInterval(placementTimer);
        }, 500);

        try {
            app.ui?.settings?.addEventListener?.(`${MENU_DISPLAY_SETTING}.change`, () => {
                requestAnimationFrame(() => {
                    placeToggleHost();
                    refreshToggleButton();
                });
            });
            app.ui?.settings?.addEventListener?.(`${SETTING_ID}.change`, () => {
                requestAnimationFrame(refreshToggleButton);
            });
        } catch {
            // Older ComfyUI builds may not expose settings events.
        }

        api.addEventListener("execution_start", ({ detail }) => {
            rememberExecutionStart(detail);
            void rememberExecutionContextFromGraph();

            // 每次执行开始时重新序列化执行图和工作流
            void serializeExecutionGraph().then((graph) => {
                serializedGraph = graph;
            });
            void serializeWorkflowGraph().then((wf) => {
                serializedWorkflow = wf;
            });
        });

        api.addEventListener("execution_success", ({ detail }) => {
            const promptId = promptIdFromDetail(detail) || activePromptId;
            activePromptId = "";
            void notifyTapRelay(promptId, getDurationMs(promptId));
        });

        api.addEventListener("execution_error", ({ detail }) => {
            const promptId = promptIdFromDetail(detail) || activePromptId;
            activePromptId = "";
            const exceptionType = detail?.exception_type || "";
            const exceptionMessage = String(detail?.exception_message || "").slice(0, 200);
            const messageBits = [FAILURE_MESSAGE_PREFIX];
            if (exceptionType) messageBits.push(exceptionType);
            if (exceptionMessage) messageBits.push(exceptionMessage);
            const failureMessage = messageBits.join("：").slice(0, MAX_MESSAGE_LENGTH);
            void notifyTapRelay(promptId, getDurationMs(promptId), {
                status: FAILED_STATUS,
                message: failureMessage,
            });
        });
    },

    settings: [
        {
            id: SETTING_ID,
            category: ["GuliNodes", "TapRelay"],
            name: "ComfyUI 完成后通知 TapRelay",
            type: "boolean",
            defaultValue: true,
            tooltip: "工作流成功完成后，通过本机 1122 端口发送 TapRelay 通知。",
            onChange: (value) => window.__ggApplyTapRelayToggle?.(value),
        },
    ],
});
