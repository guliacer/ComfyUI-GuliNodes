// GG 用户数据存储桥：把自定义数据统一落到 ComfyUI 用户区（settings，
// 即 user/default/comfy.settings.json）。插件目录升级被整体覆盖时用户数据不再受影响，
// 清浏览器缓存、换浏览器也不会丢密钥与偏好。
//
// 接口与 localStorage 完全同构（原始字符串进出），各扩展把
// localStorage.getItem / setItem 原地替换成 getUserItem / setUserItem 即可，语义零变化。
// 读到 localStorage 旧值而 settings 还没有时，自动把旧值回填 settings——
// 老用户升级后第一次打开页面就完成迁移，无需任何手动操作。
import { app } from "../../scripts/app.js";

const MIGRATED_FLAG_PREFIX = "GuliNodes.storage.migrated.";

function settingsApi() {
  return app?.ui?.settings ?? app?.extensionManager?.settings ?? null;
}

function settingsHas(key) {
  const settings = settingsApi();
  try {
    return settings?.getSettingValue?.(key, undefined) !== undefined;
  } catch {
    return false;
  }
}

function writeSetting(key, value) {
  const settings = settingsApi();
  try {
    // 未注册的 setting id 也能写：settings 本质是用户区 kv 存储，只对已注册项显示面板。
    const result = settings?.setSettingValue?.(key, value);
    if (result && typeof result.catch === "function") {
      result.catch(() => {}); // 写服务端失败不阻断前端，localStorage 兜底仍在。
    }
  } catch {}
}

export function getUserItem(key) {
  try {
    const settings = settingsApi();
    if (settings) {
      const stored = settings.getSettingValue?.(key, undefined);
      if (typeof stored === "string") return stored;
    }
  } catch {}
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      // 自动迁移：settings 缺失而 localStorage 有值时回填一次，老数据不丢。
      if (!settingsHas(key)) {
        writeSetting(key, raw);
      }
      return raw;
    }
  } catch {}
  return null;
}

export function setUserItem(key, value) {
  // localStorage 先写：同步、即时生效，也作为写 settings 失败时的兜底。
  try {
    localStorage.setItem(key, String(value));
  } catch {}
  writeSetting(key, String(value));
}

export function removeUserItem(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
  const settings = settingsApi();
  try {
    const result = settings?.setSettingValue?.(key, null);
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {}
}

// 结构化对象直接存 settings 的便捷入口（新代码建议用这个，少一层 JSON 字符串）。
export function loadUserState(key, fallback = null) {
  try {
    const settings = settingsApi();
    const stored = settings?.getSettingValue?.(key, undefined);
    if (stored !== undefined && stored !== null) return stored;
  } catch {}
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (!settingsHas(key)) writeSetting(key, parsed); // 老数据自动回填。
      return parsed;
    }
  } catch {}
  return fallback;
}

export function saveUserState(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
  writeSetting(key, value);
}

// 一次性迁移助手：把若干 localStorage key 搬进 settings，成功后给 flag 防重复扫描。
export function migrateUserItems(keys) {
  const flagKey = MIGRATED_FLAG_PREFIX + keys.join("|");
  try {
    if (settingsHas(flagKey)) return;
    let touched = false;
    for (const key of keys) {
      if (settingsHas(key)) continue;
      let raw = null;
      try {
        raw = localStorage.getItem(key);
      } catch {}
      if (raw !== null) {
        writeSetting(key, raw);
        touched = true;
      }
    }
    writeSetting(flagKey, touched ? "done" : "empty");
  } catch {}
}
