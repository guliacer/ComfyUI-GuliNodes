import torch
import torch.nn.functional as torch_F
from PIL import Image, ImageDraw, ImageFont, ImageOps
from PIL.PngImagePlugin import PngInfo
import numpy as np
import math
from collections import Counter
from nodes import PreviewImage, SaveImage
from comfy.cli_args import args
import comfy.utils
import folder_paths
import base64
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

# 比例表与按比例算宽高的逻辑统一放在 aspect_ratio，避免与 GG Latent / GG 图像宽高 /
# GG 遮罩裁剪 各存一份、日后漂移。
from .aspect_ratio import (
    ASPECT_PRESETS,
    ASPECT_RATIOS,
    LATENT_ASPECT_RATIOS,
    ORIENTATION_TYPES,
    RESOLUTION_OPTIONS,
    SIDE_TYPES,
    _unpack_mode,
    apply_orientation,
    dimensions_by_ratio,
    dimensions_by_resolution,
)

def _empty_image(device=None, dtype=torch.float32) -> torch.Tensor:
    return torch.zeros([1, 64, 64, 3], device=device, dtype=dtype)


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


def _统一图像通道(图像: torch.Tensor, 目标通道数: int) -> torch.Tensor:
    """把单张图像统一到目标通道数：RGB(3)↔RGBA(4) 互转，灰度/双通道先扩到 3 通道。
    补 alpha 时用不透明（1.0）；RGBA→RGB 直接取前三通道。"""
    当前通道数 = int(图像.shape[-1])
    if 当前通道数 == 目标通道数:
        return 图像
    # 灰度(1) / 双通道(2) 先扩到 3 通道，复用第 0 通道
    if 当前通道数 < 3:
        图像 = 图像[..., :1].expand(*图像.shape[:-1], 3)
        当前通道数 = 3
        if 当前通道数 == 目标通道数:
            return 图像.contiguous()
    if 当前通道数 == 3 and 目标通道数 == 4:
        alpha = torch.ones(tuple(图像.shape[:-1]) + (1,), dtype=图像.dtype, device=图像.device)
        return torch.cat([图像, alpha], dim=-1).contiguous()
    if 当前通道数 >= 4 and 目标通道数 == 3:
        return 图像[..., :3].contiguous()
    return 图像


