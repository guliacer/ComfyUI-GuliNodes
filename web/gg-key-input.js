import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ggIcon } from "./gg-ui-icons.js";

const NODE_NAME = "GGKeyInput";
const KEY_WIDGET_NAME = "密钥";
const ENDPOINT_WIDGET_NAME = "端点";
const MODEL_WIDGET_NAME = "模型名称";
const DOM_WIDGET_NAME = "gg_key_input";
const HIDDEN_TYPE = "ggHiddenKeyInput";
const STORAGE_KEY = "GuliNodes.ggKeyInput";
const TEST_ROUTE = "/guli/key_input/test";
const MODELS_ROUTE = "/guli/key_input/models";
const MIN_WIDTH = 340;
const PANEL_HEIGHT = 144;
const MODEL_PICKER_EXTRA_HEIGHT = 35;
const COMPACT_NODE_HEIGHT = PANEL_HEIGHT;
// 历史版本的紧凑高度。只迁移这些精确的自动布局高度，避免覆盖用户手动拉高的节点。
const PREVIOUS_COMPACT_NODE_HEIGHT = 178;
const LEGACY_COMPACT_NODE_HEIGHT = 198;
const NODE_INSET = 28;
const DEFAULT_MASKED = false;

const API_KEY_FIELD_ALIASES = [
  "api key", "api_key", "api-key", "apikey", "x-api-key", "access key",
  "secret key", "api secret", "api密钥", "api 秘钥", "api令牌", "api 令牌",
  "访问令牌", "access token", "access_token", "access-token", "auth token",
  "auth_token", "auth-token", "bearer token", "bearer_token", "bearer-token",
  "authorization", "密钥", "秘钥", "令牌", "口令",
];
const ENDPOINT_FIELD_ALIASES = [
  "api endpoint", "api_endpoint", "api-endpoint", "api url", "api_url", "api-url",
  "api base", "api_base", "api-base", "api base url", "api_base_url", "api-base-url",
  "api地址", "api接口", "api端点", "endpoint url", "endpoint_url", "endpoint-url",
  "endpoint", "base url", "base_url", "base-url", "baseurl", "接口地址", "接口网址",
  "接口URL", "接口", "请求地址", "请求网址", "请求URL", "基础地址", "基础网址",
  "基础URL", "服务地址", "服务端点", "端点配置", "端点",
];
const MODEL_FIELD_ALIASES = ["model", "model name", "model_name", "model-name", "模型", "模型名称"];
const GENERIC_URL_FIELD_ALIASES = ["url", "uri", "链接", "地址"];
const GENERIC_KEY_FIELD_ALIASES = ["key"];
const TOKEN_FIELD_ALIASES = ["token"];
const KNOWN_API_BASE_URLS = {
  "api.openai.com": "https://api.openai.com/v1",
  "api.deepseek.com": "https://api.deepseek.com/v1",
  "openrouter.ai": "https://openrouter.ai/api/v1",
  "api.groq.com": "https://api.groq.com/openai/v1",
  "api.siliconflow.cn": "https://api.siliconflow.cn/v1",
  "api.moonshot.cn": "https://api.moonshot.cn/v1",
  "open.bigmodel.cn": "https://open.bigmodel.cn/api/paas/v4",
  "dashscope.aliyuncs.com": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "generativelanguage.googleapis.com": "https://generativelanguage.googleapis.com/v1beta/openai",
  "api.together.xyz": "https://api.together.xyz/v1",
  "api.fireworks.ai": "https://api.fireworks.ai/inference/v1",
  "api.mistral.ai": "https://api.mistral.ai/v1",
  "api.x.ai": "https://api.x.ai/v1",
  "integrate.api.nvidia.com": "https://integrate.api.nvidia.com/v1",
  "api.cohere.ai": "https://api.cohere.ai/compatibility/v1",
  "ark.cn-beijing.volces.com": "https://ark.cn-beijing.volces.com/api/v3",
};

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function nodeStoreKey(node) {
  return String(node.id ?? node.type ?? NODE_NAME);
}

function readStoredConfig(node) {
  const value = readStore()[nodeStoreKey(node)];
  if (typeof value === "string") {
    return { key: value, endpoint: "", model: "" };
  }
  if (!value || typeof value !== "object") {
    return { key: "", endpoint: "", model: "" };
  }
  return {
    key: String(value.key ?? value.apiKey ?? value["密钥"] ?? ""),
    endpoint: String(value.endpoint ?? value.url ?? value["端点"] ?? ""),
    model: String(value.model ?? value.modelName ?? value["模型名称"] ?? ""),
  };
}

