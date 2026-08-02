<div align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/banner.jpg" width="100%" alt="ModLens, plug-in vision for text-only LLMs" />
  <h1>ModLens</h1>
  <p><b>Free plug-in vision for your text-only LLM.</b></p>
  <p>
    <a href="https://www.npmjs.com/package/@liustack/modlens"><img src="https://img.shields.io/npm/v/@liustack/modlens" alt="npm"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  </p>
  <p><a href="./README.zh-CN.md">简体中文</a></p>
</div>

DeepSeek-V4-Flash gives you a lot of model for very little money: fast, strong, and its one real flaw is no multimodal. And it's not just DeepSeek. Every text-only model running inside Codex, Claude Code, Pi Agent, or OpenClaw hits the same wall.

ModLens fixes this the lightest way possible. It never touches your config and never adds a local proxy. It's just a vision plug-in, usable as a CLI or as an Agent Skill, that turns any image into structured visual evidence: text, layout, regions, entities, relations, visual clues. Under the hood it runs on [Antigravity CLI](https://antigravity.google) (`agy`), whose vision comes from free-quota Gemini 3.6 Flash. And Gemini's image understanding is famously good, good enough to embarrass most flagships, Fable 5 included. How it works:

```text
text-only model in your agent harness ──▶ modlens skill (auto-triggers on images)
                              │
                              ▼
                   agy · Gemini 3.6 Flash (free quota)
                              │
                              ▼
              structured JSON evidence ──▶ model answers with sight
```

## Quick start

**1. Install Antigravity CLI and sign in** (one-time):

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy    # opens browser sign-in, then exit
```

**2. Install the skill.** Just tell your agent (Claude Code, Codex, OpenClaw, Cursor, ...):

```text
Install the skill from https://github.com/liustack/modlens
```

or do it yourself:

```bash
npx -y skills add liustack/modlens
```

**3. Use it.** Paste an image path into the CLI and ask anything. The skill fires on its own.

## See it work

```bash
npx @liustack/modlens -i workflow.jpg
```

Real output, truncated:

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

Here is the whole loop inside the Codex desktop app: drop in a tweet screenshot, and a text-only DeepSeek-V4-Flash reads all of it through ModLens: the caption, the engagement numbers (2.9K replies, 270K likes, 5M views), even the image's alt text. Where the resolution runs out, it says so instead of guessing.

![Text-only DeepSeek reading a tweet screenshot in full detail via ModLens](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-app.png)

Batch mode works too: drop three illustrations at once, and the model announces it will read them one by one through ModLens, then delivers all three descriptions in 21 seconds, design intent included.

![Text-only DeepSeek reading three images in one go via ModLens](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-batch.png)

Stress test: a scatter plot of 128 models. ModLens pulls out the axes, the log scale, and the highlighted DeepSeek V4 Flash point at $0.028 and score 50, then walks through the cost-performance cutoff line. Dense charts are where vision models usually fold; this one holds.

![Text-only DeepSeek reading a 128-model scatter plot via ModLens](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-chart.png)

## CLI reference

```bash
modlens -i <image-path-or-url> [options]
```

| Flag | Meaning | Default |
| :-- | :-- | :-- |
| `-i, --input <path\|url>` | Image to analyze (required) | |
| `-o, --output <path>` | Also write JSON to a file | |
| `-m, --model <name>` | Provider model | `gemini-3.6-flash-low` |
| `-p, --provider <name>` | Vision provider | `antigravity-cli` |
| `--prompt <text>` | Extra focus, e.g. `"extract the table"` | |
| `--timeout <ms>` | Provider timeout | `180000` |
| `--provider-bin <path>` | Provider binary | `agy` |
| `--workdir <path>` | Working directory for the provider | |

Reach for `-m gemini-3.1-pro-high` on dense screenshots or tricky documents. Output contract: [skills/modlens/references/output-schema.md](skills/modlens/references/output-schema.md).

## Providers and config

ModLens ships five vision providers. `antigravity-cli` stays the default: zero keys, pure free quota.

| Provider | Needs | Typical speed | Notes |
| :-- | :-- | :-- | :-- |
| `antigravity-cli` (default) | `agy` signed in | 15-40s | free quota, full agent loop |
| `gemini-api` | free AI Studio key | 5-10s | fastest free route, schema enforced server-side |
| `openai` | baseUrl + apiKey + model | endpoint-dependent | any OpenAI-compatible multimodal endpoint (qwen-vl, GLM, ...) |
| `anthropic` | `ANTHROPIC_API_KEY` | a few seconds | Claude Haiku by default, schema via forced tool call |
| `claude-cli` | Claude Code signed in | 20-45s | no key, rides your Claude subscription, Read-only permissions |

Config lives in `~/.modlens/config.json`. Environment variables override the file (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`), and CLI flags override everything.

