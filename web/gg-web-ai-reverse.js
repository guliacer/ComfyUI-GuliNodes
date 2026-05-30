import { app } from "../../scripts/app.js";

const NODE_CLASS = "GGWebAIReverseImage";
const DOM_WIDGET_NAME = "gg_web_ai_reverse";
const MIN_NODE_WIDTH = 520;
const MIN_PANEL_HEIGHT = 360;
const MAX_PANEL_HEIGHT = 1500;
const DEFAULT_PANEL_HEIGHT = 820;
const URL_BAR_HEIGHT = 28;

const PLATFORM_URLS = Object.freeze({
    "豆包": "https://www.doubao.com/",
    "腾讯元宝": "https://yuanbao.tencent.com/",
    "文心一言": "https://yiyan.baidu.com/",
});

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

function getWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name);
}

function getWidgetValue(node, name, fallback = "") {
    const widget = getWidget(node, name);
    return String(widget?.value ?? widget?.element?.value ?? fallback);
}

function getGraphLink(graph, linkId) {
    if (linkId == null) return null;
    const candidates = [linkId];
    const numericId = Number(linkId);
    if (Number.isFinite(numericId)) candidates.push(numericId);
    for (const id of candidates) {
        const link = graph?.getLink?.(id);
        if (link) return link;
    }
    for (const store of [graph?.links, graph?._links]) {
        if (!store) continue;
        for (const id of candidates) {
            const link = typeof store.get === "function" ? store.get(id) : store[id];
            if (link) return link;
        }
    }
    return null;
}

function deleteGraphLink(graph, linkId) {
    const candidates = [linkId];
    const numericId = Number(linkId);
    if (Number.isFinite(numericId)) candidates.push(numericId);
    for (const store of [graph?.links, graph?._links]) {
        if (!store) continue;
        for (const id of candidates) {
            if (typeof store.delete === "function" && store.delete(id)) return;
            if (Object.prototype.hasOwnProperty.call(store, id)) {
                delete store[id];
                return;
            }
        }
    }
}

function getGraphNode(graph, nodeId) {
    if (nodeId == null) return null;
    return graph?.getNodeById?.(nodeId)
        ?? (graph?.nodes ?? graph?._nodes ?? []).find((node) => String(node.id) === String(nodeId));
}

function removeGraphLink(graph, link) {
    if (link == null || !graph) return;
    const linkInfo = getGraphLink(graph, link);
    const storedId = linkInfo?.id ?? link;
    if (typeof graph.removeLink === "function") {
        graph.removeLink(storedId);
        return;
    }

    const origin = getGraphNode(graph, linkInfo?.origin_id);
    const target = getGraphNode(graph, linkInfo?.target_id);
    const outputLinks = origin?.outputs?.[linkInfo?.origin_slot]?.links;
    if (Array.isArray(outputLinks)) {
        const index = outputLinks.findIndex((id) => String(id) === String(storedId));
        if (index >= 0) outputLinks.splice(index, 1);
    }
    const input = target?.inputs?.[linkInfo?.target_slot];
    if (String(input?.link) === String(storedId)) input.link = null;

    deleteGraphLink(graph, storedId);
}

function getPanelHeight(node) {
    return clampNumber(
        getWidgetValue(node, "节点高度", DEFAULT_PANEL_HEIGHT),
        MIN_PANEL_HEIGHT,
        MAX_PANEL_HEIGHT,
        DEFAULT_PANEL_HEIGHT
    );
}

function getPlatform(node) {
    return getWidgetValue(node, "平台", "豆包");
}