function saveStoredConfig(node, config) {
  const store = readStore();
  const storeKey = nodeStoreKey(node);
  const current = readStoredConfig(node);
  const next = {
    key: String(config.key ?? current.key ?? "").trim(),
    endpoint: String(config.endpoint ?? current.endpoint ?? "").trim(),
    model: String(config.model ?? current.model ?? "").trim(),
  };

  if (next.key || next.endpoint || next.model) {
    store[storeKey] = next;
  } else {
    delete store[storeKey];
  }
  writeStore(store);
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function normalizeFieldName(value) {
  return String(value || "").toLocaleLowerCase().replace(/[\s_.-]/g, "");
}

function hasFieldAliasSuffix(fieldName, alias) {
  const fieldParts = String(fieldName || "").toLocaleLowerCase().split(/[\s_.-]+/).filter(Boolean);
  const aliasParts = String(alias || "").toLocaleLowerCase().split(/[\s_.-]+/).filter(Boolean);
  if (fieldParts.length <= aliasParts.length) return false;
  return fieldParts.slice(-aliasParts.length).join("") === aliasParts.join("");
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function getJsonValue(record, aliases, depth = 0) {
  if (!isRecord(record)) return "";
  const normalizedAliases = new Set(aliases.map(normalizeFieldName));
  for (const [key, value] of Object.entries(record)) {
    if (!normalizedAliases.has(normalizeFieldName(key)) && !aliases.some((alias) => hasFieldAliasSuffix(key, alias))) continue;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (depth >= 2) return "";
  for (const value of Object.values(record)) {
    const nested = getJsonValue(value, aliases, depth + 1);
    if (nested) return nested;
  }
  return "";
}

function extractJsonObject(text) {
  const candidate = String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!candidate.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(candidate);
    return isRecord(parsed) ? parsed : null;
  } catch {
    const start = candidate.indexOf("{");
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < candidate.length; index += 1) {
      const character = candidate[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(candidate.slice(start, index + 1));
          return isRecord(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toFieldAliasPattern(value) {
  return String(value).split(/[\s_.-]+/).map(escapeRegExp).join("[\\s_.-]*");
}

function extractNamedValue(input, names) {
  const labels = [...names]
    .sort((left, right) => right.length - left.length)
    .map(toFieldAliasPattern)
    .join("|");
  const pattern = [
    `(?:["'](?:${labels})["']|(?<![A-Za-z0-9_?&#\\u3400-\\u9fff])(?:${labels})(?![A-Za-z0-9_-]))`,
    `\\s*[:=：]\\s*`,
    `(?:["']([^"']*)["']|([^\\s,;}&\\]\\)"']+))`,
  ].join("");
  const match = String(input || "").match(new RegExp(pattern, "i"));
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

function findFirstHttpUrl(input) {
  return String(input || "").match(/https?:\/\/[^\s<>"'\\\])}]+/i)?.[0]?.replace(/[),.;]+$/, "") || "";
}

function extractCurlEndpoint(input) {
  const command = String(input || "").slice(String(input || "").search(/\bcurl\b/i)).replace(/^curl\b/i, "");
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|`(?:\\.|[^`\\])*`|\S+/g) || [];
  const valueOptions = new Set([
    "-h", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
    "--json", "-f", "--form", "--form-string", "-x", "--request", "--proxy", "--user", "-u",
  ]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const option = token.toLocaleLowerCase();
    if (option === "--url") return findFirstHttpUrl(tokens[index + 1] || "");
    if (option.startsWith("--url=")) return findFirstHttpUrl(token.slice(token.indexOf("=") + 1));
    if (valueOptions.has(option) || [...valueOptions].some((valueOption) => option.startsWith(`${valueOption}=`))) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    const url = findFirstHttpUrl(token);
    if (url) return url;
  }
  return "";
}

function extractUrlCandidate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const explicitUrl = findFirstHttpUrl(text);
  if (explicitUrl) return explicitUrl;
  const token = text.split(/\s+/)[0].replace(/^['"`]|['"`,.;]+$/g, "");
  if (/^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/.*)?$/i.test(token)) return token;
  if (/^[A-Za-z0-9.-]+(?::\d+)?(?:\/.*)?$/.test(token) && token.includes(".")) return token;
  return "";
}

function parseHttpUrl(value) {
  const candidate = extractUrlCandidate(value);
  if (!candidate) return null;
  const values = /^[a-z][a-z\d+.-]*:\/\//i.test(candidate) ? [candidate] : [candidate, `https://${candidate}`];
  for (const item of values) {
    try {
      const parsed = new URL(item);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed;
    } catch {
      // Try the HTTPS fallback for bare domains.
    }
  }
  return null;
}

function normalizeEndpointUrl(value) {
  const parsed = parseHttpUrl(value);
  if (!parsed) return "";
  const hostname = parsed.hostname.toLocaleLowerCase();
  const knownBaseUrl = KNOWN_API_BASE_URLS[hostname];
  if (knownBaseUrl) return knownBaseUrl;

  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  let path = parsed.pathname.replace(/\/+$/, "");
  if (!path || path === "/") path = "/v1";
  else if (!/\/v1(?:\/|$)/i.test(path)) path = "/v1";
  return `${parsed.protocol}//${parsed.host}${path}`;
}

function cleanClipboardKey(value) {
  return String(value || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["'`]|["'`,.;]+$/g, "")
    .trim();
}

function parseClipboardConnection(input) {
  const text = String(input || "").trim();
  if (!text) return null;

  const json = extractJsonObject(text);
  if (json) {
    const apiKey = cleanClipboardKey(firstString(
      getJsonValue(json, API_KEY_FIELD_ALIASES),
      getJsonValue(json, TOKEN_FIELD_ALIASES),
      getJsonValue(json, GENERIC_KEY_FIELD_ALIASES),
    ));
    const endpoint = firstString(
      getJsonValue(json, ENDPOINT_FIELD_ALIASES),
      getJsonValue(json, GENERIC_URL_FIELD_ALIASES),
    );
    const model = firstString(getJsonValue(json, MODEL_FIELD_ALIASES));
    if (apiKey || endpoint || model) return { key: apiKey, endpoint, model, source: "json" };
  }

  const isCurl = /^\s*curl\b/i.test(text);
  const bearerMatch = text.match(/(?:authorization|auth|api[\s_-]*key|密钥|秘钥|令牌|token)\s*[:=：]\s*bearer\s+([A-Za-z0-9._~+/=-]+)/i);
  const key = cleanClipboardKey(firstString(
    bearerMatch?.[1],
    extractNamedValue(text, API_KEY_FIELD_ALIASES),
    extractNamedValue(text, TOKEN_FIELD_ALIASES),
    extractNamedValue(text, GENERIC_KEY_FIELD_ALIASES),
  ));
  const endpoint = firstString(
    extractNamedValue(text, ENDPOINT_FIELD_ALIASES),
    isCurl ? extractCurlEndpoint(text) : findFirstHttpUrl(text),
  );
  const model = extractNamedValue(text, MODEL_FIELD_ALIASES);
  if (key || endpoint || model) return { key, endpoint, model, source: isCurl ? "curl" : "text" };
  if (!/[\s\r\n]/.test(text)) return { key: cleanClipboardKey(text), endpoint: "", model: "", source: "plain-key" };
  return null;
}

function normalizedClipboardEndpoint(input) {
  const parsed = parseClipboardConnection(input);
  return normalizeEndpointUrl(parsed?.endpoint || input);
}

function getWidget(node, name) {
  return node.widgets?.find((widget) => widget?.name === name) ?? null;
}

function syncWidgetValue(widget, value) {
  if (!widget) return;
  const text = String(value || "").trim();
  widget.value = text;
  widget.callback?.(text);
}

function hideConfigWidget(widget) {
  if (!widget || widget._ggKeyInputHidden) return;
  widget._ggKeyInputHidden = true;
  widget._ggKeyInputOriginalType = widget.type;
  widget._ggKeyInputOriginalComputeSize = widget.computeSize;
  widget.hidden = true;
  widget.type = HIDDEN_TYPE;
  widget.computeSize = () => [0, -4];
}

function inputStyle() {
  return {
    width: "100%",
    minWidth: "0",
    height: "30px",
    border: "1px solid rgba(127,127,127,0.35)",
    borderRadius: "6px",
    padding: "0 10px",
    outline: "none",
    color: "var(--input-text, #222)",
    background: "var(--comfy-input-bg, rgba(255,255,255,0.9))",
    boxSizing: "border-box",
  };
}

function buttonStyle() {
  return {
    flex: "0 0 auto",
    width: "32px",
    height: "30px",
    border: "1px solid rgba(127,127,127,0.35)",
    borderRadius: "8px",
    padding: "0",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--gg-ui-ink)",
    background: "var(--comfy-menu-bg, rgba(245,245,245,0.95))",
    cursor: "pointer",
  };
}

function actionButtonStyle() {
  return {
    ...buttonStyle(),
    width: "auto",
    minWidth: "32px",
    padding: "0 8px",
    gap: "4px",
    fontSize: "11px",
    whiteSpace: "nowrap",
  };
}

function selectStyle() {
  return {
    ...inputStyle(),
    padding: "0 8px",
    cursor: "pointer",
  };
}

function statusStyle() {
  return {
    flex: "1 1 auto",
    minWidth: "0",
    height: "26px",
    lineHeight: "26px",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    fontSize: "11px",
    color: "var(--gg-ui-muted, #6b7280)",
    boxSizing: "border-box",
  };
}

function setTestStatus(panel, state, message) {
  if (!panel?.status) return;
  panel.status.textContent = message || "";
  panel.status.title = message || "";
  const colors = {
    idle: "var(--gg-ui-muted, #6b7280)",
    testing: "var(--gg-ui-warning, #f59e0b)",
    success: "var(--gg-ui-success, #22c55e)",
    error: "var(--gg-ui-danger, #ef4444)",
  };
  panel.status.style.color = colors[state] || colors.idle;
  panel.testButton?.classList.toggle("gg-state-success", state === "success");
}

function setTestBusy(panel, busy) {
  if (!panel?.testButton) return;
  panel.testButton.disabled = busy;
  panel.testButton.style.cursor = busy ? "wait" : "pointer";
  panel.testButton.style.opacity = busy ? "0.72" : "1";
  panel.testButton.innerHTML = ggIcon(busy ? "more" : "zap", 16);
}

function setModelFetchBusy(panel, busy) {
  if (!panel?.modelFetchButton) return;
  panel.modelFetchButton.disabled = busy;
  panel.modelFetchButton.style.cursor = busy ? "wait" : "pointer";
  panel.modelFetchButton.style.opacity = busy ? "0.72" : "1";
  panel.modelFetchButton.innerHTML = `${ggIcon(busy ? "more" : "catModel", 15)}<span>${busy ? "获取中" : "获取模型"}</span>`;
}

function maskMiddle(value, prefix = 6, suffix = 4) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= prefix + suffix + 3) {
    if (text.length <= 4) return "*".repeat(text.length);
    return `${text.slice(0, 2)}***${text.slice(-2)}`;
  }
  return `${text.slice(0, prefix)}...${text.slice(-suffix)}`;
}

function syncSensitiveRawFromInputs(panel) {
  if (!panel || panel.masked) return;
  panel.rawKey = panel.keyInput?.value || "";
  panel.rawEndpoint = panel.endpointInput?.value || "";
}

function setSensitiveReadonly(panel, readonly) {
  if (!panel) return;
  [panel.endpointInput, panel.keyInput].forEach((input) => {
    if (!input) return;
    input.readOnly = readonly;
    input.style.cursor = readonly ? "default" : "text";
    input.style.opacity = readonly ? "0.82" : "1";
  });
}

function refreshSensitiveDisplay(panel) {
  if (!panel) return;
  const masked = Boolean(panel.masked);
  if (panel.endpointInput) {
    panel.endpointInput.value = masked ? maskMiddle(panel.rawEndpoint, 18, 8) : panel.rawEndpoint || "";
  }
  if (panel.keyInput) {
    panel.keyInput.value = masked ? maskMiddle(panel.rawKey, 6, 4) : panel.rawKey || "";
  }
  setSensitiveReadonly(panel, masked);
  if (panel.maskButton) {
    panel.maskButton.innerHTML = ggIcon(masked ? "eye" : "eyeOff", 16);
    panel.maskButton.title = masked ? "显示完整端点和密钥" : "部分隐藏端点和密钥";
    panel.maskButton.setAttribute("aria-label", panel.maskButton.title);
  }
}

function setMaskState(panel, masked) {
  if (!panel) return;
  if (!panel.masked) syncSensitiveRawFromInputs(panel);
  panel.masked = Boolean(masked);
  refreshSensitiveDisplay(panel);
}

async function runConfigTest(panel) {
  if (!panel || panel._testing) return;
  syncSensitiveRawFromInputs(panel);
  applyEndpointNormalization(panel);
  panel._testing = true;
  setTestBusy(panel, true);
  setTestStatus(panel, "testing", "测试中...");

  try {
    const response = await api.fetchApi(TEST_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: panel.rawKey || "",
        endpoint: panel.rawEndpoint || "",
        model: panel.modelInput?.value || "",
      }),
      cache: "no-store",
    });

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = { ok: false, message: await response.text() };
    }

    if (!response.ok) {
      throw new Error(data?.message || `HTTP ${response.status}`);
    }

    if (data?.ok) {
      setTestStatus(panel, "success", data.message || "测试成功");
    } else {
      setTestStatus(panel, "error", data?.message || "测试失败");
    }
  } catch (error) {
    setTestStatus(panel, "error", error?.message || String(error));
  } finally {
    panel._testing = false;
    setTestBusy(panel, false);
  }
}

function updatePanelHeight(panel) {
  if (!panel?.host) return;
  const height = PANEL_HEIGHT + (panel.modelPickerVisible ? MODEL_PICKER_EXTRA_HEIGHT : 0);
  panel.host.style.height = `${height}px`;
  if (panel.node) fitNode(panel.node);
}

function setModelPickerVisible(panel, visible) {
  if (!panel?.modelPicker) return;
  panel.modelPickerVisible = Boolean(visible);
  panel.modelPicker.style.display = panel.modelPickerVisible ? "flex" : "none";
  updatePanelHeight(panel);
}

function populateModelPicker(panel, models) {
  if (!panel?.modelSelect) return;
  panel.modelSelect.replaceChildren();
  const currentModel = String(panel.modelInput?.value || "").trim();
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    panel.modelSelect.append(option);
  }
  if (currentModel && models.includes(currentModel)) {
    panel.modelSelect.value = currentModel;
  } else if (models.length) {
    panel.modelSelect.selectedIndex = 0;
  }
  panel.models = models;
  setModelPickerVisible(panel, true);
}

