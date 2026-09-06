---
summary: 'CLI 手册：参数、故障转移链、guard 与 doctor 子命令、配置键'
read_when:
  - 不经 skill 直接手动运行 CLI
  - 查某个参数、默认模型或子命令
---

# ModLens CLI 手册

[English](cli.md) | 中文

skill 通过它的启动器驱动这个 CLI。本页讲的是直接手动运行。

## 直接使用

装好 skill 后不需要敲命令：粘贴图片或给出路径，随便提问，它会自动触发。手动运行：

```bash
modlens -i screenshot.png                       # local image
modlens -i https://example.com/chart.png        # remote image
modlens -i chart.png --prompt "focus on axes"   # extra focus
modlens recover-paste                           # pull a pasted image into a file
```

输出是固定的 JSON 结构：

```json
{
  "image": "/path/to/screenshot.png",
  "provider": "gemini-api",
  "result": {
    "summary": "A workflow diagram with four nodes connected by labeled arrows.",
    "ocr": { "full_text": "/shaping\nBEFORE YOU BUILD\n...", "lines": [] },
    "layout": { "regions": [{ "reading_order": 1, "type": "title", "text": "/shaping" }] },
    "semantics": { "scene": "workflow diagram", "entities": [], "relations": [] },
    "visual": { "dominant_colors": ["white", "black"], "style": "flat", "notes": [] },
    "uncertainty": []
  },
  "meta": {
    "generatedAt": "2026-08-06T12:00:00.000Z",
    "model": "gemini-3.6-flash",
    "conversationId": null,
    "durationSeconds": 6.4,
    "usage": { "promptTokenCount": 1234, "candidatesTokenCount": 567 },
    "attempts": [{ "provider": "gemini-api", "ok": true, "durationSeconds": 6.4 }],
    "warnings": []
  }
}
```

`meta` 记录结果是怎么产生的：什么时间（`generatedAt`）、用了哪个 `model`（provider 跑的是它自己配好、又没告诉我们型号的模型时为 `null`，`kimi-cli` 用 kimi 默认模型就是这种情况）、provider 有会话时的 `conversationId`、实际耗时 `durationSeconds`，以及 provider 上报的原始 `usage`（结构因 provider 而异，没有时为 `null`）。`attempts` 按顺序列出故障转移链尝试过的每个 provider 和失败原因。`warnings` 携带路由通知（故障转移、被忽略的 extraBody、自动模式下这次识别花了谁的额度）。

## 参数

`modlens analyze`（默认命令）：

| 参数 | 含义 | 默认值 |
| :-- | :-- | :-- |
| `-i, --input <path\|url>` | 要分析的图片（必填） | |
| `-p, --provider <name>` | 钉死单个 provider，不回退 | 故障转移链（见下） |
| `-m, --model <name>` | provider 的模型 | 按 provider 而定（见下） |
| `-o, --output <path>` | 同时把 JSON 写入文件 | |
| `--prompt <text>` | 额外关注点 | |
| `--timeout <ms>` | provider 超时 | `180000` |
| `--provider-bin <path>` | provider 可执行文件路径 | `agy` / `claude` |
| `--workdir <path>` | provider 的工作目录 | 每次运行新建的隔离目录 |
| `--extra-body <json>` | 合并进 API 请求体的 JSON，如 `'{"thinking":{"type":"disabled"}}'` | 配置里该 provider 的 `extraBody` |

`--extra-body` 是厂商专属开关的通道，最常见的用途是关掉 thinking。它作用于三个 API provider，并在该次运行中替换配置里的 `extraBody`。各厂商的具体写法和它拒绝改动的字段见[配置手册](../skills/modlens/references/configure.zh-CN.md)。

`-m` 的默认模型取决于 provider：

| Provider | 默认模型 |
| :-- | :-- |
| `antigravity-cli`（默认） | `gemini-3.6-flash-low` |
| `gemini-api` | `gemini-3.6-flash` |
| `anthropic` | `claude-haiku-4-5-20251001` |
| `claude-cli` | `haiku` |
| `kimi-cli` | 用 kimi 自己配好的模型 |
| `openai` | 无，必须传 `-m` |

`modlens recover-paste`：

| 参数 | 含义 | 默认值 |
| :-- | :-- | :-- |
| `--count <n>` | 恢复最近几张粘贴的图片 | `1` |
| `--out-dir <path>` | 恢复出的图片写到哪里 | 每次运行新建的私有 `<tmpdir>/modlens-paste-*` |
| `--session <id>` | 用会话 id 精确定位 | 自动检测 |
| `--transcript <path>` | 显式指定 transcript 的 `.jsonl` 或 `.db`（覆盖 `--session`） | |
| `--harness <name>` | 强制指定存储范围：`claude-code`、`pi`、`opencode`、`none` | 自动检测 |
| `--cwd <path>` | 粘贴图片时所在的项目目录 | 当前目录 |

共六个 provider：`antigravity-cli`（免 key）、`gemini-api`（最快的免费通道）、`openai`（任意 OpenAI 兼容的多模态端点）、`anthropic`，`claude-cli`（复用你现有的 Claude 订阅），以及 `kimi-cli`（复用你现有的 Kimi Code 订阅，只在被点名时运行，绝不作为故障转移备选）。不带 `-p` 时，一次运行会依次尝试每个已配好的 provider：API 快车道（inline API provider，不启动 agent、直接调 API 的引擎）先试（5-10 秒），agent 类兜底，第一个可用结果胜出，其余尝试记录在 `meta.attempts` 里。通过 `reuse.<harness>` 授权的 harness 会把复用来的引擎补进相同的区段（pi 的凭据算快车道，agent CLI 排在后面），不会插到你自己引擎的前面。细节和 `guards` 的 deny/allow 名单见[配置手册](../skills/modlens/references/configure.zh-CN.md)。

其他子命令：

- `modlens guard [--model <id>]`：判断当前激活的模型到底该不该运行引擎。退出码 0 表示放行，1 表示拒绝，判定结果以 JSON 输出。
- `modlens config <init|set|show>`：`set` 在 `apiKey` 字段上省略值会进入不回显的输入提示，密钥不进 argv、不进 shell 历史，也不进你与终端里那个 agent 的对话。它也接受从管道读一行（`pbpaste | modlens config set openai.apiKey`），这样密钥不进 argv，但产生这条管道的命令本身是否留在历史里，由你自己决定。可用的键有 `provider`、`proxy`（API provider 的 HTTP/HTTPS 代理，也认 `HTTPS_PROXY`/`HTTP_PROXY`）、`cooldown`（`on` 或 `off`，默认打开）、`reuse.<claude|codex|opencode|pi|grok>`、`guards.<denyModels|allowModels|denyWhenUnknown>`，以及 `<provider>.<apiKey|baseUrl|model|proxy|extraBody>`，另有 `openai.structuredOutput`（仅这条路线用得上）。provider 的代理地址会覆盖共享代理。显式传入空值，例如 `modlens config set openai.proxy ""`，会让该 provider 强制直连。`apiKey` 接受英文逗号分隔的列表，鉴权、限流或配额失败后会轮换。
- `modlens state clear`：忘掉 `~/.modlens/state.json` 里每一条 provider 冷却，让所有 provider 重新按完整优先级尝试。
- `modlens doctor`：报告 Node 与 node:sqlite、各 provider 的就绪状态（含密钥数量）、本机的故障转移链、冷却开关和正在冷却的密钥、检测到的 harness、guard 规则和一次现场判定，以及 Reuse 一节里按 harness 的授权决定与发现的视觉能力。不花任何额度，`--json` 输出机器可读报告。
