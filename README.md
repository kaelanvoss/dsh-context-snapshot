# DeepSeek Harness 窗口快照插件

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立插件：用快捷键把其它应用的前台窗口截图和可访问文本加入当前会话的草稿。你可以先预览、补充问题，再手动发送给模型。

支持图片缩放、拖动、下载和文本预览，界面跟随 Harness 的浅色 / 深色主题。

![快照草稿示例（Harness 官方输入区样式）](docs/draft-preview.png)

示例渲染采用 Harness 官方输入区样式和插件实际组件，窗口内容为公开发布页的真实截图。

## 安装

当前版本：`0.6.1`。支持采集质量与来源预览、未发送快照恢复，以及弹窗内自定义双键快捷键；修复 macOS 大写快照 ID 在发送后未识别为卡片的问题。支持 Harness `0.2.0-rc.2` 和 `0.2.1-alpha.1`；其它版本尚未核验。

| 系统 | 默认捕获快捷键 | 安装包 |
| --- | --- | --- |
| macOS 13+，Apple Silicon / Intel | 左 Command + 右 Command | [macOS](https://github.com/kaelanvoss/dsh-context-snapshot/releases/download/v0.6.1/dsh-context-snapshot-0.6.1-macos.tgz) |
| Windows 10/11 x64 | 左 Ctrl + 右 Ctrl | [Windows x64](https://github.com/kaelanvoss/dsh-context-snapshot/releases/download/v0.6.1/dsh-context-snapshot-0.6.1-windows-x64.tgz) |
| Windows 10/11 ARM64 | 左 Ctrl + 右 Ctrl | [Windows ARM64](https://github.com/kaelanvoss/dsh-context-snapshot/releases/download/v0.6.1/dsh-context-snapshot-0.6.1-windows-arm64.tgz) |

1. 下载对应系统的 **`.tgz` 安装包**，解压后找到其中的 `package` 目录。
2. 打开 Harness Desktop 的「插件 → 添加插件」，填写这个目录的绝对路径，例如 `C:\Downloads\dsh-context-snapshot-0.6.1-windows-x64\package`。
3. 安装并启用插件，打开会话，点击「快照」确认已就绪。若按钮未出现，完全退出再打开 Harness。

**升级已有版本**：先禁用插件，等待采集程序退出，卸载旧版，再通过「添加插件」安装新版。这与 Harness 当前的升级提示一致。Windows 从 `0.4.2` 或更早版本首次升级时，旧采集程序仍可能锁住安装目录；禁用后若无法卸载或仍报 `EPERM`，完全退出 Harness（包括托盘），按下方恢复步骤处理。

升级或覆盖安装后，请完整退出并重新打开 Harness。运行中的后台插件不会随安装文件自动更新，界面与后台可能暂时使用不同版本。若旧版录入报 `Invalid draft identity`，完整重启应用可加载新版后台；「重启采集」只重启原生程序，不能代替应用重启。`0.5.2` 会在暂停快捷键分发之前检查后台能力并提示这一情况。

**安装来源怎么选？** 插件尚未发布到 npm，暂不能填包名安装；GitHub 仓库地址和 Source code ZIP / tar.gz 提供的是源码，缺少预编译程序。请用平台包解压得到的本地目录。底层安装器也能识别 `.tgz` 的绝对路径，可通过 CLI 直接安装，无需解压。

[最新版 Release](https://github.com/kaelanvoss/dsh-context-snapshot/releases/latest) · [安装包 SHA256 校验值](https://github.com/kaelanvoss/dsh-context-snapshot/releases/latest/download/SHA256SUMS.txt)

平台包已包含原生程序，使用时无需 Swift、.NET SDK 或额外运行时。`0.4.3` 起，Windows 采集程序从 `%LOCALAPPDATA%\dsh-context-snapshot\helpers\` 下按版本和内容区分的缓存目录运行，不再占用插件安装目录。此改动不修复旧版失败安装留下的残缺文件，也不提供自动更新或安装回滚。

预览工具栏会避开桌面标题栏的窗口按钮，并随全屏状态调整位置。

<details>
<summary>CLI 首次安装 / 异常恢复（可选）</summary>

先启动一次 Harness Desktop 初始化配置，再完全退出应用，包括托盘进程。将命令中的路径替换为实际安装包路径；不要在 Harness 或旧采集程序仍运行时覆盖安装。

macOS：

```sh
dsh plugin --profile desktop add "/absolute/path/dsh-context-snapshot-0.6.1-macos.tgz"
```

Windows PowerShell：

```powershell
dsh plugin --profile desktop add "C:\Downloads\dsh-context-snapshot-0.6.1-windows-x64.tgz"
```

macOS 若找不到 `dsh`，可使用 Desktop 自带的 CLI：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。

Windows 自带 CLI 位于 `<Harness 安装目录>\resources\runtime\cli\bin\dsh.cmd`。若 `dsh` 不在 PATH，在 PowerShell 中用 `& "完整的 dsh.cmd 路径"` 替换命令里的 `dsh`。

若旧版安装已损坏、显示「异常」，或应用内无法卸载：确认 Harness 和 `ContextSnapshot.exe` 都已退出，先移除旧包，再运行上面的 `add` 命令，成功后重新打开 Harness：

```sh
dsh plugin --profile desktop remove dsh-context-snapshot
```

</details>

## 使用

1. 在 Harness 中打开目标会话，点击输入框工具栏的「快照」，确认显示「已就绪」。
2. macOS 首次使用时点击「检查权限」：截图需要屏幕录制权限，读取文字需要辅助功能权限，监听快捷键需要输入监控或辅助功能权限。更改权限后点击「重启采集」。
3. 切换到要引用的应用窗口，同时按下当前设置的快捷键。默认是左右 Command（macOS）或左右 Ctrl（Windows）。组合全部按下才会触发，额外按住其他支持的键时不触发；松开组合中的任一键后可再次捕获。
4. 返回 Harness，检查草稿中的快照卡片，补充问题后发送。插件不会自动发送或把 Harness 切到前台。

| 操作 | 效果 |
| --- | --- |
| 点击草稿、发送中或历史消息里的快照卡片 | 打开大图，可缩放、适应窗口、拖动和下载 |
| 点击「查看文本」 | 显示捕获时保存的文字、控件层级、可获取的状态、来源、选区、聚焦对象与采集质量；仅图片时仍可查看已知来源和失败原因 |
| 点击左右箭头 | 切换同组快照 |
| 点击关闭按钮、空白遮罩，或按 Esc | 关闭预览 |
| 点击草稿卡片的移除按钮 | 一起移除图片及其窗口上下文，保留其他附件和正文；暂不支持撤销 |

排队中的快照沿用静态缩略图。文本预览读取已保存的内容，不重新采集窗口，也不运行 OCR。

### 设置快捷键

在同一个「窗口快照」弹窗中点击「修改快捷键」，同时按住两个不同按键，全部松开后再点击「保存快捷键」。只支持双键组合；录入第三个键会使本次录入无效，并要求重新录入，不会自动截取前两个键。支持左右修饰键、字母、数字、功能键、导航键及常用数字小键盘键；当前平台不支持的键会提示重新录入。单键、重复同一键、依次按两个不重叠的键不能保存。

弹窗采用统一背景和简洁文字状态，随 Harness 主题变化。点击弹窗外可关闭并继续操作外部控件；也可用关闭按钮、快照按钮或 Esc。录入时单独 Esc 取消编辑，组合中的 Esc 仍可录入。保存或恢复监听尚未完成时延迟关闭，失败会保留错误供重试。

- 录入期间暂停快照捕获及 Harness 命令触发；取消保留原设置，关闭弹窗恢复监听。
- 组合由原生程序确认，不依赖输入框的按键冒泡事件。仅在本次录入的 Harness 窗口位于前台时采集；未完成录入切换窗口或超过 15 秒会中断并要求重新录入。完整录入后可以从容保存，不再接收新的键位；不保存字符或按键序列。
- 与 Harness 已登记的快捷键冲突时，显示命令名称并禁止保存。目录包含当前窗口的用户自定义绑定及固定命令；后续目录变更也会更新提示。
- 左右纯修饰键组合及超出 Harness 官方格式的组合仅能部分检测。系统和其他应用的快捷键不在检测范围内；插件采用被动监听，按键仍会传给前台应用。
- 「恢复默认」应用对应系统的左右 Command / Ctrl。原生程序确认和本地保存均成功后才显示为新设置；失败时恢复旧组合，无法确认恢复则停止采集并提示重启。
- 设置保存在本机，跨会话及采集程序重启保留。多个 Harness 窗口共享设置，旧窗口的过期保存请求会被拒绝。窗口意外退出后，录入暂停租约会自动到期。
- 旧配置若包含三个或更多键，将明确提示并使用默认双键组合；保存新的双键组合后才覆盖旧文件。

配置文件为 macOS 的 `~/Library/Application Support/dsh-context-snapshot/shortcut.json`，或 Windows 的 `%LOCALAPPDATA%\dsh-context-snapshot\shortcut.json`，与插件安装目录分离。它只保存按键代码，不保存用户输入内容。

## 注意事项

- **捕获范围**：只截前台应用的可见窗口，不回退到整屏截图；Harness 和采集程序自身的窗口会跳过。先确认目标会话就绪，再切换到来源窗口捕获。
- **文本范围与质量**：来自 macOS Accessibility / Windows UI Automation，最多读取 300 个节点、16,000 个 UTF-16 单位。优先保留聚焦路径、选中控件、弹窗和文档；过滤密码及提供者报告的隐藏内容（Windows 还排除 offscreen）。macOS 优先读取 AXVisibleChildren，不支持时读取 AXChildren，因此不等于完整可视区域。超时、读取失败和截断会同时告知用户与模型；“文字已获取”不表示应用暴露了全部内容。
- **来源与时间**：保存可获取的 URL、选中文字、聚焦对象及图片／文字各自采集时间。Windows 仅保存 Document 提供者明确暴露的 URL；不会从标题猜测。图片和文字不是原子读数；采集期间目标窗口、进程或标题变化会拒绝该次快照。
- **草稿保存**：图片、文字、来源、质量与稳定 ID 在本机原子保存，刷新、退出或意外重启后按原会话恢复。切换会话不删除草稿；点击移除或发送成功后清理全部上下文。已确认拒绝的发送保留草稿供重试；断连、取消或未决请求不能证明后台未接受时，保持本机记录并提示发送状态未确认，避免自动恢复或再次发送。多窗口通过租约防止重复恢复。
- **本机存储**：草稿保存在快捷键配置同级的 `drafts-v1` 目录，最多 16 张／64 MiB；达到上限或文件异常会明确提示，已有草稿不会自动删除。发送后的应用图标保留为独立展示数据，最多 2048 条／24 MiB；图标不进入新版模型文本。
- **消息内容**：模型收到截图、窗口来源、采集质量和可访问文本。插件启用时，输入框和消息正文隐藏插件生成的上下文，消息复制只包含用户正文；导出、原始记录或停用插件后可能看到 `window_snapshot` 文本块。发送后的图片与消息按 Harness 自身规则存储。
- **模型与指令**：理解图片需要支持图像输入的模型。快照与 `/` 指令混用时会拒绝发送并保留草稿，退出指令后可正常发送。

## 常见问题

| 问题 | 检查方法 |
| --- | --- |
| 没有「快照」按钮 | 检查 Harness 版本、插件是否启用，以及安装后是否完全重启 |
| 升级时报 `EPERM` 或安装后显示「异常」 | 旧版采集程序可能仍在占用文件；完全退出 Harness（包括托盘），确认 `ContextSnapshot.exe` 已结束，再用 CLI 先移除旧包、安装新版，见上方恢复步骤 |
| 快捷键没有反应 | 检查原生程序状态、macOS 权限、设置的组合是否全部按下且未额外按键；来源窗口不能是 Harness 自身 |
| 快捷键无法保存 | 两个不同键须同时按住；单键和三个以上键均不支持；检查 Harness 冲突提示、录入连接状态，或重新录入 |
| 快照显示“仅图片”或“文字部分获取” | 点击「查看文本」查看具体原因和已保存的来源；升级不会补回旧快照中未保存的信息 |
| 历史图片加载失败 | 有已保存的文字时仍可查看文本；检查 Harness 的附件是否可用 |
| 正文出现 `window_snapshot` 块 | 确认插件已启用并重启；图片缺失或上下文无法完整配对时会保留原内容 |

## 开发

需要 Node.js 22+。构建原生程序时，macOS 还需要包含 Swift 6 的 Xcode Command Line Tools，Windows 需要 .NET 8 SDK。

```sh
git clone https://github.com/kaelanvoss/dsh-context-snapshot.git
cd dsh-context-snapshot
npm ci --ignore-scripts
npm run build
npm test
```

测试会下载并校验固定版本的官方 Harness 组件，缓存到忽略的 `.fixtures/` 目录。仅运行发送接口测试可用 `npm run test:contracts`。

macOS 构建与打包：

```sh
npm run build:macos
npm run pack:macos
```

Windows PowerShell 构建与打包：

```powershell
# x64
npm run build:windows
npm run pack:windows-x64

# ARM64
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -Runtime win-arm64
npm run pack:windows-arm64
```

构建脚本会运行原生自测，可安装的 `.tgz` 输出到 `artifacts/`。打包命令可指定输出目录，例如 `npm run pack:windows-x64 -- C:\Downloads`。

本地 Host / Client 构建及 305 项 JavaScript / 官方接口回归通过，macOS universal 构建与 30 个原生自测组通过。macOS 真实 Harness 已验证双键录入保存、A+D 完整重启后触发、未发送草稿重启恢复、移除与成功发送清理、图片／文本预览及下载，以及已知 Host 拒绝后的无重复重试；独立新会话的模型图文读取也已验证。Windows x64 / ARM64 已有零错误交叉构建及 116 项可移植策略检查，本轮按用户要求跳过 Windows 真机捕获、UIA 与全局快捷键验收。

Release 工作流从发布 tag 重建三个平台安装包，核验附件并备份旧 Release 元数据后，只保留最新版稳定 Release 的下载，历史源码 tag 保留。远端构建与发布结果以对应 GitHub Actions / Release 为准；构建和自动检查不替代未覆盖的系统权限、硬件及故障场景实测。完整记录见 [VALIDATION.md](VALIDATION.md)。

原生采集与权限细节见 [macOS 说明](native/macos/README.md) 和 [Windows 说明](native/windows/README.md)。插件的会话适配依赖已核验版本的具体实现，升级 Harness 时需要重新验证。

## 许可

源码采用 [MIT 许可](LICENSE)。Windows 安装包包含对应运行时的许可证和第三方声明；安装包尚未完成 macOS Developer ID 公证或 Windows 代码签名。
