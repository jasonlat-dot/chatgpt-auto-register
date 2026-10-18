import {sleep} from "./core.mjs";

// Only readiness metadata leaves the page; URLs and form values are not logged.
export function pageLoadSnapshot() {
  if (document.readyState !== "complete" || !document.body) return {ready: false};
  const visible = element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  const busy = [...document.querySelectorAll('[aria-busy="true"],[role="progressbar"],[data-testid*="loading"],[data-testid*="spinner"],svg.animate-spin')].some(visible);
  const text = (document.body.innerText || "").trim();
  const controls = [...document.querySelectorAll('input:not([type="hidden"]),button,select')].some(element => !element.disabled && visible(element));
  const loadingMessage = !controls && text.length < 300 && /正在加载|正在处理|请稍候|please wait|\bloading\b|\bprocessing\b/i.test(text);
  return {ready: !busy && !loadingMessage, key: JSON.stringify([location.href, performance.timeOrigin])};
}

export async function waitForPageLoaded(inspect, {timeoutMs = 30000, stableMs = 1000, now = Date.now, pause = sleep} = {}) {
  const deadline = now() + timeoutMs;
  let readySince = null;
  let previousKey;
  while (now() <= deadline) {
    let state;
    try {state = await inspect();} catch {state = null;}
    if (state?.closed) return true;
    if (state?.ready) {
      if (readySince === null || state.key !== previousKey) readySince = now();
      previousKey = state.key;
      if (now() - readySince >= stableMs) return true;
    } else {readySince = null; previousKey = undefined;}
    if (now() >= deadline) break;
    await pause(Math.min(250, deadline - now()));
  }
  return false;
}

export async function closeAccountBrowser(page, browser, {notify = console.log, timeoutMs = 30000, confirmedImport = false, pause = sleep} = {}) {
  if (browser?.isClosed?.()) return;
  const retain = async message => {
    try {if (browser?.detach) await browser.detach();} catch {}
    throw Object.assign(new Error(message), {fatal: true, browserRetained: true});
  };
  if (page) {
    if (confirmedImport && page.showImportComplete) {
      try {await page.showImportComplete();}
      catch {await retain("后端已确认导入，但完成页无法显示，已保留浏览器并停止队列；请手动检查窗口。");}
    }
    notify("关闭前检查：等待页面加载完成并稳定…");
    let loaded = false;
    try {loaded = await page.waitUntilLoaded({timeoutMs});} catch {}
    if (!loaded) {
      await retain("页面仍在加载或无法确认加载完成，已保留浏览器窗口并停止队列；请查看页面后手动关闭窗口。");
    }
    if (confirmedImport) {
      for (let seconds = 3; seconds > 0; seconds--) {
        try {await page.setCloseCountdown?.(seconds);}
        catch {await retain("后端已确认导入，但完成页状态发生变化，已保留浏览器并停止队列；请手动检查窗口。");}
        notify("后端已确认导入，" + seconds + " 秒后关闭浏览器…");
        await pause(1000);
      }
    }
    try {await page.close();}
    catch {await retain("无法确认当前页面已关闭，已保留浏览器并停止队列；请手动检查窗口。");}
  }
  if (browser) await browser.close();
}
