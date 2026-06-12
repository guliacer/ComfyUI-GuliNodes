import { app } from "../../scripts/app.js";
import { ggIcon } from "./gg-ui-icons.js";

const SETTINGS = {
    enabled: "GuliNodes.comfyTranslate.enabled",
    topButton: "GuliNodes.enableComfyTranslateButton",
    menuDisplay: "Comfy.UseNewMenu",
};

const ORIGINAL_KEY = "__ggComfyTranslateOriginal";
const PATCHED_KEY = "__ggComfyTranslatePatched";
const NODE_DEFS = new Set();
const VISUAL_TEXT_TRANSLATIONS = new Map();

const PROTECTED_TERMS = new Set([
    "AI", "API", "BF16", "BGR", "CPU", "CUDA", "DiT", "dit", "FP8", "FP16", "GG", "GPU", "HTML",
    "IPAdapter", "IP-Adapter", "JPEG", "JPG", "JSON", "KSampler", "LoCon", "LoRA",
    "LyCORIS", "MP4", "ONNX", "PNG", "RAM", "RGB", "RGBA", "SD", "SDXL", "SD3",
    "SVG", "T2I", "UNET", "VAE", "VRAM", "WEBP", "WAN", "Wan", "WanVideo",
]);

const EXACT_TRANSLATIONS = new Map([
    ["Load Checkpoint", "加载 Checkpoint"],
    ["Load Checkpoint With Config (DEPRECATED)", "加载带配置的 Checkpoint (已弃用)"],
    ["Load Checkpoint Image Only (img2vid model)", "加载仅图像 Checkpoint (img2vid 模型)"],
    ["CheckpointLoaderSimple", "加载 Checkpoint"],
    ["CheckpointLoader", "加载带配置的 Checkpoint"],
    ["unCLIPCheckpointLoader", "加载 unCLIP Checkpoint"],
    ["Load VAE", "加载 VAE"],
    ["VAELoader", "加载 VAE"],
    ["VAE Encode", "VAE 编码"],
    ["VAE Decode", "VAE 解码"],
    ["VAEEncode", "VAE 编码"],
    ["VAEDecode", "VAE 解码"],
    ["VAEEncodeForInpaint", "VAE 编码用于重绘"],
    ["CLIP Text Encode (Prompt)", "CLIP 文本编码 (提示词)"],
    ["CLIPTextEncode", "CLIP 文本编码"],
    ["CLIPLoader", "加载 CLIP"],
    ["DualCLIPLoader", "加载双 CLIP"],
    ["TripleCLIPLoader", "加载三 CLIP"],
    ["QuadrupleCLIPLoader", "加载四 CLIP"],
    ["CLIPVisionLoader", "加载 CLIP Vision"],
    ["CLIPVisionEncode", "CLIP Vision 编码"],
    ["KSampler", "KSampler"],
    ["KSampler (Advanced)", "KSampler (高级)"],
    ["KSamplerAdvanced", "KSampler 高级"],
    ["KSamplerSelect", "选择 KSampler"],
    ["Empty Latent Image", "空 Latent 图像"],
    ["EmptyLatentImage", "空 Latent 图像"],
    ["Load Latent", "加载 Latent"],
    ["LoadLatent", "加载 Latent"],
    ["Save Latent", "保存 Latent"],
    ["Latent Upscale", "Latent 放大"],
    ["LatentUpscale", "Latent 放大"],
    ["LatentUpscaleBy", "Latent 按比例放大"],
    ["Repeat Latent Batch", "重复 Latent 批次"],
    ["Set Latent Noise Mask", "设置 Latent 噪声蒙版"],
    ["Load Image", "加载图像"],
    ["LoadImage", "加载图像"],
    ["LoadImageMask", "加载图像蒙版"],
    ["Save Image", "保存图像"],
    ["SaveImage", "保存图像"],
    ["Preview Image", "预览图像"],
    ["PreviewImage", "预览图像"],
    ["Image Scale", "图像缩放"],
    ["ImageScale", "图像缩放"],
    ["Image Scale By", "图像按比例缩放"],
    ["ImageScaleBy", "图像按比例缩放"],
    ["ImageInvert", "图像反相"],
    ["ImagePadForOutpaint", "图像外扩填充"],
    ["ImageCrop", "图像裁剪"],
    ["Crop Image", "裁剪图像"],
    ["Invert Mask", "反转蒙版"],
    ["MaskToImage", "蒙版转图像"],
    ["ImageToMask", "图像转蒙版"],
    ["Conditioning Combine", "条件合并"],
    ["ConditioningConcat", "条件拼接"],
    ["ConditioningSetArea", "设置条件区域"],
    ["ConditioningSetMask", "设置条件蒙版"],
    ["ConditioningAverage", "条件平均"],
    ["ControlNetLoader", "加载 ControlNet"],
    ["ControlNetApply", "应用 ControlNet"],
    ["ControlNetApplyAdvanced", "高级应用 ControlNet"],
    ["LoraLoader", "加载 LoRA"],
    ["LoraLoaderModelOnly", "仅模型加载 LoRA"],
    ["StyleModelLoader", "加载风格模型"],
    ["UpscaleModelLoader", "加载放大模型"],
    ["GLIGENLoader", "加载 GLIGEN"],
    ["HypernetworkLoader", "加载 Hypernetwork"],
]);

