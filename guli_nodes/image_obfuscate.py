import math

import numpy as np
import torch
import torch.nn.functional as torch_F

try:
    from comfy_api.latest import io
except Exception:
    io = None

from .aspect_ratio import _unpack_mode

_MODE_OPTIONS = ["混淆", "解码"]
_ALGORITHM_OPTIONS = ["V3 防缩放", "V2 无损"]
_V3_MAX_SIDE = 16384
_PASSWORD_HINT = (
    "密码需为 4 位数字（例如 0100）：前两位为混淆步数，"
    "第三位为右侧填充，第四位为底部填充。留空等同 0100。"
)


def _parse_password(password) -> tuple[int, int, int]:
    text = (password or "").strip()
    if not text:
        return 1, 0, 0
    if len(text) != 4 or not text.isdigit():
        raise ValueError(_PASSWORD_HINT)
    return max(1, int(text[:2])), int(text[2]), int(text[3])


def _gilbert_indices(width: int, height: int) -> np.ndarray:
    """把广义 Hilbert 曲线展开成一维扁平索引，与网页版 gilbert2d 逐点一致。"""
    total = width * height
    indices = np.empty(total, dtype=np.int32)
    cursor = 0

    def emit_line(x: int, y: int, dx: int, dy: int, count: int) -> None:
        nonlocal cursor
        end = cursor + count
        while cursor < end:
            indices[cursor] = x + y * width
            cursor += 1
            x += dx
            y += dy

    def generate(x: int, y: int, ax: int, ay: int, bx: int, by: int) -> None:
        nonlocal cursor
        w = abs(ax + ay)
        h = abs(bx + by)
        dax = (ax > 0) - (ax < 0)
        day = (ay > 0) - (ay < 0)
        dbx = (bx > 0) - (bx < 0)
        dby = (by > 0) - (by < 0)
        if h == 1:
            emit_line(x, y, dax, day, w)
            return
        if w == 1:
            emit_line(x, y, dbx, dby, h)
            return
        ax2, ay2 = ax // 2, ay // 2
        bx2, by2 = bx // 2, by // 2
        w2 = abs(ax2 + ay2)
        h2 = abs(bx2 + by2)
        if 2 * w > 3 * h:
            if w2 % 2 and w > 2:
                ax2 += dax
                ay2 += day
            generate(x, y, ax2, ay2, bx, by)
            generate(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by)
        else:
            if h2 % 2 and h > 2:
                bx2 += dbx
                by2 += dby
            generate(x, y, bx2, by2, ax2, ay2)
            generate(x + bx2, y + by2, ax, ay, bx - bx2, by - by2)
            generate(
                x + (ax - dax) + (bx2 - dbx),
                y + (ay - day) + (by2 - dby),
                -bx2,
                -by2,
                -(ax - ax2),
                -(ay - ay2),
            )

    if width >= height:
        generate(0, 0, width, 0, 0, height)
    else:
        generate(0, 0, 0, height, width, 0)
    return indices


def _source_map(width: int, height: int, step: int, cache: dict) -> np.ndarray:
    """返回 src_map：输出位置 -> 输入位置，已合并 step 次重复置换。"""
    key = (width, height, step)
    cached = cache.get(key)
    if cached is not None:
        return cached
    curve = _gilbert_indices(width, height)
    total = curve.size
    offset = int(math.floor((math.sqrt(5) - 1) / 2 * total + 0.5))
    shift = (step * offset) % total
    src_map = np.empty(total, dtype=np.int32)
    src_map[curve] = np.roll(curve, shift)
    cache[key] = src_map
    return src_map


def _v3_source_map(width: int, height: int, step: int, pad_right: int, cache: dict) -> np.ndarray:
    """V3 备份/自愈使用的索引表。

    网页版的 getScrambledIndices 在密码带右侧填充时，会按补边后的步长读取打乱后的
    索引图，导致部分位置取到最后一列的副本。这里照搬该行为，保证与网页版逐像素一致。
    """
    if not pad_right:
        return _source_map(width, height, step, cache)
    key = (width, height, step, pad_right, "v3")
    cached = cache.get(key)
    if cached is not None:
        return cached
    src_map = _source_map(width, height, step, cache)
    padded = _pad_edges(src_map.reshape(height, width, 1), pad_right, 0).reshape(-1)
    site_map = padded[:width * height].copy()
    cache[key] = site_map
    return site_map


