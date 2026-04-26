import torch
import torch.nn.functional as torch_F
from PIL import Image, ImageDraw, ImageFont
import numpy as np
from nodes import PreviewImage, SaveImage
import folder_paths
import os
import shutil
import subprocess
import tempfile

try:
    import cv2
except Exception:
    cv2 = None


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
    if cv2 is None:
        return _adain_transfer(content, style)

    outputs = []
    for i in range(content.shape[0]):
        content_np = (content[i].detach().cpu().numpy().clip(0.0, 1.0) * 255).astype(np.uint8)
        style_np = (style[min(i, style.shape[0] - 1)].detach().cpu().numpy().clip(0.0, 1.0) * 255).astype(np.uint8)
        content_lab = cv2.cvtColor(content_np, cv2.COLOR_RGB2LAB).astype(np.float32)
        style_lab = cv2.cvtColor(style_np, cv2.COLOR_RGB2LAB).astype(np.float32)
        c_mean, c_std = cv2.meanStdDev(content_lab)
        s_mean, s_std = cv2.meanStdDev(style_lab)
        c_mean = c_mean.reshape(1, 1, 3)
        c_std = c_std.reshape(1, 1, 3)
        s_mean = s_mean.reshape(1, 1, 3)
        s_std = s_std.reshape(1, 1, 3)
        transferred = (content_lab - c_mean) / np.maximum(c_std, 1e-5) * np.maximum(s_std, 1e-5) + s_mean
        transferred = np.clip(transferred, 0, 255).astype(np.uint8)
        rgb = cv2.cvtColor(transferred, cv2.COLOR_LAB2RGB).astype(np.float32) / 255.0
        outputs.append(torch.from_numpy(rgb).to(device=content.device, dtype=content.dtype))
    return torch.stack(outputs, dim=0).contiguous()


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


class GGRGBAtoRGB:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "背景颜色": (["白色", "黑色", "灰色", "自定义"], {"default": "白色"}),
            },
            "optional": {
                "背景R": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "round": 0.001}),
                "背景G": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "round": 0.001}),
                "背景B": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "round": 0.001}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "convert"
    CATEGORY = "GuliNodes/图像工具"

    def convert(self, 图像: torch.Tensor, 背景颜色: str = "白色", 背景R: float = 1.0, 背景G: float = 1.0, 背景B: float = 1.0) -> tuple:
        if 图像 is None:
            return (_empty_image(),)
        if 图像.shape[-1] == 1:
            return (图像.expand(*图像.shape[:-1], 3).contiguous(),)
        if 图像.shape[-1] == 2:
            gray = 图像[..., :1].expand(*图像.shape[:-1], 3)
            alpha = 图像[..., 1:2].clamp(0.0, 1.0)
            background = self._background(图像, 背景颜色, 背景R, 背景G, 背景B)
            return (torch.clamp(gray * alpha + background * (1.0 - alpha), 0.0, 1.0).contiguous(),)
        if 图像.shape[-1] == 3:
            return (图像,)
        if 图像.shape[-1] >= 4:
            rgb = 图像[..., :3]
            alpha = 图像[..., 3:4].clamp(0.0, 1.0)
            background = self._background(图像, 背景颜色, 背景R, 背景G, 背景B)
            return (torch.clamp(rgb * alpha + background * (1.0 - alpha), 0.0, 1.0).contiguous(),)
        return (_empty_image(图像.device, 图像.dtype),)

    @staticmethod
    def _background(图像: torch.Tensor, 背景颜色: str, 背景R: float, 背景G: float, 背景B: float) -> torch.Tensor:
        presets = {
            "白色": (1.0, 1.0, 1.0),
            "黑色": (0.0, 0.0, 0.0),
            "灰色": (0.5, 0.5, 0.5),
        }
        color = presets.get(背景颜色, (背景R, 背景G, 背景B))
        return torch.tensor(color, device=图像.device, dtype=图像.dtype).view(1, 1, 1, 3)


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
            return (_empty_image(),)

        if 模式 == "按比例":
            new_height = int(图像.shape[1] * 缩放比例)
            new_width = int(图像.shape[2] * 缩放比例)
        else:
            new_height = 高度
            new_width = 宽度

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
    CATEGORY = "GuliNodes/图像工具"

    def crop(self, 图像: torch.Tensor, 模式: str = "中心裁剪",
              宽度: int = 512, 高度: int = 512, X坐标: int = 0, Y坐标: int = 0,
              宽高比例: str = "16:9", 边长: int = 1024, 边长类型: str = "最长边") -> tuple:
        if 图像 is None:
            return (_empty_image(),)

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

            crop_width = _align_to_eight(crop_width)
            crop_height = _align_to_eight(crop_height)

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
                "亮度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.1, "round": 0.01}),
                "对比度": ("FLOAT", {"default": 1.1, "min": 0.0, "max": 5.0, "step": 0.1, "round": 0.01}),
                "饱和度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.1, "round": 0.01}),
                "锐化": ("FLOAT", {"default": 1.2, "min": 0.0, "max": 10.0, "step": 0.1, "round": 0.01}),
                "虚化": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 20.0, "step": 0.1, "round": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "adjust"
    CATEGORY = "GuliNodes/图像工具"

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


