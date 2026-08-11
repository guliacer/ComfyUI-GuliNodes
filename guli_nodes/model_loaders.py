from collections import OrderedDict
import gc
import hashlib
import os
import threading

import comfy.model_management as mm
import comfy.sd
import folder_paths
import torch


ANY_INPUT = "*"
ANY_OUTPUT = "*"
ANY_NAME = "\u4efb\u4f55"
CLEAR_CACHE_NAME = "\u6e05\u9664\u7f13\u5b58"
CLEAR_MODELS_NAME = "\u6e05\u9664\u6a21\u578b"
CLEAR_VAE_CACHE_NAME = "\u6e05\u9664VAE\u7f13\u5b58"
GC_ROUNDS_NAME = "GC\u8f6e\u6570"
DETAIL_REPORT_NAME = "\u8be6\u7ec6\u62a5\u544a"
REPORT_OUTPUT = "\u62a5\u544a"
MEMORY_CLEANUP_NODE_ID = "GGMemoryCleanup"
MEMORY_CLEANUP_DISPLAY_NAME = "GG \u5185\u5b58\u6e05\u7406"

LATENT_INPUT = "Latent"
IMAGE_INPUT = "\u56fe\u50cf"
VAE_NAME = "VAE\u540d\u79f0"
IMAGE_OUTPUT = "\u56fe\u50cf"
LATENT_OUTPUT = "Latent"
EMPTY_VAE_MESSAGE = "\uff08\u8bf7\u628aVAE\u6a21\u578b\u653e\u5230 models/vae\uff09"
VAE_DECODE_NODE_ID = "GGVAE\u89e3\u7801"
VAE_DECODE_DISPLAY_NAME = "GG VAE\u89e3\u7801"
VAE_ENCODE_NODE_ID = "GGVAE\u7f16\u7801"
VAE_ENCODE_DISPLAY_NAME = "GG VAE\u7f16\u7801"
VAE_CACHE_LIMIT = 2

MODEL_OUTPUT = "\u6a21\u578b"
CATEGORY = "GuliNodes/模型"


def _resolve_model_file(folder_names: tuple[str, ...], model_file: str) -> str:
    for folder_name in folder_names:
        try:
            model_path = folder_paths.get_full_path(folder_name, model_file)
        except Exception:
            model_path = None
        if model_path and os.path.exists(model_path):
            return model_path

    for folder_name in folder_names:
        fallback_path = os.path.join(folder_paths.models_dir, folder_name, model_file)
        if os.path.exists(fallback_path):
            return fallback_path

    return ""


def _model_file_fingerprint(model_path: str) -> str:
    if not model_path or not os.path.exists(model_path):
        return ""
    try:
        stat = os.stat(model_path)
    except OSError:
        return model_path
    return f"{model_path}:{stat.st_size}:{stat.st_mtime_ns}"


def _get_native_vae_loader_class():
    try:
        from nodes import VAELoader

        return VAELoader
    except Exception:
        return None


def _get_native_vae_decode_class():
    try:
        from nodes import VAEDecode

        return VAEDecode
    except Exception:
        return None


def _get_native_vae_encode_class():
    try:
        from nodes import VAEEncode

        return VAEEncode
    except Exception:
        return None


def _list_vae_files() -> list[str]:
    loader_class = _get_native_vae_loader_class()
    if loader_class is not None:
        try:
            files = loader_class.vae_list(loader_class)
            if files:
                return files
        except Exception:
            pass

    try:
        files = folder_paths.get_filename_list("vae")
    except Exception:
        files = []
    if "pixel_space" not in files:
        files.append("pixel_space")
    return files or [EMPTY_VAE_MESSAGE]


def _vae_file_fingerprint(vae_name: str) -> str:
    if not vae_name or vae_name == EMPTY_VAE_MESSAGE:
        return ""
    if vae_name == "pixel_space":
        return "pixel_space"

    loader_class = _get_native_vae_loader_class()
    image_taes = getattr(loader_class, "image_taes", ["taesd", "taesdxl", "taesd3", "taef1", "taef2"])
    video_taes = getattr(loader_class, "video_taes", ["taehv", "lighttaew2_2", "lighttaew2_1", "lighttaehy1_5", "taeltx_2"])

    if vae_name in image_taes:
        try:
            approx_vaes = folder_paths.get_filename_list("vae_approx")
            encoder = next((name for name in approx_vaes if name.startswith(f"{vae_name}_encoder.")), "")
            decoder = next((name for name in approx_vaes if name.startswith(f"{vae_name}_decoder.")), "")
        except Exception:
            encoder = decoder = ""
        fingerprints = []
        for filename in (encoder, decoder):
            if not filename:
                continue
            try:
                path = folder_paths.get_full_path_or_raise("vae_approx", filename)
            except Exception:
                path = _resolve_model_file(("vae_approx",), filename)
            fingerprints.append(_model_file_fingerprint(path))
        return "|".join(fingerprints) or vae_name

    folder_name = "vae_approx" if os.path.splitext(vae_name)[0] in video_taes else "vae"
    try:
        path = folder_paths.get_full_path_or_raise(folder_name, vae_name)
    except Exception:
        path = _resolve_model_file((folder_name,), vae_name)
    return _model_file_fingerprint(path)


