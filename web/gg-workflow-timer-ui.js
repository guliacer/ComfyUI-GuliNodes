import { PALETTES, ensureGGDesign, applySurface, detectHostTheme, parseCssColor, mixColor, rgbToHex } from "./gg-ui-design.js";
import { colorWithOpacity, fontString, drawRoundRect, drawTextLine, measureTextLine } from "./gg-title-node.js";

const STYLE_ID = "gg-workflow-timer-dashboard-style";
const CUSTOM_STYLE_KEY = "_gg_workflow_timer_presentation";
const ROW_TONES = ["timerPurple", "accent", "timerTeal"];
const STATUS = {
  success: { label: "执行成功", tone: "ok" },
  running: { label: "运行中", tone: "accent" },
  error: { label: "执行失败", tone: "danger" },
  interrupted: { label: "已中断", tone: "warning" },
  disconnected: { label: "连接中断", tone: "warning" },
};
const domViews = new WeakMap();
let metricContext = null;

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function formatDashboardDuration(ms) {
  if (ms === null || ms === undefined || ms === "" || !Number.isFinite(Number(ms)) || Number(ms) < 0) return "—";
  const ticks = Math.round(Number(ms) / 10);
  if (ticks < 6000) return `${(ticks / 100).toFixed(2)}s`;
  const seconds = Math.round(ticks / 100);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}h ${minutes}m ${remainder}s` : `${minutes}m ${remainder}s`;
}

export function dashboardView(summary, display, width, height, config = {}, active = true) {
  const showTotal = display !== "耗时最长的三个节点";
  const showTop = display !== "总用时";
  const stacked = showTotal && showTop && width < 480;
  const nodes = Array.isArray(summary?.topNodes) ? summary.topNodes : [];
  const ranked = nodes.filter(node => node && Number.isFinite(Number(node.ms)) && Number(node.ms) >= 0)
    .slice().sort((a, b) => Number(b.ms) - Number(a.ms)).slice(0, 3);
  const maximum = Math.max(0, ...ranked.map(node => Number(node.ms)));
  const rows = ranked.map((node, index) => ({
    id: String(node.id), name: String(node.name || "节点").replace(/[\r\n]+/g, " "),
    time: formatDashboardDuration(node.ms), ratio: maximum > 0 ? Number(node.ms) / maximum : 0,
    rank: index + 1, tone: ROW_TONES[index],
  }));
  const status = !active ? { label: "统计已关闭", tone: "muted" } : STATUS[summary?.status] ?? { label: "等待执行", tone: "muted" };
  const emptyText = !summary ? "暂无耗时数据" : summary.status === "running" ? "等待节点耗时记录"
    : summary.cachedCount > 0 && !rows.length ? "本次全部命中缓存" : "暂无可统计的节点";
  const padding = Math.min(number(config.padding, 18), Math.max(2, Math.min(width, height) / 6));
  const gap = Math.min(18, Math.max(8, width * 0.025));
  const fontScale = Math.max(0.6, Math.min(2, number(config.fontSize, 32) / 32));
  const headerHeight = Math.min(40 * fontScale, Math.max(22, height * 0.15));
  const bodyY = padding + headerHeight + gap;
  const bodyHeight = Math.max(1, height - bodyY - padding);
  const innerWidth = Math.max(1, width - padding * 2);
  const totalWidth = showTotal && showTop && !stacked ? Math.max(1, (innerWidth - gap) * 0.34) : innerWidth;
  const totalHeight = stacked ? Math.min(78 * fontScale, bodyHeight * 0.31) : bodyHeight;
  const rankingX = showTotal && !stacked ? padding + totalWidth + gap : padding;
  const rankingY = stacked ? bodyY + totalHeight + gap : bodyY;
  const rankingHeight = stacked ? Math.max(1, bodyHeight - totalHeight - gap) : bodyHeight;
  const rankingWidth = showTotal && !stacked ? Math.max(1, innerWidth - totalWidth - gap) : innerWidth;
  const listHeadingHeight = Math.min(27 * fontScale, Math.max(16, rankingHeight * 0.2));
  const rowGap = Math.min(14, Math.max(4, rankingHeight * 0.065));
  const rowArea = Math.max(1, rankingHeight - listHeadingHeight - 8);
  const rowHeight = Math.max(1, Math.min(58 * fontScale, (rowArea - rowGap * Math.max(0, rows.length - 1)) / Math.max(1, rows.length)));
  const listTop = rankingY + listHeadingHeight + 8 + Math.max(0, (rowArea - rows.length * rowHeight - rowGap * Math.max(0, rows.length - 1)) / 2);
  const diameter = Math.max(1, Math.min(196, totalWidth - 12, totalHeight - 4));
  const rowFont = Math.max(10, Math.min(16 * fontScale, rowHeight * 0.5));
  const totalFont = Math.max(12, Math.min(48 * fontScale, totalWidth * 0.22, totalHeight * (stacked ? 0.47 : 0.25)));
  return {
    title: "GG 耗时", status, totalText: summary ? formatDashboardDuration(summary.totalMs) : "—", emptyText,
    rows, showTotal, showTop, stacked, estimated: !!summary?.estimated, ring: showTotal && !stacked && diameter >= 90,
    layout: { width, height, padding, gap, headerHeight, bodyY, bodyHeight, totalWidth, totalHeight,
      rankingX, rankingY, rankingWidth, rankingHeight, listHeadingHeight, listTop, rowHeight, rowGap, diameter, rowFont, totalFont,
      titleFont: Math.max(12, Math.min(24 * fontScale, headerHeight * 0.68)),
      headingFont: Math.max(11, Math.min(18 * fontScale, listHeadingHeight * 0.72)),
      statusFont: Math.max(10, Math.min(13 * fontScale, headerHeight * 0.52)),
      captionFont: Math.max(10, Math.min(15 * fontScale, totalHeight * 0.21)),
      barHeight: Math.max(3, Math.min(8, rowHeight * 0.16)),
      rankSize: Math.max(14, Math.min(22, rowHeight * 0.65)),
      barGap: Math.max(3, Math.min(6, rowHeight * 0.14)),
    },
  };
}

function readStyle(node, name, fallback) {
  return node.widgets?.find(widget => widget.name === name)?.value ?? node.properties?.[name] ?? fallback;
}

function surface(node, config = {}) {
  const custom = node.properties?.[CUSTOM_STYLE_KEY] ?? {};
  const background = config.backgroundColor ?? readStyle(node, "背景颜色", "transparent");
  const opacity = number(config.backgroundOpacity ?? readStyle(node, "背景不透明度", 0), 0);
  const changed = custom.background || String(background).toLowerCase() !== "transparent" || opacity > 0;
  // 默认随宿主明暗主题切换；手动背景按合成后的亮度选择配色。
  let mode = "auto";
  if (changed) {
    const rgb = parseCssColor(background);
    if (rgb && opacity > 0) {
      const backdrop = parseCssColor(PALETTES[detectHostTheme()].canvas);
      const composite = mixColor(backdrop, rgb, Math.min(1, opacity / 100));
      mode = (0.2126 * composite[0] + 0.7152 * composite[1] + 0.0722 * composite[2]) / 255 > 0.55 ? "light" : "dark";
    }
  }
  const palette = PALETTES[mode === "auto" ? detectHostTheme() : mode];
  return {
    mode, palette, background: changed ? colorWithOpacity(background, opacity) : palette.card,
    padding: custom.padding || number(config.padding, 0) !== 0 ? number(config.padding, 0) : 18,
    radius: custom.radius || number(config.borderRadius, 0) !== 0 ? number(config.borderRadius, 0) : 18,
  };
}

function ensureStyles() {
  ensureGGDesign();
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style"); style.id = STYLE_ID;
  style.textContent = `
    .gg-title-dom-label.gg-timer-dashboard {
      box-sizing:border-box; display:flex; flex-direction:column; gap:var(--gg-timer-gap);
      width:100%; height:100%; padding:var(--gg-timer-padding); border-radius:var(--gg-timer-radius);
      background:var(--gg-timer-background); color:var(--gg-timer-ink); white-space:normal;
      box-shadow:0 8px 22px color-mix(in srgb,var(--gg-muted) 14%,transparent);
      overflow:hidden; line-height:1.2; writing-mode:horizontal-tb;
    }
    .gg-timer-header { display:flex; align-items:center; justify-content:space-between; gap:12px; height:var(--gg-timer-header-height); flex:0 0 var(--gg-timer-header-height); min-width:0; }
    .gg-timer-title { display:flex; align-items:center; gap:10px; min-width:0; font-size:var(--gg-timer-title-font); font-weight:700; white-space:nowrap; }
    .gg-timer-title-text { overflow:hidden; text-overflow:ellipsis; }
    .gg-timer-clock { color:var(--gg-accent); flex:0 0 auto; display:inline-flex; }
    .gg-timer-clock svg { width:1.1em; height:1.1em; display:block; }
    .gg-timer-status { --gg-timer-status-tone:var(--gg-muted); display:inline-flex; align-items:center; gap:5px; flex:0 0 auto; padding:5px 9px; border-radius:999px; font-size:var(--gg-timer-status-font); font-weight:600; white-space:nowrap;
      color:color-mix(in srgb,var(--gg-timer-status-tone) 76%,var(--gg-ink)); background:color-mix(in srgb,var(--gg-timer-status-tone) 10%,var(--gg-card)); }
    .gg-timer-status[data-tone="ok"] { --gg-timer-status-tone:var(--gg-ok); }
    .gg-timer-status[data-tone="accent"] { --gg-timer-status-tone:var(--gg-accent); }
    .gg-timer-status[data-tone="danger"] { --gg-timer-status-tone:var(--gg-danger); }
    .gg-timer-status[data-tone="warning"] { --gg-timer-status-tone:var(--gg-warning); }
    .gg-timer-status-icon { display:inline-flex; width:1em; height:1em; }
    .gg-timer-status-icon svg { width:100%; height:100%; }
    .gg-timer-body { flex:1 1 0; min-height:0; min-width:0; display:grid; gap:var(--gg-timer-gap); }
    .gg-timer-total { position:relative; min-width:0; min-height:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:7px; }
    .gg-timer-total[hidden],.gg-timer-ranking[hidden] { display:none; }
    .gg-timer-ring { position:absolute; width:var(--gg-timer-diameter); height:var(--gg-timer-diameter); left:50%; top:50%; transform:translate(-50%,-50%); border-radius:50%;
      background:conic-gradient(from -90deg,var(--gg-accent),color-mix(in srgb,var(--gg-accent) 74%,var(--gg-card)) 281deg,var(--gg-timer-track) 282deg);
      mask:radial-gradient(farthest-side,transparent calc(100% - 7px),var(--gg-ink) calc(100% - 6px)); }
    .gg-timer-total-clock { position:relative; font-size:24px; color:var(--gg-faint); display:flex; }
    .gg-timer-total-clock svg { width:1em; height:1em; }
    .gg-timer-total-text { position:relative; max-width:100%; padding:0 5px; box-sizing:border-box; font-size:var(--gg-timer-total-font); font-weight:700; letter-spacing:-0.03em; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .gg-timer-total-label { position:relative; color:var(--gg-muted); font-size:var(--gg-timer-caption-font); }
    .gg-timer-ranking { display:flex; flex-direction:column; min-width:0; min-height:0; }
    .gg-timer-ranking-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; height:var(--gg-timer-list-heading-height); flex:0 0 var(--gg-timer-list-heading-height); }
    .gg-timer-ranking-title { margin:0; font-size:var(--gg-timer-heading-font); font-weight:650; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .gg-timer-estimated { color:var(--gg-faint); font-size:10px; flex:0 0 auto; }
    .gg-timer-rows { display:flex; flex-direction:column; justify-content:center; gap:var(--gg-timer-row-gap); flex:1 1 0; min-height:0; min-width:0; padding-top:8px; }
    .gg-timer-row { --gg-timer-row-color:var(--gg-timer-purple); flex:0 0 var(--gg-timer-row-height); min-width:0; }
    .gg-timer-row[data-rank="2"] { --gg-timer-row-color:var(--gg-accent); }
    .gg-timer-row[data-rank="3"] { --gg-timer-row-color:var(--gg-timer-teal); }
    .gg-timer-row-top { display:flex; align-items:center; gap:8px; min-width:0; font-size:var(--gg-timer-row-font); }
    .gg-timer-rank { display:flex; justify-content:center; align-items:center; width:var(--gg-timer-rank-size); height:var(--gg-timer-rank-size); flex:0 0 var(--gg-timer-rank-size); border-radius:7px; font-size:10px; color:var(--gg-timer-row-color); background:color-mix(in srgb,var(--gg-timer-row-color) 11%,var(--gg-card)); }
    .gg-timer-name { min-width:0; flex:1 1 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:var(--gg-timer-text-align); pointer-events:auto; }
    .gg-timer-node-time { flex:0 0 auto; font-weight:600; text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .gg-timer-track { margin:var(--gg-timer-bar-gap) 0 0 var(--gg-timer-rank-space); height:var(--gg-timer-bar-height); border-radius:999px; background:var(--gg-timer-track); overflow:hidden; }
    .gg-timer-fill { display:block; height:100%; border-radius:inherit; background:linear-gradient(90deg,var(--gg-timer-row-color),color-mix(in srgb,var(--gg-timer-row-color) 80%,var(--gg-card))); }
    .gg-timer-empty { margin:auto 0; color:var(--gg-muted); font-size:var(--gg-timer-row-font); text-align:center; }
    .gg-timer-title,.gg-timer-status,.gg-timer-total-text,.gg-timer-total-label,.gg-timer-ranking-heading,.gg-timer-row-top,.gg-timer-empty { opacity:var(--gg-timer-font-opacity); }
    .gg-timer-dashboard[data-stacked="true"] .gg-timer-total-clock { display:none; }
  `;
  document.head.appendChild(style);
}

const CLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6M12 2v3M18 5l2 2"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8l3 3 7-7"/></svg>';

function element(className, parent, text) {
  const node = document.createElement("div"); node.className = className;
  if (text !== undefined) node.textContent = text;
  parent?.appendChild(node); return node;
}

function createDOM(host) {
  host.classList.add("gg-timer-dashboard", "gg-surface"); host.setAttribute("role", "group");
  const header = element("gg-timer-header", host);
  const title = element("gg-timer-title", header);
  element("gg-timer-clock", title).innerHTML = CLOCK_SVG;
  element("gg-timer-title-text", title, "GG 耗时");
  const status = element("gg-timer-status", header);
  const statusIcon = element("gg-timer-status-icon", status);
  const statusText = element("gg-timer-status-text", status); statusText.setAttribute("aria-live", "polite");
  const body = element("gg-timer-body", host);
  const total = element("gg-timer-total", body);
  const ring = element("gg-timer-ring", total); ring.setAttribute("aria-hidden", "true");
  const totalClock = element("gg-timer-total-clock", total); totalClock.innerHTML = CLOCK_SVG;
  const value = element("gg-timer-total-text", total);
  element("gg-timer-total-label", total, "总用时");
  const ranking = element("gg-timer-ranking", body);
  const listHeader = element("gg-timer-ranking-heading", ranking);
  element("gg-timer-ranking-title", listHeader, "耗时最长的 3 个节点");
  const estimated = element("gg-timer-estimated", listHeader, "估算");
  const rows = element("gg-timer-rows", ranking);
  const empty = element("gg-timer-empty", ranking);
  const dom = { header, status, statusIcon, statusText, body, total, ring, totalClock, value, ranking, estimated, rows, empty, rowNodes: [] };
  domViews.set(host, dom); return dom;
}

function createRow() {
  const root = element("gg-timer-row"); const top = element("gg-timer-row-top", root);
  const rank = element("gg-timer-rank", top); const name = element("gg-timer-name", top); const time = element("gg-timer-node-time", top);
  const track = element("gg-timer-track", root); track.setAttribute("aria-hidden", "true");
  const fill = element("gg-timer-fill", track);
  return { root, rank, name, time, fill };
}

function roundRect(ctx, x, y, width, height, radius, color) {
  ctx.beginPath(); drawRoundRect(ctx, x, y, Math.max(0, width), Math.max(0, height), radius);
  ctx.fillStyle = color; ctx.fill();
}

function clock(ctx, x, y, size, color) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, size * 0.09); ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(x, y, size * 0.35, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y - size * 0.16); ctx.lineTo(x, y); ctx.lineTo(x + size * 0.16, y + size * 0.1);
  ctx.moveTo(x - size * 0.1, y - size * 0.46); ctx.lineTo(x + size * 0.1, y - size * 0.46); ctx.stroke(); ctx.restore();
}

function fitText(ctx, text, width, config, size) {
  const chars = Array.from(String(text));
  if (measureTextLine(ctx, text, config, size) <= width) return String(text);
  let low = 0; let high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measureTextLine(ctx, chars.slice(0, middle).join("") + "…", config, size) <= width) low = middle;
    else high = middle - 1;
  }
  return low ? chars.slice(0, low).join("") + "…" : "…";
}

function text(ctx, value, x, y, size, width, color, config, align = "left", strong = false) {
  const style = { ...config, fontColor: color, fontWeight: strong ? "粗体" : config.fontWeight };
  ctx.font = fontString(size, style.fontFamily, style.fontWeight, style.fontStyle);
  ctx.fillStyle = colorWithOpacity(color, config.fontOpacity ?? 100); ctx.textBaseline = "middle";
  drawTextLine(ctx, fitText(ctx, value, width, style, size), x, y, { config: style, fontSize: size, canvasAlign: align });
}

function gradient(ctx, x, y, width, color, palette) {
  const fade = rgbToHex(mixColor(parseCssColor(color), parseCssColor(palette.card), 0.2));
  const fill = ctx.createLinearGradient(x, y, x + width, y); fill.addColorStop(0, color); fill.addColorStop(1, fade); return fill;
}

export function createTimerDashboard({ getSummary, getDisplay, isEnabled = () => true }) {
  const viewFor = (node, layout) => {
    const styles = surface(node, layout.config);
    const view = dashboardView(getSummary(node), getDisplay(node), layout.width, layout.height, { ...layout.config, padding: styles.padding }, isEnabled());
    metricContext ??= document.createElement("canvas").getContext?.("2d") ?? null;
    const l = view.layout;
    if (metricContext) metricContext.font = fontString(l.totalFont, layout.config.fontFamily, "粗体", layout.config.fontStyle);
    const measured = metricContext ? measureTextLine(metricContext, view.totalText, layout.config, l.totalFont) : Array.from(view.totalText).length * l.totalFont * 0.56;
    const available = Math.max(1, view.ring ? l.diameter * 0.81 : l.totalWidth - 8);
    l.totalFont = Math.min(l.totalFont, l.totalFont * available / Math.max(1, measured));
    return { ...view, styles, config: layout.config };
  };
  return {
    defaultFontColor(node) { return surface(node).palette.ink; },
    measure(node, config) {
      const scale = Math.max(0.5, Math.min(3, number(config.fontSize, 32) / 32));
      return [Math.round(760 * scale), Math.round(280 * scale)];
    },
    styleChanged(node, name) {
      const key = name === "内边距" ? "padding" : name === "圆角半径" ? "radius"
        : ["背景颜色", "背景不透明度"].includes(name) ? "background" : null;
      if (key) { node.properties ??= {}; node.properties[CUSTOM_STYLE_KEY] = { ...node.properties[CUSTOM_STYLE_KEY], [key]: true }; }
    },
    drawContent(node, ctx, layout, canvas) {
      const view = viewFor(node, layout); const { styles, config } = view; const l = view.layout; const p = styles.palette;
      ctx.save(); ctx.globalAlpha = 1;
      const zoom = Math.max(0.01, number(canvas?.ds?.scale, 1));
      ctx.shadowColor = colorWithOpacity(p.muted, 14); ctx.shadowBlur = 18 / zoom; ctx.shadowOffsetY = 6 / zoom;
      roundRect(ctx, 0, 0, l.width, l.height, styles.radius, styles.background);
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.beginPath(); drawRoundRect(ctx, 0, 0, l.width, l.height, styles.radius); ctx.clip();
      const headerY = l.padding + l.headerHeight / 2;
      clock(ctx, l.padding + l.titleFont / 2, headerY, l.titleFont, p.accent);
      const statusColor = p[view.status.tone] ?? p.muted;
      const badgeWidth = Math.min(l.width * 0.39, view.status.label.length * l.statusFont + 27);
      const badgeX = l.width - l.padding - badgeWidth;
      roundRect(ctx, badgeX, headerY - l.statusFont, badgeWidth, l.statusFont * 2, l.statusFont, colorWithOpacity(statusColor, 10));
      const badgeInk = rgbToHex(mixColor(parseCssColor(p.ink), parseCssColor(statusColor), 0.76));
      text(ctx, view.status.label, badgeX + badgeWidth / 2, headerY, l.statusFont, badgeWidth - 12, badgeInk, config, "center", true);
      text(ctx, view.title, l.padding + l.titleFont + 10, headerY, l.titleFont, Math.max(1, badgeX - l.padding - l.titleFont - 20), config.fontColor ?? p.ink, config, "left", true);
      if (view.showTotal) {
        const x = l.padding + l.totalWidth / 2; const y = l.bodyY + l.totalHeight / 2;
        if (view.ring) {
          const radius = l.diameter / 2 - 5;
          ctx.save(); ctx.lineWidth = Math.max(5, l.diameter * 0.045); ctx.lineCap = "round";
          ctx.strokeStyle = p.timerTrack; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = gradient(ctx, x - radius, y - radius, radius * 2, p.accent, p);
          // Decorative arc only: there is no invented execution-progress percentage.
          ctx.beginPath(); ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 1.56); ctx.stroke(); ctx.restore();
          clock(ctx, x, y - l.totalFont * 0.8, Math.min(26, l.diameter * 0.17), p.faint);
        }
        const valueY = y + (view.ring ? l.totalFont * 0.1 : -l.captionFont * 0.3);
        const available = Math.max(1, view.ring ? l.diameter * 0.81 : l.totalWidth - 8);
        const size = l.totalFont;
        text(ctx, view.totalText, x, valueY, size, available, config.fontColor ?? p.ink, config, "center", true);
        text(ctx, "总用时", x, valueY + size * 0.6 + l.captionFont, l.captionFont, l.totalWidth - 8, p.muted, config, "center");
      }
      if (view.showTop) {
        if (view.showTotal && !view.stacked) {
          ctx.save(); ctx.strokeStyle = p.divider; ctx.lineWidth = 1; ctx.beginPath();
          ctx.moveTo(l.rankingX - l.gap / 2, l.bodyY + 4); ctx.lineTo(l.rankingX - l.gap / 2, l.bodyY + l.bodyHeight - 4); ctx.stroke(); ctx.restore();
        }
        text(ctx, "耗时最长的 3 个节点", l.rankingX, l.rankingY + l.listHeadingHeight / 2, l.headingFont,
          Math.max(1, l.rankingWidth - (view.estimated ? 40 : 0)), config.fontColor ?? p.ink, config, "left", true);
        if (view.estimated) text(ctx, "估算", l.rankingX + l.rankingWidth, l.rankingY + l.listHeadingHeight / 2, 10, 38, p.faint, config, "right");
        for (const [index, row] of view.rows.entries()) {
          const y = l.listTop + index * (l.rowHeight + l.rowGap); const color = p[row.tone]; const left = l.rankingX + l.rankSize + 8;
          const rankSize = l.rankSize;
          roundRect(ctx, l.rankingX, y + 1, rankSize, rankSize, 6, colorWithOpacity(color, 11));
          text(ctx, String(row.rank), l.rankingX + rankSize / 2, y + rankSize / 2 + 1, 10, rankSize - 2, color, config, "center", true);
          ctx.font = fontString(l.rowFont, config.fontFamily, "粗体", config.fontStyle);
          const durationWidth = measureTextLine(ctx, row.time, config, l.rowFont);
          const nameWidth = Math.max(1, l.rankingWidth - rankSize - 8 - durationWidth - 12);
          const nameX = config.textAlign === "right" ? left + nameWidth : config.textAlign === "center" ? left + nameWidth / 2 : left;
          text(ctx, row.name, nameX, y + Math.max(rankSize, l.rowFont) / 2 + 1, l.rowFont, nameWidth, config.fontColor ?? p.ink, config, config.textAlign ?? "left");
          text(ctx, row.time, l.rankingX + l.rankingWidth, y + Math.max(rankSize, l.rowFont) / 2 + 1, l.rowFont, durationWidth + 2, config.fontColor ?? p.ink, config, "right", true);
          const barY = y + Math.max(rankSize, l.rowFont) + l.barGap; const barWidth = Math.max(1, l.rankingWidth - rankSize - 8);
          roundRect(ctx, left, barY, barWidth, l.barHeight, l.barHeight / 2, p.timerTrack);
          if (row.ratio > 0) roundRect(ctx, left, barY, barWidth * row.ratio, l.barHeight, l.barHeight / 2, gradient(ctx, left, barY, barWidth, color, p));
        }
        if (!view.rows.length) text(ctx, view.emptyText, l.rankingX + l.rankingWidth / 2, l.rankingY + l.rankingHeight * 0.6,
          l.rowFont, l.rankingWidth - 8, p.muted, config, "center");
      }
      ctx.restore();
    },
    renderDOM(node, host, layout) {
      ensureStyles(); const view = viewFor(node, layout); const { styles, config } = view; const l = view.layout;
      const dom = domViews.get(host) ?? createDOM(host); applySurface(host, { mode: styles.mode });
      host.dataset.stacked = String(view.stacked);
      host.setAttribute("aria-label", `GG 耗时，${view.status.label}，总用时 ${view.totalText}`);
      const vars = {
        "--gg-timer-padding": `${l.padding}px`, "--gg-timer-radius": `${styles.radius}px`, "--gg-timer-background": styles.background,
        "--gg-timer-ink": config.fontColor ?? styles.palette.ink, "--gg-timer-gap": `${l.gap}px`, "--gg-timer-diameter": `${l.diameter}px`,
        "--gg-timer-header-height": `${l.headerHeight}px`, "--gg-timer-title-font": `${l.titleFont}px`, "--gg-timer-status-font": `${l.statusFont}px`,
        "--gg-timer-total-font": `${l.totalFont}px`, "--gg-timer-caption-font": `${l.captionFont}px`, "--gg-timer-heading-font": `${l.headingFont}px`,
        "--gg-timer-list-heading-height": `${l.listHeadingHeight}px`, "--gg-timer-row-height": `${l.rowHeight}px`, "--gg-timer-row-gap": `${l.rowGap}px`,
        "--gg-timer-row-font": `${l.rowFont}px`, "--gg-timer-bar-height": `${l.barHeight}px`, "--gg-timer-font-opacity": String(number(config.fontOpacity, 100) / 100),
        "--gg-timer-rank-size": `${l.rankSize}px`, "--gg-timer-rank-space": `${l.rankSize + 8}px`, "--gg-timer-bar-gap": `${l.barGap}px`,
        "--gg-timer-text-align": config.textAlign ?? "left",
      };
      for (const [key, value] of Object.entries(vars)) host.style.setProperty(key, value);
      Object.assign(host.style, { fontFamily: config.fontFamily, fontStyle: config.fontStyle === "斜体" ? "italic" : "normal",
        letterSpacing: `${number(config.letterSpacingAmount, 0)}px`, textDecoration: config.textDecoration === "下划线" ? "underline" : config.textDecoration === "删除线" ? "line-through" : "none",
        transform: config.angle ? `rotate(${config.angle}deg)` : "", transformOrigin: "center", boxShadow: styles.background === "transparent" ? "none" : "" });
      dom.body.style.gridTemplateColumns = view.showTotal && view.showTop && !view.stacked ? `${l.totalWidth}px minmax(0,1fr)` : "minmax(0,1fr)";
      dom.body.style.gridTemplateRows = view.stacked ? `${l.totalHeight}px minmax(0,1fr)` : "minmax(0,1fr)";
      dom.total.hidden = !view.showTotal; dom.ranking.hidden = !view.showTop; dom.ring.hidden = !view.ring;
      dom.ring.style.display = view.ring ? "block" : "none"; dom.totalClock.style.display = view.ring ? "flex" : "none";
      dom.value.textContent = view.totalText; dom.statusText.textContent = view.status.label; dom.status.dataset.tone = view.status.tone;
      dom.statusIcon.innerHTML = view.status.label === "执行成功" ? CHECK_SVG : CLOCK_SVG;
      dom.estimated.hidden = !view.estimated; dom.estimated.style.display = view.estimated ? "block" : "none";
      dom.empty.textContent = view.emptyText; dom.empty.style.display = view.rows.length ? "none" : "block";
      dom.rows.style.display = view.rows.length ? "flex" : "none";
      const children = view.rows.map((row, index) => {
        const entry = dom.rowNodes[index] ?? (dom.rowNodes[index] = createRow()); entry.root.dataset.rank = String(row.rank);
        entry.rank.textContent = String(row.rank); entry.name.textContent = row.name; entry.name.title = `${row.name} [#${row.id}]`;
        entry.time.textContent = row.time; entry.fill.style.width = `${row.ratio * 100}%`; return entry.root;
      });
      dom.rows.replaceChildren(...children);
    },
  };
}
