"""GG 提示词增强qwen2.1：按 Qwen Image 2.1 官方规则增强文生图/图生图提示词。

三种增强方式：
- API：OpenAI 兼容 Responses 接口。
- 本地PE：ComfyUI 文本编码器栈加载官方 PE safetensors（QWEN_IMAGE）。
- 本地LLM：llama-cpp-python 加载 GGUF 主模型（图生图配 mmproj 视觉投影）。

API 与本地PE 的逻辑及官方提示词模板整段移植自 TE MAN / QQ 的同类节点，
详见 README「致谢与借鉴说明」。
"""

from __future__ import annotations

import base64
import io as _io
import json
import re
from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np
import torch
from PIL import Image

import folder_paths

from .qwen_pe_prompts import (
    API_MODE_LINE,
    FINAL_LANGUAGE_RULE_EN,
    FINAL_LANGUAGE_RULE_ZH,
    LOCAL_MODE_LINE,
    PE_LANGUAGE_RULE_EN,
    PE_LANGUAGE_RULE_ZH,
    QWEN_EDIT_SYSTEM_PROMPT,
    QWEN_OFFICIAL_PE_POLICY,
    QWEN_OUTPUT_POLICY,
    QWEN_T2I_SYSTEM_PROMPT,
)

try:
    from comfy_api.latest import io
except Exception:
    io = None


NODE_ID = "GGPromptEnhancer"
DISPLAY_NAME = "GG 提示词增强qwen2.1"
CATEGORY = "GuliNodes/文本"

IMAGE_PREFIX = "图片"
MAX_IMAGES = 20

MODE_T2I = "文生图"
MODE_I2I = "图生图"
METHOD_API = "API"
METHOD_PE = "本地PE"
METHOD_LLM = "本地LLM"

DEFAULT_API_BASE_URL = "https://api.deepseek.com"
DEFAULT_API_MODEL = "deepseek-flash"
DEFAULT_MAX_OUTPUT_TOKENS = 4096
DEFAULT_CONTEXT_LENGTH = 8192
API_TIMEOUT = 600
API_TEMPERATURE = 0.6
PE_FOLDER = "text_encoders"
PE_TEMPERATURE = 0.7
PE_TOP_K = 20
PE_TOP_P = 0.95
PE_REPETITION_PENALTY = 1.05
LLM_TEMPERATURE = 0.7
JPEG_QUALITY = 90
DEFAULT_IMAGE_MAX_EDGE = 2048
DEFAULT_IMAGE_MAX_PIXELS = 1_048_576
MAX_SEED = 0xFFFFFFFFFFFFFFFF
LLM_FOLDERS = ("text_encoders", "clip", "LLM", "llm")

MISSING_PE = "（把官方 PE 的 safetensors 放到 models/text_encoders）"
MISSING_GGUF = "（把 GGUF 模型放到 models/text_encoders 或 models/LLM）"
NO_MMPROJ = "无"
_USER_REQUEST_PREFIX = "用户需求：\n"
_EMPTY_REPLY_MESSAGE = "模型返回为空，可能只生成了思考内容但没有最终提示词。请提高最大生成token后重试。"
_VERSIONLESS_API_HOSTS = frozenset({"api.deepseek.com"})

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_CODE_FENCE_RE = re.compile(r"```(?:json|text|markdown)?\s*([\s\S]*?)\s*```")
_THINK_PAIR_RE = re.compile(r"<think>[\s\S]*?</think>\s*", re.I)
_THINK_ORPHAN_RE = re.compile(r"^[\s\S]*?</think>\s*")
_THINK_ZH_RE = re.compile(r"<思考>[\s\S]*?</思考>\s*")
_THOUGHT_FENCE_RE = re.compile(r"```thought\b[\s\S]*?```")
_T2I_LANGUAGE_TAIL_RE = re.compile(r"\n\n## Language\n[\s\S]*\Z")
_EDIT_OUTPUT_TAIL_RE = re.compile(r"\n\n## Output [Ff]ormat\n[\s\S]*\Z")
_EDIT_LANGUAGE_BLOCK_RE = re.compile(
    r"\n\*\*FIRST — there are TWO separate language decisions\.[\s\S]*?"
    r"(?=\n\nYou are an expert at clarifying image editing instructions\.)"
)


