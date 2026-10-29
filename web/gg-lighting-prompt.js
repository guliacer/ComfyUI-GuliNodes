import { app } from "../../scripts/app.js";
import {
  captureManualHeight,
  lockPanelChildren,
  measurePanelHeight,
  nextWidgetHeight,
  resolveNodeWidth,
  resolveNodeHeight,
  scheduleRefit,
  setPanelNodeSize,
  trackManualHeight,
} from "./gg-panel-fit.js";
import {
  THEME_MODE_LABELS,
  ensureGGDesign,
  isThemeMode,
  nextThemeMode,
  paletteVars,
  resolveThemeMode,
} from "./gg-ui-design.js";

// ---------------------------------------------------------------------------
// GG 镜头打光提示词
//
// 机位、光效、光线方向的表与拼装规则只放在这里（面板是唯一的作者界面），拼好的
// 成品写进后端节点的 `提示词` 控件并随工作流序列化，所以重开工作流、换机器或
// 直接用 API 跑，拿到的都是当时看到的那段文本；后端只负责与上游 `基础提示词` 合并。
// 控件本身在面板装好后隐藏，面板装不起来时它保留可见，节点仍可手写提示词。
// ---------------------------------------------------------------------------

const NODE_NAME = "GGLightingPrompt";
const PROMPT_WIDGET = "提示词";
const DOM_WIDGET_NAME = "gg_lighting_prompt";
const HIDDEN_TYPE = "ggHiddenLightingPrompt";
const STATE_KEY = "ggLightingPrompt";
const MIN_WIDTH = 380;
const NODE_INSET = 28;
// 光效区按「展开内容」定高、上限 EFFECT_AREA_MAX_HEIGHT：只开常用组时面板紧凑，
// 全部展开后在区域内滚动，镜头角度、光照方向、补充说明与预览始终留在可视范围内。
const EFFECT_AREA_MAX_HEIGHT = 220;
// 折叠分区的 key：光效分组用 GROUPS 的 key，这几个留给独立分区。
const SECTION_ANGLE = "角度";
const SECTION_DIRECTION = "方向";
const SECTION_EXTRA = "补充";
const SECTION_PREVIEW = "预览";
// 默认状态（光效只开常用组、镜头角度与光照方向收起）各段高度之和：顶栏 22 +
// 镜头角度标题 18 + 光效区 200 + 光照方向标题 18 + 主体 22 + 补充说明 66 + 预览 74 +
// 6 个 8px 间隔 + 上下内边距 16。
// 只在 DOM 尚未挂载、量不到 scrollHeight 时用作初始高度，挂载后一律按实测值。
const FALLBACK_PANEL_HEIGHT = 500;
const EMPTY_PREVIEW = "选择机位或光效后这里会显示最终提示词";

// 分组顺序即面板顺序，也是光效在提示词里的拼装顺序。
// `open: true` 的组默认展开，其余收起——常用的一眼可见，专业布光点标题才展开。
const GROUPS = [
  { key: "常用", label: "常用光效", open: true },
  { key: "人像", label: "人像布光", open: false },
  { key: "产品", label: "产品布光", open: false },
  { key: "环境", label: "环境光效", open: false },
  { key: "扩展", label: "创意光影", open: false },
];

