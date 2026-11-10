"""GG 图像加载：上传、遮罩读取与节点预览。"""

import hashlib
import os
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence

import folder_paths
import node_helpers

try:
    from comfy_api.latest import io
except Exception:
    io = None


_IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")


def _image_files():
    input_dir = folder_paths.get_input_directory()
    if not os.path.isdir(input_dir):
        return []
    return sorted(
        name for name in os.listdir(input_dir)
        if os.path.isfile(os.path.join(input_dir, name))
        and name.lower().endswith(_IMAGE_EXTENSIONS)
    )


def _media_files():
    """遮罩下拉的可选项。

    首位必须是空串：COMBO 的默认值取 options[0]，直接给文件列表会让新建节点
    默认就套上目录里的第一张图当遮罩，输出被悄悄改掉。空串同时就是「不指定遮罩」。
    """
    return [""] + _image_files()


def _load_mask(path):
    try:
        return np.asarray(Image.open(path).convert("L"), dtype=np.float32) / 255.0
    except Exception:
        return None


def _sidecar_candidates(image_path):
    stem, suffix = os.path.splitext(image_path)
    yield f"{stem}_mask.png"
    yield f"{stem}_mask.jpg"
    if "bb_" in os.path.basename(image_path):
        yield os.path.join(os.path.dirname(image_path), os.path.basename(image_path).replace("bb_", "bb_mask_", 1))
    yield os.path.join(os.path.dirname(image_path), f"{Path(stem).name}.mask.png")


def _resolve_mask(image_path, mask_file, pil_image, height, width):
    mask = None
    if mask_file:
        try:
            mask = _load_mask(folder_paths.get_annotated_filepath(mask_file))
        except Exception:
            mask = None
    if mask is None:
        for candidate in _sidecar_candidates(image_path):
            if os.path.isfile(candidate):
                mask = _load_mask(candidate)
                if mask is not None:
                    break
    if mask is None and ("A" in pil_image.getbands() or pil_image.mode in ("RGBA", "LA")):
        alpha = pil_image.convert("RGBA").getchannel("A")
        mask = 1.0 - np.asarray(alpha, dtype=np.float32) / 255.0
    if mask is None or mask.shape != (height, width):
        mask = np.zeros((height, width), dtype=np.float32)
    return mask


def _preview(rgb, mask, prefix="gg_load"):
    overlay = np.zeros_like(rgb)
    overlay[..., 0] = 34.0 / 255.0
    overlay[..., 1] = 197.0 / 255.0
    overlay[..., 2] = 94.0 / 255.0
    alpha = mask[..., None] * 0.5
    result = np.clip(rgb * (1.0 - alpha) + overlay * alpha, 0.0, 1.0)
    image = Image.fromarray((result * 255.0).astype(np.uint8), "RGB")
    temp_dir = folder_paths.get_temp_directory()
    os.makedirs(temp_dir, exist_ok=True)
    name = f"{prefix}_{os.getpid()}_{hashlib.sha1(image.tobytes()).hexdigest()[:10]}.png"
    image.save(os.path.join(temp_dir, name), format="PNG")
    return [{"filename": name, "subfolder": "", "type": "temp"}]


def _read_image(image, mask_file=""):
    image_path = folder_paths.get_annotated_filepath(image)
    source = node_helpers.pillow(Image.open, image_path)
    output_images = []
    output_masks = []
    width = height = None
    for frame in ImageSequence.Iterator(source):
        frame = node_helpers.pillow(ImageOps.exif_transpose, frame)
        rgb = frame.convert("RGB")
        if width is None:
            width, height = rgb.size
        if rgb.size != (width, height):
            continue
        rgb_np = np.asarray(rgb, dtype=np.float32) / 255.0
        mask_np = _resolve_mask(image_path, mask_file, frame, height, width)
        output_images.append(torch.from_numpy(rgb_np).unsqueeze(0))
        output_masks.append(torch.from_numpy(mask_np).unsqueeze(0))
    if not output_images:
        raise RuntimeError(f"无法读取图像：{image}")
    images = torch.cat(output_images, dim=0)
    masks = torch.cat(output_masks, dim=0)
    return images, masks, _preview(output_images[0][0].numpy(), output_masks[0][0].numpy()), width, height


class GGImageLoad:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 不带 image_upload：前端会为此额外插两个控件（一个 upload 按钮
                # + 一个 232px 的 $$canvas-image-preview），与节点自带的 DOM 预览
                # 面板和四个快捷按钮完全重复，还会把内容高度顶出节点。
                "图像": (_image_files(), {}),
            },
            "optional": {
                # 遮罩也是一张图，走和「图像」同样的文件选择控件；
                # 用 STRING 会被渲染成一个文本框，位置和交互都对不上。
                "遮罩文件": (_media_files(), {}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("图像", "遮罩")
    FUNCTION = "load_image"
    CATEGORY = "GuliNodes/图像"
    DESCRIPTION = "加载图像并输出图像与遮罩；支持粘贴、上传遮罩、裁剪和预览。"
    SEARCH_ALIASES = ["load image", "image loader", "paste image", "image upload"]

    def load_image(self, 图像, 遮罩文件=""):
        images, masks, preview, _, _ = _read_image(图像, 遮罩文件)
        return {"ui": {"images": preview}, "result": (images, masks)}

    @classmethod
    def IS_CHANGED(cls, 图像, 遮罩文件=""):
        try:
            path = folder_paths.get_annotated_filepath(图像)
            digest = hashlib.sha256()
            with open(path, "rb") as handle:
                digest.update(handle.read())
            if 遮罩文件:
                mask_path = folder_paths.get_annotated_filepath(遮罩文件)
                if os.path.isfile(mask_path):
                    digest.update(Path(mask_path).read_bytes())
            return digest.hexdigest()
        except Exception:
            return float("nan")

    @classmethod
    def VALIDATE_INPUTS(cls, 图像, 遮罩文件=""):
        if not folder_paths.exists_annotated_filepath(图像):
            return f"图像文件不存在：{图像}"
        if 遮罩文件 and not folder_paths.exists_annotated_filepath(遮罩文件):
            return f"遮罩文件不存在：{遮罩文件}"
        return True


if io is not None:
    class GGImageLoad_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGImageLoad",
                display_name="GG 图像加载",
                category="GuliNodes/图像",
                description="加载图像并输出图像与遮罩；支持粘贴、上传遮罩、裁剪和预览。",
                inputs=[
                    # 两个都是纯下拉：给 Combo 加 upload 会让前端自动插入
                    # 「upload」按钮控件和一张 232px 的 $$canvas-image-preview，
                    # 与节点自带的 DOM 预览面板 + 四个快捷按钮重复，且顶高内容。
                    # 上传走面板上的「选择文件上传 / 蒙版」按钮。
                    io.Combo.Input("图像", options=_image_files()),
                    io.Combo.Input("遮罩文件", options=_media_files(), optional=True),
                ],
                outputs=[io.Image.Output("图像"), io.Mask.Output("遮罩")],
            )

        @classmethod
        def execute(cls, 图像, 遮罩文件=""):
            images, masks, preview, _, _ = _read_image(图像, 遮罩文件)
            return io.NodeOutput(images, masks, ui={"images": preview})

    GGImageLoad = GGImageLoad_V3


NODE_CLASS_MAPPINGS = {"GGImageLoad": GGImageLoad}
NODE_DISPLAY_NAME_MAPPINGS = {"GGImageLoad": "GG 图像加载"}