async function runModelDiscovery(panel) {
  if (!panel || panel._fetchingModels) return;
  syncSensitiveRawFromInputs(panel);
  applyEndpointNormalization(panel);
  const endpoint = String(panel.rawEndpoint || "").trim();
  if (!endpoint) {
    setTestStatus(panel, "error", "请先输入端点");
    return;
  }

  panel._fetchingModels = true;
  setModelFetchBusy(panel, true);
  setTestStatus(panel, "testing", "获取模型中...");
  try {
    const response = await api.fetchApi(MODELS_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: panel.rawKey || "",
        endpoint,
      }),
      cache: "no-store",
    });

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = { ok: false, message: await response.text() };
    }

    if (!response.ok || !data?.ok) {
      throw new Error(data?.message || `HTTP ${response.status}`);
    }
    const models = Array.isArray(data.models)
      ? data.models.map((model) => String(model || "").trim()).filter(Boolean)
      : [];
    if (!models.length) throw new Error("服务商没有返回可用模型");

    populateModelPicker(panel, models);
    setTestStatus(panel, "success", data.message || `已获取 ${models.length} 个模型，请选择并确认`);
  } catch (error) {
    setTestStatus(panel, "error", error?.message || String(error));
  } finally {
    panel._fetchingModels = false;
    setModelFetchBusy(panel, false);
  }
}

