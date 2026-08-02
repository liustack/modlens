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

ModLens 用最轻量级方案解决这个问题。ModLens 不会入侵你的配置，也不会给你添加本地代理，ModLens 只是一个视觉外挂，有 cli 或 skill 两种模式。ModLens 能产出结构化的视觉证据：文字、版面、区块、实体、关系、视觉线索。ModLens 由 Antigravity [Antigravity CLI](https://antigravity.google)（`agy`）驱动，而 Antigravity 的视觉由免费额度的 Gemini 3.6 Flash 驱动。众所周知，Gemini 的识图能力，连 Fable 5 都吊打。原理如下：

```text
Agent Harness 中的纯文本模型 ──▶ modlens skill（遇到图片自动触发）
                        │
                        ▼
             agy · Gemini 3.6 Flash（免费额度）
                        │
                        ▼
           结构化 JSON 证据 ──▶ 模型带着视力回答
```

## 快速开始

**1. 安装 Antigravity CLI 并登录**（一次性）：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy    # 浏览器完成登录后退出
```

**2. 安装 skill。** 直接告诉你的 agent（Claude Code、Codex、OpenClaw、Cursor 等）：

```text
安装这个 skill https://github.com/liustack/modlens
```

或者自己动手：

```bash
npx -y skills add liustack/modlens
```

**3. 用起来。** 在 cli 里粘贴个图片路径，随便问，skill 会自动触发。

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

## Provider 与配置

ModLens 内置五个视觉 provider，默认还是 `antigravity-cli`：零 key，纯免费额度。

| Provider | 需要什么 | 速度 | 说明 |
| :-- | :-- | :-- | :-- |
| `antigravity-cli`（默认） | `agy` 登录过 | 15-40 秒 | 免费额度，完整 agent 循环 |
| `gemini-api` | 免费 AI Studio key | 5-10 秒 | 最快的免费路线，服务端强制 schema |
| `openai` | baseUrl + apiKey + model | 看端点 | 任何 OpenAI 兼容的多模态端点（qwen-vl、GLM 等） |
| `anthropic` | `ANTHROPIC_API_KEY` | 几秒 | 默认 Claude Haiku，强制工具调用保 schema |
| `claude-cli` | Claude Code 已登录 | 20-45 秒 | 零 key，吃你的 Claude 订阅额度，只放行 Read 工具 |

配置放在 `~/.modlens/config.json`，环境变量能盖过它（`GEMINI_API_KEY`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`ANTHROPIC_API_KEY`），CLI 参数最大。

```bash
modlens config init                          # 生成配置骨架
modlens config set gemini-api.apiKey <key>   # 落盘即 0600 权限
modlens config show                          # key 打码显示
modlens config set provider gemini-api       # 换默认 provider
```

免费 Gemini key 去 [aistudio.google.com](https://aistudio.google.com) 领，三分钟，不要信用卡。嫌麻烦就直接跟你的 agent 说一句「帮我把 Gemini key 配进 modlens」，让它自己跑命令。

## 在 Codex 里用（DeepSeek 等纯文本模型）

Codex 只认 Responses API，DeepSeek 官方端点原生支持。先照着[官方集成文档](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex)配好：它的 `models.json` 把 deepseek-v4-flash 声明成纯文本（`input_modalities: ["text"]`），这一行就是打通下面整条链路的钥匙。

有个坑要注意：声明纯文本之后，Codex TUI 会**直接拦下 Ctrl+V 粘贴图片**（报错 `Model deepseek-v4-flash does not support image inputs`），闸门卡在输入框那一层，图片压根到不了消息里。能用的招数有两个，都拿 deepseek-v4-flash 端到端验证过：

- **把图片文件拖进终端**，或者手打路径。路径以纯文本形式落进消息，modlens skill 接着从这里接手。
- 用 `codex exec -i 图片.png "..."` skill 从这里把路径抠出来。

## 在 Claude Code 里用（网关接第三方模型）

不用任何配置：把图片文件拖进终端，或手打路径，skill 直接接手。

粘贴要多说两句。走 `ANTHROPIC_BASE_URL` 网关跑纯文本模型时，Claude Code 粘贴的图片从不写普通临时文件，也没有声明模型无视觉的开关，粘贴的图要么变成一个不带路径的 `[Unsupported Image]` 占位符到达模型（DeepSeek 的 Anthropic 兼容端点这类宽容网关），要么直接把请求搞挂（[#62009](https://github.com/anthropics/claude-code/issues/62009)）。但图片字节没有蒸发：Claude Code 在网关看到消息之前，就把每条用户消息（含图片）原样写进了本地会话记录。`modlens recover-paste` 干的就是这件事：从会话记录里把最近粘贴的图捞回来，落成真实文件路径，直接喂给 `modlens -i`。skill 看到占位符会自动跑这一步。会话记录本来就是一个会话一个文件，recover-paste 按消息时间戳挑「持有最新粘贴图」的那份，同项目并发开多个会话也不会拿错。一句老实话：会话记录格式是 Claude Code 的内部实现，没有兼容承诺，哪天捞不动了，拖文件永远是保底。

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
