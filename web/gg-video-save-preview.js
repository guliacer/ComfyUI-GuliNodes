import { app } from "../../scripts/app.js";

const SAVE_NODES = new Set(["GGVideoSave", "SaveVideoGG"]);
const COMPRESS_NODES = new Set(["GGVideoCompress", "CompressVideoGG"]);
const PREVIEW_WIDGET_NAME = "gg_video_preview";
const MIN_NODE_WIDTH = 360;
const MIN_PREVIEW_WIDTH = 300;
const MIN_PREVIEW_HEIGHT = 170;
const MAX_PREVIEW_HEIGHT = 520;
const LEGACY_ENCODER_ALIASES = new Map([
    ["CPU H.264 (libx264)", "x264_64-8bit.exe"],
    ["CPU H.265 (libx265)", "x265-64-8bit.exe"],
    ["自动优先硬件编码", "x264_64-8bit.exe"],
    ["x265-8bit\\gcc1.exe", "x265-64-8bit.exe"],
    ["x265-8bit\\gcc[cpu].exe", "x265-64-8bit.exe"],
    ["x265-64-8bit[gcc].exe", "x265-64-8bit.exe"],
    ["x265-8bit.exe", "x265-64-8bit.exe"],
    ["x265-10bit.exe", "x265-64-10bit.exe"],
    ["x265-12bit.exe", "x265-64-12bit.exe"],
]);

function getWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name);
}

