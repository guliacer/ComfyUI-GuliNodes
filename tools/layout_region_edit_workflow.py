"""重排 GG 人像／背景分区编辑工作流的画布布局。

只改节点 pos / size、分组框 bounding / title、初始视口 extra.ds。
链路、widgets_values、父子关系一律不动，因此不会影响出图结果。

幂等：重复运行结果完全一致，可以随时再跑一遍。
用法：
    python tools/layout_region_edit_workflow.py            # 先看报告，不写盘
    python tools/layout_region_edit_workflow.py --apply    # 实际写入（自动备份）
    python tools/layout_region_edit_workflow.py --check    # 只做重叠／悬空校验
"""
from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMFY_ROOT = ROOT.parent.parent
DEFAULT_WORKFLOW = (
    COMFY_ROOT / "user" / "default" / "workflows" / "GG-人像背景分区编辑_Qwen2.1_Turbo.json"
)

# ── 画布布局表 ────────────────────────────────────────────────────────────
# 列宽统一：区域链每列间距 470，节点左边距 40 的整数倍，保证连线水平。
# (x, y, w, h)，w/h 为 None 表示保留节点原尺寸。
LAYOUT: dict[int, tuple[int, int, int | None, int | None]] = {
    # A 列（x=-500）：自动蒙版 SAM3，纵向一列，输出接到蒙版来源开关
    60: (-500, 100, 420, 90),     # 自动识别人像（关掉=用手绘蒙版）
    58: (-500, 240, 420, 160),    # sam3 模型加载
    59: (-500, 430, 420, 330),    # sam3 文本识别人像
    73: (-500, 800, 420, 180),    # MaskGrow 膨胀（防残影）
    74: (-500, 1010, 420, 150),   # MaskGrow 收缩回边界
    61: (-500, 1200, 420, 120),   # 蒙版来源：自动 / 手绘
    # B 列（x=40）：输入与蒙版
    1: (40, 80, 420, 650),        # LoadImage
    55: (40, 770, 430, 300),      # GGMaskCheck
    2: (40, 1110, 420, 166),      # 共同摄影要求
    54: (40, 1320, 420, 500),     # Note 使用前必读
    # C 列（x=510）：共享模型 + 蒙版诊断
    4: (510, 80, 390, 100),       # UNETLoader
    6: (510, 220, 390, 106),      # GGLoRACustomLoader
    5: (510, 370, 390, 70),       # VAELoader
    56: (510, 490, 470, 540),     # PreviewImage ② 蒙版诊断
    57: (510, 1070, 470, 220),    # GGTextDisplayCopy 诊断说明
}

# 两条区域链共用同一套列偏移，只是纵向起点不同。
REGION_COLUMNS: dict[str, tuple[int, int, int, int]] = {
    # role 后缀: (x, y_offset, w, h)
    "prepare": (1000, 0, 420, 370),      # GGRegionEditPrepare
    "crop": (1470, 0, 410, 300),         # GGMaskCrop
    # GGPromptEnhancer 有 16 个 widget，前端按内容重算后实际高 488（文件里存的 379 是旧值），
    # 所以这里必须按 488 预留，否则下面的 AI 开关会压在它身上。
    "enhance": (1940, 0, 420, 488),      # GGPromptEnhancer
    "prompt_select": (1940, 528, 420, 150),   # ComfySwitchNode AI 开关
    "condition": (2410, 0, 420, 520),    # GGPromptOptimizer
    "prompt_final": (2410, 560, 420, 200),    # GGTextConcat 追加约束
    "vae_encode": (2880, 0, 300, 110),   # VAEEncode
    "latent_mask": (2880, 150, 300, 120),     # SetLatentNoiseMask
    "sample": (3230, 0, 410, 450),       # KSampler（背景）/ 采样组（人像）
    "decode": (3690, 0, 300, 120),       # VAEDecode
    "restore": (4040, 0, 410, 220),      # GGCropRestore
    "select": (4500, 0, 410, 170),       # ComfySwitchNode 需求为空返回原图
}

