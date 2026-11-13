"""一次本机视觉改写实测；不启动服务、不调用外部API、不排队扩散生成。"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMFY = ROOT.parent.parent
sys.path.insert(0, str(COMFY))
sys.path.insert(0, str(ROOT))

import numpy as np
import torch
from PIL import Image, ImageOps
from guli_nodes.prompt_enhancer import _run, _LocalLLMStorage

source = COMFY / "input" / "77d2c42db7b0e56286aec070a54d1437.png"
with Image.open(source) as image:
    image = ImageOps.exif_transpose(image).convert("RGB")
    image.thumbnail((320, 640))
    reference = torch.from_numpy(np.array(image).astype(np.float32) / 255.0)[None]
start = time.monotonic()
try:
    result, _, _ = _run({"任务模式": "图生图", "输出语言": "中文", "增强方式": "本地LLM", "输入提示词": "仅略微优化图中泳池和树木背景的曝光层次与色彩，保持人物、衣服、身份、姿态、位置和外轮廓不变，不新增物体。", "图生图LLM模型": "Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf", "mmproj": "Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf", "上下文长度": 8192, "最大生成token": 512, "卸载策略": "运行后自动卸载", "图片": {"图片1": reference}})
    assert isinstance(result, str) and len(result.strip()) > 10, "本地视觉改写未返回有效文字"
    report = {"success": True, "seconds": round(time.monotonic() - start, 2), "result": result, "model_architecture": "qwen35", "reference_size": list(reference.shape[1:3]), "diffusion_executed": False}
except Exception as exc:
    report = {"success": False, "seconds": round(time.monotonic() - start, 2), "error": str(exc), "diffusion_executed": False}
    raise
finally:
    _LocalLLMStorage.unload()
    if "report" in locals():
        out = ROOT / "tools" / "region_edit_local_llm_probe.json"
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf8")
        print(json.dumps(report, ensure_ascii=False))