function setWidgetValue(widget, value) {
    if (!widget) return;
    widget.value = value;
    if (widget.element) {
        widget.element.value = value;
        widget.element.dispatchEvent(new Event("input", { bubbles: true }));
        widget.element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    widget.callback?.(value);
}

function normalizeLegacyEncoderWidget(node) {
    const encoderWidget = getWidget(node, "编码器");
    if (!encoderWidget) return;

    const currentValue = String(encoderWidget.value ?? "");
    if (!currentValue.trim()) {
        setWidgetValue(encoderWidget, "x264_64-8bit.exe");
        app.graph.setDirtyCanvas(true, true);
        return;
    }

    const mappedValue = LEGACY_ENCODER_ALIASES.get(currentValue);
    if (!mappedValue || mappedValue === currentValue) return;

    setWidgetValue(encoderWidget, mappedValue);
    app.graph.setDirtyCanvas(true, true);
}

function normalizePath(path) {
    if (!path || typeof path !== "string") return "";
    return path.replace(/\\/g, "/");
}

function buildDirectPreviewUrl(path) {
    const normalizedPath = normalizePath(String(path ?? "").trim());
    if (!normalizedPath) return "";
    const params = new URLSearchParams();
    params.set("path", normalizedPath);
    params.set("rand", String(Date.now()));
    return `/guli/video/preview?${params.toString()}`;
}

function setPreviewEmpty(previewWidget, message = "执行保存后可在这里预览输出视频") {
    if (!previewWidget?.videoEl || !previewWidget.placeholderEl) return;
    previewWidget.videoEl.pause();
    previewWidget.videoEl.removeAttribute("src");
    previewWidget.videoEl.load();
    previewWidget.videoEl.style.display = "none";
    previewWidget.placeholderEl.textContent = message;
    previewWidget.placeholderEl.style.display = "flex";
}

function updateVideoPreviewFromPath(node, path) {
    const previewWidget = node.ggVideoPreviewWidget;
    if (!previewWidget?.videoEl) return;

    const url = buildDirectPreviewUrl(path);
    if (!url) {
        setPreviewEmpty(previewWidget);
        return;
    }

    previewWidget.placeholderEl.style.display = "none";
    previewWidget.videoEl.style.display = "block";
    if (previewWidget.videoEl.dataset.previewUrl !== url) {
        previewWidget.videoEl.dataset.previewUrl = url;
        previewWidget.videoEl.src = url;
        previewWidget.videoEl.load();
    }
}

function getPreviewMetrics(widget, widgetWidth) {
    const outerWidth = Math.max(MIN_PREVIEW_WIDTH, Number(widgetWidth || MIN_NODE_WIDTH) - 28);
    const ratio = Math.max(0.2, Number(widget.inputRatio) || (16 / 9));
    const mediaHeight = Math.round(Math.min(MAX_PREVIEW_HEIGHT, Math.max(MIN_PREVIEW_HEIGHT, outerWidth / ratio)));
    return {
        width: outerWidth,
        height: mediaHeight,
        widgetHeight: mediaHeight + 18,
    };
}

function applyPreviewLayout(widget, widgetWidth) {
    const metrics = getPreviewMetrics(widget, widgetWidth);
    Object.assign(widget.host.style, {
        width: `${metrics.width}px`,
        minWidth: `${metrics.width}px`,
        maxWidth: `${metrics.width}px`,
        height: `${metrics.widgetHeight}px`,
    });
    Object.assign(widget.container.style, {
        width: `${metrics.width}px`,
        minWidth: `${metrics.width}px`,
        maxWidth: `${metrics.width}px`,
        height: `${metrics.height}px`,
        minHeight: `${metrics.height}px`,
        maxHeight: `${metrics.height}px`,
    });
    return metrics;
}

function getPreviewWidgetSize(node) {
    const widget = node?.ggVideoPreviewWidget;
    if (!widget) return [MIN_NODE_WIDTH, MIN_PREVIEW_HEIGHT + 18];
    return widget.computeSize?.(node.size?.[0] || MIN_NODE_WIDTH) || [MIN_NODE_WIDTH, MIN_PREVIEW_HEIGHT + 18];
}

function lockPreviewInsideNode(node, forceExact = false) {
    if (!node?.ggVideoPreviewWidget || typeof node.computeSize !== "function") return;

    const computed = node.computeSize();
    const computedWidth = Array.isArray(computed) ? Number(computed[0]) || MIN_NODE_WIDTH : MIN_NODE_WIDTH;
    const computedHeight = Array.isArray(computed) ? Number(computed[1]) || 0 : 0;
    const previewSize = getPreviewWidgetSize(node);
    const width = Math.max(MIN_NODE_WIDTH, node.size?.[0] || 0, computedWidth, previewSize[0]);
    const height = Math.max(computedHeight, previewSize[1] + 130);
    const nextHeight = forceExact ? height : Math.max(node.size?.[1] || 0, height);

    node.size = [width, nextHeight];
    node.setSize?.([width, nextHeight]);
    node.setDirtyCanvas?.(true, true);
    app.graph.setDirtyCanvas(true, true);
}

function ensurePreviewWidget(node) {
    if (node.ggVideoPreviewWidget) {
        return node.ggVideoPreviewWidget;
    }

    const host = document.createElement("div");
    Object.assign(host.style, {
        display: "block",
        paddingTop: "8px",
        paddingBottom: "10px",
        boxSizing: "border-box",
        overflow: "hidden",
        pointerEvents: "auto",
    });

    const container = document.createElement("div");
    Object.assign(container.style, {
        position: "relative",
        background: "#111827",
        border: "1px solid #374151",
        borderRadius: "10px",
        overflow: "hidden",
        boxSizing: "border-box",
        pointerEvents: "auto",
    });

    const videoEl = document.createElement("video");
    videoEl.controls = true;
    videoEl.preload = "metadata";
    videoEl.playsInline = true;
    Object.assign(videoEl.style, {
        width: "100%",
        height: "100%",
        display: "none",
        background: "#000000",
        objectFit: "contain",
        pointerEvents: "auto",
    });

    const placeholderEl = document.createElement("div");
    placeholderEl.textContent = "执行保存后可在这里预览输出视频";
    Object.assign(placeholderEl.style, {
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#d1d5db",
        fontSize: "13px",
        padding: "12px",
        boxSizing: "border-box",
        textAlign: "center",
        background: "linear-gradient(180deg, #111827 0%, #0f172a 100%)",
    });

    host.appendChild(container);
    container.appendChild(placeholderEl);
    container.appendChild(videoEl);

    const widget = node.addDOMWidget(PREVIEW_WIDGET_NAME, "gg_video_preview", host, {
        getValue() {
            return "";
        },
        setValue() {},
        serialize: false,
    });
    widget.inputEl = host;
    widget.host = host;
    widget.container = container;
    widget.videoEl = videoEl;
    widget.placeholderEl = placeholderEl;
    widget.inputRatio = 16 / 9;
    widget.computeSize = function (width) {
        const metrics = applyPreviewLayout(this, Number(width) || this.parent?.size?.[0] || MIN_NODE_WIDTH);
        return [Math.max(Number(width) || MIN_NODE_WIDTH, MIN_NODE_WIDTH), metrics.widgetHeight];
    };
    widget.onRemoved = function () {
        this.videoEl?.pause();
        this.videoEl?.remove();
        this.placeholderEl?.remove();
        this.container?.remove();
        this.host?.remove();
    };

    videoEl.addEventListener("error", () => {
        setPreviewEmpty(widget, "当前视频无法预览，请确认路径和格式");
    });
    videoEl.addEventListener("loadedmetadata", () => {
        const videoWidth = Number(videoEl.videoWidth) || 0;
        const videoHeight = Number(videoEl.videoHeight) || 0;
        if (videoWidth > 0 && videoHeight > 0) {
            widget.inputRatio = videoWidth / videoHeight;
        }
        lockPreviewInsideNode(node, true);
    });

    node.ggVideoPreviewWidget = widget;

    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        widget.onRemoved?.();
        node.ggVideoPreviewWidget = null;
        return originalOnRemoved?.apply(this, arguments);
    };

    return widget;
}

