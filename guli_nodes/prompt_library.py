"""提示词库：把常用提示词做成可点击的预设，点一下就填进节点文本框。

预设存在 ComfyUI 的 `user/default/gg-prompt-library.json`，跨工作流共享，不是每个节点各存一份；
本模块只负责读写这份文件和提供一个「把文本原样输出」的节点，面板交互与填充规则都在
`web/gg-prompt-library.js`，两边不重复实现同一套逻辑。
"""

import asyncio
import base64
import binascii
import hashlib
import json
import os
import re
import shutil
import threading
import uuid
from pathlib import Path

import folder_paths

try:
    from aiohttp import web
except Exception:
    web = None

try:
    from server import PromptServer
except Exception:
    PromptServer = None


NODE_ID = "GGPromptLibrary"
DISPLAY_NAME = "GG 提示词库"
CATEGORY = "GuliNodes/文本"
PROMPT_NAME = "提示词"

LIBRARY_ROUTE = "/guli/prompt_library"
LIBRARY_FILENAME = "gg-prompt-library.json"
LIBRARY_VERSION = 1

# 预览图：文件存 user/default/gg-prompt-library-previews/<安全目录名>/uuid.ext，
# 库 JSON 里每条预设只存文件名列表（previews 键）。悬浮轮播用的读取路由也在这组。
PREVIEW_ROUTE = "/guli/prompt_library_preview"
MAX_PREVIEWS = 9
MAX_PREVIEW_BYTES = 5 * 1024 * 1024
MIME_EXTENSION = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}
PREVIEW_FILE_RE = re.compile(r"[0-9a-f]{8,32}\.(?:png|jpe?g|webp|gif)\Z")
DATA_URL_RE = re.compile(r"\Adata:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)\Z")

# 颜色只用固定几个键，具体色值由前端映射，避免用户填出看不清的颜色。
COLOR_KEYS = ("rose", "amber", "emerald", "sky", "violet", "slate")
MAX_PRESETS = 500
MAX_NAME_LENGTH = 40
MAX_GROUP_LENGTH = 20
MAX_TEXT_LENGTH = 20000

_WRITE_LOCK = threading.Lock()
_ROUTE_REGISTERED = False

DEFAULT_PRESETS = [
    {
        "id": "lineart-colorize",
        "name": "线稿上色",
        "group": "人物一致性",
        "color": "rose",
        "text": "保持线稿中人物的一致性，帮我上色，生成写实风格。",
    },
    {
        "id": "four-view",
        "name": "四视白底图",
        "group": "人物一致性",
        "color": "rose",
        "text": "生成四视白底图：正视图，半侧视图，侧视图，背视图，保持人物的特征风格一致性。",
    },
    {
        "id": "nine-poses",
        "name": "9 种姿势",
        "group": "人物一致性",
        "color": "rose",
        "text": (
            "保持人物一致性，人物的五官长相身材服饰不要发生任何变化，"
            "设计9种风格各异的姿势，涵盖站立、坐姿、动态动作（如跳跃、挥手）、"
            "静态姿态（如托腮、叉腰）等不同类型。"
        ),
    },
    {
        "id": "photo-restore",
        "name": "老照片修复",
        "group": "人像修复",
        "color": "emerald",
        "text": "保持人物的一致性，帮我修复图中的老照片，修复破损划痕，并且为照片上色。",
    },
    {
        "id": "hd-recover",
        "name": "高清恢复",
        "group": "人像修复",
        "color": "emerald",
        "text": (
            "高清恢复图片，消除像素模糊和色块失真，使插图细节清晰饱满，达到印刷级高清标准，"
            "保持图片一致性。图片为手机实拍女生头像。"
        ),
    },
    {
        "id": "portrait-retouch",
        "name": "人像精修",
        "group": "人像修复",
        "color": "emerald",
        "text": (
            "高分辨率人像，皮肤修饰，去除瑕疵，去除皱纹，平滑皮肤质感，清理毛孔，自然妆容感，"
            "保持原始脸型，保持人物身份，高细节，8K超高清，杰作，无浓妆。"
        ),
    },
    {
        "id": "mini-3d",
        "name": "3D 微缩模型",
        "group": "创意改图",
        "color": "violet",
        "text": (
            "从图像中提取主体并创建五分之一比例的3D模型。将模型放在带圆形透明底座的电脑桌上。"
            "在模型后面，放一个印有模型图像的玩具盒。这个盒子的包装很有趣。"
            "添加一个在背景中显示3D线框模型的计算机屏幕。将整个场景设置在室内。提供明亮、自然的照明。"
        ),
    },
    {
        "id": "deep-rewrite",
        "name": "深度洗图",
        "group": "创意改图",
        "color": "violet",
        "text": (
            "对原图进行深度洗图与重构，整体相似度降至30%；重新规划构图，替换≥70%背景元素，"
            "调整主体角度与光影方向，重塑色彩基调与质感，新增少量合理元素，"
            "同时保留原图核心主体的关键识别特征不丢失；高清精细，无模糊、无噪点、无拼接痕迹。"
            "--no 原图构图、原图背景、原图光影、原图色调、高相似度"
        ),
    },
    {
        "id": "cgi-mannequin",
        "name": "CGI 人体模型",
        "group": "创意改图",
        "color": "violet",
        "text": (
            "提取图中人物姿势转为抽象的CGI人体模型图片，模型人物描绘内容与姿势与原图中人物完全相同。"
            "模型面部表情应抽象化，无头发，且全身赤裸,无道具。模型拥有完美无瑕的灰色皮肤，"
            "其上覆盖着一层黑色线框，且无任何色差。图片背景透明。"
            "请勿包含任何与原图中人物互动相关的物体、道具或场景元素。"
        ),
    },
    {
        "id": "grid-poses",
        "name": "九宫格姿势扩展",
        "group": "创意改图",
        "color": "violet",
        "text": (
            "为图1的女性扩展姿势，画面分割为3*3的格局，用5px的白色填内框充分割线，"
            "拼图内联2px圆角，每个画面平均分配。分别在不同的格局内做出不同的少女摄影写真自然姿势，"
            "可以有NFSW姿势，第一格维持原图，其他的格子中的内容你需要描绘完整，"
            "全部内容需要维持人物面部和服装不变。"
        ),
    },
    {
        "id": "product-studio",
        "name": "产品摄影",
        "group": "产品摄影",
        "color": "sky",
        "text": (
            "产品摄影，纯白背景，影棚灯光，高分辨率，去除背景杂乱，增强产品质感，"
            "干净极简风格，电商标准，8K超高清，焦点清晰。"
        ),
    },
]


