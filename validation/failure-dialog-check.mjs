import assert from "node:assert/strict";
import {askCodeFailure} from "../failure-choice.mjs";

for (const choice of ["manual", "skip"]) {
  const result = await askCodeFailure({email: "synthetic@domain.test", reason: "模拟取码失败；不访问真实账号。", testChoice: choice, testHidden: true});
  assert.equal(result, choice, "real Windows Forms button: " + choice);
}
const start = Date.now();
const result = await askCodeFailure({email: "synthetic@domain.test", reason: "验证 15 秒倒计时自动跳过。", testHidden: true});
const elapsed = Date.now() - start;
assert.equal(result, "skip");
assert.ok(elapsed >= 15000 && elapsed < 24000, "real dialog timeout: " + elapsed);
console.log("PASS: real Windows Forms manual/skip button actions and 15-second auto-close to skip (" + elapsed + " ms including startup). Test dialog hidden; no real registration or email access.");
