import os
from pathlib import Path

import folder_paths


TXT_NODE_ID = "GGTextFileLoad"
TXT_DISPLAY_NAME = "GG TXT加载"
TXT_CATEGORY = "GuliNodes/文本"
NO_TXT_FILE = "无"
TXT_EXTENSIONS = {".txt", ".md", ".text"}


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
        annotated = folder_paths.get_annotated_filepath(value)
        if annotated and os.path.isfile(annotated):
            return annotated
    except Exception:
        pass

    candidate = Path(folder_paths.get_input_directory()) / value
    return str(candidate) if candidate.is_file() else ""


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


NODE_CLASS_MAPPINGS = {
    TXT_NODE_ID: GGTextFileLoad,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    TXT_NODE_ID: TXT_DISPLAY_NAME,
}