def _library_path() -> Path:
    return Path(folder_paths.get_user_directory()) / "default" / LIBRARY_FILENAME


def _previews_root() -> Path:
    return Path(folder_paths.get_user_directory()) / "default" / "gg-prompt-library-previews"


def _preview_dir_name(preset_id) -> str:
    """预设 id → 磁盘目录名。id 来自前端生成或旧库数据，可能带任意字符：
    统一替换成安全字符并追加内容摘要后缀，防目录穿越也防清洗后碰撞。"""
    text = str(preset_id or "").strip()
    if not text or len(text) > 64:
        return ""
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", text)[:48]
    digest = hashlib.md5(text.encode("utf-8")).hexdigest()[:8]
    return f"{safe}-{digest}"


def _preview_dir(preset_id) -> Path | None:
    name = _preview_dir_name(preset_id)
    return _previews_root() / name if name else None


def _prune_orphan_previews(presets: list[dict]) -> None:
    """整库落盘后清理不再被任何预设引用的预览图目录。只动 previews 根目录内部。"""
    root = _previews_root()
    try:
        entries = [entry for entry in root.iterdir() if entry.is_dir()]
    except OSError:
        return
    referenced = {_preview_dir_name(preset.get("id")) for preset in presets}
    for entry in entries:
        if entry.name not in referenced:
            shutil.rmtree(entry, ignore_errors=True)
            if entry.exists():
                for item in entry.iterdir():
                    try:
                        item.unlink()
                    except OSError:
                        pass
                try:
                    entry.rmdir()
                except OSError:
                    pass


def _clean_text(value, limit: int) -> str:
    text = str(value or "").strip()
    return text[:limit]


def _clean_preview_list(raw) -> list[str]:
    """预览图只收我们自己生成的文件名（uuid hex + 白名单扩展名），其余一律丢弃。"""
    files: list[str] = []
    if not isinstance(raw, list):
        return files
    for item in raw[:MAX_PREVIEWS]:
        name = str(item or "").strip().lower()
        if PREVIEW_FILE_RE.fullmatch(name) and name not in files:
            files.append(name)
    return files


