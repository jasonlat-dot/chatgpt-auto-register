import {chooseCode, inspectMessage} from "./core.mjs";

// The runner resolves mail failures through a bounded manual-or-skip dialog.
export class CodeReader {
  constructor(gmail, {manual = false, failurePolicy = "dialog", waitSeconds = 60, notify = console.log, now = () => Date.now()} = {}) {
    this.gmail = gmail;
    this.manual = manual;
    this.configuredManual = manual;
    this.failurePolicy = failurePolicy;
    this.pendingFailure = null;
    this.unavailableReason = null;
    this.waitMilliseconds = Math.max(1, Number(waitSeconds) || 60) * 1000;
    this.notify = notify;
    this.now = now;
    this.waitStarted = null;
    this.warned = false;
  }
  useManual(reason) {
    if (!this.manual) this.notify(reason + " 已切换为手动接码：请在当前浏览器填写验证码并点击继续，程序会接着完成授权和导入。");
    this.manual = true;
    this.pendingFailure = null;
  }
  fail(reason) {
    this.manual = true;
    this.pendingFailure = reason;
    this.notify(reason + (this.failurePolicy === "skip" ? " 自动模式将跳过当前账号。" : " 将弹窗选择手动接码或跳过当前账号。"));
  }
  resetWait() {this.waitStarted = null; this.warned = false;}
  async connect() {
    if (this.manual) {this.notify("手动接码模式：无需连接 Gmail，请在浏览器直接填写验证码。"); return null;}
    try {return await this.gmail.initialize({allowAuthorize: this.failurePolicy !== "skip"});}
    catch {
      this.unavailableReason = "Gmail 未配置或连接失败。";
      this.manual = true;
      this.pendingFailure = this.unavailableReason;
      return null;
    }
  }
  async begin(email, used, senderDomains) {
    this.resetWait();
    this.manual = this.configuredManual;
    this.pendingFailure = null;
    let baseline = new Set();
    if (!this.configuredManual && this.unavailableReason) this.fail(this.unavailableReason);
    else if (!this.manual) {
      try {baseline = new Set(await this.gmail.ids());}
      catch {this.fail("读取 Gmail 邮件基线失败。");}
    }
    return {email, since: this.now(), baseline, used, senderDomains};
  }
  async read(guard) {
    if (this.manual) return null;
    if (this.waitStarted === null) this.waitStarted = this.now();
    if (this.now() - this.waitStarted >= this.waitMilliseconds) {
      this.fail("自动等待验证码已超时。");
      return null;
    }
    let messages;
    try {messages = await this.gmail.fresh(guard);}
    catch {this.fail("Gmail 自动取码失败。"); return null;}
    const candidate = chooseCode(messages, guard);
    if (candidate) return candidate;
    if (messages.some(message => inspectMessage(message, guard).reason === "ambiguous")) {
      this.fail("当前账号邮件中的验证码不唯一。");
    } else if (messages.map(message => inspectMessage(message, guard)).filter(item => item.code).length > 1) {
      this.fail("当前账号同时收到多封验证码，无法确定应使用哪一封。");
    } else if (!this.warned && messages.some(message => inspectMessage(message, guard).reason === "recipient")) {
      this.notify("新邮件不匹配当前收件地址，继续等待；" + (this.failurePolicy === "skip" ? "达到取码超时后自动跳过。" : "达到取码超时后会弹窗供你选择。"));
      this.warned = true;
    }
    return null;
  }
}