def _default_option(options: list[str], preferred: str) -> str:
    if preferred in options:
        return preferred
    return options[0] if options else ""


def _coerce_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("content", "text", "output", "output_text", "response"):
            if key in value:
                text = _coerce_text(value[key])
                if text:
                    return text
        return ""
    if isinstance(value, (list, tuple)):
        for item in value:
            text = _coerce_text(item)
            if text:
                return text
        return ""
    return str(value)


def _normalize_seed(seed: Any) -> "int | None":
    try:
        value = int(seed)
    except (TypeError, ValueError):
        return None
    return None if value < 0 else value

# ------------------------- 提示词模板 ------------------------- #


def _remove_conflicting_language_rules(text: str) -> str:
    text = text.replace("one long English paragraph", "one long paragraph")
    text = _EDIT_LANGUAGE_BLOCK_RE.sub("", text)
    text = _T2I_LANGUAGE_TAIL_RE.sub("", text)
    text = _EDIT_OUTPUT_TAIL_RE.sub("", text)
    return text


def _clean_base_prompt(mode: str) -> str:
    base = QWEN_T2I_SYSTEM_PROMPT if mode == MODE_T2I else QWEN_EDIT_SYSTEM_PROMPT
    return _remove_conflicting_language_rules(base)


def _node_output_tail(language: str, *, api_mode: bool) -> str:
    rule = FINAL_LANGUAGE_RULE_ZH if language == "中文" else FINAL_LANGUAGE_RULE_EN
    line = API_MODE_LINE if api_mode else LOCAL_MODE_LINE
    return "\n\n" + QWEN_OUTPUT_POLICY + "\n" + rule + "\n" + line


def _build_api_instructions(mode: str, language: str) -> str:
    return _clean_base_prompt(mode) + _node_output_tail(language, api_mode=True)


def _build_llm_system(mode: str, language: str) -> str:
    return _clean_base_prompt(mode) + _node_output_tail(language, api_mode=False)


def _build_official_pe_system(mode: str, language: str) -> str:
    rule = PE_LANGUAGE_RULE_ZH if language == "中文" else PE_LANGUAGE_RULE_EN
    return _clean_base_prompt(mode) + "\n\n" + QWEN_OFFICIAL_PE_POLICY + "\n" + rule


def _build_official_pe_text(system: str, user_request: str, *, has_images: bool) -> str:
    text = "<start_of_turn>system\n" + system + "<end_of_turn>\n<start_of_turn>user\n"
    if has_images:
        text += "\n<image_soft_token>\n\n"
    return text + "User Raw Input Prompt: " + user_request + ".<end_of_turn>\n<start_of_turn>model\n"


# ------------------------- 结果解析 ------------------------- #


def _clean_think_blocks(text: str) -> str:
    cleaned = _THINK_PAIR_RE.sub("", text or "")
    cleaned = _THINK_ZH_RE.sub("", cleaned)
    cleaned = _THINK_ORPHAN_RE.sub("", cleaned)
    cleaned = _THOUGHT_FENCE_RE.sub("", cleaned)
    return cleaned.strip()


def _strip_code_fence(text: str) -> str:
    cleaned = (text or "").strip()
    match = _CODE_FENCE_RE.fullmatch(cleaned)
    return match.group(1).strip() if match else cleaned


def _repair_mojibake(text: str) -> str:
    if not text or _CJK_RE.search(text):
        return text
    try:
        repaired = text.encode("latin-1").decode("utf-8")
    except (UnicodeDecodeError, UnicodeEncodeError):
        return text
    if repaired == text or len(_CJK_RE.findall(repaired)) < 2:
        return text
    return repaired


