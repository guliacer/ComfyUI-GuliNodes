import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ggIcon } from "./gg-ui-icons.js";

const SETTING_ID = "GuliNodes.enableMemoryCleanupButtons";
const MENU_DISPLAY_SETTING = "Comfy.UseNewMenu";

const getSettingValue = (id, fallback) => {
    try {
        const value = app.extensionManager?.setting?.get?.(id);
        if (value !== undefined) return value;
    } catch (error) {
        console.warn("[GGMemoryTools] Unable to read setting:", id, error);
    }

    try {
        return app.ui?.settings?.getSettingValue?.(id, fallback) ?? fallback;
    } catch {
        return fallback;
    }
};

const notify = (summary, detail = "", severity = "success") => {
    try {
        const toast = app.extensionManager?.toast;
        if (toast?.add) {
            toast.add({ severity, summary, detail, life: 2600 });
            return;
        }
        if (severity === "error" && toast?.addAlert) {
            toast.addAlert(detail || summary);
            return;
        }
    } catch {
        // Toast is optional across ComfyUI builds.
    }

    const message = detail ? `${summary}: ${detail}` : summary;
    if (severity === "error") console.error(`[GGMemoryTools] ${message}`);
    else console.info(`[GGMemoryTools] ${message}`);
};

app.registerExtension({
    name: "ComfyUI.GGNodes.MemoryTools",

    async setup() {
        let ComfyButtonGroup;

        try {
            ({ ComfyButtonGroup } = await import("../../scripts/ui/components/buttonGroup.js"));
        } catch (error) {
            console.warn("[GGMemoryTools] Comfy button group unavailable, using fallback host.", error);
        }

        let isBusy = false;
        let groupEl;
        let buttons = [];

        const setBusy = (busy) => {
            isBusy = busy;
            groupEl?.classList.toggle("gg-memory-cleanup-busy", busy);
            buttons.forEach((button) => {
                const element = button?.element || button;
                if (element) element.disabled = busy;
            });
        };

        const runCleanup = async (label, payload) => {
            if (isBusy) return;
            setBusy(true);

            try {
                const response = await api.fetchApi("/free", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                    cache: "no-store",
                });

                if (!response?.ok) {
                    const text = await response?.text?.();
                    throw new Error(text || `HTTP ${response?.status || "unknown"}`);
                }

                notify(`${label}请求已提交`, "ComfyUI 会安全释放可卸载的模型与缓存。");
            } catch (error) {
                notify(`${label}失败`, error?.message || String(error), "error");
            } finally {
                setBusy(false);
            }
        };

        const createButton = ({ title, icon, action }) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "comfyui-button gg-ui-top-button gg-memory-cleanup-btn";
            button.title = title;
            button.setAttribute("aria-label", title);
            button.innerHTML = ggIcon(icon, 18);
            button.addEventListener("click", action);
            return button;
        };

        const releaseModelButton = createButton({
            title: "释放模型显存",
            icon: "modelUnload",
            action: () => runCleanup("模型显存释放", { unload_models: true }),
        });
        const deepCleanupButton = createButton({
            title: "深度清理内存/显存",
            icon: "memorySweep",
            action: () => runCleanup("深度清理", { unload_models: true, free_memory: true }),
        });

        buttons = [releaseModelButton, deepCleanupButton];
        groupEl = ComfyButtonGroup ? new ComfyButtonGroup().element : document.createElement("div");
        groupEl.append(releaseModelButton, deepCleanupButton);

        groupEl.id = "gg-memory-cleanup-buttons";
        groupEl.classList.add("gg-memory-cleanup-host");

        const style = document.createElement("style");
        style.textContent = `
            #gg-memory-cleanup-buttons {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                height: 34px;
                flex: 0 0 auto;
            }
            #gg-memory-cleanup-buttons.gg-memory-menu-host,
            #gg-memory-cleanup-buttons.gg-memory-legacy-host {
                position: static;
                margin-inline: 2px;
                z-index: auto;
            }
            #gg-memory-cleanup-buttons.gg-memory-menu-host + #gg-toolbar-top-switch,
            #gg-memory-cleanup-buttons.gg-memory-legacy-host + #gg-toolbar-top-switch {
                margin-left: -6px;
            }
            #gg-toolbar-top-switch.gg-toolbar-after-memory {
                margin-left: -6px !important;
            }
            #gg-memory-cleanup-buttons.gg-memory-floating-host {
                position: fixed;
                top: 18px;
                right: clamp(144px, 25vw, 490px);
                z-index: 99999;
            }
            #gg-memory-cleanup-buttons.gg-memory-hidden {
                display: none !important;
            }
            #gg-memory-cleanup-buttons.gg-memory-cleanup-busy {
                opacity: 0.68;
                pointer-events: none;
            }
            #gg-memory-cleanup-buttons .gg-memory-cleanup-btn {
                width: 34px;
                height: 34px;
                min-width: 34px;
                max-width: 34px;
                padding: 0 !important;
                margin: 0 !important;
                border-radius: 8px;
                border: 1px solid var(--gg-ui-accent-border) !important;
                background: var(--gg-ui-accent-soft) !important;
                color: var(--gg-ui-accent) !important;
                box-shadow: none !important;
                appearance: none;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                box-sizing: border-box;
                line-height: 0 !important;
                cursor: pointer;
                overflow: hidden;
                transition: transform 0.16s ease, background 0.16s ease, border-color 0.16s ease, color 0.16s ease, opacity 0.16s ease;
            }
            #gg-memory-cleanup-buttons .gg-memory-cleanup-btn:hover,
            #gg-memory-cleanup-buttons .gg-memory-cleanup-btn:focus-visible {
                color: var(--gg-ui-accent) !important;
                background: var(--gg-ui-accent-soft) !important;
                border-color: var(--gg-ui-accent-border) !important;
                transform: scale(1.08);
            }
            #gg-memory-cleanup-buttons .gg-memory-cleanup-btn:focus-visible {
                outline: 2px solid var(--gg-ui-accent-border);
                outline-offset: 2px;
            }
            #gg-memory-cleanup-buttons .gg-memory-cleanup-btn:disabled {
                cursor: wait;
                opacity: 0.72;
                transform: none;
            }
            #gg-memory-cleanup-buttons .gg-memory-cleanup-btn .gg-ui-icon {
                width: 18px;
                height: 18px;
                margin: 0;
                flex: 0 0 auto;
                pointer-events: none;
            }
        `;
        document.head.appendChild(style);

        const placeGroup = () => {
            groupEl.classList.remove("gg-memory-menu-host", "gg-memory-legacy-host", "gg-memory-floating-host");

            const settingsGroup = app.menu?.settingsGroup?.element;
            if (settingsGroup?.parentElement) {
                settingsGroup.before(groupEl);
                groupEl.classList.add("gg-memory-menu-host");
                syncToolbarSpacing();
                return true;
            }

            const queueButton = document.getElementById("queue-button");
            if (queueButton?.parentElement) {
                queueButton.insertAdjacentElement("afterend", groupEl);
                groupEl.classList.add("gg-memory-legacy-host");
                syncToolbarSpacing();
                return true;
            }

            if (groupEl.parentElement !== document.body) {
                document.body.appendChild(groupEl);
            }
            groupEl.classList.add("gg-memory-floating-host");
            syncToolbarSpacing();
            return false;
        };

        const syncToolbarSpacing = () => {
            const topSwitch = document.getElementById("gg-toolbar-top-switch");
            topSwitch?.classList.toggle("gg-toolbar-after-memory", groupEl.nextElementSibling === topSwitch);
        };

        const applyVisibility = (enabled) => {
            const isEnabled = enabled !== false;
            placeGroup();
            groupEl.classList.toggle("gg-memory-hidden", !isEnabled);
            groupEl.style.display = isEnabled ? "inline-flex" : "none";
        };

        window.__ggApplyMemoryCleanupButtons = applyVisibility;

        const refreshVisibility = () => applyVisibility(getSettingValue(SETTING_ID, true));
        refreshVisibility();

        let attempts = 0;
        const timer = setInterval(() => {
            attempts += 1;
            const placed = placeGroup();
            refreshVisibility();
            if (placed || attempts >= 10) clearInterval(timer);
        }, 500);

        try {
            app.ui?.settings?.addEventListener?.(`${MENU_DISPLAY_SETTING}.change`, () => {
                requestAnimationFrame(refreshVisibility);
            });
        } catch {
            // Older ComfyUI builds may not expose this settings event.
        }
    },
});