const PHRASE_TRANSLATIONS = new Map([
    ["ckpt_name", "Checkpoint 名称"],
    ["config_name", "配置名称"],
    ["vae_name", "VAE 名称"],
    ["clip_name", "CLIP 名称"],
    ["lora_name", "LoRA 名称"],
    ["control_net_name", "ControlNet 名称"],
    ["upscale_model_name", "放大模型名称"],
    ["sampler_name", "采样器名称"],
    ["batch_size", "批次数量"],
    ["batch_index", "批次索引"],
    ["start_at_step", "开始步数"],
    ["end_at_step", "结束步数"],
    ["return_with_leftover_noise", "返回剩余噪声"],
    ["add_noise", "添加噪声"],
    ["force_full_denoise", "强制完整降噪"],
    ["noise_seed", "噪声种子"],
    ["filename_prefix", "文件名前缀"],
    ["text_g", "全局文本"],
    ["text_l", "局部文本"],
    ["clip_width", "CLIP 宽度"],
    ["clip_height", "CLIP 高度"],
    ["crop_w", "裁剪宽度"],
    ["crop_h", "裁剪高度"],
    ["target_width", "目标宽度"],
    ["target_height", "目标高度"],
    ["source", "来源"],
    ["destination", "目标"],
    ["pixels", "像素图像"],
    ["samples", "Latent 样本"],
]);

const WORD_TRANSLATIONS = new Map([
    ["add", "添加"],
    ["advanced", "高级"],
    ["align", "对齐"],
    ["amount", "数量"],
    ["area", "区域"],
    ["audio", "音频"],
    ["average", "平均"],
    ["background", "背景"],
    ["batch", "批次"],
    ["blur", "模糊"],
    ["bottom", "底部"],
    ["brightness", "亮度"],
    ["cfg", "CFG"],
    ["checkpoint", "Checkpoint"],
    ["class", "类别"],
    ["clip", "CLIP"],
    ["color", "颜色"],
    ["combine", "合并"],
    ["conditioning", "条件"],
    ["config", "配置"],
    ["contrast", "对比度"],
    ["control", "控制"],
    ["controlnet", "ControlNet"],
    ["crop", "裁剪"],
    ["decode", "解码"],
    ["denoise", "降噪"],
    ["depth", "深度"],
    ["destination", "目标"],
    ["diffusion", "扩散"],
    ["disable", "禁用"],
    ["empty", "空"],
    ["encode", "编码"],
    ["end", "结束"],
    ["face", "人脸"],
    ["file", "文件"],
    ["filename", "文件名"],
    ["folder", "文件夹"],
    ["force", "强制"],
    ["frame", "帧"],
    ["full", "完整"],
    ["get", "获取"],
    ["gligen", "GLIGEN"],
    ["grow", "扩展"],
    ["height", "高度"],
    ["image", "图像"],
    ["images", "图像"],
    ["index", "索引"],
    ["input", "输入"],
    ["invert", "反转"],
    ["latent", "Latent"],
    ["left", "左"],
    ["load", "加载"],
    ["loader", "加载器"],
    ["lora", "LoRA"],
    ["mask", "蒙版"],
    ["max", "最大"],
    ["min", "最小"],
    ["model", "模型"],
    ["name", "名称"],
    ["negative", "负向"],
    ["noise", "噪声"],
    ["only", "仅"],
    ["output", "输出"],
    ["pad", "填充"],
    ["padding", "填充"],
    ["path", "路径"],
    ["pixels", "像素"],
    ["positive", "正向"],
    ["preview", "预览"],
    ["prompt", "提示词"],
    ["queue", "队列"],
    ["repeat", "重复"],
    ["right", "右"],
    ["sampler", "采样器"],
    ["samples", "样本"],
    ["save", "保存"],
    ["scale", "缩放"],
    ["scheduler", "调度器"],
    ["seed", "种子"],
    ["set", "设置"],
    ["size", "尺寸"],
    ["source", "来源"],
    ["start", "开始"],
    ["steps", "步数"],
    ["strength", "强度"],
    ["style", "风格"],
    ["text", "文本"],
    ["tile", "分块"],
    ["top", "顶部"],
    ["upscale", "放大"],
    ["vae", "VAE"],
    ["value", "值"],
    ["video", "视频"],
    ["vision", "视觉"],
    ["width", "宽度"],
]);

[
    ["Bool", "布尔"],
    ["Boolean", "布尔"],
    ["ColorCorrect", "颜色校正"],
    ["Color Correct", "颜色校正"],
    ["ImageColorMatch", "图像颜色匹配"],
    ["Image Color Match", "图像颜色匹配"],
].forEach(([key, value]) => EXACT_TRANSLATIONS.set(key, value));

[
    ["image_ref", "参考图像"],
    ["image_reference", "参考图像"],
    ["reference_image", "参考图像"],
    ["ref_image", "参考图像"],
    ["image_target", "目标图像"],
    ["target_image", "目标图像"],
    ["image_output", "图像输出"],
    ["output_image", "输出图像"],
    ["color_correct", "颜色校正"],
    ["color_match", "颜色匹配"],
    ["temporaloverlap", "时间重叠"],
    ["temporal_overlap", "时间重叠"],
    ["prependframes", "前置帧数"],
    ["prepend_frames", "前置帧数"],
    ["offloaddevice", "卸载设备"],
    ["offload_device", "卸载设备"],
    ["enabledebug", "启用调试"],
    ["enable_debug", "启用调试"],
    ["uniformbatchsize", "统一批次数量"],
    ["uniform_batch_size", "统一批次数量"],
    ["input_noise_scale", "输入噪声缩放"],
    ["latent_noise_scale", "Latent 噪声缩放"],
    ["torchcompileargs", "Torch 编译参数"],
    ["torch_compile_args", "Torch 编译参数"],
    ["blockstoswap", "交换块数"],
    ["blocks_to_swap", "交换块数"],
    ["swapiocomponents", "交换 I/O 组件"],
    ["swap_io_components", "交换 I/O 组件"],
    ["positions", "位置"],
    ["original", "原始"],
    ["grid", "网格"],
    ["original_size", "原始尺寸"],
    ["grid_size", "网格尺寸"],
    ["cache", "缓存"],
    ["cache_model", "缓存模型"],
    ["tiled", "分块"],
    ["encode_tiled", "编码分块"],
    ["decode_tiled", "解码分块"],
    ["sigmas", "Sigma 序列"],
    ["boolean", "布尔"],
    ["bool", "布尔"],
    ["multithread", "多线程"],
    ["multi_thread", "多线程"],
    ["load_dit_model", "加载 DiT 模型"],
    ["load_vae_model", "加载 VAE 模型"],
].forEach(([key, value]) => PHRASE_TRANSLATIONS.set(key, value));

