# ChatGPT 网页桥接｜Windows 私人极简版

源项目：<https://github.com/Draivix/chatgpt-gateway> · MIT License。保留上游 Git 历史和 LICENSE。

**定位：** 山海墨迹、Cherry Studio、酒馆等 OpenAI 兼容客户端，通过本机 HTTP 接口，把问题送到**正常登录的 ChatGPT 网页聊天**，再获取回答。不是 OpenAI API、Codex 或另外的模型调用通道。

## 已部署的后台服务

- 本机地址：`http://127.0.0.1:18080/v1`
- API Key：本地客户端要求非空时可填 `local`；接口不向公网开放
- 模型名：`auto`（沿用 ChatGPT 网页当前可用的模型，不额外调用模型服务）
- 健康检查：`http://127.0.0.1:18080/health`
- Windows 当前用户登录后自动启动 Node，**无 PowerShell 窗口**；一键启动文件为 `start-hidden.vbs`

## 第一次安装 Chrome 扩展（需要一次浏览器确认）

1. 正常打开你常用的 Chrome，确保已在 <https://chatgpt.com> 登录。
2. 进入 `chrome://extensions`，启用「开发者模式」，点击「加载已解压的扩展程序」。
3. 选择本项目内的 **`dist\chrome-extension`** 文件夹（不是旧 CommandTower 的插件）。
4. 打开 `http://127.0.0.1:18080/health`，确认 `extensionConnected:true` 后再连接应用。

扩展将为请求创建一个**非当前焦点的临时 ChatGPT 标签页**，避免改动你正在聊天的标签页；完成后清理临时标签页。Chrome 必须处于运行状态，扩展才能接收任务。浏览器首次安装确认不能由服务端替代。

## 三个应用通用填写

| 字段 | 设置 |
| --- | --- |
| 接口类型 | OpenAI 兼容 |
| Base URL | `http://127.0.0.1:18080/v1` |
| Key | `local` |
| 模型 | `auto` |

## 行为

- 不裁剪输入消息/历史记录，不自设请求长度或模型处理截止时间；网站自身的上下文/使用限制仍然存在。
- `stream:true` 时，浏览器页面变化通过 SSE 实际增量返回，而非先缓存全文再假装流式。
- 只在当前响应出现完成证据后返回正常结束；断线、浏览器拒绝、输出前后不一致时返回错误，**不把半截文本报告为完成**。
- 同一时刻仅向网页发送一项任务，其他请求在内存排队，避免不同客户端同时操作同一个页面。
- 本程序无后台模型调用。网站页面变化、扩展休眠或账户未登录可能中断请求；这时需要诊断，不应重复发送已经可能产生副作用的任务。

## 开发与维护

```powershell
npm ci
npm test
npm run build:chrome
.\install-autostart.ps1
```

Fork `master` 保留上游版本，`work/lean-extension-autostart` 是私人精简改造分支。

**验收边界：** Node 网关本地 HTTP/WebSocket 与模拟内容脚本测试不能代替三种桌面应用到真实 ChatGPT 网页的往返。只有浏览器扩展已实际安装并且完成应用端真实收发，才算上线验收。
