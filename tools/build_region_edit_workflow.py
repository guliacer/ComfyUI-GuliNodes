"""按本机节点定义生成 GG 人像/背景分区编辑工作流（不执行模型）。"""
from __future__ import annotations

import argparse
import copy
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = ROOT.parent.parent
OUT = ROOT / "examples" / "workflows" / "GG-人像背景分区编辑_Qwen2.1_Turbo.json"
NODE_TYPES = ["LoadImage", "UNETLoader", "VAELoader", "GGLoRACustomLoader", "GGMaskCrop", "GGCropRestore", "GGImageMergeMask", "GGPromptEnhancer", "GGPromptOptimizer", "GGTextConcat", "ComfySwitchNode", "PrimitiveBoolean", "VAEEncode", "SetLatentNoiseMask", "KSampler", "VAEDecode", "GGImageComparer2", "GGImageCompressSave", "MaskToImage", "PreviewImage", "Note"]
REGION_DEF = {
    "input": {"required": {
        "图像": ["IMAGE", {}], "人像遮罩": ["MASK", {}],
        "处理区域": [["人像", "背景"], {"default": "人像"}],
        "编辑需求": ["STRING", {"default": "", "multiline": True}],
        "全局要求": ["STRING", {"default": "", "multiline": True}],
    }},
    "output": ["IMAGE", "MASK", "STRING", "STRING", "BOOLEAN"],
    "output_name": ["图像", "区域遮罩", "区域请求", "锁定约束", "是否编辑"],
    "python_module": "guli_nodes.region_edit", "display_name": "GG 分区编辑准备",
}


def fetch_defs(url):
    definitions = {}
    for name in NODE_TYPES:
        if name == "Note":
            # Note 是前端虚拟节点，不会出现在后端 object_info。
            definitions[name] = {"input": {"required": {"text": ["STRING", {"default": "", "multiline": True}]}}, "output": [], "output_name": [], "display_name": "备注"}
            continue
        with urllib.request.urlopen(url.rstrip("/") + "/object_info/" + name, timeout=30) as response:
            data = json.load(response)
        if name not in data:
            raise RuntimeError("正在运行的 ComfyUI 中缺少节点：" + name)
        definitions[name] = data[name]
    definitions["GGRegionEditPrepare"] = REGION_DEF
    return definitions


def option(definition, name, suffix, *, fallback=None):
    buckets = definition["input"]
    spec = next((buckets.get(bucket, {})[name] for bucket in ("required", "optional") if name in buckets.get(bucket, {})), None)
    if spec is None:
        raise ValueError("节点定义中没有参数：" + name)
    candidates = spec[0] if isinstance(spec[0], list) else spec[1].get("options", [])
    suffix = suffix.replace("\\", "/")
    for candidate in candidates:
        if str(candidate).replace("\\", "/").endswith(suffix):
            return candidate
    if fallback is not None:
        return fallback
    raise ValueError("节点参数中未找到已核实的模型：" + suffix)


def _kind(spec):
    if isinstance(spec[0], list):
        return "COMBO"
    kind = spec[0]
    if kind == "COMFY_MATCHTYPE_V3":
        return "*"
    return kind


def _default(spec):
    options = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    if "default" in options:
        return options["default"]
    if isinstance(spec[0], list):
        return spec[0][0] if spec[0] else ""
    return {"STRING": "", "BOOLEAN": False, "INT": 0, "FLOAT": 0.0, "COMBO": ""}.get(spec[0], "")


def _dynamic_children(spec, selected):
    config = spec[1] if len(spec) > 1 else {}
    options = config.get("options", [])
    for item in options:
        if isinstance(item, dict) and (item.get("key") == selected or item.get("name") == selected):
            return item.get("inputs", {})
    if isinstance(options, dict):
        item = options.get(selected, {})
        return item.get("inputs", item) if isinstance(item, dict) else {}
    return {}