def _parse_result(text: str) -> str:
    cleaned = _repair_mojibake(_strip_code_fence(text))
    if not cleaned.strip():
        raise ValueError(_EMPTY_REPLY_MESSAGE)
    data: Any = None
    try:
        data = json.loads(cleaned)
    except (TypeError, ValueError):
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if 0 <= start < end:
            try:
                data = json.loads(cleaned[start : end + 1])
            except (TypeError, ValueError):
                data = None
    if isinstance(data, dict):
        value = data.get("rewritten_prompt")
        if value is not None and str(value).strip():
            return str(value).strip()
    return cleaned

# ------------------------- 参考图 ------------------------- #


def _image_index(name: str) -> int:
    match = re.search(r"(\d+)$", str(name))
    return int(match.group(1)) if match else 0


def _append_frames(value: Any, sink: list) -> None:
    if value is None:
        return
    if isinstance(value, torch.Tensor):
        tensor = value.detach()
        if tensor.ndim == 3:
            tensor = tensor.unsqueeze(0)
        if tensor.ndim != 4:
            raise ValueError("参考图张量维度不正确（需要 HWC 或 BHWC）")
        for index in range(tensor.shape[0]):
            sink.append(tensor[index : index + 1])
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            _append_frames(item, sink)
        return
    raise ValueError("参考图只接受 IMAGE 张量")


def _collect_frames(images: Any) -> list:
    """Autogrow 传入 {图片1: tensor, ...}；按序号展开成单帧张量列表。"""
    frames: list = []
    if isinstance(images, dict):
        for _, value in sorted(images.items(), key=lambda item: _image_index(item[0])):
            _append_frames(value, frames)
    else:
        _append_frames(images, frames)
    if len(frames) > MAX_IMAGES:
        raise ValueError(f"最多支持 {MAX_IMAGES} 张参考图，当前 {len(frames)} 张")
    return frames


def _tensor_to_pil(tensor: torch.Tensor) -> Image.Image:
    array = tensor.detach().to(device="cpu", dtype=torch.float32).clamp(0.0, 1.0)
    array = array.mul(255.0).to(torch.uint8).numpy()
    if array.shape[-1] == 4:
        return Image.fromarray(array, mode="RGBA")
    if array.shape[-1] == 1:
        return Image.fromarray(array[:, :, 0], mode="L")
    return Image.fromarray(array[:, :, :3], mode="RGB")


def _image_to_jpeg_base64(tensor: torch.Tensor) -> str:
    frame = tensor[0] if tensor.ndim == 4 else tensor
    image = _tensor_to_pil(frame)
    longest = max(image.size)
    if DEFAULT_IMAGE_MAX_EDGE and longest > DEFAULT_IMAGE_MAX_EDGE:
        scale = DEFAULT_IMAGE_MAX_EDGE / float(longest)
        size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        image = image.resize(size, Image.BICUBIC)
    buffer = _io.BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=JPEG_QUALITY, progressive=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _images_to_jpeg_base64(frames: Sequence[torch.Tensor]) -> list:
    return [_image_to_jpeg_base64(item) for item in frames]


def _resize_image_tensor_max_pixels(tensor: torch.Tensor) -> torch.Tensor:
    height, width = int(tensor.shape[1]), int(tensor.shape[2])
    if height <= 0 or width <= 0 or height * width <= DEFAULT_IMAGE_MAX_PIXELS:
        return tensor
    scale = (float(DEFAULT_IMAGE_MAX_PIXELS) / float(height * width)) ** 0.5
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    image = _tensor_to_pil(tensor[0]).resize(size, Image.LANCZOS)
    array = np.asarray(image, dtype=np.float32) / 255.0
    if array.ndim == 2:
        array = array[:, :, None]
    return torch.from_numpy(array).unsqueeze(0).to(dtype=tensor.dtype, device=tensor.device)


