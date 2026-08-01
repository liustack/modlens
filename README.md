<div align="center">
  <h1>ModLens</h1>
  <p><b>Plug-in eyes for text-only LLMs. Free.</b></p>
  <p>
    <a href="https://www.npmjs.com/package/@liustack/modlens"><img src="https://img.shields.io/npm/v/@liustack/modlens" alt="npm"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  </p>
  <p><a href="./README.zh-CN.md">简体中文</a></p>
</div>

Your favorite model is brilliant but blind. DeepSeek-V4-Flash costs next to nothing and reasons beautifully, yet paste a screenshot and it shrugs: no vision. Same story for every text-only model running inside Claude Code, OpenClaw, Codex, or any Agent Skills harness.

ModLens fixes that with one command. Point it at any image (local path or URL) and it returns structured JSON evidence a text-only model can actually reason over: OCR text, layout regions in reading order, entities, relations, visual clues. The seeing is done by [Antigravity CLI](https://antigravity.google) (`agy`), so it rides Google's free quota, not your API bill.

```text
your text-only model ──▶ modlens skill (auto-triggers on images)
                              │
                              ▼
                   agy · Gemini 3.6 Flash (free quota)
                              │
                              ▼
              structured JSON evidence ──▶ model answers with sight
```

Install the skill once, and your agent handles images by itself. No model switch, no API key, no prompt surgery.

## Quick start

**1. Install Antigravity CLI and sign in** (one-time):

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy    # opens browser sign-in, then exit
```

**2. Install the skill** — tell your agent (Claude Code, Codex, OpenClaw, Cursor, ...):

```text
Install the skill from https://github.com/liustack/modlens
```

or do it yourself:

```bash
npx -y skills add liustack/modlens
```

**3. Use it.** Drop an image path into the chat and ask anything. The skill triggers automatically whenever your model needs eyes.

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

A run takes 15-40 seconds. The JSON structure is enforced by schema at the provider level, so your agent never has to fish JSON out of markdown again.

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

Use `-m gemini-3.1-pro-high` for dense screenshots or hard documents. Output contract: [skills/modlens/references/output-schema.md](skills/modlens/references/output-schema.md).

## Using it in Codex (DeepSeek and friends)

Codex only speaks the Responses API, and DeepSeek's official endpoint supports it natively. Follow the [official integration guide](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) first: its `models.json` declares deepseek-v4-flash as text-only (`input_modalities: ["text"]`), which is the key that unlocks the whole flow.

With that in place, pasted and attached images just work: Codex strips the pixels before they reach your model but keeps a `<image name=[Image #1] path="/tmp/....png">` text tag in the message, and the modlens skill picks the path up from there. Verified end to end with deepseek-v4-flash: the model reads the tag, calls modlens, and answers with full image content.

Without `models.json` (a bare custom-model config), Codex assumes your model accepts images and sends them raw, and whether that survives depends on the provider's lenience. The always-safe move in any harness: skip the paste, drag the image file into the terminal (or type its path) so the path arrives as plain text.

## Why a bridge instead of a multimodal model?

- **Keep your model.** You picked DeepSeek-V4-Flash (or gpt-oss, or whatever) for its price and reasoning. ModLens adds sight without touching that choice.
- **Evidence beats pixels.** Text models reason best over structured text. ModLens hands them OCR plus layout plus semantics, not a base64 blob.
- **Engines die, the bridge survives.** v1 ran on Gemini CLI's free tier until Google shut it down in June 2026. v2 runs on its successor, Antigravity CLI, behind the same provider interface, so the next engine swap is one file, not a rewrite.

ModSearch, the sibling project, does the same trick for web search and page fetching: [liustack/modsearch](https://github.com/liustack/modsearch).

## Built with liustack

ModLens v2 was shaped, coded, and shipped with **[liustack](https://github.com/liustack/liustack)** — four Agent Skills, one loop: `shaping` before you build, `coding` while you build, `dig` when it breaks, `snapshot` when you hand off. A lighter, sharper alternative to Superpowers.

**If ModLens just gave your model eyes, liustack gives your whole workflow discipline:**

```bash
npx -y skills add liustack/liustack -g
```

⭐ Like the idea? [Star ModLens](https://github.com/liustack/modlens) and [star liustack](https://github.com/liustack/liustack). Stars are how the next developer finds them.

## Security notes

- ModLens invokes `agy` with `--dangerously-skip-permissions`, because print mode skips tool calls without it. The prompt restricts the agent to reading the one image, and instructs it to treat image content as data, never as instructions. Still, only analyze images you would open yourself, and prefer running inside a sandboxed workspace.
- Vision output is evidence, not gospel: fields the engine cannot read land in `uncertainty` instead of being invented. Pixel bboxes and confidence scores were removed in v2 because models fabricate them.

## Disclaimer

Personal learning and experimentation only. Not for commercial use. Antigravity CLI usage falls under your own Google account terms and quota.

## License

MIT