def _clean_preset(raw, index: int) -> dict | None:
    if not isinstance(raw, dict):
        return None
    text = _clean_text(raw.get("text"), MAX_TEXT_LENGTH)
    if not text:
        return None
    preset_id = _clean_text(raw.get("id"), 64) or f"preset-{index + 1}"
    color = _clean_text(raw.get("color"), 16)
    return {
        "id": preset_id,
        "name": _clean_text(raw.get("name"), MAX_NAME_LENGTH) or f"预设 {index + 1}",
        "group": _clean_text(raw.get("group"), MAX_GROUP_LENGTH) or "未分类",
        "color": color if color in COLOR_KEYS else "slate",
        "text": text,
        "previews": _clean_preview_list(raw.get("previews")),
    }


def _clean_presets(raw) -> list[dict]:
    if not isinstance(raw, list):
        return []
    presets: list[dict] = []
    seen: set[str] = set()
    for index, item in enumerate(raw[:MAX_PRESETS]):
        preset = _clean_preset(item, index)
        if preset is None:
            continue
        # id 重复时补后缀，前端靠 id 定位卡片
        base_id = preset["id"]
        suffix = 2
        while preset["id"] in seen:
            preset["id"] = f"{base_id}-{suffix}"
            suffix += 1
        seen.add(preset["id"])
        presets.append(preset)
    return presets


def _default_presets() -> list[dict]:
    return _clean_presets(DEFAULT_PRESETS)


def _read_library() -> list[dict]:
    path = _library_path()
    if not path.is_file():
        presets = _default_presets()
        _write_library(presets)
        return presets
    try:
        with open(path, "r", encoding="utf-8") as file:
            payload = json.load(file)
    except (OSError, ValueError) as exc:
        print(f"[GuliNodes] 提示词库读取失败，已回退到默认预设：{exc}")
        return _default_presets()

    presets = _clean_presets(payload.get("presets") if isinstance(payload, dict) else payload)
    return presets


