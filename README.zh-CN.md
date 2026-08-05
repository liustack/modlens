<div align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/banner.jpg" width="100%" alt="ModLens，给纯文本 LLM 外挂视觉" />
  <h1>ModLens</h1>
  <p><b>免费给你的大语言模型（纯文本 LLM）外挂视觉能力。</b></p>
  <p>
    <a href="https://www.npmjs.com/package/@liustack/modlens"><img src="https://img.shields.io/npm/v/@liustack/modlens" alt="npm"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  </p>
  <p><a href="./README.md">English</a></p>
</div>

DeepSeek-V4-Flash 碗大又好吃，速度快，性能强，要说唯一的缺点就是没有多模态。不仅 DeepSeek-V4-Flash，只要是纯文本语言模型，跑在 Codex、Claude Code、Pi Agent、OpenClaw 中，都有这个问题。

ModLens 用最轻的方式解决它：不动你的配置，不装本地代理，就是一个视觉外挂，CLI 和 skill 两种用法。它产出的不是一句话描述，是结构化的视觉证据：文字、版面、区块、实体、关系、视觉线索。视觉引擎有五个可选，默认那个零 key 就能跑，最快的那个用免费 Gemini key，识图能力连 Fable 5 都吊打。原理如下：

![纯文本模型经 modlens skill 把图片交给视觉引擎，回来的是结构化 JSON 证据](https://raw.githubusercontent.com/liustack/modlens/main/assets/flow.zh.png)

- **你直接粘贴就行。** 别的方案让你先存成文件再报路径，ModLens 从会话存储里把粘贴的图捞回来。
- **给的是证据，不是印象。** OCR 全文、按阅读顺序排好的版面区块、语义实体、视觉线索，模型能引用具体内容。
- **读不准就说读不准。** 拿不准的地方进 `uncertainty`，不编。像素坐标和置信度分数这两样模型最爱编的，v2 直接删了。
- **不换模型，不改配置，不装代理。** 你选 DeepSeek 图的是价格和推理，不是视力，这个选择不用动。
- **零 key 起步，想快就领个免费 key。** agy 不要 key，AI Studio 的免费 Gemini key 三分钟到手，识图 5-10 秒。
- **装一次，四家 harness 通用。** Claude Code、Codex、Pi、OpenCode 都验证过。

**环境要求**：Node 18+（OpenCode 的粘贴恢复需要 22.5+），macOS 或 Linux。 出问题看[故障排查](docs/troubleshooting.md)，里面按报错原文列了每一条的成因和解法。

## 你可以直接粘贴图片

别的方案让你先把图存成文件，再在对话里报一句路径。ModLens 让你直接粘贴。

这不怪它们偷懒。粘贴这个动作从头到尾是客户端办的，图一进对话框就被转码发走，识图 MCP server 连插手的机会都没有，所以它们的文档只能教你存文件、报路径。ModLens 走的是另一条路：图片字节在发走之前，早被 harness 原样写进了本地会话存储，skill 直接去那里把它捞回来落成文件，再喂给视觉引擎。你什么都不用做，模型拿到的是完整图片，不是一句「麻烦告诉我路径」。

四家 harness 真机验证过：Claude Code 按注入的会话 ID 精确定位，Pi 的存储路数和它同构，OpenCode 换成了 SQLite，Codex 的粘贴图本来就带临时路径，走路径标签就行。动手之前 `recover-paste` 会先认清自己跑在哪一家（查进程祖先链，核对环境变量指纹），只读那一家的存储，别家的旧会话冒充不了。

放在一起看更清楚：

| | 换个多模态模型 | 识图类 MCP server | ModLens |
| :-- | :-- | :-- | :-- |
| 你选的模型 | 得换掉 | 不用换 | 不用换 |
| 粘贴进对话的图 | 模型支持就能看 | 接不住，文档让你先存文件报路径 | 直接接住 |
| 拿到手的是什么 | 模型自己的理解 | 通常是一段描述 | OCR 全文、版面区块、语义、视觉线索 |
| 读不准的地方 | 可能编 | 可能编 | 进 `uncertainty`，明说读不准 |
| 花费 | 多模态模型的价格 | 多数按 API 计费 | agy 免费额度，或免费 Gemini key |
| 上手 | 改配置换模型 | 装 server、改配置 | 一个 CLI 或一个 skill |

诚实说短板：agy 的免费额度是周配额，重度用会撞墙（换成免费 Gemini key 就绕开了）。会话存储格式是各家 harness 的内部实现，没有兼容承诺，哪天捞不动了，拖文件永远是保底。

## 快速开始

**1. 装 skill。** 直接告诉你的 agent（Claude Code、Codex、OpenClaw、Cursor 等）：

```text
安装这个 skill https://github.com/liustack/modlens
```

或者自己动手：

```bash
npx -y skills add liustack/modlens
```

各家 harness 找 skill 的位置不一样：Claude Code 读 `~/.claude/skills/`，Codex 读 `~/.codex/skills/`，Pi 和 OpenCode 读 `~/.agents/skills/`。软链接在哪家都好使，把 skill 目录链一次，各家永远用最新版。

**2. 接一个视觉引擎。** 推荐去 [aistudio.google.com](https://aistudio.google.com) 领个免费 Gemini key，三分钟，不要信用卡，出图 5-10 秒：

```bash
modlens config set gemini-api.apiKey <key>
modlens config set provider gemini-api
```

懒得敲这两行？跟 agent 说一句「帮我把 Gemini key 配进 modlens」，它自己会跑。

不想注册也行，装上 Antigravity CLI 就能零 key 开跑，代价是慢（15-40 秒），免费额度也紧：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy    # 浏览器完成登录后退出
```

**3. 用起来。** 粘贴一张图，或者甩个图片路径，随便问。skill 自己会触发。

## 看看效果

```bash
npx @liustack/modlens -i workflow.jpg
```

真实输出（已截断）：

```json
{
  "image": "/Users/leon/projects/liustack/assets/loop.jpg",
  "provider": "antigravity-cli",
  "result": {
    "summary": "A workflow diagram with four nodes connected by labeled arrows.",
    "ocr": {
      "full_text": "/shaping\nBEFORE YOU BUILD\n\n/coding\nWHILE YOU BUILD\n\nIT BREAKS\n/dig\nROOT CAUSE FIRST\n...",
      "lines": [
        { "language": "en", "text": "/shaping" },
        { "language": "en", "text": "BEFORE YOU BUILD" }
      ]
    },
    "layout": {
      "regions": [
        {
          "reading_order": 1,
          "text": "/shaping BEFORE YOU BUILD",
          "type": "other"
        }
      ]
    },
    "uncertainty": []
  },
  "meta": { "model": "gemini-3.6-flash-low", "durationSeconds": 25.4 }
}
```

整条链路在 Codex 桌面 App 里跑起来是这样：丢一张推文截图，纯文本的 DeepSeek-V4-Flash 通过 ModLens 读出了全部内容：配文、互动数据（2.9K 回复、270K 点赞、5M 浏览）、连图片的 alt 文字都没放过。分辨率不够的地方，它老实说读不清，不瞎编。

![纯文本 DeepSeek 通过 ModLens 读出推文截图的全部细节](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-app.png)

批量也不在话下：一次丢三张插画进去，模型自己说「三张图我都用 modlens 视觉桥接逐张读取」，21 秒后逐张交卷，连画面的设计意图都点出来了。

![纯文本 DeepSeek 通过 ModLens 一次读完三张图](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-batch.png)

压力测试：一张 128 个模型的智能对成本散点图。ModLens 读出双轴、对数刻度，把高亮的 DeepSeek V4 Flash 精准拎出来（成本约 $0.028、智能指数 50），还讲明白了性价比斩杀线。密集图表是识图模型最容易露怯的地方，这一关它扛住了。

![纯文本 DeepSeek 通过 ModLens 读 128 个模型的散点图](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-chart.png)

## CLI 参数

```bash
modlens -i <图片路径或 URL> [选项]
```

| 参数                      | 含义                              | 默认值                 |
| :------------------------ | :-------------------------------- | :--------------------- |
| `-i, --input <path\|url>` | 要解析的图片（必填）              |                        |
| `-o, --output <path>`     | 同时把 JSON 写入文件              |                        |
| `-m, --model <name>`      | provider 模型                     | `gemini-3.6-flash-low` |
| `-p, --provider <name>`   | 视觉 provider                     | `antigravity-cli`      |
| `--prompt <text>`         | 额外关注点，比如 `"重点提取表格"` |                        |
| `--timeout <ms>`          | provider 超时                     | `180000`               |
| `--provider-bin <path>`   | provider 可执行文件               | `agy`                  |
| `--workdir <path>`        | provider 运行目录                 |                        |

截图信息密集或文档难啃，换成 `-m gemini-3.1-pro-high`。输出契约见 [skills/modlens/references/output-schema.md](skills/modlens/references/output-schema.md)。

另外两个子命令：`modlens config <init|set|show>` 管 provider 和 key（下文详述），`modlens recover-paste` 抢救粘贴进 Claude Code、Pi、OpenCode 的图片：

```bash
modlens recover-paste                 # 捞最新一张，路径以 JSON 打印
modlens recover-paste --count 3       # 捞最近三张
modlens recover-paste --session <id>  # 精确会话（skill 会传 ${CLAUDE_SESSION_ID}）
modlens recover-paste --harness pi    # 强制按某家宿主的格式解析
# --transcript <path> 优先级最高，--cwd <dir> 指定项目目录
```

恢复出来的图片写成 0600、放进 0700 目录，共享机器上别人读不到。定位会话时除了目录，还会核对会话记录里写着的真实工作目录，因为目录 slug 会碰撞（`/tmp/a.b` 和 `/tmp/a-b` 算出同一个），不核对就可能把隔壁项目的图交给你。

## Provider 与配置

ModLens 内置五个视觉 provider，默认还是 `antigravity-cli`：零 key，纯免费额度。

| Provider | 需要什么 | 速度 | 说明 |
| :-- | :-- | :-- | :-- |
| `antigravity-cli`（默认） | `agy` 登录过 | 15-40 秒 | 免费额度，完整 agent 循环，额度紧（见下文） |
| `gemini-api`（推荐） | 免费 AI Studio key | 5-10 秒 | 最快的免费路线，服务端强制 schema |
| `openai` | baseUrl + apiKey + model | 看端点 | 任何 OpenAI 兼容的多模态端点（qwen-vl、GLM 等） |
| `anthropic` | `ANTHROPIC_API_KEY` | 几秒 | 默认 Claude Haiku，强制工具调用保 schema |
| `claude-cli` | Claude Code 已登录 | 20-45 秒 | 零 key，吃你的 Claude 订阅额度，只放行 Read 工具 |

`antigravity-cli` 胜在零 key，输在两头：慢（完整 agent 循环 15-40 秒，`gemini-api` 直连 5-10 秒），额度紧。它的免费档如今是一次性发放的周配额，桌面应用、CLI、SDK 共用一个池子，subagent 并行还加倍消耗，用超了得等下个周期（我们实测撞过一次，提示「94 小时后重置」）。所以它适合尝鲜，日常主力还是 `gemini-api` 稳。

配置放在 `~/.modlens/config.json`，环境变量能盖过它（`GEMINI_API_KEY`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`ANTHROPIC_API_KEY`），CLI 参数最大。

```bash
modlens config init                          # 生成配置骨架
modlens config set gemini-api.apiKey <key>   # 落盘即 0600 权限
modlens config show                          # key 打码显示
modlens config set provider gemini-api       # 换默认 provider
```

免费 Gemini key 去 [aistudio.google.com](https://aistudio.google.com) 领，三分钟，不要信用卡。

这些命令你其实一条都不用记。skill 自带一份分 provider 的配置手册，装完之后直接问你的 agent：「modlens 怎么配置」「帮我把 Gemini key 配进 modlens」「把默认 provider 切成 claude-cli」，它照着手册自己跑完。

## 在 Codex 里用（DeepSeek 等纯文本模型）

Codex 只认 Responses API，DeepSeek 官方端点原生支持。先照着[官方集成文档](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex)配好：它的 `models.json` 把 deepseek-v4-flash 声明成纯文本（`input_modalities: ["text"]`），这一行就是解锁下面整条链路的钥匙。

有个坑要注意：声明纯文本之后，Codex TUI 会**直接拦下 Ctrl+V 粘贴图片**（报错 `Model deepseek-v4-flash does not support image inputs`），闸门卡在输入框那一层，图片压根到不了消息里。能用的招数有两个，都拿 deepseek-v4-flash 端到端验证过：

- **把图片文件拖进终端**，或者手打路径。路径以纯文本形式落进消息，modlens skill 接着从这里接手。
- 用 `codex exec -i 图片.png "..."` skill 从这里把路径抠出来。

## 在 Claude Code、Pi、OpenCode 里用（网关接第三方模型）

不用任何配置：把图片文件拖进终端，或手打路径，skill 直接接手。

粘贴要多说两句。走 `ANTHROPIC_BASE_URL` 网关跑纯文本模型时，Claude Code 粘贴的图片从不写普通临时文件，也没有声明模型无视觉的开关，粘贴的图要么变成一个不带路径的 `[Unsupported Image]` 占位符到达模型（DeepSeek 的 Anthropic 兼容端点这类宽容网关），要么直接把请求搞挂（[#62009](https://github.com/anthropics/claude-code/issues/62009)）。但图片字节没有蒸发：Claude Code 在网关看到消息之前，就把每条用户消息（含图片）原样写进了本地会话记录，`modlens recover-paste` 干的就是把它们捞回来、落成真实文件路径，直接喂给 `modlens -i`。skill 看到占位符会自动跑这一步。

会话记录本来就是一个会话一个文件，skill 可以通过 `--session` 传入精确会话（Claude Code 从 v2.1.9 起会把 `${CLAUDE_SESSION_ID}` 替换进 skill 文本）。不传时按消息时间戳挑「持有最新粘贴图」的那份，两条路都不怕同项目并发多开。

[Pi](https://github.com/earendil-works/pi) 的会话存储和它同构（`~/.pi/agent/sessions/`，图片以 base64 存 JSONL）。[OpenCode](https://github.com/sst/opencode) 换了个存法，图片以 data URL 塞进 SQLite（`~/.local/share/opencode/opencode.db`，读它需要 Node 22.5+ 的 node:sqlite）。

`recover-paste` 会先搞清楚自己正跑在哪家宿主里（沿进程祖先链往上找，再核对 `CLAUDECODE`、`PI_CODING_AGENT`、`CODEX_THREAD_ID` 这些环境变量指纹），然后只读那一家的存储，别家的陈年会话再也没机会冒充。在 Claude Code 里还会直接用注入的会话 ID 精确定位，在 Codex 里则干脆拒绝执行并把你指回 path tag。实在识别不出来才退回按最新图片时间戳在三家赛跑。

四家宿主全部活体验证过：Claude Code 靠注入的会话 ID 精确捞回粘贴，OpenCode 上 DeepSeek 全程自动触发 skill 跑完整条链路，Pi 只认自家存储不受别家污染，Codex 被拒之门外并指回 path tag。一句老实话：会话记录格式是这些工具的内部实现，没有兼容承诺，哪天捞不动了，拖文件永远是保底。

OpenCode 接 DeepSeek 只要两步：`opencode auth login` 选 DeepSeek 贴上 key（落在 `~/.local/share/opencode/auth.json`），再把 `~/.config/opencode/opencode.jsonc` 的默认模型设成 `deepseek/deepseek-v4-flash`。Pi 的 key 放 `~/.pi/agent/auth.json`。

## 为什么外挂，而不是换多模态模型？

- **模型不用换。** 你选 DeepSeek-V4-Flash（或 gpt-oss，或别的什么）图的是价格和推理能力，不是视力。ModLens 只加视力，不碰这个选择。
- **证据强过像素。** 文本模型最会在结构化文本上推理，不是盯着原始像素。ModLens 递过去的是 OCR 加版面加语义，都是解好码的证据，不是一坨 base64。
- **引擎会死，桥不会死。** v1 跑在 Gemini CLI 免费档上，2026 年 6 月被 Google 一刀切停掉。v2 换到继任者 Antigravity CLI，还是同一个 provider 接口，下次再换引擎，改一个文件就行，不用重写。

姊妹项目 ModSearch 用同一招补上联网搜索和网页抓取：[liustack/modsearch](https://github.com/liustack/modsearch)。

## 插入一条硬广告

本项目由 LIUSTACK Skills 驱动，ModLens v2 从需求成形、编码到交付，全程用 **[liustack](https://github.com/liustack/liustack)** 驱动：动手前 `shaping` 捋清楚，编码时 `coding` 上纪律，出问题 `dig` 挖根因，交接时 `snapshot` 留快照。比 Superpowers 更轻，也更强。

**ModLens 给你的模型装上眼睛，LIUSTACK Skills 给你的开发工作流装上翅膀：**

```bash
npx -y skills add liustack/liustack -g
```

⭐ 好用的话，给 [ModLens](https://github.com/liustack/modlens) 和 [liustack](https://github.com/liustack/liustack) 各点一个 star。star 是下一个开发者找到它们的方式。

## 安全说明

- ModLens 调用 `agy` 时带上 `--dangerously-skip-permissions`，因为 prompt/print 模式不带这个参数在某些场景会失败。提示词已经把 agent 限定在只读那一张图，并要求把图片内容当数据看，绝不当指令执行。即便如此，也只解析你自己敢打开的图片，尽量在沙箱化的工作目录里跑。
- 视觉输出是证据，引擎读不准的地方会进 `uncertainty`，而不是被编出来凑数。v2 把像素坐标和置信度分数都删了，因为模型会瞎编这两样。

## 免责声明

仅供个人学习与实验，不用于商业用途。Antigravity CLI 的使用受你自己的 Google 账号条款和额度约束。

## License

MIT
