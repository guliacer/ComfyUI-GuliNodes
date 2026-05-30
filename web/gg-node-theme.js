import { ggIcon, getCategoryColor, getCategoryIcon, ensureGGIconStyles } from "./gg-ui-icons.js";

const GG_PREFIXES = ["GG", "GuliNodes"];
const STYLE_ID = "gg-node-theme";
const MENU_HOOKED = Symbol("ggMenuHooked");
const NODES_STYLED = new WeakMap();

let themeInstalled = false;
let observer = null;

function isGGNode(node) {
    if (!node || !node.type) return false;
    return GG_PREFIXES.some(p => node.type.startsWith(p));
}

function getNodeCategory(node) {
    const ctor = app.graph.getNodeType(node.type);
    if (ctor && ctor.category) return ctor.category;
    return "";
}

function applyNodeTheme(node) {
    if (!node || !isGGNode(node) || NODES_STYLED.has(node)) return;
    const el = node.domElement;
    if (!el) return;

    const category = getNodeCategory(node);
    const colors = getCategoryColor(category);

    el.classList.add("gg-themed-node");
    el.style.setProperty("--gg-cat-accent", colors.accent);
    el.style.setProperty("--gg-cat-soft", colors.soft);
    el.style.setProperty("--gg-cat-border", colors.border);

    const borderEl = document.createElement("div");
    borderEl.className = "gg-cat-border";
    borderEl.style.cssText = `
        position: absolute;
        left: 0; top: 0; bottom: 0;
        width: 3px;
        background: ${colors.accent};
        border-radius: 6px 0 0 6px;
        opacity: 0;
        transition: opacity 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        pointer-events: none;
        z-index: 1;
    `;
    el.style.position = "relative";
    el.insertBefore(borderEl, el.firstChild);

    const titleEl = el.querySelector(".title");
    if (titleEl && !titleEl.querySelector(".gg-cat-icon")) {
        const iconWrap = document.createElement("span");
        iconWrap.className = "gg-cat-icon";
        iconWrap.innerHTML = ggIcon(getCategoryIcon(category), 14);
        iconWrap.style.cssText = `
            display: inline-flex;
            align-items: center;
            margin-right: 5px;
            vertical-align: middle;
            opacity: 0.7;
            flex-shrink: 0;
        `;
        const titleWrap = titleEl.querySelector(".title-text-wrap") || titleEl;
        titleWrap.insertBefore(iconWrap, titleWrap.firstChild);
    }

    NODES_STYLED.set(node, { borderEl, category });
    updateNodeVisualState(node);
}

function updateNodeVisualState(node) {
    const data = NODES_STYLED.get(node);
    if (!data || !data.borderEl) return;
    const isSelected = app.canvas.selected_nodes?.[node.id] !== undefined;
    data.borderEl.style.opacity = isSelected ? "1" : "0.55";
}

function setupMutationObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const added of mutation.addedNodes) {
                if (added.nodeType === 1 && added.classList?.contains("litegraph")) {
                    requestAnimationFrame(() => styleAllExistingNodes());
                    break;
                }
                if (added.nodeType === 1 && added.classList?.contains("comfyui-node")) {
                    const nodeId = added.id?.replace("COMFYGUI_", "");
                    const node = app.graph.getNodeById(Number(nodeId));
                    if (isGGNode(node)) applyNodeTheme(node);
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function styleAllExistingNodes() {
    if (!app.graph) return;
    for (const node of app.graph._nodes) {
        if (isGGNode(node) && !NODES_STYLED.has(node)) {
            applyNodeTheme(node);
        }
    }
}

function injectThemeCSS() {
    if (document.getElementById(STYLE_ID)) return;

    const css = `
        .gg-themed-node {
            transition: box-shadow 0.3s ease, transform 0.15s ease;
        }
        .gg-themed-node:hover {
            box-shadow: 0 2px 12px rgba(0,0,0,0.08), 0 0 0 1px rgba(128,128,128,0.08);
        }
        .gg-themed-node.selected {
            box-shadow: 0 4px 20px rgba(0,0,0,0.12), 0 0 0 2px var(--gg-cat-border, rgba(99,102,241,0.4));
        }
        .gg-themed-node .title {
            font-weight: 600;
            letter-spacing: -0.01em;
            display: flex;
            align-items: center;
            gap: 2px;
        }
        .gg-themed-node:hover .gg-cat-icon {
            opacity: 1;
        }
        .gg-themed-node .widget {
            margin-top: 2px;
            transition: background-color 0.2s ease;
        }
        .gg-themed-node .widget:hover {
            background: rgba(128,128,128,0.04);
            border-radius: 4px;
        }
        @keyframes ggNodeAppear {
            from { opacity: 0; transform: scale(0.96); }
            to { opacity: 1; transform: scale(1); }
        }
        .gg-themed-node.gg-node-new {
            animation: ggNodeAppear 0.28s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .comfy-menu-searches > [data-category*="GuliNodes"]::before,
        .comfy-menu-searches > [data-category="image"]:has([value^="GG"])::before {
            content: '';
            display: inline-block;
            width: 16px; height: 16px;
            margin-right: 6px;
            vertical-align: -3px;
            background-size: contain;
            background-repeat: no-repeat;
            background-position: center;
            filter: var(--gg-cat-accent-filter, none);
        }
        .comfy-list-item:hover {
            transition: background-color 0.15s ease;
        }
    `;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
}

function hookNodeAdded() {
    const origAddNode = app.graph.add.bind(app.graph);
    app.graph.add = function(node, ...args) {
        const result = origAddNode(node, ...args);
        if (isGGNode(node)) {
            requestAnimationFrame(() => {
                applyNodeTheme(node);
                const el = node.domElement;
                if (el) {
                    el.classList.add("gg-node-new");
                    setTimeout(() => el.classList.remove("gg-node-new"), 300);
                }
            });
        }
        return result;
    };
}

function hookSelectionChange() {
    const canvas = app.canvas;
    if (!canvas) return;

    const origSelectNode = canvas.selectNode?.bind(canvas);
    const origDeselectNode = canvas.deselectNode?.bind(canvas);

    if (origSelectNode) {
        canvas.selectNode = function(node, ...args) {
            const result = origSelectNode(node, ...args);
            if (isGGNode(node)) updateNodeVisualState(node);
            for (const n of Object.values(canvas.selected_nodes || {})) {
                if (n !== node && isGGNode(n)) updateNodeVisualState(n);
            }
            return result;
        };
    }
    if (origDeselectNode) {
        canvas.deselectNode = function(node, ...args) {
            const result = origDeselectNode(node, ...args);
            if (isGGNode(node)) updateNodeVisualState(node);
            return result;
        };
    }
}

export function initGGNodeTheme() {
    if (themeInstalled || typeof app === "undefined") return;
    themeInstalled = true;

    ensureGGIconStyles();
    injectThemeCSS();
    setupMutationObserver();

    setTimeout(() => {
        styleAllExistingNodes();
        hookNodeAdded();
        hookSelectionChange();
    }, 800);

    console.log("[GG Node Theme] 已初始化节点主题美化系统");
}
