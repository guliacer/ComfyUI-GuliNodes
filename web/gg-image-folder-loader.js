import { app } from "../../scripts/app.js";

const NODE_NAME = "GGImageFolderSequenceLoad";
const FOLDER_WIDGET = "文件夹路径";
const LIST_WIDGET = "图像列表";
const INDEX_WIDGET = "当前索引";
const LOOP_WIDGET = "循环";
const SELECT_ROUTE = "/guli/image-folder/select";
const LIST_ROUTE = "/guli/image-folder/list";
const PREVIEW_ROUTE = "/guli/image-folder/preview";
const MIN_NODE_WIDTH = 390;

function getWidget(node, name) {
    return node.widgets?.find((widget) => widget?.name === name) ?? null;
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

function hideWidget(widget) {
    if (!widget || widget._ggImageFolderHidden) return;
    widget._ggImageFolderHidden = true;
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
}

function normalizePath(path) {
    return String(path || "").replace(/\\/g, "/");
}

function previewUrl(item) {
    const params = new URLSearchParams();
    params.set("path", normalizePath(item.path));
    params.set("mtime", String(item.mtime || item.size || Date.now()));
    return `${PREVIEW_ROUTE}?${params.toString()}`;
}

function parseItems(value) {
    try {
        const parsed = JSON.parse(String(value || "[]"));
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((item) => {
                if (typeof item === "string") {
                    return { path: item, name: item.split(/[\\/]/).pop() || item, selected: true };
                }
                return {
                    path: String(item?.path || ""),
                    name: String(item?.name || item?.path?.split?.(/[\\/]/)?.pop?.() || ""),
                    selected: item?.selected !== false,
                    mtime: item?.mtime || 0,
                    size: item?.size || 0,
                };
            })
            .filter((item) => item.path);
    } catch {
        return [];
    }
}

function serializeItems(items) {
    return JSON.stringify(items.map((item) => ({
        path: item.path,
        name: item.name,
        selected: item.selected !== false,
        mtime: item.mtime || 0,
        size: item.size || 0,
    })));
}

function selectedItems(items) {
    return items.filter((item) => item.selected !== false);
}

function clampIndex(node, items) {
    const indexWidget = getWidget(node, INDEX_WIDGET);
    if (!indexWidget) return 0;
    const count = selectedItems(items).length;
    const current = Math.max(0, Number(indexWidget.value) || 0);
    const next = count > 0 ? Math.min(current, count - 1) : 0;
    if (next !== current) setWidgetValue(indexWidget, next);
    return next;
}

function saveItems(node, items, resetIndex = false) {
    const listWidget = getWidget(node, LIST_WIDGET);
    const indexWidget = getWidget(node, INDEX_WIDGET);
    setWidgetValue(listWidget, serializeItems(items));
    if (resetIndex && indexWidget) {
        setWidgetValue(indexWidget, 0);
    } else {
        clampIndex(node, items);
    }
    renderPanel(node);
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
}

function mergeScannedItems(oldItems, scannedItems) {
    const fresh = new Map(scannedItems.map((item) => [item.path, { ...item, selected: true }]));
    const merged = [];

    for (const oldItem of oldItems) {
        const next = fresh.get(oldItem.path);
        if (!next) continue;
        next.selected = oldItem.selected !== false;
        merged.push(next);
        fresh.delete(oldItem.path);
    }

    for (const item of fresh.values()) {
        merged.push(item);
    }
    return merged;
}

async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
    }
    return await response.json();
}

async function selectFolder() {
    return await fetchJson(SELECT_ROUTE, { method: "POST" });
}

async function listFolder(directory) {
    const params = new URLSearchParams();
    params.set("directory", directory);
    return await fetchJson(`${LIST_ROUTE}?${params.toString()}`);
}

function setStatus(node, message) {
    if (node.ggImageFolderPanel?.statusEl) {
        node.ggImageFolderPanel.statusEl.textContent = message;
    }
}