class GGFaceSkinSmoothing:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
            },
            "optional": {
                "平滑": ("INT", {"default": 8, "min": 1, "max": 100, "step": 1}),
                "阈值": ("INT", {"default": -10, "min": -100, "max": 100, "step": 1}),
                "不透明度": ("INT", {"default": 85, "min": 0, "max": 100, "step": 1}),
                "脸部扩展": ("FLOAT", {"default": 1.2, "min": 0.8, "max": 2.0, "step": 0.05, "round": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("图像", "磨皮遮罩")
    FUNCTION = "smooth"
    CATEGORY = "GuliNodes/图像工具"

    def smooth(self, 图像: torch.Tensor, 平滑: int = 8, 阈值: int = -10, 不透明度: int = 85, 脸部扩展: float = 1.2) -> tuple:
        image = _to_rgb_image(图像)
        if cv2 is None or image is None:
            return (image, torch.zeros(image.shape[0], image.shape[1], image.shape[2], device=image.device, dtype=image.dtype))

        output_images = []
        output_masks = []
        opacity = max(0.0, min(float(不透明度) / 100.0, 1.0))
        strength = max(1, int(平滑))
        detail_threshold = max(0.0, min((float(阈值) + 100.0) / 200.0, 1.0))

        for batch_index in range(image.shape[0]):
            source = image[batch_index].detach().cpu().numpy()
            source_u8 = (np.clip(source, 0.0, 1.0) * 255.0).astype(np.uint8)
            mask_u8 = self._detect_face_mask(source_u8, 脸部扩展)

            if mask_u8.max() == 0 or opacity <= 0:
                output_images.append(image[batch_index])
                output_masks.append(torch.zeros(image.shape[1], image.shape[2], device=image.device, dtype=image.dtype))
                continue

            smooth_u8 = self._smooth_image(source_u8, strength)
            if detail_threshold > 0:
                diff = np.mean(np.abs(source_u8.astype(np.float32) - smooth_u8.astype(np.float32)), axis=2)
                protect = np.clip(diff / max(1.0, detail_threshold * 80.0), 0.0, 1.0)
                mask_float = (mask_u8.astype(np.float32) / 255.0) * (1.0 - protect * 0.65)
            else:
                mask_float = mask_u8.astype(np.float32) / 255.0

            mask_float = np.clip(mask_float * opacity, 0.0, 1.0)
            blended = source_u8.astype(np.float32) * (1.0 - mask_float[..., None]) + smooth_u8.astype(np.float32) * mask_float[..., None]
            blended = np.clip(blended, 0.0, 255.0).astype(np.uint8)
            output_images.append(torch.from_numpy(blended.astype(np.float32) / 255.0).to(device=image.device, dtype=image.dtype))
            output_masks.append(torch.from_numpy(mask_float.astype(np.float32)).to(device=image.device, dtype=image.dtype))

        return (torch.stack(output_images, dim=0).contiguous(), torch.stack(output_masks, dim=0).contiguous())

    @staticmethod
    def _detect_face_mask(image_u8: np.ndarray, expansion: float) -> np.ndarray:
        gray = cv2.cvtColor(image_u8, cv2.COLOR_RGB2GRAY)
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        detector = cv2.CascadeClassifier(cascade_path)
        faces = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(32, 32))

        mask = np.zeros(gray.shape, dtype=np.uint8)
        height, width = gray.shape
        for x, y, w, h in faces:
            cx = x + w / 2.0
            cy = y + h / 2.0
            ew = w * expansion
            eh = h * expansion * 1.15
            x1 = int(max(0, cx - ew / 2.0))
            y1 = int(max(0, cy - eh / 2.0))
            x2 = int(min(width, cx + ew / 2.0))
            y2 = int(min(height, cy + eh / 2.0))
            center = ((x1 + x2) // 2, (y1 + y2) // 2)
            axes = (max(1, (x2 - x1) // 2), max(1, (y2 - y1) // 2))
            cv2.ellipse(mask, center, axes, 0, 0, 360, 255, -1)

        if mask.max() > 0:
            mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=12, sigmaY=12)
        return mask

    @staticmethod
    def _smooth_image(image_u8: np.ndarray, strength: int) -> np.ndarray:
        diameter = max(5, min(31, int(strength / 3) * 2 + 1))
        sigma_color = max(20, min(150, strength * 3))
        sigma_space = max(5, min(80, strength))
        smooth = cv2.bilateralFilter(image_u8, diameter, sigma_color, sigma_space)
        blur = cv2.GaussianBlur(smooth, (0, 0), sigmaX=max(0.1, strength / 18.0))
        return cv2.addWeighted(smooth, 0.75, blur, 0.25, 0)


class GGFaceSmartBeauty:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"图像": ("IMAGE",)},
            "optional": {
                "自动磨皮": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "自动污点修复": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "自动美白皮肤": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "自动除油": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "眼白提亮": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "眼睛大小": ("INT", {"default": 0, "min": -50, "max": 100, "step": 1}),
                "牙齿美白": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "自动瘦脸": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "脸部扩展": ("FLOAT", {"default": 1.35, "min": 0.8, "max": 2.0, "step": 0.05, "round": 0.01}),
                "检测灵敏度": ("INT", {"default": 45, "min": 0, "max": 100, "step": 1}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("图像", "人脸遮罩")
    FUNCTION = "beautify"
    CATEGORY = "GuliNodes/图像工具"

    def beautify(self, **kwargs) -> tuple:
        image = _to_rgb_image(kwargs.get("图像"))
        if cv2 is None or image is None:
            empty_mask = torch.zeros(image.shape[0], image.shape[1], image.shape[2], device=image.device, dtype=image.dtype)
            return (image, empty_mask)

        skin_strength = float(kwargs.get("自动磨皮", 0)) / 100.0
        blemish_strength = float(kwargs.get("自动污点修复", 0)) / 100.0
        whitening_strength = float(kwargs.get("自动美白皮肤", 0)) / 100.0
        oil_strength = float(kwargs.get("自动除油", 0)) / 100.0
        eye_white_strength = float(kwargs.get("眼白提亮", 0)) / 100.0
        eye_scale = float(kwargs.get("眼睛大小", 0)) / 100.0
        teeth_strength = float(kwargs.get("牙齿美白", 0)) / 100.0
        slim_strength = float(kwargs.get("自动瘦脸", 0)) / 100.0
        expansion = float(kwargs.get("脸部扩展", 1.35))
        sensitivity = int(kwargs.get("检测灵敏度", 45))

        outputs = []
        masks = []
        for batch_index in range(image.shape[0]):
            source = image[batch_index].detach().cpu().numpy()
            source_u8 = (np.clip(source, 0.0, 1.0) * 255.0).astype(np.uint8)
            faces = self._detect_faces(source_u8, sensitivity)
            face_mask = self._face_mask(source_u8.shape[:2], faces, expansion)
            if not faces or face_mask.max() == 0:
                outputs.append(image[batch_index])
                masks.append(torch.zeros(image.shape[1], image.shape[2], device=image.device, dtype=image.dtype))
                continue

            result = source_u8.copy()
            if slim_strength > 0:
                result = self._slim_faces(result, faces, slim_strength)
                face_mask = self._face_mask(result.shape[:2], faces, expansion)
            if blemish_strength > 0:
                result = self._repair_blemishes(result, face_mask, faces, blemish_strength)
            if skin_strength > 0:
                result = self._smooth_skin(result, face_mask, faces, skin_strength)
            if whitening_strength > 0:
                result = self._whiten_skin(result, face_mask, faces, whitening_strength)
            if oil_strength > 0:
                result = self._reduce_oil(result, face_mask, faces, oil_strength)
            if eye_white_strength > 0 or abs(eye_scale) > 0.001:
                result = self._enhance_eyes(result, faces, eye_white_strength, eye_scale, sensitivity)
            if teeth_strength > 0:
                result = self._whiten_teeth(result, faces, teeth_strength)

            outputs.append(torch.from_numpy(result.astype(np.float32) / 255.0).to(device=image.device, dtype=image.dtype))
            masks.append(torch.from_numpy(face_mask.astype(np.float32) / 255.0).to(device=image.device, dtype=image.dtype))
        return (torch.stack(outputs, dim=0).contiguous(), torch.stack(masks, dim=0).contiguous())

    @staticmethod
    def _detect_faces(image_u8: np.ndarray, sensitivity: int) -> list:
        gray = cv2.cvtColor(image_u8, cv2.COLOR_RGB2GRAY)
        detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        min_neighbors = max(2, min(8, 8 - int(sensitivity / 18)))
        scale_factor = 1.05 if sensitivity >= 70 else 1.08 if sensitivity >= 40 else 1.12
        faces = detector.detectMultiScale(gray, scaleFactor=scale_factor, minNeighbors=min_neighbors, minSize=(32, 32))
        return [tuple(map(int, face)) for face in faces]

    @staticmethod
    def _face_mask(shape: tuple, faces: list, expansion: float) -> np.ndarray:
        height, width = shape
        mask = np.zeros((height, width), dtype=np.uint8)
        for x, y, w, h in faces:
            cx = x + w / 2.0
            cy = y + h / 2.0
            axes = (max(1, int(w * expansion / 2.0)), max(1, int(h * expansion * 1.15 / 2.0)))
            cv2.ellipse(mask, (int(cx), int(cy)), axes, 0, 0, 360, 255, -1)
        if mask.max() > 0:
            mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=10, sigmaY=10)
        return mask

    @classmethod
    def _facial_feature_protect_mask(cls, image_u8: np.ndarray, faces: list) -> np.ndarray:
        height, width = image_u8.shape[:2]
        protect = np.zeros((height, width), dtype=np.float32)
        gray = cv2.cvtColor(image_u8, cv2.COLOR_RGB2GRAY)
        for face in faces:
            x, y, w, h = face
            cx = x + w / 2.0
            eye_y = y + h * 0.38
            nose_y = y + h * 0.54
            mouth_y = y + h * 0.74
            cv2.ellipse(protect, (int(cx), int(eye_y)), (max(1, int(w * 0.43)), max(1, int(h * 0.13))), 0, 0, 360, 1.0, -1)
            cv2.ellipse(protect, (int(cx), int(nose_y)), (max(1, int(w * 0.18)), max(1, int(h * 0.22))), 0, 0, 360, 0.95, -1)
            cv2.ellipse(protect, (int(cx), int(mouth_y)), (max(1, int(w * 0.33)), max(1, int(h * 0.15))), 0, 0, 360, 1.0, -1)
            for ex, ey, ew, eh in cls._detect_eyes(gray, face, 60):
                cv2.ellipse(protect, (ex + ew // 2, ey + eh // 2), (max(1, int(ew * 0.82)), max(1, int(eh * 0.72))), 0, 0, 360, 1.0, -1)
        if protect.max() > 0:
            protect = cv2.GaussianBlur(protect, (0, 0), sigmaX=4.0, sigmaY=4.0)
        return np.clip(protect, 0.0, 1.0)


    @classmethod
    def _protected_skin_mask(cls, image_u8: np.ndarray, face_mask: np.ndarray, faces: list, fallback_to_face: bool = True) -> np.ndarray:
        skin_mask = cls._skin_color_mask(image_u8, face_mask)
        if skin_mask.max() == 0 and fallback_to_face:
            skin_mask = face_mask.astype(np.float32) / 255.0
        protect = cls._facial_feature_protect_mask(image_u8, faces)
        mask = skin_mask * (1.0 - protect)
        if mask.max() > 0:
            mask = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), sigmaX=2.0, sigmaY=2.0)
        return np.clip(mask, 0.0, 1.0)

    @classmethod
    def _smooth_skin(cls, image_u8: np.ndarray, face_mask: np.ndarray, faces: list, strength: float) -> np.ndarray:
        diameter = max(5, int(7 + strength * 22) // 2 * 2 + 1)
        smooth = cv2.bilateralFilter(image_u8, diameter, 35 + strength * 110, 12 + strength * 55)
        blur = cv2.GaussianBlur(smooth, (0, 0), sigmaX=0.5 + strength * 1.8)
        smooth = cv2.addWeighted(smooth, 0.8, blur, 0.2, 0)
        mask = cls._protected_skin_mask(image_u8, face_mask, faces)
        mask = np.clip(mask * min(0.9, 0.18 + strength * 0.72), 0.0, 0.9)
        return np.clip(image_u8.astype(np.float32) * (1.0 - mask[..., None]) + smooth.astype(np.float32) * mask[..., None], 0, 255).astype(np.uint8)

    @classmethod
    def _reduce_oil(cls, image_u8: np.ndarray, face_mask: np.ndarray, faces: list, strength: float) -> np.ndarray:
        skin = cls._protected_skin_mask(image_u8, face_mask, faces)
        if skin.max() == 0:
            return image_u8
        hsv = cv2.cvtColor(image_u8, cv2.COLOR_RGB2HSV).astype(np.float32)
        value_blur = cv2.GaussianBlur(hsv[..., 2], (0, 0), sigmaX=9.0)
        local_highlight = np.clip((hsv[..., 2] - value_blur + 18.0) / 55.0, 0.0, 1.0)
        highlight = ((hsv[..., 2] > 150) & (hsv[..., 1] < 130)).astype(np.float32) * local_highlight * skin
        highlight = cv2.GaussianBlur(highlight, (0, 0), sigmaX=5, sigmaY=5)
        if highlight.max() == 0:
            return image_u8
        matte = cv2.bilateralFilter(image_u8, 9, 45 + strength * 80, 20 + strength * 50)
        matte = cv2.GaussianBlur(matte, (0, 0), sigmaX=1.2 + strength * 2.8)
        alpha = np.clip(highlight * (0.28 + strength * 0.85), 0.0, 0.92)
        return np.clip(image_u8.astype(np.float32) * (1.0 - alpha[..., None]) + matte.astype(np.float32) * alpha[..., None], 0, 255).astype(np.uint8)


    @staticmethod
    def _skin_color_mask(image_u8: np.ndarray, face_mask: np.ndarray) -> np.ndarray:
        ycrcb = cv2.cvtColor(image_u8, cv2.COLOR_RGB2YCrCb)
        cr = ycrcb[..., 1]
        cb = ycrcb[..., 2]
        skin = ((cr > 132) & (cr < 180) & (cb > 75) & (cb < 145) & (face_mask > 20)).astype(np.float32)
        if skin.max() > 0:
            skin = cv2.GaussianBlur(skin, (0, 0), sigmaX=3, sigmaY=3)
        return np.clip(skin, 0.0, 1.0)

    @classmethod
    def _repair_blemishes(cls, image_u8: np.ndarray, face_mask: np.ndarray, faces: list, strength: float) -> np.ndarray:
        skin = cls._protected_skin_mask(image_u8, face_mask, faces)
        if skin.max() == 0:
            return image_u8
        lab = cv2.cvtColor(image_u8, cv2.COLOR_RGB2LAB)
        l_channel = lab[..., 0].astype(np.float32)
        local = cv2.GaussianBlur(l_channel, (0, 0), sigmaX=3.5)
        dark_spots = np.clip((local - l_channel - 3.0) / 22.0, 0.0, 1.0)
        color_diff = np.mean(np.abs(image_u8.astype(np.float32) - cv2.GaussianBlur(image_u8, (0, 0), sigmaX=2.0).astype(np.float32)), axis=2)
        spot_detail = np.clip((color_diff - 4.0) / 32.0, 0.0, 1.0)
        blemish = np.clip((dark_spots * 0.75 + spot_detail * 0.45) * skin, 0.0, 1.0)
        blemish = cv2.GaussianBlur(blemish, (0, 0), sigmaX=1.8)
        if blemish.max() == 0:
            return image_u8
        repaired = cv2.inpaint(image_u8, (blemish > 0.06).astype(np.uint8) * 255, 4, cv2.INPAINT_TELEA)
        smooth_repair = cv2.bilateralFilter(repaired, 7, 45, 25)
        alpha = np.clip(blemish * (0.35 + strength * 0.95), 0.0, 0.95)
        return np.clip(image_u8.astype(np.float32) * (1.0 - alpha[..., None]) + smooth_repair.astype(np.float32) * alpha[..., None], 0, 255).astype(np.uint8)


    @classmethod
    def _whiten_skin(cls, image_u8: np.ndarray, face_mask: np.ndarray, faces: list, strength: float) -> np.ndarray:
        skin = cls._protected_skin_mask(image_u8, face_mask, faces)
        if skin.max() == 0:
            return image_u8
        lab = cv2.cvtColor(image_u8, cv2.COLOR_RGB2LAB).astype(np.float32)
        lab[..., 0] = np.clip(lab[..., 0] + 28.0 * strength * skin, 0, 255)
        lab[..., 1] = np.clip(lab[..., 1] - 2.0 * strength * skin, 0, 255)
        lab[..., 2] = np.clip(lab[..., 2] - 4.0 * strength * skin, 0, 255)
        rgb = cv2.cvtColor(lab.astype(np.uint8), cv2.COLOR_LAB2RGB).astype(np.float32)
        hsv = cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
        hsv[..., 1] *= (1.0 - skin * strength * 0.22)
        white = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2RGB)
        alpha = np.clip(skin * (0.22 + strength * 0.68), 0.0, 0.88)
        return np.clip(image_u8.astype(np.float32) * (1.0 - alpha[..., None]) + white.astype(np.float32) * alpha[..., None], 0, 255).astype(np.uint8)

    @staticmethod
    def _detect_eyes(gray: np.ndarray, face: tuple, sensitivity: int) -> list:
        x, y, w, h = face
        roi = gray[y:y + int(h * 0.62), x:x + w]
        if roi.size == 0:
            return []
        detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_eye.xml")
        eyes = detector.detectMultiScale(roi, scaleFactor=1.08, minNeighbors=max(3, min(8, 7 - int(sensitivity / 25))), minSize=(max(8, w // 12), max(8, h // 12)))
        result = []
        for ex, ey, ew, eh in eyes:
            if ey > h * 0.48:
                continue
            result.append((x + int(ex), y + int(ey), int(ew), int(eh)))
        result.sort(key=lambda item: item[2] * item[3], reverse=True)
        return result[:2]

    @staticmethod
    def _local_scale(image_u8: np.ndarray, center: tuple, radius_x: int, radius_y: int, scale: float) -> np.ndarray:
        if abs(scale) < 0.001:
            return image_u8
        height, width = image_u8.shape[:2]
        cx, cy = center
        x1 = max(0, int(cx - radius_x)); y1 = max(0, int(cy - radius_y))
        x2 = min(width, int(cx + radius_x)); y2 = min(height, int(cy + radius_y))
        if x2 <= x1 + 2 or y2 <= y1 + 2:
            return image_u8
        roi = image_u8[y1:y2, x1:x2].copy()
        yy, xx = np.indices((y2 - y1, x2 - x1), dtype=np.float32)
        local_cx = cx - x1; local_cy = cy - y1
        nx = (xx - local_cx) / max(1.0, radius_x)
        ny = (yy - local_cy) / max(1.0, radius_y)
        dist = np.clip(nx * nx + ny * ny, 0.0, 1.0)
        weight = (1.0 - dist) ** 1.5
        factor = 1.0 + scale * weight
        map_x = local_cx + (xx - local_cx) / np.maximum(factor, 0.2)
        map_y = local_cy + (yy - local_cy) / np.maximum(factor, 0.2)
        warped = cv2.remap(roi, map_x.astype(np.float32), map_y.astype(np.float32), interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        alpha = (weight * min(1.0, abs(scale) * 1.5 + 0.25))[..., None]
        out = image_u8.copy()
        out[y1:y2, x1:x2] = np.clip(roi.astype(np.float32) * (1.0 - alpha) + warped.astype(np.float32) * alpha, 0, 255).astype(np.uint8)
        return out

    @staticmethod
    def _eye_white_mask(roi: np.ndarray) -> np.ndarray:
        if roi.size == 0:
            return np.zeros(roi.shape[:2], dtype=np.float32)
        height, width = roi.shape[:2]
        hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV).astype(np.float32)
        gray = cv2.cvtColor(roi, cv2.COLOR_RGB2GRAY).astype(np.float32)
        yy, xx = np.indices((height, width), dtype=np.float32)
        cx = (width - 1) / 2.0
        cy = (height - 1) / 2.0
        eye_shape = (((xx - cx) / max(1.0, width * 0.46)) ** 2 + ((yy - cy) / max(1.0, height * 0.34)) ** 2) <= 1.0
        low_saturation = hsv[..., 1] < 95
        bright_enough = hsv[..., 2] > max(55.0, float(np.percentile(hsv[..., 2], 35)))
        not_skin_ycrcb = cv2.cvtColor(roi, cv2.COLOR_RGB2YCrCb)
        cr = not_skin_ycrcb[..., 1]
        cb = not_skin_ycrcb[..., 2]
        skin_like = (cr > 135) & (cr < 180) & (cb > 75) & (cb < 145)
        iris_dark = gray < max(45.0, float(np.percentile(gray, 22)))
        iris_dark = cv2.dilate(iris_dark.astype(np.uint8), np.ones((3, 3), dtype=np.uint8), iterations=1).astype(bool)
        center_protect = (((xx - cx) / max(1.0, width * 0.18)) ** 2 + ((yy - cy) / max(1.0, height * 0.28)) ** 2) <= 1.0
        edge_protect = (yy < height * 0.18) | (yy > height * 0.82) | (xx < width * 0.05) | (xx > width * 0.95)
        mask = eye_shape & low_saturation & bright_enough & (~skin_like) & (~iris_dark) & (~center_protect) & (~edge_protect)
        if mask.sum() < max(4, int(width * height * 0.015)):
            mask = eye_shape & low_saturation & bright_enough & (~iris_dark) & (~edge_protect)
        mask = mask.astype(np.float32)
        if mask.max() > 0:
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), dtype=np.uint8))
            mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=1.1, sigmaY=1.1)
        return np.clip(mask, 0.0, 1.0)

    @classmethod
    def _enhance_eyes(cls, image_u8: np.ndarray, faces: list, white_strength: float, eye_scale: float, sensitivity: int) -> np.ndarray:
        result = image_u8.copy()
        gray = cv2.cvtColor(result, cv2.COLOR_RGB2GRAY)
        for face in faces:
            for ex, ey, ew, eh in cls._detect_eyes(gray, face, sensitivity):
                if abs(eye_scale) > 0.001:
                    result = cls._local_scale(result, (ex + ew // 2, ey + eh // 2), max(ew, 8), max(eh, 8), eye_scale * 0.45)
                if white_strength <= 0:
                    continue
                pad_x = max(1, int(ew * 0.08))
                pad_y = max(1, int(eh * 0.08))
                x1 = max(0, ex - pad_x)
                y1 = max(0, ey - pad_y)
                x2 = min(result.shape[1], ex + ew + pad_x)
                y2 = min(result.shape[0], ey + eh + pad_y)
                roi = result[y1:y2, x1:x2]
                if roi.size == 0:
                    continue
                white_mask = cls._eye_white_mask(roi)
                if white_mask.max() <= 0:
                    continue
                lab = cv2.cvtColor(roi, cv2.COLOR_RGB2LAB).astype(np.float32)
                hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV).astype(np.float32)
                lab[..., 0] = np.clip(lab[..., 0] + white_mask * white_strength * 32.0, 0, 255)
                enhanced = cv2.cvtColor(lab.astype(np.uint8), cv2.COLOR_LAB2RGB).astype(np.float32)
                enhanced_hsv = cv2.cvtColor(enhanced.astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
                enhanced_hsv[..., 1] = np.clip(hsv[..., 1] * (1.0 - white_mask * white_strength * 0.38), 0, 255)
                enhanced = cv2.cvtColor(enhanced_hsv.astype(np.uint8), cv2.COLOR_HSV2RGB)
                alpha = np.clip(white_mask * (0.25 + white_strength * 0.65), 0.0, 0.85)
                result[y1:y2, x1:x2] = np.clip(roi.astype(np.float32) * (1.0 - alpha[..., None]) + enhanced.astype(np.float32) * alpha[..., None], 0, 255).astype(np.uint8)
        return result

    @staticmethod
    def _tooth_mask(roi: np.ndarray) -> np.ndarray:
        if roi.size == 0:
            return np.zeros(roi.shape[:2], dtype=np.float32)
        height, width = roi.shape[:2]
        hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV).astype(np.float32)
        ycrcb = cv2.cvtColor(roi, cv2.COLOR_RGB2YCrCb)
        cr = ycrcb[..., 1].astype(np.float32)
        cb = ycrcb[..., 2].astype(np.float32)
        yy, xx = np.indices((height, width), dtype=np.float32)
        cx = (width - 1) / 2.0
        cy = (height - 1) / 2.0
        mouth_ellipse = (((xx - cx) / max(1.0, width * 0.46)) ** 2 + ((yy - cy) / max(1.0, height * 0.34)) ** 2) <= 1.0
        low_sat = hsv[..., 1] < 90
        bright = hsv[..., 2] > max(85.0, float(np.percentile(hsv[..., 2], 55)))
        not_lip = ~(((cr > 145) & (cb < 135) & (hsv[..., 1] > 55)) | (hsv[..., 0] < 8) | (hsv[..., 0] > 168))
        not_shadow = hsv[..., 2] > 70
        candidate = (mouth_ellipse & low_sat & bright & not_lip & not_shadow).astype(np.uint8)
        candidate = cv2.morphologyEx(candidate, cv2.MORPH_OPEN, np.ones((2, 2), dtype=np.uint8))
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(candidate, 8)
        mask = np.zeros((height, width), dtype=np.float32)
        min_area = max(3, int(width * height * 0.01))
        for label in range(1, num_labels):
            area = stats[label, cv2.CC_STAT_AREA]
            x = stats[label, cv2.CC_STAT_LEFT]
            y = stats[label, cv2.CC_STAT_TOP]
            w = stats[label, cv2.CC_STAT_WIDTH]
            h = stats[label, cv2.CC_STAT_HEIGHT]
            if area < min_area or h > height * 0.75 or w < width * 0.05:
                continue
            mask[labels == label] = 1.0
        if mask.max() == 0:
            fallback = (mouth_ellipse & (hsv[..., 1] < 105) & (hsv[..., 2] > 105) & not_lip).astype(np.float32)
            mask = fallback
        if mask.max() > 0:
            mask = cv2.dilate(mask.astype(np.uint8), np.ones((2, 2), dtype=np.uint8), iterations=1).astype(np.float32)
            mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=1.6, sigmaY=1.6)
        return np.clip(mask, 0.0, 1.0)

    @classmethod
    def _whiten_teeth(cls, image_u8: np.ndarray, faces: list, strength: float) -> np.ndarray:
        result = image_u8.copy()
        for x, y, w, h in faces:
            mx1 = max(0, x + int(w * 0.18)); mx2 = min(result.shape[1], x + int(w * 0.82))
            my1 = max(0, y + int(h * 0.56)); my2 = min(result.shape[0], y + int(h * 0.86))
            roi = result[my1:my2, mx1:mx2]
            if roi.size == 0:
                continue
            tooth_mask = cls._tooth_mask(roi)
            if tooth_mask.max() <= 0:
                continue
            lab = cv2.cvtColor(roi, cv2.COLOR_RGB2LAB).astype(np.float32)
            hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV).astype(np.float32)
            lab[..., 0] = np.clip(lab[..., 0] + tooth_mask * strength * 34.0, 0, 255)
            enhanced = cv2.cvtColor(lab.astype(np.uint8), cv2.COLOR_LAB2RGB).astype(np.float32)
            enhanced_hsv = cv2.cvtColor(enhanced.astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
            enhanced_hsv[..., 1] = np.clip(hsv[..., 1] * (1.0 - tooth_mask * strength * 0.52), 0, 255)
            enhanced = cv2.cvtColor(enhanced_hsv.astype(np.uint8), cv2.COLOR_HSV2RGB)
            alpha = np.clip(tooth_mask * (0.25 + strength * 0.65), 0.0, 0.88)
            result[my1:my2, mx1:mx2] = np.clip(roi.astype(np.float32) * (1.0 - alpha[..., None]) + enhanced.astype(np.float32) * alpha[..., None], 0, 255).astype(np.uint8)
        return result





    @staticmethod
    def _slim_faces(image_u8: np.ndarray, faces: list, strength: float) -> np.ndarray:
        height, width = image_u8.shape[:2]
        base_x, base_y = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
        map_x = base_x.copy()
        map_y = base_y.copy()
        strength = max(0.0, min(float(strength), 1.0))
        for x, y, w, h in faces:
            cx = x + w / 2.0
            nx = (base_x - cx) / max(1.0, w * 0.5)
            ny = (base_y - (y + h * 0.60)) / max(1.0, h * 0.48)

            cheek_band = (np.abs(nx) > 0.34).astype(np.float32)
            cheek_band *= (np.abs(nx) < 1.05).astype(np.float32)
            vertical_band = np.exp(-(ny ** 2) * 1.8)
            jaw_weight = np.clip((base_y - (y + h * 0.34)) / max(1.0, h * 0.58), 0.0, 1.0)
            nose_protect = np.exp(-((base_x - cx) / max(1.0, w * 0.20)) ** 2 - ((base_y - (y + h * 0.52)) / max(1.0, h * 0.30)) ** 2)
            mouth_protect = np.exp(-((base_x - cx) / max(1.0, w * 0.26)) ** 2 - ((base_y - (y + h * 0.74)) / max(1.0, h * 0.16)) ** 2)
            eye_protect = np.exp(-((base_x - cx) / max(1.0, w * 0.42)) ** 2 - ((base_y - (y + h * 0.38)) / max(1.0, h * 0.18)) ** 2)
            protect = np.clip(nose_protect * 0.95 + mouth_protect * 0.85 + eye_protect * 0.75, 0.0, 1.0)

            weight = cheek_band * vertical_band * jaw_weight * (1.0 - protect)
            weight = cv2.GaussianBlur(weight.astype(np.float32), (0, 0), sigmaX=max(2.0, w * 0.025), sigmaY=max(2.0, h * 0.025))
            direction = np.sign(base_x - cx)
            inward_pull = direction * weight * strength * w * 0.055
            map_x = map_x + inward_pull

        return cv2.remap(image_u8, map_x, map_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


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
    CATEGORY = "GuliNodes/图像工具"

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
    CATEGORY = "GuliNodes/图像工具"

    def preview(self, 图像, prompt=None, extra_pnginfo=None):
        return self.save_images(图像, filename_prefix="GG.preview", prompt=prompt, extra_pnginfo=extra_pnginfo)


class GGSaveImage(SaveImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "文件名前缀": ("STRING", {"default": "%date:yyyy_MM_dd%/图像"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    FUNCTION = "save"
    CATEGORY = "GuliNodes/图像工具"
    OUTPUT_NODE = True

    def save(self, 图像, 文件名前缀="%date:yyyy_MM_dd%/图像", prompt=None, extra_pnginfo=None):
        return self.save_images(图像, filename_prefix=文件名前缀, prompt=prompt, extra_pnginfo=extra_pnginfo)


class GGHighQualityImageCompress(SaveImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "格式": (["WEBP", "JPEG", "PNG"], {"default": "JPEG"}),
                "质量": ("INT", {"default": 85, "min": 1, "max": 100, "step": 1}),
            },
            "optional": {
                "无损": ("BOOLEAN", {"default": True}),
                "保留元数据": ("BOOLEAN", {"default": False}),
                "优先外部优化器": ("BOOLEAN", {"default": True}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "compress"
    CATEGORY = "GuliNodes/图像工具"
    OUTPUT_NODE = True

    def compress(self, 图像, 格式="JPEG", 质量=85, 无损=False,
                 保留元数据=False, 优先外部优化器=True, prompt=None, extra_pnginfo=None):
        文件名前缀 = "%date:yyyy_MM_dd%/meowtec图像压缩"
        output_dir = folder_paths.get_output_directory()
        ext = self._extension(格式)
        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(
            文件名前缀, output_dir, 图像[0].shape[1], 图像[0].shape[0]
        )

        results = []
        output_images = []
        for batch_number, image in enumerate(图像):
            pil_image = self._to_pil(image, 格式)
            filename_with_batch_num = filename.replace("%batch_num%", str(batch_number))
            file = f"{filename_with_batch_num}_{counter:05}_.{ext}"
            output_path = os.path.join(full_output_folder, file)
            self._save_optimized(pil_image, output_path, 格式, int(质量), bool(无损), bool(保留元数据), bool(优先外部优化器))
            results.append({"filename": file, "subfolder": subfolder, "type": "output"})
            with Image.open(output_path) as saved_image:
                output_images.append(_pil_to_tensor(saved_image, device=image.device, dtype=image.dtype))
            counter += 1

        return {"ui": {"images": results}, "result": (torch.stack(output_images, dim=0).contiguous(),)}

    @staticmethod
    def _extension(format_name: str) -> str:
        return {"WEBP": "webp", "JPEG": "jpg", "PNG": "png"}.get(format_name, "webp")

    @staticmethod
    def _to_pil(image: torch.Tensor, format_name: str) -> Image.Image:
        array = np.clip(255.0 * image.detach().cpu().numpy(), 0, 255).astype(np.uint8)
        pil_image = Image.fromarray(array)
        if format_name in ("WEBP", "JPEG") and pil_image.mode != "RGB":
            pil_image = pil_image.convert("RGB")
        return pil_image

    def _save_optimized(self, pil_image: Image.Image, output_path: str, format_name: str, quality: int,
                        lossless: bool, keep_metadata: bool, prefer_external: bool) -> None:
        if prefer_external and self._save_with_external_optimizer(pil_image, output_path, format_name, quality, lossless):
            return

        save_kwargs = {"optimize": True}
        if format_name == "WEBP":
            save_kwargs.update({"quality": quality, "method": 6, "lossless": lossless})
        elif format_name == "JPEG":
            save_kwargs.update({"quality": quality, "progressive": True, "subsampling": 0 if quality >= 90 else "4:2:0"})
        elif format_name == "PNG":
            save_kwargs.update({"compress_level": 9})
        if not keep_metadata:
            pil_image.info.clear()
        pil_image.save(output_path, format=format_name, **save_kwargs)

    def _save_with_external_optimizer(self, pil_image: Image.Image, output_path: str, format_name: str, quality: int, lossless: bool) -> bool:
        if format_name == "WEBP" and shutil.which("cwebp"):
            return self._run_cwebp(pil_image, output_path, quality, lossless)
        if format_name == "JPEG" and shutil.which("cjpeg"):
            return self._run_cjpeg(pil_image, output_path, quality)
        if format_name == "PNG" and shutil.which("pngquant") and not lossless:
            return self._run_pngquant(pil_image, output_path, quality)
        return False

    @staticmethod
    def _run_cwebp(pil_image: Image.Image, output_path: str, quality: int, lossless: bool) -> bool:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp_file:
            temp_path = temp_file.name
        try:
            pil_image.save(temp_path, format="PNG")
            command = ["cwebp", "-quiet", "-m", "6"]
            command += ["-lossless"] if lossless else ["-q", str(quality)]
            command += [temp_path, "-o", output_path]
            return subprocess.run(command, check=False).returncode == 0 and os.path.exists(output_path)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    @staticmethod
    def _run_cjpeg(pil_image: Image.Image, output_path: str, quality: int) -> bool:
        with tempfile.NamedTemporaryFile(suffix=".ppm", delete=False) as temp_file:
            temp_path = temp_file.name
        try:
            pil_image.convert("RGB").save(temp_path, format="PPM")
            command = ["cjpeg", "-quality", str(quality), "-optimize", "-progressive", "-outfile", output_path, temp_path]
            return subprocess.run(command, check=False).returncode == 0 and os.path.exists(output_path)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    @staticmethod
    def _run_pngquant(pil_image: Image.Image, output_path: str, quality: int) -> bool:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp_file:
            temp_path = temp_file.name
        try:
            pil_image.save(temp_path, format="PNG")
            min_quality = max(0, quality - 20)
            command = ["pngquant", "--force", "--quality", f"{min_quality}-{quality}", "--output", output_path, temp_path]
            return subprocess.run(command, check=False).returncode == 0 and os.path.exists(output_path)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)


class GGCaesiumImageCompress(GGHighQualityImageCompress):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "格式": (["自动", "JPEG", "PNG", "WEBP", "TIFF"], {"default": "JPEG"}),
                "质量": ("INT", {"default": 85, "min": 1, "max": 100, "step": 1}),
            },
            "optional": {
                "无损": ("BOOLEAN", {"default": True}),
                "保留元数据": ("BOOLEAN", {"default": False}),
                "缩放百分比": ("INT", {"default": 100, "min": 1, "max": 400, "step": 1}),
                "最大宽度": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 8}),
                "最大高度": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 8}),
                "目标大小KB": ("INT", {"default": 0, "min": 0, "max": 1048576, "step": 16}),
                "渐进JPEG": ("BOOLEAN", {"default": True}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    FUNCTION = "compress_caesium"
    CATEGORY = "GuliNodes/图像工具"
    OUTPUT_NODE = True

    def compress_caesium(self, 图像, 格式="JPEG", 质量=85, 无损=True,
                         保留元数据=False, 缩放百分比=100, 最大宽度=0, 最大高度=0,
                         目标大小KB=0, 渐进JPEG=True, prompt=None, extra_pnginfo=None):
        文件名前缀 = "%date:yyyy_MM_dd%/Caesium图像压缩"
        output_dir = folder_paths.get_output_directory()
        output_format = "WEBP" if 格式 == "自动" else 格式
        ext = self._extension(output_format)
        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(
            文件名前缀, output_dir, 图像[0].shape[1], 图像[0].shape[0]
        )

        results = []
        output_images = []
        for batch_number, image in enumerate(图像):
            pil_image = self._to_pil(image, output_format)
            pil_image = self._resize_like_caesium(pil_image, int(缩放百分比), int(最大宽度), int(最大高度))
            filename_with_batch_num = filename.replace("%batch_num%", str(batch_number))
            file = f"{filename_with_batch_num}_{counter:05}_.{ext}"
            output_path = os.path.join(full_output_folder, file)
            self._save_caesium_style(pil_image, output_path, output_format, int(质量), bool(无损), bool(保留元数据), bool(渐进JPEG), int(目标大小KB))
            results.append({"filename": file, "subfolder": subfolder, "type": "output"})
            with Image.open(output_path) as saved_image:
                output_images.append(_pil_to_tensor(saved_image, device=image.device, dtype=image.dtype))
            counter += 1

        return {"ui": {"images": results}, "result": (torch.stack(output_images, dim=0).contiguous(),)}

    @staticmethod
    def _extension(format_name: str) -> str:
        return {"WEBP": "webp", "JPEG": "jpg", "PNG": "png", "TIFF": "tif"}.get(format_name, "webp")

    @staticmethod
    def _resize_like_caesium(pil_image: Image.Image, scale_percent: int, max_width: int, max_height: int) -> Image.Image:
        width, height = pil_image.size
        scale = max(1, scale_percent) / 100.0
        target_width = max(1, int(width * scale))
        target_height = max(1, int(height * scale))

        if max_width > 0 and target_width > max_width:
            ratio = max_width / target_width
            target_width = max_width
            target_height = max(1, int(target_height * ratio))
        if max_height > 0 and target_height > max_height:
            ratio = max_height / target_height
            target_height = max_height
            target_width = max(1, int(target_width * ratio))

        if (target_width, target_height) == pil_image.size:
            return pil_image
        return pil_image.resize((target_width, target_height), Image.Resampling.LANCZOS)

    def _save_caesium_style(self, pil_image: Image.Image, output_path: str, format_name: str, quality: int,
                            lossless: bool, keep_metadata: bool, progressive_jpeg: bool, target_size_kb: int) -> None:
        quality = max(1, min(int(quality), 100))
        if target_size_kb > 0 and format_name in ("JPEG", "WEBP") and not lossless:
            self._save_target_size(pil_image, output_path, format_name, quality, keep_metadata, progressive_jpeg, target_size_kb)
            return

        if format_name == "TIFF":
            if not keep_metadata:
                pil_image.info.clear()
            pil_image.save(output_path, format="TIFF", compression="tiff_lzw")
            return

        if format_name == "JPEG":
            pil_image = pil_image.convert("RGB")
            if not keep_metadata:
                pil_image.info.clear()
            pil_image.save(output_path, format="JPEG", quality=quality, optimize=True, progressive=progressive_jpeg, subsampling=0 if quality >= 90 else "4:2:0")
            return

        self._save_optimized(pil_image, output_path, format_name, quality, lossless, keep_metadata, True)

    def _save_target_size(self, pil_image: Image.Image, output_path: str, format_name: str, quality: int,
                          keep_metadata: bool, progressive_jpeg: bool, target_size_kb: int) -> None:
        target_bytes = target_size_kb * 1024
        low, high = 1, quality
        best_data = None

        for _ in range(7):
            current_quality = (low + high) // 2
            with tempfile.NamedTemporaryFile(suffix="." + self._extension(format_name), delete=False) as temp_file:
                temp_path = temp_file.name
            try:
                self._save_caesium_style(pil_image, temp_path, format_name, current_quality, False, keep_metadata, progressive_jpeg, 0)
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
            self._save_caesium_style(pil_image, output_path, format_name, 1, False, keep_metadata, progressive_jpeg, 0)
            return
        with open(output_path, "wb") as handle:
            handle.write(best_data)


class GGCivilblurImageCompress(GGHighQualityImageCompress):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "格式": (["WEBP", "JPEG", "PNG"], {"default": "JPEG"}),
                "质量": ("INT", {"default": 85, "min": 1, "max": 100, "step": 1}),
            },
            "optional": {
                "目标大小KB": ("INT", {"default": 0, "min": 0, "max": 1048576, "step": 16}),
                "最大边长": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 8}),
                "移除元数据": ("BOOLEAN", {"default": True}),
                "渐进JPEG": ("BOOLEAN", {"default": True}),
                "强制压缩": ("BOOLEAN", {"default": False}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    FUNCTION = "compress_civilblur"
    CATEGORY = "GuliNodes/图像工具"
    OUTPUT_NODE = True

    def compress_civilblur(self, 图像, 格式="JPEG", 质量=85,
                           目标大小KB=0, 最大边长=0, 移除元数据=True,
                           渐进JPEG=True, 强制压缩=False, prompt=None, extra_pnginfo=None):
        文件名前缀 = "%date:yyyy_MM_dd%/civilblur图像压缩"
        output_dir = folder_paths.get_output_directory()
        ext = self._extension(格式)
        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(
            文件名前缀, output_dir, 图像[0].shape[1], 图像[0].shape[0]
        )

        results = []
        output_images = []
        for batch_number, image in enumerate(图像):
            pil_image = self._to_pil(image, 格式)
            pil_image = self._resize_max_edge(pil_image, int(最大边长))
            filename_with_batch_num = filename.replace("%batch_num%", str(batch_number))
            file = f"{filename_with_batch_num}_{counter:05}_.{ext}"
            output_path = os.path.join(full_output_folder, file)
            self._save_mazanoke_style(
                pil_image,
                output_path,
                格式,
                int(质量),
                int(目标大小KB),
                remove_metadata=bool(移除元数据),
                progressive_jpeg=bool(渐进JPEG),
                force_compress=bool(强制压缩),
            )
            results.append({"filename": file, "subfolder": subfolder, "type": "output"})
            with Image.open(output_path) as saved_image:
                output_images.append(_pil_to_tensor(saved_image, device=image.device, dtype=image.dtype))
            counter += 1

        return {"ui": {"images": results}, "result": (torch.stack(output_images, dim=0).contiguous(),)}

    @staticmethod
    def _resize_max_edge(pil_image: Image.Image, max_edge: int) -> Image.Image:
        if max_edge <= 0:
            return pil_image
        width, height = pil_image.size
        longest = max(width, height)
        if longest <= max_edge:
            return pil_image
        ratio = max_edge / longest
        new_size = (max(1, int(width * ratio)), max(1, int(height * ratio)))
        return pil_image.resize(new_size, Image.Resampling.LANCZOS)

    def _save_mazanoke_style(self, pil_image: Image.Image, output_path: str, format_name: str, quality: int,
                             target_size_kb: int, remove_metadata: bool, progressive_jpeg: bool,
                             force_compress: bool) -> None:
        quality = max(1, min(int(quality), 100))
        if remove_metadata:
            pil_image.info.clear()

        if target_size_kb > 0 and format_name in ("WEBP", "JPEG"):
            self._save_target_size_like_mazanoke(pil_image, output_path, format_name, quality, target_size_kb, progressive_jpeg)
            return

        self._save_single_pass(pil_image, output_path, format_name, quality, progressive_jpeg)

    def _save_target_size_like_mazanoke(self, pil_image: Image.Image, output_path: str, format_name: str,
                                        quality: int, target_size_kb: int, progressive_jpeg: bool) -> None:
        target_bytes = target_size_kb * 1024
        low, high = 1, quality
        best_path = None

        for _ in range(8):
            current_quality = (low + high) // 2
            with tempfile.NamedTemporaryFile(suffix="." + self._extension(format_name), delete=False) as temp_file:
                temp_path = temp_file.name
            self._save_single_pass(pil_image, temp_path, format_name, current_quality, progressive_jpeg)
            size = os.path.getsize(temp_path)
            if size <= target_bytes:
                if best_path and os.path.exists(best_path):
                    os.remove(best_path)
                best_path = temp_path
                low = current_quality + 1
            else:
                os.remove(temp_path)
                high = current_quality - 1

        if best_path is None:
            self._save_single_pass(pil_image, output_path, format_name, 1, progressive_jpeg)
        else:
            shutil.move(best_path, output_path)

    def _save_single_pass(self, pil_image: Image.Image, output_path: str, format_name: str, quality: int, progressive_jpeg: bool) -> None:
        if format_name == "WEBP":
            pil_image.save(output_path, format="WEBP", quality=quality, method=6, optimize=True)
        elif format_name == "JPEG":
            pil_image.convert("RGB").save(output_path, format="JPEG", quality=quality, optimize=True, progressive=progressive_jpeg, subsampling=0 if quality >= 90 else "4:2:0")
        elif format_name == "PNG":
            pil_image.save(output_path, format="PNG", optimize=True, compress_level=9)


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
    "GGFaceSkinSmoothing": GGFaceSkinSmoothing,
    "GGFaceSmartBeauty": GGFaceSmartBeauty,
    "GGImageStyleReference": GGImageStyleReference,
    "GGPreviewImage": GGPreviewImage,
    "GGSaveImage": GGSaveImage,
    "GGHighQualityImageCompress": GGHighQualityImageCompress,
    "GGCaesiumImageCompress": GGCaesiumImageCompress,
    "GGCivilblurImageCompress": GGCivilblurImageCompress,
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
    "GGFaceSkinSmoothing": "GG 人脸磨皮",
    "GGFaceSmartBeauty": "GG 智能人脸美化",
    "GGImageStyleReference": "GG 图像风格参考",
    "GGPreviewImage": "GG 图像预览",
    "GGSaveImage": "GG 图像保存",
    "GGHighQualityImageCompress": "GG meowtec图像压缩",
    "GGCaesiumImageCompress": "GG Caesium图像压缩",
    "GGCivilblurImageCompress": "GG civilblur图像压缩",
    "GGImageComparer2": "GG 图像对比 2张",
    "GGImageComparer4": "GG 图像对比 4张",
    "GGImageComparer8": "GG 图像对比 8张",
}