def _pe_reference_images(frames: Sequence[torch.Tensor]) -> list:
    return [_resize_image_tensor_max_pixels(item) for item in frames]

# ------------------------- API 通路 ------------------------- #


def _resolve_api_url(api_base_url: str) -> str:
    base = str(api_base_url or "").strip().rstrip("/")
    if not base:
        raise ValueError("请填写 API 调用地址（api_base_url）")
    if base.endswith("/responses") or base.endswith("/chat/completions"):
        return base
    if base.endswith("/v1"):
        return base + "/responses"
    host = re.sub(r"^https?://", "", base, flags=re.I).split("/", 1)[0].lower()
    if host in _VERSIONLESS_API_HOSTS:
        return base + "/responses"
    return base + "/v1/responses"


def _build_api_input(user_prompt: str, image_base64_list: Sequence[str]) -> Any:
    images = list(image_base64_list or [])
    if not images:
        return user_prompt
    content: list = [{"type": "input_text", "text": user_prompt}]
    content.extend(
        {"type": "input_image", "image_url": "data:image/jpeg;base64," + item} for item in images
    )
    return [{"role": "user", "content": content}]


def _extract_response_text(data: dict) -> str:
    def read_content(content: Any) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, (list, tuple)):
            return "".join(str(part.get("text") or "") for part in content if isinstance(part, dict))
        return ""

    for item in data.get("output") or []:
        if isinstance(item, dict):
            text = read_content(item.get("content"))
            if text:
                return text
    output_text = data.get("output_text")
    if isinstance(output_text, str) and output_text:
        return output_text
    for choice in data.get("choices") or []:
        if isinstance(choice, dict):
            message = choice.get("message")
            text = read_content(message.get("content") if isinstance(message, dict) else None)
            if text:
                return text
    return ""


