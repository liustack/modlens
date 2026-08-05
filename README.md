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

DeepSeek-V4-Flash gives you a lot of model for very little money: fast, cheap, capable, and blind. It is not just DeepSeek either. Any text-only model running inside Codex, Claude Code, Pi, or OpenCode hits the same wall: you throw it a screenshot of an error and it sees nothing.

ModLens gives it sight, and **you just paste**. Every other bridge makes you save the image to a file and then mention the path in the chat. ModLens pulls the pasted image back out of session storage instead. What comes back is not "this is a screenshot of an error", it is evidence you can quote: every word in the image transcribed, the layout cut into regions in reading order, and the entities and relations on screen listed separately.

No model swap, no prompt surgery, no local proxy. It starts with no key at all.

![A text-only model hands an image to the vision engine through the modlens skill and gets structured JSON evidence back](https://raw.githubusercontent.com/liustack/modlens/main/assets/flow.en.png)

## Three steps

**1. Install the skill.** Tell your agent (Claude Code, Codex, OpenClaw, and Cursor all take this):

```text
Install the skill from https://github.com/liustack/modlens
```

Or do it yourself: `npx -y skills add liustack/modlens`

**2. Give it a vision engine.** A free Gemini key from [aistudio.google.com](https://aistudio.google.com) is the fast answer: three minutes, no credit card, 5 to 10 seconds per image.

```bash
modlens config set gemini-api.apiKey <key>
modlens config set provider gemini-api
```

Don't feel like typing those? Tell your agent "set my Gemini key in modlens" and it runs them. Skipping the sign-up is fine too: Antigravity CLI works with no key, it is just slower (15 to 40 seconds) and its free quota is tight.

**3. Use it.** Paste an image, or throw a path at it, and ask anything. The skill fires on its own.

Requirements, in one line: Node 18+ (22.5+ for OpenCode paste recovery), macOS or Linux.

## Why pasting works here and nowhere else

Pasting is handled end to end by the client. The moment an image lands in the chat box it is encoded and sent, and a vision MCP server never gets a chance to step in, which is why their docs can only tell you to save the file and report the path.

ModLens takes the other route. Before those bytes are sent anywhere, the harness has already written them to local session storage. The skill goes there, pulls them back into a real file, and hands that to the vision engine. You do nothing, and the model gets the whole image instead of asking you for a path.

All four harnesses are verified on real machines: Claude Code pinpoints the exact session from its injected session id, Pi stores sessions the same way, OpenCode swaps in SQLite, and Codex's pasted images already carry a temp path, so the path-tag route handles them. Before touching anything, `recover-paste` works out which harness it is running inside (process ancestry, then environment fingerprints) and reads only that harness's storage, so a neighbouring project's old sessions cannot impersonate it. Recovered files are written 0600.

| | Swap in a multimodal model | Vision MCP servers | ModLens |
| :-- | :-- | :-- | :-- |
| Your chosen model | has to change | stays | stays |
| An image pasted into the chat | visible if the model supports it | out of reach, save a file and report the path | handled directly |
| What you get back | the model's own reading | usually a description | full transcription, layout regions, entities and relations, visual clues |
| Where it cannot read | may invent | may invent | says so in `uncertainty` |
| Cost | multimodal model pricing | usually per API call | agy's free quota, or a free Gemini key |
| Setup | change config, change model | install a server, edit config | one CLI or one skill |

The weaknesses sit here too: agy's free tier is a weekly quota and heavy use hits the wall (a free Gemini key sidesteps it). Session storage layouts are each harness's internals with no compatibility promise, so if recovery ever breaks, dragging the file in still works everywhere.

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

Stress test: a scatter plot of 128 models. ModLens pulls out the axes, the log scale, and the highlighted DeepSeek V4 Flash point at $0.028 and score 50, then walks through the cost-performance cutoff line. Dense charts are where vision models usually fold. This one holds.

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

Two more subcommands: `modlens config <init|set|show>` manages providers and keys (details below), and `modlens recover-paste` rescues images pasted into Claude Code, Pi, or OpenCode:

```bash
modlens recover-paste                 # newest pasted image, path printed as JSON
modlens recover-paste --count 3       # the three newest
modlens recover-paste --session <id>  # exact session (skills pass ${CLAUDE_SESSION_ID})
modlens recover-paste --harness pi    # force one harness's format
# --transcript <path> overrides everything; --cwd <dir> sets the project directory
```

Recovered images are written 0600 into a 0700 directory, so nobody else on a shared machine can read them. Locating a session checks the cwd recorded inside the transcript as well as the directory, because directory slugs collide (`/tmp/a.b` and `/tmp/a-b` produce the same one) and without that check you can be handed a neighbouring project's images.

## Providers and config

ModLens ships five vision providers. `antigravity-cli` stays the default: zero keys, pure free quota.

| Provider | Needs | Typical speed | Notes |
| :-- | :-- | :-- | :-- |
| `antigravity-cli` (default) | `agy` signed in | 15-40s | free quota, full agent loop, quota is tight (see below) |
| `gemini-api` (recommended) | free AI Studio key | 5-10s | fastest free route, schema enforced server-side |
| `openai` | baseUrl + apiKey + model | endpoint-dependent | any OpenAI-compatible multimodal endpoint (qwen-vl, GLM, ...) |
| `anthropic` | `ANTHROPIC_API_KEY` | a few seconds | Claude Haiku by default, schema via forced tool call |
| `claude-cli` | Claude Code signed in | 20-45s | no key, rides your Claude subscription, Read-only permissions |

`antigravity-cli` wins on needing no key and loses on both other fronts: it's slower (a full agent loop takes 15-40 seconds against 5-10 for `gemini-api` direct) and its quota is tight. The free tier is now a one-time weekly grant, pooled across the desktop app, the CLI, and the SDK, and parallel subagents drain it faster. Once it's gone you wait out the cycle: we hit that wall ourselves and the message read "94 hours until reset." Great for a first look, but `gemini-api` is what holds up day to day.

Config lives in `~/.modlens/config.json`. Environment variables override the file (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`), and CLI flags override everything.

```bash
modlens config init                          # write a starter config
modlens config set gemini-api.apiKey <key>   # saved with 0600 perms
modlens config show                          # keys come out masked
modlens config set provider gemini-api       # switch the default provider
```

The free Gemini key takes three minutes at [aistudio.google.com](https://aistudio.google.com), no credit card.

You don't actually have to remember any of these commands. The skill ships a per-provider setup guide, so once it's installed you can just ask your agent: "how do I configure modlens," "set my Gemini key in modlens," "switch modlens to claude-cli." It reads the guide and runs them.

## Using it in Codex (DeepSeek and friends)

Codex speaks only the Responses API, and DeepSeek's official endpoint supports it natively. Start with the [official integration guide](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/): its `models.json` declares deepseek-v4-flash as text-only (`input_modalities: ["text"]`), and that one line is what unlocks the whole flow.

One catch: once text-only is declared, the Codex TUI **blocks Ctrl+V image paste outright** (`Model deepseek-v4-flash does not support image inputs`). The gate sits in the input box itself, so the image never makes it into the message. Two moves get around it, both verified end to end with deepseek-v4-flash:

- **Drag the image file into the terminal**, or type its path. The path lands as plain text, and the modlens skill picks it up from there.
- Attach it with `codex exec -i image.png "..."`. The skill reads the path out of the message tag.

## Using it in Claude Code, Pi, and OpenCode (gateway models)

No setup needed: drag the image file into the terminal, or type its path, and the skill takes over.

Paste is trickier. If you run a text-only model behind `ANTHROPIC_BASE_URL`, Claude Code never writes pasted images to a regular temp file and has no modality switch. A pasted image reaches the model as a pathless `[Unsupported Image]` placeholder (lenient gateways like DeepSeek's Anthropic endpoint) or breaks the request outright ([#62009](https://github.com/anthropics/claude-code/issues/62009)). But the bytes are not gone: Claude Code appends every user message, images included, to the local session transcript before the gateway ever sees it, and that is what `modlens recover-paste` exploits: it pulls the images back out and prints real file paths, ready for `modlens -i`. The skill runs this automatically the moment it spots the placeholder.

Transcripts are per-session files, so skills can pass the exact one via `--session` (Claude Code substitutes `${CLAUDE_SESSION_ID}` into skill text since v2.1.9). Without it, recovery picks the transcript holding the newest pasted image by message timestamp, so concurrent sessions in the same project do not confuse it either way.

[Pi](https://github.com/earendil-works/pi) stores sessions the same way (`~/.pi/agent/sessions/`, images as base64 in JSONL). [OpenCode](https://github.com/sst/opencode) keeps them in SQLite instead (`~/.local/share/opencode/opencode.db`, images as data URLs, reading it needs Node 22.5+ for node:sqlite).

`recover-paste` first identifies the harness it is running inside, by walking the process ancestry and checking env fingerprints (`CLAUDECODE`, `PI_CODING_AGENT`, `CODEX_THREAD_ID`), and reads only that harness's storage, so one tool's stale sessions can never hijack another tool's paste. In Claude Code it targets the exact session from the injected session id. In Codex it refuses outright and points back to the path tag. Only when detection comes up empty does it fall back to racing all three stores by newest image timestamp.

Verified live in all four harnesses: Claude Code recovers the paste via its injected session id, OpenCode runs the whole loop on DeepSeek with the skill firing on its own, Pi stays scoped to its own store, and Codex is refused with the path-tag guidance. One honest caveat: transcript layouts are internal implementation details of those tools with no compatibility promise. If recovery ever breaks, dragging the file still works everywhere.

Pointing OpenCode at DeepSeek takes two lines of setup: `opencode auth login`, pick DeepSeek and paste your key (it lands in `~/.local/share/opencode/auth.json`), then set the default model in `~/.config/opencode/opencode.jsonc` to `deepseek/deepseek-v4-flash`. Pi reads its key from `~/.pi/agent/auth.json`.

## Why a bridge instead of a multimodal model?

- **Keep your model.** You picked DeepSeek-V4-Flash (or gpt-oss, or whatever else) for its price and its reasoning, not its eyesight. ModLens adds sight without touching that choice.
- **Evidence beats pixels.** Text models reason best over structured text, not raw pixels. ModLens hands them the transcribed words, the segmented layout, and the extracted meaning, not a base64 blob.
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
