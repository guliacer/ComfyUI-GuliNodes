"""把 SAM3 检查点转成当前 ComfyUI 能载入的格式。

背景（实测）：
  `models/sam3/sam3.pt`、`models/Sam3.1/sam3.1_multiplex.pt` 已经是 ComfyUI 认的
  `detector.*` / `tracker.*` 命名，`detect_unet_config` 也能判定成 SAM31，
  但文本编码器的 `language_backbone.encoder.text_projection` 是 (1024, 512)，
  而 `comfy/clip_model.py` 里 `text_projection = Linear(embed_dim, embed_dim)`，
  期望 (1024, 1024) → `load_state_dict` 直接 size mismatch，整份权重载不进来。

本脚本做的事：
  1. 读源检查点（.pt / .safetensors 都行）；
  2. 用 ComfyUI 自己的检测器确认它是 SAM3 / SAM3.1（不是就直接报错退出）；
  3. 把 `text_projection` 补零到模型期望形状（其余键一个不动）；
  4. 存成 safetensors，可选地立刻重新载入跑一次前向验证。

为什么补零是安全的：
  `SAM3ClipModel` 用 `return_projected_pooled=False`，SAM3 检测器吃的是
  CLIP 的 hidden states（1024 维，未投影），`text_projection` 只作用于 pooled 输出，
  而 SAM3 全链路不读 pooled。所以这份投影矩阵实际是死权重，形状对上即可。

用法：
    cd <ComfyUI 根目录>
    python custom_nodes/ComfyUI-GuliNodes/tools/convert_sam3_checkpoint.py ^
        models/sam3/sam3.pt ^
        models/checkpoints/sam3.1_multiplex_comfy.safetensors

    # 转 bf16（体积减半），并顺带验证
    python ... --dtype bf16 --verify

    # 只体检不写文件
    python ... --dry-run
"""

import argparse
import gc
import os
import sys