[
    ["alpha", "透明度"],
    ["angle", "角度"],
    ["balance", "平衡"],
    ["beta", "Beta"],
    ["blend", "混合"],
    ["blocks", "块数"],
    ["bool", "布尔"],
    ["boolean", "布尔"],
    ["cache", "缓存"],
    ["channel", "通道"],
    ["channels", "通道"],
    ["count", "数量"],
    ["correct", "校正"],
    ["correction", "校正"],
    ["duration", "时长"],
    ["down", "下"],
    ["factor", "系数"],
    ["format", "格式"],
    ["fps", "帧率"],
    ["args", "参数"],
    ["compile", "编译"],
    ["debug", "调试"],
    ["device", "设备"],
    ["gamma", "伽马"],
    ["hide", "隐藏"],
    ["hue", "色相"],
    ["interpolation", "插值"],
    ["keep", "保持"],
    ["level", "级别"],
    ["loop", "循环"],
    ["multithread", "多线程"],
    ["method", "方法"],
    ["mode", "模式"],
    ["opacity", "不透明度"],
    ["offload", "卸载"],
    ["overlap", "重叠"],
    ["prepend", "前置"],
    ["positions", "位置"],
    ["quality", "质量"],
    ["radius", "半径"],
    ["ref", "参考"],
    ["reference", "参考"],
    ["rescale", "重新缩放"],
    ["resize", "调整尺寸"],
    ["resolution", "分辨率"],
    ["reverse", "反转"],
    ["rotate", "旋转"],
    ["saturation", "饱和度"],
    ["setting", "设置"],
    ["settings", "设置"],
    ["sharpen", "锐化"],
    ["smooth", "平滑"],
    ["target", "目标"],
    ["temperature", "色温"],
    ["threshold", "阈值"],
    ["tiled", "分块"],
    ["torch", "Torch"],
    ["uniform", "统一"],
    ["type", "类型"],
    ["upscaler", "放大器"],
    ["visible", "可见"],
].forEach(([key, value]) => WORD_TRANSLATIONS.set(key, value));

const VALUE_TRANSLATIONS = new Map([
    ["true", "是"],
    ["false", "否"],
    ["yes", "是"],
    ["no", "否"],
    ["on", "开"],
    ["off", "关"],
    ["enable", "启用"],
    ["disable", "禁用"],
    ["enabled", "已启用"],
    ["disabled", "已禁用"],
    ["default", "默认"],
    ["auto", "自动"],
    ["automatic", "自动"],
    ["manual", "手动"],
    ["none", "无"],
    ["null", "空"],
    ["cpu", "CPU"],
    ["cuda", "CUDA"],
    ["cuda:0", "CUDA:0"],
    ["cuda:1", "CUDA:1"],
    ["gpu", "GPU"],
    ["mps", "MPS"],
    ["bool", "布尔"],
    ["boolean", "布尔"],
    ["positions", "位置"],
    ["sigmas", "Sigma 序列"],
    ["fixed", "固定"],
    ["increment", "递增"],
    ["decrement", "递减"],
    ["randomize", "随机"],
    ["random", "随机"],
    ["hide", "隐藏"],
    ["preview", "预览"],
    ["save", "保存"],
    ["hide/save", "隐藏/保存"],
    ["show", "显示"],
    ["visible", "可见"],
    ["hidden", "隐藏"],
    ["left", "左"],
    ["right", "右"],
    ["top", "上"],
    ["bottom", "下"],
    ["center", "居中"],
    ["horizontal", "水平"],
    ["vertical", "垂直"],
    ["nearest", "最近邻"],
    ["nearest-exact", "最近邻精确"],
    ["bilinear", "双线性"],
    ["bicubic", "双三次"],
    ["lanczos", "Lanczos"],
    ["area", "面积"],
    ["linear", "线性"],
    ["cubic", "三次"],
    ["stretch", "拉伸"],
    ["crop", "裁剪"],
    ["pad", "填充"],
    ["fit", "适应"],
    ["fill", "填充"],
    ["cover", "覆盖"],
    ["contain", "包含"],
    ["normal", "正常"],
    ["multiply", "正片叠底"],
    ["screen", "滤色"],
    ["overlay", "叠加"],
    ["soft_light", "柔光"],
    ["hard_light", "强光"],
    ["difference", "差值"],
    ["add", "添加"],
    ["subtract", "减去"],
    ["wavelet", "小波"],
    ["gaussian", "高斯"],
    ["median", "中值"],
]);

const hasChinese = (value) => /[\u3400-\u9fff]/.test(String(value ?? ""));
const isProtectedTerm = (value) => PROTECTED_TERMS.has(String(value ?? ""));

function setting(id, fallback) {
    try {
        const value = app.extensionManager?.setting?.get?.(id);
        if (value !== undefined) return value;
    } catch (error) {
        console.warn("[GGTranslate] Unable to read extension setting:", id, error);
    }

    try {
        const value = app.ui?.settings?.getSettingValue?.(id, undefined);
        if (value !== undefined) return value;
    } catch {
        // Older ComfyUI builds may not expose the legacy setting accessor.
    }

    return fallback;
}

