<div align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/banner.jpg" width="100%" alt="ModLens，给纯文本 LLM 外挂视觉" />
  <h1>ModLens</h1>
  <p><b>给纯文本 LLM 外挂一双眼睛，免费。</b></p>
  <p>
    <a href="https://www.npmjs.com/package/@liustack/modlens"><img src="https://img.shields.io/npm/v/@liustack/modlens" alt="npm"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  </p>
  <p><a href="./README.md">English</a></p>
</div>

DeepSeek-V4-Flash 便宜又能打，可惜是个瞎子。甩一张截图过去，只换来两手一摊。Claude Code、OpenClaw、Codex，随便哪个 Agent Skills 宿主里跑着的纯文本模型，都卡在这同一个死结上。

一条命令解开这个死结。把 ModLens 指向任意图片（本地路径或 URL），它吐出纯文本模型真正用得上的结构化 JSON 证据：OCR 文字、按阅读顺序排好的版面区块、实体、关系、视觉线索。真正「看」图这件事，交给 [Antigravity CLI](https://antigravity.google)（`agy`）去干，用的是 Google 的免费额度，不碰你的 API 账单。

```text
你的纯文本模型 ──▶ modlens skill（遇到图片自动触发）
                        │
                        ▼
             agy · Gemini 3.6 Flash（免费额度）
                        │
                        ▼
           结构化 JSON 证据 ──▶ 模型带着视力回答
```

skill 装一次，你的 agent 以后见着图片自己就处理了。模型不用换，API key 不用要，提示词也不用改。

## 快速开始

**1. 安装 Antigravity CLI 并登录**（一次性）：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy    # 浏览器完成登录后退出
```

**2. 安装 skill。** 直接告诉你的 agent（Claude Code、Codex、OpenClaw、Cursor 等）：

```text
Install the skill from https://github.com/liustack/modlens
```

或者自己动手：

```bash
npx -y skills add liustack/modlens
```

**3. 用起来。** 往对话里丢一个图片路径，随便问。模型需要眼睛的时候，skill 自动触发。

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
    "layout": { "regions": [ { "reading_order": 1, "text": "/shaping BEFORE YOU BUILD", "type": "other" } ] },
    "uncertainty": []
  },
  "meta": { "model": "gemini-3.6-flash-low", "durationSeconds": 25.4 }
}
```

一次运行 15-40 秒。JSON 结构由 provider 层的 schema 硬性保证，你的 agent 不用再从 markdown 里抠 JSON 出来。

## CLI 参数

```bash
modlens -i <图片路径或 URL> [选项]
```

| 参数 | 含义 | 默认值 |
| :-- | :-- | :-- |
| `-i, --input <path\|url>` | 要解析的图片（必填） | |
| `-o, --output <path>` | 同时把 JSON 写入文件 | |
| `-m, --model <name>` | provider 模型 | `gemini-3.6-flash-low` |
| `-p, --provider <name>` | 视觉 provider | `antigravity-cli` |
| `--prompt <text>` | 额外关注点，比如 `"重点提取表格"` | |
| `--timeout <ms>` | provider 超时 | `180000` |
| `--provider-bin <path>` | provider 可执行文件 | `agy` |
| `--workdir <path>` | provider 运行目录 | |

截图信息密集或文档难啃，换成 `-m gemini-3.1-pro-high`。输出契约见 [skills/modlens/references/output-schema.md](skills/modlens/references/output-schema.md)。

## 在 Codex 里用（DeepSeek 等纯文本模型）

Codex 只认 Responses API，DeepSeek 官方端点原生支持。先照着[官方集成文档](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex)配好：它的 `models.json` 把 deepseek-v4-flash 声明成纯文本（`input_modalities: ["text"]`），这一行就是打通下面整条链路的钥匙。

有个坑要注意：声明纯文本之后，Codex TUI 会**直接拦下 Ctrl+V 粘贴图片**（报错 `Model deepseek-v4-flash does not support image inputs`），闸门卡在输入框那一层，图片压根到不了消息里。能用的招数有两个，都拿 deepseek-v4-flash 端到端验证过：

- **把图片文件拖进终端**，或者手打路径。路径以纯文本形式落进消息，modlens skill 接着从这里接手。
- 用 `codex exec -i 图片.png "..."` 附件方式：Codex 在内核层就把像素剥掉了，但留了一个 `<image name=[Image #1] path="/tmp/....png">` 文本标签，skill 从这个标签里把路径抠出来。

不配 `models.json`（裸的自定义模型配置）的话，Codex 会默认你的模型能看图，把图片原样发过去，能不能扛住全看服务商脾气好不好。拖文件这一招，换到哪个宿主都稳。

## 为什么外挂，而不是换多模态模型？

- **模型不用换。** 你选 DeepSeek-V4-Flash（或 gpt-oss，或别的什么）图的是价格和推理能力，不是视力。ModLens 只加视力，不碰这个选择。
- **证据强过像素。** 文本模型最会在结构化文本上推理，不是盯着原始像素。ModLens 递过去的是 OCR 加版面加语义，都是解好码的证据，不是一坨 base64。
- **引擎会死，桥不会死。** v1 跑在 Gemini CLI 免费档上，2026 年 6 月被 Google 一刀切停掉。v2 换到继任者 Antigravity CLI，还是同一个 provider 接口，下次再换引擎，改一个文件就行，不用重写。

姊妹项目 ModSearch 用同一招补上联网搜索和网页抓取：[liustack/modsearch](https://github.com/liustack/modsearch)。

## 用 liustack 打造

ModLens v2 从需求成形、编码到交付，全程用 **[liustack](https://github.com/liustack/liustack)** 跑完。四个 Agent Skills，一个闭环：动手前 `shaping` 捋清楚，编码时 `coding` 上纪律，出问题 `dig` 挖根因，交接时 `snapshot` 留快照。比 Superpowers 更轻，也更锋利。

**ModLens 给你的模型装上眼睛，liustack 给你的整个工作流装上纪律：**

```bash
npx -y skills add liustack/liustack -g
```

⭐ 好用的话，给 [ModLens](https://github.com/liustack/modlens) 和 [liustack](https://github.com/liustack/liustack) 各点一个 star。star 是下一个开发者找到它们的方式。

## 安全说明

- ModLens 调用 `agy` 时带上 `--dangerously-skip-permissions`，因为 print 模式不带这个参数就不执行工具调用。提示词已经把 agent 限定在只读那一张图，并要求把图片内容当数据看，绝不当指令执行。即便如此，也只解析你自己敢打开的图片，尽量在沙箱化的工作目录里跑。
- 视觉输出是证据，不是圣旨。引擎读不准的地方会进 `uncertainty`，而不是被编出来凑数。v2 把像素坐标和置信度分数都删了，因为模型会瞎编这两样。

## 免责声明

仅供个人学习与实验，不用于商业用途。Antigravity CLI 的使用受你自己的 Google 账号条款和额度约束。

## License

MIT