def concatenate_images_horizontally(images: list, labels: list = None, font_size: int = 40, border: int = 32, label_height: int = 80, spacing: int = 20) -> torch.Tensor:
    if not images:
        return None
    # 统一通道数：取所有图像中的最大通道数（RGB=3 / RGBA=4），通道数少的补不透明 alpha。
    # 否则 torch.cat 在宽度维度拼接时，channel 维度不一致会报错（如 RGBA 图遇到写死 3 通道的间隔条）。
    目标通道数 = max(int(img.shape[-1]) for img in images)
    images = [
        _统一图像通道(img, 目标通道数) if int(img.shape[-1]) != 目标通道数 else img
        for img in images
    ]
    target_height = images[0].shape[1]
    resized = []
    for img in images:
        if img.shape[1] != target_height:
            target_width = max(1, int(img.shape[2] * target_height / img.shape[1]))
            img = _resize_image(img, target_height, target_width, "bilinear")
        resized.append(img)
    if spacing > 0:
        gap = torch.ones(
            (images[0].shape[0], target_height, spacing, 目标通道数),
            dtype=images[0].dtype,
            device=images[0].device,
        )
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
    # 标签画布通道跟随拼接结果：RGBA 输入用 RGBA 画布，避免 alpha 被丢弃
    画布模式 = "RGBA" if C == 4 else "RGB"
    背景色 = (255, 255, 255, 255) if C == 4 else (255, 255, 255)
    描边色 = (255, 255, 255, 255) if C == 4 else (255, 255, 255)
    文字色 = (0, 0, 0, 255) if C == 4 else (0, 0, 0)
    new_img = Image.new(画布模式, (W, H + label_height), 背景色)
    new_img.paste(pil_img, (0, 0))
    draw = ImageDraw.Draw(new_img)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", font_size)
    except Exception:
        font = ImageFont.load_default()
    sub_width = W // len(labels)
    for i, text in enumerate(labels):
        x = i * sub_width + sub_width // 2
        # 先画白描边白字做描边底，再叠黑字，保证文字在任意背景上可读
        draw.text((x, H + label_height // 2), text, fill=描边色, font=font, anchor="mm", stroke_width=4, stroke_fill=描边色)
        draw.text((x, H + label_height // 2), text, fill=文字色, font=font, anchor="mm")
    final_np = np.array(new_img).astype(np.float32) / 255.0
    return torch.from_numpy(final_np).unsqueeze(0)


def _do_crop(图像: torch.Tensor, 模式: str = "中心裁剪",
             宽度: int = 512, 高度: int = 512, X坐标: int = 0, Y坐标: int = 0,
             宽高比例: str = "16:9", 边长: int = 1024, 边长类型: str = "最长边",
             画面方向: str = "横屏", 分辨率: str = "1K") -> torch.Tensor:
    if 图像 is None:
        return _empty_image()

    img_height, img_width = 图像.shape[1], 图像.shape[2]

    def safe_crop(x: int, y: int, width: int, height: int) -> torch.Tensor:
        width = max(1, min(int(width), img_width))
        height = max(1, min(int(height), img_height))
        x = max(0, min(int(x), img_width - width))
        y = max(0, min(int(y), img_height - height))
        return 图像[:, y:y+height, x:x+width, :].contiguous()

    if 模式 in ("按比例裁剪", "按K数分辨率"):
        # 宽高比例不合法时由 dimensions_by_* 抛中文错误。
        if 模式 == "按K数分辨率":
            target_width, target_height = dimensions_by_resolution(宽高比例, 分辨率, 画面方向)
            wr, hr = ASPECT_PRESETS[宽高比例]
            wr, hr = apply_orientation(wr, hr, 画面方向)
        else:
            # 「按比例裁剪」没有画面方向参数，按比例字面值算，不摆正方向。
            target_width, target_height = dimensions_by_ratio(宽高比例, 边长, 边长类型, None)
            wr, hr = ASPECT_PRESETS[宽高比例]

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
        return cropped

    if 模式 == "中心裁剪":
        width = max(1, min(int(宽度), img_width))
        height = max(1, min(int(高度), img_height))
        x = (img_width - width) // 2
        y = (img_height - height) // 2
    else:
        width = max(1, min(int(宽度), img_width))
        height = max(1, min(int(高度), img_height))
        x = X坐标
        y = Y坐标

    return safe_crop(x, y, width, height)


def _unpack_crop_mode(value):
    if isinstance(value, dict):
        nested = value.get("模式")
        if isinstance(nested, dict):
            return nested.get("模式", "中心裁剪"), nested
        return nested or "中心裁剪", value
    return value or "中心裁剪", {}


class GGImageCrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "模式": (["中心裁剪", "手动裁剪", "按比例裁剪", "按K数分辨率"], {"default": "中心裁剪"}),
            },
            "optional": {
                "宽度": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "高度": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 8}),
                "X坐标": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 8}),
                "Y坐标": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 8}),
                "宽高比例": (ASPECT_RATIOS, {"default": "16:9"}),
                "边长": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "边长类型": (SIDE_TYPES, {"default": "最长边"}),
                "画面方向": (ORIENTATION_TYPES, {"default": "横屏"}),
                "分辨率": (RESOLUTION_OPTIONS, {"default": "1K"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "crop"
    CATEGORY = "GuliNodes/图像"

    def crop(self, 图像: torch.Tensor, 模式: str = "中心裁剪",
              宽度: int = 512, 高度: int = 512, X坐标: int = 0, Y坐标: int = 0,
              宽高比例: str = "16:9", 边长: int = 1024, 边长类型: str = "最长边",
              画面方向: str = "横屏", 分辨率: str = "1K") -> tuple:
        return (_do_crop(
            图像, 模式, 宽度, 高度, X坐标, Y坐标, 宽高比例, 边长, 边长类型, 画面方向, 分辨率,
        ),)


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
    CATEGORY = "GuliNodes/图像"
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


def _gg_metadata_json(prompt=None, extra_pnginfo=None) -> str:
    payload = {}
    if prompt is not None:
        payload.setdefault("prompt", prompt)
    if extra_pnginfo is not None:
        for key in extra_pnginfo:
            if key != "prompt" and key not in payload:
                payload[key] = extra_pnginfo[key]
    try:
        return json.dumps(payload, ensure_ascii=False, allow_nan=False)
    except Exception:
        return ""


_GG_METADATA_TAG = b"GGMETA1"


def _webp_metadata_bytes(prompt=None, extra_pnginfo=None) -> bytes | None:
    """WEBP 元数据：JSON 载荷以 EXIF 块直通写入（Pillow 实测支持大载荷）。

    无条件（无 prompt/extra）时不写，避免目标大小探测的临时文件被打上空元数据。
    """
    if args.disable_metadata:
        return None
    if prompt is None and extra_pnginfo is None:
        return None
    metadata = _gg_metadata_json(prompt, extra_pnginfo)
    if not metadata:
        return None
    payload_bytes = metadata.encode("utf-8")
    if len(payload_bytes) > 6 * 1024 * 1024:
        return None
    return b"EXIF" + payload_bytes


def _png_metadata_info(prompt=None, extra_pnginfo=None) -> PngInfo | None:
    if args.disable_metadata:
        return None
    metadata = PngInfo()
    if prompt is not None:
        metadata.add_text("prompt", json.dumps(prompt))
    if extra_pnginfo is not None:
        for key in extra_pnginfo:
            metadata.add_text(key, json.dumps(extra_pnginfo[key]))
    return metadata


def _embed_gg_metadata_jpeg(output_path: str, prompt=None, extra_pnginfo=None) -> None:
    if args.disable_metadata:
        return
    if prompt is None and extra_pnginfo is None:
        return
    metadata = _gg_metadata_json(prompt, extra_pnginfo)
    if metadata:
        _attach_gg_metadata_jpeg(output_path, metadata)


def _attach_gg_metadata_jpeg(
    output_path: str,
    data: bytes,
) -> None:
    """把 JSON 元数据写进 JPEG COM 段。

    - 载荷不超段上限时：写入单个未加前缀的 COM 段，普通查看器(Pillow/浏览器等)
      读回的 comment 就是完整 JSON。
    - 载荷超限时：拆成多个 ≤60000 字节的 COM 段，每段以 _GG_METADATA_TAG 标记，
      用 _load_gg_metadata 读取全部段即可还原完整 JSON。
    """
    if not data:
        return
    if isinstance(data, str):
        text = data
    else:
        try:
            text = data.decode("utf-8")
        except Exception:
            return
    if not text:
        return

    with open(output_path, "rb") as handle:
        jpeg = handle.read()
    sos_index = jpeg.find(b"\xff\xda")
    if sos_index < 0:
        return
    # 确保末尾只有一个 EOI（部分优化编码会提前截断重写流）
    eoi_index = jpeg.rfind(b"\xff\xd9")
    if eoi_index > sos_index:
        jpeg = jpeg[:eoi_index] + b"\xff\xd9"
    elif jpeg.endswith(b"\xff\xd9"):
        jpeg = jpeg[:-2] + b"\xff\xd9"

    text_bytes = text.encode("utf-8")
    if len(text_bytes) <= 60000:
        com_markers = b"\xff\xfe" + (len(text_bytes) + 2).to_bytes(2, "big") + text_bytes
    else:
        # base64 保证跨段切分安全（60000 是 4 的整数倍），第一段带标记
        base64_text = _GG_METADATA_TAG + base64.b64encode(text_bytes)
        chunks = [base64_text[offset : offset + 60000] for offset in range(0, len(base64_text), 60000)]
        com_markers = b"".join(
            b"\xff\xfe" + (len(chunk) + 2).to_bytes(2, "big") + chunk for chunk in chunks
        )
    jpeg = jpeg[:sos_index] + com_markers + jpeg[sos_index:]
    with open(output_path, "wb") as handle:
        handle.write(jpeg)


def _load_gg_metadata(file_path: str) -> str | None:
    """读取 GG JPEG 保存的完整 JSON 元数据；普通 JPEG/Pillow 读回单段时也直接返回。"""
    try:
        with open(file_path, "rb") as handle:
            data = handle.read()
    except Exception:
        return None

    # 依次解析 JPEG 标记，收集 SOS(0xFFDA) 前的全部 COM 段文本
    index = 2
    payloads: list[bytes] = []
    while index + 3 < len(data):
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        if marker == 0xDA:  # SOS: 图像数据开始，元数据段到此为止
            break
        if marker == 0xD9:  # EOI
            break
        if marker == 0xD8 or 0xC0 <= marker <= 0xCF or marker in (0x01, 0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7):
            index += 2
            continue
        if index + 4 > len(data):
            break
        length = int.from_bytes(data[index + 2 : index + 4], "big")
        if length < 2:
            break
        seg_start = index + 2
        seg_end = min(seg_start + length, len(data))
        if marker == 0xFE:  # COM 段
            payloads.append(data[seg_start + 2 : seg_end])
        index = seg_end if seg_end > index else index + 1

    if not payloads:
        return None
    if payloads[0].startswith(_GG_METADATA_TAG):
        encoded = b"".join(payloads)[len(_GG_METADATA_TAG) :]
        try:
            return base64.b64decode(encoded).decode("utf-8")
        except Exception:
            return None
    return payloads[0].decode("utf-8", errors="replace")


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

        # 节点继承自 SaveImage，其 RETURN_TYPES = ("IMAGE",)，
        # 因此工作流可能把本节点输出连到下游。必须回传 result 元组，
        # 否则 ComfyUI 缓存更新时 value.outputs[from_socket] 越界报错。
        return {"ui": {"images": results}, "result": (图像,)}

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
        return _png_metadata_info(prompt, extra_pnginfo)

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
            self._save_target_size(pil_image, output_path, format_name, quality, target_size_kb, prompt, extra_pnginfo)
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
            exif = self._gg_metadata_exif(prompt, extra_pnginfo)
            save_image.save(
                output_path,
                format="WEBP",
                quality=quality,
                method=6,
                optimize=True,
                exif=exif,
            )
        else:
            save_image.save(
                output_path,
                format="JPEG",
                quality=quality,
                optimize=True,
                progressive=True,
                subsampling=0 if quality >= 90 else "4:2:0",
            )
            _embed_gg_metadata_jpeg(output_path, prompt, extra_pnginfo)

    @staticmethod
    def _gg_metadata_exif(prompt=None, extra_pnginfo=None) -> bytes | None:
        return _webp_metadata_bytes(prompt, extra_pnginfo)

    def _save_target_size(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int,
        prompt=None,
        extra_pnginfo=None,
    ) -> None:
        target_bytes = max(1, int(target_size_kb)) * 1024

        def save_once(path: str, current_quality: int) -> None:
            # 探测临时文件带元数据写，选中质量后字节会包含 COM/exif；
            # 最终文件归档后对 JPEG 再补一次（幂等，_load_gg_metadata 优先取第一个段，
            # 即探测时写入的完整 JSON）。
            self._save_encoded_image(pil_image, path, format_name, current_quality, 0, prompt, extra_pnginfo)

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
                "清除内存": ("BOOLEAN", {"default": True, "tooltip": "保存完成后卸载模型、清理设备缓存与 Python GC；VAE 由上游 Loader 管理。"}),
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
        清除内存=True,
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
                prompt=prompt,
                extra_pnginfo=extra_pnginfo,
            )
            results.append({
                "filename": file,
                "subfolder": subfolder,
                "type": self.type,
            })
            counter += 1

        if 清除内存:
            from .model_loaders import cleanup_all_memory

            cleanup_all_memory()

        # 节点继承自 SaveImage，其 RETURN_TYPES = ("IMAGE",)，
        # 因此工作流可能把本节点输出连到下游。必须回传 result 元组，
        # 否则 ComfyUI 缓存更新时 value.outputs[from_socket] 越界报错。
        return {"ui": {"images": results}, "result": (图像,)}

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
        prompt=None,
        extra_pnginfo=None,
    ) -> None:
        if method == "caesium":
            self._save_caesium_style(pil_image, output_path, format_name, quality, target_size_kb, prompt, extra_pnginfo)
        elif method == "meowtec":
            self._save_meowtec_style(pil_image, output_path, format_name, quality, target_size_kb, prompt, extra_pnginfo)
        else:
            self._save_civilblur_style(pil_image, output_path, format_name, quality, target_size_kb, prompt, extra_pnginfo)

    def _save_meowtec_style(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int,
        prompt=None,
        extra_pnginfo=None,
    ) -> None:
        pil_image.info.clear()
        if target_size_kb > 0 and format_name in ("JPEG", "WEBP"):
            target_bytes = max(1, int(target_size_kb)) * 1024
            _save_target_size_by_quality(
                output_path,
                format_name,
                target_bytes,
                quality,
                lambda path, current_quality: self._save_meowtec_style(pil_image, path, format_name, current_quality, 0, prompt, extra_pnginfo),
                iterations=7,
            )
            return
        self._save_single_pass(pil_image, output_path, format_name, quality, prompt, extra_pnginfo)

    def _save_caesium_style(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int,
        prompt=None,
        extra_pnginfo=None,
    ) -> None:
        pil_image.info.clear()
        if target_size_kb > 0 and format_name in ("JPEG", "WEBP"):
            target_bytes = max(1, int(target_size_kb)) * 1024
            _save_target_size_by_quality(
                output_path,
                format_name,
                target_bytes,
                quality,
                lambda path, current_quality: self._save_caesium_style(pil_image, path, format_name, current_quality, 0, prompt, extra_pnginfo),
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
            _embed_gg_metadata_jpeg(output_path, prompt, extra_pnginfo)
            return

        self._save_single_pass(pil_image, output_path, format_name, quality, prompt, extra_pnginfo)

    def _save_civilblur_style(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        target_size_kb: int,
        prompt=None,
        extra_pnginfo=None,
    ) -> None:
        pil_image.info.clear()
        if target_size_kb > 0 and format_name in ("WEBP", "JPEG"):
            target_bytes = max(1, int(target_size_kb)) * 1024
            _save_target_size_by_quality(
                output_path,
                format_name,
                target_bytes,
                quality,
                lambda path, current_quality: self._save_single_pass(pil_image, path, format_name, current_quality, prompt, extra_pnginfo),
                iterations=8,
            )
            return

        self._save_single_pass(pil_image, output_path, format_name, quality, prompt, extra_pnginfo)

    def _save_single_pass(
        self,
        pil_image: Image.Image,
        output_path: str,
        format_name: str,
        quality: int,
        prompt=None,
        extra_pnginfo=None,
    ) -> None:
        save_image = _prepare_pil_for_format(pil_image, format_name)
        if format_name == "WEBP":
            save_image.save(
                output_path,
                format="WEBP",
                quality=quality,
                method=6,
                optimize=True,
                exif=_webp_metadata_bytes(prompt, extra_pnginfo),
            )
        elif format_name == "PNG":
            save_image.save(
                output_path,
                format="PNG",
                optimize=True,
                compress_level=9,
                pnginfo=_png_metadata_info(prompt, extra_pnginfo),
            )
        else:
            save_image.convert("RGB").save(
                output_path,
                format="JPEG",
                quality=quality,
                optimize=True,
                progressive=True,
                subsampling=0 if quality >= 90 else "4:2:0",
            )
            _embed_gg_metadata_jpeg(output_path, prompt, extra_pnginfo)

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


class ImageComparerBase(PreviewImage):
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

    @classmethod
    def get_hidden_inputs(cls):
        return {
            "prompt": "PROMPT",
            "extra_pnginfo": "EXTRA_PNGINFO",
        }

    def _save_compare_images(
        self,
        images: torch.Tensor,
        filename_prefix: str,
        format_value="JPEG",
        prompt=None,
        extra_pnginfo=None,
    ) -> list[dict[str, str]]:
        """保存对比输入图像，供前端预览和外部联动功能读取。"""
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
            save_image.save(
                output_path,
                format="WEBP",
                quality=quality,
                method=6,
                optimize=True,
                exif=_webp_metadata_bytes(prompt, extra_pnginfo),
            )
        else:
            save_image.save(
                output_path,
                format="JPEG",
                quality=quality,
                optimize=True,
                progressive=True,
                subsampling=0 if quality >= 90 else "4:2:0",
            )
            _embed_gg_metadata_jpeg(output_path, prompt, extra_pnginfo)


class GGImageComparer4(ImageComparerBase):
    @classmethod
    def INPUT_TYPES(s):
        inputs, labels = s.create_image_inputs(20)
        base_inputs = s.get_default_inputs()
        base_inputs["optional"].update(inputs)
        base_inputs["optional"].update(labels)
        base_inputs["hidden"] = s.get_hidden_inputs()
        return base_inputs

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("对比结果",)
    FUNCTION = "compare"
    CATEGORY = "GuliNodes/图像"

    def compare(self, 字体大小: int = 40, 边框宽度: int = 32, 标签高度: int = 80, 图像间距: int = 20,
                prompt=None, extra_pnginfo=None, **kwargs) -> dict:
        image_pairs = [
            (
                kwargs.get(f"图像_{chr(65 + index)}"),
                kwargs.get(f"标签_{chr(65 + index)}", f"图像 {chr(65 + index)}"),
            )
            for index in range(20)
        ]
        image_pairs = [(image, label) for image, label in image_pairs if image is not None]
        if not image_pairs:
            raise RuntimeError("请至少连接一张图像用于对比。")
        images = [image for image, _ in image_pairs]
        labels = [label for _, label in image_pairs]
        preview_images = []
        for index, image in enumerate(images):
            if len(image) > 0:
                preview_images.extend(
                    self._save_compare_images(
                        image,
                        f"GG.compareN.{chr(65 + index)}_",
                        "JPEG",
                        prompt,
                        extra_pnginfo,
                    )
                )
        comparison = images[0] if len(images) == 1 else concatenate_images_horizontally(
            images, labels, 字体大小, 边框宽度, 标签高度, 图像间距
        )
        return {
            "ui": {"a_images": preview_images, "b_images": []},
            "result": (comparison,),
        }


class GGImageComparer2(ImageComparerBase):
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
        result = {"ui": {"a_images": [], "b_images": []}, "result": (图像_A,)}
        if 图像_A is not None and len(图像_A) > 0:
            result["ui"]["a_images"] = self._save_compare_images(
                图像_A, f"{filename_prefix}a_", "JPEG", prompt, extra_pnginfo
            )
        if 图像_B is not None and len(图像_B) > 0:
            result["ui"]["b_images"] = self._save_compare_images(
                图像_B, f"{filename_prefix}b_", "JPEG", prompt, extra_pnginfo
            )
        return result

_缩放方法选项 = ["nearest-exact", "bilinear", "lanczos", "area", "bicubic"]

# 「缩放方式」把两种定尺寸的思路并成一个选择器：
#   按倍数   —— 原来那套（缩放倍率），行为不变；
#   按参数   —— 直接给长边/短边/宽度/高度，另一边按原比例推算；按宽度高度则精确给宽高。
# 合成一级六项、而不是「模式 → 依据」两级，是因为两级要嵌套 DynamicCombo：
# 本机前端没有嵌套动态下拉的先例，翻车时表现为整片控件消失；
# 一级六项少点一次，参数显隐也更容易稳定。
_缩放依据选项 = ("按长边", "按短边", "按宽度", "按高度")
_缩放方式选项 = ("按倍数",) + _缩放依据选项 + ("按宽度高度",)

# 缩放依据 → 对应的输入名（两者不同名，避免「按宽度」和「按宽度高度」的宽度混在一起）
_依据输入名 = {"按长边": "长边", "按短边": "短边", "按宽度": "宽度", "按高度": "高度"}

# 整除数的快速选择：16 放第一项，动态下拉没有独立默认值，第一项就是默认值。
# 想要的非预设值走「自定义」，所以这个控件既能一键选常用档，也能自由填。
_整除数选项 = ("16", "0", "4", "8", "32", "64", "128", "自定义")
_整除数默认 = 16


def _校验整除数(值) -> int:
    数值 = int(值)
    if 数值 < 0 or 数值 > 256:
        raise ValueError(f"整除数需要填 0~256，现在填的是 {数值}；填 0 表示不对齐。")
    return 数值


def _解析整除数(值, 默认=_整除数默认) -> int:
    """拆出整除数：兼容快速选择（字符串/嵌套字典）、「自定义」分支和纯数字。"""
    if isinstance(值, dict):
        选中 = 值.get("整除数")
        if isinstance(选中, dict):
            选中 = 选中.get("整除数")
        if 选中 == "自定义":
            return _校验整除数(值.get("自定义整除数", 默认))
        if 选中 in (None, ""):
            return 默认
        值 = 选中
    if isinstance(值, (int, float)) and not isinstance(值, bool):
        return _校验整除数(int(值))
    try:
        return _校验整除数(int(str(值).strip()))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"整除数「{值}」不是有效数字。") from exc