async function setSettingValue(id, value) {
    try {
        if (app.extensionManager?.setting?.set) {
            await app.extensionManager.setting.set(id, value);
            return;
        }
    } catch (error) {
        console.warn("[GGTranslate] Unable to write extension setting:", id, error);
    }

    try {
        app.ui?.settings?.setSettingValue?.(id, value);
    } catch (error) {
        console.warn("[GGTranslate] Unable to write UI setting:", id, error);
    }
}

function notify(summary, detail = "", severity = "success") {
    try {
        app.extensionManager?.toast?.add?.({ severity, summary, detail, life: 2200 });
        return;
    } catch {
        // Toast support is optional.
    }
    console.info(`[GGTranslate] ${summary}${detail ? `: ${detail}` : ""}`);
}

function splitEnglishText(value) {
    return String(value)
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/[_\-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function restoreProtectedPlaceholders(text, protectedValues) {
    return text.replace(/@@GGTERM(\d+)@@/g, (_, index) => protectedValues[Number(index)] ?? "");
}

function protectTerms(text) {
    const protectedValues = [];
    const pattern = new RegExp(`\\b(${[...PROTECTED_TERMS].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})\\b`, "g");
    const protectedText = String(text).replace(pattern, (match) => {
        protectedValues.push(match);
        return `@@GGTERM${protectedValues.length - 1}@@`;
    });
    return { protectedText, protectedValues };
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedPhraseKey(value) {
    return splitEnglishText(value).toLowerCase().replace(/\s+/g, "_");
}

function phraseTranslation(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return EXACT_TRANSLATIONS.get(text)
        || EXACT_TRANSLATIONS.get(splitEnglishText(text))
        || PHRASE_TRANSLATIONS.get(text)
        || PHRASE_TRANSLATIONS.get(text.toLowerCase())
        || PHRASE_TRANSLATIONS.get(normalizedPhraseKey(text))
        || "";
}

function translateToken(token) {
    if (!token) return "";
    if (/^@@GGTERM\d+@@$/.test(token)) return token;
    if (/^\d+(\.\d+)?$/.test(token)) return token;
    if (isProtectedTerm(token)) return token;
    return WORD_TRANSLATIONS.get(token.toLowerCase()) || token;
}

function translateByLongestPhrases(normalized) {
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const translated = [];

    for (let index = 0; index < tokens.length;) {
        let matched = "";
        let matchedLength = 0;
        const maxWindow = Math.min(6, tokens.length - index);

        for (let size = maxWindow; size >= 2; size--) {
            const candidate = tokens.slice(index, index + size).join(" ");
            const hit = phraseTranslation(candidate);
            if (hit) {
                matched = hit;
                matchedLength = size;
                break;
            }
        }

        if (matched) {
            translated.push(matched);
            index += matchedLength;
            continue;
        }

        translated.push(translateToken(tokens[index]));
        index += 1;
    }

    return translated.join("");
}

function translateEnglishSegment(value) {
    const text = String(value ?? "").trim();
    if (!text || hasChinese(text)) return text;
    if (isProtectedTerm(text)) return text;

    const phraseHit = phraseTranslation(text);
    if (phraseHit) return phraseHit;

    const { protectedText, protectedValues } = protectTerms(text);
    const normalized = splitEnglishText(protectedText);
    const normalizedPhrase = phraseTranslation(normalized);
    if (normalizedPhrase) return restoreProtectedPlaceholders(normalizedPhrase, protectedValues);

    const translated = translateByLongestPhrases(normalized);

    return restoreProtectedPlaceholders(translated, protectedValues)
        .replace(/\s+\)/g, ")")
        .replace(/\(\s+/g, "(")
        .replace(/\s+/g, " ")
        .trim();
}

function translateMixedText(value) {
    const text = String(value ?? "").trim();
    if (!text || !hasChinese(text) || !/[A-Za-z]/.test(text)) return value;

    return text.replace(/[A-Za-z][A-Za-z0-9_/-]*/g, (segment) => {
        const translated = translateEnglishSegment(segment);
        return translated && translated !== segment ? translated : segment;
    });
}

function translateText(value) {
    if (typeof value !== "string") return value;
    const text = value.trim();
    if (!text) return value;
    if (EXACT_TRANSLATIONS.has(text)) return EXACT_TRANSLATIONS.get(text);
    if (!/[A-Za-z]/.test(text)) return value;
    if (hasChinese(text)) return translateMixedText(text);
    if (!hasChinese(text)) return translateEnglishSegment(text);
    return value;
}

function rememberVisualTranslation(source, translated) {
    if (typeof source !== "string" || typeof translated !== "string") return;
    const key = source.trim();
    const value = translated.trim();
    if (!key || !value || key === value) return;
    VISUAL_TEXT_TRANSLATIONS.set(key, value);
}

function rememberTranslatedDisplay(source) {
    if (typeof source !== "string") return source;
    const translated = translateText(source);
    rememberVisualTranslation(source, translated);
    return translated;
}

function translateValueText(value) {
    const text = String(value ?? "").trim();
    if (!text || hasChinese(text)) return text;
    return VALUE_TRANSLATIONS.get(text) || VALUE_TRANSLATIONS.get(text.toLowerCase()) || "";
}

function shouldTranslateCanvasValue(text, x) {
    const value = translateValueText(text);
    if (!value) return false;
    if (String(text).length > 18) return false;
    return Number(x) >= 96 || /^(true|false|yes|no|on|off|enable|disable|enabled|disabled)$/i.test(String(text));
}

function patchDisplayValueRendering() {
    const proto = window.CanvasRenderingContext2D?.prototype;
    if (!proto || proto.__ggComfyTranslateFillTextPatched) return;

    const originalFillText = proto.fillText;
    proto.fillText = function (text, x, y, ...rest) {
        let displayText = text;
        try {
            if (isTranslateEnabled()) {
                displayText = VISUAL_TEXT_TRANSLATIONS.get(String(text).trim()) || text;
                if (displayText === text && shouldTranslateCanvasValue(text, x)) {
                    displayText = translateValueText(text) || text;
                }
            }
        } catch {
            displayText = text;
        }
        return originalFillText.call(this, displayText, x, y, ...rest);
    };
    proto.__ggComfyTranslateFillTextPatched = true;
}

function translateMenuElementText(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
    const tag = element.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable) return;
    if (element.children?.length) return;

    const original = element.dataset?.ggTranslateValueOriginal || element.textContent?.trim();
    if (!original) return;
    if (!isTranslateEnabled()) {
        if (element.dataset?.ggTranslateValueOriginal) {
            element.textContent = element.dataset.ggTranslateValueOriginal;
            delete element.dataset.ggTranslateValueOriginal;
        }
        return;
    }
    const translated = isTranslateEnabled() ? translateValueText(original) : "";
    if (!translated) return;

    element.dataset.ggTranslateValueOriginal = original;
    element.textContent = translated;
}

function translateOpenMenuValues(root = document.body) {
    if (!root?.querySelectorAll) return;
    const selectors = [
        ".litecontextmenu *",
        ".litemenu-entry",
        ".comfy-menu *",
        ".p-contextmenu *",
        ".p-menu *",
        "[role='menu'] *",
        "[role='listbox'] *",
    ];
    root.querySelectorAll(selectors.join(",")).forEach(translateMenuElementText);
}

let menuObserver = null;
function startMenuValueObserver() {
    if (menuObserver) return;
    menuObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            mutation.addedNodes?.forEach((node) => {
                if (node.nodeType !== Node.ELEMENT_NODE) return;
                translateMenuElementText(node);
                translateOpenMenuValues(node);
            });
        }
    });
    menuObserver.observe(document.body, { childList: true, subtree: true });
}

