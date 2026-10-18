#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
for executable in git sha256sum tar mktemp; do
  command -v "$executable" >/dev/null || { echo "缺少命令：$executable"; exit 1; }
done
for directory in api services web test; do
  [[ ! -L "$directory" ]] || { echo "不处理带符号链接的源码目录：$directory"; exit 1; }
done
[[ ! -L 'api/accounts.py' ]] || { echo '不处理符号链接：api/accounts.py'; exit 1; }
[[ ! -L 'services/account_service.py' ]] || { echo '不处理符号链接：services/account_service.py'; exit 1; }
[[ ! -L 'services/openai_oauth.py' ]] || { echo '不处理符号链接：services/openai_oauth.py'; exit 1; }
[[ ! -L 'services/oauth_login_service.py' ]] || { echo '不处理符号链接：services/oauth_login_service.py'; exit 1; }
[[ ! -L 'web/src/app/accounts/components/account-import-dialog.tsx' ]] || { echo '不处理符号链接：web/src/app/accounts/components/account-import-dialog.tsx'; exit 1; }
[[ ! -L 'test/test_oauth_loopback.py' ]] || { echo '不处理符号链接：test/test_oauth_loopback.py'; exit 1; }
ensure_override() {
  if [[ ! -e compose.oauth-local.yml && ! -L compose.oauth-local.yml ]]; then
    cat > compose.oauth-local.yml <<'CHATGPT2API_COMPOSE_OVERRIDE'
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    image: chatgpt2api:oauth-loopback-local
CHATGPT2API_COMPOSE_OVERRIDE
    echo "已补充 compose.oauth-local.yml，使用本地镜像。"
  fi
}
matches_target() {
  sha256sum --check --status <<'CHATGPT2API_KNOWN_HASHES'
74da3f8d29f465e65a6b289a8ea37418391c40fc25fee69979d1e31725ae36dc  api/accounts.py
ed2062c730f1de5aad0ac3ff10b77b84b6e26cd15f3c209230b0aeee4458fba5  services/account_service.py
ac67485f924214023b462eb7dc6312fc715d9f2efc55e07941a4deeec829face  services/openai_oauth.py
f1de60872d4929999cac0cfe99ce005c9806dc78ce32d8446edeaec19ed86660  services/oauth_login_service.py
9cb0e3b2dbc3bbbe3c4d5d74580f2a351262a91b60122a5b97a0ac243414307d  web/src/app/accounts/components/account-import-dialog.tsx
6ea7793f3deaaac87bedd2e8521693783753bd54ce8c46003b41f58ce96950c3  test/test_oauth_loopback.py
CHATGPT2API_KNOWN_HASHES
}
matches_original() {
  [[ ! -e 'test/test_oauth_loopback.py' && ! -L 'test/test_oauth_loopback.py' ]] || return 1
  sha256sum --check --status <<'CHATGPT2API_KNOWN_HASHES'
1432104eb2af8456f66c2d23dc581b04aa5cabe55875ab545b20b05b2cc843a5  api/accounts.py
e11d045784e3215b98954fc88225489ce732b103c34070217c38efc7b2f7708c  services/account_service.py
bddf107fca32ee413afa3fc3d2c37e957ce138c27e028ff1b11aaff003726482  services/openai_oauth.py
8019d572e74d8703f7f73aaef813f10fa48b6a9d51957c07a24e985388f9fa5c  services/oauth_login_service.py
4a4b307dea0b7fa047f7811887721bdca5b87e25d4213945cac5e919023491cf  web/src/app/accounts/components/account-import-dialog.tsx
CHATGPT2API_KNOWN_HASHES
}
patch_original() {
  cat <<'CHATGPT2API_PATCH_ORIGINAL'
diff --git a/api/accounts.py b/api/accounts.py
--- a/api/accounts.py
+++ b/api/accounts.py
@@ -363,13 +363,6 @@
     ):
         """收用户从浏览器抓回的 callback URL / code，换出 token 三件套并落盘。"""
         require_admin(authorization)
-        # 入参日志：截断敏感字段，仅保留前几位，方便排错而不泄密
-        cb_preview = (body.callback or "")[:80]
-        sid_preview = (body.session_id or "")[:8]
-        print(
-            f"[oauth-login] finish called: session_id={sid_preview}..., callback_preview={cb_preview!r}",
-            flush=True,
-        )
         try:
             tokens = await run_in_threadpool(oauth_login_service.finish, body.session_id, body.callback)
         except OAuthLoginError as exc:
@@ -380,7 +373,8 @@
             "access_token": tokens["access_token"],
             "refresh_token": tokens["refresh_token"],
             "id_token": tokens["id_token"],