function createButton(label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", onClick);
    Object.assign(button.style, {
        border: "1px solid #475569",
        background: "#1f2937",
        color: "#e5e7eb",
        borderRadius: "7px",
        padding: "6px 10px",
        fontSize: "12px",
        cursor: "pointer",
        lineHeight: "16px",
        whiteSpace: "nowrap",
    });
    return button;
}

function stylePanelElement(host) {
    Object.assign(host.style, {
        boxSizing: "border-box",
        padding: "8px 0 10px",
        pointerEvents: "auto",
        width: "100%",
    });
}

function ensurePanel(node) {
    if (node.ggImageFolderPanel) return node.ggImageFolderPanel;

    const host = document.createElement("div");
    stylePanelElement(host);

    const shell = document.createElement("div");
    Object.assign(shell.style, {
        boxSizing: "border-box",
        width: "100%",
        border: "1px solid #374151",
        borderRadius: "8px",
        background: "#111827",
        overflow: "hidden",
        color: "#e5e7eb",
        fontFamily: "Arial, sans-serif",
    });

    const toolbar = document.createElement("div");
    Object.assign(toolbar.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px",
        borderBottom: "1px solid #253244",
        background: "#0f172a",
    });

    const selectBtn = createButton("选择文件夹", "选择本地图片文件夹", async () => {
        selectBtn.disabled = true;
        const previousText = selectBtn.textContent;
        selectBtn.textContent = "选择中...";
        try {
            const result = await selectFolder();
            const folderPath = String(result?.path || "");
            if (!folderPath) return;
            setWidgetValue(getWidget(node, FOLDER_WIDGET), folderPath);
            const items = Array.isArray(result.images) ? result.images : [];
            saveItems(node, items, true);
            setStatus(node, items.length ? `已载入 ${items.length} 张图片` : "该文件夹内没有可用图片");
        } catch (error) {
            console.error("[GGImageFolderSequenceLoad] Select failed:", error);
            alert(error?.message || "图片文件夹选择失败。");
        } finally {
            selectBtn.textContent = previousText;
            selectBtn.disabled = false;
        }
    });

    const refreshBtn = createButton("刷新", "重新扫描当前文件夹，并保留已有排序和选中状态", async () => {
        const folderPath = String(getWidget(node, FOLDER_WIDGET)?.value || "");
        if (!folderPath) {
            setStatus(node, "请先选择图片文件夹");
            return;
        }
        refreshBtn.disabled = true;
        try {
            const result = await listFolder(folderPath);
            const oldItems = parseItems(getWidget(node, LIST_WIDGET)?.value);
            const merged = mergeScannedItems(oldItems, Array.isArray(result.images) ? result.images : []);
            saveItems(node, merged, false);
            setStatus(node, merged.length ? `已刷新 ${merged.length} 张图片` : "该文件夹内没有可用图片");
        } catch (error) {
            console.error("[GGImageFolderSequenceLoad] Refresh failed:", error);
            alert(error?.message || "图片列表刷新失败。");
        } finally {
            refreshBtn.disabled = false;
        }
    });

    const metaEl = document.createElement("div");
    Object.assign(metaEl.style, {
        marginLeft: "auto",
        minWidth: "78px",
        color: "#cbd5e1",
        fontSize: "12px",
        textAlign: "right",
        whiteSpace: "nowrap",
    });

    const pathEl = document.createElement("div");
    Object.assign(pathEl.style, {
        padding: "7px 9px 0",
        color: "#94a3b8",
        fontSize: "11px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    });

    const gridEl = document.createElement("div");
    Object.assign(gridEl.style, {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
        gap: "8px",
        padding: "9px",
        maxHeight: "360px",
        overflowY: "auto",
        boxSizing: "border-box",
    });

    const statusEl = document.createElement("div");
    Object.assign(statusEl.style, {
        padding: "0 9px 9px",
        color: "#9ca3af",
        fontSize: "11px",
        lineHeight: "16px",
        minHeight: "16px",
    });

    toolbar.append(selectBtn, refreshBtn, metaEl);
    shell.append(toolbar, pathEl, gridEl, statusEl);
    host.append(shell);

    const widget = node.addDOMWidget("gg_image_folder_panel", "gg_image_folder_panel", host, {
        getValue() {
            return "";
        },
        setValue() {},
        serialize: false,
    });
    widget.computeSize = function (width) {
        const count = parseItems(getWidget(node, LIST_WIDGET)?.value).length;
        const rows = Math.max(1, Math.ceil(count / 4));
        const gridHeight = Math.min(360, rows * 88);
        return [Math.max(Number(width) || MIN_NODE_WIDTH, MIN_NODE_WIDTH), 116 + gridHeight];
    };

    const panel = { host, shell, toolbar, gridEl, pathEl, metaEl, statusEl, widget, draggedPath: "" };
    node.ggImageFolderPanel = panel;

    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        host.remove();
        node.ggImageFolderPanel = null;
        return originalOnRemoved?.apply(this, arguments);
    };

    return panel;
}