function ensureDefOriginal(nodeData) {
    if (!nodeData || nodeData[ORIGINAL_KEY]) return;
    nodeData[ORIGINAL_KEY] = {
        display_name: nodeData.display_name,
        title: nodeData.title,
        output_name: Array.isArray(nodeData.output_name) ? [...nodeData.output_name] : null,
        inputMeta: collectInputMeta(nodeData),
    };
}

function collectInputMeta(nodeData) {
    const result = [];
    const input = nodeData?.input || {};
    for (const groupName of ["required", "optional", "hidden"]) {
        const group = input[groupName] || {};
        for (const [name, value] of Object.entries(group)) {
            const options = Array.isArray(value) ? value[1] : null;
            if (!options || typeof options !== "object") continue;
            result.push({
                groupName,
                name,
                display_name: options.display_name,
                label: options.label,
            });
        }
    }
    return result;
}

function getReadonlyInputOptions(value) {
    if (!Array.isArray(value)) return null;
    const options = value[1];
    if (!options || typeof options !== "object" || Array.isArray(options)) return null;
    return options;
}

function inputDisplaySource(name, value) {
    const options = getReadonlyInputOptions(value);
    if (typeof options?.display_name === "string" && options.display_name.trim()) return options.display_name;
    if (typeof options?.label === "string" && options.label.trim()) return options.label;
    return name;
}

function rememberNodeDefVisualTranslations(nodeData, original = nodeData?.[ORIGINAL_KEY]) {
    const sourceTitle = original?.display_name || original?.title || nodeData?.name;
    rememberTranslatedDisplay(sourceTitle);
    if (original?.title) rememberTranslatedDisplay(original.title);
    (original?.output_name || []).forEach((name) => rememberTranslatedDisplay(name));

    const input = nodeData?.input || {};
    for (const groupName of ["required", "optional", "hidden"]) {
        const group = input[groupName] || {};
        for (const [name, value] of Object.entries(group)) {
            rememberTranslatedDisplay(name);
            rememberTranslatedDisplay(inputDisplaySource(name, value));
        }
    }
}

function buildTranslatedNameLookup(names = []) {
    const lookup = new Map();
    for (const name of names) {
        if (typeof name !== "string" || !name.trim()) continue;
        const translated = translateText(name);
        if (typeof translated === "string" && translated.trim() && translated !== name && !lookup.has(translated)) {
            lookup.set(translated, name);
        }
    }
    return lookup;
}

function buildTranslatedInputNameLookup(nodeData) {
    const lookup = new Map();
    const input = nodeData?.input || {};
    for (const groupName of ["required", "optional", "hidden"]) {
        const group = input[groupName] || {};
        for (const [name, value] of Object.entries(group)) {
            const sources = [name, inputDisplaySource(name, value)];
            for (const source of sources) {
                if (typeof source !== "string" || !source.trim()) continue;
                const translated = translateText(source);
                if (typeof translated === "string" && translated.trim() && translated !== source && !lookup.has(translated)) {
                    lookup.set(translated, name);
                }
            }
        }
    }
    return lookup;
}

function nodeDataForNode(node) {
    return node?.constructor?.nodeData || node?.nodeData || null;
}

