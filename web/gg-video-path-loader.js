import { app } from "../../scripts/app.js";

const TARGET_NODES = new Set(["GGVideoLoadPath", "LoadVideoPathGG"]);
const SAVE_NODES = new Set(["GGVideoSave", "SaveVideoGG"]);
const COMPRESS_NODES = new Set(["GGVideoCompress", "CompressVideoGG"]);
const PICK_BUTTON_LABEL = "选择本地视频";
const STORAGE_KEY = "guli.video_path_loader.last_dir";
const PREVIEW_WIDGET_NAME = "gg_video_preview";
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

function hideWidget(widget) {
    if (!widget) return;
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
    if (widget.element) {
        widget.element.style.display = "none";
    }
}

function normalizePath(path) {
    if (!path || typeof path !== "string") return "";
    return path.replace(/\\/g, "/");
}

function getCurrentDirectory(node) {
    const directoryWidget = getWidget(node, "directory");
    return normalizePath(String(directoryWidget?.value ?? "").trim()) || normalizePath(localStorage.getItem(STORAGE_KEY) || "");
}

function getCurrentFile(node) {
    const fileWidget = getWidget(node, "file");
    return normalizePath(String(fileWidget?.value ?? "").trim());
}

function buildPreviewUrl(node) {
    const file = getCurrentFile(node);
    if (!file) return "";
    const directory = getCurrentDirectory(node);
    const params = new URLSearchParams();
    params.set("file", file);
    if (directory) {
        params.set("directory", directory);
    }
    params.set("rand", String(Date.now()));
    return `/guli/video/preview?${params.toString()}`;
}

function buildDirectPreviewUrl(path) {
    const normalizedPath = normalizePath(String(path ?? "").trim());
    if (!normalizedPath) return "";
    const params = new URLSearchParams();
    params.set("path", normalizedPath);
    params.set("rand", String(Date.now()));
    return `/guli/video/preview?${params.toString()}`;
}

function setPreviewEmpty(previewWidget, message = "选择视频后可在这里预览") {
    if (!previewWidget?.videoEl || !previewWidget.placeholderEl) return;
    previewWidget.videoEl.pause();
    previewWidget.videoEl.removeAttribute("src");
    previewWidget.videoEl.load();
    previewWidget.videoEl.style.display = "none";
    previewWidget.placeholderEl.textContent = message;
    previewWidget.placeholderEl.style.display = "flex";
}

