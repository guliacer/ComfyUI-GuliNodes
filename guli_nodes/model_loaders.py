import asyncio
import gc

import comfy.model_management as mm
import torch

try:
    from aiohttp import web
except Exception:
    web = None

try:
    from server import PromptServer
except Exception:
    PromptServer = None


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
MEMORY_CLEANUP_ROUTE = "/guli/memory/cleanup"
_MEMORY_ROUTE_REGISTERED = False

MODEL_OUTPUT = "\u6a21\u578b"
CATEGORY = "GuliNodes/模型"


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
        messages.append("VAE由上游加载器管理，本插件不持有私有 VAE 缓存")

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


def cleanup_all_memory() -> str:
    """Clear device caches, loaded models, and Python references."""
    return _execute_memory_cleanup(
        clear_cache=True,
        clear_models=True,
        clear_vae_cache=True,
        gc_rounds=2,
        detail_report=False,
    )


def _register_memory_cleanup_route() -> None:
    global _MEMORY_ROUTE_REGISTERED
    if (
        _MEMORY_ROUTE_REGISTERED
        or PromptServer is None
        or getattr(PromptServer, "instance", None) is None
        or web is None
    ):
        return

    @PromptServer.instance.routes.post(MEMORY_CLEANUP_ROUTE)
    async def guli_memory_cleanup(request):
        try:
            loop = asyncio.get_running_loop()
            report = await loop.run_in_executor(None, cleanup_all_memory)
            return web.json_response({"ok": True, "report": report})
        except Exception as exc:
            return web.json_response({"ok": False, "message": str(exc)}, status=500)

    _MEMORY_ROUTE_REGISTERED = True


_register_memory_cleanup_route()


class GGMemoryCleanup:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                CLEAR_CACHE_NAME: ("BOOLEAN", {"default": True, "tooltip": "\u6e05\u7406 PyTorch/ComfyUI \u8bbe\u5907\u7f13\u5b58\u3002"}),
                CLEAR_MODELS_NAME: ("BOOLEAN", {"default": True, "tooltip": "\u5378\u8f7d ComfyUI \u5f53\u524d\u52a0\u8f7d\u7684\u6a21\u578b\u5e76\u6e05\u7406\u6b7b\u4ea1\u5f15\u7528\u3002"}),
                CLEAR_VAE_CACHE_NAME: ("BOOLEAN", {"default": True, "tooltip": "\u517c\u5bb9\u65e7\u5de5\u4f5c\u6d41\uff1bVAE \u7531\u4e0a\u6e38 Loader \u7ba1\u7406\uff0c\u672c\u8282\u70b9\u4e0d\u6301\u6709\u79c1\u6709\u6a21\u578b\u7f13\u5b58\u3002"}),
            },
            "optional": {
                ANY_NAME: (ANY_INPUT,),
            }
        }

    RETURN_TYPES = (ANY_OUTPUT, "STRING")
    RETURN_NAMES = (ANY_NAME, REPORT_OUTPUT)
    FUNCTION = "cleanup"
    CATEGORY = "GuliNodes/模型"

    DESCRIPTION = "\u5378\u8f7d ComfyUI \u6a21\u578b\u3001\u6e05\u7406\u8bbe\u5907\u7f13\u5b58\u5e76\u8f93\u51fa\u62a5\u544a\u3002\u4fdd\u7559\u65e7\u5de5\u4f5c\u6d41\u7684 VAE \u7f13\u5b58\u517c\u5bb9\u5b57\u6bb5\u3002\u53ef\u72ec\u7acb\u89e6\u53d1\uff0c\u4e5f\u53ef\u63a5\u4efb\u610f\u8f93\u5165\u4f5c\u4e3a\u5de5\u4f5c\u6d41\u900f\u4f20\u8282\u70b9\u3002"

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
    MEMORY_CLEANUP_NODE_ID: GGMemoryCleanup,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    MEMORY_CLEANUP_NODE_ID: MEMORY_CLEANUP_DISPLAY_NAME,
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