function confirmModelSelection(panel) {
  const value = String(panel?.modelSelect?.value || "").trim();
  if (!value) {
    setTestStatus(panel, "error", "请选择模型");
    return;
  }
  panel.modelInput.value = value;
  panel.syncAndReset?.();
  setTestStatus(panel, "success", `已选择模型：${value}`);
}

async function pasteFieldValue(panel, field) {
  const button = panel?.pasteButtons?.[field];
  if (!panel || !button) return;
  if (!navigator.clipboard?.readText) {
    setTestStatus(panel, "error", "当前浏览器不支持读取剪贴板");
    return;
  }
  button.disabled = true;
  button.style.cursor = "wait";
  try {
    const rawValue = String(await navigator.clipboard.readText() || "").trim();
    const parsed = parseClipboardConnection(rawValue);
    let value = rawValue;
    if (field === "key") {
      value = parsed?.key || cleanClipboardKey(rawValue);
      panel.rawKey = value;
      refreshSensitiveDisplay(panel);
    } else if (field === "endpoint") {
      value = normalizeEndpointUrl(parsed?.endpoint || rawValue);
      if (!value && rawValue) throw new Error("剪贴板中没有可识别的接口地址");
      panel.rawEndpoint = value;
      refreshSensitiveDisplay(panel);
    } else {
      value = parsed?.model || rawValue;
      panel.modelInput.value = value;
    }
    panel.sync?.();
    setTestStatus(panel, "success", value.trim() ? "已粘贴并自动适配" : "剪贴板内容为空");
  } catch (error) {
    setTestStatus(panel, "error", `读取剪贴板失败：${error?.message || error}`);
  } finally {
    button.disabled = false;
    button.style.cursor = "pointer";
  }
}