def _解析缩放方式(值):
    """拆开「缩放方式」的嵌套取值，返回 (方式, 该方式下的参数)。

    兼容旧工作流：老版本的第一个下拉是「缩放方法」，值会落进这一格，
    这里按插值名/倍率还原成「按倍数」，不让老工作流一开就报错。
    """
    if isinstance(值, dict):
        方式 = 值.get("缩放方式")
        if isinstance(方式, dict):  # 少数前端会把选中值再套一层
            return 方式.get("缩放方式", "按倍数"), 值
        return (方式 or "按倍数"), 值
    if isinstance(值, str) and 值:
        if 值 in _缩放方式选项:
            return 值, {}
        if 值 in _缩放方法选项:
            return "按倍数", {"缩放插值": 值}
        return 值, {}  # 认不出来的字符串原样上抛，由调用方报「不支持的缩放方式」
    if isinstance(值, (int, float)) and not isinstance(值, bool):
        return "按倍数", {"缩放倍率": float(值)}
    return "按倍数", {}


def _边长缩放比例(原宽, 原高, 依据, 数值):
    """按「长边/短边/宽度/高度」算出缩放比例；数值非法时抛中文错误。"""
    try:
        数值 = float(数值)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"「{依据}」的数值必须是有效数字。") from exc
    if not math.isfinite(数值) or 数值 <= 0:
        raise ValueError(f"「{依据}」的数值必须大于 0，现在填的是 {数值:g}。")

    参照 = {
        "按长边": max(原宽, 原高),
        "按短边": min(原宽, 原高),
        "按宽度": 原宽,
        "按高度": 原高,
    }.get(依据)
    if 参照 is None or 参照 <= 0:
        raise ValueError(f"不支持的缩放依据「{依据}」。")
    return 数值 / float(参照)


def _缩放图像到(图像, 目标宽, 目标高, 插值="lanczos"):
    """把 IMAGE 直接重采样到 目标宽×目标高（不裁不补，比例可能被改变）。"""
    if 插值 not in _缩放方法选项:
        raise ValueError(f"不支持的缩放插值「{插值}」。")
    缩放后 = 图像.movedim(-1, 1)
    缩放后 = comfy.utils.common_upscale(缩放后, int(目标宽), int(目标高), 插值, "disabled")
    return 缩放后.movedim(1, -1)


def _执行图像缩放(图像, 缩放方式="按倍数", 缩放插值="lanczos", 缩放倍率=1.5,
                  长边=1024, 短边=768, 宽度=1024, 高度=1024, 整除数=_整除数默认):
    if not isinstance(图像, torch.Tensor) or 图像.ndim != 4:
        raise ValueError("图像输入必须是 ComfyUI IMAGE 格式（批次、高度、宽度、通道）。")

    整除数 = _解析整除数(整除数)
    方式, 原始参数 = _解析缩放方式(缩放方式)
    参数 = dict(原始参数 or {})

    # 旧工作流的控件顺序不同，倍率可能落在「缩放插值」这一格；先捞回来再归位
    if 缩放插值 not in _缩放方法选项:
        if isinstance(缩放插值, (int, float)) and not isinstance(缩放插值, bool):
            参数.setdefault("缩放倍率", float(缩放插值))
        缩放插值 = "lanczos"
    if 方式 not in _缩放方式选项:
        raise ValueError(f"不支持的缩放方式「{方式}」。")

    _, 原高, 原宽, _ = 图像.shape
    if 原宽 < 1 or 原高 < 1:
        raise ValueError(f"输入图像尺寸异常（{原宽}×{原高}），无法缩放。")

    if 方式 == "按宽度高度":
        目标宽 = _就近整除(int(参数.get("宽度", 宽度)), 整除数)
        目标高 = _就近整除(int(参数.get("高度", 高度)), 整除数)
        if 目标宽 < 1 or 目标高 < 1:
            raise ValueError(f"宽度和高度都要大于 0，现在填的是 {目标宽}×{目标高}。")
        return _缩放图像到(图像, 目标宽, 目标高, 缩放插值)

    if 方式 == "按倍数":
        try:
            比例 = float(参数.get("缩放倍率", 缩放倍率))
        except (TypeError, ValueError) as exc:
            raise ValueError("缩放倍率必须是有效数字。") from exc
        if not math.isfinite(比例) or 比例 <= 0:
            raise ValueError("缩放倍率必须大于 0。")
        比例 = min(10000.0, max(0.1, 比例))
    else:
        数值 = 参数.get(_依据输入名[方式], {"按长边": 长边, "按短边": 短边,
                                            "按宽度": 宽度, "按高度": 高度}[方式])
        比例 = _边长缩放比例(原宽, 原高, 方式, 数值)

    # 比例只在输出侧取整，原图尺寸永远参与计算，连续缩放不会累积误差；
    # 宽高各自就近吸附到整除数倍数，用户填 1000 配 16 会输出 1008 而不是报错
    return _缩放图像到(
        图像,
        _就近整除(round(原宽 * 比例), 整除数),
        _就近整除(round(原高 * 比例), 整除数),
        缩放插值,
    )


