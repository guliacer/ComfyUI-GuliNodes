import { app } from "../../scripts/app.js";
import { ggIcon } from "./gg-ui-icons.js";

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

        // 创建单个工具栏面板
        const panel = document.createElement("div");
        panel.id = "gg-nodes-panel";
        panel.style.cssText = `
            position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%);
            background: #ffffff; padding: 8px 12px; border-radius: 12px;
            z-index: 99999; font-size: 13px;
            user-select: none; display: flex; flex-direction: column; gap: 6px;
            border: 1px solid #e0e0e0; cursor: grab; box-shadow: none;
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
                        ${ggIcon("layers", 21)}
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
                <div class="divider" style="width:1px;height:24px;background:#e0e0e0;"></div>
                <div id="gg-color-presets" style="display:flex;align-items:center;gap:2px;"></div>
                <button id="btn-custom-color-1" class="tool-btn custom-color-btn" data-index="1" data-tooltip="自定义颜色 1" style="background:transparent;border:none;padding:4px;">
                    <span class="color-dot custom-dot" style="background:#8fa39b;"></span>
                </button>
                <button id="btn-custom-color-2" class="tool-btn custom-color-btn" data-index="2" data-tooltip="自定义颜色 2" style="background:transparent;border:none;padding:4px;">
                    <span class="color-dot custom-dot" style="background:#c9a7a2;"></span>
                </button>
                <button id="btn-clear-color" class="tool-btn" data-tooltip="删除节点颜色" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("trash", 21)}
                </button>
                <button id="btn-custom-action" class="tool-btn" data-tooltip="自定义" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("more", 21)}
                </button>
                <input id="gg-custom-color-input-1" type="color" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;">
                <input id="gg-custom-color-input-2" type="color" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;">
            </div>
            <div class="toolbar-row-divider" style="width:100%;height:1px;background:#e0e0e0;"></div>
            <!-- 尺寸调节工具栏 -->
            <div class="main-section" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:center;">
                <button id="btn-same-width" class="tool-btn" data-tooltip="自动宽度" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("width", 21)}
                </button>
                <button id="btn-same-height" class="tool-btn" data-tooltip="自动高度" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("height", 21)}
                </button>
                <div class="divider" style="width:1px;height:24px;background:#e0e0e0;"></div>
                <button id="btn-align-left" class="tool-btn" data-tooltip="最左对齐" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("alignLeft", 21)}
                </button>
                <button id="btn-align-right" class="tool-btn" data-tooltip="最右对齐" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("alignRight", 21)}
                </button>
                <button id="btn-align-hcenter" class="tool-btn" data-tooltip="水平居中" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("alignHCenter", 21)}
                </button>
                <div class="divider" style="width:1px;height:24px;background:#e0e0e0;"></div>
                <button id="btn-align-top" class="tool-btn" data-tooltip="最顶对齐" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("alignTop", 21)}
                </button>
                <button id="btn-align-bottom" class="tool-btn" data-tooltip="最底对齐" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("alignBottom", 21)}
                </button>
                <button id="btn-align-vcenter" class="tool-btn" data-tooltip="垂直居中" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("alignVCenter", 21)}
                </button>
                <div class="divider" style="width:1px;height:24px;background:#e0e0e0;"></div>
                <button id="btn-auto-spacing" class="tool-btn" data-tooltip="自动间距" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("spacing", 21)}
                </button>
                <div class="divider" style="width:1px;height:24px;background:#e0e0e0;"></div>
                <button id="btn-auto-fit" class="tool-btn" data-tooltip="自适应尺寸（紧凑）" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("fit", 21)}
                </button>
                <div class="divider" style="width:1px;height:24px;background:#e0e0e0;"></div>
                <button id="btn-close-toolbar" class="tool-btn" data-tooltip="关闭工具栏" style="background:transparent;border:none;padding:4px;">
                    ${ggIcon("close", 21)}
                </button>
            </div>
        `;

        document.body.appendChild(panel);

        const toolbarSettings = document.createElement("div");
        toolbarSettings.id = "gg-toolbar-settings";
        toolbarSettings.style.cssText = `
            position: fixed; display: none; z-index: 100002;
            width: 248px; padding: 14px;
            border-radius: 16px;
            border: 1px solid rgba(148,163,184,0.28);
            background: linear-gradient(180deg, rgba(255,255,255,0.97) 0%, rgba(248,250,252,0.94) 100%);
            box-shadow: 0 18px 42px rgba(15,23,42,0.14), 0 4px 14px rgba(15,23,42,0.08);
            backdrop-filter: blur(16px);
            user-select: none;
            color: var(--gg-ui-ink);
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
            #gg-nodes-mini:hover,
            #gg-nodes-mini.active,
            #gg-float-buttons-mini:hover,
            #gg-float-buttons-mini.active {
                color: var(--gg-ui-accent) !important;
                background: var(--gg-ui-accent-soft) !important;
                border-color: var(--gg-ui-accent-border) !important;
            }
            #gg-toolbar-top-switch {
                --gg-top-control-size: 34px;
                --gg-top-control-radius: 8px;
                --gg-top-switch-bg: rgba(255,255,255,0.84);
                --gg-top-switch-border: rgba(148,163,184,0.22);
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
            #gg-toolbar-top-switch .gg-toolbar-top-button::after {
                content: "";
                position: absolute;
                inset: 3px;
                border-radius: calc(var(--gg-top-control-radius) - 2px);
                opacity: 0;
                pointer-events: none;
                box-shadow: inset 0 0 0 1px rgba(255,255,255,0.5);
                transition: opacity 0.18s ease;
            }
            #gg-toolbar-top-switch .gg-toolbar-top-button.active::after,
            #gg-toolbar-top-switch .gg-toolbar-top-button.gg-state-on::after {
                opacity: 1;
            }
            #gg-toolbar-top-switch .gg-toolbar-top-button.gg-state-off {
                color: var(--gg-ui-muted) !important;
                background: rgba(148,163,184,0.08) !important;
                border-color: rgba(148,163,184,0.18) !important;
            }
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
                border: 1px solid rgba(148,163,184,0.28);
                background: linear-gradient(180deg, rgba(255,255,255,0.97) 0%, rgba(248,250,252,0.94) 100%);
                box-shadow: 0 16px 36px rgba(15,23,42,0.14), 0 4px 12px rgba(15,23,42,0.08);
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
                border-right: 1px solid rgba(148,163,184,0.28);
                border-bottom: 1px solid rgba(148,163,184,0.28);
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
                border: 1px solid rgba(148,163,184,0.18);
                background: rgba(255,255,255,0.78) !important;
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.76);
                color: var(--gg-ui-ink);
                transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease, background 0.16s ease;
            }
            #gg-color-mode-menu .tool-btn:hover {
                transform: translateY(-1px);
                box-shadow: 0 6px 12px rgba(15,23,42,0.1), inset 0 1px 0 rgba(255,255,255,0.82);
            }
            #gg-color-mode-menu .tool-btn.active {
                transform: translateY(-1px);
                color: var(--gg-ui-accent) !important;
                border-color: var(--gg-ui-accent-border);
                box-shadow: 0 0 0 2px var(--gg-ui-accent-soft), inset 0 1px 0 rgba(255,255,255,0.88);
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
                border: 1px solid rgba(148,163,184,0.22);
                background: rgba(255,255,255,0.78);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.72);
            }
            #gg-toolbar-settings .gg-toolbar-settings-card {
                padding: 12px;
                border-radius: 12px;
                background: rgba(255,255,255,0.72);
                border: 1px solid rgba(148,163,184,0.2);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.8);
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
                border: 1px solid rgba(148,163,184,0.22);
                background: rgba(255,255,255,0.78);
                flex: 0 0 auto;
            }
            #gg-toolbar-settings .gg-toolbar-color-chip .color-dot {
                width: 24px;
                height: 24px;
                border-radius: 8px;
                border: 1px solid rgba(0,0,0,0.12);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.45);
            }
            #gg-toolbar-settings .gg-toolbar-color-input {
                width: 44px;
                height: 42px;
                padding: 4px;
                border-radius: 12px;
                border: 1px solid rgba(148,163,184,0.22);
                background: rgba(255,255,255,0.78);
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
                border: 1px solid rgba(0,0,0,0.08);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.55);
                cursor: pointer;
                transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
            }
            #gg-toolbar-settings .gg-toolbar-swatch:hover {
                transform: translateY(-1px);
            }
            #gg-toolbar-settings .gg-toolbar-swatch.active {
                border-color: var(--gg-ui-accent-border);
                box-shadow: 0 0 0 2px var(--gg-ui-accent-soft), inset 0 1px 0 rgba(255,255,255,0.65);
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
        miniIcon.classList.add("gg-toolbar-top-button");
        miniIcon.title = "收起工具栏";
        miniIcon.style.cssText = `
            width: 34px; height: 34px; background: var(--comfy-menu-bg, rgba(255,255,255,0.95));
            border: 1px solid var(--border-color, rgba(0,0,0,0.1));
            border-radius: 8px; color: var(--gg-ui-ink); cursor: pointer; display: none;
            align-items: center; justify-content: center; padding: 0;
            box-shadow: none; transition: transform 0.16s ease, background 0.16s ease, border-color 0.16s ease, opacity 0.16s ease;
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
        floatButtonsIcon.classList.add("gg-toolbar-top-button");
        floatButtonsIcon.title = "关闭文本框悬浮按钮";
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
                return JSON.parse(localStorage.getItem(TOOLBAR_SETTINGS_STATE_KEY) || "{}");
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
            localStorage.setItem(TOOLBAR_SETTINGS_STATE_KEY, JSON.stringify(nextState));
        }

        function applyToolbarStyle() {
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
            document.documentElement.style.setProperty("--gg-toolbar-button-bg", background);
            document.documentElement.style.setProperty("--gg-toolbar-button-border", borderTone);
            document.documentElement.style.setProperty("--gg-toolbar-button-color", "var(--gg-ui-accent)");
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
            localStorage.setItem("ggNodes_toolbarStyle", JSON.stringify({
                color,
                opacity: toolbarOpacityInput.value,
            }));
        }

        function loadToolbarStyle() {
            try {
                const savedStyle = JSON.parse(localStorage.getItem("ggNodes_toolbarStyle") || "{}");
                if (savedStyle.color) toolbarBgInput.value = savedStyle.color;
                if (savedStyle.opacity) toolbarOpacityInput.value = savedStyle.opacity;
            } catch (e) {
                console.error("Failed to load toolbar style:", e);
            }
            applyToolbarStyle();
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

        toolbarBgInput.oninput = applyToolbarStyle;
        toolbarOpacityInput.oninput = applyToolbarStyle;
        toolbarResetButton.onclick = () => {
            toolbarBgInput.value = "#ffffff";
            toolbarOpacityInput.value = "100";
            applyToolbarStyle();
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
            floatButtonsIcon.title = floatButtonsEnabled ? "关闭文本框悬浮按钮" : "启用文本框悬浮按钮";
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
            localStorage.setItem("ggNodes_visible", "false");
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
            localStorage.setItem("ggNodes_visible", "true");
        };

        const applyToolbarEnabled = (enabled) => {
            toolbarEnabled = enabled !== false;
            if (toolbarEnabled) {
                if (topSwitchEnabled && localStorage.getItem("ggNodes_visible") === "false") {
                    setPanelHidden();
                } else {
                    showPanel();
                }
            } else {
                panel.style.display = "none";
                hideToolbarSettings();
                updateMiniIconState(false);
                localStorage.setItem("ggNodes_visible", "false");
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
                localStorage.setItem("ggNodes_pos", JSON.stringify(lastPosition));
            }
        });

        // 加载保存的位置
        const saved = localStorage.getItem("ggNodes_pos");
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
                Array.isArray(value.pos) ||
                Array.isArray(value.size) ||
                typeof value.id === "number" ||
                typeof value.setDirtyCanvas === "function"
            );
        }

        function isColorTarget(value) {
            return isGraphNode(value) || isOfficialColorable(value) || (
                !!value && typeof value === "object" && Array.isArray(value._bounding)
            );
        }

        function isGraphGroup(value) {
            return !!value && typeof value === "object" && (
                value.constructor === window.LiteGraph?.LGraphGroup ||
                typeof value.font_size === "number" ||
                Array.isArray(value._bounding)
            );
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
        ];
        const GG_NODE_COLOR_STATE_KEY = "_gg_toolbar_color_state";
        const GG_GROUP_COLOR_STATE_KEY = "gg_toolbar_color_state";
        const customColorDefaults = ["#8fa39b", "#c9a7a2"];
        let colorMode = "node";
        let paintAction = null;
        let paintEnabled = false;
        let selectedPaintColor = morandiColors[0];

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

        function ensureColorOverlay(node) {
            if (node._ggColorOverlayInstalled) return;
            const originalOnDrawForeground = node.onDrawForeground;
            node._ggOriginalOnDrawForeground = originalOnDrawForeground;
            node.onDrawForeground = function (ctx) {
                originalOnDrawForeground?.apply(this, arguments);
                const overlay = this._ggColorOverlay;
                if (!overlay) return;

                const width = this.size?.[0] || 0;
                const height = this.size?.[1] || 0;
                const titleHeight = window.LiteGraph?.NODE_TITLE_HEIGHT || 30;
                const isCollapsed = !!(this.flags?.collapsed || this.collapsed);
                if (!width || !height) return;

                ctx.save();
                if (overlay.bodyColor && !isCollapsed) {
                    ctx.globalAlpha = overlay.bodyAlpha ?? 0.32;
                    ctx.fillStyle = overlay.bodyColor;
                    roundRectPath(ctx, 0, 0, width, height, 8);
                    ctx.fill();
                }
                if (overlay.titleColor && !isCollapsed) {
                    ctx.globalAlpha = 0.42;
                    ctx.fillStyle = overlay.titleColor;
                    roundRectPath(ctx, 0, -titleHeight, width, titleHeight, 8);
                    ctx.fill();
                }
                ctx.restore();
            };
            node._ggColorOverlayInstalled = true;
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
        }

        function clearColorOverlay(node) {
            delete node._ggColorOverlay;
        }

        function cloneColorState(state) {
            return state ? JSON.parse(JSON.stringify(state)) : null;
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

        function refreshColorButtons() {
            panel.querySelectorAll(".color-preset-btn, .custom-color-btn").forEach(btn => {
                const dot = btn.querySelector(".color-dot");
                const color = dot?.dataset.color || dot?.style.background || "";
                const isActive = !!selectedPaintColor && color.toLowerCase() === selectedPaintColor.toLowerCase();
                btn.classList.toggle("active", isActive);
            });
        }

        function beginPaintColor(color) {
            if (selectedPaintColor && selectedPaintColor.toLowerCase() === color.toLowerCase()) {
                selectedPaintColor = null;
                if (paintAction?.type === "color") paintAction = null;
                refreshColorButtons();
                return;
            }
            selectedPaintColor = color;
            paintAction = paintEnabled ? { type: "color", color } : null;
            refreshColorButtons();
            showToast(paintEnabled ? "已选择颜色，点击节点上色" : "已选择颜色，启用画笔后可上色", "success");
        }

        function beginClearColor() {
            const selectedNodes = getSelectedColorTargets();
            if (selectedNodes.length > 0) {
                clearColorFromNodes(selectedNodes);
                showToast("已删除选中节点颜色", "success");
                return;
            }
            if (paintEnabled) {
                paintAction = { type: "clear" };
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
            const button = document.getElementById("btn-color-paint");
            button.classList.toggle("active", paintEnabled);
            button.dataset.tooltip = paintEnabled ? "关闭节点上色" : "启用节点上色";
            paintAction = paintEnabled && selectedPaintColor ? { type: "color", color: selectedPaintColor } : null;
        }

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
            const savedColor = localStorage.getItem(`ggNodes_customColor_${index}`) || customColorDefaults[index - 1];
            input.value = savedColor;
            btn.querySelector(".color-dot").style.background = savedColor;
            btn.querySelector(".color-dot").dataset.color = savedColor;

            btn.onclick = () => input.click();
            input.oninput = () => {
                localStorage.setItem(`ggNodes_customColor_${index}`, input.value);
                btn.querySelector(".color-dot").style.background = input.value;
                btn.querySelector(".color-dot").dataset.color = input.value;
                applyNodeColor(input.value);
            };
        });

        document.getElementById("btn-clear-color").onclick = clearNodeColor;

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
            const targets = selectedTargets.length > 1 || (clickedTarget && selectedTargets.includes(clickedTarget))
                ? selectedTargets
                : clickedTarget
                    ? [clickedTarget]
                    : selectedTargets;
            if (targets.length === 0) return;
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
