import {spawn} from "node:child_process";
import {readFile, mkdir, unlink} from "node:fs/promises";
import {resolve} from "node:path";
import {sleep} from "./core.mjs";
import {validateBrowserMode} from "./browser-mode.mjs";
import {prepareBirthday} from "./birthday.mjs";
import {browserSessionProbe, sessionLandingStep} from "./session-import.mjs";
import {waitForStablePage} from "./page-timing.mjs";
import {pageLoadSnapshot, waitForPageLoaded} from "./page-load.mjs";
import {findChrome, chromeArguments} from "./browser-launch.mjs";
import {isOfficialCallback, shouldRefreshOfficialCallback, callbackAfterNavigation} from "./official-callback.mjs";

export async function launchBrowser(profile, proxy = "", headless = false, mode = "incognito") {
  validateBrowserMode(mode);
  const executable = await findChrome();
  // Chrome must not open the former Edge profile in place.
  profile = resolve(profile, "chrome");
  await mkdir(profile, {recursive: true});
  await unlink(resolve(profile, "DevToolsActivePort")).catch(error => {if (error.code !== "ENOENT") throw error;});
  const args = chromeArguments(profile, {mode, proxy, headless});
  const child = spawn(executable, args, {windowsHide: headless, stdio: "ignore"});
  let spawnError;
  child.on("error", error => {spawnError = error;});
  let active;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError || child.exitCode !== null) throw new Error("无法启动浏览器；请确认该账号的脚本浏览器窗口已关闭。");
    try {active = await readFile(resolve(profile, "DevToolsActivePort"), "utf8"); break;} catch {}
    await sleep(100);
  }
  if (!active) {child.kill(); throw new Error("浏览器未启动或调试端口不可用。");}
  const [port, path] = active.trim().split(/\r?\n/);
  const socket = new WebSocket("ws://127.0.0.1:" + port + path);
  try {
    await new Promise((ok, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 10000);
      socket.addEventListener("open", () => {clearTimeout(timer); ok();}, {once: true});
      socket.addEventListener("error", () => {clearTimeout(timer); reject(new Error("connection"));}, {once: true});
    });
  } catch {
    socket.close(); child.kill();
    throw new Error("无法连接本机浏览器调试端口，请关闭该账号的脚本浏览器后重试。");
  }
  const pending = new Map();
  const listeners = new Set();
  let id = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error("浏览器操作失败（" + item.method + "），请在可见浏览器中检查当前页面。")); else item.ok(message.result);
    } else for (const listener of listeners) listener(message);
  });
  socket.addEventListener("close", () => {for (const item of pending.values()) {clearTimeout(item.timer); item.reject(new Error("浏览器已关闭。"));} pending.clear();});
  const send = (method, params = {}, sessionId) => new Promise((ok, reject) => {
    const current = ++id;
    const timer = setTimeout(() => {pending.delete(current); reject(new Error("浏览器操作超时。"));}, method === "Runtime.evaluate" ? 300000 : 10000);
    pending.set(current, {ok, reject, timer, method});
    try {socket.send(JSON.stringify({id: current, method, params, ...(sessionId ? {sessionId} : {})}));}
    catch {clearTimeout(timer); pending.delete(current); reject(new Error("浏览器连接已中断。"));}
  });
  // Record only our own initial blank tabs; never close a later user-opened tab.
  let bootstrapTargets = [];
  try {
    for (let attempt = 0; attempt < 50 && !bootstrapTargets.length; attempt++) {
      bootstrapTargets = (await send("Target.getTargets")).targetInfos.filter(target => target.type === "page" && target.url === "about:blank").map(target => target.targetId);
      if (!bootstrapTargets.length) await sleep(100);
    }
    if (!bootstrapTargets.length) throw new Error("Chrome 启动窗口未就绪，请关闭本次脚本浏览器后重试。");
  } catch (error) {socket.close(); child.kill(); throw error;}
  let closing;
  let detached = false;
  return {
    send, listeners, mode, name: "Google Chrome",
    takeNativePrivateTarget() {return mode === "incognito" ? bootstrapTargets.shift() : undefined;},
    async closeBootstrapTabs() {
      while (bootstrapTargets.length) await send("Target.closeTarget", {targetId: bootstrapTargets.shift()});
    },
    isClosed() {return child.exitCode !== null || child.signalCode !== null;},
    async detach() {detached = true; try {socket.close();} finally {child.unref();}},
    async evaluate(sessionId, expression) {
      const result = await send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true}, sessionId);
      if (result.exceptionDetails) throw new Error("当前页面暂时无法操作，请在浏览器检查。");
      return result.result.value;
    },
    async close() {
      if (detached) throw Object.assign(new Error("当前浏览器窗口已保留，请手动关闭。"), {fatal: true, browserRetained: true});
      if (closing) return closing;
      closing = (async () => {
      const exited = new Promise(ok => {
        if (child.exitCode !== null || child.signalCode !== null) ok();
        else child.once("exit", ok);
      });
      try {await send("Browser.close");} catch {}
      socket.close();
      let timer;
      await Promise.race([exited, new Promise(ok => {timer = setTimeout(ok, 30000);})]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        if (mode === "normal") {
          child.unref();
          throw new Error("普通浏览器仍在关闭并保存资料，请手动关闭本次脚本浏览器，再继续队列。");
        }
        child.kill();
      }
      })();
      return closing;
    },
  };
}

