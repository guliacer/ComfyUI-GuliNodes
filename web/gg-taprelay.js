import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ggIcon } from "./gg-ui-icons.js";

const SETTING_ID = "GuliNodes.enableTapRelayNotification";
const MENU_DISPLAY_SETTING = "Comfy.UseNewMenu";
const NOTIFY_ROUTE = "/guli/taprelay/notify";
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

function getWorkflowName() {
    let filename = "";

    // The browser tab title is the most reliable source in the current menu:
    // useBrowserTabTitle sets it to "<prefix><name><unsaved> - ComfyUI",
    // where <prefix> is an execution progress hint like "[34%] " and
    // <name> is the active workflow filename.
    const title = document.title || "";
    const suffixIndex = title.lastIndexOf(" - ComfyUI");
    let candidate = suffixIndex !== -1 ? title.slice(0, suffixIndex) : title;
    candidate = candidate.replace(/^\[[0-9]+%\]\s*/, "").trim();
    candidate = candidate.replace(/^\s*\*\s*/, "").trim();
    if (candidate && candidate !== "ComfyUI") {
        filename = candidate;
    }

    if (!filename) {
        // Fallbacks for older ComfyUI builds / legacy menu.
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

function getPositivePrompt(graph) {
    try {
        // graphToPrompt() resolves to { workflow, output } where `output` is
        // the API prompt (nodeId -> node). The old code read `graph.prompt`
        // which never exists, so the positive prompt was always empty.
        const prompt = graph?.output ?? graph?.prompt;
        if (!prompt || typeof prompt !== "object") return "";
        const linkCache = new Map();
        const resolveText = (nodeId) => {
            if (linkCache.has(nodeId)) return linkCache.get(nodeId);
            const node = prompt[nodeId];
            if (!node) return "";
            const text = node?.inputs?.text;
            if (Array.isArray(text)) {
                linkCache.set(nodeId, "");
                const linkedId = text[0];
                const linked = resolveText(linkedId);
                linkCache.set(nodeId, linked);
                return linked;
            }
            const value = typeof text === "string" ? text : "";
            linkCache.set(nodeId, value);
            return value;
        };
        for (const nodeId of Object.keys(prompt)) {
            const node = prompt[nodeId];
            if (!node) continue;
            const positive = node?.inputs?.positive;
            if (positive && Array.isArray(positive)) {
                const resolved = resolveText(String(positive[0]));
                if (resolved) return resolved.slice(0, MAX_MESSAGE_LENGTH);
            }
        }
        return "";
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

    try {
        const response = await fetch(NOTIFY_ROUTE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: finalMessage,
                projectName: currentWorkflowName,
                source: DEFAULT_SOURCE,
                status,
                taskId,
                durationMs,
            }),
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

app.registerExtension({
    name: "ComfyUI.GGNodes.TapRelay",

    async setup() {
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
