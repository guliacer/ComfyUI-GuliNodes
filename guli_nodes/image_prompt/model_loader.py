# -*- coding: utf-8 -*-
import base64
import gc
import inspect
import io
import os
import re
from dataclasses import dataclass
from functools import wraps

import numpy as np
from PIL import Image

import folder_paths
import comfy.model_management as mm

try:
    from llama_cpp import Llama
except Exception:
    Llama = None

try:
    from llama_cpp import GGML_TYPE_Q8_0
except Exception:
    GGML_TYPE_Q8_0 = 8

try:
    from llama_cpp.llama_chat_format import Qwen3VLChatHandler
except Exception:
    Qwen3VLChatHandler = None

try:
    from llama_cpp.llama_chat_format import Qwen35ChatHandler
except Exception:
    Qwen35ChatHandler = None

try:
    from llama_cpp.llama_chat_format import Gemma4ChatHandler
except Exception:
    Gemma4ChatHandler = None


class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


any_type = AnyType("*")

# 定义模型类型
class QWENLLAMA(str):
    pass

class GEMMA4LLAMA(str):
    pass

默认图片提示词 = ""
默认图片系统提示词 = "描述这张图,300字左右."
默认文本系统提示词 = "描述这张图,300字左右."
默认KV缓存类型 = "默认(F16)"
Q8_0缓存类型 = "q8_0"
KV缓存类型选项 = [默认KV缓存类型, Q8_0缓存类型]


def _确保_llm目录已注册() -> None:
    folder_name = "LLM"
    llm_dir = os.path.join(folder_paths.models_dir, folder_name)

    supported_exts = set(getattr(folder_paths, "supported_pt_extensions", set()))
    llm_exts = supported_exts | {".gguf"}

    try:
        if folder_name not in folder_paths.folder_names_and_paths:
            folder_paths.folder_names_and_paths[folder_name] = ([llm_dir], llm_exts)
            return

        paths, exts = folder_paths.folder_names_and_paths[folder_name]
        if llm_dir not in paths:
            paths.append(llm_dir)

        if isinstance(exts, set):
            exts.update(llm_exts)
        else:
            folder_paths.folder_names_and_paths[folder_name] = (paths, set(exts) | llm_exts)
    except Exception:
        return


def _列出llm文件() -> list[str]:
    _确保_llm目录已注册()
    try:
        return folder_paths.get_filename_list("LLM")
    except Exception:
        return []