class Graph:
    def __init__(self, definitions):
        self.defs = definitions
        self.nodes = []
        self.roles = {}
        self.links = []
        self.groups = []

    def node(self, nid, kind, role, title, pos, values=None, *, size=(380, 260), dynamic=None, grow=None, output_type=None):
        definition = self.defs[kind]
        values = dict(values or {})
        inputs = []
        widgets = []
        named = {}

        def add_input(name, spec, optional=False):
            dtype = _kind(spec)
            slot = {"name": name, "type": dtype, "link": None}
            if optional:
                slot["shape"] = 7
            if dtype in {"STRING", "INT", "FLOAT", "BOOLEAN", "COMBO"}:
                slot["widget"] = {"name": name}
                value = values.get(name, _default(spec))
                named[name] = value
                widgets.append(value)
                options = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
                if options.get("control_after_generate"):
                    widgets.append("fixed")
                    named["control_after_generate"] = "fixed"
            inputs.append(slot)

        for bucket in ("required", "optional"):
            for name, spec in definition.get("input", {}).get(bucket, {}).items():
                dtype = _kind(spec)
                if dtype == "COMFY_DYNAMICCOMBO_V3":
                    selected = values[name]
                    inputs.append({"name": name, "type": dtype, "widget": {"name": name}, "link": None})
                    widgets.append(selected)
                    named[name] = selected
                    children = (dynamic or {}).get(name) or _dynamic_children(spec, selected)
                    for child_name, child_spec in children.items():
                        add_input(name + "." + child_name, child_spec, bucket == "optional")
                elif dtype == "COMFY_AUTOGROW_V3":
                    for child_name, child_type in (grow or {}).get(name, []):
                        add_input(name + "." + child_name, [child_type, {}], True)
                else:
                    add_input(name, spec, bucket == "optional")
        outputs = []
        for index, dtype in enumerate(definition.get("output", [])):
            dtype = output_type if dtype in {"COMFY_MATCHTYPE_V3", "*"} and output_type else dtype
            if isinstance(dtype, dict):
                dtype = output_type or "*"
            outputs.append({"name": definition.get("output_name", definition["output"])[index], "type": dtype, "links": []})
        for slot in inputs:
            if slot["type"] in {"*", "COMFY_MATCHTYPE_V3"} and output_type:
                slot["type"] = output_type
        props = {"Node name for S&R": kind, "gg_region_role": role}
        if kind.startswith("GG"):
            props["cnr_id"] = "comfyui-gulinodes"
        else:
            props["cnr_id"] = "comfy-core"
        node = {"id": nid, "type": kind, "title": title, "pos": list(pos), "size": list(size), "flags": {}, "order": len(self.nodes), "mode": 0, "inputs": inputs, "outputs": outputs, "properties": props, "widgets_values": widgets, "widgets_values_named": named}
        if kind == "GGLoRACustomLoader":
            node["widgets_values"].append("新增LoRA")
            node["widgets_values_named"]["新增LoRA"] = "新增LoRA"
        if kind == "GGImageComparer2":
            node["widgets_values"] = [False]
            node["widgets_values_named"] = {"Mode": False}
        self.nodes.append(node)
        self.roles[role] = node
        return node

    def connect(self, source_role, slot, target_role, input_name):
        source = self.roles[source_role]
        target = self.roles[target_role]
        index = next((i for i, x in enumerate(target["inputs"]) if x["name"] == input_name), None)
        if index is None:
            raise ValueError("找不到目标端口：" + target_role + "." + input_name)
        if target["inputs"][index]["link"] is not None:
            raise ValueError("同一输入重复连线：" + target_role + "." + input_name)
        lid = len(self.links) + 1
        dtype = source["outputs"][slot]["type"]
        self.links.append([lid, source["id"], slot, target["id"], index, dtype])
        source["outputs"][slot]["links"].append(lid)
        target["inputs"][index]["link"] = lid

    def group(self, title, box, color):
        self.groups.append({"id": len(self.groups) + 1, "title": title, "bounding": box, "color": color, "flags": {}})

    def export(self):
        return {"id": "ff2efab8-a663-4b23-8f94-64c05ed16101", "revision": 0, "last_node_id": max(x["id"] for x in self.nodes), "last_link_id": len(self.links), "nodes": self.nodes, "links": self.links, "groups": self.groups, "config": {}, "extra": {"ds": {"scale": 0.7, "offset": [40, 100]}, "gg_region_workflow": {"version": 1, "description": "手绘人物蒙版，先背景后人物；清空区域需求即跳过；原蒙版再次限域。"}}, "version": 0.4}


