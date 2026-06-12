import asyncio
import os
import re
import shutil
import subprocess
import time
import uuid
import wave
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote

import comfy.utils
import folder_paths
import numpy as np
from PIL import Image

try:
    from aiohttp import web
except Exception:
    web = None

try:
    from server import PromptServer
except Exception:
    PromptServer = None

try:
    from comfy_api.latest import InputImpl
except Exception:
    InputImpl = None

try:
    from comfy.comfy_types import IO, ComfyNodeABC
except Exception:
    IO = None

    class ComfyNodeABC:
        pass


VIDEO_TYPE = "VIDEO"
VIDEO_RETURN_TYPE = IO.VIDEO if IO is not None else VIDEO_TYPE
UPLOAD_VIDEO_EXTENSIONS = {"mp4", "flv", "mov", "avi", "f4v"}
PATH_VIDEO_EXTENSIONS = UPLOAD_VIDEO_EXTENSIONS | {"mkv", "webm", "m4v", "mpg", "mpeg", "ts", "m2ts", "wmv"}
PRESET_OPTIONS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]

CN_VIDEO = "\u89c6\u9891"
CN_IMAGE = "\u56fe\u50cf"
CN_AUDIO = "\u97f3\u9891"
CN_VAE = "VAE"
CN_PATH = "\u8def\u5f84"
CN_VIDEO_PATH = "\u89c6\u9891\u8def\u5f84"
CN_VERIFY_READABLE = "\u6267\u884c\u524d\u9a8c\u8bc1\u53ef\u8bfb"
CN_VIDEO_OBJECT = "\u89c6\u9891\u5bf9\u8c61"
CN_VIDEO_FORMAT = "\u89c6\u9891\u683c\u5f0f"
CN_PIXEL_FORMAT = "\u50cf\u7d20\u683c\u5f0f"
CN_TRIM_AUDIO = "\u4fee\u526a\u97f3\u9891"
CN_ENCODER = "\u7f16\u7801\u5668"
CN_MODE = "\u538b\u7f29\u6a21\u5f0f"
CN_CRF = "CRF"
CN_SPEED = "\u7f16\u7801\u901f\u5ea6"
CN_KEEP_RESOLUTION = "\u4fdd\u6301\u539f\u5206\u8fa8\u7387"
CN_MAX_WIDTH = "\u6700\u5927\u5bbd\u5ea6"
CN_MAX_HEIGHT = "\u6700\u5927\u9ad8\u5ea6"
CN_FPS = "\u8f93\u51fa\u5e27\u7387"
CN_AUDIO_BITRATE = "\u97f3\u9891\u7801\u7387kbps"
CN_REMOVE_METADATA = "\u79fb\u9664\u5143\u6570\u636e"
CN_OUTPUT_FORMAT = "\u8f93\u51fa\u683c\u5f0f"
CN_FILENAME_PREFIX = "\u4fdd\u5b58\u6587\u4ef6\u540d\u524d\u7f00"

MODE_SMART = "\u667a\u80fd\u538b\u7f29"
MODE_SIZE = "\u4f53\u79ef\u4f18\u5148"
MODE_COMPAT = "\u517c\u5bb9\u4f18\u5148"
FORMAT_FOLLOW = "\u8ddf\u968f\u8f93\u5165"
BRIDGE_VIDEO_FORMATS = ["mp4", "mov", "mkv"]
BRIDGE_PIXEL_FORMATS = ["yuv420p", "yuv444p", "yuv420p10le"]
BRIDGE_DEFAULT_FPS = 24

CPU_ENCODER_OPTIONS = [
    "x264_32-8bit.exe",
    "x264_32-10bit.exe",
    "x264_64-8bit.exe",
    "x264_64-10bit.exe",
    "x264_64-12bit.exe",
    "x265-64-8bit.exe",
    "x265-64-10bit.exe",
    "x265-64-12bit.exe",
]
DEFAULT_ENCODER_LABEL = "x264_64-8bit.exe"
LEGACY_ENCODER_ALIASES = {
    "CPU H.264 (libx264)": "x264_64-8bit.exe",
    "CPU H.265 (libx265)": "x265-64-8bit.exe",
    "\u81ea\u52a8\u4f18\u5148\u786c\u4ef6\u7f16\u7801": "x264_64-8bit.exe",
    "x265-8bit\\gcc1.exe": "x265-64-8bit.exe",
    "x265-8bit\\gcc[cpu].exe": "x265-64-8bit.exe",
    "x265-64-8bit[gcc].exe": "x265-64-8bit.exe",
    "x265-8bit.exe": "x265-64-8bit.exe",
    "x265-10bit.exe": "x265-64-10bit.exe",
    "x265-12bit.exe": "x265-64-12bit.exe",
}

ENCODER_PROFILES = {
    "x264_32-8bit.exe": {"codec": "libx264", "family": "cpu", "default_crf": 23.5, "pix_fmt": "yuv420p"},
    "x264_32-10bit.exe": {"codec": "libx264", "family": "cpu", "default_crf": 23.5, "pix_fmt": "yuv420p10le"},
    "x264_64-8bit.exe": {"codec": "libx264", "family": "cpu", "default_crf": 23.5, "pix_fmt": "yuv420p"},
    "x264_64-10bit.exe": {"codec": "libx264", "family": "cpu", "default_crf": 23.5, "pix_fmt": "yuv420p10le"},
    "x264_64-12bit.exe": {"codec": "libx264", "family": "cpu", "default_crf": 23.5, "pix_fmt": "yuv420p12le"},
    "x265-64-8bit.exe": {"codec": "libx265", "family": "cpu", "default_crf": 28.0, "pix_fmt": "yuv420p"},
    "x265-64-10bit.exe": {"codec": "libx265", "family": "cpu", "default_crf": 28.0, "pix_fmt": "yuv420p10le"},
    "x265-64-12bit.exe": {"codec": "libx265", "family": "cpu", "default_crf": 28.0, "pix_fmt": "yuv420p12le"},
}

_ENCODER_OPTIONS_CACHE = None
_ROUTES_REGISTERED = False
FFMPEG_PROGRESS_TOTAL = 1000
VIDEO_SEARCH_MAX_DEPTH = 4
VIDEO_SEARCH_MAX_ENTRIES = 20000


