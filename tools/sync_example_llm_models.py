#!/usr/bin/env python3
"""把正式示例工作流里的 GGPromptEnhancer 从旧「主模型」升级成双模型新格式。

背景：本地LLM 拆成「文生图LLM模型 / 图生图LLM模型」之后，节点控件从 16 位变成
19 位（新增图生图模型 + seed 的 control_after_generate 规范化 + 尾部两个控件）。
老示例工作流不升级的话，加载时 mmproj / 输入提示词会整体错位，图生图模型会被
combo 纠正成列表里第一个 GGUF。

用法：
    W:/AIphotograph/ComfyUI_windows_portable/python_embeded/python.exe \
        tools/sync_example_llm_models.py [--check]

    --check 只报告不写文件，用于回归。

幂等：已经是 19 位、已带新字段的节点直接跳过。
"""
from __future__ import annotations

import argparse
import copy
import io
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI_FILES = (
    ROOT / "examples" / "workflows" / "GG-人像背景分区编辑_Qwen2.1_Turbo.json",
    ROOT / "example_workflows" / "人像精修工作流.json",
)
API_FILES = (
    ROOT / "examples" / "workflows" / "GG-人像背景分区编辑_Qwen2.1_Turbo.api.json",
)

NODE = "GGPromptEnhancer"
LEGACY = "主模型"
T2I = "文生图LLM模型"
I2I = "图生图LLM模型"
NEW_COUNT = 19
T2I_GGUF = "Qwen-Image-2.1-PE-T2I.Q5_K_S.gguf"
I2I_GGUF = "Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf"
MMPROJ = "Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf"


def is_enhancer(obj: object) -> bool:
    return isinstance(obj, dict) and (
        obj.get("type") == NODE or obj.get("class_type") == NODE
    )


def upgrade_values(values: list) -> tuple[list, bool]:
    if len(values) >= NEW_COUNT:
        return values, False
    if len(values) != 16:
        raise ValueError(f"未识别的 widgets_values 长度 {len(values)}，拒绝猜测")

    # 旧 16 位：0..8（下标 8 是主模型）、9 mmproj、10 上下文、11 最大token、
    # 12 seed、13 control_after_generate（旧前端存 true/false）、
    # 14 生成后自动卸载模型、15 输入提示词。
    # 新 19 位：在 9 插图生图模型，尾部补「透明背景」「增强方向」。
    out = values[:9] + [values[8]] + values[9:]
    if isinstance(out[14], bool):
        out[14] = "fixed" if out[14] else "randomize"
    if out[15] in (None, "", True, False):
        out[15] = "自动"
    out.extend([False, "默认"])
    if len(out) != NEW_COUNT:
        raise ValueError(f"升级后长度 {len(out)} != {NEW_COUNT}")
    return out, True


def upgrade_named(named: dict) -> tuple[dict, bool]:
    if not isinstance(named, dict) or LEGACY not in named:
        return named, False
    out: dict = {}
    for key, value in named.items():
        if key == LEGACY:
            out[T2I] = value
            out[I2I] = value
        elif key == "control_after_generate":
            out[key] = "fixed" if value is True else ("randomize" if value is False else value)
        elif key == "生成后自动卸载模型":
            out["卸载策略"] = "自动" if value in (None, "", True, False) else value
        else:
            out[key] = value
    out.setdefault("透明背景", False)
    out.setdefault("增强方向", "默认")
    return out, True


def upgrade_inputs(inputs: list) -> tuple[list, bool]:
    if not isinstance(inputs, list):
        return inputs, False
    changed = False
    out: list = []
    for item in inputs:
        name = item.get("name") if isinstance(item, dict) else None
        widget_name = item.get("widget", {}).get("name") if isinstance(item, dict) else None
        if name == LEGACY or widget_name == LEGACY:
            for new_name in (T2I, I2I):
                clone = copy.deepcopy(item)
                clone["localized_name"] = new_name
                clone["name"] = new_name
                clone["widget"] = {"name": new_name}
                clone["link"] = None
                out.append(clone)
            changed = True
        else:
            out.append(item)

    # 老存档没有「透明背景」「增强方向」的控件输入镜像，补在尾部。
    existing = {str(i.get("name")) for i in out if isinstance(i, dict)}
    for new_name, dtype in (("透明背景", "BOOLEAN"), ("增强方向", "COMBO")):
        if new_name not in existing:
            out.append({
                "localized_name": new_name,
                "name": new_name,
                "type": dtype,
                "widget": {"name": new_name},
                "link": None,
            })
            changed = True
    return out, changed


