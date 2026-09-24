# 顺风 · 独立测速页面

面向手机的静态页面：按需启动私有 GitHub Actions 测速、显示运行进度、查看真实结果、复制分享链接或下载 Clash / Mihomo 配置。

页面地址：https://lb623912981-cyber.github.io/proxy-scout-web/

## 首次连接

1. 打开页面，点“连接我的测速空间”。
2. 按指引创建 GitHub fine-grained personal access token。只授权自己的私有测速仓库，权限为 **Actions: Read and write** 和 **Contents: Read-only**。
3. 在页面输入令牌。默认只保存在当前会话；可以主动选择“在这台手机记住连接”。令牌到期后需重新创建并连接。
4. 点击“立即测速”。完整运行通常需要几分钟，平台排队可能增加时间。

测速从云端发起，结果不能代表手机当前网络的实际速度。页面不会在后台定时发起新测速，仅在打开时刷新已有结果及运行状态。

## 数据与部署

- 此公开仓库只包含静态界面，不包含访问令牌、订阅链接或节点配置。
- 使用用户自己的私有后端仓库 `.github/workflows/cloud-check.yml` 和 `LATEST.json`。
- 所有带认证的请求仅发往 `https://api.github.com`。结果保存在内存中，不写入浏览器持久存储，不使用第三方分析或字体服务。
- 页面没有服务端代理；使用者的网络需要能够访问 GitHub API。
- “断开连接”会清除页面保存的令牌。若要撤销令牌本身，在 GitHub 设置中删除它。
- GitHub Pages 从 `main` 分支根目录发布，无需构建。图标、样式和脚本均为本地静态资源。

## 后端结果格式

`LATEST.json` 包含 `version: 1`、`report`、`shares`、`clash_config`、`clash_recommended` 和按节点 ID 索引的 `node_configs`。节点 ID 用于匹配链接和配置，避免同名节点混淆。

任务通过 `workflow_dispatch` 启动，传入 `download: true`。页面读取 Actions 实际状态与任务步骤，不生成模拟测速数据。
