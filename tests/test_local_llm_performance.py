"""Worker GPU bootstrap tests; no native libraries or weights required."""
import importlib.util
import os
import sys
import tempfile
import unittest
import ast
import types
import builtins
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class WorkerDLLPathTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "performance_worker", ROOT / "guli_nodes" / "local_llm_worker.py"
        )
        self.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.worker)

    def prepare(self):
        prepare = getattr(self.worker, "_prepare_windows_dll_paths", None)
        self.assertTrue(callable(prepare), "Worker must register CUDA DLL paths before importing llama_cpp")
        return prepare()

    def test_windows_registers_both_loaders_and_retains_handles(self):
        with tempfile.TemporaryDirectory(prefix="gg_dll_test_") as directory:
            site = Path(directory) / "site-packages"
            runtime_dirs = [site / "torch" / "lib", site / "nvidia" / "cublas" / "bin"]
            for path in runtime_dirs:
                path.mkdir(parents=True)
            handles = []

            def register(path):
                handle = object()
                handles.append(handle)
                return handle

            with patch.object(sys, "platform", "win32"), \
                    patch("sysconfig.get_path", return_value=str(site)), \
                    patch.dict(os.environ, {"PATH": "original-path", "CUDA_PATH": ""}), \
                    patch.object(os, "add_dll_directory", side_effect=register, create=True) as add:
                self.prepare()
                entries = os.environ["PATH"].split(os.pathsep)
                self.assertTrue(all(str(path) in entries for path in runtime_dirs))
                self.assertEqual(entries[-1], "original-path")
                self.assertEqual({call.args[0] for call in add.call_args_list}, {str(path) for path in runtime_dirs})
                self.assertTrue(all(handle in self.worker._DLL_DIRECTORY_HANDLES.values() for handle in handles))
                before = os.environ["PATH"]
                self.prepare()
                self.assertEqual(os.environ["PATH"], before)
                self.assertEqual(add.call_count, 2)

    def test_non_windows_keeps_environment_untouched(self):
        with patch.object(sys, "platform", "linux"), \
                patch.dict(os.environ, {"PATH": "original-path"}), \
                patch.object(os, "add_dll_directory", create=True) as add:
            self.prepare()
            self.assertEqual(os.environ["PATH"], "original-path")
            add.assert_not_called()

    def test_missing_optional_runtime_dirs_are_skipped(self):
        with tempfile.TemporaryDirectory(prefix="gg_dll_missing_") as directory:
            with patch.object(sys, "platform", "win32"), \
                    patch("sysconfig.get_path", return_value=directory), \
                    patch.dict(os.environ, {"PATH": "original-path", "CUDA_PATH": ""}), \
                    patch.object(os, "add_dll_directory", create=True) as add:
                self.prepare()
                self.assertEqual(os.environ["PATH"], "original-path")
                add.assert_not_called()

    def test_bootstrap_runs_before_llama_import(self):
        tree = ast.parse((ROOT / "guli_nodes" / "local_llm_worker.py").read_text(encoding="utf-8"))
        factory = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "load_llm_model")
        calls = [node.lineno for node in ast.walk(factory) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Name) and node.func.id == "_prepare_windows_dll_paths"]
        imports = [node.lineno for node in ast.walk(factory) if isinstance(node, ast.ImportFrom) and node.module == "llama_cpp"]
        self.assertTrue(calls, "Model factory must invoke CUDA bootstrap")
        self.assertLess(min(calls), min(imports))

    def test_factory_executes_bootstrap_before_native_import(self):
        events = []
        fake = types.ModuleType("llama_cpp")
        fake.Llama = lambda **kwargs: types.SimpleNamespace(chat_handler=None, metadata={})
        original = builtins.__import__

        def record_import(name, *args, **kwargs):
            if name == "llama_cpp":
                events.append("import")
            return original(name, *args, **kwargs)

        with patch.dict(sys.modules, {"llama_cpp": fake}), \
                patch.object(self.worker, "_prepare_windows_dll_paths", side_effect=lambda: events.append("bootstrap")), \
                patch.object(builtins, "__import__", side_effect=record_import):
            self.worker.load_llm_model("fake.gguf", "", 512)
        self.assertEqual(events, ["bootstrap", "import"])

    def test_add_dll_directory_failure_still_registers_path(self):
        with tempfile.TemporaryDirectory(prefix="gg_dll_fallback_") as directory:
            root = Path(directory)
            runtime = root / "torch" / "lib"
            runtime.mkdir(parents=True)
            with patch.object(sys, "platform", "win32"), \
                    patch("sysconfig.get_path", return_value=directory), \
                    patch.dict(os.environ, {"PATH": "original-path", "CUDA_PATH": ""}), \
                    patch.object(os, "add_dll_directory", side_effect=OSError("test loader failure"), create=True):
                self.prepare()
                self.assertIn(str(runtime), os.environ["PATH"].split(os.pathsep))
                before = os.environ["PATH"]
                self.prepare()
                self.assertEqual(os.environ["PATH"], before)

    def test_backend_info_is_native_and_rpc_is_not_called_cuda(self):
        info = getattr(self.worker, "_llm_backend_info", None)
        self.assertTrue(callable(info), "Worker must report native backend info")
        fake = types.ModuleType("llama_cpp")
        fake.llama_print_system_info = lambda: b"CPU : TEST=1 | RPC=1"
        with patch.dict(sys.modules, {"llama_cpp": fake}):
            self.assertEqual(info(), "CPU : TEST=1 | RPC=1")
        fake.llama_print_system_info = lambda: b"CUDA : ARCHS=890 | CPU : TEST=1"
        with patch.dict(sys.modules, {"llama_cpp": fake}):
            self.assertIn("CUDA", info())

    def test_older_library_missing_diagnostics_keeps_working(self):
        info = getattr(self.worker, "_llm_backend_info", None)
        self.assertTrue(callable(info), "Worker must tolerate missing diagnostics")
        with patch.dict(sys.modules, {"llama_cpp": types.ModuleType("llama_cpp")}):
            self.assertEqual(info(), "")


if __name__ == "__main__":
    unittest.main()