function restoreTranslatedInternalNames(node) {
    const nodeData = nodeDataForNode(node);
    if (!node || !nodeData) return;
    ensureDefOriginal(nodeData);

    const inputLookup = buildTranslatedInputNameLookup(nodeData);
    for (const slot of node.inputs || []) {
        if (!slot || typeof slot.name !== "string") continue;
        const originalName = inputLookup.get(slot.name);
        if (originalName) slot.name = originalName;
    }

    for (const widget of node.widgets || []) {
        if (!widget || typeof widget.name !== "string") continue;
        const originalName = inputLookup.get(widget.name);
        if (originalName) widget.name = originalName;
    }

    const originalOutputNames = nodeData[ORIGINAL_KEY]?.output_name || [];
    const outputLookup = buildTranslatedNameLookup(originalOutputNames);
    for (const slot of node.outputs || []) {
        if (!slot || typeof slot.name !== "string") continue;
        const originalName = outputLookup.get(slot.name);
        if (originalName) slot.name = originalName;
    }
}

function applyNodeDefTranslation(nodeData, enabled = isTranslateEnabled()) {
    if (!nodeData) return;
    NODE_DEFS.add(nodeData);
    ensureDefOriginal(nodeData);
    const original = nodeData[ORIGINAL_KEY];

    if (!enabled) {
        nodeData.display_name = original.display_name;
        nodeData.title = original.title;
        if (original.output_name) nodeData.output_name = [...original.output_name];
        restoreInputMeta(nodeData, original.inputMeta);
        return;
    }

    const sourceTitle = original.display_name || original.title || nodeData.name;
    if (sourceTitle) nodeData.display_name = translateText(sourceTitle);
    if (original.title) nodeData.title = translateText(original.title);
    if (original.output_name) nodeData.output_name = [...original.output_name];
    restoreInputMeta(nodeData, original.inputMeta);
    rememberNodeDefVisualTranslations(nodeData, original);
}

function restoreInputMeta(nodeData, inputMeta = []) {
    for (const meta of inputMeta) {
        const options = getInputOptions(nodeData, meta.groupName, meta.name);
        if (!options) continue;
        if (meta.display_name === undefined) delete options.display_name;
        else options.display_name = meta.display_name;
        if (meta.label === undefined) delete options.label;
        else options.label = meta.label;
    }
}

function getInputOptions(nodeData, groupName, name) {
    const item = nodeData?.input?.[groupName]?.[name];
    if (!Array.isArray(item)) return null;
    if (!item[1] || typeof item[1] !== "object" || Array.isArray(item[1])) item[1] = {};
    return item[1];
}

function originalNodeTitle(node) {
    const nodeData = nodeDataForNode(node);
    const originalDef = nodeData?.[ORIGINAL_KEY];
    const defaultTitle = originalDef?.display_name || originalDef?.title || nodeData?.name || node?.comfyClass || node?.type;
    if (typeof defaultTitle !== "string" || !defaultTitle.trim()) return node?.title;

    const translatedTitle = translateText(defaultTitle);
    if (node?.title === translatedTitle || node?.title === nodeData?.display_name || node?.title === nodeData?.title) {
        return defaultTitle;
    }
    return node?.title;
}

function ensureNodeOriginal(node) {
    if (!node || node[ORIGINAL_KEY]) return;
    node[ORIGINAL_KEY] = {
        title: originalNodeTitle(node),
        inputs: (node.inputs || []).map((slot) => slot?.name),
        inputLabels: (node.inputs || []).map((slot) => slot?.label),
        outputs: (node.outputs || []).map((slot) => slot?.name),
        outputLabels: (node.outputs || []).map((slot) => slot?.label),
        widgets: (node.widgets || []).map((widget) => widget?.name),
        widgetLabels: (node.widgets || []).map((widget) => widget?.label),
    };
}

function displaySource(label, name) {
    if (typeof label === "string" && label.trim()) return label;
    return name;
}

function applyNodeTranslation(node, enabled = isTranslateEnabled()) {
    if (!node) return;
    restoreTranslatedInternalNames(node);
    ensureNodeOriginal(node);
    if (!enabled) {
        restoreNodeTranslation(node);
        return;
    }

    const original = node[ORIGINAL_KEY];
    if (typeof original.title === "string") {
        node.title = translateText(original.title);
    } else if (typeof node.title === "string") {
        node.title = translateText(node.title);
    }

    (node.inputs || []).forEach((slot, index) => {
        if (!slot) return;
        const source = displaySource(original.inputLabels[index], original.inputs[index] ?? slot.name);
        const translated = translateText(source);
        slot.label = translated;
        rememberVisualTranslation(original.inputs[index] ?? slot.name, translated);
        rememberVisualTranslation(source, translated);
    });

    (node.outputs || []).forEach((slot, index) => {
        if (!slot) return;
        const source = displaySource(original.outputLabels[index], original.outputs[index] ?? slot.name);
        const translated = translateText(source);
        slot.label = translated;
        rememberVisualTranslation(original.outputs[index] ?? slot.name, translated);
        rememberVisualTranslation(source, translated);
    });

    (node.widgets || []).forEach((widget, index) => {
        if (!widget) return;
        const source = displaySource(original.widgetLabels[index], original.widgets[index] ?? widget.name);
        const translated = translateText(source);
        widget.label = translated;
        rememberVisualTranslation(original.widgets[index] ?? widget.name, translated);
        rememberVisualTranslation(source, translated);
    });

    node.setDirtyCanvas?.(true, true);
}

