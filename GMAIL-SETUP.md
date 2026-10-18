# 首次配置：让 Windows 程序只读 Gmail

要授权的是接收所有转发验证码的那个 Gmail；待注册账号仍填写你自己的域名邮箱。

如果先试手动接码，可直接在启动菜单选 4，本教程可以稍后再配。自动模式中 Gmail 连接或取码失败会直接跳过，不再弹窗。首次授权请先在菜单 1 完成；菜单 3 不会主动打开首次授权页面。

本程序使用 Google 的 Gmail API 只读授权。你在 Google 网页中登录并授权，程序不会要求你在聊天里发送 Gmail 密码或应用专用密码。配置依据：[Google 官方桌面应用快速入门](https://developers.google.com/workspace/gmail/api/quickstart/python)、[OAuth 授权设置](https://developers.google.com/workspace/guides/configure-oauth-consent)。

标准 Gmail API 使用按官方配额提供，正常额度内无额外费用；配额和未来计费安排以 [Google 官方说明](https://developers.google.com/workspace/gmail/api/reference/quota) 为准。本程序不需要开通虚拟机、Gemini API 或 Cloud 试用赠金。

域名邮箱转发尚未配置时，先完成 [Spaceship / 域名邮箱教程](docs/DOMAIN-EMAIL.md)。

## 1. 创建 Google Cloud 项目并启用 Gmail API

1. 用接收转发邮件的 Google 账号打开 [Google Cloud 控制台](https://console.cloud.google.com/)。
2. 点击顶部项目选择器，新建一个项目，例如 `My Gmail OTP Reader`。
3. 在该项目中打开“API 和服务” → “库”，搜索 `Gmail API` 并点击“启用”。

## 2. 配置授权页面

进入“Google Auth platform / Google 身份验证平台”。如果没有完成初始化，点击“开始使用 / Get started”。

1. 应用名称填写你自己能识别的名称，例如 `My Gmail OTP Reader`；支持邮箱和联系邮箱填写你自己的 Gmail。
2. 个人 Gmail 选择“外部 / External”。“内部 / Internal”只适合受支持的组织账号，个人 Gmail 不选它。
3. 在“目标对象 / Audience”中保留“测试 / Testing”，在“测试用户 / Test users”添加接收验证码的 Gmail 地址。
4. 在“数据访问 / Data Access”中添加权限：

   ```text
   https://www.googleapis.com/auth/gmail.readonly
   ```

这个权限允许读取 Gmail 邮件。程序只筛选 OpenAI 发来的验证码邮件，并不发送邮件、删除邮件或标记已读；Google 授权本身是邮箱级只读权限，不是仅授权某个标签。

## 3. 创建桌面应用凭据

1. 打开“客户端 / Clients”，点击“创建客户端 / Create client”。
2. 应用类型选择 **“桌面应用 / Desktop app”**。
3. 创建后下载 JSON 文件，重命名为 **`credentials.json`**。
4. 将它放进解压后的自动化程序目录，与 `runner.mjs`、`start.cmd` 同级。

这里是 Google 客户端配置，不是你之前导入的 ChatGPT Session JSON，也不是 chatgpt2api 的 `config.json`。

## 4. 在本机完成授权

1. 确认本机代理已启动。程序目录的 `config.json` 默认使用 `http://127.0.0.1:7890`；如需其他端口，在这里修改。
2. 双击 `start.cmd`，选择 **1**。
3. 程序会打开系统默认浏览器的 Google 授权页面。
4. 选择接收所有转发验证码的 Gmail，核对应用名称是你刚创建的项目，按 Google 页面提示同意只读授权。
5. 回到程序窗口，应显示：

   ```text
   Gmail 只读连接成功：你的邮箱@gmail.com
   ```

授权凭据保存在本机 `.local/gmail-token.json`。不需要将这个文件、`credentials.json` 或邮箱密码发到聊天里。

如果提示 `access_denied` / 未添加测试用户，返回 Audience 检查是否添加了本次登录的 Gmail。若提示客户端类型不正确，重新创建“桌面应用”客户端。

如果出现“此应用未经 Google 验证”，这是与直接拒绝访问不同的页面。确认是自己创建的客户端并已加入测试用户后，按页面提示点击“继续”完成自己的测试授权；不要对不认识的第三方客户端授权。参考 [Google 测试用户说明](https://support.google.com/cloud/answer/15549945)。

Google 外部测试应用的刷新凭据通常在 7 天后过期；到期后，先关闭程序，删除本机 `.local/gmail-token.json`，再次选择 1 授权。见 [Google 官方凭据过期说明](https://developers.google.com/identity/protocols/oauth2#expiration)。这与 chatgpt2api 的管理员密钥无关。

## 5. 检查转发是否保留原收件地址

集中收码时，一次只处理一个账号能减少混淆，但前一个账号延迟到达的验证码仍有可能混进来。程序会同时核对：

- 任务启动前已有的 Gmail 邮件 ID：全部排除。
- Gmail 接收时间及邮件日期：排除旧邮件和明显延迟的旧转发。
- 发件地址域名：默认只接受 `openai.com` 及其子域。
- 原收件地址：必须对应当前处理的域名邮箱。
- 验证码数量：同一阶段出现多封候选邮件或多个不同验证码时，不猜测。

支持从 `To`、`Cc`、`X-Original-To`、`X-Forwarded-To`、`X-Envelope-To` 等邮件头识别原收件人。转发如果把原收件人完全抹掉，只剩最终 Gmail 地址，程序不会使用这封邮件的验证码，达到等待超时后跳过；需要根据你的实际转发格式适配。可以在 Gmail 打开一封验证码邮件，选择“显示原始邮件”检查收件相关邮件头，分享用于适配的样本前遮住验证码、完整邮件正文和身份验证信息。