def _scramble(pixels: np.ndarray, src_map: np.ndarray) -> np.ndarray:
    return pixels[src_map]


def _unscramble(pixels: np.ndarray, src_map: np.ndarray) -> np.ndarray:
    out = np.empty_like(pixels)
    out[src_map] = pixels
    return out


def _pad_edges(pixels: np.ndarray, extra_cols: int, extra_rows: int) -> np.ndarray:
    """右列复制本行最后一列，底部复制最后一行（右下角取右下像素），与网页版一致。"""
    height, width = pixels.shape[:2]
    if extra_cols == 0 and extra_rows == 0:
        return pixels
    out = np.empty((height + extra_rows, width + extra_cols, pixels.shape[2]), dtype=pixels.dtype)
    out[:height, :width] = pixels
    if extra_cols:
        out[:height, width:] = pixels[:, width - 1:width]
    if extra_rows:
        out[height:, :width] = out[height - 1:height, :width]
        if extra_cols:
            out[height:, width:] = out[height - 1:height, width - 1:width]
    return out


def _encode_v3(pixels: np.ndarray, step: int, pad_right: int, pad_bottom: int, cache: dict) -> np.ndarray:
    height, width = pixels.shape[:2]
    if width > _V3_MAX_SIDE or height > _V3_MAX_SIDE:
        raise ValueError(
            f"V3 条码只能记录 16384 像素以内的宽高，当前图像为 {width}×{height}。"
            "请改用「V2 无损」算法。"
        )

    active_height = height + 64
    canvas = np.zeros((active_height, width, 3), dtype=np.uint8)
    canvas[:32] = 255
    canvas[32:32 + height] = pixels

    src_map = _source_map(width, active_height, step, cache)
    heal_map = _v3_source_map(width, active_height, step, pad_right, cache)
    flat = canvas.reshape(-1, 3)
    start = (height + 32) * width
    # 把即将被条码破坏的像素先备份到底部 32 行；逐像素顺序与网页版保持一致，
    # 源区间与备份区间重叠时的取值行为也必须相同。
    for i in range(32 * width):
        flat[start + i] = flat[heal_map[start + i]]

    scrambled = _scramble(flat, src_map).reshape(active_height, width, 3)
    final = _pad_edges(scrambled, pad_right, pad_bottom)
    final_width = final.shape[1]

    final[height + 32:height + 40] = 0
    payload = f"{width:016b}{height:016b}"
    block_width = final_width / 34
    for i in range(34):
        x0 = int(math.floor(i * block_width))
        x1 = min(x0 + int(math.ceil(block_width)), final_width)
        if i == 0:
            color = (255, 0, 0)
        elif i == 33:
            color = (0, 0, 255)
        else:
            color = (255, 255, 255) if payload[i - 1] == "1" else (0, 0, 0)
        final[height + 40:height + 64, x0:x1] = color
    return final


def _read_barcode(image: np.ndarray, pad_bottom: int):
    """在底部色条中读取原始宽高；兼容密码带底部填充（h>0）时条码不在最底行的情况。"""
    height, width = image.shape[:2]
    if height < 2 or width < 34:
        return None

    block_width = width / 34
    offsets = [2]
    if pad_bottom:
        offsets.append(2 + pad_bottom)

    for offset in offsets:
        if offset >= height:
            continue
        sample = image[height - offset]
        red_x = min(int(math.floor(0.5 * block_width)), width - 1)
        r, g, b = (int(v) for v in sample[red_x])
        if not (r > g + 40 and r > b + 40):
            continue
        blue_x = min(int(math.floor(33.5 * block_width)), width - 1)
        r, g, b = (int(v) for v in sample[blue_x])
        if not (b > r + 40 and b > g + 40):
            continue

        bits = []
        for i in range(1, 33):
            x = min(int(math.floor((i + 0.5) * block_width)), width - 1)
            r, g, b = (int(v) for v in sample[x])
            bits.append("1" if 0.299 * r + 0.587 * g + 0.114 * b > 127 else "0")
        payload = "".join(bits)
        decoded_w = int(payload[:16], 2)
        decoded_h = int(payload[16:], 2)
        if 10 < decoded_w <= _V3_MAX_SIDE and 10 < decoded_h <= _V3_MAX_SIDE:
            return decoded_w, decoded_h
    return None


