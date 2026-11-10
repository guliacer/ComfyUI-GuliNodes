# -*- coding: utf-8 -*-
"""GG 智能人脸美化：真机参数扫描 + 客观指标评分 + 默认参数标定。

用法（在插件根目录）：
  python_embeded/python.exe tools/tune_face_beauty.py --mode baseline
  python_embeded/python.exe tools/tune_face_beauty.py --mode sweep
  python_embeded/python.exe tools/tune_face_beauty.py --mode sweep --set 自动磨皮=60,遮罩羽化=10

输出：tools/out/face_tune/<tag>/result.png / mask.png / metrics.json / contact_sheet.png
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

HOST = "http://127.0.0.1:8188"
ROOT = Path(__file__).resolve().parents[1]
COMFY = ROOT.parents[1]
COMFY_OUT = COMFY / "output"
SOURCE = COMFY / "input" / "clipboard-2026-11-04T09-26-37-794Z-49706998.jpg"
OUT = ROOT / "tools" / "out" / "face_tune"
CKPT = "sam3.1_multiplex_comfy.safetensors"
IMAGE_NAME = SOURCE.name

# 第二轮最终默认值（与 INPUT_TYPES / 示例工作流 widgets_values 完全一致）
BASELINE = {
    "自动磨皮": 75,
    "自动美白皮肤": 45,
    "眼白提亮": 20,
    "眼睛大小": 0,
    "牙齿美白": 0,
    "自动瘦脸": 0,
    "脸部扩展": 1.35,
    "检测灵敏度": 45,
    "人脸识别方式": "SAM3",
    "检测提示词": "face:4",
    "SAM3阈值": 0.5,
    "SAM3精修": 2,
    "遮罩收缩": 0,
    "遮罩羽化": 6.0,
}

# 扫描网格：每条只覆盖 BASELINE 里点名的字段，其余沿基线。
# 目的不是穷举，而是把「磨过头 / 遮罩带头发 / 瘦脸变形 / 美白过曝」四类问题分开定位。
CASES = [
    ("base", {}),
    ("skin_45", {"自动磨皮": 45}),
    ("skin_85", {"自动磨皮": 85}),
    ("white_25", {"自动美白皮肤": 25}),
    ("white_60", {"自动美白皮肤": 60}),
    ("slim_0", {"自动瘦脸": 0}),
    ("slim_55", {"自动瘦脸": 55}),
    ("mask_shrink6", {"遮罩收缩": 6}),
    ("mask_shrink12", {"遮罩收缩": 12}),
    ("feather_14", {"遮罩羽化": 14.0}),
    ("thresh_035", {"SAM3阈值": 0.35}),
    ("thresh_065", {"SAM3阈值": 0.65}),
    ("expand_12", {"脸部扩展": 1.2}),
    ("gentle", {"自动磨皮": 55, "自动美白皮肤": 30, "自动瘦脸": 20,
                "遮罩收缩": 4, "遮罩羽化": 10.0, "SAM3阈值": 0.45}),
    ("balanced", {"自动磨皮": 60, "自动美白皮肤": 32, "自动瘦脸": 25,
                  "遮罩收缩": 5, "遮罩羽化": 12.0, "SAM3阈值": 0.45,
                  "眼白提亮": 20}),
    # 检测路径探针：先确认遮罩框住的是不是整张脸，再谈美化强度
    ("builtin", {"人脸识别方式": "内置检测"}),
    ("prompt_face", {"检测提示词": "face"}),
    ("prompt_face1", {"检测提示词": "face:1"}),
    ("prompt_humanface", {"检测提示词": "human face"}),
    ("refine_0", {"SAM3精修": 0}),
    ("refine_4", {"SAM3精修": 4}),
    ("threshold_02", {"SAM3阈值": 0.2}),
    ("threshold_08", {"SAM3阈值": 0.8}),
]


def post(path: str, payload: dict) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        HOST + path, data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get(path: str) -> dict:
    with urllib.request.urlopen(HOST + path, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def build_prompt(params: dict, tag: str) -> dict:
    inputs = {
        "图像": ["1", 0],
        "模型": ["13", 0],
        "CLIP": ["13", 1],
        **params,
    }
    prefix = f"gg_face_tune/{tag}"
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": IMAGE_NAME}},
        "13": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "2": {"class_type": "GGFaceSmartBeauty", "inputs": inputs},
        "4": {"class_type": "MaskToImage", "inputs": {"mask": ["2", 1]}},
        "5": {"class_type": "SaveImage", "inputs": {
            "images": ["2", 0], "filename_prefix": prefix + "/result"}},
        "7": {"class_type": "SaveImage", "inputs": {
            "images": ["4", 0], "filename_prefix": prefix + "/mask"}},
    }


def wait_prompt(prompt_id: str, timeout: int = 900) -> dict:
    start = time.time()
    while time.time() - start < timeout:
        history = get(f"/history/{prompt_id}")
        entry = history.get(prompt_id)
        if entry:
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                raise RuntimeError(json.dumps(status, ensure_ascii=False)[:1600])
            if entry.get("outputs") or status.get("completed"):
                return entry
        time.sleep(1.0)
    raise TimeoutError(f"prompt {prompt_id} 超过 {timeout}s")


def collect(entry: dict, dest: Path) -> dict:
    dest.mkdir(parents=True, exist_ok=True)
    files = {}
    for node_id, label in (("5", "result"), ("7", "mask")):
        images = entry.get("outputs", {}).get(node_id, {}).get("images", [])
        if not images:
            continue
        info = images[0]
        path = COMFY_OUT / info.get("subfolder", "") / info["filename"]
        if path.exists():
            target = dest / f"{label}.png"
            target.write_bytes(path.read_bytes())
            files[label] = target
    return files


def analyze(source_path: Path, result_path: Path, mask_path: Path) -> dict:
    import cv2
    import numpy as np
    from PIL import Image

    src = np.asarray(Image.open(source_path).convert("RGB"), dtype=np.float32)
    res = np.asarray(Image.open(result_path).convert("RGB"), dtype=np.float32)
    msk = np.asarray(Image.open(mask_path).convert("L"), dtype=np.float32) / 255.0
    if msk.shape != src.shape[:2]:
        msk = cv2.resize(msk, (src.shape[1], src.shape[0]), interpolation=cv2.INTER_LINEAR)
    if res.shape != src.shape:
        res = cv2.resize(res, (src.shape[1], src.shape[0]), interpolation=cv2.INTER_LINEAR)

    h, w = src.shape[:2]
    gray_s = cv2.cvtColor(src.astype(np.uint8), cv2.COLOR_RGB2GRAY)
    gray_r = cv2.cvtColor(res.astype(np.uint8), cv2.COLOR_RGB2GRAY)
    lap_s = cv2.Laplacian(gray_s, cv2.CV_32F)
    lap_r = cv2.Laplacian(gray_r, cv2.CV_32F)

    ys, xs = np.where(msk > 0.5)
    if len(xs) == 0:
        return {"error": "遮罩为空（没有检测到人脸）"}
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    bw, bh = max(1, x1 - x0), max(1, y1 - y0)

    # 五官区：遮罩外接框的中段（眼/鼻/嘴），用来盯「磨皮有没有把细节一起磨平」
    fx0, fx1 = int(x0 + bw * 0.18), int(x1 - bw * 0.18)
    fy0, fy1 = int(y0 + bh * 0.28), int(y0 + bh * 0.82)
    fx0, fx1 = max(0, fx0), min(w, max(fx0 + 1, fx1))
    fy0, fy1 = max(0, fy0), min(h, max(fy0 + 1, fy1))
    feature = np.zeros((h, w), dtype=bool)
    feature[fy0:fy1, fx0:fx1] = True
    skin = (msk > 0.5) & ~feature
    outside = msk < 0.05

    def lap_var(arr, region):
        vals = arr[region]
        return float(vals.var()) if vals.size else 0.0

    skin_lap_s = lap_var(lap_s, skin)
    skin_lap_r = lap_var(lap_r, skin)
    feat_lap_s = lap_var(lap_s, feature & (msk > 0.5))
    feat_lap_r = lap_var(lap_r, feature & (msk > 0.5))

    diff = np.abs(res - src).mean(axis=2)
    bright_s = float(src[msk > 0.5].mean())
    bright_r = float(res[msk > 0.5].mean())

    return {
        "size": [w, h],
        "mask_coverage": round(float(msk.mean()), 4),
        "mask_bbox": [x0, y0, x1, y1],
        "mask_bbox_ratio": round(float((bw * bh) / (w * h)), 4),
        "mask_fill": round(float((msk > 0.5).sum() / max(1, bw * bh)), 4),
        "mask_centroid_y": round(float(ys.mean() / h), 4),
        "skin_smooth_gain": round(1.0 - skin_lap_r / max(1e-6, skin_lap_s), 4),
        "feature_detail_keep": round(feat_lap_r / max(1e-6, feat_lap_s), 4),
        "brightness_delta": round(bright_r - bright_s, 2),
        "overexposed_ratio": round(float((res[msk > 0.5] > 250).mean()), 4),
        "outside_change": round(float(diff[outside].mean()), 3),
        "inside_change": round(float(diff[msk > 0.5].mean()), 3),
    }


def run_case(tag: str, overrides: dict) -> dict:
    params = {**BASELINE, **overrides}
    dest = OUT / tag
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "params.json").write_text(
        json.dumps(params, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    started = time.time()
    submission = post("/prompt", {"prompt": build_prompt(params, tag)})
    prompt_id = submission["prompt_id"]
    entry = wait_prompt(prompt_id)
    elapsed = round(time.time() - started, 1)
    files = collect(entry, dest)
    record = {"tag": tag, "prompt_id": prompt_id, "seconds": elapsed, "params": params}
    if "result" in files and "mask" in files:
        record["metrics"] = analyze(SOURCE, files["result"], files["mask"])
        make_overlay(SOURCE, files["mask"], dest / "overlay.png")
    else:
        record["metrics"] = {"error": "输出文件缺失", "files": list(files)}
    (dest / "metrics.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return record


def make_overlay(source_path: Path, mask_path: Path, dest: Path) -> None:
    """原图上半透明红盖一层遮罩，用来肉眼核对遮罩有没有框住整张脸。"""
    try:
        from PIL import Image
    except ImportError:
        return
    src = Image.open(source_path).convert("RGB")
    mask = Image.open(mask_path).convert("L").resize(src.size)
    tinted = Image.new("RGB", src.size, (255, 48, 48))
    alpha = mask.point(lambda value: int(value * 0.42))
    Image.composite(tinted, src, alpha).save(dest)


def make_contact_sheet(records: list[dict]) -> Path | None:
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None
    tiles = []
    for record in records:
        path = OUT / record["tag"] / "result.png"
        if not path.exists():
            continue
        image = Image.open(path).convert("RGB")
        image.thumbnail((260, 390))
        tiles.append((record["tag"], image))
    if not tiles:
        return None
    cols = 4
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * 280, rows * 430), (245, 245, 245))
    draw = ImageDraw.Draw(sheet)
    for index, (tag, image) in enumerate(tiles):
        x = (index % cols) * 280 + 10
        y = (index // cols) * 430 + 28
        sheet.paste(image, (x, y))
        draw.text((x, y - 20), tag, fill=(20, 20, 20))
    target = OUT / "contact_sheet.png"
    sheet.save(target)
    return target


def verify_defaults() -> dict:
    """确认 INPUT_TYPES 默认值已生效，且「零参数」跑出来的图 == 第二轮真机标定组 final_sam3。"""
    import numpy as np
    from PIL import Image

    optional = get("/object_info/GGFaceSmartBeauty")["GGFaceSmartBeauty"]["input"]["optional"]
    expected = {
        "自动磨皮": 75, "自动美白皮肤": 45, "眼白提亮": 20, "眼睛大小": 0,
        "牙齿美白": 0, "自动瘦脸": 0, "脸部扩展": 1.35, "检测灵敏度": 45,
        "人脸识别方式": "自动", "检测提示词": "face:4", "SAM3阈值": 0.5,
        "SAM3精修": 2, "遮罩收缩": 0, "遮罩羽化": 6.0,
    }
    checks = []
    for key, want in expected.items():
        spec = optional.get(key)
        actual = spec[1].get("default") if isinstance(spec, list) and len(spec) > 1 and isinstance(spec[1], dict) else None
        checks.append({"name": key, "expected": want, "actual": actual, "ok": actual == want})

    # 只接 图像 / 模型 / CLIP，其余全部走默认值
    tag = "verify_defaults"
    submission = post("/prompt", {"prompt": build_prompt({}, tag)})
    entry = wait_prompt(submission["prompt_id"])
    files = collect(entry, OUT / tag)
    diff = None
    candidate = OUT / "final_sam3" / "result.png"
    if candidate.exists() and "result" in files:
        left = np.asarray(Image.open(candidate).convert("RGB"), dtype=np.int16)
        right = np.asarray(Image.open(files["result"]).convert("RGB"), dtype=np.int16)
        diff = round(float(np.abs(left - right).mean()), 4) if left.shape == right.shape else "尺寸不一致"

    workflow = ROOT / "example_workflows" / "GG智能人脸美化_SAM3测试.json"
    data = json.loads(workflow.read_text(encoding="utf-8"))
    nodes = [n for n in data["nodes"] if n["type"] == "GGFaceSmartBeauty"]
    wanted = [75, 45, 20, 0, 0, 0, 1.35, 45, None, "face:4", 0.5, 2, 0, 6]
    workflow_checks = []
    for node in nodes:
        values = node.get("widgets_values", [])
        ok = len(values) == len(wanted) and all(
            want is None or value == want for value, want in zip(values, wanted)
        )
        workflow_checks.append({"id": node["id"], "mode": values[8] if len(values) > 8 else None, "ok": ok})
    load_image = next((n for n in data["nodes"] if n["type"] == "LoadImage"), {})
    load_ok = IMAGE_NAME in load_image.get("widgets_values", [])

    report = {
        "defaults": checks,
        "zero_param_mean_abs_diff_vs_final_sam3": diff,
        "workflow_widgets": workflow_checks,
        "workflow_load_image": load_ok,
        "prompt_id": submission["prompt_id"],
    }
    (OUT / "verify_defaults.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def run_workflow_case() -> dict:
    """按示例工作流的拓扑真机跑一遍：SAM3 分支 + 内置检测对照分支 + 遮罩输出。"""
    prefix = "gg_face_tune/workflow"
    prompt = {
        "1": {"class_type": "LoadImage", "inputs": {"image": IMAGE_NAME}},
        "13": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        # 两个美化节点都不传美化参数，全部走标定后的 INPUT_TYPES 默认值
        "2": {"class_type": "GGFaceSmartBeauty", "inputs": {
            "图像": ["1", 0], "模型": ["13", 0], "CLIP": ["13", 1]}},
        "3": {"class_type": "GGFaceSmartBeauty", "inputs": {
            "图像": ["1", 0], "人脸识别方式": "内置检测"}},
        "4": {"class_type": "MaskToImage", "inputs": {"mask": ["2", 1]}},
        "5": {"class_type": "SaveImage", "inputs": {
            "images": ["2", 0], "filename_prefix": prefix + "/sam3"}},
        "6": {"class_type": "SaveImage", "inputs": {
            "images": ["3", 0], "filename_prefix": prefix + "/builtin"}},
        "7": {"class_type": "SaveImage", "inputs": {
            "images": ["4", 0], "filename_prefix": prefix + "/mask"}},
    }
    started = time.time()
    submission = post("/prompt", {"prompt": prompt})
    entry = wait_prompt(submission["prompt_id"])
    dest = OUT / "workflow"
    dest.mkdir(parents=True, exist_ok=True)
    saved = {}
    for node_id in ("5", "6", "7"):
        images = entry.get("outputs", {}).get(node_id, {}).get("images", [])
        if images:
            info = images[0]
            path = COMFY_OUT / info.get("subfolder", "") / info["filename"]
            if path.exists():
                target = dest / f"{node_id}.png"
                target.write_bytes(path.read_bytes())
                saved[node_id] = target.name
    report = {
        "prompt_id": submission["prompt_id"],
        "seconds": round(time.time() - started, 1),
        "outputs": saved,
        "status": entry.get("status", {}).get("status_str"),
        "ok": len(saved) == 3,
    }
    (dest / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def make_final_compare() -> dict:
    """第一轮 / 第二轮 / 原图三方放大对比 + 差异放大，用来做最终视觉核对。"""
    import numpy as np
    from PIL import Image, ImageDraw

    crop = (405, 400, 700, 690)
    paths = {
        "SOURCE": SOURCE,
        "ROUND1": OUT / "cand_a" / "result.png",
        "ROUND2": OUT / "final_sam3" / "result.png",
    }
    images = {}
    for name, path in paths.items():
        if not path.exists():
            raise SystemExit(f"缺对比图：{path}")
        images[name] = Image.open(path).convert("RGB")
    src = np.asarray(images["SOURCE"], dtype=np.float32)
    final = np.asarray(images["ROUND2"], dtype=np.float32)
    diff = np.clip(np.abs(final - src).mean(axis=2) * 12.0, 0, 255).astype(np.uint8)
    diff_im = Image.fromarray(diff).convert("RGB")

    cw, ch = 295 * 2, 290 * 2
    sheet = Image.new("RGB", (3 * (cw + 16) + 16, ch + 50), (242, 242, 242))
    draw = ImageDraw.Draw(sheet)
    for index, (title, image) in enumerate(
        (("SOURCE", images["SOURCE"]), ("ROUND1", images["ROUND1"]),
         ("ROUND2", images["ROUND2"]))
    ):
        x = index * (cw + 16) + 8
        sheet.paste(image.crop(crop).resize((cw, ch), Image.LANCZOS), (x, 36))
        draw.text((x + 4, 12), title, fill=(20, 20, 20))
    sheet.save(OUT / "final_compare.png")

    diff_sheet = Image.new("RGB", (cw + 16, ch + 50), (242, 242, 242))
    diff_sheet.paste(diff_im.crop(crop).resize((cw, ch), Image.LANCZOS), (8, 36))
    ImageDraw.Draw(diff_sheet).text((12, 12), "ROUND2 - SOURCE x12", fill=(20, 20, 20))
    diff_sheet.save(OUT / "final_diff_x12.png")
    return {"sheet": str(OUT / "final_compare.png"), "diff": str(OUT / "final_diff_x12.png")}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["baseline", "sweep", "custom", "verify", "workflow", "compare"], default="baseline")
    parser.add_argument("--set", default="", help="custom 模式：k=v,k=v，覆盖基线")
    parser.add_argument("--tags", default="", help="只跑这些 tag，逗号分隔")
    parser.add_argument("--tag", default="", help="custom 模式的输出目录名")
    args = parser.parse_args()

    if not SOURCE.exists():
        raise SystemExit(f"测试图不存在：{SOURCE}")
    OUT.mkdir(parents=True, exist_ok=True)

    if args.mode == "compare":
        print(json.dumps(make_final_compare(), ensure_ascii=False, indent=2))
        return

    if args.mode == "workflow":
        report = run_workflow_case()
        print(json.dumps(report, ensure_ascii=False, indent=2))
        if not report["ok"]:
            raise SystemExit(1)
        return

    if args.mode == "verify":
        report = verify_defaults()
        print(json.dumps(report, ensure_ascii=False, indent=2))
        bad = [c["name"] for c in report["defaults"] if not c["ok"]]
        print(f"默认值不符: {bad or '无'}")
        print(f"零参数执行 vs final_sam3 平均像素差: {report['zero_param_mean_abs_diff_vs_final_sam3']}")
        print(f"工作流 widgets_values: {report['workflow_widgets']}  测试图: {report['workflow_load_image']}")
        if bad or not report["workflow_load_image"] or any(not c["ok"] for c in report["workflow_widgets"]):
            raise SystemExit(1)
        if report["zero_param_mean_abs_diff_vs_final_sam3"] not in (None, "尺寸不一致") \
                and report["zero_param_mean_abs_diff_vs_final_sam3"] > 0.5:
            raise SystemExit(1)
        return

    if args.mode == "baseline":
        cases = [("base", {})]
    elif args.mode == "custom":
        overrides = {}
        for pair in filter(None, args.set.split(",")):
            key, value = pair.split("=", 1)
            overrides[key] = json.loads(value) if value.startswith(("[", "{")) else (
                float(value) if "." in value else int(value) if value.lstrip("-").isdigit() else value
            )
        cases = [(args.tag or "custom", overrides)]
    else:
        cases = CASES
    if args.tags:
        wanted = set(args.tags.split(","))
        cases = [case for case in cases if case[0] in wanted]

    records = []
    for tag, overrides in cases:
        print(f"[RUN] {tag} {json.dumps(overrides, ensure_ascii=False)}", flush=True)
        try:
            record = run_case(tag, overrides)
        except Exception as exc:  # 单组失败不打断整轮扫描
            record = {"tag": tag, "error": str(exc)[:1200]}
            (OUT / tag).mkdir(parents=True, exist_ok=True)
            (OUT / tag / "metrics.json").write_text(
                json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        metrics = record.get("metrics", {})
        print(f"[DONE] {tag} {record.get('seconds', '-')}s "
              f"coverage={metrics.get('mask_coverage', '-')} "
              f"smooth={metrics.get('skin_smooth_gain', '-')} "
              f"detail={metrics.get('feature_detail_keep', '-')} "
              f"err={record.get('error', metrics.get('error', '-'))}", flush=True)
        records.append(record)

    (OUT / "report.json").write_text(
        json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    sheet = make_contact_sheet(records)
    print(f"report: {OUT / 'report.json'}")
    if sheet:
        print(f"contact sheet: {sheet}")


if __name__ == "__main__":
    main()
