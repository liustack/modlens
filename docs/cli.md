---
summary: 'CLI manual: flags, the failover chain, guard and doctor subcommands, config keys'
read_when:
  - Running the CLI by hand instead of through the skill
  - Looking up a flag, a default model, or a subcommand
---

# ModLens CLI manual

English | [中文](cli.zh-CN.md)

The skill drives this CLI through its launcher. This page is for running it directly.

## Direct usage

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

`meta` records how the result was produced: when (`generatedAt`), which `model` (`null` when the provider ran one it never named, as `kimi-cli` does with kimi's own default), the provider's `conversationId` when it has one, wall-clock `durationSeconds`, and the raw `usage` the provider reported (shape varies by provider, `null` when none). `attempts` lists every provider the failover chain tried, in order, with failure reasons; `warnings` carries routing notices (failovers, ignored extraBody, whose quota an auto-mode read spent).

## Flags

`modlens analyze` (the default command):

| Flag | Meaning | Default |
| :-- | :-- | :-- |
| `-i, --input <path\|url>` | Image to analyze (required) | |
| `-p, --provider <name>` | Pin exactly one provider, no fallback | the failover chain (below) |
| `-m, --model <name>` | Provider model | per provider (below) |
| `-o, --output <path>` | Also write JSON to a file | |
| `--prompt <text>` | Extra focus | |
| `--timeout <ms>` | Provider timeout | `180000` |
| `--provider-bin <path>` | Provider binary path | `agy` / `claude` |
| `--workdir <path>` | Working directory for the provider | a fresh isolated directory per run |
| `--extra-body <json>` | JSON merged into the API request body, e.g. `'{"thinking":{"type":"disabled"}}'` | the provider's `extraBody` from the config |

`--extra-body` is how vendor-specific knobs get through, turning thinking off
being the common one. It applies to the three API providers and replaces the
configured `extraBody` for that run. Per-vendor spellings and the fields it
refuses to touch are in [Configuration](../skills/modlens/references/configure.md).

The default `-m` model depends on the provider:

| Provider | Default model |
| :-- | :-- |
| `antigravity-cli` (default) | `gemini-3.6-flash-low` |
| `gemini-api` | `gemini-3.6-flash` |
| `anthropic` | `claude-haiku-4-5-20251001` |
| `claude-cli` | `haiku` |
| `kimi-cli` | whatever kimi is configured with |
| `openai` | none, `-m` is required |

`modlens recover-paste`:

| Flag | Meaning | Default |
| :-- | :-- | :-- |
| `--count <n>` | How many recent pasted images to recover | `1` |
| `--out-dir <path>` | Where to write recovered images | a fresh private `<tmpdir>/modlens-paste-*` per run |
| `--session <id>` | Session id for exact targeting | auto-detect |
| `--transcript <path>` | Explicit transcript `.jsonl` or `.db` (overrides `--session`) | |
| `--harness <name>` | Force storage scope: `claude-code`, `pi`, `opencode`, `none` | auto-detect |
| `--cwd <path>` | Project directory the image was pasted in | current directory |

Six providers: `antigravity-cli` (no key), `gemini-api` (fastest free route), `openai` (any OpenAI-compatible multimodal endpoint), `anthropic`, `claude-cli` (uses your existing Claude subscription), and `kimi-cli` (uses your existing Kimi Code subscription, and runs only when named, never as a failover peer). Without `-p`, a run tries every provider that is set up, inline API providers first (5-10s), then the agents; the first good result wins and `meta.attempts` records the rest. Harnesses granted via `reuse.<harness>` contribute reused engines to the same regions (pi credentials inline, agent CLIs behind), with no priority over the user's own; details and the `guards` deny/allow lists are in [Configuration](../skills/modlens/references/configure.md).

Other subcommands:

- `modlens guard [--model <id>]`: should the engine run for the active model at all? Exit 0 allow, 1 deny, verdict as JSON.
- `modlens config <init|set|show>`: `set` with the value omitted on an `apiKey` field prompts for it with the echo hidden, so the key never enters argv, shell history, or the conversation with an agent driving the terminal. It also accepts one piped line (`pbpaste | modlens config set openai.apiKey`), which keeps the key out of argv, though whatever produced that pipe is still your own command to keep out of history. Keys are `provider`, `proxy` (HTTP/HTTPS proxy for the API providers, `HTTPS_PROXY`/`HTTP_PROXY` also honored), `cooldown` (`on` or `off`, on by default), `reuse.<claude|codex|opencode|pi|grok>`, `guards.<denyModels|allowModels|denyWhenUnknown>`, and `<provider>.<apiKey|baseUrl|model|proxy|extraBody>`, plus `openai.structuredOutput` (that route only). A provider proxy URL overrides the shared route. An explicit empty provider proxy, for example `modlens config set openai.proxy ""`, forces that provider to connect directly. `apiKey` accepts a comma-separated list and rotates after authentication, rate-limit, or quota failures.
- `modlens state clear`: forget every provider cooldown in `~/.modlens/state.json`, so all providers are tried at full priority again.
- `modlens doctor`: Node and node:sqlite, provider readiness (including API key counts), the failover chains for this machine, the cooldown switch and any cooling keys, the detected harness, the guard's rules with a live verdict, and the Reuse section with per-harness grant decisions and discovered vision. Spends no quota; `--json` for a machine-readable report.
