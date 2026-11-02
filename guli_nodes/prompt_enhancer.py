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
import math
import re
import time
from dataclasses import dataclass
from pathlib import Path
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
# 提示词增强的正常输出在 250~600 token；上限留到 1536 是为了偶发的长描述，
# 再高只会让跑偏的生成一路拖到几十秒（实测跑满 2048 token 要 70 秒）。
DEFAULT_MAX_OUTPUT_TOKENS = 1536
# 图生图的官方规则提示词本身就占约 4000 token（实测 prompt_tokens 4025），
# 加上 1024~1617 token/张 的参考图与 2048 输出，8192 明显不够；
# 16384 能装下「规则 + 6 张参考图 + 2048 输出」，KV 显存约 512 MiB（9B 每 8192 约 256 MiB）。
DEFAULT_CONTEXT_LENGTH = 16384
# 每张参考图的上下文预算。llama.cpp 对 Qwen-VL 有 image_min_tokens 下限（日志里的
# "Qwen-VL models require at minimum 1024 image tokens"），大图实际落在 1024~1617 token，
# 早前按 128 预留是 10 倍低估，直接把 n_ctx 算小、生成阶段抢不到 KV 槽位。
LLM_IMAGE_TOKEN_BUDGET = 2048
LLM_PROMPT_HEADROOM = 256
# 本地LLM 直接送图的张数上限；超过就拼成一张网格图（见 _llm_reference_images）。
# 每多一个图像 chunk 就多一份 M-RoPE 位置账本误差，2 张以上拼图更稳也更省上下文。
LLM_DIRECT_IMAGE_LIMIT = 2
# 自动抬高上下文的上限；用户手动设得更大时以用户值为准。
LLM_MAX_CONTEXT = 32768
# 上下文不足时自动放大重试的次数。估算不可能永远准，宁可多花一次加载时间也不报错。
LLM_CONTEXT_RETRY = 2
# 为 LLM 进程预留的额外显存（KV + compute + 视觉投影），在 GGUF 文件大小之外。
LLM_VRAM_OVERHEAD = 1536 * 1024 ** 2
API_TIMEOUT = 600
API_CONNECT_TIMEOUT = 30
API_RETRY_ATTEMPTS = 3
API_RETRY_BACKOFF = (1.5, 4.0)
API_RETRY_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})
API_TEMPERATURE = 0.6
PE_FOLDER = "text_encoders"
PE_TEMPERATURE = 0.7
PE_TOP_K = 20
PE_TOP_P = 0.95
PE_REPETITION_PENALTY = 1.05
LLM_TEMPERATURE = 0.5
LLM_TOP_P = 0.8
LLM_TOP_K = 20
LLM_REPEAT_PENALTY = 1.05
# 本地LLM 生成硬上限。旧工作流里存着 4096/8192 的 max_tokens 时不会随默认值更新，
# 一旦模型跑偏就会一路生成到上限（实测 2048 token 已要 70 秒）。直接对齐默认值 1536，
# 正常输出 250~600 token 完全够用，跑偏时最多拖 50 秒。
LLM_LOCAL_MAX_OUTPUT_CEILING = DEFAULT_MAX_OUTPUT_TOKENS
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