function updateVideoPreview(node) {
    const previewWidget = node.ggVideoPreviewWidget;
    if (!previewWidget?.videoEl) return;

    const url = buildPreviewUrl(node);
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

function updateVideoPreviewFromPath(node, path) {
    const previewWidget = node.ggVideoPreviewWidget;
    if (!previewWidget?.videoEl) return;

    const url = buildDirectPreviewUrl(path);
    if (!url) {
        setPreviewEmpty(previewWidget, node.ggVideoPreviewPlaceholder || "暂无可预览视频");
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
    const outerWidth = Math.max(260, widgetWidth - 24);
    const ratio = Math.max(0.2, Number(widget.inputRatio) || (16 / 9));
    const mediaHeight = Math.round(Math.min(520, Math.max(150, outerWidth / ratio)));
    return {
        width: outerWidth,
        height: mediaHeight + 28,
    };
}

function getPreviewRequiredHeight(node) {
    const widget = node?.ggVideoPreviewWidget;
    if (!widget) return 220;
    const width = Number(node.size?.[0]) || 460;
    const metrics = getPreviewMetrics(widget, width);
    return metrics.height + 22;
}

function refreshPreviewNodeSize(node, forceExact = false) {
    if (!node?.ggVideoPreviewWidget || typeof node.computeSize !== "function") return;
    const computed = node.computeSize();
    const computedWidth = Array.isArray(computed) && computed.length >= 1 ? computed[0] : (node.size?.[0] || 460);
    const computedHeight = Array.isArray(computed) && computed.length >= 2 ? computed[1] : 0;

    const nextWidth = Math.max(460, computedWidth || node.size?.[0] || 460);
    const nextHeight = Math.max(computedHeight || 0, getPreviewRequiredHeight(node), 220);
    const currentHeight = Number(node.size?.[1] || 0);
    const targetHeight = forceExact ? nextHeight : Math.max(currentHeight, nextHeight);

    node.setSize?.([nextWidth, targetHeight]);
    node.setDirtyCanvas?.(true, true);
    app.graph.setDirtyCanvas(true, true);
}

function applyPreviewLayout(widget, widgetWidth) {
    const metrics = getPreviewMetrics(widget, widgetWidth);
    Object.assign(widget.container.style, {
        width: `${metrics.width}px`,
        minHeight: `${metrics.height}px`,
        height: `${metrics.height}px`,
    });
    widget.lastAppliedHeight = metrics.height;
    return metrics;
}

function ensurePreviewWidget(node) {
    if (node.ggVideoPreviewWidget) {
        return node.ggVideoPreviewWidget;
    }

    const host = document.createElement("div");
    Object.assign(host.style, {
        width: "100%",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        paddingTop: "12px",
        paddingBottom: "10px",
        boxSizing: "border-box",
    });

    const container = document.createElement("div");
    Object.assign(container.style, {
        background: "#111827",
        border: "1px solid #374151",
        borderRadius: "10px",
        overflow: "hidden",
        boxSizing: "border-box",
        width: "100%",
        minHeight: "220px",
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
    });

    const placeholderEl = document.createElement("div");
    placeholderEl.textContent = node.ggVideoPreviewPlaceholder || "选择视频后可在这里预览";
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
        const metrics = applyPreviewLayout(this, Number(width) || this.parent?.size?.[0] || 420);
        return [Math.max(width || 420, 320), metrics.height + 22];
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
        refreshPreviewNodeSize(node, true);
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

function installResponsiveNodeLayout(node) {
    if (node.ggResponsivePreviewLayoutInstalled) return;
    node.ggResponsivePreviewLayoutInstalled = true;

    const originalOnResize = node.onResize;
    node.onResize = function (size) {
        const result = originalOnResize?.apply(this, arguments);
        if (!this.ggVideoPreviewWidget) {
            return result;
        }

        const width = Array.isArray(size) && size.length >= 1 ? size[0] : this.size?.[0];
        this.ggVideoPreviewWidget.computeSize?.(width || this.size?.[0] || 460);
        const minHeight = Math.max(this.computeSize?.()?.[1] || 0, getPreviewRequiredHeight(this));
        if (Array.isArray(size) && size.length >= 2) {
            size[1] = Math.max(minHeight, 220);
            this.size[1] = size[1];
        } else {
            this.size[1] = Math.max(minHeight, 220);
        }

        this.setDirtyCanvas?.(true, true);
        app.graph.setDirtyCanvas(true, true);
        return result;
    };
}

function hookPreviewRefresh(node) {
    const fileWidget = getWidget(node, "file");
    const directoryWidget = getWidget(node, "directory");

    const originalFileCallback = fileWidget?.callback;
    if (fileWidget && !fileWidget.ggPreviewHooked) {
        fileWidget.callback = function () {
            originalFileCallback?.apply(this, arguments);
            updateVideoPreview(node);
        };
        fileWidget.ggPreviewHooked = true;
    }

    const originalDirectoryCallback = directoryWidget?.callback;
    if (directoryWidget && !directoryWidget.ggPreviewHooked) {
        directoryWidget.callback = function () {
            const value = normalizePath(String(directoryWidget.value ?? "").trim());
            if (value) {
                localStorage.setItem(STORAGE_KEY, value);
            }
            originalDirectoryCallback?.apply(this, arguments);
            updateVideoPreview(node);
        };
        directoryWidget.ggPreviewHooked = true;
    }
}

async function fetchPickerJson(url) {
    const comfyApi = globalThis.api;
    const response = comfyApi?.fetchApi ? await comfyApi.fetchApi(url, { method: "GET" }) : await fetch(url, { method: "GET" });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
}

function chooseLocalVideoFallback(node) {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".mp4,.flv,.mov,.avi,.f4v,video/mp4,video/x-flv,video/quicktime,video/x-msvideo";
        input.style.display = "none";
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            if (!file) {
                input.remove();
                resolve(false);
                return;
            }

            const rawPath = normalizePath(file.path || file.name || "");
            if (rawPath) {
                setWidgetValue(getWidget(node, "file"), rawPath);
                const lastSlash = rawPath.lastIndexOf("/");
                if (lastSlash > 0) {
                    const directory = rawPath.slice(0, lastSlash);
                    setWidgetValue(getWidget(node, "directory"), directory);
                    localStorage.setItem(STORAGE_KEY, directory);
                }
            }

            updateVideoPreview(node);
            app.graph.setDirtyCanvas(true, true);
            input.remove();
            resolve(true);
        });
        input.addEventListener("cancel", () => {
            input.remove();
            resolve(false);
        });
        document.body.appendChild(input);
        input.click();
    });
}