def _resolve_ffmpeg_binary(binary_name: str) -> str | None:
    env_key = f"{binary_name.upper()}_PATH"
    env_path = os.environ.get(env_key)
    if env_path and os.path.exists(env_path):
        return env_path

    system_path = shutil.which(binary_name)
    if system_path:
        return system_path

    current = Path(__file__).resolve()
    for parent in current.parents:
        for candidate in (
            parent / "python_embeded" / f"{binary_name}.exe",
            parent / "python_embeded" / binary_name,
            parent / f"{binary_name}.exe",
            parent / binary_name,
        ):
            if candidate.exists():
                return str(candidate)
    return None


def _normalize_user_video_path(value: str) -> str:
    if not isinstance(value, str):
        return ""
    text = unquote(value.strip().strip('"').strip("'"))
    if text.startswith("file:///"):
        text = text[8:]
    elif text.startswith("file://"):
        text = text[7:]
    return text.replace("\\", "/")


def _sanitize_stem(name: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in ("-", "_", ".", "/", "\\") else "_" for ch in (name or "video"))
    return cleaned.strip("._") or "video"


def _resolve_prefix(prefix: str) -> str:
    if not isinstance(prefix, str):
        return "video"
    return prefix.replace("%date:yyyy_MM_dd%", datetime.now().strftime("%Y_%m_%d"))


def _iter_files_bounded(root: Path, max_depth: int = VIDEO_SEARCH_MAX_DEPTH, max_entries: int = VIDEO_SEARCH_MAX_ENTRIES):
    stack = [(root, 0)]
    visited = 0
    while stack and visited < max_entries:
        directory, depth = stack.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    visited += 1
                    if visited > max_entries:
                        break
                    try:
                        if entry.is_file(follow_symlinks=False):
                            yield Path(entry.path)
                        elif depth < max_depth and entry.is_dir(follow_symlinks=False):
                            stack.append((Path(entry.path), depth + 1))
                    except OSError:
                        continue
        except OSError:
            continue


def _search_file_by_name(file_name: str, search_roots: list[Path]) -> str:
    target_name = Path(file_name).name.lower()
    relative_name = _normalize_user_video_path(file_name)
    for root in search_roots:
        if not root.exists() or not root.is_dir():
            continue
        direct_candidate = root / relative_name
        if direct_candidate.is_file():
            return str(direct_candidate.resolve())
        try:
            for candidate in _iter_files_bounded(root):
                if candidate.name.lower() == target_name:
                    return str(candidate.resolve())
        except Exception:
            continue
    return ""


def _get_windows_drive_roots() -> list[Path]:
    drives = []
    for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        drive = Path(f"{letter}:/")
        if drive.exists():
            drives.append(drive)
    return drives


def _build_search_roots_from_directory(directory: str) -> list[Path]:
    roots = []
    directory_norm = _normalize_user_video_path(directory)
    if not directory_norm:
        return roots

    directory_path = Path(directory_norm).expanduser()
    if directory_path.exists():
        roots.append(directory_path)
    return roots


def _resolve_video_file_reference(file_name: str) -> str:
    file_name = _normalize_user_video_path(file_name)
    if not file_name:
        return ""

    direct = Path(file_name).expanduser()
    if direct.is_file():
        return str(direct.resolve())

    try:
        annotated_path = folder_paths.get_annotated_filepath(file_name)
    except Exception:
        annotated_path = ""
    if annotated_path and os.path.isfile(annotated_path):
        return str(Path(annotated_path).resolve())

    comfy_root = Path(folder_paths.get_input_directory()).parent
    roots = [
        Path(folder_paths.get_input_directory()),
        Path(folder_paths.get_temp_directory()),
        Path(folder_paths.get_output_directory()),
        comfy_root,
        Path.home() / "Videos",
        Path.home() / "Desktop",
        Path.home() / "Downloads",
    ]
    return _search_file_by_name(file_name, roots)


def _validate_video_extension(path: str, allowed_extensions: set[str] = PATH_VIDEO_EXTENSIONS) -> None:
    suffix = Path(str(path or "")).suffix.lower().lstrip(".")
    if suffix not in allowed_extensions:
        raise ValueError(f"\u4e0d\u652f\u6301\u7684\u89c6\u9891\u683c\u5f0f: {suffix or path}")


def _load_video_from_resolved_path(video_path: str, verify_readable: bool = True):
    if not video_path or not os.path.isfile(video_path):
        raise FileNotFoundError(f"\u627e\u4e0d\u5230\u89c6\u9891\u6587\u4ef6: {video_path}")

    _validate_video_extension(video_path)
    video_path = str(Path(video_path).resolve())

    if verify_readable:
        ok, probe_error = _probe_video_readable(video_path)
        if not ok:
            raise RuntimeError(f"\u89c6\u9891\u6587\u4ef6\u65e0\u6cd5\u6b63\u5e38\u8bfb\u53d6: {video_path}\n{probe_error}")

    return _build_video_output(video_path, Path(video_path).suffix.lstrip("."), "", video_path), video_path


