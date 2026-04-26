import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "ComfyUI.GGNodes.Toolbar",
    async setup() {
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
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h5"/><path d="M14 4l6 6"/><path d="M13 5l-7 7v4h4l7-7"/></svg>
                </button>
                <div class="color-mode-wrap" style="position:relative;">
                    <button id="btn-color-mode" class="tool-btn" data-tooltip="上色模式" style="background:transparent;border:none;padding:4px;">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16"/><path d="M8 14h6"/><path d="M17 14l2 2 2-2"/></svg>
                    </button>
                    <div id="gg-color-mode-menu" style="display:none;position:absolute;left:50%;bottom:42px;transform:translateX(-50%);z-index:100000;">
                        <button class="tool-btn color-mode-btn active" data-mode="node" data-tooltip="节点整体" style="background:transparent;border:none;padding:4px;">
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8"/><path d="M8 13h5"/></svg>
                        </button>
                        <button class="tool-btn color-mode-btn" data-mode="body" data-tooltip="节点内部" style="background:transparent;border:none;padding:4px;">
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16"/><path d="M8 14h8"/></svg>
                        </button>
                        <button class="tool-btn color-mode-btn" data-mode="title" data-tooltip="标题栏" style="background:transparent;border:none;padding:4px;">
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16"/></svg>
                        </button>
                    </div>
                </div>
                <button id="btn-color-node" class="tool-btn color-mode-btn active" data-mode="node" data-tooltip="上色模式：节点整体" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8"/><path d="M8 13h5"/></svg>
                </button>
                <button id="btn-color-body" class="tool-btn color-mode-btn" data-mode="body" data-tooltip="上色模式：节点内部" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16"/><path d="M8 14h8"/></svg>
                </button>
                <button id="btn-color-title" class="tool-btn color-mode-btn" data-mode="title" data-tooltip="上色模式：节点标题栏" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16"/></svg>
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
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>
                </button>
                <input id="gg-custom-color-input-1" type="color" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;">
                <input id="gg-custom-color-input-2" type="color" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;">
            </div>
            <div class="toolbar-row-divider" style="width:100%;height:1px;background:#e0e0e0;"></div>
            <!-- 尺寸调节工具栏 -->
            <div class="main-section" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:center;">
                <button id="btn-same-width" class="tool-btn" data-tooltip="自动宽度" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 12h8"/></svg>
                </button>
                <button id="btn-same-height" class="tool-btn" data-tooltip="自动高度" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M12 8v8"/></svg>
                </button>
                <div class="divider" style="width:1px;height:24px;background:#e0e0e0;"></div>
                <button id="btn-align-left" class="tool-btn" data-tooltip="最左对齐" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M3 12h14"/><path d="M3 18h10"/></svg>
                </button>
                <button id="btn-align-right" class="tool-btn" data-tooltip="最右对齐" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M7 12h14"/><path d="M11 18h10"/></svg>
                </button>
                <button id="btn-align-hcenter" class="tool-btn" data-tooltip="水平居中" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="M9 6v12"/><path d="M15 6v12"/></svg>
                </button>
                <div class="divider" style="width:1px;height:24px;background:#e0e0e0;"></div>
                <button id="btn-align-top" class="tool-btn" data-tooltip="最顶对齐" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v18"/><path d="M12 3v14"/><path d="M18 3v10"/></svg>
                </button>
                <button id="btn-align-bottom" class="tool-btn" data-tooltip="最底对齐" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21v-18"/><path d="M12 21v-14"/><path d="M18 21v-10"/></svg>
                </button>
                <button id="btn-align-vcenter" class="tool-btn" data-tooltip="垂直居中" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M6 8h12"/><path d="M6 16h12"/></svg>
                </button>
                <div class="divider" style="width:1px;height:24px;background:#e0e0e0;"></div>
                <button id="btn-auto-spacing" class="tool-btn" data-tooltip="自动间距" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/></svg>
                </button>
                <div class="divider" style="width:1px;height:24px;background:#e0e0e0;"></div>
                <button id="btn-auto-fit" class="tool-btn" data-tooltip="自适应尺寸（紧凑）" style="background:transparent;border:none;padding:4px;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="M8 8h8v8H8z"/></svg>
                </button>
            </div>
        `;

        document.body.appendChild(panel);

        const toolbarSettings = document.createElement("div");
        toolbarSettings.id = "gg-toolbar-settings";
        toolbarSettings.style.cssText = `
            position: fixed; display: none; z-index: 100002;
            background: #ffffff; border: 1px solid #e0e0e0; border-radius: 8px;
            padding: 8px; box-shadow: 0 6px 18px rgba(0,0,0,0.16);
            user-select: none; min-width: 188px;
        `;
        toolbarSettings.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <button id="gg-toolbar-bg-chip" class="tool-btn" data-tooltip="工具栏颜色" style="background:transparent;border:none;padding:4px;">
                    <span class="color-dot" style="background:#ffffff;"></span>
                </button>
                <input id="gg-toolbar-bg-input" type="color" value="#ffffff" style="width:36px;height:28px;border:none;background:transparent;padding:0;cursor:pointer;">
                <button id="gg-toolbar-reset" class="tool-btn" data-tooltip="恢复默认工具栏样式" style="background:transparent;border:none;padding:4px;margin-left:auto;">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/></svg>
                </button>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><path d="M12 5v14"/></svg>
                <input id="gg-toolbar-opacity-input" type="range" min="0" max="100" step="1" value="100" style="width:116px;accent-color:#777;">
                <span id="gg-toolbar-opacity-label" style="width:34px;text-align:right;font-size:12px;color:#555;">100%</span>
            </div>
        `;
        document.body.appendChild(toolbarSettings);

        toolbarSettings.style.cssText = `
            position: fixed; display: none; z-index: 100002;
            width: 248px; padding: 14px;
            border-radius: 16px;
            border: 1px solid rgba(255,255,255,0.72);
            background: linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(248,246,243,0.93) 100%);
            box-shadow: 0 18px 42px rgba(81,72,57,0.16), 0 4px 14px rgba(81,72,57,0.08);
            backdrop-filter: blur(16px);
            user-select: none;
            color: #5f564b;
        `;
        toolbarSettings.innerHTML = `
            <div class="gg-toolbar-settings-head">
                <div>
                    <div class="gg-toolbar-settings-title">工具栏外观</div>
                    <div class="gg-toolbar-settings-subtitle">实时调整颜色与透明度</div>
                </div>
                <button id="gg-toolbar-reset" class="tool-btn gg-toolbar-icon-btn" data-tooltip="恢复默认工具栏样式" type="button">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/></svg>
                </button>
            </div>
            <div class="gg-toolbar-settings-card">
                <div class="gg-toolbar-settings-row">
                    <div class="gg-toolbar-settings-label">背景颜色</div>
                    <div class="gg-toolbar-settings-value" id="gg-toolbar-color-hex">#FFFFFF</div>
                </div>
                <div class="gg-toolbar-settings-color-row">
                    <button id="gg-toolbar-bg-chip" class="tool-btn gg-toolbar-color-chip" data-tooltip="工具栏颜色" type="button">
                        <span class="color-dot" style="background:#ffffff;"></span>
                    </button>
                    <input id="gg-toolbar-bg-input" type="color" value="#ffffff" class="gg-toolbar-color-input">
                    <div class="gg-toolbar-color-presets">
                        <button class="gg-toolbar-swatch" type="button" data-color="#f3f0ea" style="background:#f3f0ea;"></button>
                        <button class="gg-toolbar-swatch" type="button" data-color="#e5ebea" style="background:#e5ebea;"></button>
                        <button class="gg-toolbar-swatch" type="button" data-color="#ede2d8" style="background:#ede2d8;"></button>
                        <button class="gg-toolbar-swatch" type="button" data-color="#ded8eb" style="background:#ded8eb;"></button>
                    </div>
                </div>
            </div>
            <div class="gg-toolbar-settings-card">
                <div class="gg-toolbar-settings-row">
                    <div class="gg-toolbar-settings-label">背景透明度</div>
                    <div class="gg-toolbar-settings-value" id="gg-toolbar-opacity-label">100%</div>
                </div>
                <div class="gg-toolbar-slider-row">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><path d="M12 5v14"/></svg>
                    <input id="gg-toolbar-opacity-input" type="range" min="0" max="100" step="1" value="100" class="gg-toolbar-opacity-input">
                </div>
            </div>
        `;

        toolbarSettings.innerHTML = `
            <div class="gg-toolbar-settings-head">
                <div>
                    <div class="gg-toolbar-settings-title">Toolbar Style</div>
                    <div class="gg-toolbar-settings-subtitle">Live color and opacity</div>
                </div>
                <div class="gg-toolbar-head-actions">
                    <button id="gg-toolbar-reset" class="tool-btn gg-toolbar-icon-btn" data-tooltip="Reset toolbar style" type="button">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/></svg>
                    </button>
                    <button id="gg-toolbar-close" class="tool-btn gg-toolbar-icon-btn" data-tooltip="Close" type="button">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
                    </button>
                </div>
            </div>
            <div class="gg-toolbar-settings-card">
                <div class="gg-toolbar-settings-row">
                    <div class="gg-toolbar-settings-label">Color</div>
                    <div class="gg-toolbar-settings-value" id="gg-toolbar-color-hex">#FFFFFF</div>
                </div>
                <div class="gg-toolbar-settings-color-row">
                    <button id="gg-toolbar-bg-chip" class="tool-btn gg-toolbar-color-chip" data-tooltip="Toolbar color" type="button">
                        <span class="color-dot" style="background:#ffffff;"></span>
                    </button>
                    <input id="gg-toolbar-bg-input" type="color" value="#ffffff" class="gg-toolbar-color-input">
                    <div class="gg-toolbar-color-presets">
                        <button class="gg-toolbar-swatch" type="button" data-color="#f3f0ea" style="background:#f3f0ea;"></button>
                        <button class="gg-toolbar-swatch" type="button" data-color="#e5ebea" style="background:#e5ebea;"></button>
                        <button class="gg-toolbar-swatch" type="button" data-color="#ede2d8" style="background:#ede2d8;"></button>
                        <button class="gg-toolbar-swatch" type="button" data-color="#ded8eb" style="background:#ded8eb;"></button>
                    </div>
                </div>
            </div>
            <div class="gg-toolbar-settings-card">
                <div class="gg-toolbar-settings-row">
                    <div class="gg-toolbar-settings-label">Opacity</div>
                    <div class="gg-toolbar-settings-value" id="gg-toolbar-opacity-label">100%</div>
                </div>
                <div class="gg-toolbar-slider-row">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><path d="M12 5v14"/></svg>
                    <input id="gg-toolbar-opacity-input" type="range" min="0" max="100" step="1" value="100" class="gg-toolbar-opacity-input">
                </div>
            </div>
        `;

        const style = document.createElement("style");
        style.textContent = `
            #gg-nodes-panel .tool-btn {
                width: 30px;
                height: 30px;
                border-radius: 6px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
            }
            #gg-nodes-panel .tool-btn:hover,
            #gg-nodes-panel .tool-btn.active,
            #gg-toolbar-settings .tool-btn:hover {
                background: #f0f0f0 !important;
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
                border: 1px solid rgba(255,255,255,0.72);
                background: linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(248,246,243,0.93) 100%);
                box-shadow: 0 16px 36px rgba(81,72,57,0.16), 0 4px 12px rgba(81,72,57,0.08);
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
                border-right: 1px solid rgba(255,255,255,0.72);
                border-bottom: 1px solid rgba(255,255,255,0.72);
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
                border: 1px solid rgba(149,138,125,0.14);
                background: rgba(255,255,255,0.78) !important;
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.76);
                color: #665f55;
                transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease, background 0.16s ease;
            }
            #gg-color-mode-menu .tool-btn:hover {
                transform: translateY(-1px);
                box-shadow: 0 6px 12px rgba(81,72,57,0.12), inset 0 1px 0 rgba(255,255,255,0.82);
            }
            #gg-color-mode-menu .tool-btn.active {
                transform: translateY(-1px);
                border-color: rgba(140,102,63,0.32);
                box-shadow: 0 0 0 2px rgba(156,125,94,0.16), inset 0 1px 0 rgba(255,255,255,0.88);
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
                color: #665f55;
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
                color: #554d44;
            }
            #gg-toolbar-settings .gg-toolbar-settings-subtitle {
                margin-top: 4px;
                font-size: 11px;
                line-height: 1.4;
                color: #8b8277;
            }
            #gg-toolbar-settings .gg-toolbar-icon-btn {
                border: 1px solid rgba(149,138,125,0.18);
                background: rgba(255,255,255,0.78);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.72);
            }
            #gg-toolbar-settings .gg-toolbar-settings-card {
                padding: 12px;
                border-radius: 12px;
                background: rgba(255,255,255,0.72);
                border: 1px solid rgba(149,138,125,0.14);
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
                color: #675e53;
            }
            #gg-toolbar-settings .gg-toolbar-settings-value {
                font-size: 12px;
                font-weight: 700;
                color: #8e6e4f;
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
                border: 1px solid rgba(149,138,125,0.16);
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
                border: 1px solid rgba(149,138,125,0.16);
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
                border-color: rgba(140, 102, 63, 0.5);
                box-shadow: 0 0 0 2px rgba(156, 125, 94, 0.18), inset 0 1px 0 rgba(255,255,255,0.65);
                transform: translateY(-1px);
            }
            #gg-toolbar-settings .gg-toolbar-slider-row {
                display: flex;
                align-items: center;
                gap: 10px;
                color: #6e655c;
            }
            #gg-toolbar-settings .gg-toolbar-opacity-input {
                width: 100%;
                margin: 0;
                accent-color: #9b7d5e;
            }
        `;
        document.head.appendChild(style);

        // 创建迷你图标
        const miniIcon = document.createElement("button");
        miniIcon.id = "gg-nodes-mini";
        miniIcon.style.cssText = `
            position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
            width: 32px; height: 32px; background: #ffffff; border: 1px solid #e0e0e0; 
            border-radius: 6px; color: #555555; cursor: pointer; display: none; 
            align-items: center; justify-content: center; z-index: 99999;
        `;
        miniIcon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#555555" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="M8 8h8v8H8z"/></svg>`;
        document.body.appendChild(miniIcon);

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
            position: fixed; background: #333; color: #fff; font-size: 12px; padding: 6px 12px;
            border-radius: 8px; pointer-events: none; z-index: 100001; white-space: nowrap;
            display: none; opacity: 0; transition: opacity 0.15s; box-shadow: 0 2px 8px rgba(0,0,0,0.2);
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
            panel.style.background = background;
            miniIcon.style.background = background;
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

        const hidePanel = () => {
            lastPosition = { left: panel.style.left, top: panel.style.top, bottom: panel.style.bottom };
            panel.style.display = "none";
            miniIcon.style.display = "flex";
        };

        const showPanel = () => {
            panel.style.display = "flex";
            panel.style.left = lastPosition.left || "50%";
            panel.style.top = lastPosition.top || "auto";
            panel.style.bottom = lastPosition.bottom || "30px";
            panel.style.transform = lastPosition.top ? "none" : "translateX(-50%)";
            miniIcon.style.display = "none";
        };

        // 为面板添加右键菜单事件
        panel.addEventListener("contextmenu", e => { e.preventDefault(); hidePanel(); });
        miniIcon.addEventListener("contextmenu", e => { e.preventDefault(); showPanel(); });
        panel.addEventListener("auxclick", e => {
            if (e.button === 1) showToolbarSettings(e);
        });
        panel.addEventListener("mouseup", e => {
            if (e.button === 1) showToolbarSettings(e);
        });
        document.addEventListener("mousedown", e => {
            if (!toolbarSettings.contains(e.target) && !panel.contains(e.target)) hideToolbarSettings();
        });

        // 为面板添加拖拽功能
        let isDragging = false, offsetX, offsetY;
        
        panel.addEventListener("mousedown", e => {
            if (e.button === 1) {
                showToolbarSettings(e);
                return;
            }
            if (e.button !== 0) return;
            if (e.target.tagName === "BUTTON" || e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
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
            console.log("尝试获取选中节点:");
            console.log("app对象:", app);
            console.log("app.graph:", app.graph);
            console.log("app.canvas:", app.canvas);
            
            const canvasSelected = getCanvasSelectedNodes();
            if (canvasSelected.length > 0) {
                console.log("从LGraphCanvas/app.canvas.selected_nodes获取:", canvasSelected.length);
                console.log("选中节点详情:", canvasSelected);
                return uniqueNodes(canvasSelected);
            }

            if (app.graph && app.graph.selected_nodes) {
                const selected = normalizeSelectedNodes(app.graph.selected_nodes);
                if (selected.length > 0) {
                    console.log("从app.graph.selected_nodes获取:", selected.length);
                    console.log("选中节点详情:", selected);
                    return uniqueNodes(selected);
                }
            }
            
            const selectedFromGraph = getSelectedNodesFromGraph();
            if (selectedFromGraph.length > 0) {
                const selected = uniqueNodes(selectedFromGraph);
                console.log("从app.graph._nodes.filter获取:", selected.length);
                console.log("选中节点详情:", selected);
                return selected;
            }

            // 尝试其他可能的方式
            if (app.graph && app.graph.getSelection) {
                const selection = uniqueNodes(normalizeSelectedNodes(app.graph.getSelection()));
                console.log("从app.graph.getSelection获取:", selection.length);
                if (selection && selection.length > 0) {
                    console.log("选中节点详情:", selection);
                    return selection;
                }
            }
            
            // 尝试通过全局变量获取
            if (window.canvas && window.canvas.selected_nodes) {
                const selected = normalizeSelectedNodes(window.canvas.selected_nodes);
                if (selected.length > 0) {
                    console.log("从window.canvas.selected_nodes获取:", selected.length);
                    return uniqueNodes(selected);
                }
            }
            
            // 尝试通过LiteGraph的方式获取
            if (window.LiteGraph && window.LiteGraph.getSelectedNodes) {
                const selected = uniqueNodes(normalizeSelectedNodes(window.LiteGraph.getSelectedNodes()));
                console.log("从window.LiteGraph.getSelectedNodes获取:", selected.length);
                if (selected && selected.length > 0) {
                    console.log("选中节点详情:", selected);
                    return selected;
                }
            }
            
            console.log("未找到选中节点");
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
                if (!width || !height) return;

                ctx.save();
                if (overlay.bodyColor) {
                    ctx.globalAlpha = overlay.bodyAlpha ?? 0.32;
                    ctx.fillStyle = overlay.bodyColor;
                    roundRectPath(ctx, 0, 0, width, height, 8);
                    ctx.fill();
                }
                if (overlay.titleColor) {
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

        function beginPaintColor(color) {
            paintAction = { type: "color", color };
            const selectedNodes = getSelectedColorTargets();
            if (selectedNodes.length > 0) {
                applyColorToNodes(selectedNodes, color);
                showToast("已上色，也可继续点击节点上色", "success");
                return;
            }
            showToast("点击节点上色", "success");
        }

        function beginClearColor() {
            paintAction = { type: "clear" };
            const selectedNodes = getSelectedColorTargets();
            if (selectedNodes.length > 0) {
                clearColorFromNodes(selectedNodes);
                showToast("已删除颜色，也可继续点击节点删除颜色", "success");
                return;
            }
            showToast("点击节点删除颜色", "success");
        }

        function applyNodeColor(color) {
            beginPaintColor(color);
        }

        function clearNodeColor() {
            beginClearColor();
        }

        function setColorMode(mode) {
            colorMode = mode;
            panel.querySelectorAll(".color-mode-btn").forEach(btn => {
                btn.classList.toggle("active", btn.dataset.mode === mode);
            });
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
            nodes.forEach(n => n.size = [210, n.size[1]]);
            app.graph.setDirtyCanvas(true);
        };

        // 迷你图标点击事件
        miniIcon.onclick = showPanel;

        // 点击外部区域不关闭面板，避免误操作
        // document.addEventListener('click', (e) => {
        //     if (!panel.contains(e.target) && e.target !== miniIcon) {
        //         hidePanel();
        //     }
        // });
    }
});