class GG图像缩放:
    """旧版前端（没有 V3 动态接口）用的扁平参数版：所有参数一次全显示。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "缩放方式": (list(_缩放方式选项), {"default": "按倍数"}),
                "缩放插值": (_缩放方法选项[:], {"default": "lanczos"}),
                "缩放倍率": ("FLOAT", {"default": 1.5, "min": 0.1, "max": 10000.0, "step": 0.05}),
                "长边": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1}),
                "短边": ("INT", {"default": 768, "min": 1, "max": 16384, "step": 1}),
                "宽度": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1}),
                "高度": ("INT", {"default": 1024, "min": 1, "max": 16384, "step": 1}),
                "整除数": ("INT", {"default": 16, "min": 0, "max": 256, "step": 4}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/图像"

    def execute(self, 图像, 缩放方式="按倍数", 缩放插值="lanczos", 缩放倍率=1.5,
                长边=1024, 短边=768, 宽度=1024, 高度=1024, 整除数=16):
        return (_执行图像缩放(图像, 缩放方式, 缩放插值, 缩放倍率,
                              长边, 短边, 宽度, 高度, 整除数),)


# ---------------------------------------------------------------------------
# GG 图像缩放 V2
#
# 与上面的 `GG 图像缩放` 分工：
#   `GG 图像缩放` 只负责“把尺寸定下来”（按倍数或按长/短边、宽、高、宽高），输出只有图像；
#   `GG 图像缩放 V2` 先按边长/自定义宽高定出目标框，再决定内容怎么落进框里
#   （拉伸、裁剪、三种填充），同时缩放遮罩并输出实际宽高，供下游按真实尺寸排布。
#
# 全部在 torch 张量上算，不走 PIL 往返：批次一次整形，裁剪/填充都是切片，
# 单张 4K 图像的耗时就只有一次重采样；批次越大，摊到每张的成本越低。
# ---------------------------------------------------------------------------

_缩放V2模式选项 = ("拉伸", "裁剪", "填充·自定义颜色", "填充·边框颜色", "填充·边缘像素", "总像素等比例")
_缩放V2方向选项 = ("居中", "上", "下", "左", "右")
_缩放V2条件选项 = ("总是", "最长边大于目标时", "最短边小于目标时")


def _解析填充颜色(值) -> tuple[float, float, float]:
    """把 #RRGGBB / #RGB / r,g,b / (r,g,b) 解析成 0~1 的 RGB；解析不了抛中文错误。"""
    if isinstance(值, (tuple, list)) and len(值) == 3:
        通道 = [float(分量) for 分量 in 值]
        if max(通道) > 1.0:  # 传的是 0~255 的整数写法
            通道 = [分量 / 255.0 for 分量 in 通道]
        return tuple(min(1.0, max(0.0, 分量)) for 分量 in 通道)

    if isinstance(值, str):
        文本 = 值.strip()
        if "," in 文本:
            片段 = [段.strip() for 段 in 文本.split(",")]
            if len(片段) == 3:
                try:
                    return _解析填充颜色(tuple(int(段) for 段 in 片段))
                except ValueError:
                    pass  # 落到下面按十六进制再试一次
        文本 = 文本.lstrip("#")
        if len(文本) == 3:
            文本 = "".join(字 * 2 for 字 in 文本)
        if len(文本) == 6:
            try:
                数值 = int(文本, 16)
            except ValueError:
                数值 = -1
            if 数值 >= 0:
                return ((数值 >> 16 & 0xFF) / 255.0,
                        (数值 >> 8 & 0xFF) / 255.0,
                        (数值 & 0xFF) / 255.0)

    raise ValueError(f"填充颜色「{值}」无法识别，请填 #RRGGBB（例如 #364254），也支持 r,g,b。")


def _就近整除(尺寸: int, 整除数: int) -> int:
    """把尺寸就近取到整除数倍数，至少保留一个整除数；整除数 <= 1 时原样返回。"""
    尺寸 = max(1, int(尺寸))
    if 整除数 <= 1:
        return 尺寸
    倍数 = int(math.floor(尺寸 / 整除数 + 0.5))
    return max(int(整除数), 倍数 * int(整除数))


def _缩放V2目标尺寸(原宽: int, 原高: int, 缩放方法: str,
                    将边缩放到: int, 宽度: int, 高度: int, 整除数: int):
    """按缩放方法算出目标宽高（已对齐整除数），返回 (宽, 高)。"""
    if 缩放方法 in ("按长边等比例", "按短边等比例"):
        依据 = "按长边" if 缩放方法 == "按长边等比例" else "按短边"
        比例 = _边长缩放比例(原宽, 原高, 依据, 将边缩放到)
        return (_就近整除(round(原宽 * 比例), 整除数),
                _就近整除(round(原高 * 比例), 整除数))

    if 缩放方法 != "自定义宽高":
        raise ValueError(f"不支持的缩放方法「{缩放方法}」。")

    # 自定义宽高：一边填 0 表示按另一边等比例推算，两边都 0 表示保持原尺寸
    if int(宽度) <= 0 and int(高度) <= 0:
        return _就近整除(原宽, 整除数), _就近整除(原高, 整除数)
    if int(宽度) <= 0:
        比例 = float(高度) / float(原高)
        return _就近整除(round(原宽 * 比例), 整除数), _就近整除(高度, 整除数)
    if int(高度) <= 0:
        比例 = float(宽度) / float(原宽)
        return _就近整除(宽度, 整除数), _就近整除(round(原高 * 比例), 整除数)
    return _就近整除(宽度, 整除数), _就近整除(高度, 整除数)


def _总像素目标尺寸(原宽: int, 原高: int, 参考宽: int, 参考高: int, 整除数: int):
    """保持原图宽高比，让输出 宽×高 尽量接近 参考宽×参考高 的总像素。"""
    目标总像素 = float(参考宽) * float(参考高)
    比例 = float(原宽) / float(原高)
    基准高 = max(1, int(round(math.sqrt(目标总像素 / 比例))))

    # 开方取整会带 ±1 像素误差，这里在邻域里挑总像素最接近的一组
    候选 = []
    for 偏移 in (-1, 0, 1):
        候选高 = max(1, 基准高 + 偏移)
        候选宽 = max(1, int(round(候选高 * 比例)))
        候选.append((abs(候选宽 * 候选高 - 目标总像素), 候选宽, 候选高))
    _, 最佳宽, 最佳高 = min(候选, key=lambda 项: 项[0])
    return _就近整除(最佳宽, 整除数), _就近整除(最佳高, 整除数)


def _方向偏移(容器宽: int, 容器高: int, 内容宽: int, 内容高: int, 固定方向: str):
    """内容放进容器时，按固定方向算左上角偏移；内容比容器大时对应轴偏移为 0。"""
    差宽 = max(0, int(容器宽) - int(内容宽))
    差高 = max(0, int(容器高) - int(内容高))
    if 固定方向 == "上":
        return 差宽 // 2, 0
    if 固定方向 == "下":
        return 差宽 // 2, 差高
    if 固定方向 == "左":
        return 0, 差高 // 2
    if 固定方向 == "右":
        return 差宽, 差高 // 2
    return 差宽 // 2, 差高 // 2


def _重采样图像(图像: torch.Tensor, 宽: int, 高: int, 插值: str) -> torch.Tensor:
    通道前置 = 图像.movedim(-1, 1).contiguous()
    缩放后 = comfy.utils.common_upscale(通道前置, int(宽), int(高), 插值, "disabled")
    return 缩放后.movedim(1, -1).contiguous()


def _重采样遮罩(遮罩: torch.Tensor, 宽: int, 高: int, 插值: str) -> torch.Tensor:
    # 遮罩避开 lanczos / bicubic：这两个算法会在二值边界外振铃出负值光晕，
    # 缩完再 clamp 也只会得到一圈脏边。双线性或区域更干净。
    方法 = "bilinear" if 插值 in ("lanczos", "bicubic") else 插值
    结果 = comfy.utils.common_upscale(遮罩.unsqueeze(1), int(宽), int(高), 方法, "disabled")
    return 结果.squeeze(1).clamp(0.0, 1.0)


def _规整遮罩(遮罩, 批次: int, 高: int, 宽: int):
    """把各种形状的 MASK 统一成 批次×高×宽，并对齐到图像尺寸；没接返回 None。"""
    if 遮罩 is None:
        return None
    if not isinstance(遮罩, torch.Tensor):
        raise ValueError("遮罩输入必须是 ComfyUI MASK 张量。")
    if 遮罩.ndim == 4:  # 偶见的 批次×1×高×宽 形状
        遮罩 = 遮罩[:, 0]
    if 遮罩.ndim == 2:
        遮罩 = 遮罩.unsqueeze(0)
    if 遮罩.ndim != 3:
        raise ValueError(f"遮罩输入必须是 批次×高×宽，实际维度是 {遮罩.ndim}。")

    if 遮罩.shape[0] == 1 and 批次 > 1:
        遮罩 = 遮罩.repeat(批次, 1, 1)
    elif 遮罩.shape[0] != 批次:
        raise ValueError(
            f"遮罩批次（{遮罩.shape[0]}）与图像批次（{批次}）不一致；只接 1 张遮罩时会自动复用。"
        )

    遮罩 = 遮罩.to(dtype=torch.float32)
    if 遮罩.shape[1] != 高 or 遮罩.shape[2] != 宽:
        遮罩 = _重采样遮罩(遮罩, 宽, 高, "bilinear")
    return 遮罩


