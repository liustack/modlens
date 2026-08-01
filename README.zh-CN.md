<div align="center">
  <h1>ModLens</h1>
  <p><b>给纯文本 LLM 外挂一双眼睛，免费。</b></p>
  <p>
    <a href="https://www.npmjs.com/package/@liustack/modlens"><img src="https://img.shields.io/npm/v/@liustack/modlens" alt="npm"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  </p>
  <p><a href="./README.md">English</a></p>
</div>

你最喜欢的模型聪明但失明。DeepSeek-V4-Flash 便宜得离谱，推理又漂亮，可你贴一张截图过去，它只能两手一摊：没有视觉。跑在 Claude Code、OpenClaw、Codex 或任何 Agent Skills 宿主里的纯文本模型，都是同一个故事。

ModLens 用一条命令解决这件事。指向任意图片（本地路径或 URL），它返回纯文本模型真正能推理的结构化 JSON 证据：OCR 文字、按阅读顺序排列的版面区块、实体、关系、视觉线索。「看」这件事交给 [Antigravity CLI](https://antigravity.google)（`agy`），用的是 Google 的免费额度，不动你的 API 账单。

```text
你的纯文本模型 ──▶ modlens skill（遇到图片自动触发）
                        │
                        ▼
             agy · Gemini 3.6 Flash（免费额度）
                        │
                        ▼
           结构化 JSON 证据 ──▶ 模型带着视力回答
```

装一次 skill，你的 agent 从此自己处理图片。不换模型，不要 API key，不用改提示词。

## 快速开始

**1. 安装 Antigravity CLI 并登录**（一次性）：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy    # 浏览器完成登录后退出
```

**2. 安装 skill**，直接告诉你的 agent（Claude Code、Codex、OpenClaw、Cursor 等）：

```text
Install the skill from https://github.com/liustack/modlens
```

或者自己动手：

```bash
npx -y skills add liustack/modlens
```

**3. 用起来。** 往对话里丢一个图片路径，随便问。模型需要眼睛时，skill 自动触发。

## 看看效果

```bash
npx @liustack/modlens -i workflow.jpg
```

真实输出（截断）：

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

单次运行 15-40 秒。JSON 结构由 provider 层的 schema 强制保证，你的 agent 再也不用从 markdown 里抠 JSON。

## CLI 参数

```bash
modlens -i <图片路径或URL> [选项]
```

| 参数 | 含义 | 默认值 |
| :-- | :-- | :-- |
| `-i, --input <path\|url>` | 要解析的图片（必填） | |
| `-o, --output <path>` | 同时把 JSON 写入文件 | |
| `-m, --model <name>` | provider 模型 | `gemini-3.6-flash-low` |
| `-p, --provider <name>` | 视觉 provider | `antigravity-cli` |
| `--prompt <text>` | 额外关注点，如 `"重点提取表格"` | |
| `--timeout <ms>` | provider 超时 | `180000` |
| `--provider-bin <path>` | provider 可执行文件 | `agy` |
| `--workdir <path>` | provider 运行目录 | |

内容密集的截图或难啃的文档，换 `-m gemini-3.1-pro-high`。输出契约见 [skills/modlens/references/output-schema.md](skills/modlens/references/output-schema.md)。

## 在 Codex 里用（DeepSeek 等纯文本模型）

Codex 只讲 Responses API，DeepSeek 官方端点原生支持。先按[官方集成文档](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex)配置：它的 `models.json` 把 deepseek-v4-flash 声明为纯文本（`input_modalities: ["text"]`），这一行是整条链路的钥匙。

一个提醒：声明纯文本后，Codex TUI 会**直接拦截 Ctrl+V 粘贴图片**（提示 "Model deepseek-v4-flash does not support image inputs"），闸门在输入框层，图片根本进不了消息。可用的姿势有两个，都用 deepseek-v4-flash 端到端实测过：

- **把图片文件拖进终端**（或手打路径）。路径以纯文本进入消息，modlens skill 从这里接管。
- `codex exec -i 图片.png "..."` 附件方式：Codex 在内核层剥掉像素，但保留 `<image name=[Image #1] path="/tmp/....png">` 文本标签，skill 从标签提取路径。

如果没配 `models.json`（裸的自定义模型配置），Codex 会默认你的模型能看图，把图片原样发给 API，能不能活下来全看服务商的宽容度。拖文件这招在任何宿主里都稳。

## 为什么外挂，而不是换多模态模型？

- **模型不用换。** 你选 DeepSeek-V4-Flash（或 gpt-oss，或别的什么）是为了价格和推理能力。ModLens 只加视力，不动这个选择。
- **证据强过像素。** 文本模型最擅长在结构化文本上推理。ModLens 递过去的是 OCR 加版面加语义，不是一坨 base64。
- **引擎会死，桥不会。** v1 跑在 Gemini CLI 免费档上，2026 年 6 月被 Google 停掉。v2 换到继任者 Antigravity CLI，同一个 provider 接口，下次换引擎只改一个文件，不用重写。

姊妹项目 ModSearch 用同样的思路补上联网搜索和网页抓取：[liustack/modsearch](https://github.com/liustack/modsearch)。

## 用 liustack 打造

ModLens v2 从需求成形、编码到交付，全程由 **[liustack](https://github.com/liustack/liustack)** 驱动。四个 Agent Skills，一个闭环：动手前 `shaping` 捋清楚，编码时 `coding` 上纪律，出问题 `dig` 挖根因，交接时 `snapshot` 留快照。比 Superpowers 更轻，也更锋利。

**ModLens 给你的模型装上眼睛，liustack 给你的整个工作流装上纪律：**

```bash
npx -y skills add liustack/liustack -g
```

⭐ 觉得有用？给 [ModLens](https://github.com/liustack/modlens) 和 [liustack](https://github.com/liustack/liustack) 各点一个 star。star 是下一个开发者找到它们的方式。

## 安全说明

- ModLens 调用 `agy` 时带 `--dangerously-skip-permissions`，因为 print 模式不带它就不执行工具。提示词里已把 agent 限制为只读这一张图，并要求把图片内容当数据、绝不当指令。即便如此，只解析你自己敢打开的图片，并尽量在沙箱化的工作目录里运行。
- 视觉输出是证据，不是圣旨：引擎读不清的内容会进 `uncertainty`，而不是被编出来。v2 删掉了像素坐标和置信度分数，因为模型会捏造它们。

## 免责声明

仅供个人学习与实验，请勿用于商业用途。Antigravity CLI 的使用受你自己的 Google 账号条款与额度约束。

## License

MIT
