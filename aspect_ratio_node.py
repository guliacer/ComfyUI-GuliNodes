import torch
import torch.nn.functional as torch_F
import random
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import comfy.utils
import comfy.sd
import folder_paths
from nodes import PreviewImage

# Global last seed for "use previous" mode
_last_seed = 1

# Random seed state
initial_random_state = random.getstate()
random.seed(datetime.now().timestamp())
_gg_seed_random_state = random.getstate()
random.setstate(initial_random_state)

ASPECT_RATIOS = ["1:1", "3:2", "4:3", "5:4", "16:9", "21:9", "9:16", "2:3", "3:4", "4:5", "9:21"]
ASPECT_PRESETS = {"1:1": (1, 1), "3:2": (3, 2), "4:3": (4, 3), "5:4": (5, 4), "16:9": (16, 9),
                  "21:9": (21, 9), "9:16": (9, 16), "2:3": (2, 3), "3:4": (3, 4), "4:5": (4, 5), "9:21": (9, 21)}
SIDE_TYPES = ["最长边", "最短边"]

def concatenate_images_horizontally(images: list, labels: list = None, font_size: int = 40, border: int = 32, label_height: int = 80, spacing: int = 20) -> torch.Tensor:
    """水平拼接图像，可选添加标签"""
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
    except Exception:
        font = ImageFont.load_default()
    sub_width = W // len(labels)
    for i, text in enumerate(labels):
        x = i * sub_width + sub_width // 2
        draw.text((x, H + label_height // 2), text, fill=(255, 255, 255), font=font, anchor="mm", stroke_width=4, stroke_fill=(255, 255, 255))
        draw.text((x, H + label_height // 2), text, fill=(0, 0, 0), font=font, anchor="mm")
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

    def calculate(self, aspect_ratio: str, side_length: int, side_type: str) -> tuple:
        """计算指定比例和边长的宽高"""
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

    def generate(self, aspect_ratio: str, side_length: int, side_type: str, batch_size: int) -> tuple:
        """生成指定比例的Latent"""
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

    def convert(self, mode: str = "手动", aspect_ratio: str = "16:9", side_length: int = 1024, side_type: str = "最长边", batch_size: int = 1, image: torch.Tensor = None) -> tuple:
        """根据手动设置或参考图像生成Latent"""
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

    def convert(self, image: torch.Tensor) -> tuple:
        """将RGBA图像转换为RGB"""
        if image is None:
            return (torch.zeros([1, 64, 64, 3]),)
        # Check if image has alpha channel (RGBA)
        if image.shape[-1] == 4:
            # Remove alpha channel, keep only RGB
            rgb_image = image[..., :3]
            return (rgb_image,)
        # Already RGB
        return (image,)


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

    def join(self, text_a: str = "", text_b: str = "", separator: str = "\n") -> tuple:
        """合并两个文本"""
        combined = text_a + separator + text_b if text_a and text_b else (text_a or text_b)
        return (combined,)


def _gg_new_random_seed() -> int:
    """生成新的随机种子"""
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

    def get_seed(self, mode: str = "随机", seed: int = 1, prompt: dict = None, extra_pnginfo: dict = None, unique_id: str = None) -> tuple:
        """获取种子值"""
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
    def create_image_inputs(cls, count: int) -> tuple:
        """创建指定数量的图像输入"""
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

    def compare(self, image_A: torch.Tensor = None, image_B: torch.Tensor = None, image_C: torch.Tensor = None, image_D: torch.Tensor = None,
                label_A: str = "图像 A", label_B: str = "图像 B", label_C: str = "图像 C", label_D: str = "图像 D",
                font_size: int = 40, border: int = 32, label_height: int = 80, spacing: int = 20, **kwargs) -> tuple:
        """对比4张图像"""
        images = [img for img in [image_A, image_B, image_C, image_D] if img is not None]
        labels = [label_A, label_B, label_C, label_D][:len(images)]
        if len(images) < 2:
            return (image_A or image_B or image_C or image_D,)
        return (concatenate_images_horizontally(images, labels, font_size, border, label_height, spacing),)


class GGImageComparer2(PreviewImage):
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image_A": ("IMAGE",),
                "image_B": ("IMAGE",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO"
            }
        }

    FUNCTION = "compare"
    CATEGORY = "GuliNodes/图像工具"
    DESCRIPTION = "对比两张图像，支持滑动和点击两种模式"

    def compare(self, image_A: torch.Tensor, image_B: torch.Tensor,
                filename_prefix="GG.compare.",
                prompt=None, extra_pnginfo=None) -> dict:
        """对比两张图像"""
        result = {"ui": {"a_images": [], "b_images": []}}
        if image_A is not None and len(image_A) > 0:
            result["ui"]["a_images"] = self.save_images(
                image_A, f"{filename_prefix}a_", prompt, extra_pnginfo
            )["ui"]["images"]
        if image_B is not None and len(image_B) > 0:
            result["ui"]["b_images"] = self.save_images(
                image_B, f"{filename_prefix}b_", prompt, extra_pnginfo
            )["ui"]["images"]
        return result


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

    def compare(self, **kwargs) -> tuple:
        """对比8张图像"""
        images = [kwargs.get(f"image_{chr(65 + i)}") for i in range(8)]
        images = [img for img in images if img is not None]
        labels = [kwargs.get(f"label_{chr(65 + i)}", f"图像 {chr(65 + i)}") for i in range(8)][:len(images)]
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
    def get_lora_file_inputs(cls, count: int) -> dict:
        """获取LoRA文件输入"""
        lora_list = folder_paths.get_filename_list("loras")
        # Ensure "None" option is available
        if "None" not in lora_list:
            lora_list = ["None"] + lora_list
        inputs = {}
        for i in range(1, count + 1):
            inputs[f"lora{i}_name"] = (lora_list, {"default": "None"})
            inputs[f"strength{i}"] = ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.01})
        return inputs
    
    def load_lora_file(self, lora_name: str, strength: float) -> dict:
        """加载LoRA文件"""
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
    
    def apply_lora_stack(self, model: object, lora_data: list) -> object:
        """应用LoRA堆栈"""
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

    def stack(self, model: object, lora1_name: str = "None", lora2_name: str = "None", lora3_name: str = "None", lora4_name: str = "None",
              strength1: float = 1.0, strength2: float = 1.0, strength3: float = 1.0, strength4: float = 1.0) -> tuple:
        """堆叠4个LoRA"""
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

    def stack(self, model: object, **kwargs) -> tuple:
        """堆叠8个LoRA"""
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

    def run(self) -> dict:
        """运行批量编组控制"""
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

    def run(self) -> dict:
        """运行单个编组控制"""
        return {}


class GGClipboardReader:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "optional": {
                "text": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "read"
    CATEGORY = "GuliNodes/文本工具"
    DESCRIPTION = "读取系统剪贴板内容，无需手动复制粘贴"

    def read(self, text: str = "") -> tuple:
        """读取剪贴板内容"""
        return (text,)


NODE_CLASS_MAPPINGS = {
    "AspectRatioAdapter": AspectRatioAdapter,
    "AspectRatioLatent": AspectRatioLatent,
    "GGImageToLatent": GGImageToLatent,
    "GGRGBAtoRGB": GGRGBAtoRGB,
    "GGTextJoin": GGTextJoin,
    "GGSeed": GGSeed,
    "GGImageComparer2": GGImageComparer2,
    "GGImageComparer4": GGImageComparer4,
    "GGImageComparer8": GGImageComparer8,
    "GGLoRAFileStacker4": GGLoRAFileStacker4,
    "GGLoRAFileStacker8": GGLoRAFileStacker8,
    "GGGroupControllerM": GGGroupControllerM,
    "GGGroupControllerS": GGGroupControllerS,
    "GGClipboardReader": GGClipboardReader,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "AspectRatioAdapter": "GG 比例适配计算器",
    "AspectRatioLatent": "GG 比例适配 Latent 生成器",
    "GGImageToLatent": "GG 比例适配 Latent (可接图像)",
    "GGRGBAtoRGB": "GG RGBA转RGB",
    "GGTextJoin": "GG 文本合并",
    "GGSeed": "GG 随机种",
    "GGImageComparer2": "GG 图像对比 2张",
    "GGImageComparer4": "GG 图像对比 4张",
    "GGImageComparer8": "GG 图像对比 8张",
    "GGLoRAFileStacker4": "GG LoRA 文件选择堆 4个",
    "GGLoRAFileStacker8": "GG LoRA 文件选择堆 8个",
    "GGGroupControllerM": "GG 多组控制",
    "GGGroupControllerS": "GG 单组控制",
    "GGClipboardReader": "GG 剪贴板读取",
}