---
summary: '宿主接入：图片在 Codex、Claude Code、Pi、OpenCode 中如何抵达模型'
read_when:
  - 在某个具体的编码 agent 里安装配置 modlens
  - 粘贴的图片没有抵达模型
  - 了解 recover-paste 在各 harness 里分别做什么
---

# 宿主接入

[English](harness-setup.md) | 中文

粘贴的图片最终落在哪里，每个 harness 都不一样，modlens 在每个 harness 里走的路线也不同。`recover-paste` 会检测自己运行在哪个 harness 里（先看进程祖先，再看环境变量指纹），只读取该 harness 的存储。

## Codex

粘贴的图片会落成真实的临时文件，消息里带着形如 `<image name=[Image #1] path="/tmp/xxxx.png">` 的标签。skill 直接从标签里读出路径。`recover-paste` 检测到 Codex 后会拒绝执行，并把你指回这个标签。

纯文本模型有一个坑：一旦 `models.json` 声明了 `input_modalities: ["text"]`，Codex TUI 会直接拦下 Ctrl+V 粘贴。改为把文件拖进终端、手动输入路径，或使用 `codex exec -i image.png "..."`。

## Claude Code、Pi、OpenCode

这三家都不像 Codex 那样递给模型一个可用的临时文件路径（较新的 Claude Code 版本确实会把粘贴写进自己的 `~/.claude/image-cache/`，但只在终端入口以路径行的形式注入），不过三者都会在网关剥离图片之前，把用户消息完整存在本地：

| Harness | 存储位置 | 说明 |
| :-- | :-- | :-- |
| Claude Code | `~/.claude/projects/<slug>/<session>.jsonl` | 图片以 base64 存储。注入的 `CLAUDE_CODE_SESSION_ID` 可精确定位当前 session |
| Pi | `~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl` | 结构与 Claude Code 相同 |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite，图片以 data URL 存储（通过 `node:sqlite` 读取） |

