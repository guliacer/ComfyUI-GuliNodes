// 连线效果补充包：5 种新增样式。
//
// 纯增量：通过 gg-link-style.js 的 registerDashStyle() 注册，不改任何原生样式。
// 设置项 GuliNodes.enableLinkStylePack 关掉后不注册，行为与旧版逐字节一致。
//
// 绘制红线（AGENTS.md）：
//  · 每条连线先画「底线」再画特色，否则看起来像漂浮的零件而不是一条线；
//  · globalAlpha 每段显式设定，不依赖上一段遗留值（save/restore 之间会泄漏）；
//  · 屏幕像素常量一律除以画布缩放 ds.scale；
//  · 不用 shadowBlur 堆光晕，用预乘 alpha 的 2~3 层描边做柔光；
//  · 方向必须看得出来：流动类都带一个沿 t 前进的头部或逐渐衰减的尾迹。
import { app } from "../../scripts/app.js";
import {
  registerDashStyle,
  EXTRA_DASH_STYLES,
  EXTRA_DASH_DRAWERS,
  EXTRA_ANIMATED_STYLES,
  ALL_DASH_STYLES,
  ANIMATED_STYLES,
  buildPathPoints,
  pathLength,
  pointOnPath,
} from "./gg-link-style.js";

const SETTING_ID = "GuliNodes.enableLinkStylePack";

const px = (cfg) => 1 / (Number(cfg?.scale) || 1);
const now = () => performance.now();

/** 底线：2px、alpha 0.22~0.28，让所有特色效果都落回「一条连线」上。 */
function base(ctx, from, to, color, cfg) {
  const points = buildPathPoints(from, to, cfg.pathStyle);
  ctx.setLineDash([]);
  ctx.globalAlpha = cfg.opacity * 0.26;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.4, cfg.lineWidth * 0.8) * px(cfg);
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
  ctx.stroke();
  return points;
}

function dot(ctx, x, y, r, color, cfg, alpha) {
  ctx.globalAlpha = cfg.opacity * alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r * px(cfg), 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------- 补充样式

// 数据雨：竖向短竖线，沿路径逐格下落，长距离也能看出方向。
function drawRain(ctx, from, to, color, cfg) {
  const points = base(ctx, from, to, color, cfg);
  const len = pathLength(points);
  const count = Math.min(70, Math.max(8, Math.floor(len / 14)));
  const t0 = (now() / (900 / cfg.speed)) % 1;
  for (let i = 0; i < count; i += 1) {
    const t = (i / count + t0) % 1;
    const p = pointOnPath(points, t);
    const h = (3 + 6 * (1 - t)) * px(cfg);
    ctx.globalAlpha = cfg.opacity * (0.25 + 0.55 * (1 - t));
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, cfg.lineWidth * 0.55) * px(cfg);
    ctx.beginPath();
    ctx.moveTo(p[0], p[1] - h);
    ctx.lineTo(p[0], p[1] + h);
    ctx.stroke();
  }
}

// 光斑串：头大尾小的 10 颗点慢速漂移，适合长距离跨区连线。
function drawBlob(ctx, from, to, color, cfg) {
  const points = base(ctx, from, to, color, cfg);
  const head = (now() / (2600 / cfg.speed)) % 1;
  for (let i = 0; i < 10; i += 1) {
    const t = (head + i * 0.045) % 1;
    const p = pointOnPath(points, t);
    const r = (1.4 + 3.6 * (1 - i / 10)) * px(cfg);
    dot(ctx, p[0], p[1], r, color, cfg, 0.78 * (1 - i / 12));
  }
}

// 光点队列：4 颗等距光点同速前进，间距固定不追尾。
function drawConvoy(ctx, from, to, color, cfg) {
  const points = base(ctx, from, to, color, cfg);
  const head = (now() / (2200 / cfg.speed)) % 1;
  for (let i = 0; i < 4; i += 1) {
    const p = pointOnPath(points, (head + i * 0.18) % 1);
    dot(ctx, p[0], p[1], 2.8 - i * 0.3, color, cfg, 0.9 - i * 0.15);
  }
}

// 扫描带：6px 亮带匀速扫过，前沿白、后沿淡。
function drawScan(ctx, from, to, color, cfg) {
  const points = base(ctx, from, to, color, cfg);
  const head = (now() / (1800 / cfg.speed)) % 1;
  for (let i = 0; i < 7; i += 1) {
    const t = head - i * 0.016;
    if (t < 0) continue;
    const p = pointOnPath(points, t);
    ctx.globalAlpha = cfg.opacity * (0.85 - i * 0.11);
    ctx.fillStyle = i < 2 ? "#F8FBFF" : color;
    ctx.beginPath();
    ctx.arc(p[0], p[1], (3.4 - i * 0.28) * px(cfg), 0, Math.PI * 2);
    ctx.fill();
  }
}

// 光栅栈：沿路每 8px 一道短竖线，中段最亮（长连线限流到 90 道）。
function drawGrille(ctx, from, to, color, cfg) {
  const points = base(ctx, from, to, color, cfg);
  const count = Math.min(90, Math.max(6, Math.floor(pathLength(points) / 8)));
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const p = pointOnPath(points, t);
    const strength = Math.sin(t * Math.PI);
    const h = (2 + 5 * strength) * px(cfg);
    ctx.globalAlpha = cfg.opacity * (0.2 + 0.6 * strength);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2 * px(cfg);
    ctx.beginPath();
    ctx.moveTo(p[0], p[1] - h);
    ctx.lineTo(p[0], p[1] + h);
    ctx.stroke();
  }
}

const STYLES = [
  ["数据雨", drawRain], ["光斑串", drawBlob], ["光点队列", drawConvoy],
  ["扫描带", drawScan], ["光栅栈", drawGrille],
];

function installed() {
  return STYLES.every(([name]) => EXTRA_DASH_STYLES.includes(name) && EXTRA_DASH_DRAWERS.has(name));
}

function install() {
  if (installed()) return;
  for (const [name, drawer] of STYLES) registerDashStyle(name, drawer);
}

function uninstall() {
  for (const [name] of STYLES) {
    const i = EXTRA_DASH_STYLES.indexOf(name);
    if (i >= 0) EXTRA_DASH_STYLES.splice(i, 1);
    EXTRA_DASH_DRAWERS.delete(name);
    EXTRA_ANIMATED_STYLES.delete(name);
  }
  // 主数组与动画数组是 gg-link-style.js 导出的同一份引用，一并摘掉，
  // 保证关掉开关后设置下拉和动画循环只保留核心样式。
  for (const [name] of STYLES) {
    for (const arr of [ALL_DASH_STYLES, ANIMATED_STYLES]) {
      const i = arr.indexOf(name);
      if (i >= 0) arr.splice(i, 1);
    }
  }
}

app.registerExtension({
  name: "ComfyUI.GGNodes.LinkStylePack",
  settings: [
    {
      id: SETTING_ID,
      name: "连线效果补充包（5 种新增样式）",
      tooltip: "数据雨/光斑串/光点队列/扫描带/光栅栈",
      type: "boolean",
      defaultValue: true,
      onChange(value) { if (value) install(); else uninstall(); },
    },
  ],
  async setup() {
    // 默认开启：设置系统可能尚未就绪，setup 时先注册一次，
    // 之后用户关掉开关再由 onChange 摘除。
    install();
  },
});
