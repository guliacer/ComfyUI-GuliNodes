import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import folder_paths
except Exception:
    folder_paths = None


WEB_AI_PLATFORMS = [
    "豆包",
    "腾讯元宝",
    "文心一言",
    "智谱清言",
    "Kimi",
    "讯飞星火",
    "可灵AI",
    "自定义",
]

DEFAULT_LLM_API_URL = "https://api.openai.com/v1/chat/completions"
DEFAULT_LLM_MODEL = "gpt-4o-mini"
DEFAULT_NOVEL_RULES = """请从小说内容中提取以下信息：
1. 主要人物：姓名、身份、关系、性格特征、当前状态。
2. 关键事件：按发生顺序提取，不遗漏转折点。
3. 场景与设定：地点、势力、世界观、特殊规则、重要物品。
4. 冲突与目标：主线矛盾、人物动机、短期目标、长期目标。
5. 伏笔与线索：已经出现但尚未解决的信息。
6. 情绪与风格：叙事氛围、人物情绪变化、文风特点。"""
DEFAULT_SUMMARY_REQUIREMENTS = """请先给出一段不超过 300 字的整体总结，再按规则分点输出提取结果。
只基于原文内容，不要编造；不确定的信息请标注“原文未明确”。
如果内容适合后续创作，请补充“可延展方向”。"""
NO_TXT_FILE = "无"
TXT_EXTENSIONS = {".txt", ".md", ".text"}


def _clamp_panel_height(节点高度=820) -> int:
    try:
        panel_height = int(节点高度)
    except (TypeError, ValueError):
        panel_height = 820
    return max(360, min(1500, panel_height))


def _stringify_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, dict):
        for key in ("text", "文本", "content", "prompt", "value", "txt", "data"):
            if key in value:
                return _stringify_text(value[key])
        return "\n".join(f"{key}: {_stringify_text(item)}" for key, item in value.items())
    if isinstance(value, (list, tuple, set)):
        return "\n".join(_stringify_text(item) for item in value if item is not None)
    return str(value)


def _parse_api_config(value) -> tuple[str, str, str]:
    if value is None:
        return "", "", ""

    data = value if isinstance(value, dict) else None
    text = "" if data is not None else _stringify_text(value).strip()
    if data is None and text:
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                data = parsed
        except Exception:
            data = None

    if isinstance(data, dict):
        key = _stringify_text(data.get("key") or data.get("api_key") or data.get("API密钥") or data.get("密钥")).strip()
        endpoint = _stringify_text(
            data.get("endpoint")
            or data.get("base_url")
            or data.get("baseUrl")
            or data.get("url")
            or data.get("API端点")
            or data.get("API地址")
            or data.get("端点")
        ).strip()
        model = _stringify_text(
            data.get("model")
            or data.get("model_name")
            or data.get("modelName")
            or data.get("API模型名称")
            or data.get("模型名称")
        ).strip()
        return key, endpoint, model

    return text, "", ""


def _list_txt_files() -> list[str]:
    files = [NO_TXT_FILE]
    if folder_paths is None:
        return files
    try:
        input_dir = folder_paths.get_input_directory()
    except Exception:
        input_dir = ""
    if input_dir and os.path.isdir(input_dir):
        try:
            txt_files = [
                name
                for name in os.listdir(input_dir)
                if os.path.isfile(os.path.join(input_dir, name)) and Path(name).suffix.lower() in TXT_EXTENSIONS
            ]
            files.extend(sorted(txt_files))
        except Exception:
            pass
    return files


def _resolve_txt_path(txt_file: str = "", txt_path: str = "") -> str:
    path_value = str(txt_path or "").strip()
    if path_value:
        candidate = Path(path_value).expanduser()
        if candidate.is_file():
            return str(candidate)

    file_value = str(txt_file or "").strip()
    if not file_value or file_value == NO_TXT_FILE:
        return ""

    if folder_paths is not None:
        try:
            annotated = folder_paths.get_annotated_filepath(file_value)
            if annotated and os.path.isfile(annotated):
                return annotated
        except Exception:
            pass
        try:
            input_candidate = Path(folder_paths.get_input_directory()) / file_value
            if input_candidate.is_file():
                return str(input_candidate)
        except Exception:
            pass

    candidate = Path(file_value).expanduser()
    return str(candidate) if candidate.is_file() else ""


def _read_text_file(path: str) -> str:
    if not path:
        return ""
    if Path(path).suffix.lower() not in TXT_EXTENSIONS:
        raise ValueError(f"不支持的文本文件格式：{path}")
    last_error = None
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            with open(path, "r", encoding=encoding) as file:
                return file.read()
        except UnicodeDecodeError as exc:
            last_error = exc
    raise RuntimeError(f"无法读取文本文件编码：{path}") from last_error