async function importClipboardConfig(panel) {
  const buttons = Object.values(panel?.importButtons || {});
  if (!panel || !buttons.length) return;
  if (!navigator.clipboard?.readText) {
    setTestStatus(panel, "error", "当前浏览器不支持读取剪贴板");
    return;
  }

  buttons.forEach((button) => {
    button.disabled = true;
    button.style.cursor = "wait";
  });

  try {
    const text = String(await navigator.clipboard.readText() || "").trim();
    const parsed = parseClipboardConnection(text);
    if (!parsed) throw new Error("剪贴板中未识别到可用的 API 连接信息");

    const changed = [];
    if (parsed.endpoint) {
      const endpoint = normalizeEndpointUrl(parsed.endpoint);
      if (endpoint) {
        panel.rawEndpoint = endpoint;
        refreshSensitiveDisplay(panel);
        changed.push("端点");
      }
    }
    if (parsed.key) {
      panel.rawKey = parsed.key;
      refreshSensitiveDisplay(panel);
      changed.push("密钥");
    }
    if (parsed.model) {
      panel.modelInput.value = parsed.model;
      changed.push("模型");
    }
    if (!changed.length) throw new Error("剪贴板中未识别到可用的 API 连接信息");

    panel.sync?.();
    setTestStatus(panel, "success", `已快速导入并自动适配：${changed.join("、")}`);
  } catch (error) {
    setTestStatus(panel, "error", error?.message || String(error));
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
      button.style.cursor = "pointer";
    });
  }
}

function applyEndpointNormalization(panel) {
  if (!panel) return;
  const normalized = normalizeEndpointUrl(panel.rawEndpoint);
  if (!normalized || normalized === panel.rawEndpoint) return;
  panel.rawEndpoint = normalized;
  refreshSensitiveDisplay(panel);
  panel.sync?.();
}

function normalizeEndpointField(panel) {
  if (!panel || panel.masked) return;
  syncSensitiveRawFromInputs(panel);
  applyEndpointNormalization(panel);
  if (panel.rawEndpoint) {
    panel.syncAndReset?.();
  }
}