def _resize_rgb(pixels: np.ndarray, target_w: int, target_h: int) -> np.ndarray:
    src_h, src_w = pixels.shape[:2]
    if src_w == target_w and src_h == target_h:
        return pixels
    tensor = torch.from_numpy(pixels).permute(2, 0, 1).unsqueeze(0).to(torch.float32)
    tensor = torch_F.interpolate(
        tensor,
        size=(target_h, target_w),
        mode="bilinear",
        align_corners=False,
        antialias=True,
    )
    tensor = tensor.clamp_(0, 255).round_().to(torch.uint8)
    return tensor.squeeze(0).permute(1, 2, 0).numpy()


def _decode_v3(
    image: np.ndarray,
    step: int,
    pad_right: int,
    pad_bottom: int,
    decoded_w: int,
    decoded_h: int,
    cache: dict,
) -> np.ndarray:
    target_w = decoded_w + pad_right
    target_h = decoded_h + 64 + pad_bottom
    work = _resize_rgb(image, target_w, target_h)[:decoded_h + 64, :decoded_w]

    src_map = _source_map(decoded_w, decoded_h + 64, step, cache)
    heal_map = _v3_source_map(decoded_w, decoded_h + 64, step, pad_right, cache)
    decoded = _unscramble(work.reshape(-1, 3), src_map)
    start = (decoded_h + 32) * decoded_w
    # 用底部 32 行备份反向覆盖条码破坏区；顺序与网页版一致。
    for i in range(32 * decoded_w):
        decoded[heal_map[start + i]] = decoded[start + i]
    return decoded.reshape(decoded_h + 64, decoded_w, 3)[32:32 + decoded_h]


def _encode_v2(pixels: np.ndarray, step: int, pad_right: int, pad_bottom: int, cache: dict) -> np.ndarray:
    height, width = pixels.shape[:2]
    src_map = _source_map(width, height, step, cache)
    scrambled = _scramble(pixels.reshape(-1, 3), src_map).reshape(height, width, 3)
    return _pad_edges(scrambled, pad_right, pad_bottom)


def _decode_v2(image: np.ndarray, step: int, pad_right: int, pad_bottom: int, cache: dict) -> np.ndarray:
    height, width = image.shape[:2]
    if width - pad_right <= 0 or height - pad_bottom <= 0:
        raise ValueError(
            f"密码指定的填充（右侧 {pad_right}、底部 {pad_bottom}）超过了图像尺寸 "
            f"{width}×{height}，无法按 V2 解码。"
        )
    cropped = image[:height - pad_bottom, :width - pad_right]
    src_map = _source_map(cropped.shape[1], cropped.shape[0], step, cache)
    return _unscramble(cropped.reshape(-1, 3), src_map).reshape(cropped.shape)


def _tensor_to_uint8(image: torch.Tensor) -> np.ndarray:
    pixels = image.detach().cpu().numpy()
    if pixels.ndim != 3:
        raise ValueError("输入的每张图像必须是三维张量（高度、宽度、通道）。")
    if pixels.shape[2] >= 3:
        pixels = pixels[..., :3]
    elif pixels.shape[2] == 1:
        pixels = np.repeat(pixels, 3, axis=2)
    else:
        raise ValueError("输入的图像通道数不足，至少需要 1 个通道。")
    pixels = np.clip(pixels, 0.0, 1.0)
    return np.floor(pixels * 255.0 + 0.5).astype(np.uint8)


