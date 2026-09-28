import { app } from "../../scripts/app.js";
import { ggIcon } from "./gg-ui-icons.js";

const SETTINGS_ID = "GuliNodes.groupStyler";
const INSTALL_FLAG = Symbol.for("GuliNodes.groupStyler.installed");
const CANVAS_CAPTURE_FLAG = Symbol.for("GuliNodes.groupStyler.canvasCaptureInstalled");
const TOP_BUTTONS_SETTING = "GuliNodes.groupStylerTopButton";
const MENU_DISPLAY_SETTING = "Comfy.UseNewMenu";
const PROMPT_PATCH_FLAG = Symbol.for("GuliNodes.groupStyler.graphToPromptPatched");
const GROUP_DRAW_PATCH_FLAG = Symbol.for("GuliNodes.groupStyler.drawGroupsPatched");
const GROUP_DRAW_ORIGINAL_KEY = Symbol.for("GuliNodes.groupStyler.drawGroupsOriginal");
const GROUP_INTERACTION_PATCH_FLAG = Symbol.for("GuliNodes.groupStyler.interactionPatched");
const GROUP_INTERACTION_ORIGINAL_KEY = Symbol.for("GuliNodes.groupStyler.interactionOriginal");
const GROUP_SELECTION_HOOK_FLAG = Symbol.for("GuliNodes.groupStyler.selectionHooked");
const GROUP_REPLACEMENT_EVENT_FLAG = Symbol.for("GuliNodes.groupStyler.replacementEventInstalled");
const GROUP_REPLACEMENT_STYLE_ID = "gg-group-styler-replacement-style";
const RESIZE_EDGE_PX = 10;
const NATIVE_CORNER_PX = 18;
const MIN_GROUP_WIDTH = 80;
const MIN_GROUP_HEIGHT = 48;
const TITLE_SCREEN_HEIGHT = 28;
const TITLE_SCREEN_FONT = 13;
const TITLE_SCREEN_RADIUS = 8;
const TITLE_SCREEN_DOT_RADIUS = 3.2;
const TOGGLE_SCREEN_SIZE = 18;
const TOGGLE_SCREEN_RIGHT = 34;
const BUTTON_SCREEN_GAP = 6;
const SCALE_TOGGLE_SCREEN_RIGHT = TOGGLE_SCREEN_RIGHT + TOGGLE_SCREEN_SIZE + BUTTON_SCREEN_GAP;
const RECOMPUTE_INTERVAL = 300;
const DISABLED_MODE = 2;
const BYPASS_MODE = 4;
const ACTIVE_MODE = 0;
const GROUP_BYPASS_STATE_KEY = Symbol.for("GuliNodes.groupStyler.groupBypassModes");
const SCALE_HIDE_RATIO = 0.16;
const SCALE_HIDE_MIN_WIDTH = 24;
const SCALE_HIDE_MIN_HEIGHT = 16;
const SCALE_HIDE_DURATION = 220;
const SCALE_HIDE_GROUP_WIDTH = 178;
const SCALE_HIDE_GROUP_HEIGHT = 48;
const GROUP_CHILD_CONTAINMENT_TOLERANCE = 2;
const LEGACY_COMPACT_GROUP_MAX_WIDTH = 220;
const LEGACY_COMPACT_GROUP_MAX_HEIGHT = 96;
const LEGACY_RECOVERY_MAX_WIDTH = 1200;
const LEGACY_RECOVERY_MAX_HEIGHT = 900;
const LEGACY_RECOVERY_MIN_NODES = 3;
const LEGACY_RECOVERY_PADDING = 24;
const SCALE_HIDE_STATE_KEY = "GuliNodes.groupScaleHideState";
// Group properties are not part of LiteGraph's serialized group payload.
// Keep the same state in flags as well so a saved workflow can restore a
// collapsed group without exposing its real nodes on the next load.
const SCALE_HIDE_STATE_FLAG = "__guli_group_scale_state";
const SCALE_HIDE_CACHE_KEY = "GuliNodes.groupScaleHideCache.v1";
const SCALE_HIDE_CACHE_LIMIT = 80;
const SCALE_HIDE_CACHE_TTL = 1000 * 60 * 60 * 24 * 90;
const SUBWORKFLOW_INDICATOR_ID = "gg-subworkflow-indicators";
const SUBWORKFLOW_INDICATOR_STYLE_ID = "gg-subworkflow-indicator-style";
const HIDDEN_NODE_KEY = "__ggGroupScaleHidden";
const HIDDEN_NODE_OWNER_KEY = "__ggGroupScaleHiddenOwner";
const HIDDEN_GROUP_KEY = "__ggGroupScaleHidden";
const HIDDEN_GROUP_OWNER_KEY = "__ggGroupScaleHiddenOwner";
const HIDDEN_NODE_DRAW_PATCH_FLAG = Symbol.for("GuliNodes.groupStyler.hiddenNodeDrawPatched");
const HIDDEN_NODE_HIT_PATCH_FLAG = Symbol.for("GuliNodes.groupStyler.hiddenNodeHitPatched");
const HIDDEN_CANVAS_DRAW_PATCH_FLAG = Symbol.for("GuliNodes.groupStyler.hiddenCanvasDrawPatched");
const HIDDEN_CONNECTIONS_PATCH_FLAG = Symbol.for("GuliNodes.groupStyler.hiddenConnectionsPatched");
const HIDDEN_COMPUTE_VISIBLE_PATCH_FLAG = Symbol.for("GuliNodes.groupStyler.computeVisiblePatched");

const FALLBACK_COLOR = "#64748b";
const GROUP_COLORS = {
    "#335": "#8b8cf6",
    "#353": "#22c55e",
    "#355": "#06b6d4",
    "#533": "#f87171",
    "#535": "#c084fc",
    "#553": "#f59e0b",
    "#555": "#94a3b8",
};

const resizeState = {
    hover: null,
    active: null,
    windowMove: null,
    windowUp: null,
    windowPointerMove: null,
    windowPointerUp: null,
    windowPointerCancel: null,
    windowBlur: null,
    captureWindow: null,
};

// Keep title dragging separate from LiteGraph's resize/pan state.  Nodes 2.0
// can render node DOM above the canvas, and the native drag state is not
// reliable when the canvas is zoomed or has a non-1:1 backing store.
const groupDragState = {
    active: null,
    windowMove: null,
    windowUp: null,
    windowPointerMove: null,
    windowPointerUp: null,
    windowPointerCancel: null,
    windowBlur: null,
    captureWindow: null,
};

const groupControlState = {
    hoverToggle: null,
    hoverScale: null,
    recomputeTimes: new WeakMap(),
    bypassModes: new WeakMap(),
    lastToggle: null,
    lastScaleToggle: null,
    scaleStates: new WeakMap(),
    scaleAnimations: new WeakMap(),
    topScaleButton: null,
    indicatorHost: null,
    indicatorGraph: null,
    indicatorGraphKey: "",
    indicatorPendingGraphKey: "",
    indicatorSyncQueued: false,
    indicatorPositionInstalled: false,
    hoverProxy: null,
    proxyDrag: null,
    proxyWindowMove: null,
    proxyWindowUp: null,
    proxyWindowPointerMove: null,
    proxyWindowPointerUp: null,
    proxyWindowPointerCancel: null,
    proxyWindowBlur: null,
    proxyCaptureWindow: null,
    lastProxyEditAt: 0,
    lastProxyEditGroup: null,
    hydrateTimer: null,
    drawWatchdogTimer: null,
    nativeGroupHover: null,
    hoverFrame: null,
    hoverCanvas: null,
    hoverEvent: null,
    legacyRecoveredGroups: new WeakSet(),
};

function syncGroupInteractionMarker() {
    globalThis.__ggGroupStylerDraggingCanvas = groupDragState.active?.canvas
        || resizeState.active?.canvas
        || groupControlState.proxyDrag?.canvas
        || null;
}

const hiddenNodeDomStates = new WeakMap();
let hiddenNodeDomObserver = null;
let hiddenNodeDomSyncFrame = null;

const graphIndicatorIds = new WeakMap();
let nextGraphIndicatorId = 1;

function readSetting(id, fallback) {
    try {
        const value = app.extensionManager?.setting?.get?.(id);
        if (value !== undefined) return value;
    } catch (error) {
        console.warn("[GGGroupStyler] Unable to read extension setting:", error);
    }

    try {
        return app.ui?.settings?.getSettingValue?.(id, fallback) ?? fallback;
    } catch (_) {
        return fallback;
    }
}

async function writeSetting(id, value) {
    try {
        if (app.extensionManager?.setting?.set) {
            await app.extensionManager.setting.set(id, value);
            return;
        }
    } catch (error) {
        console.warn("[GGGroupStyler] Unable to write extension setting:", error);
    }

    try {
        app.ui?.settings?.setSettingValue?.(id, value);
    } catch (error) {
        console.warn("[GGGroupStyler] Unable to write UI setting:", error);
    }
}

function isEnabled() {
    return readSetting(SETTINGS_ID, true) !== false;
}

function markCanvasDirty() {
    app.canvas?.setDirty?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

function normalizeHex(color) {
    if (typeof color !== "string") return null;
    const trimmed = color.trim();
    const match = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!match) return null;

    let hex = match[1].toLowerCase();
    if (hex.length === 3) {
        hex = hex.split("").map((char) => char + char).join("");
    }
    return `#${hex}`;
}

function hexToRgb(color) {
    const hex = normalizeHex(color) || normalizeHex(FALLBACK_COLOR);
    return {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
    };
}

