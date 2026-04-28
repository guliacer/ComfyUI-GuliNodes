import gc
import os

import comfy.model_management as mm
import comfy.sd
import folder_paths
import torch


UNET_EXTENSIONS = {".safetensors", ".ckpt", ".pt", ".pth", ".bin"}

ANY_INPUT = "*"
ANY_OUTPUT = "*"
ANY_NAME = "\u4efb\u4f55"
CLEAR_CACHE_NAME = "\u6e05\u9664\u7f13\u5b58"
CLEAR_MODELS_NAME = "\u6e05\u9664\u6a21\u578b"
MEMORY_CLEANUP_NODE_ID = "GGMemoryCleanup"
MEMORY_CLEANUP_DISPLAY_NAME = "GG \u5185\u5b58\u6e05\u7406"

MODEL_FILE = "\u6a21\u578b\u6587\u4ef6"
DTYPE_NAME = "\u6570\u636e\u7c7b\u578b"
MODEL_OUTPUT = "\u6a21\u578b"
CATEGORY = "GuliNodes/\u6a21\u578b\u52a0\u8f7d"
DEFAULT_DTYPE = "\u9ed8\u8ba4"
EMPTY_UNET_MESSAGE = "\uff08\u8bf7\u628aUNET\u6a21\u578b\u653e\u5230 models/unet\uff09"
UNET_NODE_ID = "GGUNET\u6a21\u578b"
UNET_DISPLAY_NAME = "GG UNET\u6a21\u578b"


GGUF_MODEL_FILE = "\u6a21\u578b\u6587\u4ef6"
DEQUANT_DTYPE_NAME = "\u53cd\u91cf\u5316\u6570\u636e\u7c7b\u578b"
PATCH_DTYPE_NAME = "\u6743\u91cd\u8865\u4e01\u6570\u636e\u7c7b\u578b"
PATCH_ON_DEVICE_NAME = "\u5728\u8bbe\u5907\u4e0a\u6253\u8865\u4e01"
SAGE_ATTENTION_NAME = "\u542f\u7528SageAttention"
FLASH_ATTENTION_NAME = "\u542f\u7528FlashAttention"
GGUF_NODE_ID = "GGGGUF\u6a21\u578b"
GGUF_DISPLAY_NAME = "GG GGUF\u6a21\u578b"
GGUF_DTYPE_OPTIONS = ["default", "target", "float32", "float16", "bfloat16"]

DTYPE_OPTIONS = {
    DEFAULT_DTYPE: None,
    "float32": torch.float32,
    "float16": torch.float16,
    "bfloat16": torch.bfloat16,
}


def _list_unet_files() -> list[str]:
    try:
        files = [
            filename
            for filename in folder_paths.get_filename_list("diffusion_models")
            if os.path.splitext(filename)[1].lower() in UNET_EXTENSIONS
        ]
    except Exception:
        search_dirs = [
            os.path.join(folder_paths.models_dir, "unet"),
            os.path.join(folder_paths.models_dir, "diffusion_models"),
        ]
        files = []
        for directory in search_dirs:
            os.makedirs(directory, exist_ok=True)
            files.extend(
                filename
                for filename in os.listdir(directory)
                if os.path.isfile(os.path.join(directory, filename))
                and os.path.splitext(filename)[1].lower() in UNET_EXTENSIONS
            )

    files = sorted(set(files), key=str.lower)
    return files or [EMPTY_UNET_MESSAGE]


def _list_gguf_files() -> list[str]:
    files = []
    try:
        files.extend(
            filename
            for filename in folder_paths.get_filename_list("unet_gguf")
            if filename.lower().endswith(".gguf")
        )
    except Exception:
        pass

    search_dirs = [
        os.path.join(folder_paths.models_dir, "unet"),
        os.path.join(folder_paths.models_dir, "diffusion_models"),
    ]
    for directory in search_dirs:
        os.makedirs(directory, exist_ok=True)
        files.extend(
            filename
            for filename in os.listdir(directory)
            if os.path.isfile(os.path.join(directory, filename)) and filename.lower().endswith(".gguf")
        )
    files = sorted(set(files), key=str.lower)
    return files or ["\uff08\u8bf7\u628aGGUF\u6a21\u578b\u653e\u5230 models/unet \u3001models/diffusion_models \u6216 ComfyUI-GGUF \u914d\u7f6e\u76ee\u5f55\uff09"]


