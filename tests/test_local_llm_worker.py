"""本地LLM 隔离与真实子进程传输；仅标准库替身，不加载权重。"""
import ast
import copy
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "GG_LOCAL_LLM_JSON:"


def load_source(name):
    path = ROOT / "guli_nodes" / (name + ".py")
    assert path.is_file(), f"缺少隔离实现：{path.name}"
    spec = importlib.util.spec_from_file_location("_test_" + name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FAKE_WORKER = r'''
import json, os, sys, time
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
PREFIX = "GG_LOCAL_LLM_JSON:"
def reply(req, result=None, error=None):
    value = {"id": req["id"], "ok": error is None}
    value["result" if error is None else "error"] = result if error is None else error
    print(PREFIX + json.dumps(value, ensure_ascii=False), flush=True)
print('native non-JSON stdout', flush=True)
print('{"id":1,"ok":false,"error":"unmarked diagnostic"}', flush=True)
mode = ""
for line in sys.stdin:
    req = json.loads(line)
    op = req["op"]
    if op == "load":
        mode = req["model_path"]
        if mode == "load_error":
            print("load diagnostic tail", file=sys.stderr, flush=True)
            reply(req, error="模拟加载失败：请检查模型")
            continue
        if mode == "load_eof":
            print("native load abort tail", file=sys.stderr, flush=True)
            sys.exit(7)
        if mode == "load_hang":
            time.sleep(60)
        result = {"ready": True, "torch_loaded": mode == "load_torch", "metadata": {
            "general.architecture": "qwen35", "pid": os.getpid(),
            "isolated": sys.flags.isolated, "script": __file__,
            "guli_loaded": any(n == "guli_nodes" or n.startswith("guli_nodes.") for n in sys.modules),
            "load_request": req}}
        if mode == "load_missing_torch":
            del result["torch_loaded"]
        reply(req, result)
        if mode == "no_read":
            time.sleep(60)
    elif op == "generate":
        if mode == "stderr_flood":
            sys.stderr.buffer.write(b"x" * 262144 + b"\nstderr flood tail\n")
            sys.stderr.flush()
            reply(req, error="模拟生成失败")
            continue
        if mode == "query_eof":
            print("native query abort tail", file=sys.stderr, flush=True)
            sys.exit(9)
        if mode == "query_hang":
            time.sleep(60)
        if mode == "malformed":
            print(PREFIX + "{not JSON", flush=True)
            continue
        reply(req, {"choices": [{"message": {"content": '{"rewritten_prompt":"测试增强"}'}}],
                    "echo": req["kwargs"], "pid": os.getpid()})
    elif op == "close":
        if mode == "close_hang":
            time.sleep(60)
        reply(req, {"closed": True})
        if mode == "close_ack_hang":
            time.sleep(60)
        break
'''


class LocalLLMTransportTests(unittest.TestCase):
    def setUp(self):
        self.bridge = load_source("local_llm_bridge")
        self.temp = tempfile.TemporaryDirectory(prefix="gg_worker_transport_")
        self.root = Path(self.temp.name).resolve()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.script = self.root / "独立 worker.py"
        self.script.write_text(FAKE_WORKER, encoding="utf-8")
        self.proxies = []
        self.patches = [patch.object(self.bridge, "WORKER_SCRIPT", self.script),
                        patch.object(self.bridge, "LOAD_TIMEOUT", 3),
                        patch.object(self.bridge, "QUERY_TIMEOUT", 3),
                        patch.object(self.bridge, "CLOSE_TIMEOUT", 0.2)]
        for item in self.patches:
            item.start()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        for proxy in self.proxies:
            proxy.close()
        for item in reversed(self.patches):
            item.stop()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.temp.cleanup()

    def start(self, mode="模型.gguf"):
        proxy = self.bridge.LocalLLMProxy(mode, "视觉.mmproj.gguf", 4096)
        self.proxies.append(proxy)
        return proxy

    def generate(self, proxy, text="中文需求"):
        return proxy.create_chat_completion(messages=[{"role": "user", "content": text}],
                                            max_tokens=32, temperature=0.7)

    def assert_released(self, proxy):
        self.assertIsNotNone(proxy._process.poll())
        self.assertTrue(all(stream.closed for stream in (proxy._process.stdin, proxy._process.stdout, proxy._process.stderr)))
        self.assertFalse(proxy._stdout_thread.is_alive())
        self.assertFalse(proxy._stderr_thread.is_alive())
        if proxy._writer_thread is not None:
            self.assertFalse(proxy._writer_thread.is_alive())

    def test_launch_isolated_file_and_utf8_roundtrip(self):
        proxy = self.start()
        self.assertEqual(proxy._process.args, [sys.executable, "-I", str(self.script)])
        self.assertEqual(proxy.metadata["isolated"], 1)
        self.assertFalse(proxy.metadata["guli_loaded"])
        self.assertEqual(Path(proxy.metadata["script"]).resolve(), self.script)
        request = proxy.metadata["load_request"]
        self.assertEqual((request["model_path"], request["mmproj_path"], request["context_length"]),
                         ("模型.gguf", "视觉.mmproj.gguf", 4096))
        kwargs = {"messages": [{"role": "system", "content": "增强规则"}, {"role": "user", "content": [
            {"type": "text", "text": "保留人物"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,dGVzdA=="}}]}],
                  "max_tokens": 256, "temperature": 0.7}
        result = proxy.create_chat_completion(**kwargs)
        self.assertEqual(result["echo"], kwargs)
        self.assertIn("测试增强", result["choices"][0]["message"]["content"])

    def test_repeat_queries_reuse_exact_child(self):
        proxy = self.start()
        pid = proxy._process.pid
        self.assertEqual(self.generate(proxy)["pid"], pid)
        self.assertEqual(self.generate(proxy, "第二次")["pid"], pid)
        self.assertIsNone(proxy._process.poll())

    def test_close_is_idempotent_and_releases_streams_and_threads(self):
        proxy = self.start()
        self.generate(proxy)
        proxy.close()
        proxy.close()
        self.assert_released(proxy)
        with self.assertRaisesRegex(RuntimeError, "本地LLM.*关闭|重新"):
            self.generate(proxy)

    def assert_start_failure(self, mode, expression):
        processes = []
        original = self.bridge.subprocess.Popen
        def record(*args, **kwargs):
            process = original(*args, **kwargs)
            processes.append(process)
            return process
        with patch.object(self.bridge.subprocess, "Popen", side_effect=record):
            with self.assertRaisesRegex(RuntimeError, expression):
                self.start(mode)
        self.assertEqual(len(processes), 1)
        process = processes[0]
        self.assertIsNotNone(process.poll())
        self.assertTrue(all(stream.closed for stream in (process.stdin, process.stdout, process.stderr)))

    def test_load_error_is_actionable_and_releases_child(self):
        self.assert_start_failure("load_error", "本地LLM.*模拟加载失败")

    def test_load_eof_includes_stderr_and_releases_child(self):
        self.assert_start_failure("load_eof", "(?s)本地LLM.*native load abort tail")

    def test_stderr_flood_is_drained_and_failure_tail_is_bounded(self):
        proxy = self.start("stderr_flood")
        with self.assertRaisesRegex(RuntimeError, "(?s)本地LLM.*stderr flood tail") as raised:
            self.generate(proxy)
        self.assertLess(len(str(raised.exception)), 4600)
        self.assert_released(proxy)

    def test_query_eof_includes_stderr_and_releases_child(self):
        proxy = self.start("query_eof")
        with self.assertRaisesRegex(RuntimeError, "(?s)本地LLM.*native query abort tail"):
            self.generate(proxy)
        self.assert_released(proxy)

    def test_load_timeout_forces_cleanup(self):
        with patch.object(self.bridge, "LOAD_TIMEOUT", 0.2):
            start = time.monotonic()
            self.assert_start_failure("load_hang", "本地LLM.*超时")
            self.assertLess(time.monotonic() - start, 3)

    def test_query_timeout_does_not_terminate_unrelated_process(self):
        other = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(60)"],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            proxy = self.start("query_hang")
            with patch.object(self.bridge, "QUERY_TIMEOUT", 0.2):
                with self.assertRaisesRegex(RuntimeError, "本地LLM.*超时"):
                    self.generate(proxy)
            self.assert_released(proxy)
            self.assertIsNone(other.poll())
        finally:
            other.terminate()
            other.wait(timeout=3)

    def test_blocked_stdin_write_is_inside_query_deadline(self):
        proxy = self.start("no_read")
        with patch.object(self.bridge, "QUERY_TIMEOUT", 0.2):
            start = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, "本地LLM.*超时"):
                self.generate(proxy, "x" * 2_000_000)
            self.assertLess(time.monotonic() - start, 3)
        self.assert_released(proxy)

    def test_interrupt_releases_child_without_waiting_full_timeout(self):
        calls = []

        class Interrupted(Exception):
            pass

        def check():
            calls.append(1)
            if len(calls) >= 2:
                raise Interrupted()

        proxy = self.bridge.LocalLLMProxy("query_hang", "视觉.mmproj.gguf", 4096, interrupt_check=check)
        self.proxies.append(proxy)
        started = time.monotonic()
        with self.assertRaises(Interrupted):
            self.generate(proxy)
        self.assertLess(time.monotonic() - started, 3)
        self.assert_released(proxy)

    def test_close_during_generation_kills_child_immediately(self):
        proxy = self.bridge.LocalLLMProxy("query_hang", "视觉.mmproj.gguf", 4096)
        self.proxies.append(proxy)

        def slow_query():
            try:
                self.generate(proxy)
            except Exception:
                pass

        threading.Thread(target=slow_query, daemon=True).start()
        time.sleep(0.3)
        started = time.monotonic()
        proxy.close()
        self.assertLess(time.monotonic() - started, 3)
        self.assert_released(proxy)

    def test_close_timeout_forces_cleanup(self):
        proxy = self.start("close_hang")
        start = time.monotonic()
        proxy.close()
        self.assertLess(time.monotonic() - start, 3)
        self.assert_released(proxy)

    def test_close_ack_without_exit_forces_cleanup(self):
        proxy = self.start("close_ack_hang")
        start = time.monotonic()
        proxy.close()
        self.assertLess(time.monotonic() - start, 3)
        self.assert_released(proxy)

    def test_torch_or_missing_isolation_readiness_is_refused(self):
        for mode in ("load_torch", "load_missing_torch"):
            with self.subTest(mode=mode):
                self.assert_start_failure(mode, "本地LLM.*torch|隔离")

    def test_malformed_marked_json_releases_child(self):
        proxy = self.start("malformed")
        with self.assertRaisesRegex(RuntimeError, "本地LLM.*JSON|协议"):
            self.generate(proxy)
        self.assert_released(proxy)

    def test_queue_message_and_timeout_bounds(self):
        proxy = self.start()
        self.assertGreater(proxy._responses.maxsize, 0)
        self.assertLessEqual(proxy._responses.maxsize, 8)
        unpatched = load_source("local_llm_bridge")
        for value in (unpatched.LOAD_TIMEOUT, unpatched.QUERY_TIMEOUT):
            self.assertGreater(value, 0)
            self.assertLessEqual(value, 600)
        with patch.object(self.bridge, "MAX_MESSAGE_BYTES", 512):
            with self.assertRaisesRegex(RuntimeError, "本地LLM.*上限|过大"):
                self.generate(proxy, "x" * 1024)
        self.assert_released(proxy)

    def test_real_worker_redirects_python_and_native_stdout(self):
        worker_path = ROOT / "guli_nodes" / "local_llm_worker.py"
        self.assertTrue(worker_path.is_file())
        driver = self.root / "mock_native_driver.py"
        driver.write_text('import importlib.util, os, sys, types\n'
                          f'spec = importlib.util.spec_from_file_location("worker", {str(worker_path)!r})\n'
                          'worker = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(worker)\n'
                          'class Llama:\n'
                          '    def __init__(self, **kwargs):\n'
                          '        os.write(1, b"native stdout diagnostic\\n")\n'
                          '        print("Python stdout diagnostic", flush=True)\n'
                          '        self.metadata = {"general.architecture": "llama"}\n'
                          '        self.chat_handler = None\n'
                          '    def create_chat_completion(self, **kwargs):\n'
                          '        return {"choices": [{"message": {"content": "standalone success"}}]}\n'
                          '    def close(self): pass\n'
                          'fake = types.ModuleType("llama_cpp")\nfake.Llama = Llama\n'
                          'sys.modules["llama_cpp"] = fake\nworker.main()\n', encoding="utf-8")
        with patch.object(self.bridge, "WORKER_SCRIPT", driver):
            # 此驱动只替身 text-only Llama，不应要求未提供的视觉 handler。
            proxy = self.bridge.LocalLLMProxy("model.gguf", "", 4096)
            self.proxies.append(proxy)
            result = self.generate(proxy)
        self.assertEqual(result["choices"][0]["message"]["content"], "standalone success")
        proxy.close()
        self.assert_released(proxy)
        tail = bytes(proxy._stderr_tail).decode("utf-8", errors="replace")
        self.assertIn("native stdout diagnostic", tail)
        self.assertIn("Python stdout diagnostic", tail)


class WorkerFactoryTests(unittest.TestCase):
    def setUp(self):
        self.worker = load_source("local_llm_worker")

    def test_top_level_imports_are_stdlib_and_no_package_or_torch_imports(self):
        tree = ast.parse((ROOT / "guli_nodes" / "local_llm_worker.py").read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names = [alias.name for alias in node.names] if isinstance(node, ast.Import) else [node.module or ""]
                self.assertFalse(getattr(node, "level", 0), "worker 必须可按文件独立启动")
                for name in names:
                    self.assertNotIn(name.split(".")[0], ("guli_nodes", "torch", "numpy", "folder_paths", "comfy"))
        for node in tree.body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names = [alias.name for alias in node.names] if isinstance(node, ast.Import) else [node.module]
                self.assertTrue(all(name.split(".")[0] in sys.stdlib_module_names for name in names))

    def test_import_does_not_load_llama_cpp(self):
        with patch.dict(sys.modules):
            sys.modules.pop("llama_cpp", None)
            sys.modules.pop("llama_cpp.llama_chat_format", None)
            load_source("local_llm_worker")
            self.assertNotIn("llama_cpp", sys.modules)

    def fake_llama(self, import_torch=False, arch="llama"):
        instances = []
        class Llama:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self.metadata = {"general.architecture": arch}
                self.chat_handler = None
                self.close_calls = 0
                instances.append(self)
                if import_torch:
                    sys.modules["torch"] = types.ModuleType("torch")
            def create_chat_completion(self, **kwargs):
                return {"choices": [{"message": {"content": "fake reply"}}]}
            def close(self):
                self.close_calls += 1
                if self.chat_handler is not None:
                    self.chat_handler.close()
        module = types.ModuleType("llama_cpp")
        module.Llama = Llama
        return module, instances

    def test_factory_retains_context_and_gpu_constructor_arguments(self):
        module, instances = self.fake_llama()
        with patch.dict(sys.modules, {"llama_cpp": module}):
            llm = self.worker.load_llm_model("text.gguf", "", 128)
        self.assertEqual(llm.kwargs, {"model_path": "text.gguf", "n_ctx": 512, "n_batch": 512, "n_ubatch": 512,
                                     "n_gpu_layers": -1, "chat_handler": None, "verbose": False})
        self.worker.close_llm_model(llm)
        self.assertEqual(instances[0].close_calls, 1)

    def test_batch_window_keeps_compute_buffer_small(self):
        module, instances = self.fake_llama()
        with patch.dict(sys.modules, {"llama_cpp": module}):
            llm = self.worker.load_llm_model("text.gguf", "", 8192)
        self.assertEqual(llm.kwargs["n_batch"], self.worker.PROMPT_BATCH)
        # n_ubatch 直接决定 compute buffer 显存（512→501 MiB，1024→1002 MiB），不能随手放大。
        self.assertEqual(llm.kwargs["n_ubatch"], self.worker.PROMPT_UBATCH)
        self.assertLessEqual(llm.kwargs["n_ubatch"], 512)

    def test_vision_handler_keeps_library_default_image_tokens(self):
        module, instances = self.fake_llama(arch="qwen35")
        seen = {}

        class Handler:
            def __init__(self, **kwargs):
                seen.update(kwargs)

            def close(self):
                pass

        fake_format = types.ModuleType("llama_cpp.llama_chat_format")
        fake_format.Qwen35ChatHandler = Handler
        sys.modules["llama_cpp.llama_chat_format"] = fake_format
        try:
            with patch.dict(sys.modules, {"llama_cpp": module}):
                self.worker.load_llm_model("text.gguf", "vision.mmproj.gguf", 16384)
        finally:
            sys.modules.pop("llama_cpp.llama_chat_format", None)
        # 不传 image_min/max tokens：实测图像只有几十 token，强行 1024 只会白吃上下文。
        self.assertEqual(set(seen), {"clip_model_path", "verbose", "enable_thinking"})
        self.assertFalse(seen["enable_thinking"])

    def test_kv_slot_failure_is_explained_in_chinese(self):
        module, _ = self.fake_llama()
        with patch.dict(sys.modules, {"llama_cpp": module}):
            llm = self.worker.load_llm_model("text.gguf", "", 8192)
        llm.n_ctx = lambda: 8192
        for raw in ("Llama.eval(decode): Failed completely even with batch size 1.",
                    "decode: failed to find a memory slot for batch of size 1"):
            message = self.worker._explain_generate_failure(RuntimeError(raw), llm)
            self.assertIn("上下文不足", message)
            self.assertIn("8192", message)
            self.assertIn("参考图", message)
        other = "some unrelated backend failure"
        self.assertEqual(self.worker._explain_generate_failure(RuntimeError(other), llm), other)

    def test_cleanup_detaches_projector_and_closes_each_once(self):
        module, _ = self.fake_llama()
        with patch.dict(sys.modules, {"llama_cpp": module}):
            llm = self.worker.load_llm_model("text.gguf", "", 4096)
        handler = types.SimpleNamespace(close_calls=0)
        def close():
            handler.close_calls += 1
        handler.close = close
        llm.chat_handler = handler
        self.worker.close_llm_model(llm)
        self.assertIsNone(llm.chat_handler)
        self.assertEqual((handler.close_calls, llm.close_calls), (1, 1))

    def test_missing_llama_cpp_is_actionable(self):
        with patch.dict(sys.modules, {"llama_cpp": None}):
            with self.assertRaisesRegex(RuntimeError, "llama-cpp-python.*安装|API / 本地PE"):
                self.worker.load_llm_model("text.gguf", "", 4096)

    def serve(self, requests):
        output = io.StringIO()
        data = "".join(json.dumps(req) + "\n" for req in requests).encode("utf-8")
        self.worker.serve(io.BytesIO(data), output)
        return [json.loads(line[len(PREFIX):]) for line in output.getvalue().splitlines()]

    def test_torch_present_before_load_is_rejected_without_construction(self):
        module, instances = self.fake_llama()
        with patch.dict(sys.modules, {"llama_cpp": module, "torch": types.ModuleType("torch")}):
            responses = self.serve([{"id": 1, "op": "load", "model_path": "fake", "mmproj_path": "", "context_length": 512}])
        self.assertFalse(responses[0]["ok"])
        self.assertIn("torch", responses[0]["error"])
        self.assertEqual(instances, [])

    def test_torch_imported_by_dependency_refuses_ready_and_closes_model(self):
        module, instances = self.fake_llama(import_torch=True)
        with patch.dict(sys.modules, {"llama_cpp": module}):
            sys.modules.pop("torch", None)
            responses = self.serve([{"id": 1, "op": "load", "model_path": "fake", "mmproj_path": "", "context_length": 512}])
        self.assertFalse(responses[0]["ok"])
        self.assertIn("torch", responses[0]["error"])
        self.assertEqual(instances[0].close_calls, 1)

    def test_json_serve_roundtrip_and_eof_close_model(self):
        module, instances = self.fake_llama()
        with patch.dict(sys.modules, {"llama_cpp": module}):
            sys.modules.pop("torch", None)
            responses = self.serve([{"id": 1, "op": "load", "model_path": "fake", "mmproj_path": "", "context_length": 512},
                                    {"id": 2, "op": "generate", "kwargs": {"messages": []}}])
        self.assertEqual(responses[0]["result"], {"ready": True, "torch_loaded": False,
                                                 "metadata": {"general.architecture": "llama"}})
        self.assertEqual(responses[1]["result"]["choices"][0]["message"]["content"], "fake reply")
        self.assertEqual(instances[0].close_calls, 1)


class StorageTransportIntegrationTests(unittest.TestCase):
    def setUp(self):
        # 先检查缺失实现，使 RED 是明确的功能缺失而非导入异常。
        load_source("local_llm_bridge")
        sys.path.insert(0, str(ROOT.parent.parent))
        sys.path.insert(0, str(ROOT))
        from guli_nodes import prompt_enhancer as pe
        from guli_nodes import local_llm_bridge as bridge
        import comfy.model_management as mm
        self.pe, self.bridge = pe, bridge
        pe._LocalLLMStorage.unload()
        self.temp = tempfile.TemporaryDirectory(prefix="gg_storage_transport_")
        self.root = Path(self.temp.name).resolve()
        self.script = self.root / "worker.py"
        self.script.write_text(FAKE_WORKER, encoding="utf-8")
        self.unload = patch.object(mm, "unload_all_models")
        self.empty = patch.object(mm, "soft_empty_cache")
        self.free = patch.object(mm, "free_memory")
        self.patches = [patch.object(bridge, "WORKER_SCRIPT", self.script), patch.object(bridge, "LOAD_TIMEOUT", 3),
                        patch.object(bridge, "QUERY_TIMEOUT", 3), patch.object(bridge, "CLOSE_TIMEOUT", 0.2),
                        patch.object(pe, "_resolve_gguf_path", side_effect=lambda name: name),
                        self.unload, self.empty, self.free]
        for item in self.patches:
            item.start()
        self.unload_mock, self.empty_mock = mm.unload_all_models, mm.soft_empty_cache
        self.free_mock = mm.free_memory
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.pe._LocalLLMStorage.unload()
        for item in reversed(self.patches):
            item.stop()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.temp.cleanup()

    def test_same_key_reuses_real_worker_and_new_key_closes_it_without_registry_change(self):
        storage = self.pe._LocalLLMStorage
        before = copy.deepcopy(self.pe.folder_paths.folder_names_and_paths)
        first = storage.load("model.gguf", "无", 4096)
        self.assertEqual(first.metadata["load_request"]["mmproj_path"], "")
        self.assertIs(first, storage.load("model.gguf", "", 4096))
        second = storage.load("model.gguf", "vision.gguf", 8192)
        self.assertIsNot(first, second)
        self.assertIsNotNone(first._process.poll())
        self.assertEqual(storage.key, ("model.gguf", "vision.gguf"))
        self.assertEqual(storage.context_length, 8192)
        self.assertEqual(before, self.pe.folder_paths.folder_names_and_paths)
        self.assertEqual(self.free_mock.call_count, 2)

    def test_larger_context_request_reloads_and_smaller_request_reuses(self):
        storage = self.pe._LocalLLMStorage
        first = storage.load("model.gguf", "无", 4096)
        self.assertIs(first, storage.load("model.gguf", "无", 2048))
        bigger = storage.load("model.gguf", "无", 16384)
        self.assertIsNot(bigger, first)
        self.assertEqual(storage.context_length, 16384)
        self.assertIsNotNone(first._process.poll())
        self.assertIs(bigger, storage.load("model.gguf", "无", 8192))

    def test_context_budget_covers_prompt_images_and_output(self):
        pe = self.pe
        required = pe._local_llm_context_needed("规则" * 10, "需求", 2, 4096)
        self.assertGreaterEqual(required, 2 * pe.LLM_IMAGE_TOKEN_BUDGET + 4096)
        self.assertLess(required, 4096 + pe.LLM_MAX_CONTEXT)

    def test_over_budget_request_is_rejected_before_loading_weights(self):
        pe = self.pe
        # 提示词本身撑爆预算时，确认超限报错且不会先去加载权重。
        with self.assertRaisesRegex(ValueError, "上下文不够"):
            pe._request_local_llm(model_name="model.gguf", mmproj_name="无", context_length=8192,
                                  system_prompt="规则", user_prompt="x" * 200_000, max_output_tokens=4096,
                                  image_base64_list=["x"] * 20)
        self.assertIsNone(pe._LocalLLMStorage.llm)

    def test_many_reference_images_are_packed_into_one(self):
        import torch
        pe = self.pe
        frames = [torch.rand(1, 64, 48, 3) for _ in range(8)]
        self.assertEqual(len(pe._llm_reference_images(frames)), 1)
        self.assertEqual(len(pe._llm_reference_images(frames[: pe.LLM_DIRECT_IMAGE_LIMIT])),
                         pe.LLM_DIRECT_IMAGE_LIMIT)
        self.assertEqual(len(pe._llm_reference_images(frames[:1])), 1)

    def test_packed_grid_keeps_aspect_and_limits_edge(self):
        import torch
        pe = self.pe
        frames = [torch.rand(1, 90, 40, 3) for _ in range(9)]
        packed = pe._pack_image_grid(frames)
        self.assertEqual(packed.ndim, 4)
        self.assertLessEqual(max(packed.shape[1], packed.shape[2]), pe.DEFAULT_IMAGE_MAX_EDGE)

    def test_twenty_images_still_fit_default_context(self):
        pe = self.pe
        # 超过 LLM_DIRECT_IMAGE_LIMIT 的参考图会先拼成一张网格图，按 1 张算预算。
        packed = 1
        required = pe._local_llm_context_needed("规则" * 2000, "需求" * 20, packed, pe.DEFAULT_MAX_OUTPUT_TOKENS)
        self.assertLessEqual(required, pe.DEFAULT_CONTEXT_LENGTH)
        # 两张直送的上限情况也要装得下。
        direct = pe._local_llm_context_needed(
            "规则" * 2000, "需求" * 20, pe.LLM_DIRECT_IMAGE_LIMIT, pe.DEFAULT_MAX_OUTPUT_TOKENS
        )
        self.assertLessEqual(direct, pe.DEFAULT_CONTEXT_LENGTH)

    def test_image_budget_covers_llama_cpp_minimum_image_tokens(self):
        # llama.cpp 对 Qwen-VL 有 image_min_tokens 下限（1024），预算必须高过它。
        self.assertGreaterEqual(self.pe.LLM_IMAGE_TOKEN_BUDGET, 1024)

    def test_local_mode_output_guard_matches_language(self):
        zh = self.pe._local_output_guard("中文")
        self.assertIn("不要输出任何英文说明", zh)
        en = self.pe._local_output_guard("英文")
        self.assertIn("English prompt", en)
        self.assertNotEqual(zh, en)

    def test_default_context_is_the_tested_optimal_value(self):
        # 实测 8448 在拼图/多图时抢不到 KV 槽位，16384 稳定通过。
        self.assertGreaterEqual(self.pe.DEFAULT_CONTEXT_LENGTH, 16384)

    def test_only_required_vram_is_freed_and_reused_on_cache_hit(self):
        events = []
        self.free_mock.side_effect = lambda need, device: events.append("free")
        self.unload_mock.side_effect = lambda: events.append("unload_all")
        real_factory = self.bridge.LocalLLMProxy
        def start(*args, **kwargs):
            events.append("worker")
            return real_factory(*args, **kwargs)
        with patch.object(self.bridge, "LocalLLMProxy", side_effect=start):
            self.pe._LocalLLMStorage.load("model.gguf", "无", 4096)
            self.pe._LocalLLMStorage.load("model.gguf", "无", 4096)
        # 只按需腾显存，不再无条件踢掉 ComfyUI 已加载的扩散模型。
        self.assertEqual(events, ["free", "worker"])
        need = self.free_mock.call_args[0][0]
        self.assertGreater(need, self.pe.LLM_VRAM_OVERHEAD)

    def test_auto_unload_false_retains_child_and_default_true_exits_it(self):
        pe = self.pe
        kwargs = {pe.P_METHOD: pe.METHOD_LLM, pe.P_LLM: "model.gguf", pe.P_PROMPT: "保留人物", pe.P_UNLOAD: False}
        self.assertEqual(pe._run(kwargs), "测试增强")
        retained = pe._LocalLLMStorage.llm
        self.assertIsNone(retained._process.poll())
        kwargs.pop(pe.P_UNLOAD)
        kwargs[pe.P_PROMPT] = "第二次需求"
        self.assertEqual(pe._run(kwargs), "测试增强")
        self.assertIsNotNone(retained._process.poll())
        self.assertIsNone(pe._LocalLLMStorage.llm)
        self.assertIsNone(pe._LocalLLMStorage.key)

    def test_failed_startup_leaves_storage_empty(self):
        with self.assertRaisesRegex(RuntimeError, "本地LLM.*模拟加载失败"):
            self.pe._LocalLLMStorage.load("load_error", "无", 4096)
        self.assertIsNone(self.pe._LocalLLMStorage.llm)
        self.assertIsNone(self.pe._LocalLLMStorage.key)

    def test_failed_query_clears_dead_cached_proxy_for_same_key_retry(self):
        pe = self.pe
        dead = pe._LocalLLMStorage.load("query_eof", "无", 4096)
        with self.assertRaisesRegex(RuntimeError, "(?s)本地LLM.*native query abort tail"):
            pe._request_local_llm(model_name="query_eof", mmproj_name="无", context_length=4096,
                                  system_prompt="rules", user_prompt="request", max_output_tokens=32,
                                  image_base64_list=[])
        self.assertIsNotNone(dead._process.poll())
        self.assertIsNone(pe._LocalLLMStorage.llm)
        self.assertIsNone(pe._LocalLLMStorage.key)
        fresh = pe._LocalLLMStorage.load("query_eof", "无", 4096)
        self.assertIsNot(fresh, dead)
        self.assertIsNone(fresh._process.poll())


if __name__ == "__main__":
    unittest.main()