def _process(images: torch.Tensor, mode: str, algorithm: str, password) -> torch.Tensor:
    if not isinstance(images, torch.Tensor) or images.ndim != 4:
        raise ValueError("输入的图像必须是四维 IMAGE 张量（批量、高度、宽度、通道）。")
    if mode not in _MODE_OPTIONS:
        raise ValueError(f"不支持的模式「{mode}」，可选：{'、'.join(_MODE_OPTIONS)}。")
    if mode == "混淆" and algorithm not in _ALGORITHM_OPTIONS:
        raise ValueError(f"不支持的算法「{algorithm}」，可选：{'、'.join(_ALGORITHM_OPTIONS)}。")

    step, pad_right, pad_bottom = _parse_password(password)
    cache = {}
    results = []
    for image in images:
        pixels = _tensor_to_uint8(image)
        if mode == "混淆":
            if algorithm == "V3 防缩放":
                results.append(_encode_v3(pixels, step, pad_right, pad_bottom, cache))
            else:
                results.append(_encode_v2(pixels, step, pad_right, pad_bottom, cache))
            continue

        barcode = _read_barcode(pixels, pad_bottom)
        if barcode is None:
            results.append(_decode_v2(pixels, step, pad_right, pad_bottom, cache))
        else:
            results.append(
                _decode_v3(pixels, step, pad_right, pad_bottom, barcode[0], barcode[1], cache)
            )

    shape = results[0].shape[:2]
    if any(result.shape[:2] != shape for result in results[1:]):
        sizes = "、".join(f"{result.shape[1]}×{result.shape[0]}" for result in results)
        raise ValueError(
            f"同一批次解码出的图像尺寸不一致（{sizes}），无法合并为一个 IMAGE 批次，"
            "请拆分批次后逐张解码。"
        )

    stacked = np.stack(results, axis=0).astype(np.float32) / 255.0
    return torch.from_numpy(stacked).to(device=images.device, dtype=images.dtype)


class GGImageObfuscate:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "模式": (_MODE_OPTIONS, {"default": "混淆"}),
                "算法": (_ALGORITHM_OPTIONS, {"default": "V3 防缩放"}),
                "密码": ("STRING", {"default": "0100", "multiline": False}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "run"
    CATEGORY = "GuliNodes/图像"

    def run(self, 图像, 模式="混淆", 算法="V3 防缩放", 密码="0100"):
        return (_process(图像, 模式, 算法, 密码),)


if io is not None:

    class GGImageObfuscateV3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGImageObfuscate",
                display_name="GG 图像混淆",
                category="GuliNodes/图像",
                description=(
                    "按大番茄混淆工具的 Hilbert 曲线置换算法打乱或还原图像。"
                    "V3 会写入原始宽高条码，解码时自动识别；V2 不改变尺寸但缩放后无法还原。"
                ),
                inputs=[
                    io.Image.Input("图像"),
                    io.DynamicCombo.Input("模式", options=[
                        io.DynamicCombo.Option(key="混淆", inputs=[
                            io.Combo.Input(
                                "算法",
                                options=_ALGORITHM_OPTIONS,
                                default="V3 防缩放",
                                tooltip="V3 在底部附加 64 像素的提示与条码区，可自动识别原图尺寸；V2 不改变尺寸但缩放后无法还原。",
                            ),
                        ]),
                        io.DynamicCombo.Option(key="解码", inputs=[]),
                    ]),
                    io.String.Input(
                        "密码",
                        default="0100",
                        tooltip="4 位数字：前两位为混淆步数，第三位为右侧填充，第四位为底部填充。留空等同 0100。",
                    ),
                ],
                outputs=[
                    io.Image.Output(display_name="图像"),
                ],
            )

        @classmethod
        def execute(cls, 图像, 模式, 密码="0100"):
            mode, values = _unpack_mode(模式, "模式")
            return io.NodeOutput(_process(图像, mode, values.get("算法", "V3 防缩放"), 密码))

    GGImageObfuscate = GGImageObfuscateV3


NODE_CLASS_MAPPINGS = {
    "GGImageObfuscate": GGImageObfuscate,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGImageObfuscate": "GG 图像混淆",
}