function createInput({ type = "text", placeholder = "", value = "" } = {}) {
  const input = document.createElement("input");
  input.type = type;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.value = String(value || "");
  Object.assign(input.style, inputStyle());
  return input;
}

function createRow() {
  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: "0",
    width: "100%",
  });
  return row;
}

function createPasteButton(label, className = "gg-key-input-paste") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.innerHTML = ggIcon("paste", 16);
  button.title = label;
  button.setAttribute("aria-label", label);
  Object.assign(button.style, buttonStyle());
  return button;
}

function createPanel(node, keyWidget, endpointWidget, modelWidget) {
  const stored = readStoredConfig(node);
  const host = document.createElement("div");
  host.className = "gg-key-input-panel";
  Object.assign(host.style, {
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-start",
    gap: "5px",
    height: `${PANEL_HEIGHT}px`,
    boxSizing: "border-box",
    overflow: "hidden",
    padding: "4px 6px",
    pointerEvents: "auto",
  });

  const endpointInput = createInput({
    placeholder: "输入 API Endpoint / Base URL（可选）",
    value: normalizeEndpointUrl(endpointWidget?.value || stored.endpoint) || endpointWidget?.value || stored.endpoint,
  });
  endpointInput.className = "gg-key-input-endpoint";

  const modelInput = createInput({
    placeholder: "输入 API 模型名称",
    value: modelWidget?.value || stored.model,
  });
  modelInput.className = "gg-key-input-model";

  const endpointRow = createRow();
  endpointInput.style.flex = "1 1 auto";
  const endpointImport = createPasteButton("快速导入端点、API Key和模型", "gg-key-input-import");
  endpointRow.append(endpointInput, endpointImport);

  const modelRow = createRow();
  modelInput.style.flex = "1 1 auto";
  const modelPaste = createPasteButton("粘贴模型名称");
  const modelFetchButton = document.createElement("button");
  modelFetchButton.type = "button";
  modelFetchButton.className = "gg-key-input-model-fetch";
  modelFetchButton.title = "根据端点和密钥获取模型列表";
  modelFetchButton.setAttribute("aria-label", modelFetchButton.title);
  Object.assign(modelFetchButton.style, actionButtonStyle());
  modelRow.append(modelInput, modelFetchButton, modelPaste);

  const keyInput = createInput({
    type: "text",
    placeholder: "输入 API Key 或访问令牌",
    value: keyWidget.value || stored.key,
  });
  keyInput.className = "gg-key-input-secret";
  keyInput.style.flex = "1 1 auto";
  const keyRow = createRow();
  const keyImport = createPasteButton("快速导入端点、API Key和模型", "gg-key-input-import");
  keyRow.append(keyInput, keyImport);

  const modelPicker = createRow();
  modelPicker.className = "gg-key-input-model-picker";
  const modelSelect = document.createElement("select");
  modelSelect.className = "gg-key-input-model-list";
  Object.assign(modelSelect.style, selectStyle(), { flex: "1 1 auto" });
  const confirmModelButton = document.createElement("button");
  confirmModelButton.type = "button";
  confirmModelButton.className = "gg-key-input-model-confirm";
  confirmModelButton.innerHTML = `${ggIcon("check", 15)}<span>确认</span>`;
  confirmModelButton.title = "确认选择模型";
  confirmModelButton.setAttribute("aria-label", confirmModelButton.title);
  Object.assign(confirmModelButton.style, actionButtonStyle());
  modelPicker.append(modelSelect, confirmModelButton);
  modelPicker.style.display = "none";

  const testRow = document.createElement("div");
  Object.assign(testRow.style, {
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    columnGap: "8px",
    minWidth: "0",
    width: "100%",
  });

  const buttonGroup = document.createElement("div");
  buttonGroup.className = "gg-key-input-button-group";
  Object.assign(buttonGroup.style, {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    gridColumn: "2",
    justifySelf: "center",
  });

  const testButton = document.createElement("button");
  testButton.type = "button";
  testButton.className = "gg-key-input-test";
  testButton.innerHTML = ggIcon("zap", 16);
  testButton.title = "测试当前配置";
  testButton.setAttribute("aria-label", "测试当前配置");
  Object.assign(testButton.style, buttonStyle());

  const maskButton = document.createElement("button");
  maskButton.type = "button";
  maskButton.className = "gg-key-input-mask";
  Object.assign(maskButton.style, buttonStyle());

  const status = document.createElement("div");
  status.className = "gg-key-input-test-status";
  status.title = "";
  Object.assign(status.style, statusStyle());
  Object.assign(status.style, {
    gridColumn: "3",
    justifySelf: "stretch",
  });

  const panel = {
    host,
    keyInput,
    endpointInput,
    modelInput,
    modelFetchButton,
    modelPicker,
    modelSelect,
    confirmModelButton,
    maskButton,
    testButton,
    pasteButtons: { model: modelPaste },
    importButtons: { endpoint: endpointImport, key: keyImport },
    modelPickerVisible: false,
    status,
    masked: DEFAULT_MASKED,
    rawKey: keyWidget.value || stored.key || "",
    rawEndpoint: endpointWidget?.value || stored.endpoint || "",
  };

  const sync = () => {
    syncSensitiveRawFromInputs(panel);
    syncWidgetValue(keyWidget, panel.rawKey);
    syncWidgetValue(endpointWidget, panel.rawEndpoint);
    syncWidgetValue(modelWidget, modelInput.value);
    saveStoredConfig(node, {
      key: panel.rawKey,
      endpoint: panel.rawEndpoint,
      model: modelInput.value,
    });
  };
  panel.sync = sync;
  const syncAndReset = () => {
    sync();
    if (!panel._testing) setTestStatus(panel, "idle", "未测试");
  };
  panel.syncAndReset = syncAndReset;

  keyInput.addEventListener("input", syncAndReset);
  keyInput.addEventListener("change", syncAndReset);
  endpointInput.addEventListener("input", syncAndReset);
  endpointInput.addEventListener("change", syncAndReset);
  endpointInput.addEventListener("blur", () => normalizeEndpointField(panel));
  modelInput.addEventListener("input", syncAndReset);
  modelInput.addEventListener("change", syncAndReset);
  endpointImport.addEventListener("click", () => importClipboardConfig(panel));
  modelPaste.addEventListener("click", () => pasteFieldValue(panel, "model"));
  keyImport.addEventListener("click", () => importClipboardConfig(panel));
  modelFetchButton.addEventListener("click", () => runModelDiscovery(panel));
  confirmModelButton.addEventListener("click", () => confirmModelSelection(panel));
  maskButton.addEventListener("click", () => {
    setMaskState(panel, !panel.masked);
  });
  testButton.addEventListener("click", () => {
    sync();
    runConfigTest(panel);
  });

  buttonGroup.append(testButton, maskButton);
  testRow.append(document.createElement("span"), buttonGroup, status);
  host.append(endpointRow, keyRow, modelRow, modelPicker, testRow);
  panel.node = node;
  setModelFetchBusy(panel, false);
  sync();
  refreshSensitiveDisplay(panel);
  setTestStatus(panel, "idle", "未测试");
  return panel;
}

