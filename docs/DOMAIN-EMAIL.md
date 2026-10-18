# 域名邮箱转发到 Gmail

收信链路为：`你拥有的域名邮箱 → 邮件转发 → 一个专用 Gmail → 本地只读 Gmail API`。生成邮箱列表只写入本地文件；能否收信取决于域名邮件配置。

## 1. 准备域名

可以在 [Spaceship](https://www.spaceship.com/) 搜索并购买域名；购买前检查注册价、续费价和域名拼写。已有其他注册商域名也能使用本程序，无须迁移。域名和邮件产品的费用以供应商页面为准，本项目不提供邮箱托管服务，也没有购买返佣链接。

## 2. 配置统一转发

在 Spaceship 的 **Domain Manager** 中选择域名，找到 **Email Forwarding**，使用 **To a single address** 将收件目标设置为你用于接码的 Gmail，再保存规则。菜单名称和适用条件以 [Spaceship 官方转发教程](https://www.spaceship.com/knowledgebase/domain-email-forwarding/) 为准。

自动生成的地址是随机前缀，所以需要确认规则确实接收未逐个创建的地址。如果使用的是 Spacemail 邮箱产品，可以配置其 [catch-all 收件箱](https://www.spaceship.com/en-GB/knowledgebase/setup-catch-all-mailbox-spacemail/)，再按该产品的转发设置投递到 Gmail。Spacemail 与域名转发是不同产品，不要仅因本教程就重复购买。

使用自定义 DNS 或已有邮件服务时，按所选服务商提供的 MX / 验证记录配置。不要同时保留两套相互冲突的收信 MX；本教程不提供通用 MX 值。

## 3. 先验证收信

1. 用另一个邮箱分别向两个不同的域名地址发测试邮件，其中至少一个地址没有单独创建过。
2. 在目标 Gmail 确认两封都收到，检查垃圾邮件和转发确认状态。
3. 在 Gmail 邮件菜单选择“显示原始邮件”，确认 `To`、`X-Original-To`、`X-Forwarded-To` 等字段中仍能找到原来的域名邮箱。
4. 若只剩最终 Gmail 地址，先调整转发方式；本程序不能仅凭“最新一封邮件”可靠判断验证码属于哪个账号。

本程序按发件域名筛选 OpenAI 验证码，普通测试邮件不会被当作验证码使用。菜单 1 只验证 Gmail 授权和连接，不会证明域名转发已经配置成功。

## 4. 连接本地程序

完成 [Gmail API 授权教程](../GMAIL-SETUP.md)，授权收取所有转发邮件的那个 Gmail。然后在菜单 6 输入邮箱数量和自己的域名。先生成一个地址，用菜单 2 预览，再运行菜单 3。

菜单 6 不会注册域名、创建真实邮箱或向邮箱发送邮件。保留 `accounts-completed.txt` 和 `.local` 中的历史记录，后续生成才会继续避开已经使用过的地址。