def _贴到画布(内容: torch.Tensor, 目标宽: int, 目标高: int,
              偏移x: int, 偏移y: int, 底色: torch.Tensor | None) -> torch.Tensor:
    """把 [批次,h,w,C] 贴到目标尺寸画布；底色为 [批次,1,1,C]，None 表示全 0。"""
    批次, 高, 宽, 通道 = 内容.shape
    if 底色 is None:
        画布 = 内容.new_zeros((批次, 目标高, 目标宽, 通道))
    else:
        画布 = 底色.to(device=内容.device, dtype=内容.dtype).expand(
            批次, 目标高, 目标宽, 通道
        ).clone()
    画布[:, 偏移y:偏移y + 高, 偏移x:偏移x + 宽, :] = 内容
    return 画布


def _纯色画布(图像: torch.Tensor, 填充颜色) -> torch.Tensor:
    rgb = _解析填充颜色(填充颜色)
    底色 = torch.tensor(rgb, device=图像.device, dtype=图像.dtype).view(1, 1, 1, 3)
    通道 = int(图像.shape[-1])
    if 通道 == 3:
        return 底色
    if 通道 < 3:
        return 底色[..., :通道].contiguous()
    补 = torch.ones((1, 1, 1, 通道 - 3), device=图像.device, dtype=图像.dtype)
    return torch.cat([底色, 补], dim=-1)


