# ChatGPT 网页桥接（Tampermonkey 极简版）

Fork 来源：Draivix/chatgpt-gateway · MIT，保留原始 Git 历史和 LICENSE。私人用途：山海墨迹、Cherry Studio 和酒馆经本机接口使用 **ChatGPT 普通网页聊天**，不使用 OpenAI API 或 Codex，也不转到其他付费模型请求渠道。

## 使用

**本机服务已配置 Windows 登录静默自启**；不用打开 PowerShell。也可以双击 `start-hidden.vbs`。重复启动会复用已有服务。

你的 Chrome 已安装 Tampermonkey（油猴）。**首次只需要在浏览器做两个动作**：

1. 打开 [一键安装油猴脚本](http://127.0.0.1:18080/chatgpt-gateway.user.js)，在 Tampermonkey 弹出的安装页点击“安装”。脚本元数据和文件由本机服务提供；如果浏览器不识别这个地址，也可通过 [GitHub 原始脚本](https://raw.githubusercontent.com/lili13500/chatgpt-gateway/main/chatgpt-gateway.user.js) 安装。
2. 打开 [专用 ChatGPT 标签页](https://chatgpt.com/?web_gateway=1)，确认已正常登录，然后**保留此标签页**（可以切换到别的标签页，不需要盯着它）。脚本只会激活这一标签页，不会控制你的其他 ChatGPT 聊天。

随后打开 [本机健康检查](http://127.0.0.1:18080/health)，应看到 `userscriptConnected: true`。看到 `false` 表示网页还没接上，不能宣称可用。Chrome 整个关闭后，油猴也无法运行；再次打开专用标签页即可恢复。

你的应用填写：

| 项目 | 值 |
|---|---|
| API 类型 | OpenAI 兼容 |
| Base URL | `http://127.0.0.1:18080/v1` |
| API Key | `local`（客户端必须填写时） |
| 模型 | `auto` |

## 设计约束

- 一个 Node 本地服务（内建 HTTP/WebSocket）和一个油猴脚本；**无额外 Chrome 扩展、专用调试浏览器、CommandTower 工具接单层或模型 API**。
- Windows 登录后后台运行，无常驻黑窗口，127.0.0.1 监听。
- 独立的专用标签页才接收请求，防止占用正在正常使用的 ChatGPT 聊天。
- 没有自建输入字节、对话轮次或生成时间限制。网站和模型本身的上下文限制仍存在。
- SSE 传输真实增量；文本回写、网页失联和其他实际错误不伪装成回答结束。
- 串行向网页发送任务，不对请求作危险重放。
- 页面变化、登录失效、浏览器休眠、浏览器网站使用条款限制，仍是网页自动化的固有风险。**不能保证持续不断线**。

## 测试边界

`npm test` 验证本地传输、原文完整性、脚本 DOM 模拟、故障处理；**只有从山海墨迹真实发送并在应用显示完整回传才是最终 E2E**。首次安装油猴脚本需 Chrome/Tampermonkey 本身确认；不通过修改 Chrome 安全配置或静默注入绕过。

## 开发

`npm ci` · `npm test` · `node server.mjs`

原 Fork 在 `https://github.com/lili13500/chatgpt-gateway`。旧 Chrome 专用扩展源码已从当前分支去除，仍在 Git 历史中可回滚。