-            "source_type": "oauth_login",
+            "source_type": tokens["source_type"],
+            "oauth_client_id": tokens["oauth_client_id"],
         }
         add_result = await run_in_threadpool(account_service.add_account_items, [payload])
         refresh_result = await run_in_threadpool(
diff --git a/services/account_service.py b/services/account_service.py
--- a/services/account_service.py
+++ b/services/account_service.py
@@ -13,6 +13,7 @@
 from urllib.parse import urlencode
 
 from services.config import config
+from services.openai_oauth import codex_oauth_client_id
 from services.log_service import (
     LOG_TYPE_ACCOUNT,
     log_service,
@@ -356,6 +357,11 @@
         from curl_cffi import requests
         from services.proxy_service import proxy_settings
 
+        # Each refresh token is bound to the client that issued it. Legacy
+        # Platform accounts without this field keep using the original client.
+        client_id = str((account or {}).get("oauth_client_id") or self._OAUTH_CLIENT_ID).strip()
+        if client_id not in {self._OAUTH_CLIENT_ID, codex_oauth_client_id}:
+            raise RuntimeError("unsupported oauth_client_id")
         session = requests.Session(**proxy_settings.build_session_kwargs(account=account, impersonate="chrome110", verify=True))
         try:
             response = session.post(
@@ -368,7 +374,7 @@
                 data={
                     "grant_type": "refresh_token",
                     "refresh_token": refresh_token,
-                    "client_id": self._OAUTH_CLIENT_ID,
+                    "client_id": client_id,
                 },
                 timeout=60,
             )
@@ -1675,6 +1681,8 @@
             password = str(account.get("password") or "").strip()
             if password:
                 item["password"] = password
+            if account.get("oauth_client_id"):
+                item["oauth_client_id"] = str(account["oauth_client_id"])
             items.append(item)
         return items
 
diff --git a/services/openai_oauth.py b/services/openai_oauth.py
--- a/services/openai_oauth.py
+++ b/services/openai_oauth.py
@@ -1,4 +1,9 @@
 auth_base = "https://auth.openai.com"
+# Retained only to refresh accounts previously imported by the V1/V2 patches.
+codex_oauth_client_id = "app_EMoamEEZ73f0CkXaXp7hrann"
+codex_oauth_redirect_uri = "http://localhost:1455/auth/callback"
+codex_oauth_authorize_url = f"{auth_base}/oauth/authorize"
+codex_oauth_token_url = f"{auth_base}/oauth/token"
 platform_base = "https://platform.openai.com"
 platform_oauth_client_id = "app_2SKx67EdpoN0G6j64rFvigXD"
 platform_oauth_redirect_uri = f"{platform_base}/auth/callback"
diff --git a/services/oauth_login_service.py b/services/oauth_login_service.py
--- a/services/oauth_login_service.py
+++ b/services/oauth_login_service.py
@@ -1,14 +1,7 @@
-"""手动 OAuth 桥服务
-
-让用户用自己浏览器走一遍 OpenAI 的标准 OAuth + PKCE 授权码流程：
-  1. 后端生成 code_verifier / code_challenge / state，构造 authorize URL。
-  2. 用户在浏览器登录，浏览器最终被 OpenAI 重定向到 platform.openai.com 的
-     callback 地址；用户从地址栏或 devtools 抓出 code，回填到前端。
-  3. 后端拿之前存好的 code_verifier + 回填的 code 调用 /api/accounts/oauth/token
-     得到 {access_token, refresh_token, id_token}。
-
-得到的 refresh_token 跟 account_service 自动刷新机制用的 client_id 是同一个
-（app_2SKx67EdpoN0G6j64rFvigXD），所以落盘后能直接进入 keepalive 周期。
+"""保留原版 Platform OAuth；浏览器扩展在请求发出前把回调转到 localhost。
+
+本地 URL 只用于复制 code/state。授权与兑换始终使用原注册的 Platform
+redirect_uri；扩展不兑换 code，本服务不监听 localhost 回调端口。
 """
 from __future__ import annotations
 
@@ -35,6 +28,9 @@
 from services.proxy_service import proxy_settings
 
 
+LOCAL_CAPTURE_URI = "http://localhost:1455/auth/callback"
+
+
 class OAuthLoginError(Exception):
     """OAuth 桥流程中的可预期错误，会被 API 层翻译成 400。"""
 
@@ -69,14 +65,14 @@
     def start(self, email_hint: str = "") -> dict[str, str]:
         """登记一个新的 PKCE 会话，返回 session_id 与可让用户打开的 authorize_url。
 
-        state 形如 "<session_id>.<nonce>"，让 callback URL 自带 session_id，
+        state 形如 "chatgpt2api-<session_id>.<nonce>"，让扩展精确识别本项目，
         finish 时即便前端 React 状态被覆盖也能从 URL 恢复正确的 verifier。
         """
         verifier, challenge = self._generate_pkce()
         nonce = secrets.token_urlsafe(32)
         device_id = str(uuid.uuid4())
         session_id = uuid.uuid4().hex
-        state = f"{session_id}.{secrets.token_urlsafe(16)}"
+        state = f"chatgpt2api-{session_id}.{secrets.token_urlsafe(16)}"
 
         params = {
             "issuer": auth_base,
@@ -108,6 +104,8 @@
                 "state": state,
                 "created_at": time.time(),
                 "redirect_uri": platform_oauth_redirect_uri,
+                "client_id": platform_oauth_client_id,
+                "in_progress": False,
             }
 
         return {
@@ -121,7 +119,7 @@
     def _extract_code_from_callback(value: str) -> tuple[str, str]:
         """从 callback URL 或 raw code 中提取 (code, state)。
 
-        既允许用户粘贴整段 platform.openai.com/auth/callback?code=...&state=... 的 URL，
+        既允许浏览器扩展转到的 localhost URL，也允许原 Platform 回调，
         也允许只粘 code 本身。
         """
         raw = str(value or "").strip()
@@ -129,7 +127,12 @@
             return "", ""
         if raw.startswith("http://") or raw.startswith("https://"):
             try:
-                parsed = parse_qs(urlparse(raw).query)
+                url = urlparse(raw)
+                if f"{url.scheme}://{url.netloc}{url.path}" not in (LOCAL_CAPTURE_URI, platform_oauth_redirect_uri):
+                    raise OAuthLoginError("请粘贴本次授权生成的 localhost:1455/auth/callback 完整 URL")
+                parsed = parse_qs(url.query)
+            except OAuthLoginError:
+                raise
             except Exception as exc:
                 raise OAuthLoginError(f"无法解析 callback URL: {exc}") from exc
             code = str((parsed.get("code") or [""])[0]).strip()
@@ -137,6 +140,8 @@
             if not code:
                 err = str((parsed.get("error_description") or parsed.get("error") or [""])[0]).strip()
                 raise OAuthLoginError(err or "callback URL 中没有 code 参数")
+            if not state:
+                raise OAuthLoginError("callback URL 中缺少 state，请复制完整 URL")
             return code, state
         # 用户可能直接粘了 code 字符串
         return raw, ""
@@ -146,8 +151,8 @@
 
         - 优先用 callback URL 自带 state 里的 session_id（更可靠），
           找不到才用前端传来的 session_id；
-        - 失败时不立刻销毁 session（OAuth code 错配换 token 失败通常不会消耗 code），
-          只有成功兑换才 pop，便于用户用同一 verifier 重试。
+        - 同一会话同时只允许一个兑换请求；成功后删除会话。
+        - 网络错误不能证明 code 未消耗，遇到此类错误应重新授权。
         """
         body_sid = str(session_id or "").strip()
         code, state = self._extract_code_from_callback(callback)
@@ -155,7 +160,7 @@
             raise OAuthLoginError("缺少 code 或 callback URL")
 
         # state 里嵌的 session_id 优先级最高
-        state_sid = state.split(".", 1)[0] if state else ""
+        state_sid = state.split(".", 1)[0].removeprefix("chatgpt2api-") if state else ""
         candidate_sids = [sid for sid in (state_sid, body_sid) if sid]
         if not candidate_sids:
             raise OAuthLoginError("既未提供 session_id，callback URL 中也未携带 state")
@@ -170,30 +175,33 @@
                     session = cur
                     picked_sid = sid
                     break
-        if session is None:
-            raise OAuthLoginError(
-                "OAuth 会话已过期或不存在，请回到导入对话框点\"重新生成\"再走一次"
-            )
-
-        if state and session.get("state") and state != session["state"]:
-            raise OAuthLoginError(
-                "state 不匹配。常见原因：你点过两次\"打开授权页面\"，但浏览器里登录的还是前一次的窗口。请点\"重新生成\"重来。"
-            )
-
-        tokens = self._exchange_code(
-            code,
-            session["code_verifier"],
-            session.get("redirect_uri") or platform_oauth_redirect_uri,
-        )
+            if session is None:
+                raise OAuthLoginError("OAuth 会话已过期、不存在或已完成，请重新生成授权")
+            if state and not secrets.compare_digest(state.encode("utf-8"), session["state"].encode("utf-8")):
+                raise OAuthLoginError("state 不匹配，请使用本次授权窗口生成的完整 callback URL")
+            if session.get("in_progress"):
+                raise OAuthLoginError("本次授权正在兑换，请勿重复提交")
+            session["in_progress"] = True
+
+        try:
+            tokens = self._exchange_code(
+                code,
+                session["code_verifier"],
+                session["redirect_uri"],
+            )
+        except Exception:
+            with self._lock:
+                session["in_progress"] = False
+            raise
         # 仅在成功兑换之后才消耗 session
         with self._lock:
             self._sessions.pop(picked_sid, None)
-        return tokens
+        return {**tokens, "oauth_client_id": session["client_id"], "source_type": "oauth_login"}
 
     @staticmethod
     def _exchange_code(code: str, code_verifier: str, redirect_uri: str) -> dict[str, str]:
         """调用 /api/accounts/oauth/token 用 code+verifier 换 token 三件套。"""
-        kwargs = proxy_settings.build_session_kwargs(impersonate="chrome", verify=False)
+        kwargs = proxy_settings.build_session_kwargs(impersonate="chrome", verify=True)
         session = requests.Session(**kwargs)
         try:
             response = session.post(
@@ -216,7 +224,7 @@
                 timeout=60,
             )
         except Exception as exc:
-            raise OAuthLoginError(f"换 token 网络异常: {exc}") from exc
+            raise OAuthLoginError("换 token 网络异常，无法确认授权码是否已消耗；请重新生成授权") from exc
         finally:
             session.close()
 
@@ -234,13 +242,7 @@
                     detail = str(response.text or "")[:300]
                 except Exception:
                     detail = ""
-            # 打到 docker logs 方便排错——OAuth 换 token 的失败原因往往只有这里能看到
-            print(
-                f"[oauth-login] /api/accounts/oauth/token rejected: "
-                f"status={response.status_code} detail={detail!r} "
-                f"raw_body={(getattr(response, 'text', '') or '')[:500]!r}",
-                flush=True,
-            )
+            detail = detail.replace(code, "[code]").replace(code_verifier, "[verifier]")
             raise OAuthLoginError(
                 f"OpenAI 拒绝换 token (HTTP {response.status_code}){': ' + detail if detail else ''}"
             )
@@ -254,7 +256,7 @@
         if not refresh_token:
             # scope 含 offline_access 时正常会下发 refresh_token；这里给出明确提示
             raise OAuthLoginError(
-                "OpenAI 没有返回 refresh_token（可能 scope 未包含 offline_access 或 code 已使用过）"
+                "OpenAI 没有返回 refresh_token；请重新生成授权，不要重复兑换旧 code"
             )
 
         return {
diff --git a/web/src/app/accounts/components/account-import-dialog.tsx b/web/src/app/accounts/components/account-import-dialog.tsx
--- a/web/src/app/accounts/components/account-import-dialog.tsx
+++ b/web/src/app/accounts/components/account-import-dialog.tsx
@@ -556,9 +556,10 @@
           <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm leading-6 text-stone-600 space-y-2">
             <div className="font-medium text-stone-800">操作步骤</div>
             <ol className="list-decimal pl-5 space-y-1">
-              <li>（可选）填写你 ChatGPT 账号的邮箱，登录页会预填。</li>
-              <li>点击下方"打开授权页面"，在新标签里登录自己的 ChatGPT 账号。</li>
-              <li>登录完成后浏览器会跳到 <code className="rounded bg-stone-200 px-1">platform.openai.com/auth/callback?code=...</code>。立刻从地址栏复制整段 URL（或开 F12 在 Network 里抓到 callback 那一行，右键 Copy → Copy URL）。</li>
+              <li>先在当前浏览器的“ChatGPT2API 回调拦截”扩展中点击“启用拦截（10 分钟）”，确认显示“已启用”。</li>
+              <li>（可选）填写账号邮箱，登录页会预填。本次使用原版 Platform 授权流程。</li>
+              <li>启用扩展后，点击下方“打开授权页面”，在同一浏览器的新标签里完成登录或注册。</li>
+              <li>扩展会在 Platform 回调请求发出前将地址转到 <code className="rounded bg-stone-200 px-1">http://localhost:1455/auth/callback?code=...&amp;state=...</code>。本项目不监听 1455 端口，页面提示无法连接是正常的；从地址栏复制包含 code 和 state 的完整 URL。</li>
               <li>把 callback URL 粘到下面输入框，点"完成导入"。</li>
             </ol>
           </div>
@@ -620,9 +621,9 @@
                 </Button>
               </div>
               <div className="space-y-2">
-                <label className="text-sm font-medium text-stone-700">粘贴 callback URL（或仅 code）</label>
+                <label className="text-sm font-medium text-stone-700">粘贴完整 callback URL（包含 code 和 state）</label>
                 <Textarea
-                  placeholder={"https://platform.openai.com/auth/callback?code=...&state=..."}
+                  placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                   value={oauthCallbackInput}
                   onChange={(event) => setOauthCallbackInput(event.target.value)}
                   className="min-h-24 resize-none rounded-xl border-stone-200 font-mono text-xs"
@@ -633,8 +634,8 @@
           <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
             <div className="font-medium">注意</div>
             <div>
-              授权码（code）只能使用一次。如果浏览器的 callback 页加载完成、显示了 OpenAI 的错误页，那 code 大概率已经被消耗，
-              请点击"重新生成"再走一次。整个流程在 10 分钟内完成即可。
+              授权链接里仍是 platform.openai.com/auth/callback，这是原版注册的回调地址；由扩展在浏览器中拦截。授权码只能兑换一次，请在 10 分钟内回填并提交。授权期间确保本机 1455 端口没有其他 OAuth 回调服务监听。
+              如果最终仍进入 Platform 页面，说明扩展未生效，请启用后重新生成授权；不要把已经跳转的地址手动改成 localhost。如果提示 code 已使用或换 token 网络异常，请重新生成授权；其他工具生成的回调 URL 无法用于本次会话。
             </div>
           </div>
         </div>
diff --git a/test/test_oauth_loopback.py b/test/test_oauth_loopback.py
new file mode 100644
--- /dev/null
+++ b/test/test_oauth_loopback.py
@@ -0,0 +1,186 @@
+from __future__ import annotations
+
+import base64
+import hashlib
+import io
+import os
+import tempfile
+import threading
+import time
+import unittest
+from concurrent.futures import ThreadPoolExecutor
+from contextlib import redirect_stdout
+from pathlib import Path
+from unittest.mock import Mock, patch
+from urllib.parse import parse_qs, urlencode, urlparse
+
+os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")
+
+from fastapi import FastAPI
+from fastapi.testclient import TestClient
+
+from api.accounts import create_router
+from services.account_service import AccountService
+from services.oauth_login_service import LOCAL_CAPTURE_URI, OAuthLoginError, OAuthLoginService
+from services.openai_oauth import codex_oauth_client_id, platform_oauth_client_id, platform_oauth_redirect_uri, platform_oauth_audience, platform_auth0_client
+from services.storage.json_storage import JSONStorageBackend
+
+
+TOKENS = {"access_token": "test-access", "refresh_token": "test-refresh", "id_token": "test-id"}
+
+
+class LoopbackOAuthTests(unittest.TestCase):
+    def setUp(self):
+        self.service = OAuthLoginService()
+        self.started = self.service.start("test@example.com")
+        self.sid = self.started["session_id"]
+        self.query = parse_qs(urlparse(self.started["authorize_url"]).query)
+        self.state = self.query["state"][0]
+        self.callback = LOCAL_CAPTURE_URI + "?" + urlencode({"code": "test-code", "state": self.state})
+
+    def test_authorization_preserves_original_platform_profile_and_matching_pkce(self):
+        self.assertEqual(urlparse(self.started["authorize_url"]).path, "/api/accounts/authorize")
+        self.assertEqual(self.query["client_id"], [platform_oauth_client_id])
+        self.assertEqual(self.query["redirect_uri"], [platform_oauth_redirect_uri])
+        self.assertEqual(self.query["scope"], ["openid profile email offline_access"])
+        self.assertEqual(self.query["code_challenge_method"], ["S256"])
+        self.assertNotIn("codex_cli_simplified_flow", self.query)
+        self.assertNotIn("id_token_add_organizations", self.query)
+        self.assertEqual(self.query["audience"], [platform_oauth_audience])
+        self.assertEqual(self.query["issuer"], ["https://auth.openai.com"])
+        self.assertEqual(self.query["screen_hint"], ["login_or_signup"])
+        self.assertEqual(self.query["max_age"], ["0"])
+        self.assertEqual(self.query["auth0Client"], [platform_auth0_client])
+        self.assertEqual(self.query["login_hint"], ["test@example.com"])
+        self.assertTrue(self.query["nonce"][0])
+        self.assertTrue(self.query["device_id"][0])
+        verifier = self.service._sessions[self.sid]["code_verifier"]
+        expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
+        self.assertEqual(self.query["code_challenge"], [expected])
+
+    def test_success_consumes_session_and_preserves_refresh_client(self):
+        with patch.object(self.service, "_exchange_code", return_value=TOKENS) as exchange:
+            result = self.service.finish("stale-body-session", self.callback)
+            self.assertEqual(result["oauth_client_id"], platform_oauth_client_id)
+            self.assertEqual(result["source_type"], "oauth_login")
+            self.assertEqual(exchange.call_args.args[2], platform_oauth_redirect_uri)
+            with self.assertRaises(OAuthLoginError):
+                self.service.finish(self.sid, self.callback)
+            exchange.assert_called_once()
+
+    def test_original_platform_callback_remains_accepted(self):
+        callback = self.callback.replace(LOCAL_CAPTURE_URI, platform_oauth_redirect_uri)
+        with patch.object(self.service, "_exchange_code", return_value=TOKENS) as exchange:
+            self.service.finish(self.sid, callback)
+            self.assertEqual(exchange.call_args.args[2], platform_oauth_redirect_uri)
+
+    def test_wrong_state_is_rejected_before_exchange(self):
+        with patch.object(self.service, "_exchange_code") as exchange:
+            wrong = self.callback.replace(self.state, self.sid + ".wrong")
+            with self.assertRaisesRegex(OAuthLoginError, "state"):
+                self.service.finish(self.sid, wrong)
+            exchange.assert_not_called()
+
+    def test_missing_state_and_foreign_callback_are_rejected(self):
+        for value in [LOCAL_CAPTURE_URI + "?code=test-code", self.callback.replace("localhost:1455", "example.com")]:
+            with self.subTest(value=value), patch.object(self.service, "_exchange_code") as exchange:
+                with self.assertRaises(OAuthLoginError):
+                    self.service.finish(self.sid, value)
+                exchange.assert_not_called()
+
+    def test_expired_session_is_rejected(self):
+        self.service._sessions[self.sid]["created_at"] = time.time() - 601
+        with patch.object(self.service, "_exchange_code") as exchange:
+            with self.assertRaises(OAuthLoginError):
+                self.service.finish(self.sid, self.callback)
+            exchange.assert_not_called()
+
+    def test_simultaneous_submissions_only_exchange_once(self):
+        entered = threading.Event()
+        release = threading.Event()
+
+        def exchange(*args):
+            entered.set()
+            if not release.wait(5):
+                raise RuntimeError("test timed out")
+            return TOKENS
+
+        with patch.object(self.service, "_exchange_code", side_effect=exchange) as mocked:
+            with ThreadPoolExecutor(max_workers=1) as executor:
+                first = executor.submit(self.service.finish, self.sid, self.callback)
+                self.assertTrue(entered.wait(5))
+                try:
+                    with self.assertRaisesRegex(OAuthLoginError, "重复提交"):
+                        self.service.finish(self.sid, self.callback)
+                finally:
+                    release.set()
+                self.assertEqual(first.result(timeout=5)["access_token"], TOKENS["access_token"])
+            mocked.assert_called_once()
+
+    def test_exchange_posts_original_platform_json_and_registered_redirect(self):
+        response = Mock(status_code=200, text="json")
+        response.json.return_value = TOKENS
+        session = Mock()
+        session.post.return_value = response
+        with patch("services.oauth_login_service.requests.Session", return_value=session):
+            self.assertEqual(self.service._exchange_code("test-code", "test-verifier", platform_oauth_redirect_uri), TOKENS)
+        args, kwargs = session.post.call_args
+        self.assertEqual(args, ("https://auth.openai.com/api/accounts/oauth/token",))
+        self.assertEqual(kwargs["json"]["client_id"], platform_oauth_client_id)
+        self.assertEqual(kwargs["json"]["redirect_uri"], self.query["redirect_uri"][0])
+        self.assertEqual(kwargs["json"]["code_verifier"], "test-verifier")
+        self.assertNotIn("data", kwargs)
+        self.assertEqual(kwargs["headers"]["origin"], "https://platform.openai.com")
+        session.close.assert_called_once()
+
+    def test_exchange_error_does_not_echo_code_or_verifier(self):
+        response = Mock(status_code=400, text="json")
+        response.json.return_value = {"error_description": "invalid test-code test-verifier"}
+        session = Mock()
+        session.post.return_value = response
+        with patch("services.oauth_login_service.requests.Session", return_value=session):
+            with self.assertRaises(OAuthLoginError) as raised:
+                self.service._exchange_code("test-code", "test-verifier", platform_oauth_redirect_uri)
+        self.assertNotIn("test-code", str(raised.exception))
+        self.assertNotIn("test-verifier", str(raised.exception))
+
+
+class RefreshProfileTests(unittest.TestCase):
+    def test_new_and_legacy_refresh_use_their_own_client(self):
+        with tempfile.TemporaryDirectory() as directory:
+            service = AccountService(JSONStorageBackend(Path(directory) / "accounts.json"))
+            for account, expected in [({}, service._OAUTH_CLIENT_ID), ({"oauth_client_id": codex_oauth_client_id}, codex_oauth_client_id)]:
+                response = Mock(status_code=200, text="json")
+                response.json.return_value = TOKENS
+                session = Mock()
+                session.post.return_value = response
+                with self.subTest(client=expected), patch("curl_cffi.requests.Session", return_value=session):
+                    service._request_access_token_refresh("test-refresh", account)
+                    self.assertEqual(session.post.call_args.kwargs["data"]["client_id"], expected)
+
+    def test_client_metadata_survives_storage_rotation_and_export(self):
+        with tempfile.TemporaryDirectory() as directory:
+            storage = JSONStorageBackend(Path(directory) / "accounts.json")
+            service = AccountService(storage)
+            service.add_account_items([{**TOKENS, "oauth_client_id": codex_oauth_client_id, "source_type": "codex"}])
+            service._apply_refreshed_tokens("test-access", {**TOKENS, "access_token": "rotated-access"}, "test")
+            reloaded = AccountService(storage)
+            self.assertEqual(reloaded.get_account("rotated-access")["oauth_client_id"], codex_oauth_client_id)
+            [exported] = reloaded.build_export_items()
+            self.assertEqual(exported["oauth_client_id"], codex_oauth_client_id)
+
+    def test_finish_api_persists_client_and_omits_callback_from_logs(self):
+        app = FastAPI()
+        app.include_router(create_router())
+        client = TestClient(app)
+        output = io.StringIO()
+        with patch("api.accounts.require_admin"), patch("api.accounts.oauth_login_service.finish", return_value={**TOKENS, "oauth_client_id": platform_oauth_client_id, "source_type": "oauth_login"}), patch("api.accounts.account_service.add_account_items", return_value={"added": 1}) as add, patch("api.accounts.account_service.refresh_accounts", return_value={"refreshed": 1, "items": [], "errors": []}), redirect_stdout(output):
+            response = client.post("/api/accounts/oauth/finish", json={"session_id": "test-session", "callback": LOCAL_CAPTURE_URI + "?code=sensitive-test-code&state=test-state"})
+        self.assertEqual(response.status_code, 200)
+        self.assertEqual(add.call_args.args[0][0]["oauth_client_id"], platform_oauth_client_id)
+        self.assertEqual(add.call_args.args[0][0]["source_type"], "oauth_login")
+        self.assertNotIn("sensitive-test-code", output.getvalue())
+
+
+if __name__ == "__main__":
+    unittest.main()
CHATGPT2API_PATCH_ORIGINAL
}
matches_v1() {
  sha256sum --check --status <<'CHATGPT2API_KNOWN_HASHES'
74da3f8d29f465e65a6b289a8ea37418391c40fc25fee69979d1e31725ae36dc  api/accounts.py
ed2062c730f1de5aad0ac3ff10b77b84b6e26cd15f3c209230b0aeee4458fba5  services/account_service.py
030e0f3afba9dcfd8c80711fb133d438b7f952efbf2c52b89d5d01caf3d18545  services/openai_oauth.py
1a3a4e40e98a168d8e5d12985dfe1b579a7b5999ca79d5fc2ab55c9f1f674708  services/oauth_login_service.py
a777e550722a11494c60790b571d5f4da232865f460964674ffbe551c1695db3  web/src/app/accounts/components/account-import-dialog.tsx
0b8140dfd018bf838e88d506ce6a85e31d1807bb899c827fdd115505d89e2122  test/test_oauth_loopback.py
CHATGPT2API_KNOWN_HASHES
}
patch_v1() {
  cat <<'CHATGPT2API_PATCH_V1'
diff --git a/services/openai_oauth.py b/services/openai_oauth.py
--- a/services/openai_oauth.py
+++ b/services/openai_oauth.py
@@ -1,5 +1,5 @@
 auth_base = "https://auth.openai.com"
-# Loopback OAuth profile, matching Sub2API's OpenAI login flow.
+# Retained only to refresh accounts previously imported by the V1/V2 patches.
 codex_oauth_client_id = "app_EMoamEEZ73f0CkXaXp7hrann"
 codex_oauth_redirect_uri = "http://localhost:1455/auth/callback"
 codex_oauth_authorize_url = f"{auth_base}/oauth/authorize"
diff --git a/services/oauth_login_service.py b/services/oauth_login_service.py
--- a/services/oauth_login_service.py
+++ b/services/oauth_login_service.py
@@ -1,14 +1,7 @@
-"""手动 OAuth 桥服务
-
-让用户用自己浏览器走一遍 OpenAI 的标准 OAuth + PKCE 授权码流程：
-  1. 后端生成 code_verifier / code_challenge / state，构造 authorize URL。
-  2. 用户在浏览器登录，浏览器最终跳到 localhost:1455/auth/callback；
-     本服务不监听该端口，用户复制完整回调 URL 并回填到前端。
-  3. 后端拿之前存好的 code_verifier + 回填的 code 调用 /oauth/token
-     得到 {access_token, refresh_token, id_token}。
-
-按 Sub2API 的 Codex OAuth profile 授权，持久保存 client_id，供自动刷新使用。
-授权码仍只能兑换一次；同一会话禁止并发兑换。
+"""保留原版 Platform OAuth；浏览器扩展在请求发出前把回调转到 localhost。
+
+本地 URL 只用于复制 code/state。授权与兑换始终使用原注册的 Platform
+redirect_uri；扩展不兑换 code，本服务不监听 localhost 回调端口。
 """
 from __future__ import annotations
 
@@ -22,13 +15,20 @@
 from curl_cffi import requests
 
 from services.openai_oauth import (
-    codex_oauth_authorize_url,
-    codex_oauth_client_id,
-    codex_oauth_redirect_uri,
-    codex_oauth_token_url,
+    auth_base,
+    common_headers,
+    platform_auth0_client,
+    platform_base,
+    platform_oauth_audience,
+    platform_oauth_client_id,
+    platform_oauth_redirect_uri,
+    sec_ch_ua,
     user_agent,
 )
 from services.proxy_service import proxy_settings
+
+
+LOCAL_CAPTURE_URI = "http://localhost:1455/auth/callback"
 
 
 class OAuthLoginError(Exception):
@@ -65,30 +65,37 @@
     def start(self, email_hint: str = "") -> dict[str, str]:
         """登记一个新的 PKCE 会话，返回 session_id 与可让用户打开的 authorize_url。
 
-        state 形如 "<session_id>.<nonce>"，让 callback URL 自带 session_id，
+        state 形如 "chatgpt2api-<session_id>.<nonce>"，让扩展精确识别本项目，
         finish 时即便前端 React 状态被覆盖也能从 URL 恢复正确的 verifier。
         """
         verifier, challenge = self._generate_pkce()
+        nonce = secrets.token_urlsafe(32)
+        device_id = str(uuid.uuid4())
         session_id = uuid.uuid4().hex
-        state = f"{session_id}.{secrets.token_urlsafe(16)}"
+        state = f"chatgpt2api-{session_id}.{secrets.token_urlsafe(16)}"
 
         params = {
-            "client_id": codex_oauth_client_id,
-            "redirect_uri": codex_oauth_redirect_uri,
+            "issuer": auth_base,
+            "client_id": platform_oauth_client_id,
+            "audience": platform_oauth_audience,
+            "redirect_uri": platform_oauth_redirect_uri,
+            "device_id": device_id,
+            "screen_hint": "login_or_signup",
+            "max_age": "0",
             "scope": "openid profile email offline_access",
             "response_type": "code",
             "response_mode": "query",
             "state": state,
+            "nonce": nonce,
             "code_challenge": challenge,
             "code_challenge_method": "S256",
-            "id_token_add_organizations": "true",
-            "codex_cli_simplified_flow": "true",
+            "auth0Client": platform_auth0_client,
         }
         email_hint = str(email_hint or "").strip()
         if email_hint:
             params["login_hint"] = email_hint
 
-        authorize_url = f"{codex_oauth_authorize_url}?{urlencode(params)}"
+        authorize_url = f"{auth_base}/api/accounts/authorize?{urlencode(params)}"
 
         with self._lock:
             self._purge_expired_locked()
@@ -96,8 +103,8 @@
                 "code_verifier": verifier,
                 "state": state,
                 "created_at": time.time(),
-                "redirect_uri": codex_oauth_redirect_uri,
-                "client_id": codex_oauth_client_id,
+                "redirect_uri": platform_oauth_redirect_uri,
+                "client_id": platform_oauth_client_id,
                 "in_progress": False,
             }
 
@@ -105,14 +112,14 @@
             "session_id": session_id,
             "authorize_url": authorize_url,
             "expires_in": str(self._SESSION_TTL_SECONDS),
-            "redirect_uri_prefix": codex_oauth_redirect_uri,
+            "redirect_uri_prefix": platform_oauth_redirect_uri,
         }
 
     @staticmethod
     def _extract_code_from_callback(value: str) -> tuple[str, str]:
         """从 callback URL 或 raw code 中提取 (code, state)。
 
-        既允许用户粘贴完整 localhost 回调 URL，
+        既允许浏览器扩展转到的 localhost URL，也允许原 Platform 回调，
         也允许只粘 code 本身。
         """
         raw = str(value or "").strip()
@@ -121,7 +128,7 @@
         if raw.startswith("http://") or raw.startswith("https://"):
             try:
                 url = urlparse(raw)
-                if f"{url.scheme}://{url.netloc}{url.path}" != codex_oauth_redirect_uri:
+                if f"{url.scheme}://{url.netloc}{url.path}" not in (LOCAL_CAPTURE_URI, platform_oauth_redirect_uri):
                     raise OAuthLoginError("请粘贴本次授权生成的 localhost:1455/auth/callback 完整 URL")
                 parsed = parse_qs(url.query)
             except OAuthLoginError:
@@ -153,7 +160,7 @@
             raise OAuthLoginError("缺少 code 或 callback URL")
 
         # state 里嵌的 session_id 优先级最高
-        state_sid = state.split(".", 1)[0] if state else ""
+        state_sid = state.split(".", 1)[0].removeprefix("chatgpt2api-") if state else ""
         candidate_sids = [sid for sid in (state_sid, body_sid) if sid]
         if not candidate_sids:
             raise OAuthLoginError("既未提供 session_id，callback URL 中也未携带 state")
@@ -189,23 +196,26 @@
         # 仅在成功兑换之后才消耗 session
         with self._lock:
             self._sessions.pop(picked_sid, None)
-        return {**tokens, "oauth_client_id": session["client_id"], "source_type": "codex"}
+        return {**tokens, "oauth_client_id": session["client_id"], "source_type": "oauth_login"}
 
     @staticmethod
     def _exchange_code(code: str, code_verifier: str, redirect_uri: str) -> dict[str, str]:
-        """调用 Codex OAuth token endpoint；redirect_uri 与授权阶段保持一致。"""
+        """调用 /api/accounts/oauth/token 用 code+verifier 换 token 三件套。"""
         kwargs = proxy_settings.build_session_kwargs(impersonate="chrome", verify=True)
         session = requests.Session(**kwargs)
         try:
             response = session.post(
-                codex_oauth_token_url,
+                f"{auth_base}/api/accounts/oauth/token",
                 headers={
-                    "accept": "application/json",
-                    "content-type": "application/x-www-form-urlencoded",
+                    **common_headers,
+                    "referer": f"{platform_base}/",
+                    "origin": platform_base,
+                    "auth0-client": platform_auth0_client,
+                    "sec-ch-ua": sec_ch_ua,
                     "user-agent": user_agent,
                 },
-                data={
-                    "client_id": codex_oauth_client_id,
+                json={
+                    "client_id": platform_oauth_client_id,
                     "code_verifier": code_verifier,
                     "grant_type": "authorization_code",
                     "code": code,
diff --git a/web/src/app/accounts/components/account-import-dialog.tsx b/web/src/app/accounts/components/account-import-dialog.tsx
--- a/web/src/app/accounts/components/account-import-dialog.tsx
+++ b/web/src/app/accounts/components/account-import-dialog.tsx
@@ -556,9 +556,10 @@
           <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm leading-6 text-stone-600 space-y-2">
             <div className="font-medium text-stone-800">操作步骤</div>
             <ol className="list-decimal pl-5 space-y-1">
-              <li>（可选）填写你 ChatGPT 账号的邮箱，登录页会预填。</li>
-              <li>点击下方"打开授权页面"，在新标签里登录自己的 ChatGPT 账号。</li>
-              <li>授权完成后会跳到 <code className="rounded bg-stone-200 px-1">http://localhost:1455/auth/callback?code=...&amp;state=...</code>。本项目不监听 1455 端口，页面提示无法连接是正常的；从地址栏复制包含 code 和 state 的完整 URL。</li>
+              <li>先在当前浏览器的“ChatGPT2API 回调拦截”扩展中点击“启用拦截（10 分钟）”，确认显示“已启用”。</li>
+              <li>（可选）填写账号邮箱，登录页会预填。本次使用原版 Platform 授权流程。</li>
+              <li>启用扩展后，点击下方“打开授权页面”，在同一浏览器的新标签里完成登录或注册。</li>
+              <li>扩展会在 Platform 回调请求发出前将地址转到 <code className="rounded bg-stone-200 px-1">http://localhost:1455/auth/callback?code=...&amp;state=...</code>。本项目不监听 1455 端口，页面提示无法连接是正常的；从地址栏复制包含 code 和 state 的完整 URL。</li>
               <li>把 callback URL 粘到下面输入框，点"完成导入"。</li>
             </ol>
           </div>
@@ -622,7 +623,7 @@
               <div className="space-y-2">
                 <label className="text-sm font-medium text-stone-700">粘贴完整 callback URL（包含 code 和 state）</label>
                 <Textarea
-                  placeholder={oauthSession.redirect_uri_prefix + "?code=...&state=..."}
+                  placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                   value={oauthCallbackInput}
                   onChange={(event) => setOauthCallbackInput(event.target.value)}
                   className="min-h-24 resize-none rounded-xl border-stone-200 font-mono text-xs"
@@ -633,8 +634,8 @@
           <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
             <div className="font-medium">注意</div>
             <div>
-              授权码只能兑换一次，请在 10 分钟内回填并提交。授权期间确保本机 1455 端口没有其他 OAuth 回调服务监听。
-              如果提示 code 已使用或换 token 网络异常，请重新生成授权；其他工具生成的回调 URL 无法用于本次会话。
+              授权链接里仍是 platform.openai.com/auth/callback，这是原版注册的回调地址；由扩展在浏览器中拦截。授权码只能兑换一次，请在 10 分钟内回填并提交。授权期间确保本机 1455 端口没有其他 OAuth 回调服务监听。
+              如果最终仍进入 Platform 页面，说明扩展未生效，请启用后重新生成授权；不要把已经跳转的地址手动改成 localhost。如果提示 code 已使用或换 token 网络异常，请重新生成授权；其他工具生成的回调 URL 无法用于本次会话。
             </div>
           </div>
         </div>
diff --git a/test/test_oauth_loopback.py b/test/test_oauth_loopback.py
--- a/test/test_oauth_loopback.py
+++ b/test/test_oauth_loopback.py
@@ -21,8 +21,8 @@
 
 from api.accounts import create_router
 from services.account_service import AccountService
-from services.oauth_login_service import OAuthLoginError, OAuthLoginService
-from services.openai_oauth import codex_oauth_client_id, codex_oauth_redirect_uri
+from services.oauth_login_service import LOCAL_CAPTURE_URI, OAuthLoginError, OAuthLoginService
+from services.openai_oauth import codex_oauth_client_id, platform_oauth_client_id, platform_oauth_redirect_uri, platform_oauth_audience, platform_auth0_client
 from services.storage.json_storage import JSONStorageBackend
 
 
@@ -36,16 +36,24 @@
         self.sid = self.started["session_id"]
         self.query = parse_qs(urlparse(self.started["authorize_url"]).query)
         self.state = self.query["state"][0]
-        self.callback = codex_oauth_redirect_uri + "?" + urlencode({"code": "test-code", "state": self.state})
+        self.callback = LOCAL_CAPTURE_URI + "?" + urlencode({"code": "test-code", "state": self.state})
 
-    def test_authorization_uses_loopback_profile_and_matching_pkce(self):
-        self.assertEqual(urlparse(self.started["authorize_url"]).path, "/oauth/authorize")
-        self.assertEqual(self.query["client_id"], [codex_oauth_client_id])
-        self.assertEqual(self.query["redirect_uri"], [codex_oauth_redirect_uri])
+    def test_authorization_preserves_original_platform_profile_and_matching_pkce(self):
+        self.assertEqual(urlparse(self.started["authorize_url"]).path, "/api/accounts/authorize")
+        self.assertEqual(self.query["client_id"], [platform_oauth_client_id])
+        self.assertEqual(self.query["redirect_uri"], [platform_oauth_redirect_uri])
         self.assertEqual(self.query["scope"], ["openid profile email offline_access"])
         self.assertEqual(self.query["code_challenge_method"], ["S256"])
-        self.assertEqual(self.query["codex_cli_simplified_flow"], ["true"])
-        self.assertNotIn("audience", self.query)
+        self.assertNotIn("codex_cli_simplified_flow", self.query)
+        self.assertNotIn("id_token_add_organizations", self.query)
+        self.assertEqual(self.query["audience"], [platform_oauth_audience])
+        self.assertEqual(self.query["issuer"], ["https://auth.openai.com"])
+        self.assertEqual(self.query["screen_hint"], ["login_or_signup"])
+        self.assertEqual(self.query["max_age"], ["0"])
+        self.assertEqual(self.query["auth0Client"], [platform_auth0_client])
+        self.assertEqual(self.query["login_hint"], ["test@example.com"])
+        self.assertTrue(self.query["nonce"][0])
+        self.assertTrue(self.query["device_id"][0])
         verifier = self.service._sessions[self.sid]["code_verifier"]
         expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
         self.assertEqual(self.query["code_challenge"], [expected])
@@ -53,12 +61,18 @@
     def test_success_consumes_session_and_preserves_refresh_client(self):
         with patch.object(self.service, "_exchange_code", return_value=TOKENS) as exchange:
             result = self.service.finish("stale-body-session", self.callback)
-            self.assertEqual(result["oauth_client_id"], codex_oauth_client_id)
-            self.assertEqual(result["source_type"], "codex")
-            self.assertEqual(exchange.call_args.args[2], codex_oauth_redirect_uri)
+            self.assertEqual(result["oauth_client_id"], platform_oauth_client_id)
+            self.assertEqual(result["source_type"], "oauth_login")
+            self.assertEqual(exchange.call_args.args[2], platform_oauth_redirect_uri)
             with self.assertRaises(OAuthLoginError):
                 self.service.finish(self.sid, self.callback)
             exchange.assert_called_once()
+
+    def test_original_platform_callback_remains_accepted(self):
+        callback = self.callback.replace(LOCAL_CAPTURE_URI, platform_oauth_redirect_uri)
+        with patch.object(self.service, "_exchange_code", return_value=TOKENS) as exchange:
+            self.service.finish(self.sid, callback)
+            self.assertEqual(exchange.call_args.args[2], platform_oauth_redirect_uri)
 
     def test_wrong_state_is_rejected_before_exchange(self):
         with patch.object(self.service, "_exchange_code") as exchange:
@@ -68,7 +82,7 @@
             exchange.assert_not_called()
 
     def test_missing_state_and_foreign_callback_are_rejected(self):
-        for value in [codex_oauth_redirect_uri + "?code=test-code", self.callback.replace("localhost:1455", "example.com")]:
+        for value in [LOCAL_CAPTURE_URI + "?code=test-code", self.callback.replace("localhost:1455", "example.com")]:
             with self.subTest(value=value), patch.object(self.service, "_exchange_code") as exchange:
                 with self.assertRaises(OAuthLoginError):
                     self.service.finish(self.sid, value)
@@ -103,19 +117,20 @@
                 self.assertEqual(first.result(timeout=5)["access_token"], TOKENS["access_token"])
             mocked.assert_called_once()
 
-    def test_exchange_posts_form_to_matching_token_endpoint(self):
+    def test_exchange_posts_original_platform_json_and_registered_redirect(self):
         response = Mock(status_code=200, text="json")
         response.json.return_value = TOKENS
         session = Mock()
         session.post.return_value = response
         with patch("services.oauth_login_service.requests.Session", return_value=session):
-            self.assertEqual(self.service._exchange_code("test-code", "test-verifier", codex_oauth_redirect_uri), TOKENS)
+            self.assertEqual(self.service._exchange_code("test-code", "test-verifier", platform_oauth_redirect_uri), TOKENS)
         args, kwargs = session.post.call_args
-        self.assertEqual(args, ("https://auth.openai.com/oauth/token",))
-        self.assertEqual(kwargs["data"]["client_id"], codex_oauth_client_id)
-        self.assertEqual(kwargs["data"]["redirect_uri"], self.query["redirect_uri"][0])
-        self.assertEqual(kwargs["data"]["code_verifier"], "test-verifier")
-        self.assertNotIn("json", kwargs)
+        self.assertEqual(args, ("https://auth.openai.com/api/accounts/oauth/token",))
+        self.assertEqual(kwargs["json"]["client_id"], platform_oauth_client_id)
+        self.assertEqual(kwargs["json"]["redirect_uri"], self.query["redirect_uri"][0])
+        self.assertEqual(kwargs["json"]["code_verifier"], "test-verifier")
+        self.assertNotIn("data", kwargs)
+        self.assertEqual(kwargs["headers"]["origin"], "https://platform.openai.com")
         session.close.assert_called_once()
 
     def test_exchange_error_does_not_echo_code_or_verifier(self):
@@ -125,7 +140,7 @@
         session.post.return_value = response
         with patch("services.oauth_login_service.requests.Session", return_value=session):
             with self.assertRaises(OAuthLoginError) as raised:
-                self.service._exchange_code("test-code", "test-verifier", codex_oauth_redirect_uri)
+                self.service._exchange_code("test-code", "test-verifier", platform_oauth_redirect_uri)
         self.assertNotIn("test-code", str(raised.exception))
         self.assertNotIn("test-verifier", str(raised.exception))
 
@@ -159,10 +174,11 @@
         app.include_router(create_router())
         client = TestClient(app)
         output = io.StringIO()
-        with patch("api.accounts.require_admin"), patch("api.accounts.oauth_login_service.finish", return_value={**TOKENS, "oauth_client_id": codex_oauth_client_id, "source_type": "codex"}), patch("api.accounts.account_service.add_account_items", return_value={"added": 1}) as add, patch("api.accounts.account_service.refresh_accounts", return_value={"refreshed": 1, "items": [], "errors": []}), redirect_stdout(output):
-            response = client.post("/api/accounts/oauth/finish", json={"session_id": "test-session", "callback": codex_oauth_redirect_uri + "?code=sensitive-test-code&state=test-state"})
+        with patch("api.accounts.require_admin"), patch("api.accounts.oauth_login_service.finish", return_value={**TOKENS, "oauth_client_id": platform_oauth_client_id, "source_type": "oauth_login"}), patch("api.accounts.account_service.add_account_items", return_value={"added": 1}) as add, patch("api.accounts.account_service.refresh_accounts", return_value={"refreshed": 1, "items": [], "errors": []}), redirect_stdout(output):
+            response = client.post("/api/accounts/oauth/finish", json={"session_id": "test-session", "callback": LOCAL_CAPTURE_URI + "?code=sensitive-test-code&state=test-state"})
         self.assertEqual(response.status_code, 200)
-        self.assertEqual(add.call_args.args[0][0]["oauth_client_id"], codex_oauth_client_id)
+        self.assertEqual(add.call_args.args[0][0]["oauth_client_id"], platform_oauth_client_id)
+        self.assertEqual(add.call_args.args[0][0]["source_type"], "oauth_login")
         self.assertNotIn("sensitive-test-code", output.getvalue())
 
 
CHATGPT2API_PATCH_V1
}
matches_v2() {
  sha256sum --check --status <<'CHATGPT2API_KNOWN_HASHES'
74da3f8d29f465e65a6b289a8ea37418391c40fc25fee69979d1e31725ae36dc  api/accounts.py
ed2062c730f1de5aad0ac3ff10b77b84b6e26cd15f3c209230b0aeee4458fba5  services/account_service.py
030e0f3afba9dcfd8c80711fb133d438b7f952efbf2c52b89d5d01caf3d18545  services/openai_oauth.py
7cff640d06e5da427ff3acff53df31058a1c52f733833990aefb4003392f908a  services/oauth_login_service.py
0b5af2a303ca9f1698e88efc19c9e422a0b9d23e57f234a81dd21d7fd67d3a29  web/src/app/accounts/components/account-import-dialog.tsx
4ad0d449c0b8f25608515b557e24f94dce28a86409e906a6032da36fcb0ef40f  test/test_oauth_loopback.py
CHATGPT2API_KNOWN_HASHES
}
patch_v2() {
  cat <<'CHATGPT2API_PATCH_V2'
diff --git a/services/openai_oauth.py b/services/openai_oauth.py
--- a/services/openai_oauth.py
+++ b/services/openai_oauth.py
@@ -1,5 +1,5 @@
 auth_base = "https://auth.openai.com"
-# Loopback OAuth profile, matching Sub2API's OpenAI login flow.
+# Retained only to refresh accounts previously imported by the V1/V2 patches.
 codex_oauth_client_id = "app_EMoamEEZ73f0CkXaXp7hrann"
 codex_oauth_redirect_uri = "http://localhost:1455/auth/callback"
 codex_oauth_authorize_url = f"{auth_base}/oauth/authorize"
diff --git a/services/oauth_login_service.py b/services/oauth_login_service.py
--- a/services/oauth_login_service.py
+++ b/services/oauth_login_service.py
@@ -1,37 +1,36 @@
-"""手动 OAuth 桥服务
-
-让用户用自己浏览器走一遍 OpenAI 的标准 OAuth + PKCE 授权码流程：
-  1. 后端生成 code_verifier / code_challenge / state，构造 authorize URL。
-  2. 用户在浏览器登录，浏览器最终跳到 localhost:1455/auth/callback；
-     本服务不监听该端口，用户复制完整回调 URL 并回填到前端。
-  3. 后端拿之前存好的 code_verifier + 回填的 code 调用 /oauth/token
-     得到 {access_token, refresh_token, id_token}。
-
-按 Sub2API 的 Codex OAuth profile 授权，持久保存 client_id，供自动刷新使用。
-授权码仍只能兑换一次；同一会话禁止并发兑换。
+"""保留原版 Platform OAuth；浏览器扩展在请求发出前把回调转到 localhost。
+
+本地 URL 只用于复制 code/state。授权与兑换始终使用原注册的 Platform
+redirect_uri；扩展不兑换 code，本服务不监听 localhost 回调端口。
 """
 from __future__ import annotations
 
-import base64
-import hashlib
 import secrets
 import threading
 import time
+import uuid
 from typing import Any
 from urllib.parse import parse_qs, urlencode, urlparse
 
 from curl_cffi import requests
 
 from services.openai_oauth import (
-    codex_oauth_authorize_url,
-    codex_oauth_client_id,
-    codex_oauth_redirect_uri,
-    codex_oauth_token_url,
+    auth_base,
+    common_headers,
+    platform_auth0_client,
+    platform_base,
+    platform_oauth_audience,
+    platform_oauth_client_id,
+    platform_oauth_redirect_uri,
+    sec_ch_ua,
     user_agent,
 )
 from services.proxy_service import proxy_settings
 
 
+LOCAL_CAPTURE_URI = "http://localhost:1455/auth/callback"
+
+
 class OAuthLoginError(Exception):
     """OAuth 桥流程中的可预期错误，会被 API 层翻译成 400。"""
 
@@ -39,7 +38,7 @@
 class OAuthLoginService:
     """维护 PKCE 临时会话，并完成 code → token 的兑换。"""
 
-    _SESSION_TTL_SECONDS = 30 * 60  # 与 Sub2API 的本地 OAuth 会话保留时间一致
+    _SESSION_TTL_SECONDS = 10 * 60  # 用户点开浏览器 + 拿 code 给的时间上限
     _MAX_SESSIONS = 64               # 防止异常累积；超过容量时清理最老的
 
     def __init__(self) -> None:
@@ -48,12 +47,9 @@
 
     @staticmethod
     def _generate_pkce() -> tuple[str, str]:
-        """与 Sub2API 一致：64 随机字节的十六进制 verifier，S256 challenge。"""
-        verifier = secrets.token_hex(64)
-        challenge = base64.urlsafe_b64encode(
-            hashlib.sha256(verifier.encode("ascii")).digest()
-        ).rstrip(b"=").decode("ascii")
-        return verifier, challenge
+        """生成 PKCE code_verifier 与对应的 code_challenge（S256）。"""
+        from utils.pkce import generate_pkce
+        return generate_pkce()
 
     def _purge_expired_locked(self) -> None:
         """清理过期或溢出容量的会话，必须在持锁状态下调用。"""
@@ -69,27 +65,37 @@
     def start(self, email_hint: str = "") -> dict[str, str]:
         """登记一个新的 PKCE 会话，返回 session_id 与可让用户打开的 authorize_url。
 
-        state 为独立的 32 字节随机数的十六进制字符串，与 Sub2API 一致。
-        完整 callback 可按 state 找回会话，不依赖 URL 内嵌 session_id。
-        email_hint 保留为 API 兼容入参，不加入授权链接。
+        state 形如 "chatgpt2api-<session_id>.<nonce>"，让扩展精确识别本项目，
+        finish 时即便前端 React 状态被覆盖也能从 URL 恢复正确的 verifier。
         """
         verifier, challenge = self._generate_pkce()
-        session_id = secrets.token_hex(16)
-        state = secrets.token_hex(32)
+        nonce = secrets.token_urlsafe(32)
+        device_id = str(uuid.uuid4())
+        session_id = uuid.uuid4().hex
+        state = f"chatgpt2api-{session_id}.{secrets.token_urlsafe(16)}"
 
         params = {
-            "client_id": codex_oauth_client_id,
-            "redirect_uri": codex_oauth_redirect_uri,
+            "issuer": auth_base,
+            "client_id": platform_oauth_client_id,
+            "audience": platform_oauth_audience,
+            "redirect_uri": platform_oauth_redirect_uri,
+            "device_id": device_id,
+            "screen_hint": "login_or_signup",
+            "max_age": "0",
             "scope": "openid profile email offline_access",
             "response_type": "code",
+            "response_mode": "query",
             "state": state,
+            "nonce": nonce,
             "code_challenge": challenge,
             "code_challenge_method": "S256",
-            "id_token_add_organizations": "true",
-            "codex_cli_simplified_flow": "true",
+            "auth0Client": platform_auth0_client,
         }
-        # Go url.Values.Encode sorts parameter names; match that serialization.
-        authorize_url = f"{codex_oauth_authorize_url}?{urlencode(sorted(params.items()))}"
+        email_hint = str(email_hint or "").strip()
+        if email_hint:
+            params["login_hint"] = email_hint
+
+        authorize_url = f"{auth_base}/api/accounts/authorize?{urlencode(params)}"
 
         with self._lock:
             self._purge_expired_locked()
@@ -97,8 +103,8 @@
                 "code_verifier": verifier,
                 "state": state,
                 "created_at": time.time(),
-                "redirect_uri": codex_oauth_redirect_uri,
-                "client_id": codex_oauth_client_id,
+                "redirect_uri": platform_oauth_redirect_uri,
+                "client_id": platform_oauth_client_id,
                 "in_progress": False,
             }
 
@@ -106,14 +112,14 @@
             "session_id": session_id,
             "authorize_url": authorize_url,
             "expires_in": str(self._SESSION_TTL_SECONDS),
-            "redirect_uri_prefix": codex_oauth_redirect_uri,
+            "redirect_uri_prefix": platform_oauth_redirect_uri,
         }
 
     @staticmethod
     def _extract_code_from_callback(value: str) -> tuple[str, str]:
         """从 callback URL 或 raw code 中提取 (code, state)。
 
-        既允许用户粘贴完整 localhost 回调 URL，
+        既允许浏览器扩展转到的 localhost URL，也允许原 Platform 回调，
         也允许只粘 code 本身。
         """
         raw = str(value or "").strip()
@@ -122,7 +128,7 @@
         if raw.startswith("http://") or raw.startswith("https://"):
             try:
                 url = urlparse(raw)
-                if f"{url.scheme}://{url.netloc}{url.path}" != codex_oauth_redirect_uri:
+                if f"{url.scheme}://{url.netloc}{url.path}" not in (LOCAL_CAPTURE_URI, platform_oauth_redirect_uri):
                     raise OAuthLoginError("请粘贴本次授权生成的 localhost:1455/auth/callback 完整 URL")
                 parsed = parse_qs(url.query)
             except OAuthLoginError:
@@ -143,7 +149,8 @@
     def finish(self, session_id: str, callback: str) -> dict[str, str]:
         """用 session_id 配对的 code_verifier 把 callback 里的 code 换成 token 三件套。
 
-        - 完整 callback 按 state 精确匹配会话；仅 code 的旧入参按 session_id 匹配。
+        - 优先用 callback URL 自带 state 里的 session_id（更可靠），
+          找不到才用前端传来的 session_id；
         - 同一会话同时只允许一个兑换请求；成功后删除会话。
         - 网络错误不能证明 code 未消耗，遇到此类错误应重新授权。
         """
@@ -152,23 +159,22 @@
         if not code:
             raise OAuthLoginError("缺少 code 或 callback URL")
 
-        if not state and not body_sid:
+        # state 里嵌的 session_id 优先级最高
+        state_sid = state.split(".", 1)[0].removeprefix("chatgpt2api-") if state else ""
+        candidate_sids = [sid for sid in (state_sid, body_sid) if sid]
+        if not candidate_sids:
             raise OAuthLoginError("既未提供 session_id，callback URL 中也未携带 state")
 
         with self._lock:
             self._purge_expired_locked()
             session = None
             picked_sid = ""
-            if state:
-                for sid, cur in self._sessions.items():
-                    if secrets.compare_digest(state.encode("utf-8"), cur["state"].encode("utf-8")):
-                        session, picked_sid = cur, sid
-                        break
-                if session is None and body_sid in self._sessions:
-                    raise OAuthLoginError("state 不匹配，请使用本次授权窗口生成的完整 callback URL")
-            else:
-                session = self._sessions.get(body_sid)
-                picked_sid = body_sid
+            for sid in candidate_sids:
+                cur = self._sessions.get(sid)
+                if cur is not None:
+                    session = cur
+                    picked_sid = sid
+                    break
             if session is None:
                 raise OAuthLoginError("OAuth 会话已过期、不存在或已完成，请重新生成授权")
             if state and not secrets.compare_digest(state.encode("utf-8"), session["state"].encode("utf-8")):
@@ -190,23 +196,26 @@
         # 仅在成功兑换之后才消耗 session
         with self._lock:
             self._sessions.pop(picked_sid, None)
-        return {**tokens, "oauth_client_id": session["client_id"], "source_type": "codex"}
+        return {**tokens, "oauth_client_id": session["client_id"], "source_type": "oauth_login"}
 
     @staticmethod
     def _exchange_code(code: str, code_verifier: str, redirect_uri: str) -> dict[str, str]:
-        """调用 Codex OAuth token endpoint；redirect_uri 与授权阶段保持一致。"""
+        """调用 /api/accounts/oauth/token 用 code+verifier 换 token 三件套。"""
         kwargs = proxy_settings.build_session_kwargs(impersonate="chrome", verify=True)
         session = requests.Session(**kwargs)
         try:
             response = session.post(
-                codex_oauth_token_url,
+                f"{auth_base}/api/accounts/oauth/token",
                 headers={
-                    "accept": "application/json",
-                    "content-type": "application/x-www-form-urlencoded",
+                    **common_headers,
+                    "referer": f"{platform_base}/",
+                    "origin": platform_base,
+                    "auth0-client": platform_auth0_client,
+                    "sec-ch-ua": sec_ch_ua,
                     "user-agent": user_agent,
                 },
-                data={
-                    "client_id": codex_oauth_client_id,
+                json={
+                    "client_id": platform_oauth_client_id,
                     "code_verifier": code_verifier,
                     "grant_type": "authorization_code",
                     "code": code,
diff --git a/web/src/app/accounts/components/account-import-dialog.tsx b/web/src/app/accounts/components/account-import-dialog.tsx
--- a/web/src/app/accounts/components/account-import-dialog.tsx
+++ b/web/src/app/accounts/components/account-import-dialog.tsx
@@ -190,6 +190,7 @@
   const [isSubmitting, setIsSubmitting] = useState(false);
   const [pendingAccountJsonImport, setPendingAccountJsonImport] = useState<PendingAccountJsonImport | null>(null);
   const [confirmOpen, setConfirmOpen] = useState(false);
+  const [oauthEmailHint, setOauthEmailHint] = useState("");
   const [oauthSession, setOauthSession] = useState<OAuthLoginStartResponse | null>(null);
   const [oauthCallbackInput, setOauthCallbackInput] = useState("");
   const [oauthStarting, setOauthStarting] = useState(false);
@@ -204,6 +205,7 @@
     setCodexAuthInput("");
     setPendingAccountJsonImport(null);
     setConfirmOpen(false);
+    setOauthEmailHint("");
     setOauthSession(null);
     setOauthCallbackInput("");
     setOauthStarting(false);
@@ -257,7 +259,7 @@
   const handleStartOAuth = async () => {
     setOauthStarting(true);
     try {
-      const data = await startOAuthLogin();
+      const data = await startOAuthLogin(oauthEmailHint.trim());
       setOauthSession(data);
       setOauthCallbackInput("");
       if (typeof window !== "undefined") {
@@ -554,10 +556,23 @@
           <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm leading-6 text-stone-600 space-y-2">
             <div className="font-medium text-stone-800">操作步骤</div>
             <ol className="list-decimal pl-5 space-y-1">
-              <li>点击下方"打开授权页面"，在 OpenAI 页面选择登录或注册，并完成页面要求的步骤。</li>
-              <li>授权完成后会跳到 <code className="rounded bg-stone-200 px-1">http://localhost:1455/auth/callback?code=...&amp;state=...</code>。本项目不监听 1455 端口，页面提示无法连接是正常的；从地址栏复制包含 code 和 state 的完整 URL。</li>
+              <li>先在当前浏览器的“ChatGPT2API 回调拦截”扩展中点击“启用拦截（10 分钟）”，确认显示“已启用”。</li>
+              <li>（可选）填写账号邮箱，登录页会预填。本次使用原版 Platform 授权流程。</li>
+              <li>启用扩展后，点击下方“打开授权页面”，在同一浏览器的新标签里完成登录或注册。</li>
+              <li>扩展会在 Platform 回调请求发出前将地址转到 <code className="rounded bg-stone-200 px-1">http://localhost:1455/auth/callback?code=...&amp;state=...</code>。本项目不监听 1455 端口，页面提示无法连接是正常的；从地址栏复制包含 code 和 state 的完整 URL。</li>
               <li>把 callback URL 粘到下面输入框，点"完成导入"。</li>
             </ol>
+          </div>
+          <div className="space-y-2">
+            <label className="text-sm font-medium text-stone-700">邮箱（可选预填）</label>
+            <input
+              type="email"
+              placeholder="you@example.com"
+              value={oauthEmailHint}
+              onChange={(event) => setOauthEmailHint(event.target.value)}
+              disabled={Boolean(oauthSession) || oauthStarting}
+              className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm outline-none focus:border-stone-400"
+            />
           </div>
           {!oauthSession ? (
             <Button
@@ -608,7 +623,7 @@
               <div className="space-y-2">
                 <label className="text-sm font-medium text-stone-700">粘贴完整 callback URL（包含 code 和 state）</label>
                 <Textarea
-                  placeholder={oauthSession.redirect_uri_prefix + "?code=...&state=..."}
+                  placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                   value={oauthCallbackInput}
                   onChange={(event) => setOauthCallbackInput(event.target.value)}
                   className="min-h-24 resize-none rounded-xl border-stone-200 font-mono text-xs"
@@ -619,8 +634,8 @@
           <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
             <div className="font-medium">注意</div>
             <div>
-              本地授权会话保留 30 分钟，取得授权码后请尽快回填；授权码仍只能兑换一次。授权期间确保本机 1455 端口没有其他 OAuth 回调服务监听。
-              如果提示 code 已使用或换 token 网络异常，请重新生成授权；其他工具生成的回调 URL 无法用于本次会话。
+              授权链接里仍是 platform.openai.com/auth/callback，这是原版注册的回调地址；由扩展在浏览器中拦截。授权码只能兑换一次，请在 10 分钟内回填并提交。授权期间确保本机 1455 端口没有其他 OAuth 回调服务监听。
+              如果最终仍进入 Platform 页面，说明扩展未生效，请启用后重新生成授权；不要把已经跳转的地址手动改成 localhost。如果提示 code 已使用或换 token 网络异常，请重新生成授权；其他工具生成的回调 URL 无法用于本次会话。
             </div>
           </div>
         </div>
diff --git a/test/test_oauth_loopback.py b/test/test_oauth_loopback.py
--- a/test/test_oauth_loopback.py
+++ b/test/test_oauth_loopback.py
@@ -21,8 +21,8 @@
 
 from api.accounts import create_router
 from services.account_service import AccountService
-from services.oauth_login_service import OAuthLoginError, OAuthLoginService
-from services.openai_oauth import codex_oauth_client_id, codex_oauth_redirect_uri
+from services.oauth_login_service import LOCAL_CAPTURE_URI, OAuthLoginError, OAuthLoginService
+from services.openai_oauth import codex_oauth_client_id, platform_oauth_client_id, platform_oauth_redirect_uri, platform_oauth_audience, platform_auth0_client
 from services.storage.json_storage import JSONStorageBackend
 
 
@@ -36,33 +36,43 @@
         self.sid = self.started["session_id"]
         self.query = parse_qs(urlparse(self.started["authorize_url"]).query)
         self.state = self.query["state"][0]
-        self.callback = codex_oauth_redirect_uri + "?" + urlencode({"code": "test-code", "state": self.state})
+        self.callback = LOCAL_CAPTURE_URI + "?" + urlencode({"code": "test-code", "state": self.state})
 
-    def test_authorization_uses_loopback_profile_and_matching_pkce(self):
-        self.assertEqual(urlparse(self.started["authorize_url"]).path, "/oauth/authorize")
-        self.assertEqual(self.query["client_id"], [codex_oauth_client_id])
-        self.assertEqual(self.query["redirect_uri"], [codex_oauth_redirect_uri])
+    def test_authorization_preserves_original_platform_profile_and_matching_pkce(self):
+        self.assertEqual(urlparse(self.started["authorize_url"]).path, "/api/accounts/authorize")
+        self.assertEqual(self.query["client_id"], [platform_oauth_client_id])
+        self.assertEqual(self.query["redirect_uri"], [platform_oauth_redirect_uri])
         self.assertEqual(self.query["scope"], ["openid profile email offline_access"])
         self.assertEqual(self.query["code_challenge_method"], ["S256"])
-        self.assertEqual(self.query["codex_cli_simplified_flow"], ["true"])
-        self.assertNotIn("audience", self.query)
-        self.assertNotIn("response_mode", self.query)
-        self.assertNotIn("login_hint", self.query)
-        self.assertRegex(self.state, r"^[0-9a-f]{64}$")
+        self.assertNotIn("codex_cli_simplified_flow", self.query)
+        self.assertNotIn("id_token_add_organizations", self.query)
+        self.assertEqual(self.query["audience"], [platform_oauth_audience])
+        self.assertEqual(self.query["issuer"], ["https://auth.openai.com"])
+        self.assertEqual(self.query["screen_hint"], ["login_or_signup"])
+        self.assertEqual(self.query["max_age"], ["0"])
+        self.assertEqual(self.query["auth0Client"], [platform_auth0_client])
+        self.assertEqual(self.query["login_hint"], ["test@example.com"])
+        self.assertTrue(self.query["nonce"][0])
+        self.assertTrue(self.query["device_id"][0])
         verifier = self.service._sessions[self.sid]["code_verifier"]
-        self.assertRegex(verifier, r"^[0-9a-f]{128}$")
         expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
         self.assertEqual(self.query["code_challenge"], [expected])
 
     def test_success_consumes_session_and_preserves_refresh_client(self):
         with patch.object(self.service, "_exchange_code", return_value=TOKENS) as exchange:
             result = self.service.finish("stale-body-session", self.callback)
-            self.assertEqual(result["oauth_client_id"], codex_oauth_client_id)
-            self.assertEqual(result["source_type"], "codex")
-            self.assertEqual(exchange.call_args.args[2], codex_oauth_redirect_uri)
+            self.assertEqual(result["oauth_client_id"], platform_oauth_client_id)
+            self.assertEqual(result["source_type"], "oauth_login")
+            self.assertEqual(exchange.call_args.args[2], platform_oauth_redirect_uri)
             with self.assertRaises(OAuthLoginError):
                 self.service.finish(self.sid, self.callback)
             exchange.assert_called_once()
+
+    def test_original_platform_callback_remains_accepted(self):
+        callback = self.callback.replace(LOCAL_CAPTURE_URI, platform_oauth_redirect_uri)
+        with patch.object(self.service, "_exchange_code", return_value=TOKENS) as exchange:
+            self.service.finish(self.sid, callback)
+            self.assertEqual(exchange.call_args.args[2], platform_oauth_redirect_uri)
 
     def test_wrong_state_is_rejected_before_exchange(self):
         with patch.object(self.service, "_exchange_code") as exchange:
@@ -72,53 +82,18 @@
             exchange.assert_not_called()
 
     def test_missing_state_and_foreign_callback_are_rejected(self):
-        for value in [codex_oauth_redirect_uri + "?code=test-code", self.callback.replace("localhost:1455", "example.com")]:
+        for value in [LOCAL_CAPTURE_URI + "?code=test-code", self.callback.replace("localhost:1455", "example.com")]:
             with self.subTest(value=value), patch.object(self.service, "_exchange_code") as exchange:
                 with self.assertRaises(OAuthLoginError):
                     self.service.finish(self.sid, value)
                 exchange.assert_not_called()
 
     def test_expired_session_is_rejected(self):
-        self.service._sessions[self.sid]["created_at"] = time.time() - 1801
+        self.service._sessions[self.sid]["created_at"] = time.time() - 601
         with patch.object(self.service, "_exchange_code") as exchange:
             with self.assertRaises(OAuthLoginError):
                 self.service.finish(self.sid, self.callback)
             exchange.assert_not_called()
-
-    def test_authorization_parameter_set_matches_sub2api(self):
-        expected = {
-            "client_id": [codex_oauth_client_id],
-            "code_challenge": self.query["code_challenge"],
-            "code_challenge_method": ["S256"],
-            "codex_cli_simplified_flow": ["true"],
-            "id_token_add_organizations": ["true"],
-            "redirect_uri": [codex_oauth_redirect_uri],
-            "response_type": ["code"],
-            "scope": ["openid profile email offline_access"],
-            "state": [self.state],
-        }
-        self.assertEqual(self.query, expected)
-        self.assertEqual(urlparse(self.started["authorize_url"]).query,
-                         urlencode({key: values[0] for key, values in sorted(expected.items())}))
-
-    def test_callback_state_selects_its_own_verifier_among_multiple_sessions(self):
-        other = self.service.start()
-        expected_verifier = self.service._sessions[self.sid]["code_verifier"]
-        with patch.object(self.service, "_exchange_code", return_value=TOKENS) as exchange:
-            self.service.finish(other["session_id"], self.callback)
-            self.assertEqual(exchange.call_args.args[1], expected_verifier)
-            self.assertIn(other["session_id"], self.service._sessions)
-            self.assertNotIn(self.sid, self.service._sessions)
-
-    def test_existing_raw_code_input_still_uses_session_id(self):
-        with patch.object(self.service, "_exchange_code", return_value=TOKENS) as exchange:
-            self.service.finish(self.sid, "test-code")
-            self.assertEqual(exchange.call_args.args[0], "test-code")
-
-    def test_thirty_minute_session_is_not_expired_after_ten_minutes(self):
-        self.service._sessions[self.sid]["created_at"] = time.time() - 601
-        with patch.object(self.service, "_exchange_code", return_value=TOKENS):
-            self.assertEqual(self.service.finish(self.sid, self.callback)["access_token"], TOKENS["access_token"])
 
     def test_simultaneous_submissions_only_exchange_once(self):
         entered = threading.Event()
@@ -142,19 +117,20 @@
                 self.assertEqual(first.result(timeout=5)["access_token"], TOKENS["access_token"])
             mocked.assert_called_once()
 
-    def test_exchange_posts_form_to_matching_token_endpoint(self):
+    def test_exchange_posts_original_platform_json_and_registered_redirect(self):
         response = Mock(status_code=200, text="json")
         response.json.return_value = TOKENS
         session = Mock()
         session.post.return_value = response
         with patch("services.oauth_login_service.requests.Session", return_value=session):
-            self.assertEqual(self.service._exchange_code("test-code", "test-verifier", codex_oauth_redirect_uri), TOKENS)
+            self.assertEqual(self.service._exchange_code("test-code", "test-verifier", platform_oauth_redirect_uri), TOKENS)
         args, kwargs = session.post.call_args
-        self.assertEqual(args, ("https://auth.openai.com/oauth/token",))
-        self.assertEqual(kwargs["data"]["client_id"], codex_oauth_client_id)
-        self.assertEqual(kwargs["data"]["redirect_uri"], self.query["redirect_uri"][0])
-        self.assertEqual(kwargs["data"]["code_verifier"], "test-verifier")
-        self.assertNotIn("json", kwargs)
+        self.assertEqual(args, ("https://auth.openai.com/api/accounts/oauth/token",))
+        self.assertEqual(kwargs["json"]["client_id"], platform_oauth_client_id)
+        self.assertEqual(kwargs["json"]["redirect_uri"], self.query["redirect_uri"][0])
+        self.assertEqual(kwargs["json"]["code_verifier"], "test-verifier")
+        self.assertNotIn("data", kwargs)
+        self.assertEqual(kwargs["headers"]["origin"], "https://platform.openai.com")
         session.close.assert_called_once()
 
     def test_exchange_error_does_not_echo_code_or_verifier(self):
@@ -164,7 +140,7 @@
         session.post.return_value = response
         with patch("services.oauth_login_service.requests.Session", return_value=session):
             with self.assertRaises(OAuthLoginError) as raised:
-                self.service._exchange_code("test-code", "test-verifier", codex_oauth_redirect_uri)
+                self.service._exchange_code("test-code", "test-verifier", platform_oauth_redirect_uri)
         self.assertNotIn("test-code", str(raised.exception))
         self.assertNotIn("test-verifier", str(raised.exception))
 
@@ -198,10 +174,11 @@
         app.include_router(create_router())
         client = TestClient(app)
         output = io.StringIO()
-        with patch("api.accounts.require_admin"), patch("api.accounts.oauth_login_service.finish", return_value={**TOKENS, "oauth_client_id": codex_oauth_client_id, "source_type": "codex"}), patch("api.accounts.account_service.add_account_items", return_value={"added": 1}) as add, patch("api.accounts.account_service.refresh_accounts", return_value={"refreshed": 1, "items": [], "errors": []}), redirect_stdout(output):
-            response = client.post("/api/accounts/oauth/finish", json={"session_id": "test-session", "callback": codex_oauth_redirect_uri + "?code=sensitive-test-code&state=test-state"})
+        with patch("api.accounts.require_admin"), patch("api.accounts.oauth_login_service.finish", return_value={**TOKENS, "oauth_client_id": platform_oauth_client_id, "source_type": "oauth_login"}), patch("api.accounts.account_service.add_account_items", return_value={"added": 1}) as add, patch("api.accounts.account_service.refresh_accounts", return_value={"refreshed": 1, "items": [], "errors": []}), redirect_stdout(output):
+            response = client.post("/api/accounts/oauth/finish", json={"session_id": "test-session", "callback": LOCAL_CAPTURE_URI + "?code=sensitive-test-code&state=test-state"})
         self.assertEqual(response.status_code, 200)
-        self.assertEqual(add.call_args.args[0][0]["oauth_client_id"], codex_oauth_client_id)
+        self.assertEqual(add.call_args.args[0][0]["oauth_client_id"], platform_oauth_client_id)
+        self.assertEqual(add.call_args.args[0][0]["source_type"], "oauth_login")
         self.assertNotIn("sensitive-test-code", output.getvalue())
 
 
CHATGPT2API_PATCH_V2
}
if matches_target 2>/dev/null; then
  ensure_override
  echo "新版 Platform 回调拦截补丁已经应用，无需重复操作。"
  echo "若尚未更新容器，请按 README 构建镜像，再重建 app。"
  exit 0
fi
version=""
for candidate in original v1 v2; do
  if "matches_$candidate" 2>/dev/null; then version="$candidate"; break; fi
done
if [[ -z "$version" ]]; then
  echo "当前源码不匹配已验证的原版 v1.8.0 / V1 / V2，未修改项目文件。"
  echo "请确认脚本位于 ~/chatgpt2api 根目录。若有自行修改，请保留代码并提供报错以便适配。"
  exit 1
fi
patch_file=$(mktemp)
trap 'rm -f -- "$patch_file"' EXIT
"patch_$version" > "$patch_file"
git -c core.autocrlf=false apply --check --whitespace=nowarn "$patch_file"
backup_dir=".oauth-platform-capture-backup-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -- "$backup_dir"
backup_files=(api/accounts.py services/account_service.py services/openai_oauth.py services/oauth_login_service.py web/src/app/accounts/components/account-import-dialog.tsx)
if [[ -f test/test_oauth_loopback.py ]]; then backup_files+=(test/test_oauth_loopback.py); fi
tar -czf "$backup_dir/source-before.tar.gz" -- "${backup_files[@]}"
git -c core.autocrlf=false apply --whitespace=nowarn "$patch_file"
matches_target
ensure_override
echo "已从 $version 升级：恢复原版 Platform OAuth，支持浏览器扩展转到 localhost 的完整回调。"
echo "源代码备份：$backup_dir/source-before.tar.gz"
echo "config.json 和 data 未修改。当前容器尚未变更。"
echo "请按 docs/WSL-SETUP.md 重建镜像/容器；自动化浏览器不需要额外扩展。"