function installLockedSaveNodeLayout(node) {
    if (node.ggLockedVideoSaveLayoutInstalled) return;
    node.ggLockedVideoSaveLayoutInstalled = true;

    const originalOnResize = node.onResize;
    node.onResize = function (size) {
        const result = originalOnResize?.apply(this, arguments);
        if (!this.ggVideoPreviewWidget) return result;

        const width = Math.max(MIN_NODE_WIDTH, Array.isArray(size) ? Number(size[0]) || 0 : Number(this.size?.[0]) || 0);
        const previewSize = getPreviewWidgetSize(this);
        const minHeight = Math.max(this.computeSize?.()?.[1] || 0, previewSize[1] + 130);

        if (Array.isArray(size)) {
            size[0] = width;
            size[1] = Math.max(Number(size[1]) || 0, minHeight);
        }
        this.size = [width, Math.max(Number(this.size?.[1]) || 0, minHeight)];
        this.setDirtyCanvas?.(true, true);
        app.graph.setDirtyCanvas(true, true);
        return result;
    };
}

function installSavePreview(node) {
    ensurePreviewWidget(node);
    installLockedSaveNodeLayout(node);
    lockPreviewInsideNode(node, true);

    if (!node.ggSavePreviewExecutionHooked) {
        const originalOnExecuted = node.onExecuted;
        node.onExecuted = function (message) {
            originalOnExecuted?.apply(this, arguments);
            const previewItem = Array.isArray(message?.guli_video_preview) ? message.guli_video_preview[0] : null;
            if (previewItem?.path) {
                updateVideoPreviewFromPath(this, previewItem.path);
            }
            lockPreviewInsideNode(this, true);
        };
        node.ggSavePreviewExecutionHooked = true;
    }
}

app.registerExtension({
    name: "ComfyUI.GGNodes.VideoSavePreview",
    async nodeCreated(node) {
        if (COMPRESS_NODES.has(node.comfyClass)) {
            normalizeLegacyEncoderWidget(node);
        }

        if (SAVE_NODES.has(node.comfyClass)) {
            installSavePreview(node);
        }
    },
    async loadedGraphNode(node) {
        if (SAVE_NODES.has(node.comfyClass)) {
            installSavePreview(node);
        }
    },
});
