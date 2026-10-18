import {spawn} from "node:child_process";
import {readFile, mkdir, unlink} from "node:fs/promises";
import {resolve} from "node:path";
import {sleep, validatedCallback} from "./core.mjs";
import {validateBrowserMode} from "./browser-mode.mjs";
import {prepareBirthday} from "./birthday.mjs";
import {browserSessionProbe, sessionLandingStep} from "./session-import.mjs";
import {waitForStablePage} from "./page-timing.mjs";
import {pageLoadSnapshot, waitForPageLoaded} from "./page-load.mjs";
import {findChrome, chromeArguments} from "./browser-launch.mjs";

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
    const timer = setTimeout(() => {pending.delete(current); reject(new Error("浏览器操作超时。"));}, 10000);
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

export async function newAccountPage(browser, expectedState, {sessionImport = false, actionDelayMs = 0, signal} = {}) {
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
  let loading = false;
  let mainFrameId;
  const navigationListener = message => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Page.frameNavigated" && !message.params.frame.parentId) {mainFrameId = message.params.frame.id; loading = true;}
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
    if (loading) return {ready: false};
    const state = await browser.evaluate(sessionId, "(" + pageLoadSnapshot.toString() + ")()");
    return {...state, ready: !!state?.ready && !loading};
  };
  let callback = null;
  let callbackError = null;
  const listener = message => {
    if (message.sessionId !== sessionId || message.method !== "Fetch.requestPaused") return;
    void (async () => {
      const {requestId, request} = message.params;
      if (!request.url.startsWith("https://platform.openai.com/auth/callback")) return;
      // This happens at Request stage, before Platform can receive/redeem the code.
      await browser.send("Fetch.failRequest", {requestId, errorReason: "Aborted"}, sessionId);
      try {callback = validatedCallback(request.url, expectedState);} catch (error) {callbackError = error;}
    })().catch(() => {callbackError = new Error("回调拦截失败，队列已暂停。");});
  };
  if (!sessionImport) {
    browser.listeners.add(listener);
    await browser.send("Fetch.enable", {patterns: [{urlPattern: "https://platform.openai.com/auth/callback*", requestStage: "Request", resourceType: "Document"}]}, sessionId);
  }
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
      const html = '<!doctype html><meta charset="utf-8"><title>导入已确认</title><body style="font-family:system-ui;padding:48px;line-height:1.8"><h1>后端已确认导入</h1><p>本次 OAuth 授权与导入已完成。页面加载稳定后将关闭窗口。</p></body>';
      loading = true;
      await browser.send("Page.navigate", {url: "data:text/html;charset=utf-8," + encodeURIComponent(html)}, sessionId);
      return true;
    },
    async readSession() {
      if (!sessionImport) throw new Error("当前页面未启用 Session 导入。");
      if (!(await loadState()).ready) return {kind: "loading"};
      return browser.evaluate(sessionId, "(" + browserSessionProbe.toString() + ")()");
    },
    async step(job, code = "") {
      if (!(await loadState()).ready) return {kind: "loading"};
      if (actionDelayMs && !(await waitForStablePage(browser, sessionId, actionDelayMs, {signal}))) return {kind: "loading"};
      if (signal?.aborted) throw new Error("用户已停止当前任务。");
      if (callback || callbackError) return {kind: "loading"};
      if (sessionImport) {
        const origin = await browser.evaluate(sessionId, "location.origin");
        if (origin !== "https://auth.openai.com") {
          const landing = await browser.evaluate(sessionId, "(" + sessionLandingStep.toString() + ")()");
          if (landing.kind !== "login-form") return landing;
          return browser.evaluate(sessionId, "(" + formStep.toString() + ")(" + JSON.stringify(job) + "," + JSON.stringify(code) + ",[],{preferLogin:true,allowChatGPTLogin:true})");
        }
      }
      const birthday = await prepareBirthday(browser, sessionId, job);
      if (birthday.kind === "unsupported") return {kind: "manual-profile"};
      return browser.evaluate(sessionId, "(" + formStep.toString() + ")(" + JSON.stringify(job) + "," + JSON.stringify(code) + "," + JSON.stringify(birthday.fields?.map(f => f.index) || []) + "," + JSON.stringify({preferLogin: sessionImport}) + ")");
    },
    async close() {
      browser.listeners.delete(navigationListener);
      browser.listeners.delete(listener);
      if (browserContextId) await browser.send("Target.disposeBrowserContext", {browserContextId});
      else await browser.send("Target.closeTarget", {targetId});
    },
  };
}