function renderEmpty(panel, message) {
    panel.gridEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.textContent = message;
    Object.assign(empty.style, {
        gridColumn: "1 / -1",
        minHeight: "86px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#94a3b8",
        fontSize: "12px",
        border: "1px dashed #334155",
        borderRadius: "8px",
        background: "#0b1220",
        textAlign: "center",
        padding: "12px",
    });
    panel.gridEl.appendChild(empty);
}

function renderCard(node, panel, item, index, activePath) {
    const card = document.createElement("div");
    card.draggable = true;
    card.dataset.path = item.path;
    const selected = item.selected !== false;
    const active = selected && item.path === activePath;
    Object.assign(card.style, {
        position: "relative",
        height: "78px",
        borderRadius: "8px",
        border: active ? "2px solid #38bdf8" : selected ? "1px solid #22c55e" : "1px solid #475569",
        background: selected ? "#0f1f1a" : "#172033",
        overflow: "hidden",
        cursor: "grab",
        opacity: selected ? "1" : "0.46",
        boxSizing: "border-box",
    });

    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.src = previewUrl(item);
    img.alt = item.name || `image-${index + 1}`;
    Object.assign(img.style, {
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
        pointerEvents: "none",
        userSelect: "none",
    });

    const label = document.createElement("div");
    label.textContent = item.name || `图片 ${index + 1}`;
    Object.assign(label.style, {
        position: "absolute",
        left: "0",
        right: "0",
        bottom: "0",
        padding: "12px 5px 4px",
        color: "#f8fafc",
        fontSize: "10px",
        lineHeight: "12px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        background: "linear-gradient(180deg, transparent 0%, rgba(0,0,0,.78) 78%)",
        pointerEvents: "none",
    });

    const badge = document.createElement("div");
    badge.textContent = active ? "下一张" : selected ? String(index + 1) : "停用";
    Object.assign(badge.style, {
        position: "absolute",
        top: "5px",
        left: "5px",
        padding: "2px 5px",
        borderRadius: "999px",
        background: active ? "#0284c7" : selected ? "rgba(22, 163, 74, .92)" : "rgba(71, 85, 105, .9)",
        color: "#ffffff",
        fontSize: "10px",
        lineHeight: "12px",
        pointerEvents: "none",
    });

    card.append(img, label, badge);

    card.addEventListener("click", () => {
        if (panel.justDragged) return;
        const items = parseItems(getWidget(node, LIST_WIDGET)?.value);
        const target = items.find((candidate) => candidate.path === item.path);
        if (!target) return;
        target.selected = target.selected === false;
        saveItems(node, items, false);
    });

    card.addEventListener("dragstart", (event) => {
        panel.draggedPath = item.path;
        event.dataTransfer?.setData("text/plain", item.path);
        event.dataTransfer?.setDragImage(card, 20, 20);
        card.style.cursor = "grabbing";
    });

    card.addEventListener("dragend", () => {
        panel.draggedPath = "";
        panel.justDragged = true;
        card.style.cursor = "grab";
        setTimeout(() => {
            panel.justDragged = false;
        }, 80);
    });

    card.addEventListener("dragover", (event) => {
        event.preventDefault();
        card.style.outline = "2px solid #f59e0b";
        card.style.outlineOffset = "-3px";
    });

    card.addEventListener("dragleave", () => {
        card.style.outline = "";
        card.style.outlineOffset = "";
    });

    card.addEventListener("drop", (event) => {
        event.preventDefault();
        card.style.outline = "";
        card.style.outlineOffset = "";

        const draggedPath = panel.draggedPath || event.dataTransfer?.getData("text/plain");
        if (!draggedPath || draggedPath === item.path) return;

        const items = parseItems(getWidget(node, LIST_WIDGET)?.value);
        const from = items.findIndex((candidate) => candidate.path === draggedPath);
        const to = items.findIndex((candidate) => candidate.path === item.path);
        if (from < 0 || to < 0) return;

        const [moved] = items.splice(from, 1);
        items.splice(to, 0, moved);
        saveItems(node, items, false);
    });

    return card;
}

