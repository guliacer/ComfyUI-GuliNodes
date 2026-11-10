import { registerRowLayout } from "./gg-widget-rows.js";

// 各节点的行布局预设
// ------------------------------------------------------------------
// 口径（2026-11-04 定）：**非必要一律单列**（columns: 1，每行一个控件，
// 宽度贴着最宽的控件收），只有确实有必要的节点才用两列：
//   · 同形参数成对排能明显省高、又不产生孤行的（GG色彩校正 6 个滑杆 2×3、
//     GGFaceSkinSmoothing / GGImageStyleReference 各 4 个滑杆 2×2）；
//   · 参数天然成对的（GG纯色图像 宽度/高度 同行，填充颜色独占一行）。
// 三列及以上不再使用：孤行、一头沉、标签被挤是常态（历史做法见更新记录）。
//
// 只登记「参数固定、互不联动」的节点：控件按声明顺序排。有前端动态显隐的
// 节点（提示词增强、人脸美化、反推模型等）不在这一批，那些节点要等各自的
// 显隐逻辑接上 refreshRowLayout 再逐个体检，否则会出现「藏了控件但行没重排」
// 的半截状态。
//
// 带 `control_after_generate`（种子后面的 randomize/fixed 小控件）的节点保持
// 单列：那个控件会自己占一格，多列时看起来像「种子 | randomize | 步数」，
// 语义上是断的。
//
// 想给某个节点登记：在这里加一条 registerRowLayout("节点类名", {...})，
// 类名就是 object_info 里的键（comfyClass）。

const SINGLE = {
    columns: 1,
    // minWidth: "content" —— 引擎按「最宽控件完整显示所需」收紧宽度，
    // 长取值仍受 130/220 额度截断，节点不会为一个值撑到天上去。
    minWidth: "content",
    // 多行文本框和图像预览不参与分列，独占一行
    fullWidth: (widget) => {
        const type = String(widget?.type ?? "").toLowerCase();
        if (type === "text" || type === "customtext") {
            return widget?.options?.multiline === true;
        }
        return type === "image" || type === "image_preview";
    },
};

// 两列基线：宽度由引擎按「最宽那行的内容宽」收紧（contentWidth 只量多控件行，
// 单列行全是一行一个、量出来是 0，所以单列走上面的 minWidth: "content"）。
const PAIR = {
    columns: 2,
    fullWidth: SINGLE.fullWidth,
};

// 宽度 / 高度 · 填充颜色（独占一行）
// 颜色控件左边画标签、右边画 40px 色块、中间塞十六进制文本，一列宽度放不下，
// 多列时标签和色值会互相压住。宽/高是天然一对，让它俩同行（两列），
// 填充颜色单独占满一行，标签和色值都能看清。
registerRowLayout("GG纯色图像", {
    ...SINGLE,
    minWidth: 0,
    rows: (node, shown) => {
        const byName = new Map(shown.map((widget) => [widget.name, widget]));
        const sizeRow = [byName.get("宽度"), byName.get("高度")].filter(Boolean);
        const others = shown
            .filter((widget) => widget.name !== "宽度" && widget.name !== "高度")
            .map((widget) => [widget]);
        return sizeRow.length ? [sizeRow, ...others] : others;
    },
});

// 六个同形滑杆（温度 / 色调 / 明度 / 对比度 / 饱和度 / 伽马）2×3 成对排，
// 高度省一半也不出孤行，属于「确实有必要」的两列。
registerRowLayout("GG色彩校正", { ...PAIR });

// 宽高方式切换各模式的参数（比例 / 类型 / 方向 / 倍数 / 边长），按口径单列。
// labels 只换显示名，name 与序列化不动；「倍数」措辞由 verify_ar_rows 断言钉住。
registerRowLayout("GGAspectRatioAdapter", {
    ...SINGLE,
    labels: {
        宽高方式: "方式",
        宽高比例: "比例",
        边长类型: "类型",
        画面方向: "方向",
        缩放倍率: "倍数",
    },
});

// 遮罩填充 / 遮罩反相 / 遮罩扩展 · 低值过滤 / 上下文扩展 / 画面外扩 · 输出宽度 / 输出高度 / 尺寸对齐
// 九个参数混着三组用途，多列排开看不清组别，按「人脸美化」的口径回归单列。
registerRowLayout("GGInpaintCrop", {
    ...SINGLE,
    labels: {
        遮罩填充: "填充",
        遮罩反相: "反相",
        遮罩扩展: "扩展",
        低值过滤: "过滤",
        上下文扩展: "上下文",
        画面外扩: "外扩",
        输出宽度: "宽",
        输出高度: "高",
        尺寸对齐: "对齐",
    },
});

// 表达式是可编辑的长文本框，一条占满一整行；显示几条由 web/gg-simple-math.js
// 按接线数量动态控制，这里只把节点宽度定住。
registerRowLayout("GGSimpleMath", {
    columns: 1,
    minWidth: 340,
    fullWidth: () => true,
});