def upgrade_properties(props: dict) -> tuple[dict, bool]:
    if not isinstance(props, dict):
        return props, False
    ue = props.get("ue_properties")
    if not isinstance(ue, dict):
        return props, False
    connectable = ue.get("widget_ue_connectable")
    if not isinstance(connectable, dict) or LEGACY not in connectable:
        return props, False
    out = copy.deepcopy(props)
    table = out["ue_properties"]["widget_ue_connectable"]
    rebuilt: dict = {}
    for key, value in table.items():
        if key == LEGACY:
            rebuilt[T2I] = value
            rebuilt[I2I] = value
        else:
            rebuilt[key] = value
    for key in ("卸载策略", "输入提示词", "透明背景", "增强方向"):
        rebuilt.setdefault(key, True)
    out["ue_properties"]["widget_ue_connectable"] = rebuilt
    return out, True


def upgrade_ui_node(node: dict) -> int | None:
    """升级单个节点，返回旧「主模型」在 inputs 里的下标（供连线槽位平移用）。"""
    legacy_index = None
    for index, item in enumerate(node.get("inputs") or []):
        if isinstance(item, dict) and (
            item.get("name") == LEGACY or item.get("widget", {}).get("name") == LEGACY
        ):
            legacy_index = index
            break

    values, _ = upgrade_values(node.get("widgets_values") or [])
    # 前端的通用老存档迁移保留旧主模型值（行为不变）；正式示例工作流要直接展示
    # 「两个不同模型」的新能力，所以这里显式写成 T2I / I2I 两个 GGUF。
    values[8] = T2I_GGUF
    values[9] = I2I_GGUF
    node["widgets_values"] = values
    if "widgets_values_named" in node:
        named, _ = upgrade_named(node["widgets_values_named"])
        if isinstance(named, dict) and T2I in named:
            named[T2I] = T2I_GGUF
            named[I2I] = I2I_GGUF
        node["widgets_values_named"] = named
    if "inputs" in node:
        node["inputs"], _ = upgrade_inputs(node["inputs"])
    if "properties" in node:
        node["properties"], _ = upgrade_properties(node["properties"])
    return legacy_index


def graph_containers(data: dict):
    """顶层 graph + 新版前端的 definitions.subgraphs（子图自带 nodes / links）。"""
    yield data
    definitions = data.get("definitions")
    if isinstance(definitions, dict):
        for subgraph in definitions.get("subgraphs") or []:
            if isinstance(subgraph, dict):
                yield subgraph


def reindex_links(container: dict, shifts: dict) -> int:
    """「主模型」一项拆成两项后，插入点之后的所有目标槽位都要 +1。

    顶层 links 是 [id, src, ss, dst, ds, type]，子图 links 是
    {id, target_id, target_slot, ...}，两种格式都要处理。
    """
    links = container.get("links")
    if not isinstance(links, list) or not shifts:
        return 0
    moved = 0
    for link in links:
        if isinstance(link, list) and len(link) > 4:
            dst, slot = link[3], link[4]
            index = shifts.get(dst)
            if index is not None and isinstance(slot, int) and slot > index:
                link[4] = slot + 1
                moved += 1
        elif isinstance(link, dict):
            dst, slot = link.get("target_id"), link.get("target_slot")
            index = shifts.get(dst)
            if index is not None and isinstance(slot, int) and slot > index:
                link["target_slot"] = slot + 1
                moved += 1
    return moved


def link_problems(container: dict, label: str) -> list[str]:
    """连线槽位与 inputs[].link 必须双向一致，否则 ComfyUI 读档会丢线。"""
    nodes = {n.get("id"): n for n in container.get("nodes") or [] if isinstance(n, dict)}
    found: list[str] = []
    for link in container.get("links") or []:
        if isinstance(link, list) and len(link) > 4:
            lid, dst, slot = link[0], link[3], link[4]
        elif isinstance(link, dict):
            lid, dst, slot = link.get("id"), link.get("target_id"), link.get("target_slot")
        else:
            continue
        node = nodes.get(dst)
        if node is None:
            continue
        inputs = node.get("inputs") or []
        if not isinstance(slot, int) or slot >= len(inputs) or inputs[slot].get("link") != lid:
            found.append(f"{label} 边 {lid} 槽位不一致: 节点 {dst} 槽 {slot}")
    return found