export async function newAccountPage(browser, expectedState, {sessionImport = false, actionDelayMs = 0, signal, notify = () => {}} = {}) {
  const mode = validateBrowserMode(browser.mode ?? "incognito");
  // Use Chrome's native --incognito window so its private-window UI is visible too.
  // Alternate browser transports without that window still use an isolated context.
  let targetId = mode === "incognito" ? browser.takeNativePrivateTarget?.() : undefined;
  const browserContextId = mode === "incognito" && !targetId ? (await browser.send("Target.createBrowserContext", {disposeOnDetach: false})).browserContextId : undefined;
  try {if (!targetId) ({targetId} = await browser.send("Target.createTarget", {url: "about:blank", ...(browserContextId ? {browserContextId, newWindow: true} : {})}));}
  catch (error) {
    if (browserContextId) await browser.send("Target.disposeBrowserContext", {browserContextId}).catch(() => {});
    throw error;
  }
  const {sessionId} = await browser.send("Target.attachToTarget", {targetId, flatten: true});
  await browser.closeBootstrapTabs?.();
  const abortInput = () => {void browser.evaluate(sessionId, "window.__cg2InputCancelled = true").catch(() => {});};
  signal?.addEventListener("abort", abortInput, {once: true});
  let loading = false;
  let mainFrameId;
  let mainDocumentSequence = 0;
  let reloadAfterDocument = null;
  let callbackReloaded = false;
  let reloadLoaderId;
  let reloadDocumentConfirmed = false;
  let callback = null;
  let callbackError = null;
  let callbackCandidate = null;
  let callbackTask;
  let finishCallbackNavigation;
  const startCallbackTask = () => {
    if (!callbackTask && finishCallbackNavigation) callbackTask = Promise.resolve().then(finishCallbackNavigation);
  };
  const callbackUrlInFrame = frame => [frame?.url, frame?.unreachableUrl].find(isOfficialCallback);
  const confirmReloadDocument = () => {
    if (callbackReloaded && !reloadDocumentConfirmed && mainDocumentSequence > reloadAfterDocument) {
      reloadDocumentConfirmed = true;
      notify("已检测到刷新后的新文档，等待页面加载稳定…");
    }
  };
  const navigationListener = message => {
    if (message.sessionId !== sessionId) return;
    if (!sessionImport && message.method === "Network.requestWillBeSent" && message.params.type === "Document" &&
      (!mainFrameId || message.params.frameId === mainFrameId) && isOfficialCallback(message.params.request.url)) {
      // Keep only the in-memory URL; allow the request to reach the official server.
      if (!callbackCandidate) {
        callbackCandidate = message.params.request.url;
        notify("已观察到官方回调导航，正在确认当前页面地址…");
      }
    }
    if (message.method === "Page.frameNavigated" && !message.params.frame.parentId) {
      mainDocumentSequence++;
      mainFrameId = message.params.frame.id; loading = true;
      if (!sessionImport && callbackUrlInFrame(message.params.frame)) callbackCandidate ??= callbackUrlInFrame(message.params.frame);
      confirmReloadDocument();
      if (callbackCandidate) startCallbackTask();
    }
    if (message.method === "Page.frameStartedLoading" && (!mainFrameId || message.params.frameId === mainFrameId)) loading = true;
    if (message.method === "Page.frameStoppedLoading" && (!mainFrameId || message.params.frameId === mainFrameId)) loading = false;
    if (message.method === "Page.loadEventFired") loading = false;
  };
  browser.listeners.add(navigationListener);
  await browser.send("Page.enable", {}, sessionId);
  const tree = await browser.send("Page.getFrameTree", {}, sessionId);
  mainFrameId = tree?.frameTree?.frame?.id;
  const loadState = async () => {
    if (browser.isClosed?.()) return {ready: true, closed: true};
    if (reloadAfterDocument !== null && mainDocumentSequence <= reloadAfterDocument) {
      const latestTree = await browser.send("Page.getFrameTree", {}, sessionId);
      const latest = latestTree?.frameTree?.frame;
      if (!reloadLoaderId || !latest?.loaderId || latest.loaderId === reloadLoaderId) return {ready: false};
      mainDocumentSequence = reloadAfterDocument + 1;
      mainFrameId = latest.id;
      loading = false;
      confirmReloadDocument();
    }
    if (loading) return {ready: false};
    const state = await browser.evaluate(sessionId, "(" + pageLoadSnapshot.toString() + ")()");
    return {...state, ready: !!state?.ready && !loading};
  };
  finishCallbackNavigation = async () => {
    try {
      callback = await callbackAfterNavigation(callbackCandidate, expectedState, options => waitForPageLoaded(loadState, options), {
        signal, isClosed: () => !!browser.isClosed?.(),
        refreshCurrentCallback: async () => {
          if (callbackReloaded) return;
          const currentTree = await browser.send("Page.getFrameTree", {}, sessionId);
          const currentFrame = currentTree?.frameTree?.frame;
          const currentUrl = callbackUrlInFrame(currentFrame);
          if (!shouldRefreshOfficialCallback(currentUrl)) {
            notify("当前页面不是带 code 的官方回调页，不刷新旧地址；等待当前页面稳定后核对授权结果。");
            return;
          }
          callbackReloaded = true;
          reloadAfterDocument = mainDocumentSequence;
          reloadLoaderId = currentFrame?.loaderId;
          loading = true;
          if (currentFrame?.unreachableUrl) notify("检测到回调地址仍在浏览器中，但文档加载失败；尝试刷新一次。");
          notify("已到达官方回调页，刷新一次；等待刷新后的页面加载稳定，再导入后端。");
          await browser.send("Page.reload", {ignoreCache: false}, sessionId);
          notify("浏览器已接受刷新命令，尚未确认新页面加载完成。");
          return currentUrl;
        }
      });
      notify(callbackReloaded ? "刷新后的页面已加载稳定，准备向后端导入。" : "官方目标页已加载稳定，准备向后端导入。");
    } catch (error) {callbackError = error;}
  };
  const pollCallbackLocation = async () => {
    if (sessionImport || callbackTask || callback || callbackError) return;
    const current = (await browser.send("Page.getFrameTree", {}, sessionId))?.frameTree?.frame;
    const url = callbackUrlInFrame(current);
    if (!url) return;
    callbackCandidate ??= url;
    mainFrameId = current.id;
    notify("页面地址检查已确认官方回调，准备执行一次刷新。");
    startCallbackTask();
  };
  if (!sessionImport) await browser.send("Network.enable", {}, sessionId);
  return {
    sessionId,
    get callback() {if (callbackError) throw callbackError; return callback;},
    async navigate(url) {
      loading = true;
      try {const result = await browser.send("Page.navigate", {url}, sessionId); if (result?.errorText) loading = false; return result;}
      catch (error) {loading = false; throw error;}
    },
    async waitUntilLoaded(options) {return waitForPageLoaded(loadState, options);},
    async showImportComplete() {
      if (!callback) return false;
      return browser.evaluate(sessionId, '(() => {const notice = document.createElement("aside"); notice.style.cssText="position:fixed;bottom:24px;right:24px;z-index:2147483647;background:#fff;color:#111;border:1px solid #ccc;border-radius:12px;padding:20px;font:16px system-ui"; const heading = document.createElement("strong"); heading.textContent="后端已确认导入"; const countdown = document.createElement("p"); countdown.id="close-countdown"; countdown.textContent="页面稳定后，倒计时 3 秒关闭窗口。"; notice.append(heading,countdown); document.body.append(notice); return true;})()');
    },
    async setCloseCountdown(seconds) {
      const updated = await browser.evaluate(sessionId, '(() => {const message = document.getElementById("close-countdown"); if (!message) return false; message.textContent = ' + JSON.stringify(seconds + " 秒后关闭窗口…") + '; return true;})()');
      if (!updated) throw new Error("完成页已变化，无法显示关闭倒计时。");
    },
    async readSession() {
      if (!sessionImport) throw new Error("当前页面未启用 Session 导入。");
      if (!(await loadState()).ready) return {kind: "loading"};
      return browser.evaluate(sessionId, "(" + browserSessionProbe.toString() + ")()");
    },
    async step(job, code = "") {
      await pollCallbackLocation();
      if (callbackCandidate || callbackTask || callback || callbackError) return {kind: "loading"};
      if (!(await loadState()).ready) return {kind: "loading"};
      if (actionDelayMs && !(await waitForStablePage(browser, sessionId, actionDelayMs, {signal}))) return {kind: "loading"};
      if (signal?.aborted) throw new Error("用户已停止当前任务。");
      if (callback || callbackError) return {kind: "loading"};
      if (sessionImport) {
        const origin = await browser.evaluate(sessionId, "location.origin");
        if (origin !== "https://auth.openai.com") {
          const landing = await browser.evaluate(sessionId, "(" + sessionLandingStep.toString() + ")()");
          if (landing.kind !== "login-form") return landing;
          return browser.evaluate(sessionId, "(" + formStep.toString() + ")(" + JSON.stringify(job) + "," + JSON.stringify(code) + ",[],{preferLogin:true,allowChatGPTLogin:true,paced:true})");
        }
      }
      const birthday = await prepareBirthday(browser, sessionId, job, {paced: true, signal});
      if (birthday.kind === "unsupported") return {kind: "manual-profile"};
      return browser.evaluate(sessionId, "(" + formStep.toString() + ")(" + JSON.stringify(job) + "," + JSON.stringify(code) + "," + JSON.stringify(birthday.fields?.map(f => f.index) || []) + "," + JSON.stringify({preferLogin: sessionImport, paced: true}) + ")");
    },
    async close() {
      signal?.removeEventListener("abort", abortInput);
      browser.listeners.delete(navigationListener);
      if (browserContextId) await browser.send("Target.disposeBrowserContext", {browserContextId});
      else await browser.send("Target.closeTarget", {targetId});
    },
  };
}