// Conservative form adapter. Unknown pages remain visible for the user to handle.
export function formStep(job, code, birthdayIndices = [], {preferLogin = false, allowChatGPTLogin = false} = {}) {
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
  const fill = (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", {bubbles: true}));
    element.dispatchEvent(new Event("change", {bubbles: true}));
  };
  const clickContinue = () => {
    const buttons = [...document.querySelectorAll("button,input[type=submit]")].filter(visible);
    const button = buttons.find(x => /^(continue|next|submit|verify|confirm|create account|sign up|allow|authorize|accept|继续|下一步|提交|验证|确认|注册|创建账户|创建账号|同意|授权)(\s|$)/i.test((x.innerText || x.value || "").trim()));
    if (button) {button.click(); return true;}
    return false;
  };
  const codeInputs = inputs.filter(x => x.autocomplete === "one-time-code" || /\b(otp|code|verification.code)\b|验证码/.test(label(x)) || (x.maxLength === 1 && x.inputMode === "numeric"));
  if (codeInputs.length) {
    const previousAuto = window.__cg2LastAutoOtp;
    const fieldKey = input => JSON.stringify([input.type, input.name, input.autocomplete, input.maxLength, input.inputMode]);
    const sameAuto = previousAuto && codeInputs.length === previousAuto.inputs.length && codeInputs.every((input, i) =>
      input.value === previousAuto.values[i] && (input === previousAuto.inputs[i] || fieldKey(input) === previousAuto.fields?.[i]));
    if (codeInputs.some(x => window.__cg2TouchedInputs.has(x)) || (codeInputs.some(x => x.value.trim()) && !sameAuto)) return {kind: "otp-manual"};
    if (sameAuto) {
      if (!previousAuto.submitted && clickContinue()) {previousAuto.submitted = true; return {kind: "otp-submitted"};}
      return {kind: previousAuto.submitted ? "otp-waiting" : "otp-ready"};
    }
    if (!code) return {kind: "otp"};
    if (codeInputs.length === 1) fill(codeInputs[0], code);
    else if (codeInputs.length === 6 && codeInputs.every(x => x.maxLength === 1)) codeInputs.forEach((x, i) => fill(x, code[i]));
    else return {kind: "manual"};
    window.__cg2LastAutoOtp = {inputs: codeInputs, fields: codeInputs.map(fieldKey), values: codeInputs.map(x => x.value), submitted: false};
    if (clickContinue()) {window.__cg2LastAutoOtp.submitted = true; return {kind: "otp-submitted"};}
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
    if (value !== undefined) {fill(input, value); filled++;}
  }
  for (const select of [...document.querySelectorAll("select")].filter(visible)) {
    if (birthdayElements.has(select)) continue;
    const name = label(select);
    const number = /\byear\b|年份/.test(name) ? Number(year) : /\bmonth\b|月份/.test(name) ? Number(month) : /\bday\b|日期/.test(name) ? Number(day) : null;
    const option = number === null ? null : [...select.options].find(x => x.value !== "" && Number(x.value) === number);
    if (!option) {unknown++; continue;}
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, option.value);
    select.dispatchEvent(new Event("input", {bubbles: true}));
    select.dispatchEvent(new Event("change", {bubbles: true}));
    filled++;
  }
  if (unknown || [...document.querySelectorAll('[role="spinbutton"]:not(input)')].some(e => visible(e) && !birthdayElements.has(e))) return {kind: "manual-profile"};
  if (filled || birthdayIndices.length || !inputs.length) {
    if (clickContinue()) {window.__cg2LastFill = key; return {kind: "advanced"};}
  }
  return {kind: "manual"};
}
