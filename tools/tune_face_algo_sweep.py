# -*- coding: utf-8 -*-
"""磨皮算法常数离线扫描：monkeypatch _smooth_skin，只改常数，不动生产代码。

产物：tools/out/face_tune/offline/algo_<name>/compare.png + metrics.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
COMFY = ROOT.parents[1]
sys.path.insert(0, str(COMFY))
sys.path.insert(0, str(ROOT / "tools"))

import importlib.util

_spec = importlib.util.spec_from_file_location(
    "gg_image_tools_sweep",
    COMFY / "custom_nodes" / "ComfyUI-GuliNodes-Dependencies" / "guli_nodes_dependency" / "image_tools.py",
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)
C = mod.GGFaceSmartBeauty

from tune_face_offline import (  # noqa: E402
    BASE, OUT, SOURCE, RAW_MASK, load_inputs, metrics, compare_sheet,
)

VARIANTS = [
    ("m_max", dict(sigma=2.7, lo=2.0, hi=14.0, coeff=1.0, edge=0.95, mask_edge=0.20,
                   spec=9.0, despeckle=0.0, white=45)),
    ("n_wide_max", dict(sigma=3.5, lo=2.0, hi=15.0, coeff=1.0, edge=0.95, mask_edge=0.20,
                        spec=9.0, despeckle=0.0, white=45)),
    ("o_max_light", dict(sigma=2.7, lo=2.0, hi=14.0, coeff=1.0, edge=0.95, mask_edge=0.20,
                         spec=9.0, despeckle=0.0, white=35)),
    ("p_medium_max", dict(sigma=4.5, lo=3.0, hi=18.0, coeff=1.0, edge=0.95, mask_edge=0.20,
                          spec=9.0, despeckle=0.0, white=45)),
    ("q_balanced", dict(sigma=3.0, lo=2.5, hi=16.0, coeff=0.95, edge=0.95, mask_edge=0.25,
                        spec=9.0, despeckle=0.0, white=45)),
    ("r_soft", dict(sigma=2.7, lo=3.0, hi=17.0, coeff=0.90, edge=0.9, mask_edge=0.30,
                    spec=9.0, despeckle=0.0, white=45)),
]


def make_smooth(cfg):
    def fn(cls, image_u8, face_mask, faces, strength, context=None):
        lab = cv2.cvtColor(image_u8, cv2.COLOR_RGB2LAB)
        L = lab[..., 0].astype(np.float32)
        tone = cv2.GaussianBlur(L, (0, 0), sigmaX=cfg["sigma"], sigmaY=cfg["sigma"])
        detail = L - tone
        mag = np.abs(detail)
        keep = np.clip((mag - cfg["lo"]) / (cfg["hi"] - cfg["lo"]), 0.0, 1.0)
        edge = cls._skin_detail_protect(image_u8)
        attenuation = 1.0 - float(np.clip(strength, 0, 1)) * cfg["coeff"] * (1.0 - keep) * (1.0 - cfg["edge"] * edge)
        L_smooth = tone + detail * attenuation
        spec = np.clip((L - 200.0) / 55.0, 0.0, 1.0)
        L_smooth = L_smooth - spec * cfg["spec"] * strength
        if cfg["despeckle"] > 0:
            # 只压「比邻域亮的小白点」：油光颗粒，鼻梁整体的亮带不受影响
            local = cv2.GaussianBlur(L, (0, 0), 2.0, 2.0)
            peak = np.clip((L - local) / 16.0, 0.0, 1.0)
            bright = np.clip((L - 198.0) / 57.0, 0.0, 1.0)
            L_smooth = L_smooth - peak * bright * cfg["despeckle"] * strength
        a = cv2.GaussianBlur(lab[..., 1].astype(np.float32), (0, 0), 1.6, 1.6)
        b = cv2.GaussianBlur(lab[..., 2].astype(np.float32), (0, 0), 1.6, 1.6)
        smooth_lab = np.stack(
            [np.clip(L_smooth, 0, 255),
             lab[..., 1].astype(np.float32) * 0.55 + a * 0.45,
             lab[..., 2].astype(np.float32) * 0.55 + b * 0.45], axis=2
        ).astype(np.uint8)
        smooth_rgb = cv2.cvtColor(smooth_lab, cv2.COLOR_LAB2RGB)
        face = face_mask.astype(np.float32) / 255.0
        mask = face * (1.0 - cfg["mask_edge"] * edge)
        mask = cv2.GaussianBlur(mask, (0, 0), 1.6, 1.6)
        mask = np.clip(mask * (0.62 + 0.50 * strength), 0.0, 0.96)
        return np.clip(image_u8.astype(np.float32) * (1 - mask[..., None])
                       + smooth_rgb.astype(np.float32) * mask[..., None], 0, 255).astype(np.uint8)
    return fn


def main():
    image_t, mask_t, src_u8 = load_inputs()
    mask_u8 = np.asarray(Image.open(RAW_MASK).convert("L"), dtype=np.uint8)
    records = []
    for name, cfg in VARIANTS:
        C._smooth_skin = classmethod(make_smooth(cfg))
        params = {**BASE, "自动磨皮": 70, "自动美白皮肤": cfg["white"], "眼白提亮": 20,
                  "图像": image_t, "人脸遮罩": mask_t}
        out_img, out_mask = C().beautify(**params)
        res = (np.clip(out_img[0].detach().cpu().numpy(), 0, 1) * 255).astype(np.uint8)
        refined = (np.clip(out_mask[0].detach().cpu().numpy(), 0, 1) * 255).astype(np.uint8)
        dest = OUT / ("algo_" + name)
        dest.mkdir(parents=True, exist_ok=True)
        Image.fromarray(res).save(dest / "result.png")
        m = metrics(src_u8, res, refined)
        compare_sheet(src_u8, res, refined, dest / "compare.png", name)
        (dest / "metrics.json").write_text(json.dumps({"cfg": cfg, "metrics": m}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[{name}] struct={m['structure_keep']} texture={m['texture_smooth']} "
              f"change={m['overall_change']} bright={m['brightness_delta_mean']} "
              f"spread={m['brightness_delta_spread']}", flush=True)
        records.append({"name": name, "cfg": cfg, "metrics": m})
    (OUT / "algo_report.json").write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
