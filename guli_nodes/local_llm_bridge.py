"""本地LLM 的单子进程 JSON 桥接；宿主只持有代理，不导入原生推理库。"""
import atexit
import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

WORKER_SCRIPT = Path(__file__).resolve().with_name("local_llm_worker.py")
PROTOCOL_PREFIX = "GG_LOCAL_LLM_JSON:"
LOAD_TIMEOUT = 600
QUERY_TIMEOUT = 600
CLOSE_TIMEOUT = 2
MAX_MESSAGE_BYTES = 64 * 1024 * 1024
STDERR_BYTES = 4096
_EOF = object()


class LocalLLMProxy:
    def __init__(self, model_path, mmproj_path, context_length, interrupt_check=None):
        self._lock = threading.RLock()
        self._stderr_lock = threading.Lock()
        self._stderr_tail = bytearray()
        self._responses = queue.Queue(maxsize=4)
        self._reader_error = ""
        self._closed = False
        self._interrupted = False
        # ComfyUI 的取消信号；轮询等待期间调用它，用户点「取消」能立刻退出，不必等满超时。
        self._interrupt_check = interrupt_check
        self._request_id = 0
        self._process = None
        self._stdout_thread = self._stderr_thread = self._writer_thread = None
        try:
            self._process = subprocess.Popen(
                [sys.executable, "-I", str(WORKER_SCRIPT)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            self._stdout_thread = threading.Thread(target=self._read_stdout, name="GGLocalLLM-stdout", daemon=True)
            self._stderr_thread = threading.Thread(target=self._read_stderr, name="GGLocalLLM-stderr", daemon=True)
            self._stdout_thread.start()
            self._stderr_thread.start()
            ready = self._request("load", LOAD_TIMEOUT, model_path=str(model_path),
                                  mmproj_path=str(mmproj_path), context_length=int(context_length))
            if not isinstance(ready, dict) or ready.get("ready") is not True or ready.get("torch_loaded") is not False:
                raise RuntimeError("worker 未确认 torch 未加载，已拒绝隔离就绪")
            if not isinstance(ready.get("metadata"), dict):
                raise RuntimeError("worker 返回的模型 metadata 不正确")
            self.metadata = ready["metadata"]
            atexit.register(self.close)
        except Exception as exc:
            if self._closed:
                raise
            raise self._failure(str(exc)) from exc

    def _publish(self, response):
        try:
            self._responses.put_nowait(response)
        except queue.Full:
            self._reader_error = "worker 协议响应过多，已超过队列上限"

    def _read_stdout(self):
        prefix = PROTOCOL_PREFIX.encode("ascii")
        try:
            while True:
                line = self._process.stdout.readline(MAX_MESSAGE_BYTES + 1)
                if not line:
                    break
                if len(line) > MAX_MESSAGE_BYTES:
                    if line.startswith(prefix):
                        raise RuntimeError("worker JSON 响应超过消息大小上限")
                    # 无标记的原生诊断可能没有换行；分段丢弃，不累积。
                    while line and not line.endswith(b"\n"):
                        line = self._process.stdout.readline(MAX_MESSAGE_BYTES + 1)
                    continue
                if line.startswith(prefix):
                    self._publish(json.loads(line[len(prefix):].decode("utf-8")))
        except Exception as exc:
            if not self._closed:
                self._reader_error = f"worker JSON 协议读取失败：{exc}"[:4096]
        finally:
            self._publish(_EOF)

    def _read_stderr(self):
        try:
            while True:
                chunk = self._process.stderr.read1(STDERR_BYTES)
                if not chunk:
                    break
                with self._stderr_lock:
                    self._stderr_tail.extend(chunk)
                    del self._stderr_tail[:-STDERR_BYTES]
        except (OSError, ValueError):
            pass

    def _write_request(self, data):
        try:
            self._process.stdin.write(data)
            self._process.stdin.flush()
        except (OSError, ValueError) as exc:
            if not self._closed:
                self._reader_error = f"worker 请求写入失败：{exc}"[:4096]
                self._publish(_EOF)

    def _wait_response(self, op, timeout):
        """按 0.25 秒粒度等待响应，期间检查取消信号；否则一次 get 会僵等到超时。"""
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(f"{op} 请求超时（{timeout:g} 秒）")
            try:
                return self._responses.get(timeout=min(0.25, remaining))
            except queue.Empty:
                if self._interrupt_check is not None:
                    try:
                        self._interrupt_check()
                    except BaseException:
                        self._interrupted = True
                        raise

    def _request(self, op, timeout, **payload):
        with self._lock:
            if self._closed:
                raise RuntimeError("本地LLM 隔离进程已经关闭，请重新执行节点。")
            try:
                if self._reader_error:
                    raise RuntimeError(self._reader_error)
                self._request_id += 1
                data = (json.dumps({"id": self._request_id, "op": op, **payload},
                                   ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
                if len(data) > MAX_MESSAGE_BYTES:
                    raise RuntimeError("请求消息超过大小上限，请减少参考图或提示词")
                # 管道写入也必须在截止时间内；子进程不读 stdin 时不能卡住宿主。
                self._writer_thread = threading.Thread(target=self._write_request, args=(data,),
                                                       name="GGLocalLLM-write", daemon=True)
                self._writer_thread.start()
                response = self._wait_response(op, timeout)
                if self._reader_error:
                    raise RuntimeError(self._reader_error)
                if response is _EOF:
                    raise RuntimeError("worker 意外退出或输出管道 EOF")
                if not isinstance(response, dict) or response.get("id") != self._request_id:
                    raise RuntimeError("worker JSON 协议响应序号不匹配")
                if response.get("ok") is not True:
                    raise RuntimeError(str(response.get("error") or "worker 返回失败")[:4096])
                return response.get("result")
            except Exception as exc:
                if self._interrupted:
                    # 用户主动取消：释放子进程后原样抛出，让 ComfyUI 记成「已中断」而不是报错。
                    self._dispose()
                    raise
                raise self._failure(str(exc)) from exc
            finally:
                if self._writer_thread is not None:
                    self._writer_thread.join(timeout=CLOSE_TIMEOUT)

    def _failure(self, reason):
        self._dispose()
        with self._stderr_lock:
            tail = bytes(self._stderr_tail).decode("utf-8", errors="replace").strip()
        text = str(reason)
        if text.startswith("本地LLM "):
            # worker 已经给出中文可行动提示，不再叠加「检查 GGUF/mmproj」这类无关建议。
            message = text
        else:
            message = (f"本地LLM 隔离进程失败：{text[:4096]}。"
                       "请检查 GGUF/mmproj 与 llama-cpp-python，或改用 API / 本地PE 后重试。")
        if tail:
            message += "\nworker stderr（末尾）：" + tail
        return RuntimeError(message)

    def _dispose(self, wait_first=False):
        if self._closed:
            return
        self._closed = True
        atexit.unregister(self.close)
        process = self._process
        if process is None:
            return
        if wait_first:
            try:
                process.wait(timeout=CLOSE_TIMEOUT)
            except subprocess.TimeoutExpired:
                pass
        if process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass
            try:
                process.wait(timeout=CLOSE_TIMEOUT)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=CLOSE_TIMEOUT)
        # 先结束精确持有的 child，使管道线程退出，再关闭流，避免阻塞 close。
        for thread in (self._writer_thread, self._stdout_thread, self._stderr_thread):
            if thread is not None:
                thread.join(timeout=CLOSE_TIMEOUT)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()

    def create_chat_completion(self, **kwargs):
        return self._request("generate", QUERY_TIMEOUT, kwargs=kwargs)

    def close(self):
        # 生成请求可能持锁好几分钟；关闭不能排在它后面，否则用户点取消/退出会一直卡住。
        if not self._lock.acquire(blocking=False):
            self._dispose()
            return
        try:
            if self._closed:
                return
            try:
                self._request("close", CLOSE_TIMEOUT)
            except RuntimeError:
                pass
            finally:
                self._dispose(wait_first=True)
        finally:
            self._lock.release()
