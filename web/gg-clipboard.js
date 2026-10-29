import { app } from "../../scripts/app.js";
import { ggIcon } from "./gg-ui-icons.js";
import { applySurface, ensureGGDesign } from "./gg-ui-design.js";

const SETTINGS_ID = "GuliNodes";
const STORAGE_KEY = "ggFloatToolbarSettings";
const SKIP_WIDGET_NAMES = new Set(["压缩模式", "压缩模式选择"]);
const SKIP_WIDGET_CLASSES = ["gg-compress-mode-host"];
const TEXT_WIDGET_TYPES = new Set(["customtext", "text", "string", "textarea"]);
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "email", "password"]);

const SKIP_WIDGET_TYPES = new Set(["button", "toggle", "combo", "number", "slider", "ggHiddenCompressMode", "gg_compress_mode"]);

const _timers = new Set();
let _initialized = false;

let _currentSettings = loadSettings();

function loadSettings() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return getDefaultSettings();
        const parsed = JSON.parse(saved);
        // 迁移：老版本把「没选过颜色」也存成 #ffffff / 0.92，
        // 结果深色主题里悬浮条是白的。这一对正好等于旧默认值，视为「跟随主题」。
        if (parsed?.background === "#ffffff" && Number(parsed?.opacity) === 0.92) {
            parsed.background = "";
        }
        return { ...getDefaultSettings(), ...parsed };
    } catch {
        return getDefaultSettings();
    }
}

function getDefaultSettings() {
    return {
        // 空 = 跟随主题（由设计层给底色）；只有用户真的选了颜色才写具体值
        background: "",
        opacity: 0.92
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
        const value = app.extensionManager?.setting?.get?.(`${SETTINGS_ID}.enableFloatButtons`);
        if (value !== undefined) return value !== false;
    } catch (error) {
        console.warn("[GGClipboard] Unable to read extension setting:", error);
    }

    try {
        return app.ui?.settings?.getSettingValue?.(`${SETTINGS_ID}.enableFloatButtons`, true) !== false;
    } catch { return true; }
}

function isToolbarEnabled() {
    try {
        const value = app.extensionManager?.setting?.get?.(`${SETTINGS_ID}.enableToolbar`);
        if (value !== undefined) return value !== false;
    } catch (error) {
        console.warn("[GGClipboard] Unable to read toolbar setting:", error);
    }

    try {
        return app.ui?.settings?.getSettingValue?.(`${SETTINGS_ID}.enableToolbar`, true) !== false;
    } catch { return true; }
}

function getTextWidget(node, name = "文本") {
    return node.widgets?.find((w) => w.name === name);
}

function isTextInputControl(element) {
    if (!element) return false;
    if (element.tagName === "TEXTAREA") return true;
    return element.tagName === "INPUT"
        && TEXT_INPUT_TYPES.has(String(element.type || "").toLowerCase());
}

function findTextControl(element) {
    if (isTextInputControl(element)) return element;
    const controls = element?.querySelectorAll?.("textarea, input") || [];
    return Array.from(controls).find(isTextInputControl) || null;
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
    }

    const inputs = nodeEl.querySelectorAll("input[type='text'], input[type='search'], input[type='url'], input[type='email'], input[type='password'], input:not([type])");
    for (const inp of inputs) {
        const label = inp.previousElementSibling;
        if (label && label.classList?.contains("widget-label") && label.textContent.trim() === widget.name) return inp;
        if (inp.dataset.widgetName === widget.name) return inp;
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
        const control = findTextControl(el);
        if (control) {
            control.value = text;
            control.dispatchEvent(new Event("input", { bubbles: true }));
        }
    }
}

function getWidgetValue(widget) {
    if (!widget) return "";
    const el = findWidgetElement(widget) || widget.element;
    if (el) {
        const control = findTextControl(el);
        if (control) return control.value;
    }
    return String(widget.value ?? "");
}

function firstOutputValue(output, key) {
    const value = output?.[key];
    return Array.isArray(value) ? value[0] : value;
}

function textFromExecutedMessage(message) {
    const value = firstOutputValue(message, "文本")
        ?? firstOutputValue(message, "text")
        ?? firstOutputValue(message?.ui, "文本")
        ?? firstOutputValue(message?.ui, "text")
        ?? firstOutputValue(message?.message, "文本")
        ?? firstOutputValue(message?.message, "text")
        ?? firstOutputValue(message?.message?.ui, "文本")
        ?? firstOutputValue(message?.message?.ui, "text");
    return value == null ? null : String(value);
}