def _select_video_file_dialog() -> str:
    try:
        import ctypes
        from ctypes import wintypes

        initial_dir = folder_paths.get_input_directory()
        if not initial_dir or not os.path.isdir(initial_dir):
            initial_dir = str(Path.home())

        class OPENFILENAMEW(ctypes.Structure):
            _fields_ = [
                ("lStructSize", wintypes.DWORD),
                ("hwndOwner", wintypes.HWND),
                ("hInstance", wintypes.HINSTANCE),
                ("lpstrFilter", wintypes.LPCWSTR),
                ("lpstrCustomFilter", wintypes.LPWSTR),
                ("nMaxCustFilter", wintypes.DWORD),
                ("nFilterIndex", wintypes.DWORD),
                ("lpstrFile", wintypes.LPWSTR),
                ("nMaxFile", wintypes.DWORD),
                ("lpstrFileTitle", wintypes.LPWSTR),
                ("nMaxFileTitle", wintypes.DWORD),
                ("lpstrInitialDir", wintypes.LPCWSTR),
                ("lpstrTitle", wintypes.LPCWSTR),
                ("Flags", wintypes.DWORD),
                ("nFileOffset", wintypes.WORD),
                ("nFileExtension", wintypes.WORD),
                ("lpstrDefExt", wintypes.LPCWSTR),
                ("lCustData", wintypes.LPARAM),
                ("lpfnHook", wintypes.LPVOID),
                ("lpTemplateName", wintypes.LPCWSTR),
                ("pvReserved", wintypes.LPVOID),
                ("dwReserved", wintypes.DWORD),
                ("FlagsEx", wintypes.DWORD),
            ]

        buffer_size = 65536
        file_buffer = ctypes.create_unicode_buffer(buffer_size)
        extensions = sorted(PATH_VIDEO_EXTENSIONS)
        patterns = ";".join(f"*.{ext}" for ext in extensions)
        file_filter = f"\u89c6\u9891\u6587\u4ef6 ({patterns})\0{patterns}\0\u6240\u6709\u6587\u4ef6 (*.*)\0*.*\0\0"
        ofn = OPENFILENAMEW(
            lStructSize=ctypes.sizeof(OPENFILENAMEW),
            hwndOwner=None,
            hInstance=None,
            lpstrFilter=file_filter,
            lpstrCustomFilter=None,
            nMaxCustFilter=0,
            nFilterIndex=1,
            lpstrFile=ctypes.cast(file_buffer, wintypes.LPWSTR),
            nMaxFile=buffer_size,
            lpstrFileTitle=None,
            nMaxFileTitle=0,
            lpstrInitialDir=str(Path(initial_dir).resolve()),
            lpstrTitle="\u9009\u62e9\u89c6\u9891\u6587\u4ef6",
            Flags=0x00080000 | 0x00001000 | 0x00000800 | 0x00000004,
            nFileOffset=0,
            nFileExtension=0,
            lpstrDefExt=None,
            lCustData=0,
            lpfnHook=None,
            lpTemplateName=None,
            pvReserved=None,
            dwReserved=0,
            FlagsEx=0,
        )

        if ctypes.windll.comdlg32.GetOpenFileNameW(ctypes.byref(ofn)):
            return str(Path(file_buffer.value).resolve())

        error_code = ctypes.windll.comdlg32.CommDlgExtendedError()
        if error_code == 0:
            return ""
        raise RuntimeError(f"\u7cfb\u7edf\u6587\u4ef6\u9009\u62e9\u5668\u9519\u8bef: 0x{error_code:04X}")
    except Exception as exc:
        raise RuntimeError(f"\u65e0\u6cd5\u6253\u5f00\u7cfb\u7edf\u6587\u4ef6\u9009\u62e9\u5668: {exc}") from exc


def _extract_native_video_path(video) -> str:
    if video is None:
        return ""

    direct_file = getattr(video, "_VideoFromFile__file", "")
    if direct_file:
        return str(direct_file)

    stream_source = getattr(video, "get_stream_source", None)
    if callable(stream_source):
        try:
            source = stream_source()
            if isinstance(source, str) and source:
                return source
        except Exception:
            pass

    if isinstance(video, dict):
        return str(video.get("path", "") or video.get("source_path", "") or "")

    return ""


def _resolve_source_path(video) -> str:
    return _extract_native_video_path(video)


def _validate_source_path(source_path: str) -> str:
    if not source_path:
        raise ValueError("\u8bf7\u8fde\u63a5\u4e0a\u4e00\u4e2a\u8282\u70b9\u8f93\u51fa\u7684\u89c6\u9891\u5bf9\u8c61\u3002")
    resolved = Path(_normalize_user_video_path(source_path)).expanduser()
    if not resolved.is_file():
        raise FileNotFoundError(f"\u627e\u4e0d\u5230\u89c6\u9891\u6587\u4ef6: {resolved}")
    return str(resolved.resolve())


def _probe_video_readable(source_path: str) -> tuple[bool, str]:
    ffmpeg_path = _resolve_ffmpeg_binary("ffmpeg")
    if not ffmpeg_path:
        return True, ""

    command = [
        ffmpeg_path,
        "-v",
        "error",
        "-i",
        source_path,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
    ]
    result = _run_ffmpeg_command(command)
    if result.returncode == 0:
        return True, ""
    return False, (result.stderr or result.stdout or "").strip()[-800:]


def _resolve_video_preview_path(file: str, directory: str = "") -> str:
    file_norm = _normalize_user_video_path(file)
    dir_norm = _normalize_user_video_path(directory)

    if file_norm:
        direct = Path(file_norm).expanduser()
        if direct.is_file():
            return str(direct.resolve())
        if direct.is_absolute():
            return str(direct)

    if dir_norm and file_norm:
        joined = Path(dir_norm).expanduser() / Path(file_norm).name
        if joined.is_file():
            return str(joined.resolve())
        if joined.is_absolute():
            return str(joined)
        searched_from_dir = _search_file_by_name(Path(file_norm).name, _build_search_roots_from_directory(dir_norm))
        if searched_from_dir:
            return searched_from_dir

    if file_norm:
        input_candidate = Path(folder_paths.get_input_directory()) / Path(file_norm).name
        if input_candidate.is_file():
            return str(input_candidate.resolve())

        searched = _resolve_video_file_reference(file_norm)
        if searched:
            return searched

    if dir_norm:
        directory_path = Path(dir_norm).expanduser()
        if directory_path.is_dir():
            return str(directory_path.resolve())
        return str(directory_path)

    return ""


def _infer_temp_output_format(source_path: str) -> str:
    source_ext = Path(source_path).suffix.lower().lstrip(".")
    return source_ext if source_ext in {"mp4", "mov", "mkv", "avi", "flv", "f4v"} else "mp4"


def _build_temp_output_path(source_path: str, output_format: str) -> str:
    temp_root = Path(folder_paths.get_temp_directory()) / "GuliVideos"
    temp_root.mkdir(parents=True, exist_ok=True)
    source = Path(source_path)
    filename = f"{source.stem}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.{output_format.lower()}"
    return str((temp_root / filename).resolve())


def _build_bridge_work_dir() -> Path:
    work_dir = Path(folder_paths.get_temp_directory()) / "GuliVideos" / f"bridge_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
    work_dir.mkdir(parents=True, exist_ok=True)
    return work_dir


def _tensor_to_rgb_image(image) -> Image.Image:
    array = image.detach().cpu().numpy()
    array = np.clip(array * 255.0, 0, 255).astype(np.uint8)
    if array.ndim == 2:
        return Image.fromarray(array, mode="L").convert("RGB")
    channels = array.shape[-1] if array.ndim == 3 else 1
    if channels == 1:
        return Image.fromarray(array[..., 0], mode="L").convert("RGB")
    if channels == 2:
        return Image.fromarray(array[..., :2], mode="LA").convert("RGB")
    if channels == 3:
        return Image.fromarray(array[..., :3], mode="RGB")
    return Image.fromarray(array[..., :4], mode="RGBA").convert("RGB")