def _pack_image_grid(frames: Sequence[torch.Tensor], max_edge: int = DEFAULT_IMAGE_MAX_EDGE) -> torch.Tensor:
    """把多张参考图拼成一张九宫格样式的大图，等比缩放居中、白底留边。"""
    images = [_tensor_to_pil(item[0] if item.ndim == 4 else item).convert("RGB") for item in frames]
    cols = max(1, math.ceil(math.sqrt(len(images))))
    rows = max(1, math.ceil(len(images) / cols))
    cell = max(64, max_edge // cols)
    canvas = Image.new("RGB", (cell * cols, cell * rows), (255, 255, 255))
    for index, image in enumerate(images):
        thumb = image.copy()
        thumb.thumbnail((cell, cell), Image.LANCZOS)
        canvas.paste(thumb, ((index % cols) * cell + (cell - thumb.width) // 2,
                             (index // cols) * cell + (cell - thumb.height) // 2))
    array = np.asarray(canvas, dtype=np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0)


def _llm_reference_images(frames: Sequence[torch.Tensor]) -> list:
    """本地LLM 的参考图编码：少量原样送，多了拼成一张。

    llama.cpp 的 Qwen3.5 走 M-RoPE + hybrid KV cache，每多一个图像 chunk 就累积一次
    位置账本误差（worker stderr 里 `find_slot: non-consecutive token position`），
    实测第 8 张起必然 `failed to find a memory slot`，4 张以内稳定。
    拼成单图后只有一个图像 chunk，位置只算一次，20 张也能稳定出结果。
    """
    if len(frames) <= LLM_DIRECT_IMAGE_LIMIT:
        return [_image_to_jpeg_base64(item) for item in frames]
    print(f"[GG 本地LLM] {len(frames)} 张参考图拼成单张网格图（绕开 M-RoPE 多图位置错位）", flush=True)
    return [_image_to_jpeg_base64(_pack_image_grid(frames))]


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


def _uses_system_proxy(url: str) -> bool:
    """判断 requests 访问该地址时是否真的会走系统/环境代理（决定要不要追加直连兜底）。"""
    try:
        import requests

        proxies = requests.utils.get_environ_proxies(url)
    except Exception:
        return False
    return any(key in proxies for key in ("http", "https"))


def _network_error_hint(exc) -> str:
    """把底层网络异常翻译成「哪错了 + 怎么改」的中文说明。"""
    text = f"{type(exc).__name__}: {exc}"
    lowered = text.lower()
    if "10053" in text or "10054" in text or "connection aborted" in lowered or "connection reset" in lowered:
        return (
            "连接在传输过程中被本机网络软件中断（WinError 10053/10054）。"
            "常见原因是代理/VPN 客户端、安全软件或运营商中间设备掐断了这条 HTTPS 连接。"
            "请确认代理软件与系统代理设置正常，或换一条网络线路后重试。"
        )
    if "timed out" in lowered or "timeout" in lowered:
        return "连接 API 超时。请检查网络是否通畅、api_base_url 是否正确，或稍后重试。"
    if "getaddrinfo" in lowered or "name or service not known" in lowered or "11001" in text:
        return "无法解析 API 域名。请检查 api_base_url 拼写以及本机 DNS / 代理设置。"
    if "certificate" in lowered or "ssl" in lowered:
        return "HTTPS 证书校验失败。可能是代理或安全软件做了中间人拦截，请更换网络或关闭证书拦截类软件。"
    if "10061" in text or "connection refused" in lowered or "actively refused" in lowered:
        return "目标端口拒绝连接。请确认 api_base_url 正确、服务端在线。"
    return "网络请求未能完成。请检查网络与代理设置后重试。"


def _request_api(*, api_base_url, api_key, model, instructions, user_prompt, image_base64_list) -> str:
    import requests

    if not str(api_key or "").strip():
        raise ValueError("API 方式需要填写 API Key")
    if not str(model or "").strip():
        raise ValueError("API 方式需要填写模型名（model）")
    url = _resolve_api_url(api_base_url)
    payload = {
        "model": model,
        "instructions": instructions,
        "input": _build_api_input(user_prompt, image_base64_list),
        "temperature": API_TEMPERATURE,
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    timeout = (API_CONNECT_TIMEOUT, API_TIMEOUT)

    # 瞬时网络中断（连接被掐断、超时、服务端 5xx / 429）重试同一路径；
    # 只有在系统代理确实生效时才追加一次直连，用于绕开出问题的本地代理。
    if _uses_system_proxy(url):
        attempts = [(True, "系统代理")] * (API_RETRY_ATTEMPTS - 1) + [(False, "直连（绕过代理）")]
    else:
        attempts = [(True, "直连")] * API_RETRY_ATTEMPTS

    response = None
    last_error = None
    for index, (trust_env, label) in enumerate(attempts, start=1):
        session = requests.Session()
        session.trust_env = trust_env
        try:
            response = session.post(url, json=payload, headers=headers, timeout=timeout)
        except requests.exceptions.RequestException as exc:
            response, last_error = None, exc
        finally:
            session.close()

        if response is not None and response.status_code not in API_RETRY_STATUS:
            break
        if index >= len(attempts):
            break
        reason = (
            f"HTTP {response.status_code}" if response is not None
            else f"{type(last_error).__name__}：{last_error}"
        )
        delay = API_RETRY_BACKOFF[min(index - 1, len(API_RETRY_BACKOFF) - 1)]
        print(f"[GG 提示词增强] API 请求失败（{label}，{reason}），{delay} 秒后重试（{index}/{len(attempts)}）")
        time.sleep(delay)

    if response is None:
        raise RuntimeError(
            f"GG 提示词增强失败：API 请求未送达（已尝试 {len(attempts)} 次）。"
            f"{_network_error_hint(last_error)}\n原始错误：{last_error}"
        ) from last_error
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
    # models/LLM 是本节点的本地兜底，不依赖其它插件注册目录或扩展名。
    local_dir = Path(folder_paths.models_dir) / "LLM"
    if local_dir.is_dir():
        for path in local_dir.rglob("*"):
            if path.is_file() and path.suffix.lower() == ".gguf":
                names.add(path.relative_to(local_dir).as_posix())
    found = sorted(names)
    if allow_none:
        return [NO_MMPROJ] + found
    return found or [MISSING_GGUF]


def _resolve_gguf_path(model_name: str) -> str:
    name = str(model_name or "").replace("\\", "/")
    if not name or Path(name).is_absolute() or ".." in Path(name).parts:
        raise ValueError("GGUF 模型名称必须是模型目录内的相对路径，不能跳出模型目录。")
    for folder in LLM_FOLDERS:
        try:
            path = folder_paths.get_full_path(folder, model_name)
        except Exception:
            path = None
        if path:
            return path
    root = (Path(folder_paths.models_dir) / "LLM").resolve()
    candidate = (root / name).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        raise ValueError("GGUF 模型路径不能跳出 models/LLM 目录。") from None
    if candidate.is_file() and candidate.suffix.lower() == ".gguf":
        return str(candidate)
    raise ValueError(f"找不到 GGUF 模型文件：{model_name}")


class _LocalLLMStorage:
    llm = None
    key = None
    context_length = 0

    @classmethod
    def load(cls, model_name: str, mmproj_name: str, context_length: int):
        mmproj = "" if not mmproj_name or mmproj_name == NO_MMPROJ else mmproj_name
        key = (model_name, mmproj)
        need = max(512, int(context_length))
        # 参考图张数变了只会抬高需求，已按更大上下文加载过就直接复用，不重复载入权重。
        if cls.llm is not None and cls.key == key and cls.context_length >= need:
            return cls.llm
        cls.unload()
        model_path = _resolve_gguf_path(model_name)
        mmproj_path = _resolve_gguf_path(mmproj) if mmproj else ""
        from .local_llm_bridge import LocalLLMProxy

        # 原生 LLM 不归 Comfy 管理：只腾出它自己要用的显存，够用就不动已加载的扩散模型。
        # 无条件 unload_all_models() 会把用户的 UNET/CLIP 全踢掉，后续采样重新从磁盘
        # 加载几十 GB 权重，整个工作流能多出 200 秒以上。
        interrupt_check = None
        try:
            import comfy.model_management as mm
        except ImportError:
            pass
        else:
            interrupt_check = getattr(mm, "throw_exception_if_processing_interrupted", None)
            try:
                vram_need = Path(model_path).stat().st_size + LLM_VRAM_OVERHEAD
            except OSError:
                vram_need = 8 * 1024 ** 3
            try:
                mm.free_memory(vram_need, mm.get_torch_device())
            except Exception:
                mm.unload_all_models()
                mm.soft_empty_cache(force=True)
        print(f"[GG 本地LLM] 正在加载 {Path(model_path).name}（n_ctx={need}）…", flush=True)
        llm = LocalLLMProxy(model_path, mmproj_path, need, interrupt_check=interrupt_check)
        cls.llm = llm
        cls.key = key
        cls.context_length = need
        return llm

    @classmethod
    def unload(cls) -> None:
        llm, cls.llm, cls.key, cls.context_length = cls.llm, None, None, 0
        if llm is not None:
            llm.close()


def _estimate_tokens(text: str) -> int:
    """粗估 token 数：中日韩约 1 字/token，其余约 4 字符/token。只用于上下文预算。"""
    cjk = sum(1 for ch in text if "\u2e80" <= ch <= "\u9fff")
    return cjk + (len(text) - cjk + 3) // 4


def _local_llm_context_needed(system_prompt: str, user_prompt: str, image_count: int, max_output_tokens: int) -> int:
    """n_ctx 必须同时装下提示词、参考图与全部输出 token，否则生成阶段会拿不到 KV 槽位。"""
    text = int((_estimate_tokens(system_prompt) + _estimate_tokens(user_prompt)) * 1.15) + LLM_PROMPT_HEADROOM
    return text + LLM_IMAGE_TOKEN_BUDGET * int(image_count) + int(max_output_tokens)


def _local_output_guard(language: str) -> str:
    """本地模型的末位输出约束：只出正文，别翻译、别解析，避免一路生成到 max_tokens。"""
    if language == "英文":
        return "\n\nOutput only the final English prompt text. No translation, no analysis, no Chinese notes."
    return "\n\n只输出最终的中文提示词正文，不要翻译、不要分析、不要输出任何英文说明。"


def _is_context_overflow(exc: BaseException) -> bool:
    """判断失败是不是 KV 槽位/上下文装不下——只有这类才值得放大 n_ctx 重试。"""
    text = str(exc)
    return any(
        marker in text
        for marker in ("上下文不足", "memory slot", "batch size 1", "Context Shift")
    )


def _request_local_llm(*, model_name, mmproj_name, context_length, system_prompt, user_prompt, max_output_tokens, image_base64_list) -> str:
    images = list(image_base64_list or [])
    requested_output = int(max_output_tokens)
    max_output_tokens = min(requested_output, LLM_LOCAL_MAX_OUTPUT_CEILING)
    if max_output_tokens != requested_output:
        print(
            f"[GG 本地LLM] 最大生成 token {requested_output} 超过本地上限，按 {max_output_tokens} 执行",
            flush=True,
        )
    needed = _local_llm_context_needed(system_prompt, user_prompt, len(images), max_output_tokens)
    # 实测 8448 在拼图/多图时必然抢不到 KV 槽位（prompt 才 4408 token 也一样），
    # 16384 稳定通过。低于默认值的旧工作流设置不再生效，避免用户手动调小后又踩同一个坑。
    target = max(512, int(context_length), DEFAULT_CONTEXT_LENGTH)
    if needed > target:
        # 用户手动设得更大就以用户值为准，只有自动抬高会撞上限时才拒绝。
        if needed > LLM_MAX_CONTEXT:
            prompt_tokens = int((_estimate_tokens(system_prompt) + _estimate_tokens(user_prompt)) * 1.15) + LLM_PROMPT_HEADROOM
            raise ValueError(
                f"本地LLM 上下文不够：提示词约 {prompt_tokens} token + 参考图 {len(images)} 张 × "
                f"{LLM_IMAGE_TOKEN_BUDGET} + 最大生成 {int(max_output_tokens)} token，共需约 {needed}，"
                f"超过上限 {LLM_MAX_CONTEXT}。请减少参考图张数或降低最大生成token。"
            )
        target = needed
    user_content: Any = user_prompt
    if images:
        user_content = [{"type": "text", "text": user_prompt}]
        user_content.extend(
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + item}}
            for item in images
        )
    attempt = 0
    while True:
        loaded = target
        llm = _LocalLLMStorage.load(model_name, mmproj_name, target)
        started = time.monotonic()
        try:
            result = llm.create_chat_completion(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                max_tokens=int(max_output_tokens),
                temperature=LLM_TEMPERATURE,
                top_p=LLM_TOP_P,
                top_k=LLM_TOP_K,
                # 增强规则写得很长，放开重复惩罚会退化成复读，一直生成到 max_tokens 才停。
                repeat_penalty=LLM_REPEAT_PENALTY,
            )
        except Exception as exc:
            # 失败的桥接已释放 child；清掉代理缓存，让同一选择可以重新启动。
            _LocalLLMStorage.unload()
            attempt += 1
            if attempt > LLM_CONTEXT_RETRY or loaded >= LLM_MAX_CONTEXT or not _is_context_overflow(exc):
                raise
            # token 估算不可能永远准（图像下限、模板差异都会变），装不下就直接放大重来，
            # 比让用户自己去猜上下文长度可靠。实测一次重试约多花 5~10 秒。
            target = min(LLM_MAX_CONTEXT, max(loaded * 2, loaded + 4096))
            print(
                f"[GG 本地LLM] 上下文不足（n_ctx={loaded}），自动提高到 n_ctx={target} 重试"
                f"（{attempt}/{LLM_CONTEXT_RETRY}）…",
                flush=True,
            )
            continue
        usage = result.get("usage") if isinstance(result, dict) else None
        detail = ""
        if isinstance(usage, dict):
            detail = f"，prompt {usage.get('prompt_tokens')} / 生成 {usage.get('completion_tokens')} token"
        print(f"[GG 本地LLM] 生成完成，用时 {time.monotonic() - started:.1f}s（n_ctx={loaded}）{detail}", flush=True)
        break
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
                # 本地模型偶尔先输出一段英文任务解析（"The user's instruction is in Chinese: ..."）
                # 再一路生成到 max_tokens。实测在需求末尾追加这句，同一请求从 56 秒/1536 token
                # 收到 20.6 秒/249 token，且直接给中文正文。
                user_prompt=user_prompt + _local_output_guard(language),
                max_output_tokens=max_output_tokens,
                image_base64_list=_llm_reference_images(edit_images),
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
        io.Int.Input(P_CTX, default=DEFAULT_CONTEXT_LENGTH, min=512, max=131072, step=512, tooltip="本地LLM 上下文长度。默认 16384 已是最优值；填得比它小会被自动抬回 16384，装不下时还会继续自动放大并重试，一般不用手调。"),
        io.Int.Input(P_MAXTOK, default=DEFAULT_MAX_OUTPUT_TOKENS, min=256, max=32768, step=256, tooltip="最大生成 token。正常输出 250~600 token，默认 1536 已够；本地LLM 方式填更大也只按 1536 执行，避免跑偏时一路生成几十秒。"),
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