def _txt_file_fingerprint(txt_file: str = "", txt_path: str = "") -> str:
    resolved = _resolve_txt_path(txt_file, txt_path)
    if not resolved or not os.path.isfile(resolved):
        return ""
    try:
        stat = os.stat(resolved)
        return f"{resolved}:{stat.st_size}:{stat.st_mtime_ns}"
    except OSError:
        return resolved


def _clamp_int(value, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))


def _clamp_float(value, default: float, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))


def _select_text(文本="", 文本输入=None, TXT文件=NO_TXT_FILE, TXT路径="") -> str:
    if 文本输入 is not None:
        return _stringify_text(文本输入)
    txt_path = _resolve_txt_path(TXT文件, TXT路径)
    if txt_path:
        return _read_text_file(txt_path)
    return _stringify_text(文本)


def _normalize_chat_api_url(value: str | None = "") -> str:
    api_url = str(value or "").strip() or DEFAULT_LLM_API_URL
    parsed = urllib.parse.urlparse(api_url)
    path = (parsed.path or "").rstrip("/")
    if path.endswith("/chat/completions"):
        return api_url
    if path.endswith("/v1"):
        return api_url.rstrip("/") + "/chat/completions"
    if parsed.scheme and parsed.netloc and not path:
        return api_url.rstrip("/") + "/v1/chat/completions"
    return api_url


def _limit_text(text: str, max_chars: int) -> tuple[str, str]:
    if max_chars <= 0 or len(text) <= max_chars:
        return text, ""
    omitted = len(text) - max_chars
    return text[:max_chars], f"\n\n注意：原文长度超过最大输入字符限制，已从开头截取 {max_chars} 字，省略 {omitted} 字。"


def _compose_novel_prompt(小说内容: str, 提取规则: str, 总结要求: str, 输出格式: str, 截取说明: str = "") -> str:
    format_instruction = {
        "Markdown": "请使用 Markdown 输出，标题清晰，层级不要过深。",
        "JSON": "请只输出合法 JSON，不要包裹 Markdown 代码块。",
        "纯文本": "请使用纯文本输出，结构清晰，便于复制。",
    }.get(输出格式, "请使用 Markdown 输出，标题清晰，层级不要过深。")

    return f"""你需要对一段小说内容进行信息提取和总结。
重要：最终回答必须包含可直接阅读的提取结果和总结，不要只输出思考过程或空内容。

【提取规则】
{提取规则.strip() or DEFAULT_NOVEL_RULES}

【总结要求】
{总结要求.strip() or DEFAULT_SUMMARY_REQUIREMENTS}

【输出格式】
{format_instruction}

【小说内容】
{小说内容}{截取说明}
"""


