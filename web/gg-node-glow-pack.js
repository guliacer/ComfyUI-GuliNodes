// 节点光效补充包：1 种新增光效 + 8 套配方。
//
// 纯增量：通过 gg-node-glow.js 的 registerGlowEffect() 注册，在节点本体绘制
// 完成后追加一层独立叠加；不进粒子池，不改真随机配额与长期存活节奏。
// 设置 GuliNodes.enableNodeGlowPack 关掉后 EFFECTS 里不再有这些效果。
//
// AGENTS.md 红线：
//  · 不画贴边描边光环（会被看成节点背后垫了彩色底板），光只从边界向外散；
//  · 每个「节点+效果」一条独立 LCG 随机序列，同节点两次会话排布不同；
//  · 每段绘制前显式设定 globalAlpha，不依赖上一段遗留值；
//  · 配色跟随画布明暗，浅底用压深的 500/600 级；
//  · 屏幕像素常量一律除以 ds.scale；
//  · 不用 shadowBlur 堆光晕，用多层低 alpha 圆累加出柔光。
import { app } from "../../scripts/app.js";
import {
  registerGlowEffect,
  unregisterGlowEffect,
  EXTRA_GLOW_EFFECTS,
  EXTRA_GLOW_DRAWERS,
} from "./gg-node-glow.js";

const SETTING_ID = "GuliNodes.enableNodeGlowPack";

// ---------------------------------------------------------------- 绘制

const PINK = { dark: "#F472B6", light: "#BE185D" };

const P = (scale) => 1 / Math.max(0.05, Number(scale) || 1);

function heartbeat({ ctx, node, rect, now, scale, isLight }) {
  const color = isLight ? PINK.light : PINK.dark;
  const t = (now % 1200) / 1200;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (let ring = 0; ring < 2; ring += 1) {
    const phase = (t + ring * 0.28) % 1;
    const r = (Math.max(rect.width, rect.height) * 0.45 + phase * 62);
    ctx.globalAlpha = (1 - phase) * 0.32;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * P(scale);
    ctx.beginPath();
    ctx.ellipse(cx, cy, r + rect.width * 0.5, r + rect.height * 0.5, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

const EFFECTS = [
  ["heartbeat", "心跳双环", heartbeat],
];

// ---------------------------------------------------------------- 配方
// 配方 = 光效 + 连线 + 主色，一次写进设置；不新增绘制路径、不改节点尺寸。
export const RECIPES = [
  { name: "极简冷静", glow: "heartbeat", link: "光斑串", color: "#8FA3BF" },
  { name: "梦幻柔光", glow: "rainbow", link: "光斑串", color: "#A78BFA" },
  { name: "深空星野", glow: "cosmicDust", link: "星河", color: "#6D8BFF" },
  { name: "生物共生", glow: "heart", link: "光点队列", color: "#4ADE80" },
  { name: "秩序矩阵", glow: "cosmicDust", link: "数据雨", color: "#34D399" },
  { name: "暖光回声", glow: "musicNote", link: "光点队列", color: "#F0A94B" },
  { name: "极光流动", glow: "rainbow", link: "极光", color: "#22D3EE" },
  { name: "扫描现场", glow: "stardust", link: "扫描带", color: "#4C8DFF" },
];

// 配方落地：一次写入「光效效果池 + 连线样式 + 统一颜色」三个已有设置，
// 不新增绘制路径、不改节点尺寸。选「不使用配方」时不写任何值。
const GLOW_MODE = "GuliNodes.nodeGlow.mode";
const GLOW_POOL = "GuliNodes.nodeGlow.effectPool";
const LINK_STYLE = "GuliNodes.linkStyle.dashStyle";
const LINK_COLOR_MODE = "GuliNodes.linkStyle.colorMode";
const LINK_CUSTOM_COLOR = "GuliNodes.linkStyle.customColor";

async function writeSetting(id, value) {
  if (app.extensionManager?.setting?.set) {
    await app.extensionManager.setting.set(id, value);
  } else if (app.ui?.settings?.setSettingValue) {
    await app.ui.settings.setSettingValue(id, value);
  }
}

async function applyRecipe(name) {
  const recipe = RECIPES.find((r) => r.name === name);
  if (!recipe) return;
  await writeSetting(GLOW_MODE, "自定义");
  await writeSetting(GLOW_POOL, [recipe.glow]);
  await writeSetting(LINK_STYLE, recipe.link);
  await writeSetting(LINK_COLOR_MODE, "统一颜色");
  await writeSetting(LINK_CUSTOM_COLOR, recipe.color);
  app.graph?.setDirtyCanvas?.(true, true);
}

function installed() {
  return EFFECTS.every(([name]) => EXTRA_GLOW_EFFECTS.includes(name) && EXTRA_GLOW_DRAWERS.has(name));
}

function install() {
  if (installed()) return;
  for (const [name, label, drawer] of EFFECTS) registerGlowEffect(name, label, drawer);
}

function uninstall() {
  for (const [name] of EFFECTS) {
    const i = EXTRA_GLOW_EFFECTS.indexOf(name);
    if (i >= 0) EXTRA_GLOW_EFFECTS.splice(i, 1);
    EXTRA_GLOW_DRAWERS.delete(name);
  }
  // 一并从主效果表与标签表摘掉，保证效果池下拉和 normalizePool 白名单
  // 都回到 5 种原生效果，不留「选了却画不出来」的死项。
  for (const [name] of EFFECTS) unregisterGlowEffect(name);
}

app.registerExtension({
  name: "ComfyUI.GGNodes.NodeGlowPack",
  settings: [
    {
      id: SETTING_ID,
      name: "节点光效补充包（1 种新增光效 + 8 套配方）",
      tooltip: "心跳双环",
      type: "boolean",
      defaultValue: true,
      onChange(value) { if (value) install(); else uninstall(); },
    },
    {
      id: "GuliNodes.effectRecipe",
      name: "一键套用效果配方",
      tooltip: "一次配好光效 + 连线 + 主色；选好后仍可单项覆盖",
      type: "combo",
      options: ["不使用配方", ...RECIPES.map((r) => r.name)],
      defaultValue: "不使用配方",
      onChange(value) { if (value && value !== "不使用配方") void applyRecipe(value); },
    },
  ],
  async setup() { install(); },
});