def _边框主色(图像: torch.Tensor) -> torch.Tensor:
    """取每张图四条边的众数色（前 20% 高频色加权平均），作为留白填充色。

    返回 [批次,1,1,C]。只读边界像素，成本 O(批次 × 周长)，与像素总数无关。
    """
    数组 = 图像.detach().float().clamp(0.0, 1.0).cpu().numpy()
    批次, 高, 宽, 通道 = 数组.shape
    色板 = np.zeros((批次, 1, 1, 通道), dtype=np.float32)
    if 高 < 1 or 宽 < 1:
        return torch.from_numpy(色板).to(device=图像.device, dtype=图像.dtype)

    for 序号 in range(批次):
        边缘 = np.concatenate([
            数组[序号, :, 0, :], 数组[序号, :, -1, :],
            数组[序号, 0, :, :], 数组[序号, -1, :, :],
        ], axis=0)
        量化 = np.clip(np.round(边缘 * 255.0), 0, 255).astype(np.int32)
        计数 = Counter(map(tuple, 量化.tolist()))
        主要 = 计数.most_common(max(1, len(计数) // 5))
        总权重 = sum(次数 for _, 次数 in 主要)
        if 总权重 <= 0:
            continue
        加权 = np.zeros(3, dtype=np.float64)
        for rgb, 次数 in 主要:
            加权 += np.array(rgb[:3], dtype=np.float64) * 次数
        色板[序号, 0, 0, :3] = (加权 / 总权重 / 255.0).astype(np.float32)
        if 通道 > 3:
            色板[序号, 0, 0, 3:] = 1.0
    return torch.from_numpy(色板).to(device=图像.device, dtype=图像.dtype)


def _复制边缘填充(内容: torch.Tensor, 目标宽: int, 目标高: int,
                  偏移x: int, 偏移y: int) -> torch.Tensor:
    """留白处用最近的一行/一列边界像素向外延伸。

    用 clamp 索引一次性 gather 出来，不用 torch_F.pad("replicate")：
    后者在单侧留白超过图像自身尺寸时会直接报错，大比例放大时就踩到了。
    """
    _, 高, 宽, _ = 内容.shape
    xs = torch.clamp(torch.arange(目标宽, device=内容.device) - 偏移x, 0, 宽 - 1)
    ys = torch.clamp(torch.arange(目标高, device=内容.device) - 偏移y, 0, 高 - 1)
    return 内容[:, ys][:, :, xs].contiguous()


def _覆盖裁剪(图像, 遮罩, 原宽, 原高, 目标宽, 目标高, 插值, 固定方向):
    """等比放大到刚好盖住目标框，再按固定方向裁掉多出的边：不拉伸、不留白。"""
    比例 = max(目标宽 / 原宽, 目标高 / 原高)
    缩放宽 = max(目标宽, int(round(原宽 * 比例)))
    缩放高 = max(目标高, int(round(原高 * 比例)))
    图 = _重采样图像(图像, 缩放宽, 缩放高, 插值)
    罩 = _重采样遮罩(遮罩, 缩放宽, 缩放高, 插值) if 遮罩 is not None else None

    x, y = _方向偏移(缩放宽, 缩放高, 目标宽, 目标高, 固定方向)
    图 = 图[:, y:y + 目标高, x:x + 目标宽, :].contiguous()
    if 罩 is not None:
        罩 = 罩[:, y:y + 目标高, x:x + 目标宽].contiguous()
    return 图, 罩


def _等比留白(图像, 遮罩, 原宽, 原高, 目标宽, 目标高, 插值, 固定方向):
    """等比缩到刚好装进目标框，返回 (图, 罩, 偏移x, 偏移y)。"""
    比例 = min(目标宽 / 原宽, 目标高 / 原高)
    缩放宽 = max(1, min(目标宽, int(round(原宽 * 比例))))
    缩放高 = max(1, min(目标高, int(round(原高 * 比例))))
    图 = _重采样图像(图像, 缩放宽, 缩放高, 插值)
    罩 = _重采样遮罩(遮罩, 缩放宽, 缩放高, 插值) if 遮罩 is not None else None
    x, y = _方向偏移(目标宽, 目标高, 缩放宽, 缩放高, 固定方向)
    return 图, 罩, x, y


def _填充落框(图像, 遮罩, 原宽, 原高, 目标宽, 目标高, 插值, 固定方向, 缩放模式, 填充颜色):
    图, 罩, x, y = _等比留白(图像, 遮罩, 原宽, 原高, 目标宽, 目标高, 插值, 固定方向)

    if 缩放模式 == "填充·边缘像素":
        新图 = _复制边缘填充(图, 目标宽, 目标高, x, y)
    elif 缩放模式 == "填充·自定义颜色":
        新图 = _贴到画布(图, 目标宽, 目标高, x, y, _纯色画布(图, 填充颜色))
    else:  # 填充·边框颜色
        新图 = _贴到画布(图, 目标宽, 目标高, x, y, _边框主色(图))

    if 罩 is None:
        return 新图, None
    # 填充区不属于任何遮罩区域，外扩部分补 0
    新罩 = _贴到画布(罩.unsqueeze(-1), 目标宽, 目标高, x, y, None).squeeze(-1)
    return 新图, 新罩


def _执行图像缩放V2(图像, 遮罩, 缩放方法, 缩放插值, 缩放模式, 固定方向,
                    执行条件, 填充颜色, 整除数, 宽度=1024, 高度=1024, 将边缩放到=1024):
    if 图像 is None:
        raise ValueError("图像不能为空：请连接 IMAGE 输入。")
    if not isinstance(图像, torch.Tensor) or 图像.ndim != 4:
        raise ValueError("图像输入必须是 ComfyUI IMAGE 格式（批次、高度、宽度、通道）。")

    批次, 原高, 原宽, 通道 = 图像.shape
    if 原宽 < 1 or 原高 < 1:
        raise ValueError(f"输入图像尺寸异常（{原宽}×{原高}），无法缩放。")

    整除数 = int(整除数 or 0)
    if 整除数 < 0 or 整除数 > 256:
        raise ValueError("整除数需要填 0~256；填 0 表示不按倍数对齐。")

    if 缩放插值 not in _缩放方法选项:
        raise ValueError(f"不支持的缩放插值「{缩放插值}」。")
    if 缩放模式 not in _缩放V2模式选项:
        raise ValueError(f"不支持的缩放模式「{缩放模式}」。")
    if 固定方向 not in _缩放V2方向选项:
        raise ValueError(f"不支持的固定方向「{固定方向}」。")

    遮罩 = _规整遮罩(遮罩, 批次, 原高, 原宽)

    if 缩放模式 == "总像素等比例":
        # 总像素要靠「宽×高」当预算，只有自定义宽高才拿得到这两个值
        if 缩放方法 != "自定义宽高":
            raise ValueError(
                "「总像素等比例」需要把「缩放方法」改成「自定义宽高」，"
                "再在宽度/高度里填参考像素尺寸（当作目标总像素）。"
            )
        if int(宽度) <= 0 or int(高度) <= 0:
            raise ValueError(
                "「总像素等比例」的宽度和高度都要大于 0："
                f"现在填的是 {int(宽度)}×{int(高度)}，总像素为 0 算不出目标尺寸。"
            )
        目标宽, 目标高 = _总像素目标尺寸(原宽, 原高, int(宽度), int(高度), 整除数)
    else:
        目标宽, 目标高 = _缩放V2目标尺寸(
            原宽, 原高, 缩放方法, int(将边缩放到), int(宽度), int(高度), 整除数
        )

    # 执行条件：不满足时退回原尺寸（只保留整除数对齐），避免无意义的二次重采样
    if 执行条件 == "最长边大于目标时" and max(原宽, 原高) <= max(目标宽, 目标高):
        目标宽, 目标高 = _就近整除(原宽, 整除数), _就近整除(原高, 整除数)
    elif 执行条件 == "最短边小于目标时" and min(原宽, 原高) >= min(目标宽, 目标高):
        目标宽, 目标高 = _就近整除(原宽, 整除数), _就近整除(原高, 整除数)

    if 目标宽 == 原宽 and 目标高 == 原高:
        输出图, 输出遮罩 = 图像, 遮罩
    elif 缩放模式 == "拉伸":
        输出图 = _重采样图像(图像, 目标宽, 目标高, 缩放插值)
        输出遮罩 = _重采样遮罩(遮罩, 目标宽, 目标高, 缩放插值) if 遮罩 is not None else None
    elif 缩放模式 in ("裁剪", "总像素等比例"):
        # 总像素模式的比例误差已经控制在 1 像素内，居中裁掉即可，不必再拉伸
        输出图, 输出遮罩 = _覆盖裁剪(
            图像, 遮罩, 原宽, 原高, 目标宽, 目标高, 缩放插值,
            "居中" if 缩放模式 == "总像素等比例" else 固定方向,
        )
    else:
        输出图, 输出遮罩 = _填充落框(
            图像, 遮罩, 原宽, 原高, 目标宽, 目标高, 缩放插值, 固定方向,
            缩放模式, 填充颜色,
        )

    if 输出遮罩 is None:
        输出遮罩 = torch.zeros(
            (批次, 目标高, 目标宽), device=输出图.device, dtype=torch.float32
        )

    return 输出图, int(目标宽), int(目标高), 输出遮罩


class GG图像缩放V2:
    """旧版前端（没有 V3 动态接口）用的扁平参数版，所有参数一次全显示。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "缩放方法": (["按长边等比例", "按短边等比例", "自定义宽高"], {"default": "按长边等比例"}),
                "将边缩放到": ("INT", {"default": 1024, "min": 8, "max": 16384, "step": 1}),
                "宽度": ("INT", {"default": 1024, "min": 0, "max": 16384, "step": 1}),
                "高度": ("INT", {"default": 1024, "min": 0, "max": 16384, "step": 1}),
                "缩放插值": (_缩放方法选项[:], {"default": "lanczos"}),
                "缩放模式": (list(_缩放V2模式选项), {"default": "拉伸"}),
                "固定方向": (list(_缩放V2方向选项), {"default": "居中"}),
                "执行条件": (list(_缩放V2条件选项), {"default": "总是"}),
                "填充颜色": ("STRING", {"default": "#364254"}),
                "整除数": ("INT", {"default": 0, "min": 0, "max": 256, "step": 1}),
            },
            "optional": {
                "遮罩": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "MASK")
    RETURN_NAMES = ("图像", "宽度", "高度", "遮罩")
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/图像"

    def execute(self, 图像, 缩放方法="按长边等比例", 将边缩放到=1024, 宽度=1024, 高度=1024,
                缩放插值="lanczos", 缩放模式="拉伸", 固定方向="居中", 执行条件="总是",
                填充颜色="#364254", 整除数=0, 遮罩=None):
        return _执行图像缩放V2(
            图像, 遮罩, 缩放方法, 缩放插值, 缩放模式, 固定方向, 执行条件,
            填充颜色, 整除数, 宽度, 高度, 将边缩放到,
        )


# ---------------------------------------------------------------------------
# GG 尺寸适配
#
# 按 Qwen-Image 2.1 常用训练尺寸生成稳定尺寸（内部缩放后的不动点），
# 再以裁剪、补边或拉伸方式输出。尺寸选择逻辑参考 BlueBox 的 CutQwenImage21，
# 图像处理复用本模块的 torch 批量重采样工具。
# ---------------------------------------------------------------------------

_QWEN21_RESOLUTIONS = tuple(range(512, 2048 + 1, 32))
_QWEN21_STANDARD_RATIOS = (1.0, 4 / 3, 3 / 4, 16 / 9, 9 / 16, 3 / 2, 2 / 3)
_QWEN21_MODES = ("裁剪", "补边", "拉伸")


def _qwen21_auto_resolution(宽度: int, 高度: int) -> int:
    目标 = math.sqrt(float(宽度) * float(高度))
    档位 = int(round(目标 / 32.0)) * 32
    return max(_QWEN21_RESOLUTIONS[0], min(_QWEN21_RESOLUTIONS[-1], 档位))


def _qwen21_whitelist(分辨率: int, 容差比例: float):
    n = int(分辨率) // 32
    容差 = max(1, int(n * float(容差比例)))
    目标面积 = n * n
    结果 = []
    for k in range(1, n * 3):
        for m in range(1, n * 3):
            面积 = k * m
            if abs(面积 - 目标面积) <= 容差:
                结果.append((k * 32, m * 32, 面积))
    return 结果


def _qwen21_ratio_distance(a: float, b: float) -> float:
    return abs(math.log(a) - math.log(b))


def _qwen21_pick_size(宽度: int, 高度: int, 分辨率: int, 容差比例: float):
    候选 = _qwen21_whitelist(分辨率, 容差比例)
    if not 候选:
        raise ValueError(f"分辨率 {分辨率} 无法生成稳定尺寸，请把容差比例调大。")
    输入比例 = 宽度 / 高度
    目标面积 = 分辨率 * 分辨率

    def score(item):
        宽, 高, 格数 = item
        比例 = 宽 / 高
        输入偏差 = _qwen21_ratio_distance(比例, 输入比例)
        标准偏差 = min(_qwen21_ratio_distance(比例, 标准) for 标准 in _QWEN21_STANDARD_RATIOS)
        面积偏差 = abs(格数 * 1024 - 目标面积) / 目标面积
        return 输入偏差 + 标准偏差 * 0.6 + 面积偏差 * 0.4

    return min(候选, key=score)[:2]


def _qwen21_verify_fixed_point(宽度: int, 高度: int, 分辨率: int):
    比例 = math.sqrt((分辨率 * 分辨率) / (宽度 * 高度))
    return (
        max(32, int(round(宽度 * 比例 / 32.0)) * 32),
        max(32, int(round(高度 * 比例 / 32.0)) * 32),
    )


def _qwen21_pick_target_size(宽度: int, 高度: int, 分辨率: int, 容差比例: float):
    目标宽, 目标高 = _qwen21_pick_size(宽度, 高度, 分辨率, 容差比例)
    if _qwen21_verify_fixed_point(目标宽, 目标高, 分辨率) == (目标宽, 目标高):
        return 目标宽, 目标高

    输入比例 = 宽度 / 高度
    合法候选 = []
    for 候选宽, 候选高, _ in _qwen21_whitelist(分辨率, 容差比例):
        if _qwen21_verify_fixed_point(候选宽, 候选高, 分辨率) == (候选宽, 候选高):
            合法候选.append((候选宽, 候选高))
    if 合法候选:
        return min(合法候选, key=lambda wh: _qwen21_ratio_distance(wh[0] / wh[1], 输入比例))
    return 目标宽, 目标高


def _qwen21_pad_color(图像: torch.Tensor, 宽度: int, 高度: int, 颜色: float):
    批次, _, _, 通道 = 图像.shape
    画布 = torch.full((批次, 高度, 宽度, 通道), float(颜色), dtype=图像.dtype, device=图像.device)
    return 画布


def _qwen21_transform(图像: torch.Tensor, 目标宽: int, 目标高: int, 模式: str, 补边颜色: float):
    if 模式 == "拉伸":
        return _重采样图像(图像, 目标宽, 目标高, "bilinear")
    if 模式 == "裁剪":
        return _覆盖裁剪(图像, None, int(图像.shape[2]), int(图像.shape[1]), 目标宽, 目标高, "bilinear", "居中")[0]

    原高, 原宽 = int(图像.shape[1]), int(图像.shape[2])
    比例 = min(目标宽 / 原宽, 目标高 / 原高)
    缩放宽 = max(1, min(目标宽, int(round(原宽 * 比例))))
    缩放高 = max(1, min(目标高, int(round(原高 * 比例))))
    内容 = _重采样图像(图像, 缩放宽, 缩放高, "bilinear")
    x = (目标宽 - 缩放宽) // 2
    y = (目标高 - 缩放高) // 2
    结果 = _qwen21_pad_color(图像, 目标宽, 目标高, 补边颜色)
    结果[:, y:y + 缩放高, x:x + 缩放宽, :] = 内容
    return 结果


def _执行Qwen21尺寸适配(图像, 分辨率="default", 容差比例=1.0, 模式="裁剪", 补边颜色=0.0):
    if not isinstance(图像, torch.Tensor) or 图像.ndim != 4:
        raise ValueError("图像输入必须是 ComfyUI IMAGE 格式（批次、高度、宽度、通道）。")
    _, 原高, 原宽, _ = 图像.shape
    if 原宽 < 1 or 原高 < 1:
        raise ValueError(f"输入图像尺寸异常（{原宽}×{原高}），无法适配。")
    if 分辨率 in (None, "default", "自动"):
        实际分辨率 = _qwen21_auto_resolution(原宽, 原高)
    else:
        try:
            实际分辨率 = int(分辨率)
        except (TypeError, ValueError) as exc:
            raise ValueError("分辨率必须选择 default 或 512~2048 的 32 倍数。") from exc
    if 实际分辨率 not in _QWEN21_RESOLUTIONS:
        raise ValueError("分辨率必须是 512~2048 之间、步进 32 的档位。")
    try:
        容差比例 = float(容差比例)
    except (TypeError, ValueError) as exc:
        raise ValueError("容差比例必须是有效数字。") from exc
    if not math.isfinite(容差比例) or 容差比例 < 0.2 or 容差比例 > 3.0:
        raise ValueError("容差比例需要在 0.2~3.0 之间。")
    if 模式 not in _QWEN21_MODES:
        raise ValueError(f"不支持的处理模式「{模式}」。")
    补边颜色 = min(1.0, max(0.0, float(补边颜色)))
    目标宽, 目标高 = _qwen21_pick_target_size(原宽, 原高, 实际分辨率, 容差比例)
    输出 = _qwen21_transform(图像, 目标宽, 目标高, 模式, 补边颜色)
    return 输出, int(目标宽), int(目标高), int(实际分辨率)


class GG尺寸适配:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "分辨率": (["default"] + [str(值) for 值 in _QWEN21_RESOLUTIONS], {"default": "default"}),
                "容差比例": ("FLOAT", {"default": 1.0, "min": 0.2, "max": 3.0, "step": 0.1}),
                "模式": (list(_QWEN21_MODES), {"default": "裁剪"}),
                "补边颜色": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "INT")
    RETURN_NAMES = ("图像", "宽度", "高度", "分辨率")
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/图像"

    def execute(self, 图像, 分辨率="default", 容差比例=1.0, 模式="裁剪", 补边颜色=0.0):
        return _执行Qwen21尺寸适配(图像, 分辨率, 容差比例, 模式, 补边颜色)


# ---------------------------------------------------------------------------
# GG 纯色图像
#
# 生成指定宽高、指定颜色的纯色图：作画布底、做外扩/贴回的背景、给合成节点垫底都用得上。
# 只要三个参数，不接任何输入，是纯粹的发生器节点。
# ---------------------------------------------------------------------------

_纯色图像尺寸上限 = 8192


def _生成纯色图像(宽度, 高度, 颜色) -> torch.Tensor:
    """生成 宽度×高度 的纯色图，返回 [1,高,宽,3] 的 IMAGE 张量。"""
    try:
        宽 = int(宽度)
        高 = int(高度)
    except (TypeError, ValueError) as exc:
        raise ValueError("宽度和高度必须是整数像素值。") from exc

    if 宽 < 1 or 高 < 1:
        raise ValueError(f"宽度和高度都要大于 0，现在填的是 {宽}×{高}。")
    if 宽 > _纯色图像尺寸上限 or 高 > _纯色图像尺寸上限:
        raise ValueError(
            f"单边最大 {_纯色图像尺寸上限} 像素，现在填的是 {宽}×{高}；"
            "再大就会吃掉几 GB 显存，需要大画布请用缩放/填充类节点。"
        )

    rgb = _解析填充颜色(颜色)
    # 单通道值先做成 1×1×1×3，再 expand+contiguous：只分配一次输出内存，不做逐像素填充
    像素 = torch.tensor(rgb, dtype=torch.float32).view(1, 1, 1, 3)
    return 像素.expand(1, 高, 宽, 3).contiguous()


class GG纯色图像:
    """旧版前端用的扁平参数版。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "宽度": ("INT", {"default": 512, "min": 1, "max": _纯色图像尺寸上限, "step": 1}),
                "高度": ("INT", {"default": 512, "min": 1, "max": _纯色图像尺寸上限, "step": 1}),
                "填充颜色": ("STRING", {"default": "#00ff00"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "execute"
    CATEGORY = "GuliNodes/图像"

    def execute(self, 宽度=512, 高度=512, 填充颜色="#00ff00"):
        return (_生成纯色图像(宽度, 高度, 填充颜色),)


if io is not None:

    class GGImageCropV3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGImageCrop",
                display_name="GG 图像裁剪",
                category="GuliNodes/图像",
                description="按中心、手动坐标、指定宽高比或 K 数分辨率裁剪图像，仅显示当前模式生效的参数。",
                inputs=[
                    io.Image.Input("图像"),
                    io.DynamicCombo.Input("模式", options=[
                        io.DynamicCombo.Option(key="中心裁剪", inputs=[
                            io.Int.Input("宽度", default=512, min=64, max=4096, step=8),
                            io.Int.Input("高度", default=512, min=64, max=4096, step=8),
                        ]),
                        io.DynamicCombo.Option(key="手动裁剪", inputs=[
                            io.Int.Input("宽度", default=512, min=64, max=4096, step=8),
                            io.Int.Input("高度", default=512, min=64, max=4096, step=8),
                            io.Int.Input("X坐标", default=0, min=0, max=4096, step=8),
                            io.Int.Input("Y坐标", default=0, min=0, max=4096, step=8),
                        ]),
                        io.DynamicCombo.Option(key="按比例裁剪", inputs=[
                            io.Combo.Input("宽高比例", options=ASPECT_RATIOS, default="16:9"),
                            io.Int.Input("边长", default=1024, min=64, max=8192, step=8),
                            io.Combo.Input("边长类型", options=SIDE_TYPES, default="最长边"),
                        ]),
                        io.DynamicCombo.Option(key="按K数分辨率", inputs=[
                            io.Combo.Input("宽高比例", options=LATENT_ASPECT_RATIOS, default="9:16"),
                            io.Combo.Input("画面方向", options=ORIENTATION_TYPES, default="横屏"),
                            io.Combo.Input("分辨率", options=RESOLUTION_OPTIONS, default="1K"),
                        ]),
                    ]),
                ],
                outputs=[
                    io.Image.Output(display_name="图像"),
                ],
            )

        @classmethod
        def execute(cls, 图像, 模式):
            mode, values = _unpack_crop_mode(模式)
            return io.NodeOutput(_do_crop(
                图像,
                mode,
                values.get("宽度", 512),
                values.get("高度", 512),
                values.get("X坐标", 0),
                values.get("Y坐标", 0),
                values.get("宽高比例", "16:9"),
                values.get("边长", 1024),
                values.get("边长类型", "最长边"),
                values.get("画面方向", "横屏"),
                values.get("分辨率", "1K"),
            ))

    GGImageCrop = GGImageCropV3

    class GG图像缩放_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GG图像缩放",
                display_name="GG 图像缩放",
                category="GuliNodes/图像",
                description=(
                    "两种定尺寸方式：「按倍数」沿用倍率缩放；「按参数」直接给长边、短边、宽度或高度，"
                    "另一边按原比例推算，选「按宽度高度」则精确给宽高。只显示当前方式用得到的参数。"
                ),
                inputs=[
                    io.Image.Input("图像", tooltip="要缩放的图像，支持批量。"),
                    io.DynamicCombo.Input("缩放方式", options=[
                        io.DynamicCombo.Option(key="按倍数", inputs=[
                            io.Float.Input(
                                "缩放倍率", default=1.5, min=0.1, max=10000.0, step=0.05,
                                tooltip="大于 1 放大、小于 1 缩小，宽高按同一比例变化。",
                            ),
                        ]),
                        io.DynamicCombo.Option(key="按长边", inputs=[
                            io.Int.Input(
                                "长边", default=1024, min=1, max=16384, step=1,
                                tooltip="把较长的一边定成这个像素，另一边按原比例推算。",
                            ),
                        ]),
                        io.DynamicCombo.Option(key="按短边", inputs=[
                            io.Int.Input(
                                "短边", default=768, min=1, max=16384, step=1,
                                tooltip="把较短的一边定成这个像素，另一边按原比例推算。",
                            ),
                        ]),
                        io.DynamicCombo.Option(key="按宽度", inputs=[
                            io.Int.Input(
                                "宽度", default=1024, min=1, max=16384, step=1,
                                tooltip="按目标宽度等比缩放，高度自动推算。",
                            ),
                        ]),
                        io.DynamicCombo.Option(key="按高度", inputs=[
                            io.Int.Input(
                                "高度", default=1024, min=1, max=16384, step=1,
                                tooltip="按目标高度等比缩放，宽度自动推算。",
                            ),
                        ]),
                        io.DynamicCombo.Option(key="按宽度高度", inputs=[
                            io.Int.Input(
                                "宽度", default=1024, min=1, max=16384, step=1,
                                tooltip="精确输出宽度；与当前比例不同时会拉伸变形。",
                            ),
                            io.Int.Input(
                                "高度", default=1024, min=1, max=16384, step=1,
                                tooltip="精确输出高度；需要不变形的裁切或填充，请用 GG 图像缩放 V2。",
                            ),
                        ]),
                    ]),
                    io.Combo.Input(
                        "缩放插值",
                        options=list(_缩放方法选项),
                        default="lanczos",
                        tooltip="重采样算法，所有缩放方式都生效；缩小用 area 更干净，放大用 lanczos 或 bicubic 更锐利。",
                    ),
                    io.DynamicCombo.Input(
                        "整除数",
                        options=[
                            io.DynamicCombo.Option(key="16", inputs=[]),
                            io.DynamicCombo.Option(key="0", inputs=[]),
                            io.DynamicCombo.Option(key="4", inputs=[]),
                            io.DynamicCombo.Option(key="8", inputs=[]),
                            io.DynamicCombo.Option(key="32", inputs=[]),
                            io.DynamicCombo.Option(key="64", inputs=[]),
                            io.DynamicCombo.Option(key="128", inputs=[]),
                            io.DynamicCombo.Option(key="自定义", inputs=[
                                io.Int.Input(
                                    "自定义整除数", default=24, min=1, max=256, step=1,
                                    tooltip="填这一档想要的倍数，例如 12、24、48。",
                                ),
                            ]),
                        ],
                        extra_dict={"default": "16"},
                        tooltip=(
                            "输出宽高会就近吸附到这个数的整数倍：填 1000 配 16 会得到 1008，不报错也不截断。"
                            "常用档直接选，其它值选「自定义」；选 0 表示不对齐。"
                        ),
                    ),
                ],
                outputs=[
                    io.Image.Output(display_name="图像"),
                ],
                search_aliases=["resize", "scale", "缩放", "图像缩放", "长边", "短边"],
            )

        @classmethod
        def execute(cls, 图像, 缩放方式="按倍数", 缩放插值="lanczos", 整除数="16"):
            return io.NodeOutput(_执行图像缩放(图像, 缩放方式, 缩放插值, 整除数=整除数))

    GG图像缩放 = GG图像缩放_V3

    class GG图像缩放V2_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GG图像缩放V2",
                display_name="GG 图像缩放 V2",
                category="GuliNodes/图像",
                description=(
                    "先按最长边、最短边或自定义宽高定出目标尺寸，再决定内容怎么落进框里："
                    "拉伸、裁剪，或按自定义颜色、边框主色、边缘像素填充留白。"
                    "遮罩随图像一起缩放，另输出实际宽高供下游按真实尺寸排布。"
                    "只显示当前选择下真正生效的参数。"
                ),
                inputs=[
                    io.Image.Input("图像", tooltip="要缩放的图像，支持批量。"),
                    io.Mask.Input(
                        "遮罩",
                        optional=True,
                        tooltip="可选；与图像同步缩放。不接时输出与图像同尺寸的全零遮罩。",
                    ),
                    io.DynamicCombo.Input("缩放方法", options=[
                        io.DynamicCombo.Option(key="按长边等比例", inputs=[
                            io.Int.Input(
                                "将边缩放到", default=1024, min=8, max=16384, step=1,
                                tooltip="把最长边缩放到这个像素，另一边按原比例推算；再就近对齐「整除数」。",
                            ),
                        ]),
                        io.DynamicCombo.Option(key="按短边等比例", inputs=[
                            io.Int.Input(
                                "将边缩放到", default=768, min=8, max=16384, step=1,
                                tooltip="把最短边缩放到这个像素，另一边按原比例推算；再就近对齐「整除数」。",
                            ),
                        ]),
                        io.DynamicCombo.Option(key="自定义宽高", inputs=[
                            io.Int.Input(
                                "宽度", default=1024, min=0, max=16384, step=1,
                                tooltip="目标宽度；填 0 表示按高度等比例推算，宽高都填 0 表示只按「整除数」处理。",
                            ),
                            io.Int.Input(
                                "高度", default=1024, min=0, max=16384, step=1,
                                tooltip="目标高度；填 0 表示按宽度等比例推算，宽高都填 0 表示只按「整除数」处理。",
                            ),
                        ]),
                    ]),
                    io.Combo.Input(
                        "缩放插值",
                        options=list(_缩放方法选项),
                        default="lanczos",
                        tooltip="重采样算法；缩小用 area 更干净，放大用 lanczos 或 bicubic 更锐利。遮罩始终用非振铃算法。",
                    ),
                    io.DynamicCombo.Input("缩放模式", options=[
                        io.DynamicCombo.Option(key="拉伸", inputs=[]),
                        io.DynamicCombo.Option(key="裁剪", inputs=[
                            io.Combo.Input(
                                "固定方向", options=list(_缩放V2方向选项), default="居中",
                                tooltip="等比盖满后裁掉多出的边，这里决定保留哪一侧。",
                            ),
                        ]),
                        io.DynamicCombo.Option(key="填充·自定义颜色", inputs=[
                            io.Combo.Input(
                                "固定方向", options=list(_缩放V2方向选项), default="居中",
                                tooltip="缩放到装进目标框后贴在哪个位置。",
                            ),
                            io.Color.Input(
                                "填充颜色", default="#364254",
                                tooltip="留白处的纯色，十六进制写法，例如 #364254。",
                            ),
                        ]),
                        io.DynamicCombo.Option(key="填充·边框颜色", inputs=[
                            io.Combo.Input(
                                "固定方向", options=list(_缩放V2方向选项), default="居中",
                                tooltip="缩放到装进目标框后贴在哪个位置。",
                            ),
                        ]),
                        io.DynamicCombo.Option(key="填充·边缘像素", inputs=[
                            io.Combo.Input(
                                "固定方向", options=list(_缩放V2方向选项), default="居中",
                                tooltip="缩放到装进目标框后贴在哪个位置。",
                            ),
                        ]),
                        io.DynamicCombo.Option(key="总像素等比例", inputs=[]),
                    ]),
                    io.Int.Input(
                        "整除数", default=0, min=0, max=256, step=1,
                        tooltip="把输出宽高就近对齐到这个数的整数倍（8、16、64 最常用）；填 0 表示不对齐。",
                    ),
                    io.Combo.Input(
                        "执行条件",
                        options=list(_缩放V2条件选项),
                        default="总是",
                        tooltip=(
                            "「最长边大于目标时」只缩不放，原图不够大就原样返回；"
                            "「最短边小于目标时」只放不缩。两种条件都仍会按「整除数」对齐。"
                        ),
                    ),
                ],
                outputs=[
                    io.Image.Output(display_name="图像"),
                    io.Int.Output(display_name="宽度"),
                    io.Int.Output(display_name="高度"),
                    io.Mask.Output(display_name="遮罩"),
                ],
                search_aliases=["resize", "scale", "图像缩放", "缩放", "填充", "裁剪"],
            )

        @classmethod
        def execute(cls, 图像, 遮罩=None, 缩放方法="按长边等比例", 缩放插值="lanczos",
                    缩放模式="拉伸", 整除数=0, 执行条件="总是"):
            方法, 方法值 = _unpack_mode(缩放方法, "缩放方法", "按长边等比例")
            模式, 模式值 = _unpack_mode(缩放模式, "缩放模式", "拉伸")
            图, 宽, 高, 罩 = _执行图像缩放V2(
                图像,
                遮罩,
                方法,
                缩放插值,
                模式,
                模式值.get("固定方向", "居中"),
                执行条件,
                模式值.get("填充颜色") or "#364254",
                整除数,
                方法值.get("宽度", 1024),
                方法值.get("高度", 1024),
                方法值.get("将边缩放到", 1024),
            )
            return io.NodeOutput(图, 宽, 高, 罩)

    GG图像缩放V2 = GG图像缩放V2_V3

    class GG尺寸适配_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GG尺寸适配",
                display_name="GG 尺寸适配",
                category="GuliNodes/图像",
                description=(
                    "按输入图像比例、常见训练比例和目标面积选择 Qwen-Image 2.1 稳定尺寸，"
                    "并通过内部缩放模拟检查固定点；输出可选择裁剪、补边或拉伸。"
                ),
                inputs=[
                    io.Image.Input("图像", tooltip="要适配的图像，支持批量。"),
                    io.Combo.Input(
                        "分辨率",
                        options=["default"] + [str(值) for 值 in _QWEN21_RESOLUTIONS],
                        default="default",
                        tooltip="default 按输入图像面积自动选择；也可固定为 512~2048 的 32 倍数。",
                    ),
                    io.Float.Input(
                        "容差比例",
                        default=1.0,
                        min=0.2,
                        max=3.0,
                        step=0.1,
                        tooltip="稳定尺寸候选的面积容差；数值越大，可选比例越多。",
                    ),
                    io.DynamicCombo.Input("模式", options=[
                        io.DynamicCombo.Option(key="裁剪", inputs=[]),
                        io.DynamicCombo.Option(key="补边", inputs=[
                            io.Float.Input(
                                "补边颜色",
                                default=0.0,
                                min=0.0,
                                max=1.0,
                                step=0.01,
                                tooltip="补边区域的灰度颜色，0 为黑色，1 为白色。",
                            ),
                        ]),
                        io.DynamicCombo.Option(key="拉伸", inputs=[]),
                    ]),
                ],
                outputs=[
                    io.Image.Output(display_name="图像"),
                    io.Int.Output(display_name="宽度"),
                    io.Int.Output(display_name="高度"),
                    io.Int.Output(display_name="分辨率"),
                ],
                search_aliases=[
                    "Qwen Image 2.1", "Qwen-Image", "稳定尺寸", "固定点", "裁剪", "补边"
                ],
            )

        @classmethod
        def execute(cls, 图像, 分辨率="default", 容差比例=1.0, 模式="裁剪"):
            处理模式, 模式值 = _unpack_mode(模式, "模式", "裁剪")
            return io.NodeOutput(*_执行Qwen21尺寸适配(
                图像,
                分辨率,
                容差比例,
                处理模式,
                模式值.get("补边颜色", 0.0),
            ))

    GG尺寸适配 = GG尺寸适配_V3

    class GG纯色图像_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GG纯色图像",
                display_name="GG 纯色图像",
                category="GuliNodes/图像",
                description=(
                    "按指定宽度、高度生成一张纯色图，作画布底、外扩填充色或合成垫底都可用。"
                    "不接任何输入，是纯发生器节点。"
                ),
                inputs=[
                    io.Int.Input(
                        "宽度", default=512, min=1, max=_纯色图像尺寸上限, step=1,
                        tooltip=f"输出图宽度（像素），最大 {_纯色图像尺寸上限}。",
                    ),
                    io.Int.Input(
                        "高度", default=512, min=1, max=_纯色图像尺寸上限, step=1,
                        tooltip=f"输出图高度（像素），最大 {_纯色图像尺寸上限}。",
                    ),
                    io.Color.Input(
                        "填充颜色", default="#00ff00",
                        tooltip="整张图的颜色，十六进制写法，例如 #00ff00。",
                    ),
                ],
                outputs=[io.Image.Output(display_name="图像")],
                search_aliases=["ColorImage", "纯色", "纯色图像", "空白图像", "画布", "背景色"],
            )

        @classmethod
        def execute(cls, 宽度=512, 高度=512, 填充颜色="#00ff00"):
            return io.NodeOutput(_生成纯色图像(宽度, 高度, 填充颜色))

    GG纯色图像 = GG纯色图像_V3

    class GG色彩校正_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GG色彩校正",
                display_name="GG 色彩校正",
                category="GuliNodes/图像",
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
    "GG图像缩放": GG图像缩放,
    "GG图像缩放V2": GG图像缩放V2,
    "GG尺寸适配": GG尺寸适配,
    "GG纯色图像": GG纯色图像,
}


NODE_DISPLAY_NAME_MAPPINGS = {
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
    "GGImageComparer4": "GG 图像对比 N张",
    "GG图像缩放": "GG 图像缩放",
    "GG图像缩放V2": "GG 图像缩放 V2",
    "GG尺寸适配": "GG 尺寸适配",
    "GG纯色图像": "GG 纯色图像",
}