// ------------------------------------------------------------------
// 批量登记（其余纯控件节点）
// ------------------------------------------------------------------
// 全部单列。labels 只换显示名（`比例` 代替 `宽高比例`），name 与序列化不动，
// 老工作流不受影响。跳过的是这几类，都有各自的理由：
//   · 上面手工登记的（色彩校正 / 纯色图像 / 局部重绘裁剪）；
//   · 带多行文本框的 8 个：`GG 提示词优化`、`GG 提示词优化qwen2.1`、
//     `GG 提示词增强qwen2.1`、`GG 图像反推`、`GG 文本反推`、`GG CLIP文本`、
//     `GG 文本拼接`、`GG 分区编辑准备`。它们的文本框走 computeLayoutSize
//     （高度由节点剩余空间分出来），再叠一层自定 y 会跟官方排布打架；
//     引擎里也加了同样的兜底判断。
//   · 没有控件或画面由图像决定高度的：`GGPreviewImage`、`GG 图像对比 2张 / N张`；
//   · 自绘界面：`GG 标题`、`GG 文本`、`GG 密钥输入`、`GG 镜头打光提示词`、
//     `GG 提示词库`、`GG 网页AI图像反推`（节点高度自己管）、`GG 视频保存`（内嵌预览）；
//   · 控件全隐藏的 `GG 单组控制 / 多组控制`。
//   · 参数一大坨的 `GG 智能人脸美化`（登记见文末，同为单列）。

const AUTO_LABELS = {
    // 尺寸 / 缩放
    缩放方式: "方式",
    缩放方法: "方法",
    缩放插值: "插值",
    缩放倍率: "倍率",
    将边缩放到: "边长",
    缩放模式: "模式",
    执行条件: "条件",
    Latent方式: "方式",
    宽高比例: "比例",
    边长类型: "类型",
    批量大小: "批量",
    画面方向: "方向",
    最大边长: "边长",
    变换类型: "变换",
    // 遮罩
    遮罩填充: "填充",
    遮罩扩展: "扩展",
    遮罩羽化: "羽化",
    遮罩收缩: "收缩",
    颜色还原: "还原",
    扩展方式: "方式",
    扩展系数: "系数",
    输出尺寸: "尺寸",
    倍数取整: "取整",
    匹配方法: "方法",
    匹配图像大小: "匹配尺寸",
    叠加颜色: "颜色",
    叠加不透明度: "不透明度",
    背景压暗: "压暗",
    // 人脸
    自动磨皮: "磨皮",
    自动美白皮肤: "美白",
    眼白提亮: "眼白",
    眼睛大小: "眼睛",
    牙齿美白: "牙齿",
    自动瘦脸: "瘦脸",
    脸部扩展: "扩展",
    检测灵敏度: "灵敏度",
    检测提示词: "检测词",
    人脸识别方式: "识别方式",
    SAM3阈值: "阈值",
    SAM3精修: "精修",
    // 风格参考
    风格强度: "风格",
    色彩强度: "色彩",
    纹理强度: "纹理",
    保留结构: "结构",
    // 超分
    分块重叠: "重叠",
    自动下载: "下载",
    超分后卸载: "卸载",
    // 压缩 / 保存
    压缩方式: "方式",
    压缩模式: "模式",
    目标大小KB: "目标KB",
    文件名前缀: "前缀",
    保存文件名前缀: "前缀",
    分辨率处理: "分辨率",
    移除元数据: "去元数据",
    // 视频
    编码速度: "速度",
    输出帧率: "帧率",
    音频码率kbps: "音频码率",
    视频文件: "视频",
    视频路径: "路径",
    选择视频文件: "选择文件",
    输出格式: "格式",
    执行前验证可读: "预检",
    // 提示词 / LLM
    任务模式: "任务",
    输出语言: "语言",
    增强方式: "方式",
    卸载策略: "卸载",
    增强方向: "方向",
    卸载LLM模型: "卸载模型",
    最大生成token: "输出token",
    最大输出Token: "输出token",
    最大输入字符: "输入字符",
    top_p采样: "top_p",
    top_k采样: "top_k",
    输出think块: "think块",
    提示词规则: "规则",
    系统提示词: "系统",
    输入提示词: "输入",
    正向提示词: "正向",
    负向提示词: "负向",
    CLIP名称: "CLIP",
    文生图PE模型: "文生图PE",
    图生图PE模型: "图生图PE",
    文生图LLM模型: "文生图LLM",
    图生图LLM模型: "图生图LLM",
    // 长 mmproj 文件名会把原名挤成 "mm …"，短标签才留得住。
    mmproj: "投影",
    control_after_generate: "生成后",
    处理区域: "区域",
    编辑需求: "需求",
    全局要求: "要求",
    // 文本
    小说内容: "内容",
    提取规则: "规则",
    总结要求: "要求",
    TXT文件: "文件",
    TXT路径: "路径",
    // 模型 / 视频 / 缓存
    模型类型: "类型",
    视觉投影mmproj: "投影",
    启用思考: "思考",
    上下文长度: "上下文",
    KV缓存K类型: "K缓存",
    KV缓存V类型: "V缓存",
    视频格式: "容器",
    像素格式: "像素",
    修剪音频: "修剪",
    清除内存: "清内存",

    // 其它
    清除缓存: "清缓存",
    清除模型: "清模型",
    清除VAE缓存: "VAE缓存",
    种子来源: "来源",
    偏移模式: "偏移",
    内存清理: "清理",
    引导强度: "引导",
    降噪强度: "降噪",
    VAE名称: "VAE",
};

