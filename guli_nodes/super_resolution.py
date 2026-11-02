"""Real-CUGAN 图片超分节点。

模型来自 real-cugan.webgpu.me 的 ONNX 导出，11 个官方档位（2x/3x/4x × 降噪强度）。
每个模型输入固定 ``[1, 3, 512, 512]``（float32、0~1、NCHW），输出按倍率放大，
所以大图必须切块：

    以 stride = 512 - 重叠 滑窗取块 → 逐块推理 → 重叠区按线性羽化权重加权融合

窗口最后一块不 padding，而是把窗口滑到贴边位置。padding 出来的假像素会让模型在
边界生成错内容，贴边滑窗则全是真实像素；只有图本身小于 512 时才不得不 pad。

推理走 ONNX Runtime，不引入 torch 以外的推理框架：
    pip install onnxruntime-gpu   # 有 N 卡时装这个，能吃 CUDA
    pip install onnxruntime       # 或者纯 CPU 版
"""

from __future__ import annotations

import gc
import os
import ssl
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as torch_F

import comfy.utils
import folder_paths

try:
    import onnxruntime as ort

    _ORT_IMPORT_ERROR = ""
except Exception as exc:  # 缺 onnxruntime 时节点仍要能注册，执行时再抛中文错误
    ort = None
    _ORT_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"

try:
    from comfy_api.latest import io
except Exception:
    io = None


# --------------------------------------------------------------------------- #
# 模型注册表
# --------------------------------------------------------------------------- #

_MODEL_BASE_URL = "https://real-cugan.webgpu.me/models/"

# (标签, 文件名主干, 倍率, 说明) —— 标签即下拉框取值，改动会断旧工作流的模型选择
_MODELS = (
    ("2x 无降噪", "up2x-latest-no-denoise-fixed512", 2, "保留原画细节，不做去噪"),
    ("2x 保守降噪", "up2x-latest-conservative-fixed512", 2, "温和去噪，尽量不伤细节"),
    ("2x 降噪1", "up2x-latest-denoise1x-fixed512", 2, "轻度去噪"),
    ("2x 降噪2", "up2x-latest-denoise2x-fixed512", 2, "中等去噪，适合压缩痕"),
    ("2x 降噪3", "up2x-latest-denoise3x-fixed512", 2, "强力去噪，会损失细节"),
    ("3x 无降噪", "up3x-latest-no-denoise-fixed512", 3, "三倍放大，无去噪"),
    ("3x 保守降噪", "up3x-latest-conservative-fixed512", 3, "三倍放大 + 温和去噪"),
    ("3x 降噪3", "up3x-latest-denoise3x-fixed512", 3, "三倍放大 + 强力去噪"),
    ("4x 无降噪", "up4x-latest-no-denoise-fixed512", 4, "四倍放大，无去噪"),
    ("4x 保守降噪", "up4x-latest-conservative-fixed512", 4, "四倍放大 + 温和去噪"),
    ("4x 降噪3", "up4x-latest-denoise3x-fixed512", 4, "四倍放大 + 强力去噪"),
)

_MODEL_LABELS = [item[0] for item in _MODELS]
_MODEL_BY_LABEL = {item[0]: item for item in _MODELS}

_CATEGORY = "GuliNodes/图像"

_SESSIONS: dict[tuple, tuple] = {}
_SESSION_LOCK = threading.Lock()
_SESSION_LIMIT = 4  # 同时保留的推理解析器数量上限


_MODEL_SUBDIR = "Real-ESRGAN"  # ComfyUI/models/Real-ESRGAN
_LEGACY_SUBDIR = "RealCUGAN"  # 早期版本放在 upscale_models/RealCUGAN，仍然认
_SCAN_TTL = 2.0  # 目录扫描结果的缓存秒数

_SCAN_CACHE: tuple[float, list] = (0.0, [])
_SCAN_LOCK = threading.Lock()


