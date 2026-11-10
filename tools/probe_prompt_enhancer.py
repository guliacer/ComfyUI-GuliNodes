"""GGPromptEnhancer 真机探针：走 ComfyUI HTTP API 跑一个最小图，把三个输出打出来。

用法（ComfyUI 需已启动，默认 http://127.0.0.1:8188）：

    # 文本 → 提示词（本地PE）
    python tools/probe_prompt_enhancer.py --prompt "雨夜霓虹街头，穿黑风衣的女人回头"

    # 只反推（不填文字），图接到 图片1
    python tools/probe_prompt_enhancer.py --image "W:/ComfyUI/input/demo.png" --reverse

    # 图生图 + 透明背景 + 方向
    python tools/probe_prompt_enhancer.py --image demo.png --task i2i --transparent --direction 人像

参数名与节点控件对齐；没写的用节点自己的默认值，所以这里只传关心的字段。
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8188"
NODE = "GGPromptEnhancer"

# ComfyUI 常在本机跑，绕开系统代理，避免 127.0.0.1 被代理拦掉
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post(path, payload):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        return json.load(opener.open(req, timeout=60))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise SystemExit(f"HTTP {exc.code}: {body[:2000]}") from None


def get(path):
    return json.load(opener.open(BASE + path, timeout=60))


def upload_image(local_path, name):
    """把本地图塞进 input 目录（/upload/image 走 multipart，手写不用第三方库）。"""
    import os
    import uuid

    boundary = uuid.uuid4().hex
    filename = os.path.basename(local_path)
    with open(local_path, "rb") as fh:
        blob = fh.read()
    parts = [
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n".encode("utf-8"),
        blob,
        f"\r\n--{boundary}\r\n"
        f'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'
        f"--{boundary}--\r\n".encode("utf-8"),
    ]
    body = b"".join(parts)
    req = urllib.request.Request(
        BASE + "/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    resp = json.load(opener.open(req, timeout=120))
    return resp.get("name") or filename


def default_inputs(overrides=None):
    """/prompt 要求必填项全部在场，所以先从 /object_info 抄一遍默认值，再用 overrides 覆盖。

    这样节点加参数后探针不用跟着改；Combo 缺 default 时退回第一个选项，
    但要跳过「无」「禁用」这类占位值，否则增强方向之类会被钉成空档。
    """
    info = get(f"/object_info/{NODE}")[NODE]
    values = {}
    for name, spec in info["input"].get("required", {}).items():
        kind, opts = spec[0], (spec[1] if len(spec) > 1 else {})
        if "default" in opts:
            values[name] = opts["default"]
            continue
        if isinstance(kind, list):
            usable = [v for v in kind if str(v) not in ("无", "禁用", "None")]
            values[name] = usable[0] if usable else (kind[0] if kind else "")
            continue
        if kind in ("INT", "FLOAT"):
            values[name] = opts.get("min", 0)
        elif kind == "BOOLEAN":
            values[name] = False
        else:
            values[name] = ""
    values.update(overrides or {})
    return values


def run(inputs, note, images=None, links=None, timeout=1800, key_fmt="图片.图片{}"):
    """跑一个只有本节点 + 三个 PreviewAny 的最小图。

    images: [(node_id, {"class_type": "LoadImage", "inputs": {...}}), ...] 按 图片1.. 顺序接；
    links:  三个输出各自的目标，默认 [["1", 0], ["1", 1], ["1", 2]]。
    PreviewAny 必须有，否则 /prompt 会报 prompt_no_outputs。
    """
    graph = {"1": {"class_type": NODE, "inputs": dict(inputs)}}
    for slot in range(3):
        graph[str(10 + slot)] = {
            "class_type": "PreviewAny",
            "inputs": {"source": ["1", slot] if links is None else links[slot]},
        }
    for index, (node_id, node) in enumerate(images or [], start=1):
        graph[str(node_id)] = node
        graph["1"]["inputs"][key_fmt.format(index)] = [str(node_id), 0]

    started = time.time()
    resp = post("/prompt", {"prompt": graph, "client_id": "gg-enhancer-probe"})
    pid = resp["prompt_id"]
    while True:
        hist = get(f"/history/{pid}")
        if pid in hist:
            break
        if time.time() - started > timeout:
            print(note, "超时")
            return None
        time.sleep(2)
    elapsed = time.time() - started
    entry = hist[pid]
    status = entry.get("status", {})
    print(f"--- {note} | {elapsed:.1f}s | {status.get('status_str')}")
    if status.get("status_str") != "success":
        for message in status.get("messages", []):
            if message[0] in ("execution_error", "execution_interrupted"):
                print("ERR:", json.dumps(message[1], ensure_ascii=False)[:1200])
        return None
    outputs = entry.get("outputs", {})
    for slot in range(3):
        item = outputs.get(str(10 + slot), {})
        for value in item.values():
            if isinstance(value, list) and value:
                text = str(value[0])
                print(f"[out{slot}] {len(text)} 字: {text[:500]}")
    return outputs


def main():
    ap = argparse.ArgumentParser(description="GGPromptEnhancer 真机探针")
    ap.add_argument("--prompt", default="", help="输入提示词")
    ap.add_argument("--image", action="append", default=[], help="参考图本地路径，可重复")
    ap.add_argument("--task", default="自动", choices=["自动", "文生图", "图生图"])
    ap.add_argument("--method", default=None, help="增强方式，默认用节点默认值（本地PE）")
    ap.add_argument("--language", default="自动", choices=["自动", "中文", "英文"])
    ap.add_argument("--direction", default=None, help="增强方向，如 人像/产品/风景")
    ap.add_argument("--transparent", action="store_true", help="透明背景")
    ap.add_argument("--reverse", action="store_true", help="强制反推（有图无字时自动成立）")
    ap.add_argument("--note", default="probe")
    ap.add_argument("--timeout", type=int, default=1800)
    args = ap.parse_args()

    overrides = {
        "输入提示词": args.prompt,
        "任务模式": args.task,
        "输出语言": args.language,
        "透明背景": args.transparent,
    }
    if args.method:
        overrides["增强方式"] = args.method
    if args.direction:
        overrides["增强方向"] = args.direction
    if args.reverse:
        overrides["任务模式"] = "图生图"  # 有图无字本身就是反推，这里顺带把模式钉住
    inputs = default_inputs(overrides)

    images = []
    for index, path in enumerate(args.image, start=1):
        name = upload_image(path, f"probe_{index}")
        images.append((100 + index, {"class_type": "LoadImage", "inputs": {"image": name}}))

    run(inputs, args.note, images=images or None, timeout=args.timeout)


if __name__ == "__main__":
    main()
