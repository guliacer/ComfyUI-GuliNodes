# -*- coding: utf-8 -*-
"""提亮曲线离线扫描：gamma 会压对比度（显灰白），试加法 / screen 保留皮肤层次。"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
COMFY = ROOT.parents[1]
sys.path.insert(0, str(COMFY))
sys.path.insert(0, str(ROOT / "tools"))

_spec = importlib.util.spec_from_file_location(
    "gg_image_tools_white",
    COMFY / "custom_nodes" / "ComfyUI-GuliNodes-Dependencies" / "guli_nodes_dependency" / "image_tools.py",
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)
C = mod.GGFaceSmartBeauty

from tune_face_offline import BASE, OUT, SOURCE, load_inputs, metrics  # noqa: E402

VARIANTS = [
    ("x1", dict(kind="add", amount=16.0, white=45, skin=75, guard_sigma=6.0,
                hi=0.70, sh=0.70, sat=0.08)),
    ("x2", dict(kind="add", amount=22.0, white=40, skin=75, guard_sigma=6.0,
                hi=0.70, sh=0.70, sat=0.08)),
    ("x3", dict(kind="gamma", amount=0.20, white=45, skin=75, guard_sigma=6.0,
                hi=0.70, sh=0.70, sat=0.08)),
    ("x4", dict(kind="add", amount=16.0, white=40, skin=75, guard_sigma=8.0,
                hi=0.70, sh=0.70, sat=0.12)),
    ("x5", dict(kind="add", amount=16.0, white=45, skin=75, guard_sigma=6.0,
                hi=0.70, sh=0.0, sat=0.08)),
    ("x6", dict(kind="add", amount=20.0, white=45, skin=75, guard_sigma=10.0,
                hi=0.60, sh=0.60, sat=0.10)),
]


def make_whiten(cfg):
    def fn(cls, image_u8, face_mask, faces, strength, context=None):
        face = face_mask.astype(np.float32) / 255.0
        if face.max() <= 0:
            return image_u8
        lab = cv2.cvtColor(image_u8, cv2.COLOR_RGB2LAB).astype(np.float32)
        L = lab[..., 0]
        # 保护图按低频亮度算，避免逐像素阈值在鼻线/眼窝边上画出深色描边
        tone = cv2.GaussianBlur(L, (0, 0), cfg["guard_sigma"], cfg["guard_sigma"])
        highlight = np.clip((tone - 185.0) / 65.0, 0.0, 1.0)
        shadow = np.clip((105.0 - tone) / 60.0, 0.0, 1.0)
        weight = face * (1.0 - cfg["hi"] * highlight) * (1.0 - cfg["sh"] * shadow)
        if faces:
            protect = cls._facial_feature_protect_mask(
                image_u8, faces, protect_nose=False,
                eye_scale_x=0.36, eye_scale_y=0.11,
                mouth_scale_x=0.27, mouth_scale_y=0.11,
                eye_strength=0.9, mouth_strength=0.85, context=context)
            weight *= (1.0 - 0.45 * protect)
        weight = cv2.GaussianBlur(weight, (0, 0), sigmaX=5.0, sigmaY=5.0)
        full = lab.copy()
        if cfg["kind"] == "gamma":
            gain = strength * cfg["amount"]
            full[..., 0] = np.clip(255.0 * np.power(np.clip(L / 255.0, 0, 1), 1.0 - gain), 0, 255)
        elif cfg["kind"] == "add":
            full[..., 0] = np.clip(L + cfg["amount"] * strength, 0, 255)
        else:
            full[..., 0] = np.clip(L + (255.0 - L) * cfg["amount"] * strength, 0, 255)
        full[..., 1] = np.clip(full[..., 1] - 1.2 * strength, 0, 255)
        full[..., 2] = np.clip(full[..., 2] - 2.4 * strength, 0, 255)
        bright = cv2.cvtColor(full.astype(np.uint8), cv2.COLOR_LAB2RGB)
        if cfg["sat"] > 0:
            hsv = cv2.cvtColor(bright, cv2.COLOR_RGB2HSV).astype(np.float32)
            hsv[..., 1] = np.clip(hsv[..., 1] * (1.0 + cfg["sat"] * strength), 0, 255)
            bright = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2RGB)
        bright = bright.astype(np.float32)
        alpha = np.clip(weight, 0.0, 1.0)
        return np.clip(image_u8.astype(np.float32) * (1 - alpha[..., None])
                       + bright * alpha[..., None], 0, 255).astype(np.uint8)
    return fn


def main():
    image_t, mask_t, src_u8 = load_inputs()
    records = []
    for name, cfg in VARIANTS:
        C._whiten_skin = classmethod(make_whiten(cfg))
        params = {**BASE, "自动磨皮": cfg["skin"], "自动美白皮肤": cfg["white"],
                  "眼白提亮": 20, "图像": image_t, "人脸遮罩": mask_t}
        out_img, out_mask = C().beautify(**params)
        res = (np.clip(out_img[0].detach().cpu().numpy(), 0, 1) * 255).astype(np.uint8)
        refined = (np.clip(out_mask[0].detach().cpu().numpy(), 0, 1) * 255).astype(np.uint8)
        dest = OUT / ("white_" + name)
        dest.mkdir(parents=True, exist_ok=True)
        Image.fromarray(res).save(dest / "result.png")
        m = metrics(src_u8, res, refined)
        (dest / "metrics.json").write_text(json.dumps({"cfg": cfg, "metrics": m}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[{name}] struct={m['structure_keep']} eye_band={m['regions'].get('眼眉',{}).get('sharp_keep')} "
              f"texture={m['texture_smooth']} bright={m['brightness_delta_mean']} "
              f"spread={m['brightness_delta_spread']} over={m['overexposed_ratio']}", flush=True)
        records.append({"name": name, "cfg": cfg, "metrics": m})
    (OUT / "white_report.json").write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
