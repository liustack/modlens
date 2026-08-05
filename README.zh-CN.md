<p align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/banner.jpg" width="100%" alt="ModLens" />
</p>

<h1 align="center">ModLens</h1>

<p align="center"><b>给纯文本模型装上视力，而且你直接粘贴就行。</b></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="docs/troubleshooting.md">故障排查</a> ·
  <a href="skills/modlens/references/configure.md">配置</a> ·
  <a href="skills/modlens/references/output-schema.md">输出契约</a> ·
  <a href="docs/security.md">安全</a> ·
  <a href="https://github.com/liustack/modsearch">ModSearch（联网）</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@liustack/modlens"><img src="https://img.shields.io/npm/v/@liustack/modlens?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
  <a href="https://github.com/liustack/modlens/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/liustack/modlens/ci.yml?branch=main&style=flat-square&label=ci" alt="CI"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@liustack/modlens?style=flat-square" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
</p>

```bash
npx -y skills add liustack/modlens                # 装 skill
npx @liustack/modlens -i screenshot.png           # 或者直接当 CLI 用
```

DeepSeek-V4-Flash 这类模型便宜、快、能打，唯独看不见图。你甩过去一张报错截图，它一片漆黑。ModLens 把图读成能引用的证据交给它，而且**你直接粘贴就行**：别的方案都要你先存成文件再报路径，ModLens 从会话存储里把粘贴的图捞回来。

## 亮点

- **粘贴就能用。** 识图类 MCP server 接不住粘贴（图一进对话框就被客户端发走了），ModLens 从本地会话存储里捞。
- **给的是证据，不是印象。** 图里的字一句不落地转录、版面按阅读顺序切块、实体和关系单列，模型能引用具体内容。
- **读不准就说读不准。** 拿不准的地方进 `uncertainty`。像素坐标和置信度分数这两样模型最爱编的，v2 直接删了。
- **模型不用换。** 你选 DeepSeek 图的是价格和推理，不是视力，这个选择不用动。
- **零 key 起步。** agy 不要 key；想快就领个免费 Gemini key，识图 5 到 10 秒。
- **一次装好，处处能用。** Claude Code、Codex、Pi、OpenCode 都在真机上验证过。

## 安装

```bash
npx -y skills add liustack/modlens
```

或者跟你的 agent 说一句「安装这个 skill https://github.com/liustack/modlens」。