def _locate_comfy_root() -> str:
    """往上找带 comfy/sd.py 的目录，插件被搬走也能用。"""
    current = os.path.dirname(os.path.abspath(__file__))
    for _ in range(8):
        if os.path.isfile(os.path.join(current, "comfy", "sd.py")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    raise RuntimeError("找不到 ComfyUI 根目录（需要 comfy/sd.py），请在 ComfyUI 目录下运行本脚本")


_COMFY_ROOT = _locate_comfy_root()
if _COMFY_ROOT not in sys.path:
    sys.path.insert(0, _COMFY_ROOT)

import torch  # noqa: E402
import comfy.utils  # noqa: E402
import comfy.model_management  # noqa: E402
import comfy.model_detection as model_detection  # noqa: E402
import comfy.supported_models as supported_models  # noqa: E402

_SAM3_CONFIG_CLASSES = {"SAM3": "SAM3", "SAM31": "SAM31"}
_PROJECTION_SUFFIXES = ("language_backbone.encoder.text_projection",
                        "language_backbone.encoder.text_projection.weight")


def _is_sam3(source) -> bool:
    config = model_detection.detect_unet_config(source, "")
    return bool(config) and config.get("image_model") in _SAM3_CONFIG_CLASSES


def _expected_projection_shape() -> tuple:
    """问 ComfyUI 自己要形状，避免把 1024 写死。"""
    from comfy.text_encoders.sam3_clip import SAM3ClipModelWrapper
    wrapper = SAM3ClipModelWrapper()
    state = wrapper.state_dict()
    for key, tensor in state.items():
        if key.endswith("text_projection.weight"):
            shape = tuple(tensor.shape)
            del wrapper, state
            gc.collect()
            return shape
    raise RuntimeError("这个 ComfyUI 的 SAM3 文本编码器里没有 text_projection，脚本需要更新")


def _pad_projection(tensor: torch.Tensor, target: tuple, key: str) -> torch.Tensor:
    """把 (hidden, proj) 的 HF 布局投影矩阵补到转换后能对上 target 的形状。

    `comfy.supported_models.SAM3.process_clip_state_dict` 会走
    `clip_text_transformers_convert`，把 `text_projection` 转置一次，
    所以这里先在“转置后”的空间里对齐，再转回去写回源字典。
    """
    if tensor.ndim != 2:
        raise RuntimeError(f"{key} 不是二维矩阵：{tuple(tensor.shape)}")
    converted = tensor.transpose(0, 1).contiguous()
    if tuple(converted.shape) == tuple(target):
        return tensor
    padded = tensor.new_zeros(target)
    rows = min(target[0], converted.shape[0])
    cols = min(target[1], converted.shape[1])
    if rows < converted.shape[0] or cols < converted.shape[1]:
        print(f"  ! {key} 转换后比模型期望的大，会截断：{tuple(converted.shape)} → {tuple(target)}")
    padded[:rows, :cols] = converted[:rows, :cols]
    return padded.transpose(0, 1).contiguous()


def _cast(sd: dict, dtype: str) -> dict:
    if dtype == "keep":
        return sd
    torch_dtype = {"bf16": torch.bfloat16, "fp16": torch.float16}[dtype]
    for key, value in list(sd.items()):
        if isinstance(value, torch.Tensor) and value.is_floating_point():
            sd[key] = value.to(torch_dtype)
    return sd


def convert(source_path: str, target_path: str, dtype: str = "keep", dry_run: bool = False) -> bool:
    print(f"读入 {source_path}")
    source = comfy.utils.load_torch_file(source_path)
    print(f"  张量 {len(source)} 个")

    if not _is_sam3(source):
        print("  × 这不是 ComfyUI 认得的 SAM3 / SAM3.1 检查点（detect_unet_config 没命中）")
        print("    原始 Meta 命名（vision_encoder. / detr_decoder.）需要先做键名映射，本脚本不处理")
        return False
    print("  检测通过：SAM3 / SAM3.1")

    target_shape = _expected_projection_shape()
    print(f"  模型期望 text_projection（转换后）：{target_shape}")

    hits = 0
    for key in list(source.keys()):
        if not key.endswith(_PROJECTION_SUFFIXES):
            continue
        original = source[key]
        fixed = _pad_projection(original, target_shape, key)
        if fixed is not original:
            source[key] = fixed
            print(f"  补形状 {key}: {tuple(original.shape)} → {tuple(fixed.shape)}")
        else:
            print(f"  已经是目标形状 {key}: {tuple(original.shape)}")
        hits += 1
    if hits == 0:
        print("  × 没找到 language_backbone 的 text_projection，可能是精简过的 unet-only 权重")
        return False

    source = _cast(source, dtype)
    if dtype != "keep":
        print(f"  已转换精度：{dtype}")

    if dry_run:
        print("--dry-run：不写文件")
        return True

    os.makedirs(os.path.dirname(os.path.abspath(target_path)) or ".", exist_ok=True)
    print(f"写出 {target_path} ...")
    comfy.utils.save_torch_file(source, target_path, metadata={"format": "pt", "converted": "sam3-text-projection"})
    size_gb = os.path.getsize(target_path) / (1024 ** 3)
    print(f"  完成，{size_gb:.2f} GB")
    return True


def verify(checkpoint_path: str) -> bool:
    """按 CheckpointLoaderSimple 的同一条路装入，再跑一次 CLIP 编码 + SAM3 前向。"""
    import comfy.sd
    import folder_paths
    from comfy_extras.nodes_sam3 import SAM3_Detect
    from nodes import CLIPTextEncode

    print(f"验证 {checkpoint_path}")
    loaded = comfy.sd.load_checkpoint_guess_config(
        checkpoint_path,
        output_vae=True,
        output_clip=True,
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
    )
    model, clip = loaded[0], loaded[1]
    print("  模型与 CLIP 载入成功")

    conditioning = CLIPTextEncode().encode(clip, "face")[0]
    emb = conditioning[0][0]
    print(f"  文本编码成功：tokens {tuple(emb.shape)}")

    height, width = 512, 512
    grid = torch.linspace(0.2, 0.8, width).view(1, 1, width, 1).expand(1, height, width, 1)
    image = torch.cat([grid, grid.flip(2), torch.full_like(grid, 0.5)], dim=-1)
    result = SAM3_Detect.execute(model=model, image=image, conditioning=conditioning,
                                 threshold=0.5, refine_iterations=1, individual_masks=False)
    masks = result.result[0]
    print(f"  前向成功：masks {tuple(masks.shape)} 覆盖率 {float((masks > 0.5).float().mean()) * 100:.2f}%")
    return True


def main():
    parser = argparse.ArgumentParser(description="SAM3 检查点 → ComfyUI 可载入格式")
    parser.add_argument("source", help="源检查点路径（.pt / .safetensors）")
    parser.add_argument("target", nargs="?", help="输出路径，默认同名加 _comfy.safetensors")
    parser.add_argument("--dtype", default="keep", choices=["keep", "bf16", "fp16"], help="输出精度，默认保持原样")
    parser.add_argument("--dry-run", action="store_true", help="只体检，不写文件")
    parser.add_argument("--verify", action="store_true", help="写完立刻重新载入并跑一次前向")
    args = parser.parse_args()

    source_path = os.path.abspath(args.source)
    if not os.path.isfile(source_path):
        print(f"× 源文件不存在：{source_path}")
        return 1
    target_path = args.target
    if not target_path:
        stem, _ext = os.path.splitext(source_path)
        target_path = f"{stem}_comfy.safetensors"
    target_path = os.path.abspath(target_path)

    if not convert(source_path, target_path, dtype=args.dtype, dry_run=args.dry_run):
        return 2
    if args.verify and not args.dry_run:
        verify(target_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
