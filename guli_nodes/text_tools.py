import os
from pathlib import Path

import folder_paths


TXT_NODE_ID = "GGTextFileLoad"
TXT_DISPLAY_NAME = "GG TXT加载"
TXT_CATEGORY = "GuliNodes/文本"
NO_TXT_FILE = "无"
TXT_EXTENSIONS = {".txt", ".md", ".text"}

CONCAT_NODE_ID = "GGTextConcat"
CONCAT_DISPLAY_NAME = "GG 文本拼接"
MAX_SLOTS = 20
SLOT_PREFIX = "文本"
SEPARATOR_NAME = "分隔符"
# 默认分隔：换行 + 空白行（两段之间空一行）。
DEFAULT_SEPARATOR = "\n\n"


def _list_txt_files() -> list[str]:
    input_dir = folder_paths.get_input_directory()
    files = []
    if os.path.isdir(input_dir):
        for root, _, names in os.walk(input_dir):
            for name in names:
                if Path(name).suffix.lower() not in TXT_EXTENSIONS:
                    continue
                full_path = Path(root) / name
                try:
                    rel_path = full_path.relative_to(input_dir).as_posix()
                except ValueError:
                    rel_path = name
                files.append(rel_path)
    return [NO_TXT_FILE] + sorted(files)


def _resolve_txt_path(txt_file: str) -> str:
    value = str(txt_file or "").strip()
    if not value or value == NO_TXT_FILE:
        return ""

    try:
        input_dir = Path(folder_paths.get_input_directory()).resolve()
    except Exception:
        return ""

    def resolve_input_file(candidate: str | Path) -> str:
        try:
            resolved = Path(candidate).resolve()
            resolved.relative_to(input_dir)
        except (OSError, ValueError):
            return ""
        return str(resolved) if resolved.is_file() else ""

    try:
        annotated = folder_paths.get_annotated_filepath(value)
        resolved = resolve_input_file(annotated)
        if resolved:
            return resolved
    except Exception:
        pass

    return resolve_input_file(input_dir / value)


def _read_txt_file(path: str) -> str:
    if not path:
        raise FileNotFoundError("未选择 TXT 文件。")
    suffix = Path(path).suffix.lower()
    if suffix not in TXT_EXTENSIONS:
        raise ValueError(f"不支持的文本文件格式：{suffix or path}")

    last_error = None
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            with open(path, "r", encoding=encoding) as file:
                return file.read()
        except UnicodeDecodeError as exc:
            last_error = exc
    raise RuntimeError(f"无法读取文本文件编码：{path}") from last_error


class GGTextFileLoad:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "TXT文件": (_list_txt_files(), {"gg_txt_upload": True}),
            },
        }

    RETURN_TYPES = ("STRING", "TXT", "PATH", "INT")
    RETURN_NAMES = ("文本", "TXT", "路径", "字符数")
    FUNCTION = "load_txt"
    CATEGORY = TXT_CATEGORY
    DESCRIPTION = "从 ComfyUI/input 选择或上传 TXT/MD 文本文件，并输出文本内容。"

    def load_txt(self, TXT文件=NO_TXT_FILE):
        path = _resolve_txt_path(TXT文件)
        text = _read_txt_file(path)
        return (text, text, path, len(text))

    @classmethod
    def IS_CHANGED(cls, TXT文件=NO_TXT_FILE):
        path = _resolve_txt_path(TXT文件)
        if not path or not os.path.isfile(path):
            return TXT文件
        try:
            stat = os.stat(path)
        except OSError:
            return path
        return f"{path}:{stat.st_size}:{stat.st_mtime_ns}"

    @classmethod
    def VALIDATE_INPUTS(cls, TXT文件=NO_TXT_FILE):
        if not TXT文件 or TXT文件 == NO_TXT_FILE:
            return "请选择或上传一个 TXT 文件。"
        suffix = Path(str(TXT文件)).suffix.lower()
        if suffix not in TXT_EXTENSIONS:
            return f"不支持的文本文件格式：{suffix or TXT文件}"
        path = _resolve_txt_path(TXT文件)
        return True if path and os.path.isfile(path) else f"找不到 TXT 文件：{TXT文件}"


def _concat_slot_name(index: int) -> str:
    return f"{SLOT_PREFIX}{index}"


def _clean_part(value) -> str:
    """去掉每段首尾空白，避免和分隔符叠出多余空行；段内换行原样保留。"""
    return str(value or "").strip()


def _separator_text(separator) -> str:
    """默认「换行 + 空白行」；填了自定义分隔符时，让分隔符单独占一行、上下各留一个空白行。"""
    custom = str(separator or "").strip()
    if not custom:
        return DEFAULT_SEPARATOR
    return f"{DEFAULT_SEPARATOR}{custom}{DEFAULT_SEPARATOR}"


def _join_texts(parts, separator="") -> str:
    cleaned = [text for text in (_clean_part(part) for part in parts) if text]
    if not cleaned:
        return ""
    if len(cleaned) == 1:
        return cleaned[0]
    return _separator_text(separator).join(cleaned)


class GGTextConcat:
    """把多段文本按分隔符合并成一段。

    槽位 `文本1` … `文本20` 全部声明成可选：前端只展示「用到最后一个 + 2」个，
    填字或接上线都会自动多出下一个空槽（见 web/gg-text-concat.js）。
    拼接规则只写在这里，前端不重复实现一份。
    """

    @classmethod
    def INPUT_TYPES(cls):
        # 顺序即控件顺序：20 个文本槽在前，分隔符在最后（与 Concatenate Text 一致）。
        optional = {
            _concat_slot_name(index): (
                "STRING",
                {
                    "default": "",
                    "multiline": True,
                    "dynamicPrompts": False,
                    "tooltip": f"第 {index} 段文本；留空会被跳过。",
                },
            )
            for index in range(1, MAX_SLOTS + 1)
        }
        optional[SEPARATOR_NAME] = (
            "STRING",
            {
                "default": "",
                "multiline": False,
                "tooltip": "留空时用「换行 + 空白行」分隔；填写后分隔符单独占一行，上下各留一个空白行。",
            },
        )
        return {"required": {}, "optional": optional}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本",)
    FUNCTION = "concat"
    CATEGORY = TXT_CATEGORY
    DESCRIPTION = (
        f"把最多 {MAX_SLOTS} 段文本按顺序拼成一段：默认用换行 + 空白行分隔，"
        "填了自定义分隔符时让它单独占一行、上下各空一行；空段自动跳过。"
    )

    def concat(self, 分隔符="", **kwargs):
        parts = [kwargs.get(_concat_slot_name(index), "") for index in range(1, MAX_SLOTS + 1)]
        return (_join_texts(parts, 分隔符),)


NODE_CLASS_MAPPINGS = {
    TXT_NODE_ID: GGTextFileLoad,
    CONCAT_NODE_ID: GGTextConcat,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    TXT_NODE_ID: TXT_DISPLAY_NAME,
    CONCAT_NODE_ID: CONCAT_DISPLAY_NAME,
}
