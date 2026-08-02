<div align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/banner.jpg" width="100%" alt="ModLens, plug-in vision for text-only LLMs" />
  <h1>ModLens</h1>
  <p><b>Plug-in eyes for text-only LLMs. Free.</b></p>
  <p>
    <a href="https://www.npmjs.com/package/@liustack/modlens"><img src="https://img.shields.io/npm/v/@liustack/modlens" alt="npm"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  </p>
  <p><a href="./README.zh-CN.md">简体中文</a></p>
</div>

DeepSeek-V4-Flash is one of the smartest cheap models you can run, and it's completely blind. Show it a screenshot and it just shrugs. Same dead end for every text-only model wired into Claude Code, OpenClaw, Codex, or any Agent Skills harness.

One command fixes that. Point ModLens at an image, a local path or a URL, and it hands back structured JSON evidence a text-only model can actually reason over: OCR text, layout regions in reading order, entities, relations, visual clues. The seeing itself happens in [Antigravity CLI](https://antigravity.google) (`agy`), so it runs on Google's free quota, not your API bill.

```text
your text-only model ──▶ modlens skill (auto-triggers on images)
                              │
                              ▼
                   agy · Gemini 3.6 Flash (free quota)
                              │
                              ▼
              structured JSON evidence ──▶ model answers with sight
```

Install the skill once and your agent starts handling images on its own. No model swap, no API key, no prompt surgery.

## Quick start

**1. Install Antigravity CLI and sign in** (one-time):

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy    # opens browser sign-in, then exit
```

**2. Install the skill.** Tell your agent (Claude Code, Codex, OpenClaw, Cursor, ...):

```text
Install the skill from https://github.com/liustack/modlens
```

or do it yourself:

```bash
npx -y skills add liustack/modlens
```

**3. Use it.** Drop an image path into the chat and ask anything. The skill fires automatically whenever your model needs eyes.

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
    "layout": { "regions": [ { "reading_order": 1, "text": "/shaping BEFORE YOU BUILD", "type": "other" } ] },
    "uncertainty": []
  },
  "meta": { "model": "gemini-3.6-flash-low", "durationSeconds": 25.4 }
}
```

A run takes 15-40 seconds. The JSON shape is locked in by a schema at the provider level, so your agent never has to fish JSON out of markdown again.

And here is the whole loop inside the Codex desktop app: drop three illustrations at once, and a text-only DeepSeek-V4-Flash announces it will read them one by one through ModLens, then delivers all three descriptions in 21 seconds, design intent included.

![Text-only DeepSeek reading three images in one go via ModLens](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-app.png)

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

## Using it in Codex (DeepSeek and friends)

Codex speaks only the Responses API, and DeepSeek's official endpoint supports it natively. Start with the [official integration guide](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/): its `models.json` declares deepseek-v4-flash as text-only (`input_modalities: ["text"]`), and that one line is what unlocks everything below.

One catch: once text-only is declared, the Codex TUI **blocks Ctrl+V image paste outright** (`Model deepseek-v4-flash does not support image inputs`). The gate sits in the input box itself, so the image never makes it into the message. Two moves get around it, both verified end to end with deepseek-v4-flash:

- **Drag the image file into the terminal**, or type its path. The path lands as plain text, and the modlens skill picks it up from there.
- Attach it with `codex exec -i image.png "..."`. Codex strips the pixels in core but leaves a `<image name=[Image #1] path="/tmp/....png">` text tag behind, and the skill reads the path out of that tag.

Skip `models.json` (a bare custom-model config) and Codex assumes your model can see images, sending them raw, and whether that survives depends on the provider's patience. Dragging the file in is the one move that works everywhere, in every harness.

## Why a bridge instead of a multimodal model?

- **Keep your model.** You picked DeepSeek-V4-Flash (or gpt-oss, or whatever else) for its price and its reasoning, not its eyesight. ModLens adds sight without touching that choice.
- **Evidence beats pixels.** Text models reason best over structured text, not raw pixels. ModLens hands them OCR plus layout plus semantics, already decoded, not a base64 blob.
- **Engines die, the bridge survives.** v1 ran on Gemini CLI's free tier until Google shut it down in June 2026. v2 moved to its successor, Antigravity CLI, behind the same provider interface, so the next engine swap costs one file, not a rewrite.

ModSearch, ModLens's sibling project, plays the same trick for web search and page fetching: [liustack/modsearch](https://github.com/liustack/modsearch).

## Built with liustack

ModLens v2 was shaped, coded, and shipped with **[liustack](https://github.com/liustack/liustack)**. Four Agent Skills, one loop: `shaping` before you build, `coding` while you build, `dig` when it breaks, `snapshot` when you hand off. A lighter, sharper alternative to Superpowers.

**ModLens gave your model eyes. liustack gives your whole workflow discipline:**

```bash
npx -y skills add liustack/liustack -g
```

⭐ Like the idea? [Star ModLens](https://github.com/liustack/modlens) and [star liustack](https://github.com/liustack/liustack). Stars are how the next developer finds them.

## Security notes

- ModLens runs `agy` with `--dangerously-skip-permissions`, because print mode skips every tool call without it. The prompt keeps the agent to reading that one image and tells it to treat image content as data, never as instructions. Even so, only point it at images you would open yourself, and run it inside a sandboxed workspace when you can.
- Vision output is evidence, not gospel. Anything the engine cannot read lands in `uncertainty` instead of getting invented. Pixel bounding boxes and confidence scores were dropped in v2 because models fabricate them.

## Disclaimer

Personal learning and experimentation only, not for commercial use. Antigravity CLI usage runs under your own Google account's terms and quota.

## License

MIT
