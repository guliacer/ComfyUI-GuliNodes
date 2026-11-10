# -*- coding: utf-8 -*-
"""GG 智能人脸美化：离线算法迭代台。

直接 import 依赖插件的 image_tools.py，用已采集的「原始 SAM3 遮罩」走
人脸识别方式=外部遮罩 分支，跳过 SAM3 前向，也无需重启 ComfyUI。
改完 image_tools.py 立刻能重跑，用来做算法/参数的快速视觉核对。

用法：
  python_embeded/python.exe tools/tune_face_offline.py --tag v1
  python_embeded/python.exe tools/tune_face_offline.py --tag v1 --set 自动磨皮=70,自动美白皮肤=50
  python_embeded/python.exe tools/tune_face_offline.py --mode probe
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
COMFY = ROOT.parents[1]
DEPS = COMFY / "custom_nodes" / "ComfyUI-GuliNodes-Dependencies"
MODULE = DEPS / "guli_nodes_dependency" / "image_tools.py"
OUT = ROOT / "tools" / "out" / "face_tune" / "offline"
SOURCE = COMFY / "input" / "clipboard-2026-11-04T09-26-37-794Z-49706998.jpg"
RAW_MASK = ROOT / "tools" / "out" / "face_tune" / "raw_mask" / "mask.png"

sys.path.insert(0, str(COMFY))
_spec = importlib.util.spec_from_file_location("gg_image_tools_offline", MODULE)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

BASE = {
    "自动磨皮": 70,
    "自动美白皮肤": 50,
    "眼白提亮": 20,
    "眼睛大小": 0,
    "牙齿美白": 0,
    "自动瘦脸": 0,
    "脸部扩展": 1.35,
    "检测灵敏度": 45,
    "人脸识别方式": "外部遮罩",
    "检测提示词": "face:4",
    "SAM3阈值": 0.5,
    "SAM3精修": 2,
    "遮罩收缩": 0,
    "遮罩羽化": 6.0,
}


def load_inputs():
    src = np.asarray(Image.open(SOURCE).convert("RGB"), dtype=np.float32) / 255.0
    msk = np.asarray(Image.open(RAW_MASK).convert("L"), dtype=np.float32) / 255.0
    if msk.shape != src.shape[:2]:
        msk = cv2.resize(msk, (src.shape[1], src.shape[0]), interpolation=cv2.INTER_LINEAR)
    return (
        torch.from_numpy(src).unsqueeze(0).contiguous(),
        torch.from_numpy(msk).unsqueeze(0).contiguous(),
        (np.clip(src, 0, 1) * 255).astype(np.uint8),
    )


def face_bbox(mask_u8: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.where(mask_u8 > 100)
    if len(xs) == 0:
        return (0, 0, mask_u8.shape[1], mask_u8.shape[0])
    return (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


def metrics(src: np.ndarray, res: np.ndarray, mask_u8: np.ndarray) -> dict:
    h, w = src.shape[:2]
    gray_s = cv2.cvtColor(src, cv2.COLOR_RGB2GRAY)
    gray_r = cv2.cvtColor(res, cv2.COLOR_RGB2GRAY)
    lap_s = cv2.Laplacian(gray_s, cv2.CV_32F)
    lap_r = cv2.Laplacian(gray_r, cv2.CV_32F)
    msk = mask_u8.astype(np.float32) / 255.0
    outside = msk < 0.02
    diff = np.abs(res.astype(np.float32) - src.astype(np.float32)).mean(axis=2)

    x0, y0, x1, y1 = face_bbox(mask_u8)
    bw, bh = max(1, x1 - x0), max(1, y1 - y0)
    # 分区按遮罩外接框比例，固定不随参数变，便于跨组对比
    bands = {
        "额头": (0.02, 0.30),
        "眼眉": (0.30, 0.49),
        "鼻颊": (0.49, 0.72),
        "嘴下巴": (0.72, 1.0),
    }
    regions = {}
    for name, (ry0, ry1) in bands.items():
        rx0, rx1 = 0.14, 0.86
        ax0 = max(0, int(x0 + bw * rx0))
        ax1 = min(w, int(x0 + bw * rx1))
        ay0 = max(0, int(y0 + bh * ry0))
        ay1 = min(h, int(y0 + bh * ry1))
        if ax1 <= ax0 or ay1 <= ay0:
            continue
        roi = (slice(ay0, ay1), slice(ax0, ax1))
        inside = (msk[roi] > 0.35)
        if inside.sum() < 50:
            continue
        var_s = float(lap_s[roi][inside].var())
        var_r = float(lap_r[roi][inside].var())
        regions[name] = {
            "sharp_keep": round(var_r / max(1e-6, var_s), 4),
            "brightness_delta": round(float(np.mean(res[roi][inside]) - np.mean(src[roi][inside])), 3),
            "change": round(float(diff[roi][inside].mean()), 3),
            "overexposed": round(float((res[roi][inside] > 250).mean()), 4),
        }
    bd = [v["brightness_delta"] for v in regions.values()]
    # 结构保持：只看原图里梯度本来就强的像素（眼线/睫毛/眉毛/唇线/鼻孔）
    grad = np.abs(cv2.Laplacian(gray_s, cv2.CV_32F))
    energy = cv2.GaussianBlur(grad, (0, 0), sigmaX=1.1, sigmaY=1.1)
    strong = (energy > 18.0) & (msk > 0.35)
    weak = (energy <= 12.0) & (msk > 0.35)
    ey0, ey1 = int(y0 + bh * 0.28), int(y0 + bh * 0.50)
    eye_band = np.zeros((h, w), dtype=bool)
    eye_band[max(0, ey0):min(h, ey1), max(0, int(x0 + bw * 0.10)):min(w, int(x0 + bw * 0.90))] = True
    eye_strong = strong & eye_band

    def ratio(a, b, region):
        if region.sum() < 30:
            return None
        return round(float(b[region].var() / max(1e-6, a[region].var())), 4)

    def mean_ratio(a, b, region):
        if region.sum() < 30:
            return None
        return round(float(np.abs(b[region]).mean() / max(1e-6, np.abs(a[region]).mean())), 4)

    return {
        "bbox": [x0, y0, x1, y1],
        "structure_keep": ratio(lap_s, lap_r, strong),
        "eye_structure_keep": ratio(lap_s, lap_r, eye_strong),
        "texture_smooth": mean_ratio(lap_s, lap_r, weak),
        "regions": regions,
        "brightness_delta_mean": round(float(np.mean(bd)), 3) if bd else 0.0,
        "brightness_delta_spread": round(float(max(bd) - min(bd)), 3) if len(bd) > 1 else 0.0,
        "eye_sharp_keep": regions.get("眼眉", {}).get("sharp_keep", 0.0),
        "skin_sharp_keep": regions.get("鼻颊", {}).get("sharp_keep", 0.0),
        "overall_change": round(float(diff[msk > 0.35].mean()), 3),
        "outside_change": round(float(diff[outside].mean()), 4),
        "overexposed_ratio": round(float((res[msk > 0.35] > 250).mean()), 4),
    }


def compare_sheet(src: np.ndarray, res: np.ndarray, mask_u8: np.ndarray, dest: Path, tag: str) -> None:
    x0, y0, x1, y1 = face_bbox(mask_u8)
    pad_x, pad_y = int((x1 - x0) * 0.16), int((y1 - y0) * 0.12)
    ax0, ay0 = max(0, x0 - pad_x), max(0, y0 - pad_y)
    ax1, ay1 = min(src.shape[1], x1 + pad_x), min(src.shape[0], y1 + pad_y)
    crop_s = src[ay0:ay1, ax0:ax1]
    crop_r = res[ay0:ay1, ax0:ax1]
    d = np.abs(crop_r.astype(np.float32) - crop_s.astype(np.float32)).mean(axis=2)
    d = np.clip(d * 8.0, 0, 255).astype(np.uint8)
    scale = 2
    cw, ch = (ax1 - ax0) * scale, (ay1 - ay0) * scale
    sheet = Image.new("RGB", (cw * 3 + 40, ch + 40), (242, 242, 242))
    for idx, (title, arr) in enumerate((("SOURCE", crop_s), (tag, crop_r))):
        im = Image.fromarray(arr).resize((cw, ch), Image.LANCZOS)
        sheet.paste(im, (idx * (cw + 20), 32))
    dim = Image.fromarray(d).convert("RGB").resize((cw, ch), Image.LANCZOS)
    sheet.paste(dim, (2 * (cw + 20), 32))
    draw = ImageDraw.Draw(sheet)
    draw.text((4, 10), "SOURCE", fill=(20, 20, 20))
    draw.text((cw + 24, 10), tag, fill=(20, 20, 20))
    draw.text((2 * (cw + 24), 10), "DIFF x8", fill=(20, 20, 20))
    sheet.save(dest)


def run(tag: str, overrides: dict, image_t, mask_t, src_u8, mask_u8) -> dict:
    params = {**BASE, **overrides}
    params["图像"] = image_t
    params["人脸遮罩"] = mask_t
    started = time.time()
    out_image, out_mask = mod.GGFaceSmartBeauty().beautify(**params)
    result = np.clip(out_image[0].detach().cpu().numpy(), 0, 1)
    res_u8 = (result * 255.0).astype(np.uint8)
    refined_mask = (np.clip(out_mask[0].detach().cpu().numpy(), 0, 1) * 255).astype(np.uint8)
    dest = OUT / tag
    dest.mkdir(parents=True, exist_ok=True)
    Image.fromarray(res_u8).save(dest / "result.png")
    Image.fromarray(refined_mask).save(dest / "mask.png")
    m = metrics(src_u8, res_u8, refined_mask)
    compare_sheet(src_u8, res_u8, refined_mask, dest / "compare.png", tag)
    record = {"tag": tag, "params": {k: v for k, v in params.items() if not isinstance(v, torch.Tensor)},
              "seconds": round(time.time() - started, 2), "metrics": m}
    (dest / "metrics.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    return record


def probe(src_u8, mask_u8) -> dict:
    ctx = mod._build_face_analysis_context(src_u8, sensitivity=45)
    meshes = ctx.get("mesh_results", [])
    contours = mod._contours_to_face_rects(mask_u8)
    info = {
        "image": list(src_u8.shape[:2]),
        "mask_bbox": list(face_bbox(mask_u8)),
        "mask_coverage": round(float((mask_u8 > 128).mean()), 5),
        "contour_faces": contours,
        "mp_detections": [d.get("bbox") for d in ctx.get("mp_detections", [])],
        "mesh_bboxes": [m.get("bbox") for m in meshes],
        "mesh_landmarks": [len(m.get("landmarks", [])) for m in meshes],
    }
    for face in contours:
        match = mod._match_mediapipe_mesh(face, meshes)
        info["contour_mesh_match"] = match.get("bbox") if match else None
    return info


def parse_set(text: str) -> dict:
    out = {}
    for pair in filter(None, text.split(",")):
        key, value = pair.split("=", 1)
        out[key] = json.loads(value) if value.startswith(("[", "{")) else (
            float(value) if "." in value else int(value) if value.lstrip("-").isdigit() else value
        )
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["run", "probe"], default="run")
    ap.add_argument("--tag", default="offline")
    ap.add_argument("--set", default="")
    ap.add_argument("--cases", default="", help="JSON 文件：[[tag, {k:v}], ...] 批量跑")
    args = ap.parse_args()

    if not SOURCE.exists() or not RAW_MASK.exists():
        raise SystemExit(f"缺输入：{SOURCE} / {RAW_MASK}")
    OUT.mkdir(parents=True, exist_ok=True)
    image_t, mask_t, src_u8 = load_inputs()
    mask_u8 = np.asarray(Image.open(RAW_MASK).convert("L"), dtype=np.uint8)
    if mask_u8.shape != src_u8.shape[:2]:
        mask_u8 = cv2.resize(mask_u8, (src_u8.shape[1], src_u8.shape[0]), interpolation=cv2.INTER_LINEAR)

    if args.mode == "probe":
        print(json.dumps(probe(src_u8, mask_u8), ensure_ascii=False, indent=2))
        return

    cases = [(args.tag, parse_set(args.set))]
    if args.cases:
        cases = json.loads(Path(args.cases).read_text(encoding="utf-8"))
    records = []
    for tag, overrides in cases:
        rec = run(tag, overrides, image_t, mask_t, src_u8, mask_u8)
        m = rec["metrics"]
        print(f"[{tag}] {rec['seconds']}s struct={m['structure_keep']} eye={m['eye_structure_keep']} "
              f"texture={m['texture_smooth']} bright={m['brightness_delta_mean']} "
              f"spread={m['brightness_delta_spread']} change={m['overall_change']} "
              f"outside={m['outside_change']}", flush=True)
        records.append(rec)
    (OUT / "report.json").write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"report: {OUT / 'report.json'}")


if __name__ == "__main__":
    main()