def _request_api(*, api_base_url, api_key, model, instructions, user_prompt, image_base64_list) -> str:
    import requests

    if not str(api_key or "").strip():
        raise ValueError("API 方式需要填写 API Key")
    if not str(model or "").strip():
        raise ValueError("API 方式需要填写模型名（model）")
    payload = {
        "model": model,
        "instructions": instructions,
        "input": _build_api_input(user_prompt, image_base64_list),
        "temperature": API_TEMPERATURE,
    }
    response = requests.post(
        _resolve_api_url(api_base_url),
        json=payload,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        timeout=API_TIMEOUT,
    )
    if response.status_code != 200:
        raise RuntimeError(f"API 调用失败 HTTP {response.status_code}: {response.text}")
    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError(f"API 返回不是合法 JSON：{response.text[:500]}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("API 返回结构不正确，需要一个 JSON 对象")
    return _extract_response_text(data)

# ------------------------- 本地官方 PE ------------------------- #


def _pe_model_choices() -> list:
    try:
        names = folder_paths.get_filename_list(PE_FOLDER)
    except Exception:
        names = []
    found = sorted({str(n) for n in names if str(n).lower().endswith(".safetensors")})
    return found or [MISSING_PE]


@dataclass
class _OfficialPEModel:
    clip: Any
    model_name: str


class _OfficialPEStorage:
    model = None

    @classmethod
    def load(cls, model_name: str):
        if cls.model is not None and cls.model.model_name == model_name:
            return cls.model
        cls.unload()
        import comfy.sd

        if not hasattr(comfy.sd.CLIPType, "QWEN_IMAGE"):
            raise RuntimeError("当前 ComfyUI 版本不支持 Qwen Image 2.1 文本编码器，请更新 ComfyUI")
        clip = comfy.sd.load_clip(
            ckpt_paths=[folder_paths.get_full_path_or_raise(PE_FOLDER, model_name)],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=comfy.sd.CLIPType.QWEN_IMAGE,
        )
        cls.model = _OfficialPEModel(clip=clip, model_name=model_name)
        return cls.model

    @classmethod
    def unload(cls) -> None:
        model, cls.model = cls.model, None
        if model is None:
            return
        try:
            import comfy.model_management as mm

            patcher = getattr(model.clip, "patcher", None)
            if patcher is not None:
                mm.unload_model_and_clones(patcher)
            mm.soft_empty_cache(force=True)
        except Exception:
            pass


def _request_official_pe(*, model_name, system_prompt, user_prompt, max_output_tokens, seed, images) -> str:
    clip = _OfficialPEStorage.load(model_name).clip
    text = _build_official_pe_text(system_prompt, user_prompt, has_images=bool(images))
    tokens = clip.tokenize(text, images=list(images), thinking=False)
    generated = clip.generate(
        tokens,
        do_sample=True,
        max_length=int(max_output_tokens),
        temperature=PE_TEMPERATURE,
        top_k=PE_TOP_K,
        top_p=PE_TOP_P,
        min_p=0.0,
        repetition_penalty=PE_REPETITION_PENALTY,
        seed=_normalize_seed(seed),
        presence_penalty=0.0,
    )
    return _coerce_text(clip.decode(generated))

# ------------------------- 本地 LLM（llama-cpp-python） ------------------------- #


def _gguf_choices(*, allow_none: bool) -> list:
    names: set = set()
    for folder in LLM_FOLDERS:
        try:
            for name in folder_paths.get_filename_list(folder):
                if str(name).lower().endswith(".gguf"):
                    names.add(str(name))
        except Exception:
            continue
    found = sorted(names)
    if allow_none:
        return [NO_MMPROJ] + found
    return found or [MISSING_GGUF]


def _resolve_gguf_path(model_name: str) -> str:
    for folder in LLM_FOLDERS:
        try:
            path = folder_paths.get_full_path(folder, model_name)
        except Exception:
            path = None
        if path:
            return path
    raise ValueError(f"找不到 GGUF 模型文件：{model_name}")


class _LocalLLMStorage:
    llm = None
    key = None

    @classmethod
    def load(cls, model_name: str, mmproj_name: str, context_length: int):
        mmproj = "" if not mmproj_name or mmproj_name == NO_MMPROJ else mmproj_name
        key = (model_name, mmproj, int(context_length))
        if cls.llm is not None and cls.key == key:
            return cls.llm
        cls.unload()
        try:
            from llama_cpp import Llama
        except Exception as exc:
            raise RuntimeError(
                "本地LLM 方式需要 llama-cpp-python，请先安装（pip install llama-cpp-python），"
                "或改用 API / 本地PE 方式。"
            ) from exc

        chat_handler = None
        if mmproj:
            handler_cls = None
            try:
                from llama_cpp.llama_chat_format import Qwen25VLChatHandler as handler_cls  # type: ignore
            except Exception:
                try:
                    from llama_cpp.llama_chat_format import Qwen2VLChatHandler as handler_cls  # type: ignore
                except Exception:
                    handler_cls = None
            if handler_cls is None:
                raise RuntimeError("当前 llama-cpp-python 不支持 Qwen VL 视觉，请升级后再用图生图本地LLM")
            chat_handler = handler_cls(clip_model_path=_resolve_gguf_path(mmproj), verbose=False)

        llm = Llama(
            model_path=_resolve_gguf_path(model_name),
            n_ctx=max(512, int(context_length)),
            n_gpu_layers=-1,
            chat_handler=chat_handler,
            verbose=False,
        )
        cls.llm = llm
        cls.key = key
        return llm

    @classmethod
    def unload(cls) -> None:
        llm, cls.llm, cls.key = cls.llm, None, None
        if llm is None:
            return
        try:
            close = getattr(llm, "close", None)
            if callable(close):
                close()
        except Exception:
            pass


def _request_local_llm(*, model_name, mmproj_name, context_length, system_prompt, user_prompt, max_output_tokens, image_base64_list) -> str:
    llm = _LocalLLMStorage.load(model_name, mmproj_name, context_length)
    user_content: Any = user_prompt
    images = list(image_base64_list or [])
    if images:
        user_content = [{"type": "text", "text": user_prompt}]
        user_content.extend(
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + item}}
            for item in images
        )
    result = llm.create_chat_completion(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        max_tokens=int(max_output_tokens),
        temperature=LLM_TEMPERATURE,
    )
    choices = result.get("choices") if isinstance(result, dict) else None
    if choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        return _coerce_text(message.get("content") if isinstance(message, dict) else None)
    return ""

