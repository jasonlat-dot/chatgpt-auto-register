import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

export function askCodeFailure({email, reason, timeoutSeconds = 15, signal, scriptPath = fileURLToPath(new URL("./failure-dialog.ps1", import.meta.url)), testChoice = "", testHidden = false} = {}) {
  if (signal?.aborted) return Promise.resolve("stop");
  return new Promise(resolve => {
    const seconds = Math.min(60, Math.max(1, Math.trunc(Number(timeoutSeconds) || 15)));
    const args = ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Email", email, "-Reason", reason, "-TimeoutSeconds", String(seconds)];
    if (testChoice) args.push("-TestChoice", testChoice);
    if (testHidden) args.push("-TestHidden");
    const child = spawn("powershell.exe", args, {windowsHide: true, stdio: ["ignore", "pipe", "ignore"]});
    let output = "";
    let complete = false;
    let timer;
    const finish = answer => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(answer);
    };
    const abort = () => {child.kill(); finish("stop");};
    signal?.addEventListener("abort", abort, {once: true});
    if (signal?.aborted) {abort(); return;}
    child.stdout.on("data", data => {output = (output + data.toString("utf8")).slice(-512);});
    child.on("error", () => finish("skip"));
    child.on("close", () => finish(output.trim() === "manual" ? "manual" : "skip"));
    // If the helper cannot initialize its UI, there must still be a finite exit.
    timer = setTimeout(() => {child.kill(); finish("skip");}, (seconds + 10) * 1000);
  });
}

export async function resolveCodeFailure(reader, {email, ask = askCodeFailure, signal, skipManual = false} = {}) {
  if (!reader.pendingFailure) return "continue";
  if (skipManual) {reader.pendingFailure = null; return signal?.aborted ? "stop" : "skip";}
  const reason = reader.pendingFailure;
  const result = await ask({email, reason, timeoutSeconds: 15, signal});
  reader.pendingFailure = null;
  if (result === "stop") return "stop";
  if (result === "manual") {
    reader.useManual("你已选择手动接码。");
    reader.notify("已选择手工输入：请在浏览器填写验证码并点击继续，当前账号完成后才会处理下一个。");
    return "manual";
  }
  return "skip";
}
