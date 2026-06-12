import asyncio
import hashlib
import json
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit, urlunsplit

try:
    from aiohttp import web
except Exception:
    web = None

try:
    from server import PromptServer
except Exception:
    PromptServer = None

try:
    from comfy_api.latest import io
except Exception:
    io = None


NODE_ID = "GGKeyInput"
DISPLAY_NAME = "GG 密钥输入"
CATEGORY = "GuliNodes/输入"
KEY_NAME = "密钥"
ENDPOINT_NAME = "端点"
MODEL_NAME = "模型名称"
CONFIG_NAME = "API配置"
CONFIG_TYPE = "GG_API_CONFIG"
DEFAULT_MODEL_NAME = "gpt-4o-mini"
TEST_ROUTE = "/guli/key_input/test"
TEST_TIMEOUT_SECONDS = 20
_ROUTES_REGISTERED = False
_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _normalize_key(value: str | None) -> str:
    return str(value or "").strip()


def _normalize_endpoint(value: str | None) -> str:
    return str(value or "").strip()


def _normalize_model_name(value: str | None) -> str:
    return str(value or "").strip() or DEFAULT_MODEL_NAME


def _fingerprint_config(key_value: str | None, endpoint_value: str | None, model_value: str | None) -> str:
    payload = "\n".join((_normalize_key(key_value), _normalize_endpoint(endpoint_value), _normalize_model_name(model_value)))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _build_api_config(key_value: str | None, endpoint_value: str | None, model_value: str | None) -> str:
    payload = {
        "type": CONFIG_TYPE,
        "version": 1,
        "key": _normalize_key(key_value),
        "endpoint": _normalize_endpoint(endpoint_value),
        "model": _normalize_model_name(model_value),
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _ensure_endpoint_url(value: str | None) -> str:
    endpoint = _normalize_endpoint(value)
    if not endpoint:
        raise ValueError("端点不能为空。")
    if "://" not in endpoint:
        endpoint = f"https://{endpoint}"

    parts = urlsplit(endpoint)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError("端点必须是 http 或 https URL。")

    path = parts.path.rstrip("/")
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def _chat_completions_url(endpoint: str) -> str:
    endpoint = _ensure_endpoint_url(endpoint)
    parts = urlsplit(endpoint)
    path = parts.path.rstrip("/")
    lower_path = path.lower()

    if lower_path.endswith("/chat/completions"):
        target_path = path
    elif lower_path.endswith("/models"):
        target_path = path[: -len("/models")].rstrip("/") + "/chat/completions"
    elif not path:
        target_path = "/v1/chat/completions"
    elif lower_path.endswith("/v1"):
        target_path = path + "/chat/completions"
    else:
        target_path = path + "/chat/completions"

    if not target_path.startswith("/"):
        target_path = f"/{target_path}"
    return urlunsplit((parts.scheme, parts.netloc, target_path, "", ""))


def _models_url(endpoint: str) -> str:
    endpoint = _ensure_endpoint_url(endpoint)
    parts = urlsplit(endpoint)
    path = parts.path.rstrip("/")
    lower_path = path.lower()

    if lower_path.endswith("/models"):
        target_path = path
    elif lower_path.endswith("/chat/completions"):
        target_path = path[: -len("/chat/completions")].rstrip("/") + "/models"
    elif not path:
        target_path = "/v1/models"
    elif lower_path.endswith("/v1"):
        target_path = path + "/models"
    else:
        target_path = path + "/models"

    if not target_path.startswith("/"):
        target_path = f"/{target_path}"
    return urlunsplit((parts.scheme, parts.netloc, target_path, "", ""))


def _format_url_context(url: str) -> str:
    return f"（测试地址：{url}）" if url else ""


def _elapsed_ms(started_at: float) -> int:
    return max(0, round((time.perf_counter() - started_at) * 1000))


def _with_elapsed(result: dict, started_at: float) -> dict:
    elapsed = _elapsed_ms(started_at)
    result["elapsed_ms"] = elapsed
    if result.get("ok"):
        result["message"] = f"{result.get('message') or '测试成功'}（{elapsed}ms）"
    return result


def _looks_like_connection_refused(error) -> bool:
    text = str(error or "").lower()
    return "10061" in text or "connection refused" in text or "actively refused" in text


def _new_chat_request(url: str, body: bytes, headers: dict[str, str]) -> urllib.request.Request:
    return urllib.request.Request(url, data=body, headers=headers, method="POST")


def _new_models_request(url: str, headers: dict[str, str]) -> urllib.request.Request:
    return urllib.request.Request(url, headers=headers, method="GET")


def _error_reason(error) -> str:
    return str(getattr(error, "reason", error))


def _urlopen_with_fallbacks(url: str, body: bytes, headers: dict[str, str], timeout: int):
    try:
        return _DIRECT_OPENER.open(_new_chat_request(url, body, headers), timeout=timeout)
    except urllib.error.HTTPError:
        raise
    except urllib.error.URLError as direct_error:
        try:
            return urllib.request.urlopen(_new_chat_request(url, body, headers), timeout=timeout)
        except urllib.error.HTTPError:
            raise
        except urllib.error.URLError as proxy_error:
            reason = f"直连失败：{_error_reason(direct_error)}；系统代理失败：{_error_reason(proxy_error)}"
            raise urllib.error.URLError(reason) from proxy_error


def _urlopen_get_with_fallbacks(url: str, headers: dict[str, str], timeout: int):
    try:
        return _DIRECT_OPENER.open(_new_models_request(url, headers), timeout=timeout)
    except urllib.error.HTTPError:
        raise
    except urllib.error.URLError as direct_error:
        try:
            return urllib.request.urlopen(_new_models_request(url, headers), timeout=timeout)
        except urllib.error.HTTPError:
            raise
        except urllib.error.URLError as proxy_error:
            reason = f"直连失败：{_error_reason(direct_error)}；系统代理失败：{_error_reason(proxy_error)}"
            raise urllib.error.URLError(reason) from proxy_error


def _short_text(value: str, limit: int = 800) -> str:
    text = str(value or "").strip()
    return text if len(text) <= limit else f"{text[:limit]}..."


def _extract_error_message(text: str) -> str:
    text = _short_text(text)
    if not text:
        return ""
    try:
        data = json.loads(text)
    except Exception:
        return text

    error = data.get("error") if isinstance(data, dict) else None
    if isinstance(error, dict):
        return _short_text(error.get("message") or error.get("type") or text)
    if isinstance(error, str):
        return _short_text(error)
    if isinstance(data, dict):
        for key in ("message", "detail", "error_description"):
            if data.get(key):
                return _short_text(data[key])
    return text


def _request_headers(key_value: str | None, *, content_type: bool = False) -> dict[str, str]:
    headers = {
        "Accept": "application/json",
        "User-Agent": "ComfyUI-GuliNodes/KeyInputTest",
    }
    if content_type:
        headers["Content-Type"] = "application/json"
    api_key = _normalize_key(key_value)
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _read_http_error(exc: urllib.error.HTTPError) -> str:
    try:
        return exc.read().decode("utf-8", errors="replace")
    except Exception:
        return str(exc)


def _test_models_endpoint(endpoint: str | None, key_value: str | None) -> dict:
    started_at = time.perf_counter()
    url = ""
    try:
        url = _models_url(endpoint or "")
        with _urlopen_get_with_fallbacks(url, _request_headers(key_value), timeout=TEST_TIMEOUT_SECONDS) as response:
            raw_text = response.read().decode("utf-8", errors="replace")
            status = getattr(response, "status", 200)

        try:
            data = json.loads(raw_text) if raw_text else {}
        except Exception:
            data = {}

        if isinstance(data, dict) and data.get("error"):
            return {
                "ok": False,
                "status": status,
                "message": f"{_extract_error_message(raw_text) or 'Models 接口返回了错误信息。'}{_format_url_context(url)}",
                "endpoint": url,
            }

        return _with_elapsed({
            "ok": True,
            "status": status,
            "message": "测试成功：端点和密钥可用",
            "endpoint": url,
        }, started_at)
    except urllib.error.HTTPError as exc:
        error_text = _read_http_error(exc)
        error_url = getattr(exc, "url", "") or url
        return {
            "ok": False,
            "status": getattr(exc, "code", 0),
            "message": f"HTTP {getattr(exc, 'code', '')}: {_extract_error_message(error_text) or str(exc)}{_format_url_context(error_url)}",
            "endpoint": error_url,
        }
    except urllib.error.URLError as exc:
        return {
            "ok": False,
            "status": 0,
            "message": f"连接失败：{getattr(exc, 'reason', exc)}{_format_url_context(url)}",
            "endpoint": url,
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": 0,
            "message": f"{exc}{_format_url_context(url)}",
            "endpoint": url,
        }


def _test_openai_compatible_settings(endpoint: str | None, key_value: str | None, model_value: str | None) -> dict:
    started_at = time.perf_counter()
    url = ""
    try:
        url = _chat_completions_url(endpoint or "")
        model_name = _normalize_model_name(model_value)
        if not model_name:
            raise ValueError("模型名称不能为空。")

        payload = {
            "model": model_name,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
            "temperature": 0,
            "stream": False,
        }
        body = json.dumps(payload).encode("utf-8")
        headers = _request_headers(key_value, content_type=True)

        with _urlopen_with_fallbacks(url, body, headers, timeout=TEST_TIMEOUT_SECONDS) as response:
            raw_text = response.read().decode("utf-8", errors="replace")
            status = getattr(response, "status", 200)

        try:
            data = json.loads(raw_text) if raw_text else {}
        except Exception:
            data = {}

        if isinstance(data, dict) and data.get("error"):
            message = _extract_error_message(raw_text) or "API 返回了错误信息。"
            models_result = _test_models_endpoint(endpoint, key_value)
            if models_result.get("ok"):
                return _with_elapsed({
                    "ok": True,
                    "status": models_result.get("status", 200),
                    "message": f"测试成功：端点和密钥可用；Chat 返回错误：{message}",
                    "endpoint": models_result.get("endpoint") or url,
                }, started_at)
            return {
                "ok": False,
                "status": status,
                "message": f"{message}{_format_url_context(url)}",
                "endpoint": url,
            }

        return _with_elapsed({
            "ok": True,
            "status": status,
            "message": f"测试成功：模型 {model_name} 可用",
            "endpoint": url,
        }, started_at)
    except urllib.error.HTTPError as exc:
        error_text = _read_http_error(exc)
        message = _extract_error_message(error_text) or str(exc)
        error_url = getattr(exc, "url", "") or url
        models_result = _test_models_endpoint(endpoint, key_value)
        if models_result.get("ok"):
            return _with_elapsed({
                "ok": True,
                "status": models_result.get("status", 200),
                "message": f"测试成功：端点和密钥可用；Chat HTTP {getattr(exc, 'code', '')}: {message}",
                "endpoint": models_result.get("endpoint") or error_url,
            }, started_at)
        return {
            "ok": False,
            "status": getattr(exc, "code", 0),
            "message": f"HTTP {getattr(exc, 'code', '')}: {message}{_format_url_context(error_url)}",
            "endpoint": error_url,
        }
    except urllib.error.URLError as exc:
        models_result = _test_models_endpoint(endpoint, key_value)
        if models_result.get("ok"):
            return _with_elapsed({
                "ok": True,
                "status": models_result.get("status", 200),
                "message": f"测试成功：端点和密钥可用；Chat 连接失败：{getattr(exc, 'reason', exc)}",
                "endpoint": models_result.get("endpoint") or url,
            }, started_at)
        return {
            "ok": False,
            "status": 0,
            "message": f"连接失败：{getattr(exc, 'reason', exc)}{_format_url_context(url)}",
            "endpoint": url,
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": 0,
            "message": f"{exc}{_format_url_context(url)}",
            "endpoint": url,
        }


def _register_key_test_route() -> None:
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED or PromptServer is None or getattr(PromptServer, "instance", None) is None or web is None:
        return

    @PromptServer.instance.routes.post(TEST_ROUTE)
    async def guli_key_input_test(request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            _test_openai_compatible_settings,
            payload.get("endpoint"),
            payload.get("key"),
            payload.get("model"),
        )
        return web.json_response(result)

    _ROUTES_REGISTERED = True


_register_key_test_route()


if io is not None:

    class GGKeyInput(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id=NODE_ID,
                display_name=DISPLAY_NAME,
                category=CATEGORY,
                description="输入 API Key、访问令牌、API 端点和模型名称，并输出统一 API 配置。",
                search_aliases=["KeyInput", "API Key Input", "Endpoint Input", "Model Input", "API Config", "密钥输入", "端点设置", "模型名称", "API配置"],
                inputs=[
                    io.String.Input(
                        KEY_NAME,
                        default="",
                        multiline=False,
                        placeholder="输入 API Key 或访问令牌",
                    ),
                    io.String.Input(
                        ENDPOINT_NAME,
                        default="",
                        multiline=False,
                        placeholder="输入 API Endpoint / Base URL（可选）",
                    ),
                    io.String.Input(
                        MODEL_NAME,
                        default=DEFAULT_MODEL_NAME,
                        multiline=False,
                        placeholder="输入 API 模型名称",
                    ),
                ],
                outputs=[
                    io.String.Output(display_name=CONFIG_NAME),
                ],
            )

        @classmethod
        def execute(cls, 密钥: str = "", 端点: str = "", 模型名称: str = DEFAULT_MODEL_NAME):
            return io.NodeOutput(_build_api_config(密钥, 端点, 模型名称))

        @classmethod
        def IS_CHANGED(cls, 密钥: str = "", 端点: str = "", 模型名称: str = DEFAULT_MODEL_NAME):
            return _fingerprint_config(密钥, 端点, 模型名称)

else:

    class GGKeyInput:
        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    KEY_NAME: (
                        "STRING",
                        {
                            "default": "",
                            "multiline": False,
                            "placeholder": "输入 API Key 或访问令牌",
                        },
                    ),
                    ENDPOINT_NAME: (
                        "STRING",
                        {
                            "default": "",
                            "multiline": False,
                            "placeholder": "输入 API Endpoint / Base URL（可选）",
                        },
                    ),
                    MODEL_NAME: (
                        "STRING",
                        {
                            "default": DEFAULT_MODEL_NAME,
                            "multiline": False,
                            "placeholder": "输入 API 模型名称",
                        },
                    ),
                },
            }

        RETURN_TYPES = ("STRING",)
        RETURN_NAMES = (CONFIG_NAME,)
        FUNCTION = "execute"
        CATEGORY = CATEGORY
        DESCRIPTION = "输入 API Key、访问令牌、API 端点和模型名称，并输出统一 API 配置。"

        def execute(self, 密钥: str = "", 端点: str = "", 模型名称: str = DEFAULT_MODEL_NAME):
            return (_build_api_config(密钥, 端点, 模型名称),)

        @classmethod
        def IS_CHANGED(cls, 密钥: str = "", 端点: str = "", 模型名称: str = DEFAULT_MODEL_NAME):
            return _fingerprint_config(密钥, 端点, 模型名称)


NODE_CLASS_MAPPINGS = {
    NODE_ID: GGKeyInput,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: DISPLAY_NAME,
}