function removeExistingPanel(node) {
  const widget = node.ggKeyInputWidget || node.widgets?.find((item) => item?.name === DOM_WIDGET_NAME);
  if (!widget) return;
  widget.onRemoved?.();
  if (Array.isArray(node.widgets)) {
    node.widgets = node.widgets.filter((item) => item !== widget);
  }
  node.ggKeyInputWidget = null;
  node.ggKeyInputPanel = null;
}

function applyPanelLayout(panel, width) {
  if (!panel?.host) return;

  const nodeWidth = Math.max(MIN_WIDTH, Number(width) || MIN_WIDTH);
  const panelWidth = Math.max(220, nodeWidth - NODE_INSET);
  Object.assign(panel.host.style, {
    width: `${panelWidth}px`,
    minWidth: `${panelWidth}px`,
    maxWidth: `${panelWidth}px`,
  });
}

function panelNodeHeight(panel) {
  return COMPACT_NODE_HEIGHT + (panel?.modelPickerVisible ? MODEL_PICKER_EXTRA_HEIGHT : 0);
}

function fitNode(node) {
  const currentWidth = Number(node.size?.[0]) || MIN_WIDTH;
  const currentHeight = Number(node.size?.[1]) || COMPACT_NODE_HEIGHT;
  const width = Math.max(MIN_WIDTH, currentWidth);
  const targetHeight = panelNodeHeight(node.ggKeyInputPanel);
  const knownCompactHeights = [
    COMPACT_NODE_HEIGHT,
    PREVIOUS_COMPACT_NODE_HEIGHT,
    LEGACY_COMPACT_NODE_HEIGHT,
  ];
  const shouldShrinkKnownCompactHeight = knownCompactHeights.some(
    (knownHeight) => Math.abs(currentHeight - knownHeight) <= 1,
  );
  const height = shouldShrinkKnownCompactHeight ? targetHeight : Math.max(targetHeight, currentHeight);
  if (node.ggKeyInputPanel) applyPanelLayout(node.ggKeyInputPanel, width);
  if (width === currentWidth && height === currentHeight) return;
  node.setSize?.([width, height]);
  node.size = [width, height];
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
}

function installResizeHook(node) {
  if (node._ggKeyInputResizeHookInstalled) return;
  node._ggKeyInputResizeHookInstalled = true;

  const originalOnResize = node.onResize;
  node.onResize = function (size) {
    const result = originalOnResize?.apply(this, arguments);
    const width = Math.max(MIN_WIDTH, Number(size?.[0]) || Number(this.size?.[0]) || MIN_WIDTH);
    if (size != null && typeof size === "object" && typeof size.length === "number" && width !== size[0]) size[0] = width;
    const minimumHeight = panelNodeHeight(this.ggKeyInputPanel);
    if (size != null && typeof size === "object" && typeof size.length === "number" && Number(size[1]) < minimumHeight) size[1] = minimumHeight;
    if (this.ggKeyInputPanel) applyPanelLayout(this.ggKeyInputPanel, width);
    return result;
  };
}

