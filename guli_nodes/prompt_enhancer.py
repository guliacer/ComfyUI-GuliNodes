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
# 自动模式：接了图且需求为空 → 反推；接了图 → 图生图；没图 → 文生图。
# 这三个分支的判定放在 _resolve_task，节点只管把 frames 与文本丢进来。
MODE_AUTO = "自动"
TASK_MODES = (MODE_AUTO, MODE_T2I, MODE_I2I)
METHOD_API = "API"
METHOD_PE = "本地PE"
METHOD_LLM = "本地LLM"

LANG_AUTO = "自动"
LANGUAGES = (LANG_AUTO, "中文", "英文")

# 卸载策略。孤海那种四档比原来的单个布尔好用：常驻能省 5~10 秒重载，
# 「运行前后」则能把上一步扩散模型留下的显存彻底腾给本节点。
UNLOAD_AUTO = "自动"
UNLOAD_KEEP = "保持加载"
UNLOAD_AFTER = "运行后自动卸载"
UNLOAD_BEFORE_AFTER = "运行前后自动卸载"
UNLOAD_MODES = (UNLOAD_AUTO, UNLOAD_KEEP, UNLOAD_AFTER, UNLOAD_BEFORE_AFTER)

# 透明背景：Qwen Image 2.1 认这段英文前缀/后缀出 RGBA。
TRANSPARENT_PREFIX = "This is an RGBA image with transparency. "
TRANSPARENT_SUFFIX = " The image has alpha channel and the background is transparent."

DIRECTION_NONE = "默认"
# 增强方向只是往用户需求后面叠一段画面约束，不改官方 system prompt：
# 官方模板已经很长，再往里塞容易互相打架，追加在 user 侧更可控。
_DIRECTION_HINTS = {
    "写实人像": "按写实人像摄影处理：85mm 左右等效焦段、浅景深，皮肤保留毛孔与绒毛质感，柔和侧逆光勾边，避免塑料感与过度磨皮。",
    "商业产品": "按商业产品摄影处理：纯净或简洁台面背景，柔光箱主光加轮廓光，材质纹理与反射清楚，构图一侧留出文案空间。",
    "氛围场景": "强化环境氛围：明确时间与天气，加入空气介质（薄雾、浮尘、逆光光斑、雨丝），前中后景层次分明，主体仍是视觉中心。",
    "二次元插画": "按二次元插画处理：干净的线稿、赛璐璐或厚涂二选一并全图统一，色块分区明确，高光与阴影简化但结构准确。",
    "建筑空间": "按建筑与室内摄影处理：垂直线保持竖直不倾倒，广角不畸变，自然光与人工光分层，材质与结构细节清楚。",
    "美食": "按美食摄影处理：45 度斜拍或俯拍，硬光打出高光点，蒸汽与油光真实，配色克制，餐具不抢主体。",
    "宠物": "按宠物摄影处理：镜头与视线齐平，抓拍动态瞬间，毛发丝缕清晰，眼神高光明确，背景干净不杂乱。",
}
DIRECTIONS = (DIRECTION_NONE,) + tuple(_DIRECTION_HINTS)

# 反推模式的用户侧指令。system 侧再补一段 _REVERSE_SYSTEM_TAIL，
# 让模型从「改写编辑指令」切换到「从零写生成提示词」。
REVERSE_USER_PROMPT = "上面这张图需要被复现。请按反推模式，输出一段可以直接用来生成这张图的完整提示词。"
# 反推时用户消息里没有任何「中文/英文」的锚点（内容全在图上），官方 PE 微调又天然偏英文，
# 实测不改这句会稳定吐出英文，所以按输出语言在用户消息末尾补一句。
_REVERSE_LANG_HINT = {
    "中文": "\n\n这段提示词请用中文写。",
    "英文": "\n\nWrite this prompt in English.",
    LANG_AUTO: "",
}
_REVERSE_SYSTEM_TAIL = (
    "\n\n## Reverse mode\n"
    "Instead of a request you receive reference image(s). Read them and write ONE generation prompt "
    "that would reproduce the image: subject and attributes, pose and composition, camera and lens, "
    "lighting, color palette, materials, environment and rendering style. Describe only what is visible; "
    "invent nothing. Do not phrase it as an edit instruction and never mention \"the input image\" — "
    "write it as a from-scratch generation prompt."
)

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
# JSON 通道只剥掉 Language 这一节（官方模板写死了「永远英文」，与节点的输出语言设置冲突），
# 后面的「## Output format」必须留着——那是 JSON 字段约定的出处。
# 纯文本通道反过来：Language 之后（含格式约定）整段一起剥掉，旧行为就是这样。
_T2I_LANGUAGE_TAIL_RE = re.compile(r"\n\n## Language\n[\s\S]*?(?=\n\n## |\Z)")
_T2I_TAIL_TO_END_RE = re.compile(r"\n\n## Language\n[\s\S]*\Z")
_EDIT_OUTPUT_TAIL_RE = re.compile(r"\n\n## Output [Ff]ormat\n[\s\S]*\Z")
_EDIT_LANGUAGE_BLOCK_RE = re.compile(
    r"\n\*\*FIRST — there are TWO separate language decisions\.[\s\S]*?"
    r"(?=\n\nYou are an expert at clarifying image editing instructions\.)"
)


def _default_option(options: list[str], preferred: str) -> str:
    if preferred in options:
        return preferred
    return options[0] if options else ""


def _preferred_model(options: list[str], *markers: str) -> str:
    """按文件名里的记号挑默认模型。

    模型列表是按字母序排的，第一个往往是 clip_l.safetensors 这种视觉编码器，
    直接拿它当默认值，用户点一下节点就得先怀疑人生。
    """
    for marker in markers:
        key = marker.casefold()
        for option in options:
            if key in str(option).casefold():
                return option
    return options[0] if options else ""


def _default_method(pe_choices: list[str]) -> str:
    """有 PE 权重就默认本地PE：16 秒级、不用填 key，比让用户先配 API 好上手。"""
    first = str(pe_choices[0]) if pe_choices else ""
    return METHOD_PE if first and not first.startswith("（") else METHOD_API


_MMPROJ_MARKERS = ("mmproj", "mm-projector", "vision-projector", "vit-")


def _main_gguf_default(options: list[str]) -> str:
    """主模型默认值要避开 mmproj。

    GGUF 列表按字母序排，视觉投影文件经常排在前面（3.5mmproj-BF16.gguf 就是第一个），
    把它填进「主模型」只会加载失败，用户还以为节点坏了。
    """
    for option in options:
        name = str(option).casefold()
        if name.startswith("（"):
            continue
        if any(marker in name for marker in _MMPROJ_MARKERS):
            continue
        return option
    return options[0] if options else ""