function normalizeUrl(url) {
    const value = String(url ?? "").trim();
    if (!value) return "";
    if (/^https?:\/\//i.test(value)) return value;
    return `https://${value}`;
}

function getPlatformUrl(node) {
    const platform = getPlatform(node);
    const customUrl = normalizeUrl(getWidgetValue(node, "自定义网址", ""));
    if (platform === "自定义") return customUrl;
    return PLATFORM_URLS[platform] || customUrl || "";
}

function clearNodeSlots(node) {
    if (!node) return;
    const graph = node.graph || app.graph;
    const inputLinks = (node.inputs || []).map((input) => input?.link).filter((link) => link != null);
    const outputLinks = (node.outputs || []).flatMap((output) => output?.links || []).filter((link) => link != null);

    for (const link of [...inputLinks, ...outputLinks]) {
        removeGraphLink(graph, link);
    }

    node.inputs = [];
    node.outputs = [];
    node.setDirtyCanvas?.(true, true);
    app.graph.setDirtyCanvas(true, true);
}

function updateUrlBar(panel, url) {
    const displayUrl = url || "about:blank";
    panel.urlText.textContent = displayUrl;
    panel.urlText.title = displayUrl;
    panel.urlText.href = url || "#";
}

function applyPanelLayout(panel, width) {
    const outerWidth = Math.max(MIN_NODE_WIDTH - 28, Number(width || MIN_NODE_WIDTH) - 28);
    const panelHeight = getPanelHeight(panel.node);
    const iframeHeight = Math.max(MIN_PANEL_HEIGHT - URL_BAR_HEIGHT, panelHeight - URL_BAR_HEIGHT);

    Object.assign(panel.host.style, {
        width: `${outerWidth}px`,
        minWidth: `${outerWidth}px`,
        maxWidth: `${outerWidth}px`,
        height: `${panelHeight}px`,
        minHeight: `${panelHeight}px`,
        maxHeight: `${panelHeight}px`,
    });
    Object.assign(panel.iframe.style, {
        height: `${iframeHeight}px`,
        minHeight: `${iframeHeight}px`,
        maxHeight: `${iframeHeight}px`,
    });
}

function loadIframe(panel, platform, url, force = false) {
    const nextUrl = url || "about:blank";
    updateUrlBar(panel, nextUrl);

    if (!force && panel.currentUrl === nextUrl) return;
    panel.currentUrl = nextUrl;

    panel.iframe.removeAttribute("srcdoc");
    panel.iframe.src = nextUrl;
}

function updatePanelFromWidgets(node, reloadIframe = false) {
    const panel = node.ggWebAIReversePanel;
    if (!panel) return;

    loadIframe(panel, getPlatform(node), getPlatformUrl(node), reloadIframe);
    applyPanelLayout(panel, node.size?.[0] || MIN_NODE_WIDTH);
}

function resizeNodeToPanel(node) {
    if (!node?.ggWebAIReverseWidget) return;

    const currentWidth = Number(node.size?.[0]) || MIN_NODE_WIDTH;
    const width = Math.max(MIN_NODE_WIDTH, currentWidth);
    const computed = typeof node.computeSize === "function" ? node.computeSize() : null;
    const height = Math.max(Number(computed?.[1]) || 0, getPanelHeight(node));

    if (!node.size || node.size[0] !== width || node.size[1] !== height) {
        node.size = [width, height];
        node.setSize?.([width, height]);
    }

    updatePanelFromWidgets(node);
    node.setDirtyCanvas?.(true, true);
    app.graph.setDirtyCanvas(true, true);
}

function wrapWidgetCallback(node, widgetName) {
    const widget = getWidget(node, widgetName);
    if (!widget || widget.ggWebAIReverseWrapped) return;
    const originalCallback = widget.callback;
    widget.callback = function () {
        const result = originalCallback?.apply(this, arguments);
        window.setTimeout(() => {
            const shouldReload = widgetName === "平台" || widgetName === "自定义网址";
            updatePanelFromWidgets(node, shouldReload);
            resizeNodeToPanel(node);
        }, 0);
        return result;
    };
    widget.ggWebAIReverseWrapped = true;
}

function createPanel(node) {
    const host = document.createElement("div");
    Object.assign(host.style, {
        background: "#ffffff",
        border: "1px solid rgba(148, 163, 184, 0.28)",
        borderRadius: "10px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        padding: "0",
        pointerEvents: "auto",
    });

    const iframe = document.createElement("iframe");
    iframe.title = "GG Web AI";
    iframe.allow = "clipboard-read; clipboard-write; fullscreen; camera; microphone; display-capture";
    iframe.referrerPolicy = "no-referrer-when-downgrade";
    Object.assign(iframe.style, {
        background: "#ffffff",
        border: "0",
        display: "block",
        flex: "1 1 auto",
        minHeight: "0",
        width: "100%",
    });

    const urlBar = document.createElement("div");
    Object.assign(urlBar.style, {
        alignItems: "center",
        background: "#f8fafc",
        borderTop: "1px solid rgba(148, 163, 184, 0.28)",
        boxSizing: "border-box",
        color: "#475569",
        display: "flex",
        fontSize: "11px",
        gap: "6px",
        height: `${URL_BAR_HEIGHT}px`,
        lineHeight: "1",
        minHeight: `${URL_BAR_HEIGHT}px`,
        overflow: "hidden",
        padding: "0 10px",
        whiteSpace: "nowrap",
    });

    const urlLabel = document.createElement("span");
    urlLabel.textContent = "当前网址:";
    Object.assign(urlLabel.style, {
        color: "#64748b",
        flex: "0 0 auto",
    });

    const urlText = document.createElement("a");
    urlText.target = "_blank";
    urlText.rel = "noopener noreferrer";
    Object.assign(urlText.style, {
        color: "#0f766e",
        flex: "1 1 auto",
        minWidth: "0",
        overflow: "hidden",
        textDecoration: "none",
        textOverflow: "ellipsis",
    });
    urlBar.append(urlLabel, urlText);
    host.append(iframe, urlBar);

    return {
        node,
        host,
        iframe,
        urlText,
        currentUrl: "",
    };
}

function removeExistingWebAIWidget(node) {
    const existingWidget = node.ggWebAIReverseWidget || node.widgets?.find((widget) => widget.name === DOM_WIDGET_NAME);
    if (!existingWidget) return;

    existingWidget.onRemoved?.();
    existingWidget.element?.remove?.();
    existingWidget.inputEl?.remove?.();
    existingWidget.panel?.host?.remove?.();

    if (Array.isArray(node.widgets)) {
        node.widgets = node.widgets.filter((widget) => widget !== existingWidget);
    }

    node.ggWebAIReverseWidget = null;
    node.ggWebAIReversePanel = null;
}

function ensureWebAIWidget(node) {
    clearNodeSlots(node);
    if (node.ggWebAIReverseWidget?.ggPureWebAIWidget) {
        updatePanelFromWidgets(node);
        return node.ggWebAIReverseWidget;
    }

    removeExistingWebAIWidget(node);

    const panel = createPanel(node);
    node.ggWebAIReversePanel = panel;
    node.resizable = true;
    node.resizeable = true;

    const widget = node.addDOMWidget(DOM_WIDGET_NAME, "gg_web_ai_reverse", panel.host, {
        getValue() {
            return "";
        },
        setValue() {},
        serialize: false,
    });

    widget.panel = panel;
    widget.inputEl = panel.host;
    widget.host = panel.host;
    widget.iframe = panel.iframe;
    widget.ggPureWebAIWidget = true;
    widget.computeSize = function (width) {
        const nodeWidth = Number(width) || node.size?.[0] || MIN_NODE_WIDTH;
        applyPanelLayout(panel, nodeWidth);
        return [Math.max(MIN_NODE_WIDTH, nodeWidth), getPanelHeight(node)];
    };
    widget.onRemoved = function () {
        panel.iframe.removeAttribute("src");
        panel.host.remove();
    };

    node.ggWebAIReverseWidget = widget;
    installNodeHooks(node);
    updatePanelFromWidgets(node, true);
    window.setTimeout(() => resizeNodeToPanel(node), 0);
    window.setTimeout(() => resizeNodeToPanel(node), 120);
    return widget;
}

function installNodeHooks(node) {
    if (node.ggWebAIReverseHooksInstalled) return;
    node.ggWebAIReverseHooksInstalled = true;

    ["平台", "自定义网址", "节点高度"].forEach((name) => wrapWidgetCallback(node, name));

    const originalOnExecuted = node.onExecuted;
    node.onExecuted = function () {
        originalOnExecuted?.apply(this, arguments);
        clearNodeSlots(this);
        updatePanelFromWidgets(this);
        resizeNodeToPanel(this);
    };

    const originalOnResize = node.onResize;
    node.onResize = function (size) {
        const result = originalOnResize?.apply(this, arguments);
        clearNodeSlots(this);
        if (this.ggWebAIReversePanel) {
            applyPanelLayout(this.ggWebAIReversePanel, size?.[0] || this.size?.[0] || MIN_NODE_WIDTH);
        }
        return result;
    };

    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        this.ggWebAIReverseWidget?.onRemoved?.();
        this.ggWebAIReverseWidget = null;
        this.ggWebAIReversePanel = null;
        return originalOnRemoved?.apply(this, arguments);
    };
}

app.registerExtension({
    name: "ComfyUI.GGNodes.WebAIReverse",
    async nodeCreated(node) {
        if (node.comfyClass === NODE_CLASS) {
            clearNodeSlots(node);
            ensureWebAIWidget(node);
        }
    },
    async loadedGraphNode(node) {
        if (node.comfyClass === NODE_CLASS) {
            clearNodeSlots(node);
            ensureWebAIWidget(node);
        }
    },
});
