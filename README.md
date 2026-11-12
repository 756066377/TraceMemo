# NearCast

<p align="center">
  <img src="./build/icon.png" width="120" alt="NearCast Logo" />
</p>

<h2 align="center">读懂对话，从容回复</h2>

<p align="center">本地优先的微信数据与分析工作台</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/756066377/TraceMemo?style=for-the-badge" alt="GitHub stars" />
  <img src="https://img.shields.io/github/forks/756066377/TraceMemo?style=for-the-badge" alt="GitHub forks" />
  <img src="https://img.shields.io/badge/branch-nearcast-534AB7?style=for-the-badge" alt="branch" />
</p>

<p align="center">
  <a href="https://github.com/756066377/TraceMemo/releases"><b>下载</b></a>
  ·
  <a href="./docs/user-guide/getting-started.md"><b>第一次使用</b></a>
  ·
  <a href="./docs/README.md"><b>完整文档</b></a>
  ·
  <a href="./docs/concepts/reply-assistant.md"><b>狗头军师怎么工作</b></a>
</p>

<p align="center">
  <img src="./public/日报.png" alt="NearCast 群聊日报" />
</p>

<p align="center">
  <img src="./public/自动化.png" alt="NearCast 自动化" />
</p>

---

## NearCast 是什么

NearCast 是一款**本地优先**的微信数据、AI 分析与自动化工作台：把微信里聊过的事变成可浏览、可搜索、可理解、可追溯的信息，并在需要时给出下一步动作。

所有数据都在你自己的机器上处理——聊天记录不因为使用 AI 功能而整体上传，密钥、索引、导出文件都留在本地。

核心分工很清晰：**先用「狗头军师」把话说清楚**，再用档案与搜索找回原文，用日报和监控持续跟踪，最后通过自动化把结果送出去。

## 核心能力

### 狗头军师（回复助手）

- 🧭 **对话分析**：读取当前会话最近的文字与语音转写，分开呈现「可见原文 / 可能意图 / 关键未知 / 下一步 / 停止条件」，引用只接受本轮真实存在的消息。
- 💬 **多种回复建议**：按你设定的关系类型、阶段与本轮目标给出多组候选回复，并说明各自适用与代价；发送与否始终由你决定。
- 🗂️ **关系档案**：按联系人保存关系类型、阶段、目标与补充说明，只在你主动填写后保存，可随时修改或清除。
- 🛡️ **边界优先**：对方明确要求停止联系时，本轮不生成候选，也不会把这段聊天交给模型。

> 「狗头军师」是本项目的**功能名**，不随品牌改动而变化。

### 档案与分析

- 💬 **聊天档案与搜索**：浏览会话，按关键词、备注、昵称或 wxid 找回消息。
- 🔍 **问问微信**：用自然语言检索模糊记忆，并回看来源出处。
- 🧠 **本地知识库**：在本机建立索引，让跨会话、跨时间的查询更稳定。
- 🖼️ **图片文字索引**：在本机识别微信图片里的文字（截图、公告、报价图），识别全程不联网。

### 持续跟踪

- 📊 **群聊日报**：生成今日、昨日或近 7 天的群聊总结，可保存为 HTML 与 PNG。
- 🗣️ **群发言统计**：统计群成员的发言量与沉默成员。
- 👀 **退群监控**：用成员快照对比记录群成员退出事件，支持多群与事件历史。
- ⚙️ **自动化**：把上面几步按规则串起来——定时生成并发送日报、成员退群时发送通知。

### 出口

- 🔊 **文字转语音**：把文字生成语音，试听后发送到当前会话。
- 🤖 **Agent Hub**：在微信里向本机 NearCast 提问。
- 🔌 **Local HTTP API / Reader Skill**：让 Codex 等外部 Agent 查询本机微信历史。
- 📦 **导出**：把聊天保存成文件。

## 从你的任务开始

| 想做什么                           | 使用入口                      |
| ---------------------------------- | ----------------------------- |
| 想知道下一句怎么回                 | 狗头军师                      |
| 找记得原文或关键词的消息           | 档案搜索                      |
| 找记得大意、但不知道在哪聊过的内容 | 问问微信                      |
| 找到截图、公告图里写过的文字       | 问问微信 → 图片文字索引       |
| 长期跨群查询历史                   | 本地知识库                    |
| 了解一个群今天或近 7 天聊了什么    | 日报                          |
| 看群里谁最活跃、谁一直没说话       | 档案 → 群聊 → 群发言统计      |
| 持续关注群成员退出                 | 退群监控                      |
| 按计划自动生成并发送群聊日报       | 自动化                        |
| 把文字生成微信语音                 | 文字转语音                    |
| 让 Codex 等工具查询微信历史        | Reader Skill / Local HTTP API |
| 把聊天保存成文件                   | 导出                          |

## 💻 平台支持