# 顺序按真实连线来：原图 → 人像分支(30) → 42 → 背景分支(10) → 22 → 保存。
# 人像先跑，所以排在上面；人像分支的采样组更高，背景那行要给足下方空间。
REGION_TOP = {"person": 180, "background": 1080}
# 区域链里 role 后缀 → 节点 id。人像分支的采样在 2026-11 换成了手动 sigma 高级采样，
# 所以 sample 位不是 KSampler，而是 SamplerCustomAdvanced 那一组。
REGION_NODES: dict[str, dict[str, int]] = {
    "background": {
        "prepare": 10, "crop": 11, "enhance": 12, "prompt_select": 13,
        "condition": 15, "prompt_final": 14, "vae_encode": 16, "latent_mask": 17,
        "sample": 18, "decode": 19, "restore": 20, "select": 22,
    },
    "person": {
        "prepare": 30, "crop": 31, "enhance": 32, "prompt_select": 33,
        "condition": 35, "prompt_final": 34, "vae_encode": 36, "latent_mask": 37,
        # sample 与 decode 由 PERSON_SAMPLER_STACK 单独排，见下。
        "restore": 40, "select": 42,
    },
}

# 人像分支用的是手动 sigma 高级采样，一共 5 个节点，占 sample 与 decode 两列。
# (id, x, dy, w, h)；dy 相对 REGION_TOP["person"]。
PERSON_SAMPLER_STACK: list[tuple[int, int, int, int, int]] = [
    (75, 3230, 0, 320, 90),     # RandomNoise 噪声种子
    (76, 3230, 130, 320, 80),   # KSamplerSelect 采样器
    (77, 3230, 250, 390, 70),   # ManualSigmas qwen 手动 sigma 曲线
    (78, 3230, 380, 320, 100),  # BasicGuider 引导（turbo 无 CFG）
    (79, 3690, 0, 340, 110),    # SamplerCustomAdvanced 高级采样本体
    (39, 3690, 150, 300, 120),  # VAEDecode（让开 79 的高度，垂直连线）
]

# F 列（x=5060）：预览与保存，一路向下排成单列，不再撑高画布
PREVIEW_STACK: list[tuple[int, int]] = [
    # (id, y)
    (62, 60),     # ① 原图
    (67, 520),    # ③ 人像结果
    (72, 980),    # ④ 最终结果
    (51, 1420),   # ⑧ 保存 PNG
]

# 分组框：(title, bounding=[x, y, w, h], color)
GROUPS: list[tuple[str, list[int], str]] = [
    ("① 输入原图与蒙版（手绘或自动）", [10, 40, 480, 1810], "#b58b2a"),
    ("①b 自动蒙版 SAM3（关掉开关即用手绘）", [-520, 60, 460, 1310], "#7d6a3a"),
    ("② 共享模型与 VAE", [495, 40, 440, 430], "#346279"),
    ("③ 蒙版诊断（颜色只落在人物上才算涂对）", [495, 470, 500, 850], "#4a7a8c"),
    # 框上沿拉到 30，把悬在上面的「启用 AI 提示词优化」总开关一起圈进来。
    ("④ 先人物：需求清空即整条跳过（顶部是 AI 开关）", [940, 30, 4000, 950], "#815ba6"),
    ("⑤ 后背景：需求清空即整条跳过", [970, 1020, 3970, 990], "#3f789e"),
    ("⑥ 预览与保存", [5030, 20, 620, 1790], "#3f789e"),
]

# 初始视口：打开就落在「输入区 + 背景链」，不用先缩小找画面。
VIEW_SCALE = 0.5
VIEW_OFFSET = [540, 40]


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def build_positions() -> dict[int, tuple[int, int, int | None, int | None]]:
    """把三张表合并成一份 {节点id: (x, y, w, h)}。"""
    table: dict[int, tuple[int, int, int | None, int | None]] = dict(LAYOUT)

    for region, nodes in REGION_NODES.items():
        top = REGION_TOP[region]
        for role, node_id in nodes.items():
            x, dy, w, h = REGION_COLUMNS[role]
            table[node_id] = (x, top + dy, w, h)

    person_top = REGION_TOP["person"]
    for node_id, x, dy, w, h in PERSON_SAMPLER_STACK:
        table[node_id] = (x, person_top + dy, w, h)

    for node_id, y in PREVIEW_STACK:
        table[node_id] = (5060, y, 520, 360 if node_id == 51 else 380)

    return table


def apply_layout(workflow: dict, table: dict) -> list[str]:
    nodes = {n["id"]: n for n in workflow["nodes"]}
    changes: list[str] = []
    missing = [i for i in table if i not in nodes]
    if missing:
        raise SystemExit(f"布局表引用了不存在的节点：{missing}")

    for node_id, (x, y, w, h) in table.items():
        node = nodes[node_id]
        old = (node["pos"][0], node["pos"][1], node["size"][0], node["size"][1])
        node["pos"] = [x, y]
        if w is not None:
            node["size"][0] = w
        if h is not None:
            node["size"][1] = h
        new = (node["pos"][0], node["pos"][1], node["size"][0], node["size"][1])
        if old != new:
            changes.append(f'  {node_id:>3} {node["type"]:<26} {old} → {new}')

    workflow["groups"] = [
        {"id": index + 1, "title": title, "bounding": box, "color": color, "flags": {}}
        for index, (title, box, color) in enumerate(GROUPS)
    ]
    workflow.setdefault("extra", {})["ds"] = {"scale": VIEW_SCALE, "offset": list(VIEW_OFFSET)}
    return changes