def _write_library(presets: list[dict]) -> None:
    path = _library_path()
    payload = {"version": LIBRARY_VERSION, "presets": presets}
    with _WRITE_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_suffix(".json.tmp")
        with open(temp_path, "w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False, indent=2)
        os.replace(temp_path, path)
        # 库落盘后同步清理孤儿预览图目录；没有引用就说明前端已经把对应预设删掉了
        _prune_orphan_previews(presets)


def _register_library_route() -> None:
    global _ROUTE_REGISTERED
    if (
        _ROUTE_REGISTERED
        or PromptServer is None
        or getattr(PromptServer, "instance", None) is None
        or web is None
    ):
        return

    @PromptServer.instance.routes.get(LIBRARY_ROUTE)
    async def guli_prompt_library_get(request):
        try:
            return web.json_response({"ok": True, "presets": _read_library()})
        except Exception as exc:
            return web.json_response({"ok": False, "message": str(exc)}, status=500)

    @PromptServer.instance.routes.post(LIBRARY_ROUTE)
    async def guli_prompt_library_save(request):
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"ok": False, "message": "请求内容不是合法的 JSON。"}, status=400)

        raw = payload.get("presets") if isinstance(payload, dict) else payload
        presets = _clean_presets(raw)
        if not presets:
            return web.json_response(
                {"ok": False, "message": "至少要保留一条有内容的预设。"}, status=400
            )
        try:
            _write_library(presets)
        except Exception as exc:
            return web.json_response({"ok": False, "message": str(exc)}, status=500)
        return web.json_response({"ok": True, "presets": presets})

    @PromptServer.instance.routes.post(f"{PREVIEW_ROUTE}/{{preset_id}}")
    async def guli_prompt_preview_upload(request):
        """上传一张预览图（dataURL）。文件名后端生成，前端只拿到文件名存进库。"""
        preset_id = request.match_info.get("preset_id", "")
        if not preset_id or len(preset_id) > 64:
            return web.json_response({"ok": False, "message": "预设标识不合法，无法保存预览图。"}, status=400)
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"ok": False, "message": "请求内容不是合法的 JSON。"}, status=400)
        matched = DATA_URL_RE.fullmatch(str(payload.get("image") or "").strip())
        if not matched:
            return web.json_response(
                {"ok": False, "message": "只支持 PNG / JPEG / WEBP / GIF 格式的图片。"}, status=400
            )
        try:
            raw = base64.b64decode(matched.group(2), validate=True)
        except (binascii.Error, ValueError):
            return web.json_response({"ok": False, "message": "图片数据解码失败，请重新选择文件。"}, status=400)
        if not raw:
            return web.json_response({"ok": False, "message": "图片内容为空。"}, status=400)
        if len(raw) > MAX_PREVIEW_BYTES:
            return web.json_response(
                {"ok": False, "message": "预览图不能超过 5MB，请压缩后再添加。"}, status=400
            )
        directory = _preview_dir(preset_id)
        try:
            directory.mkdir(parents=True, exist_ok=True)
            existing = [entry for entry in directory.iterdir() if entry.is_file()]
            if len(existing) >= MAX_PREVIEWS:
                return web.json_response(
                    {"ok": False, "message": f"每个提示词最多 {MAX_PREVIEWS} 张预览图。"}, status=400
                )
            filename = f"{uuid.uuid4().hex}.{MIME_EXTENSION[matched.group(1)]}"
            temp_path = directory / f"{filename}.tmp"
            with open(temp_path, "wb") as file:
                file.write(raw)
            os.replace(temp_path, directory / filename)
        except OSError as exc:
            return web.json_response({"ok": False, "message": f"预览图保存失败：{exc}"}, status=500)
        return web.json_response({"ok": True, "file": filename})

    @PromptServer.instance.routes.get(f"{PREVIEW_ROUTE}/{{preset_id}}/{{filename}}")
    async def guli_prompt_preview_get(request):
        """读取一张预览图。文件名不可变（uuid），可以放心长缓存。"""
        preset_id = request.match_info.get("preset_id", "")
        filename = str(request.match_info.get("filename", "")).lower()
        directory = _preview_dir(preset_id)
        if directory is None or not PREVIEW_FILE_RE.fullmatch(filename):
            return web.json_response({"ok": False, "message": "预览图不存在。"}, status=404)
        path = directory / filename
        try:
            # 双保险：即便文件名将来放开了，也确保解析结果不出预览图根目录
            path.resolve().relative_to(_previews_root().resolve())
        except (ValueError, OSError):
            return web.json_response({"ok": False, "message": "预览图不存在。"}, status=404)
        if not path.is_file():
            return web.json_response({"ok": False, "message": "预览图不存在。"}, status=404)
        return web.FileResponse(
            path, headers={"Cache-Control": "public, max-age=31536000, immutable"}
        )

    @PromptServer.instance.routes.delete(f"{PREVIEW_ROUTE}/{{preset_id}}")
    async def guli_prompt_preview_delete(request):
        """删掉一条预设的预览图目录。只允许删「还没保存进库」的临时目录，
        已保存预设的预览图随整库管理（保存时后端按引用清理）。"""
        preset_id = request.match_info.get("preset_id", "")
        if any(preset.get("id") == preset_id for preset in _read_library()):
            return web.json_response(
                {"ok": False, "message": "该提示词已保存，预览图随整库一起管理。"}, status=400
            )
        directory = _preview_dir(preset_id)
        try:
            if directory is not None and directory.is_dir() and directory.resolve().parent == _previews_root().resolve():
                # Windows 上刚发完的 GET 响应可能还占着句柄，rmtree 会静默失败：
                # 带重试删，最后校验目录真的没了才算成功
                for attempt in range(4):
                    try:
                        shutil.rmtree(directory)
                        break
                    except OSError:
                        await asyncio.sleep(0.15)
                if directory.exists():
                    for entry in directory.iterdir():
                        try:
                            entry.unlink()
                        except OSError:
                            pass
                    try:
                        directory.rmdir()
                    except OSError:
                        pass
                if directory.exists():
                    return web.json_response(
                        {"ok": False, "message": "预览图目录删除失败，文件可能被占用。"}, status=500
                    )
        except OSError:
            pass
        return web.json_response({"ok": True})

    _ROUTE_REGISTERED = True


_register_library_route()


class GGPromptLibrary:
    """承载提示词库面板的节点：面板把预设内容写进 `提示词`，本节点原样输出。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                PROMPT_NAME: (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": False,
                        "tooltip": "点下方预设会自动填到这里；也可以直接手写。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("提示词",)
    FUNCTION = "emit"
    CATEGORY = CATEGORY
    DESCRIPTION = (
        "把常用提示词做成可点击的预设：点一下填进文本框，多个预设自动换行分隔；"
        "预设支持新增、编辑、删除、分类与颜色，存在 user/default/gg-prompt-library.json，跨工作流共享。"
    )

    def emit(self, 提示词=""):
        return (str(提示词 or ""),)


NODE_CLASS_MAPPINGS = {
    NODE_ID: GGPromptLibrary,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: DISPLAY_NAME,
}