# ------------------------- 核心分派 ------------------------- #


def _enhance(
    *,
    prompt,
    task_mode,
    language,
    method,
    api_key,
    api_base_url,
    model,
    pe_t2i_model,
    pe_i2i_model,
    llm_model,
    mmproj_model,
    context_length,
    max_output_tokens,
    seed,
    auto_unload,
    images,
) -> str:
    prompt = str(prompt or "")
    if not prompt.strip():
        return ""
    task_mode = task_mode if task_mode in (MODE_T2I, MODE_I2I) else MODE_T2I
    method = method if method in (METHOD_API, METHOD_PE, METHOD_LLM) else METHOD_API
    frames = _collect_frames(images)
    if task_mode == MODE_I2I and not frames:
        raise ValueError("图生图模式需要连接参考图输入。")
    edit_images = frames if task_mode == MODE_I2I else []
    user_prompt = _USER_REQUEST_PREFIX + prompt

    try:
        if method == METHOD_API:
            raw = _request_api(
                api_base_url=api_base_url or DEFAULT_API_BASE_URL,
                api_key=api_key,
                model=model,
                instructions=_build_api_instructions(task_mode, language),
                user_prompt=user_prompt,
                image_base64_list=_images_to_jpeg_base64(edit_images),
            )
        elif method == METHOD_PE:
            model_name = pe_i2i_model if task_mode == MODE_I2I else pe_t2i_model
            if not model_name or str(model_name).startswith("（"):
                raise ValueError("请选择本地PE模型，或把 safetensors 放入 models/text_encoders")
            raw = _request_official_pe(
                model_name=model_name,
                system_prompt=_build_official_pe_system(task_mode, language),
                user_prompt=user_prompt,
                max_output_tokens=max_output_tokens,
                seed=seed,
                images=_pe_reference_images(edit_images),
            )
            if auto_unload:
                _OfficialPEStorage.unload()
        else:
            if not llm_model or str(llm_model).startswith("（"):
                raise ValueError("请选择本地LLM 的 GGUF 主模型，或把模型放入 models/text_encoders")
            raw = _request_local_llm(
                model_name=llm_model,
                mmproj_name=mmproj_model,
                context_length=context_length,
                system_prompt=_build_llm_system(task_mode, language),
                user_prompt=user_prompt,
                max_output_tokens=max_output_tokens,
                image_base64_list=_images_to_jpeg_base64(edit_images),
            )
            if auto_unload:
                _LocalLLMStorage.unload()
        return _parse_result(_clean_think_blocks(raw))
    except (ValueError, RuntimeError):
        raise
    except Exception as exc:
        raise RuntimeError(f"GG 提示词增强失败：{exc}") from exc

# ------------------------- 节点 ------------------------- #

P_PROMPT = "输入提示词"
P_TASK = "任务模式"
P_LANG = "输出语言"
P_METHOD = "增强方式"
P_KEY = "api_key"
P_URL = "api_base_url"
P_MODEL = "model"
P_PE_T2I = "文生图PE模型"
P_PE_I2I = "图生图PE模型"
P_LLM = "主模型"
P_MMPROJ = "mmproj"
P_CTX = "上下文长度"
P_MAXTOK = "最大生成token"
P_SEED = "seed"
P_UNLOAD = "生成后自动卸载模型"