// 套单列布局的节点。
const AUTO_CLASSES = [
    "GG图像缩放",
    "GG图像缩放V2",
    "GGAspectRatioLatent",
    "GGColorMatch",
    "GGCropRestore",
    "GGImageAdjust",
    "GGImageCompress",
    "GGImageCrop",
    "GGImageMergeMask",
    "GGImageObfuscate",
    "GGImageSuperResolution",
    "GGImageTransform",
    "GGInteger",
    "GGMaskCheck",
    "GGMaskCrop",
    "GGMemoryCleanup",
    "GGSaveImage",
    "GGSeedGenerator",
    "GGTextFileLoad",
    "GGVAE解码",
    "GGVideoCompress",
    "GGVideoLoad",
    "GGVideoLoadByPath",
    "GGZImageSampler",
];

// 参数 ≥7 个的节点配功能分组：每组第一个控件所在行前插节标题
// （11px muted + 通栏细线）。match 按控件 name 末段匹配，顺序决定标题顺序。
const GROUPS = {
    GGZImageSampler: [
        { title: "种子", match: ["种子", "control_after_generate"] },
        { title: "采样", match: ["步数", "引导强度", "采样器", "调度器", "降噪强度"] },
    ],
    GGFaceSmartBeauty: [
        { title: "肤质", match: ["自动磨皮", "自动美白皮肤"] },
        { title: "五官", match: ["眼白提亮", "眼睛大小", "牙齿美白", "自动瘦脸", "脸部扩展"] },
        { title: "检测", match: ["检测灵敏度", "检测提示词", "人脸识别方式", "SAM3阈值", "SAM3精修"] },
        { title: "遮罩", match: ["遮罩收缩", "遮罩羽化"] },
    ],
    GGVideoCompress: [
        { title: "编码", match: ["编码器", "压缩模式", "CRF", "编码速度"] },
        { title: "输出", match: ["输出帧率", "音频码率kbps", "移除元数据"] },
    ],
    GG反推模型: [
        { title: "模型", match: ["模型类型", "主模型", "视觉投影mmproj"] },
        { title: "运行", match: ["启用思考", "上下文长度", "GPU层数", "KV缓存K类型", "KV缓存V类型"] },
    ],
};

const AUTO_LAYOUT = { ...SINGLE, labels: AUTO_LABELS };

for (const comfyClass of AUTO_CLASSES) {
    registerRowLayout(comfyClass, GROUPS[comfyClass]
        ? { ...AUTO_LAYOUT, groups: GROUPS[comfyClass] }
        : AUTO_LAYOUT);
}

// 四个同形滑杆 2×2 成对排，不出孤行、高度省一半，保留两列。
registerRowLayout("GGFaceSkinSmoothing", { ...PAIR, labels: AUTO_LABELS });
registerRowLayout("GGImageStyleReference", { ...PAIR, labels: AUTO_LABELS });

// 这三个原本是固定权重 / 自动折行，随口径统一改单列。

// 图像压缩保存回归单列（每行一个控件，宽度贴着最宽控件收）：
//   · 此前用 flow 流式折行（拉宽把下方控件逐个并排成 2~3 列），用户反馈
//     「参数设置很乱」，按要求改回默认单列。
//   · 单列下宽度走 minWidth: "content"（引擎按最宽控件完整显示所需收紧），
//     拉宽时富余由 packedRects 补给长取值列、行尾不留死空白。
//   · 高度归本节点内容精确贴合（与其它单列节点一致，见文件顶部口径）。
registerRowLayout("GGImageCompressSave", AUTO_LAYOUT);
registerRowLayout("GGVideoBridgeFromImageAudio", AUTO_LAYOUT);
registerRowLayout("GG反推模型", { ...AUTO_LAYOUT, groups: GROUPS["GG反推模型"] });

// 提示词增强带多行文本框，只借这套配置调宽度和显示名（引擎对弹性高度节点只调宽）,
// 那两个 PE 模型下拉原来在 400px 里会被切成 20 来个字符的省略号。
registerRowLayout("GGPromptEnhancer", AUTO_LAYOUT);

// 参数一大坨的节点多列排开看不清组别，单列（每行一个控件）。
// 显示名沿用短标签，否则「自动美白皮肤」这类长标签在单列里会被截成「自动美 …」。
registerRowLayout("GGFaceSmartBeauty", { ...AUTO_LAYOUT, groups: GROUPS.GGFaceSmartBeauty });