def _load_vae_with_native_loader(vae_name: str):
    loader_class = _get_native_vae_loader_class()
    if loader_class is None:
        raise RuntimeError("\u672a\u80fd\u8bfb\u53d6 ComfyUI \u539f\u751f\u52a0\u8f7dVAE\u8282\u70b9\u3002")
    return loader_class().load_vae(vae_name)[0]


def _decode_vae_with_native_node(vae, samples):
    decode_class = _get_native_vae_decode_class()
    if decode_class is not None:
        return decode_class().decode(vae, samples)

    latent = samples["samples"]
    if latent.is_nested:
        latent = latent.unbind()[0]
    images = vae.decode(latent)
    if len(images.shape) == 5:
        images = images.reshape(-1, images.shape[-3], images.shape[-2], images.shape[-1])
    return (images,)


def _encode_vae_with_native_node(vae, pixels):
    encode_class = _get_native_vae_encode_class()
    if encode_class is not None:
        return encode_class().encode(vae, pixels)

    latent = vae.encode(pixels)
    return ({"samples": latent},)


def _format_bytes(value) -> str:
    try:
        size = float(value)
    except Exception:
        return "\u672a\u77e5"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(size) < 1024.0 or unit == "TB":
            return f"{size:.2f}{unit}"
        size /= 1024.0
    return f"{size:.2f}TB"


def _memory_snapshot() -> list[str]:
    rows = []
    try:
        devices = list(mm.get_all_torch_devices())
    except Exception:
        try:
            devices = [mm.get_torch_device()]
        except Exception:
            devices = []

    for device in devices:
        try:
            free_total, torch_free = mm.get_free_memory(device, torch_free_too=True)
            rows.append(f"{device}: \u53ef\u7528 {_format_bytes(free_total)}\uff0cTorch\u53ef\u91ca\u653e {_format_bytes(torch_free)}")
        except Exception as exc:
            rows.append(f"{device}: \u8bfb\u53d6\u5931\u8d25 {exc}")
    return rows


def _run_cleanup_step(name: str, action, messages: list[str], errors: list[str]):
    try:
        result = action()
        if result is None:
            messages.append(f"{name}: \u5b8c\u6210")
        else:
            messages.append(f"{name}: {result}")
    except Exception as exc:
        errors.append(f"{name}: {exc}")


def _clear_guli_vae_cache() -> int:
    with GGVaeDecode._cache_lock:
        count = len(GGVaeDecode._vae_cache)
        GGVaeDecode._vae_cache.clear()
    return count


def _clear_device_caches(messages: list[str], errors: list[str]) -> None:
    _run_cleanup_step("ComfyUI\u7f13\u5b58", lambda: mm.soft_empty_cache(force=True), messages, errors)

    if torch.cuda.is_available():
        def clear_cuda():
            count = torch.cuda.device_count()
            for index in range(count):
                with torch.cuda.device(index):
                    torch.cuda.synchronize(index)
                    torch.cuda.empty_cache()
                    torch.cuda.ipc_collect()
            return f"CUDA\u8bbe\u5907 {count} \u4e2a"
        _run_cleanup_step("CUDA\u7f13\u5b58", clear_cuda, messages, errors)

    if hasattr(torch, "xpu") and hasattr(torch.xpu, "is_available") and torch.xpu.is_available():
        def clear_xpu():
            torch.xpu.synchronize()
            torch.xpu.empty_cache()
        _run_cleanup_step("XPU\u7f13\u5b58", clear_xpu, messages, errors)

    if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache") and getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        _run_cleanup_step("MPS\u7f13\u5b58", torch.mps.empty_cache, messages, errors)

    if hasattr(torch, "npu") and hasattr(torch.npu, "empty_cache") and hasattr(torch.npu, "is_available") and torch.npu.is_available():
        _run_cleanup_step("NPU\u7f13\u5b58", torch.npu.empty_cache, messages, errors)

    if hasattr(torch, "mlu") and hasattr(torch.mlu, "empty_cache") and hasattr(torch.mlu, "is_available") and torch.mlu.is_available():
        _run_cleanup_step("MLU\u7f13\u5b58", torch.mlu.empty_cache, messages, errors)


