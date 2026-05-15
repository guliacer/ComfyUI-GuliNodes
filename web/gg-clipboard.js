import { app } from "../../scripts/app.js";

const SETTINGS_ID = "GuliNodes";
const STORAGE_KEY = "ggFloatToolbarSettings";

const SKIP_WIDGET_TYPES = new Set(["button", "toggle", "combo", "number", "slider"]);

const _timers = new Set();
let _initialized = false;

let _currentSettings = loadSettings();

function loadSettings() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved ? JSON.parse(saved) : getDefaultSettings();
    } catch {
        return getDefaultSettings();
    }
}

function getDefaultSettings() {
    return {
        background: "#282828",
        opacity: 0.95
    };
}

function saveSettings() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(_currentSettings));
    } catch {}
}

function clearTimer(id) {
    clearInterval(id);
    clearTimeout(id);
    _timers.delete(id);
}

function clearAllTimers() {
    _timers.forEach((id) => { clearInterval(id); clearTimeout(id); });
    _timers.clear();
}

function managedInterval(fn, ms) {
    const id = setInterval(() => {
        try { fn(); } catch (e) { console.warn("[GGClipboard] Interval error:", e); }
    }, ms);
    _timers.add(id);
    return id;
}

function managedTimeout(fn, ms) {
    const id = setTimeout(() => {
        try { fn(); } catch (e) { console.warn("[GGClipboard] Timeout error:", e); }
    }, ms);
    _timers.add(id);
    return id;
}

function writeClipboard(text) {
    if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
        const el = document.createElement("textarea");
        el.value = text;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        try { document.execCommand("copy"); resolve(); } catch { reject(); }
        finally { document.body.removeChild(el); }
    });
}

function isFloatingEnabled() {
    try {
        return app.ui.settings.getSettingValue(`${SETTINGS_ID}.enableFloatButtons`, true);
    } catch { return true; }
}

function isToolbarEnabled() {
    try {
        return app.ui.settings.getSettingValue(`${SETTINGS_ID}.enableToolbar`, true);
    } catch { return true; }
}

function getTextWidget(node, name = "文本") {
    return node.widgets?.find((w) => w.name === name);
}

function findWidgetElement(widget) {
    if (!widget) return null;
    if (widget.element) return widget.element;
    if (widget.inputEl) return widget.inputEl;

    const nodeId = widget.parent?.id;
    const nodeEl = widget.parent?.element || document.querySelector(`#node-${nodeId}`);
    if (!nodeEl) return null;

    const textareas = nodeEl.querySelectorAll("textarea.comfy-multiline-input, textarea");
    for (const ta of textareas) {
        const label = ta.previousElementSibling;
        if (label && label.classList?.contains("widget-label")) {
            if (label.textContent.trim() === widget.name) return ta;
        }
        if (ta.dataset.widgetName === widget.name) return ta;
        if (widget.value !== undefined && ta.value === String(widget.value)) return ta;
    }

    const inputs = nodeEl.querySelectorAll("input[type='text'], input:not([type])");
    for (const inp of inputs) {
        const label = inp.previousElementSibling;
        if (label && label.classList?.contains("widget-label") && label.textContent.trim() === widget.name) return inp;
        if (inp.dataset.widgetName === widget.name) return inp;
        if (widget.value !== undefined && inp.value === String(widget.value)) return inp;
    }

    const labelEls = nodeEl.querySelectorAll(".widget-label");
    for (const labelEl of labelEls) {
        if (labelEl.textContent.trim() === widget.name) {
            const next = labelEl.nextElementSibling;
            if (next) {
                if (next.tagName === "TEXTAREA" || next.tagName === "INPUT") return next;
                const inner = next.querySelector("textarea, input, .comfy-multiline-input, .widget-input");
                if (inner) return inner;
            }
            const container = labelEl.parentElement;
            if (container) {
                const input = container.querySelector("textarea, input, .comfy-multiline-input, .widget-input");
                if (input) return input;
            }
        }
    }

    return null;
}