def _run(kwargs: dict) -> str:
    images = kwargs.get(IMAGE_PREFIX)
    if not isinstance(images, dict):
        images = {
            f"{IMAGE_PREFIX}{i}": kwargs.get(f"{IMAGE_PREFIX}{i}") for i in range(1, MAX_IMAGES + 1)
        }
    return _enhance(
        prompt=kwargs.get(P_PROMPT, ""),
        task_mode=kwargs.get(P_TASK, MODE_T2I),
        language=kwargs.get(P_LANG, "中文"),
        method=kwargs.get(P_METHOD, METHOD_API),
        api_key=kwargs.get(P_KEY, ""),
        api_base_url=kwargs.get(P_URL, ""),
        model=kwargs.get(P_MODEL, ""),
        pe_t2i_model=kwargs.get(P_PE_T2I, ""),
        pe_i2i_model=kwargs.get(P_PE_I2I, ""),
        llm_model=kwargs.get(P_LLM, ""),
        mmproj_model=kwargs.get(P_MMPROJ, NO_MMPROJ),
        context_length=kwargs.get(P_CTX, DEFAULT_CONTEXT_LENGTH),
        max_output_tokens=kwargs.get(P_MAXTOK, DEFAULT_MAX_OUTPUT_TOKENS),
        seed=kwargs.get(P_SEED, 0),
        auto_unload=bool(kwargs.get(P_UNLOAD, True)),
        images=images,
    )


_DESCRIPTION = (
    "按 Qwen Image 2.1 官方规则增强文生图/图生图提示词，输出一段增强提示词文本。"
    "增强方式支持 API / 本地PE / 本地LLM；图生图可接最多 20 张参考图。"
)

def _v3_inputs() -> list:
    pe = _pe_model_choices()
    gguf = _gguf_choices(allow_none=False)
    mmproj = _gguf_choices(allow_none=True)
    return [
        io.Combo.Input(P_TASK, options=[MODE_T2I, MODE_I2I], default=MODE_T2I, tooltip="文生图无需参考图；图生图需接入参考图。"),
        io.Combo.Input(P_LANG, options=["中文", "英文"], default="中文", tooltip="增强提示词的描述语言；用户要求显示在图中的文字保持原文。"),
        io.Combo.Input(P_METHOD, options=[METHOD_API, METHOD_PE, METHOD_LLM], default=METHOD_API, tooltip="API=OpenAI 兼容接口；本地PE=官方 PE 文本编码器；本地LLM=GGUF 大模型。"),
        io.String.Input(P_KEY, default="", tooltip="API Key，仅 API 方式生效。"),
        io.String.Input(P_URL, default=DEFAULT_API_BASE_URL, tooltip="API 调用地址，仅 API 方式生效。"),
        io.String.Input(P_MODEL, default=DEFAULT_API_MODEL, tooltip="API 模型名，仅 API 方式生效。"),
        io.Combo.Input(P_PE_T2I, options=pe, default=_default_option(pe, ""), tooltip="本地PE 文生图模型（safetensors）。"),
        io.Combo.Input(P_PE_I2I, options=pe, default=_default_option(pe, ""), tooltip="本地PE 图生图模型（需支持视觉输入）。"),
        io.Combo.Input(P_LLM, options=gguf, default=_default_option(gguf, ""), tooltip="本地LLM 的 GGUF 主模型。"),
        io.Combo.Input(P_MMPROJ, options=mmproj, default=NO_MMPROJ, tooltip="本地LLM 视觉投影 mmproj，图生图需要。"),
        io.Int.Input(P_CTX, default=DEFAULT_CONTEXT_LENGTH, min=512, max=131072, step=512, tooltip="本地LLM 上下文长度。"),
        io.Int.Input(P_MAXTOK, default=DEFAULT_MAX_OUTPUT_TOKENS, min=256, max=32768, step=256, tooltip="最大生成 token（本地PE / 本地LLM 生效）。"),
        io.Int.Input(P_SEED, default=0, min=0, max=MAX_SEED, tooltip="本地PE 随机种子；负数按随机处理。"),
        io.Boolean.Input(P_UNLOAD, default=True, tooltip="本地PE / 本地LLM 生成后自动卸载模型释放显存。"),
        io.String.Input(P_PROMPT, multiline=True, dynamic_prompts=True, placeholder="输入要增强的文生图/图生图需求"),
        io.Autogrow.Input(
            IMAGE_PREFIX,
            template=io.Autogrow.TemplateNames(
                io.Image.Input(IMAGE_PREFIX),
                names=[f"{IMAGE_PREFIX}{i}" for i in range(1, MAX_IMAGES + 1)],
                min=0,
            ),
            tooltip="图生图参考图，接入最后一个后自动增加，最多 20 个；文生图时前端会隐藏。",
        ),
    ]