function syncPanelFromWidgets(node, keyWidget, endpointWidget, modelWidget) {
  const panel = node.ggKeyInputPanel;
  const stored = readStoredConfig(node);
  if (!panel?.keyInput) return;

  panel.rawKey = String(keyWidget.value || stored.key || "");
  const endpointValue = String(endpointWidget?.value || stored.endpoint || "");
  panel.rawEndpoint = normalizeEndpointUrl(endpointValue) || endpointValue;
  if (panel.modelInput) {
    panel.modelInput.value = String(modelWidget?.value || stored.model || "");
  }
  refreshSensitiveDisplay(panel);
  syncWidgetValue(keyWidget, panel.rawKey);
  syncWidgetValue(endpointWidget, panel.rawEndpoint);
  syncWidgetValue(modelWidget, panel.modelInput?.value || "");
  saveStoredConfig(node, {
    key: panel.rawKey,
    endpoint: panel.rawEndpoint,
    model: panel.modelInput?.value || "",
  });
  if (!panel._testing) setTestStatus(panel, "idle", "未测试");
}

function setupNode(node) {
  if (!node || (node.comfyClass !== NODE_NAME && node.type !== NODE_NAME)) return;
  const keyWidget = getWidget(node, KEY_WIDGET_NAME);
  const endpointWidget = getWidget(node, ENDPOINT_WIDGET_NAME);
  const modelWidget = getWidget(node, MODEL_WIDGET_NAME);
  if (!keyWidget) return;

  node.serialize_widgets = true;
  hideConfigWidget(keyWidget);
  hideConfigWidget(endpointWidget);
  hideConfigWidget(modelWidget);
  installResizeHook(node);

  if (node.ggKeyInputWidget?.keyInput) {
    syncPanelFromWidgets(node, keyWidget, endpointWidget, modelWidget);
    applyPanelLayout(node.ggKeyInputPanel, node.size?.[0] || MIN_WIDTH);
    requestAnimationFrame(() => fitNode(node));
    return;
  }

  removeExistingPanel(node);
  const panel = createPanel(node, keyWidget, endpointWidget, modelWidget);
  node.ggKeyInputPanel = panel;
  panel.node = node;
  applyPanelLayout(panel, node.size?.[0] || MIN_WIDTH);
  const widget = node.addDOMWidget(DOM_WIDGET_NAME, "gg_key_input", panel.host, {
    getValue() {
      return "";
    },
    setValue() {},
    serialize: false,
  });

  widget.input = panel.keyInput;
  widget.keyInput = panel.keyInput;
  widget.endpointInput = panel.endpointInput;
  widget.modelInput = panel.modelInput;
  widget.maskButton = panel.maskButton;
  widget.testButton = panel.testButton;
  widget.modelFetchButton = panel.modelFetchButton;
  widget.modelSelect = panel.modelSelect;
  widget.modelConfirmButton = panel.confirmModelButton;
  widget.pasteButtons = panel.pasteButtons;
  widget.importButtons = panel.importButtons;
  widget.status = panel.status;
  widget.host = panel.host;
  widget.computeSize = function (width) {
    const nodeWidth = Math.max(MIN_WIDTH, Number(width) || node.size?.[0] || MIN_WIDTH);
    applyPanelLayout(panel, nodeWidth);
    return [nodeWidth, PANEL_HEIGHT + (panel.modelPickerVisible ? MODEL_PICKER_EXTRA_HEIGHT : 0)];
  };
  widget.onRemoved = function () {
    panel.host.remove();
  };

  node.ggKeyInputWidget = widget;
  requestAnimationFrame(() => fitNode(node));
}

app.registerExtension({
  name: "ComfyUI.GuliNodes.KeyInput",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME || nodeType.prototype._ggKeyInputInstalled) return;
    nodeType.prototype._ggKeyInputInstalled = true;

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalOnNodeCreated?.apply(this, args);
      setTimeout(() => setupNode(this), 0);
      return result;
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = originalOnConfigure?.apply(this, args);
      setTimeout(() => setupNode(this), 0);
      return result;
    };

    const originalComputeSize = nodeType.prototype.computeSize;
    nodeType.prototype.computeSize = function (...args) {
      const size = originalComputeSize?.apply(this, args) ?? [MIN_WIDTH, COMPACT_NODE_HEIGHT];
      if (this?.comfyClass !== NODE_NAME && this?.type !== NODE_NAME) return size;
      return [
        Math.max(MIN_WIDTH, Number(size?.[0]) || MIN_WIDTH),
        panelNodeHeight(this.ggKeyInputPanel),
      ];
    };
  },

  nodeCreated(node) {
    setTimeout(() => setupNode(node), 0);
  },

  loadedGraphNode(node) {
    setTimeout(() => setupNode(node), 0);
  },
});