def _gguf_task_defaults(gguf: list[str], mmproj: list[str]) -> tuple[str, str, str]:
    """文生图 / 图生图各自挑一个 GGUF，并找图生图模型配套的 mmproj。

    本地PE 早就是「文生图一个模型、图生图一个模型」，本地LLM 之前只有一个
    「主模型」：装了 Qwen-Image-2.1-PE-T2I.gguf + Qwen-Image-2.1-PE-I2I.gguf
    也永远只用到前者，切换任务毫无作用。按文件名记号分开挑，两个任务各用各的。
    """
    t2i = _task_gguf_default(gguf, "t2i", "text2image", "text-to-image")
    i2i = _task_gguf_default(gguf, "i2i", "image2image", "image-to-image")
    return t2i, i2i, _preferred_mmproj(mmproj, i2i)


def _task_gguf_default(options: list[str], *markers: str) -> str:
    """按 T2I / I2I 记号挑默认主模型；仍要排除 mmproj 与占位项。"""
    for marker in markers:
        key = marker.casefold()
        for option in options:
            name = str(option).casefold()
            if name.startswith("（") or key not in name:
                continue
            if any(m in name for m in _MMPROJ_MARKERS):
                continue
            return option
    return _main_gguf_default(options)


def _preferred_mmproj(options: list[str], i2i_model: str) -> str:
    """只认「与图生图模型同前缀」的 mmproj；找不到就保持「无」。

    拿别的模型的投影硬凑会在加载视觉 handler 时直接失败。公共前缀要够长，
    免得 Qwen3.5-9B-xxx 与 Qwen3.5-9B-yyy 被误判成配套。
    """
    target = str(i2i_model or "").casefold()
    if not target or target.startswith("（"):
        return NO_MMPROJ
    best, longest = NO_MMPROJ, 0
    for option in options:
        name = str(option).casefold()
        if not any(marker in name for marker in _MMPROJ_MARKERS):
            continue
        common = 0
        for a, b in zip(target, name):
            if a != b:
                break
            common += 1
        if common >= 12 and common > longest:
            best, longest = option, common
    return best


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
# 两条输出通道，按后端分开——这是实测出来的，不是偏好：
# · 本地PE 走 JSON：官方 PE 权重就是按 JSON 协议微调的，字段齐全还能拿到 ratio_follow。
# · API / 本地LLM 走纯文本 + 一行 RATIO 尾注：通用模型被要求「只返回 JSON」时，
#   实测会照着模板里的 <the description> 占位符抄，甚至跑满 1536 token（本机 9B 实测 474 秒
#   只吐出 "..."）。纯文本是它们一直工作的形态，比例用单独一行取，代价只是少一个 ratio_follow。
_FINAL_LANG_ZH = FINAL_LANGUAGE_RULE_ZH
_FINAL_LANG_EN = FINAL_LANGUAGE_RULE_EN
_FINAL_LANG_AUTO = (
    "最终语言规则（优先级最高）：输出语言设为“自动”，最终提示词的叙述语言与用户需求所用的语言保持一致"
    "（中文需求写中文，英文需求写英文；没有可判定的语言线索时用英文）。"
    "用户明确要求显示在图片中的文字、专有名词和品牌名保持原文。"
    "只输出最终提示词纯文本，不输出 JSON、字段名、Markdown、分析过程、思考内容或解释。"
)
_FINAL_LANG_RULES = {LANG_AUTO: _FINAL_LANG_AUTO, "中文": _FINAL_LANG_ZH, "英文": _FINAL_LANG_EN}

# 「自动」在官方 PE 规则里没有对应说法，自己补一条；中文/英文直接沿用官方逐字稿。
_PE_LANG_AUTO = (
    "输出语言设为「自动」：`rewritten_prompt` 的叙述语言与用户需求所用语言保持一致。"
    "用户明确要求显示在图片中的文字、专有名词和品牌名保持原文。"
    "**关键：输出完整的 JSON 对象后立即停止。不要输出任何额外的文字、解释或分析。**"
)
_PE_LANG_RULES = {LANG_AUTO: _PE_LANG_AUTO, "中文": PE_LANGUAGE_RULE_ZH, "英文": PE_LANGUAGE_RULE_EN}

# 官方 PE 权重偏英文：system prompt 尾部那句语言规则隔着上万字符，实测经常被淹没，
# 同一请求只在用户消息里补这一句才会稳定改语言。宁可重复一次，也不要用户看到满屏英文。
_PE_USER_LANG_HINT = {
    "中文": "\n\n最终提示词请用中文写。",
    "英文": "\n\nWrite the final prompt in English.",
    LANG_AUTO: "",
}

# 纯文本通道的画面比例尾注：单独一行，比塞进正文好剥，也不会污染提示词本身。
_RATIO_TRAILER_ZH = (
    "\n\n最后另起一行，单独写 `RATIO: 比例`（例如 `RATIO: 3:2`），这一行不要写别的。"
)
_RATIO_TRAILER_EN = (
    "\n\nEnd with a separate final line `RATIO: W:H` (for example `RATIO: 3:2`) and nothing else on it."
)
_RATIO_TRAILER_FOR = {LANG_AUTO: _RATIO_TRAILER_ZH, "中文": _RATIO_TRAILER_ZH, "英文": _RATIO_TRAILER_EN}
_RATIO_LINE_RE = re.compile(
    r"[\r\n]+\s*(?:RATIO|WH_RATIO|wh_ratio|画面比例|比例)\s*[:：]\s*([0-9]{1,2}\s*[:：]\s*[0-9]{1,2})\s*$",
    re.IGNORECASE,
)

_OUTPUT_FORMAT_HEAD_RE = re.compile(r"\n\n## Output [Ff]ormat\b")

# 图生图模板最后一句是把用户指令接在 system 里的引导语；本节点的需求走 user 消息，
# 留着它就成了半截话，还得让后面的节点级规则跟着它跑。
_EDIT_REQUEST_LEADIN_RE = re.compile(r"\n*The user's edit instruction to rewrite is:\s*\Z")


def _with_section(base: str, section: str) -> str:
    """把补充段落插在「## Output format」之前，保证输出格式仍是最后一段。"""
    match = _OUTPUT_FORMAT_HEAD_RE.search(base)
    if match:
        return base[: match.start()] + section + base[match.start():]
    return base + section


# 官方模板要求「按八步走」。官方 PE 权重是训练成这样、默默走完再出稿的；
# 通用指令模型（尤其是 abliterated 微调）会把八步当正文写出来。
# 纯文本通道把这句改成「心里走，别写出来」，这是本地LLM 好不好用的关键一句。
_STEP_PREAMBLE = (
    "Work through the eight steps below in order. Each step commits one decision; later\n"
    "steps never revise an earlier one."
)
_STEP_PREAMBLE_SILENT = (
    "Work through the eight steps below in your head, in order. Each step commits one decision; "
    "later steps never revise an earlier one. Never write the steps, the checklist, the analysis, "
    "or any planning notes into your answer — the answer begins directly with the finished description."
)