def _write_image_sequence(images, frames_dir: Path) -> int:
    if images is None or not hasattr(images, "shape") or len(images.shape) < 3:
        raise ValueError("\u8bf7\u8fde\u63a5\u4e0a\u6e38 IMAGE \u56fe\u50cf\u6279\u6b21\u3002")
    frame_count = int(images.shape[0])
    if frame_count <= 0:
        raise ValueError("\u56fe\u50cf\u6279\u6b21\u4e2d\u6ca1\u6709\u53ef\u7528\u5e27\u3002")

    frames_dir.mkdir(parents=True, exist_ok=True)
    for index in range(frame_count):
        frame_path = frames_dir / f"frame_{index:06d}.png"
        _tensor_to_rgb_image(images[index]).save(frame_path, "PNG")
    return frame_count


def _audio_to_wave_array(audio, trim_seconds: float | None = None) -> tuple[np.ndarray, int]:
    if not isinstance(audio, dict) or "waveform" not in audio or "sample_rate" not in audio:
        raise ValueError("\u8bf7\u8fde\u63a5\u4e0a\u6e38 AUDIO \u97f3\u9891\u3002")

    waveform = audio["waveform"]
    sample_rate = int(audio["sample_rate"])
    if sample_rate <= 0:
        raise ValueError(f"\u97f3\u9891\u91c7\u6837\u7387\u65e0\u6548: {sample_rate}")

    array = waveform.detach().cpu().numpy()
    if array.ndim == 3:
        array = array[0]
    elif array.ndim == 1:
        array = array[None, :]
    if array.ndim != 2:
        raise ValueError(f"\u4e0d\u652f\u6301\u7684\u97f3\u9891\u5f20\u91cf\u7ef4\u5ea6: {array.shape}")

    if trim_seconds is not None and trim_seconds > 0:
        max_samples = max(1, int(round(trim_seconds * sample_rate)))
        array = array[:, :max_samples]

    array = np.clip(array, -1.0, 1.0)
    return np.ascontiguousarray((array.T * 32767.0).astype(np.int16)), sample_rate


def _write_audio_wav(audio, output_path: Path, trim_seconds: float | None = None) -> str:
    samples, sample_rate = _audio_to_wave_array(audio, trim_seconds)
    channel_count = 1 if samples.ndim == 1 else int(samples.shape[1])
    with wave.open(str(output_path), "wb") as wav_file:
        wav_file.setnchannels(channel_count)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(samples.tobytes())
    return str(output_path.resolve())


def _pick_bridge_video_codec(video_format: str) -> str:
    fmt = str(video_format or "mp4").lower()
    return "libx264" if fmt in {"mp4", "mov", "mkv"} else "libx264"


def _build_bridge_ffmpeg_command(
    ffmpeg_path: str,
    frames_dir: Path,
    audio_path: str,
    output_path: str,
    video_format: str,
    pixel_format: str,
    crf: float,
    fps: int,
) -> list[str]:
    command = [
        ffmpeg_path,
        "-y",
        "-framerate",
        str(max(1, int(fps))),
        "-i",
        str((frames_dir / "frame_%06d.png").resolve()),
        "-i",
        audio_path,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        _pick_bridge_video_codec(video_format),
        "-preset",
        "medium",
        "-crf",
        str(max(0.0, min(40.0, float(crf)))),
        "-pix_fmt",
        pixel_format,
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:a",
        _pick_audio_codec(video_format),
        "-b:a",
        "192k",
    ]
    if str(video_format).lower() in {"mp4", "mov"}:
        command.extend(["-movflags", "+faststart"])
    command.append(output_path)
    return command


def _build_saved_output_path(video_path: str, filename_prefix: str) -> str:
    output_root = Path(folder_paths.get_output_directory()).resolve()
    source = Path(video_path)
    prefix = _sanitize_stem(_resolve_prefix(filename_prefix))
    prefix_path = Path(prefix).expanduser()
    if prefix_path.is_absolute():
        prefix_path = Path(prefix_path.name)
    clean_parts = [part for part in prefix_path.parts if part not in ("", ".", "..") and not Path(part).is_absolute()]
    prefix_path = Path(*clean_parts) if clean_parts else Path(source.stem)
    parent = output_root / prefix_path.parent
    parent = parent.resolve()
    if not (parent == output_root or output_root in parent.parents):
        raise ValueError(f"保存路径必须位于 ComfyUI 输出目录内: {parent}")
    parent.mkdir(parents=True, exist_ok=True)
    stem = prefix_path.name or source.stem
    filename = f"{stem}_{datetime.now().strftime('%Y%m%d_%H%M%S')}{source.suffix.lower() or '.mp4'}"
    output_path = (parent / filename).resolve()
    if not (output_path.parent == output_root or output_root in output_path.parent.parents):
        raise ValueError(f"保存路径必须位于 ComfyUI 输出目录内: {output_path}")
    return str(output_path)


def _pick_audio_codec(output_format: str) -> str:
    return "mp3" if output_format.lower() == "avi" else "aac"


def _build_scale_filter(max_width: int, max_height: int) -> str:
    if max_width <= 0 and max_height <= 0:
        return "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    width_limit = max_width if max_width > 0 else 32768
    height_limit = max_height if max_height > 0 else 32768
    return f"scale={width_limit}:{height_limit}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2"


def _get_encoder_options() -> list[str]:
    global _ENCODER_OPTIONS_CACHE
    if _ENCODER_OPTIONS_CACHE is not None:
        return _ENCODER_OPTIONS_CACHE

    _ENCODER_OPTIONS_CACHE = list(CPU_ENCODER_OPTIONS)
    return _ENCODER_OPTIONS_CACHE


def _pick_encoder_profile(output_format: str, encoder_label: str, compress_mode: str) -> dict:
    fmt = output_format.lower()
    encoder_label = LEGACY_ENCODER_ALIASES.get(encoder_label, encoder_label)
    profile = dict(ENCODER_PROFILES.get(encoder_label, ENCODER_PROFILES[DEFAULT_ENCODER_LABEL]))

    if fmt == "avi":
        return {"codec": "mpeg4", "family": "legacy", "default_crf": 5.0, "pix_fmt": "yuv420p"}

    if fmt == "flv" and profile["codec"] in {"libx265", "hevc_nvenc", "hevc_qsv", "hevc_amf"}:
        return dict(ENCODER_PROFILES[DEFAULT_ENCODER_LABEL])

    if compress_mode == MODE_COMPAT and profile["codec"] in {"libx265", "hevc_nvenc", "hevc_qsv", "hevc_amf"}:
        return dict(ENCODER_PROFILES[DEFAULT_ENCODER_LABEL])

    if compress_mode == MODE_SIZE and fmt == "flv":
        return dict(ENCODER_PROFILES[DEFAULT_ENCODER_LABEL])

    return profile


