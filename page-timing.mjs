import {sleep} from "./core.mjs";

// Wait for a stable rendered form; this is a fixed readability/rendering delay.
export function pageSnapshot() {
  if (document.readyState === "loading" || location.href === "about:blank") return {ready: false};
  const fields = [...document.querySelectorAll('input,select,button,[role="spinbutton"]')]
    .filter(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)
    .map(element => [element.tagName, element.type, element.name, element.id, element.getAttribute("aria-label"), element.placeholder]);
  return {ready: true, key: JSON.stringify([location.href, performance.timeOrigin, fields])};
}

export async function waitForStablePage(browser, sessionId, milliseconds, {pause = sleep, signal} = {}) {
  const checkStop = () => {if (signal?.aborted) throw new Error("用户已停止当前任务。");};
  checkStop();
  const inspect = () => browser.evaluate(sessionId, "(" + pageSnapshot.toString() + ")()");
  const before = await inspect();
  if (!before.ready) return false;
  await pause(milliseconds);
  checkStop();
  const after = await inspect();
  return after.ready && before.key === after.key;
}
