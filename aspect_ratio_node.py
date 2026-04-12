import torch
import torch.nn.functional as torch_F
import random
from datetime import datetime
from nodes import PreviewImage
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import cv2
import comfy.utils
import comfy.sd
import folder_paths

# Global last seed for "use previous" mode
_last_seed = 1

# Random seed state
initial_random_state = random.getstate()
random.seed(datetime.now().timestamp())
_gg_seed_random_state = random.getstate()
random.setstate(initial_random_state)

ASPECT_RATIOS = ["1:1", "3:2", "4:3", "5:4", "16:9", "21:9", "9:16", "2:3", "3:4", "4:5", "9:21"]
ASPECT_PRESETS = {"1:1": (1,1), "3:2":(3,2), "4:3":(4,3), "5:4":(5,4), "16:9":(16,9), 
                  "21:9":(21,9), "9:16":(9,16), "2:3":(2,3), "3:4":(3,4), "4:5":(4,5), "9:21":(9,21)}
SIDE_TYPES = ["最长边", "最短边"]

def concatenate_images_horizontally(images, labels=None, font_size=40, border=32, label_height=80, spacing=20):
    if not images:
        return None
    target_height = images[0].shape[1]
    resized = []
    for img in images:
        if img.shape[1] != target_height:
            img_ch = img.permute(0, 3, 1, 2).contiguous()
            img_resized = torch_F.interpolate(img_ch, size=(target_height, int(img.shape[2] * target_height / img.shape[1])), mode="bilinear", align_corners=False, antialias=True)
            img = img_resized.permute(0, 2, 3, 1).contiguous()
        resized.append(img)
    if spacing > 0:
        gap = torch.ones((1, target_height, spacing, 3), dtype=torch.float32, device=images[0].device)
        final_list = []
        for i, img in enumerate(resized):
            final_list.append(img)
            if i < len(resized) - 1:
                final_list.append(gap)
        concat_image = torch.cat(final_list, dim=2)
    else:
        concat_image = torch.cat(resized, dim=2)
    if not labels or len(labels) == 0:
        return concat_image
    B, H, W, C = concat_image.shape
    np_img = (concat_image[0] * 255).clamp(0, 255).to(torch.uint8).cpu().numpy()
    pil_img = Image.fromarray(np_img)
    new_img = Image.new("RGB", (W, H + label_height), (255, 255, 255))
    new_img.paste(pil_img, (0, 0))
    draw = ImageDraw.Draw(new_img)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", font_size)
    except:
        font = ImageFont.load_default()
    sub_width = W // len(labels)
    for i, text in enumerate(labels):
        x = i * sub_width + sub_width // 2
        draw.text((x, H + label_height//2), text, fill=(255,255,255), font=font, anchor="mm", stroke_width=4, stroke_fill=(255,255,255))
        draw.text((x, H + label_height//2), text, fill=(0,0,0), font=font, anchor="mm")
    final_np = np.array(new_img).astype(np.float32) / 255.0
    return torch.from_numpy(final_np).unsqueeze(0)


class AspectRatioAdapter:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "aspect_ratio": (ASPECT_RATIOS, {"default": "16:9"}),
                "side_length": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "side_type": (SIDE_TYPES, {"default": "最长边"}),
            }
        }
    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    FUNCTION = "calculate"
    CATEGORY = "GuliNodes/尺寸工具"

    def calculate(self, aspect_ratio, side_length, side_type):
        wr, hr = ASPECT_PRESETS[aspect_ratio]
        if side_type == "最长边":
            width = side_length if wr > hr else int(side_length * wr / hr)
            height = int(side_length * hr / wr) if wr > hr else side_length
        else:
            height = side_length if wr > hr else int(side_length * hr / wr)
            width = int(side_length * wr / hr) if wr > hr else side_length
        width = (width // 8) * 8
        height = (height // 8) * 8
        return (width, height)


class AspectRatioLatent:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "aspect_ratio": (ASPECT_RATIOS, {"default": "16:9"}),
                "side_length": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "side_type": (SIDE_TYPES, {"default": "最长边"}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 64}),
            }
        }
    RETURN_TYPES = ("LATENT",)
    FUNCTION = "generate"
    CATEGORY = "GuliNodes/尺寸工具"

    def generate(self, aspect_ratio, side_length, side_type, batch_size):
        adapter = AspectRatioAdapter()
        width, height = adapter.calculate(aspect_ratio, side_length, side_type)
        latent = torch.zeros([batch_size, 4, height // 8, width // 8])
        return ({"samples": latent},)


class GGImageToLatent(AspectRatioLatent):
    @classmethod
    def INPUT_TYPES(s):
        base = AspectRatioLatent.INPUT_TYPES()
        base["optional"] = base["required"]
        base["required"] = {
            "mode": (["手动", "参考图像"], {"default": "手动"}),
        }
        base["optional"]["image"] = ("IMAGE",)
        return base
    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "convert"
    CATEGORY = "GuliNodes/尺寸工具"

    def convert(self, mode="手动", aspect_ratio="16:9", side_length=1024, side_type="最长边", batch_size=1, image=None):
        if mode == "参考图像" and image is not None:
            # Get image dimensions from input image
            if len(image.shape) == 4:
                h, w = image.shape[1], image.shape[2]
            else:
                h, w = image.shape[0], image.shape[1]
        else:
            # Use manual settings like AspectRatioLatent
            adapter = AspectRatioAdapter()
            width, height = adapter.calculate(aspect_ratio, side_length, side_type)
            return ({"samples": torch.zeros([batch_size, 4, height // 8, width // 8])},)
        
        # Create latent with image dimensions
        latent = torch.zeros([batch_size, 4, h // 8, w // 8])
        return ({"samples": latent},)


class GGRGBAtoRGB:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "convert"
    CATEGORY = "GuliNodes/图像工具"

    def convert(self, image):
        if image is None:
            return (torch.zeros([1, 64, 64, 3]),)
        # Check if image has alpha channel (RGBA)
        if image.shape[-1] == 4:
            # Remove alpha channel, keep only RGB
            rgb_image = image[..., :3]
            return (rgb_image,)
        # Already RGB
        return (image,)


COLOR_GRADE_PRESETS = {
    "清新_氧气感": "fresh_oxygen",
    "清新_薄荷感": "fresh_mint",
    "清新_森林系": "fresh_forest",
    "复古_电影卷": "film_cinema",
    "复古_过期卷": "film_expired",
    "复古_赛博朋克": "film_cyber",
    "日韩_奶油肌": "jk_cream",
    "日韩_氧气少女": "jk_girl",
    "日韩_韩系通透": "jk_korean",
    "高级_肖像": "premium_portrait",
    "高级_商业": "premium_commercial",
    "高级_大片感": "premium_blockbuster",
    "港风_霓虹灯": "hk_neon",
    "港风_王家卫": "hk_wkw",
    "港风_打字机": "hk_typewriter",
    "氛围_情绪": "niche_mood",
    "氛围_暗黑": "niche_dark",
    "氛围_梦幻": "niche_dreamy",
    "国风_水墨": "cn_ink",
    "国风_丹青": "cn_danqing",
    "国风_复古红": "cn_retro_red",
}

# Placeholder - will be populated after function definitions
_COLOR_GRADE_FUNCS = {}

def _adjust_contrast(img, factor):
    return np.clip((img - 128) * factor + 128, 0, 255).astype(np.uint8)

def _adjust_saturation(img, factor):
    gray = np.dot(img[...,:3], [0.299, 0.587, 0.114])[..., np.newaxis]
    return np.clip(gray + (img - gray) * factor, 0, 255).astype(np.uint8)

def _adjust_temperature(img, kelvin):
    result = img.astype(np.float32)
    if kelvin > 0:
        result[:,:,2] *= (1 + kelvin/100)
    else:
        result[:,:,0] *= (1 - kelvin/100)
    return np.clip(result, 0, 255).astype(np.uint8)

def _fresh_oxygen(img):
    r, g, b = img[:,:,0], img[:,:,1], img[:,:,2]
    r = np.clip(r * 1.05 + 5, 0, 255).astype(np.uint8)
    g = np.clip(g * 1.1 + 8, 0, 255).astype(np.uint8)
    b = np.clip(b * 1.05 + 3, 0, 255).astype(np.uint8)
    result = np.stack([r, g, b], axis=2)
    return _adjust_contrast(result, 0.95)

def _fresh_mint(img):
    r, g, b = img[:,:,0], img[:,:,1], img[:,:,2]
    r = np.clip(r * 0.95, 0, 255).astype(np.uint8)
    g = np.clip(g * 1.15 + 10, 0, 255).astype(np.uint8)
    b = np.clip(b * 1.1 + 5, 0, 255).astype(np.uint8)
    result = np.stack([r, g, b], axis=2)
    return _adjust_contrast(result, 1.05)

def _fresh_forest(img):
    r, g, b = img[:,:,0], img[:,:,1], img[:,:,2]
    r = np.clip(r * 0.9, 0, 255).astype(np.uint8)
    g = np.clip(g * 1.2 + 5, 0, 255).astype(np.uint8)
    b = np.clip(b * 0.95, 0, 255).astype(np.uint8)
    result = np.stack([r, g, b], axis=2)
    return _adjust_contrast(result, 1.1)

def _film_cinema(img):
    result = _adjust_contrast(img, 1.15)
    r, g, b = result[:,:,0], result[:,:,1], result[:,:,2]
    r = np.clip(r * 1.05, 0, 255).astype(np.uint8)
    b = np.clip(b * 0.9, 0, 255).astype(np.uint8)
    return np.stack([r, g, b], axis=2)

def _film_expired(img):
    result = img.astype(np.float32)
    result = result * 0.85 + 35
    result[:,:,0] *= 1.1
    result[:,:,2] *= 0.8
    result = np.clip(result, 0, 255).astype(np.uint8)
    return _adjust_saturation(result, 0.7)

def _film_cyber(img):
    result = _adjust_contrast(img, 1.3)
    r, g, b = result[:,:,0], result[:,:,1], result[:,:,2]
    r = np.clip(r * 1.2, 0, 255).astype(np.uint8)
    g = np.clip(g * 0.9, 0, 255).astype(np.uint8)
    b = np.clip(b * 1.1, 0, 255).astype(np.uint8)
    return np.stack([r, g, b], axis=2)

def _jk_cream(img):
    result = img.astype(np.float32)
    result = result * 0.9 + 50
    result[:,:,0] *= 1.05
    result[:,:,1] *= 1.1
    result[:,:,2] *= 1.15
    return np.clip(result * 1.05, 0, 255).astype(np.uint8)

def _jk_girl(img):
    result = img.astype(np.float32)
    result = result * 0.95 + 40
    result[:,:,0] *= 1.1
    result[:,:,2] *= 0.9
    return np.clip(result, 0, 255).astype(np.uint8)

def _jk_korean(img):
    result = img.astype(np.float32)
    result = result * 0.92 + 45
    result[:,:,0] *= 1.0
    result[:,:,1] *= 1.12
    result[:,:,2] *= 1.08
    return np.clip(result, 0, 255).astype(np.uint8)

def _premium_portrait(img):
    result = img.astype(np.float32)
    result = result * 0.95 + 25
    result[:,:,1] *= 1.05
    return _adjust_contrast(np.clip(result, 0, 255).astype(np.uint8), 1.1)

def _premium_commercial(img):
    result = _adjust_contrast(img, 1.2)
    r, g, b = result[:,:,0], result[:,:,1], result[:,:,2]
    r = np.clip(r * 1.05, 0, 255).astype(np.uint8)
    g = np.clip(g * 1.0, 0, 255).astype(np.uint8)
    b = np.clip(b * 0.95, 0, 255).astype(np.uint8)
    return np.stack([r, g, b], axis=2)

def _premium_blockbuster(img):
    result = _adjust_contrast(img, 1.25)
    r, g, b = result[:,:,0], result[:,:,1], result[:,:,2]
    r = np.clip(r * 1.1, 0, 255).astype(np.uint8)
    b = np.clip(b * 0.9, 0, 255).astype(np.uint8)
    return np.stack([r, g, b], axis=2)

def _hk_neon(img):
    result = _adjust_contrast(img, 1.15)
    r, g, b = result[:,:,0], result[:,:,1], result[:,:,2]
    r = np.clip(r * 1.25, 0, 255).astype(np.uint8)
    g = np.clip(g * 0.95, 0, 255).astype(np.uint8)
    b = np.clip(b * 1.15, 0, 255).astype(np.uint8)
    return np.stack([r, g, b], axis=2)

def _hk_wkw(img):
    result = _adjust_contrast(img, 1.1)
    r, g, b = result[:,:,0], result[:,:,1], result[:,:,2]
    r = np.clip(r * 0.9 + 20, 0, 255).astype(np.uint8)
    g = np.clip(g * 0.85 + 15, 0, 255).astype(np.uint8)
    b = np.clip(b * 0.7, 0, 255).astype(np.uint8)
    return np.stack([r, g, b], axis=2)

def _hk_typewriter(img):
    result = img.astype(np.float32)
    result = result * 0.85 + 30
    gray = np.dot(result[...,:3], [0.299, 0.587, 0.114])
    result[...,0] = gray * 1.05
    result[...,1] = gray * 1.0
    result[...,2] = gray * 0.85
    return _adjust_contrast(np.clip(result, 0, 255).astype(np.uint8), 1.15)

def _niche_mood(img):
    result = img.astype(np.float32)
    result = result * 0.85 + 20
    result[:,:,0] *= 1.1
    result[:,:,2] *= 0.85
    return _adjust_contrast(np.clip(result, 0, 255).astype(np.uint8), 1.1)

def _niche_dark(img):
    result = img.astype(np.float32)
    result = result * 0.75 + 15
    result[:,:,0] *= 1.05
    result[:,:,2] *= 0.9
    return _adjust_contrast(np.clip(result, 0, 255).astype(np.uint8), 1.2)

def _niche_dreamy(img):
    result = img.astype(np.float32)
    result = result * 0.95 + 35
    result[:,:,0] *= 1.15
    result[:,:,1] *= 1.1
    result[:,:,2] *= 1.2
    return np.clip(result * 0.95, 0, 255).astype(np.uint8)

def _cn_ink(img):
    result = img.astype(np.float32)
    gray = np.dot(result[...,:3], [0.299, 0.587, 0.114])
    result[...,0] = gray * 0.9
    result[...,1] = gray * 0.95
    result[...,2] = gray * 0.85
    return _adjust_contrast(np.clip(result, 0, 255).astype(np.uint8), 1.05)

def _cn_danqing(img):
    result = img.astype(np.float32)
    result = result * 0.9 + 25
    result[:,:,0] *= 0.85
    result[:,:,1] *= 1.05
    result[:,:,2] *= 0.95
    return np.clip(result, 0, 255).astype(np.uint8)

def _cn_retro_red(img):
    result = img.astype(np.float32)
    result = result * 0.9 + 30
    result[:,:,0] *= 1.25
    result[:,:,1] *= 0.9
    result[:,:,2] *= 0.8
    return _adjust_contrast(np.clip(result, 0, 255).astype(np.uint8), 1.05)


# Populate the actual functions after all are defined
COLOR_GRADE_FUNCS = {
    "fresh_oxygen": _fresh_oxygen,
    "fresh_mint": _fresh_mint,
    "fresh_forest": _fresh_forest,
    "film_cinema": _film_cinema,
    "film_expired": _film_expired,
    "film_cyber": _film_cyber,
    "jk_cream": _jk_cream,
    "jk_girl": _jk_girl,
    "jk_korean": _jk_korean,
    "premium_portrait": _premium_portrait,
    "premium_commercial": _premium_commercial,
    "premium_blockbuster": _premium_blockbuster,
    "hk_neon": _hk_neon,
    "hk_wkw": _hk_wkw,
    "hk_typewriter": _hk_typewriter,
    "niche_mood": _niche_mood,
    "niche_dark": _niche_dark,
    "niche_dreamy": _niche_dreamy,
    "cn_ink": _cn_ink,
    "cn_danqing": _cn_danqing,
    "cn_retro_red": _cn_retro_red,
}

# Also update the reference dictionary used by GGColorGrade
# COLOR_GRADE_FUNCS is already populated above, sync it to _COLOR_GRADE_FUNCS
_COLOR_GRADE_FUNCS.update({
    "fresh_oxygen": _fresh_oxygen,
    "fresh_mint": _fresh_mint,
    "fresh_forest": _fresh_forest,
    "film_cinema": _film_cinema,
    "film_expired": _film_expired,
    "film_cyber": _film_cyber,
    "jk_cream": _jk_cream,
    "jk_girl": _jk_girl,
    "jk_korean": _jk_korean,
    "premium_portrait": _premium_portrait,
    "premium_commercial": _premium_commercial,
    "premium_blockbuster": _premium_blockbuster,
    "hk_neon": _hk_neon,
    "hk_wkw": _hk_wkw,
    "hk_typewriter": _hk_typewriter,
    "niche_mood": _niche_mood,
    "niche_dark": _niche_dark,
    "niche_dreamy": _niche_dreamy,
    "cn_ink": _cn_ink,
    "cn_danqing": _cn_danqing,
    "cn_retro_red": _cn_retro_red,
})


class GGColorGrade:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "preset": (list(COLOR_GRADE_PRESETS.keys()), {"default": "清新_氧气感"}),
            },
            "optional": {
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.01}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "apply"
    CATEGORY = "GuliNodes/图像工具"

    def apply(self, image, preset="清新_氧气感", strength=1.0):
        if image is None:
            return (torch.zeros([1, 64, 64, 3]),)
        
        img_np = image.cpu().numpy()
        
        # Handle batch dimension and alpha channel
        if len(img_np.shape) == 4:
            if img_np.shape[-1] == 4:
                img_np = img_np[0, :, :, :3]  # Remove batch and alpha
            else:
                img_np = img_np[0]  # Remove batch
        else:
            img_np = img_np
        
        img = (img_np * 255).astype(np.uint8)
        
        preset_key = COLOR_GRADE_PRESETS.get(preset, preset)
        
        if preset_key in _COLOR_GRADE_FUNCS and strength > 0:
            processed = _COLOR_GRADE_FUNCS[preset_key](img)
            
            if strength != 1.0:
                if strength < 1.0:
                    # Blend original and processed
                    img = (img.astype(np.float32) * (1 - strength) + processed.astype(np.float32) * strength)
                else:
                    # Strength > 1.0: push further toward processed
                    img = ((processed.astype(np.float32) - 128) * strength + 128)
                img = np.clip(img, 0, 255).astype(np.uint8)
        else:
            processed = img
        
        result = torch.from_numpy(img.astype(np.float32) / 255.0).unsqueeze(0)
        return (result,)


COLOR_MATCH_METHODS = {
    "直方图匹配": "histogram",
    "Reinhard_LAB迁移": "reinhard_lab",
    "均值标准差": "mean_std",
    "多维高斯分布": "mvgd",
    "Monge_Kantorovich": "mkl",
    "快速色彩迁移": "color_transfer",
    "自适应匹配": "adaptive",
}

# Placeholder - will be populated after function definitions
_COLOR_MATCH_FUNCS = {}


def _histogram_match(src, ref):
    result = src.copy()
    for c in range(min(src.shape[2], 3)):
        src_hist, src_bins = np.histogram(src[:,:,c].flatten(), 256, [0,256])
        ref_hist, ref_bins = np.histogram(ref[:,:,c].flatten(), 256, [0,256])
        src_cdf = src_hist.cumsum()
        ref_cdf = ref_hist.cumsum()
        src_cdf = src_cdf / src_cdf[-1]
        ref_cdf = ref_cdf / ref_cdf[-1]
        lookup = np.zeros(256, dtype=np.uint8)
        src_idx = 0
        for v in range(256):
            while src_idx < 255 and src_cdf[src_idx] < ref_cdf[v]:
                src_idx += 1
            lookup[v] = src_idx
        result[:,:,c] = lookup[src[:,:,c]]
    return result


def _reinhard_lab_match(src, ref):
    src_lab = cv2.cvtColor(src, cv2.COLOR_RGB2LAB).astype(np.float32)
    ref_lab = cv2.cvtColor(ref, cv2.COLOR_RGB2LAB).astype(np.float32)
    l_src, a_src, b_src = cv2.split(src_lab)
    l_ref, a_ref, b_ref = cv2.split(ref_lab)
    l_mean_src, l_std_src = l_src.mean(), l_src.std()
    a_mean_src, a_std_src = a_src.mean(), a_src.std()
    b_mean_src, b_std_src = b_src.mean(), b_src.std()
    l_mean_ref, l_std_ref = l_ref.mean(), l_ref.std()
    a_mean_ref, a_std_ref = a_ref.mean(), a_ref.std()
    b_mean_ref, b_std_ref = b_ref.mean(), b_ref.std()
    l_result = ((l_src - l_mean_src) * (l_std_ref / (l_std_src + 1e-8))) + l_mean_ref
    a_result = ((a_src - a_mean_src) * (a_std_ref / (a_std_src + 1e-8))) + a_mean_ref
    b_result = ((b_src - b_mean_src) * (b_std_ref / (b_std_src + 1e-8))) + b_mean_ref
    result_lab = cv2.merge([l_result, a_result, b_result])
    result_rgb = cv2.cvtColor(result_lab.astype(np.uint8), cv2.COLOR_LAB2RGB)
    return result_rgb


def _mean_std_match(src, src_l, ref_l):
    src_mean = src_l.mean()
    src_std = src_l.std()
    ref_mean = ref_l.mean()
    ref_std = ref_std = ref_l.std()
    result = src_l.copy()
    result = ((result - src_mean) * (ref_std / (src_std + 1e-8))) + ref_mean
    return np.clip(result, 0, 255).astype(np.uint8)


def _mvgd_match(src, ref):
    src_flat = src.reshape(-1, 3).astype(np.float32)
    ref_flat = ref.reshape(-1, 3).astype(np.float32)
    src_mean = src_flat.mean(axis=0)
    ref_mean = ref_flat.mean(axis=0)
    src_cov = np.cov(src_flat.T)
    ref_cov = np.cov(ref_flat.T)
    src_centered = src_flat - src_mean
    ref_centered = ref_flat - ref_mean
    src_inv = np.linalg.inv(src_cov + 1e-8 * np.eye(3))
    transfer = np.dot(ref_cov, src_inv)
    result_flat = np.dot(src_centered, transfer.T) + ref_mean
    result = result_flat.reshape(src.shape)
    return np.clip(result, 0, 255).astype(np.uint8)


def _mkl_match(src, ref):
    result = _mvgd_match(src, ref)
    return result


def _color_transfer_fast(src, ref):
    return _reinhard_lab_match(src, ref)


def _adaptive_match(src, ref):
    result = _histogram_match(src, ref)
    result_f = result.astype(np.float32)
    ref_f = ref.astype(np.float32)
    result_mean = result_f.mean()
    ref_mean = ref_f.mean()
    result_std = result_f.std()
    ref_std = ref_f.std()
    result = ((result_f - result_mean) * (ref_std / (result_std + 1e-8))) + ref_mean
    return np.clip(result, 0, 255).astype(np.uint8)


# Populate COLOR_MATCH_FUNCS after all functions are defined
_COLOR_MATCH_FUNCS.update({
    "histogram": _histogram_match,
    "reinhard_lab": _reinhard_lab_match,
    "mean_std": _mean_std_match,
    "mvgd": _mvgd_match,
    "mkl": _mkl_match,
    "color_transfer": _color_transfer_fast,
    "adaptive": _adaptive_match,
})


class GGColorMatch:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "reference": ("IMAGE",),
                "method": (list(COLOR_MATCH_METHODS.keys()), {"default": "直方图匹配"}),
            },
            "optional": {
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.01}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "match"
    CATEGORY = "GuliNodes/图像工具"

    def match(self, image, reference, method="直方图匹配", strength=1.0):
        if image is None or reference is None:
            return (torch.zeros([1, 64, 64, 3]),)
        
        # Handle batch and alpha
        src_np = image.cpu().numpy()
        ref_np = reference.cpu().numpy()
        
        if len(src_np.shape) == 4:
            if src_np.shape[-1] == 4:
                src_np = src_np[0, :, :, :3]
                ref_np = ref_np[0, :, :, :3]
            else:
                src_np = src_np[0]
                ref_np = ref_np[0]
        
        src = (src_np * 255).astype(np.uint8)
        ref = (ref_np * 255).astype(np.uint8)
        
        method_key = COLOR_MATCH_METHODS.get(method, method)
        if method_key in _COLOR_MATCH_FUNCS:
            processed = _COLOR_MATCH_FUNCS[method_key](src, ref)
        else:
            processed = src
        
        if strength < 1.0 and strength > 0:
            processed = np.clip(src.astype(np.float32) * (1 - strength) + processed.astype(np.float32) * strength, 0, 255).astype(np.uint8)
        
        result = torch.from_numpy(processed.astype(np.float32) / 255.0).unsqueeze(0)
        return (result,)


SWATCH_PRESETS = {
    "肤色": [np.array([210, 165, 140]), np.array([245, 200, 175]), np.array([255, 220, 195]), np.array([180, 140, 125])],
    "天空": [np.array([135, 180, 230]), np.array([100, 150, 210]), np.array([180, 210, 245]), np.array([70, 130, 190])],
    "草地": [np.array([90, 180, 80]), np.array([50, 160, 60]), np.array([140, 210, 100]), np.array([30, 130, 40])],
    "日落": [np.array([255, 100, 50]), np.array([255, 150, 80]), np.array([255, 200, 120]), np.array([240, 60, 30])],
    "海洋": [np.array([30, 120, 180]), np.array([40, 100, 160]), np.array([50, 150, 200]), np.array([20, 80, 140])],
    "紫色": [np.array([150, 80, 180]), np.array([180, 100, 210]), np.array([120, 60, 160]), np.array([200, 120, 220])],
    "霓虹": [np.array([255, 0, 128]), np.array([0, 255, 128]), np.array([128, 0, 255]), np.array([255, 255, 0])],
    "灰度": [np.array([30, 30, 30]), np.array([80, 80, 80]), np.array([150, 150, 150]), np.array([220, 220, 220])],
}


class GGSwatchPicker:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preset": (list(SWATCH_PRESETS.keys()), {"default": "肤色"}),
                "index": ("INT", {"default": 0, "min": 0, "max": 3}),
            },
            "optional": {
                "opacity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "get_swatch"
    CATEGORY = "GuliNodes/颜色工具"

    def get_swatch(self, preset, index, opacity=1.0):
        colors = SWATCH_PRESETS.get(preset, SWATCH_PRESETS["灰度"])
        color = colors[min(index, len(colors)-1)]
        img = np.full((100, 100, 3), color, dtype=np.uint8)
        if opacity < 1.0:
            img = np.clip(img.astype(np.float32) * opacity, 0, 255).astype(np.uint8)
        result = torch.from_numpy(img.astype(np.float32) / 255.0).unsqueeze(0)
        return (result,)


class GGHSLAdjust:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "色相": ("INT", {"default": 0, "min": -180, "max": 180}),
                "饱和度": ("INT", {"default": 0, "min": -100, "max": 100}),
                "明度": ("INT", {"default": 0, "min": -100, "max": 100}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "adjust"
    CATEGORY = "GuliNodes/颜色工具"

    def adjust(self, image, 色相=0, 饱和度=0, 明度=0):
        if image is None:
            return (torch.zeros([1, 64, 64, 3]),)
        
        img_np = image.cpu().numpy()
        
        # Handle batch and alpha
        if len(img_np.shape) == 4:
            if img_np.shape[-1] == 4:
                img_np = img_np[0, :, :, :3]
            else:
                img_np = img_np[0]
        
        img_np = (img_np * 255).astype(np.uint8)
        
        hsv = cv2.cvtColor(img_np, cv2.COLOR_RGB2HSV)
        h, s, v = cv2.split(hsv)
        
        h = h.astype(np.int16)
        h = np.clip(h + 色相, 0, 179).astype(np.uint8)
        
        if 饱和度 != 0:
            s = np.clip(s + 饱和度 * 2.55, 0, 255).astype(np.uint8)
        
        if 明度 != 0:
            v = np.clip(v + 明度 * 2.55, 0, 255).astype(np.uint8)
        
        hsv = cv2.merge([h, s, v])
        result = cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)
        
        output = torch.from_numpy(result.astype(np.float32) / 255.0).unsqueeze(0)
        return (output,)


class GGHistogramAdjust:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "输入黑场": ("INT", {"default": 0, "min": 0, "max": 255}),
                "输入白场": ("INT", {"default": 255, "min": 0, "max": 255}),
                "输出黑场": ("INT", {"default": 0, "min": 0, "max": 255}),
                "输出白场": ("INT", {"default": 255, "min": 0, "max": 255}),
                "gamma": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 3.0}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "adjust_levels"
    CATEGORY = "GuliNodes/颜色工具"

    def adjust_levels(self, image, input_black=0, input_white=255, output_black=0, output_white=255, gamma=1.0):
        if image is None:
            return (torch.zeros([1, 64, 64, 3]),)
        
        img_np = image.cpu().numpy()
        
        # Handle batch and alpha
        if len(img_np.shape) == 4:
            if img_np.shape[-1] == 4:
                img_np = img_np[0, :, :, :3]
            else:
                img_np = img_np[0]
        
        img = (img_np * 255).astype(np.float32)
        
        if input_white <= input_black:
            input_white = input_black + 1
        if output_white <= output_black:
            output_white = output_black + 1
        
        lookup = np.zeros(256, dtype=np.float32)
        for i in range(256):
            normalized = (i - input_black) / (input_white - input_black)
            normalized = np.clip(normalized, 0, 1)
            if gamma != 1.0:
                normalized = normalized ** (1.0 / gamma)
            scaled = normalized * (output_white - output_black) + output_black
            lookup[i] = np.clip(scaled, 0, 255)
        
        lookup = lookup.astype(np.uint8)
        
        result = lookup[img.astype(np.uint8)]
        
        output = torch.from_numpy(result.astype(np.float32) / 255.0).unsqueeze(0)
        return (output,)


class GGHistogramOutput:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "show_histogram"
    CATEGORY = "GuliNodes/颜色工具"

    def show_histogram(self, image):
        if image is None:
            return (torch.zeros([1, 256, 512, 3]),)
        
        img_np = image.cpu().numpy()
        
        # Handle batch and alpha
        if len(img_np.shape) == 4:
            if img_np.shape[-1] == 4:
                img_np = img_np[0, :, :, :3]
            else:
                img_np = img_np[0]
        
        img = (img_np * 255).astype(np.uint8)
        
        hist_r = np.histogram(img[:,:,0], bins=256, range=(0, 256))[0]
        hist_g = np.histogram(img[:,:,1], bins=256, range=(0, 256))[0]
        hist_b = np.histogram(img[:,:,2], bins=256, range=(0, 256))[0]
        
        max_val = max(hist_r.max(), hist_g.max(), hist_b.max())
        if max_val > 0:
            hist_r = (hist_r / max_val * 200).astype(np.uint8)
            hist_g = (hist_g / max_val * 200).astype(np.uint8)
            hist_b = (hist_b / max_val * 200).astype(np.uint8)
        
        canvas = np.zeros((256, 512, 3), dtype=np.uint8)
        
        # Use int() to convert and clip to valid range
        for i in range(256):
            x = i * 2
            r_idx = max(0, min(255, 256 - int(hist_r[i])))
            g_idx = max(0, min(255, 256 - int(hist_g[i])))
            b_idx = max(0, min(255, 256 - int(hist_b[i])))
            
            canvas[r_idx:256, x:x+2, 0] = 255
            canvas[g_idx:256, x:x+2, 1] = 255
            canvas[b_idx:256, x:x+2, 2] = 255
        
        for i in range(256):
            x = i * 2
            r_idx = max(0, min(255, 256 - int(hist_r[i])))
            g_idx = max(0, min(255, 256 - int(hist_g[i])))
            b_idx = max(0, min(255, 256 - int(hist_b[i])))
            
            canvas[r_idx:256, x:x+2, 0] = 255
            canvas[r_idx:256, x:x+2, 1] = 0
            canvas[r_idx:256, x:x+2, 2] = 0
            canvas[g_idx:256, x:x+2, 0] = 0
            canvas[g_idx:256, x:x+2, 1] = 255
            canvas[g_idx:256, x:x+2, 2] = 0
            canvas[b_idx:256, x:x+2, 0] = 0
            canvas[b_idx:256, x:x+2, 1] = 0
            canvas[b_idx:256, x:x+2, 2] = 255
        
        output = torch.from_numpy(canvas.astype(np.float32) / 255.0).unsqueeze(0)
        return (output,)


# ========== Photoshop Style Enhanced Nodes ==========

def _auto_levels(img):
    """自动色阶 - Photoshop自动调整"""
    result = img.astype(np.float32)
    for c in range(min(img.shape[2], 3)):
        channel = result[:,:,c]
        # 找到0.5%和99.5%百分位作为黑场/白场
        low = np.percentile(channel, 0.5)
        high = np.percentile(channel, 99.5)
        if high > low:
            result[:,:,c] = np.clip((channel - low) / (high - low) * 255, 0, 255)
    return result.astype(np.uint8)


def _adjust_contrast_ps(img, contrast):
    """Photoshop风格对比度"""
    factor = (259 * (contrast + 255)) / (259 * (259 - contrast))
    return np.clip((img - 128) * factor + 128, 0, 255).astype(np.uint8)


def _apply_curve(img, curve_points):
    """应用曲线调整 - curve_points: 16个点的坐标列表 [y0,y1,...,y15]"""
    if curve_points is None or len(curve_points) != 16:
        return img
    
    # 构建256级查找表
    lookup = np.zeros(256, dtype=np.uint8)
    for i in range(256):
        # 使用三次样条插值
        x = i / 255.0 * 15
        x0 = int(x)
        x1 = min(x0 + 1, 15)
        t = x - x0
        # 线性插值
        y = curve_points[x0] * (1 - t) + curve_points[x1] * t
        lookup[i] = int(np.clip(y / 15.0 * 255, 0, 255))
    
    result = lookup[img.astype(np.uint8)]
    return result


class GGHistogramAuto:
    """自动色阶 - 一键智能调整"""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "mode": (["自动增强", "自动对比度", "自动颜色", "柔化", "锐化"], {"default": "自动增强"}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "auto_adjust"
    CATEGORY = "GuliNodes/颜色工具"

    def auto_adjust(self, image, mode="自动增强"):
        if image is None:
            return (torch.zeros([1, 64, 64, 3]),)
        
        img_np = image.cpu().numpy()
        if len(img_np.shape) == 4:
            if img_np.shape[-1] == 4:
                img_np = img_np[0, :, :, :3]
            else:
                img_np = img_np[0]
        
        img = (img_np * 255).astype(np.uint8)
        result = img.copy()
        
        if mode == "自动增强":
            result = _auto_levels(img)
            result = _adjust_contrast_ps(result, 20)
        elif mode == "自动对比度":
            result = _adjust_contrast_ps(img, 30)
        elif mode == "自动颜色":
            result = _auto_levels(img)
            # 增加饱和度
            hsv = cv2.cvtColor(result, cv2.COLOR_RGB2HSV)
            h, s, v = cv2.split(hsv)
            s = np.clip(s * 1.2, 0, 255).astype(np.uint8)
            hsv = cv2.merge([h, s, v])
            result = cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)
        elif mode == "柔化":
            result = cv2.GaussianBlur(img, (5, 5), 0)
        elif mode == "锐化":
            kernel = np.array([[-1,-1,-1], [-1,9,-1], [-1,-1,-1]])
            result = cv2.filter2D(img, -1, kernel)
            s = np.clip(s * 1.2, 0, 255).astype(np.uint8)
            hsv = cv2.merge([h, s, v])
            result = cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)
        elif mode == "柔化":
            result = cv2.GaussianBlur(img, (5, 5), 0)
        elif mode == "锐化":
            kernel = np.array([[-1,-1,-1], [-1,9,-1], [-1,-1,-1]])
            result = cv2.filter2D(img, -1, kernel)
        
        output = torch.from_numpy(result.astype(np.float32) / 255.0).unsqueeze(0)
        return (output,)


class GGHistogramContrast:
    """对比度/亮度调整"""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "对比度": ("INT", {"default": 0, "min": -100, "max": 100}),
                "亮度": ("INT", {"default": 0, "min": -100, "max": 100}),
            },
            "optional": {
                "保持色温": ("BOOLEAN", {"default": False}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "adjust_contrast"
    CATEGORY = "GuliNodes/颜色工具"

    def adjust_contrast(self, image, 对比度=0, 亮度=0, 保持色温=False):
        if image is None:
            return (torch.zeros([1, 64, 64, 3]),)
        
        img_np = image.cpu().numpy()
        if len(img_np.shape) == 4:
            if img_np.shape[-1] == 4:
                img_np = img_np[0, :, :, :3]
            else:
                img_np = img_np[0]
        
        img = (img_np * 255).astype(np.float32)
        
        if 保持色温:
            # 只调整亮度
            img = img + 亮度 * 2.55
        else:
            # 先对比度后亮度
            factor = (259 * (对比度 + 255)) / (259 * (259 - 对比度)) if 对比度 != 0 else 1
            img = (img - 128) * factor + 128 + 亮度 * 2.55
        
        img = np.clip(img, 0, 255).astype(np.uint8)
        output = torch.from_numpy(img.astype(np.float32) / 255.0).unsqueeze(0)
        return (output,)


class GGCurves:
    """RGB曲线调整"""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "黑点": ("INT", {"default": 0, "min": 0, "max": 255}),
                "阴影": ("INT", {"default": 64, "min": 0, "max": 255}),
                "中间调": ("INT", {"default": 128, "min": 0, "max": 255}),
                "高光": ("INT", {"default": 192, "min": 0, "max": 255}),
                "白点": ("INT", {"default": 255, "min": 0, "max": 255}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "apply_curves"
    CATEGORY = "GuliNodes/颜色工具"

    def apply_curves(self, image, 黑点=0, 阴影=64, 中间调=128, 高光=192, 白点=255):
        if image is None:
            return (torch.zeros([1, 64, 64, 3]),)
        
        img_np = image.cpu().numpy()
        if len(img_np.shape) == 4:
            if img_np.shape[-1] == 4:
                img_np = img_np[0, :, :, :3]
            else:
                img_np = img_np[0]
        
        img = (img_np * 255).astype(np.uint8)
        
        # 构建曲线查找表
        curve_points = [黑点, 阴影, 中间调, 高光, 白点]
        # 扩展到16点进行平滑插值
        extended = []
        for i in range(4):
            extended.extend([curve_points[i]] * 4)
        extended.append(curve_points[4])
        
        for c in range(min(img.shape[2], 3)):
            channel = img[:,:,c]
            result = _apply_curve(channel, extended)
            img[:,:,c] = result
        
        output = torch.from_numpy(img.astype(np.float32) / 255.0).unsqueeze(0)
        return (output,)


class GGChannelCurves:
    """通道曲线调整 - RGB各通道独立"""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "R黑点": ("INT", {"default": 0, "min": 0, "max": 255}),
                "R中间调": ("INT", {"default": 128, "min": 0, "max": 255}),
                "R白点": ("INT", {"default": 255, "min": 0, "max": 255}),
                "G黑点": ("INT", {"default": 0, "min": 0, "max": 255}),
                "G中间调": ("INT", {"default": 128, "min": 0, "max": 255}),
                "G白点": ("INT", {"default": 255, "min": 0, "max": 255}),
                "B黑点": ("INT", {"default": 0, "min": 0, "max": 255}),
                "B中间调": ("INT", {"default": 128, "min": 0, "max": 255}),
                "B白点": ("INT", {"default": 255, "min": 0, "max": 255}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "apply_channel_curves"
    CATEGORY = "GuliNodes/颜色工具"

    def apply_channel_curves(self, image, 
                          R黑点=0, R中间调=128, R白点=255,
                          G黑点=0, G中间调=128, G白点=255,
                          B黑点=0, B中间调=128, B白点=255):
        if image is None:
            return (torch.zeros([1, 64, 64, 3]),)
        
        img_np = image.cpu().numpy()
        if len(img_np.shape) == 4:
            if img_np.shape[-1] == 4:
                img_np = img_np[0, :, :, :3]
            else:
                img_np = img_np[0]
        
        img = (img_np * 255).astype(np.uint8)
        
        channels = [
            ([R黑点, R中间调, R白点], "R"),
            ([G黑点, G中间调, G白点], "G"),
            ([B黑点, B中间调, B白点], "B"),
        ]
        
        for i, (curve, name) in enumerate(channels):
            extended = [curve[0]] * 5 + [curve[1]] * 5 + [curve[2]] * 5 + [curve[2]]
            img[:,:,i] = _apply_curve(img[:,:,i], extended)
        
        output = torch.from_numpy(img.astype(np.float32) / 255.0).unsqueeze(0)
        return (output,)


# ========== End Enhanced Nodes ==========


class GGColorPicker:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "hex": ("STRING", {"default": "#FF5500"}),
            },
            "optional": {
                "width": ("INT", {"default": 256, "min": 32, "max": 1024}),
                "height": ("INT", {"default": 256, "min": 32, "max": 1024}),
            }
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "pick_color"
    CATEGORY = "GuliNodes/颜色工具"

    def pick_color(self, hex_color="#FF5500", width=256, height=256):
        try:
            hex_color = hex_color.strip()
            if not hex_color.startswith("#"):
                hex_color = "#" + hex_color
            r = int(hex_color[1:3], 16)
            g = int(hex_color[3:5], 16)
            b = int(hex_color[5:7], 16)
        except:
            r, g, b = 255, 85, 0
        
        img = np.full((height, width, 3), (b, g, r), dtype=np.uint8)
        result = torch.from_numpy(img.astype(np.float32) / 255.0).unsqueeze(0)
        return (result,)


class GGTextJoin:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text_a": ("STRING", {"default": "", "multiline": True}),
                "text_b": ("STRING", {"default": "", "multiline": True}),
                "separator": ("STRING", {"default": "\n"}),
            }
        }
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "join"
    CATEGORY = "GuliNodes/文本工具"

    def join(self, text_a="", text_b="", separator="\n"):
        combined = text_a + separator + text_b if text_a and text_b else (text_a or text_b)
        return (combined,)


def _gg_new_random_seed():
    global _gg_seed_random_state
    prev_state = random.getstate()
    random.setstate(_gg_seed_random_state)
    seed = random.randint(1, 1125899906842624)
    _gg_seed_random_state = random.getstate()
    random.setstate(prev_state)
    return seed


class GGSeed:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (["随机", "手动", "上次", "增加50"], {"default": "随机"}),
                "seed": ("INT", {"default": 1, "min": 0, "max": 1125899906842624}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }
    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("seed",)
    FUNCTION = "get_seed"
    CATEGORY = "GuliNodes/工具"

    def get_seed(self, mode="随机", seed=1, prompt=None, extra_pnginfo=None, unique_id=None):
        global _last_seed
        
        if mode == "随机":
            result_seed = _gg_new_random_seed()
        elif mode == "手动":
            result_seed = seed
        elif mode == "上次":
            result_seed = _last_seed
        elif mode == "增加50":
            result_seed = _last_seed + 50
        else:
            result_seed = seed
        
        _last_seed = result_seed
        return (result_seed,)


class ImageComparerBase:
    @classmethod
    def get_default_inputs(cls):
        return {
            "required": {},
            "optional": {
                "font_size": ("INT", {"default": 40, "min": 20, "max": 120, "step": 2}),
                "border": ("INT", {"default": 32, "min": 0, "max": 80, "step": 2}),
                "label_height": ("INT", {"default": 80, "min": 50, "max": 200, "step": 2}),
                "spacing": ("INT", {"default": 20, "min": 0, "max": 100, "step": 2}),
            }
        }
    
    @classmethod
    def create_image_inputs(cls, count):
        inputs = {}
        labels = {}
        for i in range(count):
            char = chr(65 + i)
            inputs[f"image_{char}"] = ("IMAGE",)
            labels[f"label_{char}"] = ("STRING", {"default": f"图像 {char}"})
        return inputs, labels


class GGImageComparer4(ImageComparerBase):
    @classmethod
    def INPUT_TYPES(s):
        inputs, labels = s.create_image_inputs(4)
        base_inputs = s.get_default_inputs()
        base_inputs["optional"].update(inputs)
        base_inputs["optional"].update(labels)
        return base_inputs
    
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("对比结果",)
    FUNCTION = "compare"
    CATEGORY = "GuliNodes/图像工具"

    def compare(self, image_A=None, image_B=None, image_C=None, image_D=None,
                label_A="图像 A", label_B="图像 B", label_C="图像 C", label_D="图像 D",
                font_size=40, border=32, label_height=80, spacing=20, **kwargs):
        images = [img for img in [image_A, image_B, image_C, image_D] if img is not None]
        labels = [label_A, label_B, label_C, label_D][:len(images)]
        if len(images) < 2:
            return (image_A or image_B or image_C or image_D,)
        return (concatenate_images_horizontally(images, labels, font_size, border, label_height, spacing),)


class GGImageComparer8(ImageComparerBase):
    @classmethod
    def INPUT_TYPES(s):
        inputs, labels = s.create_image_inputs(8)
        base_inputs = s.get_default_inputs()
        base_inputs["optional"].update(inputs)
        base_inputs["optional"].update(labels)
        return base_inputs
    
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("对比结果",)
    FUNCTION = "compare"
    CATEGORY = "GuliNodes/图像工具"

    def compare(self, **kwargs):
        images = [kwargs.get(f"image_{chr(65+i)}") for i in range(8)]
        images = [img for img in images if img is not None]
        labels = [kwargs.get(f"label_{chr(65+i)}", f"图像 {chr(65+i)}") for i in range(8)][:len(images)]
        font_size = kwargs.get("font_size", 40)
        border = kwargs.get("border", 32)
        label_height = kwargs.get("label_height", 80)
        spacing = kwargs.get("spacing", 20)
        if len(images) < 2:
            return (images[0] if images else None,)
        return (concatenate_images_horizontally(images, labels, font_size, border, label_height, spacing),)


class LoRAStackerBase:
    def __init__(self):
        self.loaded_loras = {}
    
    @classmethod
    def get_base_inputs(cls):
        return {"required": {"model": ("MODEL",)}}
    
    @classmethod
    def get_lora_file_inputs(cls, count):
        lora_list = folder_paths.get_filename_list("loras")
        # Ensure "None" option is available
        if "None" not in lora_list:
            lora_list = ["None"] + lora_list
        inputs = {}
        for i in range(1, count + 1):
            inputs[f"lora{i}_name"] = (lora_list, {"default": "None"})
            inputs[f"strength{i}"] = ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.01})
        return inputs
    
    def load_lora_file(self, lora_name, strength):
        if lora_name == "None" or strength == 0:
            return None
        try:
            lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
            lora_key = f"{lora_name}_{strength}"
            if lora_key in self.loaded_loras:
                return self.loaded_loras[lora_key]
            lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
            self.loaded_loras[lora_key] = lora
            return lora
        except Exception as e:
            print(f"Error loading LoRA {lora_name}: {e}")
            return None
    
    def apply_lora_stack(self, model, lora_data):
        m = model
        for lora, strength in lora_data:
            if lora is not None and strength != 0:
                try:
                    m, _ = comfy.sd.load_lora_for_models(m, None, lora, strength, 0)
                except Exception as e:
                    print(f"Error applying LoRA: {e}")
                    continue
        return m


class GGLoRAFileStacker4(LoRAStackerBase):
    @classmethod
    def INPUT_TYPES(s):
        inputs = s.get_base_inputs()
        inputs["optional"] = s.get_lora_file_inputs(4)
        return inputs
    
    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "stack"
    CATEGORY = "GuliNodes/LoRA工具"

    def stack(self, model, lora1_name="None", lora2_name="None", lora3_name="None", lora4_name="None",
              strength1=1.0, strength2=1.0, strength3=1.0, strength4=1.0):
        # Protect: model cannot be None
        if model is None:
            return (None,)
        lora_data = []
        for lora_name, strength in [(lora1_name, strength1), (lora2_name, strength2), 
                                   (lora3_name, strength3), (lora4_name, strength4)]:
            lora = self.load_lora_file(lora_name, strength)
            if lora is not None:
                lora_data.append((lora, strength))
        # If no valid LoRAs selected, return original model
        if not lora_data:
            return (model,)
        result = self.apply_lora_stack(model, lora_data)
        # Double protection: never return None
        if result is None:
            return (model,)  # Fallback to original
        return (result,)


class GGLoRAFileStacker8(LoRAStackerBase):
    @classmethod
    def INPUT_TYPES(s):
        inputs = s.get_base_inputs()
        inputs["optional"] = s.get_lora_file_inputs(8)
        return inputs
    
    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "stack"
    CATEGORY = "GuliNodes/LoRA工具"

    def stack(self, model, **kwargs):
        # Protect: model cannot be None
        if model is None:
            return (None,)
        lora_data = []
        for i in range(1, 9):
            lora_name = kwargs.get(f"lora{i}_name", "None")
            strength = kwargs.get(f"strength{i}", 1.0)
            lora = self.load_lora_file(lora_name, strength)
            if lora is not None:
                lora_data.append((lora, strength))
        # If no valid LoRAs selected, return original model
        if not lora_data:
            return (model,)
        result = self.apply_lora_stack(model, lora_data)
        # Double protection: never return None
        if result is None:
            return (model,)  # Fallback to original
        return (result,)


class GGGroupControllerM:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}
    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "GuliNodes/编组控制"
    DESCRIPTION = "批量控制工作流中所有编组。全部跳过/全部启用，点击编组名可跳转。"

    def run(self):
        return {}


class GGGroupControllerS:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}
    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "GuliNodes/编组控制"
    DESCRIPTION = "精确控制单个编组。点击下拉框选择目标编组，开关控制跳过/启用。"

    def run(self):
        return {}


NODE_CLASS_MAPPINGS = {
    "AspectRatioAdapter": AspectRatioAdapter,
    "AspectRatioLatent": AspectRatioLatent,
    "GGImageToLatent": GGImageToLatent,
    "GGRGBAtoRGB": GGRGBAtoRGB,
    "GGTextJoin": GGTextJoin,
    "GGSeed": GGSeed,
    "GGImageComparer4": GGImageComparer4,
    "GGImageComparer8": GGImageComparer8,
    "GGLoRAFileStacker4": GGLoRAFileStacker4,
    "GGLoRAFileStacker8": GGLoRAFileStacker8,
    "GGGroupControllerM": GGGroupControllerM,
    "GGGroupControllerS": GGGroupControllerS,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AspectRatioAdapter": "GG 比例适配计算器",
    "AspectRatioLatent": "GG 比例适配 Latent 生成器",
    "GGImageToLatent": "GG 比例适配 Latent (可接图像)",
    "GGRGBAtoRGB": "GG RGBA转RGB",
    "GGTextJoin": "GG 文本合并",
    "GGSeed": "GG 随机种",
    "GGImageComparer4": "GG 图像对比 4张",
    "GGImageComparer8": "GG 图像对比 8张",
    "GGLoRAFileStacker4": "GG LoRA 文件选择堆 4个",
    "GGLoRAFileStacker8": "GG LoRA 文件选择堆 8个",
    "GGGroupControllerM": "GG 多组控制",
    "GGGroupControllerS": "GG 单组控制",
}