# 计划被写进正文时的补救：回复以这些词开头，说明模型在写草稿而不是写答案。
_REASONING_HEADERS = (
    "thinking process", "thinking", "reasoning", "思考过程", "思考", "分析过程", "分析：", "分析:",
)


def _clean_reasoning_block(block: str) -> str:
    """把计划里的一个小节整理成正文：去项目符号、去掉「*Revised Draft:*」这类标签行。"""
    lines = [line.strip() for line in block.splitlines() if line.strip()]
    while len(lines) > 1 and len(lines[0]) <= 40 and lines[0].rstrip("*").rstrip().endswith((":", "：")):
        lines.pop(0)
    text = " ".join(lines)
    return text.lstrip("*#->— ").strip()


def _strip_untagged_reasoning(text: str) -> str:
    """剥掉没有 <think> 标记、直接写成正文的思考/计划段，只留最后一段答案。

    只在回复以「Thinking Process / 思考过程」这类词开头时才动手，避免误伤正常输出。
    模板要求答案是一整段连续散文，所以从后往前找第一段够长的正文即可。
    """
    value = (text or "").strip()
    if not value:
        return value
    head = value[:120].lstrip().lstrip("*# ").lower()
    if not any(head.startswith(name) for name in _REASONING_HEADERS):
        return value
    match = _RATIO_LINE_RE.search(value)
    body = value[: match.start()] if match else value
    blocks = [block.strip() for block in re.split(r"\n\s*\n", body) if block.strip()]
    if len(blocks) < 2:
        return value
    for block in reversed(blocks):
        cleaned = _clean_reasoning_block(block)
        if len(cleaned) >= 40:
            return cleaned
    return _clean_reasoning_block(blocks[-1])


def _remove_conflicting_language_rules(text: str, *, structured: bool) -> str:
    text = text.replace("one long English paragraph", "one long paragraph")
    text = _EDIT_LANGUAGE_BLOCK_RE.sub("", text)
    if structured:
        # JSON 通道要留着官方的字段约定，只剥掉「永远英文」那一节。
        text = _T2I_LANGUAGE_TAIL_RE.sub("", text)
        return _EDIT_REQUEST_LEADIN_RE.sub("", text)
    # 纯文本通道不需要 JSON 字段约定，连 Language 之后的一整段一起剥掉（旧行为）。
    text = _T2I_TAIL_TO_END_RE.sub("", text)
    text = _EDIT_OUTPUT_TAIL_RE.sub("", text)
    return text.replace(_STEP_PREAMBLE, _STEP_PREAMBLE_SILENT)


def _clean_base_prompt(mode: str, reverse: bool = False, *, structured: bool = False) -> str:
    base = QWEN_T2I_SYSTEM_PROMPT if mode == MODE_T2I else QWEN_EDIT_SYSTEM_PROMPT
    base = _remove_conflicting_language_rules(base, structured=structured)
    if reverse:
        # 反推没有编辑意图，套 T2I 的生成规则 + 一段反推说明，比硬塞 EDIT 模板干净。
        base = _with_section(base, _REVERSE_SYSTEM_TAIL)
    return base


def _node_output_tail(language: str, *, api_mode: bool) -> str:
    rule = _FINAL_LANG_RULES.get(language, _FINAL_LANG_ZH)
    line = API_MODE_LINE if api_mode else LOCAL_MODE_LINE
    return "\n\n" + QWEN_OUTPUT_POLICY + "\n" + rule + "\n" + line


def _build_api_instructions(mode: str, language: str, reverse: bool = False) -> str:
    return _clean_base_prompt(mode, reverse) + _node_output_tail(language, api_mode=True)


def _build_llm_system(mode: str, language: str, reverse: bool = False) -> str:
    return _clean_base_prompt(mode, reverse) + _node_output_tail(language, api_mode=False)


def _build_official_pe_system(mode: str, language: str, reverse: bool = False) -> str:
    rule = _PE_LANG_RULES.get(language, PE_LANGUAGE_RULE_ZH)
    base = _clean_base_prompt(mode, reverse, structured=True)
    # 规则头尾各钉一次：反推要带图，图片 token 会把上万字符模板的尾部挤出上下文
    # （实测同一套提示词，文生图出中文、反推出英文），截断只会砍尾巴，砍不到第一句。
    return rule + "\n\n" + base + "\n\n" + QWEN_OFFICIAL_PE_POLICY + "\n" + rule


def _resolve_language(language: str, prompt_text: str) -> str:
    """把「自动」提前钉成具体语言。

    「自动」的语义是跟随用户需求的语言，可系统提示里那句话对模型来说太远；
    反推时又没有用户文本可跟随（此时按节点默认的中文走，本插件用户多数写中文需求）。
    """
    if language in ("中文", "英文"):
        return language
    text = str(prompt_text or "").strip()
    if not text:
        return "中文"
    return "中文" if _CJK_RE.search(text) else "英文"


def _resolve_task(task_mode: str, frames: list, prompt_text: str) -> tuple[str, bool]:
    """把「自动」解析成真实任务，返回 (模式, 是否反推)。

    反推判定沿用孤海那套：有图但没写需求 = 想让节点看着图说人话。
    显式选了文生图/图生图就完全听用户的，不猜。
    """
    mode = str(task_mode or MODE_AUTO)
    if mode not in TASK_MODES:
        mode = MODE_AUTO
    has_images = bool(frames)
    has_text = bool(str(prompt_text or "").strip())
    if mode == MODE_AUTO:
        if has_images and not has_text:
            return MODE_T2I, True
        return (MODE_I2I if has_images else MODE_T2I), False
    if mode == MODE_I2I and not has_images:
        raise ValueError("图生图模式需要连接参考图输入。")
    if mode == MODE_I2I and not has_text:
        raise ValueError("图生图模式需要填写需求；只想按图反推请把任务模式改成「自动」并留空需求。")
    return mode, False


def _direction_tail(direction: str) -> str:
    hint = _DIRECTION_HINTS.get(str(direction or "").strip(), "")
    if not hint:
        return ""
    return "\n\n画面方向要求（在满足上述用户需求的前提下叠加，不得改变用户明确要求的内容）：\n" + hint


def _coerce_unload(value: Any) -> str:
    """卸载策略兼容旧工作流的布尔值：True 等于运行后卸载，False 等于保持加载。"""
    if isinstance(value, bool):
        return UNLOAD_AFTER if value else UNLOAD_KEEP
    text = str(value or "").strip()
    return text if text in UNLOAD_MODES else UNLOAD_AUTO


