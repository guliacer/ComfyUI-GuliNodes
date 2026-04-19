import torch
import torch.nn.functional as torch_F
from PIL import Image, ImageDraw, ImageFont
import numpy as np
from nodes import PreviewImage


def concatenate_images_horizontally(images: list, labels: list = None, font_size: int = 40, border: int = 32, label_height: int = 80, spacing: int = 20) -> torch.Tensor:
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
                "图像": ("IMAGE",),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "convert"
    CATEGORY = "GuliNodes/图像工具"

    def convert(self, 图像: torch.Tensor) -> tuple:
        if 图像 is None:
            return (torch.zeros([1, 64, 64, 3]),)
        if 图像.shape[-1] == 4:
            rgb_image = 图像[..., :3]
            return (rgb_image,)
        return (图像,)


class GGImageResize:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "模式": (["按比例", "按尺寸"], {"default": "按比例"}),
            },
            "optional": {
                "缩放比例": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 10.0, "step": 0.1}),
                "宽度": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "高度": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "插值方法": (["bilinear", "nearest", "bicubic"], {"default": "bilinear"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "resize"
    CATEGORY = "GuliNodes/图像工具"

    def resize(self, 图像: torch.Tensor, 模式: str = "按比例", 缩放比例: float = 1.0,
               宽度: int = 512, 高度: int = 512, 插值方法: str = "bilinear") -> tuple:
        if 图像 is None:
            return (torch.zeros([1, 64, 64, 3]),)

        img_ch = 图像.permute(0, 3, 1, 2).contiguous()

        if 模式 == "按比例":
            new_height = int(图像.shape[1] * 缩放比例)
            new_width = int(图像.shape[2] * 缩放比例)
        else:
            new_height = 高度
            new_width = 宽度

        new_width = (new_width // 8) * 8
        new_height = (new_height // 8) * 8

        if 插值方法 == "nearest":
            mode = "nearest"
        elif 插值方法 == "bicubic":
            mode = "bicubic"
        else:
            mode = "bilinear"

        resized = torch_F.interpolate(img_ch, size=(new_height, new_width),
                                      mode=mode, align_corners=False, antialias=True)
        return (resized.permute(0, 2, 3, 1).contiguous(),)


class GGImageCrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "模式": (["中心裁剪", "手动裁剪", "按比例裁剪"], {"default": "中心裁剪"}),
            },
            "optional": {
                "宽度": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "高度": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "X坐标": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 8}),
                "Y坐标": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 8}),
                "宽高比例": (["1:1", "3:2", "4:3", "5:4", "16:9", "21:9", "9:16", "2:3", "3:4", "4:5", "9:21"], {"default": "16:9"}),
                "边长": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "边长类型": (["最长边", "最短边"], {"default": "最长边"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "crop"
    CATEGORY = "GuliNodes/图像工具"

    def crop(self, 图像: torch.Tensor, 模式: str = "中心裁剪",
              宽度: int = 512, 高度: int = 512, X坐标: int = 0, Y坐标: int = 0,
              宽高比例: str = "16:9", 边长: int = 1024, 边长类型: str = "最长边") -> tuple:
        if 图像 is None:
            return (torch.zeros([1, 64, 64, 3]),)

        if 模式 == "按比例裁剪":
            aspect_presets = {"1:1": (1, 1), "3:2": (3, 2), "4:3": (4, 3), "5:4": (5, 4), "16:9": (16, 9),
                           "21:9": (21, 9), "9:16": (9, 16), "2:3": (2, 3), "3:4": (3, 4), "4:5": (4, 5), "9:21": (9, 21)}

            wr, hr = aspect_presets[宽高比例]
            if 边长类型 == "最长边":
                crop_width = 边长 if wr > hr else int(边长 * wr / hr)
                crop_height = int(边长 * hr / wr) if wr > hr else 边长
            else:
                crop_height = 边长 if wr > hr else int(边长 * hr / wr)
                crop_width = int(边长 * wr / hr) if wr > hr else 边长

            crop_width = (crop_width // 8) * 8
            crop_height = (crop_height // 8) * 8

            img_height, img_width = 图像.shape[1], 图像.shape[2]
            x = (img_width - crop_width) // 2
            y = (img_height - crop_height) // 2

            x = max(0, x)
            y = max(0, y)

            crop_width = min(crop_width, img_width - x)
            crop_height = min(crop_height, img_height - y)

            cropped = 图像[:, y:y+crop_height, x:x+crop_width, :]
            return (cropped,)

        elif 模式 == "中心裁剪":
            img_height, img_width = 图像.shape[1], 图像.shape[2]
            x = (img_width - 宽度) // 2
            y = (img_height - 高度) // 2
        else:
            x = X坐标
            y = Y坐标

        x = max(0, x)
        y = max(0, y)

        img_height, img_width = 图像.shape[1], 图像.shape[2]
        width = min(宽度, img_width - x)
        height = min(高度, img_height - y)

        cropped = 图像[:, y:y+height, x:x+width, :]
        return (cropped,)


class GGImageTransform:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "变换类型": (["水平翻转", "垂直翻转", "旋转90度", "旋转180度", "旋转270度"], {"default": "水平翻转"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "transform"
    CATEGORY = "GuliNodes/图像工具"

    def transform(self, 图像: torch.Tensor, 变换类型: str = "水平翻转") -> tuple:
        if 图像 is None:
            return (torch.zeros([1, 64, 64, 3]),)

        if 变换类型 == "水平翻转":
            return (torch.flip(图像, [2]),)
        elif 变换类型 == "垂直翻转":
            return (torch.flip(图像, [1]),)
        elif 变换类型 == "旋转90度":
            return (torch.rot90(图像, 1, [1, 2]),)
        elif 变换类型 == "旋转180度":
            return (torch.rot90(图像, 2, [1, 2]),)
        elif 变换类型 == "旋转270度":
            return (torch.rot90(图像, 3, [1, 2]),)
        else:
            return (图像,)


class GGImageAdjust:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
            },
            "optional": {
                "亮度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 3.0, "step": 0.1}),
                "对比度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 3.0, "step": 0.1}),
                "饱和度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 3.0, "step": 0.1}),
                "锐化": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.1}),
                "虚化": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 5.0, "step": 0.1}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "adjust"
    CATEGORY = "GuliNodes/图像工具"

    def adjust(self, 图像: torch.Tensor, 亮度: float = 1.0,
               对比度: float = 1.0, 饱和度: float = 1.0, 锐化: float = 1.0, 虚化: float = 0.0) -> tuple:
        if 图像 is None:
            return (torch.zeros([1, 64, 64, 3]),)

        adjusted = 图像 * 亮度
        adjusted = (adjusted - 0.5) * 对比度 + 0.5

        if 饱和度 != 1.0:
            gray = adjusted.mean(dim=-1, keepdim=True)
            adjusted = gray * (1 - 饱和度) + adjusted * 饱和度

        if 虚化 > 0:
            img_ch = adjusted.permute(0, 3, 1, 2).contiguous()
            kernel_size = int(虚化 * 2) + 1
            if kernel_size % 2 == 0:
                kernel_size += 1
            kernel_size = min(kernel_size, 15)
            blurred = torch_F.gaussian_blur(img_ch, kernel_size=(kernel_size, kernel_size), sigma=虚化)
            adjusted = blurred.permute(0, 2, 3, 1).contiguous()

        if 锐化 > 1:
            kernel = torch.tensor([[-1, -1, -1],
                                  [-1, 9, -1],
                                  [-1, -1, -1]], dtype=torch.float32)
            kernel = kernel.view(1, 1, 3, 3)
            kernel = kernel * (锐化 - 1) + torch.eye(3).view(1, 1, 3, 3)
            kernel = kernel / kernel.sum()

            img_ch = adjusted.permute(0, 3, 1, 2).contiguous()
            sharpened = torch_F.conv2d(img_ch, kernel.repeat(3, 1, 1, 1), padding=1)
            adjusted = sharpened.permute(0, 2, 3, 1).contiguous()

        adjusted = torch.clamp(adjusted, 0.0, 1.0)

        return (adjusted,)


class GGImageEffects:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "效果类型": (["灰度", "模糊", "锐化", "边缘检测"], {"default": "灰度"}),
            },
            "optional": {
                "内核大小": ("INT", {"default": 3, "min": 1, "max": 15, "step": 2}),
                "Sigma值": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 5.0, "step": 0.1}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "apply_effect"
    CATEGORY = "GuliNodes/图像工具"

    def apply_effect(self, 图像: torch.Tensor, 效果类型: str = "灰度",
                     内核大小: int = 3, Sigma值: float = 1.0) -> tuple:
        if 图像 is None:
            return (torch.zeros([1, 64, 64, 3]),)

        if 效果类型 == "灰度":
            gray = 图像.mean(dim=-1, keepdim=True)
            return (gray.expand_as(图像),)

        elif 效果类型 == "模糊":
            img_ch = 图像.permute(0, 3, 1, 2).contiguous()
            blurred = torch_F.gaussian_blur(img_ch, kernel_size=(内核大小, 内核大小), sigma=Sigma值)
            return (blurred.permute(0, 2, 3, 1).contiguous(),)

        elif 效果类型 == "锐化":
            kernel = torch.tensor([[-1, -1, -1],
                                  [-1, 9, -1],
                                  [-1, -1, -1]], dtype=torch.float32)
            kernel = kernel.view(1, 1, 3, 3)
            kernel = kernel / kernel.sum()

            img_ch = 图像.permute(0, 3, 1, 2).contiguous()
            sharpened = torch_F.conv2d(img_ch, kernel.repeat(3, 1, 1, 1), padding=1)
            return (sharpened.permute(0, 2, 3, 1).contiguous(),)

        elif 效果类型 == "边缘检测":
            kernel_x = torch.tensor([[-1, 0, 1],
                                     [-2, 0, 2],
                                     [-1, 0, 1]], dtype=torch.float32)
            kernel_y = torch.tensor([[-1, -2, -1],
                                     [0, 0, 0],
                                     [1, 2, 1]], dtype=torch.float32)

            kernel_x = kernel_x.view(1, 1, 3, 3)
            kernel_y = kernel_y.view(1, 1, 3, 3)

            img_ch = 图像.permute(0, 3, 1, 2).contiguous()
            edges_x = torch_F.conv2d(img_ch, kernel_x.repeat(3, 1, 1, 1), padding=1)
            edges_y = torch_F.conv2d(img_ch, kernel_y.repeat(3, 1, 1, 1), padding=1)
            edges = torch.sqrt(edges_x**2 + edges_y**2)
            edges = torch.clamp(edges, 0.0, 1.0)
            return (edges.permute(0, 2, 3, 1).contiguous(),)

        else:
            return (图像,)


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

    def compare(self, image_A: torch.Tensor, image_B: torch.Tensor,
                filename_prefix="GG.compare.",
                prompt=None, extra_pnginfo=None) -> dict:
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
    "GGImageResize": GGImageResize,
    "GGImageCrop": GGImageCrop,
    "GGImageTransform": GGImageTransform,
    "GGImageAdjust": GGImageAdjust,
    "GGImageEffects": GGImageEffects,
    "GGImageComparer2": GGImageComparer2,
    "GGImageComparer4": GGImageComparer4,
    "GGImageComparer8": GGImageComparer8,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGRGBAtoRGB": "GG RGBA转RGB",
    "GGImageResize": "GG 图像调整大小",
    "GGImageCrop": "GG 图像裁剪",
    "GGImageTransform": "GG 图像变换",
    "GGImageAdjust": "GG 图像调整",
    "GGImageEffects": "GG 图像效果",
    "GGImageComparer2": "GG 图像对比 2张",
    "GGImageComparer4": "GG 图像对比 4张",
    "GGImageComparer8": "GG 图像对比 8张",
}