def _local_clean_llm_text(text: str, keep_think: bool = False) -> str:
    import re

    if not isinstance(text, str) or not text:
        return "" if text is None else str(text)
    cleaned = text.replace("\r\n", "\n")
    if not keep_think and "<channel|>" in cleaned:
        cleaned = re.sub(r"^.*?<channel\|\>\s*", "", cleaned, count=1, flags=re.DOTALL)
    if not keep_think:
        cleaned = re.sub(r"<think\b[^>]*>.*?</think\>", "", cleaned, flags=re.DOTALL | re.IGNORECASE)
        if re.search(r"</think\>", cleaned, flags=re.IGNORECASE):
            cleaned = re.sub(r"^.*?</think\>\s*", "", cleaned, count=1, flags=re.DOTALL | re.IGNORECASE)
    cleaned = re.sub(r"<\|channel\>\s*[\w-]*\s*\n?", "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.replace("<channel|>", "").replace("<|think|>", "").replace("<think", "").replace("</think", "")
    return cleaned.strip()


def _extract_chat_response_text(response) -> str:
    if isinstance(response, dict):
        choices = response.get("choices")
        if isinstance(choices, list) and choices:
            choice = choices[0]
            if isinstance(choice, dict):
                message = choice.get("message")
                if isinstance(message, dict):
                    for key in ("content", "reasoning_content", "reasoning", "thinking", "analysis"):
                        value = message.get(key)
                        if value not in (None, ""):
                            return _stringify_text(value)
                delta = choice.get("delta")
                if isinstance(delta, dict):
                    for key in ("content", "reasoning_content", "reasoning", "thinking", "analysis"):
                        value = delta.get(key)
                        if value not in (None, ""):
                            return _stringify_text(value)
                for key in ("text", "content", "response", "output"):
                    value = choice.get(key)
                    if value not in (None, ""):
                        return _stringify_text(value)
        for key in ("content", "text", "response", "output", "result", "data"):
            value = response.get(key)
            if value not in (None, ""):
                return _stringify_text(value)
    return _stringify_text(response)


def _clean_model_text(text: str, helpers: dict | None = None, keep_think: bool = False) -> str:
    helpers = helpers or {}
    clean = helpers.get("clean")
    if callable(clean):
        return clean(text, 保留think块=bool(keep_think))
    return _local_clean_llm_text(text, keep_think=bool(keep_think))


def _finish_model_text(raw_text: str, cleaned_text: str, raw_response: str, keep_think: bool = False) -> str:
    cleaned = _stringify_text(cleaned_text).lstrip().removeprefix(": ").strip()
    if cleaned:
        return cleaned

    raw = _stringify_text(raw_text).strip()
    if raw:
        if keep_think:
            return raw.lstrip().removeprefix(": ").strip()
        return (
            "【提示】模型返回的可见内容为空，可能是输出只包含 think/推理块，已显示原始返回文本。\n"
            "如果想保留推理内容，请开启“输出think块”；如果想要最终总结，请尝试关闭模型思考模式、增大“最大输出Token”，或让规则明确要求“不要只输出思考过程”。\n\n"
            f"{raw}"
        )

    preview = _stringify_text(raw_response).strip()
    if preview:
        return (
            "【提示】模型已返回响应，但没有解析到可用文本内容。\n"
            "请查看控制台中的模型响应预览，或调整模型/参数后重试。\n\n"
            f"模型响应预览：\n{preview[:1200]}"
        )

    return "【提示】模型没有返回任何文本内容。请检查模型是否支持纯文本对话，或增大“最大输出Token”后重试。"


def _get_dependency_llm_helpers():
    try:
        from guli_nodes_dependency.image_prompt import model_loader

        return {
            "call": model_loader._调用chat_completion,
            "reset": model_loader._重置llm推理状态,
            "clean": model_loader._清洗LLM输出文本,
            "qwen_storage": model_loader._QwenStorage,
            "gemma_storage": model_loader._Gemma4Storage,
        }
    except Exception:
        return {}


def _ensure_local_model_loaded(模型):
    if 模型 is None:
        raise RuntimeError('本地模型模式需要连接"GG 反推模型"节点的模型输出。')

    helpers = _get_dependency_llm_helpers()
    model_family = getattr(模型, "settings", {}).get("family", "")
    storage = None
    if model_family in ["Qwen3-VL", "Qwen3.5-VL"]:
        storage = helpers.get("qwen_storage")
    elif model_family == "Gemma4":
        storage = helpers.get("gemma_storage")

    if storage is not None:
        need_reload = False
        if getattr(storage, "model", None) is None:
            need_reload = True
        elif 模型 is not storage.model:
            if hasattr(模型, "settings") and getattr(模型, "settings") == storage.model.settings:
                模型 = storage.model
            else:
                need_reload = True
        if need_reload:
            if not hasattr(模型, "settings"):
                raise RuntimeError('输入的模型对象缺少配置信息，无法自动重载。请先运行"GG 反推模型"。')
            storage.load(模型.settings)
            模型 = storage.model

    if not hasattr(模型, "llm") or 模型.llm is None:
        raise RuntimeError("模型对象内部 llm 实例无效，请检查模型文件完整性，或重新加载模型。")
    return 模型, helpers


def _call_local_llama_model(模型, 系统提示词: str, 用户提示词: str, 温度, 最大输出Token, top_p采样, top_k采样, 输出think块) -> tuple[str, str]:
    模型, helpers = _ensure_local_model_loaded(模型)
    llm = 模型.llm

    messages = []
    system_text = (系统提示词 or "").strip()
    if system_text:
        messages.append({"role": "system", "content": system_text})
    messages.append({"role": "user", "content": 用户提示词})

    params = {
        "max_tokens": _clamp_int(最大输出Token, 2048, 1, 200000),
        "temperature": _clamp_float(温度, 0.2, 0.0, 2.0),
        "top_p": _clamp_float(top_p采样, 0.9, 0.0, 1.0),
        "top_k": _clamp_int(top_k采样, 20, 0, 200),
        "stream": False,
        "stop": ["</s>"],
    }

    reset = helpers.get("reset")
    if callable(reset):
        reset(llm)

    call_chat = helpers.get("call")
    if callable(call_chat):
        out = call_chat(llm, messages=messages, params=params)
    else:
        out = llm.create_chat_completion(messages=messages, **params)

    raw_response = _stringify_text(out)
    raw_text = _extract_chat_response_text(out)
    cleaned_text = _clean_model_text(raw_text, helpers, keep_think=bool(输出think块))
    text = _finish_model_text(raw_text, cleaned_text, raw_response, keep_think=bool(输出think块))
    print(f"[GG 文本反推] 本地模型响应长度: raw={len(_stringify_text(raw_text))}, cleaned={len(_stringify_text(cleaned_text))}, final={len(text)}")
    return text, raw_response


def _call_openai_compatible_chat(API地址: str, API密钥: str, 模型名称: str, 系统提示词: str, 用户提示词: str, 温度, 最大输出Token, 超时秒) -> tuple[str, str]:
    api_url = _normalize_chat_api_url(API地址)
    model_name = str(模型名称 or DEFAULT_LLM_MODEL).strip()
    if not api_url:
        raise RuntimeError("API地址不能为空。")
    if not model_name:
        raise RuntimeError("模型名称不能为空。")

    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": 系统提示词 or "你是严谨的中文小说内容分析助手。"},
            {"role": "user", "content": 用户提示词},
        ],
        "temperature": _clamp_float(温度, 0.2, 0.0, 2.0),
        "max_tokens": _clamp_int(最大输出Token, 2048, 1, 200000),
    }

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    api_key = str(API密钥 or "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    request = urllib.request.Request(api_url, data=body, headers=headers, method="POST")
    timeout = _clamp_int(超时秒, 120, 5, 600)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw_text = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"大模型请求失败：HTTP {exc.code}\n{error_body[:1200]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"大模型请求失败：{exc}") from exc

    try:
        data = json.loads(raw_text)
        content = _extract_chat_response_text(data)
    except Exception as exc:
        raise RuntimeError(f"无法解析大模型响应：{raw_text[:1200]}") from exc

    summary = _finish_model_text(content, _stringify_text(content).strip(), raw_text, keep_think=True)
    return summary, raw_text


def _build_web_ai_ui(平台="豆包", 自定义网址="", 节点高度=820) -> dict:
    payload = {
        "platform": str(平台 or "豆包"),
        "custom_url": str(自定义网址 or ""),
        "height": _clamp_panel_height(节点高度),
    }
    return {"ui": {"guli_web_ai_reverse": [payload]}}


class GGWebAIReverseImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "平台": (WEB_AI_PLATFORMS, {"default": "豆包"}),
            },
            "optional": {
                "自定义网址": ("STRING", {"default": "", "multiline": False, "dynamicPrompts": False}),
                "节点高度": ("INT", {"default": 1100, "min": 360, "max": 1500, "step": 20}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "open_web"
    CATEGORY = "GuliNodes/AI"
    OUTPUT_NODE = True
    DESCRIPTION = "在节点内打开 AI 平台网页版。"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        m = hashlib.sha256()
        m.update(str(kwargs.get("平台", "豆包")).encode("utf-8"))
        m.update(str(kwargs.get("自定义网址", "")).encode("utf-8"))
        m.update(str(kwargs.get("节点高度", 820)).encode("utf-8"))
        return m.hexdigest()

    def open_web(self, 平台="豆包", 自定义网址="", 节点高度=820):
        return _build_web_ai_ui(平台, 自定义网址, 节点高度)


class GGWebAIReverseText:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "小说内容": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
                "TXT文件": (_list_txt_files(), {"default": NO_TXT_FILE, "defaultInput": True}),
                "提取规则": ("STRING", {"default": DEFAULT_NOVEL_RULES, "multiline": True, "dynamicPrompts": False}),
                "总结要求": ("STRING", {"default": DEFAULT_SUMMARY_REQUIREMENTS, "multiline": True, "dynamicPrompts": False}),
                "输出格式": (["Markdown", "JSON", "纯文本"], {"default": "Markdown"}),
            },
            "optional": {
                "模型": ("GGLLAMA",),
                "文本输入": ("STRING", {"forceInput": True}),
                "TXT路径": ("STRING", {"default": "", "multiline": False, "dynamicPrompts": False}),
                "系统提示词": (
                    "STRING",
                    {
                        "default": "你是严谨的中文小说内容分析助手，擅长从长篇文本中提取人物、剧情、设定、伏笔并进行总结。",
                        "multiline": True,
                        "dynamicPrompts": False,
                    },
                ),
                "最大输出Token": ("INT", {"default": 2048, "min": 1, "max": 200000, "step": 128}),
                "最大输入字符": ("INT", {"default": 12000, "min": 0, "max": 500000, "step": 1000}),
                "温度": ("FLOAT", {"default": 0.2, "min": 0.0, "max": 2.0, "step": 0.05}),
                "top_p采样": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01}),
                "top_k采样": ("INT", {"default": 20, "min": 0, "max": 200, "step": 1}),
                "输出think块": ("BOOLEAN", {"default": False}),
                "API配置": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("提取总结",)
    FUNCTION = "extract_summary"
    CATEGORY = "GuliNodes/AI"
    OUTPUT_NODE = True
    DESCRIPTION = "调用本地 GG 反推模型，按规则提取小说内容并总结。"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        m = hashlib.sha256()
        for name in (
            "小说内容",
            "TXT文件",
            "TXT路径",
            "提取规则",
            "总结要求",
            "输出格式",
            "系统提示词",
            "温度",
            "top_p采样",
            "top_k采样",
            "最大输出Token",
            "最大输入字符",
            "输出think块",
        ):
            m.update(_stringify_text(kwargs.get(name, "")).encode("utf-8"))
        m.update(_stringify_text(kwargs.get("文本输入", "")).encode("utf-8"))
        m.update(hashlib.sha256(_stringify_text(kwargs.get("API配置", "")).encode("utf-8")).hexdigest().encode("utf-8"))
        m.update(_txt_file_fingerprint(kwargs.get("TXT文件", NO_TXT_FILE), kwargs.get("TXT路径", "")).encode("utf-8"))
        model = kwargs.get("模型")
        if model is not None:
            m.update(_stringify_text(getattr(model, "settings", "")).encode("utf-8"))
            m.update(str(id(getattr(model, "llm", model))).encode("utf-8"))
        return m.hexdigest()

    def extract_summary(
        self,
        小说内容="",
        TXT文件=NO_TXT_FILE,
        提取规则=DEFAULT_NOVEL_RULES,
        总结要求=DEFAULT_SUMMARY_REQUIREMENTS,
        输出格式="Markdown",
        模型=None,
        文本输入=None,
        TXT路径="",
        系统提示词="你是严谨的中文小说内容分析助手，擅长从长篇文本中提取人物、剧情、设定、伏笔并进行总结。",
        最大输出Token=2048,
        最大输入字符=12000,
        温度=0.2,
        top_p采样=0.9,
        top_k采样=20,
        输出think块=False,
        API配置=None,
        **kwargs,
    ):
        novel_text = _select_text(小说内容, 文本输入, TXT文件, TXT路径).strip()
        if not novel_text:
            raise RuntimeError("小说内容为空：请填写小说内容、连接文本输入，或选择/填写 TXT 文件。")

        max_input_chars = _clamp_int(最大输入字符, 12000, 0, 500000)
        limited_text, truncate_note = _limit_text(novel_text, max_input_chars)
        rules_text = _stringify_text(提取规则).strip()
        prompt = _compose_novel_prompt(limited_text, rules_text, _stringify_text(总结要求), 输出格式, truncate_note)
        api_key, api_endpoint, api_model_name = _parse_api_config(API配置)
        has_api_config = bool(api_key or api_endpoint or api_model_name)

        local_error = None
        if 模型 is not None:
            try:
                summary, raw_response = _call_local_llama_model(
                    模型,
                    _stringify_text(系统提示词),
                    prompt,
                    温度,
                    最大输出Token,
                    top_p采样,
                    top_k采样,
                    输出think块,
                )
            except Exception as exc:
                local_error = exc
                if not has_api_config:
                    raise
            else:
                return {
                    "ui": {"提取总结": [summary]},
                    "result": (summary,),
                }

        if has_api_config:
            summary, raw_response = _call_openai_compatible_chat(
                api_endpoint,
                api_key,
                api_model_name,
                _stringify_text(系统提示词),
                prompt,
                温度,
                最大输出Token,
                120,
            )
            if local_error is not None:
                summary = f"（本地模型失败，已使用 API 备用。错误：{local_error}）\n\n{summary}"
        else:
            raise RuntimeError('请连接"GG 反推模型"的模型输出；如果要使用 API，请连接"GG 密钥输入"的 API配置输出。')

        return {
            "ui": {"提取总结": [summary]},
            "result": (summary,),
        }


NODE_CLASS_MAPPINGS = {
    "GGWebAIReverseImage": GGWebAIReverseImage,
    "GGWebAIReverseText": GGWebAIReverseText,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GGWebAIReverseImage": "GG 网页AI图像反推",
    "GGWebAIReverseText": "GG 文本反推",
}