def _low_free_memory() -> bool:
    """显存剩余不到一半就认为该卸载了（孤海「自动」档的判据）。"""
    try:
        import comfy.model_management as mm

        device = mm.get_torch_device()
        total = float(mm.get_total_memory(device) or 0)
        free = float(mm.get_free_memory(device) or 0)
    except Exception:
        return True
    return not total or free * 2 < total


def _release_models_before_run() -> None:
    """「运行前先卸载」：把本节点自己加载过的 PE / LLM 先放掉，再让 Comfy 收回显存。"""
    _OfficialPEStorage.unload()
    _LocalLLMStorage.unload()
    try:
        import comfy.model_management as mm

        mm.soft_empty_cache(force=True)
    except Exception:
        pass


def _build_official_pe_text(system: str, user_request: str, *, has_images: bool) -> str:
    text = "<start_of_turn>system\n" + system + "<end_of_turn>\n<start_of_turn>user\n"
    if has_images:
        text += "\n<image_soft_token>\n\n"
    return text + "User Raw Input Prompt: " + user_request + ".<end_of_turn>\n<start_of_turn>model\n"


# ------------------------- 透明背景 ------------------------- #
# 只加前后缀没用：用户需求里那句「站在白墙前」「白色背景」会把模型重新拉回不透明画面。
# 所以请求侧先改写目标/删除背景描述，出稿侧再清一遍残留，最后才套 RGBA 前后缀。
_BG_ZH_NOUN = r"(?:背景|背景色|背景颜色|背景板|背景布|背景区域)"
_BG_COLORS_ZH = "黑|白|灰|红|橙|黄|绿|青|蓝|紫|粉|棕|褐|米|金|银|彩色|多彩|有色"
_BG_COLORS_EN = (
    "black|white|gray|grey|red|orange|yellow|green|cyan|blue|purple|violet|"
    "pink|brown|beige|gold|silver|colored|colourful|colorful|multicolored|multi-colored"
)
# 抠图用途：环境类子句必须整段清掉，否则「站在白墙前」会把主体拖回实景。
_RESIDUE_ZH = (
    "天空|蓝天|云层|云朵|云彩|积云|白云|乌云|地平线|风景|景色|"
    "墙|地面|地板|桌面|房间|卧室|客厅|室内|户外|影棚|摄影棚|街道|海边|沙滩|树林|森林|"
    "背景板|背景布|渐变背景|背景渐变"
)
_RESIDUE_EN = (
    "sky|clouds?|cloud layer|cloudscape|horizon|landscape|scenery|"
    "wall|floor|tabletop|table|room|interior|outdoor|backdrop|beach|street|forest|studio|"
    "background gradient|gradient background"
)

_TRANSPARENT_REQUEST_OVERRIDE = (
    "\n\n[透明背景要求，优先级最高] 忽略需求里出现的任何背景颜色、背景材质、背景板、墙面、地面、房间、"
    "风景等不透明背景描述；最终画面只保留完全透明的背景。主体本身（人、物、材质、光影、构图）保持不变。"
)
_TRANSPARENT_REVERSE_OVERRIDE = (
    "\n\n[透明背景要求，优先级最高] 参考图只用来提取主体（人、物、材质、光影、构图），"
    "不要描述、也不要沿用参考图的任何背景；最终画面只保留完全透明的背景。"
)
_TRANSPARENT_FINAL_CONSTRAINT = (
    "\n\nFINAL CONSTRAINT: `rewritten_prompt` 只能描述完全透明的背景，"
    "不得保留或补写天空、云层、地平线、风景、墙面、地面、桌面、房间、背景板、渐变背景等任何背景或环境描述。"
)


def _stash_source_background(text: str, sink: list) -> str:
    """把「纯白背景」这类源描述换成占位符，改写目标时才不会把颜色一起吃掉。"""
    zh_term = re.compile(
        rf"(?:纯净的|均匀的|均匀纯净的|浅色的|深色的|纯色的|纯|浅|深)?"
        rf"(?:{_BG_COLORS_ZH})色?[\u4e00-\u9fffA-Za-z-]{{0,6}}{_BG_ZH_NOUN}"
    )
    en_term = re.compile(
        rf"(?:{_BG_COLORS_EN})(?:\s+[\w-]+){{0,4}}\s+(?:background|backdrop)\b", re.IGNORECASE
    )

    def stash(match: re.Match) -> str:
        token = f"__GG_SOURCE_BG_{len(sink)}__"
        sink.append(match.group(0))
        return token

    return en_term.sub(stash, zh_term.sub(stash, text))


def _unstash_source_background(text: str, sink: list) -> str:
    for index, original in enumerate(sink):
        text = text.replace(f"__GG_SOURCE_BG_{index}__", original)
    return text


def _rewrite_background_edit_targets(text: str, sink: list) -> str:
    """「把蓝底换成…」这类改写指令，目标直接钉成透明背景。"""
    zh_action = re.compile(
        r"(?P<head>(?:请\s*)?(?:把|将)\s*[^，。；\n]*?" + _BG_ZH_NOUN +
        r"[^，。；\n]*?(?:改为|改成|换成|替换为|替换成|变为|变成|设置为|设为)\s*)"
        r"(?P<target>[^，。；\n]+)"
    )
    en_action = re.compile(
        r"(?P<head>\b(?:change|replace|turn|make|set|switch)\b[^,.!?;\n]*?"
        r"\b(?:background|backdrop)(?:\s+color)?\b[^,.!?;\n]*?\b(?:to|into|with)\b\s*)"
        r"(?P<target>[^,.!?;\n]+)",
        re.IGNORECASE,
    )
    text = zh_action.sub(
        lambda m: _stash_source_background(m.group("head"), sink) + "透明背景", text
    )
    return en_action.sub(
        lambda m: _stash_source_background(m.group("head"), sink) + "a transparent background", text
    )


def _rewrite_direct_background_descriptions(text: str) -> str:
    """「背景是白色」「on a white background」直接改写成透明背景。"""
    zh_clause = re.compile(
        rf"背景(?:颜色)?\s*(?:是|为|呈|：|:)\s*[^，。；\n]*?(?:{_BG_COLORS_ZH})色?"
        rf"[^，。；\n]*?(?=[，。；\n]|$)"
    )
    text = zh_clause.sub("背景为透明", text)
    zh_phrase = re.compile(
        rf"(?:纯净的|均匀的|均匀纯净的|浅色的|深色的|纯色的|纯|浅|深)?"
        rf"(?:{_BG_COLORS_ZH})色?[\u4e00-\u9fffA-Za-z-]{{0,6}}{_BG_ZH_NOUN}"
    )
    text = zh_phrase.sub("透明背景", text)
    en_clause = re.compile(
        rf"\b(?:the\s+)?background(?:\s+color)?\s+"
        rf"(?:is|was|becomes|became|changed\s+to|changed\s+into|replaced\s+with|set\s+to)\s+"
        rf"[^,.!?;\n]*?(?:{_BG_COLORS_EN})[^,.!?;\n]*?(?=[,.!?;\n]|$)",
        re.IGNORECASE,
    )
    text = en_clause.sub("The background is transparent", text)
    en_phrase = re.compile(
        rf"\b(?:on|against|over|with)\s+(?:a|an|the)\s+(?:[\w-]+\s+){{0,4}}?"
        rf"(?:{_BG_COLORS_EN})\s+(?:colored\s+)?(?:background|backdrop)\b",
        re.IGNORECASE,
    )
    text = en_phrase.sub("on a transparent background", text)
    en_simple = re.compile(
        rf"\b(?:{_BG_COLORS_EN})(?:\s+[\w-]+){{0,4}}\s+(?:background|backdrop)\b", re.IGNORECASE
    )
    return en_simple.sub("transparent background", text)