// Conservative form adapter. Unknown pages remain visible for the user to handle.
export function formStep(job, code, birthdayIndices = [], {preferLogin = false, allowChatGPTLogin = false, paced = false} = {}) {
  function* steps() {
    if (location.href === "about:blank" || document.readyState === "loading") return {kind: "loading"};
    const chatGPTLogin = allowChatGPTLogin && location.origin === "https://chatgpt.com" && /^\/auth\/(?:login|log-in)(?:\/|$)/.test(location.pathname);
    if (location.hostname !== "auth.openai.com" && !chatGPTLogin) return {kind: "manual"};
    if (!window.__cg2TouchedInputs) {
      window.__cg2TouchedInputs = new WeakSet();
      document.addEventListener("input", event => {if (event.isTrusted) window.__cg2TouchedInputs.add(event.target);}, true);
    }
    const visible = element => !!element && !element.disabled && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const inputs = [...document.querySelectorAll("input")].filter(visible);
    const birthdayElements = new Set([...document.querySelectorAll('input,select,[role="spinbutton"]')].filter((e, i) => birthdayIndices.includes(i)));
    const text = (document.body?.innerText || "").slice(0, 10000);
    if (inputs.some(x => x.type === "tel" && /phone|mobile|手机|电话/i.test(x.name + " " + x.placeholder)) || /电话号码是必填项|phone number is required|verify your phone|短信|WhatsApp/i.test(text) || [...document.querySelectorAll("iframe")].some(x => visible(x) && /captcha|challenge/i.test(x.src))) return {kind: "manual-verification"};
    const label = element => [element.name, element.id, element.autocomplete, element.placeholder, element.getAttribute("aria-label"), ...[...(element.labels || [])].map(x => x.textContent)].filter(Boolean).join(" ").toLowerCase();
    const codeInputs = inputs.filter(x => x.autocomplete === "one-time-code" || /\b(otp|code|verification.code)\b|验证码/.test(label(x)) || (x.maxLength === 1 && x.inputMode === "numeric"));
    if (codeInputs.length) {
      const previousAuto = window.__cg2LastAutoOtp;
      const fieldKey = input => JSON.stringify([input.type, input.name, input.autocomplete, input.maxLength, input.inputMode]);
      const sameAuto = previousAuto && codeInputs.length === previousAuto.inputs.length && codeInputs.every((input, i) =>
        input.value === previousAuto.values[i] && (input === previousAuto.inputs[i] || fieldKey(input) === previousAuto.fields?.[i]));
      if (codeInputs.some(x => window.__cg2TouchedInputs.has(x)) || (codeInputs.some(x => x.value.trim()) && !sameAuto)) return {kind: "otp-manual"};
      if (sameAuto) {
        if (!previousAuto.submitted && (yield {action: "continue"})) {previousAuto.submitted = true; return {kind: "otp-submitted"};}
        return {kind: previousAuto.submitted ? "otp-waiting" : "otp-ready"};
      }
      if (!code) return {kind: "otp"};
      if (codeInputs.length === 1) codeInputs[0] = yield {action: "fill", element: codeInputs[0], value: code, otp: true};
      else if (codeInputs.length === 6 && codeInputs.every(x => x.maxLength === 1)) {
        for (let i = 0; i < codeInputs.length; i++) codeInputs[i] = yield {action: "fill", element: codeInputs[i], value: code[i], otp: true, groupContinues: i < codeInputs.length - 1};
      }
      else return {kind: "manual"};
      window.__cg2LastAutoOtp = {inputs: codeInputs, fields: codeInputs.map(fieldKey), values: codeInputs.map(x => x.value), submitted: false};
      if (yield {action: "continue"}) {window.__cg2LastAutoOtp.submitted = true; return {kind: "otp-submitted"};}
      return {kind: "otp-ready"};
    }
    const signup = [...document.querySelectorAll("a")].find(x => visible(x) && /^(sign up|create account|注册|请注册|创建账号|创建账户)$/i.test(x.innerText.trim()));
    if (!preferLogin && signup && !/signup|sign-up|create.account/i.test(location.pathname) && !window.__cg2SignupClicked) {
      window.__cg2SignupClicked = true; signup.click(); return {kind: "signup"};
    }
    const key = location.pathname + "|" + inputs.map(x => x.type + ":" + x.name + ":" + x.placeholder).join("|");
    if (window.__cg2LastFill === key) return {kind: "waiting"};
    let filled = 0;
    let unknown = 0;
    const [year, month, day] = job.birth_date.split("-");
    for (const input of inputs) {
      if (birthdayElements.has(input)) continue;
      if (["hidden", "submit", "button", "checkbox", "radio"].includes(input.type) || input.readOnly) continue;
      const name = label(input);
      let value;
      if (input.type === "email" || /\bemail\b|邮箱|电子邮件/.test(name)) value = job.email;
      else if (input.type === "password") value = job.password;
      else if (/\bage\b|年龄/.test(name)) value = String(job.age);
      else if (input.type === "date") value = job.birth_date;
      else if (/birth|\bdob\b|生日|出生日期/.test(name)) {
        if (/yyyy-mm-dd/i.test(input.placeholder)) value = job.birth_date;
        else if (/mm.?dd.?yyyy/i.test(input.placeholder)) value = `${month}/${day}/${year}`;
        else {unknown++; continue;}
      } else if (/\byear\b|出生年|年份/.test(name)) value = year;
      else if (/\bmonth\b|月份/.test(name)) value = String(Number(month));
      else if (/\bday\b|日期|日份/.test(name)) value = String(Number(day));
      else if (/\b(given.name|first.name)\b/.test(name)) value = job.name.split(" ")[0];
      else if (/\b(family.name|last.name)\b/.test(name)) value = job.name.split(" ").slice(1).join(" ");
      else if (/\b(name|full.name)\b|姓名|名字/.test(name)) value = job.name;
      else if (!input.value) {unknown++; continue;}
      if (value !== undefined) {yield {action: "fill", element: input, value}; filled++;}
    }
    for (const select of [...document.querySelectorAll("select")].filter(visible)) {
      if (birthdayElements.has(select)) continue;
      const name = label(select);
      const number = /\byear\b|年份/.test(name) ? Number(year) : /\bmonth\b|月份/.test(name) ? Number(month) : /\bday\b|日期/.test(name) ? Number(day) : null;
      const option = number === null ? null : [...select.options].find(x => x.value !== "" && Number(x.value) === number);
      if (!option) {unknown++; continue;}
      yield {action: "fill", element: select, value: option.value};
      filled++;
    }
    if (unknown || [...document.querySelectorAll('[role="spinbutton"]:not(input)')].some(e => visible(e) && !birthdayElements.has(e))) return {kind: "manual-profile"};
    if (filled || birthdayIndices.length || !inputs.length) {
      if (yield {action: "continue"}) {window.__cg2LastFill = key; return {kind: "advanced"};}
    }
    return {kind: "manual"};
  }
  const fill = (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(element.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value").set;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", {bubbles: true}));
    element.dispatchEvent(new Event("change", {bubbles: true}));
  };
  const clickContinue = () => {
    const visible = element => !!element && !element.disabled && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const buttons = [...document.querySelectorAll("button,input[type=submit]")].filter(visible);
    const button = buttons.find(x => /^(continue|next|submit|verify|confirm|create account|sign up|allow|authorize|accept|继续|下一步|提交|验证|确认|注册|创建账户|创建账号|同意|授权)(\s|$)/i.test((x.innerText || x.value || "").trim()));
    if (button) {button.click(); return true;}
    return false;
  };
  const iterator = steps();
  if (!paced) {
    let step = iterator.next();
    while (!step.done) {
      const action = step.value;
      const value = action.action === "continue" ? clickContinue() : (fill(action.element, action.value), action.element);
      step = iterator.next(value);
    }
    return step.value;
  }
  return (async () => {
    const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const writtenInputs = new Set();
    let result;
    let step = iterator.next();
    while (!step.done) {
      const action = step.value;
      if (action.action === "continue") {
        await pause(1000);
        if (window.__cg2InputCancelled) return {kind: "loading"};
        if ([...writtenInputs].some(element => window.__cg2TouchedInputs.has(element))) return {kind: "manual-profile"};
        result = clickContinue();
      } else {
        let {element} = action;
        const {value} = action;
        const signature = input => JSON.stringify([input.tagName, input.type, input.name, input.id, input.autocomplete, input.placeholder, input.inputMode]);
        const originalSignature = signature(element);
        let expectedValue = element.value;
        // Never overwrite input typed by the user during an asynchronous step.
        const usable = () => {
          if (!element.isConnected) {
            const replacements = [...document.querySelectorAll("input,select")].filter(input => signature(input) === originalSignature && input.value === expectedValue);
            if (replacements.length !== 1) return false;
            element = replacements[0];
          }
          return !window.__cg2InputCancelled && !element.disabled && !window.__cg2TouchedInputs.has(element) && element.value === expectedValue;
        };
        if (!usable()) return {kind: "loading"};
        element.focus();
        if (element.tagName === "SELECT" || ["date", "datetime-local", "month", "time"].includes(element.type)) {fill(element, value); expectedValue = String(value);}
        else {
          let typed = "";
          fill(element, typed);
          expectedValue = typed;
          for (const character of String(value)) {
            await pause(500);
            if (!usable()) return {kind: "loading"};
            typed += character;
            fill(element, typed);
            expectedValue = typed;
          }
        }
        if (!action.groupContinues) await pause(1000);
        if (!usable()) return {kind: "loading"};
        writtenInputs.add(element);
        result = element;
      }
      step = iterator.next(result);
    }
    return step.value;
  })();
}
