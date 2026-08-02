# Configuring ModLens

Read this when the user asks how to set up, configure, or switch ModLens providers. Prefer running the commands for the user over explaining them.

## Where config lives

`~/.modlens/config.json`, managed by the CLI. Precedence: CLI flags > environment variables > config file > built-in defaults. The default provider with zero config is `antigravity-cli`.

```bash
modlens config init                     # write a starter config (refuses to overwrite; --force to redo)
modlens config show                     # effective file, API keys masked
modlens config set provider <name>      # change the default provider
modlens config set <provider>.<field> <value>   # fields: apiKey, baseUrl, model
```

`config set` writes the file with 0600 permissions.

## Provider setup recipes

### antigravity-cli (default, free, no key)

Needs Antigravity CLI installed and signed in:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy    # user must complete browser sign-in themselves, then exit
```

Any free Google account works; no Google AI Pro needed. Sign-in cannot be automated, ask the user to run `agy` once.

### gemini-api (free key, fastest free route, 5-10s)

1. The user creates a key at https://aistudio.google.com (three minutes, no credit card, free tier does not expire).
2. Store it either way:

```bash
modlens config set gemini-api.apiKey <key>
# or environment: export GEMINI_API_KEY=<key>
```

Default model `gemini-3.6-flash` has vision on the free tier (about 10-15 requests/min, 1500/day). Free-tier data may be used by Google to improve products; mention this if the user handles sensitive images.

### openai (any OpenAI-compatible multimodal endpoint)

Needs three values. Example for DashScope qwen:

```bash
modlens config set openai.baseUrl https://dashscope.aliyuncs.com/compatible-mode/v1
modlens config set openai.apiKey <sk-key>
modlens config set openai.model qwen3.6-27b
```

For official OpenAI: baseUrl `https://api.openai.com/v1`, a vision-capable model. Environment equivalents: `OPENAI_BASE_URL`, `OPENAI_API_KEY`. The model must be multimodal; text-only models will fail or hallucinate. This route has no server-side schema enforcement, so occasional shape failures are surfaced as explicit errors; retry or switch provider.

### anthropic (Claude API key)

```bash
modlens config set anthropic.apiKey <sk-ant-key>
# or: export ANTHROPIC_API_KEY=<key>
```

Default model is Claude Haiku (`claude-haiku-4-5-20251001`). Schema is enforced through a forced tool call.

### claude-cli (Claude Code login, no key)

Rides an existing `claude` sign-in, so it costs the user's Claude subscription quota, not a separate API bill. Requires Claude Code installed and logged in (`claude --version` to check). Runs with `--allowedTools Read` only. Local image files only; for remote URLs use gemini-api instead. Default model alias `haiku`.

```bash
modlens config set provider claude-cli   # make it the default if the user wants
```

## Choosing a provider for the user

- Wants zero setup and free: `antigravity-cli` (needs agy sign-in, 15-40s per image).
- Wants fast and free: `gemini-api` (three-minute key, 5-10s).
- Already pays for Claude: `claude-cli` (no extra key) or `anthropic` (API billing).
- Has a favorite multimodal endpoint (qwen, GLM, ...): `openai`.

## Troubleshooting

- Error names a missing env var or `config set` command: run exactly that.
- `Provider CLI not found: agy`: install Antigravity CLI or switch provider.
- `Claude CLI reported ...` or empty result: check `claude` login state.
- openai route `does not match the vision schema`: retry once, then switch to gemini-api or anthropic.
- `config init` refusing to run: the file exists; use `modlens config show` first, `--force` only if the user agrees to overwrite.
