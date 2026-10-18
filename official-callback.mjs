import {validatedCallback} from "./core.mjs";

export function isOfficialCallback(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://platform.openai.com" && parsed.pathname === "/auth/callback";
  } catch {return false;}
}

export function sameOfficialCallback(left, right) {
  if (!isOfficialCallback(left) || !isOfficialCallback(right)) return false;
  const first = new URL(left), second = new URL(right);
  return ["code", "state"].every(key => first.searchParams.getAll(key).length === 1 && second.searchParams.getAll(key).length === 1 &&
    !!first.searchParams.get(key) && first.searchParams.get(key) === second.searchParams.get(key));
}

// Only observe official requests. Validation and handoff wait for the new document.
export async function callbackAfterNavigation(url, state, waitUntilLoaded, {signal, isClosed = () => false, refreshCurrentCallback} = {}) {
  if (!isOfficialCallback(url)) throw new Error("不是预期的官方 OAuth 回调地址。");
  if (signal?.aborted) throw new Error("用户已停止当前任务。");
  if (refreshCurrentCallback) await refreshCurrentCallback();
  const ready = await waitUntilLoaded({timeoutMs: 60000, stableMs: 1000});
  if (signal?.aborted) throw new Error("用户已停止当前任务。");
  if (!ready || isClosed()) throw new Error("官方跳转后的页面未加载稳定，未向后端提交授权信息。");
  return validatedCallback(url, state);
}