def build(definitions):
    graph = Graph(definitions)
    defs = definitions
    model = option(defs["UNETLoader"], "unet_name", "qwen_image_2.1_turbo_int8_convrot.safetensors")
    vae = option(defs["VAELoader"], "vae_name", "qwen_image_2.1_vae_bf16.safetensors")
    clip = option(defs["GGPromptOptimizer"], "CLIP名称", "qwen3vl_8b_int8_convrot.safetensors")
    lora = option(defs["GGLoRACustomLoader"], "LoRA1名称", "Qwen2.1 一致性无偏移_GH_V1.0.safetensors")
    original = option(defs["LoadImage"], "image", "77d2c42db7b0e56286aec070a54d1437.png", fallback=_default(defs["LoadImage"]["input"]["required"]["image"]))
    shared = "保持原画幅、机位、透视和摄影风格。人物与背景的主光方向、色温和明暗关系协调，不新增人物，不改变构图。"
    graph.node(1, "LoadImage", "original", "① 上传原图／右键画人物蒙版", (40, 80), {"image": original}, size=(420, 650))
    graph.node(2, "GGTextConcat", "global_rules", "共同摄影要求（两区共享）", (40, 820), {"文本1": shared}, size=(420, 260))
    graph.node(3, "PrimitiveBoolean", "enable_ai", "启用 AI 提示词优化（本地LLM）", (970, 65), {"value": False}, size=(380, 100))
    graph.node(4, "UNETLoader", "unet", "Qwen2.1 Turbo 模型", (510, 80), {"unet_name": model, "weight_dtype": "default"}, size=(390, 100))
    graph.node(5, "VAELoader", "vae", "Qwen2.1 VAE", (510, 535), {"vae_name": vae}, size=(390, 70))
    graph.node(6, "GGLoRACustomLoader", "lora", "一致性 LoRA（可设强度 0 禁用）", (510, 250), {"LoRA数量": 1, "LoRA1名称": lora, "LoRA1强度": 1.0}, size=(390, 230))
    graph.connect("unet", 0, "lora", "模型")

    for region, offset, base in (("background", 180, 10), ("person", 1430, 30)):
        label = "背景" if region == "background" else "人像"
        request = "保持场景结构与物体位置，只优化背景的曝光层次、色彩和材质细节，使画面更自然干净。" if region == "background" else "仅优化人物皮肤层次、发丝和服装质感，保留真实自然细节，不改变脸型、身份、姿态、位置、比例和外轮廓。"
        graph.node(base, "GGRegionEditPrepare", region + "_prepare", "② " + label + "修改需求（清空即跳过）", (970, offset), {"处理区域": label, "编辑需求": request}, size=(420, 370))
        crop_values = {"遮罩填充": False, "扩展方式": "四边统一", "扩展方式.扩展系数": 1.1, "输出尺寸": "按宽高", "输出尺寸.宽度": 768, "输出尺寸.高度": 768}
        graph.node(base + 1, "GGMaskCrop", region + "_crop", "③ " + label + "局部裁剪／等比补边", (1450, offset), crop_values, size=(410, 300), dynamic={"扩展方式": {"扩展系数": ["FLOAT", {"default": 1.4}]}, "输出尺寸": {"宽度": ["INT", {"default": 1024}], "高度": ["INT", {"default": 1024}]}})
        enhancer_values = {"任务模式": "图生图", "输出语言": "中文", "增强方式": "本地LLM", "api_key": "", "主模型": option(defs["GGPromptEnhancer"], "主模型", "Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf", fallback="Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf"), "mmproj": option(defs["GGPromptEnhancer"], "mmproj", "Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf", fallback="Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf"), "上下文长度": 8192, "最大生成token": 2048, "生成后自动卸载模型": True, "seed": 12345}
        graph.node(base + 2, "GGPromptEnhancer", region + "_enhance", "可选 AI：单独优化" + label + "请求", (1910, offset), enhancer_values, size=(420, 600), grow={"图片": [("图片1", "IMAGE")]})
        graph.node(base + 3, "ComfySwitchNode", region + "_prompt_select", "AI 开／关：真正跳过未选分支", (1910, offset + 690), size=(420, 150), output_type="STRING")
        graph.node(base + 4, "GGTextConcat", region + "_prompt_final", "优化后追加固定轮廓约束", (2370, offset + 690), size=(420, 220))
        graph.node(base + 5, "GGPromptOptimizer", region + "_condition", "④ Qwen 条件编码（不是文本改写）", (2370, offset), {"CLIP名称": clip, "CLIP类型": "qwen_image", "VAE名称": vae, "分辨率": 0}, size=(420, 520), grow={"图像": [("图像1", "IMAGE")]})
        graph.node(base + 6, "VAEEncode", region + "_vae_encode", "原图像 Latent 编码", (2830, offset), size=(300, 110))
        graph.node(base + 7, "SetLatentNoiseMask", region + "_latent_mask", "采样蒙版：仅当前区域去噪", (2830, offset + 200), size=(300, 120))
        graph.node(base + 8, "KSampler", region + "_sample", "⑤ " + label + "小幅图生图", (3170, offset), {"seed": 246813579 if region == "background" else 246813580, "steps": 9, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 0.45 if region == "background" else 0.25}, size=(410, 450))
        graph.node(base + 9, "VAEDecode", region + "_decode", "VAE 解码", (3620, offset), size=(300, 120))
        graph.node(base + 10, "GGCropRestore", region + "_restore", "⑥ 原坐标还原（不扩大轮廓）", (3970, offset), {"遮罩扩展": 0, "遮罩羽化": 0, "颜色还原": 0.0}, size=(410, 220))
        graph.node(base + 11, "GGImageMergeMask", region + "_merge", "原蒙版再次限域，保护另一部分", (4420, offset), {"透明度": 1.0, "遮罩扩展": 0, "模糊半径": 0, "匹配图像大小": False}, size=(410, 260))
        graph.node(base + 12, "ComfySwitchNode", region + "_select", "需求为空：返回输入原图", (4870, offset), size=(410, 170), output_type="IMAGE")
        pre = region + "_prepare"
        input_role = "original" if region == "background" else "background_select"
        graph.connect(input_role, 0, pre, "图像")
        graph.connect("original", 1, pre, "人像遮罩")
        graph.connect("global_rules", 0, pre, "全局要求")
        graph.connect(pre, 0, region + "_crop", "图像")
        graph.connect(pre, 1, region + "_crop", "遮罩")
        graph.connect(pre, 2, region + "_enhance", "输入提示词")
        graph.connect(pre, 0, region + "_enhance", "图片.图片1")
        graph.connect("enable_ai", 0, region + "_prompt_select", "switch")
        graph.connect(pre, 2, region + "_prompt_select", "on_false")
        graph.connect(region + "_enhance", 0, region + "_prompt_select", "on_true")
        graph.connect(region + "_prompt_select", 0, region + "_prompt_final", "文本1")
        graph.connect(pre, 3, region + "_prompt_final", "文本2")
        graph.connect(region + "_prompt_final", 0, region + "_condition", "正向提示词")
        graph.connect(region + "_crop", 1, region + "_condition", "图像.图像1")
        graph.connect(region + "_crop", 1, region + "_vae_encode", "pixels")
        graph.connect("vae", 0, region + "_vae_encode", "vae")
        graph.connect(region + "_vae_encode", 0, region + "_latent_mask", "samples")
        graph.connect(region + "_crop", 2, region + "_latent_mask", "mask")
        graph.connect("lora", 0, region + "_sample", "model")
        graph.connect(region + "_condition", 0, region + "_sample", "positive")
        graph.connect(region + "_condition", 1, region + "_sample", "negative")
        graph.connect(region + "_latent_mask", 0, region + "_sample", "latent_image")
        graph.connect(region + "_sample", 0, region + "_decode", "samples")
        graph.connect("vae", 0, region + "_decode", "vae")
        graph.connect(region + "_crop", 0, region + "_restore", "接缝")
        graph.connect(region + "_decode", 0, region + "_restore", "裁剪图像")
        graph.connect(input_role, 0, region + "_restore", "背景图像")
        graph.connect(input_role, 0, region + "_merge", "背景图")
        graph.connect(region + "_restore", 0, region + "_merge", "覆盖图")
        graph.connect(pre, 1, region + "_merge", "遮罩")
        graph.connect(pre, 4, region + "_select", "switch")
        graph.connect(pre, 0, region + "_select", "on_false")
        graph.connect(region + "_merge", 0, region + "_select", "on_true")
        graph.group("先" + label + "：清空请求即可跳过整条优化／采样", [930, offset - 50, 4400, 1080], "#3f789e" if region == "background" else "#815ba6")

    graph.node(50, "GGImageComparer2", "compare", "⑦ 最终结果 ↔ 原图", (5420, 180), size=(520, 1000))
    graph.node(51, "GGImageCompressSave", "save", "⑧ 保存 PNG（保留原画幅）", (5420, 1370), {"文件名前缀": "%date:yyyy_MM_dd%/GG_人像背景分区", "格式": "PNG", "清除内存": True}, size=(520, 360))
    graph.node(52, "MaskToImage", "mask_to_image", "检查白色是否只选中了人物", (40, 1150), size=(310, 100))
    graph.node(53, "PreviewImage", "mask_preview", "人物蒙版预览（无模型运算）", (40, 1310), size=(420, 600))
    graph.node(54, "Note", "instructions", "使用前必读", (40, 2030), {"text": "1. 先上传原图，右键加载图像→遮罩编辑器，只涂人物并保存。\n2. 白色=人物；背景会自动反转，不需再画一次。\n3. 编辑需求清空/只留空格=跳过该区域。\n4. AI优化为独立开关；未验证本地模型兼容前保持关闭。\n5. 本版默认768×768等比补边，恢复到原坐标和原画幅。\n6. 最终合成严格按原蒙版限域，人物外轮廓不扩大；人物内部姿态仍依赖模型。\n7. 人像降噪0.25、背景0.45为保守起点，可进一步调低。\n8. 未涂蒙版会中文报错，而不是自动重绘全图。"}, size=(420, 500))
    graph.connect("person_select", 0, "compare", "图像_A")
    graph.connect("original", 0, "compare", "图像_B")
    graph.connect("person_select", 0, "save", "图像")
    graph.connect("original", 1, "mask_to_image", "mask")
    graph.connect("mask_to_image", 0, "mask_preview", "images")
    graph.group("输入与蒙版：不需要SAM3／孤海节点", [10, 30, 460, 2530], "#b58b2a")
    graph.group("共享模型与参数", [485, 30, 430, 660], "#346279")
    graph.group("最终对比与保存", [5390, 130, 580, 1690], "#3f789e")
    return graph.export()


