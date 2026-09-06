<p align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/banner.jpg" width="100%" alt="ModLens" />
</p>

<h1 align="center">ModLens</h1>

<p align="center"><b>为纯文本模型补上视觉能力，直接粘贴图片就能识别。</b></p>

<p align="center">🥇 <b>全网最强的 DeepSeek Harness（dsh）视觉插件</b> 🥇</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="skills/modlens/references/configure.zh-CN.md">配置</a> ·
  <a href="docs/troubleshooting.zh-CN.md">故障排查</a> ·
  <a href="docs/security.zh-CN.md">安全</a> ·
  <a href="https://github.com/liustack/modsearch"><b>🔍 ModSearch（DSH 最强免费联网搜索插件）</b></a>
</p>

<p align="center">
  <a href="https://x.com/liustack"><img src="https://img.shields.io/badge/follow-%40liustack-black?style=flat-square&logo=x&logoColor=white" alt="Follow @liustack on X"></a>
  <a href="https://www.npmjs.com/package/@liustack/modlens"><img src="https://img.shields.io/npm/v/@liustack/modlens?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@liustack/modlens?style=flat-square" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/Not%20backed%20by-Y%20Combinator-FF6600?style=flat-square&logo=ycombinator&logoColor=white" alt="Not backed by Y Combinator">
  <img src="https://img.shields.io/badge/users-unknown-lightgrey?style=flat-square" alt="Users unknown">
</p>

DeepSeek 的主力对话模型和 GLM-5.3 本体仍是纯文本，无法读图。GLM-5.3-Flash 已是原生多模态。ModLens 借助外挂视觉引擎，为纯文本模型补上视觉能力。**ModLens 支持直接粘贴图片识别**，无需先保存成文件再提供路径。

## 交流

