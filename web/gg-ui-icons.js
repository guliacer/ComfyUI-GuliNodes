const ICONS = {
    brush: '<path d="M4 20h5"/><path d="M14.5 4.5l5 5"/><path d="M13.5 5.5 6 13v4h4l7.5-7.5"/>',
    layers: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M4 10h16"/><path d="M8 14h6"/><path d="M17 14l2 2 2-2"/>',
    node: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M8 9h8"/><path d="M8 13h5"/>',
    body: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M4 10h16"/><path d="M8 14h8"/>',
    title: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M4 10h16"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6.5 7l1 14h9l1-14"/><path d="M9 7V4h6v3"/>',
    more: '<circle cx="5" cy="12" r="1.3" class="gg-ui-fill"/><circle cx="12" cy="12" r="1.3" class="gg-ui-fill"/><circle cx="19" cy="12" r="1.3" class="gg-ui-fill"/>',
    width: '<rect x="4" y="7" width="16" height="10" rx="3"/><path d="M8 12h8"/><path d="M10 10l-2 2 2 2"/><path d="M14 10l2 2-2 2"/>',
    height: '<rect x="7" y="4" width="10" height="16" rx="3"/><path d="M12 8v8"/><path d="M10 10l2-2 2 2"/><path d="M10 14l2 2 2-2"/>',
    alignLeft: '<path d="M5 5v14"/><path d="M8 7h11"/><path d="M8 12h8"/><path d="M8 17h6"/>',
    alignRight: '<path d="M19 5v14"/><path d="M5 7h11"/><path d="M8 12h8"/><path d="M10 17h6"/>',
    alignHCenter: '<path d="M5 12h14"/><path d="M8 5v14"/><path d="M16 7v10"/>',
    alignTop: '<path d="M5 5h14"/><path d="M8 8v11"/><path d="M12 8v8"/><path d="M16 8v5"/>',
    alignBottom: '<path d="M5 19h14"/><path d="M8 5v11"/><path d="M12 8v8"/><path d="M16 11v5"/>',
    alignVCenter: '<path d="M12 5v14"/><path d="M5 8h14"/><path d="M7 16h10"/>',
    spacing: '<path d="M5 6h14"/><path d="M5 12h14"/><path d="M5 18h14"/><path d="M8 9l4 3-4 3"/><path d="M16 9l-4 3 4 3"/>',
    fit: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z"/><path d="M4 9h3"/><path d="M17 9h3"/><path d="M4 15h3"/><path d="M17 15h3"/>',
    close: '<circle cx="12" cy="12" r="8"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/>',
    reset: '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v6h6"/>',
    opacity: '<circle cx="12" cy="12" r="7"/><path d="M12 5v14"/><path d="M12 5a7 7 0 0 1 0 14"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/>',
    paste: '<path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><rect x="8" y="3" width="8" height="5" rx="1.5"/>',
    clear: '<path d="M5 5l14 14"/><path d="M19 5 5 19"/>',
    check: '<path d="M20 7 9.5 17.5 4 12"/>',
    error: '<circle cx="12" cy="12" r="8"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/>',
    eye: '<path d="M3 12s3.2-5.5 9-5.5 9 5.5 9 5.5-3.2 5.5-9 5.5S3 12 3 12z"/><circle cx="12" cy="12" r="2.5"/>',
    eyeOff: '<path d="M3 12s3.2-5.5 9-5.5c1.4 0 2.7.3 3.8.8"/><path d="M21 12s-3.2 5.5-9 5.5c-1.4 0-2.7-.3-3.8-.8"/><path d="M4 4l16 16"/><path d="M10.6 10.6a2.5 2.5 0 0 0 2.8 2.8"/>',
    memory: '<rect x="6" y="5" width="12" height="14" rx="3"/><path d="M9 9h6"/><path d="M9 13h4"/><path d="M9 2v3"/><path d="M15 2v3"/><path d="M9 19v3"/><path d="M15 19v3"/>',
    clean: '<path d="M5 19h14"/><path d="M8 16l7.8-7.8a2.4 2.4 0 0 0 0-3.4 2.4 2.4 0 0 0-3.4 0L6 11.2V16h4.8"/><path d="M12 7l5 5"/>',
    modelUnload: '<rect x="6" y="5" width="12" height="12" rx="3"/><path d="M9 9h6"/><path d="M9 13h3"/><path d="M9 2v3"/><path d="M15 2v3"/><path d="M9 17v3"/><path d="M15 17v3"/><path d="M12 16v6"/><path d="M9.5 19.5 12 22l2.5-2.5"/>',
    memorySweep: '<rect x="5" y="4" width="12" height="12" rx="3"/><path d="M8 8h6"/><path d="M8 12h4"/><path d="M8 1.8V4"/><path d="M14 1.8V4"/><path d="M8 16v2.2"/><path d="M14 16v2.2"/><path d="M14.5 19.5 20 14"/><path d="M18 12.5 21.5 16"/><path d="M12.5 21h7"/>',
    linkFlow: '<circle cx="6" cy="8" r="2.5"/><circle cx="18" cy="16" r="2.5"/><path d="M8.3 9.1c3.4.8 5.4 3 7.4 5.8"/><path d="M9 16H5a3 3 0 0 1 0-6h1"/><path d="M15 8h4a3 3 0 0 1 0 6h-1"/>',
    linkTune: '<circle cx="5" cy="7" r="2"/><circle cx="19" cy="17" r="2"/><path d="M7 7h4"/><path d="M13 7h6"/><path d="M5 9v4a4 4 0 0 0 4 4h8"/><path d="M11 4v6"/><path d="M15 14v6"/>',
    toolbarCollapse: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M4 10h16"/><path d="M9 14h6"/><path d="M10 17l2-2 2 2"/>',
    toolbarExpand: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M4 10h16"/><path d="M9 15h6"/><path d="M10 13l2 2 2-2"/>',
    floatingText: '<rect x="4" y="6" width="12" height="10" rx="2"/><path d="M7 10h6"/><path d="M9 13h4"/><rect x="14" y="12" width="7" height="7" rx="2"/><path d="M16.2 15.5h2.6"/>',

    catImage: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="9" r="1.5" class="gg-ui-fill"/><circle cx="15.5" cy="9" r="1.5" class="gg-ui-fill"/><path d="M8 14c1 1.5 3 2.5 4 2.5s3-1 4-2.5"/>',
    catLatent: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
    catText: '<path d="M4 7V4"/><path d="M8 7V4"/><path d="M12 7V4"/><path d="M16 7V4"/><path d="M20 7V4"/><path d="M4 10h16"/><path d="M8 14h8"/><path d="M10 18h4"/>',
    catModel: '<path d="M12 3l-2 4h4l-2-4z"/><path d="M4 9h16"/><rect x="6" y="12" width="12" height="9" rx="2"/><path d="M9 15.5h6"/><path d="M9 18.5h4"/>',
    catMask: '<ellipse cx="12" cy="14" rx="9" ry="6"/><path d="M3 14c0-3.5 4-6 9-6s9 2.5 9 6"/><path d="M7 8c2-2 5-3 5-3s3 1 5 3"/>',
    catVideo: '<polygon points="6,4 20,12 6,20" class="gg-ui-fill"/><path d="M22 7h-4v10h4"/><path d="M22 12h2"/>',
    catAI: '<path d="M12 2a7 7 0 0 1 7 7 7 7 0 0 1-7 7c-1.5 0-3-.5-4-1.5L4 18v-5a7 7 0 0 1-1-4A7 7 0 0 1 12 2z"/><circle cx="9" cy="10" r="1" class="gg-ui-fill"/><circle cx="15" cy="10" r="1" class="gg-ui-fill"/><path d="M9 14c1.5 1 3.5 1 5 0"/>',
    catWorkflow: '<rect x="3" y="3" width="18" height="6" rx="2"/><rect x="3" y="15" width="18" height="6" rx="2"/><path d="M7 15V9"/><path d="M17 15V9"/>',
    catInput: '<rect x="2" y="8" width="14" height="10" rx="2"/><path d="M16 11h4v2h-4"/><path d="M20 11l3 1.5L20 14"/><path d="M6 12h6"/>',
    catSample: '<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z"/><path d="M12 6v6l4 2"/>',
    sparkle: '<path d="M12 2l2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2L12 2z"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" class="gg-ui-fill"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="9" r="1.5" class="gg-ui-fill"/><path d="M3 16l5-5 4 4 3-3 5 5v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3z"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V19a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};

const CATEGORY_COLORS = {
    "GuliNodes/图像":   { accent: "#6366f1", soft: "rgba(99,102,241,0.12)", border: "rgba(99,102,241,0.26)", icon: "catImage" },
    "GuliNodes/潜空间": { accent: "#8b5cf6", soft: "rgba(139,92,246,0.12)", border: "rgba(139,92,246,0.26)", icon: "catLatent" },
    "GuliNodes/文本":   { accent: "#ec4899", soft: "rgba(236,72,153,0.12)", border: "rgba(236,72,153,0.26)", icon: "catText" },
    "GuliNodes/模型":   { accent: "#f59e0b", soft: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.26)", icon: "catModel" },
    "GuliNodes/蒙版":   { accent: "#14b8a6", soft: "rgba(20,184,166,0.12)", border: "rgba(20,184,166,0.26)", icon: "catMask" },
    "GuliNodes/视频":   { accent: "#06b6d4", soft: "rgba(6,182,212,0.12)", border: "rgba(6,182,212,0.26)", icon: "catVideo" },
    "GuliNodes/AI":     { accent: "#7c3aed", soft: "rgba(124,58,237,0.12)", border: "rgba(124,58,237,0.26)", icon: "catAI" },
    "GuliNodes/工作流": { accent: "#78716c", soft: "rgba(120,113,108,0.12)", border: "rgba(120,113,108,0.26)", icon: "catWorkflow" },
    "GuliNodes/输入":   { accent: "#059669", soft: "rgba(5,150,105,0.12)", border: "rgba(5,150,105,0.26)", icon: "catInput" },
    "GuliNodes/采样":   { accent: "#64748b", soft: "rgba(100,116,139,0.12)", border: "rgba(100,116,139,0.26)", icon: "catSample" },
};

let styleInstalled = false;

export function ensureGGIconStyles() {
    if (styleInstalled || document.getElementById("gg-ui-icon-system")) return;
    styleInstalled = true;

    const categoryCSSEntries = Object.entries(CATEGORY_COLORS).map(([cat, c]) => `
        .gg-cat-${cssEscape(cat)} { --gg-cat-accent: ${c.accent}; --gg-cat-soft: ${c.soft}; --gg-cat-border: ${c.border}; }
    `).join("");

    const style = document.createElement("style");
    style.id = "gg-ui-icon-system";
    style.textContent = `
        :root {
            --gg-ui-ink: #3f4856;
            --gg-ui-muted: #6b7280;
            --gg-ui-accent: #3b82f6;
            --gg-ui-accent-soft: rgba(59, 130, 246, 0.13);
            --gg-ui-accent-border: rgba(59, 130, 246, 0.28);
            --gg-ui-danger: #ef4444;
            --gg-ui-success: #22c55e;
            --gg-ui-warning: #f59e0b;
        }
        ${categoryCSSEntries}
        .gg-ui-icon {
            display: block;
            flex: 0 0 auto;
            color: inherit;
            fill: none;
            stroke: currentColor;
            stroke-width: 2.15;
            stroke-linecap: round;
            stroke-linejoin: round;
            vector-effect: non-scaling-stroke;
        }
        .gg-ui-icon .gg-ui-fill {
            fill: currentColor;
            stroke: none;
        }
        #gg-nodes-panel .tool-btn,
        #gg-toolbar-settings .tool-btn,
        .gg-float-toolbar button,
        .gg-key-input-toggle,
        .gg-key-input-mask,
        .gg-key-input-test,
        .gg-ui-top-button {
            color: var(--gg-ui-ink);
        }
        #gg-nodes-panel .tool-btn:hover,
        #gg-toolbar-settings .tool-btn:hover,
        .gg-float-toolbar button:hover,
        .gg-key-input-toggle:hover,
        .gg-key-input-mask:hover,
        .gg-key-input-test:hover,
        .gg-ui-top-button:hover {
            color: var(--gg-ui-accent) !important;
            background: var(--gg-ui-accent-soft) !important;
            border-color: var(--gg-ui-accent-border) !important;
        }
        #gg-nodes-panel .tool-btn.active,
        #gg-toolbar-settings .tool-btn.active,
        .gg-float-toolbar button.gg-state-success,
        .gg-ui-top-button.active {
            color: var(--gg-ui-accent) !important;
            background: rgba(59, 130, 246, 0.17) !important;
            border-color: var(--gg-ui-accent-border) !important;
        }
        .gg-ui-icon-success { color: var(--gg-ui-success); }
        .gg-ui-icon-error { color: var(--gg-ui-danger); }
        .gg-ui-icon-warning { color: var(--gg-ui-warning); }
        
        div[data-id^="GuliNodes"] {
            border-bottom: 1px solid rgba(148, 163, 184, 0.15);
            padding: 10px 0;
        }
        div[data-id^="GuliNodes"]:last-of-type {
            border-bottom: none;
        }
        div[data-id^="GuliNodes"] + div[data-id^="GuliNodes"] {
            border-top: 1px solid rgba(148, 163, 184, 0.12);
        }

        /* ===== 设置面板参数行边框间隔 ===== */
        .comfy-settings-panel .comfy-setting-row,
        #comfy-settings-dialog .comfy-setting-row,
        .comfy-modal .comfy-setting-row,
        .comfy-menu .comfy-setting-row,
        [class*="setting-row"],
        .comfy-list .comfy-list-item {
            border-bottom: 1px solid rgba(148, 163, 184, 0.13) !important;
            padding: 10px 8px !important;
            margin: 0 !important;
            transition: background-color 0.15s ease;
        }
        .comfy-settings-panel .comfy-setting-row:last-child,
        #comfy-settings-dialog .comfy-setting-row:last-child,
        .comfy-modal .comfy-setting-row:last-child,
        .comfy-menu .comfy-setting-row:last-child,
        .comfy-list .comfy-list-item:last-child {
            border-bottom: none !important;
        }
        .comfy-settings-panel .comfy-setting-row:hover,
        #comfy-settings-dialog .comfy-setting-row:hover {
            background: rgba(99, 102, 241, 0.04) !important;
        }

        /* 设置面板容器内边距 */
        .comfy-settings-panel,
        #comfy-settings-dialog,
        .comfy-modal {
            padding: 4px 0 !important;
        }

        .gg-settings-about-row {
            padding-bottom: 16px !important;
            border-bottom: 1px solid rgba(148, 163, 184, 0.2) !important;
            margin-bottom: 8px !important;
        }
    `;
    document.head.appendChild(style);
}

function cssEscape(str) {
    return str.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export function ggIcon(name, size = 20, className = "") {
    ensureGGIconStyles();
    const paths = ICONS[name] || ICONS.more;
    const classes = ["gg-ui-icon", `gg-ui-icon-${name}`, className].filter(Boolean).join(" ");
    return `<svg class="${classes}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
}

export function getCategoryColor(category) {
    return CATEGORY_COLORS[category] || { accent: "#64748b", soft: "rgba(100,116,139,0.12)", border: "rgba(100,116,139,0.26)" };
}

export function getCategoryIcon(category) {
    const info = CATEGORY_COLORS[category] || {};
    return info.icon || "folder";
}

export { ICONS, CATEGORY_COLORS };

const CONTROL_AFTER_GENERATE_I18N = {
    "fixed": "固定",
    "increment": "递增",
    "decrement": "递减",
    "randomize": "随机",
};

function localizeControlAfterGenerate() {
    const observer = new MutationObserver(() => {
        document.querySelectorAll(".comfy-widget-combo").forEach(combo => {
            const select = combo.querySelector("select");
            if (!select) return;
            let changed = false;
            for (const opt of select.options) {
                const cn = CONTROL_AFTER_GENERATE_I18N[opt.value];
                if (cn && opt.textContent !== cn) {
                    opt.textContent = cn;
                    changed = true;
                }
            }
            if (changed && select._litegraph_combo) {
                select._litegraph_combo.options = Array.from(select.options).map(o => ({
                    content: o.textContent,
                    value: o.value,
                }));
            }
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    if (window.app?.registerExtension) {
        window.app.registerExtension({
            name: "GuliNodes.I18N",
            nodeCreated(node) {
                requestAnimationFrame(() => {
                    node.widgets?.forEach(w => {
                        if (w.options?.values && w.type === "combo") {
                            const values = w.options.values;
                            const localized = values.map(v => CONTROL_AFTER_GENERATE_I18N[v] || v);
                            if (JSON.stringify(values) !== JSON.stringify(localized)) {
                                w.options.values = localized;
                                if (w.callback) w.callback(w.value);
                            }
                        }
                    });
                });
            },
        });
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", localizeControlAfterGenerate);
} else {
    localizeControlAfterGenerate();
}

/* ===== 动态注入设置面板边框样式 ===== */
function injectSettingRowBorders() {
    const styleId = "gulinodes-setting-borders";
    if (document.getElementById(styleId)) return;

    const css = `
        /* 通用设置行 - 覆盖所有可能的容器 */
        .comfy-settings-panel > div:not([class*="title"]):not([class*="header"]):not([class*="close"]),
        #comfy-settings-dialog > div,
        .comfy-modal-content > div > div,
        [id*="settings"] > div > div,
        [class*="dialog"] [class*="row"],
        [class*="panel"] [class*="row"] {
            border-bottom: 1px solid rgba(148,163,184,0.12) !important;
            padding: 8px 6px !important;
        }
        [class*="dialog"] [class*="row"]:last-child,
        [class*="panel"] [class*="row"]:last-child {
            border-bottom: none !important;
        }
    `;
    const s = document.createElement("style");
    s.id = styleId;
    s.textContent = css;
    document.head.appendChild(s);

    new MutationObserver(() => {
        document.querySelectorAll('[class*="setting"], [class*="Setting"]').forEach(el => {
            if (el.children.length > 1 && el.children[0].tagName !== 'BUTTON' &&
                el.offsetHeight > 20 && el.offsetHeight < 120) {
                el.style.borderBottom = '1px solid rgba(148,163,184,0.12)';
                el.style.padding = '8px 4px';
            }
        });
    }).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectSettingRowBorders);
} else {
    injectSettingRowBorders();
}