// 光效描述按「常用 → 扩展」固定顺序拼装，勾选先后不影响最终文本顺序。
const EFFECTS = [
  {
    id: "dappled",
    name: "树荫光",
    group: "常用",
    en: "dappled sunlight filtering through leaves, scattered leaf shadows falling across the subject",
  },
  {
    id: "striped",
    name: "条纹光",
    group: "常用",
    en: "hard striped light from window blinds slicing across the scene, banded highlights and shadows",
  },
  {
    id: "flare",
    name: "镜头光晕",
    group: "常用",
    en: "anamorphic lens flare with soft light streaks and bokeh orbs, gentle glow bleeding into the frame",
  },
  {
    id: "caustics",
    name: "透明焦散",
    group: "常用",
    en: "caustic light patterns refracted through glass, bright web-like ripples shimmering across the skin",
  },
  {
    id: "godRays",
    name: "丁达尔光",
    group: "常用",
    en: "strong Tyndall effect, visible volumetric light shafts cutting through the air with floating dust",
  },
  {
    id: "practical",
    name: "夜间开灯",
    group: "常用",
    en: "a single warm practical lamp at night, localized warm pool of light, dim surroundings",
  },
  {
    id: "windowLight",
    name: "窗光",
    group: "常用",
    en: "soft directional daylight from a large window, gentle falloff into the room, natural skin tones",
  },
  {
    id: "whiteSweep",
    name: "白底棚拍",
    group: "常用",
    en: "clean white seamless backdrop, even bright product lighting, soft contact shadow under the subject",
  },
  {
    id: "rembrandt",
    name: "伦勃朗光",
    group: "人像",
    en: "Rembrandt lighting, key light 45 degrees from the side and above, a small triangle of light on the shadow-side cheek",
  },
  {
    id: "butterfly",
    name: "蝴蝶光",
    group: "人像",
    en: "butterfly lighting, key light from above and slightly in front, symmetric butterfly shadow under the nose",
  },
  {
    id: "loop",
    name: "环形光",
    group: "人像",
    en: "loop lighting, key light 45 degrees to the side, a small loop shadow beside the nose",
  },
  {
    id: "split",
    name: "分割光",
    group: "人像",
    en: "split lighting, light from a full 90-degree side, one half of the face lit and the other in shadow",
  },
  {
    id: "shortLight",
    name: "窄面光",
    group: "人像",
    en: "short lighting, key light on the side turned away from the camera, the narrow side of the face lit, slimming shadows",
  },
  {
    id: "wideLight",
    name: "宽面光",
    group: "人像",
    en: "broad lighting, key light on the side facing the camera, the wider side of the face lit, open shadows",
  },
  {
    id: "clamshell",
    name: "蚌壳光",
    group: "人像",
    en: "clamshell lighting, soft key light from above plus a white reflector filling from below, flattering even skin with clear catchlights",
  },
  {
    id: "beautyDish",
    name: "雷达罩",
    group: "人像",
    en: "a beauty dish key light close in from above, crisp center falloff, defined cheekbones with soft shadow edges",
  },
  {
    id: "softbox",
    name: "柔光箱",
    group: "人像",
    en: "a large softbox key light at 45 degrees, soft wraparound falloff and gentle shadow transitions",
  },
  {
    id: "flat",
    name: "平光",
    group: "人像",
    en: "flat frontal beauty lighting, soft shadowless light across the face, clean even skin tones",
  },
  {
    id: "highKey",
    name: "高调光",
    group: "人像",
    en: "high-key portrait lighting, bright even illumination, minimal shadows, airy white background",
  },
  {
    id: "lowKey",
    name: "低调光",
    group: "人像",
    en: "low-key portrait lighting, a single hard light source, deep black shadows, strong contrast",
  },
  {
    id: "shortBack",
    name: "侧逆光",
    group: "人像",
    en: "short side-back light from 45 degrees behind, bright edge along the cheek, most of the face in shadow",
  },
  {
    id: "hairLight",
    name: "发丝光",
    group: "人像",
    en: "a separate hair light from above and behind, glowing rim along the hair strands, head separated from the background",
  },
  {
    id: "kicker",
    name: "分离光",
    group: "人像",
    en: "a hard kicker light from behind at the side, bright separation edge along the jaw and shoulder",
  },
  {
    id: "topLight",
    name: "顶光",
    group: "人像",
    en: "direct overhead light, bright crown of the head, shadow pooling under the brow, nose and chin",
  },
  {
    id: "ringLight",
    name: "环形灯",
    group: "人像",
    en: "ring light illumination from the camera axis, even shadowless face, circular catchlight in the eyes",
  },
  {
    id: "bounceFill",
    name: "反光板",
    group: "人像",
    en: "a white bounce card lifting the shadow side, opened-up shadow detail, soft natural skin",
  },
  {
    id: "goldenReflector",
    name: "金色反光板",
    group: "人像",
    en: "a gold reflector bouncing warm fill into the shadow side, golden skin tones, glowing warmth",
  },
  {
    id: "hardFlash",
    name: "机顶闪",
    group: "人像",
    en: "direct on-camera flash, hard flat illumination with a sharp shadow falling on the wall behind",
  },
  {
    id: "silhouette",
    name: "逆光剪影",
    group: "人像",
    en: "strong backlight turning the subject into a silhouette, bright halo around the outline, no detail in the face",
  },
  {
    id: "underlight",
    name: "底光",
    group: "人像",
    en: "underlighting from below, chin and underside of the nose lit, eerie theatrical mood",
  },
  {
    id: "lightTent",
    name: "光帐篷",
    group: "产品",
    en: "product shot inside a white light tent, fully diffused shadowless illumination, even reflections across the surface",
  },
  {
    id: "dualSoftbox",
    name: "双柔光箱",
    group: "产品",
    en: "two large softboxes at 45 degrees on both sides, cross lighting, soft gradients on the product and clean specular highlights",
  },
  {
    id: "overheadFlat",
    name: "顶光平铺",
    group: "产品",
    en: "flat lay shot lit from directly overhead by a large diffused source, even shadowless top light",
  },
  {
    id: "gradientBackdrop",
    name: "渐变背景",
    group: "产品",
    en: "a gradient backdrop glowing from one edge to dark on the other, smooth color transition behind the product",
  },
  {
    id: "seamlessSpot",
    name: "无缝聚光",
    group: "产品",
    en: "a focused spot on the product against a dark seamless background, tight light falloff around the subject",
  },
  {
    id: "hardShadow",
    name: "硬光硬影",
    group: "产品",
    en: "a single hard bare light source, crisp defined shadow cast on the background, glossy specular highlights",
  },
  {
    id: "reflectiveTable",
    name: "镜面台面",
    group: "产品",
    en: "the product sitting on a glossy black reflective surface, a clean mirror reflection beneath it",
  },
  {
    id: "backlitTranslucent",
    name: "透光背光",
    group: "产品",
    en: "backlight passing through translucent material, glowing edges, the liquid inside lit from behind",
  },
  {
    id: "edgeLightGlass",
    name: "玻璃勾边",
    group: "产品",
    en: "two strip lights flanking a glass object, bright vertical edge highlights outlining its contour",
  },
  {
    id: "gelRim",
    name: "彩色勾边",
    group: "产品",
    en: "colored gel rim lights on both sides of the product, saturated colored edges against a dark background",
  },
  {
    id: "whiteOnWhite",
    name: "白上白",
    group: "产品",
    en: "white product on a white background, high-key studio lighting, minimal shadow, clean and airy",
  },
  {
    id: "blackOnBlack",
    name: "黑上黑",
    group: "产品",
    en: "dark product on a black background, a single controlled highlight raking across the surface, deep low-key mood",
  },
  {
    id: "mist",
    name: "晨雾散射",
    group: "环境",
    en: "diffused light through light morning mist, soft low-contrast illumination with layered haze",
  },
  {
    id: "overcast",
    name: "阴天散射",
    group: "环境",
    en: "flat overcast daylight, soft shadowless illumination, muted colors",
  },
  {
    id: "blueHour",
    name: "蓝调时刻",
    group: "环境",
    en: "blue hour twilight, deep blue ambient light, city lights just coming on, cool skin tones",
  },
  {
    id: "middaySun",
    name: "正午硬光",
    group: "环境",
    en: "harsh midday sun from overhead, short hard shadows under the brow and nose",
  },
  {
    id: "stormySky",
    name: "暴风雨光",
    group: "环境",
    en: "dramatic storm light, a break in heavy clouds, cold shafts of sun against a dark sky",
  },
  {
    id: "snowGlow",
    name: "雪地反光",
    group: "环境",
    en: "light bounced up from snow, bright cool fill from below, high-key winter daylight",
  },
  {
    id: "stringLights",
    name: "串灯虚化",
    group: "环境",
    en: "warm string lights out of focus in the background, soft bokeh orbs, dim ambient surroundings",
  },
  {
    id: "carWindow",
    name: "车窗光",
    group: "环境",
    en: "light through a car window, moving bands of sun and shade sweeping across the face",
  },
  {
    id: "wetNeon",
    name: "雨夜霓虹",
    group: "环境",
    en: "rainy night street, wet ground mirroring neon signs, colored reflections on the skin",
  },
  {
    id: "candle",
    name: "烛光",
    group: "环境",
    en: "single candle flame, a small warm pool of light, surroundings almost black",
  },
  {
    id: "screenGlow",
    name: "屏幕光",
    group: "环境",
    en: "cool white glow from a phone or monitor screen lighting the face from the front",
  },
  {
    id: "doorway",
    name: "门缝光",
    group: "环境",
    en: "light spilling through an open doorway, a bright rectangle of light cutting into a dark room",
  },
  {
    id: "underwater",
    name: "水下光",
    group: "环境",
    en: "underwater ambient light, rippling caustics drifting through the water, teal blue cast",
  },
  {
    id: "lightning",
    name: "闪电",
    group: "环境",
    en: "a lightning flash of cold white light, hard shadows, high contrast, split-second exposure",
  },
  {
    id: "rim",
    name: "轮廓光",
    group: "扩展",
    en: "strong rim light tracing the subject's silhouette, bright edge separation from a darker background",
  },
  {
    id: "goldenHour",
    name: "日落金光",
    group: "扩展",
    en: "golden hour backlight, warm orange glow wrapping the subject, long soft shadows",
  },
  {
    id: "biColor",
    name: "冷暖双色",
    group: "扩展",
    en: "bi-color lighting, warm key light against cool blue fill, strong warm-cool contrast",
  },
  {
    id: "neon",
    name: "霓虹双色",
    group: "扩展",
    en: "magenta and cyan neon lighting, colored reflections on the skin, moody night city atmosphere",
  },
  {
    id: "splitGel",
    name: "分色背景",
    group: "扩展",
    en: "two-tone gel backdrop, warm on one side and cool on the other, a clean vertical split behind the subject",
  },
  {
    id: "spotlight",
    name: "戏剧聚光",
    group: "扩展",
    en: "a single dramatic spotlight on the subject, surroundings falling quickly into deep shadow, strong chiaroscuro",
  },
  {
    id: "moonlight",
    name: "月光",
    group: "扩展",
    en: "cool blue moonlight from above, desaturated night palette, soft silver highlights",
  },
  {
    id: "followSpot",
    name: "舞台追光",
    group: "扩展",
    en: "stage follow spot from above, crisp circular pool of light, dark stage background",
  },
  {
    id: "firelight",
    name: "火光",
    group: "扩展",
    en: "warm orange firelight flickering from below, dancing highlights and deep warm shadows",
  },
  {
    id: "waterRipple",
    name: "水波光影",
    group: "扩展",
    en: "moving water-reflection light rippling across the subject, shimmering wave patterns",
  },
  {
    id: "gelProjection",
    name: "彩色投影",
    group: "扩展",
    en: "hard-edged colored gel projection, geometric patches of red and blue light across the scene",
  },
  {
    id: "goboWindow",
    name: "窗框投影",
    group: "扩展",
    en: "a window-frame gobo projection, hard rectangles of light and shadow thrown across the subject and wall",
  },
  {
    id: "projector",
    name: "投影画面",
    group: "扩展",
    en: "an image projected onto the subject, patterns of light from a projector overlaying the scene",
  },
  {
    id: "hardCut",
    name: "硬光切割",
    group: "扩展",
    en: "hard light cutting a sharp shadow line across the face, crisp high-contrast edges",
  },
  {
    id: "prism",
    name: "棱镜虹光",
    group: "扩展",
    en: "prism dispersion, a rainbow spectrum band of light sweeping across the frame",
  },
  {
    id: "halation",
    name: "高光溢出",
    group: "扩展",
    en: "strong halation around the highlights, film-like glow bleeding into the shadows, soft bloom on bright edges",
  },
];

// 方向按钮按 4 列排布：前 3 列是画面内的方位，第 4 列是正面光与背后光。
const DIRECTIONS = [
  { id: "topLeft", name: "左上方", en: "light coming from the upper left" },
  { id: "top", name: "正上方", en: "light coming straight down from above" },
  { id: "topRight", name: "右上方", en: "light coming from the upper right" },
  { id: "front", name: "正前方", en: "frontal light from the camera direction" },
  { id: "left", name: "左侧", en: "light coming from the left side" },
  { id: "", name: "默认", en: "" },
  { id: "right", name: "右侧", en: "light coming from the right side" },
  { id: "back", name: "正后方", en: "light from directly behind the subject" },
  { id: "bottomLeft", name: "左下方", en: "low light from the lower left" },
  { id: "bottom", name: "正下方", en: "light coming from below" },
  { id: "bottomRight", name: "右下方", en: "low light from the lower right" },
];

