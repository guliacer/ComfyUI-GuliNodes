import asyncio
import json
import urllib.error
import urllib.request

try:
    from aiohttp import web
except Exception:
    web = None

try:
    from server import PromptServer
except Exception:
    PromptServer = None


NOTIFY_ROUTE = "/guli/taprelay/notify"
TAPRELAY_ENDPOINT = "http://127.0.0.1:1122/send"
DEFAULT_SOURCE = "comfyui"
DEFAULT_STATUS = "completed"
REQUEST_TIMEOUT_SECONDS = 3
MAX_MESSAGE_LENGTH = 500
MAX_TASK_ID_LENGTH = 200
MAX_CWD_LENGTH = 240
MAX_SOURCE_LENGTH = 40
MAX_STATUS_LENGTH = 20
MAX_PROJECT_NAME_LENGTH = 200
MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000
_ROUTES_REGISTERED = False
_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _normalize_string(value, default="", max_length=200):
    if not isinstance(value, str):
        return default
    value = value.strip()
    return value[:max_length] if value else default


def _normalize_notify_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("通知数据必须是 JSON 对象。")

    message = payload.get("message")
    if not isinstance(message, str):
        raise ValueError("message 必须是 1 到 500 个字符。")
    message = message.strip()
    if not message or len(message) > MAX_MESSAGE_LENGTH:
        raise ValueError("message 必须是 1 到 500 个字符。")

    project_name = _normalize_string(
        payload.get("projectName"), max_length=MAX_PROJECT_NAME_LENGTH
    )

    duration_ms = payload.get("durationMs", 0)
    if isinstance(duration_ms, bool) or not isinstance(duration_ms, int):
        duration_ms = 0
    if duration_ms < 0 or duration_ms > MAX_DURATION_MS:
        duration_ms = 0

    return {
        "message": message,
        "projectName": project_name,
        "source": _normalize_string(payload.get("source"), DEFAULT_SOURCE, MAX_SOURCE_LENGTH),
        "status": _normalize_string(payload.get("status"), DEFAULT_STATUS, MAX_STATUS_LENGTH),
        "taskId": _normalize_string(payload.get("taskId"), max_length=MAX_TASK_ID_LENGTH),
        "cwd": _normalize_string(payload.get("cwd"), max_length=MAX_CWD_LENGTH),
        "durationMs": duration_ms,
    }


def _post_to_taprelay(payload):
    request_body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        TAPRELAY_ENDPOINT,
        data=request_body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with _DIRECT_OPENER.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            response.read(4096)
            return response.status
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"TapRelay 返回 HTTP {exc.code}。") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError("无法连接 TapRelay，请确认 TapRelay 已启动并监听 1122 端口。") from exc
    except TimeoutError as exc:
        raise RuntimeError("连接 TapRelay 超时，请确认 TapRelay 已启动。") from exc
    except OSError as exc:
        raise RuntimeError("连接 TapRelay 失败，请确认 TapRelay 已启动。") from exc


def _register_taprelay_route():
    global _ROUTES_REGISTERED
    if (
        _ROUTES_REGISTERED
        or PromptServer is None
        or getattr(PromptServer, "instance", None) is None
        or web is None
    ):
        return

    @PromptServer.instance.routes.post(NOTIFY_ROUTE)
    async def guli_taprelay_notify(request):
        try:
            payload = await request.json()
            normalized_payload = _normalize_notify_payload(payload)
        except ValueError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)
        except Exception:
            return web.json_response({"ok": False, "error": "通知数据必须是有效的 JSON。"}, status=400)

        try:
            status_code = await asyncio.to_thread(_post_to_taprelay, normalized_payload)
        except RuntimeError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=502)

        return web.json_response({"ok": True, "status": "sent", "taprelayStatus": status_code})

    _ROUTES_REGISTERED = True


_register_taprelay_route()


# This module exposes a ComfyUI route only; it does not add a workflow node.
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
