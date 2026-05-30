from collections import OrderedDict
import hashlib
import os
import threading

import comfy.sd
import folder_paths
import torch


EMPTY_CLIP_MESSAGE = "（请把CLIP模型放到 models/text_encoders）"
CLIP_CACHE_LIMIT = 3
CLIP_TEXT_NODE_ID = "GGCLIPText"
CLIP_TEXT_DISPLAY_NAME = "GG CLIP文本"
CLIP_TYPE_FALLBACKS = [
    "stable_diffusion",
    "stable_cascade",
    "sd3",
    "stable_audio",
    "mochi",
    "ltxv",
    "pixart",
    "cosmos",
    "lumina2",
    "wan",
    "hidream",
    "chroma",
    "ace",
    "omnigen2",
    "qwen_image",
    "hunyuan_image",
    "flux2",
    "ovis",
    "longcat_image",
    "cogvideox",
    "lens",
    "pixeldit",
]


def _list_clip_files() -> list[str]:
    try:
        files = folder_paths.get_filename_list("text_encoders")
    except Exception:
        files = []
    return files or [EMPTY_CLIP_MESSAGE]


def _native_clip_loader_inputs() -> dict:
    try:
        from nodes import CLIPLoader

        return CLIPLoader.INPUT_TYPES()
    except Exception:
        return {}


def _list_clip_types() -> list[str]:
    native_inputs = _native_clip_loader_inputs()
    try:
        choices = native_inputs["required"]["type"][0]
        if choices:
            return list(choices)
    except Exception:
        pass
    return list(CLIP_TYPE_FALLBACKS)


def _resolve_clip_path(clip_name: str) -> str:
    try:
        return folder_paths.get_full_path_or_raise("text_encoders", clip_name)
    except Exception:
        try:
            return folder_paths.get_full_path("text_encoders", clip_name) or ""
        except Exception:
            return ""


def _file_fingerprint(path: str) -> str:
    if not path or not os.path.exists(path):
        return ""
    try:
        stat = os.stat(path)
    except OSError:
        return path
    return f"{path}:{stat.st_size}:{stat.st_mtime_ns}"


def _load_clip_with_native_loader(clip_name: str, clip_type: str, device: str = "default"):
    try:
        from nodes import CLIPLoader

        return CLIPLoader().load_clip(clip_name, clip_type, device)[0]
    except Exception:
        clip_type_value = getattr(comfy.sd.CLIPType, clip_type.upper(), comfy.sd.CLIPType.STABLE_DIFFUSION)
        model_options = {}
        if device == "cpu":
            model_options["load_device"] = model_options["offload_device"] = torch.device("cpu")

        clip_path = folder_paths.get_full_path_or_raise("text_encoders", clip_name)
        return comfy.sd.load_clip(
            ckpt_paths=[clip_path],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=clip_type_value,
            model_options=model_options,
        )


class GGTextDisplayCopy:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文本": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            },
            "optional": {
                "文本输入": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本",)
    FUNCTION = "display"
    CATEGORY = "GuliNodes/文本"
    DESCRIPTION = "\u53ef\u76f4\u63a5\u6267\u884c\u7684\u6587\u672c\u5c55\u793a\u8282\u70b9\uff0c\u5e76\u63d0\u4f9b\u5feb\u901f\u590d\u5236\u5230\u526a\u8d34\u677f\u7684\u6309\u94ae"
    OUTPUT_NODE = True

    def display(self, 文本: str = "", 文本输入: str | None = None) -> dict:
        display_text = 文本 if 文本输入 is None else str(文本输入)
        return {"ui": {"文本": [display_text]}, "result": (display_text,)}


class GGCLIPTextEncode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "CLIP模型": ("CLIP", {"tooltip": "用于编码文本提示词的 CLIP 模型。"}),
                "文本": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True, "tooltip": "需要编码为条件的文本提示词。"}),
            }
        }

    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("条件",)
    FUNCTION = "encode"
    CATEGORY = "GuliNodes/文本"
    DESCRIPTION = "带读取剪贴板按钮的 CLIP 文本编码器。"

    def encode(self, CLIP模型, 文本: str = "") -> tuple:
        if CLIP模型 is None:
            raise RuntimeError("CLIP 输入无效：未检测到 CLIP 模型。")
        tokens = CLIP模型.tokenize(文本 or "")
        return (CLIP模型.encode_from_tokens_scheduled(tokens),)

    @classmethod
    def IS_CHANGED(cls, CLIP模型, 文本: str = ""):
        import hashlib
        m = hashlib.sha256()
        m.update(文本.encode("utf-8"))
        clip_id = id(CLIP模型) if CLIP模型 is not None else 0
        m.update(str(clip_id).encode("utf-8"))
        return m.hexdigest()


