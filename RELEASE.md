v0.4.3 修复 Windows 采集程序占用插件安装目录、导致升级报 `EPERM` 的问题。

- Windows 启动前将完整原生程序复制到 `%LOCALAPPDATA%\dsh-context-snapshot\helpers\` 下按版本和内容区分的缓存目录，从缓存启动，避免运行中的 EXE 锁住 `node_modules` 内的插件文件。
- macOS 保持现有 app 路径与授权方式。
- 安装说明对齐 Harness 的「包名、GitHub 地址、本地目录」入口；升级按「禁用 → 等待采集程序退出 → 卸载 → 添加新版」处理。
- 下载页仅保留最新版 Release；历史源码 tag 保留。

**安装**：下载对应平台的 `.tgz`，解压后在「插件 → 添加插件」填写其中 `package` 目录的绝对路径。插件尚未发布到 npm；GitHub 仓库和源码压缩包需要自行构建，不能直接作为预编译插件安装。CLI 也可直接安装 `.tgz`，用法见 README。

**旧版首次迁移**：`0.4.2` 及更早版本的进程仍从旧安装目录运行。先禁用并等待采集程序退出，再卸载安装。若出现 `EPERM`、无法卸载或已有残缺文件，完全退出 Harness（包括托盘），确认 `ContextSnapshot.exe` 已结束，通过 Desktop CLI 先 `remove dsh-context-snapshot` 再 `add` 新包。新版缓存机制不补回旧版缺失文件，也未加入自动更新、安装备份或回滚。

**附件**：macOS universal、Windows x64、Windows ARM64 三个平台安装包，`dsh-context-snapshot-0.4.3-source.tar.gz` 和 `SHA256SUMS.txt`。请选择实际系统架构，Source code 下载不是安装包。

**验证**：本地构建与 93 项 JavaScript 回归通过。Windows x64 缓存内程序通过 22 项自检；运行中成功重命名原始运行目录，随后状态请求和正常退出通过，未捕获窗口。Release 工作流从此 tag 构建、自检三个平台并核验发布资产后才清理旧下载。Windows ARM64 使用交叉构建；这些检查不替代真实 Desktop 的卸载安装、捕获和 macOS 授权验收，完整记录见 `VALIDATION.md`。

**兼容与限制**：支持 Harness `0.2.0-rc.2` 和 `0.2.1-alpha.1`。截图与可访问文本进入草稿，由用户手动发送；不运行 OCR，未发送快照在刷新或退出后丢失。图片需要支持图像输入的模型，快照不能与 `/` 指令混用。安装包尚未完成 macOS Developer ID 公证或 Windows 代码签名。