def _remove_transparent_background_residue(text: str) -> str:
    zh_clause = re.compile(
        rf"(?:^|(?<=[，。；、]))[^，。；\n]*?(?:{_RESIDUE_ZH})[^，。；\n]*(?=[，。；\n]|$)"
    )
    en_clause = re.compile(
        rf"(?:^|(?<=[,.!?;]))[^,.!?;\n]*?(?:\b(?:{_RESIDUE_EN})\b)[^,.!?;\n]*(?=[,.!?;\n]|$)",
        re.IGNORECASE,
    )
    value = en_clause.sub("", zh_clause.sub("", str(text or "")))
    # 删完子句会留下「，，」「. ,」这类断口，收拾干净再拼回。
    value = re.sub(r"[ \t]*([，。；、,.!?;])[ \t]*", r"\1", value)
    value = re.sub(r"([，。；、,.!?;])(?:[，。；、,.!?;])+", r"\1", value)
    value = re.sub(r"([,.!?;])(?=\S)", r"\1 ", value)
    value = re.sub(r"[ \t]{2,}", " ", value)
    return value.strip(" ，。；、,.!?;")


def _force_transparent_text(text: str) -> str:
    value = str(text or "").strip()
    if not value:
        return value
    sink: list = []
    value = _rewrite_background_edit_targets(value, sink)
    value = _rewrite_direct_background_descriptions(value)
    value = _unstash_source_background(value, sink)
    value = _remove_transparent_background_residue(value)
    value = re.sub(r"背景为透明背景", "背景为透明", value)
    value = re.sub(
        rf"transparent background with (?:a |an |the )?(?:{_BG_COLORS_EN})\b",
        "transparent background",
        value,
        flags=re.IGNORECASE,
    )
    return value.strip()


def _rewrite_transparency_request(text: str) -> str:
    """送进模型之前先改用户需求，比事后擦更省 token 也更准。"""
    value = str(text or "").strip()
    if not value:
        return value
    sink: list = []
    value = _rewrite_background_edit_targets(value, sink)
    value = _rewrite_direct_background_descriptions(value)
    return _unstash_source_background(value, sink).strip()


def _apply_transparency(prompt: str) -> str:
    text = str(prompt or "").strip()
    if not text:
        return text
    prefix, suffix = TRANSPARENT_PREFIX.strip(), TRANSPARENT_SUFFIX.strip()
    # 模型自己补过一次前后缀时先剥掉，避免叠加成两遍。
    while text.startswith(prefix):
        text = text[len(prefix):].lstrip()
    while text.endswith(suffix):
        text = text[: -len(suffix)].rstrip()
    text = _force_transparent_text(text)
    if text and text[-1] not in ".。!?！？;；":
        # 清理过程会剥掉句尾标点，中文正文补全角句号，别给中文句子接一个英文句点。
        text += "。" if _CJK_RE.search(text) else "."
    return f"{TRANSPARENT_PREFIX}{text}{TRANSPARENT_SUFFIX}"


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


def _json_object(text: str) -> dict:
    """从回复里抠出那个 JSON 对象；抠不到就返回空 dict，由调用方退回纯文本。"""
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        start, end = text.find("{"), text.rfind("}")
        if not 0 <= start < end:
            return {}
        try:
            data = json.loads(text[start : end + 1])
        except (TypeError, ValueError):
            return {}
    return data if isinstance(data, dict) else {}


