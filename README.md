<p align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/banner.jpg" width="100%" alt="ModLens" />
</p>

<h1 align="center">ModLens</h1>

<p align="center"><b>Give a text-only model sight, and just paste the image.</b></p>

<p align="center">
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="docs/troubleshooting.md">Troubleshooting</a> ·
  <a href="skills/modlens/references/configure.md">Configuration</a> ·
  <a href="skills/modlens/references/output-schema.md">Output contract</a> ·
  <a href="docs/security.md">Security</a> ·
  <a href="https://github.com/liustack/modsearch">ModSearch (web)</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@liustack/modlens"><img src="https://img.shields.io/npm/v/@liustack/modlens?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
  <a href="https://github.com/liustack/modlens/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/liustack/modlens/ci.yml?branch=main&style=flat-square&label=ci" alt="CI"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@liustack/modlens?style=flat-square" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
</p>

```bash
npx -y skills add liustack/modlens             # install the skill
npx @liustack/modlens -i screenshot.png        # or just use the CLI
```

Models like DeepSeek-V4-Flash are cheap, fast, capable, and blind. Throw one a screenshot of an error and it sees nothing. ModLens turns the image into evidence it can quote, and **you just paste**: every other bridge makes you save a file and report its path, while ModLens pulls the pasted image back out of session storage.

## Highlights

- **Pasting works.** Vision MCP servers cannot catch a paste (the client encodes and sends it the moment it lands), so ModLens reads it from local session storage instead.
- **Evidence, not an impression.** Every word transcribed, layout cut into regions in reading order, entities and relations listed, all of it quotable.
- **It says when it cannot read something.** Uncertain parts land in `uncertainty`. Pixel coordinates and confidence scores, the two things models fabricate most, were dropped in v2.
- **Keep your model.** You picked it for price and reasoning, not eyesight. That choice stays.
- **Starts with no key.** agy needs none. A free Gemini key makes it 5 to 10 seconds per image.
- **Install once, works everywhere.** Verified on real machines in Claude Code, Codex, Pi, and OpenCode.

## Installation

```bash
npx -y skills add liustack/modlens
```

Or tell your agent: "Install the skill from https://github.com/liustack/modlens".