const ICON_COPY = ggIcon("copy", 16);
const ICON_PASTE = ggIcon("paste", 16);
const ICON_CLEAR = ggIcon("clear", 16);
const ICON_CHECK = ggIcon("check", 16, "gg-ui-icon-success");
const ICON_ERROR = ggIcon("error", 16, "gg-ui-icon-error");
const IMAGE_PREVIEW_SELECTOR = ".image-preview";

let _imageToolbar = null;
let _imageToolbarImage = null;
let _imageToolbarHideTimer = null;
let _imageToolbarEventsInstalled = false;
let _imageGraphCanvas = null;

let _currentContextMenu = null;

function createContextMenu(e) {
    if (_currentContextMenu) {
        _currentContextMenu.remove();
    }

    const menu = document.createElement("div");
    // 外壳交给设计层：底色 / 描边 / 阴影 / 圆角都按当前主题给，
    // 以前这里猜的是 `--comfy-menu-bg`，深色主题下会拿到一块近白的底。
    menu.className = "gg-context-menu gg-surface gg-popover";
    ensureGGDesign();
    applySurface(menu);
    Object.assign(menu.style, {
        position: "fixed",
        top: `${e.clientY}px`,
        left: `${e.clientX}px`,
        padding: "8px 0",
        minWidth: "220px",
        // `.gg-popover` 默认宽 360px，这个菜单按内容宽度排
        width: "auto",
        zIndex: "100000",
        backdropFilter: "blur(12px)",
        fontSize: "13px",
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
        color: "var(--gg-muted)",
        borderBottom: "1px solid var(--gg-divider)",
        marginBottom: "4px",
        letterSpacing: "0",
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
    // 「跟随主题」时 background 是空串，而 input[type=color] 拿到空串会自己退回 #000000：
    // 菜单里就永远是那块黑，深色下像「已选黑色」，浅色下干脆是错的。
    // 空值就显示当前解析出来的面板底色，所见即所得。
    const panelColor = getComputedStyle(document.documentElement)
        .getPropertyValue("--gg-panel").trim() || "#171B24";
    colorInput.value = _currentSettings.background || panelColor;
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
        syncFollowChip();
    });

    // 回退入口：选过颜色之后以前没有任何办法回到「跟随主题」，只能清 localStorage。
    // 颜色与四态交给设计层的 `.gg-chip`，这里只留一句 aria-pressed 说明当前状态。
    const followChip = document.createElement("button");
    followChip.type = "button";
    followChip.className = "gg-chip gg-follow-theme-chip";
    followChip.textContent = "跟随主题";
    followChip.title = "清掉自定义颜色，跟随深浅主题";
    const syncFollowChip = () => {
        const following = !_currentSettings.background;
        followChip.setAttribute("aria-pressed", following ? "true" : "false");
        followChip.disabled = following;
    };
    followChip.addEventListener("click", () => {
        _currentSettings.background = "";
        colorInput.value = getComputedStyle(document.documentElement)
            .getPropertyValue("--gg-panel").trim() || "#171B24";
        saveSettings();
        updateAllToolbars();
        syncFollowChip();
    });
    syncFollowChip();

    colorItem.appendChild(followChip);
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
    opacityValue.style.color = "var(--gg-ui-muted)";
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
        background: "rgba(148, 163, 184, 0.35)",
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
    btn.type = "button";
    // 颜色 / 悬停 / 禁用全部交给设计层（`.gg-icon-btn.is-outline`）。
    // 以前这里把白底写在 style 里、悬停靠 JS 改色：深色主题下就是三个白方块，
    // 而且 JS 改的内联样式永远盖不住样式表的伪类，越改越乱。
    btn.className = "gg-icon-btn is-outline";
    Object.assign(btn.style, {
        width: "24px",
        height: "24px",
        minWidth: "24px",
        cursor: "pointer",
        padding: "1px",
        lineHeight: "0",
        boxSizing: "border-box",
        touchAction: "manipulation",
        transition: "transform 0.16s ease",
    });
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.style.transform = "scale(0.92)";
        setTimeout(() => { btn.style.transform = "scale(1)"; }, 100);
        onClick?.();
    });
    return btn;
}

function imageBlobAsPng(blob) {
    if (blob.type === "image/png") return Promise.resolve(blob);
    if (typeof createImageBitmap !== "function") {
        return Promise.reject(new Error("当前浏览器无法转换图像格式"));
    }

    return createImageBitmap(blob).then((bitmap) => new Promise((resolve, reject) => {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) {
            bitmap.close?.();
            reject(new Error("无法读取图像内容"));
            return;
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        canvas.toBlob((png) => {
            if (png) resolve(png);
            else reject(new Error("图像转换失败"));
        }, "image/png");
    }));
}

