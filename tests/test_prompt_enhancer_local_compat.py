"""本地 GGUF 路径与视觉架构适配；模型构造以测试替身隔离，不加载权重。"""
import copy
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent.parent))
sys.path.insert(0, str(ROOT))
from guli_nodes import prompt_enhancer as pe


class FakeHandler:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.closed = False
        self.close_calls = 0
    def close(self):
        self.close_calls += 1
        self.closed = True


class FakeLlama:
    architecture = "qwen35"
    instances = []
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.metadata = {"general.architecture": self.architecture}
        self.chat_handler = kwargs.get("chat_handler")
        self.closed = False
        self.instances.append(self)
    def close(self):
        # 复现本机 Llama.close 会释放当前 chat_handler 的真实资源关系。
        if self.chat_handler is not None:
            self.chat_handler.close()
            self.chat_handler = None
        self.closed = True


def fake_modules():
    handlers = types.ModuleType("llama_cpp.llama_chat_format")
    for name in ("Qwen35ChatHandler", "Qwen3VLChatHandler", "Qwen25VLChatHandler", "Qwen2VLChatHandler"):
        setattr(handlers, name, type(name, (FakeHandler,), {}))
    llama = types.ModuleType("llama_cpp")
    llama.Llama = FakeLlama
    llama.llama_chat_format = handlers
    return llama, handlers


class FakeWorkerProxy:
    """只替换进程启动；真正的模型工厂和资源清理仍走 worker helper。"""
    worker = None
    def __init__(self, model_path, mmproj_path, context_length):
        self.native = self.worker.load_llm_model(model_path, mmproj_path, context_length)
    def __getattr__(self, name):
        return getattr(self.native, name)
    def close(self):
        self.worker.close_llm_model(self.native)


class LocalLLMCompatibilityTests(unittest.TestCase):
    def setUp(self):
        pe._LocalLLMStorage.unload()
        worker_path = ROOT / "guli_nodes" / "local_llm_worker.py"
        self.assertTrue(worker_path.is_file(), "缺少独立 worker 工厂")
        spec = importlib.util.spec_from_file_location("_compat_worker", worker_path)
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        FakeWorkerProxy.worker = worker
        from guli_nodes import local_llm_bridge as bridge
        import comfy.model_management as mm
        FakeLlama.instances = []
        FakeLlama.architecture = "qwen35"
        self.llama, self.handlers = fake_modules()
        self.patches = [patch.dict(sys.modules, {"llama_cpp": self.llama, "llama_cpp.llama_chat_format": self.handlers}),
                        patch.object(pe, "_resolve_gguf_path", side_effect=lambda name: name),
                        patch.object(bridge, "LocalLLMProxy", side_effect=FakeWorkerProxy),
                        patch.object(mm, "unload_all_models"), patch.object(mm, "soft_empty_cache")]
        mocks = [item.start() for item in self.patches]
        self.startup = mocks[2]
    def tearDown(self):
        pe._LocalLLMStorage.unload()
        for item in reversed(getattr(self, "patches", [])):
            item.stop()

    def test_qwen35_uses_its_own_visual_handler(self):
        llm = pe._LocalLLMStorage.load("PE.gguf", "PE.mmproj.gguf", 8192)
        self.assertIsInstance(llm.chat_handler, self.handlers.Qwen35ChatHandler)
        self.assertFalse(llm.chat_handler.kwargs.get("enable_thinking", True))

    def test_qwen3vl_does_not_reuse_qwen25_template(self):
        FakeLlama.architecture = "qwen3vl"
        llm = pe._LocalLLMStorage.load("Qwen3.gguf", "vision.gguf", 4096)
        self.assertIsInstance(llm.chat_handler, self.handlers.Qwen3VLChatHandler)

    def test_qwen2vl_legacy_handler_still_works(self):
        FakeLlama.architecture = "qwen2vl"
        llm = pe._LocalLLMStorage.load("Qwen2.gguf", "vision.gguf", 4096)
        self.assertIsInstance(llm.chat_handler, self.handlers.Qwen25VLChatHandler)

    def test_qwen2vl_has_qwen2_fallback(self):
        FakeLlama.architecture = "qwen2vl"
        del self.handlers.Qwen25VLChatHandler
        llm = pe._LocalLLMStorage.load("Qwen2.gguf", "vision.gguf", 4096)
        self.assertIsInstance(llm.chat_handler, self.handlers.Qwen2VLChatHandler)

    def test_missing_qwen35_handler_is_actionable_not_silent_fallback(self):
        del self.handlers.Qwen35ChatHandler
        with self.assertRaisesRegex(RuntimeError, "升级|不支持|Qwen3.5|Qwen35"):
            pe._LocalLLMStorage.load("PE.gguf", "vision.gguf", 8192)
        self.assertIsNone(pe._LocalLLMStorage.llm)

    def test_unknown_visual_architecture_is_rejected(self):
        FakeLlama.architecture = "unsupported_model"
        with self.assertRaisesRegex(RuntimeError, "架构|不支持"):
            pe._LocalLLMStorage.load("other.gguf", "vision.gguf", 8192)

    def test_text_only_load_does_not_require_any_visual_handler(self):
        FakeLlama.architecture = "llama"
        llm = pe._LocalLLMStorage.load("text.gguf", "无", 4096)
        self.assertIsNone(llm.chat_handler)

    def test_same_key_reuses_model(self):
        first = pe._LocalLLMStorage.load("PE.gguf", "vision.gguf", 4096)
        second = pe._LocalLLMStorage.load("PE.gguf", "vision.gguf", 4096)
        self.assertIs(first, second)
        self.assertEqual(len(FakeLlama.instances), 1)
        self.startup.assert_called_once_with("PE.gguf", "vision.gguf", 4096)

    def test_unload_closes_visual_projector_and_model(self):
        llm = pe._LocalLLMStorage.load("PE.gguf", "vision.gguf", 4096)
        handler = llm.chat_handler
        pe._LocalLLMStorage.unload()
        self.assertTrue(llm.closed)
        self.assertTrue(handler.closed)
        self.assertEqual(handler.close_calls, 1)
        self.assertIsNone(pe._LocalLLMStorage.llm)
        self.assertIsNone(pe._LocalLLMStorage.key)
        pe._LocalLLMStorage.unload()

    def test_failed_handler_construction_closes_loaded_model(self):
        class Broken(FakeHandler):
            def __init__(self, **kwargs):
                raise RuntimeError("test projector construction failure")
        self.handlers.Qwen35ChatHandler = Broken
        with self.assertRaisesRegex(RuntimeError, "projector"):
            pe._LocalLLMStorage.load("PE.gguf", "vision.gguf", 4096)
        self.assertEqual(len(FakeLlama.instances), 1)
        self.assertTrue(FakeLlama.instances[0].closed)
        self.assertIsNone(pe._LocalLLMStorage.llm)


class StandaloneGGUFDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gg_local_llm_")
        self.root = Path(self.temp.name).resolve()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.models = self.root / "models"
        self.folder = self.models / "LLM"
        (self.folder / "portrait").mkdir(parents=True)
        (self.folder / "portrait" / "PE.gguf").write_bytes(b"test only")
        (self.folder / "vision.mmproj.gguf").write_bytes(b"test only")
        (self.folder / "ignore.txt").write_text("not a model", encoding="utf8")
        self.patches = [patch.object(pe.folder_paths, "models_dir", str(self.models)), patch.object(pe.folder_paths, "get_filename_list", return_value=[]), patch.object(pe.folder_paths, "get_full_path", return_value=None)]
        for p in self.patches:
            p.start()
    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.temp.cleanup()

    def test_models_llm_is_discoverable_without_other_plugin_registration(self):
        names = [name.replace("\\", "/") for name in pe._gguf_choices(allow_none=False)]
        self.assertIn("portrait/PE.gguf", names)
        self.assertIn("vision.mmproj.gguf", names)
        self.assertNotIn("ignore.txt", names)

    def test_fallback_resolves_own_local_model(self):
        path = pe._resolve_gguf_path("portrait/PE.gguf")
        self.assertEqual(Path(path).resolve(), self.folder / "portrait" / "PE.gguf")

    def test_fallback_does_not_modify_global_model_categories(self):
        before = copy.deepcopy(pe.folder_paths.folder_names_and_paths)
        pe._gguf_choices(allow_none=False)
        pe._gguf_choices(allow_none=True)
        self.assertEqual(pe.folder_paths.folder_names_and_paths, before)

    def test_path_traversal_cannot_escape_local_model_directory(self):
        (self.models / "outside.gguf").write_bytes(b"not allowed")
        for name in ("../outside.gguf", "..\\outside.gguf", str(self.models / "outside.gguf")):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    pe._resolve_gguf_path(name)


if __name__ == "__main__":
    unittest.main()
