// DeepSeek Harness (dsh) plugin: registers a modlens_read_image tool backed
// by the modlens CLI that ships in this very package. dsh models are
// text-only, so the tool is the vision bridge; unlike prompt-triggered
// skills, a registered tool schema reaches the model on every request, so
// there is no trigger gamble. The name is ours rather than the host's
// `read_image` (see the registration in apply, and issue #34).
// The engine is spawned from ../dist/main.js inside this package:
// no PATH lookup, no npx, the plugin and its engine version-lock together.
//
// Loaded via the cordis.patch.yml row `@liustack/modlens/dsh` (see the
// package.json `dsh.bundle` manifest). Providers, reuse grants, and guard
// rules keep living in ~/.modlens/config.json, shared with every harness.
import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnHidden } from './spawnHidden.js'

const CLI_PATH = fileURLToPath(new URL('../dist/main.js', import.meta.url))
// Kept in lockstep with src/schema.ts by a repo test; the plugin file cannot
// import the TS source and stays fully dependency-free (node builtins only).
const OUTPUT_SCHEMA = JSON.parse(readFileSync(new URL('./vision-schema.json', import.meta.url), 'utf8'))

const CLI_TIMEOUT_MS = 180_000
const TOOL_READ_CACHE_LIMIT = 256
const TOOL_READ_FAILURE_COOLDOWN_MS = 60_000
const TOOL_READ_REMOTE_TTL_MS = 60_000
// Shared by both evidence caches. Monotonic time keeps an NTP adjustment from
// extending or collapsing a retry window.
const monotonicNow = () => performance.now()