def _json_payload(prompt: str, wh_ratio: Any = "", ratio_follow: Any = "") -> str:
    """固定三字段输出，下游解析不用先判断字段在不在。"""
    payload = {
        "rewritten_prompt": prompt,
        "wh_ratio": str(wh_ratio or "").strip(),
        "ratio_follow": str(ratio_follow or "").strip(),
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _split_ratio_trailer(text: str) -> tuple[str, str]:
    """纯文本通道：把最后一行的 RATIO 尾注剥出来当 wh_ratio。"""
    match = _RATIO_LINE_RE.search(text)
    if not match:
        return text.strip(), ""
    ratio = match.group(1).replace("：", ":").replace(" ", "")
    return text[: match.start()].strip(), ratio


def _parse_output(
    text: str, *, transparent: bool = False, structured: bool = False
) -> tuple[str, str]:
    """返回 (提示词正文, 提示词JSON)。structured=True 时按官方 PE 的 JSON 协议解析。"""
    cleaned = _repair_mojibake(_strip_code_fence(text))
    if not cleaned.strip():
        raise ValueError(_EMPTY_REPLY_MESSAGE)
    prompt = wh_ratio = ratio_follow = ""
    if structured:
        data = _json_object(cleaned)
        prompt = str(data.get("rewritten_prompt") or "").strip()
        if prompt:
            wh_ratio, ratio_follow = data.get("wh_ratio"), data.get("ratio_follow")
        else:
            # JSON 被截断或模型换了个纯文本口气：退回原文，别让整条链路报错。
            prompt = cleaned
    else:
        prompt, wh_ratio = _split_ratio_trailer(cleaned)
        prompt = _strip_untagged_reasoning(prompt)
        if prompt.startswith("{"):
            # 有些 API 模型无论如何都会回 JSON，白捡的字段就收下。
            data = _json_object(prompt)
            if str(data.get("rewritten_prompt") or "").strip():
                prompt = str(data["rewritten_prompt"]).strip()
                wh_ratio = wh_ratio or data.get("wh_ratio") or ""
                ratio_follow = data.get("ratio_follow") or ""
    if transparent:
        prompt = _apply_transparency(prompt)
    return prompt, _json_payload(prompt, wh_ratio, ratio_follow)

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


def _mmproj_matches_model(model_name: str, mmproj_name: str) -> bool:
    """公共前缀够长才认为是配套投影，和 _preferred_mmproj 用同一口径。"""
    target = str(model_name or "").casefold()
    name = str(mmproj_name or "").casefold()
    if not target or not name or name.startswith("（"):
        return False
    common = 0
    for a, b in zip(target, name):
        if a != b:
            break
        common += 1
    return common >= 12


def _text_chat_mmproj(model_name: str, mmproj_name: str) -> str:
    """文生图也要一份配套 mmproj：只借它构造关闭思考的 Qwen 聊天模板。

    模型自带模板会开思考，实测同样输入要多花 1000+ token 写英文分析，
    耗时从 38 秒涨到 14 秒以上，还会把中文语言设置淹没。mmproj 在文本任务里
    不上 GPU、也不参与编码，只是提供模板（见 local_llm_worker.load_llm_model）。
    """
    if _valid_model(mmproj_name) and _mmproj_matches_model(model_name, mmproj_name):
        return mmproj_name
    return _preferred_mmproj(_gguf_choices(allow_none=True), model_name)


class _LocalLLMStorage:
    llm = None
    key = None
    context_length = 0

    @classmethod
    def load(cls, model_name: str, mmproj_name: str, context_length: int, text_only: bool = False):
        mmproj = "" if not mmproj_name or mmproj_name == NO_MMPROJ else mmproj_name
        # text_only 会换一套聊天模板（关闭思考），不能和看图用的实例互相复用。
        key = (model_name, mmproj, bool(text_only))
        need = max(512, int(context_length))
        # 参考图张数变了只会抬高需求，已按更大上下文加载过就直接复用，不重复载入权重。
        # 代理被中断/失败回收过就不要再复用：它的管道里可能留着上一轮的响应。
        if (cls.llm is not None and cls.key == key and cls.context_length >= need
                and not getattr(cls.llm, "closed", False)):
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
        llm = LocalLLMProxy(
            model_path,
            mmproj_path,
            need,
            interrupt_check=interrupt_check,
            text_only=bool(text_only),
        )
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
    """本地模型的末位输出约束：别写计划、别翻译，只出正文加最后一行比例。"""
    if language == "英文":
        return (
            "\n\nDo not write any thinking, plan, checklist or analysis. "
            "Start directly with the finished prompt text, then the final RATIO line."
        )
    return (
        "\n\n不要输出任何思考过程、步骤、清单或分析，直接从最终提示词正文开始，"
        "最后另起一行给 RATIO。不要翻译、不要写英文说明。"
    )


def _is_context_overflow(exc: BaseException) -> bool:
    """判断失败是不是 KV 槽位/上下文装不下——只有这类才值得放大 n_ctx 重试。"""
    text = str(exc)
    return any(
        marker in text
        for marker in ("上下文不足", "memory slot", "batch size 1", "Context Shift")
    )


def _request_local_llm(*, model_name, mmproj_name, context_length, system_prompt, user_prompt, max_output_tokens, image_base64_list, text_only=False) -> str:
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
        llm = _LocalLLMStorage.load(model_name, mmproj_name, target, text_only=text_only)
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
                # 纯文本（没接 mmproj）时用的是模型自带 chat 模板，Qwen3.5 默认开思考：
                # 实测同一请求 1536 token 全部花在 Thinking Process 上，耗时 469 秒且没有正文。
                # reasoning_budget=0 直接关掉；旧版 llama.cpp 不认这个参数，由 worker 过滤掉。
                reasoning_budget=0,
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
        except BaseException:
            # 用户取消走的是 BaseException（ComfyUI 的 InterruptProcessingException 不继承 Exception），
            # 这里必须清掉代理缓存，否则下次执行会复用一个管道里留着旧响应的 worker。
            _LocalLLMStorage.unload()
            raise
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


def _valid_model(name: Any) -> bool:
    """下拉框里的「（把权重放到 …）」这类占位项不算选了模型。"""
    text = str(name or "").strip()
    return bool(text) and not text.startswith("（")


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
    llm_t2i_model,
    llm_i2i_model,
    mmproj_model,
    context_length,
    max_output_tokens,
    seed,
    unload,
    transparent,
    direction,
    images,
) -> tuple[str, str, bool]:
    prompt = str(prompt or "")
    method = method if method in (METHOD_API, METHOD_PE, METHOD_LLM) else METHOD_API
    language = language if language in LANGUAGES else "中文"
    language = _resolve_language(language, prompt)
    unload_mode = _coerce_unload(unload)
    transparent = bool(transparent)

    frames = _collect_frames(images)
    task_mode, reverse = _resolve_task(task_mode, frames, prompt)
    if not prompt.strip() and not reverse:
        # 没写字也没接线：原样返回空，别为了报错把整条工作流卡住。
        return "", "", False

    # 反推要把图喂给模型看图写词；图生图要把图当编辑对象。文生图不送图。
    ref_frames = frames if (reverse or task_mode == MODE_I2I) else []

    if reverse:
        user_prompt = REVERSE_USER_PROMPT + _REVERSE_LANG_HINT.get(language, "")
    else:
        request_text = prompt.strip()
        if transparent:
            request_text = _rewrite_transparency_request(request_text)
        user_prompt = _USER_REQUEST_PREFIX + request_text
    user_prompt += _direction_tail(direction)
    if transparent:
        user_prompt += (
            _TRANSPARENT_REVERSE_OVERRIDE if reverse else _TRANSPARENT_REQUEST_OVERRIDE
        ) + _TRANSPARENT_FINAL_CONSTRAINT
    if method != METHOD_PE:
        # 本地PE 的 JSON 协议自带 wh_ratio，只有纯文本通道需要这行尾注。
        user_prompt += _RATIO_TRAILER_FOR.get(language, _RATIO_TRAILER_ZH)
    elif not reverse:
        # 反推已经在上面补过 _REVERSE_LANG_HINT，这里只补文生图/图生图。
        user_prompt += _PE_USER_LANG_HINT.get(language, "")

    if unload_mode == UNLOAD_BEFORE_AFTER:
        _release_models_before_run()

    try:
        if method == METHOD_API:
            raw = _request_api(
                api_base_url=api_base_url or DEFAULT_API_BASE_URL,
                api_key=api_key,
                model=model,
                instructions=_build_api_instructions(task_mode, language, reverse),
                user_prompt=user_prompt,
                image_base64_list=_images_to_jpeg_base64(ref_frames),
            )
        elif method == METHOD_PE:
            # 自动模式下可能从文生图跳到图生图，另一个 PE 模型就是现成的退路。
            primary, backup = (
                (pe_i2i_model, pe_t2i_model) if task_mode == MODE_I2I else (pe_t2i_model, pe_i2i_model)
            )
            model_name = primary if _valid_model(primary) else backup
            if not _valid_model(model_name):
                raise ValueError("请选择本地PE模型，或把 safetensors 放入 models/text_encoders")
            raw = _request_official_pe(
                model_name=model_name,
                system_prompt=_build_official_pe_system(task_mode, language, reverse),
                user_prompt=user_prompt,
                max_output_tokens=max_output_tokens,
                seed=seed,
                images=_pe_reference_images(ref_frames),
            )
        else:
            # 与本地PE 一样「两个任务两个模型」；本地LLM 的分界线是「这次要不要送图」：
            # 图生图和反推都要看图，必须用带视觉投影的那个 GGUF；文生图是纯文本。
            # 自动模式在 _resolve_task 里已经解析成具体任务，反推虽然返回 MODE_T2I
            # 但 ref_frames 非空，所以照样落到图生图模型。
            needs_vision = bool(ref_frames)
            primary, backup = (
                (llm_i2i_model, llm_t2i_model) if needs_vision
                else (llm_t2i_model, llm_i2i_model)
            )
            model_name = primary if _valid_model(primary) else backup
            if not _valid_model(model_name):
                raise ValueError("请选择本地LLM 的 GGUF 模型，或把模型放入 models/text_encoders")
            raw = _request_local_llm(
                model_name=model_name,
                # 文生图也带一份配套 mmproj：只用来构造关闭思考的聊天模板，不送图、不占显存。
                mmproj_name=mmproj_model if needs_vision else _text_chat_mmproj(model_name, mmproj_model),
                context_length=context_length,
                text_only=not needs_vision,
                system_prompt=_build_llm_system(task_mode, language, reverse),
                # 本地模型偶尔先输出一段英文任务解析（"The user's instruction is in Chinese: ..."）
                # 再一路生成到 max_tokens。实测在需求末尾追加这句，同一请求从 56 秒/1536 token
                # 收到 20.6 秒/249 token，且直接给正文。
                user_prompt=user_prompt + _local_output_guard(language),
                max_output_tokens=max_output_tokens,
                image_base64_list=_llm_reference_images(ref_frames),
            )
    except (ValueError, RuntimeError):
        raise
    except Exception as exc:
        raise RuntimeError(f"GG 提示词增强失败：{exc}") from exc
    finally:
        if unload_mode in (UNLOAD_AFTER, UNLOAD_BEFORE_AFTER) or (
            unload_mode == UNLOAD_AUTO and _low_free_memory()
        ):
            # 只放本节点自己加载的 PE / LLM，不动用户的 UNET / CLIP。
            _OfficialPEStorage.unload()
            _LocalLLMStorage.unload()

    text, payload = _parse_output(
        _clean_think_blocks(raw),
        transparent=transparent,
        structured=method == METHOD_PE,
    )
    print(
        f"[GG 提示词增强] {'反推' if reverse else task_mode}完成，提示词 {len(text)} 字",
        flush=True,
    )
    return text, payload, reverse

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
P_LLM_T2I = "文生图LLM模型"
P_LLM_I2I = "图生图LLM模型"
P_LLM_LEGACY = "主模型"  # 老工作流 / 老 API 提交里的名字，只用于兼容读取
P_MMPROJ = "mmproj"
P_CTX = "上下文长度"
P_MAXTOK = "最大生成token"
P_SEED = "seed"
P_UNLOAD = "卸载策略"
# 这两个排在「输入提示词」之后：控件值是按声明下标存的，
# 插在多行文本框前面会把老工作流存的提示词错位到别的控件上。
P_TRANSPARENT = "透明背景"
P_DIRECTION = "增强方向"