有问题随时提[issue](https://github.com/liustack/modlens/issues/new/choose)。推荐你关注公众号 liustack，也欢迎你来 X 上聊：**[@liustack](https://x.com/liustack)**。你用它做了什么、在哪个 harness 上跑、接下来该做什么，都会在公众号和 X 同步更新。社群正在筹备中。

## 亮点

**🥇 全网最强的 DeepSeek Harness（dsh）外挂视觉识别插件：**一条命令即刻安装 `npx -y @deepseek-ai/dsh plugin --profile web add @liustack/modlens@3.25.4`。更多安装与更新细节参考 [配置手册](docs/harness-setup.zh-CN.md) 。如果用不惯命令行，也想想玩玩 DSH，推荐食用全网最轻量级的 DeepSeek Harness 桌面版封装 <a href="https://github.com/liustack/aimanager"><b> AIManager</b></a>，零代码零配置起手，一键帮你安装所有依赖环境。

DeepSeek Harness 粘贴识图有两种玩法。

**① 直接粘贴** 贴进来的图片自主转换成文件路径进输入框（与 OpenCode、Pi 同款交互），`modlens_read_image` 工具接手读图。

**② 切到带 `(modlens vision)` 后缀的模型变体**（选择器有记忆，选一次就行）再粘贴：缩略图直接可见、所见即所得，体验更接近 Codex App。变体由插件自动发现生成：每条承载纯文本 DeepSeek 或 GLM 模型的 provider 路由各得一组包装条目（默认安装下就是 **`DeepSeek-V4-Flash (modlens vision)`** 和 **`DeepSeek-V4-Pro (modlens vision)`**，装了 opencode-go、zai 等额外路由的机器会各自多出一组），两家自己的视觉型号（含 GLM-5.3-Flash）自动排除。走哪条通路由 host 依据真实模型元数据逐个裁决：只有被元数据确认纯文本的模型才会被接管，确认不了的一律不动，视觉模型因此保留原生贴图（[细节](docs/harness-setup.zh-CN.md)）。

**所有 Harness 直接粘贴图片识别** 无需先保存成文件再提供路径。

需要快捷键把屏幕截进 DeepSeek Harness 时，用独立插件 [dsh-screenshot](https://github.com/paicat1/dsh-screenshot)。

- **全网最轻量。** 不用 hook，不套壳，不跑本地代理进程，不改任何 harness 配置的一行字：在 skill 类 harness 里它就是一个 skill 文件夹，在 dsh 里就是一个插件。卸载等于删个文件夹，你的 agent 立刻回到原样。
- **零配置起手。** 复用 Claude Code、Codex、OpenCode、Pi 已有配置，直接复用你本机的其他多模态模型。如果你本机什么都没安装？Antigravity CLI 是免 key 的免费通道，配一个免费 Gemini key 可将识别耗时降至 5 到 10 秒。也支持所有主流的 OpenAI 兼容格式 API key。
- **多个密钥用英文逗号分隔，鉴权、限流或配额失败时自动轮换。** 其他失败会跳过剩余密钥，并继续走现有的 provider 故障转移。
- **基于证据，而非想象。** 全文转录、按阅读顺序划分的版面区块、实体与关系列表，模型引用的是具体内容。
- **一次安装，多端可用。** Claude Code、Codex、Pi、OpenCode 均经真机验证。

## 在其他 Harness 中安装

**方式一，通过 [skills.sh](https://skills.sh/) 一条命令安装：**

```bash
npx -y skills add liustack/modlens --skill modlens --global
```

这会把 `modlens` skill 安装到用户级目录。重启 Harness 后，让 AI 配置
modlens 并运行体检即可。

**方式二，把安装交给你的 AI。** 把这句话发给它：

> 按 https://github.com/liustack/modlens 的 INSTALL.md 安装并配置 modlens skill，完成后运行体检并把结果告诉我。

安装会先盘点你机器上已有的东西。Claude Code、Codex、OpenCode 或 Pi 里任何一个已有的登录态都可能就够了：modlens 复用前一定先征得你同意，体检报告会说清现状。

**两种方式完成后，只在体检两手空空时，才需要你配一个免费引擎。** 推荐免费的 Gemini api key（到 [Google AI Studio](https://aistudio.google.com) 领取，约三分钟，无需信用卡），配上后每次识别 5 到 10 秒。其他平台的免费 openai 兼容 key 也行。想完全免注册就装 Antigravity CLI，然后完成登录：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy                                                           # 浏览器完成登录后退出
```

安装还会盘点本机其他 harness CLI（Codex、OpenCode、Pi）里可触达的视觉能力，并逐个询问是否允许 modlens 复用。获准的登录态与你自己配的引擎平级入池，每次复用都会在结果里标明花的是谁的额度。

**DeepSeek Harness（dsh）用户不走 skill 流程**，本包就是原生 dsh 插件：

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @liustack/modlens@3.25.4
```

装完即有 `modlens_read_image` 工具，选「(modlens vision)」模型变体即可直接粘贴识图。引擎配置同样在 `~/.modlens`，详见[宿主接入](docs/harness-setup.zh-CN.md)。

命令行不是唯一入口。dsh 设置页的「插件 → 插件配置」里有一张 ModLens 卡片：切换引擎，勾选 auto 模式可以复用本机哪些 CLI，在网页上点几下保存就生效。

![dsh 设置页里的「视觉引擎（ModLens）」配置卡片：切换引擎，勾选 auto 模式复用的本机 CLI](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-dsh-settings-card.jpg)

## 用法

装好之后不需要记任何命令。正常聊天，粘贴图片或给出图片路径，提问即可，skill 自动触发：图片交给视觉引擎，答案基于读到的内容返回。贴一次，后面追问同一张图不用再贴。

## 视觉引擎：六个内置 provider，四家可复用 CLI，一条故障转移链

ModLens 不绑定任何单一视觉服务。视觉来源一共十个：六个内置 provider（配好任意一个就能用），加四家本机 agent CLI 的登录可以复用。先看内置的：

| Provider          | 需要什么                                                                 | 单次识别耗时 | 适合谁                 |
| :---------------- | :----------------------------------------------------------------------- | :----------- | :--------------------- |
| `gemini-api`      | 免费 Gemini key（[三分钟领取，无需信用卡](https://aistudio.google.com)） | 5-10 秒      | 推荐默认               |
| `openai`          | 任意 OpenAI 兼容端点（key + baseUrl + model）                            | 5-10 秒      | qwen-vl、GLM、自建网关 |
| `anthropic`       | Anthropic API key                                                        | 5-10 秒      | 手上已有 key 的机器    |
| `antigravity-cli` | 免费的 `agy` CLI，浏览器登录一次，无需 key                               | 15-45 秒     | 完全免注册起步         |
| `claude-cli`      | 已登录的 Claude Code                                                     | 20-45 秒     | 复用现有 Claude 订阅   |
| `kimi-cli`        | 已登录的 Kimi Code                                                       | 20-45 秒     | 复用现有 Kimi 订阅，需显式点名 |

不钉死 provider 时，所有配好的引擎组成一条故障转移链：API 快车道先试，agent CLI 兜底，第一个可用结果胜出，`meta.attempts` 记录每次尝试，回退永远不是无声的。

### `openai` 是万能接口，不只是 OpenAI

任何讲 OpenAI chat-completions 协议、支持图片输入的端点都能直接插上，这基本覆盖了视觉模型的大半个世界：

```bash
modlens config set openai.baseUrl https://dashscope.aliyuncs.com/compatible-mode/v1   # qwen-vl
modlens config set openai.apiKey  <key>
modlens config set openai.model   qwen3-vl-plus
```

`apiKey`（以及对应的环境变量）也接受英文逗号分隔的列表。鉴权、限流或配额失败时会轮换到下一个密钥。网络、5xx 和解析失败会跳过剩余密钥，并继续走现有的 provider 故障转移。

同样三个键，换成 GLM 开放平台、SiliconFlow、OpenRouter、自建 vLLM/Ollama 或你自己的网关都一样。你常用的视觉模型只要有 OpenAI 兼容 API，ModLens 就能驱动它。

### 复用你机器上已有的东西

还有两处现成的视觉能力，一个新 key 都不用配，每家都在你明确同意后才启用：

- **你正在对话的这个 harness 本身。**在登录了订阅的 Claude Code 里用？`claude-cli` 开箱即可借它读图。装进哪个 harness，安装流程就会问哪个 harness 的授权。
- **机器上其他的 agent CLI。**`modlens doctor` 会逐个发现，你按家授权，它们与你自己的 key 平级入链，不插队。每次复用都在 `meta.warnings` 里标明花的是谁的额度，绝不无声扣费：

| 复用来源 | 需要什么                       | 授权命令                         | 走哪条道                                               |
| :------- | :----------------------------- | :------------------------------- | :----------------------------------------------------- |
| Codex    | 已登录且有视觉模型的 Codex CLI | `config set reuse.codex true`    | agent 通道，15-45 秒                                   |
| OpenCode | OpenCode 里配好的视觉模型      | `config set reuse.opencode true` | agent 通道，15-45 秒                                   |
| Pi       | Pi 持有的模型凭据              | `config set reuse.pi true`       | API key 直接升级到 5-10 秒的快车道，OAuth 驱动 Pi 本体 |
| Grok     | 已登录的 Grok CLI（SuperGrok） | `config set reuse.grok true`     | agent 通道，15-45 秒                                   |

### 选择与路由

两个旋钮：`modlens config set provider <name>` 表达偏好（链继续兜底），`-p <name>` 钉死单个不回退。代理环境设 `HTTPS_PROXY` 或 `modlens config set proxy <url>`，API provider 自动走代理。细节见 [CLI 手册](docs/cli.zh-CN.md)（默认模型与参数）、[配置手册](skills/modlens/references/configure.zh-CN.md)（全部配置键）、[安全说明](docs/security.zh-CN.md)（远程 URL 由谁抓取）。

## 实测

以下均为原样记录，驱动的都是纯文本的 DeepSeek-V4-Flash。

最新的一条放最前：在 DeepSeek Harness 里选 `DeepSeek-V4-Flash (modlens vision)` 变体直接粘贴截图。粘贴保留原生缩略图，轨迹里可见图片抵达时「已由 modlens 视觉桥转写」，回答逐个元素还原了界面。

![在 DeepSeek Harness 中直接粘贴图片，经 modlens 视觉插件读取](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-dsh-paste.jpg)

Codex 桌面 App 中识别一张推文截图。作者、配文、照片内容（连两人的穿着都在内）、发帖时间和全部互动数据（540 万浏览、1.6K 回复、5.7K 转发、11.6 万点赞）逐项读出。

![纯文本 DeepSeek 通过 ModLens 读出推文截图的全部细节](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-app.jpg)

一次粘贴三张图。模型逐张读取，认出三张同属一个视觉家族，并分别描述每张插画的内容和风格。

![一次粘贴三张图，逐张读取](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-batch.jpg)

压力测试：128 个模型的对比散点图。双轴定义、对数刻度、按厂商的配色、高亮区域，以及虚线标注的每一个 DeepSeek 型号全部识别。密集图表是视觉方案最容易出错的场景。

![128 个模型的散点图完整读出：双轴、对数刻度与高亮区域](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-chart.jpg)

粘贴链路的端到端记录：接入 DeepSeek 的 Claude Code 终端里，粘贴的图片以路径而非像素到达，skill 自动触发，guard 确认当前模型确实没有视觉后才开读，PPT 封面幻灯的标题、版式、背景逐项读出，连文件名被截断这个不确定点都如实说明。

![接入 DeepSeek 的 Claude Code 会话中 skill 自动触发并读出粘贴的幻灯片](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-claude-paste-recovery.jpg)

## 文档

| 文档                                                     | 适用场景                                   |
| :------------------------------------------------------- | :----------------------------------------- |
| [安装手册](INSTALL.md)                                   | 一步步安装 skill（为 agent 编写）          |
| [CLI 手册](docs/cli.zh-CN.md)                            | skill 所驱动的 CLI：参数、配置与体检       |
| [故障排查](docs/troubleshooting.zh-CN.md)                | 命令报错，查成因和解法                     |
| [配置手册](skills/modlens/references/configure.zh-CN.md) | 配置 key、切换 provider、排查配置          |
| [输出契约](docs/output-schema.zh-CN.md)                  | 解析 JSON 或构建下游工具                   |
| [宿主接入](docs/harness-setup.zh-CN.md)                  | 在 Codex、Claude Code、Pi、OpenCode 中配置 |
| [安全说明](docs/security.zh-CN.md)                       | 恢复文件的权限、图片内容作为不可信输入     |
| [更新日志](CHANGELOG.md)                                 | 查询版本变更                               |

## 参与方式

本仓库不接受 PR。项目由作者独立维护，所有代码经作者本人审阅，这是它可靠性的前提。两种有效的参与方式：

- **[提交 issue](https://github.com/liustack/modlens/issues)。** bug、建议、难以理解的报错或文档都欢迎。issue 会被认真阅读，并影响后续开发方向。
- **Fork。** MIT 协议下你的副本完全归你，修改和发布不受限制。

## 插入一条硬广

**[ModSearch](https://github.com/liustack/modsearch)** 是 ModLens 的同门项目，同一套手艺补另一种感官：给不能联网的模型补上网页搜索、X 搜索和单页抓取。免费，免注册，免 API key。模型既然需要 ModLens 当眼睛，多半也需要 ModSearch 联网：

```bash
npx -y @deepseek-ai/dsh plugin --profile web add @liustack/modsearch@latest
```

关注微信公众号「liustack」：AI 创业机会、独立开发见解、AI 实战与工具，第一时间推送。微信扫码，或搜一搜「liustack」：

<p align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/wechat-qrcode.png" width="420" alt="微信公众号 liustack" />
</p>

⭐ 如果它对你有用，请给 [ModLens](https://github.com/liustack/modlens) 和 [ModSearch](https://github.com/liustack/modsearch) 一个 star，这是其他开发者找到它们的方式。

## 重要生态伙伴

DeepSeek Harness 生态里最值得推荐的项目。

- 🛒 **[dsh-market](https://github.com/dsh-market/dsh-market)** — DeepSeek Harness 的可视化插件市场。设置页里直接逛社区全部 800+ 插件：分类筛选、截图预览、一键安装与更新、主题即点即换，装完多数免重启。
  The plugin market inside DeepSeek Harness. Browse 800+ community plugins with category filters and screenshot previews, one-click install and update, and live theme switching. Most need no restart.
- 🖥️ **[DeepSeek Harness Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)** — 为 DeepSeek Harness 生态打造的现代化桌面端。不用配置 Node.js，也不用敲命令，就能启动和管理本机的 Harness 服务。后续还会支持插件市场、移动端远程控制和 IM Channels。[官网](https://www.dshdesktop.cn)
  A desktop front end for DeepSeek Harness. Start and manage the Harness service on your own machine without installing Node.js or running a command. A plugin market, remote control from a phone, and IM channels are on its roadmap. [Site](https://www.dshdesktop.cn)

## Star History

<a href="https://www.star-history.com/?repos=liustack%2Fmodlens&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=liustack/modlens&type=date&theme=dark&legend=top-left&sealed_token=oQQAwrPffo9WRUsM6P4RnEu4ZdRART3ChPwIkavGtAfrMycGmLYdjuM2uJ4gjnoIyaF_MDwhOBkJlzmS8pT_W9IRDlsCqLafe7gwvw7Vcnr5MRTkczOasg" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=liustack/modlens&type=date&legend=top-left&sealed_token=oQQAwrPffo9WRUsM6P4RnEu4ZdRART3ChPwIkavGtAfrMycGmLYdjuM2uJ4gjnoIyaF_MDwhOBkJlzmS8pT_W9IRDlsCqLafe7gwvw7Vcnr5MRTkczOasg" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=liustack/modlens&type=date&legend=top-left&sealed_token=oQQAwrPffo9WRUsM6P4RnEu4ZdRART3ChPwIkavGtAfrMycGmLYdjuM2uJ4gjnoIyaF_MDwhOBkJlzmS8pT_W9IRDlsCqLafe7gwvw7Vcnr5MRTkczOasg" />
 </picture>
</a>

## 免责声明

本项目依下方 MIT 协议按现状提供。作者不对任何特定用途（含商业使用）提供保证或背书。上游引擎（Antigravity CLI，Gemini、OpenAI、Anthropic 的 API，以及任何 OpenAI 兼容端点）的使用受各自条款和额度约束，由使用者负责。

## License

MIT