| 平台    | 架构                           | 微信连接                              | 安装包                          |
| ------- | ------------------------------ | ------------------------------------- | ------------------------------- |
| Windows | x64                            | 支持微信 4.x                          | `NearCast-<version>-setup.exe` |
| macOS   | Apple Silicon（M 系列、arm64） | 自动获取数据库 Key                    | `NearCast-<version>-arm64.dmg` |
| macOS   | Intel（x64）                   | 自动获取数据库 Key                    | `NearCast-<version>-x64.dmg`   |

Windows 与 macOS 均支持微信本地数据库连接与数据库 Key 获取。

### 关于「发送能力」

浏览、搜索、日报生成、导出、知识库与图片文字索引都不需要任何额外的发送组件。只有**把内容真正发回微信**这一步——自动发送日报、退群通知、把语音发到会话——依赖本机发送能力。

Windows 端的发送能力由本机 hook 组件提供：

- 组件清单写在 `resources/wechat-hook/manifest.json`（文件名 + 适用微信版本 + sha256），安装包内置的版本在设置页可见来源与哈希。
- **微信 4.1.15 起不再加载安装目录里的 `version.dll`**，所以「拷文件 + 重启」拿不到发送接口；NearCast 提供「注入到运行中的微信」，把组件直接注入微信主进程，hook 会在进程内开启 HTTP 服务（默认 30001）。
- 组件与微信小版本不匹配时，注入会被拦下——版本不匹配的 hook 会让微信崩溃。设置页提供适配微信版本的下载入口。

发送能力未就绪、未绑定或发送失败时，报告本身仍会正常生成并保存在本机，执行记录会显示为「已生成，但未发送」或「已生成，发送失败」，可以稍后重试。

## 快速开始

1. 从 [Releases](https://github.com/756066377/TraceMemo/releases) 下载对应平台的安装包；当前仓库尚未发布安装包，可按下方「从源码构建」自行生成。
2. 启动应用，按「第一次使用」页面选择微信数据目录并完成连接。
3. 打开「狗头军师」，在聊天窗口里选中会话后开始分析；需要 AI 时先在「设置 → AI 模型」添加并测试 Provider。
4. 想找回原始消息时，进入「狗头军师」所在页的档案区搜索，或直接用「问问微信」做语义检索。

详细步骤见[第一次使用](./docs/user-guide/getting-started.md)。

### 从源码构建

需要 Node.js 22+ 与 pnpm 7：

```bash
pnpm install
pnpm dev                  # 开发模式
pnpm build:win            # Windows 安装包（dist/NearCast-<version>-setup.exe）
pnpm build:mac:arm64     # macOS Apple Silicon
pnpm build:mac:x64       # macOS Intel
```

自检：

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:component
```

## 文档

- [文档首页](./docs/README.md)
- [用户指南](./docs/user-guide/getting-started.md)
- [狗头军师的依据与回复生成](./docs/concepts/reply-assistant.md)
- [它是如何工作的](./docs/concepts/how-it-works.md)
- [隐私与安全](./docs/user-guide/privacy.md)
- [开发文档](./docs/development/overview.md)

## 参与贡献

- 稳定分支是 `nearcast`（本仓库默认分支），改动先进 `develop` 风格的特性分支，再合回 `nearcast`。
- 分支流程、提交信息风格与 PR 自检见[参与贡献指南](./CONTRIBUTING.md)。
- 功能想法与问题反馈请走 [Issues](https://github.com/756066377/TraceMemo/issues)。

## 出处与致谢

NearCast 基于 **[TraceMemo](https://github.com/Wxw-Gu/TraceMemo)**（原名 WechatExplorer，作者 Qingmao）派生开发。原项目完成了微信 4.x 数据访问、密钥获取、日报、知识库等底层与产品框架，是本项目能够站在今天的基础。

本仓库保留了原项目的全部能力，并在其之上新增了狗头军师（回复助手与关系档案）、Windows 端 hook 组件的版本化打包与进程注入、NearCast 品牌与主题体系。原项目的作者署名与致谢均予保留。

### 特别感谢 WeFlow

TraceMemo 在早期适配微信 4.x 时，参考了 **[WeFlow](https://github.com/hicccc77/WeFlow)** 历史版本中的相关实现与思路（数据库访问、密钥获取等底层能力），特别感谢作者 **[hicccc77](https://github.com/hicccc77)**。

### 其他参考项目

- **[WechatMessageExplorer](https://github.com/svcvit/WechatMessageExplorer)**：数据解析相关思路。
- **[chatlog](https://github.com/sjzar/chatlog)**：数据处理方面的参考。
- **[wechat_chatter](https://github.com/yincongcyincong/wechat_chatter)**：发送方面的参考。
- **[goutoujunshi-jev-chat](https://github.com/shengjidaguai-china/goutoujunshi-jev-chat)**：狗头军师回复策略与自然口吻资料的来源。

感谢所有开源作者。

---

<p align="center">
  <b>NearCast</b>
  <br />
  把微信聊过的事，找回来、问清楚、留下来。
</p>