class GGCLIPText:
    _clip_cache = OrderedDict()
    _cache_lock = threading.RLock()

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "CLIP名称": (_list_clip_files(), {"tooltip": "选择要加载并用于文本编码的 CLIP 模型。"}),
                "类型": (_list_clip_types(), {"default": "stable_diffusion", "tooltip": "与原生加载CLIP节点一致的模型类型。"}),
                "文本": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True, "tooltip": "需要编码为条件的提示词文本。"}),
            },
        }

    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("条件",)
    FUNCTION = "encode"
    CATEGORY = "GuliNodes/文本"
    DESCRIPTION = "融合加载CLIP与文本编码的一体节点，模型按文件和类型缓存，修改文本时不重复加载 CLIP。"

    @classmethod
    def _cache_key(cls, clip_name: str, clip_type: str) -> tuple[str, str, str]:
        clip_path = _resolve_clip_path(clip_name)
        return (clip_name, clip_type, _file_fingerprint(clip_path))

    @classmethod
    def _get_clip(cls, clip_name: str, clip_type: str):
        if not clip_name or clip_name == EMPTY_CLIP_MESSAGE:
            raise RuntimeError("未找到可用的 CLIP 模型。请把模型放到 ComfyUI/models/text_encoders/ 后重启。")

        key = cls._cache_key(clip_name, clip_type)
        with cls._cache_lock:
            cached_clip = cls._clip_cache.get(key)
            if cached_clip is not None:
                cls._clip_cache.move_to_end(key)
                return cached_clip

        clip = _load_clip_with_native_loader(clip_name, clip_type)

        with cls._cache_lock:
            cls._clip_cache[key] = clip
            cls._clip_cache.move_to_end(key)
            while len(cls._clip_cache) > CLIP_CACHE_LIMIT:
                cls._clip_cache.popitem(last=False)
        return clip

    def encode(self, **kwargs) -> tuple:
        clip_name = kwargs.get("CLIP名称", "")
        clip_type = kwargs.get("类型", "stable_diffusion")
        text = kwargs.get("文本", "") or ""

        clip = self._get_clip(clip_name, clip_type)
        tokens = clip.tokenize(text)
        return (clip.encode_from_tokens_scheduled(tokens),)

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        clip_name = kwargs.get("CLIP名称", "")
        clip_type = kwargs.get("类型", "stable_diffusion")
        text = kwargs.get("文本", "") or ""
        m = hashlib.sha256()
        m.update(str(clip_name).encode("utf-8"))
        m.update(str(clip_type).encode("utf-8"))
        m.update(text.encode("utf-8"))
        m.update(_file_fingerprint(_resolve_clip_path(clip_name)).encode("utf-8"))
        return m.hexdigest()


NODE_CLASS_MAPPINGS = {
    "GGTextDisplayCopy": GGTextDisplayCopy,
    "GGCLIPTextEncode": GGCLIPTextEncode,
    CLIP_TEXT_NODE_ID: GGCLIPText,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGTextDisplayCopy": "GG \u6587\u672c",
    "GGCLIPTextEncode": "GG CLIP文本编码器",
    CLIP_TEXT_NODE_ID: CLIP_TEXT_DISPLAY_NAME,
}