// 镜头角度：4 列 × 5 行，按「平视 / 俯拍 / 仰拍 / 极端机位 / 斜切与反射」顺序排，
// 每行正好一个机位族，眼睛扫一行就能找到要的角度。
// 不设「默认」按钮，再点一次已选中的机位即取消（与光照方向同一套操作）。
const CAMERA_ANGLES = [
  { id: "eyeFront", name: "平视正面", en: "eye-level frontal shot, camera at the subject's eye height, facing them straight on" },
  { id: "eyeThreeQuarter", name: "平视3/4", en: "eye-level three-quarter view, subject turned about 45 degrees toward the camera" },
  { id: "eyeProfile", name: "平视侧脸", en: "eye-level profile shot, subject at 90 degrees to the camera" },
  { id: "eyeBack", name: "平视背影", en: "eye-level shot from behind the subject" },
  { id: "highFront", name: "俯拍正面", en: "high angle shot looking down at the subject from the front" },
  { id: "highThreeQuarter", name: "俯拍3/4", en: "high three-quarter angle, camera above and to the side looking down" },
  { id: "highProfile", name: "俯拍侧脸", en: "high angle profile shot, camera above and to the side at 90 degrees" },
  { id: "highBack", name: "俯拍背影", en: "high angle from behind and above, looking down at the subject's back" },
  { id: "lowFront", name: "仰拍正面", en: "low angle shot looking up at the subject from the front" },
  { id: "lowThreeQuarter", name: "仰拍3/4", en: "low three-quarter angle, camera below and to the side looking up" },
  { id: "lowProfile", name: "仰拍侧脸", en: "low angle profile shot, camera below and to the side at 90 degrees" },
  { id: "lowBack", name: "仰拍背影", en: "low angle from behind and below, looking up at the subject's back" },
  { id: "birdEye", name: "鸟瞰顶拍", en: "bird's-eye view from almost directly above, top-down composition" },
  { id: "wormEye", name: "贴地仰拍", en: "ground-level worm's-eye view, camera almost on the floor looking up" },
  { id: "overShoulder", name: "过肩镜头", en: "over-the-shoulder shot, the foreground shoulder and head edge framing the subject" },
  { id: "throughForeground", name: "前景遮挡", en: "shot through out-of-focus foreground elements, leaves or fabric framing the subject" },
  { id: "dutchAngle", name: "荷兰角", en: "Dutch angle, camera tilted diagonally for an off-balance composition" },
  { id: "dutchLow", name: "倾斜仰拍", en: "low Dutch angle, tilted camera looking up at the subject" },
  { id: "dutchHigh", name: "倾斜俯拍", en: "high Dutch angle, tilted camera looking down at the subject" },
  { id: "mirrorShot", name: "镜中视角", en: "the subject seen as a reflection in a mirror or reflective surface, frame within a frame" },
];

const SUBJECT_ON = "the light lands on the subject, clear light-and-shadow shaping on the face and body";
const SUBJECT_OFF = "the light effect stays in the environment, the subject keeps soft even illumination";
// 面板全中文，但写进提示词的永远是英文：SD1.5 / SDXL 一类 CLIP 对英文标签最稳，
// 留一个语言开关只会多一个「忘了切回去」的出错点。
const SEPARATOR = ", ";

// ---------------------------------------------------------------- 样式表
//
// 面板是一块独立皮肤，颜色全部走 `--ggl-*` 变量。调色板本身不在这里——只有
// gg-ui-design.js 一份，`applyPalette` 把它铺到面板根元素上；这里只决定用哪套
// （默认跟随 ComfyUI 主题，用户也可以用工具条上的「主题」按钮钉死）。
// 悬停、聚焦、选中这些状态没法用内联样式表达，所以状态样式全部写在这里。

const STYLE_ID = "gg-lighting-prompt-style";