def _get_encoder_candidates(output_format: str, encoder_label: str, compress_mode: str) -> list[str]:
    encoder_label = LEGACY_ENCODER_ALIASES.get(encoder_label, encoder_label)
    if encoder_label not in ENCODER_PROFILES:
        encoder_label = DEFAULT_ENCODER_LABEL
    return [encoder_label]


def _add_quality_arguments(command: list[str], profile: dict, chosen_crf: float, preset: str) -> None:
    family = profile["family"]
    clamped_quality = max(0.0, min(40.0, float(chosen_crf)))

    if family == "cpu":
        command.extend(["-preset", preset, "-crf", str(clamped_quality), "-pix_fmt", profile["pix_fmt"], "-threads", "0"])
        return

    if family == "legacy":
        command.extend(["-q:v", str(max(2, min(15, int(round(clamped_quality)))))])
        return

    


def _build_ffmpeg_command(
    ffmpeg_path: str,
    source_path: str,
    output_path: str,
    output_format: str,
    encoder: str,
    compress_mode: str,
    crf: float,
    preset: str,
    keep_original_resolution: bool,
    max_width: int,
    max_height: int,
    fps: int,
    audio_bitrate_kbps: int,
    remove_metadata: bool,
) -> tuple[list[str], str]:
    profile = _pick_encoder_profile(output_format, encoder, compress_mode)
    video_codec = profile["codec"]
    audio_codec = _pick_audio_codec(output_format)
    chosen_crf = profile["default_crf"] if crf <= 0 else float(crf)

    command = [ffmpeg_path, "-y"]
    command.extend(["-i", source_path, "-map_metadata", "-1" if remove_metadata else "0", "-c:v", video_codec])

    _add_quality_arguments(command, profile, chosen_crf, preset)

    if keep_original_resolution:
        command.extend(["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"])
    else:
        command.extend(["-vf", _build_scale_filter(max_width, max_height)])

    if fps > 0:
        command.extend(["-r", str(fps)])

    command.extend(["-c:a", audio_codec, "-b:a", f"{max(1, int(audio_bitrate_kbps or 96))}k"])

    if output_format.lower() in {"mp4", "mov", "f4v"}:
        command.extend(["-movflags", "+faststart"])

    command.append(output_path)
    return command, video_codec


def _build_video_payload(path: str, output_format: str, codec: str, source_path: str, encoder: str = "") -> dict:
    return {"path": path, "format": output_format.lower(), "codec": codec, "source_path": source_path, "encoder": encoder}


def _build_video_output(path: str, output_format: str, codec: str, source_path: str, encoder: str = ""):
    if InputImpl is not None:
        try:
            return InputImpl.VideoFromFile(path)
        except Exception:
            pass
    return _build_video_payload(path, output_format, codec, source_path, encoder)


def _run_ffmpeg_command(command: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="ignore", check=False)


def _probe_video_duration_seconds(source_path: str) -> float:
    ffprobe_path = _resolve_ffmpeg_binary("ffprobe")
    if ffprobe_path:
        command = [
            ffprobe_path,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            source_path,
        ]
        result = _run_ffmpeg_command(command)
        if result.returncode == 0:
            try:
                return max(0.0, float((result.stdout or "").strip()))
            except Exception:
                pass

    ffmpeg_path = _resolve_ffmpeg_binary("ffmpeg")
    if not ffmpeg_path:
        return 0.0

    command = [ffmpeg_path, "-i", source_path]
    result = _run_ffmpeg_command(command)
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr or "")
    if not match:
        return 0.0
    hours = int(match.group(1))
    minutes = int(match.group(2))
    seconds = float(match.group(3))
    return hours * 3600 + minutes * 60 + seconds


def _create_progress_bar(node_id: str | None):
    try:
        return comfy.utils.ProgressBar(FFMPEG_PROGRESS_TOTAL, node_id=node_id)
    except Exception:
        return None


def _update_progress_bar(progress_bar, value: int) -> None:
    if progress_bar is None:
        return
    try:
        progress_bar.update_absolute(max(0, min(FFMPEG_PROGRESS_TOTAL, int(value))), FFMPEG_PROGRESS_TOTAL)
    except Exception:
        pass


def _run_ffmpeg_command_with_progress(command: list[str], source_path: str, node_id: str | None = None) -> subprocess.CompletedProcess:
    duration_seconds = _probe_video_duration_seconds(source_path)
    progress_bar = _create_progress_bar(node_id)
    _update_progress_bar(progress_bar, 0)

    process = subprocess.Popen(
        [*command[:-1], "-progress", "pipe:1", "-nostats", command[-1]],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="ignore",
    )

    output_lines = []
    last_progress_value = 0
    last_emit_time = 0.0

    try:
        if process.stdout is not None:
            for raw_line in process.stdout:
                line = raw_line.strip()
                output_lines.append(raw_line)
                if not line:
                    continue

                if line.startswith("out_time_ms=") and duration_seconds > 0:
                    try:
                        out_time_ms = int(line.split("=", 1)[1] or "0")
                    except Exception:
                        out_time_ms = 0
                    progress_ratio = min(1.0, max(0.0, out_time_ms / max(duration_seconds * 1_000_000.0, 1.0)))
                    progress_value = int(progress_ratio * FFMPEG_PROGRESS_TOTAL)
                    now = time.perf_counter()
                    if progress_value > last_progress_value and (progress_value - last_progress_value >= 3 or now - last_emit_time >= 0.12):
                        _update_progress_bar(progress_bar, progress_value)
                        last_progress_value = progress_value
                        last_emit_time = now
                elif line == "progress=end":
                    _update_progress_bar(progress_bar, FFMPEG_PROGRESS_TOTAL)

        return_code = process.wait()
    finally:
        if process.stdout is not None:
            process.stdout.close()

    if return_code == 0:
        _update_progress_bar(progress_bar, FFMPEG_PROGRESS_TOTAL)

    merged_output = "".join(output_lines)
    return subprocess.CompletedProcess(
        args=command,
        returncode=return_code,
        stdout=merged_output,
        stderr=merged_output if return_code != 0 else "",
    )


