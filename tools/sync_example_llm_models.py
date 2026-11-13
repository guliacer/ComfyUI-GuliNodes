#!/usr/bin/env python3
"""把正式示例工作流里的 GGPromptEnhancer 规范成「外接 CLIP + 17 位控件」新格式。

背景：本地 LLM 的 PE 模型不再由增强节点内置加载，节点只接收
`文生图PE模型 / 图生图PE模型` 两个 CLIP 类型输入。控件数组因此从 19 位
（含两个 PE 文件名下拉）缩成 17 位；旧 `clip_l.safetensors` 只是 ComfyUI
的默认值，不是 Qwen Image PE，不能拿来自动建 Loader。

同时校验 GGPromptOptimizer 已改为外接 CLIP / VAE 的 3 位格式。

用法：
    W:/AIphotograph/ComfyUI_windows_portable/python_embeded/python.exe \
        tools/sync_example_llm_models.py [--check]

    --check 只报告不写文件，用于回归。

幂等：已经是 17 位、PE 输入已转成 CLIP 端口的节点直接通过。
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
OPTIMIZER = "GGPromptOptimizer"
LEGACY = "主模型"
PE_T2I = "文生图PE模型"
PE_I2I = "图生图PE模型"
T2I = "文生图LLM模型"
I2I = "图生图LLM模型"
UNLOAD = "卸载策略"
LEGACY_UNLOAD = "生成后自动卸载模型"
NEW_COUNT = 17
T2I_INDEX = 6
I2I_INDEX = 7
MMPROJ_INDEX = 8
T2I_GGUF = "Qwen-Image-2.1-PE-T2I.Q5_K_S.gguf"
I2I_GGUF = "Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf"
MMPROJ = "Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf"
UNLOAD_MODES = ("自动", "保持加载", "运行后自动卸载", "运行前后自动卸载")
CANONICAL = (
    "任务模式", "输出语言", "增强方式", "api_key", "api_base_url", "model",
    T2I, I2I, "mmproj", "上下文长度", "最大生成token", "seed",
    "control_after_generate", UNLOAD, "输入提示词", "透明背景", "增强方向",
)
NAMED_REQUIRED = {
    "任务模式", "输出语言", "增强方式", "api_key", "api_base_url", "model",
    T2I, "mmproj", "上下文长度", "最大生成token", "seed", "输入提示词",
}


def is_enhancer(obj: object) -> bool:
    return isinstance(obj, dict) and (
        obj.get("type") == NODE or obj.get("class_type") == NODE
    )


def is_optimizer(obj: object) -> bool:
    return isinstance(obj, dict) and (
        obj.get("type") == OPTIMIZER or obj.get("class_type") == OPTIMIZER
    )


def coerce_control(value: object) -> str:
    if isinstance(value, bool):
        return "fixed" if value else "randomize"
    if isinstance(value, str) and value in ("fixed", "randomize", "increment", "decrement"):
        return value
    return "fixed"


def coerce_unload(value: object) -> str:
    if isinstance(value, bool):
        return "运行后自动卸载" if value else "保持加载"
    if isinstance(value, str) and value in UNLOAD_MODES:
        return value
    return "自动"


def values_from_named(named: object) -> list | None:
    if not isinstance(named, dict):
        return None
    work = dict(named)
    if T2I not in work and LEGACY in work:
        work[T2I] = work[LEGACY]
    if I2I not in work and T2I in work:
        work[I2I] = work[T2I]
    if not NAMED_REQUIRED.issubset(work.keys()):
        return None
    return [
        work.get("任务模式", "自动"),
        work.get("输出语言", "中文"),
        work.get("增强方式", "本地LLM"),
        work.get("api_key", ""),
        work.get("api_base_url", "https://api.deepseek.com"),
        work.get("model", "deepseek-flash"),
        work[T2I], work[I2I],
        work.get("mmproj", MMPROJ),
        work.get("上下文长度", 16384),
        work.get("最大生成token", 1536),
        work.get("seed", 0),
        coerce_control(work.get("control_after_generate")),
        coerce_unload(work.get(UNLOAD, work.get(LEGACY_UNLOAD, "自动"))),
        work.get("输入提示词", ""),
        bool(work.get("透明背景", False)),
        work.get("增强方向", "默认"),
    ]


def looks_like_pe(value: object) -> bool:
    return isinstance(value, str) and value.endswith(".safetensors")


def upgrade_values(values: list, named: object = None) -> list:
    rebuilt = values_from_named(named)
    if rebuilt is not None:
        return rebuilt

    values = list(values)
    if len(values) == NEW_COUNT and not (looks_like_pe(values[6]) and looks_like_pe(values[7])):
        return values
    if len(values) == 19:
        # 0..5 通用控件 / 6,7 PE 文件名 / 8+ 已是 17 位布局。
        out = values[:6] + values[8:]
    elif len(values) == 18:
        # 19 位去掉 seed 的 control_after_generate。
        out = values[:6] + values[8:]
        out.insert(12, "fixed")
    elif len(values) == 17:
        # 17 位但仍是 PE 文件名布局：去掉 PE，再补尾部两个控件。
        out = values[:6] + values[8:]
        out.extend([False, "默认"])
    elif len(values) == 16:
        # 拆双模型之前的旧布局：主模型在 8，PE 在 6/7，尾部缺两个控件。
        out = values[:6] + [values[8], values[8]] + values[9:]
        out.extend([False, "默认"])
    else:
        raise ValueError(f"未识别的 widgets_values 长度 {len(values)}，拒绝猜测")

    if len(out) != NEW_COUNT:
        raise ValueError(f"迁移后长度 {len(out)} != {NEW_COUNT}: {values}")
    out[13] = coerce_unload(out[13])
    return out


def upgrade_inputs(inputs: list) -> list:
    out: list = []
    has_i2i = any(isinstance(i, dict) and i.get("name") == I2I for i in inputs)
    for item in inputs:
        if not isinstance(item, dict):
            out.append(item)
            continue
        name = item.get("name")
        widget_name = (item.get("widget") or {}).get("name")
        if name in (PE_T2I, PE_I2I) or widget_name in (PE_T2I, PE_I2I):
            clone = copy.deepcopy(item)
            clone.pop("widget", None)
            clone["type"] = "CLIP"
            clone["shape"] = 7
            out.append(clone)
        elif name == LEGACY or widget_name == LEGACY:
            first = copy.deepcopy(item)
            first["localized_name"] = T2I
            first["name"] = T2I
            first["widget"] = {"name": T2I}
            out.append(first)
            second = copy.deepcopy(item)
            second["localized_name"] = I2I
            second["name"] = I2I
            second["widget"] = {"name": I2I}
            second["link"] = None
            out.append(second)
            has_i2i = True
        elif name == LEGACY_UNLOAD or widget_name == LEGACY_UNLOAD:
            clone = copy.deepcopy(item)
            clone["localized_name"] = UNLOAD
            clone["name"] = UNLOAD
            clone["type"] = "COMBO"
            clone["widget"] = {"name": UNLOAD}
            out.append(clone)
        else:
            out.append(item)

    existing = {str(i.get("name")) for i in out if isinstance(i, dict)}
    if I2I not in existing and T2I in existing:
        index = next(i for i, item in enumerate(out) if isinstance(item, dict) and item.get("name") == T2I)
        out.insert(index + 1, {
            "localized_name": I2I, "name": I2I, "type": "COMBO",
            "widget": {"name": I2I}, "link": None,
        })
        existing.add(I2I)
    if UNLOAD not in existing:
        index = next((i for i, item in enumerate(out) if isinstance(item, dict) and item.get("name") == "seed"), None)
        stub = {"localized_name": UNLOAD, "name": UNLOAD, "type": "COMBO",
                "widget": {"name": UNLOAD}, "link": None}
        if index is None:
            out.append(stub)
        else:
            out.insert(index + 1, stub)
        existing.add(UNLOAD)
    for new_name, dtype in (("透明背景", "BOOLEAN"), ("增强方向", "COMBO")):
        if new_name not in existing:
            out.append({
                "localized_name": new_name,
                "name": new_name,
                "type": dtype,
                "widget": {"name": new_name},
                "link": None,
            })
            existing.add(new_name)
    return out


def upgrade_properties(props: dict) -> dict:
    if not isinstance(props, dict):
        return props
    out = copy.deepcopy(props)
    ue = out.setdefault("ue_properties", {})
    connectable = ue.setdefault("widget_ue_connectable", {})
    for key in (LEGACY, PE_T2I, PE_I2I, LEGACY_UNLOAD):
        connectable.pop(key, None)
    connectable.setdefault(UNLOAD, True)
    return out


def upgrade_ui_node(node: dict) -> dict:
    """升级单个增强节点，返回 {link_id: 新槽位} 供连线槽位重定向。"""
    values = upgrade_values(node.get("widgets_values") or [], node.get("widgets_values_named"))
    values = list(values)
    if len(values) != NEW_COUNT:
        raise ValueError(f"节点 {node.get('id')} 迁移后长度 {len(values)}")
    values[T2I_INDEX] = T2I_GGUF
    values[I2I_INDEX] = I2I_GGUF
    values[MMPROJ_INDEX] = MMPROJ
    values[13] = coerce_unload(values[13])
    values[15] = False
    values[16] = "默认"
    node["widgets_values"] = values
    if "widgets_values_named" in node:
        node["widgets_values_named"] = dict(zip(CANONICAL, values))

    slot_by_link: dict = {}
    if "inputs" in node:
        old_inputs = node.get("inputs") or []
        new_inputs = upgrade_inputs(old_inputs)
        node["inputs"] = new_inputs
        for index, item in enumerate(new_inputs):
            if isinstance(item, dict) and item.get("link") is not None:
                slot_by_link[item["link"]] = index
    if "properties" in node:
        node["properties"] = upgrade_properties(node["properties"])
    return slot_by_link


def graph_containers(data: dict):
    """顶层 graph + 新版前端的 definitions.subgraphs（子图自带 nodes / links）。"""
    yield data
    definitions = data.get("definitions")
    if isinstance(definitions, dict):
        for subgraph in definitions.get("subgraphs") or []:
            if isinstance(subgraph, dict):
                yield subgraph


def retarget_links(container: dict, node_id: object, slot_by_link: dict) -> int:
    if not slot_by_link:
        return 0
    moved = 0
    for link in container.get("links") or []:
        if isinstance(link, list) and len(link) > 4:
            if link[3] != node_id or link[0] not in slot_by_link:
                continue
            link[4] = slot_by_link[link[0]]
            moved += 1
        elif isinstance(link, dict):
            if link.get("target_id") != node_id or link.get("id") not in slot_by_link:
                continue
            link["target_slot"] = slot_by_link[link["id"]]
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
    if not isinstance(inputs, dict):
        return inputs
    out = dict(inputs)
    out.pop(PE_T2I, None)
    out.pop(PE_I2I, None)
    if LEGACY in out:
        out.pop(LEGACY, None)
    if LEGACY_UNLOAD in out:
        value = out.pop(LEGACY_UNLOAD)
        out[UNLOAD] = "运行后自动卸载" if value else "保持加载"
    out.setdefault(UNLOAD, "自动")
    out.setdefault("透明背景", False)
    out.setdefault("增强方向", "默认")
    return out


def optimizer_problems(container: dict, label: str) -> list[str]:
    found: list[str] = []
    for node in container.get("nodes") or []:
        if not is_optimizer(node):
            continue
        values = node.get("widgets_values") or []
        inputs = node.get("inputs") or []
        names = [item.get("name") for item in inputs if isinstance(item, dict)]
        if len(values) != 3:
            found.append(f"{label} 优化节点 {node.get('id')} widgets_values = {len(values)} 位")
        if names[:7] != ["clip", "正向提示词", "负向提示词", "分辨率", "图像.图像1", "图像.图像2", "vae"]:
            found.append(f"{label} 优化节点 {node.get('id')} 输入顺序不符: {names}")
        if any(name in ("CLIP名称", "CLIP类型", "VAE名称") for name in names):
            found.append(f"{label} 优化节点 {node.get('id')} 仍有内置模型选择器")
    return found


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
        if "clip_l.safetensors" in raw:
            problems.append(f"{path.name} 仍含旧 clip_l.safetensors 默认值")
        upgraded = []
        moved = 0
        for container in graph_containers(data):
            for node in container.get("nodes") or []:
                if not is_enhancer(node):
                    continue
                before = len(node.get("widgets_values") or [])
                slot_by_link = upgrade_ui_node(node)
                moved += retarget_links(container, node.get("id"), slot_by_link)
                values = node.get("widgets_values") or []
                named = node.get("widgets_values_named") or {}
                upgraded.append({"id": node.get("id"), "before": before, "after": len(values)})
                if len(values) != NEW_COUNT:
                    problems.append(f"{path.name} 节点 {node.get('id')} 升级后 {len(values)} 位")
                    continue
                if values[T2I_INDEX] != T2I_GGUF:
                    problems.append(f"{path.name} 节点 {node.get('id')} 文生图模型 = {values[T2I_INDEX]}")
                if values[I2I_INDEX] != I2I_GGUF:
                    problems.append(f"{path.name} 节点 {node.get('id')} 图生图模型 = {values[I2I_INDEX]}")
                if values[MMPROJ_INDEX] != MMPROJ:
                    problems.append(f"{path.name} 节点 {node.get('id')} mmproj = {values[MMPROJ_INDEX]}")
                if any(key in named for key in (LEGACY, PE_T2I, PE_I2I, LEGACY_UNLOAD)):
                    problems.append(f"{path.name} 节点 {node.get('id')} named 仍有旧字段")
                for item in node.get("inputs") or []:
                    if not isinstance(item, dict):
                        continue
                    if item.get("name") in (PE_T2I, PE_I2I):
                        if item.get("type") != "CLIP" or item.get("widget"):
                            problems.append(f"{path.name} 节点 {node.get('id')} PE 输入不是 CLIP 端口")
                    if item.get("name") == LEGACY_UNLOAD:
                        problems.append(f"{path.name} 节点 {node.get('id')} inputs 仍是旧卸载开关")
            problems.extend(link_problems(container, path.name))
            problems.extend(optimizer_problems(container, path.name))
        if not args.check:
            atomic_write(path, dump(path, data, pretty))
        report.append({"file": str(path.relative_to(ROOT)), "nodes": upgraded,
                       "pretty": pretty, "movedLinks": moved})

    for path in API_FILES:
        raw = path.read_text(encoding="utf-8")
        pretty = "\n" in raw[:200]
        data = json.loads(raw)
        if "clip_l.safetensors" in raw or PE_T2I in raw or PE_I2I in raw:
            problems.append(f"{path.name} 仍含旧 PE 模型字段")
        upgraded = []
        for key, value in data.items():
            if not is_enhancer(value):
                continue
            value["inputs"] = upgrade_api_inputs(value.get("inputs"))
            inputs = value["inputs"]
            upgraded.append({
                "id": key,
                "t2i": inputs.get(T2I),
                "i2i": inputs.get(I2I),
                "mmproj": inputs.get("mmproj"),
                "unload": inputs.get(UNLOAD),
            })
            for forbidden in (LEGACY, PE_T2I, PE_I2I, LEGACY_UNLOAD):
                if forbidden in inputs:
                    problems.append(f"{path.name} 节点 {key} 仍含 {forbidden}")
            if inputs.get(UNLOAD) not in UNLOAD_MODES:
                problems.append(f"{path.name} 节点 {key} 卸载策略非法: {inputs.get(UNLOAD)}")
        if not args.check:
            atomic_write(path, dump(path, data, pretty))
        report.append({"file": str(path.relative_to(ROOT)), "nodes": upgraded, "pretty": pretty})

    for item in report:
        for node in item["nodes"]:
            for key in ("t2i", "i2i"):
                if key in node and node[key] not in (T2I_GGUF, I2I_GGUF):
                    problems.append(f"{item['file']} 节点 {node.get('id')} {key} = {node[key]}")

    print(json.dumps({"mode": "check" if args.check else "write", "report": report,
                      "problems": problems}, ensure_ascii=False, indent=2))
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