OUT_PROMPT = "增强提示词"
OUT_JSON = "提示词JSON"
OUT_REVERSE = "是否反推"


def _run(kwargs: dict) -> tuple[str, str, bool]:
    images = kwargs.get(IMAGE_PREFIX)
    if not isinstance(images, dict):
        images = {
            f"{IMAGE_PREFIX}{i}": kwargs.get(f"{IMAGE_PREFIX}{i}") for i in range(1, MAX_IMAGES + 1)
        }
    return _enhance(
        prompt=kwargs.get(P_PROMPT, ""),
        task_mode=kwargs.get(P_TASK, MODE_AUTO),
        language=kwargs.get(P_LANG, "中文"),
        method=kwargs.get(P_METHOD, METHOD_API),
        api_key=kwargs.get(P_KEY, ""),
        api_base_url=kwargs.get(P_URL, ""),
        model=kwargs.get(P_MODEL, ""),
        pe_t2i_model=kwargs.get(P_PE_T2I, ""),
        pe_i2i_model=kwargs.get(P_PE_I2I, ""),
        # 老存档 / 直接走 API 的旧提交只有「主模型」一个值：两个任务都用它，行为不变。
        llm_t2i_model=kwargs.get(P_LLM_T2I) or kwargs.get(P_LLM_LEGACY, ""),
        llm_i2i_model=kwargs.get(P_LLM_I2I) or kwargs.get(P_LLM_T2I) or kwargs.get(P_LLM_LEGACY, ""),
        mmproj_model=kwargs.get(P_MMPROJ, NO_MMPROJ),
        context_length=kwargs.get(P_CTX, DEFAULT_CONTEXT_LENGTH),
        max_output_tokens=kwargs.get(P_MAXTOK, DEFAULT_MAX_OUTPUT_TOKENS),
        seed=kwargs.get(P_SEED, 0),
        unload=kwargs.get(P_UNLOAD, UNLOAD_AUTO),
        transparent=bool(kwargs.get(P_TRANSPARENT, False)),
        direction=kwargs.get(P_DIRECTION, DIRECTION_NONE),
        images=images,
    )


_DESCRIPTION = (
    "按 Qwen Image 2.1 官方规则增强文生图/图生图提示词，同时输出提示词 JSON（含 wh_ratio / ratio_follow）。"
    "任务模式「自动」：接图且需求留空 = 按图反推；接图且有需求 = 图生图；没接图 = 文生图。"
    "增强方式支持 API / 本地PE / 本地LLM，图生图与反推可接最多 20 张参考图。"
    "本地PE 与本地LLM 都分开指定文生图 / 图生图模型；本地LLM 文生图不加载 mmproj。"
)