def _summarize_encoder_error(candidate_encoder: str, stderr_text: str) -> str:
    text = (stderr_text or "").strip()
    return f"[{candidate_encoder}] {text[-600:]}"


def _register_video_preview_route() -> None:
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED or PromptServer is None or getattr(PromptServer, "instance", None) is None or web is None:
        return

    @PromptServer.instance.routes.get("/guli/video/preview")
    async def guli_preview_video(request):
        file_value = request.query.get("file", "")
        directory = request.query.get("directory", "")
        raw_path = request.query.get("path", "")

        video_path = _resolve_video_preview_path(raw_path or file_value, directory)
        if not video_path or not os.path.isfile(video_path):
            raise web.HTTPNotFound(text=f"找不到视频文件: {video_path or raw_path or file_value}")

        suffix = Path(video_path).suffix.lower().lstrip(".")
        if suffix not in UPLOAD_VIDEO_EXTENSIONS:
            raise web.HTTPBadRequest(text=f"不支持预览的文件格式: {suffix or video_path}")

        return web.FileResponse(path=video_path)

    @PromptServer.instance.routes.post("/guli/video/select")
    async def guli_select_video(request):
        try:
            video_path = await asyncio.to_thread(_select_video_file_dialog)
        except Exception as exc:
            raise web.HTTPInternalServerError(text=str(exc))

        if not video_path:
            return web.json_response({"path": ""})

        suffix = Path(video_path).suffix.lower().lstrip(".")
        if suffix not in PATH_VIDEO_EXTENSIONS:
            raise web.HTTPBadRequest(text=f"\u4e0d\u652f\u6301\u7684\u89c6\u9891\u683c\u5f0f: {suffix or video_path}")

        return web.json_response({"path": video_path})

    _ROUTES_REGISTERED = True


_register_video_preview_route()


class GGVideoLoad(ComfyNodeABC):
    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = []
        if os.path.isdir(input_dir):
            files = [name for name in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, name))]
            filter_func = getattr(folder_paths, "filter_files_content_types", None)
            if callable(filter_func):
                try:
                    files = filter_func(files, ["video"])
                except Exception:
                    files = [name for name in files if Path(name).suffix.lower().lstrip(".") in UPLOAD_VIDEO_EXTENSIONS]
            else:
                files = [name for name in files if Path(name).suffix.lower().lstrip(".") in UPLOAD_VIDEO_EXTENSIONS]
        return {"required": {"视频文件": (sorted(files), {"video_upload": True})}}

    RETURN_TYPES = (VIDEO_RETURN_TYPE, "PATH")
    RETURN_NAMES = (CN_VIDEO, CN_PATH)
    FUNCTION = "load_video"
    CATEGORY = "GuliNodes/视频"

    def load_video(self, 视频文件):
        try:
            video_path = folder_paths.get_annotated_filepath(视频文件)
        except Exception:
            video_path = _resolve_video_file_reference(视频文件)

        if not video_path or not os.path.isfile(video_path):
            video_path = _resolve_video_file_reference(视频文件)

        if not video_path or not os.path.isfile(video_path):
            raise FileNotFoundError(f"\u627e\u4e0d\u5230\u89c6\u9891\u6587\u4ef6: {视频文件}")

        ok, probe_error = _probe_video_readable(video_path)
        if not ok:
            raise RuntimeError(f"\u89c6\u9891\u6587\u4ef6\u65e0\u6cd5\u6b63\u5e38\u8bfb\u53d6: {video_path}\n{probe_error}")

        if InputImpl is None:
            return (_build_video_payload(video_path, Path(video_path).suffix.lstrip("."), "", video_path), video_path)
        return (InputImpl.VideoFromFile(video_path), video_path)

    @classmethod
    def IS_CHANGED(cls, 视频文件):
        try:
            video_path = folder_paths.get_annotated_filepath(视频文件)
        except Exception:
            video_path = _resolve_video_file_reference(视频文件)
        if not video_path or not os.path.isfile(video_path):
            video_path = _resolve_video_file_reference(视频文件)
        return os.path.getmtime(video_path) if video_path and os.path.isfile(video_path) else 视频文件

    @classmethod
    def VALIDATE_INPUTS(cls, 视频文件):
        suffix = Path(视频文件).suffix.lower().lstrip(".")
        return True if suffix in UPLOAD_VIDEO_EXTENSIONS else f"Invalid video file: {视频文件}"


class GGVideoLoadByPath(ComfyNodeABC):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                CN_VIDEO_PATH: (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "placeholder": "D:/videos/example.mp4",
                    },
                ),
                CN_VERIFY_READABLE: ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = (VIDEO_RETURN_TYPE, "PATH")
    RETURN_NAMES = (CN_VIDEO, CN_PATH)
    FUNCTION = "load_video_by_path"
    CATEGORY = "GuliNodes/\u89c6\u9891"
    DESCRIPTION = "\u901a\u8fc7\u672c\u673a\u6587\u4ef6\u8def\u5f84\u52a0\u8f7d\u89c6\u9891\uff0c\u4e0d\u7ecf\u8fc7\u6d4f\u89c8\u5668\u4e0a\u4f20\uff0c\u53ef\u907f\u5f00 ComfyUI \u4e0a\u4f20\u4f53\u79ef\u9650\u5236\u3002"

    def load_video_by_path(self, **kwargs):
        video_path_value = kwargs.get(CN_VIDEO_PATH, "")
        verify_readable = bool(kwargs.get(CN_VERIFY_READABLE, True))
        video_path = _resolve_video_file_reference(video_path_value)
        if not video_path:
            video_path = _normalize_user_video_path(video_path_value)
        return _load_video_from_resolved_path(video_path, verify_readable)

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        video_path_value = kwargs.get(CN_VIDEO_PATH, "")
        video_path = _resolve_video_file_reference(video_path_value) or _normalize_user_video_path(video_path_value)
        if not video_path or not os.path.isfile(video_path):
            return video_path_value
        try:
            stat = os.stat(video_path)
        except OSError:
            return video_path
        return f"{video_path}:{stat.st_size}:{stat.st_mtime_ns}"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        video_path_value = kwargs.get(CN_VIDEO_PATH, "")
        video_path = _resolve_video_file_reference(video_path_value) or _normalize_user_video_path(video_path_value)
        if not video_path:
            return "\u8bf7\u8f93\u5165\u89c6\u9891\u6587\u4ef6\u8def\u5f84\u3002"
        suffix = Path(video_path).suffix.lower().lstrip(".")
        if suffix not in PATH_VIDEO_EXTENSIONS:
            return f"\u4e0d\u652f\u6301\u7684\u89c6\u9891\u683c\u5f0f: {suffix or video_path}"
        return True if os.path.isfile(video_path) else f"\u627e\u4e0d\u5230\u89c6\u9891\u6587\u4ef6: {video_path}"