function restoreNodeTranslation(node) {
    const original = node?.[ORIGINAL_KEY];
    if (!node || !original) return;

    node.title = original.title;
    (node.inputs || []).forEach((slot, index) => {
        if (!slot) return;
        if (original.inputs[index] !== undefined) slot.name = original.inputs[index];
        if (original.inputLabels[index] === undefined) delete slot.label;
        else slot.label = original.inputLabels[index];
    });
    (node.outputs || []).forEach((slot, index) => {
        if (!slot) return;
        if (original.outputs[index] !== undefined) slot.name = original.outputs[index];
        if (original.outputLabels[index] === undefined) delete slot.label;
        else slot.label = original.outputLabels[index];
    });
    (node.widgets || []).forEach((widget, index) => {
        if (!widget) return;
        if (original.widgets[index] !== undefined) widget.name = original.widgets[index];
        if (original.widgetLabels[index] === undefined) delete widget.label;
        else widget.label = original.widgetLabels[index];
    });
    node.setDirtyCanvas?.(true, true);
}

function graphNodes() {
    const graph = app.graph || app.canvas?.graph;
    return graph?._nodes || graph?.nodes || [];
}

function isTranslateEnabled() {
    return setting(SETTINGS.enabled, false) === true;
}

function markDirty() {
    app.canvas?.setDirty?.(true, true);
    app.canvas?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

function applyAllTranslations(enabled = isTranslateEnabled()) {
    for (const nodeData of NODE_DEFS) applyNodeDefTranslation(nodeData, enabled);
    for (const node of graphNodes()) applyNodeTranslation(node, enabled);
    markDirty();
    syncTopControls();
}

function restoreAllTranslations() {
    for (const node of graphNodes()) restoreNodeTranslation(node);
    markDirty();
}

function withOriginalLabels(callback) {
    const enabled = isTranslateEnabled();
    if (enabled) restoreAllTranslations();
    let reapplyScheduled = false;
    let waitsForPromise = false;
    const scheduleReapply = () => {
        if (!enabled || reapplyScheduled) return;
        reapplyScheduled = true;
        requestAnimationFrame(() => applyAllTranslations(true));
    };
    try {
        const result = callback();
        if (result && typeof result.then === "function") {
            waitsForPromise = true;
            return result.finally(scheduleReapply);
        }
        return result;
    } finally {
        if (!waitsForPromise) scheduleReapply();
    }
}

function patchSerialization() {
    if (!app[PATCHED_KEY]?.graphToPrompt && typeof app.graphToPrompt === "function") {
        const original = app.graphToPrompt;
        app.graphToPrompt = function (...args) {
            return withOriginalLabels(() => original.apply(this, args));
        };
        app[PATCHED_KEY] = { ...(app[PATCHED_KEY] || {}), graphToPrompt: true };
    }

    const graph = app.graph || app.canvas?.graph;
    if (graph && !graph[PATCHED_KEY] && typeof graph.serialize === "function") {
        const originalSerialize = graph.serialize;
        graph.serialize = function (...args) {
            return withOriginalLabels(() => originalSerialize.apply(this, args));
        };
        graph[PATCHED_KEY] = true;
    }
}

function patchNodeType(nodeType) {
    if (!nodeType?.prototype || nodeType.prototype[PATCHED_KEY]) return;
    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
        const result = originalOnNodeCreated?.apply(this, args);
        requestAnimationFrame(() => applyNodeTranslation(this));
        return result;
    };
    nodeType.prototype[PATCHED_KEY] = true;
}

let topControls = null;
let quickTimer = null;

function createTopButton(title, icon, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "comfyui-button gg-ui-top-button gg-comfy-translate-btn";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.innerHTML = ggIcon(icon, 18);
    button.addEventListener("click", action);
    return button;
}

function installTopControlStyles() {
    if (document.getElementById("gg-comfy-translate-style")) return;
    const style = document.createElement("style");
    style.id = "gg-comfy-translate-style";
    style.textContent = `
        #gg-comfy-translate-buttons {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            height: 34px;
            flex: 0 0 auto;
        }
        #gg-comfy-translate-buttons.gg-translate-menu-host,
        #gg-comfy-translate-buttons.gg-translate-legacy-host {
            position: static;
            margin-inline: 2px;
            z-index: auto;
        }
        #gg-comfy-translate-buttons.gg-translate-floating-host {
            position: fixed;
            top: 18px;
            right: clamp(252px, calc(25vw + 136px), 640px);
            z-index: 99999;
        }
        #gg-comfy-translate-buttons.gg-translate-hidden {
            display: none !important;
        }
        #gg-comfy-translate-buttons .gg-comfy-translate-btn {
            width: 34px;
            height: 34px;
            min-width: 34px;
            max-width: 34px;
            padding: 0 !important;
            margin: 0 !important;
            border-radius: 8px;
            border: 1px solid var(--gg-ui-accent-border) !important;
            background: var(--gg-ui-accent-soft) !important;
            color: var(--gg-ui-accent) !important;
            box-shadow: none !important;
            appearance: none;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            box-sizing: border-box;
            line-height: 0 !important;
            cursor: pointer;
            overflow: hidden;
            transition: transform 0.16s ease, background 0.16s ease, border-color 0.16s ease, color 0.16s ease, opacity 0.16s ease;
        }
        #gg-comfy-translate-buttons .gg-comfy-translate-btn:hover,
        #gg-comfy-translate-buttons .gg-comfy-translate-btn:focus-visible,
        #gg-comfy-translate-buttons .gg-comfy-translate-btn.active {
            color: var(--gg-ui-accent) !important;
            background: rgba(59, 130, 246, 0.17) !important;
            border-color: var(--gg-ui-accent-border) !important;
            transform: scale(1.08);
        }
        #gg-comfy-translate-buttons .gg-comfy-translate-btn .gg-ui-icon {
            width: 18px;
            height: 18px;
            margin: 0;
            flex: 0 0 auto;
            pointer-events: none;
        }
    `;
    document.head.appendChild(style);
}

