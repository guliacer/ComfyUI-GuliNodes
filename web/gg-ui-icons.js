const ICONS = {
    brush: '<path d="m16.5 3.5 4 4L8 20l-5 1 1-5L16.5 3.5z"/><path d="m13.2 6.8 4 4"/>',
    toolGrid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2" class="gg-ui-fill"/>',
    palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.6 0 2.2-1 1.7-2.1-.6-1.3.2-2.4 1.7-2.4h1.9c2 0 3.2-1.3 3.2-3.4C20.5 7.6 16.7 3.5 12 3.5z"/><circle cx="7.5" cy="10.5" r="1.1" class="gg-ui-fill"/><circle cx="11" cy="7.5" r="1.1" class="gg-ui-fill"/><circle cx="15.5" cy="8.5" r="1.1" class="gg-ui-fill"/>',
    node: '<rect x="5" y="5" width="14" height="14" rx="4"/><circle cx="5" cy="10" r="1.4" class="gg-ui-fill"/><circle cx="19" cy="14" r="1.4" class="gg-ui-fill"/><path d="M9 9.2h6"/><path d="M9 13h4.5"/>',
    body: '<rect x="5" y="5" width="14" height="14" rx="4"/><path d="M5 10h14"/><path d="M8.5 14h7"/><path d="M8.5 16.7h5"/>',
    title: '<rect x="5" y="5" width="14" height="14" rx="4"/><path d="M5 10h14"/><path d="M8 7.6h8"/>',
    trash: '<path d="M5 7.5h14"/><path d="M9 7.5V5.3h6v2.2"/><path d="m7.2 7.5.8 12.2h8l.8-12.2"/><path d="M10.3 11.2v5.2"/><path d="M13.7 11.2v5.2"/>',
    pipette: '<path d="m14.5 4 5.5 5.5"/><path d="m17.2 6.8-8.8 8.8-3.6.8.8-3.6 8.8-8.8"/><path d="M4.5 20h5"/>',
    more: '<circle cx="5.5" cy="12" r="1.35" class="gg-ui-fill"/><circle cx="12" cy="12" r="1.35" class="gg-ui-fill"/><circle cx="18.5" cy="12" r="1.35" class="gg-ui-fill"/>',
    width: '<path d="M4 6.5v11"/><path d="M20 6.5v11"/><path d="M7.5 12h9"/><path d="m10 9.5-2.5 2.5L10 14.5"/><path d="m14 9.5 2.5 2.5L14 14.5"/>',
    height: '<path d="M6.5 4h11"/><path d="M6.5 20h11"/><path d="M12 7.5v9"/><path d="m9.5 10 2.5-2.5L14.5 10"/><path d="m9.5 14 2.5 2.5L14.5 14"/>',
    alignLeft: '<path d="M5 5v14"/><rect x="8" y="6.5" width="10.5" height="3.2" rx="1.2"/><rect x="8" y="11" width="7.5" height="3.2" rx="1.2"/><rect x="8" y="15.5" width="5.5" height="3.2" rx="1.2"/>',
    alignRight: '<path d="M19 5v14"/><rect x="5.5" y="6.5" width="10.5" height="3.2" rx="1.2"/><rect x="8.5" y="11" width="7.5" height="3.2" rx="1.2"/><rect x="10.5" y="15.5" width="5.5" height="3.2" rx="1.2"/>',
    alignHCenter: '<path d="M12 5v14"/><rect x="6.5" y="6.5" width="11" height="3.2" rx="1.2"/><rect x="8.5" y="11" width="7" height="3.2" rx="1.2"/><rect x="7.5" y="15.5" width="9" height="3.2" rx="1.2"/>',
    alignTop: '<path d="M5 5h14"/><rect x="6.5" y="8" width="3.2" height="10.5" rx="1.2"/><rect x="11" y="8" width="3.2" height="7.5" rx="1.2"/><rect x="15.5" y="8" width="3.2" height="5.5" rx="1.2"/>',
    alignBottom: '<path d="M5 19h14"/><rect x="6.5" y="5.5" width="3.2" height="10.5" rx="1.2"/><rect x="11" y="8.5" width="3.2" height="7.5" rx="1.2"/><rect x="15.5" y="10.5" width="3.2" height="5.5" rx="1.2"/>',
    alignVCenter: '<path d="M5 12h14"/><rect x="6.5" y="6.5" width="3.2" height="11" rx="1.2"/><rect x="11" y="8.5" width="3.2" height="7" rx="1.2"/><rect x="15.5" y="7.5" width="3.2" height="9" rx="1.2"/>',
    spacing: '<path d="M5 6h14"/><path d="M5 18h14"/><path d="M12 8.5v7"/><path d="m10.6 9.9 1.4-1.4 1.4 1.4"/><path d="m10.6 14.1 1.4 1.4 1.4-1.4"/>',
    fit: '<path d="M8 4H5.5A1.5 1.5 0 0 0 4 5.5V8"/><path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8"/><path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16"/><path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><rect x="8.5" y="8.5" width="7" height="7" rx="2"/>',
    close: '<rect x="5" y="5" width="14" height="14" rx="7"/><path d="m9.2 9.2 5.6 5.6"/><path d="m14.8 9.2-5.6 5.6"/>',
    reset: '<path d="M4.7 10.2A7.5 7.5 0 1 1 6.8 17"/><path d="M4.5 5.5v4.8h4.8"/>',
    opacity: '<path d="M12 3.8s6.2 6 6.2 10.2a6.2 6.2 0 0 1-12.4 0C5.8 9.8 12 3.8 12 3.8z"/><path d="M12 6.2v13.5"/><path d="M12 19.7a4.5 4.5 0 0 0 0-9"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 4.5h-8a3 3 0 0 0-3 3v8"/>',
    paste: '<rect x="4.5" y="5.5" width="15" height="15.5" rx="3"/><rect x="9" y="2.8" width="6" height="3.7" rx="1.3"/>',
    clear: '<path d="m5 5 14 14"/><path d="m19 5-14 14"/>',
    check: '<path d="m20 7-10.5 10L4 11.8"/>',
    error: '<rect x="5" y="5" width="14" height="14" rx="7"/><path d="m9.2 9.2 5.6 5.6"/><path d="m14.8 9.2-5.6 5.6"/>',
    eye: '<path d="M3.5 12s3.2-5.2 8.5-5.2 8.5 5.2 8.5 5.2-3.2 5.2-8.5 5.2S3.5 12 3.5 12z"/><circle cx="12" cy="12" r="2.4"/>',
    eyeOff: '<path d="M4 4l16 16"/><path d="M8.4 8.2C5.4 9.5 3.5 12 3.5 12s3.2 5.2 8.5 5.2c1.5 0 2.8-.4 3.9-1"/><path d="M10.4 6.9c.5-.1 1-.1 1.6-.1 5.3 0 8.5 5.2 8.5 5.2s-.8 1.4-2.3 2.7"/><path d="M10.8 10.8a2.4 2.4 0 0 0 2.4 2.4"/>',
    memory: '<rect x="6" y="5" width="12" height="14" rx="3"/><path d="M9 9h6"/><path d="M9 12h6"/><path d="M9 15h3.5"/><path d="M8 2.5v2.5"/><path d="M12 2.5v2.5"/><path d="M16 2.5v2.5"/><path d="M8 19v2.5"/><path d="M12 19v2.5"/><path d="M16 19v2.5"/>',
    clean: '<path d="M5 19h14"/><path d="M7 16l8.4-8.4a2.3 2.3 0 0 0-3.2-3.2L5 11.6V16h4.4"/><path d="m12.1 6.5 3.4 3.4"/><path d="M16.5 15.5h3"/><path d="M18 14v3"/>',
    modelUnload: '<rect x="6" y="4.5" width="12" height="12" rx="3"/><path d="M9 8.5h6"/><path d="M9 12h3.5"/><path d="M8.5 2.5v2"/><path d="M15.5 2.5v2"/><path d="M12 16.5v5"/><path d="m9.8 19.3 2.2 2.2 2.2-2.2"/>',
    memorySweep: '<path d="M20.5 3.5 14 10"/><path d="M12.2 8.6 5 14.2a6.6 6.6 0 0 0 4.8 4.8l5.6-7.2z"/><path d="m8.6 12.4 3 3"/><path d="M3.5 20.5h3"/>',
    linkFlow: '<circle cx="5.5" cy="6.5" r="2.1"/><circle cx="18.5" cy="17.5" r="2.1"/><path d="M7.6 6.5h6a4.9 4.9 0 0 1 4.9 4.9v4"/>',
    linkTune: '<circle cx="5.5" cy="6.5" r="2.1"/><circle cx="18.5" cy="17.5" r="2.1"/><path d="M7.6 6.5h6a4.9 4.9 0 0 1 4.9 4.9v4"/><circle cx="13.6" cy="6.5" r="1.2" class="gg-ui-fill"/><circle cx="18.5" cy="11.4" r="1.2" class="gg-ui-fill"/>',
    toolbarCollapse: '<rect x="4.5" y="5.5" width="15" height="13" rx="3"/><path d="M4.5 10h15"/><path d="M9 14.5h6"/><path d="m9.5 17 2.5-2.5 2.5 2.5"/>',
    toolbarExpand: '<rect x="4.5" y="5.5" width="15" height="13" rx="3"/><path d="M4.5 10h15"/><path d="M9 14.5h6"/><path d="m9.5 12.8 2.5 2.5 2.5-2.5"/>',
    nodeCollapse: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M4 9.5h16"/><path d="m9.5 16.5 2.5-2.5 2.5 2.5"/>',
    nodeExpand: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M4 9.5h16"/><path d="m9.5 14 2.5 2.5 2.5-2.5"/>',
    nodePin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
    nodePinOff: '<path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/><path d="m2 2 20 20"/>',
    nodeAlign: '<path d="M12 3v18" stroke-dasharray="3 2.4"/><rect x="3.5" y="6" width="6.2" height="5" rx="1.5"/><rect x="14.3" y="13" width="6.2" height="5" rx="1.5"/>',
    portList: '<rect x="8" y="9" width="8" height="6" rx="1.8"/><path d="M2.5 10.5H8"/><path d="M2.5 13.5H8"/><path d="M16 10.5h5.5"/><path d="M16 13.5h5.5"/>',
    floatingText: '<rect x="4" y="5" width="13" height="11" rx="3"/><path d="M7.5 9h6"/><path d="M7.5 12h4"/><rect x="13.5" y="12.5" width="6.5" height="6.5" rx="2"/><path d="M15.6 15.8h2.3"/>',
    groupStyle: '<rect x="3.5" y="3.5" width="17" height="17" rx="4" stroke-dasharray="3.2 2.4"/><rect x="8.2" y="8.2" width="7.6" height="7.6" rx="1.8"/>',
    translate: '<path d="M3.5 5.5h8"/><path d="M7.5 3.5v2"/><path d="M11.5 5.5c-.4 4-3.2 7.3-8 9"/><path d="M4.5 8.8c1.5 2.7 3.9 4.4 6.5 5"/><path d="m13.5 20.5 4-11 4 11"/><path d="M15 17h5"/>',
    tagName: '<path d="M12.6 3.5H5.5a2 2 0 0 0-2 2v7.1a2 2 0 0 0 .6 1.4l7.3 7.3a2 2 0 0 0 2.8 0l7.1-7.1a2 2 0 0 0 0-2.8l-7.3-7.3a2 2 0 0 0-1.4-.6z"/><circle cx="8" cy="8" r="1.3" class="gg-ui-fill"/>',

    catImage: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="9" r="1.5" class="gg-ui-fill"/><circle cx="15.5" cy="9" r="1.5" class="gg-ui-fill"/><path d="M8 14c1 1.5 3 2.5 4 2.5s3-1 4-2.5"/>',
    catLatent: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
    catText: '<path d="M4 7V4"/><path d="M8 7V4"/><path d="M12 7V4"/><path d="M16 7V4"/><path d="M20 7V4"/><path d="M4 10h16"/><path d="M8 14h8"/><path d="M10 18h4"/>',
    catModel: '<path d="M12 3l-2 4h4l-2-4z"/><path d="M4 9h16"/><rect x="6" y="12" width="12" height="9" rx="2"/><path d="M9 15.5h6"/><path d="M9 18.5h4"/>',
    catMask: '<ellipse cx="12" cy="14" rx="9" ry="6"/><path d="M3 14c0-3.5 4-6 9-6s9 2.5 9 6"/><path d="M7 8c2-2 5-3 5-3s3 1 5 3"/>',
    catVideo: '<polygon points="6,4 20,12 6,20" class="gg-ui-fill"/><path d="M22 7h-4v10h4"/><path d="M22 12h2"/>',
    catAI: '<path d="M12 2a7 7 0 0 1 7 7 7 7 0 0 1-7 7c-1.5 0-3-.5-4-1.5L4 18v-5a7 7 0 0 1-1-4A7 7 0 0 1 12 2z"/><circle cx="9" cy="10" r="1" class="gg-ui-fill"/><circle cx="15" cy="10" r="1" class="gg-ui-fill"/><path d="M9 14c1.5 1 3.5 1 5 0"/>',
    catWorkflow: '<rect x="4" y="5" width="16" height="14" rx="4"/><rect x="7.5" y="8" width="4.2" height="3.2" rx="1.2"/><rect x="12.3" y="12.8" width="4.2" height="3.2" rx="1.2"/><path d="M11.7 9.6h2.1a2 2 0 0 1 2 2v1.2"/><path d="M12.3 14.4h-2.1a2 2 0 0 1-2-2v-1.2"/>',
    catInput: '<rect x="2" y="8" width="14" height="10" rx="2"/><path d="M16 11h4v2h-4"/><path d="M20 11l3 1.5L20 14"/><path d="M6 12h6"/>',
    catSample: '<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z"/><path d="M12 6v6l4 2"/>',
    sparkle: '<path d="M12 2l2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2L12 2z"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" class="gg-ui-fill"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10.3 21h3.4"/>',
    bellOff: '<path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="M18 8a6 6 0 0 0-9.5-4.9"/><path d="M6 8c0 7-3 7-3 9h12"/><path d="M18 17h3"/><path d="m3 3 18 18"/>',
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
        .gg-key-input-test:hover {
            color: var(--gg-ui-accent) !important;
            background: var(--gg-ui-accent-soft) !important;
            border-color: var(--gg-ui-accent-border) !important;
        }
        /* 顶栏开关按钮：悬停只加深底色，不改变颜色，避免「未开启悬停时像已开启」 */
        .gg-ui-top-button:hover,
        .gg-ui-top-button:focus-visible {
            background: rgba(148, 163, 184, 0.16) !important;
        }
        /* 开关两态：关 = 灰，开 = 主题色 */
        .gg-ui-top-button.gg-state-off {
            color: var(--gg-ui-muted, #6b7280) !important;
            background: rgba(148, 163, 184, 0.08) !important;
            border-color: rgba(148, 163, 184, 0.18) !important;
        }
        .gg-ui-top-button.gg-state-on,
        .gg-ui-top-button.active {
            color: var(--gg-ui-accent) !important;
            background: rgba(59, 130, 246, 0.17) !important;
            border-color: var(--gg-ui-accent-border) !important;
        }
        .gg-ui-top-button.gg-state-on:hover,
        .gg-ui-top-button.active:hover {
            background: rgba(59, 130, 246, 0.26) !important;
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

function ggDebounce(fn, delay = 200) {
    let timer = null;
    return () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; fn(); }, delay);
    };
}

function localizeControlAfterGenerate() {
    const runScan = () => {
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
    };
    const observer = new MutationObserver(ggDebounce(runScan));
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

    new MutationObserver(ggDebounce(() => {
        document.querySelectorAll('[class*="setting"], [class*="Setting"]').forEach(el => {
            if (el.children.length > 1 && el.children[0].tagName !== 'BUTTON' &&
                el.offsetHeight > 20 && el.offsetHeight < 120) {
                el.style.borderBottom = '1px solid rgba(148,163,184,0.12)';
                el.style.padding = '8px 4px';
            }
        });
    })).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectSettingRowBorders);
} else {
    injectSettingRowBorders();
}
