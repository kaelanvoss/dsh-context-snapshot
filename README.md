# DeepSeek Harness 窗口快照插件

面向官方 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的独立插件，版本 `0.2.0`。在其它应用中同时按下左右修饰键，将前台窗口加入 Harness 当前会话的草稿。草稿只显示独立快照卡片，输入框保留用户自己的文字；发送时同时携带 PNG、窗口元数据和可访问文字。

| 系统 | 快捷键 | 原生程序 |
| --- | --- | --- |
| macOS 13+，Apple Silicon / Intel | 左 Command + 右 Command | universal Swift `.app` |
| Windows 10/11 x64 | 左 Ctrl + 右 Ctrl | 自包含 .NET 8 x64 `.exe` |
| Windows 10/11 ARM64 | 左 Ctrl + 右 Ctrl | 自包含 .NET 8 ARM64 `.exe` |

两键需同时处于按下状态；按住不会重复触发，松开任一键后可以再次触发。仅截前台应用的可见窗口，不回退到整屏截图。

![独立快照草稿卡片预览（合成窗口内容）](docs/draft-preview.jpg)

## 安装

从 [GitHub Releases](https://github.com/kaelanvoss/dsh-context-snapshot/releases) 下载适合系统的安装包：

- [macOS Apple Silicon / Intel](https://github.com/kaelanvoss/dsh-context-snapshot/releases/download/v0.2.0/dsh-context-snapshot-0.2.0-macos.tgz)
- [Windows x64](https://github.com/kaelanvoss/dsh-context-snapshot/releases/download/v0.2.0/dsh-context-snapshot-0.2.0-windows-x64.tgz)
- [Windows ARM64](https://github.com/kaelanvoss/dsh-context-snapshot/releases/download/v0.2.0/dsh-context-snapshot-0.2.0-windows-arm64.tgz)

**直接安装请选择平台 `.tgz`，不用解压。** Release 中的 `Source code` ZIP / tar.gz 和 `dsh-context-snapshot-0.2.0-source.tar.gz` 是源码，需要按下方步骤构建，不能作为预编译插件直接添加。`SHA256SUMS.txt` 用于核对文件下载完整性。

公开接口已对官方 npm `0.2.0-rc.2` 与源码 `0.2.1-alpha.1` 核验。manifest 的可选 DSH peer 只声明这两个版本，避免在未经核验的旧版本上直接加载。该插件尚未发布到 npm，不要执行 `add dsh-context-snapshot` 从 registry 下载同名包。

推荐通过 Desktop 的「插件 → 添加插件」填写对应 `.tgz` 的绝对路径，安装后启用；无需单独安装 CLI。已有 `0.1.0` 时，使用新版本 tarball 路径替换安装，然后确认插件列表显示 `0.2.0`，刷新客户端或重启 Harness 使新界面加载。tarball 安装会更新同名包，通常无需先卸载。

也可使用 CLI：先启动一次 Harness Desktop 初始化 profile，再完全退出 Desktop。在终端运行，最后重新打开 Desktop：

```sh
dsh plugin --profile desktop add "/absolute/path/dsh-context-snapshot-0.2.0-macos.tgz"
```

Windows PowerShell 使用对应的文件路径：

```powershell
dsh plugin --profile desktop add "C:\Downloads\dsh-context-snapshot-0.2.0-windows-x64.tgz"
```

若 `dsh` 不在 PATH，macOS 官方 Desktop 自带 CLI：`"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"`。平台包已经包含原生程序，日常使用无需安装 Swift / .NET SDK。源码包用于开发和自行构建。macOS 二进制尚未 Developer ID 签名或公证。

## 使用

1. 在 Harness 中打开一个会话。输入框工具栏出现“▣ 快照”。
2. 点击“快照”，确认会话和原生程序就绪。macOS 首次使用点击“检查 / 授予系统权限”，按系统提示授予屏幕录制；读取文字还需要辅助功能，监听快捷键需要输入监控或辅助功能。更改授权后可点击“重启原生程序”。
3. 切换到要引用的应用窗口，同时按下左右 Command / Ctrl。
4. 返回 Harness，查看独立快照卡：窗口缩略图、应用名和窗口标题。点击卡片可预览原图与来源；窗口文字详情默认折叠。补充需求后发送，输入框不会出现 `window_snapshot` 块。

已有文字、引用 chip 和附件会保留。快照不会自动发送。没有已打开的会话时，本版不会自动创建会话。捕获前台 Harness / helper 自身窗口会返回跳过错误。插件本版不会自动把 Harness 切到前台。

窗口文字来自 macOS Accessibility 或 Windows UI Automation，属于尽力获取；未暴露可访问文字的页面会只有图片，本版没有 OCR。文字上限 16,000 字符、300 个节点，遍历约一秒。截图 PNG 上限 12 MiB。

图片和文字经官方普通用户消息链路提交。当前配置的模型仍需支持图像输入才能理解图片；插件不会改变模型能力。纯文本模型可读随消息提交的窗口文字，但附件是否允许发送由 Harness / provider 判断。

## 草稿与会话行为

- 快照目标在原生 `trigger` 到达 Host 时固定为最近同步的主会话。异步结果不会自动改投新会话。
- 切换会话时使用 generation 防止迟到请求恢复旧会话租约；同会话多个 composer 共享一次投递，ACK 重试不会重复添加图片。
- Harness 接收新会话首次同步之前仍有很短的窗口会沿用最近同步的会话，所以应确认目标会话就绪再切到来源窗口。
- 待处理图片只留在 Host 内存：最多 4 张、60 秒，处理确认后删除；插件不把截图写到磁盘。发送后的图片与消息按 Harness 自身规则存储。
- 快照图片和上下文在未发送时均为浏览器运行时数据，刷新或退出前需发送；尚未投递的内存队列也会随 Host 退出丢失。用户自行输入的普通草稿文字仍由 Harness 保存。
- 移除快照卡会通过官方附件删除链路一起释放图片和对应的隐藏上下文，不影响其他附件或用户正文。此版没有快照移除的撤销功能。
- 发送失败时，快照上下文会保留，图片卡片随 Harness 的草稿恢复链路恢复；重试只附带一次上下文。会话切换不会改投其他会话；官方显式携带草稿到另一工作区时，快照归属随之迁移。
- 快照用于普通消息发送；与 `/` 指令混用时明确拒绝发送并保留草稿，避免只传图片而遗漏窗口文字。退出该指令后可正常发送。
- 此版对齐的是草稿卡片呈现与图片 / 上下文的共同生命周期。已发送消息仍按 Harness 默认呈现显示附带的 `window_snapshot` 文本；自动唤回、目标会话选择、结构化 AX 树和草稿重启恢复尚未对齐 Codex。

## 接入方式

`conversation.input.attachments` 展示插槽呈现快照卡片，并继续使用原附件 renderer 处理普通图片、文件、上传重试与拖放。元数据按官方附件 ID 存储，不进入 Lexical 文档，也不复制 PNG base64。

通过 Cordis 公开的 `reflect.accessor` 对发布的 `ConversationController.sendSession` 做版本限定适配，在发送时按本次附件 ID 序列化窗口上下文；保留原始会话 receiver、queue / steer 模式和取消信号。删除、显式草稿迁移和指令附件序列化也在同一适配层处理。适配层随插件生命周期释放，不修改原型或输入框，不拦截 DOM 发送事件。该方法并非 Harness 专门提供的快照中间件，因此继续限制到已核验的 DSH 版本。

## 开发与验证

源码可用 GitHub 的「Code → Download ZIP」、Release 的源码压缩包下载，也可克隆：

```sh
git clone https://github.com/kaelanvoss/dsh-context-snapshot.git
cd dsh-context-snapshot
```

需要 Node.js 22+（CI 使用 24）。macOS 原生构建还需要包含 Swift 6 的 Xcode Command Line Tools；Windows 原生构建需要 .NET 8 SDK。项目使用公开 npm registry，不依赖私有镜像。

```sh
npm ci --ignore-scripts
npm run build
npm test
```

`npm test` 会从公开 npm 下载固定 `0.2.0-rc.2` 官方输入框实现，校验 registry integrity，再运行全部回归；`npm run test:contracts` 可只运行合同测试。fixture 仅存 `.fixtures/`，不进入 Git 仓库或分发包。

macOS 构建：

```sh
npm run build:macos
npm run pack:macos
```

Windows PowerShell 构建：

```powershell
npm run build:windows
npm run pack:windows-x64
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -Runtime win-arm64
npm run pack:windows-arm64
```

构建脚本会运行无截图的原生自测。生成的可安装 `.tgz` 位于 `artifacts/`，可直接把它的绝对路径填入 Harness。打包时也可以指定输出目录，例如 `npm run pack:macos -- /absolute/output/directory`。

平台包装入对应架构二进制。Git 仓库只保存源码、构建脚本与文档，不提交 `node_modules`、fixture 或编译产物。源码采用 MIT 许可；Windows 分发包包含实际 .NET Runtime 对应的许可证和第三方声明。代码为独立实现，没有复制社区插件源码。

推送分支和 PR 会执行构建与回归检查。维护者推送与 `package.json` 版本一致的 `v*` tag 后，Release 工作流等待检查成功，再发布三个平台安装包、源码压缩包和校验文件。安装包尚未完成 Developer ID 公证 / Windows 代码签名；Windows 仍需实机截图验收。

详见 [验证记录](VALIDATION.md)、[macOS helper 说明](native/macos/README.md)、[Windows helper 说明](native/windows/README.md)。