再给它一个视觉引擎。推荐 **[AI Studio](https://aistudio.google.com) 的免费 Gemini key**（三分钟，不要信用卡，识图 5 到 10 秒）：

```bash
modlens config set gemini-api.apiKey <key>
modlens config set provider gemini-api
```

不想注册就用 **Antigravity CLI**，零 key，代价是慢（15 到 40 秒）且免费额度紧：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash && agy   # 浏览器登录后退出
```

需要 Node 18+（OpenCode 的粘贴恢复需要 22.5+），macOS 或 Linux。

## 用法

装完 skill 就不用记命令：粘一张图或甩个图片路径，问什么都行，skill 自己触发。手动用：

```bash
modlens -i screenshot.png                      # 本地图片
modlens -i https://example.com/chart.png       # 远程图片
modlens -i chart.png --prompt "重点看数据轴"    # 指定关注点
modlens recover-paste                          # 把刚粘贴的图捞成文件
```

输出是结构固定的 JSON：

```json
{
  "image": "/path/to/screenshot.png",
  "provider": "gemini-api",
  "result": {
    "summary": "四个节点的工作流图，箭头带标注。",
    "ocr": { "full_text": "/shaping\nBEFORE YOU BUILD\n...", "lines": [] },
    "layout": { "regions": [{ "reading_order": 1, "type": "title", "text": "/shaping" }] },
    "uncertainty": []
  }
}
```

Codex 桌面 App 里的实拍：丢一张推文截图，纯文本的 DeepSeek 读出了配文、互动数据（2.9K 回复、270K 点赞、5M 浏览），连图片的 alt 文字都没放过。分辨率不够的地方它老实说读不清。

![纯文本 DeepSeek 通过 ModLens 读出推文截图的全部细节](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-app.png)

## 它是怎么干活的

![纯文本模型经 modlens skill 把图片交给视觉引擎，回来的是结构化 JSON 证据](https://raw.githubusercontent.com/liustack/modlens/main/assets/flow.zh.png)

粘贴之所以只有它接得住，是因为走了另一条路：粘贴从头到尾是客户端办的事，图一进对话框就被转码发走，MCP server 连插手的机会都没有，所以它们只能教你存文件报路径。而图片字节在发走之前，早被 harness 原样写进了本地会话存储，`recover-paste` 直接去那儿捞。四家 harness 的存储各不相同（Claude Code 和 Pi 是 JSONL，OpenCode 是 SQLite，Codex 本来就有临时文件），细节见[宿主接入](docs/harness-setup.md)。

| | 换个多模态模型 | 识图类 MCP server | ModLens |
| :-- | :-- | :-- | :-- |
| 你选的模型 | 得换掉 | 不用换 | 不用换 |
| 粘贴进对话的图 | 模型支持才看得见 | 接不住 | 直接接住 |
| 拿到手的是什么 | 模型自己的理解 | 通常一段描述 | 全文转录、版面区块、实体关系 |
| 读不准的地方 | 可能编 | 可能编 | 进 `uncertainty` |
| 花费 | 多模态模型的价格 | 多数按 API 计费 | agy 免费额度或免费 Gemini key |

短板一并摆这儿：agy 免费额度是周配额，重度用会撞墙（换免费 Gemini key 绕开）。会话存储格式是各家 harness 的内部实现，没有兼容承诺，哪天捞不动了，拖文件永远是保底。

## CLI 参数

| 参数 | 含义 | 默认值 |
| :-- | :-- | :-- |
| `-i, --input <path\|url>` | 要解析的图片（必填） | |
| `-p, --provider <name>` | 视觉 provider | `antigravity-cli` |
| `-m, --model <name>` | provider 模型 | `gemini-3.6-flash-low` |
| `-o, --output <path>` | 同时把 JSON 写入文件 | |
| `--prompt <text>` | 额外关注点 | |
| `--timeout <ms>` | provider 超时 | `180000` |

五个 provider 可选：`antigravity-cli`（默认，零 key）、`gemini-api`（最快的免费路线）、`openai`（任何 OpenAI 兼容多模态端点）、`anthropic`、`claude-cli`（吃你的 Claude 订阅）。另有 `modlens config <init|set|show>` 管配置，`modlens recover-paste` 抢救粘贴的图。

## 文档

| 文档 | 什么时候看 |
| :-- | :-- |
| [故障排查](docs/troubleshooting.md) | 命令报错，想知道成因和解法 |
| [配置手册](skills/modlens/references/configure.md) | 配 key、换 provider、排查配置 |
| [输出契约](skills/modlens/references/output-schema.md) | 要解析 JSON 或写下游工具 |
| [宿主接入](docs/harness-setup.md) | 在 Codex、Claude Code、Pi、OpenCode 里配置 |
| [安全说明](docs/security.md) | 恢复文件的权限、图片内容作为不可信输入 |
| [更新日志](CHANGELOG.md) | 想知道某个版本改了什么 |
| [AGENTS.md](AGENTS.md) | 要改这个项目的代码 |

## 插入一条硬广告

本项目由 LIUSTACK Skills 驱动：动手前 `shaping` 捋清楚，编码时 `coding` 上纪律，出问题 `dig` 挖根因，交接时 `snapshot` 留快照。比 Superpowers 更轻，也更强。

```bash
npx -y skills add liustack/liustack -g
```

⭐ 好用的话给 [ModLens](https://github.com/liustack/modlens) 和 [liustack](https://github.com/liustack/liustack) 各点一个 star。star 是下一个开发者找到它们的方式。

## 免责声明

仅供个人学习与实验，不用于商业用途。Antigravity CLI 的使用受你自己的 Google 账号条款和额度约束。

## License

MIT
