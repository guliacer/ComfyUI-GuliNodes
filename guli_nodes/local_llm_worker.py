"""本地LLM 独立文件 worker：必须以 python -I <本文件> 启动，避免宿主原生库冲突。"""
import json
import os
import sys

PROTOCOL_PREFIX = "GG_LOCAL_LLM_JSON:"
MAX_MESSAGE_BYTES = 64 * 1024 * 1024
# n_ubatch 决定 compute buffer 的显存占用（实测 9B Q5：512→501 MiB，1024→1002 MiB），
# 而图像 token 实测只有几十个，放大 ubatch 纯属白吃显存，固定回 512。
PROMPT_BATCH = 2048
PROMPT_UBATCH = 512


def close_llm_model(llm):
    # Llama.close 也会关闭 chat_handler，先解除引用再各释放一次。
    handler = getattr(llm, "chat_handler", None)
    if handler is not None:
        llm.chat_handler = None
    for resource in (handler, llm):
        close = getattr(resource, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass


def load_llm_model(model_path, mmproj_path, context_length):
    """只在独立进程内构造 Llama；路径由宿主已有 resolver 解析。"""
    try:
        from llama_cpp import Llama
    except Exception as exc:
        raise RuntimeError(
            "本地LLM 方式需要 llama-cpp-python，请先安装（pip install llama-cpp-python），"
            "或改用 API / 本地PE 方式。"
        ) from exc

    n_ctx = max(512, int(context_length))
    llm = Llama(
        model_path=model_path,
        n_ctx=n_ctx,
        n_batch=min(PROMPT_BATCH, n_ctx),
        n_ubatch=min(PROMPT_UBATCH, n_ctx),
        n_gpu_layers=-1,
        chat_handler=None,
        verbose=False,
    )
    try:
        if mmproj_path:
            from llama_cpp import llama_chat_format

            architecture = str(getattr(llm, "metadata", {}).get("general.architecture", "")).lower()
            families = {
                "qwen35": ("Qwen35ChatHandler",),
                "qwen3vl": ("Qwen3VLChatHandler",),
                "qwen2vl": ("Qwen25VLChatHandler", "Qwen2VLChatHandler"),
            }
            if architecture not in families:
                raise RuntimeError(f"本地LLM 图生图不支持此视觉架构：{architecture or '未知'}。请选择匹配的 Qwen VL 模型，或改用 API / 本地PE。")
            handler_cls = next((getattr(llama_chat_format, name, None) for name in families[architecture] if getattr(llama_chat_format, name, None) is not None), None)
            if handler_cls is None:
                raise RuntimeError(f"当前 llama-cpp-python 不支持 {families[architecture][0]}，请升级后再用图生图本地LLM。")
            handler_args = {"clip_model_path": mmproj_path, "verbose": False}
            if architecture == "qwen35":
                handler_args["enable_thinking"] = False
            llm.chat_handler = handler_cls(**handler_args)
    except Exception:
        close_llm_model(llm)
        raise
    return llm


def _reply(output, response):
    line = PROTOCOL_PREFIX + json.dumps(response, ensure_ascii=False, allow_nan=False) + "\n"
    if len(line.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise RuntimeError("本地LLM 返回消息超过大小上限，请减少最大生成token或参考图后重试。")
    output.write(line)
    output.flush()


def _explain_generate_failure(exc, llm):
    """把 llama.cpp 的 KV 槽位/上下文报错翻成可行动的中文，其余原样返回。"""
    text = str(exc)
    try:
        n_ctx = int(llm.n_ctx())
    except Exception:
        n_ctx = 0
    if "batch size 1" in text or "memory slot" in text:
        return (f"本地LLM 上下文不足（n_ctx={n_ctx}）：提示词与参考图已占满 KV 缓存，"
                "生成阶段拿不到槽位。请加大上下文长度、减少参考图张数，或降低最大生成token。")
    if "Context Shift is explicitly disabled" in text:
        return (f"本地LLM 上下文不足（n_ctx={n_ctx}）：参考图 token 超出上下文窗口，"
                "且该模型的 M-RoPE 不支持上下文平移。请加大上下文长度或减少参考图张数。")
    return text


def serve(source, output):
    """串行处理 load/generate/close；输入为 UTF-8 字节行，输出仅带标记的 JSON。"""
    llm = None
    try:
        while True:
            line = source.readline(MAX_MESSAGE_BYTES + 1)
            if not line:
                break
            request_id = None
            try:
                if len(line) > MAX_MESSAGE_BYTES:
                    raise RuntimeError("本地LLM 请求消息超过大小上限，请减少参考图后重试。")
                request = json.loads(line.decode("utf-8"))
                request_id = request["id"]
                op = request["op"]
                if op == "load":
                    if "torch" in sys.modules:
                        raise RuntimeError("本地LLM 隔离进程意外导入 torch，已拒绝加载；请检查 Python 启动配置或改用 API / 本地PE。")
                    old, llm = llm, None
                    close_llm_model(old)
                    llm = load_llm_model(request["model_path"], request["mmproj_path"], request["context_length"])
                    if "torch" in sys.modules:
                        raise RuntimeError("本地LLM 依赖意外导入 torch，已拒绝就绪；请检查 llama-cpp-python 环境或改用 API / 本地PE。")
                    result = {"ready": True, "metadata": llm.metadata, "torch_loaded": False}
                elif op == "generate":
                    if llm is None:
                        raise RuntimeError("本地LLM 尚未加载，请重新执行节点。")
                    try:
                        result = llm.create_chat_completion(**request["kwargs"])
                    except RuntimeError as exc:
                        raise RuntimeError(_explain_generate_failure(exc, llm)) from exc
                elif op == "close":
                    old, llm = llm, None
                    close_llm_model(old)
                    _reply(output, {"id": request_id, "ok": True, "result": {"closed": True}})
                    break
                else:
                    raise RuntimeError("本地LLM 请求类型不正确，请重新执行节点。")
                _reply(output, {"id": request_id, "ok": True, "result": result})
            except Exception as exc:
                # 已经是中文可行动提示的 RuntimeError 不再叠加类型名，避免 "RuntimeError: 本地LLM…"。
                message = str(exc) if isinstance(exc, RuntimeError) else f"{type(exc).__name__}: {exc}"
                _reply(output, {"id": request_id, "ok": False, "error": message[:4096]})
                break
    finally:
        close_llm_model(llm)


def main():
    # 保留协议管道，再把 Python 与原生 fd 1 的诊断统一导向 stderr。
    sys.stdout.flush()
    with os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", newline="\n", buffering=1) as output:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        sys.stdout = sys.stderr
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        serve(sys.stdin.buffer, output)


if __name__ == "__main__":
    main()