def _v3_inputs() -> list:
    pe = _pe_model_choices()
    gguf = _gguf_choices(allow_none=False)
    mmproj = _gguf_choices(allow_none=True)
    llm_t2i, llm_i2i, llm_proj = _gguf_task_defaults(gguf, mmproj)
    return [
        io.Combo.Input(P_TASK, options=list(TASK_MODES), default=MODE_AUTO, tooltip="自动：接图且需求留空=按图反推，接图且有需求=图生图，没接图=文生图。显式选文生图/图生图则完全按所选执行。"),
        io.Combo.Input(P_LANG, options=list(LANGUAGES), default="中文", tooltip="增强提示词的描述语言；自动=跟随用户需求的语言。要求显示在图中的文字始终保持原文。"),        io.Combo.Input(P_METHOD, options=[METHOD_API, METHOD_PE, METHOD_LLM], default=_default_method(pe), tooltip="本地PE=官方 PE 文本编码器，16 秒级且不用 key；本地LLM=GGUF 大模型，通用模型容易把计划写进正文；API=OpenAI 兼容接口。"),
        io.String.Input(P_KEY, default="", tooltip="API Key，仅 API 方式生效。"),
        io.String.Input(P_URL, default=DEFAULT_API_BASE_URL, tooltip="API 调用地址，仅 API 方式生效。"),
        io.String.Input(P_MODEL, default=DEFAULT_API_MODEL, tooltip="API 模型名，仅 API 方式生效。"),
        io.Combo.Input(P_PE_T2I, options=pe, default=_preferred_model(pe, "pe_t2i", "pe-t2i"), tooltip="本地PE 文生图模型（safetensors）；反推也用它。"),
        io.Combo.Input(P_PE_I2I, options=pe, default=_preferred_model(pe, "pe_i2i", "pe-i2i"), tooltip="本地PE 图生图模型（需支持视觉输入）。没选时自动退回文生图模型。"),
        io.Combo.Input(P_LLM_T2I, options=gguf, default=llm_t2i, tooltip="本地LLM 文生图 GGUF 主模型；纯文本任务用，不加载 mmproj。"),
        io.Combo.Input(P_LLM_I2I, options=gguf, default=llm_i2i, tooltip="本地LLM 图生图/反推 GGUF 主模型；这两个任务要送参考图，需配视觉投影 mmproj。"),
        io.Combo.Input(P_MMPROJ, options=mmproj, default=llm_proj, tooltip="本地LLM 视觉投影 mmproj，图生图与反推需要；文生图不使用。"),
        io.Int.Input(P_CTX, default=DEFAULT_CONTEXT_LENGTH, min=512, max=131072, step=512, tooltip="本地LLM 上下文长度。默认 16384 已是最优值；填得比它小会被自动抬回 16384，装不下时还会继续自动放大并重试，一般不用手调。"),
        io.Int.Input(P_MAXTOK, default=DEFAULT_MAX_OUTPUT_TOKENS, min=256, max=32768, step=256, tooltip="最大生成 token。正常输出 250~600 token，默认 1536 已够；本地LLM 方式填更大也只按 1536 执行，避免跑偏时一路生成几十秒。"),
        io.Int.Input(P_SEED, default=0, min=0, max=MAX_SEED, tooltip="本地PE 采样种子；右键控件可切成每次随机。"),
        io.Combo.Input(P_UNLOAD, options=list(UNLOAD_MODES), default=UNLOAD_AUTO, tooltip="自动=显存吃紧时运行后卸载；保持加载=下次更快但占显存；运行前后=跑之前先腾显存，跑完再放掉。"),
        io.String.Input(P_PROMPT, multiline=True, dynamic_prompts=True, placeholder="输入要增强的文生图/图生图需求；接图并留空则按图反推"),
        io.Boolean.Input(P_TRANSPARENT, default=False, tooltip="输出透明背景：自动改写需求里的背景描述，并给提示词套上 RGBA 前后缀，配合去背采样可出透明底图。"),
        io.Combo.Input(P_DIRECTION, options=list(DIRECTIONS), default=DIRECTION_NONE, tooltip="叠加一段画面方向约束（焦段、光位、材质、构图），不改用户明确要求的内容。"),
        io.Autogrow.Input(
            IMAGE_PREFIX,
            template=io.Autogrow.TemplateNames(
                io.Image.Input(IMAGE_PREFIX),
                names=[f"{IMAGE_PREFIX}{i}" for i in range(1, MAX_IMAGES + 1)],
                min=0,
            ),
            tooltip="参考图，接入最后一个后自动增加，最多 20 个；文生图时前端会隐藏。",
        ),
    ]


def _legacy_required() -> dict:
    pe = _pe_model_choices()
    gguf = _gguf_choices(allow_none=False)
    mmproj = _gguf_choices(allow_none=True)
    llm_t2i, llm_i2i, llm_proj = _gguf_task_defaults(gguf, mmproj)
    return {
        P_TASK: (list(TASK_MODES), {"default": MODE_AUTO}),
        P_LANG: (list(LANGUAGES), {"default": "中文"}),
        P_METHOD: ([METHOD_API, METHOD_PE, METHOD_LLM], {"default": _default_method(pe)}),
        P_KEY: ("STRING", {"default": ""}),
        P_URL: ("STRING", {"default": DEFAULT_API_BASE_URL}),
        P_MODEL: ("STRING", {"default": DEFAULT_API_MODEL}),
        P_PE_T2I: (pe, {"default": _preferred_model(pe, "pe_t2i", "pe-t2i")}),
        P_PE_I2I: (pe, {"default": _preferred_model(pe, "pe_i2i", "pe-i2i")}),
        P_LLM_T2I: (gguf, {"default": llm_t2i}),
        P_LLM_I2I: (gguf, {"default": llm_i2i}),
        P_MMPROJ: (mmproj, {"default": llm_proj}),
        P_CTX: ("INT", {"default": DEFAULT_CONTEXT_LENGTH, "min": 512, "max": 131072, "step": 512}),
        P_MAXTOK: ("INT", {"default": DEFAULT_MAX_OUTPUT_TOKENS, "min": 256, "max": 32768, "step": 256}),
        P_SEED: ("INT", {"default": 0, "min": 0, "max": MAX_SEED}),
        P_UNLOAD: (list(UNLOAD_MODES), {"default": UNLOAD_AUTO}),
        P_PROMPT: ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True, "placeholder": "输入要增强的文生图/图生图需求；接图并留空则按图反推"}),
        P_TRANSPARENT: ("BOOLEAN", {"default": False}),
        P_DIRECTION: (list(DIRECTIONS), {"default": DIRECTION_NONE}),
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
                outputs=[
                    io.String.Output(display_name=OUT_PROMPT),
                    io.String.Output(display_name=OUT_JSON, tooltip="含 rewritten_prompt / wh_ratio / ratio_follow，可直接喂给尺寸解析节点。"),
                    io.Boolean.Output(display_name=OUT_REVERSE, tooltip="本次是否走反推（接图且需求留空）。"),
                ],
            )

        @classmethod
        def execute(cls, **kwargs):
            return io.NodeOutput(*_run(kwargs))

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

        RETURN_TYPES = ("STRING", "STRING", "BOOLEAN")
        RETURN_NAMES = (OUT_PROMPT, OUT_JSON, OUT_REVERSE)
        FUNCTION = "enhance"
        CATEGORY = CATEGORY
        DESCRIPTION = _DESCRIPTION

        def enhance(self, **kwargs):
            return _run(kwargs)


NODE_CLASS_MAPPINGS = {
    NODE_ID: GGPromptEnhancer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: DISPLAY_NAME,
}