class GGVideoBridgeFromImageAudio:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                CN_IMAGE: ("IMAGE",),
                CN_AUDIO: ("AUDIO",),
                CN_VAE: ("VAE",),
                CN_VIDEO_FORMAT: (BRIDGE_VIDEO_FORMATS, {"default": "mp4"}),
                CN_PIXEL_FORMAT: (BRIDGE_PIXEL_FORMATS, {"default": "yuv420p"}),
                CN_CRF: ("FLOAT", {"default": 15.0, "min": 0.0, "max": 40.0, "step": 0.1}),
                CN_FPS: ("INT", {"default": BRIDGE_DEFAULT_FPS, "min": 1, "max": 240, "step": 1}),
                CN_TRIM_AUDIO: ("BOOLEAN", {"default": False}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = (VIDEO_RETURN_TYPE,)
    RETURN_NAMES = (CN_VIDEO,)
    FUNCTION = "make_video"
    CATEGORY = "GuliNodes/\u89c6\u9891"
    DESCRIPTION = "\u5c06\u4e0a\u6e38 IMAGE \u5e27\u6279\u6b21\u4e0e AUDIO \u5408\u6210\u4e3a VIDEO\uff0c\u4fbf\u4e8e\u63a5\u5165 GG \u89c6\u9891\u538b\u7f29\u8282\u70b9\u3002VAE \u8f93\u5165\u7528\u4e8e\u517c\u5bb9\u89c6\u9891\u5de5\u4f5c\u6d41\u8fde\u63a5\u3002"

    def make_video(self, **kwargs):
        images = kwargs.get(CN_IMAGE)
        audio = kwargs.get(CN_AUDIO)
        _vae = kwargs.get(CN_VAE)
        video_format = str(kwargs.get(CN_VIDEO_FORMAT, "mp4")).lower()
        pixel_format = str(kwargs.get(CN_PIXEL_FORMAT, "yuv420p"))
        crf = float(kwargs.get(CN_CRF, 15.0))
        fps = max(1, int(kwargs.get(CN_FPS, BRIDGE_DEFAULT_FPS)))
        trim_audio = bool(kwargs.get(CN_TRIM_AUDIO, False))
        unique_id = kwargs.get("unique_id")

        if video_format not in BRIDGE_VIDEO_FORMATS:
            raise ValueError(f"\u4e0d\u652f\u6301\u7684\u89c6\u9891\u683c\u5f0f: {video_format}")
        if pixel_format not in BRIDGE_PIXEL_FORMATS:
            raise ValueError(f"\u4e0d\u652f\u6301\u7684\u50cf\u7d20\u683c\u5f0f: {pixel_format}")

        ffmpeg_path = _resolve_ffmpeg_binary("ffmpeg")
        if not ffmpeg_path:
            raise RuntimeError("\u672a\u627e\u5230 ffmpeg\u3002")

        work_dir = _build_bridge_work_dir()
        frames_dir = work_dir / "frames"
        frame_count = _write_image_sequence(images, frames_dir)
        video_duration = frame_count / fps
        audio_path = _write_audio_wav(audio, work_dir / "audio.wav", video_duration if trim_audio else None)
        output_path = str((work_dir / f"video.{video_format}").resolve())

        command = _build_bridge_ffmpeg_command(
            ffmpeg_path=ffmpeg_path,
            frames_dir=frames_dir,
            audio_path=audio_path,
            output_path=output_path,
            video_format=video_format,
            pixel_format=pixel_format,
            crf=crf,
            fps=fps,
        )
        result = _run_ffmpeg_command_with_progress(command, audio_path, str(unique_id) if unique_id else None)

        try:
            shutil.rmtree(frames_dir, ignore_errors=True)
            Path(audio_path).unlink(missing_ok=True)
        except Exception:
            pass

        if result.returncode != 0 or not os.path.exists(output_path):
            stderr = (result.stderr or result.stdout or "").strip()
            raise RuntimeError(f"\u89c6\u9891\u5408\u6210\u5931\u8d25\u3002\n\u9519\u8bef: {stderr[-1500:]}")

        return (_build_video_output(output_path, video_format, _pick_bridge_video_codec(video_format), output_path),)

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")


class GGVideoCompress:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {CN_VIDEO_OBJECT: (VIDEO_RETURN_TYPE,)},
            "optional": {
                CN_ENCODER: (_get_encoder_options(), {"default": DEFAULT_ENCODER_LABEL}),
                CN_MODE: ([MODE_SMART, MODE_SIZE, MODE_COMPAT], {"default": MODE_SMART}),
                CN_CRF: ("FLOAT", {"default": 23.5, "min": 0.0, "max": 40.0, "step": 0.1}),
                CN_SPEED: (PRESET_OPTIONS, {"default": "medium"}),
                CN_KEEP_RESOLUTION: ("BOOLEAN", {"default": True}),
                CN_MAX_WIDTH: ("INT", {"default": 0, "min": 0, "max": 8192, "step": 2}),
                CN_MAX_HEIGHT: ("INT", {"default": 0, "min": 0, "max": 8192, "step": 2}),
                CN_FPS: ("INT", {"default": 0, "min": 0, "max": 240, "step": 1}),
                CN_AUDIO_BITRATE: ("INT", {"default": 96, "min": 0, "max": 512, "step": 8}),
                CN_REMOVE_METADATA: ("BOOLEAN", {"default": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = (VIDEO_RETURN_TYPE,)
    RETURN_NAMES = (CN_VIDEO,)
    FUNCTION = "compress_video"
    CATEGORY = "GuliNodes/视频"

    def compress_video(self, **kwargs):
        video_object = kwargs.get(CN_VIDEO_OBJECT)
        encoder = kwargs.get(CN_ENCODER, DEFAULT_ENCODER_LABEL)
        compress_mode = kwargs.get(CN_MODE, MODE_SMART)
        crf = float(kwargs.get(CN_CRF, 23.5))
        preset = kwargs.get(CN_SPEED, "medium")
        keep_original_resolution = bool(kwargs.get(CN_KEEP_RESOLUTION, True))
        max_width = int(kwargs.get(CN_MAX_WIDTH, 0))
        max_height = int(kwargs.get(CN_MAX_HEIGHT, 0))
        fps = int(kwargs.get(CN_FPS, 0))
        audio_bitrate_kbps = int(kwargs.get(CN_AUDIO_BITRATE, 96))
        remove_metadata = bool(kwargs.get(CN_REMOVE_METADATA, True))
        unique_id = kwargs.get("unique_id")

        ffmpeg_path = _resolve_ffmpeg_binary("ffmpeg")
        if not ffmpeg_path:
            raise RuntimeError("\u672a\u627e\u5230 ffmpeg\u3002")

        source_path = _validate_source_path(_resolve_source_path(video_object))
        ok, probe_error = _probe_video_readable(source_path)
        if not ok:
            raise RuntimeError(f"\u8f93\u5165\u89c6\u9891\u65e0\u6cd5\u6b63\u5e38\u89e3\u7801: {source_path}\n{probe_error}")
        output_format = _infer_temp_output_format(source_path)
        output_path = _build_temp_output_path(source_path, output_format)
        errors = []

        for candidate_encoder in _get_encoder_candidates(output_format, encoder, compress_mode):
            if os.path.exists(output_path):
                try:
                    os.remove(output_path)
                except Exception:
                    pass

            command, video_codec = _build_ffmpeg_command(
                ffmpeg_path=ffmpeg_path,
                source_path=source_path,
                output_path=output_path,
                output_format=output_format,
                encoder=candidate_encoder,
                compress_mode=compress_mode,
                crf=crf,
                preset=preset,
                keep_original_resolution=keep_original_resolution,
                max_width=max_width,
                max_height=max_height,
                fps=fps,
                audio_bitrate_kbps=audio_bitrate_kbps,
                remove_metadata=remove_metadata,
            )

            result = _run_ffmpeg_command_with_progress(command, source_path, str(unique_id) if unique_id else None)
            if result.returncode == 0 and os.path.exists(output_path):
                return (_build_video_output(output_path, output_format, video_codec, source_path, candidate_encoder),)

            stderr_text = (result.stderr or "").strip()[-800:]
            errors.append(_summarize_encoder_error(candidate_encoder, stderr_text))

        raise RuntimeError("\u89c6\u9891\u538b\u7f29\u5931\u8d25\u3002\n" + "\n".join(errors[-3:]))


class GGVideoSave:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {CN_VIDEO_OBJECT: (VIDEO_RETURN_TYPE,)},
            "optional": {
                CN_OUTPUT_FORMAT: ([FORMAT_FOLLOW, "mp4", "flv", "mov", "avi", "f4v"], {"default": FORMAT_FOLLOW}),
                CN_FILENAME_PREFIX: ("STRING", {"default": "Video/%date:yyyy_MM_dd%/\u89c6\u9891\u538b\u7f29"}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "save_video"
    CATEGORY = "GuliNodes/视频"
    OUTPUT_NODE = True

    def save_video(self, **kwargs):
        video_object = kwargs.get(CN_VIDEO_OBJECT)
        output_format = kwargs.get(CN_OUTPUT_FORMAT, FORMAT_FOLLOW)
        filename_prefix = kwargs.get(CN_FILENAME_PREFIX, "Video/%date:yyyy_MM_dd%/\u89c6\u9891\u538b\u7f29")

        source_path = _validate_source_path(_resolve_source_path(video_object))
        source_format = Path(source_path).suffix.lower().lstrip(".")
        target_format = source_format if output_format == FORMAT_FOLLOW else str(output_format).lower()
        destination_path = _build_saved_output_path(str(Path(source_path).with_suffix(f".{target_format}")), filename_prefix)

        if target_format == source_format:
            Path(destination_path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_path, destination_path)
            return {"ui": {"guli_video_preview": [{"path": destination_path, "format": target_format, "source_path": source_path}]}}

        ffmpeg_path = _resolve_ffmpeg_binary("ffmpeg")
        if not ffmpeg_path:
            raise RuntimeError("\u672a\u627e\u5230 ffmpeg\uff0c\u65e0\u6cd5\u5207\u6362\u89c6\u9891\u4fdd\u5b58\u683c\u5f0f\u3002")

        remux_command = [ffmpeg_path, "-y", "-i", source_path, "-c", "copy", destination_path]
        remux_result = _run_ffmpeg_command(remux_command)
        if remux_result.returncode == 0 and os.path.exists(destination_path):
            return {"ui": {"guli_video_preview": [{"path": destination_path, "format": target_format, "source_path": source_path}]}}

        fallback_profile = _pick_encoder_profile(target_format, DEFAULT_ENCODER_LABEL, MODE_COMPAT)
        fallback_audio = _pick_audio_codec(target_format)
        transcode_command = [
            ffmpeg_path,
            "-y",
            "-i",
            source_path,
            "-c:v",
            fallback_profile["codec"],
            "-pix_fmt",
            fallback_profile["pix_fmt"],
            "-preset",
            "medium",
            "-crf",
            "23.5",
            "-c:a",
            fallback_audio,
            "-b:a",
            "96k",
            destination_path,
        ]
        transcode_result = _run_ffmpeg_command(transcode_command)
        if transcode_result.returncode != 0 or not os.path.exists(destination_path):
            stderr = (transcode_result.stderr or remux_result.stderr or "").strip()
            raise RuntimeError(f"\u89c6\u9891\u4fdd\u5b58\u5931\u8d25\u3002\n\u9519\u8bef: {stderr[-1500:]}")
        return {"ui": {"guli_video_preview": [{"path": destination_path, "format": target_format, "source_path": source_path}]}}


NODE_CLASS_MAPPINGS = {
    "GGVideoLoad": GGVideoLoad,
    "GGVideoLoadByPath": GGVideoLoadByPath,
    "GGVideoBridgeFromImageAudio": GGVideoBridgeFromImageAudio,
    "GGVideoCompress": GGVideoCompress,
    "GGVideoSave": GGVideoSave,
}


NODE_DISPLAY_NAME_MAPPINGS = {
    "GGVideoLoad": "GG \u89c6\u9891\u52a0\u8f7d",
    "GGVideoLoadByPath": "GG \u89c6\u9891\u8def\u5f84\u52a0\u8f7d",
    "GGVideoBridgeFromImageAudio": "GG \u89c6\u9891\u5408\u6210",
    "GGVideoCompress": "GG \u89c6\u9891\u538b\u7f29",
    "GGVideoSave": "GG \u89c6\u9891\u4fdd\u5b58",
}
