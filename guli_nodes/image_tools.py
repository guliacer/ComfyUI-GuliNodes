import torch
import torch.nn.functional as torch_F
from PIL import Image, ImageDraw, ImageFont, ImageOps
from PIL.PngImagePlugin import PngInfo
import numpy as np
from nodes import PreviewImage, SaveImage
from comfy.cli_args import args
import comfy.utils
import folder_paths
import json
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    from comfy_api.latest import io
except Exception:
    io = None

def _empty_image(device=None, dtype=torch.float32) -> torch.Tensor:
    return torch.zeros([1, 64, 64, 3], device=device, dtype=dtype)


def _align_to_eight(value: int) -> int:
    return max(8, (int(value) // 8) * 8)


def _resize_image(image: torch.Tensor, height: int, width: int, mode: str) -> torch.Tensor:
    image_ch = image.permute(0, 3, 1, 2).contiguous()
    kwargs = {"size": (height, width), "mode": mode}
    if mode in ("bilinear", "bicubic"):
        kwargs.update({"align_corners": False, "antialias": True})
    resized = torch_F.interpolate(image_ch, **kwargs)
    return resized.permute(0, 2, 3, 1).contiguous()


def _channel_kernel(kernel: torch.Tensor, channels: int, image: torch.Tensor) -> torch.Tensor:
    return kernel.to(device=image.device, dtype=image.dtype).view(1, 1, 3, 3).repeat(channels, 1, 1, 1)


def _to_rgb_image(image: torch.Tensor) -> torch.Tensor:
    if image is None:
        return _empty_image()
    if image.shape[-1] == 1:
        return image.expand(*image.shape[:-1], 3).contiguous()
    if image.shape[-1] == 2:
        gray = image[..., :1].expand(*image.shape[:-1], 3)
        alpha = image[..., 1:2].clamp(0.0, 1.0)
        return torch.clamp(gray * alpha + (1.0 - alpha), 0.0, 1.0).contiguous()
    if image.shape[-1] >= 4:
        rgb = image[..., :3]
        alpha = image[..., 3:4].clamp(0.0, 1.0)
        return torch.clamp(rgb * alpha + (1.0 - alpha), 0.0, 1.0).contiguous()
    if image.shape[-1] == 3:
        return image
    return _empty_image(image.device, image.dtype)


def _pil_to_tensor(image: Image.Image, device=None, dtype=torch.float32) -> torch.Tensor:
    rgb_image = image.convert("RGB")
    array = np.asarray(rgb_image).astype(np.float32) / 255.0
    tensor = torch.from_numpy(array)
    if device is not None:
        tensor = tensor.to(device=device, dtype=dtype)
    elif dtype is not None:
        tensor = tensor.to(dtype=dtype)
    return tensor


def _resolve_output_prefix(prefix: str) -> str:
    if not isinstance(prefix, str):
        return prefix
    return prefix.replace("%date:yyyy_MM_dd%", datetime.now().strftime("%Y_%m_%d"))


def _gaussian_blur(image: torch.Tensor, kernel_size: int | None = None, sigma: float = 1.0) -> torch.Tensor:
    sigma = max(float(sigma), 0.001)
    if kernel_size is None:
        kernel_size = int(sigma * 6) + 1
    kernel_size = max(3, int(kernel_size))
    if kernel_size % 2 == 0:
        kernel_size += 1

    radius = kernel_size // 2
    coords = torch.arange(kernel_size, device=image.device, dtype=image.dtype) - radius
    kernel_1d = torch.exp(-(coords ** 2) / (2 * sigma ** 2))
    kernel_1d = kernel_1d / kernel_1d.sum()
    kernel_2d = torch.outer(kernel_1d, kernel_1d).view(1, 1, kernel_size, kernel_size)

    image_ch = image.permute(0, 3, 1, 2).contiguous()
    channels = image_ch.shape[1]
    kernel = kernel_2d.repeat(channels, 1, 1, 1)
    padded = torch_F.pad(image_ch, (radius, radius, radius, radius), mode="replicate")
    blurred = torch_F.conv2d(padded, kernel, groups=channels)
    return blurred.permute(0, 2, 3, 1).contiguous()


def _depthwise_conv3x3(image: torch.Tensor, kernel: torch.Tensor) -> torch.Tensor:
    image_ch = image.permute(0, 3, 1, 2).contiguous()
    channels = image_ch.shape[1]
    padded = torch_F.pad(image_ch, (1, 1, 1, 1), mode="replicate")
    result = torch_F.conv2d(padded, _channel_kernel(kernel, channels, image), groups=channels)
    return result.permute(0, 2, 3, 1).contiguous()


def _match_image_size(image: torch.Tensor, reference: torch.Tensor) -> torch.Tensor:
    if image.shape[1:3] == reference.shape[1:3]:
        return reference
    return _resize_image(reference, image.shape[1], image.shape[2], "bilinear")


def _adain_transfer(content: torch.Tensor, style: torch.Tensor, eps: float = 1e-5) -> torch.Tensor:
    content_ch = content.permute(0, 3, 1, 2)
    style_ch = style.permute(0, 3, 1, 2)
    content_mean = content_ch.mean(dim=(2, 3), keepdim=True)
    content_std = content_ch.std(dim=(2, 3), keepdim=True).clamp(min=eps)
    style_mean = style_ch.mean(dim=(2, 3), keepdim=True)
    style_std = style_ch.std(dim=(2, 3), keepdim=True).clamp(min=eps)
    result = (content_ch - content_mean) / content_std * style_std + style_mean
    return result.permute(0, 2, 3, 1).contiguous()


def _lab_color_transfer(content: torch.Tensor, style: torch.Tensor) -> torch.Tensor:
    # Keep this node dependency-free by using RGB channel statistics instead of OpenCV Lab conversion.
    return _adain_transfer(content, style)


def _rgb转hsl(rgb: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    最大值 = rgb.amax(dim=-1, keepdim=True)
    最小值 = rgb.amin(dim=-1, keepdim=True)
    色差 = 最大值 - 最小值
    亮度 = (最大值 + 最小值) * 0.5
    安全色差 = 色差.clamp_min(1e-8)

    红色, 绿色, 蓝色 = rgb.unbind(dim=-1)
    最大通道 = 最大值.squeeze(-1)
    色差通道 = 安全色差.squeeze(-1)
    非灰色 = 色差.squeeze(-1) > 1e-8

    红色相 = torch.remainder((绿色 - 蓝色) / 色差通道, 6.0)
    绿色相 = (蓝色 - 红色) / 色差通道 + 2.0
    蓝色相 = (红色 - 绿色) / 色差通道 + 4.0
    色相 = torch.where(
        最大通道 == 红色,
        红色相,
        torch.where(最大通道 == 绿色, 绿色相, 蓝色相),
    ) / 6.0
    色相 = torch.where(非灰色, 色相, torch.zeros_like(色相)).unsqueeze(-1)

    饱和度分母 = (1.0 - torch.abs(2.0 * 亮度 - 1.0)).clamp_min(1e-8)
    饱和度 = torch.where(色差 > 1e-8, 色差 / 饱和度分母, torch.zeros_like(色差))
    return torch.remainder(色相, 1.0), 饱和度.clamp(0.0, 1.0), 亮度


def _hsl转rgb(色相: torch.Tensor, 饱和度: torch.Tensor, 亮度: torch.Tensor) -> torch.Tensor:
    色相 = torch.remainder(色相, 1.0)
    色度上界 = torch.where(亮度 < 0.5, 亮度 * (1.0 + 饱和度), 亮度 + 饱和度 - 亮度 * 饱和度)
    色度下界 = 2.0 * 亮度 - 色度上界

    def 色相通道(偏移: torch.Tensor) -> torch.Tensor:
        偏移 = torch.remainder(偏移, 1.0)
        return torch.where(
            偏移 < 1.0 / 6.0,
            色度下界 + (色度上界 - 色度下界) * 6.0 * 偏移,
            torch.where(
                偏移 < 0.5,
                色度上界,
                torch.where(
                    偏移 < 2.0 / 3.0,
                    色度下界 + (色度上界 - 色度下界) * (2.0 / 3.0 - 偏移) * 6.0,
                    色度下界,
                ),
            ),
        )

    红色 = 色相通道(色相 + 1.0 / 3.0)
    绿色 = 色相通道(色相)
    蓝色 = 色相通道(色相 - 1.0 / 3.0)
    rgb = torch.cat([红色, 绿色, 蓝色], dim=-1)
    灰度 = 亮度.expand_as(rgb)
    return torch.where(饱和度 <= 1e-8, 灰度, rgb)


def _执行色彩校正(图像: torch.Tensor, 温度: float, 色调: float, 明度: float, 对比度: float, 饱和度: float, 伽马: float) -> torch.Tensor:
    if 图像 is None:
        return _empty_image()

    原始dtype = 图像.dtype
    if 图像.shape[-1] == 1:
        rgb = 图像.expand(*图像.shape[:-1], 3)
        额外通道 = None
    elif 图像.shape[-1] == 2:
        rgb = 图像[..., :1].expand(*图像.shape[:-1], 3)
        额外通道 = None
    else:
        rgb = 图像[..., :3]
        额外通道 = 图像[..., 3:] if 图像.shape[-1] > 3 else None

    rgb = rgb.to(dtype=torch.float32).clamp(0.0, 1.0)
    明度倍率 = max(0.0, 1.0 + float(明度) / 100.0)
    对比度倍率 = max(0.0, 1.0 + float(对比度) / 100.0)
    饱和度倍率 = max(0.0, 1.0 + float(饱和度) / 100.0)
    温度比例 = max(-1.0, min(1.0, float(温度) / 100.0))
    色调偏移 = float(色调) / 360.0
    伽马值 = max(0.001, float(伽马))

    rgb = rgb * 明度倍率
    rgb = (rgb - 0.5) * 对比度倍率 + 0.5

    if 温度比例 > 0.0:
        温度倍率 = (1.0 + 温度比例, 1.0 + 温度比例 * 0.4, 1.0)
    elif 温度比例 < 0.0:
        温度倍率 = (1.0, 1.0, 1.0 - 温度比例)
    else:
        温度倍率 = (1.0, 1.0, 1.0)
    rgb = rgb * torch.tensor(温度倍率, device=rgb.device, dtype=rgb.dtype).view(1, 1, 1, 3)

    rgb = rgb.clamp(0.0, 1.0).pow(伽马值)
    色相, 当前饱和度, 亮度 = _rgb转hsl(rgb)
    色相 = torch.remainder(色相 + 色调偏移, 1.0)
    当前饱和度 = (当前饱和度 * 饱和度倍率).clamp(0.0, 1.0)
    校正后 = _hsl转rgb(色相, 当前饱和度, 亮度).clamp(0.0, 1.0).to(dtype=原始dtype)

    if 额外通道 is not None:
        return torch.cat([校正后, 额外通道], dim=-1).contiguous()
    return 校正后.contiguous()


def concatenate_images_horizontally(images: list, labels: list = None, font_size: int = 40, border: int = 32, label_height: int = 80, spacing: int = 20) -> torch.Tensor:
    if not images:
        return None
    target_height = images[0].shape[1]
    resized = []
    for img in images:
        if img.shape[1] != target_height:
            target_width = max(1, int(img.shape[2] * target_height / img.shape[1]))
            img = _resize_image(img, target_height, target_width, "bilinear")
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


class GGImageResize:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "模式": (["按比例", "按最长边", "按最短边"], {"default": "按比例"}),
            },
            "optional": {
                "缩放比例": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 10.0, "step": 0.1}),
                "边长": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "插值方法": (["bilinear", "nearest", "bicubic"], {"default": "bilinear"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "resize"
    CATEGORY = "GuliNodes/图像"

    def resize(self, 图像: torch.Tensor, 模式: str = "按比例", 缩放比例: float = 1.0,
               边长: int = 512, 插值方法: str = "bilinear") -> tuple:
        if 图像 is None:
            return (_empty_image(),)

        if 模式 == "按比例":
            new_height = int(图像.shape[1] * 缩放比例)
            new_width = int(图像.shape[2] * 缩放比例)
        elif 模式 == "按最长边":
            src_height = 图像.shape[1]
            src_width = 图像.shape[2]
            max_dim = max(src_height, src_width)
            scale = 边长 / max_dim
            new_height = int(src_height * scale)
            new_width = int(src_width * scale)
        elif 模式 == "按最短边":
            src_height = 图像.shape[1]
            src_width = 图像.shape[2]
            min_dim = min(src_height, src_width)
            scale = 边长 / min_dim
            new_height = int(src_height * scale)
            new_width = int(src_width * scale)
        else:
            new_height = int(图像.shape[1] * 缩放比例)
            new_width = int(图像.shape[2] * 缩放比例)

        new_width = _align_to_eight(new_width)
        new_height = _align_to_eight(new_height)

        if 插值方法 == "nearest":
            mode = "nearest"
        elif 插值方法 == "bicubic":
            mode = "bicubic"
        else:
            mode = "bilinear"

        return (_resize_image(图像, new_height, new_width, mode),)


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
    CATEGORY = "GuliNodes/图像"

    def crop(self, 图像: torch.Tensor, 模式: str = "中心裁剪",
              宽度: int = 512, 高度: int = 512, X坐标: int = 0, Y坐标: int = 0,
              宽高比例: str = "16:9", 边长: int = 1024, 边长类型: str = "最长边") -> tuple:
        if 图像 is None:
            return (_empty_image(),)

        img_height, img_width = 图像.shape[1], 图像.shape[2]

        def safe_crop(x: int, y: int, width: int, height: int) -> torch.Tensor:
            width = max(1, min(int(width), img_width))
            height = max(1, min(int(height), img_height))
            x = max(0, min(int(x), img_width - width))
            y = max(0, min(int(y), img_height - height))
            return 图像[:, y:y+height, x:x+width, :].contiguous()

        if 模式 == "按比例裁剪":
            aspect_presets = {"1:1": (1, 1), "3:2": (3, 2), "4:3": (4, 3), "5:4": (5, 4), "16:9": (16, 9),
                           "21:9": (21, 9), "9:16": (9, 16), "2:3": (2, 3), "3:4": (3, 4), "4:5": (4, 5), "9:21": (9, 21)}

            wr, hr = aspect_presets[宽高比例]
            if 边长类型 == "最长边":
                target_width = 边长 if wr > hr else int(边长 * wr / hr)
                target_height = int(边长 * hr / wr) if wr > hr else 边长
            else:
                target_height = 边长 if wr > hr else int(边长 * hr / wr)
                target_width = int(边长 * wr / hr) if wr > hr else 边长

            target_width = _align_to_eight(target_width)
            target_height = _align_to_eight(target_height)

            if target_width <= img_width and target_height <= img_height:
                crop_width = target_width
                crop_height = target_height
            elif img_width * hr <= img_height * wr:
                crop_width = img_width
                crop_height = max(1, min(img_height, int(img_width * hr / wr)))
            else:
                crop_height = img_height
                crop_width = max(1, min(img_width, int(img_height * wr / hr)))

            x = (img_width - crop_width) // 2
            y = (img_height - crop_height) // 2
            cropped = safe_crop(x, y, crop_width, crop_height)

            if cropped.shape[1] != target_height or cropped.shape[2] != target_width:
                cropped = _resize_image(cropped, target_height, target_width, "bilinear")
            return (cropped,)

        elif 模式 == "中心裁剪":
            width = max(1, min(int(宽度), img_width))
            height = max(1, min(int(高度), img_height))
            x = (img_width - width) // 2
            y = (img_height - height) // 2
        else:
            width = max(1, min(int(宽度), img_width))
            height = max(1, min(int(高度), img_height))
            x = X坐标
            y = Y坐标

        cropped = safe_crop(x, y, width, height)
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
    CATEGORY = "GuliNodes/图像"

    def transform(self, 图像: torch.Tensor, 变换类型: str = "水平翻转") -> tuple:
        if 图像 is None:
            return (_empty_image(),)

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
                "亮度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.01, "round": 0.01}),
                "对比度": ("FLOAT", {"default": 1.1, "min": 0.0, "max": 5.0, "step": 0.01, "round": 0.01}),
                "饱和度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.01, "round": 0.01}),
                "锐化": ("FLOAT", {"default": 1.2, "min": 0.0, "max": 10.0, "step": 0.01, "round": 0.01}),
                "虚化": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 20.0, "step": 0.01, "round": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "adjust"
    CATEGORY = "GuliNodes/图像"

    def adjust(self, 图像: torch.Tensor, 亮度: float = 1.0,
               对比度: float = 1.0, 饱和度: float = 1.0, 锐化: float = 1.0, 虚化: float = 0.0) -> tuple:
        if 图像 is None:
            return (_empty_image(),)

        adjusted = 图像 * 亮度
        adjusted = (adjusted - 0.5) * 对比度 + 0.5

        if 饱和度 != 1.0:
            gray = adjusted.mean(dim=-1, keepdim=True)
            adjusted = gray * (1 - 饱和度) + adjusted * 饱和度

        if 虚化 > 0:
            adjusted = _gaussian_blur(adjusted, sigma=虚化)

        if 锐化 > 0:
            blur_sigma = max(0.5, min(float(锐化) * 0.6, 4.0))
            blurred = _gaussian_blur(adjusted, sigma=blur_sigma)
            adjusted = adjusted + (adjusted - blurred) * float(锐化)

        adjusted = torch.clamp(adjusted, 0.0, 1.0)

        return (adjusted,)


class GG色彩校正:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "温度": ("FLOAT", {"default": 0.0, "min": -100.0, "max": 100.0, "step": 5.0, "round": 0.01}),
                "色调": ("FLOAT", {"default": 0.0, "min": -90.0, "max": 90.0, "step": 5.0, "round": 0.01}),
                "明度": ("FLOAT", {"default": 0.0, "min": -100.0, "max": 100.0, "step": 5.0, "round": 0.01}),
                "对比度": ("FLOAT", {"default": 0.0, "min": -100.0, "max": 100.0, "step": 5.0, "round": 0.01}),
                "饱和度": ("FLOAT", {"default": 0.0, "min": -100.0, "max": 100.0, "step": 5.0, "round": 0.01}),
                "伽马": ("FLOAT", {"default": 1.0, "min": 0.2, "max": 2.2, "step": 0.1, "round": 0.01}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/图像/色彩"
    DESCRIPTION = "基于 ColorCorrect 的色彩校正节点，使用 torch 张量批量处理温度、色调、明度、对比度、饱和度和伽马。"

    def execute(self, 图像: torch.Tensor, 温度: float = 0.0, 色调: float = 0.0, 明度: float = 0.0,
                对比度: float = 0.0, 饱和度: float = 0.0, 伽马: float = 1.0) -> tuple:
        return (_执行色彩校正(图像, 温度, 色调, 明度, 对比度, 饱和度, 伽马),)


class GGImageStyleReference:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "目标图像": ("IMAGE",),
                "参考图像": ("IMAGE",),
            },
            "optional": {
                "风格强度": ("FLOAT", {"default": 0.35, "min": 0.0, "max": 2.0, "step": 0.05, "round": 0.01}),
                "色彩强度": ("FLOAT", {"default": 0.20, "min": 0.0, "max": 2.0, "step": 0.05, "round": 0.01}),
                "纹理强度": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05, "round": 0.01}),
                "保留结构": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05, "round": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "apply_style"
    CATEGORY = "GuliNodes/图像"

    def apply_style(self, 目标图像: torch.Tensor, 参考图像: torch.Tensor, 风格强度: float = 1.0,
                    色彩强度: float = 1.0, 纹理强度: float = 0.35, 保留结构: float = 0.35) -> tuple:
        content = _to_rgb_image(目标图像)
        style = _match_image_size(content, _to_rgb_image(参考图像))

        style_strength = max(0.0, min(float(风格强度), 2.0))
        color_strength = max(0.0, min(float(色彩强度), 2.0))
        texture_strength = max(0.0, min(float(纹理强度), 1.0))
        preserve_structure = max(0.0, min(float(保留结构), 1.0))

        color_transferred = _lab_color_transfer(content, style)
        stats_transferred = _adain_transfer(content, style)
        styled = content.lerp(color_transferred, min(color_strength, 1.0))
        if color_strength > 1.0:
            styled = styled + (color_transferred - content) * (color_strength - 1.0)

        styled = styled.lerp(stats_transferred, min(style_strength, 1.0))
        if style_strength > 1.0:
            styled = styled + (stats_transferred - content) * (style_strength - 1.0)

        style_low = _gaussian_blur(style, sigma=2.0)
        style_detail = style - style_low
        styled = styled + style_detail * texture_strength

        if preserve_structure > 0:
            content_low = _gaussian_blur(content, sigma=1.5)
            styled_low = _gaussian_blur(styled, sigma=1.5)
            content_detail = content - content_low
            styled = styled - (styled - styled_low) * preserve_structure + content_detail * preserve_structure

        return (torch.clamp(styled, 0.0, 1.0).contiguous(),)


class GGPreviewImage(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    FUNCTION = "preview"
    CATEGORY = "GuliNodes/图像"

    def preview(self, 图像, prompt=None, extra_pnginfo=None):
        return self.save_images(图像, filename_prefix="GG.preview", prompt=prompt, extra_pnginfo=extra_pnginfo)


_GG_RECOMMENDED_FORMAT_ATTR = "_gg_recommended_format"
_GG_COMPRESSION_METHOD_ATTR = "_gg_compression_method"
_GG_COMPRESSION_QUALITY_ATTR = "_gg_compression_quality"
_GG_TARGET_SIZE_ATTR = "_gg_target_size_kb"
_GG_SUPPORTED_SAVE_FORMATS = {"JPEG", "PNG", "WEBP"}


def _coerce_gg_format(format_name: Any) -> str | None:
    if format_name is None:
        return None
    value = str(format_name).strip()
    if not value or value == "自动":
        return None
    value = value.upper()
    if value == "JPG":
        value = "JPEG"
    return value if value in _GG_SUPPORTED_SAVE_FORMATS else None


def _normalize_gg_format(format_name: Any, default: str = "JPEG", allow_auto: bool = False) -> str:
    value = str(format_name or "").strip()
    if allow_auto and (value == "自动" or value.upper() == "AUTO"):
        return "AUTO"
    return _coerce_gg_format(value) or default


def _set_gg_image_hints(
    images: torch.Tensor,
    format_name: str,
    quality: int,
    target_size_kb: int,
    method: str,
) -> None:
    try:
        setattr(images, _GG_RECOMMENDED_FORMAT_ATTR, format_name)
        setattr(images, _GG_COMPRESSION_QUALITY_ATTR, int(quality))
        setattr(images, _GG_TARGET_SIZE_ATTR, int(target_size_kb))
        setattr(images, _GG_COMPRESSION_METHOD_ATTR, method)
    except Exception:
        pass


def _get_gg_recommended_format(images: torch.Tensor) -> str | None:
    return _coerce_gg_format(getattr(images, _GG_RECOMMENDED_FORMAT_ATTR, None))


def _get_gg_int_hint(images: torch.Tensor, attr_name: str, default: int) -> int:
    try:
        return int(getattr(images, attr_name, default))
    except Exception:
        return default


def _tensor_image_to_pil(image: torch.Tensor) -> Image.Image:
    array = np.clip(255.0 * image.detach().cpu().numpy(), 0, 255).astype(np.uint8)
    if array.ndim == 2:
        return Image.fromarray(array, mode="L")

    channels = array.shape[-1] if array.ndim == 3 else 1
    if channels == 1:
        return Image.fromarray(array[..., 0], mode="L")
    if channels == 2:
        return Image.fromarray(array[..., :2], mode="LA")
    if channels == 3:
        return Image.fromarray(array[..., :3], mode="RGB")
    return Image.fromarray(array[..., :4], mode="RGBA")


def _prepare_pil_for_format(pil_image: Image.Image, format_name: str) -> Image.Image:
    if format_name == "JPEG":
        if pil_image.mode in ("RGBA", "LA") or (pil_image.mode == "P" and "transparency" in pil_image.info):
            rgba = pil_image.convert("RGBA")
            background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            background.alpha_composite(rgba)
            return background.convert("RGB")
        return pil_image.convert("RGB")

    if format_name == "WEBP":
        if pil_image.mode in ("RGBA", "RGB"):
            return pil_image
        if pil_image.mode == "LA" or (pil_image.mode == "P" and "transparency" in pil_image.info):
            return pil_image.convert("RGBA")
        return pil_image.convert("RGB")

    return pil_image


class GGSaveImage(SaveImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "文件名前缀": ("STRING", {"default": "%date:yyyy_MM_dd%/图像"}),
                "格式": (["JPEG", "PNG", "WEBP", "自动"], {"default": "JPEG"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    FUNCTION = "save"
    CATEGORY = "GuliNodes/图像"
    OUTPUT_NODE = True

    def save(self, 图像, 文件名前缀="%date:yyyy_MM_dd%/图像", 格式="自动", prompt=None, extra_pnginfo=None):
        resolved_prefix = _resolve_output_prefix(文件名前缀) + self.prefix_append
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            resolved_prefix,
            self.output_dir,
            图像[0].shape[1],
            图像[0].shape[0],
        )

        quality = max(1, min(_get_gg_int_hint(图像, _GG_COMPRESSION_QUALITY_ATTR, 95), 100))
        target_size_kb = max(0, _get_gg_int_hint(图像, _GG_TARGET_SIZE_ATTR, 0))
        requested_format = _normalize_gg_format(格式, default="AUTO", allow_auto=True)
        results = []

        for batch_number, image in enumerate(图像):
            format_name = self._select_format(图像, image, requested_format)
            pil_image = _tensor_image_to_pil(image)
            filename_with_batch_num = filename.replace("%batch_num%", str(batch_number))
            file = f"{filename_with_batch_num}_{counter:05}_.{self._extension(format_name)}"
            output_path = os.path.join(full_output_folder, file)
            self._save_encoded_image(
                pil_image,
                output_path,
                format_name,
                quality,
                target_size_kb,
                prompt,
                extra_pnginfo,
            )
            results.append({
                "filename": file,
                "subfolder": subfolder,
                "type": self.type,
            })
            counter += 1

        return {"ui": {"images": results}}

    def _select_format(self, images: torch.Tensor, image: torch.Tensor, requested_format: str) -> str:
        if requested_format != "AUTO":
            return requested_format
        recommended_format = _get_gg_recommended_format(images)
        if recommended_format is not None:
            return recommended_format
        return self._choose_auto_format(image)

    @staticmethod
    def _choose_auto_format(image: torch.Tensor) -> str:
        if image.shape[-1] >= 4:
            alpha = image[..., 3]
            try:
                if bool(torch.any(alpha < 0.999).item()):
                    return "PNG"
            except Exception:
                return "PNG"

        try:
            cpu_image = (image.detach().cpu().clamp(0.0, 1.0) * 255.0).to(torch.uint8)
            colors = cpu_image.reshape(-1, cpu_image.shape[-1])[:, :3]
            if colors.shape[0] > 32768:
                step = max(1, colors.shape[0] // 32768)
                colors = colors[::step][:32768]
            if torch.unique(colors, dim=0).shape[0] <= 256:
                return "PNG"
        except Exception:
            pass

        return "JPEG"

    @staticmethod
    def _extension(format_name: str) -> str:
        return {"WEBP": "webp", "JPEG": "jpg", "PNG": "png"}.get(format_name, "jpg")

    @staticmethod
    def _png_metadata(prompt=None, extra_pnginfo=None) -> PngInfo | None:
        if args.disable_metadata:
            return None
        metadata = PngInfo()
        if prompt is not None:
            metadata.add_text("prompt", json.dumps(prompt))
        if extra_pnginfo is not None:
            for key in extra_pnginfo:
                metadata.add_text(key, json.dumps(extra_pnginfo[key]))
        return metadata

    def _save_encoded_image(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int = 0,
        prompt=None,
        extra_pnginfo=None,
    ) -> None:
        if target_size_kb > 0 and format_name in ("JPEG", "WEBP"):
            self._save_target_size(pil_image, output_path, format_name, quality, target_size_kb)
            return

        save_image = _prepare_pil_for_format(pil_image, format_name)
        if format_name == "PNG":
            save_image.save(
                output_path,
                format="PNG",
                pnginfo=self._png_metadata(prompt, extra_pnginfo),
                compress_level=self.compress_level,
            )
        elif format_name == "WEBP":
            save_image.save(output_path, format="WEBP", quality=quality, method=6, optimize=True)
        else:
            save_image.save(
                output_path,
                format="JPEG",
                quality=quality,
                optimize=True,
                progressive=True,
                subsampling=0 if quality >= 90 else "4:2:0",
            )

    def _save_target_size(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int,
    ) -> None:
        target_bytes = max(1, int(target_size_kb)) * 1024

        def save_once(path: str, current_quality: int) -> None:
            self._save_encoded_image(pil_image, path, format_name, current_quality, 0)

        _save_target_size_by_quality(
            output_path,
            format_name,
            target_bytes,
            quality,
            save_once,
            iterations=8,
        )


def _save_target_size_by_quality(
    output_path: str,
    format_name: str,
    target_bytes: int,
    max_quality: int,
    save_once,
    iterations: int = 8,
) -> None:
    low, high = 1, max(1, min(int(max_quality), 100))
    best_data = None

    for _ in range(iterations):
        current_quality = (low + high) // 2
        with tempfile.NamedTemporaryFile(suffix="." + GGImageCompress._extension(format_name), delete=False) as temp_file:
            temp_path = temp_file.name
        try:
            save_once(temp_path, current_quality)
            size = os.path.getsize(temp_path)
            with open(temp_path, "rb") as handle:
                data = handle.read()
            if size <= target_bytes:
                best_data = data
                low = current_quality + 1
            else:
                high = current_quality - 1
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    if best_data is None:
        save_once(output_path, 1)
        return

    with open(output_path, "wb") as handle:
        handle.write(best_data)


class GGImageCompressSave(GGSaveImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "文件名前缀": ("STRING", {"default": "%date:yyyy_MM_dd%/图像"}),
                "格式": (["JPEG", "PNG", "WEBP", "自动"], {"default": "JPEG"}),
                "压缩模式": (["civilblur", "Caesium", "meowtec"], {"default": "civilblur"}),
                "质量": ("INT", {"default": 85, "min": 1, "max": 100, "step": 1}),
                "目标大小KB": ("INT", {"default": 0, "min": 0, "max": 1048576, "step": 16}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    FUNCTION = "save"
    CATEGORY = "GuliNodes/图像"
    OUTPUT_NODE = True

    def save(
        self,
        图像,
        文件名前缀="%date:yyyy_MM_dd%/图像",
        格式="JPEG",
        压缩模式="civilblur",
        质量=85,
        目标大小KB=0,
        prompt=None,
        extra_pnginfo=None,
    ):
        resolved_prefix = _resolve_output_prefix(文件名前缀) + self.prefix_append
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            resolved_prefix,
            self.output_dir,
            图像[0].shape[1],
            图像[0].shape[0],
        )

        compressor = GGImageCompress()
        method = compressor._normalize_method(压缩模式)
        quality = max(1, min(int(质量), 100))
        target_size_kb = max(0, int(目标大小KB))
        requested_format = _normalize_gg_format(格式, default="AUTO", allow_auto=True)
        results = []

        for batch_number, image in enumerate(图像):
            format_name = self._select_compressed_format(
                图像,
                image,
                requested_format,
                method,
                target_size_kb,
            )
            pil_image = _prepare_pil_for_format(_tensor_image_to_pil(image), format_name)
            filename_with_batch_num = filename.replace("%batch_num%", str(batch_number))
            file = f"{filename_with_batch_num}_{counter:05}_.{self._extension(format_name)}"
            output_path = os.path.join(full_output_folder, file)
            compressor._save_by_method(
                pil_image,
                output_path,
                format_name,
                quality,
                target_size_kb,
                method,
            )
            results.append({
                "filename": file,
                "subfolder": subfolder,
                "type": self.type,
            })
            counter += 1

        return {"ui": {"images": results}}

    def _select_compressed_format(
        self,
        images: torch.Tensor,
        image: torch.Tensor,
        requested_format: str,
        method: str,
        target_size_kb: int,
    ) -> str:
        if requested_format != "AUTO":
            return requested_format
        recommended_format = _get_gg_recommended_format(images)
        if recommended_format is not None:
            return recommended_format
        return GGImageCompress._preferred_format(method, target_size_kb)


class GGImageCompress:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "压缩方式": (["civilblur", "Caesium", "meowtec"], {"default": "civilblur"}),
                "质量": ("INT", {"default": 85, "min": 1, "max": 100, "step": 1}),
                "目标大小KB": ("INT", {"default": 0, "min": 0, "max": 1048576, "step": 16}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "compress"
    CATEGORY = "GuliNodes/图像"
    OUTPUT_NODE = False

    def compress(self, 图像, 压缩方式="civilblur", 质量=85, 目标大小KB=0):
        return self._compress_with_method(图像, 压缩方式, 质量, 目标大小KB)

    def _compress_with_method(
        self,
        图像: torch.Tensor,
        压缩方式: str,
        质量: int = 85,
        目标大小KB: int = 0,
        preferred_format: str | None = None,
    ) -> tuple:
        method = self._normalize_method(压缩方式)
        quality = max(1, min(int(质量), 100))
        target_size_kb = max(0, int(目标大小KB))
        output_format = preferred_format or self._preferred_format(method, target_size_kb)
        output_images = []

        for image in 图像:
            pil_image = _prepare_pil_for_format(_tensor_image_to_pil(image), output_format)

            def save_callback(output_path: str, current_image=pil_image) -> None:
                self._save_by_method(
                    current_image,
                    output_path,
                    output_format,
                    quality,
                    target_size_kb,
                    method,
                )

            output_images.append(self._compress_with_tempfile(image, output_format, save_callback))

        image_result = torch.stack(output_images, dim=0).contiguous()
        _set_gg_image_hints(image_result, output_format, quality, target_size_kb, method)
        return (image_result,)

    @staticmethod
    def _normalize_method(method: str) -> str:
        value = str(method or "civilblur").strip().lower()
        if value in ("caesium", "cesium"):
            return "caesium"
        if value in ("meowtec", "meow"):
            return "meowtec"
        return "civilblur"

    @staticmethod
    def _preferred_format(method: str, target_size_kb: int) -> str:
        if method == "meowtec":
            return "WEBP"
        if method == "caesium" and target_size_kb > 0:
            return "WEBP"
        return "JPEG"

    @staticmethod
    def _extension(format_name: str) -> str:
        return {"WEBP": "webp", "JPEG": "jpg", "PNG": "png"}.get(format_name, "jpg")

    def _save_by_method(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int,
        method: str,
    ) -> None:
        if method == "caesium":
            self._save_caesium_style(pil_image, output_path, format_name, quality, target_size_kb)
        elif method == "meowtec":
            self._save_meowtec_style(pil_image, output_path, format_name, quality, target_size_kb)
        else:
            self._save_civilblur_style(pil_image, output_path, format_name, quality, target_size_kb)

    def _save_meowtec_style(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int,
    ) -> None:
        pil_image.info.clear()
        if target_size_kb > 0 and format_name in ("JPEG", "WEBP"):
            target_bytes = max(1, int(target_size_kb)) * 1024
            _save_target_size_by_quality(
                output_path,
                format_name,
                target_bytes,
                quality,
                lambda path, current_quality: self._save_meowtec_style(pil_image, path, format_name, current_quality, 0),
                iterations=7,
            )
            return
        self._save_single_pass(pil_image, output_path, format_name, quality)

    def _save_caesium_style(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int,
    ) -> None:
        pil_image.info.clear()
        if target_size_kb > 0 and format_name in ("JPEG", "WEBP"):
            target_bytes = max(1, int(target_size_kb)) * 1024
            _save_target_size_by_quality(
                output_path,
                format_name,
                target_bytes,
                quality,
                lambda path, current_quality: self._save_caesium_style(pil_image, path, format_name, current_quality, 0),
                iterations=7,
            )
            return

        if format_name == "JPEG":
            pil_image.convert("RGB").save(
                output_path,
                format="JPEG",
                quality=quality,
                optimize=True,
                progressive=True,
                subsampling=0 if quality >= 90 else "4:2:0",
            )
            return

        self._save_single_pass(pil_image, output_path, format_name, quality)

    def _save_civilblur_style(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int,
    ) -> None:
        pil_image.info.clear()
        if target_size_kb > 0 and format_name in ("WEBP", "JPEG"):
            target_bytes = max(1, int(target_size_kb)) * 1024
            _save_target_size_by_quality(
                output_path,
                format_name,
                target_bytes,
                quality,
                lambda path, current_quality: self._save_single_pass(pil_image, path, format_name, current_quality),
                iterations=8,
            )
            return

        self._save_single_pass(pil_image, output_path, format_name, quality)

    def _save_single_pass(self, pil_image: Image.Image, output_path: str, format_name: str, quality: int) -> None:
        save_image = _prepare_pil_for_format(pil_image, format_name)
        if format_name == "WEBP":
            save_image.save(output_path, format="WEBP", quality=quality, method=6, optimize=True)
        elif format_name == "PNG":
            save_image.save(output_path, format="PNG", optimize=True, compress_level=9)
        else:
            save_image.convert("RGB").save(
                output_path,
                format="JPEG",
                quality=quality,
                optimize=True,
                progressive=True,
                subsampling=0 if quality >= 90 else "4:2:0",
            )

    def _compress_with_tempfile(self, source_image: torch.Tensor, format_name: str, save_callback) -> torch.Tensor:
        suffix = "." + self._extension(format_name)
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
            temp_path = temp_file.name
        try:
            return self._compress_to_path(source_image, temp_path, save_callback)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    def _compress_to_path(self, source_image: torch.Tensor, output_path: str, save_callback) -> torch.Tensor:
        save_callback(output_path)
        with Image.open(output_path) as saved_image:
            return _pil_to_tensor(saved_image, device=source_image.device, dtype=source_image.dtype)


class ImageComparerBase:
    @classmethod
    def get_default_inputs(cls):
        return {
            "required": {},
            "optional": {
                "字体大小": ("INT", {"default": 40, "min": 20, "max": 120, "step": 2}),
                "边框宽度": ("INT", {"default": 32, "min": 0, "max": 80, "step": 2}),
                "标签高度": ("INT", {"default": 80, "min": 50, "max": 200, "step": 2}),
                "图像间距": ("INT", {"default": 20, "min": 0, "max": 100, "step": 2}),
            }
        }

    @classmethod
    def create_image_inputs(cls, count: int) -> tuple:
        inputs = {}
        labels = {}
        for i in range(count):
            char = chr(65 + i)
            inputs[f"图像_{char}"] = ("IMAGE",)
            labels[f"标签_{char}"] = ("STRING", {"default": f"图像 {char}"})
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
    CATEGORY = "GuliNodes/图像"

    def compare(self, 图像_A: torch.Tensor = None, 图像_B: torch.Tensor = None, 图像_C: torch.Tensor = None, 图像_D: torch.Tensor = None,
                标签_A: str = "图像 A", 标签_B: str = "图像 B", 标签_C: str = "图像 C", 标签_D: str = "图像 D",
                字体大小: int = 40, 边框宽度: int = 32, 标签高度: int = 80, 图像间距: int = 20, **kwargs) -> tuple:
        images = [img for img in [图像_A, 图像_B, 图像_C, 图像_D] if img is not None]
        labels = [标签_A, 标签_B, 标签_C, 标签_D][:len(images)]
        if len(images) < 2:
            return (图像_A or 图像_B or 图像_C or 图像_D,)
        return (concatenate_images_horizontally(images, labels, 字体大小, 边框宽度, 标签高度, 图像间距),)


class GGImageComparer2(PreviewImage):
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "图像_A": ("IMAGE",),
                "图像_B": ("IMAGE",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO"
            }
        }

    FUNCTION = "compare"
    CATEGORY = "GuliNodes/图像"

    def compare(self, 图像_A: torch.Tensor, 图像_B: torch.Tensor,
                filename_prefix="GG.compare.",
                prompt=None, extra_pnginfo=None) -> dict:
        result = {"ui": {"a_images": [], "b_images": []}}
        if 图像_A is not None and len(图像_A) > 0:
            result["ui"]["a_images"] = self._save_compare_images(
                图像_A, f"{filename_prefix}a_", "JPEG", prompt, extra_pnginfo
            )
        if 图像_B is not None and len(图像_B) > 0:
            result["ui"]["b_images"] = self._save_compare_images(
                图像_B, f"{filename_prefix}b_", "JPEG", prompt, extra_pnginfo
            )
        return result

    def _save_compare_images(
        self,
        images: torch.Tensor,
        filename_prefix: str,
        format_value="JPEG",
        prompt=None,
        extra_pnginfo=None,
    ) -> list[dict[str, str]]:
        resolved_prefix = _resolve_output_prefix(filename_prefix) + self.prefix_append
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            resolved_prefix,
            self.output_dir,
            images[0].shape[1],
            images[0].shape[0],
        )

        requested_format = _normalize_gg_format(format_value, default="JPEG", allow_auto=True)
        quality = max(1, min(_get_gg_int_hint(images, _GG_COMPRESSION_QUALITY_ATTR, 95), 100))
        target_size_kb = max(0, _get_gg_int_hint(images, _GG_TARGET_SIZE_ATTR, 0))
        results = []

        for batch_number, image in enumerate(images):
            format_name = self._select_compare_format(images, image, requested_format)
            pil_image = _tensor_image_to_pil(image)
            filename_with_batch_num = filename.replace("%batch_num%", str(batch_number))
            file = f"{filename_with_batch_num}_{counter:05}_.{GGSaveImage._extension(format_name)}"
            output_path = os.path.join(full_output_folder, file)
            self._save_compare_image(
                pil_image,
                output_path,
                format_name,
                quality,
                target_size_kb,
                prompt,
                extra_pnginfo,
            )
            results.append({
                "filename": file,
                "subfolder": subfolder,
                "type": self.type,
            })
            counter += 1

        return results

    @staticmethod
    def _select_compare_format(images: torch.Tensor, image: torch.Tensor, requested_format: str) -> str:
        if requested_format != "AUTO":
            return requested_format
        recommended_format = _get_gg_recommended_format(images)
        if recommended_format is not None:
            return recommended_format
        return GGSaveImage._choose_auto_format(image)

    def _save_compare_image(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int = 0,
        prompt=None,
        extra_pnginfo=None,
    ) -> None:
        if target_size_kb > 0 and format_name in ("JPEG", "WEBP"):
            target_bytes = max(1, int(target_size_kb)) * 1024
            _save_target_size_by_quality(
                output_path,
                format_name,
                target_bytes,
                quality,
                lambda path, current_quality: self._save_compare_image(
                    pil_image,
                    path,
                    format_name,
                    current_quality,
                    0,
                    prompt,
                    extra_pnginfo,
                ),
                iterations=8,
            )
            return

        save_image = _prepare_pil_for_format(pil_image, format_name)
        if format_name == "PNG":
            save_image.save(
                output_path,
                format="PNG",
                pnginfo=GGSaveImage._png_metadata(prompt, extra_pnginfo),
                compress_level=self.compress_level,
            )
        elif format_name == "WEBP":
            save_image.save(output_path, format="WEBP", quality=quality, method=6, optimize=True)
        else:
            save_image.save(
                output_path,
                format="JPEG",
                quality=quality,
                optimize=True,
                progressive=True,
                subsampling=0 if quality >= 90 else "4:2:0",
            )


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
    CATEGORY = "GuliNodes/图像"

    def compare(self, **kwargs) -> tuple:
        images = [kwargs.get(f"图像_{chr(65 + i)}") for i in range(8)]
        images = [img for img in images if img is not None]
        labels = [kwargs.get(f"标签_{chr(65 + i)}", f"图像 {chr(65 + i)}") for i in range(8)][:len(images)]
        font_size = kwargs.get("字体大小", 40)
        border = kwargs.get("边框宽度", 32)
        label_height = kwargs.get("标签高度", 80)
        spacing = kwargs.get("图像间距", 20)
        if len(images) < 2:
            return (images[0] if images else None,)
        return (concatenate_images_horizontally(images, labels, font_size, border, label_height, spacing),)


_缩放方法选项 = ["nearest-exact", "bilinear", "lanczos", "area", "bicubic"]

class GG图像缩放:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "Latent": ("LATENT",),
                "VAE": ("VAE",),
                "缩放方法": (_缩放方法选项[:], {"default": "lanczos"}),
                "缩放倍率": ("FLOAT", {"default": 1.5, "min": 0.1, "max": 10000.0, "step": 0.05}),
                "分块VAE": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "放大模型": ("UPSCALE_MODEL",),
            },
        }

    RETURN_TYPES = ("LATENT", "IMAGE")
    RETURN_NAMES = ("Latent", "预览图像")
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/潜空间"

    def execute(self, Latent, VAE, 缩放方法="lanczos", 缩放倍率=1.5, 分块VAE=False, 放大模型=None):
        倍率 = max(0.1, float(缩放倍率))
        原始图像 = VAE.decode(Latent["samples"])
        if len(原始图像.shape) == 5:
            原始图像 = 原始图像.reshape(-1, 原始图像.shape[-3], 原始图像.shape[-2], 原始图像.shape[-1])

        if 放大模型 is not None:
            from nodes import NODE_CLASS_MAPPINGS as _NCM
            _upscale_cls = _NCM.get("ImageUpscaleWithModel")
            if _upscale_cls is not None:
                _upscaler = _upscale_cls()
                当前宽度 = 原始图像.shape[3]
                目标宽度 = int(当前宽度 * 倍率)
                while 原始图像.shape[3] < 目标宽度:
                    if hasattr(_upscaler, "execute"):
                        原始图像 = _upscaler.execute(放大模型, 原始图像)[0]
                    else:
                        原始图像 = _upscaler.upscale(放大模型, 原始图像)[0]
                    if 原始图像.shape[3] == 当前宽度:
                        break
                    当前宽度 = 原始图像.shape[3]

        原始高度 = 原始图像.shape[2]
        原始宽度 = 原始图像.shape[3]
        目标高度 = max(1, round(原始高度 * 倍率))
        目标宽度 = max(1, round(原始宽度 * 倍率))

        缩放后 = 原始图像.movedim(-1, 1)
        缩放后 = comfy.utils.common_upscale(缩放后, 目标宽度, 目标高度, 缩放方法, "disabled")
        缩放后 = 缩放后.movedim(1, -1)

        新Latent = VAE.encode(缩放后)
        return ({"samples": 新Latent}, 缩放后)


class GG图像尺寸读取:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("宽度", "高度")
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/图像"

    def execute(self, 图像):
        _, 高度, 宽度, _ = 图像.shape
        return (宽度, 高度)


if io is not None:

    class GG图像缩放_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GG图像缩放",
                display_name="GG 图像缩放",
                category="GuliNodes/潜空间",
                description=(
                    "在像素空间中对 Latent 进行高质量缩放。"
                    "先将潜空间解码为像素图像，按指定倍率和算法缩放后，再编码回潜空间。"
                    "支持可选的放大模型增强和分块 VAE 编解码以节省显存。"
                ),
                inputs=[
                    io.Latent.Input("Latent"),
                    io.Vae.Input("VAE"),
                    io.Combo.Input("缩放方法", options=_缩放方法选项, default="lanczos"),
                    io.Float.Input("缩放倍率", default=1.5, min=0.1, max=10000.0, step=0.05),
                    io.Boolean.Input("分块VAE", default=False),
                    io.UpscaleModel.Input("放大模型", optional=True),
                ],
                outputs=[
                    io.Latent.Output(display_name="Latent"),
                    io.Image.Output(display_name="预览图像"),
                ],
            )

        @classmethod
        def execute(cls, Latent, VAE, 缩放方法="lanczos", 缩放倍率=1.5, 分块VAE=False, 放大模型=None):
            倍率 = max(0.1, float(缩放倍率))
            原始图像 = VAE.decode(Latent["samples"])
            if len(原始图像.shape) == 5:
                原始图像 = 原始图像.reshape(-1, 原始图像.shape[-3], 原始图像.shape[-2], 原始图像.shape[-1])

            if 放大模型 is not None:
                from nodes import NODE_CLASS_MAPPINGS as _NCM
                _upscale_cls = _NCM.get("ImageUpscaleWithModel")
                if _upscale_cls is not None:
                    _upscaler = _upscale_cls()
                    当前宽度 = 原始图像.shape[3]
                    目标宽度 = int(当前宽度 * 倍率)
                    while 原始图像.shape[3] < 目标宽度:
                        if hasattr(_upscaler, "execute"):
                            原始图像 = _upscaler.execute(放大模型, 原始图像)[0]
                        else:
                            原始图像 = _upscaler.upscale(放大模型, 原始图像)[0]
                        if 原始图像.shape[3] == 当前宽度:
                            break
                        当前宽度 = 原始图像.shape[3]

            原始高度 = 原始图像.shape[2]
            原始宽度 = 原始图像.shape[3]
            目标高度 = max(1, round(原始高度 * 倍率))
            目标宽度 = max(1, round(原始宽度 * 倍率))

            缩放后 = 原始图像.movedim(-1, 1)
            缩放后 = comfy.utils.common_upscale(缩放后, 目标宽度, 目标高度, 缩放方法, "disabled")
            缩放后 = 缩放后.movedim(1, -1)

            新Latent = VAE.encode(缩放后)
            return io.NodeOutput({"samples": 新Latent}, extra_outputs=[缩放后])

    GG图像缩放 = GG图像缩放_V3

    class GG图像尺寸读取_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GG图像尺寸读取",
                display_name="GG 图像尺寸读取",
                category="GuliNodes/图像",
                inputs=[
                    io.Image.Input("图像"),
                ],
                outputs=[
                    io.Int.Output("宽度"),
                    io.Int.Output("高度"),
                ],
            )

        @classmethod
        def execute(cls, 图像):
            _, 高度, 宽度, _ = 图像.shape
            return io.NodeOutput(宽度, 高度)

    GG图像尺寸读取 = GG图像尺寸读取_V3

    class GG色彩校正_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GG色彩校正",
                display_name="GG 色彩校正",
                category="GuliNodes/图像/色彩",
                description=(
                    "基于 ColorCorrect 的色彩校正节点。"
                    "使用 torch 张量批量处理温度、色调、明度、对比度、饱和度和伽马，"
                    "避免逐张图像转 PIL/OpenCV。"
                ),
                inputs=[
                    io.Image.Input("图像"),
                    io.Float.Input("温度", default=0.0, min=-100.0, max=100.0, step=5.0, round=0.01),
                    io.Float.Input("色调", default=0.0, min=-90.0, max=90.0, step=5.0, round=0.01),
                    io.Float.Input("明度", default=0.0, min=-100.0, max=100.0, step=5.0, round=0.01),
                    io.Float.Input("对比度", default=0.0, min=-100.0, max=100.0, step=5.0, round=0.01),
                    io.Float.Input("饱和度", default=0.0, min=-100.0, max=100.0, step=5.0, round=0.01),
                    io.Float.Input("伽马", default=1.0, min=0.2, max=2.2, step=0.1, round=0.01),
                ],
                outputs=[
                    io.Image.Output("图像"),
                ],
                search_aliases=["ColorCorrect", "color correct", "颜色校正", "色彩调整"],
            )

        @classmethod
        def execute(cls, 图像, 温度=0.0, 色调=0.0, 明度=0.0, 对比度=0.0, 饱和度=0.0, 伽马=1.0):
            return io.NodeOutput(_执行色彩校正(图像, 温度, 色调, 明度, 对比度, 饱和度, 伽马))

    GG色彩校正 = GG色彩校正_V3


NODE_CLASS_MAPPINGS = {
    "GGImageResize": GGImageResize,
    "GGImageCrop": GGImageCrop,
    "GGImageTransform": GGImageTransform,
    "GGImageAdjust": GGImageAdjust,
    "GG色彩校正": GG色彩校正,
    "GGImageStyleReference": GGImageStyleReference,
    "GGPreviewImage": GGPreviewImage,
    "GGSaveImage": GGSaveImage,
    "GGImageCompressSave": GGImageCompressSave,
    "GGImageCompress": GGImageCompress,
    "GGImageComparer2": GGImageComparer2,
    "GGImageComparer4": GGImageComparer4,
    "GGImageComparer8": GGImageComparer8,
    "GG图像缩放": GG图像缩放,
    "GG图像尺寸读取": GG图像尺寸读取,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGImageResize": "GG 尺寸调整",
    "GGImageCrop": "GG 图像裁剪",
    "GGImageTransform": "GG 图像变换",
    "GGImageAdjust": "GG 图像调整",
    "GG色彩校正": "GG 色彩校正",
    "GGImageStyleReference": "GG 风格参考",
    "GGPreviewImage": "GG 图像预览",
    "GGSaveImage": "GG 图像保存",
    "GGImageCompressSave": "GG 图像压缩保存",
    "GGImageCompress": "GG 图像压缩",
    "GGImageComparer2": "GG 图像对比 2张",
    "GGImageComparer4": "GG 图像对比 4张",
    "GGImageComparer8": "GG 图像对比 8张",
    "GG图像缩放": "GG 图像缩放",
    "GG图像尺寸读取": "GG 图像尺寸读取",
}