function writeImageToClipboard(image) {
    if (!image?.currentSrc && !image?.src) {
        return Promise.reject(new Error("没有可复制的图像"));
    }
    if (!navigator.clipboard?.write || typeof ClipboardItem !== "function") {
        return Promise.reject(new Error("当前浏览器不支持复制图像，请使用新版 Chrome 或 Edge"));
    }

    const imageData = fetch(image.currentSrc || image.src, { credentials: "same-origin" })
        .then((response) => {
            if (!response.ok) throw new Error(`读取图像失败（HTTP ${response.status}）`);
            return response.blob();
        })
        .then(imageBlobAsPng);

    return navigator.clipboard.write([new ClipboardItem({ "image/png": imageData })]);
}

function positionImageToolbar(rect) {
    if (!_imageToolbar || !rect) return;
    const width = 38;
    const height = 38;
    _imageToolbar.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + 8))}px`;
    _imageToolbar.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, rect.bottom - height - 8))}px`;
}

function showImageToolbar(image, rect) {
    if (!image || !rect) return;
    clearImageToolbarHideTimer();
    ensureImageToolbar();
    _imageToolbarImage = image;
    positionImageToolbar(rect);
    _imageToolbar.style.opacity = "1";
    _imageToolbar.style.pointerEvents = "auto";
    _imageToolbar.style.transform = "translateY(0)";
}

function clearImageToolbarHideTimer() {
    if (_imageToolbarHideTimer == null) return;
    clearTimer(_imageToolbarHideTimer);
    _imageToolbarHideTimer = null;
}

function hideImageToolbar() {
    if (!_imageToolbar) return;
    _imageToolbar.style.opacity = "0";
    _imageToolbar.style.pointerEvents = "none";
    _imageToolbarImage = null;
}

function scheduleImageToolbarHide() {
    clearImageToolbarHideTimer();
    _imageToolbarHideTimer = managedTimeout(() => {
        _imageToolbarHideTimer = null;
        hideImageToolbar();
    }, 180);
}

function ensureImageToolbar() {
    if (_imageToolbar) return;

    const toolbar = document.createElement("div");
    // 跟随主题：以前写死白底，深色主题下图像上方会浮出一个白方块
    toolbar.className = "gg-image-float-toolbar gg-surface";
    ensureGGDesign();
    applySurface(toolbar);
    Object.assign(toolbar.style, {
        position: "fixed",
        zIndex: "10000",
        opacity: "0",
        pointerEvents: "none",
        display: "flex",
        padding: "3px",
        border: "1px solid var(--gg-divider)",
        borderRadius: "9px",
        background: "var(--gg-panel)",
        boxShadow: "0 8px 18px rgba(15, 23, 42, 0.18)",
        backdropFilter: "blur(12px)",
        transition: "opacity 0.16s ease, transform 0.16s ease",
        transform: "translateY(2px)",
    });
    const button = makeBtn(ICON_COPY, "复制图像到剪贴板", () => {
        if (!_imageToolbarImage || button.disabled) return;
        button.disabled = true;
        button.style.cursor = "wait";
        writeImageToClipboard(_imageToolbarImage).then(() => {
            button.innerHTML = ICON_CHECK;
            button.title = "图像已复制到剪贴板";
            button.setAttribute("aria-label", button.title);
            managedTimeout(() => {
                if (!button.isConnected) return;
                button.innerHTML = ICON_COPY;
                button.title = "复制图像到剪贴板";
                button.setAttribute("aria-label", button.title);
            }, 1200);
        }).catch((error) => {
            button.innerHTML = ICON_ERROR;
            button.title = `复制失败：${error?.message || "请检查浏览器剪贴板权限"}`;
            button.setAttribute("aria-label", button.title);
            managedTimeout(() => {
                if (!button.isConnected) return;
                button.innerHTML = ICON_COPY;
                button.title = "复制图像到剪贴板";
                button.setAttribute("aria-label", button.title);
            }, 2200);
        }).finally(() => {
            button.disabled = false;
            button.style.cursor = "pointer";
        });
    });
    Object.assign(button.style, { width: "30px", height: "30px", minWidth: "30px" });
    button.setAttribute("aria-label", button.title);
    toolbar.appendChild(button);
    toolbar.addEventListener("pointerenter", clearImageToolbarHideTimer);
    toolbar.addEventListener("pointerleave", scheduleImageToolbarHide);
    document.body.appendChild(toolbar);
    _imageToolbar = toolbar;
}

