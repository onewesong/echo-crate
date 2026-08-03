# Contributing to EchoCrate

欢迎提交 bug 修复、Provider、文档和可访问性改进。

- 先运行 `npm run typecheck` 与 `npm test`。
- 新 Provider 必须实现来源识别、导入、流解析与错误处理；登录能力必须由后端托管，绝不把来源 Cookie 返回给浏览器。
- 不接受绕过付费、访问控制、DRM 或导出受限音频的功能。
- 请为 Provider URL 识别、来源映射与异常路径补充测试。

Provider 通过 `server/providers.ts` 注册。接口保持窄：输入 URL、标准化来源引用、按需解析可播放流、可选歌词和可选登录流程。