def _get_gguf_loader_class():
    custom_nodes_dir = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    gguf_dir = os.path.join(custom_nodes_dir, "ComfyUI-GGUF")
    init_path = os.path.join(gguf_dir, "__init__.py")
    if not os.path.exists(init_path):
        return None

    import importlib.util
    import sys

    package_name = "guli_external_comfyui_gguf"
    if package_name in sys.modules:
        package = sys.modules[package_name]
    else:
        spec = importlib.util.spec_from_file_location(package_name, init_path, submodule_search_locations=[gguf_dir])
        if spec is None or spec.loader is None:
            return None
        package = importlib.util.module_from_spec(spec)
        sys.modules[package_name] = package
        spec.loader.exec_module(package)

    node_classes = getattr(package, "NODE_CLASS_MAPPINGS", {})
    return node_classes.get("UnetLoaderGGUFAdvanced") or node_classes.get("UnetLoaderGGUF")


class GGUNETLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                MODEL_FILE: (_list_unet_files(), {"tooltip": "\u4ec5\u52a0\u8f7d\u666e\u901a UNET \u6a21\u578b\u6587\u4ef6\uff0c\u4e0d\u5305\u542b GGUF"}),
                DTYPE_NAME: (list(DTYPE_OPTIONS.keys()), {"default": DEFAULT_DTYPE}),
                SAGE_ATTENTION_NAME: ("BOOLEAN", {"default": True}),
                FLASH_ATTENTION_NAME: ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = (MODEL_OUTPUT,)
    FUNCTION = "load"
    CATEGORY = CATEGORY

    def load(self, **kwargs) -> tuple:
        model_file = kwargs.get(MODEL_FILE)
        dtype_name = kwargs.get(DTYPE_NAME, DEFAULT_DTYPE)
        enable_sage_attention = kwargs.get(SAGE_ATTENTION_NAME, True)
        enable_flash_attention = kwargs.get(FLASH_ATTENTION_NAME, True)

        if model_file == EMPTY_UNET_MESSAGE:
            raise RuntimeError("\u672a\u627e\u5230\u53ef\u7528UNET\u6a21\u578b\u6587\u4ef6\u3002\u8bf7\u628a\u6a21\u578b\u653e\u5230 ComfyUI/models/unet/ \u6216 ComfyUI/models/diffusion_models/ \u540e\u91cd\u542f\u3002")
        if not model_file:
            raise RuntimeError("\u8bf7\u9009\u62e9UNET\u6a21\u578b\u6587\u4ef6\u3002")

        try:
            model_path = folder_paths.get_full_path_or_raise("diffusion_models", model_file)
        except Exception:
            fallback_paths = [
                os.path.join(folder_paths.models_dir, "unet", model_file),
                os.path.join(folder_paths.models_dir, "diffusion_models", model_file),
            ]
            model_path = next((path for path in fallback_paths if os.path.exists(path)), "")
        if not model_path or not os.path.exists(model_path):
            raise FileNotFoundError(f"\u6a21\u578b\u6587\u4ef6\u4e0d\u5b58\u5728: {model_file}")
        if os.path.getsize(model_path) == 0:
            raise RuntimeError(f"\u6a21\u578b\u6587\u4ef6\u4e3a\u7a7a: {model_path}")

        model_options = {}
        dtype = DTYPE_OPTIONS.get(dtype_name)
        if dtype is not None:
            model_options["dtype"] = dtype

        try:
            model = comfy.sd.load_diffusion_model(model_path, model_options=model_options)
        except Exception as exc:
            raise RuntimeError(f"\u52a0\u8f7dUNET\u6a21\u578b\u5931\u8d25: {exc}\n\u6587\u4ef6\u8def\u5f84: {model_path}") from exc

        self._apply_attention_options(model, enable_sage_attention, enable_flash_attention)
        return (model,)

    @staticmethod
    def _apply_attention_options(model, enable_sage_attention: bool, enable_flash_attention: bool) -> None:
        setattr(model, "guli_enable_sage_attention", bool(enable_sage_attention))
        setattr(model, "guli_enable_flash_attention", bool(enable_flash_attention))


class GGGGUFModelLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                GGUF_MODEL_FILE: (_list_gguf_files(), {"tooltip": "\u4ec5\u52a0\u8f7d GGUF UNET \u6a21\u578b\u6587\u4ef6"}),
                DEQUANT_DTYPE_NAME: (GGUF_DTYPE_OPTIONS, {"default": "default"}),
                PATCH_DTYPE_NAME: (GGUF_DTYPE_OPTIONS, {"default": "default"}),
                PATCH_ON_DEVICE_NAME: ("BOOLEAN", {"default": False}),
                SAGE_ATTENTION_NAME: ("BOOLEAN", {"default": True}),
                FLASH_ATTENTION_NAME: ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = (MODEL_OUTPUT,)
    FUNCTION = "load"
    CATEGORY = CATEGORY

    def load(self, **kwargs) -> tuple:
        model_file = kwargs.get(GGUF_MODEL_FILE)
        if not model_file or model_file.startswith("\uff08"):
            raise RuntimeError("\u672a\u627e\u5230\u53ef\u7528GGUF\u6a21\u578b\u6587\u4ef6\u3002\u8bf7\u628a .gguf \u6587\u4ef6\u653e\u5230 ComfyUI/models/unet/ \u6216 ComfyUI/models/diffusion_models/ \u540e\u91cd\u542f\u3002")
        if not model_file.lower().endswith(".gguf"):
            raise RuntimeError("GG GGUF\u6a21\u578b\u8282\u70b9\u53ea\u652f\u6301 .gguf \u6587\u4ef6\u3002")

        loader_class = _get_gguf_loader_class()
        if loader_class is None:
            raise RuntimeError("\u672a\u68c0\u6d4b\u5230 ComfyUI-GGUF \u63d2\u4ef6\uff0c\u65e0\u6cd5\u52a0\u8f7d GGUF UNET\u3002\u8bf7\u5148\u5b89\u88c5\u6216\u542f\u7528 ComfyUI-GGUF\u3002")

        model_path = ""
        try:
            model_path = folder_paths.get_full_path("unet_gguf", model_file) or ""
        except Exception:
            model_path = ""

        if not model_path:
            fallback_paths = [
                os.path.join(folder_paths.models_dir, "unet", model_file),
                os.path.join(folder_paths.models_dir, "diffusion_models", model_file),
            ]
            model_path = next((path for path in fallback_paths if os.path.exists(path)), "")

        if not model_path:
            raise FileNotFoundError(f"\u6a21\u578b\u6587\u4ef6\u4e0d\u5b58\u5728: {model_file}")

        return loader_class().load_unet(
            model_file,
            kwargs.get(DEQUANT_DTYPE_NAME, "default"),
            kwargs.get(PATCH_DTYPE_NAME, "default"),
            kwargs.get(PATCH_ON_DEVICE_NAME, False),
        )


class GGMemoryCleanup:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                ANY_NAME: (ANY_INPUT,),
                CLEAR_CACHE_NAME: ("BOOLEAN", {"default": True}),
                CLEAR_MODELS_NAME: ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = (ANY_OUTPUT,)
    RETURN_NAMES = (ANY_NAME,)
    FUNCTION = "cleanup"
    CATEGORY = "GuliNodes/\u6a21\u578b\u52a0\u8f7d"

    def cleanup(self, **kwargs) -> tuple:
        value = kwargs.get(ANY_NAME)
        clear_cache = bool(kwargs.get(CLEAR_CACHE_NAME, True))
        clear_models = bool(kwargs.get(CLEAR_MODELS_NAME, True))

        if clear_models:
            try:
                mm.unload_all_models()
            except Exception as exc:
                print(f"GG \u5185\u5b58\u6e05\u7406: \u5378\u8f7d\u6a21\u578b\u5931\u8d25: {exc}")
            try:
                mm.cleanup_models()
            except Exception as exc:
                print(f"GG \u5185\u5b58\u6e05\u7406: \u6e05\u7406\u6a21\u578b\u5f15\u7528\u5931\u8d25: {exc}")

        gc.collect()

        if clear_cache:
            try:
                mm.soft_empty_cache(force=True)
            except Exception as exc:
                print(f"GG \u5185\u5b58\u6e05\u7406: \u6e05\u7406\u7f13\u5b58\u5931\u8d25: {exc}")
            if torch.cuda.is_available():
                try:
                    torch.cuda.synchronize()
                    torch.cuda.empty_cache()
                    torch.cuda.ipc_collect()
                except Exception as exc:
                    print(f"GG \u5185\u5b58\u6e05\u7406: CUDA \u7f13\u5b58\u6e05\u7406\u5931\u8d25: {exc}")

        return (value,)


NODE_CLASS_MAPPINGS = {
    UNET_NODE_ID: GGUNETLoader,
    GGUF_NODE_ID: GGGGUFModelLoader,
    MEMORY_CLEANUP_NODE_ID: GGMemoryCleanup,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    UNET_NODE_ID: UNET_DISPLAY_NAME,
    GGUF_NODE_ID: GGUF_DISPLAY_NAME,
    MEMORY_CLEANUP_NODE_ID: MEMORY_CLEANUP_DISPLAY_NAME,
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