def _execute_memory_cleanup(
    clear_cache: bool,
    clear_models: bool,
    clear_vae_cache: bool,
    gc_rounds: int,
    detail_report: bool,
) -> str:
    messages = []
    errors = []
    if detail_report:
        before = _memory_snapshot()
        if before:
            messages.append("\u6e05\u7406\u524d: " + "\uff1b".join(before))

    if clear_vae_cache:
        _run_cleanup_step("GuliNodes VAE\u7f13\u5b58", lambda: f"\u6e05\u9664 {_clear_guli_vae_cache()} \u4e2a", messages, errors)

    if clear_models:
        _run_cleanup_step("\u5378\u8f7dComfyUI\u6a21\u578b", mm.unload_all_models, messages, errors)
        _run_cleanup_step("\u6e05\u7406ComfyUI\u6a21\u578b\u5f15\u7528", mm.cleanup_models, messages, errors)
        cleanup_gc = getattr(mm, "cleanup_models_gc", None)
        if callable(cleanup_gc):
            _run_cleanup_step("\u6e05\u7406\u6b7b\u4ea1\u6a21\u578b\u5f15\u7528", cleanup_gc, messages, errors)

    rounds = max(0, int(gc_rounds))
    for index in range(rounds):
        collected = gc.collect()
        messages.append(f"Python GC\u7b2c{index + 1}\u8f6e: \u56de\u6536 {collected} \u4e2a\u5bf9\u8c61")

    if clear_cache:
        _clear_device_caches(messages, errors)

    if detail_report:
        after = _memory_snapshot()
        if after:
            messages.append("\u6e05\u7406\u540e: " + "\uff1b".join(after))

    if errors:
        messages.append("\u9519\u8bef: " + "\uff1b".join(errors))
    report = "\n".join(messages) if messages else "\u672a\u6267\u884c\u4efb\u4f55\u6e05\u7406\u52a8\u4f5c\u3002"
    print(f"GG \u5185\u5b58\u6e05\u7406:\n{report}")
    return report


