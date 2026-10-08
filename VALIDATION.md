# 0.2.0 验证记录

验证日期：2026-10-08。状态：`0.2.0` 已完成独立草稿卡片、发送适配与本地回归，尚待用户在真实 Desktop 安装新版验收。用户提供的 `0.1.0` 实测已证明 macOS 快照采集、会话发送与文本读取基础链路成立。Windows 仍待实机验收。

| 项目 | 已取得证据 |
| --- | --- |
| Host / Client 构建 | Node 24.16.0 + esbuild，ESM Host / 官方 ModuleLoader Client |
| JavaScript 回归 | 35/35 通过，0 skipped；含会话归属、乱序与释放租约、重复投递、隐藏上下文、草稿恢复、进程故障、EPIPE、消息大小边界 |
| 官方 npm 输入框与发送链路 | 合同与故障回归 21/21；直接运行 `@deepseek-ai/dsh-client-ui-conversation@0.2.0-rc.2` 发布实现中的 Lexical、SessionInputShell、ConversationController，真实 FileReader 编码 PNG（测试仅补 Node 平台 FileReader 实现）；验证正文不插块、引用 chip 序列化、仅附件 Enter、queue / steer、失败 / 重试 / 新输入保留、成功 admission 清理、删除、会话迁移、误会话拒绝、指令保护、scope / signal 和插件卸载（含等待指令判定时的忙态清理） |
| 独立卡片界面 | IAB 中用合成图片实际检查深 / 浅色、两张卡、原图预览、文字默认折叠 / 展开、Escape / 遮罩关闭、焦点恢复 / Tab 循环、单卡删除、普通文件重试、模拟提交时禁止删除；控制台无 error / warn。这是独立预览，未替代真实 Harness 验收 |
| macOS helper | Swift 6.3.2 / Swift 6 模式，macOS 13 deployment target；arm64 与 x86_64 双架构编译、当前 arm64 自测、plist / shell 检查通过 |
| Windows helper | .NET SDK 8.0.425 在 macOS 跨编译：0 warnings / 0 errors；同源纯 C# 策略自检 20/20；win-x64 与 win-arm64 自包含发布成功 |
| 打包与 bundle | 分别生成 macOS / Windows x64 / Windows ARM64 npm tarball；实际构建的 Client ModuleLoader 在真实 Cordis tracking 下注册两个插槽并正确委托普通附件 renderer；Host Fetch 路由合同通过，安装包内容清单核对通过 |

合同来源：[官方仓库](https://github.com/deepseek-ai/deepseek-harness)，源码 HEAD `5badb15009ae1756c3afe0ae0cef1faafc290ccc`（`0.2.1-alpha.1`），以及 npm 固定 `0.2.0-rc.2` 发布包。

公开发布准备：锁文件中 33 个私有镜像地址已与公开 npm 的对应版本、integrity 核对并替换，依赖版本未升级；干净源码目录 `npm ci`、构建和 35 项回归通过。Git 仓库不含依赖、fixture 或原生编译产物，打包默认输出 `artifacts/`。Windows 发布收集本次 MSBuild 实际解析的 Runtime / Windows Desktop 许可证与对应版本 WPF 声明，缺失声明会阻止打包。GitHub 分支检查与 tag Release 工作流已配置；其是否实际通过以 GitHub Actions 记录为准。

主要接入点为 `connection.fetch.register`、`conversation.input.left / conversation.input.attachments` slot、公开 props `sessionId / inputActions`、`conversation.createDrafts / releaseDraftAttachment`、`InputActions.addAttachments`。发送适配通过 Cordis `reflect.accessor` 包装已发布的 `ConversationController.sendSession / serializeDraftAttachments / rebindDraftFiles / releaseDraftAttachment` 方法，保留原始 receiver、mode 和 signal；不再调用 `insertText / persistDraft`。Host 路由继承 Harness 的认证和 Origin / Host 校验，不开独立无认证截图端口。

开发阶段未修改用户真实 `.dsh` profile，也未安装插件或截取真实窗口；自动测试图像为合成 1×1 PNG。随后用户自行安装并完成了下述真实 Desktop 测试。插件创建工作不涉及业务代码贡献上报。

## 用户提供的 0.1.0 macOS 实测结果

证据：2026-10-08 用户提供的 DeepSeek Harness Appshot 与截图，会话名为「快照插件测试会话就绪」。这是旧版 `0.1.0` 的用户实测证据，未由开发代理重新操作验证；不能直接替代 `0.2.0` 草稿卡片的实机验收。

| 验收项 | 结果与证据 |
| --- | --- |
| 插件 Client 加载 | 输入框显示「▣ 快照」按钮，帮助文字为左右 Command 添加前台窗口到草稿 |
| 真实窗口采集与发送 | 已发送消息包含 `window-snapshot-2026-10-08T07-47-38Z.png` 图片附件与 `<window_snapshot>` 文本块 |
| 窗口元数据 | 消息包含 Google Chrome、对应窗口标题与采集时间 |
| 可访问文本 | 消息包含地址栏 URL、浏览器控件和页面文本；模型回复能引用具体页面信息 |
| 模型接收与文本读取 | 发送后收到模型回复，窗口与页面内容可供模型使用 |

该证据确认图片附件已进入会话，但模型回复可能依据可访问文本生成，尚不能证明模型实际使用了图片进行视觉判断。截图也未展示首次权限弹窗、按键过程或发送前草稿状态，不能据此确认这些交互细节。此处仅记录成功的浏览器窗口样例，不扩展为所有应用均通过。

仍需实机完成：

- macOS：首次授权流程、左右 Command 的触发 / 松开 / 再次触发及去重；更多浏览器与原生应用；Intel / macOS13 运行。
- Windows：x64 / ARM64 真机启动、左右 Ctrl、浏览器和其它窗口、UI Automation、多屏 DPI、受保护或不响应窗口错误。
- Desktop：安装 / 升级过程、发送前草稿插入、缩略图预览 / 删除、会话切换 / 多窗口、连续多张快照、重启后的历史图片读取；仅图像可辨内容的模型视觉读取。
- macOS Developer ID 签名、公证与 Windows 签名未做。

编译、合同测试和策略自测不能代替产品验收；上述用户实测只覆盖记录中的成功路径。`0.2.0` 不再把快照上下文插入输入框，移除卡片会同时移除图片和对应上下文；发送失败时保留上下文，等待官方恢复图片，重试不重复附带。发送成功的图片仍由 Harness admission 与会话存储负责。

未对齐 Codex 的部分仍包括：已发送消息的快照文字折叠、快照删除撤销、OCR、自动创建 / 选择会话、自动切回 Harness、结构化 AX 树、独立 URL / 选中文字字段、未发送草稿重启恢复。Host PNG 校验是头部 / 尺寸 / 大小检查，完整图片 admission 仍由 Harness 正常发送链路负责。原生采集流程沿用旧版设计；公开安装包由平台 runner 从源码重新构建，构建脚本另包含 PowerShell 兼容与第三方许可证收集。
