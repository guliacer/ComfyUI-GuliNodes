import { app } from "../../scripts/app.js";
import { ggIcon } from "./gg-ui-icons.js";
import { getUserItem, setUserItem, removeUserItem } from "./gg-userdata-store.js";
import { applySurface, ensureGGDesign } from "./gg-ui-design.js";

app.registerExtension({
    name: "ComfyUI.GGNodes.Toolbar",
    async setup() {
        const SETTINGS = {
            toolbarEnabled: "GuliNodes.enableToolbar",
            topSwitchEnabled: "GuliNodes.enableToolbarTopSwitch",
            floatButtonsEnabled: "GuliNodes.enableFloatButtons",
            menuDisplay: "Comfy.UseNewMenu",
        };

        const getSettingValue = (id, fallback) => {
            try {
                const value = app.extensionManager?.setting?.get?.(id);
                if (value !== undefined) return value;
            } catch (error) {
                console.warn("[GGToolbar] Unable to read setting:", id, error);
            }
            try {
                return app.ui?.settings?.getSettingValue?.(id, fallback) ?? fallback;
            } catch {
                return fallback;
            }
        };

        const setSettingValue = async (id, value) => {
            try {
                if (app.extensionManager?.setting?.set) {
                    await app.extensionManager.setting.set(id, value);
                    return;
                }
            } catch (error) {
                console.warn("[GGToolbar] Unable to write extension setting:", id, error);
            }

            try {
                app.ui?.settings?.setSettingValue?.(id, value);
            } catch (error) {
                console.warn("[GGToolbar] Unable to write UI setting:", id, error);
            }
        };

        let toolbarEnabled = getSettingValue(SETTINGS.toolbarEnabled, true) !== false;
        let topSwitchEnabled = getSettingValue(SETTINGS.topSwitchEnabled, true) !== false;
        let floatButtonsEnabled = getSettingValue(SETTINGS.floatButtonsEnabled, true) !== false;

        // 4 枚主开关（翻译 / 连接线 / 光效 / 分组）始终收进 GuliNodes 工具菜单（折叠在内），
        // 顶栏只留开菜单的入口 + 迷你开关（收起工具栏 / 悬浮按钮），避免顶栏与 ComfyUI 自带及其它
        // 扩展按钮挤在一起显得杂乱（用户 2026-11-09 要求：回退到重构前口径，可折叠的折叠在菜单里）。
        // ggNarrow 仅用于窄屏下「4 枚主开关随其它入口一起进入菜单」的布局判定与二级页 resize 兜底，
        // 不再影响这 4 枚在顶栏/菜单之间的落点（它们始终在菜单）。
        let ggNarrow = window.matchMedia("(max-width: 1080px)").matches;

        let topSwitchHost = document.createElement("div");
        try {
            const { ComfyButtonGroup } = await import("../../scripts/ui/components/buttonGroup.js");
            if (ComfyButtonGroup) {
                const topSwitchGroup = new ComfyButtonGroup();
                topSwitchHost = topSwitchGroup.element;
            }
        } catch (error) {
            console.warn("[GGToolbar] ComfyButtonGroup unavailable, using floating toolbar switch fallback.", error);
        }
        topSwitchHost.id = "gg-toolbar-top-switch";
        topSwitchHost.classList.add("gg-toolbar-top-switch-host");

        const TOP_TOOL_SECTIONS = [
            { id: "appearance", label: "节点外观" },
            { id: "operations", label: "节点操作" },
            { id: "workflow", label: "工作流辅助" },
        ];
        const TOP_TOOL_GROUPS = [
            { id: "gg-widget-skin-buttons", label: "节点控件皮肤", section: "appearance", icon: "brush" },
            { id: "gg-link-style-buttons", label: "连接线", section: "appearance", icon: "linkFlow" },
            { id: "gg-group-styler-button", label: "分组样式", section: "appearance", icon: "node" },
            { id: "gg-node-glow-buttons", label: "节点光效", section: "appearance", icon: "sparkle" },
            { id: "gg-node-plugin-name-buttons", label: "插件名称", section: "appearance", icon: "tagName" },
            { id: "gg-port-list-toggle-button", label: "输入输出列表", section: "operations", icon: "portList" },
            { id: "gg-node-collapse-button", label: "节点折叠", section: "operations", icon: "nodeCollapse" },
            { id: "gg-node-pin-button", label: "节点固定", section: "operations", icon: "nodePin" },
            { id: "gg-node-align-button", label: "移动对齐", section: "operations", icon: "nodeAlign" },
            { id: "gg-comfy-translate-buttons", label: "界面翻译", section: "workflow", icon: "translate" },
            { id: "gg-taprelay-toggle-host", label: "完成通知", section: "workflow", icon: "bell" },
        ];
        const TOP_GROUP_IDS = new Set(TOP_TOOL_GROUPS.map((entry) => entry.id));
        // 这 4 枚是「主开关」，始终收进 GuliNodes 工具菜单（折叠在内），顶栏不再常驻（见 applyPrimaryPlacement）。
        const PRIMARY_TOP_GROUPS = new Set([
            "gg-link-style-buttons",
            "gg-node-glow-buttons",
            "gg-group-styler-button",
            "gg-comfy-translate-buttons",
        ]);
        const TOP_DETAIL_PANEL_CONFIG = new Map([
            // 「节点控件皮肤」没有详情面板：三档开关直接做成行内分段控件
            // （见 gg-widget-skin-settings.js），点行内按钮即切换，不再开第二层。
            // 触发器用 aria-label 而非 title：ComfyUI 的 buttonGroup 会把按钮的
            // title 清空（只保留 aria-label），窄屏把齿轮吸进菜单后 title 已为空，
            // 用 title 匹配会导致点齿轮不触发二级页。
            ["gg-link-style-buttons", { trigger: 'button[aria-label="连接线快速设置"]', panelId: "gg-link-style-panel", label: "连接线" }],
            ["gg-node-glow-buttons", { trigger: 'button[aria-label="节点光效设置"]', panelId: "gg-node-glow-settings-panel", label: "节点光效" }],
            ["gg-node-collapse-button", { trigger: 'button[aria-label="节点折叠设置"]', panelId: "gg-node-collapse-settings-panel", label: "节点折叠" }],
        ]);
        let topToolsMenu = null;
        let topToolsContent = null;
        let topToolsNav = null;
        let topToolsHeader = null;
        let topToolsSearch = null;
        let topToolsHeaderCount = null;
        let topToolsFooterCount = null;
        let topToolsEmpty = null;
        let topToolsBulkOff = null;
        let topToolsDetail = null;
        let topToolsButton = null;
        let topToolsGroup = null;
        let repositionTopToolsMenu = null;
        const topToolRows = new Map();
        const topToolSections = new Map();

        // ---- 二级页侧滑（设计稿 5 ·03 行三态与二级页 / ·07 统一规格）----
        // 设置不再向下撑开整行（那会把下面 8 行推到屏幕外），改为：点齿轮 →
        // 二级页从右侧 180ms 滑入，同宽、头部 ‹ 返回，一级页原位不动。
        // 菜单关闭时各模块仍用自浮动 popover（positionGlowSettingsPanel 等）。
        let subpageToolId = null;
        let subpageEl = null;
        let subpageTitle = null;
        let subpageBody = null;
        // 打开二级页时记录当时的焦点元素（点齿轮即齿轮、键盘 Enter 即所在行），关闭时回退，
        // 让键盘用户不丢失位置（设计稿 ·07）。
        let subpageReturnFocus = null;
        // 各模块按需登记「保证自己的二级页面板已存在」的回调；__ggToggleTopDetailSubpage
        // 在打开二级页前调用，避免面板还没创建就挂进二级页。
        const ggTopDetailEnsurers = new Map();
        window.__ggRegisterTopDetailEnsurer = (toolId, fn) => {
            if (toolId && typeof fn === "function") ggTopDetailEnsurers.set(toolId, fn);
        };
        // 加载顺序无关：特性模块（gg-node-glow / gg-port-list-toggle / gg-link-style 等）
        // 按字母序早于本文件求值，那时本全局尚未定义，它们的 ensurer 注册会落到这里的待注册队列。
        // 这里统一冲刷，保证键盘（Enter 打开二级页）路径也能拿到面板保证器。
        (window.__ggPendingTopDetailEnsurers || []).forEach(([id, fn]) => {
            if (id && typeof fn === "function") ggTopDetailEnsurers.set(id, fn);
        });
        window.__ggPendingTopDetailEnsurers = [];

        const restoreTopDetailPanel = (panel) => {
            if (!panel) return;
            panel.style.display = "none";
            panel.dataset.ggTopDetailPanel = "false";
            panel.style.position = "";
            panel.style.inset = "";
            panel.style.left = ""; panel.style.top = ""; panel.style.right = "";
            panel.style.width = ""; panel.style.maxWidth = "";
            panel.style.maxHeight = ""; panel.style.margin = "";
            if (panel.parentElement) panel.parentElement.removeChild(panel);
            document.body.appendChild(panel);
        };

        const openTopDetailSubpage = (toolId) => {
            const config = TOP_DETAIL_PANEL_CONFIG.get(toolId);
            if (!config) return false;
            const panel = document.getElementById(config.panelId);
            if (!panel) return false;
            // 首次打开（非切换）时记下当前焦点（点齿轮→齿轮、键盘 Enter→所在行），关闭时回退
            if (!subpageToolId) subpageReturnFocus = document.activeElement;
            // 若已有其它工具的二级页开着，先无感复位（让二级页始终只显示当前工具）
            if (subpageToolId && subpageToolId !== toolId) {
                const prevConfig = TOP_DETAIL_PANEL_CONFIG.get(subpageToolId);
                if (prevConfig) restoreTopDetailPanel(document.getElementById(prevConfig.panelId));
            }
            applySurface(panel);
            panel.dataset.ggTopDetailPanel = "true";
            panel.dataset.ggTopDetailToolId = toolId;
            panel.style.position = "static";
            panel.style.inset = "auto";
            panel.style.left = ""; panel.style.top = ""; panel.style.right = "";
            panel.style.width = "100%"; panel.style.maxWidth = "none";
            panel.style.maxHeight = "none"; panel.style.margin = "0";
            panel.style.boxSizing = "border-box";
            panel.style.display = "block";
            if (panel.parentElement !== subpageBody) subpageBody.appendChild(panel);
            subpageTitle.textContent = config.label || "";
            subpageEl.dataset.open = "true";
            topToolsMenu.dataset.subpageOpen = "true";
            void subpageEl.offsetWidth; // 强制重排后再过渡，确保滑入动画触发
            subpageEl.classList.add("gg-top-tools-subpage-open");
            const row = topToolRows.get(toolId);
            if (row) { row.entry.dataset.expanded = "true"; row.row.setAttribute("aria-expanded", "true"); }
            subpageToolId = toolId;
            syncTopToolsMenu();
            // 展开态焦点自动落到二级页首个「可见」控件（设计稿 ·07）。
            // 用 getClientRects 判定真实可见：元素自身 display 可能不是 none，但祖先被
            // 嵌样式隐藏（如连接线面板的头部关闭钮）时仍拿不到焦点，必须跳过。
            const focusEls = panel.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])");
            let first = null;
            for (const el of focusEls) {
                const cs = getComputedStyle(el);
                if (cs.visibility === "hidden") continue;
                if (el.getClientRects().length === 0) continue;
                first = el;
                break;
            }
            if (first) requestAnimationFrame(() => first.focus?.());
            return true;
        };

        const closeTopDetailSubpage = () => {
            if (!subpageToolId) return false;
            const toolId = subpageToolId;
            const config = TOP_DETAIL_PANEL_CONFIG.get(toolId);
            const panel = config && document.getElementById(config.panelId);
            subpageEl.classList.remove("gg-top-tools-subpage-open");
            subpageEl.dataset.open = "false";
            topToolsMenu.dataset.subpageOpen = "false";
            const row = topToolRows.get(toolId);
            if (row) { row.entry.dataset.expanded = "false"; row.row.setAttribute("aria-expanded", "false"); }
            subpageToolId = null;
            syncTopToolsMenu();
            // 焦点回退：菜单仍在就回触发控件（齿轮 / 所在行），菜单也要关就回顶栏入口；
            // 回退目标若已不可见（如被收回 body 的面板），改回顶栏入口避免聚焦到隐藏元素。
            const ret = subpageReturnFocus;
            subpageReturnFocus = null;
            if (ret && document.contains(ret)) {
                const rcs = getComputedStyle(ret);
                if (rcs.visibility !== "hidden" && ret.getClientRects().length > 0) {
                    ret.focus?.();
                } else if (topToolsMenu.dataset.open !== "true") {
                    topToolsButton.focus?.();
                }
            } else if (topToolsMenu.dataset.open !== "true") {
                topToolsButton.focus?.();
            }
            // 让内容随二级页一起滑走，过渡结束后再复位面板到 body 并隐藏
            const finish = () => {
                subpageEl.removeEventListener("transitionend", finish);
                if (panel) restoreTopDetailPanel(panel);
            };
            subpageEl.addEventListener("transitionend", finish);
            setTimeout(finish, 240); // 兜底：某些浏览器 transitionend 不一定触发
            return true;
        };

        // 旧名保留（光效 / 折叠模块仍调用）：菜单打开时进二级页并返回 true（模块即不自浮动）；
        // 菜单关闭时返回 false，模块退回自浮动 popover。
        const embedTopDetailPanel = (toolId) => {
            if (!topToolsMenu || topToolsMenu.dataset.open !== "true") return false;
            return openTopDetailSubpage(toolId);
        };
        window.__ggEmbedTopDetailPanel = embedTopDetailPanel;

        // 齿轮 / 行 Enter 的统一开关：同一工具再点 → 关闭；否则打开。
        window.__ggToggleTopDetailSubpage = (toolId) => {
            if (subpageToolId === toolId) { closeTopDetailSubpage(); return false; }
            ggTopDetailEnsurers.get(toolId)?.(toolId);
            return openTopDetailSubpage(toolId);
        };
        window.__ggTopDetailSubpageOpen = (toolId) => subpageToolId === toolId;

        const closeTopDetailPanels = () => {
            if (subpageToolId) closeTopDetailSubpage();
        };

        const clearTopGroupPosition = (element) => {
            element.classList.remove(
                "gg-link-menu-host", "gg-link-legacy-host", "gg-link-floating-host",
                "gg-memory-menu-host", "gg-memory-legacy-host", "gg-memory-floating-host",
                "gg-group-styler-menu-host", "gg-group-styler-legacy-host", "gg-group-styler-floating-host",
                "gg-translate-menu-host", "gg-translate-legacy-host", "gg-translate-floating-host",
                "gg-node-glow-floating-host", "gg-node-plugin-name-floating",
                "gg-port-list-floating", "gg-suyan-floating-host",
                "gg-taprelay-floating-host",
            );
            element.style.position = "";
            element.style.top = "";
            element.style.right = "";
            element.style.zIndex = "";
        };

        const toolControlButtons = (source) => {
            if (!source) return [];
            const buttons = Array.from(source.querySelectorAll?.("button") || []);
            if (source.matches?.("button")) buttons.unshift(source);
            return buttons;
        };

        const getToolToggle = (source) => toolControlButtons(source).find((button) =>
            button.classList.contains("gg-state-on")
            || button.classList.contains("gg-state-off")
            || button.hasAttribute("aria-pressed")
        ) || null;

        const isToolEnabled = (entry, source) => {
            if (!source) return false;
            if (entry.id === "gg-widget-skin-buttons") return source.dataset.scope !== "off";
            const toggle = getToolToggle(source);
            return !!toggle && (toggle.classList.contains("gg-state-on")
                || toggle.getAttribute("aria-pressed") === "true");
        };

        const applyTopToolFilter = () => {
            if (!topToolsSearch || !topToolsNav) return;
            const query = topToolsSearch.value.trim().toLocaleLowerCase();
            let visibleCount = 0;
            for (const section of topToolSections.values()) {
                let sectionCount = 0;
                for (const entry of section.items.querySelectorAll(".gg-top-tool-entry")) {
                    const available = entry.dataset.available === "true";
                    const label = entry.dataset.searchLabel || "";
                    const visible = available && (!query || label.includes(query));
                    entry.hidden = !visible;
                    if (visible) sectionCount += 1;
                }
                section.element.hidden = sectionCount === 0;
                visibleCount += sectionCount;
            }
            if (topToolsEmpty) topToolsEmpty.hidden = visibleCount > 0;
        };

        const syncTopToolsMenu = () => {
            let enabledCount = 0;
            for (const [id, row] of topToolRows) {
                const source = row.source;
                const available = !!source;
                row.entry.dataset.available = String(available);
                if (!available) continue;
                const definition = TOP_TOOL_GROUPS.find((entry) => entry.id === id);
                if (definition && isToolEnabled(definition, source)) enabledCount += 1;
                const panel = document.getElementById(TOP_DETAIL_PANEL_CONFIG.get(id)?.panelId || "");
                // 二级页模式下不再用行内 detail 撑开；展开态只看面板是否挂在二级页
                const expanded = !!panel && panel.dataset.ggTopDetailPanel === "true" && panel.style.display !== "none";
                row.entry.dataset.expanded = expanded ? "true" : "false";
                row.detail.hidden = true;
                row.row.setAttribute("aria-expanded", expanded ? "true" : "false");
            }
            if (topToolsHeaderCount) topToolsHeaderCount.textContent = `${enabledCount} / ${TOP_TOOL_GROUPS.length}`;
            if (topToolsFooterCount) topToolsFooterCount.textContent = `共 ${TOP_TOOL_GROUPS.length} 项 · 已启用 ${enabledCount} 项`;
            applyTopToolFilter();
            repositionTopToolsMenu?.();
        };

        const disableAllSwitchTools = () => {
            for (const definition of TOP_TOOL_GROUPS) {
                // 分段皮肤选择不是开关；批量关闭只操作可识别的二态主开关，跳过动作按钮。
                if (definition.id === "gg-widget-skin-buttons") continue;
                const source = topToolRows.get(definition.id)?.source;
                const toggle = getToolToggle(source);
                if (toggle && (toggle.classList.contains("gg-state-on")
                    || toggle.getAttribute("aria-pressed") === "true")) toggle.click();
            }
            requestAnimationFrame(syncTopToolsMenu);
        };

        window.__ggMountTopGroup = (element) => {
            if (!element || !topToolsDetail || !TOP_GROUP_IDS.has(element.id)) return false;
            if (element === topToolsGroup || element.contains(topToolsGroup)) return false;
            // 4 枚主开关始终收进 GuliNodes 工具菜单（折叠在内），不再常驻顶栏：宽屏/窄屏都进菜单，
            // 避免它们与 ComfyUI 自带及其它扩展按钮挤在顶栏显得杂乱（用户 2026-11-09 要求回退到重构前口径）。
            // 关键点：这里直接落到下面的菜单吸收分支，并让菜单里对应行可见。
            if (PRIMARY_TOP_GROUPS.has(element.id)) {
                const row = topToolRows.get(element.id);
                if (!row) return false;
                clearTopGroupPosition(element);
                if (element.parentElement !== row.controls) row.controls.appendChild(element);
                element.style.setProperty("display", "inline-flex", "important");
                element.dataset.ggTopToolSource = "true";
                element.dataset.ggTopToolId = element.id;
                element.dataset.ggTopGrouped = "true";
                row.source = element;
                row.entry.hidden = false;
                syncTopToolsMenu();
                return true;
            }
            const row = topToolRows.get(element.id);
            if (!row) return false;
            clearTopGroupPosition(element);
            if (element.parentElement !== row.controls) row.controls.appendChild(element);
            // A feature may hide its original top-bar host when disabled. The
            // menu must keep the source control visible so it can be enabled again.
            element.style.setProperty("display", "inline-flex", "important");
            element.dataset.ggTopToolSource = "true";
            element.dataset.ggTopToolId = element.id;
            element.dataset.ggTopGrouped = "true";
            row.source = element;
            row.entry.hidden = false;
            syncTopToolsMenu();
            return true;
        };

        // 4 枚主开关始终收进 GuliNodes 工具菜单（折叠在内），不再常驻顶栏：宽屏/窄屏都不吸顶栏，
        // 避免顶栏与 ComfyUI 自带及其它扩展按钮挤在一起显得杂乱（用户 2026-11-09 要求回退到重构前口径）。
        // 因此这里只保证它们落在菜单里，不再搬运到 topSwitchHost；ggNarrow 不再影响这 4 枚的落点。
        const applyPrimaryPlacement = () => {
            if (!topSwitchHost) return;
            for (const id of PRIMARY_TOP_GROUPS) {
                const el = document.getElementById(id);
                if (!el) continue;
                const inMenu = !!el.closest("#gg-top-tools-nav");
                if (!inMenu) window.__ggMountTopGroup?.(el);
            }
            syncTopToolsMenu?.();
            repositionTopToolsMenu?.();
        };

        const installTopToolsMenu = () => {
            if (topToolsGroup) return;
            ensureGGDesign();
            const style = document.createElement("style");
            style.id = "gg-top-tools-menu-style";
            // 外壳（位置、尺寸、圆角、阴影、内边距、滚动条）全部由设计层的
            // `.gg-popover` + `.gg-surface` 提供，这里只写「菜单特有」的结构与状态。
            // 以前这里复制了一整套外壳样式，改一处要改三个文件，深色主题下还会走样。
            style.textContent = `
                #gg-top-tools-group {
                    position: relative;
                    display: inline-flex;
                    align-items: center;
                    height: 34px;
                    margin-inline: 2px;
                    flex: 0 0 auto;
                }
                /* 设计稿 13:26 定稿：G 标入口 34×34 / r9（比 4 枚 32px 开关大半号） */
                #gg-top-tools-button {
                    width: 34px;
                    min-width: 34px;
                    height: 34px;
                    min-height: 34px;
                    border-radius: 9px;
                    padding: 0;
                }
                #gg-top-tools-menu {
                    display: none;
                    padding: 8px;
                    overflow: hidden; /* 二级页从右侧滑入时裁切，关闭后整页复位 */
                }
                #gg-top-tools-menu[data-open="true"] { display: block; }
                #gg-top-tools-nav {
                    min-width: 0;
                    min-height: 0;
                    padding: 0;
                }
                #gg-top-tools-content {
                    display: flex;
                    flex-direction: column;
                    min-width: 0;
                    max-height: calc(100vh - 136px);
                }
                .gg-top-tools-header { flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px; padding: 0 2px 8px; }
                .gg-top-tools-heading { display: flex; align-items: center; gap: 8px; min-height: 28px; color: var(--gg-ink); font-size: 13px; font-weight: 700; }
                .gg-top-tools-heading > .gg-ui-icon { color: var(--gg-accent); }
                .gg-top-tools-count { margin-left: auto; padding: 3px 7px; border: 1px solid var(--gg-divider); border-radius: 999px; color: var(--gg-muted); background: var(--gg-card); font-size: 10.5px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; }
                .gg-top-tools-search-wrap { position: relative; display: flex; align-items: center; min-width: 0; }
                .gg-top-tools-search-wrap > .gg-ui-icon { position: absolute; left: 9px; color: var(--gg-muted); pointer-events: none; }
                .gg-top-tools-search-wrap input { width: 100%; height: 32px; padding: 0 34px 0 32px; border: 1px solid var(--gg-divider); border-radius: 7px; outline: none; color: var(--gg-ink); background: var(--gg-field); font: inherit; font-size: 12px; box-sizing: border-box; }
                .gg-top-tools-search-wrap input:focus { border-color: var(--gg-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--gg-accent) 20%, transparent); }
                .gg-top-tools-search-wrap input::placeholder { color: var(--gg-muted); }
                .gg-top-tools-search-wrap kbd { position: absolute; right: 8px; min-width: 17px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--gg-divider); border-radius: 4px; color: var(--gg-muted); background: var(--gg-card); font: 10px/1 ui-monospace, monospace; }
                #gg-top-tools-nav { flex: 1 1 auto; min-height: 0; overflow: auto; scrollbar-width: thin; scrollbar-color: var(--gg-divider) transparent; }
                #gg-top-tools-nav::-webkit-scrollbar { width: 6px; }
                #gg-top-tools-nav::-webkit-scrollbar-thumb { border-radius: 6px; background: var(--gg-divider); }
                #gg-top-tools-nav .gg-top-tool-section[hidden] { display: none !important; }
                #gg-top-tools-nav .gg-top-tool-section + .gg-top-tool-section { margin-top: 12px; }
                #gg-top-tools-nav .gg-top-tool-section-title { margin: 0 8px 6px; color: var(--gg-muted); font-size: 9.5px; font-weight: 700; letter-spacing: .1em; line-height: 14px; }
                #gg-top-tools-nav .gg-top-tool-entry {
                    display: block;
                    min-width: 0;
                    border: 1px solid transparent;
                    border-radius: 8px;
                    transition: background-color .14s ease, border-color .14s ease;
                }
                #gg-top-tools-nav .gg-top-tool-entry + .gg-top-tool-entry {
                    margin-top: 2px;
                }
                #gg-top-tools-nav .gg-top-tool-entry[hidden] {
                    display: none !important;
                }
                #gg-top-tools-nav .gg-top-tool-entry[data-expanded="true"] {
                    border-color: var(--gg-picked-border);
                    background: var(--gg-picked-bg);
                }
                #gg-top-tools-nav .gg-top-tool-row {
                    width: 100%;
                    /* 设计稿 18:2124 规格表：菜单行高 34 / r8（原 40 / r7） */
                    min-height: 34px;
                    display: grid;
                    grid-template-columns: 15px minmax(78px, 1fr) minmax(0, auto);
                    align-items: center;
                    gap: 9px;
                    min-height: 34px;
                    padding: 2px 8px;
                    border: 0;
                    border-radius: 8px;
                    background: transparent;
                    color: var(--gg-ink);
                    text-align: left;
                    box-sizing: border-box;
                    font: inherit;
                    cursor: pointer;
                }
                #gg-top-tools-nav .gg-top-tool-row:hover {
                    background: var(--gg-btn-hover);
                }
                #gg-top-tools-nav .gg-top-tool-row:focus-visible {
                    outline: 2px solid var(--gg-accent);
                    outline-offset: -2px;
                }
                #gg-top-tools-nav .gg-top-tool-row-label {
                    display: block;
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    font-size: 12.5px;
                    font-weight: 600;
                }
                #gg-top-tools-nav .gg-top-tool-row-icon {
                    width: 15px;
                    height: 15px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--gg-muted);
                }
                #gg-top-tools-nav .gg-top-tool-row-icon .gg-ui-icon { width: 15px; height: 15px; }
                #gg-top-tools-nav .gg-top-tool-controls {
                    display: inline-flex;
                    min-width: 0;
                    align-items: center;
                    justify-content: flex-end;
                    gap: 4px;
                }
                #gg-top-tools-nav [data-gg-top-tool-source] {
                    display: inline-flex !important;
                    width: auto !important;
                    min-width: 0 !important;
                    height: auto !important;
                    margin: 0 !important;
                    align-items: center !important;
                    justify-content: flex-end !important;
                    gap: 4px !important;
                    flex: 0 0 auto !important;
                }
                #gg-top-tools-nav [data-gg-top-tool-source] > button,
                /* 有的功能把「按钮本身」交给工具箱托管（它自己就是 source 容器），
                   上面那条 width:auto 会把它压成图标的宽度（实测 19px）。
                   下面这条先给开关 / 齿轮控件统一尺寸，再按真实控件类型覆盖。 */
                #gg-top-tools-nav button[data-gg-top-tool-source],
                #gg-top-tools-nav [data-gg-top-tool-source] .gg-ui-top-button,
                #gg-top-tools-nav [data-gg-top-tool-source] .gg-toolbar-top-button {
                    width: 22px !important;
                    min-width: 22px !important;
                    max-width: 22px !important;
                    height: 22px !important;
                    min-height: 22px !important;
                    max-height: 22px !important;
                    padding: 0 !important;
                    border-radius: 8px !important;
                    box-sizing: border-box !important;
                }
                #gg-top-tools-nav [data-gg-top-tool-source] .gg-ui-icon {
                    width: 17px;
                    height: 17px;
                }
                #gg-top-tools-nav .gg-top-tool-controls button.gg-state-on,
                #gg-top-tools-nav .gg-top-tool-controls button.gg-state-off {
                    position: relative;
                    width: 30px !important;
                    min-width: 30px !important;
                    max-width: 30px !important;
                    height: 17px !important;
                    min-height: 17px !important;
                    max-height: 17px !important;
                    padding: 0 !important;
                    overflow: hidden;
                    border: 1px solid var(--gg-divider) !important;
                    border-radius: 999px !important;
                    background: var(--gg-divider) !important;
                    color: transparent !important;
                    box-shadow: none !important;
                    cursor: pointer;
                }
                #gg-top-tools-nav .gg-top-tool-controls button.gg-state-on {
                    border-color: var(--gg-accent) !important;
                    background: var(--gg-accent) !important;
                }
                #gg-top-tools-nav .gg-top-tool-controls button.gg-state-on:hover,
                #gg-top-tools-nav .gg-top-tool-controls button.gg-state-off:hover { filter: brightness(1.08); }
                #gg-top-tools-nav .gg-top-tool-controls button.gg-state-on > *,
                #gg-top-tools-nav .gg-top-tool-controls button.gg-state-off > * { opacity: 0 !important; }
                #gg-top-tools-nav .gg-top-tool-controls button.gg-state-on::after,
                #gg-top-tools-nav .gg-top-tool-controls button.gg-state-off::after {
                    content: "";
                    position: absolute;
                    top: 2px;
                    left: 2px;
                    width: 11px;
                    height: 11px;
                    border-radius: 50%;
                    background: var(--gg-panel);
                    transition: transform .14s ease;
                    pointer-events: none;
                }
                #gg-top-tools-nav .gg-top-tool-controls button.gg-state-on::after { transform: translateX(13px); }
                #gg-top-tools-nav .gg-top-tool-controls button[aria-label*="设置"] {
                    width: 22px !important;
                    min-width: 22px !important;
                    max-width: 22px !important;
                    height: 22px !important;
                    min-height: 22px !important;
                    max-height: 22px !important;
                }
                .gg-top-tools-empty { padding: 18px 8px; color: var(--gg-muted); text-align: center; font-size: 12px; }
                .gg-top-tools-empty[hidden] { display: none !important; }
                .gg-top-tools-footer {
                    flex: 0 0 auto;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                    margin-top: 8px;
                    padding: 8px 2px 0;
                    border-top: 1px solid var(--gg-divider);
                    color: var(--gg-muted);
                    font-size: 10.5px;
                }
                .gg-top-tools-bulk-off { padding: 4px 7px; border: 1px solid var(--gg-divider); border-radius: 6px; color: var(--gg-ink); background: var(--gg-btn); font: inherit; cursor: pointer; }
                .gg-top-tools-bulk-off:hover { background: var(--gg-btn-hover); }
                .gg-top-tools-bulk-off:focus-visible { outline: 2px solid var(--gg-accent); outline-offset: 1px; }
                #gg-top-tools-nav .gg-top-tool-detail {
                    display: block;
                    min-width: 0;
                    padding: 0 8px 8px;
                }
                #gg-top-tools-nav .gg-top-tool-detail[hidden] {
                    display: none !important;
                }
                #gg-top-tools-nav [data-gg-top-detail-panel] {
                    min-width: 0;
                    width: 100% !important;
                    max-width: none !important;
                    max-height: none !important;
                    margin: 0 !important;
                    border-radius: 12px !important;
                    box-sizing: border-box !important;
                }
                #gg-top-tools-subpage-body #gg-node-glow-settings-panel > .gg-node-glow-settings-title,
                #gg-top-tools-subpage-body #gg-node-collapse-settings-panel > .gg-collapse-settings-title {
                    display: none !important;
                }
                /* 二级页（设计稿 5 ·03 行三态与二级页 / ·07 统一规格）：
                   同宽、从右侧 180ms 滑入，覆盖一级页；头部 ‹ 返回，一级页原位不动。
                   不做嵌套浮层——任何设置面板都挂进 body 内的二级页，不再浮动第二层。 */
                #gg-top-tools-subpage {
                    position: absolute;
                    inset: 0;
                    display: flex;
                    flex-direction: column;
                    box-sizing: border-box;
                    border-radius: inherit;
                    z-index: 2;
                    transform: translateX(100%);
                    opacity: 0;
                    pointer-events: none;
                    transition: transform .18s ease, opacity .12s ease;
                }
                #gg-top-tools-subpage.gg-top-tools-subpage-open {
                    transform: translateX(0);
                    opacity: 1;
                    pointer-events: auto;
                }
                #gg-top-tools-subpage-header {
                    position: relative;
                    flex: 0 0 auto;
                    height: 44px;
                    min-height: 44px;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 0 8px;
                    border-bottom: 1px solid var(--gg-divider);
                    box-sizing: border-box;
                }
                #gg-top-tools-subpage-back {
                    display: inline-flex;
                    align-items: center;
                    gap: 1px;
                    height: 30px;
                    min-height: 30px;
                    padding: 0 9px;
                    border: 1px solid var(--gg-divider);
                    border-radius: 8px;
                    background: var(--gg-btn);
                    color: var(--gg-ink);
                    font: inherit;
                    font-size: 12.5px;
                    font-weight: 600;
                    cursor: pointer;
                }
                #gg-top-tools-subpage-back:hover { background: var(--gg-btn-hover); }
                #gg-top-tools-subpage-back:focus-visible {
                    outline: 2px solid var(--gg-accent);
                    outline-offset: -2px;
                }
                #gg-top-tools-subpage-title {
                    position: absolute;
                    left: 50%;
                    top: 50%;
                    transform: translate(-50%, -50%);
                    max-width: calc(100% - 88px);
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    text-align: center;
                    font-size: 13px;
                    font-weight: 700;
                    pointer-events: none;
                }
                #gg-top-tools-subpage-body {
                    flex: 1 1 auto;
                    min-height: 0;
                    overflow: auto;
                    padding: 10px 12px;
                    box-sizing: border-box;
                }
                /* 尊重系统“减少动态效果”偏好：二级页滑入/滑出改为瞬切，不做 180ms 位移与淡入，
                   避免对动效敏感用户造成不适；关闭仍靠 240ms 兜底复位面板，行为不变。 */
                @media (prefers-reduced-motion: reduce) {
                    #gg-top-tools-subpage { transition: none; }
                }
            `;
            document.head.appendChild(style);

            topToolsGroup = document.createElement("div");
            topToolsGroup.id = "gg-top-tools-group";
            topToolsButton = document.createElement("button");
            topToolsButton.id = "gg-top-tools-button";
            topToolsButton.type = "button";
            topToolsButton.className = "gg-switch";
            topToolsButton.title = "GuliNodes 工具";
            topToolsButton.setAttribute("aria-label", "GuliNodes 工具");
            // 动作 / 弹窗类按钮：气泡写「结果文案」而非状态（设计稿第 2 页 ·07）。
            topToolsButton.dataset.ggBubbleAction = "打开 GuliNodes 工具菜单";
            topToolsButton.setAttribute("aria-expanded", "false");
            topToolsButton.innerHTML = ggIcon("toolGrid", 18);
            topToolsMenu = document.createElement("div");
            topToolsMenu.id = "gg-top-tools-menu";
            // 外壳与配色交给设计层：这一层只负责结构与状态
            topToolsMenu.className = "gg-surface gg-popover";
            applySurface(topToolsMenu);
            topToolsMenu.setAttribute("role", "menu");
            topToolsContent = document.createElement("div");
            topToolsContent.id = "gg-top-tools-content";
            topToolsHeader = document.createElement("div");
            topToolsHeader.className = "gg-top-tools-header";
            const headerTitle = document.createElement("div");
            headerTitle.className = "gg-top-tools-heading";
            headerTitle.innerHTML = `${ggIcon("toolGrid", 16)}<span>GuliNodes 工具</span>`;
            topToolsHeaderCount = document.createElement("span");
            topToolsHeaderCount.className = "gg-top-tools-count";
            topToolsHeaderCount.textContent = `0 / ${TOP_TOOL_GROUPS.length}`;
            headerTitle.appendChild(topToolsHeaderCount);
            const searchWrap = document.createElement("label");
            searchWrap.className = "gg-top-tools-search-wrap";
            searchWrap.innerHTML = `${ggIcon("search", 15)}<input type="search" autocomplete="off" spellcheck="false" placeholder="搜索工具…" aria-label="搜索工具"><kbd>/</kbd>`;
            topToolsSearch = searchWrap.querySelector("input");
            topToolsSearch.addEventListener("input", applyTopToolFilter);
            topToolsHeader.append(headerTitle, searchWrap);
            topToolsNav = document.createElement("div");
            topToolsNav.id = "gg-top-tools-nav";
            // Kept as a compatibility marker for extensions that only check that
            // the toolbar menu has been installed before mounting their controls.
            topToolsDetail = topToolsNav;
            for (const definition of TOP_TOOL_SECTIONS) {
                const section = document.createElement("section");
                section.className = "gg-top-tool-section";
                section.dataset.sectionId = definition.id;
                const heading = document.createElement("div");
                heading.className = "gg-top-tool-section-title";
                heading.textContent = definition.label;
                const items = document.createElement("div");
                items.className = "gg-top-tool-section-items";
                section.append(heading, items);
                topToolsNav.appendChild(section);
                topToolSections.set(definition.id, { element: section, heading, items });
            }
            topToolsEmpty = document.createElement("div");
            topToolsEmpty.className = "gg-top-tools-empty";
            topToolsEmpty.textContent = "没有匹配的工具";
            topToolsEmpty.hidden = true;
            topToolsNav.appendChild(topToolsEmpty);
            const footer = document.createElement("div");
            footer.className = "gg-top-tools-footer";
            topToolsFooterCount = document.createElement("span");
            topToolsFooterCount.textContent = `共 ${TOP_TOOL_GROUPS.length} 项 · 已启用 0 项`;
            topToolsBulkOff = document.createElement("button");
            topToolsBulkOff.type = "button";
            topToolsBulkOff.className = "gg-top-tools-bulk-off";
            topToolsBulkOff.textContent = "全部关闭";
            topToolsBulkOff.addEventListener("click", disableAllSwitchTools);
            footer.append(topToolsFooterCount, topToolsBulkOff);
            topToolsContent.append(topToolsHeader, topToolsNav, footer);
            topToolsMenu.appendChild(topToolsContent);
            TOP_TOOL_GROUPS.forEach((entry) => {
                const wrapper = document.createElement("div");
                wrapper.className = "gg-top-tool-entry";
                wrapper.dataset.toolId = entry.id;
                wrapper.dataset.available = "false";
                wrapper.dataset.searchLabel = entry.label.toLocaleLowerCase();
                wrapper.dataset.controlType = entry.id === "gg-widget-skin-buttons"
                    ? "segmented"
                    : TOP_DETAIL_PANEL_CONFIG.has(entry.id) ? "switch-settings" : "switch";
                wrapper.hidden = true;
                const row = document.createElement("div");
                row.className = "gg-top-tool-row";
                row.setAttribute("role", "menuitem");
                row.setAttribute("aria-expanded", "false");
                row.tabIndex = -1; // 可聚焦但不进 Tab 序列，供 ↑/↓ 漫游
                row.innerHTML = `<span class="gg-top-tool-row-icon">${ggIcon(entry.icon, 15)}</span><span class="gg-top-tool-row-label"></span><span class="gg-top-tool-controls"></span>`;
                row.querySelector(".gg-top-tool-row-label").textContent = entry.label;
                const detail = document.createElement("div");
                detail.className = "gg-top-tool-detail";
                detail.hidden = true;
                detail.dataset.ggTopDetailSlot = entry.id;
                wrapper.append(row, detail);
                topToolSections.get(entry.section)?.items.appendChild(wrapper);
                topToolRows.set(entry.id, {
                    entry: wrapper,
                    row,
                    controls: row.querySelector(".gg-top-tool-controls"),
                    detail,
                    source: null,
                });
            });
            // Keep the trigger in the top bar, but portal the menu to body. ComfyUI's
            // top button group can clip descendants or create a stacking context.
            topToolsGroup.append(topToolsButton);

            // 二级页外壳：同宽滑入，覆盖一级页（设计稿 5 ·03 / ·07）。
            subpageEl = document.createElement("div");
            subpageEl.id = "gg-top-tools-subpage";
            subpageEl.className = "gg-surface";
            applySurface(subpageEl);
            subpageEl.setAttribute("role", "group");
            subpageEl.setAttribute("aria-label", "设置二级页");
            subpageEl.dataset.open = "false";
            const subpageHeader = document.createElement("div");
            subpageHeader.className = "gg-top-tools-subpage-header";
            subpageHeader.id = "gg-top-tools-subpage-header";
            const subpageBack = document.createElement("button");
            subpageBack.type = "button";
            subpageBack.id = "gg-top-tools-subpage-back";
            subpageBack.className = "gg-top-tools-subpage-back";
            subpageBack.setAttribute("aria-label", "返回上一级");
            subpageBack.innerHTML = `${ggIcon("chevronLeft", 16)}<span>返回</span>`;
            subpageBack.addEventListener("click", () => closeTopDetailSubpage());
            subpageTitle = document.createElement("div");
            subpageTitle.className = "gg-top-tools-subpage-title";
            subpageTitle.id = "gg-top-tools-subpage-title";
            subpageHeader.append(subpageBack, subpageTitle);
            subpageBody = document.createElement("div");
            subpageBody.id = "gg-top-tools-subpage-body";
            subpageBody.className = "gg-top-tools-subpage-body";
            subpageEl.append(subpageHeader, subpageBody);
            topToolsMenu.appendChild(subpageEl);
            topToolsMenu.dataset.subpageOpen = "false";

            document.body.appendChild(topToolsMenu);

            topToolsMenu.addEventListener("click", (event) => {
                if (event.target.closest?.("[data-gg-top-tool-source]")) {
                    requestAnimationFrame(syncTopToolsMenu);
                }
            }, true);
            topToolsMenu.addEventListener("click", (event) => {
                const source = event.target.closest?.("[data-gg-top-tool-source]");
                const toolId = source?.dataset.ggTopToolId;
                const config = TOP_DETAIL_PANEL_CONFIG.get(toolId);
                // 点齿轮 → 二级页侧滑（设计稿 5 ·03 / ·07）：不再向下撑开整行。
                // 同一工具再点齿轮 → 关闭；由 __ggToggleTopDetailSubpage 统一裁决。
                if (config && event.target.closest?.(config.trigger)) {
                    event.preventDefault();
                    event.stopPropagation();
                    window.__ggToggleTopDetailSubpage?.(toolId);
                    return;
                }
                requestAnimationFrame(syncTopToolsMenu);
                event.stopPropagation();
            });

            const positionMenu = () => {
                if (!topToolsMenu || topToolsMenu.dataset.open !== "true") return;
                const rect = topToolsButton.getBoundingClientRect();
                const menuWidth = Math.min(320, window.innerWidth - 16);
                const left = Math.min(window.innerWidth - menuWidth - 8, Math.max(8, rect.left));
                const belowTop = rect.bottom + 8;
                const top = belowTop + topToolsMenu.offsetHeight <= window.innerHeight - 8
                    ? belowTop
                    : Math.max(8, rect.top - topToolsMenu.offsetHeight - 8);
                topToolsMenu.style.left = `${left}px`;
                topToolsMenu.style.top = `${top}px`;
            };
            repositionTopToolsMenu = positionMenu;
            const setMenuOpen = (open) => {
                topToolsMenu.dataset.open = open ? "true" : "false";
                topToolsButton.setAttribute("aria-expanded", open ? "true" : "false");
                topToolsButton.classList.toggle("active", open);
                if (open) {
                    // 每次打开都重算皮肤：宿主可能中途切了深/浅色
                    applySurface(topToolsMenu);
                    collectTopGroups();
                    positionMenu();
                } else {
                    closeTopDetailPanels();
                }
            };
            topToolsButton.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                setMenuOpen(topToolsMenu.dataset.open !== "true");
            });
            topToolsMenu.addEventListener("click", (event) => event.stopPropagation());
            topToolsMenu.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
            document.addEventListener("pointerdown", (event) => {
                if (
                    topToolsMenu.dataset.open === "true"
                    && !topToolsGroup.contains(event.target)
                    && !topToolsMenu.contains(event.target)
                ) setMenuOpen(false);
            }, true);
            document.addEventListener("keydown", (event) => {
                if (topToolsMenu.dataset.open !== "true") return;
                // 二级页打开时：Esc / ← 先退回一级页，绝不越过二级页直接关菜单（设计稿 ·07）
                if (subpageToolId) {
                    if (event.key === "Escape" || event.key === "ArrowLeft") {
                        closeTopDetailSubpage();
                        event.preventDefault();
                        return;
                    }
                    // Tab / Shift+Tab 锁在二级页内：二级页覆盖一级页，键盘不能漏到背后被遮的一级页。
                    // 只在边界（首/尾控件，或焦点已跑出二级页）处拦截回环；内部元素交给浏览器原生 Tab。
                    if (event.key === "Tab" && subpageBody) {
                        const f = Array.from(
                            subpageBody.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")
                        ).filter((el) => getComputedStyle(el).visibility !== "hidden" && el.getClientRects().length > 0);
                        if (!f.length) return;
                        const first = f[0], last = f[f.length - 1];
                        const active = document.activeElement;
                        if (event.shiftKey) {
                            if (active === first || !subpageEl.contains(active)) { event.preventDefault(); last.focus(); }
                        } else {
                            if (active === last || !subpageEl.contains(active)) { event.preventDefault(); first.focus(); }
                        }
                    }
                    return;
                }
                if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey
                    && !event.target?.closest?.("input, textarea, select, [contenteditable='true']")) {
                    event.preventDefault();
                    topToolsSearch?.focus();
                    return;
                }
                if (event.key === "Escape") { setMenuOpen(false); return; }
                // 一级页：↑/↓ 在可见行间移动焦点，Enter / 空格展开二级页（有设置面板时）
                const visibleRows = Array.from(
                    topToolsNav.querySelectorAll(".gg-top-tool-entry:not([hidden]) > .gg-top-tool-row")
                );
                if (!visibleRows.length) return;
                const activeIndex = visibleRows.indexOf(document.activeElement);
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const base = activeIndex < 0 ? 0 : activeIndex;
                    const next = event.key === "ArrowDown"
                        ? Math.min(visibleRows.length - 1, base + 1)
                        : Math.max(0, base - 1);
                    visibleRows[next].focus();
                } else if (event.key === "Enter" || event.key === " ") {
                    const row = document.activeElement?.closest?.(".gg-top-tool-row");
                    if (row) {
                        const id = row.closest(".gg-top-tool-entry")?.dataset.toolId;
                        const cfg = id && TOP_DETAIL_PANEL_CONFIG.get(id);
                        if (cfg) {
                            event.preventDefault();
                            window.__ggToggleTopDetailSubpage?.(id);
                        } else {
                            // 无二级页的纯开关行：焦点落到其 source 开关，由原生 Enter 触发
                            const src = row.querySelector("[data-gg-top-tool-source]");
                            if (src) src.focus();
                        }
                    }
                }
            });
            window.addEventListener("resize", positionMenu);
            window.__ggTopToolsMenuOpen = () => topToolsMenu.dataset.open === "true";
        };

        const collectTopGroups = () => {
            if (!topToolsContent) return;
            for (const id of TOP_GROUP_IDS) {
                const element = document.getElementById(id);
                if (element) {
                    window.__ggMountTopGroup(element);
                }
            }
            syncTopToolsMenu();
        };

        installTopToolsMenu();

        // 顶栏重构：宽/窄切换时搬运 4 枚主开关；同时用 rAF + 延时兜底，捕捉在本扩展之后才挂载的主开关组。
        const ggNarrowMedia = window.matchMedia("(max-width: 1080px)");
        ggNarrowMedia.addEventListener("change", (event) => {
            ggNarrow = event.matches;
            // 离开窄屏（→宽屏）时若二级页还开着，先收掉再搬运开关，避免面板被遗留在已隐藏的菜单里
            if (!ggNarrow && subpageToolId) closeTopDetailSubpage();
            applyPrimaryPlacement();
        });
        requestAnimationFrame(() => applyPrimaryPlacement());
        setTimeout(() => applyPrimaryPlacement(), 1200);

        // 创建单个工具栏面板
        const panel = document.createElement("div");
        panel.id = "gg-nodes-panel";
        // 底色 / 描边由设计层按当前主题给；这里只留布局。
        // 以前写死 `background: #ffffff`，深色主题下就是一条纯白长条。
        panel.className = "gg-surface";
        ensureGGDesign();
        applySurface(panel);
        panel.style.cssText = `
            position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%);
            padding: 8px 12px; border-radius: 12px;
            border: 1px solid var(--gg-divider);
            box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18);
            z-index: 99999; font-size: 13px;
            user-select: none; display: flex; flex-direction: column; gap: 6px;
            cursor: grab;
            max-width: 90vw;
            align-items: center;
            justify-content: center;
        `;

        panel.innerHTML = `
            <!-- 节点上色工具栏 -->
            <div class="color-section" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:center;">
                <button id="btn-color-paint" class="tool-btn" data-tooltip="启用节点上色" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("brush", 21)}
                </button>
                <div class="color-mode-wrap" style="position:relative;">
                    <button id="btn-color-mode" class="tool-btn" data-tooltip="上色模式" style="background:transparent;border:none;padding:4px;">
                        ${ggIcon("palette", 21)}
                    </button>
                    <div id="gg-color-mode-menu" style="display:none;position:absolute;left:50%;bottom:42px;transform:translateX(-50%);z-index:100000;">
                        <button class="tool-btn color-mode-btn active" data-mode="node" data-tooltip="节点整体" style="background:transparent;border:none;padding:4px;">
                            ${ggIcon("node", 21)}
                        </button>
                        <button class="tool-btn color-mode-btn" data-mode="body" data-tooltip="节点内部" style="background:transparent;border:none;padding:4px;">
                            ${ggIcon("body", 21)}
                        </button>
                        <button class="tool-btn color-mode-btn" data-mode="title" data-tooltip="标题栏" style="background:transparent;border:none;padding:4px;">
                            ${ggIcon("title", 21)}
                        </button>
                    </div>
                </div>
                <button id="btn-color-node" class="tool-btn color-mode-btn active" data-mode="node" data-tooltip="上色模式：节点整体" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("node", 21)}
                </button>
                <button id="btn-color-body" class="tool-btn color-mode-btn" data-mode="body" data-tooltip="上色模式：节点内部" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("body", 21)}
                </button>
                <button id="btn-color-title" class="tool-btn color-mode-btn" data-mode="title" data-tooltip="上色模式：节点标题栏" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("title", 21)}
                </button>
                <div class="divider" style="width:1px;height:24px;background:var(--gg-divider);"></div>
                <button id="btn-pick-color" class="tool-btn" data-tooltip="取色：复制节点/分组上色" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("pipette", 21)}
                </button>
                <button id="btn-paste-color" class="tool-btn" data-tooltip="粘贴上色到选中节点/分组" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("paste", 21)}
                </button>
                <button id="btn-clear-color" class="tool-btn" data-tooltip="删除节点颜色" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("trash", 21)}
                </button>
                <div class="divider" style="width:1px;height:24px;background:var(--gg-divider);"></div>
                <div id="gg-color-presets" style="display:flex;align-items:center;gap:2px;"></div>
                <button id="btn-custom-color-1" class="tool-btn custom-color-btn" data-index="1" data-tooltip="自定义颜色 1" style="background:transparent;border:none;padding:4px;">
                    <span class="color-dot custom-dot" style="background:#8fa39b;"></span>
                </button>
                <button id="btn-custom-color-2" class="tool-btn custom-color-btn" data-index="2" data-tooltip="自定义颜色 2" style="background:transparent;border:none;padding:4px;">
                    <span class="color-dot custom-dot" style="background:#c9a7a2;"></span>
                </button>
                <input id="gg-custom-color-input-1" type="color" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;">
                <input id="gg-custom-color-input-2" type="color" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;">
            </div>
            <div class="toolbar-row-divider" style="width:100%;height:1px;background:var(--gg-divider);"></div>
            <!-- 尺寸调节工具栏 -->
            <div class="main-section" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:center;">
                <button id="btn-copy-size" class="tool-btn" data-tooltip="复制节点尺寸" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("copy", 21)}
                </button>
                <button id="btn-paste-size" class="tool-btn" data-tooltip="粘贴尺寸到选中节点" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("paste", 21)}
                </button>
                <div class="divider" style="width:1px;height:24px;background:var(--gg-divider);"></div>
                <button id="btn-same-width" class="tool-btn" data-tooltip="自动宽度" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("width", 21)}
                </button>
                <button id="btn-same-height" class="tool-btn" data-tooltip="自动高度" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("height", 21)}
                </button>
                <div class="divider" style="width:1px;height:24px;background:var(--gg-divider);"></div>
                <button id="btn-align-left" class="tool-btn" data-tooltip="最左对齐" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("alignLeft", 21)}
                </button>
                <button id="btn-align-right" class="tool-btn" data-tooltip="最右对齐" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("alignRight", 21)}
                </button>
                <button id="btn-align-hcenter" class="tool-btn" data-tooltip="水平居中" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("alignHCenter", 21)}
                </button>
                <div class="divider" style="width:1px;height:24px;background:var(--gg-divider);"></div>
                <button id="btn-align-top" class="tool-btn" data-tooltip="最顶对齐" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("alignTop", 21)}
                </button>
                <button id="btn-align-bottom" class="tool-btn" data-tooltip="最底对齐" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("alignBottom", 21)}
                </button>
                <button id="btn-align-vcenter" class="tool-btn" data-tooltip="垂直居中" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("alignVCenter", 21)}
                </button>
                <div class="divider" style="width:1px;height:24px;background:var(--gg-divider);"></div>
                <button id="btn-auto-spacing" class="tool-btn" data-tooltip="自动间距" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("spacing", 21)}
                </button>
                <div class="divider" style="width:1px;height:24px;background:var(--gg-divider);"></div>
                <button id="btn-auto-fit" class="tool-btn" data-tooltip="自适应尺寸（紧凑）" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("fit", 21)}
                </button>
                <div class="divider" style="width:1px;height:24px;background:var(--gg-divider);"></div>
                <button id="btn-close-toolbar" class="tool-btn" data-tooltip="关闭工具栏" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("close", 21)}
                </button>
            </div>
        `;

        document.body.appendChild(panel);

        const toolbarSettings = document.createElement("div");
        toolbarSettings.id = "gg-toolbar-settings";
        // 外壳交给设计层；这里只留尺寸与定位
        toolbarSettings.className = "gg-surface gg-popover";
        applySurface(toolbarSettings);
        toolbarSettings.style.cssText = `
            position: fixed; display: none; z-index: 100002;
            width: 248px; padding: 14px;
            border-radius: 16px;
            user-select: none;
        `;
        toolbarSettings.innerHTML = `
            <div class="gg-toolbar-settings-head">
                <div>
                    <div class="gg-toolbar-settings-title">\u5de5\u5177\u680f\u5916\u89c2</div>
                    <div class="gg-toolbar-settings-subtitle">\u5b9e\u65f6\u8c03\u6574\u989c\u8272\u4e0e\u900f\u660e\u5ea6</div>
                </div>
                <div class="gg-toolbar-head-actions">
                    <button id="gg-toolbar-reset" class="tool-btn gg-toolbar-icon-btn" data-tooltip="\u6062\u590d\u9ed8\u8ba4\u5de5\u5177\u680f\u6837\u5f0f" type="button">
                        ${ggIcon("reset", 18)}
                    </button>
                    <button id="gg-toolbar-close" class="tool-btn gg-toolbar-icon-btn" data-tooltip="\u5173\u95ed" type="button">
                        ${ggIcon("clear", 18)}
                    </button>
                </div>
            </div>
            <div class="gg-toolbar-settings-card">
                <div class="gg-toolbar-settings-row">
                    <div class="gg-toolbar-settings-label">\u80cc\u666f\u989c\u8272</div>
                    <div class="gg-toolbar-settings-value" id="gg-toolbar-color-hex">#FFFFFF</div>
                </div>
                <div class="gg-toolbar-settings-color-row">
                    <button id="gg-toolbar-bg-chip" class="tool-btn gg-toolbar-color-chip" data-tooltip="\u5de5\u5177\u680f\u989c\u8272" type="button">
                        <span class="color-dot" style="background:#ffffff;"></span>
                    </button>
                    <input id="gg-toolbar-bg-input" type="color" value="#ffffff" class="gg-toolbar-color-input">
                    <div class="gg-toolbar-color-presets">
                        <button class="gg-toolbar-swatch" type="button" data-color="#f8fafc" style="background:#f8fafc;"></button>
                        <button class="gg-toolbar-swatch" type="button" data-color="#eff6ff" style="background:#eff6ff;"></button>
                        <button class="gg-toolbar-swatch" type="button" data-color="#ecfdf5" style="background:#ecfdf5;"></button>
                        <button class="gg-toolbar-swatch" type="button" data-color="#f5f3ff" style="background:#f5f3ff;"></button>
                    </div>
                </div>
            </div>
            <div class="gg-toolbar-settings-card">
                <div class="gg-toolbar-settings-row">
                    <div class="gg-toolbar-settings-label">\u80cc\u666f\u900f\u660e\u5ea6</div>
                    <div class="gg-toolbar-settings-value" id="gg-toolbar-opacity-label">100%</div>
                </div>
                <div class="gg-toolbar-slider-row">
                    ${ggIcon("opacity", 18)}
                    <input id="gg-toolbar-opacity-input" type="range" min="0" max="100" step="1" value="100" class="gg-toolbar-opacity-input">
                </div>
            </div>
        `;
        document.body.appendChild(toolbarSettings);

        const style = document.createElement("style");
        style.textContent = `
            #gg-nodes-panel .tool-btn {
                width: 30px;
                height: 30px;
                border-radius: 8px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                color: var(--gg-ui-ink);
                transition: color 0.16s ease, background 0.16s ease, transform 0.16s ease, border-color 0.16s ease;
            }
            #gg-nodes-panel .tool-btn:hover,
            #gg-nodes-panel .tool-btn.active,
            #gg-toolbar-settings .tool-btn:hover {
                color: var(--gg-ui-accent) !important;
                background: var(--gg-ui-accent-soft) !important;
            }
            #gg-nodes-panel .tool-btn:hover {
                transform: translateY(-1px);
            }
            /* 迷你按钮的配色交给设计层（.gg-ui-top-button），这里不再单写一份。 */
            #gg-toolbar-top-switch {
                /* 设计稿 13:26：顶栏 4 枚主开关 32×32 / r8（G 标入口见 #gg-top-tools-button 34 / r9） */
                --gg-top-control-size: 32px;
                --gg-top-control-radius: 8px;
                /* 只在「顶栏宿主找不到、退回固定定位」时才用到，默认跟主题走 */
                --gg-top-switch-bg: var(--gg-panel, rgba(23,27,36,0.94));
                --gg-top-switch-border: var(--gg-divider, rgba(148,163,184,0.22));
                --gg-top-switch-shadow: 0 8px 22px rgba(15,23,42,0.18);
                --gg-top-switch-shadow: 0 8px 22px rgba(15,23,42,0.1);
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                padding: 2px;
                min-height: 38px;
                box-sizing: border-box;
                flex: 0 0 auto;
            }
            #gg-toolbar-top-switch.gg-toolbar-menu-host,
            #gg-toolbar-top-switch.gg-toolbar-legacy-host {
                position: static;
                margin-inline: 2px;
                z-index: auto;
                background: transparent;
                border: 0;
                box-shadow: none;
            }
            #gg-memory-cleanup-buttons.gg-memory-menu-host + #gg-toolbar-top-switch,
            #gg-memory-cleanup-buttons.gg-memory-legacy-host + #gg-toolbar-top-switch {
                margin-left: -6px;
            }
            #gg-toolbar-top-switch.gg-toolbar-floating-host {
                position: fixed;
                top: 18px;
                right: clamp(96px, 21vw, 430px);
                z-index: 99999;
                padding: 4px;
                border: 1px solid var(--gg-top-switch-border);
                border-radius: 12px;
                background: var(--gg-top-switch-bg);
                box-shadow: var(--gg-top-switch-shadow);
                backdrop-filter: blur(14px);
            }
            #gg-toolbar-top-switch.gg-toolbar-hidden {
                display: none !important;
            }
            #gg-toolbar-top-switch .gg-toolbar-top-button {
                position: relative;
                width: var(--gg-top-control-size) !important;
                min-width: var(--gg-top-control-size) !important;
                max-width: var(--gg-top-control-size) !important;
                height: var(--gg-top-control-size) !important;
                border-radius: var(--gg-top-control-radius) !important;
                box-sizing: border-box;
                overflow: hidden;
                isolation: isolate;
                line-height: 0 !important;
                touch-action: manipulation;
                transform-origin: center;
            }
            /* 开 / 关 / 悬停的配色由设计层（.gg-ui-top-button）统一决定。
               这里以前还写了一份 gg-state-off 的白底和一圈 ::after 白色内描边，
               深色主题下「关」就成了白板、开态还多一道亮白线。 */
            #gg-toolbar-top-switch .gg-toolbar-top-button .gg-ui-icon {
                width: 18px;
                height: 18px;
                pointer-events: none;
            }
            #gg-toolbar-top-switch.gg-toolbar-floating-host .gg-toolbar-top-button {
                --gg-top-control-size: 40px;
                --gg-top-control-radius: 10px;
            }
            @media (max-width: 760px) {
                #gg-toolbar-top-switch.gg-toolbar-floating-host {
                    top: 12px;
                    right: 12px;
                }
                #gg-toolbar-top-switch.gg-toolbar-floating-host .gg-toolbar-top-button {
                    --gg-top-control-size: 38px;
                }
            }
            #gg-nodes-panel .color-section,
            #gg-nodes-panel .main-section {
                width: 100%;
            }
            #gg-nodes-panel #btn-color-node,
            #gg-nodes-panel #btn-color-body,
            #gg-nodes-panel #btn-color-title {
                display: none !important;
            }
            #gg-color-mode-menu .tool-btn {
                display: inline-flex !important;
            }
            #gg-color-mode-menu {
                min-width: 156px;
                padding: 10px;
                border-radius: 14px;
                border: 1px solid var(--gg-divider);
                background: var(--gg-panel);
                box-shadow: 0 16px 36px rgba(15,23,42,0.22);
                backdrop-filter: blur(14px);
            }
            #gg-color-mode-menu::after {
                content: "";
                position: absolute;
                left: 50%;
                bottom: -7px;
                width: 14px;
                height: 14px;
                background: inherit;
                border-right: 1px solid var(--gg-divider);
                border-bottom: 1px solid var(--gg-divider);
                transform: translateX(-50%) rotate(45deg);
                border-bottom-right-radius: 4px;
            }
            #gg-color-mode-menu {
                display: none;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 8px;
            }
            #gg-color-mode-menu .tool-btn {
                width: 40px;
                height: 40px;
                border-radius: 12px;
                border: 1px solid var(--gg-divider);
                background: var(--gg-btn) !important;
                color: var(--gg-ink);
                transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease, background 0.16s ease;
            }
            #gg-color-mode-menu .tool-btn:hover {
                transform: translateY(-1px);
                background: var(--gg-btn-hover) !important;
            }
            #gg-color-mode-menu .tool-btn.active {
                transform: translateY(-1px);
                color: var(--gg-accent) !important;
                border-color: color-mix(in srgb, var(--gg-accent) 55%, transparent);
                background: color-mix(in srgb, var(--gg-accent) 16%, transparent) !important;
            }
            #gg-nodes-panel .color-dot {
                width: 18px;
                height: 18px;
                border-radius: 50%;
                display: block;
                border: 1px solid rgba(0,0,0,0.16);
                box-shadow: inset 0 0 0 1px rgba(255,255,255,0.35);
            }
            #gg-nodes-panel .custom-dot {
                position: relative;
            }
            #gg-nodes-panel .custom-dot::after {
                content: "";
                position: absolute;
                inset: 5px;
                border-left: 2px solid rgba(255,255,255,0.9);
                border-top: 2px solid rgba(255,255,255,0.9);
                transform: rotate(45deg);
                filter: drop-shadow(0 0 1px rgba(0,0,0,0.35));
            }
            #gg-toolbar-settings .tool-btn {
                width: 34px;
                height: 34px;
                border-radius: 10px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                color: var(--gg-ui-ink);
            }
            #gg-toolbar-settings .gg-toolbar-settings-head {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 12px;
                margin-bottom: 12px;
            }
            #gg-toolbar-settings .gg-toolbar-head-actions {
                display: flex;
                align-items: center;
                gap: 8px;
                flex: 0 0 auto;
            }
            #gg-toolbar-settings .gg-toolbar-settings-title {
                font-size: 14px;
                font-weight: 700;
                line-height: 1.2;
                color: var(--gg-ui-ink);
            }
            #gg-toolbar-settings .gg-toolbar-settings-subtitle {
                margin-top: 4px;
                font-size: 11px;
                line-height: 1.4;
                color: var(--gg-ui-muted);
            }
            #gg-toolbar-settings .gg-toolbar-icon-btn {
                border: 1px solid var(--gg-divider);
                background: var(--gg-btn);
            }
            #gg-toolbar-settings .gg-toolbar-settings-card {
                padding: 12px;
                border-radius: 12px;
                background: var(--gg-card);
                border: 1px solid var(--gg-divider);
            }
            #gg-toolbar-settings .gg-toolbar-settings-card + .gg-toolbar-settings-card {
                margin-top: 10px;
            }
            #gg-toolbar-settings .gg-toolbar-settings-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                margin-bottom: 10px;
            }
            #gg-toolbar-settings .gg-toolbar-settings-label {
                font-size: 12px;
                font-weight: 600;
                color: var(--gg-ui-ink);
            }
            #gg-toolbar-settings .gg-toolbar-settings-value {
                font-size: 12px;
                font-weight: 700;
                color: var(--gg-ui-accent);
            }
            #gg-toolbar-settings .gg-toolbar-settings-color-row {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            #gg-toolbar-settings .gg-toolbar-color-chip {
                width: 42px;
                height: 42px;
                border-radius: 12px;
                border: 1px solid var(--gg-divider);
                background: var(--gg-btn);
                flex: 0 0 auto;
            }
            #gg-toolbar-settings .gg-toolbar-color-chip .color-dot {
                width: 24px;
                height: 24px;
                border-radius: 8px;
                border: 1px solid var(--gg-divider);
            }
            #gg-toolbar-settings .gg-toolbar-color-input {
                width: 44px;
                height: 42px;
                padding: 4px;
                border-radius: 12px;
                border: 1px solid var(--gg-divider);
                background: var(--gg-btn);
                cursor: pointer;
            }
            #gg-toolbar-settings .gg-toolbar-color-presets {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 8px;
                flex: 1;
            }
            #gg-toolbar-settings .gg-toolbar-swatch {
                width: 100%;
                aspect-ratio: 1;
                border-radius: 10px;
                border: 1px solid var(--gg-divider);
                cursor: pointer;
                transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
            }
            #gg-toolbar-settings .gg-toolbar-swatch:hover {
                transform: translateY(-1px);
            }
            #gg-toolbar-settings .gg-toolbar-swatch.active {
                border-color: color-mix(in srgb, var(--gg-accent) 55%, transparent);
                box-shadow: 0 0 0 2px color-mix(in srgb, var(--gg-accent) 22%, transparent);
                transform: translateY(-1px);
            }
            #gg-toolbar-settings .gg-toolbar-slider-row {
                display: flex;
                align-items: center;
                gap: 10px;
                color: var(--gg-ui-muted);
            }
            #gg-toolbar-settings .gg-toolbar-opacity-input {
                width: 100%;
                margin: 0;
                accent-color: var(--gg-ui-accent);
            }
        `;
        document.head.appendChild(style);

        // 创建迷你图标
        const miniIcon = document.createElement("button");
        miniIcon.id = "gg-nodes-mini";
        miniIcon.type = "button";
        miniIcon.classList.add("gg-toolbar-top-button", "gg-ui-top-button");
        miniIcon.title = "收起工具栏";
        miniIcon.style.cssText = `
            width: 34px; height: 34px;
            border-radius: 8px; cursor: pointer; display: none;
            align-items: center; justify-content: center; padding: 0;
            transition: transform 0.16s ease, background-color 0.16s ease, border-color 0.16s ease, opacity 0.16s ease;
        `;
        miniIcon.innerHTML = ggIcon("toolbarCollapse", 18);
        miniIcon.addEventListener("mouseenter", () => {
            miniIcon.style.transform = "scale(1.08)";
        });
        miniIcon.addEventListener("mouseleave", () => {
            miniIcon.style.transform = "none";
        });
        topSwitchHost.appendChild(miniIcon);

        const floatButtonsIcon = document.createElement("button");
        floatButtonsIcon.id = "gg-float-buttons-mini";
        floatButtonsIcon.type = "button";
        floatButtonsIcon.classList.add("gg-toolbar-top-button", "gg-ui-top-button");
        floatButtonsIcon.title = "关闭文本框与图像悬浮按钮";
        floatButtonsIcon.setAttribute("aria-label", floatButtonsIcon.title);
        floatButtonsIcon.style.cssText = miniIcon.style.cssText;
        floatButtonsIcon.innerHTML = ggIcon("floatingText", 18);
        floatButtonsIcon.addEventListener("mouseenter", () => {
            floatButtonsIcon.style.transform = "scale(1.08)";
        });
        floatButtonsIcon.addEventListener("mouseleave", () => {
            floatButtonsIcon.style.transform = "none";
        });
        topSwitchHost.appendChild(floatButtonsIcon);

        const toast = document.createElement("div");
        toast.style.cssText = `
            position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);
            padding: 12px 24px; border-radius: 9999px; font-size: 14px; font-weight: 600;
            z-index: 100000; white-space: nowrap; color: #fff; pointer-events: none; display: none; opacity: 0;
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        `;
        document.body.appendChild(toast);

        function showToast(msg, type = "error") {
            if (type === "success") return;
            toast.textContent = msg;
            toast.style.background = type === "error" ? "#ff4444" : "#00cc99";
            toast.style.display = "block";
            toast.style.opacity = "1";
            setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => { toast.style.display = "none"; }, 250); }, 1600);
        }

        const tooltip = document.createElement("div");
        tooltip.style.cssText = `
            position: fixed; background: rgba(15,23,42,0.92); color: #fff; font-size: 12px; padding: 6px 12px;
            border-radius: 9px; pointer-events: none; z-index: 100001; white-space: nowrap;
            display: none; opacity: 0; transition: opacity 0.15s; box-shadow: 0 10px 24px rgba(15,23,42,0.22);
        `;
        document.body.appendChild(tooltip);

        let tooltipTimeout;
        const showTooltip = (e, text) => {
            clearTimeout(tooltipTimeout);
            tooltipTimeout = setTimeout(() => {
                const rect = panel.getBoundingClientRect();
                tooltip.textContent = text;
                tooltip.style.left = `${rect.left + rect.width / 2}px`;
                tooltip.style.top = `${rect.top - 30}px`;
                tooltip.style.transform = "translateX(-50%)";
                tooltip.style.display = "block";
                tooltip.style.opacity = "1";
            }, 150);
        };

        // 为面板添加鼠标悬停事件
        panel.addEventListener("mouseover", e => {
            const btn = e.target.closest(".tool-btn");
            if (btn && btn.dataset.tooltip) showTooltip(e, btn.dataset.tooltip);
        });
        panel.addEventListener("mouseout", () => {
            clearTimeout(tooltipTimeout);
            tooltip.style.opacity = "0";
            setTimeout(() => { tooltip.style.display = "none"; }, 150);
        });

        function hexToRgba(hex, alpha) {
            const normalized = hex.replace("#", "");
            const value = parseInt(normalized.length === 3 ? normalized.split("").map(c => c + c).join("") : normalized, 16);
            const r = (value >> 16) & 255;
            const g = (value >> 8) & 255;
            const b = value & 255;
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }

        const toolbarBgInput = document.getElementById("gg-toolbar-bg-input");
        const toolbarBgChip = document.getElementById("gg-toolbar-bg-chip");
        const toolbarOpacityInput = document.getElementById("gg-toolbar-opacity-input");
        const toolbarOpacityLabel = document.getElementById("gg-toolbar-opacity-label");
        const toolbarColorHex = document.getElementById("gg-toolbar-color-hex");
        const toolbarResetButton = document.getElementById("gg-toolbar-reset");
        const toolbarCloseButton = document.getElementById("gg-toolbar-close");
        const TOOLBAR_SETTINGS_STATE_KEY = "ggNodes_toolbarSettingsState";

        function refreshToolbarSwatches(color) {
            const normalized = (color || "").toLowerCase();
            toolbarSettings.querySelectorAll(".gg-toolbar-swatch").forEach(button => {
                button.classList.toggle("active", (button.dataset.color || "").toLowerCase() === normalized);
            });
        }

        function loadToolbarSettingsState() {
            try {
                return JSON.parse(getUserItem(TOOLBAR_SETTINGS_STATE_KEY) || "{}");
            } catch (error) {
                console.error("Failed to load toolbar settings state:", error);
                return {};
            }
        }

        function saveToolbarSettingsState(extra = {}) {
            const current = loadToolbarSettingsState();
            const nextState = {
                ...current,
                left: toolbarSettings.style.left || current.left || "",
                top: toolbarSettings.style.top || current.top || "",
                open: toolbarSettings.style.display === "block",
                ...extra,
            };
            setUserItem(TOOLBAR_SETTINGS_STATE_KEY, JSON.stringify(nextState));
        }

        // 用户没动过「工具栏外观」时，一切跟着主题走；动过才用他选的颜色覆盖。
        // 以前默认值就是 #ffffff / 100%，于是深色主题里整个工具栏、每个顶栏按钮都被涂成白色。
        let toolbarStyleCustomized = false;

        function clearToolbarStyleOverrides() {
            for (const element of [panel, miniIcon, floatButtonsIcon, toolbarSettings]) {
                if (!element) continue;
                element.style.removeProperty("background");
                element.style.removeProperty("border-color");
                element.style.removeProperty("color");
                element.style.removeProperty("box-shadow");
            }
            const root = document.documentElement.style;
            root.removeProperty("--gg-toolbar-button-bg");
            root.removeProperty("--gg-toolbar-button-border");
            root.removeProperty("--gg-toolbar-button-color");
            topSwitchHost.style.removeProperty("--gg-top-switch-bg");
            topSwitchHost.style.removeProperty("--gg-top-switch-border");
            topSwitchHost.style.removeProperty("--gg-top-switch-shadow");
            document.getElementById("gg-color-mode-menu")?.querySelectorAll(".tool-btn").forEach((element) => {
                element.style.removeProperty("border-color");
                element.style.removeProperty("background");
                element.style.removeProperty("color");
                element.style.removeProperty("box-shadow");
            });
            toolbarSettings.querySelectorAll(".gg-toolbar-settings-title, .gg-toolbar-settings-subtitle, .gg-toolbar-settings-label, .gg-toolbar-settings-value").forEach((element) => {
                element.style.removeProperty("color");
            });
            toolbarSettings.querySelectorAll(".gg-toolbar-settings-card, .gg-toolbar-icon-btn, .gg-toolbar-color-chip, .gg-toolbar-color-input").forEach((element) => {
                element.style.removeProperty("border-color");
                element.style.removeProperty("background");
                element.style.removeProperty("box-shadow");
            });
            removeUserItem("ggNodes_toolbarStyle");
        }

        function applyToolbarStyle(customized = true) {
            toolbarStyleCustomized = customized === true;
            if (!toolbarStyleCustomized) {
                clearToolbarStyleOverrides();
                toolbarOpacityLabel.textContent = `${toolbarOpacityInput.value}%`;
                toolbarColorHex.textContent = String(toolbarBgInput.value || "#ffffff").toUpperCase();
                refreshToolbarSwatches(toolbarBgInput.value || "#ffffff");
                return;
            }
            const color = toolbarBgInput.value || "#ffffff";
            const opacity = Number(toolbarOpacityInput.value || 100) / 100;
            const background = hexToRgba(color, opacity);
            const panelTint = mixHex(color, "#ffffff", 0.78);
            const panelTintStrong = mixHex(color, "#ffffff", 0.62);
            const accent = shadeHex(color, -42);
            const accentSoft = mixHex(accent, "#ffffff", 0.45);
            const borderTone = hexToRgba(shadeHex(color, -18), 0.18);
            const shadowTone = hexToRgba(shadeHex(color, -64), 0.18);
            const modeMenu = document.getElementById("gg-color-mode-menu");
            panel.style.background = background;
            miniIcon.style.background = background;
            miniIcon.style.borderColor = borderTone;
            miniIcon.style.color = accent;
            floatButtonsIcon.style.background = background;
            floatButtonsIcon.style.borderColor = borderTone;
            floatButtonsIcon.style.color = accent;
            toolbarSettings.style.background = `linear-gradient(180deg, ${hexToRgba(panelTint, 0.96)} 0%, ${hexToRgba(panelTintStrong, 0.92)} 100%)`;
            toolbarSettings.style.borderColor = hexToRgba(color, 0.28);
            toolbarSettings.style.boxShadow = `0 18px 42px ${shadowTone}, 0 4px 14px ${hexToRgba(color, 0.08)}`;
            toolbarSettings.style.color = accent;
            if (modeMenu) {
                modeMenu.style.background = `linear-gradient(180deg, ${hexToRgba(panelTint, 0.96)} 0%, ${hexToRgba(panelTintStrong, 0.92)} 100%)`;
                modeMenu.style.borderColor = hexToRgba(color, 0.28);
                modeMenu.style.boxShadow = `0 16px 36px ${shadowTone}, 0 4px 12px ${hexToRgba(color, 0.08)}`;
                modeMenu.querySelectorAll(".tool-btn").forEach(element => {
                    element.style.borderColor = borderTone;
                    element.style.background = hexToRgba(mixHex(color, "#ffffff", 0.74), 0.82);
                    element.style.color = accent;
                });
                modeMenu.querySelectorAll(".tool-btn.active").forEach(element => {
                    element.style.boxShadow = `0 0 0 2px ${hexToRgba(color, 0.16)}, inset 0 1px 0 ${hexToRgba("#ffffff", 0.88)}`;
                    element.style.borderColor = hexToRgba(color, 0.36);
                });
            }
            topSwitchHost.style.setProperty("--gg-top-switch-bg", hexToRgba(mixHex(color, "#ffffff", 0.78), Math.max(0.78, opacity)));
            topSwitchHost.style.setProperty("--gg-top-switch-border", borderTone);
            topSwitchHost.style.setProperty("--gg-top-switch-shadow", `0 8px 22px ${hexToRgba(shadeHex(color, -48), 0.14)}`);
            toolbarBgChip.querySelector(".color-dot").style.background = color;
            toolbarOpacityLabel.textContent = `${toolbarOpacityInput.value}%`;
            toolbarColorHex.textContent = color.toUpperCase();
            toolbarSettings.querySelectorAll(".gg-toolbar-settings-title, .gg-toolbar-settings-label, .gg-toolbar-settings-value").forEach(element => {
                element.style.color = accent;
            });
            toolbarSettings.querySelectorAll(".gg-toolbar-settings-subtitle").forEach(element => {
                element.style.color = accentSoft;
            });
            toolbarSettings.querySelectorAll(".gg-toolbar-settings-card, .gg-toolbar-icon-btn, .gg-toolbar-color-chip, .gg-toolbar-color-input").forEach(element => {
                element.style.borderColor = borderTone;
            });
            toolbarSettings.querySelectorAll(".gg-toolbar-settings-card").forEach(element => {
                element.style.background = hexToRgba(mixHex(color, "#ffffff", 0.7), 0.76);
                element.style.boxShadow = `inset 0 1px 0 ${hexToRgba("#ffffff", 0.8)}`;
            });
            toolbarSettings.querySelectorAll(".gg-toolbar-icon-btn, .gg-toolbar-color-chip, .gg-toolbar-color-input").forEach(element => {
                element.style.background = hexToRgba(mixHex(color, "#ffffff", 0.74), 0.78);
            });
            toolbarSettings.querySelectorAll(".gg-toolbar-swatch").forEach(element => {
                element.style.boxShadow = `inset 0 1px 0 ${hexToRgba("#ffffff", 0.55)}`;
            });
            refreshToolbarSwatches(color);
            setUserItem("ggNodes_toolbarStyle", JSON.stringify({
                color,
                opacity: toolbarOpacityInput.value,
            }));
        }

        function loadToolbarStyle() {
            let savedStyle = {};
            try {
                savedStyle = JSON.parse(getUserItem("ggNodes_toolbarStyle") || "{}");
                if (savedStyle.color) toolbarBgInput.value = savedStyle.color;
                if (savedStyle.opacity) toolbarOpacityInput.value = savedStyle.opacity;
            } catch (e) {
                console.error("Failed to load toolbar style:", e);
            }
            // 只有用户真的选过颜色/透明度才覆盖主题；没选过就跟着深浅色走。
            applyToolbarStyle(Boolean(savedStyle.color || savedStyle.opacity));
        }

        function showToolbarSettings(event) {
            event.preventDefault();
            event.stopPropagation();
            if (toolbarSettings.style.display === "block") {
                hideToolbarSettings();
                return;
            }
            const rect = panel.getBoundingClientRect();
            const savedState = loadToolbarSettingsState();
            const width = 248;
            const defaultLeft = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left + rect.width / 2 - width / 2));
            toolbarSettings.style.left = savedState.left || `${defaultLeft}px`;
            toolbarSettings.style.top = savedState.top || `${Math.max(8, rect.top - 180)}px`;
            toolbarSettings.style.display = "block";
            if (!savedState.left || !savedState.top) {
                const finalTop = Math.max(8, rect.top - toolbarSettings.offsetHeight - 16);
                toolbarSettings.style.left = `${defaultLeft}px`;
                toolbarSettings.style.top = `${finalTop}px`;
            }
            saveToolbarSettingsState({ open: true });
        }

        function hideToolbarSettings() {
            toolbarSettings.style.display = "none";
            saveToolbarSettingsState({ open: false });
        }

        // 注意：这两个回调会被当成事件处理函数调用，第一个参数是 Event，
        // 所以必须包一层显式传 true，否则「是否自定义」会被事件对象污染。
        toolbarBgInput.oninput = () => applyToolbarStyle(true);
        toolbarOpacityInput.oninput = () => applyToolbarStyle(true);
        toolbarResetButton.onclick = () => {
            toolbarBgInput.value = "#ffffff";
            toolbarOpacityInput.value = "100";
            // 重置 = 回到跟随主题，不是「把主题钉成白色」
            applyToolbarStyle(false);
        };
        toolbarCloseButton.onclick = hideToolbarSettings;
        toolbarSettings.querySelectorAll(".gg-toolbar-swatch").forEach(button => {
            button.onclick = () => {
                toolbarBgInput.value = button.dataset.color || "#ffffff";
                applyToolbarStyle();
            };
        });
        toolbarSettings.addEventListener("mousedown", e => e.stopPropagation());
        toolbarSettings.addEventListener("click", e => e.stopPropagation());
        loadToolbarStyle();

        let isDraggingToolbarSettings = false;
        let toolbarSettingsOffsetX = 0;
        let toolbarSettingsOffsetY = 0;

        toolbarSettings.addEventListener("mousedown", event => {
            const handle = event.target.closest(".gg-toolbar-settings-head");
            const interactive = event.target.closest("button, input, select, textarea, label");
            if (!handle || interactive || event.button !== 0) return;
            const rect = toolbarSettings.getBoundingClientRect();
            isDraggingToolbarSettings = true;
            toolbarSettingsOffsetX = event.clientX - rect.left;
            toolbarSettingsOffsetY = event.clientY - rect.top;
        });
        document.addEventListener("mousemove", event => {
            if (!isDraggingToolbarSettings) return;
            const left = Math.min(window.innerWidth - toolbarSettings.offsetWidth - 8, Math.max(8, event.clientX - toolbarSettingsOffsetX));
            const top = Math.min(window.innerHeight - toolbarSettings.offsetHeight - 8, Math.max(8, event.clientY - toolbarSettingsOffsetY));
            toolbarSettings.style.left = `${left}px`;
            toolbarSettings.style.top = `${top}px`;
        });
        document.addEventListener("mouseup", () => {
            if (!isDraggingToolbarSettings) return;
            isDraggingToolbarSettings = false;
            saveToolbarSettingsState({ open: toolbarSettings.style.display === "block" });
        });

        const savedToolbarSettingsState = loadToolbarSettingsState();
        if (savedToolbarSettingsState.open) {
            const rect = panel.getBoundingClientRect();
            toolbarSettings.style.left = savedToolbarSettingsState.left || `${Math.max(8, rect.left)}px`;
            toolbarSettings.style.top = savedToolbarSettingsState.top || `${Math.max(8, rect.top - 180)}px`;
            toolbarSettings.style.display = "block";
        }

        let lastPosition = { left: "50%", bottom: "30px" };

        const placeTopTools = () => {
            if (!topToolsGroup) return;
            const settingsGroup = app.menu?.settingsGroup?.element;
            if (settingsGroup?.parentElement) {
                if (settingsGroup.previousElementSibling !== topToolsGroup) settingsGroup.before(topToolsGroup);
            } else {
                const queueButton = document.getElementById("queue-button");
                if (queueButton?.parentElement && queueButton.nextElementSibling !== topToolsGroup) {
                    queueButton.insertAdjacentElement("afterend", topToolsGroup);
                }
                else if (topToolsGroup.parentElement !== document.body) document.body.appendChild(topToolsGroup);
            }
            collectTopGroups();
        };

        const placeTopSwitch = () => {
            if (!topSwitchHost) return;
            topSwitchHost.classList.remove("gg-toolbar-menu-host", "gg-toolbar-legacy-host", "gg-toolbar-floating-host");

            const settingsGroup = app.menu?.settingsGroup?.element;
            if (settingsGroup?.parentElement) {
                settingsGroup.before(topSwitchHost);
                topSwitchHost.classList.add("gg-toolbar-menu-host");
                return;
            }

            const queueButton = document.getElementById("queue-button");
            if (queueButton?.parentElement) {
                queueButton.insertAdjacentElement("afterend", topSwitchHost);
                topSwitchHost.classList.add("gg-toolbar-legacy-host");
                return;
            }

            if (topSwitchHost.parentElement !== document.body) {
                document.body.appendChild(topSwitchHost);
            }
            topSwitchHost.classList.add("gg-toolbar-floating-host");
        };

        const updateMiniIconState = (visible) => {
            placeTopTools();
            placeTopSwitch();
            const shouldShowSwitch = toolbarEnabled && topSwitchEnabled;
            topSwitchHost.classList.toggle("gg-toolbar-hidden", !shouldShowSwitch);
            miniIcon.style.display = shouldShowSwitch ? "flex" : "none";
            floatButtonsIcon.style.display = shouldShowSwitch ? "flex" : "none";
            miniIcon.classList.toggle("active", visible);
            miniIcon.classList.toggle("gg-state-on", visible);
            miniIcon.classList.toggle("gg-state-off", !visible);
            miniIcon.setAttribute("aria-pressed", visible ? "true" : "false");
            floatButtonsIcon.classList.toggle("active", floatButtonsEnabled);
            floatButtonsIcon.classList.toggle("gg-state-on", floatButtonsEnabled);
            floatButtonsIcon.classList.toggle("gg-state-off", !floatButtonsEnabled);
            floatButtonsIcon.setAttribute("aria-pressed", floatButtonsEnabled ? "true" : "false");
            miniIcon.title = visible ? "收起工具栏" : "展开工具栏";
            miniIcon.setAttribute("aria-label", miniIcon.title);
            miniIcon.innerHTML = ggIcon(visible ? "toolbarCollapse" : "toolbarExpand", 18);
            miniIcon.style.opacity = visible ? "0.72" : "1";
            floatButtonsIcon.title = floatButtonsEnabled ? "关闭文本框与图像悬浮按钮" : "启用文本框与图像悬浮按钮";
            floatButtonsIcon.setAttribute("aria-label", floatButtonsIcon.title);
            floatButtonsIcon.style.opacity = floatButtonsEnabled ? "1" : "0.58";
        };

        const applyFloatButtonsEnabled = (enabled) => {
            floatButtonsEnabled = enabled !== false;
            window.__ggApplyFloatButtons?.(floatButtonsEnabled);
            updateMiniIconState(panel.style.display !== "none");
        };

        const setPanelHidden = () => {
            lastPosition = { left: panel.style.left, top: panel.style.top, bottom: panel.style.bottom };
            panel.style.display = "none";
            hideToolbarSettings();
            updateMiniIconState(false);
            setUserItem("ggNodes_visible", "false");
        };

        const hidePanel = () => {
            if (toolbarEnabled && !topSwitchEnabled) {
                updateMiniIconState(panel.style.display !== "none");
                return;
            }
            setPanelHidden();
        };

        const showPanel = () => {
            panel.style.display = "flex";
            panel.style.left = lastPosition.left || "50%";
            panel.style.top = lastPosition.top || "auto";
            panel.style.bottom = lastPosition.bottom || "30px";
            panel.style.transform = lastPosition.top ? "none" : "translateX(-50%)";
            updateMiniIconState(true);
            setUserItem("ggNodes_visible", "true");
        };

        const applyToolbarEnabled = (enabled) => {
            toolbarEnabled = enabled !== false;
            if (toolbarEnabled) {
                if (topSwitchEnabled && getUserItem("ggNodes_visible") === "false") {
                    setPanelHidden();
                } else {
                    showPanel();
                }
            } else {
                panel.style.display = "none";
                hideToolbarSettings();
                updateMiniIconState(false);
                setUserItem("ggNodes_visible", "false");
            }
        };

        const applyToolbarTopSwitch = (enabled) => {
            topSwitchEnabled = enabled !== false;
            if (toolbarEnabled && !topSwitchEnabled && panel.style.display === "none") {
                showPanel();
                return;
            }
            updateMiniIconState(panel.style.display !== "none");
        };

        window.__ggToolbarApplyEnabled = applyToolbarEnabled;
        window.__ggApplyToolbar = applyToolbarEnabled;
        window.__ggApplyToolbarTopSwitch = applyToolbarTopSwitch;
        window.__ggApplyFloatButtonsTopSwitch = applyFloatButtonsEnabled;

        try {
            app.ui?.settings?.addEventListener?.(`${SETTINGS.menuDisplay}.change`, () => {
                requestAnimationFrame(() => updateMiniIconState(panel.style.display !== "none"));
            });
        } catch {
            // Older ComfyUI builds may not expose this settings event.
        }

        requestAnimationFrame(() => updateMiniIconState(panel.style.display !== "none"));
        setTimeout(() => updateMiniIconState(panel.style.display !== "none"), 800);
        setTimeout(() => {
            placeTopTools();
            collectTopGroups();
        }, 1800);

        panel.addEventListener("contextmenu", e => {
            e.preventDefault();
            hidePanel();
        });
        miniIcon.addEventListener("click", e => {
            e.preventDefault();
            if (panel.style.display === "none") showPanel();
            else hidePanel();
        });
        miniIcon.addEventListener("contextmenu", e => { e.preventDefault(); });
        floatButtonsIcon.addEventListener("click", e => {
            e.preventDefault();
            const nextEnabled = !floatButtonsEnabled;
            applyFloatButtonsEnabled(nextEnabled);
            setSettingValue(SETTINGS.floatButtonsEnabled, nextEnabled);
        });
        floatButtonsIcon.addEventListener("contextmenu", e => { e.preventDefault(); });
        panel.addEventListener("auxclick", e => {
            if (e.button === 1) showToolbarSettings(e);
        });
        panel.addEventListener("mouseup", e => {
            if (e.button === 1) showToolbarSettings(e);
        });
        document.addEventListener("mousedown", e => {
            if (!toolbarSettings.contains(e.target) && !panel.contains(e.target) && !topSwitchHost.contains(e.target)) hideToolbarSettings();
        });

        // 为面板添加拖拽功能
        let isDragging = false, offsetX, offsetY;
        
        panel.addEventListener("mousedown", e => {
            if (e.button === 1) {
                showToolbarSettings(e);
                return;
            }
            if (e.button !== 0) return;
            if (e.target.closest("button") || e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            panel.style.cursor = "grabbing";
            panel.style.transform = "none";
        });

        document.addEventListener("mousemove", e => {
            if (!isDragging) return;
            panel.style.left = `${e.clientX - offsetX}px`;
            panel.style.top = `${e.clientY - offsetY}px`;
            panel.style.bottom = "auto";
        });

        document.addEventListener("mouseup", () => {
            if (isDragging) {
                isDragging = false;
                panel.style.cursor = "grab";
                lastPosition = { left: panel.style.left, top: panel.style.top, bottom: "auto" };
                setUserItem("ggNodes_pos", JSON.stringify(lastPosition));
            }
        });

        // 加载保存的位置
        const saved = getUserItem("ggNodes_pos");
        if (saved) {
            try {
                const p = JSON.parse(saved);
                panel.style.left = p.left;
                panel.style.top = p.top;
                panel.style.bottom = "auto";
                panel.style.transform = "none";
                lastPosition = { left: p.left, top: p.top, bottom: "auto" };
            } catch (e) {
                console.error("Failed to load panel position:", e);
            }
        }

        function isGraphNode(value) {
            return !!value && typeof value === "object" && (
                isArrayLikeNumber(value.pos) ||
                isArrayLikeNumber(value.size) ||
                typeof value.id === "number" ||
                typeof value.setDirtyCanvas === "function"
            );
        }

        function isColorTarget(value) {
            return isGraphNode(value) || isOfficialColorable(value) || (
                !!value && typeof value === "object" && isArrayLikeNumber(value._bounding)
            );
        }

        function isGraphGroup(value) {
            return !!value && typeof value === "object" && (
                value.constructor === window.LiteGraph?.LGraphGroup ||
                typeof value.font_size === "number" ||
                isArrayLikeNumber(value._bounding)
            );
        }

        function isArrayLikeNumber(v) {
            return v != null
                && typeof v === "object"
                && typeof v.length === "number"
                && v.length >= 2
                && typeof v[0] === "number"
                && typeof v[1] === "number";
        }

        function normalizeSelectedNodes(value) {
            if (!value) return [];
            let values = [];
            if (Array.isArray(value)) values = value;
            else if (value instanceof Set) values = Array.from(value);
            else if (typeof value === "object") values = Object.values(value);
            return values.filter(isGraphNode);
        }

        function normalizeColorTargets(value) {
            if (!value) return [];
            let values = [];
            if (Array.isArray(value)) values = value;
            else if (value instanceof Set) values = Array.from(value);
            else if (typeof value === "object") values = Object.values(value);
            return values.filter(isColorTarget);
        }

        function getGraphNodes() {
            const graph = getActiveCanvas()?.graph || app.canvas?.graph || app.graph;
            const nodes = graph?._nodes || [];
            return Array.isArray(nodes) ? nodes : Object.values(nodes);
        }

        function getGraphGroups() {
            const graph = getActiveCanvas()?.graph || app.canvas?.graph || app.graph;
            const groups = graph?._groups || [];
            return Array.isArray(groups) ? groups : Object.values(groups);
        }

        function getSelectedNodesFromGraph() {
            return getGraphNodes().filter(n => n && (n.selected || n.is_selected));
        }

        function uniqueNodes(nodes) {
            return [...new Set(nodes.filter(isGraphNode))];
        }

        function uniqueColorTargets(targets) {
            return [...new Set(targets.filter(isColorTarget))];
        }

        function getCanvasSelectedNodes() {
            const activeCanvas = getActiveCanvas();
            const selected = normalizeSelectedNodes(activeCanvas?.selected_nodes);
            if (selected.length > 0) return selected;
            return [];
        }

        function getActiveCanvas() {
            return window.LGraphCanvas?.active_canvas || app.canvas || window.canvas;
        }

        function isOfficialColorable(target) {
            return !!target &&
                typeof target === "object" &&
                typeof target.setColorOption === "function" &&
                typeof target.getColorOption === "function";
        }

        function getSelectedNodes() {
            const canvasSelected = getCanvasSelectedNodes();
            if (canvasSelected.length > 0) return uniqueNodes(canvasSelected);

            if (app.graph && app.graph.selected_nodes) {
                const selected = normalizeSelectedNodes(app.graph.selected_nodes);
                if (selected.length > 0) return uniqueNodes(selected);
            }
            
            const selectedFromGraph = getSelectedNodesFromGraph();
            if (selectedFromGraph.length > 0) return uniqueNodes(selectedFromGraph);

            if (app.graph && app.graph.getSelection) {
                const selection = uniqueNodes(normalizeSelectedNodes(app.graph.getSelection()));
                if (selection && selection.length > 0) return selection;
            }
            
            if (window.canvas && window.canvas.selected_nodes) {
                const selected = normalizeSelectedNodes(window.canvas.selected_nodes);
                if (selected.length > 0) return uniqueNodes(selected);
            }
            
            if (window.LiteGraph && window.LiteGraph.getSelectedNodes) {
                const selected = uniqueNodes(normalizeSelectedNodes(window.LiteGraph.getSelectedNodes()));
                if (selected && selected.length > 0) return selected;
            }
            
            return [];
        }

        function getSelectedColorTargets() {
            const activeCanvas = getActiveCanvas();
            const targets = [
                ...normalizeColorTargets(activeCanvas?.selected_nodes),
                ...normalizeColorTargets(activeCanvas?.selectedItems),
                ...normalizeColorTargets(app.graph?.selected_nodes),
                ...getSelectedNodesFromGraph(),
                ...getGraphGroups().filter(group => group?.selected || group?.is_selected),
            ];
            if (activeCanvas?.selected_group) targets.push(activeCanvas.selected_group);
            if (app.canvas?.selected_group) targets.push(app.canvas.selected_group);
            return uniqueColorTargets(targets);
        }

        const morandiColors = [
            "#b8a99a",
            "#a6b2a2",
            "#9cafb7",
            "#c3a6a0",
            "#b7a6bd",
            "#d1c6a8",
            "#8792a6",
        ];
        const GG_NODE_COLOR_STATE_KEY = "_gg_toolbar_color_state";
        const GG_GROUP_COLOR_STATE_KEY = "gg_toolbar_color_state";
        const GG_COLOR_CLIPBOARD_KEY = "ggNodes_colorClipboard";
        const GG_SIZE_CLIPBOARD_KEY = "ggNodes_sizeClipboard";
        const customColorDefaults = ["#8fa39b", "#c9a7a2"];
        let colorMode = "node";
        let paintAction = null;
        let paintEnabled = false;
        let selectedPaintColor = morandiColors[0];
        let copiedColorState = null;
        let copiedNodeSize = null;
        let oneShotPaintEnabled = false;

        function hexToRgb(hex) {
            const normalized = hex.replace("#", "");
            const value = parseInt(normalized.length === 3 ? normalized.split("").map(c => c + c).join("") : normalized, 16);
            return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
        }

        function rgbToHex(r, g, b) {
            return "#" + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
        }

        function shadeHex(color, amount) {
            const [r, g, b] = hexToRgb(color);
            return rgbToHex(r + amount, g + amount, b + amount);
        }

        function mixHex(color, target = "#ffffff", amount = 0.62) {
            const [r1, g1, b1] = hexToRgb(color);
            const [r2, g2, b2] = hexToRgb(target);
            return rgbToHex(
                r1 + (r2 - r1) * amount,
                g1 + (g2 - g1) * amount,
                b1 + (b2 - b1) * amount
            );
        }

        function markGraphChanged() {
            const activeCanvas = getActiveCanvas();
            app.graph?.change?.();
            app.graph?.setDirtyCanvas?.(true, true);
            app.canvas?.setDirty?.(true, true);
            app.canvas?.setDirtyCanvas?.(true, true);
            activeCanvas?.setDirty?.(true, true);
            activeCanvas?.setDirtyCanvas?.(true, true);
            activeCanvas?.draw?.(true, true);
            requestAnimationFrame(() => {
                activeCanvas?.setDirty?.(true, true);
                activeCanvas?.setDirtyCanvas?.(true, true);
            });
            restorePersistedColors();
        }

        function withGraphChange(nodes, callback) {
            const graphs = new Set();
            nodes.forEach(node => {
                if (node?.graph) graphs.add(node.graph);
            });
            graphs.forEach(graph => graph?.beforeChange?.());
            try {
                callback();
            } finally {
                graphs.forEach(graph => graph?.afterChange?.());
                markGraphChanged();
            }
        }

        function buildColorOption(color) {
            if (colorMode === "node") {
                return {
                    mode: colorMode,
                    color: shadeHex(color, 20),
                    bgcolor: color,
                    groupcolor: color,
                };
            }
            if (colorMode === "body") {
                return {
                    mode: colorMode,
                    color,
                    bgcolor: color,
                    groupcolor: color,
                };
            }
            return {
                mode: colorMode,
                color,
                groupcolor: color,
            };
        }

        function roundRectPath(ctx, x, y, width, height, radius) {
            const r = Math.min(radius, width / 2, height / 2);
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + width - r, y);
            ctx.quadraticCurveTo(x + width, y, x + width, y + r);
            ctx.lineTo(x + width, y + height - r);
            ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
            ctx.lineTo(x + r, y + height);
            ctx.quadraticCurveTo(x, y + height, x, y + height - r);
            ctx.lineTo(x, y + r);
            ctx.quadraticCurveTo(x, y, x + r, y);
            ctx.closePath();
        }

        function isNodes20Mode(canvas = app.canvas) {
            return !!(
                globalThis.LiteGraph?.vueNodesMode
                || canvas?.vueNodesMode
                || app?.vueNodesMode
            );
        }

        function syncDomColorOverlay(node, overlay) {
            let element = node?.domElement ?? node?.element ?? node?.dom_element;
            if (!element && node?.id != null && typeof document !== "undefined") {
                const id = String(node.id);
                element = [...document.querySelectorAll?.(".lg-node[data-node-id], [data-node-id].lg-node") ?? []]
                    .find((candidate) => String(candidate.dataset?.nodeId) === id);
            }
            if (!isNodes20Mode() || !element?.style) return;

            let host = element.querySelector?.(":scope > .gg-toolbar-dom-color-overlay");
            if (!overlay || (!overlay.bodyColor && !overlay.titleColor)) {
                host?.remove();
                return;
            }
            if (!host) {
                host = document.createElement("div");
                host.className = "gg-toolbar-dom-color-overlay";
                Object.assign(host.style, {
                    position: "absolute",
                    inset: "0",
                    pointerEvents: "none",
                    zIndex: "0",
                    borderRadius: "inherit",
                    overflow: "hidden",
                });
                element.append(host);
            }
            if (!element.style.position || element.style.position === "static") element.style.position = "relative";
            host.replaceChildren();
            if (overlay.bodyColor) {
                const body = document.createElement("div");
                Object.assign(body.style, {
                    position: "absolute",
                    inset: "0",
                    background: overlay.bodyColor,
                    opacity: String(overlay.bodyAlpha ?? 0.32),
                });
                host.append(body);
            }
            if (overlay.titleColor) {
                const title = document.createElement("div");
                Object.assign(title.style, {
                    position: "absolute",
                    left: "0",
                    right: "0",
                    top: "0",
                    height: "30px",
                    background: overlay.titleColor,
                    opacity: "0.42",
                });
                host.append(title);
            }
        }

        function ensureColorOverlay(node) {
            if (node._ggColorOverlayInstalled) return;
            const originalOnDrawForeground = node.onDrawForeground;
            node._ggOriginalOnDrawForeground = originalOnDrawForeground;
            node.onDrawForeground = function (ctx) {
                originalOnDrawForeground?.apply(this, arguments);
                const overlay = this._ggColorOverlay;
                if (!overlay) return;

                const titleHeight = window.LiteGraph?.NODE_TITLE_HEIGHT || 30;
                const isCollapsed = !!(this.flags?.collapsed || this.collapsed);
                const width = (isCollapsed ? (this._collapsed_width || this.width || window.LiteGraph?.NODE_COLLAPSED_WIDTH) : this.size?.[0]) || 0;
                const height = this.size?.[1] || 0;
                if (!width) return;

                ctx.save();
                if (overlay.bodyColor && height && !isCollapsed) {
                    ctx.globalAlpha = overlay.bodyAlpha ?? 0.32;
                    ctx.fillStyle = overlay.bodyColor;
                    roundRectPath(ctx, 0, 0, width, height, 8);
                    ctx.fill();
                }
                if (isCollapsed) {
                    const collapsedTitleColor = overlay.titleColor || overlay.bodyColor;
                    if (collapsedTitleColor) {
                        ctx.globalAlpha = 0.42;
                        ctx.fillStyle = collapsedTitleColor;
                        roundRectPath(ctx, 0, -titleHeight, width, titleHeight, 8);
                        ctx.fill();
                    }
                } else if (overlay.titleColor) {
                    ctx.globalAlpha = 0.42;
                    ctx.fillStyle = overlay.titleColor;
                    roundRectPath(ctx, 0, -titleHeight, width, titleHeight, 8);
                    ctx.fill();
                }
                ctx.restore();
            };
            node._ggColorOverlayInstalled = true;
            syncDomColorOverlay(node, node._ggColorOverlay);
        }

        function setColorOverlay(node, option) {
            ensureColorOverlay(node);
            const overlay = node._ggColorOverlay || {};
            if (option.mode === "node") {
                overlay.bodyColor = option.bgcolor || option.color;
                overlay.bodyAlpha = 0.24;
                overlay.titleColor = option.color || option.bgcolor;
            } else if (option.mode === "body") {
                overlay.bodyColor = option.bgcolor || option.color;
                overlay.bodyAlpha = 0.32;
            } else if (option.mode === "title") {
                overlay.titleColor = option.color || option.bgcolor;
            }
            node._ggColorOverlay = overlay;
            syncDomColorOverlay(node, overlay);
        }

        function clearColorOverlay(node) {
            delete node._ggColorOverlay;
            syncDomColorOverlay(node, null);
        }

        function cloneColorState(state) {
            return state ? JSON.parse(JSON.stringify(state)) : null;
        }

        function getOfficialColorOption(target) {
            try {
                return isOfficialColorable(target) ? (target.getColorOption() || null) : null;
            } catch {
                return null;
            }
        }

        function buildNodeStateFromGroupColor(color) {
            if (!color) return null;
            return {
                bodyColor: color,
                bodyAlpha: 0.24,
                titleColor: shadeHex(color, 20),
            };
        }

        function normalizeToolbarColorState(state) {
            if (!state || typeof state !== "object") return null;
            const nodeState = cloneColorState(state.nodeState || state);
            const groupColor = state.groupColor || nodeState?.bodyColor || nodeState?.titleColor || null;
            if (!groupColor && !nodeState?.bodyColor && !nodeState?.titleColor) return null;
            return {
                version: 1,
                sourceType: state.sourceType || "node",
                groupColor,
                nodeState: nodeState || buildNodeStateFromGroupColor(groupColor),
            };
        }

        function loadColorClipboard() {
            try {
                return normalizeToolbarColorState(JSON.parse(getUserItem(GG_COLOR_CLIPBOARD_KEY) || "null"));
            } catch {
                return null;
            }
        }

        function saveColorClipboard(state) {
            copiedColorState = normalizeToolbarColorState(state);
            if (copiedColorState) {
                setUserItem(GG_COLOR_CLIPBOARD_KEY, JSON.stringify(copiedColorState));
            } else {
                removeUserItem(GG_COLOR_CLIPBOARD_KEY);
            }
            refreshColorClipboardButtons();
        }

        function getReadableTargetName(target) {
            return isGraphGroup(target) ? "分组" : "节点";
        }

        function getColorStateFromTarget(target) {
            if (!isColorTarget(target)) return null;

            if (isGraphGroup(target)) {
                const option = getOfficialColorOption(target);
                const groupColor = getPersistedColorState(target)?.groupColor
                    || target.color
                    || option?.groupcolor
                    || option?.color
                    || option?.bgcolor
                    || null;
                if (!groupColor) return null;
                return normalizeToolbarColorState({
                    sourceType: "group",
                    groupColor,
                    nodeState: buildNodeStateFromGroupColor(groupColor),
                });
            }

            const persisted = getPersistedColorState(target) || cloneColorState(target._ggColorOverlay);
            const option = getOfficialColorOption(target);
            const bodyColor = persisted?.bodyColor
                || target.bgcolor
                || target.groupcolor
                || option?.bgcolor
                || option?.groupcolor
                || null;
            const titleColor = persisted?.titleColor
                || target.title_color
                || target.color
                || option?.color
                || null;
            if (!bodyColor && !titleColor) return null;

            return normalizeToolbarColorState({
                sourceType: "node",
                groupColor: target.groupcolor || option?.groupcolor || bodyColor || titleColor,
                nodeState: {
                    bodyColor,
                    bodyAlpha: persisted?.bodyAlpha ?? (bodyColor && titleColor ? 0.24 : 0.32),
                    titleColor,
                },
            });
        }

        function copyColorFromTarget(target) {
            const state = getColorStateFromTarget(target);
            if (!state) {
                showToast(`这个${getReadableTargetName(target)}还没有可复制的上色`, "error");
                return false;
            }
            saveColorClipboard(state);
            showToast(`已取色：${getReadableTargetName(target)}上色信息`, "info");
            return true;
        }

        function applyColorStateToTarget(target, state) {
            const normalized = normalizeToolbarColorState(state);
            if (!target || !normalized) return;

            if (isGraphGroup(target)) {
                const groupColor = normalized.groupColor
                    || normalized.nodeState?.bodyColor
                    || normalized.nodeState?.titleColor;
                if (!groupColor) return;
                if (isOfficialColorable(target)) {
                    target.setColorOption({ groupcolor: groupColor });
                } else {
                    target.color = groupColor;
                }
                target.color = groupColor;
                persistColorState(target);
                target._ggRestoredColorStateHash = JSON.stringify(getPersistedColorState(target));
                return;
            }

            const nodeState = cloneColorState(normalized.nodeState || buildNodeStateFromGroupColor(normalized.groupColor));
            if (!nodeState?.bodyColor && !nodeState?.titleColor) return;

            if (nodeState.bodyColor) {
                target.bgcolor = nodeState.bodyColor;
            } else {
                delete target.bgcolor;
            }

            if (nodeState.titleColor) {
                target.color = nodeState.titleColor;
                target.title_color = nodeState.titleColor;
            } else {
                delete target.color;
                delete target.title_color;
            }

            if (normalized.groupColor || nodeState.bodyColor) {
                target.groupcolor = normalized.groupColor || nodeState.bodyColor;
            } else {
                delete target.groupcolor;
            }

            ensureColorOverlay(target);
            target._ggColorOverlay = nodeState;
            syncDomColorOverlay(target, nodeState);
            persistColorState(target);
            target._ggRestoredColorStateHash = JSON.stringify(getPersistedColorState(target));
            target.setDirtyCanvas?.(true, true);
        }

        function applyColorStateToTargets(targets, state) {
            const normalized = normalizeToolbarColorState(state);
            const validTargets = uniqueColorTargets(targets);
            if (!normalized || validTargets.length === 0) return false;
            withGraphChange(validTargets, () => {
                validTargets.forEach(target => applyColorStateToTarget(target, normalized));
            });
            showToast(`已粘贴上色到 ${validTargets.length} 个目标`, "info");
            return true;
        }

        function refreshColorClipboardButtons() {
            const pickButton = document.getElementById("btn-pick-color");
            const pasteButton = document.getElementById("btn-paste-color");
            pickButton?.classList.toggle("active", paintAction?.type === "pick");
            pasteButton?.classList.toggle("active", paintAction?.type === "paste");
            if (pasteButton) pasteButton.style.opacity = copiedColorState ? "1" : "0.48";
        }

        function startOneShotPaintAction(action) {
            oneShotPaintEnabled = !paintEnabled;
            setPaintEnabled(true);
            paintAction = action;
            refreshColorButtons();
            refreshColorClipboardButtons();
        }

        function finishOneShotPaintAction() {
            const shouldDisable = oneShotPaintEnabled;
            oneShotPaintEnabled = false;
            if (shouldDisable) {
                setPaintEnabled(false);
            } else {
                paintAction = paintEnabled && selectedPaintColor ? { type: "color", color: selectedPaintColor } : null;
                refreshColorClipboardButtons();
            }
        }

        function normalizeNodeSize(size) {
            if (!size || typeof size !== "object" || typeof size.length !== "number" || size.length < 2) return null;
            const width = Number(size[0]);
            const height = Number(size[1]);
            if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
            return [Math.round(width), Math.round(height)];
        }

        function readNodeSize(node) {
            if (!node) return null;
            return normalizeNodeSize(node.size)
                || normalizeNodeSize(node._size)
                || normalizeNodeSize(node.constructor?.size)
                || (Number.isFinite(Number(node.width)) && Number.isFinite(Number(node.height))
                    ? normalizeNodeSize([node.width, node.height])
                    : null);
        }

        function writeNodeSize(node, size) {
            const normalized = normalizeNodeSize(size);
            if (!node || !normalized) return false;
            if (typeof node.setSize === "function") {
                node.setSize([...normalized]);
            } else if (node.size && typeof node.size === "object" && typeof node.size.length === "number" && node.size.length >= 2) {
                node.size[0] = normalized[0];
                node.size[1] = normalized[1];
            } else {
                node.size = [...normalized];
            }
            if (node._size && typeof node._size === "object" && typeof node._size.length === "number" && node._size.length >= 2) {
                node._size[0] = normalized[0];
                node._size[1] = normalized[1];
            }
            node.width = normalized[0];
            node.height = normalized[1];
            node.setDirtyCanvas?.(true, true);
            return true;
        }

        function loadSizeClipboard() {
            try {
                return normalizeNodeSize(JSON.parse(getUserItem(GG_SIZE_CLIPBOARD_KEY) || "null"));
            } catch {
                return null;
            }
        }

        function saveSizeClipboard(size) {
            copiedNodeSize = normalizeNodeSize(size);
            if (copiedNodeSize) {
                setUserItem(GG_SIZE_CLIPBOARD_KEY, JSON.stringify(copiedNodeSize));
            } else {
                removeUserItem(GG_SIZE_CLIPBOARD_KEY);
            }
            refreshSizeClipboardButtons();
        }

        function refreshSizeClipboardButtons() {
            const pasteButton = document.getElementById("btn-paste-size");
            if (pasteButton) pasteButton.style.opacity = copiedNodeSize ? "1" : "0.48";
        }

        function copySelectedNodeSize() {
            const nodes = getSelectedNodes();
            if (nodes.length === 0) {
                showToast("请先选中一个节点，再复制尺寸", "error");
                return;
            }
            const size = readNodeSize(nodes[0]);
            if (!size) {
                showToast("当前节点没有可复制的尺寸", "error");
                return;
            }
            saveSizeClipboard(size);
            showToast(`已复制节点尺寸：${size[0]} × ${size[1]}`, "info");
        }

        function pasteSelectedNodeSize() {
            const size = copiedNodeSize || loadSizeClipboard();
            if (!size) {
                showToast("请先复制节点尺寸", "error");
                return;
            }
            saveSizeClipboard(size);
            const nodes = getSelectedNodes();
            if (nodes.length === 0) {
                showToast("请选择要粘贴尺寸的节点", "error");
                return;
            }
            withGraphChange(nodes, () => {
                nodes.forEach(node => {
                    writeNodeSize(node, copiedNodeSize);
                });
            });
            showToast(`已粘贴尺寸到 ${nodes.length} 个节点`, "info");
        }

        function getPersistedColorState(target) {
            if (isGraphGroup(target)) {
                return cloneColorState(target.flags?.[GG_GROUP_COLOR_STATE_KEY] || null);
            }
            return cloneColorState(target.properties?.[GG_NODE_COLOR_STATE_KEY] || null);
        }

        function persistColorState(target) {
            if (isGraphGroup(target)) {
                target.flags = target.flags || {};
                target.flags[GG_GROUP_COLOR_STATE_KEY] = {
                    groupColor: target.color,
                };
                return;
            }
            target.properties = target.properties || {};
            target.properties[GG_NODE_COLOR_STATE_KEY] = cloneColorState(target._ggColorOverlay || null);
        }

        function clearPersistedColorState(target) {
            if (isGraphGroup(target)) {
                if (target.flags) delete target.flags[GG_GROUP_COLOR_STATE_KEY];
                return;
            }
            if (target.properties) delete target.properties[GG_NODE_COLOR_STATE_KEY];
        }

        function restoreColorState(target) {
            if (!target) return;
            const state = getPersistedColorState(target);
            if (!state) return;
            const stateHash = JSON.stringify(state);
            if (target._ggRestoredColorStateHash === stateHash) return;

            if (isGraphGroup(target)) {
                if (state.groupColor) {
                    if (isOfficialColorable(target)) {
                        target.setColorOption({ groupcolor: state.groupColor });
                    } else {
                        target.color = state.groupColor;
                    }
                }
                target._ggRestoredColorStateHash = stateHash;
                return;
            }

            if (state.bodyColor) {
                target.bgcolor = state.bodyColor;
            }
            if (state.titleColor) {
                target.color = state.titleColor;
                target.title_color = state.titleColor;
            }
            if (state.bodyColor && state.titleColor && state.bodyAlpha === 0.24) {
                target.groupcolor = state.bodyColor;
            }
            ensureColorOverlay(target);
            target._ggColorOverlay = cloneColorState(state);
            syncDomColorOverlay(target, target._ggColorOverlay);
            target._ggRestoredColorStateHash = stateHash;
            target.setDirtyCanvas?.(true, true);
        }

        function restorePersistedColors() {
            getGraphNodes().forEach(restoreColorState);
            getGraphGroups().forEach(restoreColorState);
        }

        function applyColorToNode(node, option) {
            if (!node) return;
            if (isGraphGroup(node)) {
                if (isOfficialColorable(node)) {
                    node.setColorOption(option);
                } else {
                    node.color = option.groupcolor || option.bgcolor || option.color;
                }
                persistColorState(node);
                node._ggRestoredColorStateHash = JSON.stringify(getPersistedColorState(node));
                return;
            }
            if (option.mode === "node" && isOfficialColorable(node)) {
                // Same path used by ComfyUI's built-in node color menu.
                node.setColorOption(option);
            } else if (option.mode === "node") {
                node.color = option.color;
                node.bgcolor = option.bgcolor;
                node.groupcolor = option.groupcolor;
            } else if (option.mode === "body") {
                node.bgcolor = option.bgcolor;
            } else if (option.mode === "title") {
                node.color = option.color;
            }
            if (option.mode !== "body") node.title_color = node.color;
            setColorOverlay(node, option);
            persistColorState(node);
            node._ggRestoredColorStateHash = JSON.stringify(getPersistedColorState(node));
            node.setDirtyCanvas?.(true, true);
        }

        function clearColorFromNode(node) {
            if (!node) return;
            if (isGraphGroup(node)) {
                if (isOfficialColorable(node)) {
                    node.setColorOption(null);
                } else {
                    delete node.color;
                }
                clearPersistedColorState(node);
                delete node._ggRestoredColorStateHash;
                node.graph?.setDirtyCanvas?.(true, true);
                return;
            }
            if (isOfficialColorable(node)) {
                node.setColorOption(null);
            }
            delete node.color;
            delete node.bgcolor;
            delete node.title_color;
            delete node.groupcolor;
            clearColorOverlay(node);
            clearPersistedColorState(node);
            delete node._ggRestoredColorStateHash;
            node.setDirtyCanvas?.(true, true);
        }

        function applyColorToNodes(nodes, color) {
            const option = buildColorOption(color);
            withGraphChange(nodes, () => {
                nodes.forEach(node => applyColorToNode(node, option));
            });
        }

        function clearColorFromNodes(nodes) {
            withGraphChange(nodes, () => {
                nodes.forEach(node => clearColorFromNode(node));
            });
        }

        function applyNodeColor(color) {
            beginPaintColor(color);
        }

        function clearNodeColor() {
            beginClearColor();
        }

        function beginPickColor() {
            const selectedTargets = getSelectedColorTargets();
            if (selectedTargets.length > 0) {
                copyColorFromTarget(selectedTargets[0]);
                return;
            }
            startOneShotPaintAction({ type: "pick" });
            showToast("点击画布中的节点或分组取色", "info");
        }

        function beginPasteColor() {
            const state = copiedColorState || loadColorClipboard();
            if (!state) {
                showToast("请先取色，再粘贴到节点或分组", "error");
                return;
            }
            saveColorClipboard(state);
            const selectedTargets = getSelectedColorTargets();
            if (selectedTargets.length > 0) {
                applyColorStateToTargets(selectedTargets, copiedColorState);
                return;
            }
            startOneShotPaintAction({ type: "paste" });
            showToast("点击目标节点或分组粘贴上色", "info");
        }

        function refreshColorButtons() {
            panel.querySelectorAll(".color-preset-btn, .custom-color-btn").forEach(btn => {
                const dot = btn.querySelector(".color-dot");
                const color = dot?.dataset.color || dot?.style.background || "";
                const isActive = !!selectedPaintColor && color.toLowerCase() === selectedPaintColor.toLowerCase();
                btn.classList.toggle("active", isActive);
            });
        }

        function beginPaintColor(color) {
            oneShotPaintEnabled = false;
            if (selectedPaintColor && selectedPaintColor.toLowerCase() === color.toLowerCase()) {
                selectedPaintColor = null;
                if (paintAction?.type === "color") paintAction = null;
                refreshColorButtons();
                refreshColorClipboardButtons();
                return;
            }
            selectedPaintColor = color;
            paintAction = paintEnabled ? { type: "color", color } : null;
            refreshColorButtons();
            refreshColorClipboardButtons();
            showToast(paintEnabled ? "已选择颜色，点击节点上色" : "已选择颜色，启用画笔后可上色", "success");
        }

        function beginClearColor() {
            oneShotPaintEnabled = false;
            const selectedNodes = getSelectedColorTargets();
            if (selectedNodes.length > 0) {
                clearColorFromNodes(selectedNodes);
                showToast("已删除选中节点颜色", "success");
                return;
            }
            if (paintEnabled) {
                paintAction = { type: "clear" };
                refreshColorClipboardButtons();
                showToast("点击节点删除颜色", "success");
                return;
            }
            showToast("请先选中节点，或启用画笔后点击节点删除颜色", "success");
        }

        function setColorMode(mode) {
            colorMode = mode;
            panel.querySelectorAll(".color-mode-btn").forEach(btn => {
                btn.classList.toggle("active", btn.dataset.mode === mode);
            });
            const menu = document.getElementById("gg-color-mode-menu");
            if (menu) menu.style.display = "none";
            applyToolbarStyle();
        }

        function setPaintEnabled(enabled) {
            paintEnabled = enabled;
            if (!paintEnabled) oneShotPaintEnabled = false;
            const button = document.getElementById("btn-color-paint");
            button.classList.toggle("active", paintEnabled);
            button.dataset.tooltip = paintEnabled ? "关闭节点上色" : "启用节点上色";
            paintAction = paintEnabled && selectedPaintColor ? { type: "color", color: selectedPaintColor } : null;
            refreshColorClipboardButtons();
        }

        copiedColorState = loadColorClipboard();
        copiedNodeSize = loadSizeClipboard();
        refreshColorClipboardButtons();
        refreshSizeClipboardButtons();

        const presetContainer = document.getElementById("gg-color-presets");
        morandiColors.forEach((color, index) => {
            const button = document.createElement("button");
            button.className = "tool-btn color-preset-btn";
            button.dataset.tooltip = `莫兰迪颜色 ${index + 1}`;
            button.style.cssText = "background:transparent;border:none;padding:4px;";
            button.innerHTML = `<span class="color-dot" data-color="${color}" style="background:${color};"></span>`;
            button.onclick = () => applyNodeColor(color);
            if (index === 0) button.classList.add("active");
            presetContainer.appendChild(button);
        });

        document.getElementById("btn-color-paint").onclick = () => {
            setPaintEnabled(!paintEnabled);
            showToast(paintEnabled ? "节点上色已启用" : "节点上色已关闭", "success");
        };
        document.getElementById("btn-color-mode").onclick = event => {
            event.stopPropagation();
            const menu = document.getElementById("gg-color-mode-menu");
            menu.style.display = menu.style.display === "grid" ? "none" : "grid";
        };
        document.addEventListener("pointerdown", event => {
            if (!panel.contains(event.target)) {
                document.getElementById("gg-color-mode-menu").style.display = "none";
            }
        });

        panel.querySelectorAll(".color-mode-btn").forEach(btn => {
            btn.onclick = () => setColorMode(btn.dataset.mode);
        });

        document.querySelectorAll(".custom-color-btn").forEach(btn => {
            const index = Number(btn.dataset.index);
            const input = document.getElementById(`gg-custom-color-input-${index}`);
            const savedColor = getUserItem(`ggNodes_customColor_${index}`) || customColorDefaults[index - 1];
            input.value = savedColor;
            btn.querySelector(".color-dot").style.background = savedColor;
            btn.querySelector(".color-dot").dataset.color = savedColor;

            btn.onclick = () => input.click();
            input.oninput = () => {
                setUserItem(`ggNodes_customColor_${index}`, input.value);
                btn.querySelector(".color-dot").style.background = input.value;
                btn.querySelector(".color-dot").dataset.color = input.value;
                applyNodeColor(input.value);
            };
        });

        document.getElementById("btn-clear-color").onclick = clearNodeColor;
        document.getElementById("btn-pick-color").onclick = beginPickColor;
        document.getElementById("btn-paste-color").onclick = beginPasteColor;
        document.getElementById("btn-copy-size").onclick = copySelectedNodeSize;
        document.getElementById("btn-paste-size").onclick = pasteSelectedNodeSize;

        function getCanvasPoint(event) {
            const graphCanvas = getActiveCanvas();
            if (!graphCanvas) return null;
            if (typeof graphCanvas.convertEventToCanvasOffset === "function") {
                return graphCanvas.convertEventToCanvasOffset(event);
            }
            const canvasElement = graphCanvas.canvas;
            const rect = canvasElement?.getBoundingClientRect?.();
            if (!rect) return null;
            const scale = graphCanvas.ds?.scale || 1;
            const offset = graphCanvas.ds?.offset || [0, 0];
            return [
                (event.clientX - rect.left) / scale - offset[0],
                (event.clientY - rect.top) / scale - offset[1],
            ];
        }

        function getNodeAtEvent(event) {
            const activeCanvas = getActiveCanvas();
            if (activeCanvas?.node_over) return activeCanvas.node_over;
            if (app.canvas?.node_over) return app.canvas.node_over;
            const point = getCanvasPoint(event);
            if (!point) return null;
            const graph = activeCanvas?.graph || app.graph || app.canvas?.graph;
            if (typeof graph?.getNodeOnPos === "function") {
                return graph.getNodeOnPos(point[0], point[1], activeCanvas?.visible_nodes);
            }
            const nodes = graph?._nodes || [];
            for (let i = nodes.length - 1; i >= 0; i--) {
                const node = nodes[i];
                if (
                    point[0] >= node.pos[0] &&
                    point[0] <= node.pos[0] + node.size[0] &&
                    point[1] >= node.pos[1] &&
                    point[1] <= node.pos[1] + node.size[1]
                ) {
                    return node;
                }
            }
            return null;
        }

        function getGroupAtEvent(event) {
            const activeCanvas = getActiveCanvas();
            if (activeCanvas?.selected_group) return activeCanvas.selected_group;
            const point = getCanvasPoint(event);
            if (!point) return null;
            const groups = getGraphGroups();
            for (let i = groups.length - 1; i >= 0; i--) {
                const group = groups[i];
                const bounds = group?._bounding || group?.bounding || group?.getBounding?.();
                if (!bounds) continue;
                const x = bounds[0];
                const y = bounds[1];
                const width = bounds[2];
                const height = bounds[3];
                if (
                    point[0] >= x &&
                    point[0] <= x + width &&
                    point[1] >= y &&
                    point[1] <= y + height
                ) {
                    return group;
                }
            }
            return null;
        }

        function getColorTargetAtEvent(event) {
            return getNodeAtEvent(event) || getGroupAtEvent(event);
        }

        function handleCanvasPaint(event) {
            if (!paintEnabled || !paintAction || event.type !== "click" || event.button !== 0) return;
            const clickedTarget = getColorTargetAtEvent(event);
            const selectedTargets = getSelectedColorTargets();

            if (paintAction.type === "pick") {
                const source = clickedTarget || selectedTargets[0];
                if (!source) return;
                copyColorFromTarget(source);
                finishOneShotPaintAction();
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            const targets = selectedTargets.length > 1 || (clickedTarget && selectedTargets.includes(clickedTarget))
                ? selectedTargets
                : clickedTarget
                    ? [clickedTarget]
                    : selectedTargets;
            if (targets.length === 0) return;
            if (paintAction.type === "paste") {
                applyColorStateToTargets(targets, copiedColorState || loadColorClipboard());
                finishOneShotPaintAction();
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (paintAction.type === "color") {
                applyColorToNodes(targets, paintAction.color);
            } else if (paintAction.type === "clear") {
                clearColorFromNodes(targets);
            }
        }

        function handleCanvasClick(event) {
            setTimeout(() => {
                handleCanvasPaint(event);
            }, 10);
        }

        let paintHandlersCanvas = null;
        function attachCanvasPaintHandlers() {
            const canvasElement = getActiveCanvas()?.canvas || app.canvas?.canvas;
            if (!canvasElement || canvasElement === paintHandlersCanvas) return !!canvasElement;
            paintHandlersCanvas?.removeEventListener("pointerdown", handleCanvasPaint, true);
            paintHandlersCanvas?.removeEventListener("click", handleCanvasClick, true);
            canvasElement.addEventListener("pointerdown", handleCanvasPaint, true);
            canvasElement.addEventListener("click", handleCanvasClick, true);
            paintHandlersCanvas = canvasElement;
            return true;
        }

        attachCanvasPaintHandlers();
        const paintHandlerTimer = setInterval(() => {
            if (attachCanvasPaintHandlers()) clearInterval(paintHandlerTimer);
        }, 500);
        const restoreTimers = [200, 1000, 2500].map(delay => setTimeout(restorePersistedColors, delay));
        const restoreInterval = setInterval(restorePersistedColors, 3000);

        document.getElementById("btn-same-width").onclick = () => {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return showToast("请至少选中2个节点", "error");
            const maxW = Math.max(...nodes.map(n => n.size[0]));
            nodes.forEach(n => n.size[0] = maxW);
            app.graph.setDirtyCanvas(true);
        };

        document.getElementById("btn-same-height").onclick = () => {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return showToast("请至少选中2个节点", "error");
            const maxH = Math.max(...nodes.map(n => n.size[1]));
            nodes.forEach(n => n.size[1] = maxH);
            app.graph.setDirtyCanvas(true);
        };

        function alignNodes(mode) {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return showToast("请至少选中2个节点", "error");
            if (mode === "left") { const ref = Math.min(...nodes.map(n => n.pos[0])); nodes.forEach(n => n.pos[0] = ref); }
            else if (mode === "right") { const ref = Math.max(...nodes.map(n => n.pos[0] + n.size[0])); nodes.forEach(n => n.pos[0] = ref - n.size[0]); }
            else if (mode === "top") { const ref = Math.min(...nodes.map(n => n.pos[1])); nodes.forEach(n => n.pos[1] = ref); }
            else if (mode === "bottom") { const ref = Math.max(...nodes.map(n => n.pos[1] + n.size[1])); nodes.forEach(n => n.pos[1] = ref - n.size[1]); }
            else if (mode === "hcenter") { const centerY = nodes.reduce((sum, n) => sum + n.pos[1] + n.size[1]/2, 0) / nodes.length; nodes.forEach(n => n.pos[1] = centerY - n.size[1]/2); }
            else if (mode === "vcenter") { const centerX = nodes.reduce((sum, n) => sum + n.pos[0] + n.size[0]/2, 0) / nodes.length; nodes.forEach(n => n.pos[0] = centerX - n.size[0]/2); }
            app.graph.setDirtyCanvas(true);
        }

        document.getElementById("btn-align-left").onclick = () => alignNodes("left");
        document.getElementById("btn-align-right").onclick = () => alignNodes("right");
        document.getElementById("btn-align-hcenter").onclick = () => alignNodes("hcenter");
        document.getElementById("btn-align-top").onclick = () => alignNodes("top");
        document.getElementById("btn-align-bottom").onclick = () => alignNodes("bottom");
        document.getElementById("btn-align-vcenter").onclick = () => alignNodes("vcenter");

        document.getElementById("btn-auto-spacing").onclick = () => {
            const nodes = getSelectedNodes();
            if (nodes.length < 3) return showToast("请至少选中3个节点", "error");
            const isVertical = Math.abs(nodes[1].pos[1] - nodes[0].pos[1]) > Math.abs(nodes[1].pos[0] - nodes[0].pos[0]);
            nodes.sort((a, b) => isVertical ? a.pos[1] - b.pos[1] : a.pos[0] - b.pos[0]);
            const gap = isVertical ? nodes[1].pos[1] - (nodes[0].pos[1] + nodes[0].size[1]) : nodes[1].pos[0] - (nodes[0].pos[0] + nodes[0].size[0]);
            let current = isVertical ? nodes[0].pos[1] + nodes[0].size[1] : nodes[0].pos[0] + nodes[0].size[0];
            for (let i = 1; i < nodes.length; i++) {
                if (isVertical) { current += gap; nodes[i].pos[1] = current; current += nodes[i].size[1]; }
                else { current += gap; nodes[i].pos[0] = current; current += nodes[i].size[0]; }
            }
            app.graph.setDirtyCanvas(true);
        };

        document.getElementById("btn-auto-fit").onclick = () => {
            const nodes = getSelectedNodes();
            if (nodes.length === 0) return showToast("请至少选中1个节点", "error");
            nodes.forEach(n => {
                if (typeof n.computeSize === "function") {
                    const minSize = n.computeSize();
                    n.setSize([Math.ceil(minSize[0]), Math.ceil(minSize[1])]);
                }
            });
            app.graph.setDirtyCanvas(true, true);
        };

        // 关闭按钮点击事件
        document.getElementById("btn-close-toolbar").onclick = () => hidePanel();

        toolbarEnabled = getSettingValue(SETTINGS.toolbarEnabled, true) !== false;
        topSwitchEnabled = getSettingValue(SETTINGS.topSwitchEnabled, true) !== false;
        applyToolbarEnabled(toolbarEnabled);
    }
});