def overlaps(workflow: dict) -> list[tuple]:
    nodes = {n["id"]: n for n in workflow["nodes"]}
    ids = sorted(nodes)
    found = []
    for index, a in enumerate(ids):
        ax, ay = nodes[a]["pos"]
        aw, ah = nodes[a]["size"]
        for b in ids[index + 1:]:
            bx, by = nodes[b]["pos"]
            bw, bh = nodes[b]["size"]
            ox = min(ax + aw, bx + bw) - max(ax, bx)
            oy = min(ay + ah, by + bh) - max(ay, by)
            if ox > 4 and oy > 4:
                found.append((a, nodes[a]["type"], b, nodes[b]["type"], round(ox), round(oy)))
    return found


def dangling(workflow: dict) -> list[str]:
    nodes = {n["id"]: n for n in workflow["nodes"]}
    links = {l[0]: l for l in workflow["links"]}
    problems: list[str] = []
    for node in workflow["nodes"]:
        for slot in node.get("inputs", []) or []:
            link_id = slot.get("link")
            if link_id is None:
                continue
            if link_id not in links:
                problems.append(f'{node["id"]}.{slot["name"]} 指向不存在的连线 {link_id}')
                continue
            link = links[link_id]
            if link[3] != node["id"]:
                problems.append(f'{node["id"]}.{slot["name"]} 连线 {link_id} 的目标是 {link[3]}')
        for slot in node.get("outputs", []) or []:
            for link_id in slot.get("links") or []:
                if link_id not in links:
                    problems.append(f'{node["id"]}.{slot["name"]} 指向不存在的连线 {link_id}')
                elif links[link_id][1] != node["id"]:
                    problems.append(f'{node["id"]}.{slot["name"]} 连线 {link_id} 的源头是 {links[link_id][1]}')
    for link_id, link in links.items():
        if link[1] not in nodes or link[3] not in nodes:
            problems.append(f"连线 {link_id} 引用了不存在的节点：{link[1]} → {link[3]}")
    return problems


def bounds(workflow: dict) -> tuple[float, float, float, float]:
    xs = min(n["pos"][0] for n in workflow["nodes"])
    ys = min(n["pos"][1] for n in workflow["nodes"])
    xe = max(n["pos"][0] + n["size"][0] for n in workflow["nodes"])
    ye = max(n["pos"][1] + n["size"][1] for n in workflow["nodes"])
    return xs, ys, xe, ye


def report(workflow: dict, label: str) -> None:
    xs, ys, xe, ye = bounds(workflow)
    print(f"[{label}] 节点 {len(workflow['nodes'])}  连线 {len(workflow['links'])}  "
          f"画布 {round(xe - xs)} x {round(ye - ys)}")
    bad = overlaps(workflow)
    print(f"  重叠：{len(bad)} 处")
    for item in bad:
        print("    ", item)
    issues = dangling(workflow)
    print(f"  悬空引用：{len(issues)} 处")
    for item in issues:
        print("    ", item)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workflow", type=Path, default=DEFAULT_WORKFLOW)
    parser.add_argument("--apply", action="store_true", help="实际写盘（自动生成 .bak 备份）")
    parser.add_argument("--check", action="store_true", help="只校验，不重排")
    args = parser.parse_args()

    workflow = load(args.workflow)
    report(workflow, "重排前")
    if args.check:
        return

    changes = apply_layout(workflow, build_positions())
    print(f"\n改动节点：{len(changes)} 个")
    for line in changes:
        print(line)
    report(workflow, "重排后")

    if not args.apply:
        print("\n未写盘。确认无误后加 --apply：")
        print(f"  python {Path(__file__).name} --apply")
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = args.workflow.with_suffix(args.workflow.suffix + f".bak-layout-{stamp}")
    shutil.copy2(args.workflow, backup)
    temp = args.workflow.with_suffix(args.workflow.suffix + ".tmp")
    temp.write_text(json.dumps(workflow, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(args.workflow)
    print(f"\n已写入 {args.workflow}")
    print(f"备份 {backup}")


if __name__ == "__main__":
    main()