Then give it a vision engine. A free **[AI Studio](https://aistudio.google.com) Gemini key** is the fast answer (three minutes, no credit card, 5 to 10 seconds per image):

```bash
modlens config set gemini-api.apiKey <key>
modlens config set provider gemini-api
```

Skipping the sign-up is fine: **Antigravity CLI** works with no key, it is just slower (15 to 40 seconds) with a tight free quota:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash && agy   # sign in, then exit
```

Requires Node 18+ (22.5+ for OpenCode paste recovery), macOS or Linux.

## Usage

With the skill installed you do not type commands: paste an image or drop a path, ask anything, and it fires on its own. By hand:

```bash
modlens -i screenshot.png                       # local image
modlens -i https://example.com/chart.png        # remote image
modlens -i chart.png --prompt "focus on axes"   # extra focus
modlens recover-paste                           # pull a pasted image into a file
```

Output is a fixed JSON shape:

```json
{
  "image": "/path/to/screenshot.png",
  "provider": "gemini-api",
  "result": {
    "summary": "A workflow diagram with four nodes connected by labeled arrows.",
    "ocr": { "full_text": "/shaping\nBEFORE YOU BUILD\n...", "lines": [] },
    "layout": { "regions": [{ "reading_order": 1, "type": "title", "text": "/shaping" }] },
    "uncertainty": []
  },
  "meta": {
    "generatedAt": "2026-08-06T12:00:00.000Z",
    "model": "gemini-3.6-flash",
    "conversationId": null,
    "durationSeconds": 6.4,
    "usage": { "promptTokenCount": 1234, "candidatesTokenCount": 567 }
  }
}
```

`meta` records how the result was produced: when (`generatedAt`), which `model`, the provider's `conversationId` when it has one, wall-clock `durationSeconds`, and the raw `usage` the provider reported (shape varies by provider, `null` when none).

Inside the Codex desktop app: drop in a tweet screenshot and a text-only DeepSeek reads the caption, the engagement numbers (2.9K replies, 270K likes, 5M views), even the image's alt text. Where the resolution runs out, it says so.

![Text-only DeepSeek reading a tweet screenshot in full detail via ModLens](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-app.png)

## How it works

![A text-only model hands an image to the vision engine through the modlens skill and gets structured JSON evidence back](https://raw.githubusercontent.com/liustack/modlens/main/assets/flow.en.png)

Pasting works here because of a different route. The paste itself is handled end to end by the client: the image is encoded and sent the moment it lands, so an MCP server never gets a chance, which is why their docs tell you to save a file and report the path. But before those bytes go anywhere, the harness has already written them to local session storage, and that is where `recover-paste` goes. Each harness stores them differently (JSONL in Claude Code and Pi, SQLite in OpenCode, real temp files in Codex): see [harness setup](docs/harness-setup.md).

| | Swap in a multimodal model | Vision MCP servers | ModLens |
| :-- | :-- | :-- | :-- |
| Your chosen model | has to change | stays | stays |
| An image pasted into the chat | visible if the model supports it | out of reach | handled directly |
| What you get back | the model's own reading | usually a description | transcription, layout regions, entities |
| Where it cannot read | may invent | may invent | says so in `uncertainty` |
| Cost | multimodal model pricing | usually per API call | agy's free quota or a free Gemini key |

The weaknesses, in the same place: agy's free tier is a weekly quota and heavy use hits the wall (a free Gemini key sidesteps it). Session storage layouts are each harness's internals with no compatibility promise, so if recovery ever breaks, dragging the file in still works everywhere.

## CLI reference

`modlens analyze` (the default command):

| Flag | Meaning | Default |
| :-- | :-- | :-- |
| `-i, --input <path\|url>` | Image to analyze (required) | |
| `-p, --provider <name>` | Vision provider | `antigravity-cli` |
| `-m, --model <name>` | Provider model | per provider (below) |
| `-o, --output <path>` | Also write JSON to a file | |
| `--prompt <text>` | Extra focus | |
| `--timeout <ms>` | Provider timeout | `180000` |
| `--provider-bin <path>` | Provider binary path | `agy` / `claude` |
| `--workdir <path>` | Working directory for the provider | image's directory |

The default `-m` model depends on the provider:

| Provider | Default model |
| :-- | :-- |
| `antigravity-cli` (default) | `gemini-3.6-flash-low` |
| `gemini-api` | `gemini-3.6-flash` |
| `anthropic` | `claude-haiku-4-5-20251001` |
| `claude-cli` | `haiku` |
| `openai` | none, `-m` is required |

`modlens recover-paste`:

| Flag | Meaning | Default |
| :-- | :-- | :-- |
| `--count <n>` | How many recent pasted images to recover | `1` |
| `--out-dir <path>` | Where to write recovered images | `<tmpdir>/modlens-paste` |
| `--session <id>` | Session id for exact targeting | auto-detect |
| `--transcript <path>` | Explicit transcript `.jsonl` or `.db` (overrides `--session`) | |
| `--harness <name>` | Force storage scope: `claude-code`, `pi`, `opencode`, `none` | auto-detect |
| `--cwd <path>` | Project directory the image was pasted in | current directory |

Five providers: `antigravity-cli` (default, no key), `gemini-api` (fastest free route), `openai` (any OpenAI-compatible multimodal endpoint), `anthropic`, and `claude-cli` (rides your Claude subscription). One more subcommand: `modlens config <init|set|show>`.

## Documentation

| Doc | Read it when |
| :-- | :-- |
| [Troubleshooting](docs/troubleshooting.md) | A command failed and the message needs decoding |
| [Configuration](skills/modlens/references/configure.md) | Setting a key, switching providers, fixing config |
| [Output contract](skills/modlens/references/output-schema.md) | Parsing the JSON or building on it |
| [Harness setup](docs/harness-setup.md) | Wiring it into Codex, Claude Code, Pi, or OpenCode |
| [Security](docs/security.md) | File permissions, image content as untrusted input |
| [CHANGELOG](CHANGELOG.md) | Finding what changed in a version |
| [AGENTS.md](AGENTS.md) | Working on this codebase |

## Shameless plug

This project runs on LIUSTACK Skills: `shaping` before you build, `coding` while you build, `dig` when it breaks, `snapshot` when you hand off. Lighter than Superpowers, and stronger.

```bash
npx -y skills add liustack/liustack -g
```

⭐ If it helps, star [ModLens](https://github.com/liustack/modlens) and [liustack](https://github.com/liustack/liustack). Stars are how the next developer finds them.

## Disclaimer

Provided as-is under the MIT License below. The author makes no warranty and gives no endorsement for any particular use, commercial use included. Your use of upstream engines (Antigravity CLI, the Gemini, OpenAI, and Anthropic APIs, and any OpenAI-compatible endpoint) is governed by their own terms and quotas, which you are responsible for.

## License

MIT
