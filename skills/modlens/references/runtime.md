# modlens runtime reference

How the skill launches the `modlens` CLI, what version it pins, and how it
diagnoses a machine where nothing can run. The launchers `scripts/run.sh`
(macOS / Linux) and `scripts/run.ps1` (Windows) implement everything below and
must stay byte-for-byte identical apart from their version constants and their
shell syntax.

## Pinned version

- Pinned CLI version: 3.26.0
- npm package: `@liustack/modlens`
- CLI binary name: `modlens`

The pinned version line above and the constants inside both launchers are
stamped by `scripts/release.mjs` at release time from `package.json`. Do not
edit them by hand. `scripts/stamp.test.mjs` fails the build if the three
launcher/reference copies ever drift from `package.json`.

## Resolution order

Each call resolves a way to run the CLI, in this order:

1. **A compatible `modlens` already on `PATH`** — run it directly, by name.
2. **`npx` present, and `node` meets the CLI's 22.19 floor** — `npx --yes --package @liustack/modlens@<pinned> modlens <args>`. An npx sitting on an older node is skipped: it would select a path known to fail at run time.
3. **`bunx` present** — `bunx --bun @liustack/modlens@<pinned> <args>`.
4. **A native artifact** — reserved for phase B. None is published yet, so this
   branch reports `nativeArtifact.available: false` and moves on.
5. **Nothing usable** — print a structured diagnosis and exit `78` (`EX_CONFIG`).

The launcher forwards stdin, stdout, stderr, and the exit code unchanged, so the
CLI's JSON output contract is identical however it was launched.

## Compatibility rule

A `modlens` found on `PATH` counts as compatible only when it is **the same
major version as the pinned version and not older than it**. Same major keeps a
user who already installed a matching CLI from being forced through an `npx`
re-download (the "no regression" requirement in the design). Not-older refuses a
stale global build that predates the version this skill was written against; in
that case the launcher skips `PATH` and uses the pinned `npx` / `bunx` version
instead.

## Cache and permissions (phase B, not active yet)

Phase A ships no native artifact. The `npx` and `bunx` paths fetch the pinned
npm package on first use and cache it (that is how those runners work); nothing
else is ever downloaded. When native artifacts land in phase B, the
launchers will cache them per user, keyed by version, and launch them by
absolute path:

- macOS: `~/Library/Caches/liustack/modlens/<version>/`
- Linux: `${XDG_CACHE_HOME:-$HOME/.cache}/liustack/modlens/<version>/`
- Windows: `%LOCALAPPDATA%\liustack\modlens\<version>\`

With these constraints: no `sudo` or admin rights, no system directories, no
`PATH` edits, download to a temp file and verify SHA-256 before an atomic move,
and keep no unverified executable on failure. Any download uses `curl` (on
Windows, `curl.exe` written in full), which does not stamp quarantine or
Mark-of-the-Web, and the launcher never removes a security marker a browser
would have set.

## Diagnostic fields

`run.sh doctor --json` (and `run.ps1 doctor --json`) print this shape:

- `tool`, `package`, `pinnedVersion` — what this skill targets.
- `os`, `arch` — normalized host identity (`darwin` / `linux` / `windows`,
  `arm64` / `x64`).
- `checked.pathCli` — `{ present, path, version, compatible }` for a `modlens`
  on `PATH`, with `compatible` applying the rule above.
- `checked.npx` — `{ present, path, nodeMeetsFloor }`; `nodeMeetsFloor` is whether
  the local node satisfies the CLI's 22.19 floor, required for the npx path.
- `checked.bunx` — `{ present, path }`.
- `checked.node` — `{ present, version }`.
- `nativeArtifact` — `{ available, note }`; `available` is `false` in phase A.
- `selected` — the resolved path: `path`, `npx`, `bunx`, or `none`.
- `nextSteps` — when `selected` is `none`, one or two plain-language actions for
  the user (install Node 22.19+, or Bun); empty otherwise.
- `cliDoctor` — when a CLI is resolvable, the CLI's own `doctor --json` report
  (provider, config, and harness diagnosis) is nested here; `null` otherwise.

`doctor` spends no quota. The launcher's own diagnosis is offline: it inspects
the local environment and makes no network request of its own. Chaining the
CLI's `doctor` through the npx or bunx path can download the pinned package the
first time (that is how those runners work); after that it is served from the
local cache.

One capability note for the bunx path: Bun cannot load `node:sqlite`, which
OpenCode paste recovery needs (unflagged in Node since 22.13), so on a machine
where the launcher resolved to bunx, `recover-paste` for OpenCode requires a
real Node install — 22.19+, since that is the floor this launcher accepts.

## Delivery form: local CLI, long term

modlens stays a local CLI on purpose, and section 10 of the distribution design
(move capabilities to a remote MCP when they need no local execution) does
**not** apply to it. The reasons are the product itself: the vision-provider key
is held on the user's machine, the quota billed is the user's own, and there is
no central service in the middle. modlens also reads local files directly. Its
`recover-paste` pulls pasted images out of the harness's own session storage on
disk, which a remote service structurally cannot reach. A hosted MCP would move
the key and the quota off the user's machine and still could not see those local
files, which is the opposite of what this tool is for. Phase D may retire native
artifacts for some future tool, but modlens keeps its local-CLI form for as long
as those properties hold.