def _legacy_required() -> dict:
    pe = _pe_model_choices()
    gguf = _gguf_choices(allow_none=False)
    mmproj = _gguf_choices(allow_none=True)
    return {
        P_TASK: ([MODE_T2I, MODE_I2I], {"default": MODE_T2I}),
        P_LANG: (["中文", "英文"], {"default": "中文"}),
        P_METHOD: ([METHOD_API, METHOD_PE, METHOD_LLM], {"default": METHOD_API}),
        P_KEY: ("STRING", {"default": ""}),
        P_URL: ("STRING", {"default": DEFAULT_API_BASE_URL}),
        P_MODEL: ("STRING", {"default": DEFAULT_API_MODEL}),
        P_PE_T2I: (pe, {"default": _default_option(pe, "")}),
        P_PE_I2I: (pe, {"default": _default_option(pe, "")}),
        P_LLM: (gguf, {"default": _default_option(gguf, "")}),
        P_MMPROJ: (mmproj, {"default": NO_MMPROJ}),
        P_CTX: ("INT", {"default": DEFAULT_CONTEXT_LENGTH, "min": 512, "max": 131072, "step": 512}),
        P_MAXTOK: ("INT", {"default": DEFAULT_MAX_OUTPUT_TOKENS, "min": 256, "max": 32768, "step": 256}),
        P_SEED: ("INT", {"default": 0, "min": 0, "max": MAX_SEED}),
        P_UNLOAD: ("BOOLEAN", {"default": True}),
        P_PROMPT: ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True, "placeholder": "输入要增强的文生图/图生图需求"}),
    }

if io is not None:

    class GGPromptEnhancer(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id=NODE_ID,
                display_name=DISPLAY_NAME,
                category=CATEGORY,
                description=_DESCRIPTION,
                search_aliases=["Prompt Enhancer", "Qwen Image 2.1", "提示词增强", "AI提示词增强"],
                inputs=_v3_inputs(),
                outputs=[io.String.Output(display_name="增强提示词")],
            )

        @classmethod
        def execute(cls, **kwargs):
            return io.NodeOutput(_run(kwargs))

else:

    class GGPromptEnhancer:
        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": _legacy_required(),
                "optional": {
                    f"{IMAGE_PREFIX}{i}": ("IMAGE", {"tooltip": "图生图参考图；连接最后一个后自动增加，最多 20 个。"})
                    for i in range(1, MAX_IMAGES + 1)
                },
            }

        RETURN_TYPES = ("STRING",)
        RETURN_NAMES = ("增强提示词",)
        FUNCTION = "enhance"
        CATEGORY = CATEGORY
        DESCRIPTION = _DESCRIPTION

        def enhance(self, **kwargs):
            return (_run(kwargs),)


NODE_CLASS_MAPPINGS = {
    NODE_ID: GGPromptEnhancer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: DISPLAY_NAME,
}