const PANEL_CSS = `
.gg-lighting-panel {
  /* 色值不在这里写：调色板只有一份，在 gg-ui-design.js，由 applyPalette 铺到根元素上 */
  color: var(--ggl-ink);
  background: var(--ggl-panel);
  border-radius: 10px;
}
.gg-lighting-panel * { box-sizing: border-box; }

/* 分组卡片：面板里每一个功能区块都是一张卡 */
.gg-lighting-card {
  display: flex; flex-direction: column; gap: 6px; min-width: 0;
  padding: 7px 8px 8px;
  border: 1px solid var(--ggl-divider);
  border-radius: 8px;
  background: var(--ggl-card);
}
/* 卡内的子分组（光效五组、光照方向）用上边线隔开，不再各自套卡 */
.gg-lighting-sub { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.gg-lighting-sub + .gg-lighting-sub { border-top: 1px solid var(--ggl-divider); padding-top: 6px; }

/* 顶部：状态栏 + 模式/主题工具条 */
.gg-lighting-hint {
  flex: 1 1 auto; min-width: 0;
  font-size: 11px; color: var(--ggl-muted);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.gg-lighting-tool {
  flex: 0 0 auto; height: 22px; padding: 0 10px;
  border: 1px solid var(--ggl-divider); border-radius: 999px;
  background: var(--ggl-btn); color: var(--ggl-muted);
  font: inherit; font-size: 11px; line-height: 1; cursor: pointer;
  transition: color .14s ease, border-color .14s ease, background-color .14s ease;
}
.gg-lighting-tool:hover { color: var(--ggl-ink); background: var(--ggl-btn-hover); border-color: var(--ggl-accent); }
.gg-lighting-tool:focus-visible { outline: 2px solid var(--ggl-accent); outline-offset: 1px; }

/* 分段控件（基础 / 高级） */
.gg-lighting-seg {
  display: inline-flex; flex: 0 0 auto; height: 22px; padding: 2px;
  border: 1px solid var(--ggl-divider); border-radius: 999px;
  background: var(--ggl-btn); gap: 2px;
}
.gg-lighting-seg > button {
  min-width: 40px; height: 16px; padding: 0 8px;
  border: 0; border-radius: 999px; background: transparent;
  color: var(--ggl-muted); font: inherit; font-size: 10.5px; line-height: 1;
  cursor: pointer; transition: background-color .14s ease, color .14s ease;
}
.gg-lighting-seg > button:hover { color: var(--ggl-ink); }
.gg-lighting-seg > button[aria-pressed="true"] {
  background: var(--ggl-picked-bg); color: var(--ggl-accent); font-weight: 600;
}
.gg-lighting-seg > button:focus-visible { outline: 2px solid var(--ggl-accent); outline-offset: 1px; }

/* 分组标题行：整行都是点击区 */
.gg-lighting-group {
  display: flex; align-items: center; gap: 6px;
  width: 100%; height: 18px; margin: 0; padding: 0 4px;
  border: 0; border-radius: 5px; background: transparent;
  color: var(--ggl-muted); font: inherit;
  cursor: pointer; text-align: left; overflow: hidden;
  transition: background-color .14s ease, color .14s ease;
}
.gg-lighting-group:hover { background: var(--ggl-btn-hover); }
.gg-lighting-group:focus-visible { outline: 2px solid var(--ggl-accent); outline-offset: 1px; }
.gg-lighting-caret { flex: 0 0 auto; width: 9px; font-size: 9px; line-height: 1; text-align: center; }
.gg-lighting-title { flex: 0 0 auto; font-size: 11px; font-weight: 600; line-height: 16px; white-space: nowrap; }
.gg-lighting-group.is-primary .gg-lighting-title { color: var(--ggl-ink); }
.gg-lighting-group.is-active .gg-lighting-title { color: var(--ggl-ink); }

/* 计数胶囊 */
.gg-lighting-count {
  flex: 0 0 auto; margin-left: auto; padding: 0 7px;
  border-radius: 999px; background: var(--ggl-btn);
  color: var(--ggl-faint);
  font-size: 10px; font-weight: 500; line-height: 15px; white-space: nowrap;
  transition: background-color .14s ease, color .14s ease;
}
.gg-lighting-count.is-active { background: var(--ggl-picked-bg); color: var(--ggl-accent); }
.gg-lighting-count.is-over { background: rgba(245, 158, 11, 0.18); color: var(--ggl-warning); }

/* 选项按钮：默认有底色（读作「可点」），选中换成强调色底 + 强调色描边 */
.gg-lighting-btn {
  height: 24px; padding: 0 6px; margin: 0;
  border: 1px solid transparent; border-radius: 6px;
  background: var(--ggl-btn); color: var(--ggl-ink);
  font: inherit; font-size: 11.5px; line-height: 1; font-weight: 400;
  cursor: pointer; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  transition: background-color .12s ease, border-color .12s ease, color .12s ease;
}
.gg-lighting-btn:hover { background: var(--ggl-btn-hover); }
.gg-lighting-btn:active { background: var(--ggl-picked-bg); }
.gg-lighting-btn:focus-visible { outline: 2px solid var(--ggl-accent); outline-offset: 1px; }
.gg-lighting-btn[aria-pressed="true"] {
  background: var(--ggl-picked-bg);
  border-color: var(--ggl-picked-border);
  color: var(--ggl-accent);
  font-weight: 600;
}

/* 复选框行 */
.gg-lighting-check {
  display: inline-flex; align-items: center; gap: 7px;
  height: 24px; padding: 0 8px;
  border: 1px solid var(--ggl-divider); border-radius: 6px;
  background: var(--ggl-btn); color: var(--ggl-ink);
  font-size: 11.5px; cursor: pointer; user-select: none;
  transition: background-color .14s ease;
}
.gg-lighting-check:hover { background: var(--ggl-btn-hover); }
.gg-lighting-check input { margin: 0; accent-color: var(--ggl-accent); cursor: pointer; }

/* 字段：补充说明与预览共用 */
.gg-lighting-field {
  width: 100%; border: 1px solid var(--ggl-divider); border-radius: 7px;
  padding: 6px 8px; background: var(--ggl-field); color: var(--ggl-ink);
  font-family: inherit; font-size: 11.5px; line-height: 1.55;
  outline: none; resize: none;
  transition: border-color .14s ease, box-shadow .14s ease;
}
.gg-lighting-field:focus { border-color: var(--ggl-accent); box-shadow: 0 0 0 2px var(--ggl-picked-bg); }
.gg-lighting-field::placeholder { color: var(--ggl-faint); }
.gg-lighting-preview {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; line-height: 1.6;
}
.gg-lighting-preview.is-empty { color: var(--ggl-faint); }

/* 字段标题行 */
.gg-lighting-label {
  display: flex; align-items: center; gap: 6px;
  height: 16px; min-width: 0;
  font-size: 11px; font-weight: 600; color: var(--ggl-muted);
}
.gg-lighting-label > span:first-child { flex: 0 0 auto; }

/* 复制按钮：贴在「最终提示词」标题行右侧 */
.gg-lighting-copy {
  flex: 0 0 auto; margin-left: auto; height: 18px; padding: 0 8px;
  border: 1px solid var(--ggl-divider); border-radius: 999px;
  background: var(--ggl-btn); color: var(--ggl-muted);
  font: inherit; font-size: 10px; line-height: 1; cursor: pointer;
  transition: color .14s ease, border-color .14s ease, background-color .14s ease;
}
.gg-lighting-copy:hover { color: var(--ggl-ink); background: var(--ggl-btn-hover); border-color: var(--ggl-accent); }
.gg-lighting-copy:focus-visible { outline: 2px solid var(--ggl-accent); outline-offset: 1px; }
.gg-lighting-copy.is-done { color: var(--ggl-ok); border-color: var(--ggl-ok); }

/* 禁用态：按钮本身不再响应，视觉上也要明显「按不动」 */
.gg-lighting-panel button:disabled { opacity: .42; cursor: default; }
.gg-lighting-panel button:disabled:hover {
  background: var(--ggl-btn); color: var(--ggl-faint); border-color: var(--ggl-divider);
}

/* 滚动条：跟随皮肤，不要系统默认的白条 */
.gg-lighting-panel ::-webkit-scrollbar { width: 8px; height: 8px; }
.gg-lighting-panel ::-webkit-scrollbar-thumb {
  background: var(--ggl-btn-hover); border-radius: 999px;
}
.gg-lighting-panel ::-webkit-scrollbar-track { background: transparent; }
`;