在 Claude Code 里通过 `ANTHROPIC_BASE_URL` 接入纯文本模型时，粘贴的图片要么变成一个不带路径的 `[Unsupported Image]` 占位符（宽松的网关），要么直接让请求报错（[#62009](https://github.com/anthropics/claude-code/issues/62009)）。图片字节并没有丢，`recover-paste` 取回的就是它。

## skill 的存放位置

| Harness | skill 读取位置 |
| :-- | :-- |
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| Pi、OpenCode | `~/.agents/skills/` |

这些位置都支持符号链接，把 skill 目录链接一次，每个 agent 用的就都是最新版本。

## 平台支持

macOS 和 Linux 完整支持，并在 CI 上以 Node 22 和 24 验证。

Windows 跑同一套 CI 矩阵。那里没有 `ps`，检测会跳过进程祖先这一步，退回到上面的环境变量指纹，所以一个什么指纹都不设的 harness 会被判为未检出（用 `--harness` 或 `MODLENS_HARNESS` 强制指定）。OpenCode 的粘贴恢复在 Windows 上有覆盖，包括 [#11](https://github.com/liustack/modlens/issues/11) 里的路径分隔符归一化：opencode 记录的 `session.directory` 用正斜杠，而那里的 `path.resolve` 返回反斜杠，匹配前两边都会归一化。JSONL 存储（Claude Code、Pi）以 `os.homedir()` 和各 harness 自己的磁盘 slug 为键，在 POSIX 上验证。外部引擎（Antigravity CLI、Claude CLI）只在有 Windows 版本的平台上运行。

## 网关配置

OpenCode 接 DeepSeek：执行 `opencode auth login`，选择 DeepSeek 并粘贴 key（会存进 `~/.local/share/opencode/auth.json`），然后在 `~/.config/opencode/opencode.jsonc` 里把默认模型设为 `deepseek/deepseek-v4-flash`。Pi 从 `~/.pi/agent/auth.json` 读取它的 key。

## DeepSeek Harness（dsh）

dsh 与其他 harness 不同：modlens 以原生工具的形式接入，而不是靠提示词触发的 skill。本包自身就是一个 dsh bundle，一条命令即可装进某个 profile：

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @liustack/modlens@3.25.4
```

这会注册一个 `modlens_read_image` 工具，它的 schema 随每次请求抵达模型（不靠触发启发式），运行同一个包里自带的 modlens CLI，并把结构化证据作为工具的标准 JSON 输出返回。引擎、复用授权和 guard 规则仍在 `~/.modlens/config.json` 里，与其他所有 harness 共享。dsh 还在开发者预览阶段，插件接口可能变化。这个插件刻意保持很小的接触面（原生工具注册、视觉变体所用的 llm 适配层、附件读取器，以及一个 agent 执行前钩子），其中任何一处变动，它都会大声报错而不是无声退化。

### 在网页界面里配置引擎

dsh 的网页用户面前没有终端，所以引擎设置有一张卡片，在**设置 → 插件 → 插件配置**里：用哪个引擎读图、它的密钥、地址、模型和代理方式，以及一次读取可以借用本机哪些已有登录。展开时会探测本机，只列出真正找到的 harness，让授权是在真实选项之间做选择，而不是面对五个名字。

这些值仍然住在 `~/.modlens/config.json`，与其他所有 harness 共享：卡片通过一条回环路由读写那个文件，所以在这里改一笔，和 `modlens config set` 改的是同一笔。卡片从不拿到已保存的密钥或代理地址，只知道密钥有没有，以及代理是继承、直连还是使用专属地址。密钥或代理输入框留空就不动已存的值。在插件配置行里设 `settingsCard: false` 可以连同路由一起去掉它。

卡片自己的文案跟随 dsh 的界面语言设置，你在 dsh 里切换语言，卡片跟着切。dsh 版本太旧、拿不到这个设置时，退回跟随浏览器语言。失败时服务端回的那句话保持原样（例如未知引擎、打不开的路径），那是诊断信息，不是界面文案。

### 保持更新

modlens 发布很频繁，而两种安装形态都会冻结在装进来的那个版本上。dsh 上重跑一遍安装即可，版本号要点名：

```sh
npx -y @deepseek-ai/dsh plugin --profile <name> add @liustack/modlens@3.25.4
```

`npm view @liustack/modlens version` 可以查到当前版本号，本页的版本号则由发布流程自动写入。

这条命令里有两处是刻意的。用 `add` 而不是 `update`，因为 `update` 只在已记录的 semver 范围内挪动，而普通安装写进去的是 caret 范围，所以一个当初装到 2.7.1 的 profile 只会更新到 2.8.0，永远进不了 3.x。点名版本号而不用 `@latest`，则是因为 pnpm 11 会扣住最近 24 小时内发布的版本（`minimumReleaseAge`，默认开启），dist-tag 只在通过过滤的候选里解析：`@latest` 会落到更旧的版本上，而不是跳过冷静期。代价是一天的自然时间，不是一个版本，发布密集的一周里就是好几个版本。点名版本是一次明确的指定，所以 pnpm 会装上它，11.1.3 起还会把这一个版本作为已批准的例外写进该 profile 的 `pnpm-workspace.yaml`，其余一切仍留在窗口后面。

重启 dsh，然后确认实际装到了什么：

```sh
npx -y @deepseek-ai/dsh plugin --profile <name> list
```

更严格的情况（你自己配过 `minimumReleaseAge`，pnpm 会拒绝而不是批准）见[故障排查](troubleshooting.zh-CN.md#dsh-提示-declares-no-dshbundle--installed-as-a-plain-dependency)。

skill 类 harness 上，skill 是一个拷贝出来的文件夹，拷贝会保留安装时的版本，重跑安装原地覆盖即可。`modlens doctor` 会读出它能找到的每一份拷贝里钉住的版本，并标出落后于当前 CLI 的那些，让版本漂移在坑到人之前就先暴露出来。

### 会话里已经有图片时

会话里存在图片附件时,dsh 会拒绝切换到声明模态不含图片的模型,普通的 DeepSeek 纯文本条目都在此列。这条规则是 dsh 的,而且站得住:纯文本模型确实收不了带图片块的历史,而 `(modlens vision)` 变体之所以能切过去,靠的不是声明了图片输入,而是它在发请求时把那些块转成证据文本,普通条目没有这层转换（[#40](https://github.com/liustack/modlens/issues/40)）。

走上面第一条粘贴路线就不会遇到:图片变成文件路径,会话里从不存在附件,模型选择器也就不会被锁住。只有在变体或视觉模型上粘贴时才会产生附件,而那种场景下附件本来就是目的。

### 给其他插件作者：向 `(modlens vision)` 路由注入图片

包装路由声明的 `inputModalities: ['text', 'image']` 是承诺，不是装饰（[#74](https://github.com/liustack/modlens/issues/74)）。请求里的每一个 `image` 块，无论来自用户粘贴还是其他插件注入（包括嵌在 tool result 里的），都会在请求时转成结构化证据文本，再发往 text-only 上游。没有任何内容被静默丢弃，所以「声明 image 就注入原生图片块，否则注入文件路径」这条分支不用区分对面是真视觉模型还是 modlens 包装。

唯一前提：块必须带宿主附件引用，即 `ctx.attachments.saveImage` 返回、Web UI 粘贴产生的那种形状，插件靠 `ctx.attachments.readImage(block.attachment)` 取字节。手搓的只含路径或 base64 的块会落进固定的读取失败占位。另外不要在声明 image 的路由上给图片块旁边再附路径文本：块在这里已经变成完整证据，多出的路径会诱导模型用工具把同一张图再读一遍，双倍配额，还产生同一内容的第二种措辞，正是 [#68](https://github.com/liustack/modlens/issues/68) 清除过的前缀缓存抖动。

### 粘贴转路径（paste-to-path，web profile）

过去在 dsh Web UI 里，**纯文本模型**下粘贴图片会死在图片准入检查这一步。插件现在带了一个浏览器端半边（由 dsh 的客户端插件系统自动加载），恰好在这种情况下接管粘贴：图片字节发到插件在 dsh web 服务器上的 `/modlens/paste` 路由（仅回环地址，校验 magic byte，上限 25 MB），落成一个私有临时文件，输入框收到的则是纯文本的文件路径。这与 Pi、OpenCode、Claude Code 递给模型的形态一致，也正是 modlens skill 和 `modlens_read_image` 工具的首要触发条件。消息里不带图片附件，准入检查根本不会触发。

接管是有条件的，且裁决权在 host 一侧：浏览器半边先向插件路由询问当前选中的模型是否纯文本，host 用 provider 注册表里声明的模型元数据（`inputModalities`）回答，而不是靠名称猜。`(modlens vision)` 变体和任何声明支持图片输入的模型都保留原生粘贴流程（变体在发请求时转换且保留缩略图，视觉模型自己读图），host 认不出的模型同样不接管：在 host 确认该接管之前，粘贴一律走原生路径。模型元数据里没有声明输入模态的，一律算认不出：元数据缺失绝不当成「已确认纯文本」。裁决还有 60 秒时效，模型中途变了会重新问询，不会永远信旧答案。在插件配置行里设 `pasteToPath: false` 可整体关掉这个功能：策略端点 404 时浏览器半边彻底停手。若路由在裁决确认后中途消失，失败结果返回前那个短暂窗口（一次本地往返）内发生的粘贴会丢失，之后客户端清空全部裁决，后续粘贴一律走原生路径。