function imageAtPoint(preview, x, y) {
    for (const image of preview.querySelectorAll("img")) {
        if (!image.complete || !image.naturalWidth || !image.naturalHeight) continue;
        const rect = image.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return image;
    }
    return null;
}

function canvasImageAtPoint(event) {
    const canvas = app.canvas;
    const graphPoint = canvas?.convertEventToCanvasOffset?.(event);
    if (!Array.isArray(graphPoint)) return null;

    const nodes = app.graph?._nodes || [];
    for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        const previewWidget = node.widgets?.find((widget) => widget.name === "$$canvas-image-preview");
        const image = node.imgs?.find((item) => item?.complete && item.naturalWidth && item.naturalHeight);
        if (!previewWidget || !image || node.flags?.collapsed) continue;

        const previewTop = Number(previewWidget.last_y ?? previewWidget.y);
        const nodeWidth = Number(node.size?.[0]);
        const nodeHeight = Number(node.size?.[1]);
        const naturalWidth = Number(image.naturalWidth);
        const naturalHeight = Number(image.naturalHeight);
        if (![previewTop, nodeWidth, nodeHeight, naturalWidth, naturalHeight].every(Number.isFinite)) continue;

        const imageTop = previewTop + (globalThis.LiteGraph?.NODE_WIDGET_HEIGHT || 24);
        const availableWidth = Math.max(0, nodeWidth - 16);
        const availableHeight = Math.max(0, nodeHeight - imageTop - 8);
        const imageScale = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight);
        if (!(imageScale > 0)) continue;

        const imageWidth = naturalWidth * imageScale;
        const imageHeight = naturalHeight * imageScale;
        const imageLeft = (nodeWidth - imageWidth) / 2;
        const localX = graphPoint[0] - node.pos[0];
        const localY = graphPoint[1] - node.pos[1];
        if (localX < imageLeft || localX > imageLeft + imageWidth
            || localY < imageTop || localY > imageTop + imageHeight) continue;

        const canvasRect = canvas.canvas.getBoundingClientRect();
        const screenTopLeft = canvas.convertOffsetToCanvas([
            node.pos[0] + imageLeft,
            node.pos[1] + imageTop,
        ]);
        return {
            image,
            rect: {
                left: canvasRect.left + screenTopLeft[0],
                top: canvasRect.top + screenTopLeft[1],
                right: canvasRect.left + screenTopLeft[0] + imageWidth * canvas.ds.scale,
                bottom: canvasRect.top + screenTopLeft[1] + imageHeight * canvas.ds.scale,
            },
        };
    }
    return null;
}

function handleCanvasPointerMove(event) {
    if (!isFloatingEnabled()) return;
    const preview = canvasImageAtPoint(event);
    if (!preview) {
        scheduleImageToolbarHide();
        return;
    }
    showImageToolbar(preview.image, preview.rect);
}

function handleCanvasPointerLeave() {
    scheduleImageToolbarHide();
}

function handlePreviewPointerOver(event) {
    if (!isFloatingEnabled()) return;
    if (_imageToolbar?.contains(event.target)) {
        clearImageToolbarHideTimer();
        return;
    }

    const preview = event.target?.closest?.(IMAGE_PREVIEW_SELECTOR);
    if (!preview) return;
    const image = imageAtPoint(preview, event.clientX, event.clientY);
    if (!image) return;

    showImageToolbar(image, image.getBoundingClientRect());
}

function handlePreviewPointerOut(event) {
    const relatedTarget = event.relatedTarget;
    if (_imageToolbar?.contains(event.target)) {
        if (_imageToolbar.contains(relatedTarget)) return;
        if (relatedTarget?.closest?.(IMAGE_PREVIEW_SELECTOR)) return;
        scheduleImageToolbarHide();
        return;
    }

    const preview = event.target?.closest?.(IMAGE_PREVIEW_SELECTOR);
    if (!preview || preview.contains(relatedTarget) || _imageToolbar?.contains(relatedTarget)) return;
    scheduleImageToolbarHide();
}

function installImageToolbarEvents() {
    if (!_imageToolbarEventsInstalled) {
        document.addEventListener("pointerover", handlePreviewPointerOver);
        document.addEventListener("pointerout", handlePreviewPointerOut);
        _imageToolbarEventsInstalled = true;
    }

    const graphCanvas = app.canvas?.canvas;
    if (graphCanvas === _imageGraphCanvas) return;
    _imageGraphCanvas?.removeEventListener("pointermove", handleCanvasPointerMove);
    _imageGraphCanvas?.removeEventListener("pointerleave", handleCanvasPointerLeave);
    _imageGraphCanvas = graphCanvas || null;
    _imageGraphCanvas?.addEventListener("pointermove", handleCanvasPointerMove);
    _imageGraphCanvas?.addEventListener("pointerleave", handleCanvasPointerLeave);
}

