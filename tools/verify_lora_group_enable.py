"""验证「GG LoRA组加载」的 启用/关闭 开关在后端确实生效。

必须用 ComfyUI 自带解释器跑（lora_tools.py 顶层 import 了 comfy.sd / folder_paths）：

    cd W:/AIphotograph/ComfyUI_windows_portable/ComfyUI
    PYTHONPATH=. python_embeded/python.exe \
        custom_nodes/ComfyUI-GuliNodes/tools/verify_lora_group_enable.py

做法：把 load_lora_file / apply_lora_stack 换成探针，直接调 load_group，
看关掉的槽位到底有没有被加载；再验 IS_CHANGED 会不会因为开关翻转而变化
（不变的话 ComfyUI 会吃缓存，开关看着点了却没重新执行）。
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
COMFY_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
MODULE_PATH = os.path.abspath(os.path.join(HERE, "..", "guli_nodes", "lora_tools.py"))

sys.path.insert(0, COMFY_ROOT)

spec = importlib.util.spec_from_file_location("gg_lora_tools_probe", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

node = module.GGLoRAGroupLoader()
calls = []
applied = []

# 真文件加载很慢且依赖模型，这里只关心「有没有被调用」。
node.load_lora_file = lambda name, strength: (
    calls.append((name, strength)), {"fake_lora": True}
)[1]
node.apply_lora_stack = lambda model, data: (
    applied.append(list(data)), "MODEL_WITH_LORA"
)[1]

sentinel = object()


def inputs(on1, on2, on3):
    return {
        "LoRA1名称": "A.safetensors", "LoRA1强度": 1.0, "LoRA1启用": on1,
        "LoRA2名称": "B.safetensors", "LoRA2强度": 0.5, "LoRA2启用": on2,
        "LoRA3名称": "C.safetensors", "LoRA3强度": 1.0, "LoRA3启用": on3,
    }


checks = []


def check(name, ok, detail):
    checks.append((name, bool(ok), detail))
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else "  " + repr(detail)))


# ① 只开第 2 条：只应加载 B，且强度原样传下去。
calls.clear()
applied.clear()
out = node.load_group(sentinel, 3, 1, **inputs(False, True, False))
check("只启用第 2 条时，只加载 B.safetensors 且强度 0.5",
      calls == [("B.safetensors", 0.5)] and len(applied[0]) == 1
      and out[0] == "MODEL_WITH_LORA",
      {"calls": calls, "applied": applied, "out": out[0]})

# ② 全部关闭：一次都不加载，直接把原模型原样返回。
calls.clear()
applied.clear()
all_off = node.load_group(sentinel, 3, 1, **inputs(False, False, False))
check("全部关闭时 0 次加载，且原模型原样返回",
      calls == [] and applied == [] and all_off[0] is sentinel,
      {"calls": calls, "applied": applied})

# ③ 全部打开：三条都加载。
calls.clear()
applied.clear()
node.load_group(sentinel, 3, 1, **inputs(True, True, True))
check("全部启用时三条都加载",
      len(calls) == 3 and len(applied[0]) == 3,
      {"calls": calls, "applied": len(applied[0]) if applied else 0})

# ④ 老工作流里「新增LoRA」按钮的字符串值顶到启用开关上，必须当成 True。
calls.clear()
applied.clear()
legacy = inputs(True, True, True)
legacy["LoRA1启用"] = "新增LoRA"
node.load_group(sentinel, 3, 1, **legacy)
check("老存档里字符串 '新增LoRA' 不会被误判成关闭",
      len(calls) == 3, {"calls": calls})

# ⑤ 开关翻转必须让 IS_CHANGED 变化，否则点了也不重新执行。
h_off = module.GGLoRAGroupLoader.IS_CHANGED(
    模型=sentinel, LoRA数量=3, 当前组=1, **inputs(False, True, False))
h_on = module.GGLoRAGroupLoader.IS_CHANGED(
    模型=sentinel, LoRA数量=3, 当前组=1, **inputs(True, True, False))
check("启用状态翻转会改变 IS_CHANGED（不会吃上一帧缓存）",
      h_off != h_on, {"off": h_off[:12], "on": h_on[:12]})

passed = sum(1 for _, ok, _ in checks if ok)
print(f"\n{passed}/{len(checks)} passed")
sys.exit(0 if passed == len(checks) else 1)