async function chooseLocalVideo(node) {
    const directory = encodeURIComponent(getCurrentDirectory(node));
    try {
        const data = await fetchPickerJson(`/guli/video/pick-file?directory=${directory}`);
        if (!data?.ok || !data?.path) {
            await chooseLocalVideoFallback(node);
            return;
        }

        setWidgetValue(getWidget(node, "file"), normalizePath(data.path));
        if (data.directory) {
            const normalizedDirectory = normalizePath(data.directory);
            setWidgetValue(getWidget(node, "directory"), normalizedDirectory);
            localStorage.setItem(STORAGE_KEY, normalizedDirectory);
        }
        updateVideoPreview(node);
        app.graph.setDirtyCanvas(true, true);
    } catch (error) {
        console.warn("[GGVideoPathLoader] native picker unavailable, fallback to browser picker", error);
        await chooseLocalVideoFallback(node);
    }
}

function wrapAsyncAction(action) {
    return async () => {
        try {
            await action();
        } catch (error) {
            console.error("[GGVideoPathLoader]", error);
            window.alert(`操作失败: ${error?.message || error}`);
        }
    };
}

app.registerExtension({
    name: "ComfyUI.GGNodes.VideoPathLoader",
    async nodeCreated(node) {
        if (COMPRESS_NODES.has(node.comfyClass)) {
            normalizeLegacyEncoderWidget(node);
        }

        if (TARGET_NODES.has(node.comfyClass)) {
            node.ggVideoPreviewPlaceholder = "选择视频后可在这里预览";

            hideWidget(getWidget(node, "directory"));

            const pickWidget = node.addWidget("button", "pick_local_video", PICK_BUTTON_LABEL, wrapAsyncAction(() => chooseLocalVideo(node)));
            pickWidget.label = PICK_BUTTON_LABEL;
            pickWidget.serialize = false;

            ensurePreviewWidget(node);
            installResponsiveNodeLayout(node);
            hookPreviewRefresh(node);

            const recentDir = normalizePath(localStorage.getItem(STORAGE_KEY) || "");
            const dirWidget = getWidget(node, "directory");
            if (recentDir && dirWidget && !String(dirWidget.value ?? "").trim()) {
                setWidgetValue(dirWidget, recentDir);
            }

            refreshPreviewNodeSize(node, true);
            updateVideoPreview(node);
            return;
        }

        if (!SAVE_NODES.has(node.comfyClass)) return;

        node.ggVideoPreviewPlaceholder = "执行保存后可在这里预览输出视频";
        ensurePreviewWidget(node);
        installResponsiveNodeLayout(node);
        refreshPreviewNodeSize(node, true);

        const originalOnExecuted = node.onExecuted;
        node.onExecuted = function (message) {
            originalOnExecuted?.apply(this, arguments);
            const previewItem = Array.isArray(message?.guli_video_preview) ? message.guli_video_preview[0] : null;
            if (previewItem?.path) {
                updateVideoPreviewFromPath(this, previewItem.path);
            }
        };
    },
    async loadedGraphNode(node) {
        if (TARGET_NODES.has(node.comfyClass)) {
            node.ggVideoPreviewPlaceholder = "选择视频后可在这里预览";
            hookPreviewRefresh(node);
            ensurePreviewWidget(node);
            installResponsiveNodeLayout(node);
            refreshPreviewNodeSize(node, true);
            setTimeout(() => updateVideoPreview(node), 0);
            return;
        }

        if (!SAVE_NODES.has(node.comfyClass)) return;
        node.ggVideoPreviewPlaceholder = "执行保存后可在这里预览输出视频";
        ensurePreviewWidget(node);
        installResponsiveNodeLayout(node);
        refreshPreviewNodeSize(node, true);
    },
});