function renderPanel(node) {
    const panel = ensurePanel(node);
    const items = parseItems(getWidget(node, LIST_WIDGET)?.value);
    const folderPath = String(getWidget(node, FOLDER_WIDGET)?.value || "");
    const selected = selectedItems(items);
    const currentIndex = clampIndex(node, items);
    const active = selected.length ? selected[currentIndex % selected.length] : null;

    panel.pathEl.textContent = folderPath ? normalizePath(folderPath) : "未选择文件夹";
    panel.pathEl.title = folderPath;
    panel.metaEl.textContent = selected.length ? `${currentIndex + 1}/${selected.length}` : `${items.length} 张`;
    panel.statusEl.textContent = selected.length
        ? `已选择 ${selected.length} / ${items.length} 张，拖拽缩略图可调整顺序`
        : "点击缩略图启用图片";

    panel.gridEl.innerHTML = "";
    if (!items.length) {
        renderEmpty(panel, "选择文件夹后，图片会显示在这里");
    } else {
        items.forEach((item, index) => {
            panel.gridEl.appendChild(renderCard(node, panel, item, index, active?.path));
        });
    }

    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
}

function installExecutionAdvance(node) {
    if (node._ggImageFolderExecutionInstalled) return;
    node._ggImageFolderExecutionInstalled = true;

    const originalOnExecuted = node.onExecuted;
    node.onExecuted = function () {
        const result = originalOnExecuted?.apply(this, arguments);
        const items = parseItems(getWidget(this, LIST_WIDGET)?.value);
        const count = selectedItems(items).length;
        if (count > 0) {
            const indexWidget = getWidget(this, INDEX_WIDGET);
            const loopWidget = getWidget(this, LOOP_WIDGET);
            const current = Math.max(0, Number(indexWidget?.value) || 0);
            const loop = loopWidget?.value !== false;
            const next = loop ? (current + 1) % count : Math.min(current + 1, count - 1);
            setWidgetValue(indexWidget, next);
            renderPanel(this);
        }
        return result;
    };
}

function setupNode(node) {
    if (!node || (node.comfyClass !== NODE_NAME && node.type !== NODE_NAME)) return;
    if (node._ggImageFolderInstalled) return;
    node._ggImageFolderInstalled = true;

    hideWidget(getWidget(node, FOLDER_WIDGET));
    hideWidget(getWidget(node, LIST_WIDGET));
    hideWidget(getWidget(node, INDEX_WIDGET));
    ensurePanel(node);
    installExecutionAdvance(node);
    renderPanel(node);

    node.size = [
        Math.max(MIN_NODE_WIDTH, Number(node.size?.[0]) || 0),
        Math.max(Number(node.size?.[1]) || 0, node.computeSize?.()?.[1] || 0),
    ];
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "ComfyUI.GGNodes.ImageFolderSequenceLoad",

    nodeCreated(node) {
        setTimeout(() => setupNode(node), 0);
    },

    loadedGraphNode(node) {
        setTimeout(() => setupNode(node), 0);
    },
});