def _model_dirs() -> list[Path]:
    """候选模型目录，按优先级排列。

    主目录固定为 ``<models_dir>/Real-ESRGAN``（下载也放这里）；同时纳入
    ``extra_model_paths.yaml`` 里注册的 upscale_models 路径，以及早期版本用过的
    ``RealCUGAN`` 子目录，避免老用户手里的模型突然“消失”。
    """
    roots: list[Path] = []
    try:
        roots.append(Path(folder_paths.models_dir))
    except Exception:
        pass
    try:
        roots.extend(Path(item) for item in folder_paths.get_folder_paths("upscale_models"))
    except Exception:
        pass

    dirs: list[Path] = []
    for root in roots:
        dirs.append(root / _MODEL_SUBDIR)
    for root in roots:
        legacy = root / _LEGACY_SUBDIR
        if legacy.is_dir():
            dirs.append(legacy)

    seen: set[str] = set()
    unique: list[Path] = []
    for item in dirs:
        key = str(item).lower()
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def _primary_model_dir() -> Path:
    """下载落地的目录：ComfyUI/models/Real-ESRGAN。"""
    return _model_dirs()[0]


def _scan_local_models() -> list[tuple[str, Path]]:
    """扫描模型目录里的 .onnx，返回 [(文件名主干, 路径)]。

    目录内容会在运行时变化（用户自己往里丢文件），所以带一个短 TTL 缓存：
    前端刷新页面就会重新拉 ``/object_info``，新放的模型随即出现在下拉框里。
    """
    global _SCAN_CACHE

    now = time.monotonic()
    with _SCAN_LOCK:
        stamp, cached = _SCAN_CACHE
        if now - stamp < _SCAN_TTL:
            return list(cached)

        found: dict[str, Path] = {}
        for folder in _model_dirs():
            if not folder.is_dir():
                continue
            try:
                files = sorted(folder.glob("*.onnx"))
            except OSError:
                continue
            for item in files:
                if not item.is_file() or item.stat().st_size <= 0:
                    continue
                # 同名时保留优先级高的目录（主目录在前）
                found.setdefault(item.stem.lower(), item)

        result = sorted(((path.stem, path) for path in found.values()), key=lambda kv: kv[0].lower())
        _SCAN_CACHE = (now, result)
        return list(result)


def _model_options() -> list[str]:
    """下拉框选项：内置档位（中文）+ 目录里用户自己放的模型（文件名）。"""
    options = list(_MODEL_LABELS)
    known = {item[1].lower() for item in _MODELS}
    for stem, _path in _scan_local_models():
        if stem.lower() in known or stem in options:
            continue
        options.append(stem)
    return options


def _human_size(num_bytes: int) -> str:
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f}{unit}" if unit != "B" else f"{int(size)}B"
        size /= 1024
    return f"{size:.1f}GB"


def _ssl_context() -> ssl.SSLContext:
    """下载用的 TLS 上下文，优先用 certifi 的 CA 包。

    Windows 上 Python 默认从系统证书存储取根证书。有些机器的存储里留着已过期的
    Let's Encrypt 中间证书，会让 https 校验直接失败（报 certificate has expired），
    而站点本身证书是有效的。certifi 自带一份干净的证书包，能正常通过；
    取不到就退回系统默认，不因此挡住下载。
    """
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def _download_model(stem: str) -> Path:
    """下载单个模型到本地。先写 .part 再原子改名，避免中断留下半个文件。"""
    dest = _primary_model_dir() / f"{stem}.onnx"
    if dest.is_file() and dest.stat().st_size > 0:
        return dest

    dest.parent.mkdir(parents=True, exist_ok=True)
    url = _MODEL_BASE_URL + f"{stem}.onnx"
    part = dest.with_name(dest.name + ".part")

    print(f"[GG 超分] 开始下载模型 {stem}.onnx → {dest}")
    request = urllib.request.Request(url, headers={"User-Agent": "ComfyUI-GuliNodes"})
    try:
        with urllib.request.urlopen(
            request, timeout=60, context=_ssl_context()
        ) as response:
            total = int(response.headers.get("Content-Length") or 0)
            received = 0
            last_report = 0.0
            with open(part, "wb") as handle:
                while True:
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    received += len(chunk)
                    now = time.monotonic()
                    # 限流打印，避免大模型刷屏
                    if now - last_report > 1.0:
                        last_report = now
                        pct = f"{received * 100 / total:.0f}%" if total else _human_size(received)
                        print(f"[GG 超分] 下载中 {stem}: {pct}")
    except urllib.error.URLError as exc:
        part.unlink(missing_ok=True)
        raise RuntimeError(
            f"模型 {stem}.onnx 下载失败：{exc}。"
            f"可以手动下载 {url} 放到 {dest.parent}，或检查网络/代理设置。"
        ) from exc
    except Exception:
        part.unlink(missing_ok=True)
        raise

    os.replace(part, dest)
    print(f"[GG 超分] 模型已就绪：{dest}（{_human_size(dest.stat().st_size)}）")
    return dest