async function setupTopControls() {
    if (topControls) return;

    let ComfyButtonGroup;
    try {
        ({ ComfyButtonGroup } = await import("../../scripts/ui/components/buttonGroup.js"));
    } catch (error) {
        console.warn("[GGTranslate] Comfy button group unavailable, using fallback host.", error);
    }

    installTopControlStyles();

    const toggleButton = createTopButton("开启 ComfyUI 中文翻译", "floatingText", async () => {
        const next = !isTranslateEnabled();
        await setSettingValue(SETTINGS.enabled, next);
        onTranslateSettingChanged(next);
        notify(next ? "ComfyUI 中文翻译已开启" : "ComfyUI 中文翻译已关闭");
    });

    const groupEl = ComfyButtonGroup ? new ComfyButtonGroup().element : document.createElement("div");
    groupEl.id = "gg-comfy-translate-buttons";
    groupEl.classList.add("gg-comfy-translate-host");
    groupEl.append(toggleButton);
    topControls = { groupEl, toggleButton };

    const placeGroup = () => {
        groupEl.classList.remove("gg-translate-menu-host", "gg-translate-legacy-host", "gg-translate-floating-host");

        const settingsGroup = app.menu?.settingsGroup?.element;
        if (settingsGroup?.parentElement) {
            settingsGroup.before(groupEl);
            groupEl.classList.add("gg-translate-menu-host");
            return true;
        }

        const linkButtons = document.getElementById("gg-link-style-buttons");
        if (linkButtons?.parentElement && !linkButtons.classList.contains("gg-link-floating-host")) {
            linkButtons.insertAdjacentElement("afterend", groupEl);
            groupEl.classList.add("gg-translate-legacy-host");
            return true;
        }

        const memoryButtons = document.getElementById("gg-memory-cleanup-buttons");
        if (memoryButtons?.parentElement && !memoryButtons.classList.contains("gg-memory-floating-host")) {
            memoryButtons.insertAdjacentElement("afterend", groupEl);
            groupEl.classList.add("gg-translate-legacy-host");
            return true;
        }

        const queueButton = document.getElementById("queue-button");
        if (queueButton?.parentElement) {
            queueButton.insertAdjacentElement("afterend", groupEl);
            groupEl.classList.add("gg-translate-legacy-host");
            return true;
        }

        if (groupEl.parentElement !== document.body) document.body.appendChild(groupEl);
        groupEl.classList.add("gg-translate-floating-host");
        return false;
    };

    const applyVisibility = (enabled) => {
        const isVisible = enabled !== false;
        placeGroup();
        groupEl.classList.toggle("gg-translate-hidden", !isVisible);
        groupEl.style.display = isVisible ? "inline-flex" : "none";
        syncTopControls();
    };

    window.__ggApplyComfyTranslateButtons = applyVisibility;

    const refreshVisibility = () => applyVisibility(setting(SETTINGS.topButton, true));
    refreshVisibility();

    let attempts = 0;
    const timer = setInterval(() => {
        attempts += 1;
        const placed = placeGroup();
        refreshVisibility();
        if (placed || attempts >= 10) clearInterval(timer);
    }, 500);

    try {
        app.ui?.settings?.addEventListener?.(`${SETTINGS.menuDisplay}.change`, () => {
            requestAnimationFrame(refreshVisibility);
        });
    } catch {
        // Older ComfyUI builds may not expose this settings event.
    }
}

function syncTopControls() {
    if (!topControls) return;
    const enabled = isTranslateEnabled();
    const title = enabled ? "关闭 ComfyUI 中文翻译" : "开启 ComfyUI 中文翻译";
    topControls.toggleButton.classList.toggle("active", enabled);
    topControls.toggleButton.title = title;
    topControls.toggleButton.setAttribute("aria-label", title);
}

function onTranslateSettingChanged(value) {
    applyAllTranslations(value === true);
    patchSerialization();
    translateOpenMenuValues();
    markDirty();
}

function scheduleApply() {
    clearTimeout(quickTimer);
    quickTimer = setTimeout(() => {
        patchSerialization();
        patchDisplayValueRendering();
        startMenuValueObserver();
        applyAllTranslations();
        translateOpenMenuValues();
    }, 80);
}

app.registerExtension({
    name: "ComfyUI.GuliNodes.ComfyTranslate",

    async addCustomNodeDefs(defs) {
        for (const nodeData of Object.values(defs || {})) applyNodeDefTranslation(nodeData);
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        applyNodeDefTranslation(nodeData);
        patchNodeType(nodeType);
    },

    nodeCreated(node) {
        applyNodeTranslation(node);
    },

    loadedGraphNode(node) {
        applyNodeTranslation(node);
    },

    async afterConfigureGraph() {
        scheduleApply();
    },

    async setup() {
        await setupTopControls();
        patchSerialization();
        patchDisplayValueRendering();
        startMenuValueObserver();
        scheduleApply();
    },

    settings: [
        {
            id: SETTINGS.enabled,
            category: ["GuliNodes", "ComfyUI 中文翻译"],
            name: "节点/参数中文翻译",
            type: "boolean",
            defaultValue: false,
            tooltip: "开启后翻译节点标题、输入/输出槽和 widget 参数名；VAE、CLIP、LoRA、KSampler 等专有名词会保留英文，内部参数名保持原文以避免影响连接。",
            onChange: onTranslateSettingChanged,
        },
        {
            id: SETTINGS.topButton,
            category: ["GuliNodes", "ComfyUI 中文翻译"],
            name: "顶部翻译按钮",
            type: "boolean",
            defaultValue: true,
            tooltip: "是否在 ComfyUI 顶部菜单区显示中文翻译快捷按钮。",
            onChange: (value) => window.__ggApplyComfyTranslateButtons?.(value),
        },
    ],
});