```bash
modlens config init                          # write a starter config
modlens config set gemini-api.apiKey <key>   # saved with 0600 perms
modlens config show                          # keys come out masked
modlens config set provider gemini-api       # switch the default provider
```

The free Gemini key takes three minutes at [aistudio.google.com](https://aistudio.google.com), no credit card. Or skip the manual work entirely and tell your agent: "configure modlens with my Gemini API key".

## Using it in Codex (DeepSeek and friends)

Codex speaks only the Responses API, and DeepSeek's official endpoint supports it natively. Start with the [official integration guide](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/): its `models.json` declares deepseek-v4-flash as text-only (`input_modalities: ["text"]`), and that one line is what unlocks the whole flow.

One catch: once text-only is declared, the Codex TUI **blocks Ctrl+V image paste outright** (`Model deepseek-v4-flash does not support image inputs`). The gate sits in the input box itself, so the image never makes it into the message. Two moves get around it, both verified end to end with deepseek-v4-flash:

- **Drag the image file into the terminal**, or type its path. The path lands as plain text, and the modlens skill picks it up from there.
- Attach it with `codex exec -i image.png "..."`. The skill reads the path out of the message tag.

## Why a bridge instead of a multimodal model?

- **Keep your model.** You picked DeepSeek-V4-Flash (or gpt-oss, or whatever else) for its price and its reasoning, not its eyesight. ModLens adds sight without touching that choice.
- **Evidence beats pixels.** Text models reason best over structured text, not raw pixels. ModLens hands them OCR plus layout plus semantics, already decoded, not a base64 blob.
- **Engines die, the bridge survives.** v1 ran on Gemini CLI's free tier until Google shut it down in June 2026. v2 moved to its successor, Antigravity CLI, behind the same provider interface, so the next engine swap costs one file, not a rewrite.

ModSearch, ModLens's sibling project, plays the same trick for web search and page fetching: [liustack/modsearch](https://github.com/liustack/modsearch).

## Shameless plug

This project runs on LIUSTACK Skills. ModLens v2 was shaped, coded, and shipped with **[liustack](https://github.com/liustack/liustack)** end to end: `shaping` before you build, `coding` while you build, `dig` when it breaks, `snapshot` when you hand off. Lighter than Superpowers, and sharper.

**ModLens gives your model eyes. LIUSTACK Skills gives your dev workflow wings:**

```bash
npx -y skills add liustack/liustack -g
```

⭐ Like it? [Star ModLens](https://github.com/liustack/modlens) and [star liustack](https://github.com/liustack/liustack). Stars are how the next developer finds them.

## Security notes

- ModLens runs `agy` with `--dangerously-skip-permissions`, because print mode can fail in some setups without it. The prompt keeps the agent to reading that one image and tells it to treat image content as data, never as instructions. Even so, only point it at images you would open yourself, and run it inside a sandboxed workspace when you can.
- Vision output is evidence. Anything the engine cannot read lands in `uncertainty` instead of getting invented. Pixel bounding boxes and confidence scores were dropped in v2 because models fabricate them.

## Disclaimer

Personal learning and experimentation only, not for commercial use. Antigravity CLI usage runs under your own Google account's terms and quota.

## License

MIT