function setTextWidgetValue(widget, text) {
    if (!widget) return;
    widget.value = text;
    const el = findWidgetElement(widget) || widget.element;
    if (el) {
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
            el.value = text;
        } else {
            const inner = el.querySelector("textarea, input");
            if (inner) inner.value = text;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
    }
}

function getWidgetValue(widget) {
    if (!widget) return "";
    const el = findWidgetElement(widget) || widget.element;
    if (el) {
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
            return el.value;
        }
        const inner = el.querySelector("textarea, input");
        if (inner) return inner.value;
    }
    return String(widget.value ?? "");
}

const ICON_COPY = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const ICON_PASTE = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>`;
const ICON_CLEAR = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const ICON_CHECK = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const ICON_ERROR = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

let _currentContextMenu = null;

function createContextMenu(e) {
    if (_currentContextMenu) {
        _currentContextMenu.remove();
    }

    const menu = document.createElement("div");
    menu.className = "gg-context-menu";
    Object.assign(menu.style, {
        position: "fixed",
        top: `${e.clientY}px`,
        left: `${e.clientX}px`,
        background: "rgba(30, 30, 30, 0.98)",
        border: "1px solid rgba(80, 80, 80, 0.6)",
        borderRadius: "10px",
        padding: "8px 0",
        minWidth: "220px",
        zIndex: "100000",
        boxShadow: "0 10px 40px rgba(0, 0, 0, 0.5)",
        backdropFilter: "blur(12px)",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: "13px",
        color: "#e0e0e0",
    });

    const closeMenu = () => {
        if (menu.parentElement) menu.remove();
        if (_currentContextMenu === menu) _currentContextMenu = null;
        document.removeEventListener("click", closeMenu);
        document.removeEventListener("contextmenu", closeMenu);
        document.removeEventListener("mousedown", onMouseDown);
    };

    const onMouseDown = (ev) => {
        if (!menu.contains(ev.target)) closeMenu();
    };

    document.addEventListener("click", closeMenu);
    document.addEventListener("contextmenu", closeMenu);
    document.addEventListener("mousedown", onMouseDown);

    const title = document.createElement("div");
    title.textContent = "悬浮按钮设置";
    Object.assign(title.style, {
        padding: "8px 14px 12px",
        fontWeight: "600",
        fontSize: "12px",
        color: "#888",
        borderBottom: "1px solid rgba(80, 80, 80, 0.4)",
        marginBottom: "4px",
        letterSpacing: "0.3px",
    });
    menu.appendChild(title);

    const colorItem = document.createElement("div");
    Object.assign(colorItem.style, {
        padding: "10px 14px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px",
    });

    const colorLabel = document.createElement("span");
    colorLabel.textContent = "背景颜色";
    colorLabel.style.flex = "1";
    colorItem.appendChild(colorLabel);

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = _currentSettings.background;
    Object.assign(colorInput.style, {
        width: "36px",
        height: "24px",
        border: "none",
        borderRadius: "6px",
        cursor: "pointer",
        background: "transparent",
        padding: "0",
    });
    colorInput.addEventListener("change", () => {
        _currentSettings.background = colorInput.value;
        saveSettings();
        updateAllToolbars();
    });
    colorItem.appendChild(colorInput);
    menu.appendChild(colorItem);

    const opacityItem = document.createElement("div");
    Object.assign(opacityItem.style, {
        padding: "10px 14px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px",
    });

    const opacityLabel = document.createElement("span");
    opacityLabel.textContent = "不透明度";
    opacityLabel.style.flex = "1";
    opacityItem.appendChild(opacityLabel);

    const opacityValue = document.createElement("span");
    opacityValue.textContent = `${Math.round(_currentSettings.opacity * 100)}%`;
    opacityValue.style.color = "#888";
    opacityValue.style.minWidth = "35px";
    opacityValue.style.textAlign = "right";
    opacityItem.appendChild(opacityValue);

    const opacitySlider = document.createElement("input");
    opacitySlider.type = "range";
    opacitySlider.min = "0";
    opacitySlider.max = "1";
    opacitySlider.step = "0.01";
    opacitySlider.value = _currentSettings.opacity;
    Object.assign(opacitySlider.style, {
        width: "90px",
        height: "4px",
        borderRadius: "2px",
        background: "#555",
        outline: "none",
        cursor: "pointer",
        "-webkit-appearance": "none",
    });
    opacitySlider.addEventListener("input", () => {
        _currentSettings.opacity = parseFloat(opacitySlider.value);
        opacityValue.textContent = `${Math.round(_currentSettings.opacity * 100)}%`;
        saveSettings();
        updateAllToolbars();
    });
    opacityItem.appendChild(opacitySlider);
    menu.appendChild(opacityItem);

    _currentContextMenu = menu;
    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width - 10}px`;
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height - 10}px`;
    }
}

function makeBtn(icon, tooltip, onClick) {
    const btn = document.createElement("button");
    btn.innerHTML = icon;
    btn.title = tooltip;
    Object.assign(btn.style, {
        width: "28px",
        height: "28px",
        border: "none",
        borderRadius: "6px",
        backgroundColor: "transparent",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "all 0.15s ease",
        outline: "none",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.3)",
        padding: "2px",
    });
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.style.transform = "scale(0.92)";
        setTimeout(() => { btn.style.transform = "scale(1)"; }, 100);
        onClick?.();
    });
    btn.addEventListener("mouseenter", () => {
        btn.style.backgroundColor = "rgba(100, 100, 100, 0.5)";
        btn.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.4)";
        btn.style.transform = "translateY(-1px)";
    });
    btn.addEventListener("mouseleave", () => {
        btn.style.backgroundColor = "transparent";
        btn.style.boxShadow = "0 1px 3px rgba(0, 0, 0, 0.3)";
        btn.style.transform = "translateY(0)";
    });
    return btn;
}

function getToolbarBackground() {
    const bgColor = _currentSettings.background;
    const alpha = _currentSettings.opacity;
    const r = parseInt(bgColor.slice(1, 3), 16);
    const g = parseInt(bgColor.slice(3, 5), 16);
    const b = parseInt(bgColor.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function updateAllToolbars() {
    const toolbars = document.querySelectorAll(".gg-float-toolbar");
    const bgColor = getToolbarBackground();
    toolbars.forEach((tb) => {
        tb.style.background = bgColor;
    });
}

function attachToolbarToWidget(targetEl, widget) {
    if (!targetEl || !widget) return false;
    if (targetEl._ggFloatAttached) return false;

    targetEl._ggFloatAttached = true;
    targetEl.style.position = "relative";

    const container = document.createElement("div");
    container.className = "gg-float-toolbar";
    Object.assign(container.style, {
        position: "absolute",
        top: "6px",
        right: "6px",
        display: "flex",
        gap: "4px",
        opacity: "0",
        transition: "opacity 0.2s ease, transform 0.15s ease",
        zIndex: "100",
        pointerEvents: "none",
        background: getToolbarBackground(),
        padding: "4px",
        borderRadius: "8px",
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.4)",
        backdropFilter: "blur(8px)",
    });

    const copyBtn = makeBtn(ICON_COPY, "复制", async () => {
        try {
            await writeClipboard(getWidgetValue(widget));
            copyBtn.innerHTML = ICON_CHECK;
            managedTimeout(() => { copyBtn.innerHTML = ICON_COPY; }, 1200);
        } catch {
            copyBtn.innerHTML = ICON_ERROR;
            managedTimeout(() => { copyBtn.innerHTML = ICON_COPY; }, 1600);
        }
    });

    const pasteBtn = makeBtn(ICON_PASTE, "粘贴", () => {
        navigator.clipboard.readText().then((text) => {
            setTextWidgetValue(widget, text);
            const node = widget.parent;
            if (node) {
                node.setOutputData?.(0, text);
                app.graph.setDirtyCanvas(true, true);
            }
            pasteBtn.innerHTML = ICON_CHECK;
            managedTimeout(() => { pasteBtn.innerHTML = ICON_PASTE; }, 1200);
        }).catch(() => {
            pasteBtn.innerHTML = ICON_ERROR;
            managedTimeout(() => { pasteBtn.innerHTML = ICON_PASTE; }, 1600);
        });
    });

    const clearBtn = makeBtn(ICON_CLEAR, "清空", () => {
        setTextWidgetValue(widget, "");
        const node = widget.parent;
        if (node) {
            node.setOutputData?.(0, "");
            app.graph.setDirtyCanvas(true, true);
        }
        clearBtn.innerHTML = ICON_CHECK;
        managedTimeout(() => { clearBtn.innerHTML = ICON_CLEAR; }, 800);
    });

    container.appendChild(copyBtn);
    container.appendChild(pasteBtn);
    container.appendChild(clearBtn);
    targetEl.appendChild(container);

    const onEnter = () => {
        container.style.opacity = "1";
        container.style.pointerEvents = "auto";
        container.style.transform = "translateY(-2px)";
    };
    const onLeave = () => {
        container.style.opacity = "0";
        container.style.pointerEvents = "none";
        container.style.transform = "translateY(0)";
    };
    targetEl.addEventListener("mouseenter", onEnter);
    targetEl.addEventListener("mouseleave", onLeave);

    const onContextMenu = (e) => {
        if (e.button === 2 || e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            createContextMenu(e);
        }
    };
    container.addEventListener("contextmenu", onContextMenu);
    container.addEventListener("mousedown", (e) => {
        if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            createContextMenu(e);
        }
    });

    const cleanup = () => {
        targetEl.removeEventListener("mouseenter", onEnter);
        targetEl.removeEventListener("mouseleave", onLeave);
        container.removeEventListener("contextmenu", onContextMenu);
        container.remove();
        delete targetEl._ggFloatAttached;
        delete targetEl._ggCleanup;
    };

    targetEl._ggCleanup = cleanup;

    return true;
}

function isTextWidget(w) {
    if (!w) return false;
    if (SKIP_WIDGET_TYPES.has(w.type)) return false;
    if (w.options?.forceInput) return false;

    const element = w.element || w.inputEl;
    const tagName = element?.tagName;

    if (w.type === "customtext" || w.type === "text" || w.type === "string" || w.type === "textarea") return true;
    if (tagName === "TEXTAREA" || tagName === "INPUT") return true;

    if (typeof w.value === "string") {
        if (w.type !== "combo" && w.type !== "number" && w.type !== "toggle" && w.type !== "button") {
            return true;
        }
    }

    if (element) {
        if (element.classList?.contains("comfy-multiline-input")) return true;
        if (element.classList?.contains("widget-input")) return true;
        if (element.querySelector?.("textarea, input[type='text']")) return true;
    }

    if (typeof w.value === "string" && w.type === undefined) return true;

    return false;
}

function tryAttachToWidget(widget) {
    try {
        const el = findWidgetElement(widget) || widget.element;
        if (!el) return false;
        if (!el.isConnected) return false;

        const targetEl = (el.tagName === "TEXTAREA" || el.tagName === "INPUT")
            ? el.parentElement : el;

        if (!targetEl) return false;
        if (targetEl._ggFloatAttached) return false;

        return attachToolbarToWidget(targetEl, widget);
    } catch (e) {
        console.warn("[GGClipboard] tryAttachToWidget error:", e);
        return false;
    }
}

function attachToNodeWidgets(node) {
    if (!node.widgets) return;

    for (const w of node.widgets) {
        if (!isTextWidget(w)) continue;
        if (tryAttachToWidget(w)) continue;

        let attempts = 0;
        const check = managedInterval(() => {
            attempts++;
            if (tryAttachToWidget(w) || attempts >= 30) clearTimer(check);
        }, 150);
    }
}

function scanDomTextControls() {
    try {
        const nodeElements = document.querySelectorAll(".litegraph.node, [class*='node']");
        for (const nodeEl of nodeElements) {
            const textControls = nodeEl.querySelectorAll("textarea.comfy-multiline-input, textarea, input[type='text'], input:not([type])");
            for (const ctrl of textControls) {
                if (ctrl._ggFloatAttached) continue;
                if (!ctrl.isConnected) continue;
                if (ctrl.closest(".gg-float-toolbar")) continue;

                const parent = ctrl.parentElement;
                if (parent && !parent._ggFloatAttached) {
                    attachToolbarToWidget(parent, {
                        value: ctrl.value || "",
                        name: "",
                    });
                } else if (!ctrl._ggFloatAttached) {
                    attachToolbarToWidget(ctrl, {
                        value: ctrl.value || "",
                        name: "",
                    });
                }
            }
        }
    } catch (e) {
        console.warn("[GGClipboard] scanDomTextControls error:", e);
    }
}

function scanAllNodes() {
    if (!isFloatingEnabled()) return;

    try {
        const graph = app.graph;
        if (graph?._nodes) {
            for (const n of graph._nodes) {
                attachToNodeWidgets(n);
            }
        }

        managedTimeout(() => {
            scanDomTextControls();
        }, 300);
    } catch (e) {
        console.warn("[GGClipboard] scanAllNodes error:", e);
    }
}

function removeAllFloatToolbars() {
    document.querySelectorAll(".gg-float-toolbar").forEach((el) => {
        const parent = el.parentElement;
        if (parent?._ggCleanup) {
            try {
                parent._ggCleanup();
            } catch (e) {
                console.warn("[GGClipboard] Cleanup error:", e);
            }
        } else {
            el.remove();
        }
    });

    try {
        const allWidgets = app.graph?._nodes?.flatMap(n => n.widgets || []) || [];
        for (const w of allWidgets) {
            const el = findWidgetElement(w) || w.element;
            if (el) {
                const targetEl = (el.tagName === "TEXTAREA" || el.tagName === "INPUT") ? el.parentElement : el;
                if (targetEl?._ggCleanup) {
                    try {
                        targetEl._ggCleanup();
                    } catch (e) {
                        console.warn("[GGClipboard] Widget cleanup error:", e);
                    }
                }
            }
        }
    } catch (e) {
        console.warn("[GGClipboard] Remove all toolbars error:", e);
    }
}

window.__ggApplyToolbar = function(enabled) {
    const panel = document.getElementById("gg-nodes-panel");
    const miniIcon = document.getElementById("gg-nodes-mini");
    if (!panel) return;
    if (enabled) {
        panel.style.display = "flex";
        if (miniIcon) miniIcon.style.display = "none";
    } else {
        panel.style.display = "none";
        if (miniIcon) miniIcon.style.display = "none";
    }
};

window.__ggApplyFloatButtons = function(enabled) {
    if (enabled) {
        requestAnimationFrame(() => {
            scanAllNodes();
            managedTimeout(() => scanAllNodes(), 1000);
        });
    } else {
        removeAllFloatToolbars();
    }
};

function handleNode(node) {
    if (node.comfyClass === "GGTextDisplayCopy") {
        const idx = node.widgets?.findIndex((w) => w.name === "copy_text");
        if (idx !== undefined && idx >= 0) node.widgets.splice(idx, 1);
        node.setSize([320, 200]);
        return;
    }
}

function initExtension() {
    if (_initialized) return;
    _initialized = true;

    app.registerExtension({
        name: "ComfyUI.GGNodes.Clipboard",

        setup() {
            if (!isFloatingEnabled()) return;

            managedTimeout(() => {
                if (isToolbarEnabled()) {
                    window.__ggApplyToolbar?.(true);
                }
                scanAllNodes();
            }, 1500);
        },

        nodeCreated(node) {
            handleNode(node);
            if (!isFloatingEnabled()) return;
            managedTimeout(() => attachToNodeWidgets(node), 500);
        },

        loadedGraphNode(node) {
            if (!isFloatingEnabled()) return;
            managedTimeout(() => attachToNodeWidgets(node), 800);
        },

        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData.name !== "GGTextDisplayCopy") return;

            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                onExecuted?.apply(this, arguments);

                const text = Array.isArray(message?.text)
                    ? message.text.join("\n")
                    : String(message?.text ?? "");

                setTextWidgetValue(getTextWidget(this), text);
                app.graph.setDirtyCanvas(true, true);
            };
        },
    });

    window.addEventListener("beforeunload", clearAllTimers);
}

initExtension();
