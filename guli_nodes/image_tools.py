import torch
import torch.nn.functional as torch_F
from PIL import Image, ImageDraw, ImageFont
import numpy as np
from nodes import PreviewImage


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


NODE_CLASS_MAPPINGS = {
    "GGRGBAtoRGB": GGRGBAtoRGB,
    "GGImageComparer2": GGImageComparer2,
    "GGImageComparer4": GGImageComparer4,
    "GGImageComparer8": GGImageComparer8,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGRGBAtoRGB": "GG RGBA转RGB",
    "GGImageComparer2": "GG 图像对比 2张",
    "GGImageComparer4": "GG 图像对比 4张",
    "GGImageComparer8": "GG 图像对比 8张",
}