function toolReadSourceKey(rawSource) {
  const source = rawSource.trim()
  if (/^https?:\/\//i.test(source)) {
    return `remote:${source}`
  }
  try {
    const file = /^file:\/\//i.test(source) ? fileURLToPath(source) : resolve(source)
    const stat = statSync(file, { bigint: true })
    // A path is not an image identity. The inode and nanosecond timestamps
    // make an overwrite or replacement a fresh read while unchanged bytes at
    // the same path stay reusable during a thinking loop.
    return `local:${file}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch {
    // Let the CLI produce the canonical missing-file or invalid-path error.
    // If the file appears later, the successful stat above changes the key.
    return `local-unreadable:${source}`
  }
}

function trimToolReadCache(cache) {
  while (cache.size > TOOL_READ_CACHE_LIMIT) {
    let victim
    for (const [key, entry] of cache) {
      if (entry.state !== 'pending') {
        victim = key
        break
      }
    }
    // In-flight work stays joinable. The cap goes soft only while every
    // candidate is pending, then settlement runs this trim again.
    if (victim === undefined) return
    cache.delete(victim)
  }
}

function cachedToolRead(cache, key, remote, load) {
  const now = monotonicNow()
  let entry = cache.get(key)
  if (entry && entry.expiresAt <= now) {
    cache.delete(key)
    entry = undefined
  }
  if (entry) {
    // Map insertion order is the LRU order.
    cache.delete(key)
    cache.set(key, entry)
    return entry.promise
  }

  entry = { state: 'pending', expiresAt: Number.POSITIVE_INFINITY, promise: undefined }
  const promise = Promise.resolve()
    .then(load)
    .then(
      (value) => {
        if (cache.get(key) === entry) {
          entry.state = 'success'
          entry.expiresAt = remote ? monotonicNow() + TOOL_READ_REMOTE_TTL_MS : Number.POSITIVE_INFINITY
          trimToolReadCache(cache)
        }
        return value
      },
      (error) => {
        if (cache.get(key) === entry) {
          // The same failure is free and stable during the cooldown. A later
          // call probes again, so a recovered engine needs no restart.
          entry.state = 'failure'
          entry.expiresAt = monotonicNow() + TOOL_READ_FAILURE_COOLDOWN_MS
          trimToolReadCache(cache)
        }
        throw error
      },
    )
  entry.promise = promise
  cache.set(key, entry)
  trimToolReadCache(cache)
  return promise
}

export const name = 'modlens'
export const inject = ['tools', 'agents', 'attachments', 'llm']

export const MEDIA_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
}

export function apply(ctx, config = {}) {
  // One evidence cache for the whole plugin: every wrapper route and the
  // auto-read path share it, so the same pasted attachment is read once,
  // whichever surface asks first (issue #68; auto-read used to bypass
  // caching entirely and re-read every image on every step).
  const evidenceCache = new Map()
  // Explicit path-tool calls can repeat inside a small model's thinking loop.
  // Keep their completed evidence beside the attachment cache so the model's
  // repeated decision does not become repeated vision-provider work (#81).
  const toolReadCache = new Map()
  // Off by default since the vision provider converts at request time and
  // keeps the durable log (and the UI thumbnail) intact; turn it on only for
  // setups where images enter through a provider this plugin does not wrap.
  if (config.autoRead === true) {
    registerAutoRead(ctx, evidenceCache)
  }
  // The provider ids this plugin registered itself. The takeover verdict has
  // to skip them: our wrapper models are synthetic twins of upstream ones,
  // carrying the upstream id and declaring image input, so a plain text-only
  // label matches the twin and the twin's declaration vetoes the takeover
  // that label deserved (issue #36). Filled by registerVisionProvider as
  // wrappers land, including the later sweeps, and read by the verdict.
  const ownProviders = new Set()
  if (config.visionProvider !== false) {
    // Bundle loaders can call apply while this outer context is still waiting
    // for its required services. Reading ctx.llm here then throws "inactive
    // context" before the first discovery sweep can register any lifecycle
    // work (#79). Put the whole provider registry inside an injected child
    // scope: Cordis starts it only while llm is active, and tears its listeners
    // and registrations down with that service. Preview hosts without inject
    // keep the dependency-free plugin's former feature-detected path.
    if (typeof ctx.inject === 'function') {
      ctx.inject(['llm'], (scope) => {
        return registerVisionProvider(scope, config, ownProviders, evidenceCache)
      })
    } else {
      registerVisionProvider(ctx, config, ownProviders, evidenceCache)
    }
  }
  // Paste-to-path: the browser half (dsh/client.js) intercepts image pastes
  // and POSTs the bytes here; the file lands in a private temp dir and the
  // path text goes into the composer instead of an image attachment. A
  // text-only model then never trips image admission, and the path is the
  // same trigger shape Pi, OpenCode, and Claude Code hand their models.
  // webServer exists only under the web profile, and this cordis has no
  // optional-inject form, so the route rides a scoped ctx.inject: the closure
  // runs when the service appears and never runs where it does not (headless
  // stays untouched, and the plugin itself never waits on it).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      if (config.pasteToPath !== false) {
        try {
          // scope carries webServer; the plugin's own ctx carries llm for the
          // takeover verdicts.
          registerPasteRoute(scope, ctx, ownProviders, config)
        } catch (error) {
          console.error(`[modlens] paste-to-path route skipped: ${error}`)
        }
      }
      // Same web server, a separate switch: turning paste-to-path off is a
      // statement about how images enter, not about whether the engine can
      // be configured. The card the browser half contributes talks to this
      // route rather than to a settings schema, because modlens config lives
      // in ~/.modlens/config.json and is shared with the CLI and every other
      // harness (issue #39).
      if (config.settingsCard !== false) {
        try {
          registerConfigRoute(scope)
        } catch (error) {
          console.error(`[modlens] settings card route skipped: ${error}`)
        }
      }
    })
  }
  // Since rc.7 the settings page dispatches plugin cards by served settings
  // namespace: a card renders only when its slot key matches a namespace the
  // host answers for in settings.describe (issues #61, #65). The namespace
  // registered here is an empty pass-through object, because its whole job is
  // to make the card dispatchable; the values stay in ~/.modlens/config.json,
  // behind the loopback route above, where every other harness can read them.
  // The schema is duck-typed to what the seam calls on it, callable plus
  // toJSON, the same stance the LlmAdapter takes: importing a dsh package for
  // it would pin this plugin to one harness version. Harnesses without the
  // settings service never run the closure, and their older settings page
  // rendered every registered card anyway.
  if (config.settingsCard !== false && typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (scope) => {
      try {
        const passThrough = (value) => ({ ...(value ?? {}) })
        passThrough.toJSON = () => ({
          uid: 0,
          refs: { 0: { type: 'object', meta: { default: {} }, dict: {} } },
        })
        scope.settings.register('modlens', passThrough, { base: {} })
      } catch (error) {
        console.error(`[modlens] settings namespace skipped: ${error}`)
      }
    })
  }
  // Registered as a raw JSON-Schema tool definition (no dsh package imports:
  // the developer-preview registry accepts these and out-of-tree resolution
  // of @deepseek-ai/dsh-tools is not yet reliable), so this plugin owns its
  // own argument validation inside execute.
  //
  // The name is ours by default (see the registration below): hosts with a
  // durable attachment store mount their own native read_image (dsh-tool-fs),
  // which is gated on the model declaring image input and so refuses the
  // text-only models this plugin exists for. Any registration error degrades
  // loudly instead of taking the vision wrapper down with it (issue #21).
  const readImageTool = (toolName) => ({
    name: toolName,
    description:
      'Read an image through the modlens vision bridge. Use whenever a message references an image the current model cannot see: a local file path or an http(s) URL to a screenshot, photo, chart, diagram, or document scan. Returns structured evidence with every word transcribed (ocr.full_text), layout regions in reading order, semantics, and an uncertainty list. Quote the evidence instead of guessing. For the same image and focus, call this tool once and reuse its returned evidence instead of calling again. Requires a configured modlens engine (run `npx @liustack/modlens doctor` in a terminal to check).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute local file path or http(s) URL of the image',
        },
        prompt: {
          type: 'string',
          description: 'Optional extra focus for the reading (e.g. "focus on the axis labels")',
        },
      },
      required: ['path'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderEvidence(value) }],
    },
    // The CLI enforces its own deadline; this is the cooperative backstop.
    timeoutMs: CLI_TIMEOUT_MS + 20_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: toolName,
      kind: 'read',
      rawInput: args,
      ...(typeof args?.path === 'string' && !/^https?:\/\//i.test(args.path)
        ? { locations: [{ path: args.path }] }
        : {}),
    }),
    async execute(args, exec) {
      if (typeof args?.path !== 'string' || args.path.trim() === '') {
        throw new Error(`${toolName} needs a non-empty string "path".`)
      }
      const sourceKey = toolReadSourceKey(args.path)
      const cacheKey = JSON.stringify([sourceKey, typeof args.prompt === 'string' ? args.prompt : ''])
      const pending = cachedToolRead(toolReadCache, cacheKey, sourceKey.startsWith('remote:'), async () => {
        const cliArgs = [CLI_PATH, '-i', args.path, '--timeout', String(CLI_TIMEOUT_MS)]
        if (args.prompt) {
          cliArgs.push('--prompt', args.prompt)
        }
        // The shared read has the CLI's own deadline but not one caller's
        // signal. A caller may stop waiting without cancelling every other
        // concurrent caller that joined the same image read.
        const { stdout, stderr, code } = await run(process.execPath, cliArgs, undefined)
        if (code !== 0) {
          throw new Error(`modlens failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 500)}`)
        }
        let parsed
        try {
          parsed = JSON.parse(stdout)
        } catch {
          throw new Error(`modlens produced no JSON: ${stdout.trim().slice(0, 300)}`)
        }
        // The canonical value is the vision result itself; routing details
        // (meta.attempts, whose quota a reused engine spent) stay operational.
        return parsed.result
      })
      return structuredClone(await abortableWait(pending, exec.signal))
    },
  })
  // A name of our own rather than the host's. dsh's registry is layered and
  // a scoped tool shadows a global one, so a host `read_image` mounted in the
  // agent-preset scope and ours registered globally are not a duplicate at
  // all: the registration succeeds, nothing throws, and the model still
  // resolves the host's (issue #34). Detecting that from here would mean
  // walking every agent (`agents.list()` plus `agent/created`) and asking
  // `tools.get(name, agent)` per scope, then mutating a global catalog per
  // agent. Not entering the collision is cheaper: no host tool is known to
  // use this name, and the model finds ours through its schema, which reaches
  // it on every request regardless of what the tool is called. `toolName`
  // still pins whatever a host prefers.
  const preferred = config.toolName || 'modlens_read_image'
  try {
    ctx.tools.register(readImageTool(preferred))
  } catch (error) {
    // Same-layer duplicate of the chosen name, or a preview-era surface
    // change: degrade loudly instead of taking the whole plugin down.
    console.error(`[modlens] ${preferred} registration skipped: ${error}`)
  }
}

// Image magic bytes for the paste route: refuse anything that is not a real
// image before a byte touches disk. Mirrors the CLI's sniffing table
// (src/imageInput.ts SNIFFERS) signature for signature: full PNG magic, both
// GIF variants, and ftyp only with a known heic/heif brand — a generic BMFF
// (`ftypmp42`, plain video) must not be saved as an image.
const PASTE_SNIFFS = [
  {
    ext: '.png',
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  { ext: '.jpg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: '.gif',
    test: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)),
  },
  {
    ext: '.webp',
    test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    ext: '.heic',
    test: (b) =>
      b.length >= 12 &&
      b.toString('ascii', 4, 8) === 'ftyp' &&
      ['heic', 'heix', 'hevc', 'hevx'].includes(b.toString('ascii', 8, 12)),
  },
  {
    ext: '.heif',
    test: (b) =>
      b.length >= 12 &&
      b.toString('ascii', 4, 8) === 'ftyp' &&
      ['mif1', 'msf1', 'heif'].includes(b.toString('ascii', 8, 12)),
  },
]
const PASTE_MAX_BYTES = 25 * 1024 * 1024

/**
 * Should the browser take a paste over for the model behind this selector
 * label? Decided here, not in the browser, because only the host holds the
 * structured model metadata: a name regex in the client called every vision
 * model it did not recognize text-only and hijacked its native paste.
 *
 * The label carries no provider id, only prose plus a display name, so the
 * host cannot know WHICH matching model is selected: a longest-match pick
 * was still hijackable (a text route named "Current Pro" outscored a selected
 * vision model named "Pro", because the label's own "current" prose completed
 * the longer name). So no picking at all: the answer is true only when EVERY
 * model whose name or id appears in the label is positively confirmed
 * text-only. One image-capable match anywhere vetoes; a model with no
 * declared inputModalities is UNKNOWN, not text-only; and a provider whose
 * catalog cannot be read is unknown too, a veto rather than a shrug, since the
 * unreadable route is exactly where the vision twin could live. Anything
 * unresolvable answers false: the native path is the safe default, and a
 * text-only model merely keeps its old error message.
 */
// The provider ids registerVisionProvider mints: the legacy deepseek wrap and
// the `modlens-<upstream>` form auto-discovery uses. A sibling instance of
// this plugin derives its ids the same way, which is what makes the pair of
// checks below meaningful. A custom `config.providerId` is outside the
// convention on purpose and is covered by the registered-id set instead.
const OWN_PROVIDER_ID = /^(deepseek-modlens$|modlens-)/

async function pasteTakeoverVerdict(host, label, ownProviders) {
  if (typeof label !== 'string' || label.trim() === '') return false
  // Our own wrappers convert pastes at request time with the thumbnail
  // preserved; taking their paste over would defeat the better path.
  if (/\(modlens vision\)/i.test(label)) return false
  const llm = host.llm
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return false
  }
  const lowered = label.toLowerCase()
  let matchedAny = false
  for (const info of llm.listProviders()) {
    const providerId = info?.id
    if (!providerId) continue
    // Our own wrapper: every model in it is a synthetic twin of an upstream
    // one, carrying that upstream id and declaring image input because that
    // is how the wrapper unlocks admission. Scanning it means a plain
    // text-only label matches the twin by id and the twin vetoes the
    // takeover the real model deserved (issue #36). Only ids this plugin
    // registered itself are skipped, so a real vision provider, including
    // one that happens to be named like ours, still votes.
    if (ownProviders?.has(providerId)) continue
    let models = []
    try {
      models = await llm.listModels(providerId)
    } catch {
      return false
    }
    for (const model of models) {
      // A twin from another instance of this plugin, which the set above
      // cannot know about: a second apply() in the same process hits the
      // duplicate branch, does not claim the id, and would otherwise be
      // vetoed by the first instance's wrapper. Both halves are required.
      // The name marker alone proves nothing, since any provider can put that
      // string in a model name and would then slip past a veto it deserves;
      // the id is what makes it ours, because a sibling instance derives its
      // provider id from the same rule this one does.
      if (
        OWN_PROVIDER_ID.test(providerId) &&
        typeof model?.name === 'string' &&
        /\(modlens vision\)/i.test(model.name)
      ) {
        continue
      }
      for (const candidate of [model?.name, model?.id]) {
        if (typeof candidate !== 'string' || candidate.length === 0) continue
        if (!lowered.includes(candidate.toLowerCase())) continue
        // The veto has no length floor: a vision model named "AI" appears in
        // the label just as legitimately as a long name does, and skipping
        // short names let a longer text-only name confirm the takeover alone.
        const modalities = model?.inputModalities
        if (!Array.isArray(modalities) || modalities.includes('image')) {
          return false
        }
        // Positive confirmation does have a floor: one- and two-character
        // text-only names match label prose far too easily to identify the
        // selected model.
        if (candidate.length >= 3) {
          matchedAny = true
        }
      }
    }
  }
  return matchedAny
}

// Verdicts are stable for the lifetime of a model route but the inventory can
// grow (llm-pi-ai mounts after settings load), so cache briefly, not forever.
const PASTE_VERDICT_TTL_MS = 15_000
const PASTE_VERDICT_CAP = 32

/**
 * The paste route. POST /modlens/paste: image bytes in, `{ path }` out; the
 * file is private (0600) in a fresh unpredictable temp dir, magic-byte
 * checked and size-capped. GET /modlens/paste?model=<selector label>:
 * `{ takeover }`: the browser half asks before ever touching a paste, so a
 * disabled route (pasteToPath: false, or no web profile) means the client
 * stands down instead of swallowing pastes into a 404. Bound to the dsh web
 * server, which listens on loopback by default.
 */
function registerPasteRoute(ctx, host, ownProviders, config = {}) {
  const verdicts = new Map()
  // The cache key is only the selector label, which cannot tell two
  // same-named models on different routes apart. A route mounting mid-TTL
  // (llm-pi-ai lands after settings load) could therefore serve a stale
  // verdict computed before its vision twin existed, so every topology
  // change empties the cache at exactly the boundary that invalidates it.
  // The epoch guards the async gap the clear cannot reach: a verdict whose
  // computation STARTED before the event describes a registry that no longer
  // exists, and without the counter it was written back into the just-
  // emptied cache and served for a full TTL.
  let topologyEpoch = 0
  if (typeof host.on === 'function') {
    host.on('llm/adapters-updated', () => {
      topologyEpoch += 1
      verdicts.clear()
    })
  }
  ctx.webServer.register({
    name: 'modlens-paste',
    kind: 'exact',
    path: '/modlens/paste',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        try {
          const label = new URL(req.url, 'http://localhost').searchParams.get('model') ?? ''
          const cached = verdicts.get(label)
          let takeover
          if (cached && Date.now() - cached.at < PASTE_VERDICT_TTL_MS) {
            takeover = cached.takeover
          } else {
            // Recompute while the topology moves under the computation: an
            // answer read from a pre-event registry snapshot must be neither
            // cached nor served. Bounded, and the give-up answer is the
            // conservative one.
            let attempts = 0
            for (;;) {
              const startedEpoch = topologyEpoch
              takeover = await pasteTakeoverVerdict(host, label, ownProviders)
              if (topologyEpoch === startedEpoch) {
                verdicts.delete(label)
                verdicts.set(label, { takeover, at: Date.now() })
                if (verdicts.size > PASTE_VERDICT_CAP) {
                  verdicts.delete(verdicts.keys().next().value)
                }
                break
              }
              attempts += 1
              if (attempts >= 3) {
                takeover = false
                break
              }
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ takeover }))
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: String(error?.message ?? error) }))
        }
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      try {
        const chunks = []
        let total = 0
        for await (const chunk of req) {
          total += chunk.length
          if (total > PASTE_MAX_BYTES) {
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: `image over the ${PASTE_MAX_BYTES}-byte limit` }))
            req.destroy()
            return
          }
          chunks.push(chunk)
        }
        const buffer = Buffer.concat(chunks)
        const sniff = PASTE_SNIFFS.find((s) => s.test(buffer))
        if (!sniff) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not a recognized image (png/jpeg/gif/webp/heic)' }))
          return
        }
        const { mkdtemp, writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const root = await openPasteRoot(config.pasteDir)
        const dir = await mkdtemp(join(root, 'p-'))
        const file = join(dir, `paste${sniff.ext}`)
        await writeFile(file, buffer, { mode: 0o600 })
        // This one cannot be deleted when the request ends: its path is what
        // goes into the composer, so the file has to outlive the response and
        // survive until the model reads it. Nothing was ever collecting them
        // afterwards though, so they accumulated for as long as dsh was
        // installed (issue #51). Sweeping the expired ones here keeps it to
        // the moment a paste already costs a disk write, with no timer to
        // own and nothing running when nobody is pasting.
        // Fire and forget: the response must not wait on housekeeping. The
        // promise is kept so a test can await the side effect instead of
        // racing it, which is otherwise a coin flip decided by the scheduler.
        lastPasteSweep = sweepExpiredPastes(Date.now(), root)
        void lastPasteSweep
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ path: file }))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error?.message ? error.message : error) }))
      }
    },
  })
}

/**
 * Phase 3: the paste unlock. dsh's image admission asks the selected
 * provider's adapter for inputModalities, and the DeepSeek adapter hardcodes
 * text-only, so pastes are refused before any plugin hook runs. This wrapper
 * registers a NEW provider whose model metadata declares image input and
 * whose stream() is a one-line delegation back to the real route. Pick the
 * wrapped model in the model selector, paste, and the request-time rewrite
 * turns the image into evidence text before the delegated request goes out;
 * the upstream serializer's own image rejection stays as the fail-closed
 * backstop. Guarded feature-detection: if the llm registration surface moved
 * (developer preview), the plugin quietly stays a read-only-tool plugin.
 *
 * Two modes (issue #29, design contributed by @zlycode01):
 * - `config.upstream` set: wrap exactly that one route, legacy behavior.
 * - unset: auto-discovery — every registered provider route carrying
 *   wrappable text-only family models gets its own `modlens-<provider>`
 *   wrapper, so a machine with several subscription packages (opencode-go,
 *   zai, ...) wraps them all instead of hand-picking one. A `discover` array
 *   of provider ids narrows the set. Routes that register late (llm-pi-ai
 *   mounts its routes after settings load) are picked up by re-sweeping on
 *   the registry's own `llm/adapters-updated` notification, no polling. The
 *   deepseek-official wrap keeps its historical `deepseek-modlens` id, so a
 *   selector remembering that provider survives the upgrade.
 */
/**
 * Whether this wrapper id proves, by itself, which upstream produced the
 * turns recorded under it.
 *
 * Auto-discovery mints `modlens-<upstream>` (and `deepseek-modlens` for
 * `deepseek-official`), so the id carries its own provenance and cannot drift.
 * A hand-configured `upstream` under some other id can be repointed between
 * runs, and then history recorded under that id was produced by a provider
 * that is no longer the one behind it. Relabelling there would hand one
 * adapter another adapter's private replay state, which at best fails the
 * request. Unprovable means no relabelling, so those setups keep exactly the
 * behaviour they have today rather than gaining a worse one.
 */
function wrapperIdEncodes(wrapperId, upstream) {
  return wrapperId === `modlens-${upstream}` || (wrapperId === 'deepseek-modlens' && upstream === 'deepseek-official')
}

/**
 * Re-label our own turns as the upstream provider's before delegating.
 *
 * dsh drops an assistant message's adapter-private replayState whenever the
 * provider recorded on that message belongs to a different adapter instance
 * than the one about to run (LlmService.forAdapter, an identity comparison).
 * This wrapper is a different instance by construction, so every turn it
 * produced reached upstream stripped of the state that carries reasoning
 * continuity, and the model answered without engaging thinking mode:
 * reasoning blocks went missing and the chain of thought landed inline in the
 * text (issue #49). Nothing about the message content differed, which is why
 * passing messages through unchanged looked correct.
 *
 * Renaming is the truth rather than a trick, but only where the id proves it
 * (see wrapperIdEncodes): these turns are upstream's own work, produced by
 * upstream's adapter, and the replayState in them is upstream's to read. Only
 * the copy going over the wire is relabelled. The durable session log keeps
 * the wrapper id, so the UI and the model selector still show the chosen route.
 */
function restoreUpstreamSource(messages, wrapperId, upstream) {
  if (!wrapperIdEncodes(wrapperId, upstream)) {
    return messages
  }
  let changed = false
  const out = messages.map((message) => {
    const source = message?.source
    if (message?.role !== 'assistant' || source?.kind !== 'model' || source.provider !== wrapperId) {
      return message
    }
    changed = true
    return { ...message, source: { ...source, provider: upstream } }
  })
  return changed ? out : messages
}

function registerVisionProvider(ctx, config, ownProviders, evidenceCache) {
  // Wrap only the text-only members of these families. Their own vision
  // models (present or future: deepseek-vl/ocr/janus, glm-4.5v, glm-5v-...,
  // glm-5.3-flash, deepseek-v4-flash-vision-exp) need no bridge and are
  // excluded by name and by declared modality. The name gate matters on its
  // own: third-party catalogs copy an id without its modalities, and a vision
  // model handed a wrapper twin loses its native sight. Family matching also
  // strips a vendor namespace (OpenRouter's z-ai/glm-5.2:free, ~-prefixed
  // aliases), because the text-only member is the same model wherever the id
  // carries a prefix. GLM-5.3-Flash (2026-08-26) is native multimodal without
  // a v in the name, so the glm-*v* branch cannot catch it. GLM-5.3 itself
  // stays wrappable.
  const families = config.families || ['deepseek', 'glm', 'mimo']
  const VISION_ID = /(deepseek-(vl|ocr)|janus|glm-[\d.]*v(\b|-)|glm-5\.3-flash(?:$|[-:])|\bvision\b)/i
  const shouldWrap = (info) => {
    const id = String(info?.id ?? '').toLowerCase()
    // The model's own name: alias marker and vendor namespace stripped. The
    // vision-name gate reads only this, so a gateway namespace that happens
    // to contain the word cannot veto the text model behind it.
    const unaliased = id.replace(/^~/, '')
    const bare = unaliased.slice(unaliased.lastIndexOf('/') + 1)
    const matchesFamily = families.some(
      (family) => family !== '*' && (id.startsWith(family) || bare.startsWith(family)),
    )
    if (!matchesFamily) {
      // Opting into all families is not evidence that an unknown model is
      // text-only. Outside an explicitly named family, require the catalog
      // to declare text input. The image and native-name vetoes still apply.
      if (!families.includes('*') || !Array.isArray(info?.inputModalities) || !info.inputModalities.includes('text'))
        return false
    }
    if (VISION_ID.test(bare)) return false
    if (Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')) return false
    // MiMo needs the gate reversed. Xiaomi's bare version ids name native
    // omni models, while a -pro segment marks text-only flagships. There is no
    // vision marker to exclude, so only the named text subset is safe to include.
    if (bare.startsWith('mimo') && !/(^|-)pro(?:-|:|$)/i.test(bare)) return false
    return true
  }
  // Keep this activation bound to the exact service implementation that made
  // it runnable. Cordis reuses the child context when llm is replaced, so
  // looking the service up again after an await could otherwise move an old
  // topology result into the new registry.
  const llm = ctx.llm
  if (typeof llm?.registerAdapter !== 'function' || typeof llm?.stream !== 'function') {
    return
  }

  // Discovery promises are ordinary JavaScript work, not Cordis effects.
  // The disposer invalidates this activation before the injected child is
  // re-run, and clears the ownership facts whose actual adapter effects the
  // framework tears down independently.
  let active = true
  const claimedProviders = new Set()
  const deactivate = () => {
    active = false
    for (const providerId of claimedProviders) ownProviders?.delete(providerId)
    claimedProviders.clear()
  }
  // Cordis marks a fiber UNLOADING before it runs activation disposers. A
  // promise continuation already in the microtask queue can therefore see
  // `active` before the disposer flips it. Creating and immediately releasing
  // a zero-work effect is the framework's atomic liveness boundary: once it
  // succeeds, the following synchronous registry mutation cannot race an
  // unload. A lifecycle refusal cancels this activation without turning an
  // expected teardown into a terminal diagnostic.
  const activationCanCommit = () => {
    if (!active) return false
    if (typeof ctx.effect !== 'function') return true
    try {
      const release = ctx.effect(() => {})
      if (typeof release === 'function') release()
      return active
    } catch (error) {
      const inactive =
        error?.code === 'INACTIVE_EFFECT' ||
        /cannot create effect on inactive context/i.test(String(error?.message ?? error))
      if (!inactive) throw error
      deactivate()
      return false
    }
  }

  // dsh snapshots providerInfo and providerRetryPolicy at registration time.
  // Keep the state and registration handle for each wrapper so an upstream
  // replacement can refresh those snapshots instead of leaving a synthetic
  // route on yesterday's name or recovery policy.
  const registrations = new Map()
  const wrapped = new Set(['deepseek-modlens'])
  const policyKey = (policy) => (policy === undefined ? undefined : JSON.stringify(policy))

  const registerWrapper = (upstream, providerId, displayName) => {
    if (!activationCanCommit()) return false
    const state = { displayName, retryPolicyKey: undefined }
    const withVision = (info) => {
      const inputModalities = Array.isArray(info?.inputModalities) ? [...info.inputModalities] : []
      if (!inputModalities.includes('text')) inputModalities.unshift('text')
      if (!inputModalities.includes('image')) inputModalities.push('image')
      return { ...info, provider: providerId, inputModalities }
    }
    try {
      const registration = llm.registerAdapter([providerId], {
        // Duck-typing LlmAdapter: providerInfo/providerRetryPolicy are
        // base-class defaults a plain object must supply itself (their
        // absence is exactly the silent registration failure this catch
        // used to swallow).
        providerInfo(provider) {
          return { id: provider, name: state.displayName }
        },
        providerRetryPolicy() {
          // dsh captures this synchronously when the wrapper route registers.
          // Returning the base default here gives the synthetic route a retry
          // budget unrelated to the real route it ultimately calls (#57).
          // Older preview builds exposed registration before this runtime
          // query, so keep their former default only when the query itself is
          // absent. A current runtime that cannot resolve `upstream` throws,
          // and the registration boundary below fails closed instead; the
          // ordinary not-mounted-yet case never reaches this method, because
          // reconcile waits for the upstream before registering (#66).
          if (typeof llm.providerRetryPolicy !== 'function') return undefined
          const policy = llm.providerRetryPolicy(upstream)
          state.retryPolicyKey = policyKey(policy)
          return policy
        },
        async listModels(_provider, signal) {
          const models = await llm.listModels(upstream, signal)
          return models.filter(shouldWrap).map((model) => ({
            ...withVision(model),
            name: `${model.name ?? model.id} (modlens vision)`,
          }))
        },
        async resolveModel(_provider, model, signal) {
          const info = await llm.resolveModelInfo(upstream, model, signal)
          if (!shouldWrap(info)) {
            // Refusing is right: wrapping a model that reads images itself
            // would claim a bridge it does not need, hand it text evidence
            // instead of the picture, and lose whatever its own vision does
            // better. What was wrong is that the refusal explained nothing.
            // A session that already picked this entry fails every turn, and
            // the catalogue is advisory so nothing clears the stale choice,
            // leaving the user to read internal vocabulary and guess.
            //
            // Only the image case gets the specific wording. The same check
            // also fails when a model leaves the configured families, which
            // is a different situation and keeps the general message.
            const declaresImage = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
            throw new Error(
              declaresImage
                ? `model "${model}" declares native image input, so its "(modlens vision)" entry no longer applies. Select the same model from the provider group without "(modlens vision)".`
                : `model "${model}" is outside the modlens vision wrap scope`,
            )
          }
          return { ...withVision(info), id: model }
        },
        async prepareCall(provider, model, signal) {
          // dsh 0.1.1 dispatches every call (and its replay path) through
          // prepareCall (#73). Real adapters inherit exactly this pair from
          // the LlmAdapter base class; a plain object supplies it itself,
          // like providerInfo above. Hosts that never call it ignore it.
          return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options),
          }
        },
        imageRequestPricing() {
          // dsh >= 0.1.2 calls this with no feature check, same as
          // prepareCall. Real adapters inherit the base-class default
          // that returns undefined. A plain object supplies it itself.
          // The synthetic route has no provider-side image pricing of
          // its own, so the token meter keeps its neutral estimate.
          return undefined
        },
        stream(options) {
          // Convert at request time, not at log time: the durable session
          // log keeps the real image blocks (so the UI shows the paste
          // natively), and only the wire messages carry evidence text.
          // Cached per attachment, since the same history rides every step.
          const self = this
          return (async function* () {
            const converted = await convertImagesToEvidence(ctx, options.messages, options.signal, self)
            const messages = restoreUpstreamSource(converted, providerId, upstream)
            // Downstream meters can skip this hop when options.via names the
            // wrapper that forwarded it, and count only the upstream stream (#89).
            yield* llm.stream({ ...options, provider: upstream, messages, via: providerId })
          })()
        },
        evidenceCache,
      })
      registrations.set(upstream, { providerId, registration, state })
      // Trusted as ours only on a registration this call actually made. A
      // duplicate below means someone else holds that id, and skipping a
      // provider we do not own would let a real vision model's paste be
      // taken over, which is the bug the verdict exists to prevent.
      claimedProviders.add(providerId)
      ownProviders?.add(providerId)
      return true
    } catch (error) {
      // A duplicate means a concurrent or earlier registration already won:
      // that is success for the claim, not a reason to retry forever.
      const duplicate =
        error?.code === 'DUPLICATE_ADAPTER' ||
        /\balready registered\b|\bduplicate (adapter|provider)\b/i.test(String(error))
      if (duplicate) {
        console.error(`[modlens] vision provider ${providerId} already registered, keeping the existing one`)
        return true
      }
      // A preview-era surface change: degrade to the tool-only plugin,
      // but say so in the harness log instead of vanishing (a swallowed
      // TypeError here once hid a missing base method).
      console.error(`[modlens] vision provider registration skipped (${providerId}): ${error}`)
      return false
    }
  }

  const dropWrapper = (upstream, current) => {
    registrations.delete(upstream)
    wrapped.delete(upstream)
    claimedProviders.delete(current.providerId)
    ownProviders?.delete(current.providerId)
    if (typeof current.registration === 'function') current.registration()
  }

  // Whether our synthetic route is currently in the registry, spelled the
  // way reconcile spells its availability check. Used where an operation
  // failed and what to do next depends on whether it failed before or after
  // the host committed.
  const routed = (providerId) => {
    if (typeof llm.listProviders !== 'function') return false
    try {
      return llm.listProviders().some((info) => (typeof info === 'string' ? info : info?.id) === providerId)
    } catch {
      return false
    }
  }

  // commitRoutes mutates the registry and only then emits, so a listener
  // throwing during that emit means the replace already SUCCEEDED, and
  // treating the throw as failure would drop a healthy registration. dsh
  // even ships such a listener (its llm invariant re-reads every policy on
  // each update and fails loud), so the catch below asks the registry which
  // side of the commit the failure landed on before deciding.
  const refreshWrapper = (upstream, displayName) => {
    const current = registrations.get(upstream)
    if (!current || typeof current.registration?.replace !== 'function') return
    let nextPolicyKey
    try {
      nextPolicyKey =
        typeof llm.providerRetryPolicy === 'function' ? policyKey(llm.providerRetryPolicy(upstream)) : undefined
    } catch (error) {
      dropWrapper(upstream, current)
      console.error(`[modlens] vision provider refresh removed (${current.providerId}): ${error}`)
      return
    }
    if (current.state.displayName === displayName && current.state.retryPolicyKey === nextPolicyKey) return
    const previousName = current.state.displayName
    current.state.displayName = displayName
    try {
      // Re-read both adapter methods at the same atomic boundary dsh's own
      // adapters use when their registration-captured facts change.
      current.registration.replace([current.providerId])
    } catch (error) {
      current.state.displayName = previousName
      if (routed(current.providerId)) {
        // The route survived, so the throw came from after the commit (a
        // listener), or the host kept the old snapshot. Either converges on
        // the next refresh; disposing would not.
        console.error(
          `[modlens] vision provider refresh failed (${current.providerId}), keeping the existing registration: ${error}`,
        )
        return
      }
      dropWrapper(upstream, current)
      console.error(`[modlens] vision provider refresh failed (${current.providerId}): ${error}`)
    }
  }

  if (config.upstream) {
    const upstream = config.upstream
    // The default id encodes its upstream, the same minting rule the sweep
    // uses, because #49's relabelling trusts only ids that prove their
    // upstream. The old flat default, deepseek-modlens for every pinned
    // upstream, was also the id auto-discovery mints for deepseek-official,
    // so history recorded under a pinned foreign upstream became
    // indistinguishable from DeepSeek history, and switching to
    // auto-discovery could hand that foreign replay state to the DeepSeek
    // adapter. An explicit config.providerId is honoured as before, and a
    // pinned deepseek-official keeps the name existing setups know.
    const providerId =
      config.providerId || (upstream === 'deepseek-official' ? 'deepseek-modlens' : `modlens-${upstream}`)
    // Named after the route it actually wraps. This used to say DeepSeek
    // whatever `upstream` was, so anyone pointing it at another route got a
    // model group labelled for a provider they were not using. The refresh
    // plumbing below could never correct it, because the name it compared
    // against was a constant.
    const upstreamName = () => {
      if (typeof llm.listProviders !== 'function') return upstream
      try {
        const found = llm.listProviders().find((entry) => entry.id === upstream)
        return found?.name ?? upstream
      } catch {
        return upstream
      }
    }
    let reconciling = false
    let rerunQueued = false
    let waitingLogged = false
    // The id is held by someone else (a second modlens install, most
    // likely). Their registration answers the routing, so retrying ours on
    // every topology event would only repeat the same log line; the claim is
    // re-examined when the holder's route disappears.
    let claimedElsewhere = false
    const reconcile = () => {
      if (!activationCanCommit()) return
      if (reconciling) {
        // dropWrapper's disposer makes the host emit adapters-updated while
        // this very run is on the stack, and whatever that event announced
        // (a quick remount, say) must not wait for an unrelated next event.
        rerunQueued = true
        return
      }
      reconciling = true
      try {
        const current = registrations.get(upstream)
        const available =
          typeof llm.listProviders !== 'function' ||
          llm.listProviders().some((info) => (typeof info === 'string' ? info : info?.id) === upstream)
        if (!current) {
          if (claimedElsewhere) {
            if (routed(providerId)) return
            // The holder released the id: it is ours to try again.
            claimedElsewhere = false
          }
          if (!available) {
            // A pinned upstream that mounts after this plugin is ordinary
            // startup order (llm-pi-ai mounts its providers once settings
            // load), not an error. Registering against the absence cannot
            // succeed: dsh snapshots the retry policy synchronously inside
            // registerAdapter, the upstream lookup throws NO_ADAPTER, and the
            // doomed attempt landed in the log as a skipped registration that
            // read fatal while the next adapters-updated quietly healed it
            // (issue #66). So wait for the event instead, and say so once: a
            // typo'd upstream never arrives, and this line is then the
            // breadcrumb naming exactly what was waited on.
            if (!waitingLogged) {
              waitingLogged = true
              console.error(`[modlens] vision provider waiting for upstream "${upstream}" to register`)
            }
            return
          }
          waitingLogged = false
          if (registerWrapper(upstream, providerId, `${upstreamName()} (modlens vision)`)) {
            // True with nothing recorded is the duplicate branch: another
            // holder already answers for this id.
            claimedElsewhere = !registrations.has(upstream)
          }
          return
        }
        if (!available) {
          dropWrapper(upstream, current)
          return
        }
        refreshWrapper(upstream, `${upstreamName()} (modlens vision)`)
      } finally {
        reconciling = false
        if (rerunQueued) {
          rerunQueued = false
          reconcile()
        }
      }
    }
    reconcile()
    if (typeof ctx.on === 'function') ctx.on('llm/adapters-updated', reconcile)
    return deactivate
  }

  // Auto-discovery. `wrapped` guards duplicates across sweeps and the
  // self-nesting case (our own wrappers appear in listProviders too). Two
  // re-entrancy rules matter because registerAdapter itself broadcasts
  // llm/adapters-updated, so every successful wrap re-triggers a sweep:
  // an id is claimed in `wrapped` BEFORE any await (a concurrent sweep must
  // skip it while this one is still probing), and sweeps are serialized on
  // one promise chain so two can never interleave their probes at all.
  const discover = Array.isArray(config.discover) ? new Set(config.discover) : null
  const sweepOnce = async () => {
    if (!activationCanCommit()) return
    try {
      await sweepBody()
    } catch (error) {
      if (!active) return
      // A sweep failure must never become an unhandled rejection inside the
      // host process; the next topology notification simply tries again.
      console.error(`[modlens] vision provider discovery sweep failed: ${error}`)
    }
  }
  const sweepBody = async () => {
    if (!active) return
    if (typeof llm.listProviders !== 'function') {
      // Older registry surface: fall back to the single legacy wrap once.
      if (!wrapped.has('__legacy_fallback__')) {
        wrapped.add('__legacy_fallback__')
        registerWrapper('deepseek-official', 'deepseek-modlens', 'DeepSeek (modlens vision)')
      }
      return
    }
    const providers = llm.listProviders()
    if (!active) return
    // Same tolerance as the pinned path: an entry may be a bare id string.
    const idOf = (info) => (typeof info === 'string' ? info : info?.id)
    const available = new Set(providers.map(idOf).filter(Boolean))
    for (const [upstream, current] of registrations) {
      if (!active) return
      if (available.has(upstream)) continue
      dropWrapper(upstream, current)
    }
    for (const info of providers) {
      if (!active) return
      const id = idOf(info)
      if (!id || String(id).startsWith('modlens-')) continue
      if (discover && !discover.has(id)) continue
      const base = (typeof info === 'string' ? undefined : info.name) ?? id
      if (registrations.has(id)) {
        refreshWrapper(id, `${base} (modlens vision)`)
        continue
      }
      if (wrapped.has(id)) continue
      // Claim before the await: the probe may suspend, and the sweep a
      // registration triggers must not probe the same id concurrently.
      wrapped.add(id)
      let models = []
      try {
        models = await llm.listModels(id)
      } catch {
        if (!activationCanCommit()) return
        // Unreachable route today; release the claim so a later topology
        // change retries it.
        wrapped.delete(id)
        continue
      }
      // The promise can settle just before Cordis marks this fiber UNLOADING,
      // while the activation disposer is still one microtask away. Re-enter
      // the atomic lifecycle boundary before either continuing to refresh a
      // later registration or committing this provider's wrapper.
      if (!activationCanCommit()) return
      if (!models.some(shouldWrap)) {
        // No eligible models yet: release, the route may gain some later.
        wrapped.delete(id)
        continue
      }
      const providerId = id === 'deepseek-official' ? 'deepseek-modlens' : `modlens-${id}`
      if (!registerWrapper(id, providerId, `${base} (modlens vision)`)) {
        wrapped.delete(id)
      }
    }
  }
  // Serialize: a sweep triggered mid-sweep runs after, never interleaved.
  // The first sweep is invoked directly so its synchronous prefix (the
  // legacy fallback, the pre-await claims) completes during apply().
  let sweeping = sweepOnce()
  const sweep = () => {
    sweeping = sweeping.then(sweepOnce, sweepOnce)
    return sweeping
  }
  if (typeof ctx.on === 'function') {
    ctx.on('llm/adapters-updated', () => {
      void sweep()
    })
  }
  return deactivate
}

// The same pasted attachment rides every later step of its session, and the
// provider caches by prefix, so what this cache protects is not just the
// engine bill but the BYTES of the rewritten history: a message whose text
// changes between steps busts the provider's context cache for everything
// after it (issue #68). So it stores promises (concurrent readers join the
// first run), keeps successes for good, and holds failures for a cooldown
// instead of evicting them on settle: a broken engine is probed once per
// cooldown per attachment rather than once per step, the placeholder text is
// byte-stable while the outcome is unchanged, and the first step after the
// cooldown retries, so a fixed engine is picked up without a restart. It
// caps itself LRU-style so a long-lived Web profile cannot hoard evidence
// text forever.
const EVIDENCE_CACHE_LIMIT = 256
const EVIDENCE_FAILURE_COOLDOWN_MS = 60_000

/**
 * A cache key that survives replay: the same attachment serialized with a
 * different key order used to miss its own entry, re-run the engine, and
 * rewrite the history with a fresh reading (issue #68).
 */
function evidenceKey(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(evidenceKey).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${evidenceKey(value[key])}`).join(',')}}`
}

function cachedEvidence(ctx, adapter, block, walk) {
  const key = evidenceKey(block.attachment ?? block)
  // Everything the current walk touches is pinned for the walk's duration:
  // eviction picks victims outside the union of every open walk, or nothing.
  walk?.pin(key)
  const hit = adapter.evidenceCache.get(key)
  if (hit !== undefined) {
    const cooling = typeof hit === 'object' && hit !== null && 'retryAfter' in hit
    if (!cooling || monotonicNow() < hit.retryAfter) {
      // Refresh recency: Map iteration order is insertion order.
      adapter.evidenceCache.delete(key)
      adapter.evidenceCache.set(key, hit)
      return cooling ? Promise.resolve(hit.block) : hit
    }
    // Cooldown over: fall through into one fresh probe.
  }
  // Deliberately no caller signal: a shared entry must not die with its first
  // caller (their abort used to cancel every concurrent joiner). A cancelled
  // caller simply stops awaiting; the read finishes and the cache keeps it.
  const pending = readImageBlock(ctx, block, undefined).then(
    (evidence) => {
      // Only replace our own entry: this promise may have been LRU-evicted
      // and the key re-populated by a newer read meanwhile.
      if (!evidence.ok && adapter.evidenceCache.get(key) === pending) {
        adapter.evidenceCache.set(key, {
          retryAfter: monotonicNow() + EVIDENCE_FAILURE_COOLDOWN_MS,
          block: evidence.block,
        })
      }
      return evidence.block
    },
    () => {
      // readImageBlock never rejects by contract; this is the belt for a
      // future refactor breaking that, so a rejected promise cannot lodge in
      // the cache forever. Same stable text as the engine stage: the detail
      // belongs in the harness log, never in the wire history.
      const block = Object.freeze({
        type: 'text',
        text: FAILURE_TEXTS.engine,
      })
      if (adapter.evidenceCache.get(key) === pending) {
        adapter.evidenceCache.set(key, {
          retryAfter: monotonicNow() + EVIDENCE_FAILURE_COOLDOWN_MS,
          block,
        })
      }
      return block
    },
  )
  adapter.evidenceCache.set(key, pending)
  trimEvidenceCache(adapter.evidenceCache)
  return pending
}

/**
 * Overflow evicts the least-recently-used entry OUTSIDE the current walk's
 * working set, and nothing when the whole cache IS the working set.
 *
 * Both naive policies fail a real session shape. Oldest-first thrashes a
 * front-to-back history walk once it passes the cap (the 257th attachment
 * evicts the 1st, whose miss next step evicts the 2nd, and so on: the #68
 * retry storm wearing a cap). Newest-first survives that but starves a NEW
 * session on a long-lived profile: the cache sits full of a previous
 * session's entries, every new attachment evicts the previous new one, and
 * the storm returns with the old entries pinned in place forever.
 *
 * Pinning the walk resolves both. A new session's working set evicts stale
 * entries one by one, in LRU order, and resides in full; a single history
 * larger than the cap keeps everything it is walking (the cap goes soft for
 * the walk's duration, bounded by that history's own length) and is stable
 * again on the next step. The remaining honesty: an entry genuinely evicted
 * and later re-read by a healthy engine may be worded differently, so bytes
 * can move with the outcome unchanged; the cap exists so a long-lived Web
 * profile cannot hoard evidence forever.
 */
// Active pins per cache, as exact refcounts: victim selection must see EVERY
// walk's pins, or two interleaved sessions on the shared Map evict each
// other's in-flight entries and the full-thrash storm returns with company.
// Refcounts rather than a set of sets, so the union is exact (two walks
// pinning the same keys is one union, not a doubled sum) and every check is
// O(1). WeakMap so a cache that dies takes its registry with it.
const ACTIVE_PINS = new WeakMap()

function activePinsFor(cache) {
  let counts = ACTIVE_PINS.get(cache)
  if (!counts) {
    counts = new Map()
    ACTIVE_PINS.set(cache, counts)
  }
  return counts
}

/**
 * Open one walk over a cache: everything the walk pins stays unevictable
 * until end() runs, whichever walk a trim happens under. Ending the walk
 * releases its share of the pins; entries above the cap then linger until
 * the next miss trims them, which is the stability-over-punctuality trade
 * the cap makes on purpose.
 */
export function beginEvidenceWalk(cache) {
  const counts = activePinsFor(cache)
  const mine = new Set()
  return {
    pin: (key) => {
      if (mine.has(key)) return
      mine.add(key)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    },
    end: () => {
      for (const key of mine) {
        const left = (counts.get(key) ?? 1) - 1
        if (left <= 0) {
          counts.delete(key)
        } else {
          counts.set(key, left)
        }
      }
      mine.clear()
    },
  }
}

export function trimEvidenceCache(cache) {
  const counts = ACTIVE_PINS.get(cache)
  while (cache.size > EVIDENCE_CACHE_LIMIT) {
    // Exact union early-out: when every key in the cache is pinned by some
    // open walk, a scan would find nothing; counts.size is the union's true
    // cardinality, so overlapping walks cannot inflate it.
    if (counts !== undefined && counts.size >= cache.size) {
      return
    }
    let victim
    for (const key of cache.keys()) {
      if (counts === undefined || !counts.has(key)) {
        victim = key
        break
      }
    }
    if (victim === undefined) {
      return
    }
    cache.delete(victim)
  }
}

/**
 * Wait on a shared promise without inheriting its lifetime: the caller's
 * abort rejects THIS wait immediately, while the underlying read keeps
 * running and lands in the cache for the retry.
 */
function abortableWait(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const onAbort = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Image blocks hide at two depths: top-level message content (pastes), and
 * inside tool-result content (dsh's own read_image tool nests one there).
 * The upstream adapter's rejection check recurses (issue #24), so the
 * conversion must recurse the same way or a nested image wedges the session
 * permanently — the durable log keeps the real block, and every later turn
 * re-fails on it.
 */
function contentHasImage(blocks) {
  return (
    Array.isArray(blocks) &&
    blocks.some((b) => b?.type === 'image' || (b?.type === 'tool-result' && contentHasImage(b.content)))
  )
}

async function convertBlocks(blocks, convertOne) {
  const out = []
  for (const block of blocks) {
    if (block?.type === 'image') {
      out.push(await convertOne(block))
    } else if (block?.type === 'tool-result' && contentHasImage(block.content)) {
      out.push({ ...block, content: await convertBlocks(block.content, convertOne) })
    } else {
      out.push(block)
    }
  }
  return out
}

async function convertImagesToEvidence(ctx, messages, signal, adapter) {
  const out = []
  // One walk per conversion: its pins are visible to every trim on the
  // shared cache until end(), so concurrent sessions cannot evict each
  // other's in-flight work.
  const walk = beginEvidenceWalk(adapter.evidenceCache)
  try {
    for (const message of messages) {
      if (!contentHasImage(message.content)) {
        out.push(message)
        continue
      }
      const content = await convertBlocks(message.content, (block) =>
        abortableWait(cachedEvidence(ctx, adapter, block, walk), signal),
      )
      out.push({ ...message, content })
    }
  } finally {
    walk.end()
  }
  return out
}

/**
 * Phase 2: paste auto-route. When entered messages carry image blocks (the
 * Web UI's paste/drop intake) and the model behind dsh is text-only, rewrite
 * each image block into a modlens evidence text block before the step starts.
 * Runs after `next()` so downstream pre-step listeners (compaction, context
 * injectors) see and shape the same final message set; a failed read degrades
 * to an explanatory text block instead of rejecting the step.
 */
function registerAutoRead(ctx, evidenceCache) {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') {
      return decision
    }
    if (!decision.messages.some((message) => contentHasImage(message.content))) {
      return decision
    }
    const messages = []
    // One walk per pre-step, spanning every message in it; pins are visible
    // to every trim on the shared cache until the walk ends.
    const walk = beginEvidenceWalk(evidenceCache)
    try {
      for (const message of decision.messages) {
        if (!contentHasImage(message.content)) {
          messages.push(message)
          continue
        }
        const content = await convertBlocks(message.content, (block) =>
          // The same cache the wrapper routes use: auto-read used to re-read
          // every image on every step, healthy engine or not (issue #68).
          abortableWait(cachedEvidence(ctx, { evidenceCache }, block, walk), payload.signal),
        )
        messages.push({ ...message, content })
      }
    } finally {
      walk.end()
    }
    return { kind: 'enter', messages }
  })
}

/**
 * The wire history must not change bytes unless the outcome changed, so a
 * failure's placeholder is a constant per failure stage, never the attempt's
 * own error text: the same broken engine words its failures differently on
 * every try, and each wording rewrote the history and busted the provider's
 * prefix cache for the rest of the session (issue #68). The attempt's detail
 * goes to the harness log, which never rides a request.
 */
const FAILURE_TEXTS = {
  store:
    '[A pasted image could not be read: the attachment store did not return it. Tell the user, and suggest running `npx @liustack/modlens doctor`.]',
  media:
    '[A pasted image could not be read: its media type is not supported. Tell the user, and suggest running `npx @liustack/modlens doctor`.]',
  engine:
    '[A pasted image could not be read: the vision engine failed. Tell the user, and suggest running `npx @liustack/modlens doctor`.]',
}

/**
 * Read one image block into an evidence text block. Never throws: failures
 * degrade to an explanatory block with `ok: false`, so callers can decide
 * what a failure means (the pre-step keeps the step going, the cache holds
 * it only for a cooldown).
 */
async function readImageBlock(ctx, block, signal) {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  let dir
  // Which stage failed decides the (constant) placeholder text below. Even
  // the media stage carries no variable part: the type string arrives from
  // paste metadata and replayed content, so it is attacker-shaped, and an
  // unbounded newline-carrying value on the wire is a fake turn boundary.
  // The concrete type goes to the harness log with the rest of the detail.
  let stage = 'store'
  try {
    // StoredImageAttachment carries { ref, data: Uint8Array }; the media type
    // rides the reference (verified against dsh attachment/src/types.ts).
    const stored = await ctx.attachments.readImage(block.attachment, signal)
    if (!stored?.data) {
      // Named failure instead of Buffer.from(undefined)'s bare TypeError the
      // next time a developer-preview release moves the field (issue #17).
      throw new Error("attachments.readImage returned no 'data' bytes; the dsh attachment shape may have changed")
    }
    const mediaType = stored.ref?.mediaType ?? block.attachment?.mediaType
    const ext = MEDIA_EXT[mediaType]
    if (!ext) {
      // Refusing beats disguising: a fake .png suffix would make the CLI (and
      // the provider behind it) judge mislabelled bytes.
      stage = 'media'
      throw new Error(`unsupported pasted media type ${mediaType ?? '(none declared)'}`)
    }
    stage = 'engine'
    dir = await mkdtemp(join(tmpdir(), 'modlens-dsh-'))
    const file = join(dir, `paste${ext}`)
    await writeFile(file, Buffer.from(stored.data), { mode: 0o600 })
    const cli = process.env.MODLENS_DSH_CLI || CLI_PATH
    const { stdout, stderr, code } = await run(
      process.execPath,
      [cli, '-i', file, '--timeout', String(CLI_TIMEOUT_MS)],
      signal,
    )
    if (code !== 0) {
      throw new Error((stderr || stdout).trim().slice(0, 300))
    }
    const parsed = JSON.parse(stdout)
    return {
      ok: true,
      // Frozen: the same object rides every later step from the cache, and a
      // downstream listener mutating it would silently rewrite history.
      block: Object.freeze({
        type: 'text',
        text: `[Pasted image, read by the modlens vision bridge]\n${renderEvidence(parsed.result)}`,
      }),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : String(error)
    console.error(`[modlens] image read failed (${stage}): ${detail}`)
    return {
      ok: false,
      block: Object.freeze({
        type: 'text',
        text: FAILURE_TEXTS[stage],
      }),
    }
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

function run(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawnHidden(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      // In the packaged desktop app process.execPath is the Electron binary;
      // this makes it behave as plain node for the spawned CLI (issue #25).
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code }))
  })
}

function renderEvidence(value) {
  const lines = [value.summary]
  const text = value.ocr?.full_text?.trim()
  if (text) {
    lines.push('', 'Transcription:', text.length > 4000 ? `${text.slice(0, 4000)}…` : text)
  }
  const uncertainty = value.uncertainty ?? []
  if (uncertainty.length > 0) {
    lines.push('', `Uncertain: ${uncertainty.join('; ')}`)
  }
  return lines.join('\n')
}

// The engines a user can pick in the settings card, in the order the docs
// introduce them. Kept to the names modlens itself uses so the card and
// `modlens doctor` say the same words.
const ENGINES = ['antigravity-cli', 'gemini-api', 'openai', 'anthropic', 'claude-cli']
// The two CLI engines sign in through their own tool, so a key or an endpoint
// would be a field with nothing behind it. Both still take a model.
const KEYLESS_ENGINES = ['antigravity-cli', 'claude-cli']
// Every accepted spelling, mirroring src/providers/index.ts. Settings saved
// under an alias are the same engine's settings, and a provider pinned by an
// alias is pinned to that engine: showing either as something else would put
// the card at odds with what actually reads the images.
const ENGINE_ALIASES = {
  antigravity: 'antigravity-cli',
  agy: 'antigravity-cli',
  gemini: 'gemini-api',
  'openai-compat': 'openai',
  claude: 'anthropic',
  'claude-code': 'claude-cli',
}

/** The canonical engine a stored name means, or '' when it names none. */
function canonicalEngine(name) {
  if (typeof name !== 'string') return ''
  const trimmed = name.trim().toLowerCase()
  if (ENGINES.includes(trimmed)) return trimmed
  return ENGINE_ALIASES[trimmed] ?? ''
}

/** The config keys holding one engine's settings: its own, plus its aliases. */
function settingsKeysFor(engine) {
  const aliases = Object.keys(ENGINE_ALIASES).filter((alias) => ENGINE_ALIASES[alias] === engine)
  return [...aliases, engine]
}
// Auto mode: the local harnesses whose logins a read may borrow. `claude`
// absent counts as granted, since claude-cli predates the grant model.
const REUSE_HARNESSES = ['claude', 'codex', 'opencode', 'pi', 'grok']

// The variables that supply an engine while the file names no entry for it,
// mirroring ENV_BINDINGS in src/config.ts. An engine takes its settings from
// one source whole, so the card has to read the same two places a read does or
// it shows an empty form for an engine that works.
const ENGINE_ENV_BINDINGS = {
  'gemini-api': { apiKey: 'GEMINI_API_KEY', baseUrl: 'GEMINI_BASE_URL' },
  openai: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
  anthropic: { apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
}

/** Whether a comma-separated API-key value contains at least one real key. */
function hasApiKeys(value) {
  return (
    typeof value === 'string' &&
    value
      .split(',')
      .map((key) => key.trim())
      .some((key) => key !== '')
  )
}

function engineEnvSettings(engine, env = process.env) {
  const settings = {}
  for (const [field, variable] of Object.entries(ENGINE_ENV_BINDINGS[engine] ?? {})) {
    const value = typeof env[variable] === 'string' ? env[variable].trim() : ''
    if (value !== '' && (field !== 'apiKey' || hasApiKeys(value))) settings[field] = value
  }
  return settings
}

/**
 * Whether the file names this engine. The key existing is what counts, not
 * what it holds: an entry emptied down to `{}` still takes the engine off its
 * variables, the same rule fileKeysFor applies in src/config.ts.
 */
function engineConfiguredInFile(engine, config) {
  return settingsKeysFor(engine).some((key) => config.providers?.[key] !== undefined)
}

/** ~/.modlens/config.json, the one file every harness shares. */
function modlensConfigPath() {
  return join(homedir(), '.modlens', 'config.json')
}

/**
 * The shared config, or a thrown error. Only a missing file reads as empty:
 * a file that exists but cannot be parsed or read is somebody's configuration,
 * and a settings card that treated it as empty would overwrite it on the next
 * save. The card shows the error instead.
 */
function readModlensConfig() {
  let raw
  try {
    raw = readFileSync(modlensConfigPath(), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`cannot read ${modlensConfigPath()}: ${error?.message ?? error}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${modlensConfigPath()} is not valid JSON: ${error?.message ?? error}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${modlensConfigPath()} does not hold a JSON object`)
  }
  return parsed
}

/**
 * What the card is allowed to know. Every engine's endpoint, model and proxy
 * mode, plus whether a key is stored. Neither keys nor proxy URLs cross into
 * the browser: both can carry credentials, and a browser that cannot read a
 * secret cannot leak one or write it back accidentally.
 */
function engineSummary(config = readModlensConfig()) {
  const engines = {}
  for (const name of ENGINES) {
    // One source, whole. The file when it names the engine, its variables
    // otherwise: reading only the file showed an empty form for a container
    // that exports its key, and the first save then wrote a partial entry
    // that took the working variables away.
    const inFile = engineConfiguredInFile(name, config)
    // Alias first, canonical last: the canonical key wins on conflict, the
    // same order resolveProviderSettings uses.
    const settings = inFile
      ? Object.assign({}, ...settingsKeysFor(name).map((key) => config.providers?.[key] ?? {}))
      : engineEnvSettings(name)
    engines[name] = {
      baseUrl: typeof settings.baseUrl === 'string' ? settings.baseUrl : '',
      model: typeof settings.model === 'string' ? settings.model : '',
      hasKey: hasApiKeys(settings.apiKey),
      proxyMode: !Object.hasOwn(settings, 'proxy')
        ? 'inherit'
        : typeof settings.proxy === 'string' && settings.proxy.trim() === ''
          ? 'direct'
          : 'custom',
      // '' means neither source holds anything, which is not the same as the
      // file holding an empty entry: that one is already off its variables.
      source: inFile ? 'file' : Object.keys(settings).length > 0 ? 'env' : '',
    }
  }
  const reuse = {}
  for (const harness of REUSE_HARNESSES) {
    const granted = config.reuse?.[harness]
    reuse[harness] = typeof granted === 'boolean' ? granted : harness === 'claude'
  }
  // Three states, kept apart: pinned to an engine, pinned by one of its
  // aliases (reported canonically), or not pinned at all, which is its own
  // answer and means the failover chain decides. Collapsing the third into
  // the first pins an engine the user never chose.
  return {
    provider: canonicalEngine(config.provider),
    engines,
    keyless: KEYLESS_ENGINES,
    reuse,
  }
}

/**
 * Apply one card submission to the shared file. Only the named engine's own
 * fields are touched, so switching engines in the card cannot copy one
 * engine's endpoint onto another. An absent or empty `apiKey` leaves the
 * stored one alone: the card never receives a key, so it must never be able
 * to clear one by submitting the blank field it was shown.
 */
function applyEngineSettings(patch) {
  const config = readModlensConfig()
  // The pin moves only when the card says it moved. A save that carried the
  // currently displayed engine regardless turned "not pinned" into a pin on
  // whatever happened to be shown, changing which engine reads every later
  // image without the user asking for it.
  if (patch?.provider !== undefined) {
    if (patch.provider === '') {
      delete config.provider
    } else if (ENGINES.includes(patch.provider)) {
      config.provider = patch.provider
    } else {
      throw new Error(`unknown engine: ${patch.provider}`)
    }
  }
  // Engine fields are edited one engine at a time, named by `engine`. Absent
  // means this save touched no engine settings, which is what a reuse-only
  // save looks like.
  const engine = patch?.engine
  if (engine !== undefined) {
    if (!ENGINES.includes(engine)) {
      throw new Error(`unknown engine: ${engine}`)
    }
    config.providers = { ...config.providers }
    // Write where this engine's settings already live, so a key saved under
    // an alias is updated rather than shadowed by a second copy.
    // Write where the read takes effect. settingsKeysFor merges aliases
    // first and the canonical key last, so the canonical value wins; picking
    // the first existing key instead wrote a new value underneath an older
    // canonical one, which saved successfully and changed nothing. Both CLI
    // spellings existing at once is ordinary: `config set gemini.apiKey`
    // then `config set gemini-api.apiKey` leaves exactly that.
    const holders = settingsKeysFor(engine).filter((key) => config.providers[key] !== undefined)
    const target = holders.length > 0 ? holders[holders.length - 1] : engine
    // The first file entry for an engine the variables are supplying takes it
    // off them whole, so their values move into the entry with it. Otherwise
    // saving a model on a working environment-only engine deleted its key and
    // endpoint from the run. Seeded here rather than in the browser because
    // the key must never travel there.
    const seed = holders.length > 0 ? {} : engineEnvSettings(engine)
    const settings = { ...seed, ...config.providers[target] }
    for (const field of ['baseUrl', 'model']) {
      if (!Object.hasOwn(patch, field)) continue
      const value = typeof patch[field] === 'string' ? patch[field].trim() : ''
      if (value === '') {
        delete settings[field]
      } else {
        settings[field] = value
      }
    }
    const apiKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : ''
    if (apiKey !== '') {
      settings.apiKey = apiKey
    }
    if (Object.hasOwn(patch, 'proxyMode')) {
      if (patch.proxyMode === 'inherit') {
        // Absence is the inheritance signal. Remove the field from every
        // alias-backed entry or an older alias value resurfaces when settings
        // are merged, even after the canonical entry says it was cleared.
        for (const holder of holders) {
          const stored = config.providers[holder]
          if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
            delete stored.proxy
          }
        }
        delete settings.proxy
      } else if (patch.proxyMode === 'direct') {
        settings.proxy = ''
      } else if (patch.proxyMode === 'custom') {
        const proxy = typeof patch.proxy === 'string' ? patch.proxy.trim() : ''
        if (proxy !== '') {
          settings.proxy = proxy
        } else {
          // The card reports the merged route, which may live under an alias
          // while the canonical entry owns only the model or endpoint.
          const storedProxy = Object.assign({}, ...holders.map((key) => config.providers[key])).proxy
          if (typeof storedProxy !== 'string' || storedProxy.trim() === '') {
            throw new Error('custom proxy mode needs a proxy URL')
          }
        }
      } else {
        throw new Error(`unknown proxy mode: ${patch.proxyMode}`)
      }
    }
    config.providers[target] = settings
  }
  // Auto mode, when the card sent it: only the harnesses this build knows,
  // only booleans, so an unexpected key cannot land in the shared file.
  if (patch?.reuse !== null && typeof patch?.reuse === 'object') {
    config.reuse = { ...config.reuse }
    for (const harness of REUSE_HARNESSES) {
      const granted = patch.reuse[harness]
      if (typeof granted === 'boolean') {
        config.reuse[harness] = granted
      }
    }
  }
  const file = modlensConfigPath()
  // A symlink here would write through to wherever it points, so it is
  // refused rather than followed: the CLI writes a real file, and anything
  // else is a setup this card should not silently honor.
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(`${file} is a symlink; edit the file it points at instead`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows has no POSIX bits; the mode on the write above is all there is.
  }
}

/**
 * GET /modlens/config: the engine summary above. POST: one submission.
 *
 * The dsh web server listens on loopback, but a page in the same browser can
 * still reach it, so a write requires a same-origin request: a cross-site POST
 * could otherwise repoint someone's engine at an endpoint of its choosing.
 * A read is refused the same way for symmetry, though it carries no secret.
 */
/**
 * The self-check behind the card's auto-mode section: which local harnesses
 * exist to be borrowed at all. `doctor --json` already probes them without
 * network or quota, so the route spawns the CLI this package ships and lifts
 * its reuse section. Cached for ten minutes, since one probe can take a
 * second and re-expanding the card should not re-pay it.
 */
const DISCOVERY_TTL_MS = 600_000
let discoveryCache = null
async function discoverReuse() {
  if (discoveryCache !== null && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
    return discoveryCache.value
  }
  try {
    const { stdout, code } = await run(process.execPath, [CLI_PATH, 'doctor', '--json'], AbortSignal.timeout(30_000))
    if (code !== 0) return null
    const reuse = JSON.parse(stdout)?.reuse
    if (!reuse || !Array.isArray(reuse.probes)) return null
    // doctor names the harness claude-code; the grant key is claude.
    const probes = reuse.probes.map((probe) => ({
      harness: probe.harness === 'claude-code' ? 'claude' : probe.harness,
      cliFound: probe.cliFound === true,
      loggedIn: probe.loggedIn,
      cliPath: typeof probe.cliPath === 'string' ? probe.cliPath : '',
    }))
    discoveryCache = { at: Date.now(), value: probes }
    return probes
  } catch {
    return null
  }
}

/**
 * Open the shared config file in whatever the OS considers its editor. The
 * card's "open config file" link lands here: the path never has to be
 * explained to the user, they just get the file. Created empty first when
 * missing, so the editor has something to open.
 */
function openConfigFile() {
  const file = modlensConfigPath()
  try {
    lstatSync(file)
  } catch {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{}\n', { mode: 0o600 })
  }
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [file]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', file]]
        : ['xdg-open', [file]]
  // Hiding applies to the `cmd` that runs `start`, not to the editor it hands
  // off to: `start` opens the file through its association in a process of its
  // own. Windows ignores CREATE_NO_WINDOW next to DETACHED_PROCESS, so what
  // this leaves is SW_HIDE on the middleman.
  spawnHidden(command, args, { detached: true, stdio: 'ignore' }).unref()
}

/** localhost, ::1, or anything in 127/8, matching dsh's own /api fence. */
function isLoopbackHost(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/**
 * The same fence dsh puts in front of its own /api, for the same two
 * confused-deputy paths. Host is the header DNS rebinding cannot forge, so it
 * must name a loopback authority: a rebound page reaches this socket carrying
 * its own domain there. Origin and Sec-Fetch-Site then rule out a cross-site
 * page on the machine itself. A dsh serving a LAN address configures
 * trustedHosts for /api; this route stays loopback-only, since nothing about
 * editing an API key wants a wider door.
 */
function isTrustedRequest(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHost(hostUrl.hostname)) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * How long a pasted file stays reachable.
 *
 * This is a proxy for "nobody needs it any more", and a proxy is all that is
 * available: the path leaves through the composer as plain text, so nothing
 * here observes whether the draft holding it was sent, cleared, or abandoned.
 * A week errs the way that asymmetry asks for. Deleting too early breaks a
 * draft somebody is still writing and reads as a bug in the paste; deleting
 * too late costs a few kilobytes in a directory the OS already collects.
 */
const PASTE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * A ceiling on what unread pastes may hold, independent of age. One image may
 * be 25 MB, so a week is long enough for a burst to reach tens of gigabytes
 * before any of it expires. This only engages far past ordinary use, and it
 * removes oldest first, which is a worse rule than liveness but the only one
 * available; running a disk out of space is worse than either.
 */
const PASTE_STORE_MAX_BYTES = 1024 * 1024 * 1024

/** The most recent sweep, so tests can await what production does not. */
let lastPasteSweep = Promise.resolve()

/** Everything this plugin writes for pastes lives under one directory. */
function pasteRoot(base = null) {
  return base ?? join(tmpdir(), 'modlens-dsh-paste')
}

/**
 * Open the store directory, or refuse it.
 *
 * The path is predictable and the system temp directory is shared, so on a
 * multi-user machine somebody else can get there first. A symlink planted at
 * that name would point this plugin's recursive cleanup at whatever it names,
 * which is the oldest trick there is against a program that tidies up in
 * /tmp. So an existing entry has to be a real directory this user owns, and a
 * new one is created private. Anything else is refused, and the paste fails
 * loudly rather than writing into somebody else's directory.
 */
async function openPasteRoot(base = null) {
  const { mkdir, lstat, chmod, realpath } = await import('node:fs/promises')
  const { basename, dirname } = await import('node:path')
  const root = pasteRoot(base)
  // Create first, then check. Checking first leaves a window between the
  // answer and the use, and on a shared temp directory that window is enough
  // for somebody to drop a symlink at the name and have this write into
  // whatever it points at. An exclusive mkdir either creates the directory,
  // in which case it is ours by construction, or reports that something is
  // already there, which is the case worth inspecting.
  // Canonicalise the parent first, then work inside it. A system temp
  // directory is often behind a legitimate link (macOS puts /var behind
  // /private/var), so refusing every resolved ancestor would refuse ordinary
  // machines. What must not be a link is the leaf: an exclusive mkdir
  // succeeds just as happily through one, and the directory it makes then
  // sits wherever that link points.
  const parent = dirname(root)
  await mkdir(parent, { recursive: true }).catch(() => {})
  let realParent
  try {
    realParent = await realpath(parent)
  } catch (error) {
    throw new Error(`${parent} is not usable for the paste store: ${error?.message ?? error}`)
  }
  const target = join(realParent, basename(root))
  try {
    await mkdir(target, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error
    }
  }
  // lstat, so a link reads as a link rather than as whatever it points at.
  const info = await lstat(target)
  if (!info.isDirectory()) {
    throw new Error(`${target} exists and is not a directory`)
  }
  // POSIX ownership and mode bits are one capability boundary. Windows has
  // neither getuid nor owner/group/other mode distinctions, and reports a
  // directory as 0777 even when its ACL is private. Applying this verdict
  // there would reject every paste without proving anything about its ACL.
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined) {
    if (info.uid !== uid) {
      throw new Error(`${target} belongs to another user`)
    }
    // Narrow it even if it was created wider, so a later paste is not readable
    // by everyone on the machine. A failure here is not cosmetic: it means the
    // directory stays readable by others and this cannot fix it, so the paste
    // is refused rather than written where it can be read.
    if ((info.mode & 0o777) !== 0o700) {
      await chmod(target, 0o700)
      const after = await lstat(target)
      if ((after.mode & 0o777) !== 0o700) {
        throw new Error(`${target} could not be made private`)
      }
    }
  }
  return target
}

/**
 * Remove pastes that have expired, then, if what remains is still too large,
 * the oldest until it is not.
 *
 * The sweep only ever looks inside our own directory. An earlier version
 * scanned the whole system temp directory, which made every paste pay for
 * every unrelated entry there and put the blast radius of a bug in somebody
 * else's files. Entries are read with withFileTypes so a symlink reads as a
 * link and never as the directory it points at, because a cleanup that
 * follows a link is how it becomes somebody else's deleted files.
 *
 * The root is a parameter so tests never run this against the real one, where
 * they would delete a developer's own live pastes. That matters more than it
 * sounds: the route calls this on every successful paste, so any test that
 * exercises the route runs it too.
 */
async function sweepExpiredPastes(now = Date.now(), base = null, maxBytes = PASTE_STORE_MAX_BYTES) {
  try {
    const { readdir, stat, rm } = await import('node:fs/promises')
    const root = pasteRoot(base)
    const kept = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(root, entry.name)
      try {
        const info = await stat(full)
        if (now - info.mtimeMs >= PASTE_TTL_MS) {
          try {
            await rm(full, { recursive: true, force: true })
            continue
          } catch {
            // Held open, or removed only in part. Either way it still
            // occupies the disk, so it stays on the books rather than being
            // silently written off and leaving the ceiling reading low.
          }
        }
        // A directory that cannot be measured still occupies the disk, so it
        // stays on the books at the largest a single paste may be. Erring
        // high makes the ceiling clean sooner; erring low, or dropping the
        // entry, lets the store grow while the ceiling reads comfortable.
        const bytes = await directorySize(full).catch(() => PASTE_MAX_BYTES)
        kept.push({ full, mtimeMs: info.mtimeMs, bytes })
      } catch {
        // Vanished between listing and measuring. A paste must never fail
        // over housekeeping.
      }
    }
    let total = kept.reduce((sum, item) => sum + item.bytes, 0)
    if (total <= maxBytes) return
    for (const item of kept.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= maxBytes) break
      try {
        await rm(item.full, { recursive: true, force: true })
        total -= item.bytes
      } catch {
        // Still held, or gone only in part. Measure what is actually left
        // instead of trusting the subtraction, and keep going: one
        // undeletable directory must not stop the rest from being freed.
        total -= item.bytes - (await directorySize(item.full).catch(() => item.bytes))
      }
    }
  } catch {
    // No directory yet, or no listing available. The paste itself worked.
  }
}

/**
 * What a paste directory occupies, or a throw when that cannot be known.
 *
 * A file that vanished between listing and measuring really does occupy
 * nothing, so it counts as zero. Any other failure means the number would be
 * an undercount, and an undercount here is worse than no answer: the caller
 * puts an unmeasurable directory on the books at the largest a paste may be,
 * while a quietly low number lets the store pass a ceiling it has already
 * exceeded.
 */
async function directorySize(dir) {
  const { readdir, stat } = await import('node:fs/promises')
  let bytes = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    try {
      bytes += (await stat(join(dir, entry.name))).size
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
  }
  return bytes
}

function registerConfigRoute(ctx) {
  ctx.webServer.register({
    name: 'modlens-config',
    kind: 'exact',
    path: '/modlens/config',
    handler: async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (!isTrustedRequest(req)) {
        send(403, { error: 'request refused: this route answers same-origin loopback only' })
        return
      }
      if (req.method === 'GET') {
        try {
          const summary = engineSummary()
          const wantsDiscovery = new URL(req.url, 'http://localhost').searchParams.has('discover')
          if (wantsDiscovery) {
            // null when the probe failed: the card then falls back to the
            // plain grant list rather than showing nothing.
            summary.discovery = await discoverReuse()
          }
          send(200, summary)
        } catch (error) {
          send(409, { error: String(error?.message ?? error) })
        }
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      try {
        const chunks = []
        let total = 0
        for await (const chunk of req) {
          total += chunk.length
          if (total > 64 * 1024) {
            send(413, { error: 'config payload too large' })
            req.destroy()
            return
          }
          chunks.push(chunk)
        }
        const patch = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        // The card's "open config file" link: an action, not a setting.
        if (patch?.open === true) {
          openConfigFile()
          send(200, { opened: true })
          return
        }
        applyEngineSettings(patch)
        send(200, engineSummary())
      } catch (error) {
        send(400, { error: String(error?.message ?? error) })
      }
    },
  })
}

// The two halves of the settings card that live on this side of the socket,
// reachable from the test suite the way client.js exposes `__card`. They read
// and write a real file and a real environment, so they are tested against
// both rather than through the HTTP route.
export const __config = { engineSummary, applyEngineSettings, modlensConfigPath }

// The paste sweeper, reachable from the test suite the way __config is.
export const __paste = {
  sweepExpiredPastes,
  settled: () => lastPasteSweep,
  openPasteRoot,
  pasteRoot,
  ttlMs: PASTE_TTL_MS,
  maxBytes: PASTE_STORE_MAX_BYTES,
}
