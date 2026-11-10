"""真机 /prompt 验证新字段名能被后端接受并执行。

输入提示词留空 → _enhance 提前返回，不加载 GGUF 权重，几秒内就能验完。
模型选择逻辑（文生图 / 图生图各用哪个 GGUF）由 test_prompt_enhancer_fusion.py 覆盖。
"""
import importlib.util
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pe_probe", ROOT / "tools" / "probe_prompt_enhancer.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

INFO = probe.get("/object_info/GGPromptEnhancer")["GGPromptEnhancer"]["input"]["required"]
EXPECTED = ("文生图LLM模型", "图生图LLM模型")
for name in EXPECTED:
    if name not in INFO:
        raise SystemExit(f"FAIL 后端缺少控件 {name}")
    print(f"PASS 后端声明 {name}，默认 {INFO[name][1].get('default')}")

T2I = INFO[EXPECTED[0]][1]["default"]
I2I = INFO[EXPECTED[1]][1]["default"]
if T2I == I2I:
    raise SystemExit("FAIL 两个默认模型没有分开")


def submit(task, note):
    inputs = probe.default_inputs({
        "任务模式": task,
        "增强方式": "本地LLM",
        "输入提示词": "",  # 空需求：不加载权重，只验证提交与分派
        "卸载策略": "保持加载",
        EXPECTED[0]: T2I,
        EXPECTED[1]: I2I,
    })
    graph = {"1": {"class_type": "GGPromptEnhancer", "inputs": inputs}}
    for slot in range(3):
        graph[str(10 + slot)] = {
            "class_type": "PreviewAny",
            "inputs": {"source": ["1", slot]},
        }
    resp = probe.post("/prompt", {"prompt": graph, "client_id": "gg-pe-llm-split"})
    pid = resp.get("prompt_id")
    if not pid:
        raise SystemExit(f"FAIL {note} 提交失败：{json.dumps(resp, ensure_ascii=False)[:600]}")
    started = time.time()
    while time.time() - started < 180:
        hist = probe.get(f"/history/{pid}")
        if pid in hist:
            status = hist[pid].get("status", {})
            ok = status.get("status_str") == "success"
            print(f"{'PASS' if ok else 'FAIL'} {note} | {time.time() - started:.1f}s | {status.get('status_str')}")
            if not ok:
                for message in status.get("messages", []):
                    if message[0] in ("execution_error", "execution_interrupted"):
                        print("ERR:", json.dumps(message[1], ensure_ascii=False)[:800])
            return ok
        time.sleep(1)
    print(f"FAIL {note} 超时")
    return False


results = [
    submit("文生图", "新字段 + 文生图 + 空需求真机执行"),
    submit("自动", "新字段 + 自动 + 空需求真机执行"),
]
print(f"\n{sum(results)}/{len(results)} 通过")
print("默认模型", T2I, "/", I2I, "/", INFO["mmproj"][1].get("default"))
sys.exit(0 if all(results) else 1)