def _图片转base64(image_tensor) -> str:
    if image_tensor is None:
        return ""

    img = image_tensor[0].cpu().numpy()
    img = np.clip(img * 255.0, 0, 255).astype(np.uint8)
    pil = Image.fromarray(img)
    buf = io.BytesIO()
    pil.save(buf, format="JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _缩放图片到最大边(pil: Image.Image, 最大边长: int) -> Image.Image:
    if 最大边长 <= 0:
        return pil
    w, h = pil.size
    long_edge = max(w, h)
    if long_edge <= 最大边长:
        return pil
    scale = 最大边长 / float(long_edge)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    return pil.resize((new_w, new_h), resample=Image.BICUBIC)


def _批量图片索引转base64(image_tensor, index: int, 最大边长: int) -> str:
    if image_tensor is None:
        return ""
    if index < 0 or index >= int(image_tensor.shape[0]):
        return ""
    # 检查是否是PyTorch张量
    if hasattr(image_tensor[index], 'cpu'):
        img = image_tensor[index].cpu().numpy()
    else:
        # 已经是numpy数组
        img = image_tensor[index]
    img = np.clip(img * 255.0, 0, 255).astype(np.uint8)
    pil = Image.fromarray(img)
    pil = _缩放图片到最大边(pil, 最大边长)
    buf = io.BytesIO()
    pil.save(buf, format="JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _调用chat_completion(llm, *, messages, params: dict) -> dict:
    kwargs = dict(params or {})
    kwargs["messages"] = messages

    try:
        sig = inspect.signature(llm.create_chat_completion)
        has_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
    except Exception:
        sig = None
        has_var_kw = True

    if sig is not None and not has_var_kw:
        allowed = sig.parameters
        if "presence_penalty" in kwargs and "presence_penalty" not in allowed and "present_penalty" in allowed:
            kwargs["present_penalty"] = kwargs.pop("presence_penalty")
        if "present_penalty" in kwargs and "present_penalty" not in allowed and "presence_penalty" in allowed:
            kwargs["presence_penalty"] = kwargs.pop("present_penalty")
        kwargs = {k: v for k, v in kwargs.items() if k in allowed}

    return llm.create_chat_completion(**kwargs)


def _清洗think块文本(text: str) -> str:
    if not isinstance(text, str) or not text:
        return "" if text is None else str(text)

    cleaned = text
    cleaned = re.sub(r"<think\b[^>]*>.*?</think>", "", cleaned, flags=re.DOTALL | re.IGNORECASE)

    if re.search(r"</think>", cleaned, flags=re.IGNORECASE):
        cleaned = re.sub(r"^.*?</think>\s*", "", cleaned, count=1, flags=re.DOTALL | re.IGNORECASE)

    cleaned = cleaned.replace("<think>", "").replace("</think>", "")
    return cleaned


def _清洗gemma4输出文本(text: str, 保留think块: bool) -> str:
    if not isinstance(text, str) or not text:
        return "" if text is None else str(text)

    cleaned = text.replace("\r\n", "\n")

    if not 保留think块 and "<channel|>" in cleaned:
        cleaned = re.sub(r"^.*?<channel\|>\s*", "", cleaned, count=1, flags=re.DOTALL)

    if not 保留think块:
        cleaned = re.sub(r"<think\b[^>]*>.*?</think>", "", cleaned, flags=re.DOTALL | re.IGNORECASE)
        if re.search(r"</think>", cleaned, flags=re.IGNORECASE):
            cleaned = re.sub(r"^.*?</think>\s*", "", cleaned, count=1, flags=re.DOTALL | re.IGNORECASE)

    cleaned = re.sub(r"<\|channel\>\s*[\w-]*\s*\n?", "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.replace("<channel|>", "")
    cleaned = cleaned.replace("<|think|>", "")
    cleaned = cleaned.replace("<think>", "").replace("</think>", "")
    return cleaned.strip()


def _llama构造参数是否可用(param_name: str) -> bool | None:
    if Llama is None:
        return None

    try:
        sig = inspect.signature(Llama.__init__)
    except Exception:
        return None

    return param_name in sig.parameters


def _解析kv缓存类型(value: str | None) -> int | None:
    if not value or value == 默认KV缓存类型:
        return None
    if value == Q8_0缓存类型:
        return GGML_TYPE_Q8_0
    raise ValueError(f"未知 KV 缓存类型：{value}")


def _规范化随机种子(seed_value):
    try:
        seed_value = int(seed_value)
    except Exception:
        return None

    if seed_value < 0:
        return None
    return seed_value


def _重置llm推理状态(llm) -> None:
    try:
        ctx = getattr(llm, "_ctx", None)
        if ctx is not None and hasattr(ctx, "memory_clear"):
            ctx.memory_clear(True)
    except Exception:
        pass

    try:
        hybrid_cache_mgr = getattr(llm, "_hybrid_cache_mgr", None)
        if hybrid_cache_mgr is not None and hasattr(hybrid_cache_mgr, "clear"):
            hybrid_cache_mgr.clear()
    except Exception:
        pass

    try:
        batch = getattr(llm, "_batch", None)
        if batch is not None and hasattr(batch, "reset"):
            batch.reset()
    except Exception:
        pass

    try:
        input_ids = getattr(llm, "input_ids", None)
        if input_ids is not None and hasattr(input_ids, "fill"):
            input_ids.fill(0)
    except Exception:
        pass

    try:
        reset = getattr(llm, "reset", None)
        if callable(reset):
            reset()
        elif hasattr(llm, "n_tokens"):
            llm.n_tokens = 0
    except Exception:
        pass


@dataclass
class _QwenModel:
    llm: object
    settings: dict
    chat_handler: object | None = None


class _QwenStorage:
    model: _QwenModel | None = None

    @classmethod
    def unload(cls) -> None:
        try:
            if cls.model and getattr(cls.model.llm, "close", None):
                cls.model.llm.close()
        except Exception:
            pass
        cls.model = None
        gc.collect()
        mm.soft_empty_cache()

    @classmethod
    def load(cls, config: dict) -> _QwenModel:
        if Llama is None:
            raise RuntimeError("未检测到 llama-cpp-python（llama_cpp）。请先安装/更新该依赖。")

        if cls.model and cls.model.settings == config:
            return cls.model

        cls.unload()

        model_path = os.path.join(folder_paths.models_dir, "LLM", config["model"])
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"找不到模型文件：{model_path}")

        mmproj = config.get("mmproj", "无")
        mmproj_path = None
        if mmproj and mmproj != "无":
            mmproj_path = os.path.join(folder_paths.models_dir, "LLM", mmproj)
            if not os.path.exists(mmproj_path):
                raise FileNotFoundError(f"找不到 mmproj 文件：{mmproj_path}")

        family = config["family"]
        think = config["think"]
        cache_type_k = config.get("cache_type_k", 默认KV缓存类型)
        cache_type_v = config.get("cache_type_v", 默认KV缓存类型)

        chat_handler = None
        if mmproj_path:
            if family == "Qwen3-VL":
                if Qwen3VLChatHandler is None:
                    raise RuntimeError("当前 llama-cpp-python 不支持 Qwen3VLChatHandler，请更新 llama-cpp-python。")
                # Qwen3 的 thinking 参数名在不同版本可能不同，这里做兜底。
                try:
                    chat_handler = Qwen3VLChatHandler(clip_model_path=mmproj_path, force_reasoning=think, verbose=False)
                except Exception:
                    try:
                        chat_handler = Qwen3VLChatHandler(clip_model_path=mmproj_path, use_think_prompt=think, verbose=False)
                    except Exception:
                        chat_handler = Qwen3VLChatHandler(clip_model_path=mmproj_path, verbose=False)
            elif family == "Qwen3.5-VL":
                if Qwen35ChatHandler is None:
                    raise RuntimeError("当前 llama-cpp-python 不支持 Qwen35ChatHandler，请更新 llama-cpp-python。")
                try:
                    chat_handler = Qwen35ChatHandler(
                        clip_model_path=mmproj_path,
                        enable_thinking=think,
                        add_vision_id=True,
                        verbose=False,
                    )
                except TypeError:
                    # 兼容少数版本的参数名差异
                    chat_handler = Qwen35ChatHandler(clip_model_path=mmproj_path, enable_thinking=think, verbose=False)
            else:
                raise ValueError(f"未知模型系列：{family}")

        n_ctx = int(config.get("n_ctx", 8192))
        n_gpu_layers = int(config.get("n_gpu_layers", -1))

        llama_kwargs = {
            "model_path": model_path,
            "chat_handler": chat_handler,
            "n_ctx": n_ctx,
            "n_gpu_layers": n_gpu_layers,
            "verbose": False,
        }

        if _llama构造参数是否可用("ctx_checkpoints") is not False:
            llama_kwargs["ctx_checkpoints"] = 0

        type_k = _解析kv缓存类型(cache_type_k)
        type_v = _解析kv缓存类型(cache_type_v)
        wants_custom_kv_type = type_k is not None or type_v is not None
        supports_type_k = _llama构造参数是否可用("type_k")
        supports_type_v = _llama构造参数是否可用("type_v")

        if wants_custom_kv_type and (supports_type_k is False or supports_type_v is False):
            raise RuntimeError("当前 llama-cpp-python 不支持 type_k/type_v（KV cache 量化），请更新该依赖后再使用 q8_0。")

        if type_k is not None:
            llama_kwargs["type_k"] = type_k
        if type_v is not None:
            llama_kwargs["type_v"] = type_v

        llm = Llama(**llama_kwargs)

        cls.model = _QwenModel(llm=llm, settings=dict(config), chat_handler=chat_handler)
        return cls.model


class _Gemma4Storage:
    model: _QwenModel | None = None

    @classmethod
    def unload(cls) -> None:
        try:
            if cls.model and getattr(cls.model.llm, "close", None):
                cls.model.llm.close()
        except Exception:
            pass
        cls.model = None
        gc.collect()
        mm.soft_empty_cache()

    @classmethod
    def load(cls, config: dict) -> _QwenModel:
        if Llama is None:
            raise RuntimeError("未检测到 llama-cpp-python（llama_cpp）。请先安装/更新该依赖。")

        if Gemma4ChatHandler is None:
            raise RuntimeError("当前 llama-cpp-python 不支持 Gemma4ChatHandler，请先合入或安装带 Gemma4 支持的版本。")

        if cls.model and cls.model.settings == config:
            return cls.model

        cls.unload()

        model_path = os.path.join(folder_paths.models_dir, "LLM", config["model"])
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"找不到模型文件：{model_path}")

        mmproj = config.get("mmproj", "无")
        mmproj_path = None
        if mmproj and mmproj != "无":
            mmproj_path = os.path.join(folder_paths.models_dir, "LLM", mmproj)
            if not os.path.exists(mmproj_path):
                raise FileNotFoundError(f"找不到 mmproj 文件：{mmproj_path}")

        think = bool(config.get("think", False))
        cache_type_k = config.get("cache_type_k", 默认KV缓存类型)
        cache_type_v = config.get("cache_type_v", 默认KV缓存类型)

        chat_handler = None
        if mmproj_path:
            chat_handler = Gemma4ChatHandler(
                clip_model_path=mmproj_path,
                enable_thinking=think,
                verbose=False,
            )

        n_ctx = int(config.get("n_ctx", 8192))
        n_gpu_layers = int(config.get("n_gpu_layers", -1))

        llama_kwargs = {
            "model_path": model_path,
            "chat_handler": chat_handler,
            "n_ctx": n_ctx,
            "n_gpu_layers": n_gpu_layers,
            "verbose": False,
        }

        if _llama构造参数是否可用("ctx_checkpoints") is not False:
            llama_kwargs["ctx_checkpoints"] = 0

        type_k = _解析kv缓存类型(cache_type_k)
        type_v = _解析kv缓存类型(cache_type_v)
        wants_custom_kv_type = type_k is not None or type_v is not None
        supports_type_k = _llama构造参数是否可用("type_k")
        supports_type_v = _llama构造参数是否可用("type_v")

        if wants_custom_kv_type and (supports_type_k is False or supports_type_v is False):
            raise RuntimeError("当前 llama-cpp-python 不支持 type_k/type_v（KV cache 量化），请更新该依赖后再使用 q8_0。")

        if type_k is not None:
            llama_kwargs["type_k"] = type_k
        if type_v is not None:
            llama_kwargs["type_v"] = type_v

        llm = Llama(**llama_kwargs)

        cls.model = _QwenModel(llm=llm, settings=dict(config), chat_handler=chat_handler)
        return cls.model


def _安装全局卸载挂钩() -> None:
    """
    将 ComfyUI 全局卸载（comfy.model_management.unload_all_models）挂钩到本插件的卸载逻辑上。

    效果：
    - 点击 TEA/ComfyUI 的“释放显存/释放内存”（/free）触发全局卸载时，会同时 close 掉本插件的 llama_cpp 模型。
    """
    try:
        if hasattr(mm, "_qwen_te_unload_hook_installed") and mm._qwen_te_unload_hook_installed:
            return

        original = getattr(mm, "unload_all_models", None)
        if original is None or not callable(original):
            return

        @wraps(original)
        def wrapped_unload_all_models(*args, **kwargs):
            try:
                _QwenStorage.unload()
            except Exception:
                pass
            try:
                _Gemma4Storage.unload()
            except Exception:
                pass
            return original(*args, **kwargs)

        mm.unload_all_models = wrapped_unload_all_models
        mm._qwen_te_unload_hook_installed = True
    except Exception:
        # 不影响 ComfyUI 启动
        return


_安装全局卸载挂钩()


# 定义统一的模型类型
class GGLLAMA(str):
    pass

class GG模型加载器:
    @classmethod
    def INPUT_TYPES(s):
        all_files = _列出llm文件()
        model_list = [f for f in all_files if "mmproj" not in f.lower() and os.path.splitext(f)[1].lower() in [".gguf", ".safetensors", ".bin", ".pth", ".pt"]]
        mmproj_list = ["无"] + [f for f in all_files if "mmproj" in f.lower() and os.path.splitext(f)[1].lower() in [".gguf", ".safetensors", ".bin"]]

        if not model_list:
            model_list = ["（请把模型放到 models/LLM）"]

        return {
            "required": {
                "模型类型": (["Qwen3-VL", "Qwen3.5-VL", "Gemma4"], {"default": "Qwen3.5-VL"}),
                "主模型": (model_list, {"tooltip": "主模型文件（建议 .gguf）放到 ComfyUI/models/LLM/"}),
                "视觉投影mmproj": (mmproj_list, {"default": "无", "tooltip": "多模态需要 mmproj；纯文本可选\"无\"。"}),
                "启用思考": ("BOOLEAN", {"default": False, "tooltip": "启用模型的思考能力。"}),
                "上下文长度": ("INT", {"default": 8192, "min": 1024, "max": 327680, "step": 256, "tooltip": "对应 llama.cpp 的 n_ctx。"}),
                "GPU层数": ("INT", {"default": -1, "min": -1, "max": 9999, "step": 1, "tooltip": "对应 llama.cpp 的 n_gpu_layers；-1=尽可能多上GPU；0=纯CPU。"}),
                "KV缓存K类型": (KV缓存类型选项, {"default": 默认KV缓存类型, "tooltip": "对应 llama.cpp 的 --cache-type-k / type_k。推荐默认；q8_0-27B模型以上可能提速。"}),
                "KV缓存V类型": (KV缓存类型选项, {"default": 默认KV缓存类型, "tooltip": "对应 llama.cpp 的 --cache-type-v / type_v。推荐默认；q8_0-27B模型以上可能提速。"}),
            }
        }

    RETURN_TYPES = ("GGLLAMA",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "load"
    CATEGORY = "GuliNodes/图像分析"

    def load(self, 模型类型, 主模型, 视觉投影mmproj, 启用思考, 上下文长度, GPU层数, KV缓存K类型, KV缓存V类型):
        if 主模型.startswith("（请把模型放到"):
            raise RuntimeError("未找到可用模型文件。请把模型放到 ComfyUI/models/LLM/ 后重启。")

        config = {
            "family": 模型类型,
            "model": 主模型,
            "mmproj": 视觉投影mmproj,
            "think": bool(启用思考),
            "n_ctx": int(上下文长度),
            "n_gpu_layers": int(GPU层数),
            "cache_type_k": KV缓存K类型,
            "cache_type_v": KV缓存V类型,
        }
        
        if 模型类型 in ["Qwen3-VL", "Qwen3.5-VL"]:
            model = _QwenStorage.load(config)
        elif 模型类型 == "Gemma4":
            model = _Gemma4Storage.load(config)
        else:
            raise ValueError(f"未知模型类型：{模型类型}")
        
        return (model,)