function injectStyles() {
  // 调色板来自设计层，先把设计层装上（幂等）
  ensureGGDesign();
  if (document.getElementById?.(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PANEL_CSS;
  document.head.append(style);
}

// ---------------------------------------------------------------- 状态与拼装

function normalizeState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const knownEffects = new Set(EFFECTS.map((effect) => effect.id));
  const effects = Array.isArray(source.effects)
    ? [...new Set(source.effects.filter((id) => knownEffects.has(id)))]
    : [];
  return {
    effects,
    angle: CAMERA_ANGLES.some((item) => item.id === source.angle) ? source.angle : "",
    direction: DIRECTIONS.some((item) => item.id === source.direction) ? source.direction : "",
    subject: source.subject !== false,
    extra: typeof source.extra === "string" ? source.extra : "",
    // 皮肤与模式属于「用户偏好」，不是折叠/滚动那类纯浏览状态，要跟着工作流一起记住。
    // `mode` 留空表示「还没定过」，由 createPanel 按已选项推断一次。
    theme: isThemeMode(source.theme) ? source.theme : "auto",
    mode: MODES.some((item) => item.key === source.mode) ? source.mode : "",
  };
}

function composePrompt(state) {
  // 光线相关的部分：光效 + 光线方向
  const lightingParts = [];
  for (const effect of EFFECTS) {
    if (state.effects.includes(effect.id)) lightingParts.push(effect.en);
  }
  const direction = DIRECTIONS.find((item) => item.id === state.direction);
  if (direction?.en) lightingParts.push(direction.en);

  // 顺序：机位 → 光效/方向 → 主体受光 → 补充说明
  const parts = [];
  const angle = CAMERA_ANGLES.find((item) => item.id === state.angle);
  if (angle?.en) parts.push(angle.en);
  parts.push(...lightingParts);
  // 只选了机位、没选任何光效时不追加受光描述，避免多出一句和光无关的话
  if (lightingParts.length) parts.push(state.subject ? SUBJECT_ON : SUBJECT_OFF);

  // 补充说明是用户自己写的，可能带中文标点，只清尾部分隔符不翻译
  const extra = String(state.extra || "").trim().replace(/[，,、;；\s]+$/u, "");
  if (extra) parts.push(extra);
  return parts.filter(Boolean).join(SEPARATOR);
}

// ---------------------------------------------------------------- DOM 构件

function makeElement(tag, style, text) {
  const element = document.createElement(tag);
  if (style) Object.assign(element.style, style);
  if (text != null) element.textContent = text;
  return element;
}

function createToggleButton(text) {
  const button = makeElement("button", null, text);
  button.type = "button";
  button.className = "gg-lighting-btn";
  button.setAttribute("aria-pressed", "false");
  return button;
}

// 选中态只切 `aria-pressed`，配色由样式表按属性选择器接管——
// 这样悬停 / 选中的层叠关系由 CSS 决定，不会出现内联样式盖住 `:hover` 的问题。
function setPressed(button, pressed) {
  if (!button) return;
  button.setAttribute("aria-pressed", pressed ? "true" : "false");
}

function createGrid(columns) {
  return makeElement("div", {
    display: "grid",
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gap: "6px",
  });
}

// 可折叠分组：标题行（箭头 + 名称 + 右侧计数）+ 内容体。
// 镜头角度、五个光效组、光照方向、补充说明、最终提示词共用这一套，避免多份折叠逻辑漂移。
// `card: true` 时分组本身是一张卡片；`body` 不传就按列数生成按钮网格。
function createCollapsible({ key, title, kind, total = 0, columns = 4, card = false, body = null, headExtra = [], showCount = true }) {
  const section = makeElement("div", null);
  section.className = card ? "gg-lighting-card" : "gg-lighting-sub";

  const head = makeElement("button", null);
  head.type = "button";
  head.className = kind === "effect" ? "gg-lighting-group" : "gg-lighting-group is-primary";
  head.dataset.ggSection = key;

  const caret = makeElement("span", null, "▸");
  caret.className = "gg-lighting-caret";
  const labelEl = makeElement("span", null, title);
  labelEl.className = "gg-lighting-title";
  const countEl = makeElement("span", null, `${total} 项`);
  countEl.className = "gg-lighting-count";
  if (!showCount) countEl.style.display = "none";
  head.append(caret, labelEl, countEl, ...headExtra);

  const content = body || createGrid(columns);
  section.append(head, content);

  return {
    key,
    kind,
    title,
    total,
    section,
    head,
    caret,
    labelEl,
    countEl,
    body: content,
    isGrid: !body,
    picked: null,
  };
}

// 字段统一走 `gg-lighting-field`，尺寸类覆盖（高度等）由调用方按需追加。
function applyFieldStyle(element, extraStyle = {}) {
  element.className = "gg-lighting-field";
  Object.assign(element.style, extraStyle);
  return element;
}

// ---------------------------------------------------------------- 主题

// 皮肤（调色板 + 宿主主题判定）只在 gg-ui-design.js 里写一份，这里只决定「用哪套」：
// 自动模式跟宿主走，手动模式由面板上的主题按钮钉死。
// 以前这里把调色板、颜色解析、亮度计算、宿主判定整套抄了一遍，改一处要改两个文件。
function applyPalette(panel) {
  const resolved = resolveThemeMode(panel?.state?.theme);
  if (panel.resolvedTheme === resolved) return false;
  panel.resolvedTheme = resolved;
  panel.host.setAttribute("data-ggl-theme", resolved);
  // 面板样式统一写 `var(--ggl-*)`；paletteVars 同时产出 `--gg-*` 与 `--ggl-*` 别名，
  // 铺到面板根上即可，不必再在 CSS 里抄第二份色值。
  // 注意：自定义属性只能用 setProperty 写，`style["--x"] = v` 是无效的。
  for (const [name, value] of Object.entries(paletteVars(resolved))) {
    panel.host.style.setProperty(name, value);
  }
  return true;
}

// ---------------------------------------------------------------- 模式与列数

const MODES = [
  { key: "basic", label: "基础" },
  { key: "advanced", label: "高级" },
];

// 基础模式只留最常用的一批；高级模式给全部。隐藏只改显示，不动任何已选项。
const BASIC_ANGLE_IDS = new Set([
  "eyeFront", "eyeThreeQuarter", "eyeProfile", "highFront",
  "lowFront", "birdEye", "overShoulder", "dutchAngle",
]);
const BASIC_EFFECT_IDS = new Set([
  // 常用光效整组
  "dappled", "striped", "flare", "caustics", "godRays", "windowLight", "goldenHour", "neon",
  // 人像布光里最常被点到的几支
  "rembrandt", "butterfly", "loop", "softbox", "hairLight", "lowKey",
]);

// 列数按可用宽度算：窄了自动降到 3 列（光效 2 列），宽了最多 4 列，标签不挤压。
const GRID_MIN_CELL = { effect: 100, default: 78 };

function columnsFor(kind, panelWidth) {
  const minCell = GRID_MIN_CELL[kind] ?? GRID_MIN_CELL.default;
  const usable = Math.max(180, Math.round(Number(panelWidth) || MIN_WIDTH) - 18);
  const columns = Math.floor((usable + 6) / (minCell + 6));
  const floor = kind === "effect" ? 2 : 3;
  return Math.min(4, Math.max(floor, columns));
}

function applyGridColumns(panel) {
  const width = Number(panel.host?.style?.width?.replace("px", "")) || MIN_WIDTH - NODE_INSET;
  for (const entry of panel.collapsibles.values()) {
    if (!entry.isGrid) continue;
    entry.body.style.gridTemplateColumns = `repeat(${columnsFor(entry.kind, width)}, minmax(0, 1fr))`;
  }
}

// 基础模式只藏「没被选中的冷门项」：已选项永远保持可见，
// 否则用户会看到一个写着「已选 2」的分组，却找不到是哪两项、也没法取消。
function applyMode(panel) {
  const basic = panel.mode !== "advanced";
  let changed = false;
  const toggle = (button, isBasic, isPicked) => {
    if (!button) return;
    const next = !basic || isBasic || isPicked ? "" : "none";
    if (button.style.display === next) return;
    button.style.display = next;
    changed = true;
  };

  const pickedEffects = new Set(panel.state.effects);
  for (const effect of EFFECTS) {
    toggle(panel.effectButtons.get(effect.id), BASIC_EFFECT_IDS.has(effect.id), pickedEffects.has(effect.id));
  }
  for (const angle of CAMERA_ANGLES) {
    toggle(panel.angleButtons.get(angle.id), BASIC_ANGLE_IDS.has(angle.id), panel.state.angle === angle.id);
  }
  // 光照方向统共十来个，两档模式都给全
  for (const direction of DIRECTIONS) {
    toggle(panel.directionButtons.get(direction.id), true, panel.state.direction === direction.id);
  }

  // 一个可见按钮都不剩的分组整组藏掉，别留一个空壳标题
  for (const entry of panel.collapsibles.values()) {
    if (entry.kind !== "effect") continue;
    const hasVisible = [...entry.body.children].some((child) => child.style.display !== "none");
    const next = hasVisible ? "" : "none";
    if (entry.section.style.display === next) continue;
    entry.section.style.display = next;
    changed = true;
  }

  for (const [key, button] of panel.modeButtons) setPressed(button, key === panel.mode);
  return changed;
}

// ---------------------------------------------------------------- 面板

function createPanel(node) {
  const host = makeElement("div", {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    flex: "0 0 auto",
    boxSizing: "border-box",
    padding: "9px",
    overflow: "hidden",
    pointerEvents: "auto",
  });
  host.className = "gg-lighting-panel";
  injectStyles();

  // 状态栏：已选数量 + 可选总数 + 清空
  const header = makeElement("div", {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minWidth: "0",
    height: "22px",
  });
  const hint = makeElement("span", null, "");
  hint.className = "gg-lighting-hint";

  const clearButton = makeElement("button", null, "清空");
  clearButton.type = "button";
  clearButton.className = "gg-lighting-tool";
  clearButton.title = "清空所选机位、光效与光线方向（不动补充说明）";
  header.append(hint, clearButton);

  // 工具条：基础 / 高级 + 主题
  const toolbar = makeElement("div", {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minWidth: "0",
    height: "22px",
  });
  const modeSeg = makeElement("div", null);
  modeSeg.className = "gg-lighting-seg";
  const modeButtons = new Map();
  for (const mode of MODES) {
    const button = makeElement("button", null, mode.label);
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    modeButtons.set(mode.key, button);
    modeSeg.append(button);
  }
  const spacer = makeElement("span", { flex: "1 1 auto" });
  const themeButton = makeElement("button", null, "主题 · 自动");
  themeButton.type = "button";
  themeButton.className = "gg-lighting-tool";
  themeButton.title = "点击切换：自动（跟随 ComfyUI）→ 深色 → 浅色";
  toolbar.append(modeSeg, spacer, themeButton);

  // 可折叠分组按创建顺序登记，顺序即面板顺序
  const collapsibles = new Map();
  const registerCollapsible = (entry) => {
    collapsibles.set(entry.key, entry);
    return entry;
  };

  // 镜头角度
  const angleEntry = registerCollapsible(createCollapsible({
    key: SECTION_ANGLE,
    kind: "angle",
    title: "镜头角度",
    total: CAMERA_ANGLES.length,
    columns: 4,
    card: true,
  }));
  const angleButtons = new Map();
  for (const angle of CAMERA_ANGLES) {
    const button = createToggleButton(angle.name);
    angleButtons.set(angle.id, button);
    angleEntry.body.append(button);
  }
  angleEntry.picked = (state) => {
    const chosen = state.angle ? CAMERA_ANGLES.find((angle) => angle.id === state.angle) : null;
    return chosen
      ? { count: 1, label: `已选 ${chosen.name}` }
      : { count: 0, label: `${CAMERA_ANGLES.length} 项` };
  };

  // 光效：一张卡里装五组，组间用细线分隔；卡片内部自己滚动，不把节点撑高。
  const effectArea = makeElement("div", {
    display: "flex",
    flexDirection: "column",
    gap: "5px",
    maxHeight: `${EFFECT_AREA_MAX_HEIGHT}px`,
    overflowY: "auto",
    overflowX: "hidden",
    paddingRight: "2px",
    scrollbarWidth: "thin",
  });
  effectArea.className = "gg-lighting-card gg-lighting-effects";
  // 滚轮落在光效列表里时滚动列表，不要连带缩放画布
  effectArea.addEventListener("wheel", (event) => event.stopPropagation());

  const effectButtons = new Map();
  for (const group of GROUPS) {
    const items = EFFECTS.filter((item) => item.group === group.key);
    const entry = registerCollapsible(createCollapsible({
      key: group.key,
      kind: "effect",
      title: group.label,
      total: items.length,
      columns: 3,
    }));
    for (const effect of items) {
      const button = createToggleButton(effect.name);
      effectButtons.set(effect.id, button);
      entry.body.append(button);
    }
    const ids = new Set(items.map((item) => item.id));
    entry.picked = (state) => {
      const count = state.effects.filter((id) => ids.has(id)).length;
      return { count, label: count ? `已选 ${count}` : `${items.length} 项` };
    };
    effectArea.append(entry.section);
  }

  // 光照控制：复选框 + 光照方向，合成一张卡
  const lightingCard = makeElement("div", null);
  lightingCard.className = "gg-lighting-card";
  const subjectRow = makeElement("label", null);
  subjectRow.className = "gg-lighting-check";
  subjectRow.style.alignSelf = "flex-start";
  const subjectInput = document.createElement("input");
  subjectInput.type = "checkbox";
  subjectRow.append(subjectInput, makeElement("span", null, "光线作用主体"));

  const directionEntry = registerCollapsible(createCollapsible({
    key: SECTION_DIRECTION,
    kind: "direction",
    title: "光照方向",
    total: DIRECTIONS.length,
    columns: 4,
  }));
  const directionButtons = new Map();
  for (const direction of DIRECTIONS) {
    const button = createToggleButton(direction.name);
    directionButtons.set(direction.id, button);
    directionEntry.body.append(button);
  }
  // 补一个占位格，让 11 个方向按钮落在 4×3 的网格里
  directionEntry.body.append(makeElement("div", { height: "24px" }));
  directionEntry.picked = (state) => {
    // 方向表里的「默认」项 id 就是空串，`state.direction === ""` 表示没选，不能当成选中了「默认」。
    const chosen = state.direction
      ? DIRECTIONS.find((direction) => direction.id === state.direction)
      : null;
    return chosen
      ? { count: 1, label: `已选 ${chosen.name}` }
      : { count: 0, label: `${DIRECTIONS.length} 项` };
  };
  lightingCard.append(subjectRow, directionEntry.section);

  // 补充说明
  const extraInput = applyFieldStyle(makeElement("textarea"), { height: "56px" });
  extraInput.placeholder = "补充希望呈现的光线、阴影或氛围细节（建议英文）…";
  extraInput.spellcheck = false;
  // 滚轮落在输入框里时不要连带缩放画布
  extraInput.addEventListener("wheel", (event) => event.stopPropagation());
  const extraEntry = registerCollapsible(createCollapsible({
    key: SECTION_EXTRA,
    kind: "extra",
    title: "补充说明",
    card: true,
    showCount: false,
    body: extraInput,
  }));

  // 最终提示词：标题行右侧放词数胶囊 + 复制按钮
  const previewCount = makeElement("span", null, "");
  previewCount.className = "gg-lighting-count";
  previewCount.style.marginLeft = "auto";
  previewCount.style.display = "none";
  const copyButton = makeElement("button", null, "复制");
  copyButton.type = "button";
  copyButton.className = "gg-lighting-copy";
  copyButton.title = "复制当前最终提示词";

  const preview = applyFieldStyle(makeElement("div", null), {
    height: "88px",
    overflowY: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    userSelect: "text",
  });
  preview.className = "gg-lighting-field gg-lighting-preview is-empty";
  preview.textContent = EMPTY_PREVIEW;
  preview.addEventListener("wheel", (event) => event.stopPropagation());
  const previewEntry = registerCollapsible(createCollapsible({
    key: SECTION_PREVIEW,
    kind: "preview",
    title: "最终提示词",
    card: true,
    showCount: false,
    headExtra: [previewCount, copyButton],
    body: preview,
  }));

  host.append(
    header,
    toolbar,
    angleEntry.section,
    effectArea,
    lightingCard,
    extraEntry.section,
    previewEntry.section,
  );

  // 面板高度由内容决定，任何一段都不许被 flex 挤压：
  // 光效区是面板里唯一带 overflow 的子元素，`min-height: auto` 对它解析为 0 ——
  // 只要父级高度比内容小一点，它就会被整块压成 0 高（光效看起来凭空消失），
  // 而其它段落因为最小高度保护毫发无伤。宁可内容溢出被裁，也不能让一整段消失。
  lockPanelChildren(host);

  const state = normalizeState(readStoredState(node));
  // 折叠只是浏览状态、不写进 properties；但已选中的分区必须展开，
  // 否则重开工作流后用户看不到自己选过什么。
  // 镜头角度、光照方向、补充说明默认收起：常驻各占 5 行 / 3 行 / 一块输入框，会把面板顶得很高。
  const collapsed = new Set(GROUPS.filter((group) => !group.open).map((group) => group.key));
  collapsed.add(SECTION_ANGLE);
  collapsed.add(SECTION_DIRECTION);
  collapsed.add(SECTION_EXTRA);
  for (const id of state.effects) {
    const effect = EFFECTS.find((item) => item.id === id);
    if (effect) collapsed.delete(effect.group);
  }
  if (state.angle) collapsed.delete(SECTION_ANGLE);
  if (state.direction) collapsed.delete(SECTION_DIRECTION);
  if (state.extra) collapsed.delete(SECTION_EXTRA);

  // 基础模式藏起来的项如果已经被选过，直接进高级模式，避免「选过却看不见」。
  // 只在没存过模式时推断一次，用户手动切过之后就以他的选择为准。
  const needsAdvanced = (state.angle && !BASIC_ANGLE_IDS.has(state.angle))
    || state.effects.some((id) => !BASIC_EFFECT_IDS.has(id));

  return {
    node,
    host,
    effectArea,
    hint,
    preview,
    previewCount,
    copyButton,
    clearButton,
    themeButton,
    modeSeg,
    modeButtons,
    subjectInput,
    extraInput,
    effectButtons,
    angleButtons,
    directionButtons,
    collapsibles,
    collapsed,
    state,
    mode: state.mode || (needsAdvanced ? "advanced" : "basic"),
    resolvedTheme: "",
    measuredHeight: 0,
    widgetPad: 0,
    requestedHeight: 0,
    prompt: "",
    copyTimer: 0,
    needsRefit: false,
  };
}

// SD1.5 / SDXL 的 CLIP 上限是 77 token（≈60 个英文词），超出后走分块编码、后半段被稀释；
// Flux / SD3.5 / Qwen 这类长文本模型基本不受这个阈值限制。
const LENGTH_LIMIT = 60;
const LENGTH_HINT = "超过这个长度后，SD1.5 / SDXL 一类 CLIP 模型容易丢掉后半段（约 77 token 上限）；Flux / Qwen 等长文本模型影响较小。";

function measurePromptLength(prompt) {
  const value = String(prompt || "").trim();
  if (!value) return null;
  const count = value.split(/\s+/).filter(Boolean).length;
  return { label: `${count} 词`, over: count > LENGTH_LIMIT };
}

function hintText(state) {
  // 计数口径要覆盖全部「可选并会进提示词」的项，否则状态栏数字和实际内容对不上。
  const total = CAMERA_ANGLES.length + EFFECTS.length + DIRECTIONS.length;
  const count = state.effects.length + (state.angle ? 1 : 0) + (state.direction ? 1 : 0);
  return count ? `已选 ${count} · 共 ${total} 项` : `未选 · 共 ${total} 项`;
}

// 折叠状态只影响显示：内容体 display、箭头朝向、标题右侧的「N 项 / 已选 …」。
// 光效组、镜头角度、光照方向、补充说明、最终提示词走同一份逻辑，
// 靠 entry.picked(state) 区分计数口径；`isGrid` 决定展开时是网格还是普通块。
function applyCollapsibleVisibility(panel) {
  for (const entry of panel.collapsibles.values()) {
    const collapsed = panel.collapsed.has(entry.key);
    entry.body.style.display = collapsed ? "none" : entry.isGrid ? "grid" : "";
    entry.caret.textContent = collapsed ? "▸" : "▾";
    entry.head.setAttribute("aria-expanded", collapsed ? "false" : "true");
    // 补充说明 / 最终提示词没有「种数」，别给它们编一个「共 0 种」
    entry.head.title = entry.total
      ? `${collapsed ? "展开" : "收起"}${entry.title}（共 ${entry.total} 种）`
      : `${collapsed ? "展开" : "收起"}${entry.title}`;

    const picked = entry.picked
      ? entry.picked(panel.state)
      : { count: 0, label: `${entry.total} 项` };
    // 基础模式藏起了部分项，标题上的数字要跟眼前的按钮对得上，否则「8 项」只看到 6 个会很怪
    let label = picked.label;
    if (!picked.count && entry.isGrid) {
      const shown = [...entry.body.children].filter((child) => child.tagName === "BUTTON" && child.style.display !== "none").length;
      if (shown < entry.total) label = `${shown} / ${entry.total} 项`;
    }
    entry.countEl.textContent = label;
    entry.countEl.className = picked.count ? "gg-lighting-count is-active" : "gg-lighting-count";
    const base = entry.kind === "effect" ? "gg-lighting-group" : "gg-lighting-group is-primary";
    entry.head.className = picked.count ? `${base} is-active` : base;
  }
}

function applyState(panel) {
  const { state } = panel;

  for (const effect of EFFECTS) {
    const button = panel.effectButtons.get(effect.id);
    if (!button) continue;
    setPressed(button, state.effects.includes(effect.id));
    button.title = effect.en;
  }
  for (const direction of DIRECTIONS) {
    const button = panel.directionButtons.get(direction.id);
    if (button) setPressed(button, state.direction === direction.id);
  }
  for (const angle of CAMERA_ANGLES) {
    const button = panel.angleButtons.get(angle.id);
    if (!button) continue;
    setPressed(button, state.angle === angle.id);
    button.title = angle.en;
  }

  panel.subjectInput.checked = state.subject;
  if (panel.extraInput.value !== state.extra) panel.extraInput.value = state.extra;

  const prompt = composePrompt(state);
  panel.prompt = prompt;
  panel.preview.textContent = prompt || EMPTY_PREVIEW;
  panel.preview.className = prompt
    ? "gg-lighting-field gg-lighting-preview"
    : "gg-lighting-field gg-lighting-preview is-empty";
  // 没内容时复制按钮就是禁用态，免得点了没反应还以为是坏的
  panel.copyButton.disabled = !prompt;

  const length = measurePromptLength(prompt);
  if (panel.previewCount) {
    panel.previewCount.textContent = length ? length.label : "";
    panel.previewCount.className = length?.over ? "gg-lighting-count is-over" : "gg-lighting-count";
    // 没词数时把胶囊整个收掉，不然会留一个空壳
    panel.previewCount.style.display = length ? "" : "none";
    panel.previewCount.title = length?.over ? LENGTH_HINT : "";
  }

  panel.hint.textContent = hintText(state);
  panel.themeButton.textContent = `主题 · ${THEME_MODE_LABELS[state.theme] ?? THEME_MODE_LABELS.auto}`;
  // 先按模式把按钮摆好，折叠显隐才知道每个分组实际露出几项
  if (applyMode(panel)) panel.needsRefit = true;
  applyCollapsibleVisibility(panel);
  applyPalette(panel);
}

function commit(node, panel, writeWidget = true) {
  applyState(panel);
  node.properties = node.properties || {};
  node.properties[STATE_KEY] = {
    effects: [...panel.state.effects],
    angle: panel.state.angle,
    direction: panel.state.direction,
    subject: panel.state.subject,
    extra: panel.state.extra,
    theme: panel.state.theme,
    mode: panel.mode,
  };
  if (writeWidget) {
    const widget = getWidget(node, PROMPT_WIDGET);
    if (widget) widget.value = panel.prompt;
  }
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  if (panel.needsRefit) {
    panel.needsRefit = false;
    panel.measuredHeight = 0;
    requestAnimationFrame(() => fitNode(node));
  }
}

// ---------------------------------------------------------------- 控件读写

function getWidget(node, name) {
  return node?.widgets?.find((widget) => widget?.name === name) ?? null;
}

function readStoredState(node) {
  const raw = node?.properties?.[STATE_KEY];
  return raw && typeof raw === "object" ? raw : null;
}

function hideWidget(widget) {
  if (!widget || widget._ggLightingHidden) return;
  widget._ggLightingHidden = true;
  widget._ggLightingOriginalType = widget.type;
  widget._ggLightingOriginalComputeSize = widget.computeSize;
  // 隐藏时先写 hidden 再换 type：反序会被前端从旧 type 重新派生可见性。
  widget.hidden = true;
  widget.type = HIDDEN_TYPE;
  widget.computeSize = () => [0, -4];
}

// ---------------------------------------------------------------- 布局

function applyPanelLayout(panel, width) {
  if (!panel?.host) return;
  const panelWidth = Math.max(220, Math.round(Number(width) || MIN_WIDTH) - NODE_INSET);
  Object.assign(panel.host.style, {
    width: `${panelWidth}px`,
    minWidth: `${panelWidth}px`,
    maxWidth: `${panelWidth}px`,
  });
  // 列数跟着实际可用宽度走：拉宽到 4 列、拉窄回 3 列，长中文标签不会被挤扁
  applyGridColumns(panel);
}

// 量面板的自然高度、给 computeSize 补前端差额：细节与踩坑说明见 gg-panel-fit.js。
function panelNodeHeight(panel) {
  if (!panel) return FALLBACK_PANEL_HEIGHT;
  // 以自然内容高度为准：折叠分组时它会变小，节点就跟着收；DOM 还没排好版（量到 0）时才用记录值 / 兜底值。
  const measured = measurePanelHeight(panel.host);
  if (measured > 120) panel.measuredHeight = measured;
  return panel.measuredHeight || FALLBACK_PANEL_HEIGHT;
}

function widgetHeight(panel) {
  return nextWidgetHeight(panel, panelNodeHeight(panel));
}

function fitNode(node) {
  const panel = node?.ggLightingPanel;
  if (!panel) return;
  // 宽高都只增不减：用户拖出来的尺寸不许被自动布局收回去（规则见 gg-panel-fit.js）
  const width = resolveNodeWidth(node, MIN_WIDTH);
  // 先按宽度摆好列数，再量自然高度，量到的才是最终排版下的高度
  applyPanelLayout(panel, width);
  const panelHeight = panelNodeHeight(panel);

  const computed = typeof node.computeSize === "function" ? node.computeSize() : null;
  // 用户手动拉高过就按用户的高度来：点分区标题折叠、切基础/高级模式都不许把节点压回去。
  const height = resolveNodeHeight(panel, Math.max(Number(computed?.[1]) || 0, panelHeight));
  const current = [Number(node.size?.[0]) || 0, Number(node.size?.[1]) || 0];
  if (current[0] === width && Math.abs(current[1] - height) <= 1) return;

  setPanelNodeSize(panel, node, [width, height]);
  node.size = [width, height];
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  // 差额是上一轮观测出来的，改完尺寸后可能还要再贴合一次
  scheduleRefit(node, fitNode);
}

function installResizeHook(node) {
  if (node._ggLightingResizeHook) return;
  node._ggLightingResizeHook = true;

  const originalOnResize = node.onResize;
  node.onResize = function (size) {
    const result = originalOnResize?.apply(this, arguments);
    const width = Math.max(MIN_WIDTH, Number(size?.[0]) || Number(this.size?.[0]) || MIN_WIDTH);
    if (size && typeof size === "object" && typeof size.length === "number" && Number(size[0]) < MIN_WIDTH) {
      size[0] = width;
    }
    if (this.size && Number(this.size[0]) < MIN_WIDTH) this.size[0] = width;
    applyPanelLayout(this.ggLightingPanel, width);
    return result;
  };
}

// ---------------------------------------------------------------- 交互绑定

function bindPanel(node, panel) {
  for (const effect of EFFECTS) {
    const button = panel.effectButtons.get(effect.id);
    if (!button) continue;
    button.addEventListener("click", () => {
      const effects = panel.state.effects;
      const index = effects.indexOf(effect.id);
      if (index >= 0) effects.splice(index, 1);
      else effects.push(effect.id);
      commit(node, panel);
    });
  }

  // 分区标题：点一下折叠/展开。折叠会改变内容高度，清掉已测高度让节点重新贴合。
  // 光效组、镜头角度、光照方向走同一套。
  for (const entry of panel.collapsibles.values()) {
    entry.head.addEventListener("click", () => {
      if (panel.collapsed.has(entry.key)) panel.collapsed.delete(entry.key);
      else panel.collapsed.add(entry.key);
      applyCollapsibleVisibility(panel);
      panel.measuredHeight = 0;
      requestAnimationFrame(() => fitNode(node));
    });
  }

  for (const angle of CAMERA_ANGLES) {
    const button = panel.angleButtons.get(angle.id);
    if (!button) continue;
    button.addEventListener("click", () => {
      // 再点一次当前机位即取消
      panel.state.angle = panel.state.angle === angle.id ? "" : angle.id;
      commit(node, panel);
    });
  }

  for (const direction of DIRECTIONS) {
    const button = panel.directionButtons.get(direction.id);
    if (!button) continue;
    button.addEventListener("click", () => {
      // 再点一次当前方向回到「默认」
      panel.state.direction = panel.state.direction === direction.id ? "" : direction.id;
      commit(node, panel);
    });
  }

  panel.subjectInput.addEventListener("change", () => {
    panel.state.subject = Boolean(panel.subjectInput.checked);
    commit(node, panel);
  });

  panel.extraInput.addEventListener("input", () => {
    panel.state.extra = panel.extraInput.value;
    commit(node, panel);
  });

  // 基础 / 高级：只改显示，不清已选项、不改提示词拼装规则
  for (const [key, button] of panel.modeButtons) {
    button.addEventListener("click", () => {
      if (panel.mode === key) return;
      panel.mode = key;
      panel.state.mode = key;
      commit(node, panel);
    });
  }

  // 主题：自动 → 深色 → 浅色 循环。自动模式跟随 ComfyUI，手动模式由用户钉死。
  panel.themeButton.addEventListener("click", () => {
    panel.state.theme = nextThemeMode(panel.state.theme);
    commit(node, panel);
  });

  panel.copyButton.addEventListener("click", () => {
    copyPrompt(panel);
  });
}

// 复制必须真复制：优先走异步剪贴板，失败（非安全上下文 / 无权限）回退到临时 textarea。
async function copyPrompt(panel) {
  const text = panel.prompt;
  if (!text) return;
  let done = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      done = true;
    }
  } catch {
    done = false;
  }
  if (!done) {
    const scratch = makeElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    Object.assign(scratch.style, { position: "fixed", top: "-1000px", opacity: "0" });
    document.body.append(scratch);
    scratch.select();
    try {
      done = document.execCommand?.("copy") === true;
    } catch {
      done = false;
    }
    scratch.remove();
  }
  flashCopy(panel, done);
}