def upgrade_api_inputs(inputs: dict) -> dict:
    if not isinstance(inputs, dict) or LEGACY not in inputs:
        return inputs
    out: dict = {}
    for key, value in inputs.items():
        if key == LEGACY:
            out[T2I] = T2I_GGUF
            out[I2I] = value if isinstance(value, str) and I2I.upper() in value.upper() else I2I_GGUF
        else:
            out[key] = value
    return out


def dump(path: Path, data: object, pretty: bool) -> str:
    if pretty:
        return json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    # newline="" 阻止 Windows 把 \n 转成 \r\n，保持仓库原本的 LF。
    with io.open(str(tmp), "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    os.replace(str(tmp), str(path))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="只报告，不写文件")
    args = parser.parse_args()

    problems: list[str] = []
    report: list[dict] = []

    for path in UI_FILES:
        raw = path.read_text(encoding="utf-8")
        pretty = "\n" in raw[:200]
        data = json.loads(raw)
        upgraded = []
        shifted = 0
        for container in graph_containers(data):
            shifts: dict = {}
            for node in container.get("nodes") or []:
                if not is_enhancer(node):
                    continue
                before = len(node.get("widgets_values") or [])
                # 所有升级函数都幂等，无条件跑一遍才能把已升级过的示例也钉成正确双模型。
                legacy_index = upgrade_ui_node(node)
                if legacy_index is not None:
                    shifts[node.get("id")] = legacy_index
                after = node.get("widgets_values") or []
                named = node.get("widgets_values_named") or {}
                upgraded.append({
                    "id": node.get("id"), "before": before, "after": len(after),
                    "named_has_legacy": LEGACY in named,
                })
                if len(after) != NEW_COUNT:
                    problems.append(f"{path.name} 节点 {node.get('id')} 升级后 {len(after)} 位")
                else:
                    if after[8] != T2I_GGUF:
                        problems.append(f"{path.name} 节点 {node.get('id')} 文生图模型 = {after[8]}")
                    if after[9] != I2I_GGUF:
                        problems.append(f"{path.name} 节点 {node.get('id')} 图生图模型 = {after[9]}")
                    if after[10] != MMPROJ:
                        problems.append(f"{path.name} 节点 {node.get('id')} mmproj = {after[10]}")
                if LEGACY in named:
                    problems.append(f"{path.name} 节点 {node.get('id')} named 仍含主模型")
                if named and (named.get(T2I) != T2I_GGUF or named.get(I2I) != I2I_GGUF):
                    problems.append(f"{path.name} 节点 {node.get('id')} named 双模型不符")
                for item in node.get("inputs") or []:
                    if isinstance(item, dict) and (item.get("name") == LEGACY or item.get("widget", {}).get("name") == LEGACY):
                        problems.append(f"{path.name} 节点 {node.get('id')} inputs 仍含主模型")
            if shifts:
                shifted += reindex_links(container, shifts)
            problems.extend(link_problems(container, path.name))
        if not args.check:
            atomic_write(path, dump(path, data, pretty))
        report.append({"file": str(path.relative_to(ROOT)), "nodes": upgraded,
                       "pretty": pretty, "shiftedLinks": shifted})

    for path in API_FILES:
        raw = path.read_text(encoding="utf-8")
        pretty = "\n" in raw[:200]
        data = json.loads(raw)
        upgraded = []
        for key, value in data.items():
            if not is_enhancer(value):
                continue
            value["inputs"] = upgrade_api_inputs(value["inputs"])
            upgraded.append({
                "id": key,
                "t2i": value["inputs"].get(T2I),
                "i2i": value["inputs"].get(I2I),
                "mmproj": value["inputs"].get("mmproj"),
            })
            if LEGACY in value["inputs"]:
                problems.append(f"{path.name} 节点 {key} 仍含主模型")
            if value["inputs"].get(T2I) == value["inputs"].get(I2I):
                problems.append(f"{path.name} 节点 {key} 两个模型相同")
        if not args.check:
            atomic_write(path, dump(path, data, pretty))
        report.append({"file": str(path.relative_to(ROOT)), "nodes": upgraded, "pretty": pretty})

    # 默认模型常量与后端 /object_info 对齐（脚本不联网，用已知文件名核对）
    for item in report:
        for node in item["nodes"]:
            for key in ("t2i", "i2i"):
                if key in node and node[key] not in (T2I_GGUF, I2I_GGUF):
                    problems.append(f"{item['file']} 节点 {node.get('id')} {key} = {node[key]}")

    print(json.dumps({"mode": "check" if args.check else "write", "report": report, "problems": problems},
                     ensure_ascii=False, indent=2))
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
