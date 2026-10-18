import {validatedCallback} from "./core.mjs";

export function isOfficialCallback(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://platform.openai.com" && parsed.pathname === "/auth/callback";
  } catch {return false;}
}

export function shouldRefreshOfficialCallback(url) {
  if (!isOfficialCallback(url)) return false;
  const codes = new URL(url).searchParams.getAll("code");
  return codes.length === 1 && !!codes[0].trim();
}

// Only observe official requests. Validation and handoff wait for the new document.
export async function callbackAfterNavigation(url, state, waitUntilLoaded, {signal, isClosed = () => false, refreshCurrentCallback} = {}) {
  if (!isOfficialCallback(url)) throw new Error("不是预期的官方 OAuth 回调地址。");
  if (signal?.aborted) throw new Error("用户已停止当前任务。");
  const refreshedUrl = refreshCurrentCallback ? await refreshCurrentCallback() : undefined;
  const currentCallback = typeof refreshedUrl === "string" ? refreshedUrl : url;
  if (!isOfficialCallback(currentCallback)) throw new Error("不是预期的官方 OAuth 回调地址。");
  const ready = await waitUntilLoaded({timeoutMs: 60000, stableMs: 1000});
  if (signal?.aborted) throw new Error("用户已停止当前任务。");
  if (!ready || isClosed()) throw new Error("官方跳转后的页面未加载稳定，未向后端提交授权信息。");
  return validatedCallback(currentCallback, state);
}