class GGVaeDecode:
    _vae_cache = OrderedDict()
    _cache_lock = threading.RLock()

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                LATENT_INPUT: ("LATENT", {"tooltip": "\u9700\u8981\u89e3\u7801\u4e3a\u56fe\u50cf\u7684 Latent\u3002"}),
                VAE_NAME: (_list_vae_files(), {"tooltip": "\u9009\u62e9\u8981\u52a0\u8f7d\u5e76\u7528\u4e8e\u89e3\u7801\u7684 VAE\u3002"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = (IMAGE_OUTPUT,)
    FUNCTION = "decode"
    CATEGORY = "GuliNodes/潜空间"
    DESCRIPTION = "\u878d\u5408\u52a0\u8f7dVAE\u4e0eVAE\u89e3\u7801\u7684\u4e00\u4f53\u8282\u70b9\uff0cVAE \u6309\u6587\u4ef6\u6307\u7eb9\u7f13\u5b58\uff0cLatent \u53d8\u5316\u65f6\u4e0d\u91cd\u590d\u52a0\u8f7d VAE\u3002"

    @classmethod
    def _cache_key(cls, vae_name: str) -> tuple[str, str]:
        return (vae_name, _vae_file_fingerprint(vae_name))

    @classmethod
    def _get_vae(cls, vae_name: str):
        if not vae_name or vae_name == EMPTY_VAE_MESSAGE:
            raise RuntimeError("\u672a\u627e\u5230\u53ef\u7528\u7684 VAE \u6a21\u578b\u3002\u8bf7\u628a\u6a21\u578b\u653e\u5230 ComfyUI/models/vae/ \u540e\u91cd\u542f\u3002")

        key = cls._cache_key(vae_name)
        with cls._cache_lock:
            cached_vae = cls._vae_cache.get(key)
            if cached_vae is not None:
                cls._vae_cache.move_to_end(key)
                return cached_vae

        vae = _load_vae_with_native_loader(vae_name)

        with cls._cache_lock:
            cls._vae_cache[key] = vae
            cls._vae_cache.move_to_end(key)
            while len(cls._vae_cache) > VAE_CACHE_LIMIT:
                cls._vae_cache.popitem(last=False)
        return vae

    def decode(self, **kwargs) -> tuple:
        samples = kwargs.get(LATENT_INPUT)
        vae_name = kwargs.get(VAE_NAME, "")
        if samples is None:
            raise RuntimeError("Latent \u8f93\u5165\u65e0\u6548\uff1a\u672a\u68c0\u6d4b\u5230\u9700\u8981\u89e3\u7801\u7684 Latent\u3002")
        vae = self._get_vae(vae_name)
        return _decode_vae_with_native_node(vae, samples)

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        vae_name = kwargs.get(VAE_NAME, "")
        m = hashlib.sha256()
        m.update(str(vae_name).encode("utf-8"))
        m.update(_vae_file_fingerprint(vae_name).encode("utf-8"))
        return m.hexdigest()


class GGVaeEncode(GGVaeDecode):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                IMAGE_INPUT: ("IMAGE", {"tooltip": "\u9700\u8981\u7f16\u7801\u4e3a Latent \u7684\u56fe\u50cf\u3002"}),
                VAE_NAME: (_list_vae_files(), {"tooltip": "\u9009\u62e9\u8981\u52a0\u8f7d\u5e76\u7528\u4e8e\u7f16\u7801\u7684 VAE\u3002"}),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = (LATENT_OUTPUT,)
    FUNCTION = "encode"
    CATEGORY = "GuliNodes/潜空间"
    DESCRIPTION = "\u878d\u5408\u52a0\u8f7dVAE\u4e0eVAE\u7f16\u7801\u7684\u4e00\u4f53\u8282\u70b9\uff0c\u56fe\u50cf\u8f93\u5165\u540e\u76f4\u63a5\u8f93\u51fa Latent\uff0cVAE \u6309\u6587\u4ef6\u6307\u7eb9\u7f13\u5b58\u3002"

    def encode(self, **kwargs) -> tuple:
        图像 = kwargs.get(IMAGE_INPUT)
        VAE名称 = kwargs.get(VAE_NAME, "")
        if 图像 is None:
            raise RuntimeError("\u56fe\u50cf\u8f93\u5165\u65e0\u6548\uff1a\u672a\u68c0\u6d4b\u5230\u9700\u8981\u7f16\u7801\u4e3a Latent \u7684\u56fe\u50cf\u3002")
        VAE模型 = self._get_vae(VAE名称)
        return _encode_vae_with_native_node(VAE模型, 图像)


class GGMemoryCleanup:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                CLEAR_CACHE_NAME: ("BOOLEAN", {"default": True, "tooltip": "\u6e05\u7406 PyTorch/ComfyUI \u8bbe\u5907\u7f13\u5b58\u3002"}),
                CLEAR_MODELS_NAME: ("BOOLEAN", {"default": True, "tooltip": "\u5378\u8f7d ComfyUI \u5f53\u524d\u52a0\u8f7d\u7684\u6a21\u578b\u5e76\u6e05\u7406\u6b7b\u4ea1\u5f15\u7528\u3002"}),
                CLEAR_VAE_CACHE_NAME: ("BOOLEAN", {"default": True, "tooltip": "\u6e05\u7406 GG VAE\u89e3\u7801/GG VAE\u7f16\u7801 \u8282\u70b9\u5185\u90e8\u7f13\u5b58\u7684 VAE\u3002"}),
            },
            "optional": {
                ANY_NAME: (ANY_INPUT,),
            }
        }

    RETURN_TYPES = (ANY_OUTPUT, "STRING")
    RETURN_NAMES = (ANY_NAME, REPORT_OUTPUT)
    FUNCTION = "cleanup"
    CATEGORY = "GuliNodes/模型"

    DESCRIPTION = "\u5378\u8f7d\u6a21\u578b\u3001\u6e05\u7406\u7f13\u5b58\u3001\u91ca\u653e GuliNodes \u5185\u90e8 VAE \u7f13\u5b58\uff0c\u5e76\u8f93\u51fa\u6e05\u7406\u62a5\u544a\u3002\u53ef\u72ec\u7acb\u89e6\u53d1\uff0c\u4e5f\u53ef\u63a5\u4efb\u610f\u8f93\u5165\u4f5c\u4e3a\u5de5\u4f5c\u6d41\u900f\u4f20\u8282\u70b9\u3002"

    def cleanup(self, **kwargs) -> tuple:
        value = kwargs.get(ANY_NAME)
        clear_cache = bool(kwargs.get(CLEAR_CACHE_NAME, True))
        clear_models = bool(kwargs.get(CLEAR_MODELS_NAME, True))
        clear_vae_cache = bool(kwargs.get(CLEAR_VAE_CACHE_NAME, True))
        gc_rounds = 2
        detail_report = False
        report = _execute_memory_cleanup(clear_cache, clear_models, clear_vae_cache, gc_rounds, detail_report)
        if value is None:
            value = report
        return (value, report)

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")


NODE_CLASS_MAPPINGS = {
    VAE_DECODE_NODE_ID: GGVaeDecode,
    VAE_ENCODE_NODE_ID: GGVaeEncode,
    MEMORY_CLEANUP_NODE_ID: GGMemoryCleanup,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    VAE_DECODE_NODE_ID: VAE_DECODE_DISPLAY_NAME,
    VAE_ENCODE_NODE_ID: VAE_ENCODE_DISPLAY_NAME,
    MEMORY_CLEANUP_NODE_ID: MEMORY_CLEANUP_DISPLAY_NAME,
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