function rgba(color, alpha) {
    const { r, g, b } = hexToRgb(color);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mix(colorA, colorB, amount) {
    const a = hexToRgb(colorA);
    const b = hexToRgb(colorB);
    const t = Math.max(0, Math.min(1, amount));
    const channel = (left, right) => Math.round(left + (right - left) * t);
    return `#${[channel(a.r, b.r), channel(a.g, b.g), channel(a.b, b.b)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")}`;
}

function getAccentColor(group) {
    const raw = group?.color || "";
    return GROUP_COLORS[raw] || normalizeHex(raw) || FALLBACK_COLOR;
}

function readVector2(value) {
    if (!value || typeof value !== "object") return null;

    const x = Number(value[0] ?? value.x);
    const y = Number(value[1] ?? value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [x, y];
}

function readBoundsLike(value) {
    if (!value || typeof value !== "object") return null;

    const arrayRect = [
        Number(value[0]),
        Number(value[1]),
        Number(value[2]),
        Number(value[3]),
    ];
    if (arrayRect.every(Number.isFinite)) return arrayRect;

    const pos = readVector2(value.pos ?? value._pos);
    const size = readVector2(value.size ?? value._size);
    if (pos && size) return [pos[0], pos[1], size[0], size[1]];

    const x = Number(value.x ?? value.left);
    const y = Number(value.y ?? value.top);
    const w = Number(value.width ?? value.w);
    const h = Number(value.height ?? value.h);
    if ([x, y, w, h].every(Number.isFinite)) return [x, y, w, h];

    return null;
}

function getGroupBounds(group) {
    const pos = readVector2(group?.pos ?? group?._pos);
    const size = readVector2(group?.size ?? group?._size);
    if (pos && size) return [pos[0], pos[1], size[0], size[1]];

    return readBoundsLike(group?.boundingRect)
        ?? readBoundsLike(group?.getBounding?.())
        ?? readBoundsLike(group?._bounding);
}

function getGroupRect(group) {
    const bounds = getGroupBounds(group);
    if (!bounds) return null;
    return {
        x: Number(bounds[0]) || 0,
        y: Number(bounds[1]) || 0,
        w: Math.max(0, Number(bounds[2]) || 0),
        h: Math.max(0, Number(bounds[3]) || 0),
    };
}

function getGroupGraph(group, canvas = app.canvas) {
    const activeGraph = canvas?.getCurrentGraph?.() ?? canvas?.graph ?? app.graph;
    // A group object can outlive a subgraph switch.  Never use that stale
    // graph when the canvas is currently displaying another graph.
    if (group?.graph && (!activeGraph || group.graph === activeGraph)) return group.graph;
    return activeGraph ?? group?.graph ?? app.graph;
}

function isSkippedMode(mode) {
    return mode === DISABLED_MODE || mode === BYPASS_MODE;
}

function setNodeMode(node, mode) {
    if (!node || !Number.isFinite(mode)) return false;

    // Use LiteGraph's public mode transition when available.  Some ComfyUI
    // versions expose BYPASS (4) in the enum but do not yet handle it in
    // changeMode(), so verify the result and fall back to a direct write.
    let changed = false;
    try {
        if (typeof node.changeMode === "function") {
            node.changeMode(mode);
            changed = node.mode === mode;
        }
    } catch (_) {
        changed = false;
    }
    if (!changed && node.mode !== mode) {
        try {
            node.mode = mode;
            changed = node.mode === mode;
        } catch (_) {
            changed = false;
        }
    }
    if (changed) node.setDirtyCanvas?.(true, false);
    return changed;
}

function readGroupBypassModes(group) {
    return groupControlState.bypassModes.get(group)
        ?? (group?.[GROUP_BYPASS_STATE_KEY] instanceof Map ? group[GROUP_BYPASS_STATE_KEY] : null);
}

function writeGroupBypassModes(group, modes) {
    if (!group || !(modes instanceof Map) || !modes.size) return;
    groupControlState.bypassModes.set(group, modes);
    try {
        Object.defineProperty(group, GROUP_BYPASS_STATE_KEY, {
            value: modes,
            enumerable: false,
            configurable: true,
        });
    } catch (_) {
        // WeakMap state above is sufficient for sealed group objects.
    }
}

function clearGroupBypassModes(group) {
    groupControlState.bypassModes.delete(group);
    try {
        delete group[GROUP_BYPASS_STATE_KEY];
    } catch (_) {
        // Ignore non-configurable host objects.
    }
}

function getActiveGraph(canvas = app.canvas) {
    return canvas?.getCurrentGraph?.() ?? canvas?.graph ?? app.graph;
}

function getIndicatorGraphKey(graph) {
    if (!graph || (typeof graph !== "object" && typeof graph !== "function")) return "none";
    let key = graphIndicatorIds.get(graph);
    if (!key) {
        key = `graph-${nextGraphIndicatorId++}`;
        graphIndicatorIds.set(graph, key);
    }
    return key;
}

function groupBelongsToGraph(group, graph) {
    return !!group && !!graph && getGraphGroups(graph).includes(group);
}

function isGraphGroupLike(value) {
    if (!value || typeof value !== "object") return false;
    const GroupClass = globalThis.LiteGraph?.LGraphGroup ?? globalThis.LGraphGroup;
    if (GroupClass && value instanceof GroupClass) return true;
    if ("mode" in value || Array.isArray(value.inputs) || Array.isArray(value.outputs)) return false;
    return !!(
        getGroupBounds(value)
        && ("title" in value || "name" in value || "color" in value || "_children" in value || "nodes" in value)
    );
}

function selectionContainsGroup(value, depth = 0) {
    if (!value || depth > 2) return false;
    if (isGraphGroupLike(value)) return true;
    if (Array.isArray(value)) return value.some((item) => selectionContainsGroup(item, depth + 1));
    if (typeof value !== "object") return false;
    // A node can carry layout/ownership metadata that happens to reference a
    // group.  It is still a node selection and must keep the official node
    // toolbox; never recurse through node-shaped values here.
    if ("mode" in value || Array.isArray(value.inputs) || Array.isArray(value.outputs)) return false;

    // `LGraphNode` instances can expose their owning group as `group` (and
    // some ComfyUI selection wrappers copy that property).  Ownership is not
    // selection: treating it as a selected group suppresses the official
    // node toolbox whenever a node lives inside a GuliNodes group.  Only walk
    // fields that represent the selected item itself; a group selected
    // directly is already caught by the isGraphGroupLike check above.
    const candidates = [
        value.item,
        value.target,
        value.selectedItem,
        value.selected,
        value.selection,
        value.value,
    ];
    return candidates.some((item) => selectionContainsGroup(item, depth + 1));
}

function getVisibleGraphGroups(canvas = app.canvas) {
    const graph = getActiveGraph(canvas);
    return [...(graph?._groups ?? graph?.groups ?? [])].filter((group) => isGraphGroupLike(group) && !isGroupScaleHiddenByParent(group));
}

function getGraphGroups(graph) {
    if (!graph) return [];

    // LiteGraph keeps all subgraph definitions in the root graph's `subgraphs`
    // registry, but a canvas can only display the groups belonging to its
    // current graph.  Do not flatten that registry here: doing so lets a group
    // from another subgraph match the current graph's nodes/IDs and is the
    // source of the intermittent "all nodes pile up" behaviour.
    return [...(graph._groups ?? graph.groups ?? [])];
}

function getNodeBounds(node) {
    try {
        const bounds = node?.getBounding?.();
        if (bounds) return bounds;
    } catch (_) {
        // Fall back to pos/size below.
    }
    if (isArrayLikeNumber(node?.pos) && isArrayLikeNumber(node?.size)) {
        return [node.pos[0], node.pos[1], node.size[0], node.size[1]];
    }
    return null;
}

function collectNodesInGroup(group, graph) {
    const rect = getGroupRect(group);
    if (!graph || !rect) return [];

    const allNodes = graph.nodes ?? graph._nodes ?? [];
    const nodes = [];
    for (const node of allNodes) {
        if (!node || typeof node !== "object" || !("mode" in node)) continue;

        const bounds = getNodeBounds(node);
        if (!bounds) continue;

        const cx = bounds[0] + bounds[2] * 0.5;
        const cy = bounds[1] + bounds[3] * 0.5;
        if (cx >= rect.x && cx < rect.x + rect.w && cy >= rect.y && cy < rect.y + rect.h) {
            nodes.push(node);
        }
    }
    return nodes;
}

function syncGroupNodeCache(group, nodes) {
    // Newer LiteGraph builds store nodes, reroutes AND nested groups in
    // group._children. Only the node subset should be refreshed here so we
    // preserve reroutes / nested groups that native recomputeInsideNodes adds.
    if (group?._children instanceof Set) {
        const current = [...group._children];
        const nodeSet = new Set(nodes);
        for (const child of current) {
            if (child && typeof child === "object" && "mode" in child && !nodeSet.has(child)) {
                group._children.delete(child);
            }
        }
        for (const node of nodes) {
            group._children.add(node);
        }
    }

    if (!Array.isArray(group.nodes)) group.nodes = [];
    group.nodes.length = 0;
    group.nodes.push(...nodes);

    if (Array.isArray(group._nodes)) {
        group._nodes.length = 0;
        group._nodes.push(...nodes);
    }
}

function recomputeGroupNodes(group, canvas = app.canvas) {
    const graph = getGroupGraph(group, canvas);
    if (!graph || !getGroupRect(group)) return;

    let usedNativeMembership = false;
    try {
        if (typeof group.recomputeInsideNodes === "function") {
            group.recomputeInsideNodes();
            usedNativeMembership = true;
        }
    } catch (_) {
        // Older LiteGraph builds may not expose recomputeInsideNodes.
    }

    // LiteGraph's native method includes nodes, reroutes and nested groups in
    // the exact same way as its selection and drag code.  Replacing that
    // cache with a second centre-in-rectangle calculation used to drop edge
    // nodes and cause only part of a group to be bypassed.
    if (!usedNativeMembership) {
        syncGroupNodeCache(group, collectNodesInGroup(group, graph));
    }
}

function recomputeGroupNodesIfNeeded(group, canvas) {
    const now = Date.now();
    const last = groupControlState.recomputeTimes.get(group) || 0;
    if (now - last < RECOMPUTE_INTERVAL) return;
    groupControlState.recomputeTimes.set(group, now);
    recomputeGroupNodes(group, canvas);
}

function getGroupNodes(group) {
    const seen = new Set();
    const result = [];
    const add = (node) => {
        if (!node || typeof node !== "object" || !("mode" in node) || seen.has(node)) return;
        seen.add(node);
        result.push(node);
    };

    if (group?._children instanceof Set) {
        for (const node of group._children) add(node);
    }
    for (const node of group?.nodes ?? []) add(node);
    if (Array.isArray(group?._nodes)) {
        for (const node of group._nodes) add(node);
    }

    return result;
}

function getGroupBypassState(group, canvas) {
    recomputeGroupNodesIfNeeded(group, canvas);
    const nodes = getGroupNodes(group);
    const hasNodes = nodes.length > 0;
    const savedModes = readGroupBypassModes(group);
    const managedBypassed = savedModes?.size > 0
        && [...savedModes.keys()].every((node) => node?.mode === BYPASS_MODE);
    // A group is bypassed only when every member is in LiteGraph's official
    // BYPASS mode (4). NEVER (2) remains a genuine mute and must not be
    // rewritten or treated as an implicit group bypass.
    const bypassed = hasNodes && (managedBypassed || nodes.every((node) => node.mode === BYPASS_MODE));
    const mixed = hasNodes && !bypassed && nodes.some((node) => isSkippedMode(node.mode));
    return { nodes, hasNodes, bypassed, mixed };
}

function setGroupBypass(group, bypass, canvas = app.canvas) {
    recomputeGroupNodes(group, canvas);
    const nodes = getGroupNodes(group);
    if (!nodes.length) return false;

    if (bypass) {
        const savedModes = readGroupBypassModes(group) ?? new Map();
        // Match ComfyUI's official "Bypass selected nodes" action: every
        // selected node receives mode=4.  Filtering by input/output shape
        // leaves mixed groups half-active and diverges from the official
        // execution semantics.
        for (const node of nodes) {
            if (!savedModes.has(node)) {
                savedModes.set(node, Number.isFinite(node.mode) ? node.mode : ACTIVE_MODE);
            }
            setNodeMode(node, BYPASS_MODE);
        }
        writeGroupBypassModes(group, savedModes);
    } else {
        const savedModes = readGroupBypassModes(group);
        for (const node of nodes) {
            // Restore the exact pre-bypass mode, including NEVER, ON_EVENT,
            // and ON_TRIGGER. Nodes added while bypass was active fall back
            // to ALWAYS rather than remaining stuck in BYPASS.
            const originalMode = savedModes?.get(node);
            setNodeMode(node, Number.isFinite(originalMode)
                ? originalMode
                : (node.mode === BYPASS_MODE ? ACTIVE_MODE : node.mode));
        }
        clearGroupBypassModes(group);
    }

    const graph = getGroupGraph(group, canvas);
    graph?.change?.();
    graph?.setDirtyCanvas?.(true, false);
    markCanvasDirty();
    return true;
}

function enforceHiddenGroupsBeforePrompt(canvas = app.canvas) {
    // Keep the graph's serialized node modes untouched. ComfyUI's official
    // graph-to-prompt path distinguishes NEVER (2) from BYPASS (4); changing
    // one into the other here can remove outputs or alter downstream execution.
    return false;
}

function getNativeGroupMinSize() {
    const GroupClass = globalThis.LiteGraph?.LGraphGroup ?? globalThis.LGraphGroup;
    return {
        width: Math.max(MIN_GROUP_WIDTH, Number(GroupClass?.minWidth) || 0),
        height: Math.max(MIN_GROUP_HEIGHT, Number(GroupClass?.minHeight) || 0),
    };
}

function writeVector2(value, x, y) {
    if (!value || typeof value !== "object") return false;

    let changed = false;
    try {
        value[0] = x;
        value[1] = y;
        changed = true;
    } catch (_) {
        // Some builds expose readonly vector views; try named fields below.
    }

    if ("x" in value || "y" in value) {
        try {
            value.x = x;
            value.y = y;
            changed = true;
        } catch (_) {
            // Ignore readonly fields.
        }
    }

    if (typeof value.set === "function") {
        try {
            value.set([x, y]);
            changed = true;
        } catch (_) {
            try {
                value.set(x, y);
                changed = true;
            } catch (_) {
                // Not every vector-like set() accepts the same signature.
            }
        }
    }

    return changed;
}

function writeBoundsLike(value, x, y, w, h) {
    if (!value || typeof value !== "object") return false;

    let changed = false;
    try {
        value[0] = x;
        value[1] = y;
        value[2] = w;
        value[3] = h;
        changed = true;
    } catch (_) {
        // Continue with Rectangle-style APIs below.
    }

    if (typeof value.set === "function") {
        try {
            value.set([x, y, w, h]);
            changed = true;
        } catch (_) {
            try {
                value.set(x, y, w, h);
                changed = true;
            } catch (_) {
                // Rectangle variants differ between LiteGraph builds.
            }
        }
    }

    changed = writeVector2(value.pos ?? value._pos, x, y) || changed;
    changed = writeVector2(value.size ?? value._size, w, h) || changed;

    try {
        if ("x" in value || "left" in value) {
            if ("x" in value) value.x = x;
            if ("left" in value) value.left = x;
            changed = true;
        }
        if ("y" in value || "top" in value) {
            if ("y" in value) value.y = y;
            if ("top" in value) value.top = y;
            changed = true;
        }
        if ("width" in value || "w" in value) {
            if ("width" in value) value.width = w;
            if ("w" in value) value.w = w;
            changed = true;
        }
        if ("height" in value || "h" in value) {
            if ("height" in value) value.height = h;
            if ("h" in value) value.h = h;
            changed = true;
        }
    } catch (_) {
        // Ignore readonly aliases.
    }

    return changed;
}

function setGroupRect(group, rect) {
    const minSize = getNativeGroupMinSize();
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    const w = Math.max(minSize.width, Math.round(rect.w));
    const h = Math.max(minSize.height, Math.round(rect.h));

    writeBoundsLike(group._bounding, x, y, w, h);
    writeBoundsLike(group.boundingRect, x, y, w, h);
    writeBoundsLike(group.getBounding?.(), x, y, w, h);
    writeVector2(group.pos, x, y);
    writeVector2(group._pos, x, y);
    writeVector2(group.size, w, h);
    writeVector2(group._size, w, h);

    try {
        group.pos = [x, y];
    } catch (_) {
        // Older builds may expose pos as a readonly getter.
    }
    try {
        group.size = [w, h];
    } catch (_) {
        // Older builds may expose size as a readonly getter.
    }
    try {
        group.resize?.(w, h);
    } catch (_) {
        // Native resize is optional; direct bounds writes above are the source of truth.
    }

    group.setDirtyCanvas?.(true, true);
}

function getCanvasScale(canvas) {
    return Math.max(0.01, Number(canvas?.ds?.scale) || 1);
}

function getTitleMetrics(rect, scale) {
    const safeScale = Math.max(0.01, scale || 1);
    const titleHeight = TITLE_SCREEN_HEIGHT / safeScale;
    const basePadding = 12 / safeScale;
    const textInset = 24 / safeScale;

    return {
        titleHeight,
        radius: TITLE_SCREEN_RADIUS / safeScale,
        fontSize: TITLE_SCREEN_FONT / safeScale,
        dotRadius: TITLE_SCREEN_DOT_RADIUS / safeScale,
        dotX: rect.x + Math.min(basePadding, Math.max(4 / safeScale, rect.w * 0.18)),
        dotY: rect.y + titleHeight / 2,
        textX: rect.x + Math.min(textInset, Math.max(10 / safeScale, rect.w * 0.28)),
        textRightPadding: 88 / safeScale,
    };
}

function getGroupToggleRect(rect, metrics, scale) {
    const safeScale = Math.max(0.01, scale || 1);
    const size = TOGGLE_SCREEN_SIZE / safeScale;
    const right = TOGGLE_SCREEN_RIGHT / safeScale;
    return {
        x: rect.x + rect.w - right - size,
        y: rect.y + Math.max(0, (metrics.titleHeight - size) / 2),
        w: size,
        h: size,
    };
}

function getGroupScaleRect(rect, metrics, scale) {
    const safeScale = Math.max(0.01, scale || 1);
    const size = TOGGLE_SCREEN_SIZE / safeScale;
    const right = SCALE_TOGGLE_SCREEN_RIGHT / safeScale;
    return {
        x: rect.x + rect.w - right - size,
        y: rect.y + Math.max(0, (metrics.titleHeight - size) / 2),
        w: size,
        h: size,
    };
}

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function easeInOutCubic(value) {
    const t = clamp01(value);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function getGroupScaleOwnerId(group) {
    if (!group || typeof group !== "object") return "";
    if (!group.__ggGroupScaleHideId) {
        try {
            Object.defineProperty(group, "__ggGroupScaleHideId", {
                value: `gg-group-scale-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                enumerable: false,
                configurable: true,
            });
        } catch (_) {
            group.__ggGroupScaleHideId = `gg-group-scale-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        }
    }
    return group.__ggGroupScaleHideId;
}

function normalizeScaleSnapshot(snapshot) {
    const id = snapshot?.id;
    const pos = readVector2(snapshot?.pos);
    const size = readVector2(snapshot?.size);
    if (id == null || !pos || !size) return null;
    return {
        id: String(id),
        pos: [pos[0], pos[1]],
        size: [Math.max(1, size[0]), Math.max(1, size[1])],
    };
}

function normalizeScaleGroupSnapshot(snapshot) {
    const pos = readVector2(snapshot?.pos);
    const size = readVector2(snapshot?.size);
    if (!pos || !size) return null;
    const title = normalizeCacheTitle(snapshot?.title || snapshot?.name || "Subgraph");
    return {
        key: String(snapshot?.key || `${title}:${Math.round(pos[0])},${Math.round(pos[1])},${Math.round(size[0])},${Math.round(size[1])}`),
        title,
        pos: [pos[0], pos[1]],
        size: [Math.max(1, size[0]), Math.max(1, size[1])],
    };
}

function normalizeScaleRect(rect) {
    const bounds = readBoundsLike(rect);
    if (!bounds) return null;
    return {
        x: Number(bounds[0]) || 0,
        y: Number(bounds[1]) || 0,
        w: Math.max(1, Number(bounds[2]) || 1),
        h: Math.max(1, Number(bounds[3]) || 1),
    };
}

function serializeScaleRect(rect) {
    const normalized = normalizeScaleRect(rect);
    return normalized
        ? { x: normalized.x, y: normalized.y, w: normalized.w, h: normalized.h }
        : null;
}

function normalizeScaleState(state) {
    if (!state || typeof state !== "object") return null;
    const nodes = (Array.isArray(state.nodes) ? state.nodes : []).map(normalizeScaleSnapshot).filter(Boolean);
    const groups = (Array.isArray(state.groups) ? state.groups : []).map(normalizeScaleGroupSnapshot).filter(Boolean);
    if (!nodes.length && !groups.length) return null;
    const phase = ["hiding", "hidden", "restoring"].includes(state.phase) ? state.phase : (state.hidden ? "hidden" : null);
    const title = String(state.title || state.subworkflowName || state.name || "Subgraph");
    const subworkflowName = String(state.subworkflowName || state.title || state.name || title);
    return {
        hidden: !!state.hidden || phase === "hiding" || phase === "hidden",
        phase,
        nodes,
        groups,
        groupRect: normalizeScaleRect(state.groupRect),
        compactGroupRect: normalizeScaleRect(state.compactGroupRect),
        title,
        subworkflowName,
        indicatorColor: normalizeHex(state.indicatorColor) || null,
        subworkflow: state.subworkflow !== false,
        // Hidden nodes keep their original graph layout.  Older saved states
        // did not have this field; treating them as layout-preserving also
        // migrates those states away from the old compacted-node behaviour.
        preserveLayout: state.preserveLayout !== false,
        updatedAt: Number(state.updatedAt) || Date.now(),
    };
}

function serializeScaleState(state) {
    const normalized = normalizeScaleState(state);
    if (!normalized) return null;
    return {
        hidden: normalized.hidden,
        phase: normalized.phase,
        nodes: normalized.nodes.map((snapshot) => ({
            id: snapshot.id,
            pos: [snapshot.pos[0], snapshot.pos[1]],
            size: [snapshot.size[0], snapshot.size[1]],
        })),
        groups: normalized.groups.map((snapshot) => ({
            key: snapshot.key,
            title: snapshot.title,
            pos: [snapshot.pos[0], snapshot.pos[1]],
            size: [snapshot.size[0], snapshot.size[1]],
        })),
        groupRect: serializeScaleRect(normalized.groupRect),
        compactGroupRect: serializeScaleRect(normalized.compactGroupRect),
        title: normalized.title,
        subworkflowName: normalized.subworkflowName,
        indicatorColor: normalized.indicatorColor,
        subworkflow: normalized.subworkflow,
        preserveLayout: normalized.preserveLayout,
        updatedAt: normalized.updatedAt,
    };
}

function hashString(value) {
    let hash = 2166136261;
    const text = String(value ?? "");
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function normalizeCacheTitle(value) {
    const title = String(value ?? "").trim();
    return title || "Subgraph";
}

function countNodeIdOverlap(leftIds, rightIds) {
    const left = new Set((leftIds ?? []).map(String));
    let count = 0;
    for (const id of rightIds ?? []) {
        if (left.has(String(id))) count += 1;
    }
    return count;
}

function getScaleStateUpdatedAt(value) {
    return Number(value?.updatedAt) || Number(value?.state?.updatedAt) || 0;
}

function isScaleStateExpired(value, now = Date.now()) {
    const updatedAt = getScaleStateUpdatedAt(value);
    return updatedAt > 0 && now - updatedAt > SCALE_HIDE_CACHE_TTL;
}

function readScaleCache() {
    try {
        const raw = localStorage.getItem(SCALE_HIDE_CACHE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
            return parsed;
        }
    } catch (error) {
        console.warn("[GGGroupStyler] Unable to read group scale cache:", error);
    }
    return { version: 1, entries: {} };
}

function writeScaleCache(cache) {
    try {
        const now = Date.now();
        const entries = Object.entries(cache?.entries ?? {})
            .filter(([, entry]) => !isScaleStateExpired(entry, now))
            .sort((left, right) => getScaleStateUpdatedAt(right[1]) - getScaleStateUpdatedAt(left[1]))
            .slice(0, SCALE_HIDE_CACHE_LIMIT);
        localStorage.setItem(SCALE_HIDE_CACHE_KEY, JSON.stringify({
            version: 1,
            entries: Object.fromEntries(entries),
        }));
    } catch (error) {
        console.warn("[GGGroupStyler] Unable to write group scale cache:", error);
    }
}

function getGroupProperties(group, create = false) {
    if (!group || typeof group !== "object") return null;
    if (!group.properties || typeof group.properties !== "object") {
        if (!create) return null;
        try {
            group.properties = {};
        } catch (_) {
            return null;
        }
    }
    return group.properties;
}

function readGroupScaleState(group) {
    const cached = groupControlState.scaleStates.get(group);
    if (cached) return cached;

    const raw = group?.[SCALE_HIDE_STATE_KEY]
        ?? getGroupProperties(group)?.[SCALE_HIDE_STATE_KEY]
        ?? group?.flags?.[SCALE_HIDE_STATE_FLAG];
    const state = normalizeScaleState(raw);
    if (state) groupControlState.scaleStates.set(group, state);
    return state;
}

function writeGroupScaleState(group, state) {
    const serialized = serializeScaleState(state);
    if (!serialized) return;
    groupControlState.scaleStates.set(group, serialized);
    if (serialized.hidden) {
        rememberGroupScaleState(group, serialized);
    } else {
        forgetGroupScaleState(group, serialized);
    }
    try {
        group[SCALE_HIDE_STATE_KEY] = serialized;
    } catch (_) {
        // Runtime cache above is enough if the group object is sealed.
    }
    const properties = getGroupProperties(group, true);
    if (properties) {
        try {
            properties[SCALE_HIDE_STATE_KEY] = serialized;
        } catch (_) {
            // Some group property bags may be readonly.
        }
    }
    try {
        if (!group.flags || typeof group.flags !== "object") group.flags = {};
        group.flags[SCALE_HIDE_STATE_FLAG] = serialized;
    } catch (_) {
        // The runtime and local cache still cover sealed host objects.
    }
}

function clearGroupScaleState(group) {
    const existing = readGroupScaleState(group);
    if (existing) forgetGroupScaleState(group, existing);
    groupControlState.scaleStates.delete(group);
    try {
        delete group[SCALE_HIDE_STATE_KEY];
    } catch (_) {
        // Ignore readonly group objects.
    }
    const properties = getGroupProperties(group);
    if (properties) {
        try {
            delete properties[SCALE_HIDE_STATE_KEY];
        } catch (_) {
            // Ignore readonly group property bags.
        }
    }
    try {
        if (group.flags && typeof group.flags === "object") {
            delete group.flags[SCALE_HIDE_STATE_FLAG];
        }
    } catch (_) {
        // Ignore readonly host flags.
    }
}

function getGroupTitle(group) {
    const title = String(group?.title || group?.name || "").trim();
    return title || "Subgraph";
}

function randomIndicatorColor() {
    const palette = [
        "#ef4444",
        "#f97316",
        "#f59e0b",
        "#22c55e",
        "#14b8a6",
        "#06b6d4",
        "#3b82f6",
        "#8b5cf6",
        "#d946ef",
        "#ec4899",
    ];
    return palette[Math.floor(Math.random() * palette.length)] || "#3b82f6";
}

function ensureScaleIndicatorColor(group, existingState = null) {
    const existing = normalizeHex(existingState?.indicatorColor) || normalizeHex(readGroupScaleState(group)?.indicatorColor);
    return existing || randomIndicatorColor();
}

function isGroupScaleHidden(group) {
    const state = readGroupScaleState(group);
    return !!state && (state.hidden || state.phase === "hiding" || state.phase === "hidden");
}

function isGroupScaleRestoring(group) {
    return readGroupScaleState(group)?.phase === "restoring";
}

function hasScaleStateContent(state) {
    return !!(state?.nodes?.length || state?.groups?.length);
}

function isGroupScaleHiddenNode(node) {
    return !!node?.[HIDDEN_NODE_KEY];
}

function isNodes20Mode(canvas = app.canvas) {
    return !!(
        globalThis.LiteGraph?.vueNodesMode
        || canvas?.vueNodesMode
        || app?.vueNodesMode
    );
}

function getNodeDomElement(node) {
    const element = node?.domElement
        ?? node?.element
        ?? node?.dom_element
        ?? null;
    if (element?.style) return element;

    // Nodes 2.0 keeps the Vue element in its own renderer registry instead
    // of attaching it to the LiteGraph node instance. Resolve it by the
    // stable data-node-id attribute when the direct references are absent.
    const nodeId = getNodeId(node);
    if (nodeId == null || typeof document === "undefined") return null;
    for (const candidate of document.querySelectorAll?.(".lg-node[data-node-id], [data-node-id].lg-node") ?? []) {
        if (String(candidate.dataset?.nodeId) === nodeId && candidate.style) return candidate;
    }
    return null;
}

function setNodeDomScaleHidden(node, hidden, ownerId) {
    const element = getNodeDomElement(node);
    if (!element) return;

    if (hidden) {
        const existingState = hiddenNodeDomStates.get(node);
        if (!existingState || existingState.element !== element) {
            hiddenNodeDomStates.set(node, {
                ownerId,
                element,
                visibility: element.style.visibility,
                opacity: element.style.opacity,
                pointerEvents: element.style.pointerEvents,
                ariaHidden: element.getAttribute?.("aria-hidden"),
            });
        } else {
            if (!existingState.ownerId) existingState.ownerId = ownerId;
        }
        element.classList?.add("gg-group-scale-hidden-node");
        element.style.visibility = "hidden";
        element.style.opacity = "0";
        element.style.pointerEvents = "none";
        element.setAttribute?.("aria-hidden", "true");
        return;
    }

    const state = hiddenNodeDomStates.get(node);
    if (state && state.ownerId && ownerId && state.ownerId !== ownerId) return;
    hiddenNodeDomStates.delete(node);
    element.classList?.remove("gg-group-scale-hidden-node");
    if (state) {
        element.style.visibility = state.visibility;
        element.style.opacity = state.opacity;
        element.style.pointerEvents = state.pointerEvents;
        if (state.ariaHidden == null) element.removeAttribute?.("aria-hidden");
        else element.setAttribute?.("aria-hidden", state.ariaHidden);
    } else {
        element.style.visibility = "";
        element.style.opacity = "";
        element.style.pointerEvents = "";
        element.removeAttribute?.("aria-hidden");
    }
}

function syncHiddenNodeDomElements(canvas = app.canvas) {
    if (!isNodes20Mode(canvas)) return;
    const graph = getActiveGraph(canvas);
    for (const node of getGraphNodes(graph)) {
        if (!isGroupScaleHiddenNode(node)) continue;
        setNodeDomScaleHidden(node, true, node[HIDDEN_NODE_OWNER_KEY]);
    }
}

function scheduleHiddenNodeDomSync(canvas = app.canvas) {
    if (hiddenNodeDomSyncFrame != null || typeof requestAnimationFrame !== "function") return;
    hiddenNodeDomSyncFrame = requestAnimationFrame(() => {
        hiddenNodeDomSyncFrame = null;
        syncHiddenNodeDomElements(canvas);
    });
}

function installHiddenNodeDomObserver() {
    if (hiddenNodeDomObserver || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    let scanTimer = null;
    const scheduleScan = () => {
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = setTimeout(() => { scanTimer = null; scheduleHiddenNodeDomSync(app.canvas); }, 200);
    };
    hiddenNodeDomObserver = new MutationObserver(scheduleScan);
    hiddenNodeDomObserver.observe(document.body, { childList: true, subtree: true });
}

function getNodeId(node) {
    const id = node?.id ?? node?.graph_node_id;
    return id == null ? null : String(id);
}

function getGraphNodes(graph) {
    return graph?.nodes ?? graph?._nodes ?? [];
}

function getGraphScaleCacheSignature(graph = getActiveGraph()) {
    const nodes = getGraphNodes(graph)
        .map((node) => {
            const id = getNodeId(node);
            const type = String(node?.comfyClass || node?.type || node?.constructor?.type || node?.title || "");
            return id == null ? null : `${id}:${type}`;
        })
        .filter(Boolean)
        .sort();
    return hashString([
        location?.origin || "",
        location?.pathname || "",
        nodes.join("|"),
    ].join("::"));
}

function getGroupScaleCacheNodeIds(group, state = null, canvas = app.canvas) {
    const fromState = (state?.nodes ?? [])
        .map(normalizeScaleSnapshot)
        .filter(Boolean)
        .map((snapshot) => snapshot.id);
    if (fromState.length) return [...new Set(fromState)].sort();

    recomputeGroupNodes(group, canvas);
    return [...new Set(getGroupNodes(group).map(getNodeId).filter((id) => id != null))].sort();
}

function getGroupScaleCacheSignature(group, state = null, canvas = app.canvas) {
    const title = normalizeCacheTitle(getGroupTitle(group));
    const ids = getGroupScaleCacheNodeIds(group, state, canvas);
    if (!ids.length) {
        const rect = normalizeScaleRect(state?.groupRect) ?? getGroupRect(group);
        return hashString(`${title}::empty::${rect ? [rect.x, rect.y, rect.w, rect.h].map(Math.round).join(",") : ""}`);
    }
    return hashString(`${title}::${ids.join(",")}`);
}

function getGroupScaleCacheKey(group, state = null, canvas = app.canvas) {
    const graph = getGroupGraph(group, canvas);
    const graphSignature = getGraphScaleCacheSignature(graph);
    const groupSignature = getGroupScaleCacheSignature(group, state, canvas);
    return {
        key: `${graphSignature}:${groupSignature}`,
        graphSignature,
        groupSignature,
        nodeIds: getGroupScaleCacheNodeIds(group, state, canvas),
    };
}

function rememberGroupScaleState(group, state, canvas = app.canvas) {
    const serialized = serializeScaleState(state);
    if (!serialized?.hidden) return;

    const cacheMeta = getGroupScaleCacheKey(group, serialized, canvas);
    if (!cacheMeta.nodeIds.length && !serialized.groups?.length) return;

    const cache = readScaleCache();
    cache.entries[cacheMeta.key] = {
        state: serialized,
        title: normalizeCacheTitle(getGroupTitle(group)),
        subworkflowName: normalizeCacheTitle(serialized.subworkflowName || serialized.title),
        graphSignature: cacheMeta.graphSignature,
        groupSignature: cacheMeta.groupSignature,
        nodeIds: cacheMeta.nodeIds,
        updatedAt: Date.now(),
    };
    writeScaleCache(cache);
}

function forgetGroupScaleState(group, state = null, canvas = app.canvas) {
    const cache = readScaleCache();
    const meta = getGroupScaleCacheKey(group, state, canvas);
    let changed = false;

    for (const [key, entry] of Object.entries(cache.entries)) {
        if (
            key === meta.key
            || (
                entry?.groupSignature === meta.groupSignature
                && entry?.graphSignature === meta.graphSignature
            )
        ) {
            delete cache.entries[key];
            changed = true;
        }
    }

    if (changed) writeScaleCache(cache);
}

function readCachedGroupScaleState(group, canvas = app.canvas, options = {}) {
    const expired = !!options.expired;
    const now = Date.now();
    const cache = readScaleCache();
    const meta = getGroupScaleCacheKey(group, null, canvas);
    const currentTitle = normalizeCacheTitle(getGroupTitle(group));
    const currentNodeIds = meta.nodeIds.map(String);
    const entries = Object.entries(cache.entries)
        .map(([key, entry]) => ({ key, ...entry }))
        .filter((entry) => isScaleStateExpired(entry, now) === expired);

    const exact = entries.find((entry) => entry.key === meta.key);
    const signatureFallback = entries
        .filter((entry) => entry.groupSignature === meta.groupSignature)
        .sort((left, right) => {
            const graphMatch = Number(right.graphSignature === meta.graphSignature) - Number(left.graphSignature === meta.graphSignature);
            if (graphMatch) return graphMatch;
            return getScaleStateUpdatedAt(right) - getScaleStateUpdatedAt(left);
        })[0];
    const titleFallbackCandidates = entries
        .filter((entry) => (
            entry.graphSignature === meta.graphSignature
            && (
                normalizeCacheTitle(entry.title) === currentTitle
                || normalizeCacheTitle(entry.subworkflowName) === currentTitle
                || normalizeCacheTitle(entry.state?.title) === currentTitle
                || normalizeCacheTitle(entry.state?.subworkflowName) === currentTitle
            )
        ))
        .map((entry) => ({
            ...entry,
            overlap: countNodeIdOverlap(currentNodeIds, entry.nodeIds),
        }))
        .filter((entry) => currentNodeIds.length ? entry.overlap > 0 : true);
    const titleFallback = (
        currentNodeIds.length || titleFallbackCandidates.length === 1
            ? titleFallbackCandidates.sort((left, right) => {
                if (right.overlap !== left.overlap) return right.overlap - left.overlap;
                return getScaleStateUpdatedAt(right) - getScaleStateUpdatedAt(left);
            })[0]
            : null
    );

    const state = normalizeScaleState((exact ?? signatureFallback ?? titleFallback)?.state);
    if (!state?.hidden) return null;
    return state;
}

function findNodeById(graph, id) {
    if (!graph || id == null) return null;
    try {
        const node = graph.getNodeById?.(id);
        if (node) return node;
    } catch (_) {
        // Fall back to scanning below.
    }
    return getGraphNodes(graph).find((node) => String(node?.id) === String(id)) ?? null;
}

function getNodeRect(node) {
    const pos = readVector2(node?.pos ?? node?._pos);
    const size = readVector2(node?.size ?? node?._size);
    if (pos && size) {
        return { x: pos[0], y: pos[1], w: Math.max(1, size[0]), h: Math.max(1, size[1]) };
    }

    const bounds = readBoundsLike(node?.getBounding?.());
    if (bounds) {
        return { x: bounds[0], y: bounds[1], w: Math.max(1, bounds[2]), h: Math.max(1, bounds[3]) };
    }
    return null;
}

function setNodeRect(node, rect) {
    if (!node || !rect) return;
    const x = Number(rect.x) || 0;
    const y = Number(rect.y) || 0;
    const w = Math.max(1, Number(rect.w) || 1);
    const h = Math.max(1, Number(rect.h) || 1);

    if (!writeVector2(node.pos, x, y)) {
        try {
            node.pos = [x, y];
        } catch (_) {
            // Ignore readonly positions.
        }
    }

    let sized = false;
    if (typeof node.setSize === "function") {
        try {
            node.setSize([w, h]);
            sized = true;
        } catch (_) {
            try {
                node.setSize(w, h);
                sized = true;
            } catch (_) {
                // Fall through to direct size writes.
            }
        }
    }
    if (!writeVector2(node.size, w, h) && !sized) {
        try {
            node.size = [w, h];
        } catch (_) {
            // Ignore readonly sizes.
        }
    }
    node.setDirtyCanvas?.(true, true);
}

function snapshotGroupScaleNodes(nodes) {
    const snapshots = [];
    for (const node of nodes) {
        const id = getNodeId(node);
        const rect = getNodeRect(node);
        if (id == null || !rect) continue;
        snapshots.push({
            id,
            pos: [rect.x, rect.y],
            size: [rect.w, rect.h],
        });
    }
    return snapshots;
}

function rectArea(rect) {
    return rect ? Math.max(0, rect.w) * Math.max(0, rect.h) : 0;
}

function rectInsideRect(innerRect, outerRect, tolerance = GROUP_CHILD_CONTAINMENT_TOLERANCE) {
    if (!innerRect || !outerRect) return false;
    const innerArea = rectArea(innerRect);
    const outerArea = rectArea(outerRect);
    if (innerArea >= outerArea - 1) return false;

    return innerRect.x >= outerRect.x - tolerance
        && innerRect.y >= outerRect.y - tolerance
        && innerRect.x + innerRect.w <= outerRect.x + outerRect.w + tolerance
        && innerRect.y + innerRect.h <= outerRect.y + outerRect.h + tolerance;
}

function collectGroupsInGroup(group, canvas = app.canvas) {
    const graph = getGroupGraph(group, canvas);
    const parentRect = getGroupRect(group);
    if (!graph || !parentRect) return [];

    return getGraphGroups(graph)
        .filter((candidate) => candidate !== group && isGraphGroupLike(candidate))
        .map((candidate, index) => ({ candidate, index, rect: getGroupRect(candidate) }))
        .filter((entry) => rectInsideRect(entry.rect, parentRect))
        .sort((left, right) => {
            const areaDelta = (right.rect.w * right.rect.h) - (left.rect.w * left.rect.h);
            if (areaDelta) return areaDelta;
            return left.index - right.index;
        });
}

function snapshotGroupScaleGroups(group, canvas = app.canvas) {
    return collectGroupsInGroup(group, canvas)
        .map(({ candidate, index, rect }) => {
            if (!rect) return null;
            const title = getGroupTitle(candidate);
            return {
                key: `${title}:${index}:${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`,
                title,
                pos: [rect.x, rect.y],
                size: [rect.w, rect.h],
                group: candidate,
            };
        })
        .filter(Boolean);
}

function boundsFromSnapshots(snapshots) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const snapshot of snapshots) {
        const x = snapshot.pos[0];
        const y = snapshot.pos[1];
        const w = snapshot.size[0];
        const h = snapshot.size[1];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w);
        maxY = Math.max(maxY, y + h);
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

function getCompactGroupRect(groupRect, canvas) {
    const rect = normalizeScaleRect(groupRect);
    if (!rect) return null;
    const minSize = getNativeGroupMinSize();
    const width = Math.max(minSize.width, SCALE_HIDE_GROUP_WIDTH);
    const height = Math.max(minSize.height, SCALE_HIDE_GROUP_HEIGHT);
    return {
        x: rect.x,
        y: rect.y,
        w: width,
        h: height,
    };
}

function compactRectForSnapshot(snapshot, contentRect, compactGroupRect) {
    const availableW = Math.max(1, compactGroupRect.w * 0.54);
    const availableH = Math.max(1, compactGroupRect.h * 0.36);
    const fitRatio = Math.min(
        SCALE_HIDE_RATIO,
        availableW / Math.max(1, contentRect.w),
        availableH / Math.max(1, contentRect.h),
    );
    const ratio = Math.max(0.04, fitRatio);
    const w = Math.min(Math.max(SCALE_HIDE_MIN_WIDTH, snapshot.size[0] * ratio), Math.max(8, compactGroupRect.w * 0.42));
    const h = Math.min(Math.max(SCALE_HIDE_MIN_HEIGHT, snapshot.size[1] * ratio), Math.max(8, compactGroupRect.h * 0.42));
    const nodeCx = snapshot.pos[0] + snapshot.size[0] / 2;
    const nodeCy = snapshot.pos[1] + snapshot.size[1] / 2;
    const contentCx = contentRect.x + contentRect.w / 2;
    const contentCy = contentRect.y + contentRect.h / 2;
    const anchor = {
        x: compactGroupRect.x + compactGroupRect.w * 0.5,
        y: compactGroupRect.y + compactGroupRect.h * 0.62,
    };
    return {
        x: anchor.x + (nodeCx - contentCx) * ratio - w / 2,
        y: anchor.y + (nodeCy - contentCy) * ratio - h / 2,
        w,
        h,
    };
}

function setNodeScaleHidden(node, hidden, group) {
    if (!node) return;
    const ownerId = getGroupScaleOwnerId(group);
    if (hidden) {
        node[HIDDEN_NODE_KEY] = true;
        node[HIDDEN_NODE_OWNER_KEY] = ownerId;
        if (isNodes20Mode()) setNodeDomScaleHidden(node, true, ownerId);
        if (isNodes20Mode()) scheduleHiddenNodeDomSync(app.canvas);
        return;
    }
    if (!node[HIDDEN_NODE_OWNER_KEY] || node[HIDDEN_NODE_OWNER_KEY] === ownerId) {
        try {
            delete node[HIDDEN_NODE_KEY];
            delete node[HIDDEN_NODE_OWNER_KEY];
        } catch (_) {
            node[HIDDEN_NODE_KEY] = false;
            node[HIDDEN_NODE_OWNER_KEY] = null;
        }
        setNodeDomScaleHidden(node, false, ownerId);
        if (isNodes20Mode()) scheduleHiddenNodeDomSync(app.canvas);
    }
}

function isGroupScaleHiddenByParent(group) {
    return !!group?.[HIDDEN_GROUP_KEY];
}

function setGroupScaleHiddenByParent(childGroup, hidden, ownerGroup) {
    if (!childGroup || childGroup === ownerGroup) return;
    const ownerId = getGroupScaleOwnerId(ownerGroup);
    if (hidden) {
        try {
            Object.defineProperty(childGroup, HIDDEN_GROUP_KEY, {
                value: true,
                enumerable: false,
                configurable: true,
            });
            Object.defineProperty(childGroup, HIDDEN_GROUP_OWNER_KEY, {
                value: ownerId,
                enumerable: false,
                configurable: true,
            });
        } catch (_) {
            childGroup[HIDDEN_GROUP_KEY] = true;
            childGroup[HIDDEN_GROUP_OWNER_KEY] = ownerId;
        }
        return;
    }

    if (!childGroup[HIDDEN_GROUP_OWNER_KEY] || childGroup[HIDDEN_GROUP_OWNER_KEY] === ownerId) {
        try {
            delete childGroup[HIDDEN_GROUP_KEY];
            delete childGroup[HIDDEN_GROUP_OWNER_KEY];
        } catch (_) {
            childGroup[HIDDEN_GROUP_KEY] = false;
            childGroup[HIDDEN_GROUP_OWNER_KEY] = null;
        }
    }
}

function clearHiddenGroupSelection(canvas, groups) {
    const hidden = new Set(groups);
    if (hidden.has(canvas?.selected_group)) canvas.selected_group = null;
    const selectedItems = canvas?.selected_items ?? canvas?.selectedItems;
    if (Array.isArray(selectedItems)) {
        for (let i = selectedItems.length - 1; i >= 0; i--) {
            if (hidden.has(selectedItems[i])) selectedItems.splice(i, 1);
        }
    } else if (selectedItems instanceof Set) {
        for (const item of hidden) selectedItems.delete(item);
    }
    for (const group of hidden) {
        if (group) group.selected = false;
    }
    canvas?.updateSelectedItems?.();
}

function rectDistanceScore(rect, targetRect) {
    if (!rect || !targetRect) return 0;
    const delta = Math.abs(rect.x - targetRect.x)
        + Math.abs(rect.y - targetRect.y)
        + Math.abs(rect.w - targetRect.w)
        + Math.abs(rect.h - targetRect.h);
    return Math.max(0, 80 - delta / 8);
}

function groupSnapshotToRect(snapshot) {
    const normalized = normalizeScaleGroupSnapshot(snapshot);
    return normalized
        ? { x: normalized.pos[0], y: normalized.pos[1], w: normalized.size[0], h: normalized.size[1] }
        : null;
}

function findGroupForScaleSnapshot(parentGroup, snapshot, canvas = app.canvas, used = new Set(), compactRect = null) {
    if (snapshot?.group && isGraphGroupLike(snapshot.group) && !used.has(snapshot.group)) return snapshot.group;

    const graph = getGroupGraph(parentGroup, canvas);
    const originalRect = groupSnapshotToRect(snapshot);
    const title = normalizeCacheTitle(snapshot?.title);
    let best = null;
    let bestScore = -Infinity;

    for (const candidate of getGraphGroups(graph)) {
        if (!candidate || candidate === parentGroup || used.has(candidate) || !isGraphGroupLike(candidate)) continue;
        const rect = getGroupRect(candidate);
        if (!rect) continue;

        let score = 0;
        if (normalizeCacheTitle(getGroupTitle(candidate)) === title) score += 120;
        score += rectDistanceScore(rect, originalRect);
        score += rectDistanceScore(rect, compactRect);
        if (isGroupScaleHiddenByParent(candidate)) score += 12;

        if (score > bestScore) {
            best = candidate;
            bestScore = score;
        }
    }

    return bestScore > 0 ? best : null;
}

function clearHiddenNodeSelection(canvas, nodes) {
    const hidden = new Set(nodes);
    const clearSelectionMap = (selected) => {
        if (!selected) return;
        if (Array.isArray(selected)) {
            for (let i = selected.length - 1; i >= 0; i--) {
                if (hidden.has(selected[i])) selected.splice(i, 1);
            }
            return;
        }
        if (typeof selected === "object") {
            for (const [key, node] of Object.entries(selected)) {
                if (hidden.has(node)) delete selected[key];
            }
        }
    };

    clearSelectionMap(canvas?.selected_nodes);
    clearSelectionMap(canvas?.graph?.selected_nodes);
    const selectedItems = canvas?.selected_items ?? canvas?.selectedItems;
    if (Array.isArray(selectedItems)) {
        for (let i = selectedItems.length - 1; i >= 0; i--) {
            if (hidden.has(selectedItems[i])) selectedItems.splice(i, 1);
        }
    } else if (selectedItems instanceof Set) {
        for (const node of hidden) selectedItems.delete(node);
    }
    for (const node of hidden) {
        if (node) node.selected = false;
    }
    if (hidden.has(canvas?.selected_node)) canvas.selected_node = null;
    canvas?.updateSelectedItems?.();
}

function cancelScaleAnimation(group) {
    const animation = groupControlState.scaleAnimations.get(group);
    if (!animation) return;
    animation.cancelled = true;
    if (animation.frame != null) {
        try {
            cancelAnimationFrame(animation.frame);
        } catch (_) {
            // Ignore missing browser animation APIs in unusual hosts.
        }
    }
    groupControlState.scaleAnimations.delete(group);
}

function interpolateRect(from, to, progress) {
    return {
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
        w: from.w + (to.w - from.w) * progress,
        h: from.h + (to.h - from.h) * progress,
    };
}

function setScaleEntryRect(entry, rect) {
    if (entry?.group) {
        setGroupRect(entry.group, rect);
        return;
    }
    if (entry?.node) {
        setNodeRect(entry.node, rect);
    }
}

function animateNodeRects(group, entries, canvas, onFinish, groupEntry = null) {
    cancelScaleAnimation(group);
    if (!entries.length && !groupEntry) {
        onFinish?.();
        return;
    }

    const animation = { cancelled: false, frame: null };
    const startedAt = performance.now();
    const step = (now) => {
        if (animation.cancelled) return;
        const progress = easeInOutCubic((now - startedAt) / SCALE_HIDE_DURATION);
        if (groupEntry) {
            setGroupRect(group, interpolateRect(groupEntry.from, groupEntry.to, progress));
        }
        for (const entry of entries) {
            setScaleEntryRect(entry, interpolateRect(entry.from, entry.to, progress));
        }
        markCanvasDirty();

        if (progress < 1) {
            animation.frame = requestAnimationFrame(step);
            return;
        }

        groupControlState.scaleAnimations.delete(group);
        onFinish?.();
    };

    groupControlState.scaleAnimations.set(group, animation);
    animation.frame = requestAnimationFrame(step);
}

function touchScaleGraph(group, canvas) {
    const graph = getGroupGraph(group, canvas);
    graph?.change?.();
    graph?.setDirtyCanvas?.(true, true);
    markCanvasDirty();
    syncTopScaleButton();
    syncSubworkflowIndicators(canvas);
}

function getScaleCandidateNodes(group, canvas) {
    recomputeGroupNodes(group, canvas);
    const ownerId = getGroupScaleOwnerId(group);
    return getGroupNodes(group).filter((node) => !isGroupScaleHiddenNode(node) || node[HIDDEN_NODE_OWNER_KEY] === ownerId);
}

function applyHiddenScaleState(group, state, canvas = app.canvas) {
    const graph = getGroupGraph(group, canvas);
    const snapshots = (state?.nodes ?? []).map(normalizeScaleSnapshot).filter(Boolean);
    const groupSnapshots = (state?.groups ?? []).map(normalizeScaleGroupSnapshot).filter(Boolean);
    if (!graph || (!snapshots.length && !groupSnapshots.length)) return false;

    // 打开工作流恢复隐藏态时，必须以分组当前 rect 作为位置基准。
    // 缓存里记录的 groupRect/compactGroupRect 是上次隐藏时的位置，
    // 分组若已被挪动，再用旧位置会把分组拽回老地方、节点也会跑到分组外（错位）。
    const currentGroupRect = getGroupRect(group);
    if (!currentGroupRect) return false;
    const originalGroupRect = normalizeScaleRect(state.groupRect) ?? currentGroupRect;
    const cachedCompact = normalizeScaleRect(state.compactGroupRect);
    const fallbackCompact = cachedCompact ?? getCompactGroupRect(originalGroupRect, canvas) ?? currentGroupRect;
    const sameCompactSize = Math.abs(currentGroupRect.w - fallbackCompact.w) < 2
        && Math.abs(currentGroupRect.h - fallbackCompact.h) < 2;
    // A serialized hidden group has the compact proxy rectangle, while the
    // saved snapshots retain the real node layout.  Use the compact rectangle
    // as the movement baseline; using originalGroupRect here shifts all nodes
    // into the proxy and recreates the stacked-node bug after reload.
    const layoutOffset = sameCompactSize
        ? {
            x: currentGroupRect.x - fallbackCompact.x,
            y: currentGroupRect.y - fallbackCompact.y,
        }
        : {
            x: currentGroupRect.x - originalGroupRect.x,
            y: currentGroupRect.y - originalGroupRect.y,
        };
    const translatedOriginalGroupRect = {
        ...originalGroupRect,
        x: originalGroupRect.x + layoutOffset.x,
        y: originalGroupRect.y + layoutOffset.y,
    };
    const translatedSnapshots = snapshots.map((snapshot) => ({
        ...snapshot,
        pos: [snapshot.pos[0] + layoutOffset.x, snapshot.pos[1] + layoutOffset.y],
    }));
    const translatedGroupSnapshots = groupSnapshots.map((snapshot) => ({
        ...snapshot,
        pos: [snapshot.pos[0] + layoutOffset.x, snapshot.pos[1] + layoutOffset.y],
    }));
    // 位置用当前，尺寸用缓存的目标隐藏尺寸
    const compactGroupRect = {
        x: currentGroupRect.x,
        y: currentGroupRect.y,
        w: fallbackCompact.w,
        h: fallbackCompact.h,
    };
    if (!compactGroupRect) return false;

    const contentRect = boundsFromSnapshots([...translatedSnapshots, ...translatedGroupSnapshots]);
    const hiddenNodes = [];
    const hiddenGroups = [];
    const usedGroups = new Set();
    setGroupRect(group, compactGroupRect);

    for (const snapshot of translatedSnapshots) {
        const node = findNodeById(graph, snapshot.id);
        if (!node) continue;

        // Keep the real node at its saved position.  The old implementation
        // compacted every hidden node into the proxy rectangle; native/DOM
        // render paths that did not see our hidden marker then rendered those
        // nodes on top of one another.  Restoring the source rect makes the
        // hidden state safe even when a ComfyUI build uses a different draw
        // path, while the hidden marker still removes it from the canvas.
        if (state.preserveLayout !== false) {
            setNodeRect(node, {
                x: snapshot.pos[0] + layoutOffset.x,
                y: snapshot.pos[1] + layoutOffset.y,
                w: snapshot.size[0],
                h: snapshot.size[1],
            });
        } else if (contentRect) {
            setNodeRect(node, compactRectForSnapshot(snapshot, contentRect, compactGroupRect));
        }
        setNodeScaleHidden(node, true, group);
        hiddenNodes.push(node);
    }

    for (const snapshot of translatedGroupSnapshots) {
        const compactRect = contentRect ? compactRectForSnapshot(snapshot, contentRect, compactGroupRect) : null;
        const childGroup = findGroupForScaleSnapshot(group, snapshot, canvas, usedGroups, compactRect);
        if (!childGroup) continue;
        usedGroups.add(childGroup);
        if (state.preserveLayout !== false) {
            setGroupRect(childGroup, {
                x: snapshot.pos[0] + layoutOffset.x,
                y: snapshot.pos[1] + layoutOffset.y,
                w: snapshot.size[0],
                h: snapshot.size[1],
            });
        } else if (compactRect) {
            setGroupRect(childGroup, compactRect);
        }
        setGroupScaleHiddenByParent(childGroup, true, group);
        hiddenGroups.push(childGroup);
    }

    if (!hiddenNodes.length && !hiddenGroups.length) return false;
    if (hiddenNodes.length) clearHiddenNodeSelection(canvas, hiddenNodes);
    if (hiddenGroups.length) clearHiddenGroupSelection(canvas, hiddenGroups);
    writeGroupScaleState(group, {
        ...state,
        hidden: true,
        phase: "hidden",
        nodes: translatedSnapshots,
        groups: translatedGroupSnapshots,
        groupRect: translatedOriginalGroupRect,
        compactGroupRect,
        title: state.title || state.subworkflowName || getGroupTitle(group),
        subworkflowName: state.subworkflowName || state.title || getGroupTitle(group),
        indicatorColor: ensureScaleIndicatorColor(group, state),
        subworkflow: true,
        preserveLayout: state.preserveLayout !== false,
        updatedAt: state.updatedAt || Date.now(),
    });
    return true;
}

function restoreExpiredScaleState(group, state, canvas = app.canvas) {
    const graph = getGroupGraph(group, canvas);
    const snapshots = (state?.nodes ?? []).map(normalizeScaleSnapshot).filter(Boolean);
    const groupSnapshots = (state?.groups ?? []).map(normalizeScaleGroupSnapshot).filter(Boolean);
    if (!graph || (!snapshots.length && !groupSnapshots.length)) return false;

    const targetGroupRect = normalizeScaleRect(state.groupRect) ?? getGroupRect(group);
    if (targetGroupRect) {
        setGroupRect(group, targetGroupRect);
    }

    let restored = false;
    const usedGroups = new Set();
    for (const snapshot of snapshots) {
        const node = findNodeById(graph, snapshot.id);
        if (!node) continue;
        setNodeRect(node, {
            x: snapshot.pos[0],
            y: snapshot.pos[1],
            w: snapshot.size[0],
            h: snapshot.size[1],
        });
        setNodeScaleHidden(node, false, group);
        restored = true;
    }
    for (const snapshot of groupSnapshots) {
        const childGroup = findGroupForScaleSnapshot(group, snapshot, canvas, usedGroups);
        if (!childGroup) continue;
        usedGroups.add(childGroup);
        setGroupRect(childGroup, {
            x: snapshot.pos[0],
            y: snapshot.pos[1],
            w: snapshot.size[0],
            h: snapshot.size[1],
        });
        setGroupScaleHiddenByParent(childGroup, false, group);
        restored = true;
    }

    forgetGroupScaleState(group, state, canvas);
    clearGroupScaleState(group);
    recomputeGroupNodes(group, canvas);

    if (restored || targetGroupRect) {
        touchScaleGraph(group, canvas);
        return true;
    }
    return false;
}

function hideGroupScaled(group, canvas = app.canvas) {
    if (!group) return false;
    const existing = readGroupScaleState(group);
    if (existing && !isGroupScaleRestoring(group) && isGroupScaleHidden(group)) return false;

    const graph = getGroupGraph(group, canvas);
    const currentGroupRect = getGroupRect(group);
    const originalGroupRect = normalizeScaleRect(existing?.groupRect) ?? currentGroupRect;
    if (!currentGroupRect || !originalGroupRect) return false;

    const snapshots = existing?.phase === "restoring"
        ? existing.nodes
        : snapshotGroupScaleNodes(getScaleCandidateNodes(group, canvas));
    const normalizedSnapshots = snapshots.map(normalizeScaleSnapshot).filter(Boolean);
    const groupSnapshots = existing?.phase === "restoring"
        ? (existing.groups ?? [])
        : snapshotGroupScaleGroups(group, canvas);
    const normalizedGroupSnapshots = groupSnapshots.map(normalizeScaleGroupSnapshot).filter(Boolean);
    if (!normalizedSnapshots.length && !normalizedGroupSnapshots.length) return false;

    const contentRect = boundsFromSnapshots([...normalizedSnapshots, ...normalizedGroupSnapshots]);
    if (!contentRect) return false;

    const compactGroupRect = normalizeScaleRect(existing?.compactGroupRect) ?? getCompactGroupRect(originalGroupRect, canvas);
    if (!compactGroupRect) return false;
    const subworkflowName = existing?.subworkflowName || getGroupTitle(group);
    const indicatorColor = ensureScaleIndicatorColor(group, existing);

    const entries = [];
    const hiddenGroups = [];
    const usedGroups = new Set();
    for (const snapshot of normalizedSnapshots) {
        const node = findNodeById(graph, snapshot.id);
        const from = getNodeRect(node);
        if (!node || !from) continue;
        setNodeScaleHidden(node, true, group);
        entries.push({
            node,
            from,
            // Preserve the node's real layout while the group proxy shrinks.
            // This avoids a fallback renderer exposing a stack of compacted
            // nodes at the proxy position.
            to: from,
        });
    }
    for (const snapshot of normalizedGroupSnapshots) {
        const compactRect = compactRectForSnapshot(snapshot, contentRect, compactGroupRect);
        const childGroup = findGroupForScaleSnapshot(group, snapshot, canvas, usedGroups, compactRect);
        const from = getGroupRect(childGroup);
        if (!childGroup || !from) continue;
        usedGroups.add(childGroup);
        setGroupScaleHiddenByParent(childGroup, true, group);
        hiddenGroups.push(childGroup);
        entries.push({
            group: childGroup,
            from,
            to: from,
        });
    }
    if (!entries.length) return false;
    clearHiddenNodeSelection(canvas, entries.filter((entry) => entry.node).map((entry) => entry.node));
    clearHiddenGroupSelection(canvas, hiddenGroups);

    writeGroupScaleState(group, {
        hidden: true,
        phase: "hiding",
        nodes: normalizedSnapshots,
        groups: normalizedGroupSnapshots,
        groupRect: originalGroupRect,
        compactGroupRect,
        title: subworkflowName,
        subworkflowName,
        indicatorColor,
        subworkflow: true,
        preserveLayout: true,
        updatedAt: Date.now(),
    });

    animateNodeRects(group, entries, canvas, () => {
        const state = readGroupScaleState(group);
        if (!state || state.phase !== "hiding") return;
        setGroupRect(group, compactGroupRect);
        for (const entry of entries) {
            setScaleEntryRect(entry, entry.to);
            if (entry.node) setNodeScaleHidden(entry.node, true, group);
            if (entry.group) setGroupScaleHiddenByParent(entry.group, true, group);
        }
        writeGroupScaleState(group, {
            hidden: true,
            phase: "hidden",
            nodes: normalizedSnapshots,
            groups: normalizedGroupSnapshots,
            groupRect: originalGroupRect,
            compactGroupRect,
            title: subworkflowName,
            subworkflowName,
            indicatorColor,
            subworkflow: true,
            preserveLayout: true,
            updatedAt: Date.now(),
        });
        touchScaleGraph(group, canvas);
    }, { from: currentGroupRect, to: compactGroupRect });

    touchScaleGraph(group, canvas);
    return true;
}

function restoreGroupScaled(group, canvas = app.canvas) {
    const state = readGroupScaleState(group);
    if (!group || (!state?.nodes?.length && !state?.groups?.length)) return false;

    const graph = getGroupGraph(group, canvas);
    const currentGroupRect = getGroupRect(group);
    const targetGroupRect = normalizeScaleRect(state.groupRect) ?? currentGroupRect;
    const compactGroupRect = normalizeScaleRect(state.compactGroupRect) ?? currentGroupRect;
    const entries = [];
    const usedGroups = new Set();
    for (const snapshot of state.nodes ?? []) {
        const normalized = normalizeScaleSnapshot(snapshot);
        const node = findNodeById(graph, normalized?.id);
        const from = getNodeRect(node);
        if (!node || !normalized || !from) continue;
        setNodeScaleHidden(node, true, group);
        entries.push({
            node,
            from,
            to: {
                x: normalized.pos[0],
                y: normalized.pos[1],
                w: normalized.size[0],
                h: normalized.size[1],
            },
        });
    }
    for (const snapshot of state.groups ?? []) {
        const normalized = normalizeScaleGroupSnapshot(snapshot);
        const childGroup = findGroupForScaleSnapshot(group, normalized, canvas, usedGroups);
        const from = getGroupRect(childGroup);
        if (!childGroup || !normalized || !from) continue;
        usedGroups.add(childGroup);
        setGroupScaleHiddenByParent(childGroup, true, group);
        entries.push({
            group: childGroup,
            from,
            to: {
                x: normalized.pos[0],
                y: normalized.pos[1],
                w: normalized.size[0],
                h: normalized.size[1],
            },
        });
    }

    if (!entries.length && !targetGroupRect) {
        clearGroupScaleState(group);
        syncTopScaleButton();
        return false;
    }

    writeGroupScaleState(group, {
        hidden: false,
        phase: "restoring",
        nodes: state.nodes ?? [],
        groups: state.groups ?? [],
        groupRect: targetGroupRect,
        compactGroupRect,
        title: state.title || getGroupTitle(group),
        subworkflowName: state.subworkflowName || state.title || getGroupTitle(group),
        indicatorColor: ensureScaleIndicatorColor(group, state),
        subworkflow: true,
        preserveLayout: state.preserveLayout !== false,
        updatedAt: Date.now(),
    });

    animateNodeRects(group, entries, canvas, () => {
        if (targetGroupRect) {
            setGroupRect(group, targetGroupRect);
        }
        for (const entry of entries) {
            setScaleEntryRect(entry, entry.to);
            if (entry.node) setNodeScaleHidden(entry.node, false, group);
            if (entry.group) setGroupScaleHiddenByParent(entry.group, false, group);
        }
        clearGroupScaleState(group);
        touchScaleGraph(group, canvas);
    }, currentGroupRect && targetGroupRect ? { from: currentGroupRect, to: targetGroupRect } : null);

    touchScaleGraph(group, canvas);
    return true;
}

function toggleGroupScale(group, canvas = app.canvas) {
    return isGroupScaleHidden(group)
        ? restoreGroupScaled(group, canvas)
        : hideGroupScaled(group, canvas);
}

function getRestorableScaleGroups(canvas = app.canvas, graph = getActiveGraph(canvas)) {
    return getGraphGroups(graph).filter((group) => {
        const state = readGroupScaleState(group);
        return hasScaleStateContent(state) && (
            state.hidden
            || state.phase === "hiding"
            || state.phase === "hidden"
            || state.phase === "restoring"
        );
    });
}

function restoreAllScaledGroups(canvas = app.canvas) {
    const groups = getRestorableScaleGroups(canvas);
    let restored = false;
    for (const group of groups) {
        restored = restoreGroupScaled(group, canvas) || restored;
    }
    return restored;
}

function getRawGroupNodeMembers(group) {
    const result = new Set();
    const add = (node) => {
        if (node && typeof node === "object" && "mode" in node) result.add(node);
    };
    for (const node of group?._children instanceof Set ? group._children : []) add(node);
    for (const node of Array.isArray(group?._nodes) ? group._nodes : []) add(node);
    for (const node of Array.isArray(group?.nodes) ? group.nodes : []) add(node);
    return result;
}

function recoverLegacyCompactGroups(canvas = app.canvas) {
    const graph = getActiveGraph(canvas);
    if (!graph) return false;

    const groups = getGraphGroups(graph);
    const nodes = getGraphNodes(graph);
    const ownedNodes = new Set();
    for (const group of groups) {
        for (const node of getRawGroupNodeMembers(group)) ownedNodes.add(node);
    }

    let changed = false;
    for (const group of groups) {
        if (!group || groupControlState.legacyRecoveredGroups.has(group)) continue;
        groupControlState.legacyRecoveredGroups.add(group);

        // Older versions saved a collapsed proxy as an ordinary 178x80 group,
        // while its hidden markers lived only in memory.  On reload that left
        // the real nodes outside the proxy.  Only migrate groups that have no
        // serialized members and a sizeable, unowned node cluster below them;
        // small label groups and groups whose nodes already belong elsewhere
        // remain untouched.
        if (readGroupScaleState(group)) continue;
        // Older releases kept the collapse snapshot only in localStorage.
        // Let the normal hydration path consume that snapshot before the
        // heuristic migration changes the group's current rectangle.
        if (readCachedGroupScaleState(group, canvas)?.hidden) continue;
        const rect = getGroupRect(group);
        if (!rect
            || rect.w > LEGACY_COMPACT_GROUP_MAX_WIDTH
            || rect.h > LEGACY_COMPACT_GROUP_MAX_HEIGHT
            || getRawGroupNodeMembers(group).size) continue;

        const left = rect.x - LEGACY_RECOVERY_PADDING;
        const top = rect.y + Math.max(0, rect.h - LEGACY_RECOVERY_PADDING);
        const right = rect.x + LEGACY_RECOVERY_MAX_WIDTH;
        const bottom = rect.y + LEGACY_RECOVERY_MAX_HEIGHT;
        const candidates = nodes.filter((node) => {
            if (!node || ownedNodes.has(node)) return false;
            const bounds = getNodeRect(node);
            if (!bounds) return false;
            return bounds.x >= left
                && bounds.y >= top
                && bounds.x <= right
                && bounds.y <= bottom;
        });
        if (candidates.length < LEGACY_RECOVERY_MIN_NODES) continue;

        let maxX = rect.x + rect.w;
        let maxY = rect.y + rect.h;
        for (const node of candidates) {
            const bounds = getNodeRect(node);
            if (!bounds) continue;
            maxX = Math.max(maxX, bounds.x + bounds.w);
            maxY = Math.max(maxY, bounds.y + bounds.h);
        }
        const recoveredRect = {
            x: rect.x,
            y: rect.y,
            w: maxX - rect.x + LEGACY_RECOVERY_PADDING,
            h: maxY - rect.y + LEGACY_RECOVERY_PADDING,
        };
        setGroupRect(group, recoveredRect);
        try {
            group.recomputeInsideNodes?.();
        } catch (_) {
            syncGroupNodeCache(group, candidates);
        }
        changed = true;
        console.warn("[GGGroupStyler] Recovered legacy compact group layout:", getGroupTitle(group));
    }

    if (changed) {
        graph.change?.();
        graph.setDirtyCanvas?.(true, true);
        markCanvasDirty();
    }
    return changed;
}

function installSubworkflowIndicatorStyles() {
    let style = document.getElementById(SUBWORKFLOW_INDICATOR_STYLE_ID);
    if (!style) {
        style = document.createElement("style");
        style.id = SUBWORKFLOW_INDICATOR_STYLE_ID;
        document.head.appendChild(style);
    }
    style.textContent = `
        #${SUBWORKFLOW_INDICATOR_ID} {
            position: fixed;
            right: 292px;
            bottom: 24px;
            z-index: 100000;
            display: flex;
            flex-direction: row-reverse;
            flex-wrap: wrap-reverse;
            align-items: center;
            justify-content: flex-start;
            gap: 10px;
            max-width: min(42vw, 360px);
            pointer-events: none;
        }
        #${SUBWORKFLOW_INDICATOR_ID}[hidden] {
            display: none !important;
        }
        #${SUBWORKFLOW_INDICATOR_ID} .gg-subworkflow-dot {
            --gg-subworkflow-color: #3b82f6;
            position: relative;
            width: 20px;
            height: 20px;
            min-width: 20px;
            min-height: 20px;
            padding: 0;
            border: 2px solid rgba(255, 255, 255, 0.9);
            border-radius: 999px;
            background: var(--gg-subworkflow-color);
            box-shadow: 0 8px 18px rgba(15, 23, 42, 0.28), 0 0 0 4px rgba(255, 255, 255, 0.16);
            cursor: pointer;
            pointer-events: auto;
            appearance: none;
            outline: none;
            transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
        }
        #${SUBWORKFLOW_INDICATOR_ID} .gg-subworkflow-dot:hover,
        #${SUBWORKFLOW_INDICATOR_ID} .gg-subworkflow-dot:focus-visible {
            transform: translateY(-2px) scale(1.16);
            border-color: rgba(255, 255, 255, 1);
            box-shadow: 0 12px 24px rgba(15, 23, 42, 0.34), 0 0 0 5px rgba(255, 255, 255, 0.2);
        }
        #${SUBWORKFLOW_INDICATOR_ID} .gg-subworkflow-dot::after {
            content: attr(data-title);
            position: absolute;
            right: 0;
            bottom: calc(100% + 9px);
            max-width: 240px;
            padding: 6px 9px;
            border: 1px solid rgba(148, 163, 184, 0.3);
            border-radius: 7px;
            background: rgba(15, 23, 42, 0.94);
            color: #f8fafc;
            box-shadow: 0 10px 24px rgba(15, 23, 42, 0.28);
            font: 12px/1.35 Inter, Arial, sans-serif;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            opacity: 0;
            transform: translateY(4px);
            pointer-events: none;
            transition: opacity 0.14s ease, transform 0.14s ease;
        }
        #${SUBWORKFLOW_INDICATOR_ID} .gg-subworkflow-dot:hover::after,
        #${SUBWORKFLOW_INDICATOR_ID} .gg-subworkflow-dot:focus-visible::after {
            opacity: 1;
            transform: translateY(0);
        }
    `;
}

function ensureSubworkflowIndicatorHost() {
    if (typeof document === "undefined") return null;
    installSubworkflowIndicatorStyles();

    let host = groupControlState.indicatorHost;
    if (host?.isConnected) return host;

    host = document.getElementById(SUBWORKFLOW_INDICATOR_ID);
    if (!host) {
        host = document.createElement("div");
        host.id = SUBWORKFLOW_INDICATOR_ID;
        host.hidden = true;
        document.body.appendChild(host);
    }
    groupControlState.indicatorHost = host;
    return host;
}

function clearSubworkflowIndicators(resetGraph = false) {
    const host = groupControlState.indicatorHost
        ?? (typeof document !== "undefined" ? document.getElementById(SUBWORKFLOW_INDICATOR_ID) : null);
    if (host) {
        host.replaceChildren();
        host.hidden = true;
        host.dataset.count = "0";
        delete host.dataset.graphKey;
    }
    if (resetGraph) {
        groupControlState.indicatorGraph = null;
        groupControlState.indicatorGraphKey = "";
        groupControlState.indicatorPendingGraphKey = "";
    }
}

function queueSubworkflowIndicatorSync(canvas = app.canvas) {
    if (groupControlState.indicatorSyncQueued) return;
    const schedule = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 0);
    groupControlState.indicatorSyncQueued = true;
    schedule(() => {
        groupControlState.indicatorSyncQueued = false;
        groupControlState.indicatorPendingGraphKey = "";
        syncSubworkflowIndicators(canvas);
    });
}

function noticeSubworkflowIndicatorGraph(canvas = app.canvas) {
    if (!isEnabled()) {
        clearSubworkflowIndicators(true);
        return;
    }
    const graph = getActiveGraph(canvas);
    const graphKey = getIndicatorGraphKey(graph);
    if (graphKey === groupControlState.indicatorGraphKey) return;
    if (graphKey !== groupControlState.indicatorPendingGraphKey) {
        groupControlState.indicatorPendingGraphKey = graphKey;
        clearSubworkflowIndicators();
    }
    queueSubworkflowIndicatorSync(canvas);
}

function getBottomRightFloatingToolbarRect(host) {
    if (typeof document === "undefined") return null;
    const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!viewportW || !viewportH) return null;

    let best = null;
    for (const element of document.body?.querySelectorAll?.("*") ?? []) {
        if (!element || element === host || host?.contains?.(element) || element.contains?.(host)) continue;
        const style = window.getComputedStyle?.(element);
        if (!style || !["fixed", "sticky"].includes(style.position)) continue;
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;

        const rect = element.getBoundingClientRect?.();
        if (!rect || rect.width < 90 || rect.height < 28 || rect.width > 560 || rect.height > 120) continue;
        if (rect.right < viewportW - 96 || rect.bottom < viewportH - 120) continue;

        const score = (viewportW - rect.right) + (viewportH - rect.bottom) - rect.width * 0.02;
        if (!best || score < best.score) {
            best = { rect, score };
        }
    }
    return best?.rect ?? null;
}

function positionSubworkflowIndicators(host = groupControlState.indicatorHost) {
    if (!host || typeof window === "undefined") return;
    const toolbarRect = getBottomRightFloatingToolbarRect(host);
    if (!toolbarRect) {
        host.style.right = "292px";
        host.style.bottom = "24px";
        return;
    }

    const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
    const gap = 16;
    const dotSize = 20;
    const right = Math.max(24, viewportW - toolbarRect.left + gap);
    const bottom = Math.max(8, viewportH - toolbarRect.bottom + Math.max(0, (toolbarRect.height - dotSize) / 2));
    host.style.right = `${Math.round(right)}px`;
    host.style.bottom = `${Math.round(bottom)}px`;
}

function installSubworkflowIndicatorPositioning() {
    if (groupControlState.indicatorPositionInstalled || typeof window === "undefined") return;
    groupControlState.indicatorPositionInstalled = true;
    window.addEventListener("resize", () => positionSubworkflowIndicators(), { passive: true });
}

function getSubworkflowIndicatorEntries(canvas = app.canvas, graph = getActiveGraph(canvas)) {
    const entries = [];
    const seen = new Set();
    for (const group of getRestorableScaleGroups(canvas, graph)) {
        if (!groupBelongsToGraph(group, graph)) continue;
        let state = readGroupScaleState(group);
        if (!hasScaleStateContent(state)) continue;

        const ownerKey = `owner:${getGroupScaleOwnerId(group)}`;
        const nodesKey = `nodes:${(state.nodes ?? [])
            .map((snapshot) => normalizeScaleSnapshot(snapshot)?.id)
            .filter(Boolean)
            .sort()
            .join("|")}`;
        const groupsKey = `groups:${(state.groups ?? [])
            .map((snapshot) => {
                const normalized = normalizeScaleGroupSnapshot(snapshot);
                return normalized ? `${normalized.title}:${normalized.key}` : null;
            })
            .filter(Boolean)
            .sort()
            .join("|")}`;
        const hasNodesKey = nodesKey !== "nodes:";
        const hasGroupsKey = groupsKey !== "groups:";
        if (seen.has(ownerKey) || (hasNodesKey && seen.has(nodesKey)) || (hasGroupsKey && seen.has(groupsKey))) continue;
        seen.add(ownerKey);
        if (hasNodesKey) seen.add(nodesKey);
        if (hasGroupsKey) seen.add(groupsKey);

        let color = normalizeHex(state.indicatorColor);
        if (!color) {
            color = ensureScaleIndicatorColor(group, state);
            writeGroupScaleState(group, {
                ...state,
                indicatorColor: color,
                updatedAt: state.updatedAt || Date.now(),
            });
            state = readGroupScaleState(group) || { ...state, indicatorColor: color };
        }

        entries.push({
            group,
            state,
            color,
            name: state.subworkflowName || state.title || getGroupTitle(group),
        });
    }

    entries.sort((left, right) => {
        const timeDelta = (left.state.updatedAt || 0) - (right.state.updatedAt || 0);
        if (timeDelta) return timeDelta;
        return left.name.localeCompare(right.name);
    });
    return entries;
}

function syncSubworkflowIndicators(canvas = app.canvas) {
    const host = ensureSubworkflowIndicatorHost();
    if (!host) return;
    installSubworkflowIndicatorPositioning();

    if (!isEnabled()) {
        clearSubworkflowIndicators(true);
        return;
    }

    const graph = getActiveGraph(canvas);
    if (!graph) {
        clearSubworkflowIndicators(true);
        return;
    }

    const graphKey = getIndicatorGraphKey(graph);
    if (graphKey !== groupControlState.indicatorGraphKey) {
        clearSubworkflowIndicators();
    }
    groupControlState.indicatorGraph = graph;
    groupControlState.indicatorGraphKey = graphKey;
    groupControlState.indicatorPendingGraphKey = "";

    const entries = getSubworkflowIndicatorEntries(canvas, graph);
    host.replaceChildren();
    host.hidden = entries.length === 0;
    host.dataset.count = String(entries.length);
    host.dataset.graphKey = graphKey;
    if (!entries.length) return;

    for (const entry of entries) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "gg-subworkflow-dot";
        button.style.setProperty("--gg-subworkflow-color", entry.color);
        button.dataset.title = entry.name;
        button.title = entry.name;
        button.setAttribute("aria-label", `恢复子工作流：${entry.name}`);
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const activeGraph = getActiveGraph(app.canvas);
            if (!groupBelongsToGraph(entry.group, activeGraph)) {
                syncSubworkflowIndicators(app.canvas);
                return;
            }
            restoreGroupScaled(entry.group, app.canvas);
            syncSubworkflowIndicators(app.canvas);
        });
        host.append(button);
    }
    positionSubworkflowIndicators(host);
    requestAnimationFrame(() => positionSubworkflowIndicators(host));
}

function installSubworkflowIndicators() {
    ensureSubworkflowIndicatorHost();
    syncSubworkflowIndicators(app.canvas);
}

function canvasPointToGraph(canvas, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const ds = canvas?.ds;
    if (typeof ds?.convertCanvasToOffset === "function") {
        return ds.convertCanvasToOffset([x, y]);
    }

    const scale = getCanvasScale(canvas);
    const offset = ds?.offset || [0, 0];
    return [x / scale - (offset[0] || 0), y / scale - (offset[1] || 0)];
}

function eventToGraphCandidates(canvas, event) {
    normalizeCanvasEvent(canvas, event);

    const element = canvas?.canvas;
    const rect = element?.getBoundingClientRect?.();
    const pixelRatioX = rect?.width ? (element?.width || rect.width) / rect.width : 1;
    const pixelRatioY = rect?.height ? (element?.height || rect.height) / rect.height : 1;
    const candidates = [];
    const seen = new Set();

    const add = (mode, pos) => {
        if (!pos || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return;
        const key = `${mode}:${Math.round(pos[0] * 1000)}:${Math.round(pos[1] * 1000)}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ mode, pos });
    };

    if (Number.isFinite(event?.canvasX) && Number.isFinite(event?.canvasY)) {
        add("adjusted", [event.canvasX, event.canvasY]);
    }

    if (Number.isFinite(event?.graphX) && Number.isFinite(event?.graphY)) {
        add("graph", [event.graphX, event.graphY]);
    }

    if (rect && Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;
        add("client-css", canvasPointToGraph(canvas, localX, localY));
        add("client-backing", canvasPointToGraph(canvas, localX * pixelRatioX, localY * pixelRatioY));
    }

    if (Number.isFinite(event?.offsetX) && Number.isFinite(event?.offsetY)) {
        add("offset-css", canvasPointToGraph(canvas, event.offsetX, event.offsetY));
        add("offset-backing", canvasPointToGraph(canvas, event.offsetX * pixelRatioX, event.offsetY * pixelRatioY));
    }

    return candidates;
}

function normalizeCanvasEvent(canvas, event) {
    if (!canvas || !event || typeof canvas.adjustMouseEvent !== "function") return;

    try {
        canvas.adjustMouseEvent(event);
    } catch (_) {
        // Some synthetic events expose readonly fields; manual candidates below still cover them.
    }
}

function eventToGraphPos(canvas, event, preferredMode = null) {
    const candidates = eventToGraphCandidates(canvas, event);
    if (preferredMode) {
        const preferred = candidates.find((candidate) => candidate.mode === preferredMode);
        if (preferred) return preferred.pos;
    }
    return candidates[0]?.pos ?? null;
}

function resizeCursor(handle) {
    if (handle === "left" || handle === "right") return "ew-resize";
    if (handle === "top" || handle === "bottom") return "ns-resize";
    if (handle === "top-left" || handle === "bottom-right") return "nwse-resize";
    if (handle === "top-right" || handle === "bottom-left") return "nesw-resize";
    return "default";
}

function hitTestGraphGroup(canvas, event) {
    const graphCandidates = eventToGraphCandidates(canvas, event);
    const groups = getVisibleGraphGroups(canvas);
    if (!graphCandidates.length || !groups?.length) return null;

    for (const graphCandidate of graphCandidates) {
        const [mx, my] = graphCandidate.pos;
        for (let i = groups.length - 1; i >= 0; i--) {
            const group = groups[i];
            const rect = getGroupRect(group);
            if (!rect || rect.w <= 0 || rect.h <= 0) continue;
            if (mx >= rect.x && mx <= rect.x + rect.w && my >= rect.y && my <= rect.y + rect.h) {
                return { canvas, group, rect, graphPos: graphCandidate.pos, coordMode: graphCandidate.mode };
            }
        }
    }

    return null;
}

function hitTestGroupTitle(canvas, event) {
    const graphCandidates = eventToGraphCandidates(canvas, event).sort((left, right) => {
        // The browser CSS coordinate is the same coordinate space used by
        // LiteGraph's convertEventToCanvasOffset(). Prefer it over stale
        // canvasX values on zoomed/high-DPI pointer events.
        const priority = {
            "client-css": 0,
            graph: 1,
            adjusted: 2,
            "offset-css": 3,
            "client-backing": 4,
            "offset-backing": 5,
        };
        return (priority[left.mode] ?? 99) - (priority[right.mode] ?? 99);
    });
    const groups = getVisibleGraphGroups(canvas);
    if (!graphCandidates.length || !groups?.length) return null;

    const scale = getCanvasScale(canvas);
    const cornerThreshold = Math.max(12, NATIVE_CORNER_PX / scale);

    for (const graphCandidate of graphCandidates) {
        const [mx, my] = graphCandidate.pos;
        for (let i = groups.length - 1; i >= 0; i--) {
            const group = groups[i];
            if (!group || group.pinned || isGroupScaleHidden(group)) continue;

            const rect = getGroupRect(group);
            if (!rect || rect.w <= 0 || rect.h <= 0) continue;

            const metrics = getTitleMetrics(rect, scale);
            const inTitle = (
                mx >= rect.x
                && mx <= rect.x + rect.w
                && my >= rect.y
                && my <= rect.y + metrics.titleHeight
            );
            if (!inTitle) continue;

            // Let the custom buttons and native corner resize handles keep
            // their existing priority over title dragging.
            const titleButtons = [
                getGroupScaleRect(rect, metrics, scale),
                getGroupToggleRect(rect, metrics, scale),
            ];
            if (titleButtons.some((button) => (
                mx >= button.x && mx <= button.x + button.w
                && my >= button.y && my <= button.y + button.h
            ))) continue;

            const nearCorner = [
                [rect.x, rect.y],
                [rect.x + rect.w, rect.y],
            ].some(([x, y]) => Math.abs(mx - x) <= cornerThreshold && Math.abs(my - y) <= cornerThreshold);
            if (nearCorner) continue;

            return { canvas, group, rect, graphPos: graphCandidate.pos, coordMode: graphCandidate.mode };
        }
    }

    return null;
}

function hitTestGroupResizeHandle(canvas, event) {
    const graphCandidates = eventToGraphCandidates(canvas, event);
    const groups = getVisibleGraphGroups(canvas);
    if (!graphCandidates.length || !groups?.length) return null;

    const scale = getCanvasScale(canvas);
    const edgeThreshold = Math.max(4, RESIZE_EDGE_PX / scale);
    const cornerThreshold = Math.max(12, NATIVE_CORNER_PX / scale);
    const hitThreshold = Math.max(edgeThreshold, cornerThreshold);

    for (const graphCandidate of graphCandidates) {
        const [mx, my] = graphCandidate.pos;
        for (let i = groups.length - 1; i >= 0; i--) {
            const group = groups[i];
            if (group?.pinned) continue;
            if (isGroupScaleHidden(group)) continue;
            const rect = getGroupRect(group);
            if (!rect || rect.w <= 0 || rect.h <= 0) continue;

            const insideX = mx >= rect.x - hitThreshold && mx <= rect.x + rect.w + hitThreshold;
            const insideY = my >= rect.y - hitThreshold && my <= rect.y + rect.h + hitThreshold;
            if (!insideX || !insideY) continue;

            const metrics = getTitleMetrics(rect, scale);
            const titleButtons = [
                getGroupScaleRect(rect, metrics, scale),
                getGroupToggleRect(rect, metrics, scale),
            ];
            const overTitleButton = titleButtons.some((button) => (
                mx >= button.x && mx <= button.x + button.w && my >= button.y && my <= button.y + button.h
            ));
            if (overTitleButton) continue;

            const corners = [
                { handle: "top-left", x: rect.x, y: rect.y },
                { handle: "top-right", x: rect.x + rect.w, y: rect.y },
                { handle: "bottom-left", x: rect.x, y: rect.y + rect.h },
                { handle: "bottom-right", x: rect.x + rect.w, y: rect.y + rect.h },
            ];

            for (const corner of corners) {
                const inCorner = Math.abs(mx - corner.x) <= cornerThreshold && Math.abs(my - corner.y) <= cornerThreshold;
                if (inCorner) {
                    return {
                        canvas,
                        group,
                        handle: corner.handle,
                        graphPos: graphCandidate.pos,
                        coordMode: graphCandidate.mode,
                        rect,
                    };
                }
            }

            const candidates = [
                { handle: "top", distance: Math.abs(my - rect.y), valid: mx >= rect.x - edgeThreshold && mx <= rect.x + rect.w + edgeThreshold },
                { handle: "bottom", distance: Math.abs(my - (rect.y + rect.h)), valid: mx >= rect.x - edgeThreshold && mx <= rect.x + rect.w + edgeThreshold },
                { handle: "left", distance: Math.abs(mx - rect.x), valid: my >= rect.y - edgeThreshold && my <= rect.y + rect.h + edgeThreshold },
                { handle: "right", distance: Math.abs(mx - (rect.x + rect.w)), valid: my >= rect.y - edgeThreshold && my <= rect.y + rect.h + edgeThreshold },
            ].filter((candidate) => candidate.valid && candidate.distance <= edgeThreshold)
                .sort((a, b) => a.distance - b.distance);

            if (candidates.length) {
                return {
                    canvas,
                    group,
                    handle: candidates[0].handle,
                    graphPos: graphCandidate.pos,
                    coordMode: graphCandidate.mode,
                    rect,
                };
            }
        }
    }

    return null;
}

function hitTestGroupToggle(canvas, event) {
    const graphCandidates = eventToGraphCandidates(canvas, event);
    const groups = getVisibleGraphGroups(canvas);
    if (!graphCandidates.length || !groups?.length) return null;

    const scale = getCanvasScale(canvas);

    for (const graphCandidate of graphCandidates) {
        const [mx, my] = graphCandidate.pos;
        const hits = [];
        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            const rect = getGroupRect(group);
            if (!rect || rect.w <= 0 || rect.h <= 0) continue;
            if (isGroupScaleHidden(group)) continue;
            const metrics = getTitleMetrics(rect, scale);
            const button = getGroupToggleRect(rect, metrics, scale);
            if (mx >= button.x && mx <= button.x + button.w && my >= button.y && my <= button.y + button.h) {
                hits.push({ index: i, hit: { canvas, group, rect, button, graphPos: graphCandidate.pos, coordMode: graphCandidate.mode } });
            }
        }
        if (hits.length) {
            hits.sort((left, right) => rectArea(left.hit.rect) - rectArea(right.hit.rect) || right.index - left.index);
            return hits[0].hit;
        }
    }

    return null;
}

function hitTestSubworkflowProxy(canvas, event) {
    const graphCandidates = eventToGraphCandidates(canvas, event);
    const groups = getVisibleGraphGroups(canvas);
    if (!graphCandidates.length || !groups?.length) return null;

    for (const graphCandidate of graphCandidates) {
        const [mx, my] = graphCandidate.pos;
        for (let i = groups.length - 1; i >= 0; i--) {
            const group = groups[i];
            if (!isGroupScaleHidden(group)) continue;
            const rect = getGroupRect(group);
            if (!rect || rect.w <= 0 || rect.h <= 0) continue;
            const proxy = getSubworkflowProxyRect(rect);
            if (mx >= proxy.x && mx <= proxy.x + proxy.w && my >= proxy.y && my <= proxy.y + proxy.h) {
                return { canvas, group, rect, proxy, graphPos: graphCandidate.pos, coordMode: graphCandidate.mode };
            }
        }
    }

    return null;
}

function hitTestGroupScaleToggle(canvas, event) {
    const graphCandidates = eventToGraphCandidates(canvas, event);
    const groups = getVisibleGraphGroups(canvas);
    if (!graphCandidates.length || !groups?.length) return null;

    const scale = getCanvasScale(canvas);

    for (const graphCandidate of graphCandidates) {
        const [mx, my] = graphCandidate.pos;
        const hits = [];
        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            const rect = getGroupRect(group);
            if (!rect || rect.w <= 0 || rect.h <= 0) continue;
            if (isGroupScaleHidden(group)) continue;
            const metrics = getTitleMetrics(rect, scale);
            const button = getGroupScaleRect(rect, metrics, scale);
            if (mx >= button.x && mx <= button.x + button.w && my >= button.y && my <= button.y + button.h) {
                hits.push({ index: i, hit: { canvas, group, rect, button, graphPos: graphCandidate.pos, coordMode: graphCandidate.mode } });
            }
        }
        if (hits.length) {
            hits.sort((left, right) => rectArea(left.hit.rect) - rectArea(right.hit.rect) || right.index - left.index);
            return hits[0].hit;
        }
    }

    return null;
}

function resizeRectFromDrag(active, graphPos) {
    const dx = graphPos[0] - active.startMouse[0];
    const dy = graphPos[1] - active.startMouse[1];
    const next = { ...active.startRect };
    const handle = active.handle;

    if (handle === "left" || handle === "top-left" || handle === "bottom-left") {
        next.x = active.startRect.x + dx;
        next.w = active.startRect.w - dx;
        if (next.w < MIN_GROUP_WIDTH) {
            next.x = active.startRect.x + active.startRect.w - MIN_GROUP_WIDTH;
            next.w = MIN_GROUP_WIDTH;
        }
    }
    if (handle === "right" || handle === "top-right" || handle === "bottom-right") {
        next.w = Math.max(MIN_GROUP_WIDTH, active.startRect.w + dx);
    }
    if (handle === "top" || handle === "top-left" || handle === "top-right") {
        next.y = active.startRect.y + dy;
        next.h = active.startRect.h - dy;
        if (next.h < MIN_GROUP_HEIGHT) {
            next.y = active.startRect.y + active.startRect.h - MIN_GROUP_HEIGHT;
            next.h = MIN_GROUP_HEIGHT;
        }
    }
    if (handle === "bottom" || handle === "bottom-left" || handle === "bottom-right") {
        next.h = Math.max(MIN_GROUP_HEIGHT, active.startRect.h + dy);
    }

    return next;
}

function consumeEvent(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
}

function getCanvasEventWindow(canvas) {
    const doc = canvas?.canvas?.ownerDocument ?? document;
    return doc.defaultView || window;
}

function clearNativePointerAction(canvas) {
    const pointer = canvas?.pointer;

    canvas.dragging_canvas = false;
    canvas.dragging_rectangle = null;
    canvas.resizingGroup = null;
    canvas.selected_group_resizing = false;
    canvas.isDragging = false;

    if (!pointer) return;

    pointer.onClick = null;
    pointer.onDrag = null;
    pointer.onDragStart = null;
    pointer.onDragEnd = null;
    pointer.finally = null;
    pointer.resizeDirection = undefined;
    pointer.dragStarted = false;
    pointer.isDown = false;
    pointer.isDouble = false;
}

function stopGroupDragCapture() {
    const captureWindow = groupDragState.captureWindow;
    if (!captureWindow) return;

    if (groupDragState.windowMove) captureWindow.removeEventListener("mousemove", groupDragState.windowMove, true);
    if (groupDragState.windowUp) captureWindow.removeEventListener("mouseup", groupDragState.windowUp, true);
    if (groupDragState.windowPointerMove) captureWindow.removeEventListener("pointermove", groupDragState.windowPointerMove, true);
    if (groupDragState.windowPointerUp) captureWindow.removeEventListener("pointerup", groupDragState.windowPointerUp, true);
    if (groupDragState.windowPointerCancel) {
        captureWindow.removeEventListener("pointercancel", groupDragState.windowPointerCancel, true);
        captureWindow.removeEventListener("lostpointercapture", groupDragState.windowPointerCancel, true);
    }
    if (groupDragState.windowBlur) captureWindow.removeEventListener("blur", groupDragState.windowBlur, true);

    groupDragState.windowMove = null;
    groupDragState.windowUp = null;
    groupDragState.windowPointerMove = null;
    groupDragState.windowPointerUp = null;
    groupDragState.windowPointerCancel = null;
    groupDragState.windowBlur = null;
    groupDragState.captureWindow = null;
}

function startGroupDragCapture(canvas) {
    stopGroupDragCapture();

    const captureWindow = getCanvasEventWindow(canvas);
    groupDragState.captureWindow = captureWindow;
    groupDragState.windowMove = (event) => {
        if (groupDragState.active?.canvas === canvas) updateActiveGroupTitleDrag(canvas, event);
    };
    groupDragState.windowUp = (event) => {
        if (groupDragState.active?.canvas === canvas) finishActiveGroupTitleDrag(canvas, event);
    };
    groupDragState.windowPointerMove = (event) => {
        if (groupDragState.active?.canvas === canvas) updateActiveGroupTitleDrag(canvas, event);
    };
    groupDragState.windowPointerUp = (event) => {
        if (groupDragState.active?.canvas === canvas) finishActiveGroupTitleDrag(canvas, event);
    };
    groupDragState.windowPointerCancel = (event) => {
        if (groupDragState.active?.canvas === canvas) cancelActiveGroupTitleDrag(canvas, event);
    };
    groupDragState.windowBlur = () => cancelActiveGroupTitleDrag(canvas);

    captureWindow.addEventListener("mousemove", groupDragState.windowMove, true);
    captureWindow.addEventListener("mouseup", groupDragState.windowUp, true);
    captureWindow.addEventListener("pointermove", groupDragState.windowPointerMove, true);
    captureWindow.addEventListener("pointerup", groupDragState.windowPointerUp, true);
    captureWindow.addEventListener("pointercancel", groupDragState.windowPointerCancel, true);
    captureWindow.addEventListener("lostpointercapture", groupDragState.windowPointerCancel, true);
    captureWindow.addEventListener("blur", groupDragState.windowBlur, true);
}

function startGroupTitleDragFromEvent(canvas, event) {
    if (!isEnabled() || event?.button !== 0) return false;

    if (groupDragState.active?.canvas === canvas) {
        consumeEvent(event);
        return true;
    }

    const hit = hitTestGroupTitle(canvas, event);
    if (!hit?.group || hit.group.pinned) return false;

    try {
        hit.group.recomputeInsideNodes?.();
    } catch (_) {
        // The fallback movement path still works for older group objects.
    }

    const startRect = getGroupRect(hit.group) ?? hit.rect;
    const memberSnapshots = getGroupNodes(hit.group)
        .map((node) => ({ node, rect: getNodeRect(node) }))
        .filter((entry) => entry.rect);
    const childSnapshots = collectGroupsInGroup(hit.group, canvas)
        .map(({ candidate }) => ({ group: candidate, rect: getGroupRect(candidate) }))
        .filter((entry) => entry.rect);

    groupDragState.active = {
        canvas,
        group: hit.group,
        startMouse: hit.graphPos,
        lastMouse: hit.graphPos,
        startRect,
        memberSnapshots,
        childSnapshots,
        coordMode: hit.coordMode,
        pointerId: event?.pointerId,
        previousSelectedGroup: canvas.selected_group ?? null,
        previousSelected: !!hit.group.selected,
        previousPrivateSelected: "_selected" in hit.group ? !!hit.group._selected : false,
    };
    syncGroupInteractionMarker();

    clearNativePointerAction(canvas);
    canvas.selected_group = hit.group;
    try {
        canvas.selectItems?.([hit.group]);
    } catch (_) {
        hit.group.selected = true;
    }
    hit.group.selected = true;
    if ("_selected" in hit.group) hit.group._selected = true;

    if (canvas.canvas?.style) canvas.canvas.style.cursor = "grabbing";
    try {
        if (event?.pointerId != null) canvas.canvas?.setPointerCapture?.(event.pointerId);
    } catch (_) {
        // Window capture below covers browsers without pointer capture support.
    }
    startGroupDragCapture(canvas);
    syncOfficialGroupReplacementState(canvas);
    markCanvasDirty();
    consumeEvent(event);
    return true;
}

function updateActiveGroupTitleDrag(canvas, event) {
    const active = groupDragState.active;
    if (!isEnabled() || !active || active.canvas !== canvas) return false;

    const graphPos = eventToGraphPos(canvas, event, "client-css")
        ?? eventToGraphPos(canvas, event, active.coordMode);
    if (!graphPos) {
        consumeEvent(event);
        return true;
    }

    const totalDx = graphPos[0] - active.startMouse[0];
    const totalDy = graphPos[1] - active.startMouse[1];
    if (totalDx || totalDy) {
        const group = active.group;
        // Write the group target directly.  Calling group.move() here is
        // tempting, but its child handling differs between LiteGraph builds
        // (notably for zero-height nodes), which can leave one member behind.
        if (active.startRect) {
            setGroupRect(group, {
                ...active.startRect,
                x: active.startRect.x + totalDx,
                y: active.startRect.y + totalDy,
            });
        }

        // Always write the absolute target from the pre-move snapshots so no
        // member can receive a half or duplicated delta.
        for (const entry of active.memberSnapshots ?? []) {
            setNodeRect(entry.node, {
                x: entry.rect.x + totalDx,
                y: entry.rect.y + totalDy,
                w: entry.rect.w,
                h: entry.rect.h,
            });
        }
        for (const entry of active.childSnapshots ?? []) {
            setGroupRect(entry.group, {
                ...entry.rect,
                x: entry.rect.x + totalDx,
                y: entry.rect.y + totalDy,
            });
        }
        active.lastMouse = graphPos;
        markCanvasDirty();
    }

    if (canvas.canvas?.style) canvas.canvas.style.cursor = "grabbing";
    consumeEvent(event);
    return true;
}

function finishActiveGroupTitleDrag(canvas, event) {
    const active = groupDragState.active;
    if (!active || active.canvas !== canvas) return false;

    groupDragState.active = null;
    syncGroupInteractionMarker();
    stopGroupDragCapture();
    try {
        if (active.pointerId != null) canvas.canvas?.releasePointerCapture?.(active.pointerId);
    } catch (_) {
        // The pointer may already have been released by the browser.
    }
    if (canvas.canvas?.style) canvas.canvas.style.cursor = "";
    const finalRect = getGroupRect(active.group);
    if (finalRect && active.startRect) {
        const dx = finalRect.x - active.startRect.x;
        const dy = finalRect.y - active.startRect.y;
        for (const entry of active.memberSnapshots ?? []) {
            setNodeRect(entry.node, {
                x: entry.rect.x + dx,
                y: entry.rect.y + dy,
                w: entry.rect.w,
                h: entry.rect.h,
            });
        }
        for (const entry of active.childSnapshots ?? []) {
            setGroupRect(entry.group, {
                ...entry.rect,
                x: entry.rect.x + dx,
                y: entry.rect.y + dy,
            });
        }
    }
    active.group.recomputeInsideNodes?.();
    const graph = getGroupGraph(active.group, canvas);
    graph?.change?.();
    graph?.setDirtyCanvas?.(true, true);
    markCanvasDirty();
    consumeEvent(event);
    return true;
}

function cancelActiveGroupTitleDrag(canvas, event) {
    const active = groupDragState.active;
    if (!active || active.canvas !== canvas) return false;

    groupDragState.active = null;
    syncGroupInteractionMarker();
    stopGroupDragCapture();
    try {
        if (active.pointerId != null) canvas.canvas?.releasePointerCapture?.(active.pointerId);
    } catch (_) {
        // Ignore an already released pointer.
    }
    if (canvas.canvas?.style) canvas.canvas.style.cursor = "";
    if (canvas.selected_group === active.group) canvas.selected_group = active.previousSelectedGroup;
    active.group.selected = active.previousSelected;
    if ("_selected" in active.group) active.group._selected = active.previousPrivateSelected;
    consumeEvent(event);
    return true;
}

function selectionHasNode(canvas = app.canvas) {
    const selectedNodes = canvas?.selected_nodes;
    if (selectedNodes && typeof selectedNodes === "object") {
        for (const _key in selectedNodes) return true;
    }
    const items = canvas?.selectedItems;
    if (items instanceof Set) {
        for (const item of items) if (item && !isGraphGroupLike(item)) return true;
    }
    if (Array.isArray(canvas?.selected_items)) {
        for (const item of canvas.selected_items) if (item && !isGraphGroupLike(item)) return true;
    }
    return false;
}

function hasGroupReplacementTarget(canvas = app.canvas) {
    if (!isEnabled()) return false;
    // An in-progress group drag or resize is unambiguously a group gesture.
    if (isGraphGroupLike(resizeState.active?.group) || isGraphGroupLike(groupDragState.active?.group)) {
        return true;
    }
    // A selected node owns the official selection toolbox, so it must stay
    // visible even when a group is hovered or when the node lives inside a
    // GuliNodes group. The classic canvas renderer selects nodes on the
    // <canvas> element, so the DOM `.lg-node` cleanup below never fires for it;
    // without this guard the toolbox stays hidden after clicking such a node.
    if (selectionHasNode(canvas)) return false;
    return !!(
        (canvas?.selectedItems instanceof Set && [...canvas.selectedItems].some(isGraphGroupLike))
        || (Array.isArray(canvas?.selected_items) && canvas.selected_items.some(isGraphGroupLike))
        || isGraphGroupLike(resizeState.hover?.group)
    );
}

function syncOfficialGroupReplacementState(canvas = app.canvas) {
    const active = hasGroupReplacementTarget(canvas);
    try {
        const body = document.body;
        if (!body) return;
        const hasClass = body.classList.contains("gg-group-styler-force-groups");
        if (hasClass !== active) body.classList.toggle("gg-group-styler-force-groups", active);
    } catch (_) {
        // Body may not be ready during very early startup.
    }
}

function installGroupReplacementStyles() {
    if (document.getElementById(GROUP_REPLACEMENT_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = GROUP_REPLACEMENT_STYLE_ID;
    style.textContent = `
        body.gg-group-styler-force-groups .comfyui-selection-toolbox,
        body.gg-group-styler-force-groups .selection-toolbox,
        body.gg-group-styler-force-groups [class*="SelectionToolbox"],
        body.gg-group-styler-force-groups [class*="selection-toolbox"],
        body.gg-group-styler-force-groups [data-testid*="selection-toolbox"],
        body.gg-group-styler-force-groups [data-test*="selection-toolbox"] {
            display: none !important;
            visibility: hidden !important;
            pointer-events: none !important;
        }
    `;
    document.head.appendChild(style);
    if (!document[GROUP_REPLACEMENT_EVENT_FLAG]) {
        document.addEventListener("pointerdown", (event) => {
            // Vue Nodes 2.0 renders nodes in a DOM layer above the canvas.
            // Leaving a group selected/hovered must not keep the official node
            // toolbox hidden after the pointer enters that layer.
            if (event.target?.closest?.(".lg-node, [data-node-id]")) {
                document.body?.classList.remove("gg-group-styler-force-groups");
            }
        }, true);
        document[GROUP_REPLACEMENT_EVENT_FLAG] = true;
    }
}

function startGroupResizeFromEvent(canvas, event) {
    if (!isEnabled() || event?.button !== 0) return false;

    if (resizeState.active?.canvas === canvas) {
        consumeEvent(event);
        return true;
    }

    const hit = hitTestGroupResizeHandle(canvas, event);
    if (!hit) return false;

    resizeState.active = {
        canvas,
        group: hit.group,
        handle: hit.handle,
        startMouse: hit.graphPos,
        coordMode: hit.coordMode,
        startRect: hit.rect,
        pointerId: event?.pointerId,
        wasSelected: !!(hit.group.selected || hit.group._selected),
    };
    resizeState.hover = hit;
    syncGroupInteractionMarker();

    clearNativePointerAction(canvas);
    canvas.selected_group = hit.group;
    hit.group.selected = true;

    if (canvas.canvas?.style) canvas.canvas.style.cursor = resizeCursor(hit.handle);
    try {
        if (event?.pointerId != null) canvas.canvas?.setPointerCapture?.(event.pointerId);
    } catch (_) {
        // Pointer capture is best-effort; window capture listeners below keep the drag working.
    }

    startResizeCapture(canvas);
    markCanvasDirty();
    consumeEvent(event);
    return true;
}

function restoreGroupResizeSelection(active) {
    if (!active) return;
    if (active.canvas?.selected_group === active.group) {
        active.canvas.selected_group = null;
    }
    if (!active.wasSelected) {
        active.group.selected = false;
        if ("_selected" in active.group) active.group._selected = false;
    }
    try {
        if (active.pointerId != null) active.canvas?.canvas?.releasePointerCapture?.(active.pointerId);
    } catch (_) {
        // Pointer capture may already be released by the browser.
    }
}

function updateActiveResize(canvas, event) {
    if (!isEnabled() || resizeState.active?.canvas !== canvas) return false;

    const graphPos = eventToGraphPos(canvas, event, resizeState.active.coordMode);
    if (graphPos) {
        clearNativePointerAction(canvas);
        setGroupRect(resizeState.active.group, resizeRectFromDrag(resizeState.active, graphPos));
        if (canvas.canvas?.style) canvas.canvas.style.cursor = resizeCursor(resizeState.active.handle);
        markCanvasDirty();
    }

    consumeEvent(event);
    return true;
}

function stopResizeCapture() {
    const captureWindow = resizeState.captureWindow || window;
    if (resizeState.windowMove) {
        captureWindow.removeEventListener("mousemove", resizeState.windowMove, true);
        resizeState.windowMove = null;
    }
    if (resizeState.windowUp) {
        captureWindow.removeEventListener("mouseup", resizeState.windowUp, true);
        resizeState.windowUp = null;
    }
    if (resizeState.windowPointerMove) {
        captureWindow.removeEventListener("pointermove", resizeState.windowPointerMove, true);
        resizeState.windowPointerMove = null;
    }
    if (resizeState.windowPointerUp) {
        captureWindow.removeEventListener("pointerup", resizeState.windowPointerUp, true);
        resizeState.windowPointerUp = null;
    }
    if (resizeState.windowPointerCancel) {
        captureWindow.removeEventListener("pointercancel", resizeState.windowPointerCancel, true);
        captureWindow.removeEventListener("lostpointercapture", resizeState.windowPointerCancel, true);
        resizeState.windowPointerCancel = null;
    }
    if (resizeState.windowBlur) {
        captureWindow.removeEventListener("blur", resizeState.windowBlur, true);
        resizeState.windowBlur = null;
    }
    resizeState.captureWindow = null;
}

function finishActiveResize(canvas, event) {
    if (resizeState.active?.canvas !== canvas) return false;

    const active = resizeState.active;
    resizeState.active = null;
    resizeState.hover = null;
    syncGroupInteractionMarker();
    stopResizeCapture();

    if (canvas.canvas?.style) canvas.canvas.style.cursor = "";
    clearNativePointerAction(canvas);
    restoreGroupResizeSelection(active);
    active.group.recomputeInsideNodes?.();
    getGroupGraph(active.group, canvas)?.change?.();
    markCanvasDirty();
    consumeEvent(event);
    return true;
}

function startResizeCapture(canvas) {
    stopResizeCapture();

    const captureWindow = getCanvasEventWindow(canvas);
    resizeState.captureWindow = captureWindow;

    resizeState.windowMove = (event) => {
        if (resizeState.active?.canvas === canvas) {
            updateActiveResize(canvas, event);
        }
    };
    resizeState.windowUp = (event) => {
        if (resizeState.active?.canvas === canvas) {
            finishActiveResize(canvas, event);
        }
    };
    resizeState.windowPointerMove = (event) => {
        if (resizeState.active?.canvas === canvas) {
            updateActiveResize(canvas, event);
        }
    };
    resizeState.windowPointerUp = (event) => {
        if (resizeState.active?.canvas === canvas) {
            finishActiveResize(canvas, event);
        }
    };
    resizeState.windowPointerCancel = (event) => {
        if (resizeState.active?.canvas === canvas) {
            finishActiveResize(canvas, event);
        }
    };
    resizeState.windowBlur = () => {
        cancelActiveResize(canvas);
    };

    captureWindow.addEventListener("mousemove", resizeState.windowMove, true);
    captureWindow.addEventListener("mouseup", resizeState.windowUp, true);
    captureWindow.addEventListener("pointermove", resizeState.windowPointerMove, true);
    captureWindow.addEventListener("pointerup", resizeState.windowPointerUp, true);
    captureWindow.addEventListener("pointercancel", resizeState.windowPointerCancel, true);
    captureWindow.addEventListener("lostpointercapture", resizeState.windowPointerCancel, true);
    captureWindow.addEventListener("blur", resizeState.windowBlur, true);
}

function cancelActiveResize(canvas) {
    if (!resizeState.active || resizeState.active.canvas !== canvas) return;
    const active = resizeState.active;
    resizeState.active = null;
    resizeState.hover = null;
    syncGroupInteractionMarker();
    stopResizeCapture();
    restoreGroupResizeSelection(active);
    if (canvas?.canvas?.style?.cursor?.includes("resize")) {
        canvas.canvas.style.cursor = "";
    }
}

function moveHiddenScaleLayout(group, state, dx, dy, canvas = app.canvas) {
    if (!group || !state || (!dx && !dy)) return state;
    const graph = getGroupGraph(group, canvas);
    const nodes = (state.nodes ?? []).map((snapshot) => {
        const normalized = normalizeScaleSnapshot(snapshot);
        if (!normalized) return null;
        const next = {
            ...normalized,
            pos: [normalized.pos[0] + dx, normalized.pos[1] + dy],
        };
        const node = findNodeById(graph, normalized.id);
        if (node && state.preserveLayout !== false) {
            setNodeRect(node, {
                x: next.pos[0],
                y: next.pos[1],
                w: next.size[0],
                h: next.size[1],
            });
        }
        return next;
    }).filter(Boolean);

    const usedGroups = new Set();
    const groups = (state.groups ?? []).map((snapshot) => {
        const normalized = normalizeScaleGroupSnapshot(snapshot);
        if (!normalized) return null;
        const next = {
            ...normalized,
            pos: [normalized.pos[0] + dx, normalized.pos[1] + dy],
        };
        const childGroup = findGroupForScaleSnapshot(group, normalized, canvas, usedGroups);
        if (childGroup) {
            usedGroups.add(childGroup);
            setGroupRect(childGroup, {
                x: next.pos[0],
                y: next.pos[1],
                w: next.size[0],
                h: next.size[1],
            });
        }
        return next;
    }).filter(Boolean);

    const originalGroupRect = normalizeScaleRect(state.groupRect);
    return {
        ...state,
        nodes,
        groups,
        groupRect: originalGroupRect
            ? { ...originalGroupRect, x: originalGroupRect.x + dx, y: originalGroupRect.y + dy }
            : originalGroupRect,
        updatedAt: Date.now(),
    };
}

function startSubworkflowProxyDragFromEvent(canvas, event) {
    if (!isEnabled() || event?.button !== 0) return false;

    if (groupControlState.proxyDrag?.canvas === canvas) {
        consumeEvent(event);
        return true;
    }

    const hit = hitTestSubworkflowProxy(canvas, event);
    if (!hit) return false;
    if (Number(event?.detail) >= 2) {
        return editSubworkflowProxyTitleFromEvent(canvas, event);
    }

    groupControlState.proxyDrag = {
        canvas,
        group: hit.group,
        startMouse: hit.graphPos,
        lastMouse: hit.graphPos,
        coordMode: hit.coordMode,
        startRect: hit.rect,
        pointerId: event?.pointerId,
        moved: false,
    };
    syncGroupInteractionMarker();
    groupControlState.hoverProxy = hit;

    clearNativePointerAction(canvas);
    if (canvas.canvas?.style) canvas.canvas.style.cursor = "grab";
    try {
        if (event?.pointerId != null) canvas.canvas?.setPointerCapture?.(event.pointerId);
    } catch (_) {
        // Window capture below keeps dragging stable across browser variants.
    }

    startSubworkflowProxyCapture(canvas);
    markCanvasDirty();
    consumeEvent(event);
    return true;
}

function updateActiveSubworkflowProxyDrag(canvas, event) {
    const active = groupControlState.proxyDrag;
    if (!isEnabled() || active?.canvas !== canvas) return false;

    const graphPos = eventToGraphPos(canvas, event, active.coordMode);
    if (graphPos) {
        clearNativePointerAction(canvas);
        const dx = graphPos[0] - active.startMouse[0];
        const dy = graphPos[1] - active.startMouse[1];
        const stepDx = graphPos[0] - (active.lastMouse?.[0] ?? active.startMouse[0]);
        const stepDy = graphPos[1] - (active.lastMouse?.[1] ?? active.startMouse[1]);
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) active.moved = true;
        const nextRect = {
            ...active.startRect,
            x: active.startRect.x + dx,
            y: active.startRect.y + dy,
        };
        setGroupRect(active.group, nextRect);
        const state = readGroupScaleState(active.group);
        const movedState = moveHiddenScaleLayout(active.group, state, stepDx, stepDy, canvas);
        if (movedState) {
            writeGroupScaleState(active.group, {
                ...movedState,
                hidden: true,
                phase: movedState.phase === "hiding" ? "hiding" : "hidden",
                compactGroupRect: nextRect,
            });
        }
        active.lastMouse = graphPos;
        if (canvas.canvas?.style) canvas.canvas.style.cursor = active.moved ? "grabbing" : "grab";
        markCanvasDirty();
    }

    consumeEvent(event);
    return true;
}

function stopSubworkflowProxyCapture() {
    const captureWindow = groupControlState.proxyCaptureWindow || window;
    if (groupControlState.proxyWindowMove) {
        captureWindow.removeEventListener("mousemove", groupControlState.proxyWindowMove, true);
        groupControlState.proxyWindowMove = null;
    }
    if (groupControlState.proxyWindowUp) {
        captureWindow.removeEventListener("mouseup", groupControlState.proxyWindowUp, true);
        groupControlState.proxyWindowUp = null;
    }
    if (groupControlState.proxyWindowPointerMove) {
        captureWindow.removeEventListener("pointermove", groupControlState.proxyWindowPointerMove, true);
        groupControlState.proxyWindowPointerMove = null;
    }
    if (groupControlState.proxyWindowPointerUp) {
        captureWindow.removeEventListener("pointerup", groupControlState.proxyWindowPointerUp, true);
        groupControlState.proxyWindowPointerUp = null;
    }
    if (groupControlState.proxyWindowPointerCancel) {
        captureWindow.removeEventListener("pointercancel", groupControlState.proxyWindowPointerCancel, true);
        captureWindow.removeEventListener("lostpointercapture", groupControlState.proxyWindowPointerCancel, true);
        groupControlState.proxyWindowPointerCancel = null;
    }
    if (groupControlState.proxyWindowBlur) {
        captureWindow.removeEventListener("blur", groupControlState.proxyWindowBlur, true);
        groupControlState.proxyWindowBlur = null;
    }
    groupControlState.proxyCaptureWindow = null;
}

function finishActiveSubworkflowProxyDrag(canvas, event) {
    const active = groupControlState.proxyDrag;
    if (active?.canvas !== canvas) return false;

    groupControlState.proxyDrag = null;
    syncGroupInteractionMarker();
    stopSubworkflowProxyCapture();
    if (canvas.canvas?.style) canvas.canvas.style.cursor = "";
    clearNativePointerAction(canvas);
    try {
        if (active.pointerId != null) canvas?.canvas?.releasePointerCapture?.(active.pointerId);
    } catch (_) {
        // Pointer capture may already be released.
    }

    getGroupGraph(active.group, canvas)?.change?.();
    markCanvasDirty();
    consumeEvent(event);
    return true;
}

function cancelActiveSubworkflowProxyDrag(canvas) {
    const active = groupControlState.proxyDrag;
    if (!active || active.canvas !== canvas) return;
    groupControlState.proxyDrag = null;
    syncGroupInteractionMarker();
    stopSubworkflowProxyCapture();
    if (canvas?.canvas?.style?.cursor === "grab" || canvas?.canvas?.style?.cursor === "grabbing") {
        canvas.canvas.style.cursor = "";
    }
    try {
        if (active.pointerId != null) canvas?.canvas?.releasePointerCapture?.(active.pointerId);
    } catch (_) {
        // Ignore pointer release failures.
    }
}

function startSubworkflowProxyCapture(canvas) {
    stopSubworkflowProxyCapture();

    const captureWindow = getCanvasEventWindow(canvas);
    groupControlState.proxyCaptureWindow = captureWindow;
    groupControlState.proxyWindowMove = (event) => {
        if (groupControlState.proxyDrag?.canvas === canvas) {
            updateActiveSubworkflowProxyDrag(canvas, event);
        }
    };
    groupControlState.proxyWindowUp = (event) => {
        if (groupControlState.proxyDrag?.canvas === canvas) {
            finishActiveSubworkflowProxyDrag(canvas, event);
        }
    };
    groupControlState.proxyWindowPointerMove = (event) => {
        if (groupControlState.proxyDrag?.canvas === canvas) {
            updateActiveSubworkflowProxyDrag(canvas, event);
        }
    };
    groupControlState.proxyWindowPointerUp = (event) => {
        if (groupControlState.proxyDrag?.canvas === canvas) {
            finishActiveSubworkflowProxyDrag(canvas, event);
        }
    };
    groupControlState.proxyWindowPointerCancel = (event) => {
        if (groupControlState.proxyDrag?.canvas === canvas) {
            finishActiveSubworkflowProxyDrag(canvas, event);
        }
    };
    groupControlState.proxyWindowBlur = () => {
        cancelActiveSubworkflowProxyDrag(canvas);
    };

    captureWindow.addEventListener("mousemove", groupControlState.proxyWindowMove, true);
    captureWindow.addEventListener("mouseup", groupControlState.proxyWindowUp, true);
    captureWindow.addEventListener("pointermove", groupControlState.proxyWindowPointerMove, true);
    captureWindow.addEventListener("pointerup", groupControlState.proxyWindowPointerUp, true);
    captureWindow.addEventListener("pointercancel", groupControlState.proxyWindowPointerCancel, true);
    captureWindow.addEventListener("lostpointercapture", groupControlState.proxyWindowPointerCancel, true);
    captureWindow.addEventListener("blur", groupControlState.proxyWindowBlur, true);
}

function editSubworkflowProxyTitleFromEvent(canvas, event) {
    if (!isEnabled()) return false;
    const hit = hitTestSubworkflowProxy(canvas, event);
    if (!hit) return false;

    const state = readGroupScaleState(hit.group);
    if (!state) return false;
    const now = Date.now();
    if (groupControlState.lastProxyEditGroup === hit.group && now - groupControlState.lastProxyEditAt < 500) {
        consumeEvent(event);
        return true;
    }
    groupControlState.lastProxyEditAt = now;
    groupControlState.lastProxyEditGroup = hit.group;

    const currentTitle = state.subworkflowName || state.title || getGroupTitle(hit.group);
    const nextTitle = window.prompt("\u91cd\u547d\u540d\u5b50\u5de5\u4f5c\u6d41", currentTitle);
    if (nextTitle != null) {
        const title = nextTitle.trim() || currentTitle;
        writeGroupScaleState(hit.group, {
            ...state,
            title,
            subworkflowName: title,
            updatedAt: Date.now(),
        });
        touchScaleGraph(hit.group, canvas);
    }
    consumeEvent(event);
    return true;
}

function toggleGroupFromHit(hit) {
    const { bypassed } = getGroupBypassState(hit.group, hit.canvas);
    setGroupBypass(hit.group, !bypassed, hit.canvas);
    groupControlState.hoverToggle = hit;
    groupControlState.lastToggle = {
        group: hit.group,
        time: Date.now(),
        x: hit.graphPos?.[0] ?? 0,
        y: hit.graphPos?.[1] ?? 0,
    };
    if (hit.canvas.canvas?.style) hit.canvas.canvas.style.cursor = "pointer";
    markCanvasDirty();
}

function toggleGroupScaleFromHit(hit) {
    if (!hit?.group) return;
    toggleGroupScale(hit.group, hit.canvas);
    groupControlState.hoverScale = hit;
    groupControlState.lastScaleToggle = {
        group: hit.group,
        time: Date.now(),
        x: hit.graphPos?.[0] ?? 0,
        y: hit.graphPos?.[1] ?? 0,
    };
    if (hit.canvas.canvas?.style) hit.canvas.canvas.style.cursor = "pointer";
    syncTopScaleButton();
    markCanvasDirty();
}

function isDuplicateToggle(hit) {
    const last = groupControlState.lastToggle;
    if (!last || last.group !== hit.group) return false;
    const now = Date.now();
    const dx = Math.abs((hit.graphPos?.[0] ?? 0) - last.x);
    const dy = Math.abs((hit.graphPos?.[1] ?? 0) - last.y);
    return now - last.time < 220 && dx < 2 && dy < 2;
}

function isDuplicateScaleToggle(hit) {
    const last = groupControlState.lastScaleToggle;
    if (!last || last.group !== hit.group) return false;
    const now = Date.now();
    const dx = Math.abs((hit.graphPos?.[0] ?? 0) - last.x);
    const dy = Math.abs((hit.graphPos?.[1] ?? 0) - last.y);
    return now - last.time < 220 && dx < 2 && dy < 2;
}

function handleGroupToggleEvent(canvas, event) {
    if (!isEnabled() || event?.button !== 0) return false;

    const hit = hitTestGroupToggle(canvas, event);
    if (!hit) return false;

    if (!isDuplicateToggle(hit)) {
        toggleGroupFromHit(hit);
    }
    consumeEvent(event);
    return true;
}

function handleGroupScaleEvent(canvas, event) {
    if (!isEnabled() || event?.button !== 0) return false;

    const hit = hitTestGroupScaleToggle(canvas, event);
    if (!hit) return false;

    if (!isDuplicateScaleToggle(hit)) {
        toggleGroupScaleFromHit(hit);
    }
    consumeEvent(event);
    return true;
}

function isNativeCanvasInteraction(canvas) {
    const hasState = (value) => value != null && value !== false && typeof value !== "function";
    return canvas?.dragging_canvas === true
        || hasState(canvas?.node_dragged)
        || hasState(canvas?.moving_node)
        || hasState(canvas?.resizing_node)
        || canvas?.last_mouse_dragging === true
        || canvas?.pointer_is_down === true
        || canvas?.pointer?.isDown === true
        || canvas?.pointer?.dragStarted === true
        || canvas?.__ggLinkStylePointerGesture === true
        || globalThis.__ggGroupStylerDraggingCanvas === canvas;
}

function scheduleGroupHoverUpdate(canvas, event) {
    if (!canvas || !isEnabled() || isNativeCanvasInteraction(canvas)) return false;

    groupControlState.hoverCanvas = canvas;
    groupControlState.hoverEvent = event;
    if (groupControlState.hoverFrame != null) return true;

    const request = globalThis.requestAnimationFrame
        || ((callback) => globalThis.setTimeout(callback, 0));
    groupControlState.hoverFrame = request(() => {
        groupControlState.hoverFrame = null;
        const targetCanvas = groupControlState.hoverCanvas;
        const targetEvent = groupControlState.hoverEvent;
        groupControlState.hoverCanvas = null;
        groupControlState.hoverEvent = null;
        if (targetCanvas && targetEvent && !isNativeCanvasInteraction(targetCanvas)) {
            updateGroupHoverFromEvent(targetCanvas, targetEvent);
        }
    });
    return true;
}

function updateGroupHoverFromEvent(canvas, event) {
    if (!isEnabled() || resizeState.active?.canvas === canvas || groupControlState.proxyDrag?.canvas === canvas) {
        if (groupControlState.nativeGroupHover) {
            groupControlState.nativeGroupHover = null;
            syncOfficialGroupReplacementState(canvas);
        }
        return false;
    }

    // Normal node/canvas dragging is owned by LiteGraph. Hover hit testing for
    // group controls adds no useful feedback during that gesture and competes
    // with the native redraw path, so leave the existing hover state untouched.
    if (isNativeCanvasInteraction(canvas)) {
        return false;
    }

    const previousNativeHover = groupControlState.nativeGroupHover;
    groupControlState.nativeGroupHover = hitTestGraphGroup(canvas, event);
    if (groupControlState.nativeGroupHover !== previousNativeHover) {
        syncOfficialGroupReplacementState(canvas);
    }

    const hit = hitTestGroupResizeHandle(canvas, event);
    const previous = resizeState.hover;
    resizeState.hover = hit;
    if (hit) {
        clearScaleHover(canvas);
        clearToggleHover(canvas);
        if (canvas.canvas?.style) canvas.canvas.style.cursor = resizeCursor(hit.handle);
    } else if (previous?.canvas === canvas && canvas.canvas?.style?.cursor?.includes("resize")) {
        canvas.canvas.style.cursor = "";
    }
    if (hit?.group !== previous?.group || hit?.handle !== previous?.handle) {
        canvas.setDirty?.(true, true);
        canvas.setDirtyCanvas?.(true, true);
    }

    if (hit) return true;

    const proxyHit = hitTestSubworkflowProxy(canvas, event);
    if (proxyHit) {
        const previousProxy = groupControlState.hoverProxy;
        groupControlState.hoverProxy = proxyHit;
        clearScaleHover(canvas);
        clearToggleHover(canvas);
        if (canvas.canvas?.style) canvas.canvas.style.cursor = "grab";
        if (proxyHit.group !== previousProxy?.group) {
            canvas.setDirty?.(true, true);
            canvas.setDirtyCanvas?.(true, true);
        }
        return true;
    }

    const scaleHit = hitTestGroupScaleToggle(canvas, event);
    if (scaleHit) {
        const previousScale = groupControlState.hoverScale;
        groupControlState.hoverScale = scaleHit;
        clearProxyHover(canvas);
        clearToggleHover(canvas);
        if (canvas.canvas?.style) canvas.canvas.style.cursor = "pointer";
        if (scaleHit.group !== previousScale?.group) {
            canvas.setDirty?.(true, true);
            canvas.setDirtyCanvas?.(true, true);
            syncTopScaleButton();
        }
        return true;
    }

    const toggleHit = hitTestGroupToggle(canvas, event);
    if (toggleHit) {
        const previousToggle = groupControlState.hoverToggle;
        groupControlState.hoverToggle = toggleHit;
        clearProxyHover(canvas);
        clearScaleHover(canvas);
        if (canvas.canvas?.style) canvas.canvas.style.cursor = "pointer";
        if (toggleHit.group !== previousToggle?.group) {
            canvas.setDirty?.(true, true);
            canvas.setDirtyCanvas?.(true, true);
            syncTopScaleButton();
        }
        return true;
    }

    clearProxyHover(canvas);
    clearScaleHover(canvas);
    clearToggleHover(canvas);
    return false;
}

function clearResizeHover(canvas) {
    if (!resizeState.hover) return;
    resizeState.hover = null;
    if (canvas?.canvas?.style?.cursor?.includes("resize")) {
        canvas.canvas.style.cursor = "";
    }
    canvas?.setDirty?.(true, true);
    canvas?.setDirtyCanvas?.(true, true);
}

function clearToggleHover(canvas) {
    if (!groupControlState.hoverToggle) return;
    groupControlState.hoverToggle = null;
    if (canvas?.canvas?.style?.cursor === "pointer") {
        canvas.canvas.style.cursor = "";
    }
    canvas?.setDirty?.(true, true);
    canvas?.setDirtyCanvas?.(true, true);
}

function clearProxyHover(canvas) {
    if (!groupControlState.hoverProxy) return;
    groupControlState.hoverProxy = null;
    if (canvas?.canvas?.style?.cursor === "grab" || canvas?.canvas?.style?.cursor === "grabbing") {
        canvas.canvas.style.cursor = "";
    }
    canvas?.setDirty?.(true, true);
    canvas?.setDirtyCanvas?.(true, true);
}

function clearScaleHover(canvas) {
    if (!groupControlState.hoverScale) return;
    groupControlState.hoverScale = null;
    if (canvas?.canvas?.style?.cursor === "pointer") {
        canvas.canvas.style.cursor = "";
    }
    canvas?.setDirty?.(true, true);
    canvas?.setDirtyCanvas?.(true, true);
    syncTopScaleButton();
}

function clearNativeGroupHover(canvas) {
    if (!groupControlState.nativeGroupHover) return;
    groupControlState.nativeGroupHover = null;
    syncOfficialGroupReplacementState(canvas);
}

function roundedRect(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, w, h, radius);
        return;
    }

    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

function topRoundedRect(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h));
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

function drawTitle(ctx, group, rect, metrics) {
    const maxWidth = Math.max(0, rect.x + rect.w - metrics.textX - metrics.textRightPadding);
    if (maxWidth <= metrics.fontSize * 0.8) return;

    const title = String(group?.title || "Group");

    ctx.save();
    ctx.beginPath();
    ctx.rect(metrics.textX, rect.y, maxWidth, metrics.titleHeight);
    ctx.clip();
    ctx.font = `500 ${metrics.fontSize}px Inter, Arial, sans-serif`;
    ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(title, metrics.textX, rect.y + metrics.titleHeight / 2);
    ctx.restore();
}

function drawResizeEdgeHint(ctx, group, rect, accent, scale) {
    const hit = resizeState.active?.group === group ? resizeState.active : resizeState.hover?.group === group ? resizeState.hover : null;
    if (!hit) return;

    const lineWidth = Math.max(2, 3 / scale);
    const inset = lineWidth / 2;

    ctx.save();
    ctx.strokeStyle = rgba(accent, resizeState.active?.group === group ? 0.95 : 0.72);
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    if (hit.handle === "top") {
        ctx.moveTo(rect.x + 10, rect.y + inset);
        ctx.lineTo(rect.x + rect.w - 10, rect.y + inset);
    } else if (hit.handle === "bottom") {
        ctx.moveTo(rect.x + 10, rect.y + rect.h - inset);
        ctx.lineTo(rect.x + rect.w - 10, rect.y + rect.h - inset);
    } else if (hit.handle === "left") {
        ctx.moveTo(rect.x + inset, rect.y + 10);
        ctx.lineTo(rect.x + inset, rect.y + rect.h - 10);
    } else if (hit.handle === "right") {
        ctx.moveTo(rect.x + rect.w - inset, rect.y + 10);
        ctx.lineTo(rect.x + rect.w - inset, rect.y + rect.h - 10);
    }
    ctx.stroke();
    ctx.restore();
}

function drawCornerHandle(ctx, rect, handle, accent, scale, active) {
    const lineWidth = Math.max(1, 1.5 / scale);
    const gap = Math.max(4, 4 / scale);
    const size = Math.max(11, 12 / scale);
    const alpha = active ? 0.9 : 0.48;
    let x = rect.x;
    let y = rect.y;

    if (handle.includes("right")) x += rect.w;
    if (handle.includes("bottom")) y += rect.h;

    ctx.save();
    ctx.strokeStyle = rgba(accent, alpha);
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    if (handle === "bottom-right") {
        ctx.moveTo(x - size, y - gap);
        ctx.lineTo(x - gap, y - size);
        ctx.moveTo(x - size * 0.62, y - gap);
        ctx.lineTo(x - gap, y - size * 0.62);
    } else if (handle === "bottom-left") {
        ctx.moveTo(x + size, y - gap);
        ctx.lineTo(x + gap, y - size);
        ctx.moveTo(x + size * 0.62, y - gap);
        ctx.lineTo(x + gap, y - size * 0.62);
    } else if (handle === "top-right") {
        ctx.moveTo(x - size, y + gap);
        ctx.lineTo(x - gap, y + size);
        ctx.moveTo(x - size * 0.62, y + gap);
        ctx.lineTo(x - gap, y + size * 0.62);
    } else if (handle === "top-left") {
        ctx.moveTo(x + size, y + gap);
        ctx.lineTo(x + gap, y + size);
        ctx.moveTo(x + size * 0.62, y + gap);
        ctx.lineTo(x + gap, y + size * 0.62);
    }
    ctx.stroke();
    ctx.restore();
}

function drawResizeCornerHandles(ctx, group, rect, accent, scale) {
    const activeHandle = resizeState.active?.group === group ? resizeState.active?.handle : null;
    const hoverHandle = resizeState.hover?.group === group ? resizeState.hover?.handle : null;
    const handles = ["top-left", "top-right", "bottom-left", "bottom-right"];

    for (const handle of handles) {
        drawCornerHandle(ctx, rect, handle, accent, scale, handle === activeHandle || handle === hoverHandle);
    }
}

function drawToggleIcon(ctx, button, bypassed, mixed, scale) {
    const cx = button.x + button.w / 2;
    const cy = button.y + button.h / 2;
    const eyeW = 9 / scale;
    const eyeH = 5 / scale;
    const pupil = 1.6 / scale;

    ctx.save();
    ctx.strokeStyle = bypassed ? "rgba(255, 255, 255, 0.72)" : "rgba(255, 255, 255, 0.9)";
    ctx.fillStyle = bypassed ? "rgba(255, 255, 255, 0.55)" : "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = Math.max(1, 1.4 / scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(cx - eyeW / 2, cy);
    ctx.quadraticCurveTo(cx, cy - eyeH, cx + eyeW / 2, cy);
    ctx.quadraticCurveTo(cx, cy + eyeH, cx - eyeW / 2, cy);
    ctx.stroke();

    if (!bypassed && !mixed) {
        ctx.beginPath();
        ctx.arc(cx, cy, pupil, 0, Math.PI * 2);
        ctx.fill();
    }

    if (bypassed) {
        ctx.beginPath();
        ctx.moveTo(button.x + button.w * 0.28, button.y + button.h * 0.72);
        ctx.lineTo(button.x + button.w * 0.72, button.y + button.h * 0.28);
        ctx.stroke();
    } else if (mixed) {
        ctx.beginPath();
        ctx.moveTo(button.x + button.w * 0.32, cy);
        ctx.lineTo(button.x + button.w * 0.68, cy);
        ctx.stroke();
    }
    ctx.restore();
}

function drawScaleIcon(ctx, button, hidden, scale) {
    const cx = button.x + button.w / 2;
    const cy = button.y + button.h / 2;
    const box = 7.2 / scale;
    const arrow = 3.2 / scale;
    const inset = 3.7 / scale;

    ctx.save();
    ctx.strokeStyle = hidden ? "rgba(255, 255, 255, 0.86)" : "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = Math.max(1, 1.35 / scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.beginPath();
    roundedRect(ctx, cx - box / 2, cy - box / 2, box, box, 1.5 / scale);
    ctx.stroke();

    ctx.beginPath();
    if (hidden) {
        ctx.moveTo(cx - 1 / scale, cy - 1 / scale);
        ctx.lineTo(button.x + inset, button.y + inset);
        ctx.moveTo(button.x + inset, button.y + inset);
        ctx.lineTo(button.x + inset + arrow, button.y + inset);
        ctx.moveTo(button.x + inset, button.y + inset);
        ctx.lineTo(button.x + inset, button.y + inset + arrow);

        ctx.moveTo(cx + 1 / scale, cy + 1 / scale);
        ctx.lineTo(button.x + button.w - inset, button.y + button.h - inset);
        ctx.moveTo(button.x + button.w - inset, button.y + button.h - inset);
        ctx.lineTo(button.x + button.w - inset - arrow, button.y + button.h - inset);
        ctx.moveTo(button.x + button.w - inset, button.y + button.h - inset);
        ctx.lineTo(button.x + button.w - inset, button.y + button.h - inset - arrow);
    } else {
        ctx.moveTo(button.x + inset, button.y + inset);
        ctx.lineTo(cx - 1 / scale, cy - 1 / scale);
        ctx.moveTo(button.x + inset, button.y + inset);
        ctx.lineTo(button.x + inset + arrow, button.y + inset);
        ctx.moveTo(button.x + inset, button.y + inset);
        ctx.lineTo(button.x + inset, button.y + inset + arrow);

        ctx.moveTo(button.x + button.w - inset, button.y + button.h - inset);
        ctx.lineTo(cx + 1 / scale, cy + 1 / scale);
        ctx.moveTo(button.x + button.w - inset, button.y + button.h - inset);
        ctx.lineTo(button.x + button.w - inset - arrow, button.y + button.h - inset);
        ctx.moveTo(button.x + button.w - inset, button.y + button.h - inset);
        ctx.lineTo(button.x + button.w - inset, button.y + button.h - inset - arrow);
    }
    ctx.stroke();
    ctx.restore();
}

function drawGroupScaleButton(ctx, group, rect, metrics, accent, scale) {
    const button = getGroupScaleRect(rect, metrics, scale);
    const state = readGroupScaleState(group);
    const hidden = isGroupScaleHidden(group);
    const hover = groupControlState.hoverScale?.group === group;
    const base = hidden ? "#075985" : mix(accent, "#1e3a8a", 0.48);
    const alpha = hover ? 0.95 : hidden ? 0.86 : 0.72;

    ctx.save();
    ctx.fillStyle = rgba(base, alpha);
    ctx.strokeStyle = hidden ? "rgba(56, 189, 248, 0.82)" : "rgba(255, 255, 255, 0.26)";
    ctx.lineWidth = Math.max(1, 1 / scale);
    ctx.beginPath();
    roundedRect(ctx, button.x, button.y, button.w, button.h, 5 / scale);
    ctx.fill();
    ctx.stroke();
    drawScaleIcon(ctx, button, hidden || state?.phase === "restoring", scale);
    ctx.restore();
}

function drawGroupToggleButton(ctx, group, rect, metrics, accent, scale, canvas) {
    const button = getGroupToggleRect(rect, metrics, scale);
    const state = getGroupBypassState(group, canvas);
    const hover = groupControlState.hoverToggle?.group === group;
    const base = state.bypassed ? "#7f1d1d" : state.mixed ? "#92400e" : mix(accent, "#064e3b", 0.44);
    const alpha = hover ? 0.94 : 0.78;

    ctx.save();
    ctx.fillStyle = rgba(base, state.hasNodes ? alpha : 0.42);
    ctx.strokeStyle = state.bypassed ? "rgba(248, 113, 113, 0.78)" : "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = Math.max(1, 1 / scale);
    ctx.beginPath();
    roundedRect(ctx, button.x, button.y, button.w, button.h, 5 / scale);
    ctx.fill();
    ctx.stroke();
    drawToggleIcon(ctx, button, state.bypassed, state.mixed, scale);
    ctx.restore();
}

function drawSubworkflowProxyIcon(ctx, x, y, size) {
    const pad = size * 0.2;
    ctx.save();
    ctx.fillStyle = "#3b82f6";
    ctx.beginPath();
    roundedRect(ctx, x, y, size, size, size * 0.22);
    ctx.fill();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.96)";
    ctx.lineWidth = Math.max(1.4, size * 0.095);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const leftX = x + pad * 1.1;
    const midX = x + size * 0.5;
    const rightX = x + size - pad * 1.1;
    const topY = y + pad * 1.15;
    const midY = y + size * 0.5;
    const bottomY = y + size - pad * 1.15;
    ctx.beginPath();
    ctx.arc(leftX, topY, size * 0.12, 0, Math.PI * 2);
    ctx.arc(rightX, topY, size * 0.12, 0, Math.PI * 2);
    ctx.arc(midX, bottomY, size * 0.12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(leftX, topY + size * 0.12);
    ctx.lineTo(leftX, midY);
    ctx.lineTo(midX, midY);
    ctx.lineTo(midX, bottomY - size * 0.12);
    ctx.moveTo(rightX, topY + size * 0.12);
    ctx.lineTo(rightX, midY);
    ctx.lineTo(midX, midY);
    ctx.stroke();
    ctx.restore();
}

function getSubworkflowProxyRect(rect) {
    const height = Math.min(38, Math.max(34, rect.h - 10));
    return {
        x: rect.x,
        y: rect.y + Math.max(0, (rect.h - height) / 2),
        w: Math.max(124, rect.w),
        h: height,
    };
}

function getSubworkflowProxyId(state) {
    const firstId = normalizeScaleSnapshot(state?.nodes?.[0])?.id;
    if (firstId) return firstId;
    const timestamp = Math.abs(Number(state?.updatedAt) || 0);
    return String(timestamp % 1000 || 1);
}

function drawSubworkflowProxy(ctx, group, rect, state, accent) {
    const proxy = getSubworkflowProxyRect(rect);
    const title = state?.subworkflowName || state?.title || getGroupTitle(group) || "New Subgraph";
    const radius = 8;
    const iconSize = Math.min(26, Math.max(22, proxy.h - 12));
    const iconX = proxy.x + 7;
    const iconY = proxy.y + (proxy.h - iconSize) / 2;
    const textX = iconX + iconSize + 7;
    const maxTextWidth = Math.max(12, proxy.x + proxy.w - textX - 12);
    const chipText = `#${getSubworkflowProxyId(state)} \ud83d\udc31`;
    const chipW = Math.min(64, Math.max(42, chipText.length * 7 + 12));
    const chipH = 24;
    const chipX = proxy.x + proxy.w - chipW - 4;
    const chipY = proxy.y - chipH - 4;

    ctx.save();
    ctx.shadowColor = "rgba(15, 23, 42, 0.2)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = "rgba(255, 255, 255, 0.98)";
    ctx.strokeStyle = "rgba(148, 163, 184, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    roundedRect(ctx, proxy.x, proxy.y, proxy.w, proxy.h, radius);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.stroke();

    drawSubworkflowProxyIcon(ctx, iconX, iconY, iconSize);

    ctx.beginPath();
    ctx.rect(textX, proxy.y, maxTextWidth, proxy.h);
    ctx.clip();
    ctx.font = "15px Inter, Arial, sans-serif";
    ctx.fillStyle = "#2f343d";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(title, textX, proxy.y + proxy.h / 2 + 0.5);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = rgba(state?.indicatorColor || accent || "#22c55e", 0.95);
    ctx.beginPath();
    ctx.arc(proxy.x - 5, proxy.y + proxy.h / 2, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 1.25;
    ctx.stroke();

    ctx.shadowColor = "rgba(15, 23, 42, 0.14)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = "rgba(255, 255, 255, 0.98)";
    ctx.strokeStyle = "rgba(203, 213, 225, 0.72)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    roundedRect(ctx, chipX, chipY, chipW, chipH, 6);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.stroke();
    ctx.font = "12px Inter, Arial, sans-serif";
    ctx.fillStyle = "#1f2937";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(chipText, chipX + chipW / 2, chipY + chipH / 2 + 0.5);
    ctx.restore();
}

function drawStyledGroups(ctx, canvas) {
    noticeSubworkflowIndicatorGraph(canvas);
    const groups = getVisibleGraphGroups(canvas);
    if (!groups?.length) return;

    const scale = getCanvasScale(canvas);
    const lineWidth = Math.max(0.75, 1 / scale);

    ctx.save();

    for (const group of groups) {
        const bounds = getGroupBounds(group);
        if (!bounds) continue;

        const [x, y, w, h] = bounds;
        if (w <= 2 || h <= 2) continue;

        const accent = getAccentColor(group);
        const surface = mix(accent, "#111827", 0.72);
        const header = mix(accent, "#020617", 0.62);
        const selected = group?._selected || group?.selected;
        const rect = { x, y, w, h };
        const titleMetrics = getTitleMetrics(rect, scale);
        const scaleState = readGroupScaleState(group);

        if (scaleState) {
            drawSubworkflowProxy(ctx, group, rect, scaleState, accent);
            continue;
        }

        ctx.fillStyle = rgba(surface, 0.34);
        ctx.beginPath();
        roundedRect(ctx, x, y, w, h, titleMetrics.radius);
        ctx.fill();

        ctx.fillStyle = rgba(header, 0.9);
        ctx.beginPath();
        topRoundedRect(ctx, x, y, w, titleMetrics.titleHeight, titleMetrics.radius);
        ctx.fill();

        ctx.strokeStyle = rgba(accent, selected ? 0.82 : 0.44);
        ctx.lineWidth = selected ? lineWidth * 1.5 : lineWidth;
        ctx.beginPath();
        roundedRect(ctx, x, y, w, h, titleMetrics.radius);
        ctx.stroke();

        ctx.strokeStyle = rgba(accent, 0.24);
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.moveTo(x + lineWidth, y + titleMetrics.titleHeight);
        ctx.lineTo(x + w - lineWidth, y + titleMetrics.titleHeight);
        ctx.stroke();

        ctx.fillStyle = rgba(accent, 0.95);
        ctx.beginPath();
        ctx.arc(titleMetrics.dotX, titleMetrics.dotY, titleMetrics.dotRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = "rgba(255, 255, 255, 0.42)";
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.arc(titleMetrics.dotX, titleMetrics.dotY, titleMetrics.dotRadius, 0, Math.PI * 2);
        ctx.stroke();

        if (!scaleState) {
            drawTitle(ctx, group, rect, titleMetrics);
        }
        drawGroupScaleButton(ctx, group, rect, titleMetrics, accent, scale);
        drawGroupToggleButton(ctx, group, rect, titleMetrics, accent, scale, canvas);
        drawResizeCornerHandles(ctx, group, rect, accent, scale);
        drawResizeEdgeHint(ctx, group, rect, accent, scale);
    }

    ctx.restore();
}

function installGroupResizeInteractions(proto) {
    if (!proto) return false;
    if (
        proto.processMouseDown?.[GROUP_INTERACTION_PATCH_FLAG]
        && proto.processMouseMove?.[GROUP_INTERACTION_PATCH_FLAG]
        && proto.processMouseUp?.[GROUP_INTERACTION_PATCH_FLAG]
    ) {
        return true;
    }

    const originalMouseDown = proto.processMouseDown?.[GROUP_INTERACTION_ORIGINAL_KEY] || proto.processMouseDown;
    const originalMouseMove = proto.processMouseMove?.[GROUP_INTERACTION_ORIGINAL_KEY] || proto.processMouseMove;
    const originalMouseUp = proto.processMouseUp?.[GROUP_INTERACTION_ORIGINAL_KEY] || proto.processMouseUp;

    const wrappedMouseDown = function(event, ...args) {
        if (isEnabled() && event?.button === 0) {
            if (startSubworkflowProxyDragFromEvent(this, event)) {
                return true;
            }

            if (startGroupResizeFromEvent(this, event)) {
                return true;
            }

            if (handleGroupScaleEvent(this, event)) {
                return true;
            }

            if (handleGroupToggleEvent(this, event)) {
                return true;
            }

            if (startGroupTitleDragFromEvent(this, event)) {
                return true;
            }
        }

        const result = originalMouseDown?.call(this, event, ...args);
        syncTopScaleButton();
        syncOfficialGroupReplacementState(this);
        return result;
    };
    wrappedMouseDown[GROUP_INTERACTION_PATCH_FLAG] = true;
    wrappedMouseDown[GROUP_INTERACTION_ORIGINAL_KEY] = originalMouseDown;

    const wrappedMouseMove = function(event, ...args) {
        if (updateActiveSubworkflowProxyDrag(this, event)) {
            return true;
        }

        if (updateActiveResize(this, event)) {
            return true;
        }

        if (updateActiveGroupTitleDrag(this, event)) {
            return true;
        }

        const result = originalMouseMove?.call(this, event, ...args);

        if (!isEnabled()) {
            clearResizeHover(this);
            clearNativeGroupHover(this);
            clearScaleHover(this);
            clearToggleHover(this);
            return result;
        }

        scheduleGroupHoverUpdate(this, event);

        return result;
    };
    wrappedMouseMove[GROUP_INTERACTION_PATCH_FLAG] = true;
    wrappedMouseMove[GROUP_INTERACTION_ORIGINAL_KEY] = originalMouseMove;

    const wrappedMouseUp = function(event, ...args) {
        if (finishActiveSubworkflowProxyDrag(this, event)) {
            return true;
        }

        if (finishActiveResize(this, event)) {
            return true;
        }

        if (finishActiveGroupTitleDrag(this, event)) {
            return true;
        }

        const result = originalMouseUp?.call(this, event, ...args);
        syncTopScaleButton();
        syncOfficialGroupReplacementState(this);
        return result;
    };
    wrappedMouseUp[GROUP_INTERACTION_PATCH_FLAG] = true;
    wrappedMouseUp[GROUP_INTERACTION_ORIGINAL_KEY] = originalMouseUp;

    proto.processMouseDown = wrappedMouseDown;
    proto.processMouseMove = wrappedMouseMove;
    proto.processMouseUp = wrappedMouseUp;
    return true;
}

function isCanvasEventTarget(element, event) {
    if (!element || !event) return false;
    if (event.target === element) return true;
    const path = event.composedPath?.();
    return Array.isArray(path) && path.includes(element);
}

function installCanvasPointerCapture(canvas = app.canvas) {
    const element = canvas?.canvas;
    if (!element || element[CANVAS_CAPTURE_FLAG]) return false;
    const captureWindow = getCanvasEventWindow(canvas);

    const handlePointerDown = (event) => {
        if (!isCanvasEventTarget(element, event)) return;
        if (startSubworkflowProxyDragFromEvent(canvas, event)) return;
        if (startGroupResizeFromEvent(canvas, event)) return;
        if (handleGroupScaleEvent(canvas, event)) return;
        if (handleGroupToggleEvent(canvas, event)) return;
        if (startGroupTitleDragFromEvent(canvas, event)) return;
    };

    const onPointerDown = (event) => {
        handlePointerDown(event);
    };
    const onMouseDown = (event) => {
        handlePointerDown(event);
    };
    const onPointerMove = (event) => {
        if (updateActiveGroupTitleDrag(canvas, event)) return;
        if (isCanvasEventTarget(element, event)) scheduleGroupHoverUpdate(canvas, event);
    };
    const onMouseMove = (event) => {
        if (updateActiveGroupTitleDrag(canvas, event)) return;
        if (isCanvasEventTarget(element, event)) scheduleGroupHoverUpdate(canvas, event);
    };
    const onDoubleClick = (event) => {
        if (isCanvasEventTarget(element, event)) editSubworkflowProxyTitleFromEvent(canvas, event);
    };
    const onPointerLeave = () => {
        groupControlState.hoverCanvas = null;
        groupControlState.hoverEvent = null;
        clearResizeHover(canvas);
        clearNativeGroupHover(canvas);
        clearProxyHover(canvas);
        clearScaleHover(canvas);
        clearToggleHover(canvas);
    };

    const nativePointerDown = canvas._mousedown_callback;
    if (nativePointerDown) {
        try {
            element.removeEventListener("pointerdown", nativePointerDown, true);
        } catch (_) {
            // Listener may be absent on older or already-patched builds.
        }
    }

    captureWindow.addEventListener("pointerdown", onPointerDown, true);
    captureWindow.addEventListener("mousedown", onMouseDown, true);
    element.addEventListener("pointerdown", onPointerDown, true);
    element.addEventListener("mousedown", onMouseDown, true);
    if (nativePointerDown) {
        try {
            element.addEventListener("pointerdown", nativePointerDown, true);
        } catch (_) {
            // Keep our custom capture path even if native listener rebinding fails.
        }
    }
    element.addEventListener("pointermove", onPointerMove, false);
    // Pointer events cover mouse input in supported browsers. Keeping a second
    // mousemove listener makes every physical move perform the hover pipeline
    // twice; retain it only for older builds without PointerEvent.
    if (typeof globalThis.PointerEvent === "undefined") {
        element.addEventListener("mousemove", onMouseMove, false);
    }
    element.addEventListener("dblclick", onDoubleClick, true);
    element.addEventListener("pointerout", onPointerLeave, false);
    element.addEventListener("mouseleave", onPointerLeave, false);
    element[CANVAS_CAPTURE_FLAG] = true;
    return true;
}

function installCanvasPointerCaptureWhenReady() {
    if (installCanvasPointerCapture(app.canvas)) return;

    let attempts = 0;
    const timer = window.setInterval(() => {
        attempts += 1;
        if (installCanvasPointerCapture(app.canvas) || attempts >= 20) {
            window.clearInterval(timer);
        }
    }, 250);
}

function isArrayLikeNumber(v) {
    return v != null
        && typeof v === "object"
        && typeof v.length === "number"
        && v.length >= 2
        && typeof v[0] === "number"
        && typeof v[1] === "number";
}

function findDrawNodeArg(args) {
    return args.find((arg) => arg && typeof arg === "object" && ("mode" in arg) && isArrayLikeNumber(arg.pos) && isArrayLikeNumber(arg.size));
}

function hasHiddenScaleNodes(graph) {
    return getGraphNodes(graph).some(isGroupScaleHiddenNode);
}

function withHiddenNodesFiltered(graph, callback) {
    if (!graph || !hasHiddenScaleNodes(graph)) return callback();

    const originalNodes = graph.nodes;
    const originalPrivateNodes = graph._nodes;
    const originalGetNodeById = graph.getNodeById;
    const hadOwnNodes = Object.prototype.hasOwnProperty.call(graph, "nodes");
    const hadOwnPrivateNodes = Object.prototype.hasOwnProperty.call(graph, "_nodes");
    const hadOwnGetNodeById = Object.prototype.hasOwnProperty.call(graph, "getNodeById");
    const sourceNodes = getGraphNodes(graph);
    const visibleNodes = sourceNodes.filter((node) => !isGroupScaleHiddenNode(node));
    let assignedNodes = false;
    let assignedPrivateNodes = false;

    try {
        try {
            graph.nodes = visibleNodes;
            assignedNodes = true;
        } catch (_) {
            // Some graph builds expose nodes as a readonly getter.
        }
        try {
            graph._nodes = visibleNodes;
            assignedPrivateNodes = true;
        } catch (_) {
            // Some graph builds do not use _nodes.
        }
        try {
            graph.getNodeById = function(id) {
                const node = originalGetNodeById?.call(this, id)
                    ?? sourceNodes.find((candidate) => String(candidate?.id) === String(id));
                return isGroupScaleHiddenNode(node) ? null : node;
            };
        } catch (_) {
            // The nodes array filtering still covers most draw paths.
        }

        return callback();
    } finally {
        if (assignedNodes) {
            try {
                if (hadOwnNodes) {
                    graph.nodes = originalNodes;
                } else {
                    delete graph.nodes;
                }
            } catch (_) {
                // Ignore readonly graph fields.
            }
        }
        if (assignedPrivateNodes) {
            try {
                if (hadOwnPrivateNodes) {
                    graph._nodes = originalPrivateNodes;
                } else {
                    delete graph._nodes;
                }
            } catch (_) {
                // Ignore readonly graph fields.
            }
        }
        try {
            if (hadOwnGetNodeById) {
                graph.getNodeById = originalGetNodeById;
            } else {
                delete graph.getNodeById;
            }
        } catch (_) {
            // Ignore readonly graph methods.
        }
    }
}

function wrapHiddenNodeDrawMethod(target, methodName) {
    const original = target?.[methodName];
    if (typeof original !== "function") return false;
    if (original[HIDDEN_NODE_DRAW_PATCH_FLAG]) return true;

    const wrapped = function(...args) {
        const node = findDrawNodeArg(args);
        if (isGroupScaleHiddenNode(node)) return;
        return original.apply(this, args);
    };
    wrapped[HIDDEN_NODE_DRAW_PATCH_FLAG] = true;
    wrapped.__ggGroupStylerNodeDrawOriginal = original;
    target[methodName] = wrapped;
    return true;
}

function wrapHiddenCanvasDrawMethod(target, methodName) {
    const original = target?.[methodName];
    if (typeof original !== "function") return false;
    if (original[HIDDEN_CANVAS_DRAW_PATCH_FLAG]) return true;

    const wrapped = function(...args) {
        const graph = this?.graph ?? app.canvas?.graph ?? app.graph;
        if (!hasHiddenScaleNodes(graph)) {
            return original.apply(this, args);
        }
        return withHiddenNodesFiltered(graph, () => original.apply(this, args));
    };
    wrapped[HIDDEN_CANVAS_DRAW_PATCH_FLAG] = true;
    wrapped.__ggGroupStylerCanvasDrawOriginal = original;
    target[methodName] = wrapped;
    return true;
}

function installHiddenNodePatches() {
    globalThis.__ggGroupStylerIsNodeScaleHidden = isGroupScaleHiddenNode;

    const CanvasClass = globalThis.LGraphCanvas;
    const canvasProto = CanvasClass?.prototype;
    const nodeDrawMethods = [
        "drawNode",
        "drawNodeShape",
        "drawNodeWidgets",
        "drawNodeCollapsed",
        "drawNodeTitle",
        "drawNodeInputs",
        "drawNodeOutputs",
    ];
    const canvasDrawMethods = ["draw", "drawBackCanvas", "drawFrontCanvas", "drawNodes"];

    for (const target of [canvasProto, app.canvas]) {
        for (const methodName of nodeDrawMethods) {
            wrapHiddenNodeDrawMethod(target, methodName);
        }
        for (const methodName of canvasDrawMethods) {
            wrapHiddenCanvasDrawMethod(target, methodName);
        }
    }

    // Patch computeVisibleNodes to exclude hidden nodes at the culling stage.
    // This prevents hidden nodes from entering _visible_node_ids, which cascades
    // to both canvas draw (drawFrontCanvas loop) and DOM layer (isNodeVisible gate).
    if (canvasProto && !canvasProto[HIDDEN_COMPUTE_VISIBLE_PATCH_FLAG] && typeof canvasProto.computeVisibleNodes === "function") {
        const originalComputeVisibleNodes = canvasProto.computeVisibleNodes;
        canvasProto.computeVisibleNodes = function(nodes, out) {
            const result = originalComputeVisibleNodes.call(this, nodes, out);
            if (!result || !Array.isArray(result)) return result;
            // Filter out scale-hidden nodes from the visible set
            for (let i = result.length - 1; i >= 0; i--) {
                if (isGroupScaleHiddenNode(result[i])) {
                    result.splice(i, 1);
                }
            }
            return result;
        };
        canvasProto[HIDDEN_COMPUTE_VISIBLE_PATCH_FLAG] = true;
    }

    const GraphClass = globalThis.LGraph ?? app.graph?.constructor;
    const graphProto = GraphClass?.prototype;
    if (graphProto && !graphProto[HIDDEN_NODE_HIT_PATCH_FLAG] && typeof graphProto.getNodeOnPos === "function") {
        const originalGetNodeOnPos = graphProto.getNodeOnPos;
        graphProto.getNodeOnPos = function(...args) {
            if (Array.isArray(args[2])) {
                args[2] = args[2].filter((node) => !isGroupScaleHiddenNode(node));
            }
            return withHiddenNodesFiltered(this, () => {
                const node = originalGetNodeOnPos.apply(this, args);
                return isGroupScaleHiddenNode(node) ? null : node;
            });
        };
        graphProto[HIDDEN_NODE_HIT_PATCH_FLAG] = true;
    }
}

function installHiddenNodePatchesWhenReady() {
    installHiddenNodePatches();
    const canvasReady = !!globalThis.LGraphCanvas?.prototype && !!app.canvas;
    if (!canvasReady) {
        let attempts = 0;
        const tick = () => {
            attempts += 1;
            installHiddenNodePatches();
            if (attempts < 80) {
                setTimeout(tick, 150);
            }
        };
        setTimeout(tick, 150);
    }
}

function installHiddenConnectionsPatch(canvas = app.canvas) {
    if (!canvas || typeof canvas.drawConnections !== "function") return false;
    if (hasHiddenConnectionsPatch(canvas.drawConnections)) return true;

    const originalDrawConnections = canvas.drawConnections;
    const wrappedDrawConnections = function(ctx, ...args) {
        const graph = this?.graph ?? canvas.graph ?? app.graph;
        // Native LiteGraph redraw is already the cheapest path while a
        // pointer gesture is active. Avoid mutating graph node arrays during
        // every pan/move event just to filter hidden group nodes.
        if (isNativeCanvasInteraction(this) || !hasHiddenScaleNodes(graph)) {
            return originalDrawConnections.call(this, ctx, ...args);
        }
        return withHiddenNodesFiltered(graph, () => originalDrawConnections.call(this, ctx, ...args));
    };

    wrappedDrawConnections[HIDDEN_CONNECTIONS_PATCH_FLAG] = true;
    wrappedDrawConnections.__ggGroupStylerConnectionOriginal = originalDrawConnections;
    if (originalDrawConnections.__ggLinkStyleWrapper) {
        wrappedDrawConnections.__ggLinkStyleWrapper = true;
        wrappedDrawConnections.__ggLinkStyleOriginal = originalDrawConnections.__ggLinkStyleOriginal;
    }
    canvas.drawConnections = wrappedDrawConnections;
    return true;
}

function hasHiddenConnectionsPatch(drawConnections) {
    const visited = new Set();
    let current = drawConnections;
    while (typeof current === "function" && !visited.has(current)) {
        if (current[HIDDEN_CONNECTIONS_PATCH_FLAG]) return true;
        visited.add(current);
        current = current.__ggGroupStylerConnectionOriginal || current.__ggLinkStyleOriginal;
    }
    return false;
}

function installHiddenConnectionsPatchWhenReady() {
    let attempts = 0;
    const tick = () => {
        attempts += 1;
        if (installHiddenConnectionsPatch(app.canvas) || attempts >= 80) return;
        setTimeout(tick, 150);
    };
    tick();
}

function hydrateScaleHiddenGroups(canvas = app.canvas) {
    const graph = getActiveGraph(canvas);
    if (!graph) return false;

    let found = false;
    let changed = recoverLegacyCompactGroups(canvas);
    for (const group of getGraphGroups(graph)) {
        const savedState = readGroupScaleState(group);
        const expiredState = savedState && isScaleStateExpired(savedState)
            ? savedState
            : (!savedState ? readCachedGroupScaleState(group, canvas, { expired: true }) : null);
        if (expiredState?.hidden) {
            found = true;
            changed = restoreExpiredScaleState(group, expiredState, canvas) || changed;
            continue;
        }

        const state = savedState ?? readCachedGroupScaleState(group, canvas);
        if (!state?.hidden) continue;
        found = true;
        changed = applyHiddenScaleState(group, state, canvas) || changed;
    }

    if (found) {
        markCanvasDirty();
        syncTopScaleButton();
        syncSubworkflowIndicators(canvas);
    }
    return found && changed;
}

function hydrateScaleHiddenGroupsWhenReady() {
    if (hydrateScaleHiddenGroups(app.canvas)) return;
    if (groupControlState.hydrateTimer != null) return;

    let attempts = 0;
    groupControlState.hydrateTimer = window.setInterval(() => {
        attempts += 1;
        if (hydrateScaleHiddenGroups(app.canvas) || attempts >= 80) {
            window.clearInterval(groupControlState.hydrateTimer);
            groupControlState.hydrateTimer = null;
        }
    }, 250);
}

function scheduleHydrateScaleHiddenGroups() {
    requestAnimationFrame(() => hydrateScaleHiddenGroupsWhenReady());
}

function patchGroupDrawMethod(proto) {
    if (!proto || typeof proto.drawGroups !== "function") return false;
    if (proto.drawGroups[GROUP_DRAW_PATCH_FLAG]) return true;

    const originalDrawGroups = proto.drawGroups[GROUP_DRAW_ORIGINAL_KEY] || proto.drawGroups;
    const wrappedDrawGroups = function(canvas, ctx) {
        // Native gestures still go through drawGroups. Keep the custom
        // renderer in that redraw path so panning never falls back to the
        // unstyled LiteGraph group appearance.
        if (!isEnabled()) {
            resizeState.hover = null;
            clearNativeGroupHover(this);
            clearProxyHover(this);
            clearScaleHover(this);
            clearToggleHover(this);
            clearSubworkflowIndicators(true);
            cancelActiveSubworkflowProxyDrag(this);
            cancelActiveResize(this);
            return originalDrawGroups?.call(this, canvas, ctx);
        }

        try {
            drawStyledGroups(ctx, this);
        } catch (error) {
            console.warn("[GGGroupStyler] Falling back to native group drawing:", error);
            return originalDrawGroups?.call(this, canvas, ctx);
        }
    };
    wrappedDrawGroups[GROUP_DRAW_PATCH_FLAG] = true;
    wrappedDrawGroups[GROUP_DRAW_ORIGINAL_KEY] = originalDrawGroups;
    proto.drawGroups = wrappedDrawGroups;
    return true;
}

function installGroupStylerWatchdog(proto) {
    if (groupControlState.drawWatchdogTimer != null || typeof window === "undefined") return;
    groupControlState.drawWatchdogTimer = window.setInterval(() => {
        if (!isEnabled()) return;
        patchGroupDrawMethod(proto);
        installGroupResizeInteractions(proto);
        installGroupSelectionHook(app.canvas);
    }, 1000);
}

function installGroupSelectionHook(canvas = app.canvas) {
    if (!canvas || canvas[GROUP_SELECTION_HOOK_FLAG] || typeof canvas.onSelectionChange !== "function") return;
    const original = canvas.onSelectionChange;
    canvas.onSelectionChange = function (...args) {
        const result = original.apply(this, args);
        syncTopScaleButton();
        return result;
    };
    canvas[GROUP_SELECTION_HOOK_FLAG] = true;
}

function installGroupStyler() {
    const CanvasClass = globalThis.LGraphCanvas;
    const proto = CanvasClass?.prototype;
    if (!proto) return;

    patchGroupDrawMethod(proto);
    installGroupStylerWatchdog(proto);
    installGroupResizeInteractions(proto);
    installGroupSelectionHook(app.canvas);
    proto[INSTALL_FLAG] = true;
}

function getScaleTargetGroup(canvas = app.canvas) {
    const graph = getActiveGraph(canvas);
    const groups = new Set(getGraphGroups(graph));
    const selectedItems = canvas?.selected_items ?? canvas?.selectedItems;
    const selectedGroups = (selectedItems instanceof Set || Array.isArray(selectedItems))
        ? [...selectedItems].filter((item) => isGraphGroupLike(item))
        : [];
    const candidates = [
        canvas?.selected_group,
        ...selectedGroups,
        groupControlState.hoverScale?.group,
        groupControlState.hoverToggle?.group,
        resizeState.hover?.group,
        groupControlState.lastScaleToggle?.group,
        groupControlState.lastToggle?.group,
    ];

    for (const group of candidates) {
        if (group && (!groups.size || groups.has(group))) return group;
    }
    return null;
}

function createTopButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "comfyui-button gg-ui-top-button gg-group-styler-btn";
    button.innerHTML = ggIcon("groupStyle", 18);
    button.addEventListener("click", async () => {
        await writeSetting(SETTINGS_ID, !isEnabled());
        syncTopButton(button);
        markCanvasDirty();
    });
    syncTopButton(button);
    return button;
}

function createTopScaleButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "comfyui-button gg-ui-top-button gg-group-styler-btn gg-group-scale-btn";
    button.innerHTML = ggIcon("fit", 18);
    button.addEventListener("click", () => {
        const hiddenGroups = getRestorableScaleGroups(app.canvas);
        if (hiddenGroups.length) {
            restoreAllScaledGroups(app.canvas);
            syncTopScaleButton(button);
            markCanvasDirty();
            return;
        }

        const target = getScaleTargetGroup(app.canvas);
        if (!target || !isEnabled()) {
            syncTopScaleButton(button);
            return;
        }
        toggleGroupScale(target, app.canvas);
        syncTopScaleButton(button);
        markCanvasDirty();
    });
    groupControlState.topScaleButton = button;
    syncTopScaleButton(button);
    return button;
}

function syncTopButton(button) {
    const enabled = isEnabled();
    const title = enabled ? "关闭分组样式" : "开启分组样式";
    button.classList.toggle("active", enabled);
    button.title = title;
    button.setAttribute("aria-label", title);
}

function syncTopScaleButton(button = groupControlState.topScaleButton) {
    if (!button) return;
    const enabled = isEnabled();
    const target = enabled ? getScaleTargetGroup(app.canvas) : null;
    const hiddenGroups = enabled ? getRestorableScaleGroups(app.canvas) : [];
    const hidden = hiddenGroups.length > 0;
    const title = !enabled
        ? "\u5206\u7ec4\u6837\u5f0f\u5df2\u5173\u95ed"
        : hidden
            ? "\u6062\u590d\u6240\u6709\u6298\u53e0\u5b50\u5de5\u4f5c\u6d41"
        : !target
            ? "\u9009\u4e2d\u6216\u60ac\u505c\u5206\u7ec4\u540e\u6298\u53e0\u4e3a\u5b50\u5de5\u4f5c\u6d41"
            : "\u6298\u53e0\u5f53\u524d\u5206\u7ec4\u4e3a\u5b50\u5de5\u4f5c\u6d41";

    button.disabled = !enabled || (!hidden && !target);
    button.classList.toggle("active", hidden);
    button.classList.toggle("gg-scale-hidden", hidden);
    button.classList.toggle("gg-scale-disabled", !enabled || (!hidden && !target));
    button.title = title;
    button.setAttribute("aria-label", title);
}

function installTopButtonStyles() {
    if (document.getElementById("gg-group-styler-top-style")) return;

    const style = document.createElement("style");
    style.id = "gg-group-styler-top-style";
    style.textContent = `
        #gg-group-styler-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            height: 34px;
            flex: 0 0 auto;
        }
        #gg-group-styler-button.gg-group-styler-menu-host,
        #gg-group-styler-button.gg-group-styler-legacy-host {
            position: static;
            margin-inline: 2px;
            z-index: auto;
        }
        #gg-group-styler-button.gg-group-styler-floating-host {
            position: fixed;
            top: 18px;
            right: clamp(252px, calc(25vw + 132px), 624px);
            z-index: 99999;
        }
        #gg-group-styler-button.gg-group-styler-hidden {
            display: none !important;
        }
        #gg-group-styler-button .gg-group-styler-btn {
            width: 34px;
            height: 34px;
            min-width: 34px;
            max-width: 34px;
            padding: 0 !important;
            margin: 0 !important;
            border-radius: 8px;
            border: 1px solid rgba(148,163,184,0.28) !important;
            background: rgba(148,163,184,0.10) !important;
            color: var(--gg-ui-muted, #64748b) !important;
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
        #gg-group-styler-button .gg-group-styler-btn:hover,
        #gg-group-styler-button .gg-group-styler-btn:focus-visible {
            background: rgba(148,163,184,0.18) !important;
            transform: scale(1.06);
        }
        #gg-group-styler-button .gg-group-styler-btn.active {
            color: var(--gg-ui-accent) !important;
            background: rgba(59, 130, 246, 0.17) !important;
            border-color: var(--gg-ui-accent-border) !important;
            transform: scale(1.06);
        }
        #gg-group-styler-button .gg-group-styler-btn.active:hover {
            background: rgba(59, 130, 246, 0.26) !important;
        }
        #gg-group-styler-button .gg-group-styler-btn.gg-scale-hidden {
            color: var(--gg-ui-success) !important;
            background: rgba(34, 197, 94, 0.16) !important;
            border-color: rgba(34, 197, 94, 0.36) !important;
            opacity: 1;
        }
        #gg-group-styler-button .gg-group-styler-btn.gg-scale-disabled {
            opacity: 0.34;
            cursor: not-allowed;
        }
        #gg-group-styler-button .gg-group-styler-btn.gg-scale-disabled:hover {
            transform: none;
            background: var(--gg-ui-accent-soft) !important;
            border-color: var(--gg-ui-accent-border) !important;
        }
        #gg-group-styler-button .gg-group-styler-btn .gg-ui-icon {
            width: 18px;
            height: 18px;
            margin: 0;
            flex: 0 0 auto;
            pointer-events: none;
        }
    `;
    document.head.appendChild(style);
}

async function installTopButton() {
    const existingGroup = document.getElementById("gg-group-styler-button");
    if (existingGroup) {
        if (!existingGroup.querySelector(".gg-group-scale-btn")) {
            existingGroup.append(createTopScaleButton());
        }
        syncTopScaleButton();
        return;
    }

    installTopButtonStyles();

    let ComfyButtonGroup;
    try {
        ({ ComfyButtonGroup } = await import("../../scripts/ui/components/buttonGroup.js"));
    } catch (error) {
        console.warn("[GGGroupStyler] Comfy button group unavailable, using fallback host.", error);
    }

    const groupEl = ComfyButtonGroup ? new ComfyButtonGroup().element : document.createElement("div");
    groupEl.id = "gg-group-styler-button";
    groupEl.classList.add("gg-group-styler-host");

    const button = createTopButton();
    const scaleButton = createTopScaleButton();
    groupEl.append(button, scaleButton);

    const placeGroup = () => {
        if (window.__ggMountTopGroup?.(groupEl)) return true;
        groupEl.classList.remove(
            "gg-group-styler-menu-host",
            "gg-group-styler-legacy-host",
            "gg-group-styler-floating-host",
        );

        const linkStyleButtons = document.getElementById("gg-link-style-buttons");
        if (linkStyleButtons?.parentElement && !linkStyleButtons.classList.contains("gg-link-floating-host")) {
            linkStyleButtons.insertAdjacentElement("afterend", groupEl);
            groupEl.classList.add("gg-group-styler-menu-host");
            return true;
        }

        const settingsGroup = app.menu?.settingsGroup?.element;
        if (settingsGroup?.parentElement) {
            settingsGroup.before(groupEl);
            groupEl.classList.add("gg-group-styler-menu-host");
            return true;
        }

        const queueButton = document.getElementById("queue-button");
        if (queueButton?.parentElement) {
            queueButton.insertAdjacentElement("afterend", groupEl);
            groupEl.classList.add("gg-group-styler-legacy-host");
            return true;
        }

        if (groupEl.parentElement !== document.body) {
            document.body.appendChild(groupEl);
        }
        groupEl.classList.add("gg-group-styler-floating-host");
        return false;
    };

    const applyVisibility = (visible) => {
        const isVisible = visible !== false;
        placeGroup();
        syncTopButton(button);
        syncTopScaleButton(scaleButton);
        groupEl.classList.toggle("gg-group-styler-hidden", !isVisible);
        groupEl.style.display = isVisible ? "inline-flex" : "none";
    };

    window.__ggApplyGroupStylerTopButton = applyVisibility;
    window.__ggSyncGroupStylerTopButton = () => {
        syncTopButton(button);
        syncTopScaleButton(scaleButton);
        syncSubworkflowIndicators(app.canvas);
        markCanvasDirty();
    };

    const refreshVisibility = () => applyVisibility(readSetting(TOP_BUTTONS_SETTING, true));
    refreshVisibility();

    let attempts = 0;
    const timer = setInterval(() => {
        attempts += 1;
        const placed = placeGroup();
        refreshVisibility();
        if (placed || attempts >= 10) clearInterval(timer);
    }, 500);

    try {
        app.ui?.settings?.addEventListener?.(`${SETTINGS_ID}.change`, () => {
            requestAnimationFrame(() => {
                syncTopButton(button);
                syncTopScaleButton(scaleButton);
                syncSubworkflowIndicators(app.canvas);
                markCanvasDirty();
            });
        });
        app.ui?.settings?.addEventListener?.(`${MENU_DISPLAY_SETTING}.change`, () => {
            requestAnimationFrame(refreshVisibility);
        });
    } catch {
        // Older ComfyUI builds may not expose settings events.
    }
}

app.registerExtension({
    name: "ComfyUI.GGNodes.GroupStyler",

    settings: [
        {
            id: SETTINGS_ID,
            category: ["GuliNodes", "\u5206\u7ec4\u6837\u5f0f"],
            name: "\u5206\u7ec4\u6837\u5f0f\u589e\u5f3a",
            type: "boolean",
            defaultValue: true,
            tooltip: "\u4f7f\u7528 GuliNodes \u7684\u5206\u7ec4\u6807\u9898\u680f\u3001\u8fb9\u6846\u548c\u989c\u8272\u5f3a\u8c03\u6837\u5f0f",
            onChange: () => {
                syncOfficialGroupReplacementState(app.canvas);
                window.__ggSyncGroupStylerTopButton?.();
                markCanvasDirty();
            },
        },
        {
            id: TOP_BUTTONS_SETTING,
            category: ["GuliNodes", "\u5206\u7ec4\u6837\u5f0f", "\u9876\u90e8\u5f00\u5173"],
            name: "\u9876\u90e8\u5feb\u6377\u5f00\u5173",
            type: "boolean",
            defaultValue: true,
            tooltip: "\u662f\u5426\u5728 ComfyUI \u9876\u90e8\u663e\u793a\u5206\u7ec4\u6837\u5f0f\u5feb\u6377\u5f00\u5173",
            onChange: (value) => {
                window.__ggApplyGroupStylerTopButton?.(value);
            },
        },
    ],

    init() {
        if (app[PROMPT_PATCH_FLAG] || typeof app.graphToPrompt !== "function") return;

        const originalGraphToPrompt = app.graphToPrompt;
        app.graphToPrompt = async function(...args) {
            if (isEnabled()) {
                enforceHiddenGroupsBeforePrompt(app.canvas);
            }
            return await originalGraphToPrompt.apply(this, args);
        };

        app[PROMPT_PATCH_FLAG] = true;
    },

    loadedGraphNode() {
        noticeSubworkflowIndicatorGraph(app.canvas);
        syncSubworkflowIndicators(app.canvas);
        scheduleHiddenNodeDomSync(app.canvas);
        scheduleHydrateScaleHiddenGroups();
    },

    async afterConfigureGraph() {
        noticeSubworkflowIndicatorGraph(app.canvas);
        syncSubworkflowIndicators(app.canvas);
        scheduleHiddenNodeDomSync(app.canvas);
        hydrateScaleHiddenGroupsWhenReady();
    },

    getSelectionToolboxCommands(selectedItem) {
        if (isEnabled() && selectionContainsGroup(selectedItem)) return [];
    },

    async setup() {
        installGroupReplacementStyles();
        installGroupStyler();
        installHiddenNodePatchesWhenReady();
        installHiddenConnectionsPatchWhenReady();
        installHiddenNodeDomObserver();
        installCanvasPointerCaptureWhenReady();
        installSubworkflowIndicators();
        hydrateScaleHiddenGroupsWhenReady();
        await installTopButton();
        console.log("[GGGroupStyler] Group styling installed");
    },
});