def to_api(workflow):
    api = {}
    links = {l[0]: l for l in workflow["links"]}
    for node in workflow["nodes"]:
        if node["type"] == "Note":
            continue
        inputs = dict(node.get("widgets_values_named", {}))
        inputs.pop("control_after_generate", None)
        inputs.pop("新增LoRA", None)
        inputs.pop("Mode", None)
        for slot in node.get("inputs", []):
            if slot.get("link") is not None:
                edge = links[slot["link"]]
                inputs[slot["name"]] = [str(edge[1]), edge[2]]
        api[str(node["id"])] = {"class_type": node["type"], "inputs": inputs, "_meta": {"title": node["title"]}}
    return api


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8188")
    parser.add_argument("--output", type=Path, default=OUT)
    parser.add_argument("--snapshot", type=Path, default=ROOT / "tools" / "region_edit_schema_snapshot.json")
    parser.add_argument("--from-snapshot", action="store_true")
    args = parser.parse_args()
    definitions = json.loads(args.snapshot.read_text(encoding="utf-8")) if args.from_snapshot else fetch_defs(args.url)
    args.snapshot.parent.mkdir(parents=True, exist_ok=True)
    args.snapshot.write_text(json.dumps(definitions, ensure_ascii=False, indent=2), encoding="utf-8")
    workflow = build(definitions)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(workflow, ensure_ascii=False, indent=2), encoding="utf-8")
    api_path = args.output.with_suffix(".api.json")
    api_path.write_text(json.dumps(to_api(workflow), ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"workflow": str(args.output), "api": str(api_path), "nodes": len(workflow["nodes"]), "links": len(workflow["links"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