function flashCopy(panel, ok) {
  const button = panel.copyButton;
  clearTimeout(panel.copyTimer);
  button.textContent = ok ? "已复制" : "复制失败";
  button.classList.toggle("is-done", ok);
  panel.copyTimer = setTimeout(() => {
    button.textContent = "复制";
    button.classList.remove("is-done");
  }, 1200);
}

function bindClear(node, panel, clearButton) {
  clearButton.addEventListener("click", () => {
    // 只清「选项」，补充说明是用户自己敲的字，误删等于丢数据
    panel.state.effects = [];
    panel.state.angle = "";
    panel.state.direction = "";
    commit(node, panel);
  });
}

// ---------------------------------------------------------------- 安装

function setupNode(node) {
  if (!node || (node.comfyClass !== NODE_NAME && node.type !== NODE_NAME)) return;
  const widget = getWidget(node, PROMPT_WIDGET);
  if (!widget) return;

  if (node.ggLightingPanel) {
    const stored = readStoredState(node);
    if (stored) {
      node.ggLightingPanel.state = normalizeState(stored);
      // 重开工作流时以存下来的模式为准（没存过就保持当前推断值）
      if (node.ggLightingPanel.state.mode) node.ggLightingPanel.mode = node.ggLightingPanel.state.mode;
      commit(node, node.ggLightingPanel);
    } else {
      applyState(node.ggLightingPanel);
    }
    applyPanelLayout(node.ggLightingPanel, node.size?.[0] || MIN_WIDTH);
    // 用户拖过的尺寸要留住：认领必须发生在贴合之前，否则先被贴小就认不出来了
    trackManualHeight(node.ggLightingPanel, node);
    captureManualHeight(
      node.ggLightingPanel,
      node,
      Math.max(Number(node.computeSize?.()?.[1]) || 0, panelNodeHeight(node.ggLightingPanel)),
      node._ggLightingSavedHeight,
    );
    requestAnimationFrame(() => fitNode(node));
    return;
  }

  // 没有 DOM 控件能力时保留可见文本框，节点退化为「手写提示词 + 合并上游」
  if (typeof node.addDOMWidget !== "function") return;

  const panel = createPanel(node);
  node.ggLightingPanel = panel;
  bindPanel(node, panel);
  bindClear(node, panel, panel.clearButton);
  applyState(panel);

  node.serialize_widgets = true;
  installResizeHook(node);

  let domWidget = null;
  try {
    domWidget = node.addDOMWidget(DOM_WIDGET_NAME, "gg_lighting_prompt", panel.host, {
      getValue() {
        return "";
      },
      setValue() {},
      serialize: false,
    });
  } catch (error) {
    // 面板挂不上就把文本框留给用户，不要把控件也藏了
    console.warn("[GuliNodes] GG 镜头打光提示词面板创建失败，已保留「提示词」文本框：", error);
    node.ggLightingPanel = null;
    return;
  }

  // 面板确实挂上之后再隐藏文本框
  hideWidget(widget);

  domWidget.computeSize = function (width) {
    const nodeWidth = Math.max(MIN_WIDTH, Number(width) || node.size?.[0] || MIN_WIDTH);
    applyPanelLayout(panel, nodeWidth);
    return [nodeWidth, widgetHeight(panel)];
  };
  domWidget.onRemoved = function () {
    panel.host.remove?.();
  };
  node.ggLightingWidget = domWidget;

  const stored = readStoredState(node);
  if (stored) commit(node, panel);
  // 用户手动拉过高度之后，贴合只许撑大不许收小：点分区标题折叠、切基础/高级都不许把节点压回去。
  // 必须在第一次贴合之前认领工作流里存的高度，否则先被贴小、再认领就认不出来了。
  trackManualHeight(panel, node);
  captureManualHeight(
    panel,
    node,
    Math.max(Number(node.computeSize?.()?.[1]) || 0, panelNodeHeight(panel)),
    node._ggLightingSavedHeight,
  );
  requestAnimationFrame(() => fitNode(node));
  setTimeout(() => fitNode(node), 120);
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.LightingPrompt",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME || nodeType.prototype._ggLightingInstalled) return;
    nodeType.prototype._ggLightingInstalled = true;

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalOnNodeCreated?.apply(this, args);
      setTimeout(() => setupNode(this), 0);
      return result;
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      // 前端挂 DOM 控件时可能先把节点压回内容高度，等 setupNode 再读 node.size 已经晚了。
      // 工作流里存的原始尺寸在这里先记下来，贴合时用它认领。
      const info = args?.[0];
      if (info?.size && typeof info.size.length === "number" && info.size.length >= 2) {
        this._ggLightingSavedHeight = Math.round(Number(info.size[1]) || 0);
      }
      const result = originalOnConfigure?.apply(this, args);
      setTimeout(() => setupNode(this), 0);
      return result;
    };
  },

  nodeCreated(node) {
    setTimeout(() => setupNode(node), 0);
  },

  loadedGraphNode(node) {
    setTimeout(() => setupNode(node), 0);
  },
});