def _find_local_model(stem: str) -> Path | None:
    """按文件名主干在候选目录里找已存在的模型（大小写不敏感）。"""
    target = stem.lower()
    for found_stem, path in _scan_local_models():
        if found_stem.lower() == target:
            return path
    # 扫描有 TTL 缓存，刚下载/刚拷贝的文件可能还没进缓存，这里直接补查一次
    for folder in _model_dirs():
        candidate = folder / f"{stem}.onnx"
        if candidate.is_file() and candidate.stat().st_size > 0:
            return candidate
    return None


def _resolve_model_path(label: str, auto_download: bool) -> Path:
    """把下拉框取值解析成模型文件路径。

    取值可能是内置档位（中文标签）或用户自己放进目录的模型文件名——
    后者不需要走插件下载，留在目录里就能直接选。
    """
    entry = _MODEL_BY_LABEL.get(label)
    stem = entry[1] if entry else str(label).strip()

    path = _find_local_model(stem)
    if path is not None:
        return path

    if entry is None:
        raise FileNotFoundError(
            f"在模型目录里找不到「{label}」。请把 {label}.onnx 放进 "
            f"{_primary_model_dir()}（ComfyUI/models/{_MODEL_SUBDIR}）。"
            f"当前可用的模型：{'、'.join(_model_options())}"
        )

    if not auto_download:
        raise FileNotFoundError(
            f"本地没有模型 {stem}.onnx。请把「自动下载」打开，"
            f"或手动下载 {_MODEL_BASE_URL}{stem}.onnx 放到 {_primary_model_dir()}。"
        )
    return _download_model(stem)


# --------------------------------------------------------------------------- #
# 推理会话
# --------------------------------------------------------------------------- #

def _available_providers() -> list[str]:
    if ort is None:
        return []
    try:
        return ort.get_available_providers()
    except Exception:
        return []


def _pick_providers(device: str) -> list[str]:
    """按「自动 / CPU / 显卡」挑选执行后端，显卡不可用时自动回退。"""
    available = _available_providers()
    gpu_candidates = (
        "CUDAExecutionProvider",
        "DmlExecutionProvider",
        "ROCMExecutionProvider",
        "CoreMLExecutionProvider",
    )
    picked = [name for name in gpu_candidates if name in available]

    if device == "CPU":
        return ["CPUExecutionProvider"]
    if device == "显卡":
        if not picked:
            raise RuntimeError(
                "设备选了「显卡」，但当前 onnxruntime 没有可用的显卡后端。"
                "N 卡请执行 pip install onnxruntime-gpu（装完重启 ComfyUI），"
                "或把设备改成「自动」/「CPU」。"
            )
        return picked + ["CPUExecutionProvider"]
    return picked + ["CPUExecutionProvider"]