function removeImageToolbar() {
    clearImageToolbarHideTimer();
    if (_imageToolbarEventsInstalled) {
        document.removeEventListener("pointerover", handlePreviewPointerOver);
        document.removeEventListener("pointerout", handlePreviewPointerOut);
        _imageToolbarEventsInstalled = false;
    }
    _imageGraphCanvas?.removeEventListener("pointermove", handleCanvasPointerMove);
    _imageGraphCanvas?.removeEventListener("pointerleave", handleCanvasPointerLeave);
    _imageGraphCanvas = null;
    _imageToolbar?.remove();
    _imageToolbar = null;
    _imageToolbarImage = null;
}

function getToolbarBackground() {
    const bgColor = _currentSettings.background;
    // 没自定义就返回空串：调用方清掉内联底色，交给 `.gg-float-toolbar` 的 CSS 按主题取色
    if (!bgColor) return "";
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
        if (bgColor) tb.style.background = bgColor;
        else tb.style.removeProperty("background");
        tb.style.removeProperty("border-color");
    });
}

function attachToolbarToWidget(targetEl, widget) {
    if (!targetEl || !widget) return false;
    if (targetEl._ggFloatAttached) return false;

    targetEl._ggFloatAttached = true;
    targetEl.style.position = "relative";

    const container = document.createElement("div");
    // 底色 / 描边 / 圆角由设计层按主题给；用户选过颜色才由 getToolbarBackground() 覆盖
    container.className = "gg-float-toolbar gg-surface";
    ensureGGDesign();
    applySurface(container);
    Object.assign(container.style, {
        position: "absolute",
        left: "5px",
        bottom: "5px",
        display: "flex",
        gap: "3px",
        opacity: "0",
        transition: "opacity 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease",
        zIndex: "100",
        pointerEvents: "none",
        background: getToolbarBackground() || "var(--gg-panel)",
        padding: "3px",
        border: "1px solid var(--gg-divider)",
        borderRadius: "9px",
        boxShadow: "0 8px 18px rgba(15, 23, 42, 0.12)",
        backdropFilter: "blur(12px)",
        willChange: "opacity, transform",
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
        container.style.transform = "translateY(-3px)";
        container.style.boxShadow = "0 10px 22px rgba(15, 23, 42, 0.16)";
    };
    const onLeave = () => {
        container.style.opacity = "0";
        container.style.pointerEvents = "none";
        container.style.transform = "translateY(0)";
        container.style.boxShadow = "0 8px 18px rgba(15, 23, 42, 0.12)";
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
    if (SKIP_WIDGET_NAMES.has(w.name)) return false;
    if (SKIP_WIDGET_TYPES.has(w.type)) return false;
    if (w.options?.forceInput) return false;

    const element = w.element || w.inputEl;
    if (element && SKIP_WIDGET_CLASSES.some((className) => element.classList?.contains(className) || element.querySelector?.(`.${className}`))) {
        return false;
    }

    const widgetType = String(w.type || "").toLowerCase();
    if (!TEXT_WIDGET_TYPES.has(widgetType) && w.options?.multiline !== true) return false;
    if (!element) return true;
    return findTextControl(element) !== null;
}

function tryAttachToWidget(widget) {
    try {
        const el = findWidgetElement(widget) || widget.element;
        if (!el) return false;
        if (!el.isConnected) return false;

        const control = findTextControl(el);
        if (!control) return false;

        const targetEl = control.parentElement;

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

function scanAllNodes() {
    if (!isFloatingEnabled()) return;

    try {
        const graph = app.graph;
        if (graph?._nodes) {
            for (const n of graph._nodes) {
                attachToNodeWidgets(n);
            }
        }
    } catch (e) {
        console.warn("[GGClipboard] scanAllNodes error:", e);
    }
}

function removeAllFloatToolbars() {
    removeImageToolbar();
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
                const control = findTextControl(el);
                const targetEl = control?.parentElement;
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
    if (window.__ggToolbarApplyEnabled) {
        window.__ggToolbarApplyEnabled(enabled);
        return;
    }

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
        installImageToolbarEvents();
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
            installImageToolbarEvents();

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

                const text = textFromExecutedMessage(message);
                if (text == null) return;

                setTextWidgetValue(getTextWidget(this), text);
                app.graph.setDirtyCanvas(true, true);
            };
        },
    });

    window.addEventListener("beforeunload", clearAllTimers);
}

initExtension();
