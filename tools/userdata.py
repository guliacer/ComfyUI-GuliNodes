"""GuliNodes 用户数据盘点与备份工具。

GuliNodes 的所有用户自定义数据都存在 ComfyUI 用户区（升级插件、整目录覆盖都不会碰到）：
  - user/default/comfy.settings.json 里的 GuliNodes.* 键（API 密钥、工具栏/节点外观等偏好）
  - user/default/gg-prompt-library.json（提示词库预设）

浏览器 localStorage 里的旧数据由前端存储桥（web/gg-userdata-store.js）在启动时自动
迁移到 settings，本工具只负责文件侧的盘点与备份。

用法：
  python tools/userdata.py info      # 数据在哪、各部分多大
  python tools/userdata.py backup    # 打 zip 到用户区，升级前跑一次最稳
"""

import json
import sys
import time
import zipfile
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = PLUGIN_ROOT.parents[1]

PROMPT_LIBRARY_FILE = "gg-prompt-library.json"
BACKUP_DIRNAME = "GuliNodes-backup"
SECRET_HINT_KEYS = ("key", "token", "secret", "密钥", "令牌")


def settings_path() -> Path:
    """优先用 ComfyUI 运行时同款逻辑定位 user 目录，失败再按目录结构推断。"""
    try:
        sys.path.insert(0, str(COMFY_ROOT))
        import folder_paths

        return Path(folder_paths.get_user_directory()) / "default" / "comfy.settings.json"
    except Exception:
        return COMFY_ROOT / "user" / "default" / "comfy.settings.json"


def user_default_dir() -> Path:
    return settings_path().parent


def collect_guli_settings(settings: dict) -> dict:
    return {k: v for k, v in settings.items() if k.startswith("GuliNodes")}


def _looks_secret(key: str) -> bool:
    lowered = key.lower()
    return any(hint in lowered for hint in SECRET_HINT_KEYS)


def _human_size(num: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if num < 1024 or unit == "GB":
            return f"{num:.1f} {unit}" if unit != "B" else f"{int(num)} B"
        num /= 1024
    return f"{num:.1f} GB"


def cmd_info() -> int:
    spath = settings_path()
    print(f"用户区目录: {user_default_dir()}")
    if not spath.is_file():
        print("settings 文件不存在（还没跑过 ComfyUI？）")
        settings = {}
    else:
        try:
            settings = json.loads(spath.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"settings 读取失败: {exc}")
            return 1

    guli = collect_guli_settings(settings)
    print(f"\n[设置键] comfy.settings.json 中 GuliNodes.* 共 {len(guli)} 项：")
    total = 0
    for key in sorted(guli):
        blob = json.dumps(guli[key], ensure_ascii=False)
        total += len(blob.encode("utf-8"))
        tag = "（含密钥，勿外传）" if _looks_secret(key) else ""
        print(f"  {key}  {_human_size(len(blob.encode('utf-8')))} {tag}")
    print(f"  小计: {_human_size(total)}")

    lib = user_default_dir() / PROMPT_LIBRARY_FILE
    if lib.is_file():
        size = lib.stat().st_size
        try:
            count = len(json.loads(lib.read_text(encoding="utf-8")).get("presets", []))
        except (OSError, ValueError):
            count = "?"
        print(f"\n[提示词库] {lib}  {_human_size(size)}  预设 {count} 条")
    else:
        print(f"\n[提示词库] {lib} 不存在（首次使用提示词库后生成）")

    print("\n浏览器 localStorage 中的旧数据由前端存储桥自动迁移到设置键，无需手动处理。")
    return 0


def cmd_backup() -> int:
    spath = settings_path()
    try:
        settings = json.loads(spath.read_text(encoding="utf-8")) if spath.is_file() else {}
    except (OSError, ValueError) as exc:
        print(f"settings 读取失败: {exc}")
        return 1

    guli = collect_guli_settings(settings)
    out_dir = user_default_dir() / BACKUP_DIRNAME
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    zip_path = out_dir / f"GuliNodes-{stamp}.zip"

    files: list[tuple[Path, str]] = []
    if spath.is_file():
        files.append((spath, "comfy.settings.json"))
    lib = user_default_dir() / PROMPT_LIBRARY_FILE
    if lib.is_file():
        files.append((lib, PROMPT_LIBRARY_FILE))

    if not files:
        print("没有可备份的用户数据文件。")
        return 1

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for src, arcname in files:
            zf.write(src, arcname)
        zf.writestr(
            "GuliNodes-settings-only.json",
            json.dumps(guli, ensure_ascii=False, indent=2),
        )

    print(f"备份完成: {zip_path}  {_human_size(zip_path.stat().st_size)}")
    print(f"  包含 {len(files)} 个文件 + GuliNodes 设置键 {len(guli)} 项")
    print("  注意: 备份里可能包含 API 密钥，请像保管密码一样保管这个 zip。")
    return 0


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "info"
    if cmd == "info":
        return cmd_info()
    if cmd == "backup":
        return cmd_backup()
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