def _create_session(path: Path, device: str):
    providers = _pick_providers(device)
    options = ort.SessionOptions()
    options.log_severity_level = 3  # 静默 ORT 的 INFO 噪音
    # ORT 默认吃满所有核，会和 ComfyUI 主线程抢 CPU；留一半给前端和采样器
    options.intra_op_num_threads = max(1, min(8, (os.cpu_count() or 4) // 2))
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(path), options, providers=providers)


def _build_session(path: Path, device: str):
    """加载模型。显卡后端起不来时回落 CPU——CUDA 版本不匹配、显存不够都会在
    建 session 阶段直接抛，此时让整个节点失败不如降级把图出完。"""
    try:
        session = _create_session(path, device)
    except Exception as exc:
        try:
            has_gpu_backend = bool(_pick_providers(device)[:-1])
        except Exception:
            has_gpu_backend = False
        if device == "CPU" or not has_gpu_backend:
            raise
        print(f"[GG 超分] 显卡后端初始化失败（{exc}），改用 CPU 推理")
        session = _create_session(path, "CPU")

    used = session.get_providers()
    print(f"[GG 超分] 已加载 {path.name}，执行后端：{'、'.join(used)}")
    if used == ["CPUExecutionProvider"] and device != "CPU":
        print(
            "[GG 超分] 提示：当前只有 CPU 后端，512 块约 1 秒级。"
            "想要显卡加速请 pip install onnxruntime-gpu 后重启 ComfyUI。"
        )
    return session


def _read_shape(session) -> tuple[int, int]:
    """返回 (固定输入边长, 倍率)。动态度模型返回 (0, 倍率)，走整图推理。"""
    inp = session.get_inputs()[0]
    out = session.get_outputs()[0]
    shape_in = list(inp.shape or [])
    shape_out = list(out.shape or [])

    def _fixed(value) -> bool:
        return isinstance(value, int) and value > 0

    if len(shape_in) == 4 and _fixed(shape_in[2]) and _fixed(shape_in[3]):
        size = int(shape_in[2])
        if len(shape_out) == 4 and _fixed(shape_out[2]):
            return size, max(1, int(shape_out[2]) // size)
        return size, 4
    return 0, 0  # 倍率未知，推理后按实际输出推算


def _get_session(path: Path, device: str):
    """带缓存地取会话，返回 (session, 固定输入边长, 倍率)。"""
    if ort is None:
        reason = f"（导入失败原因：{_ORT_IMPORT_ERROR}）" if _ORT_IMPORT_ERROR else ""
        raise RuntimeError(
            f"缺少 onnxruntime，Real-CUGAN 超分无法推理{reason}。"
            "请执行 pip install onnxruntime（N 卡用 onnxruntime-gpu），然后重启 ComfyUI。"
        )
    try:
        stamp = path.stat().st_mtime
    except OSError as exc:
        raise FileNotFoundError(f"模型文件不可读：{path}（{exc}）") from exc

    key = (str(path), device, stamp)
    with _SESSION_LOCK:
        cached = _SESSIONS.get(key)
        if cached is not None:
            return cached
        # 最多留 4 个会话，用完整个工作流也不会一直囤着 ORT 的 arena 内存
        while len(_SESSIONS) >= _SESSION_LIMIT:
            _SESSIONS.pop(next(iter(_SESSIONS)), None)
        session = _build_session(path, device)
        in_size, scale = _read_shape(session)
        _SESSIONS[key] = (session, in_size, scale)
        return _SESSIONS[key]


def _unload_sessions() -> int:
    """释放本模块缓存的推理会话，返回释放了几个。

    ONNX Runtime 的 session 不在 ComfyUI 的模型管理体系里，
    ``comfy.model_management.unload_all_models()`` 碰不到它，显存和内存只能靠
    丢掉引用让 ORT 自己析构（CUDA EP 的 arena 也在析构时还回去）。
    清完立刻 gc，避免等下一轮循环回收。
    """
    with _SESSION_LOCK:
        count = len(_SESSIONS)
        _SESSIONS.clear()
    if count:
        gc.collect()
    return count


# --------------------------------------------------------------------------- #
# 分块推理
# --------------------------------------------------------------------------- #

def _axis_starts(total: int, size: int, stride: int) -> list[int]:
    """返回该轴上的切块起点。

    最后一块贴边对齐而不是 padding：模型在假像素上会生成错内容，贴边滑窗
    用的全是真实像素（只有 total < size 时才不得不 pad）。
    """
    if total <= size:
        return [0]
    stride = max(1, min(stride, size))
    starts = list(range(0, total - size + 1, stride))
    if starts[-1] != total - size:
        starts.append(total - size)
    return starts


def _window(size: int, left: int, right: int) -> np.ndarray:
    """1D 羽化窗：两端在重叠区内线性渐变，其余为 1。

    渐变取 (i + 0.5) / n，避开 0 和 1，保证累加权重恒大于 0，归一化不除零。
    """
    win = np.ones(size, dtype=np.float32)
    left = max(0, min(int(left), size // 2))
    right = max(0, min(int(right), size // 2))
    if left:
        win[:left] = (np.arange(left, dtype=np.float32) + 0.5) / left
    if right:
        win[size - right:] = ((np.arange(right, dtype=np.float32) + 0.5) / right)[::-1]
    return win


def _infer_tiled(session, chw: np.ndarray, in_size: int, scale: int, overlap: int, progress=None):
    """把 chw 切成 in_size 见方的块逐块推理，重叠区羽化融合。"""
    channels, height, width = chw.shape
    stride = max(1, in_size - max(0, int(overlap)))
    xs = _axis_starts(width, in_size, stride)
    ys = _axis_starts(height, in_size, stride)

    out_h, out_w = height * scale, width * scale
    acc = np.zeros((channels, out_h, out_w), dtype=np.float32)
    wsum = np.zeros((1, out_h, out_w), dtype=np.float32)

    in_name = session.get_inputs()[0].name
    out_name = session.get_outputs()[0].name
    total = len(xs) * len(ys)
    done = 0

    for yi, y0 in enumerate(ys):
        for xi, x0 in enumerate(xs):
            tile = np.ascontiguousarray(chw[:, y0:y0 + in_size, x0:x0 + in_size])
            tile_h, tile_w = tile.shape[1], tile.shape[2]
            if tile_h != in_size or tile_w != in_size:
                tile = np.pad(
                    tile,
                    ((0, 0), (0, in_size - tile_h), (0, in_size - tile_w)),
                    mode="edge",
                )

            pred = session.run([out_name], {in_name: tile[None]})[0][0]
            pred_h, pred_w = tile_h * scale, tile_w * scale
            pred = pred[:, :pred_h, :pred_w]

            # 用与邻居的「实际重叠像素」而不是设定值：贴边块可能多重叠
            left = 0 if xi == 0 else max(0, (xs[xi - 1] + in_size) - x0) * scale
            right = 0 if xi + 1 >= len(xs) else max(0, (x0 + in_size) - xs[xi + 1]) * scale
            top = 0 if yi == 0 else max(0, (ys[yi - 1] + in_size) - y0) * scale
            bottom = 0 if yi + 1 >= len(ys) else max(0, (y0 + in_size) - ys[yi + 1]) * scale

            weight = _window(pred_h, top, bottom)[:, None] * _window(pred_w, left, right)[None, :]
            oy, ox = y0 * scale, x0 * scale
            acc[:, oy:oy + pred_h, ox:ox + pred_w] += pred * weight
            wsum[:, oy:oy + pred_h, ox:ox + pred_w] += weight

            done += 1
            if progress is not None:
                progress.update_absolute(done, total)

    return acc / wsum


def _infer_whole(session, chw: np.ndarray) -> np.ndarray:
    """动态尺寸模型：整图一次推理（输入维度不固定时才走这里）。"""
    in_name = session.get_inputs()[0].name
    out_name = session.get_outputs()[0].name
    return session.run([out_name], {in_name: chw[None]})[0][0]


def _to_chw_rgb(image: torch.Tensor) -> tuple[np.ndarray, np.ndarray | None]:
    """把 ComfyUI 的 HWC 图像转成 CHW numpy；4 通道时单独取 alpha 备用。"""
    array = image.detach().to(device="cpu", dtype=torch.float32).numpy()
    if array.ndim != 3:
        raise ValueError(f"图像维度应为 3（H×W×C），实际收到 {array.shape}")
    channels = array.shape[2]
    if channels == 1:
        array = np.repeat(array, 3, axis=2)
        channels = 3
    alpha = array[:, :, 3].copy() if channels >= 4 else None
    return np.ascontiguousarray(array[:, :, :3].transpose(2, 0, 1)), alpha


def _upscale_alpha(alpha: np.ndarray, scale: int) -> np.ndarray:
    """alpha 用双三次插值放大，避免和主体不同步。"""
    tensor = torch.from_numpy(alpha)[None, None]
    upscaled = torch_F.interpolate(
        tensor, scale_factor=scale, mode="bicubic", align_corners=False
    )
    return upscaled[0, 0].numpy()


def _estimate_tiles(height: int, width: int, in_size: int, overlap: int) -> int:
    stride = max(1, in_size - max(0, overlap))
    return len(_axis_starts(width, in_size, stride)) * len(_axis_starts(height, in_size, stride))


# --------------------------------------------------------------------------- #
# 节点
# --------------------------------------------------------------------------- #

def _do_upscale(图像: torch.Tensor, 模型: str, 分块重叠: int, 设备: str, 自动下载: bool):
    if 图像 is None:
        raise ValueError("没有输入图像。")
    if not isinstance(图像, torch.Tensor) or 图像.ndim != 4:
        raise ValueError(f"图像应为 [B, H, W, C] 的批量张量，实际收到 {type(图像)}")

    path = _resolve_model_path(模型, bool(自动下载))
    session, in_size, scale = _get_session(path, 设备)

    batch = int(图像.shape[0])
    prompt_bar = comfy.utils.ProgressBar(batch)
    outputs = []

    for index in range(batch):
        started = time.monotonic()
        chw, alpha = _to_chw_rgb(图像[index])

        if in_size > 0:
            tiles = _estimate_tiles(chw.shape[1], chw.shape[2], in_size, int(分块重叠))
            print(
                f"[GG 超分] 第 {index + 1}/{batch} 张：{chw.shape[2]}×{chw.shape[1]} → "
                f"分 {tiles} 块（块 {in_size}，重叠 {分块重叠}），模型 {模型}"
            )
            result = _infer_tiled(session, chw, in_size, scale, int(分块重叠))
        else:
            print(f"[GG 超分] 第 {index + 1}/{batch} 张：动态度模型，整图推理")
            result = _infer_whole(session, chw)
            scale = max(1, result.shape[2] // chw.shape[2])

        result = np.clip(result, 0.0, 1.0)

        if alpha is not None:
            result = np.concatenate(
                [result, _upscale_alpha(alpha, scale)[None]], axis=0
            )

        outputs.append(torch.from_numpy(np.ascontiguousarray(result.transpose(1, 2, 0))))

        cost = time.monotonic() - started
        print(
            f"[GG 超分] 完成：{result.shape[2]}×{result.shape[1]}，用时 {cost:.2f}s"
        )
        prompt_bar.update(1)

    if len(outputs) == 1:
        stacked = outputs[0].unsqueeze(0)
    else:
        shapes = {tuple(item.shape) for item in outputs}
        if len(shapes) != 1:
            raise RuntimeError(f"批量内图像尺寸不一致，无法堆叠：{sorted(shapes)}")
        stacked = torch.stack(outputs, dim=0)

    return (stacked.contiguous().to(dtype=torch.float32),)


def _run_upscale(
    图像: torch.Tensor,
    模型: str,
    分块重叠: int,
    设备: str,
    自动下载: bool,
    超分后卸载: bool = True,
):
    """跑完超分后按需卸载模型会话。

    卸载判断放在外层：``_do_upscale`` 返回后它内部的 session 局部引用已经消失，
    此时清缓存才真正把 ORT session 析构掉；放在主体函数的 finally 里做，
    session 还被栈帧引用着，gc 收不走。
    """
    if not 超分后卸载:
        return _do_upscale(图像, 模型, 分块重叠, 设备, 自动下载)
    try:
        return _do_upscale(图像, 模型, 分块重叠, 设备, 自动下载)
    finally:
        released = _unload_sessions()
        if released:
            print(f"[GG 超分] 已卸载 {released} 个模型会话，下次执行会重新加载")


class GGImageSuperResolution:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "模型": (
                    _model_options(),
                    {
                        "default": "2x 无降噪",
                        "tooltip": "倍率 + 降噪强度。二次元/插画优先选无降噪或保守降噪；"
                        "压缩痕重（截图、老视频）选降噪2/降噪3。"
                        f"列表除内置档位外，还会自动列出 models/{_MODEL_SUBDIR} 里你自己放的 .onnx；"
                        "内置档位本地没有时会自动下载（约 5MB）。",
                    },
                ),
                "分块重叠": (
                    "INT",
                    {
                        "default": 32,
                        "min": 0,
                        "max": 384,
                        "step": 8,
                        "tooltip": "相邻切块的重叠像素，重叠区做羽化融合。0 会有可见接缝，"
                        "32~64 基本看不出；调大更平滑但更慢（重叠越多重复计算越多）。",
                    },
                ),
                "设备": (
                    ["自动", "CPU", "显卡"],
                    {
                        "default": "自动",
                        "tooltip": "自动=有显卡后端就用显卡，否则 CPU。需要先装 onnxruntime-gpu。",
                    },
                ),
                "自动下载": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "关掉后只使用本地已下载的模型。",
                    },
                ),
                "超分后卸载": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "执行完把模型占用的内存/显存还回去。"
                        "ONNX Runtime 的会话不在 ComfyUI 模型管理里，"
                        "常规的卸载模型节点碰不到它，只能由本节点自己释放。"
                        "连续多次执行时关掉更快（省掉每次重新加载，约 0.1 秒）。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "upscale"
    CATEGORY = _CATEGORY
    OUTPUT_NODE = False

    def upscale(
        self, 图像, 模型="2x 无降噪", 分块重叠=32, 设备="自动", 自动下载=True, 超分后卸载=True
    ):
        return _run_upscale(图像, 模型, 分块重叠, 设备, 自动下载, 超分后卸载)


if io is not None:

    class GGImageSuperResolution_V3(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="GGImageSuperResolution",
                display_name="GG 图片超分（Real-CUGAN）",
                category=_CATEGORY,
                description=(
                    "用 Real-CUGAN / Real-ESRGAN 的 ONNX 模型做 2x/3x/4x 超分，"
                    "内置 11 个官方档位（倍率 × 降噪强度）。大图自动切块推理、"
                    "重叠区羽化融合，不出网格接缝。模型目录 "
                    f"models/{_MODEL_SUBDIR} 里自己放的 .onnx 会自动出现在下拉框。"
                ),
                inputs=[
                    io.Image.Input("图像", tooltip="待超分的图像，支持批量。"),
                    io.Combo.Input(
                        "模型",
                        options=_model_options(),
                        default="2x 无降噪",
                        tooltip=(
                            "倍率 + 降噪强度。插画优先无降噪/保守；压缩痕重选降噪2/降噪3。"
                            f"列表会自动收录 models/{_MODEL_SUBDIR} 里你自己放的 .onnx。"
                        ),
                    ),
                    io.Int.Input(
                        "分块重叠",
                        default=32,
                        min=0,
                        max=384,
                        step=8,
                        tooltip="相邻切块重叠像素，重叠区羽化融合。0 会有接缝，32~64 基本看不出。",
                    ),
                    io.Combo.Input(
                        "设备",
                        options=["自动", "CPU", "显卡"],
                        default="自动",
                        tooltip="自动=有显卡后端就用显卡。需要装 onnxruntime-gpu。",
                    ),
                    io.Boolean.Input(
                        "自动下载",
                        default=True,
                        tooltip="关掉后只用本地已有的模型，不会联网下载。",
                    ),
                    io.Boolean.Input(
                        "超分后卸载",
                        default=True,
                        tooltip=(
                            "执行完把模型占用的内存/显存还回去。ONNX Runtime 的会话不在 "
                            "ComfyUI 模型管理里，常规卸载模型节点碰不到它，只能由本节点自己释放。"
                            "连续多次执行时关掉更快（省掉每次重新加载，约 0.1 秒）。"
                        ),
                    ),
                ],
                outputs=[io.Image.Output(display_name="图像")],
                search_aliases=[
                    "Real-CUGAN",
                    "RealCUGAN",
                    "超分",
                    "放大",
                    "动漫超分",
                    "super resolution",
                    "upscale",
                ],
            )

        @classmethod
        def execute(
            cls, 图像, 模型="2x 无降噪", 分块重叠=32, 设备="自动", 自动下载=True, 超分后卸载=True
        ):
            return io.NodeOutput(
                *_run_upscale(图像, 模型, 分块重叠, 设备, 自动下载, 超分后卸载)
            )

    GGImageSuperResolution = GGImageSuperResolution_V3


NODE_CLASS_MAPPINGS = {
    "GGImageSuperResolution": GGImageSuperResolution,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGImageSuperResolution": "GG 图片超分（Real-CUGAN）",
}
