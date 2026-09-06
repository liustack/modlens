// Browser half of the modlens dsh plugin: paste-to-path.
//
// A capture-phase paste listener runs before the composer's own handler.
// When the clipboard carries image files, the default intake (attachment ->
// host image admission -> "model does not support images" for text-only
// models) is suppressed; the bytes go to the plugin's host route
// (POST /modlens/paste), land as a private temp file, and the returned path
// is inserted into the composer as plain text. A text-only model then sees
// exactly what Pi, OpenCode, and Claude Code hand their models: a file path,
// which is also the modlens skill's and the read tool's primary trigger.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), so no build step and no
// imports from dsh client packages — the same zero-dependency stance as the
// host half.
window.__ModuleLoader__.load({
  id: '@liustack/modlens',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    function imageFilesOf(event) {
      var items = event.clipboardData?.items
      if (!items) return []
      var files = []
      for (var i = 0; i < items.length; i++) {
        var item = items[i]
        if (item.kind !== 'file') continue
        var file = item.getAsFile()
        if (file && /^image\//.test(file.type)) files.push(file)
      }
      return files
    }

    function insertText(target, text) {
      var el = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') ? target : document.activeElement
      if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return
      el.focus()
      // execCommand fires the input event React's controlled textarea needs;
      // the prototype-setter dance is the fallback for engines dropping it.
      var inserted = false
      try {
        inserted = document.execCommand('insertText', false, text)
      } catch {
        inserted = false
      }
      if (!inserted) {
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, el.value + text)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }

    function uploadOne(file) {
      return file.arrayBuffer().then((buffer) =>
        fetch('/modlens/paste', { method: 'POST', body: buffer }).then((res) => {
          if (!res.ok) {
            return res
              .json()
              .catch(() => ({}))
              .then((body) => {
                var error = new Error(body.error || `paste upload failed (${res.status})`)
                error.status = res.status
                throw error
              })
          }
          return res.json()
        }),
      )
    }

    function currentModelLabel() {
      var buttons = document.querySelectorAll('button[aria-label]')
      for (var i = 0; i < buttons.length; i++) {
        var label = buttons[i].getAttribute('aria-label') || ''
        if (/选择模型|select model|current model/i.test(label)) return label
      }
      return ''
    }

    // Whether to take a paste over is the HOST's call (GET /modlens/paste
    // with the selector label; the host resolves it against real model
    // metadata). A name regex here once declared every vision model it did
    // not recognize text-only and hijacked its native paste. The verdict is
    // cached per label and refreshed in the background; until a label has a
    // cached `true`, pastes stay native — the safe direction for both a
    // vision model (keeps its thumbnail) and a text-only one (keeps only its
    // old error message, once). A 404 means the route is off (pasteToPath:
    // false, or no host half), so the client stands down entirely instead of
    // swallowing pastes into a dead endpoint.
    var routeAvailable = true
    var verdicts = {}
    // A verdict older than this is UNKNOWN again, even while a refresh is in
    // flight: the route's model metadata can change mid-session (discovery
    // sweeps, provider mounts), and acting on a long-stale `true` is exactly
    // the vision-model hijack this design exists to prevent. The bound is a
    // backstop, since every focus and paste re-asks anyway.
    var VERDICT_MAX_AGE_MS = 60000

    function refreshVerdict(label) {
      if (!routeAvailable) return
      var cached = verdicts[label]
      // Dedupe only on an in-flight request, never on freshness: the host's
      // model inventory can change under an unchanged label (a same-named
      // route mounting mid-session), so every focus and paste re-asks and a
      // stale answer survives at most one local round-trip.
      if (cached?.pending) return
      var entry = { pending: true, takeover: cached ? cached.takeover : false, at: cached ? cached.at : 0 }
      verdicts[label] = entry
      fetch(`/modlens/paste?model=${encodeURIComponent(label)}`)
        .then((res) => {
          if (res.status === 404) {
            routeAvailable = false
            entry.pending = false
            return null
          }
          if (!res.ok) throw new Error(`policy ${res.status}`)
          return res.json()
        })
        .then((body) => {
          entry.pending = false
          if (body) {
            entry.takeover = body.takeover === true
            entry.at = Date.now()
          }
        })
        .catch(() => {
          entry.pending = false
        })
    }

    // A paste needs the composer focused first, so a focus-time prefetch has
    // the verdict ready before the first paste can land.
    function onFocusIn() {
      refreshVerdict(currentModelLabel())
    }

    function onPaste(event) {
      if (!routeAvailable) return
      var files = imageFilesOf(event)
      if (files.length === 0) return
      var label = currentModelLabel()
      var cached = verdicts[label]
      refreshVerdict(label)
      // No fresh confirmed host verdict: leave the paste native. Wrong only
      // for a text-only model's very first paste, and self-correcting.
      if (!cached || cached.at === 0 || cached.takeover !== true || Date.now() - cached.at > VERDICT_MAX_AGE_MS) return
      // Take the paste before the composer's intake starts an attachment (and
      // with it the host-side image admission a text-only model fails).
      event.preventDefault()
      event.stopImmediatePropagation()
      var target = event.target
      Promise.all(files.map(uploadOne))
        .then((results) => {
          var text = results
            .map((r) => r.path)
            .filter(Boolean)
            .join(' ')
          if (text) insertText(target, `${text} `)
        })
        .catch((error) => {
          // A 404 here means the route vanished AFTER a verdict confirmed it
          // (plugin disposed mid-session): that race can cost this one paste
          // — preventDefault already ran — but never another. Stand down and
          // forget every verdict, so the next paste goes native immediately.
          if (error && error.status === 404) {
            routeAvailable = false
            verdicts = {}
          }
          console.error(`[modlens] paste-to-path failed: ${error?.message ? error.message : error}`)
        })
    }

    // The settings card (issue #39). dsh renders a fixed set of plugin cards
    // and does not enumerate settings namespaces, so a card is contributed
    // through the `settings.plugin.item` slot rather than by declaring a
    // schema. It reads and writes the host route above, which owns
    // ~/.modlens/config.json: the browser never sees an API key, and never
    // sends a blank one back over a stored key.
    var ENGINES = ['antigravity-cli', 'gemini-api', 'openai', 'anthropic', 'claude-cli']
    var REUSE = ['claude', 'codex', 'opencode', 'pi', 'grok']

    // Two short label sets rather than a locale bundle: the card has a dozen
    // strings, and a bundle would be more machinery than the thing it labels.
    var TEXT = {
      en: {
        title: 'Vision engine (ModLens)',
        subtitle: 'Vision engine provider configuration.',
        openConfig: 'Open config file',
        automatic: 'Automatic (failover chain decides)',
        pickToConfigure: 'Pick an engine above to configure its key and endpoint.',
        engine: 'Engine',
        apiKey: 'API key',
        apiKeyHint:
          'Separate multiple keys with commas. ModLens rotates to the next key after authentication, rate-limit, or quota failures.',
        baseUrl: 'Base URL',
        model: 'Model',
        proxyRoute: 'Proxy route',
        proxyInherit: 'Inherit global or environment proxy',
        proxyDirect: 'Direct connection',
        proxyCustom: 'Custom proxy',
        proxyUrl: 'Proxy URL',
        proxyStored: 'stored, leave empty to keep it',
        proxyExample: 'http://127.0.0.1:7890',
        proxyHint: 'Direct ignores the global proxy and HTTP_PROXY / HTTPS_PROXY.',
        stored: 'stored, leave empty to keep it',
        unset: 'not set',
        fallback: 'provider default',
        save: 'Save',
        saving: 'saving...',
        saved: 'saved',
        loading: 'loading...',
        discard: 'Discard',
        cliNote: 'This engine signs in through its own CLI: no key, no endpoint.',
        autoTitle: 'Auto mode',
        autoHint: 'Reuse the vision engines already on this machine.',
        notLoggedIn: 'found, not signed in',
        loadFailed: 'load failed',
        saveFailed: 'save failed',
        envSourced:
          'These come from environment variables. Saving copies them into the config file, which then becomes this engine’s only source.',
      },
      zh: {
        title: '视觉引擎（ModLens）',
        subtitle: '视觉引擎提供商配置。',
        openConfig: '打开配置文件',
        automatic: '自动（不固定，由故障转移链决定）',
        pickToConfigure: '在上面选一个引擎，才能配置它的密钥和地址。',
        engine: '引擎',
        apiKey: 'API 密钥',
        apiKeyHint: '多个密钥用英文逗号分隔。鉴权、限流或配额失败时会自动轮换到下一个密钥。',
        baseUrl: '接口地址',
        model: '模型',
        proxyRoute: '代理方式',
        proxyInherit: '继承全局代理或环境变量',
        proxyDirect: '直连',
        proxyCustom: '使用专属代理',
        proxyUrl: '代理地址',
        proxyStored: '已保存，留空即不改动',
        proxyExample: 'http://127.0.0.1:7890',
        proxyHint: '直连会忽略全局代理与 HTTP_PROXY / HTTPS_PROXY。',
        stored: '已保存，留空即不改动',
        unset: '未设置',
        fallback: '使用该引擎默认值',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        loading: '加载中…',
        discard: '放弃修改',
        cliNote: '该引擎通过自己的 CLI 登录，无需密钥和接口地址。',
        autoTitle: 'auto 模式',
        autoHint: '自动复用本机已有视觉引擎。',
        notLoggedIn: '已找到，未登录',
        loadFailed: '加载失败',
        saveFailed: '保存失败',
        envSourced: '这些值来自环境变量。保存会把它们写进配置文件，此后该引擎只认配置文件。',
      },
    }

    // The copy this card speaks. `active` is dsh's own interface language,
    // when its locale service was there to say. Asked first because the page
    // language is not an answer on dsh 0.1.0-rc.7: the built index.html
    // freezes `<html lang="zh-CN">` and never rewrites it, so a user set to
    // English still read a Chinese card. Absent the service (older
    // hosts, profiles that ship no locale) the page then the browser decide,
    // unchanged.
    function labels(active) {
      var lang = (active || document.documentElement.lang || navigator.language || 'en').toLowerCase()
      return lang.indexOf('zh') === 0 ? TEXT.zh : TEXT.en
    }

    // What the footer says when a request fails. Whatever the server said
    // travels untranslated ('unknown engine: x', a path error): that is the
    // diagnosis, and mapping it to error codes would buy a translation table
    // with a much larger contact surface than this card is worth. Only the
    // silent case, where there is no detail to show, gets a localized line.
    function noteFrom(error, fallback) {
      // An Error whose message is empty is the no-detail case, not a thing to
      // stringify: String(error) on it reads 'Error'.
      var detail = error && typeof error.message === 'string' ? error.message : error ? String(error) : ''
      return detail || fallback
    }

    // The next draft when the engine changes or a summary arrives. The engine
    // fields belong to the newly selected engine; the reuse grants are
    // the user's pending answers and survive an engine switch, since granting
    // codex has nothing to do with which engine reads the images.
    function nextDraft(summary, provider, keepReuse) {
      // provider '' is its own answer: not pinned, the failover chain
      // decides. There is then no single engine whose key belongs in these
      // fields, so they stay empty and the card says how to get them back.
      var engine = summary.engines[provider] || { baseUrl: '', model: '' }
      return {
        provider: provider,
        apiKey: '',
        baseUrl: engine.baseUrl,
        model: engine.model,
        proxyMode: engine.proxyMode || 'inherit',
        // A proxy URL can carry credentials, so the host reports only its
        // mode. Blank means keep the stored custom URL unless one is typed.
        proxy: '',
        reuse: Object.assign({}, keepReuse || summary.reuse),
      }
    }

    // What one save is actually about. The pin travels only when the select
    // moved; the engine fields only when they were edited. A save that always
    // carried both pinned an engine nobody chose and wrote the values the
    // card loaded back over whatever the file holds now.
    function savePayload(summary, draft) {
      var payload = { reuse: {} }
      REUSE.forEach((name) => {
        if (draft.reuse[name] !== summary.reuse[name]) {
          payload.reuse[name] = draft.reuse[name]
        }
      })
      if (draft.provider !== summary.provider) {
        payload.provider = draft.provider
      }
      var pristine = nextDraft(summary, draft.provider, draft.reuse)
      var apiKey = draft.apiKey || ''
      var baseUrl = draft.baseUrl || ''
      var model = draft.model || ''
      var proxyMode = draft.proxyMode || 'inherit'
      var proxy = draft.proxy || ''
      var apiKeyEdited = apiKey !== ''
      var baseUrlEdited = baseUrl !== pristine.baseUrl
      var modelEdited = model !== pristine.model
      var proxyEdited = proxyMode !== pristine.proxyMode || proxy !== ''
      var engineEdited = apiKeyEdited || baseUrlEdited || modelEdited || proxyEdited
      if (draft.provider !== '' && engineEdited) {
        payload.engine = draft.provider
        if (apiKeyEdited) payload.apiKey = apiKey
        if (baseUrlEdited) payload.baseUrl = baseUrl
        if (modelEdited) payload.model = model
        if (proxyEdited) {
          payload.proxyMode = proxyMode
          // Once the route is inherit or direct, a custom URL is irrelevant
          // and may contain credentials. Do not put stale input on the wire.
          payload.proxy = proxyMode === 'custom' ? proxy : ''
        }
      }
      return payload
    }

    /**
     * How to render key and proxy credential fields with hidden characters.
     *
     * A real password input makes Safari's iCloud Keychain offer to enable
     * autofill for the site and then pop its bubble on every focus, for a
     * field that is always empty: the secret lives in the config file and the
     * host never sends it here, only whether one is stored. `autocomplete`
     * cannot turn that off, because WebKit ignores it on password fields on
     * purpose (issue #56). Masking with text-security gets the same hidden
     * characters without ever being a password field, and it also keeps a
     * machine-local secret out of a synced keychain.
     *
     * Feature-detected rather than assumed. Where the property is missing the
     * field stays a password input: the nuisance is worth more than the
     * alternative, which is somebody's credential rendered in clear text
     * while they type it.
     *
     * This is a trade, not a free win, and the cost falls on people who are
     * not in the room. A password input carries a protected state into the
     * accessibility tree, and screen readers stop reading characters back
     * because of it. Masking is only paint: VoiceOver and NVDA will read this
     * secret aloud, and ARIA has no equivalent to restore. Selection and copy
     * also become possible, and an IME candidate window shows what is being
     * typed above the field. Accepted here because the field is empty in
     * normal use (the stored value is never sent to the browser), so what a
     * screen reader can read back is what the user is
     * typing at that moment, not a stored secret.
     */
    /**
     * Whether this browser masks a text field's characters. Only the prefixed
     * property exists: there is no unprefixed `text-security`, so probing for
     * one would be dead code that reads like a real path.
     *
     * A throwing `supports` counts as no support. The spec says the two
     * argument form returns false for an unknown property rather than
     * throwing, but this runs inside render, where an exception takes the
     * whole settings surface down instead of costing one field.
     */
    function supportsTextSecurity() {
      try {
        return (
          typeof CSS === 'object' &&
          CSS !== null &&
          typeof CSS.supports === 'function' &&
          CSS.supports('-webkit-text-security', 'disc') === true
        )
      } catch {
        return false
      }
    }

    function secretFieldProps() {
      if (!supportsTextSecurity()) {
        return { type: 'password' }
      }
      return {
        type: 'text',
        autoComplete: 'off',
        autoCorrect: 'off',
        autoCapitalize: 'off',
        spellCheck: false,
        style: { WebkitTextSecurity: 'disc' },
      }
    }

    // `localeRef` is a { current } handle on dsh's locale service, not the
    // service itself: it is optional and may land after the card is built,
    // so it is read at render time rather than captured here. Absent, both
    // helpers below hand back nothing and labels() takes its old path.
    function ConfigCard(react, ui, localeRef) {
      var h = react.createElement
      var Input = ui.Input
      // Each load claims a generation. Collapsing before the config arrives
      // invalidates that load because reopening starts a fresh one. Once the
      // form exists, its in-flight discovery stays relevant across collapse.
      // The counter survives renders because ConfigCard is built once.
      var gen = 0

      // Built once per card so useSyncExternalStore is not handed a new
      // subscribe on every render, which would resubscribe every render.
      var subscribeLocale = (onChange) => {
        var locale = localeRef?.current
        return locale ? locale.subscribe(onChange) : () => {}
      }
      var readLocale = () => {
        var locale = localeRef?.current
        return locale ? locale.getSnapshot().active : ''
      }

      // The chrome is the native plugin card's, value for value (border,
      // layer backgrounds, 12px radius, header row with a rotating chevron,
      // footer with discard ghost + save primary), so this card reads as a
      // sibling of the built-in three rather than a lodger.
      var chevron = (open) =>
        h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 16 16',
            style: {
              color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
              flex: 'none',
              transition: 'transform .16s',
              transform: open ? 'rotate(180deg)' : 'none',
            },
          },
          h('path', {
            d: 'M4 6l4 4 4-4',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )

      return function ModlensCard() {
        // Subscribed, not sampled: the language is a live setting, and a card
        // sitting open while the user switches has to follow. getSnapshot and
        // subscribe are the pair dsh documents as useSyncExternalStore-safe.
        // That hook is React 18 and up; where it is missing the language is
        // read once per render instead, which still follows a switch as soon
        // as anything re-renders the card. The branch is on a closure
        // constant, so hook order never varies within one card.
        var t = labels(
          typeof react.useSyncExternalStore === 'function'
            ? react.useSyncExternalStore(subscribeLocale, readLocale)
            : readLocale(),
        )
        var openState = react.useState(false)
        var summaryState = react.useState(null)
        var draftState = react.useState(null)
        var noteState = react.useState('')
        var open = openState[0]
        var summary = summaryState[0]
        var draft = draftState[0]
        var note = noteState[0]

        var seed = (next, provider, keepReuse) => nextDraft(next, provider, keepReuse)

        var load = react.useCallback(() => {
          // Config first, so the engine form can render. Discovery is the
          // self-check probing which local harnesses exist to be borrowed,
          // paid after the form is up, cached host-side.
          var id = ++gen
          fetch('/modlens/config')
            .then((r) =>
              r.json().then((body) => {
                if (!r.ok) throw new Error(body.error || '')
                return body
              }),
            )
            .then((next) => {
              if (id !== gen) return
              summaryState[1](next)
              draftState[1](seed(next, next.provider))
              noteState[1]('')
              return fetch('/modlens/config?discover=1')
                .then((r) =>
                  r.json().then((body) => {
                    if (!r.ok) throw new Error(body.error || '')
                    return body
                  }),
                )
                .then((discovered) => {
                  if (id !== gen) return
                  summaryState[1]((prev) => {
                    if (!prev) return prev
                    var merged = Object.assign({}, prev)
                    merged.discovery = discovered && 'discovery' in discovered ? discovered.discovery : null
                    return merged
                  })
                })
                .catch(() => {
                  if (id !== gen) return
                  summaryState[1]((prev) => {
                    if (!prev) return prev
                    var merged = Object.assign({}, prev)
                    merged.discovery = null
                    return merged
                  })
                })
            })
            .catch((error) => {
              if (id !== gen) return
              noteState[1](noteFrom(error, t.loadFailed))
            })
        }, [])

        react.useEffect(() => {
          if (open && summary === null) load()
        }, [open, summary, load])

        // A row wrapping ONE control is a label, which names that control. A
        // row wrapping a set of them must not be: the label becomes the first
        // checkbox's accessible name and swallows the whole section's prose.
        // Those rows are a named group instead.
        var fieldRow = (label, control, key, groupName) =>
          h(
            groupName ? 'div' : 'label',
            {
              key: key,
              role: groupName ? 'group' : undefined,
              'aria-label': groupName || undefined,
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                padding: '12px 0',
                borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              },
            },
            h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, inherit)' } }, label),
            control,
          )

        var body = null
        if (open) {
          if (summary === null || draft === null) {
            body = h(
              'div',
              {
                style: {
                  padding: '12px 0',
                  color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                  fontSize: '13px',
                },
              },
              note || t.loading,
            )
          } else {
            var keyless = (summary.keyless || []).indexOf(draft.provider) >= 0
            var current = summary.engines[draft.provider] || { hasKey: false }
            var pristine = seed(summary, draft.provider)
            var dirty =
              draft.provider !== summary.provider ||
              draft.apiKey !== '' ||
              draft.baseUrl !== pristine.baseUrl ||
              draft.model !== pristine.model ||
              draft.proxyMode !== pristine.proxyMode ||
              draft.proxy !== '' ||
              REUSE.some((name) => draft.reuse[name] !== summary.reuse[name])
            var customProxyMissing =
              draft.proxyMode === 'custom' && current.proxyMode !== 'custom' && draft.proxy.trim() === ''
            var canDiscard = dirty && note !== t.saving
            var canSave = canDiscard && !customProxyMissing

            var set = (key, value) => {
              var next = Object.assign({}, draft)
              next[key] = value
              draftState[1](next)
              noteState[1]('')
            }

            var inputProps = (key, placeholder) => ({
              value: draft[key],
              placeholder: placeholder,
              onChange: (event) => {
                set(key, event.target.value)
              },
            })
            var textField = (label, key, type, placeholder) =>
              fieldRow(label, h(Input, Object.assign(inputProps(key, placeholder), { type: type })), key)
            // Its own function rather than a `type` string the caller has to
            // spell right. A sentinel compared with `===` fails open: one
            // typo, or a later edit passing 'text', and the key renders in
            // clear text with every test still green.
            var secretField = (label, key, placeholder) =>
              fieldRow(label, h(Input, Object.assign(inputProps(key, placeholder), secretFieldProps())), key)

            // Auto mode: the probes say which harnesses exist on this
            // machine. Found ones get a checkbox with their status; missing
            // ones are named as absent so the list explains itself.
            var probes = Array.isArray(summary.discovery) ? summary.discovery : null
            // Being listed means being found: an absent harness is simply
            // not shown, and only "not signed in" earns a note.
            var autoRows = REUSE.filter((name) => {
              if (!probes) return true
              var probe = probes.find((candidate) => candidate.harness === name)
              return probe ? probe.cliFound : false
            }).map((name) => {
              var probe = probes?.find((candidate) => candidate.harness === name)
              return h(
                'label',
                {
                  key: name,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontSize: '13px',
                  },
                },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(draft.reuse[name]),
                  onChange: (event) => {
                    var next = Object.assign({}, draft.reuse)
                    next[name] = event.target.checked
                    set('reuse', next)
                  },
                }),
                h('span', null, name),
                probe && probe.loggedIn === false
                  ? h(
                      'span',
                      {
                        style: {
                          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                          fontSize: '12px',
                        },
                      },
                      t.notLoggedIn,
                    )
                  : null,
              )
            })

            body = h(
              'div',
              null,
              fieldRow(
                t.engine,
                h(
                  'select',
                  {
                    value: draft.provider,
                    onChange: (event) => {
                      draftState[1](seed(summary, event.target.value, draft.reuse))
                      noteState[1]('')
                    },
                    style: {
                      appearance: 'none',
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                      background: 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      fontSize: '13px',
                    },
                  },
                  [h('option', { key: '', value: '' }, t.automatic)].concat(
                    ENGINES.map((name) => h('option', { key: name, value: name }, name)),
                  ),
                ),
                'engine',
              ),
              draft.provider === ''
                ? fieldRow(
                    t.apiKey,
                    h(
                      'div',
                      {
                        style: {
                          fontSize: '13px',
                          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        },
                      },
                      t.pickToConfigure,
                    ),
                    'unpinned',
                  )
                : keyless
                  ? fieldRow(
                      t.apiKey,
                      h(
                        'div',
                        {
                          style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' },
                        },
                        t.cliNote,
                      ),
                      'clinote',
                    )
                  : secretField(t.apiKey, 'apiKey', current.hasKey ? t.stored : t.unset),
              draft.provider === '' || keyless
                ? null
                : fieldRow(
                    '',
                    h(
                      'div',
                      {
                        style: {
                          fontSize: '13px',
                          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        },
                      },
                      t.apiKeyHint,
                    ),
                    'api-key-rotation',
                  ),
              draft.provider === '' || keyless ? null : textField(t.baseUrl, 'baseUrl', 'text', t.fallback),
              draft.provider === '' ? null : textField(t.model, 'model', 'text', t.fallback),
              draft.provider === '' || keyless
                ? null
                : fieldRow(
                    t.proxyRoute,
                    h(
                      'select',
                      {
                        name: 'proxyMode',
                        value: draft.proxyMode,
                        onChange: (event) => set('proxyMode', event.target.value),
                        style: {
                          appearance: 'none',
                          width: '100%',
                          padding: '8px 12px',
                          borderRadius: '8px',
                          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                          background: 'transparent',
                          color: 'inherit',
                          font: 'inherit',
                          fontSize: '13px',
                        },
                      },
                      [
                        h('option', { key: 'inherit', value: 'inherit' }, t.proxyInherit),
                        h('option', { key: 'direct', value: 'direct' }, t.proxyDirect),
                        h('option', { key: 'custom', value: 'custom' }, t.proxyCustom),
                      ],
                    ),
                    'proxy-mode',
                  ),
              draft.provider === '' || keyless
                ? null
                : fieldRow(
                    '',
                    h(
                      'div',
                      {
                        style: {
                          fontSize: '13px',
                          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        },
                      },
                      t.proxyHint,
                    ),
                    'proxy-hint',
                  ),
              draft.provider === '' || keyless || draft.proxyMode !== 'custom'
                ? null
                : secretField(t.proxyUrl, 'proxy', current.proxyMode === 'custom' ? t.proxyStored : t.proxyExample),
              // Where these values are coming from, said once, because the
              // first save moves them: an engine the file names takes its
              // settings from the file alone.
              draft.provider === '' || current.source !== 'env'
                ? null
                : fieldRow(
                    '',
                    h(
                      'div',
                      {
                        style: {
                          fontSize: '13px',
                          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        },
                      },
                      t.envSourced,
                    ),
                    'envsourced',
                  ),
              fieldRow(
                h(
                  'span',
                  null,
                  t.autoTitle,
                  h(
                    'span',
                    {
                      style: {
                        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        fontWeight: 400,
                        marginLeft: '8px',
                      },
                    },
                    t.autoHint,
                  ),
                ),
                h(
                  'div',
                  { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 18px', paddingTop: '2px' } },
                  'discovery' in summary ? autoRows : t.loading,
                ),
                'auto',
                t.autoTitle,
              ),
              h(
                'div',
                {
                  key: 'footer',
                  style: {
                    borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '12px 0 4px',
                  },
                },
                h(
                  'a',
                  {
                    href: '#',
                    onClick: (event) => {
                      event.preventDefault()
                      fetch('/modlens/config', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ open: true }),
                      }).catch(() => {})
                    },
                    style: {
                      fontSize: '12px',
                      color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                      textDecoration: 'underline',
                      textUnderlineOffset: '2px',
                    },
                  },
                  t.openConfig,
                ),
                h(
                  'span',
                  {
                    role: 'status',
                    style: {
                      marginRight: 'auto',
                      marginLeft: '10px',
                      fontSize: '12px',
                      color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                    },
                  },
                  note,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !canDiscard,
                    onClick: () => {
                      draftState[1](seed(summary, summary.provider))
                      noteState[1]('')
                    },
                    style: {
                      appearance: 'none',
                      font: 'inherit',
                      fontSize: '13px',
                      lineHeight: 1.5,
                      cursor: canDiscard ? 'pointer' : 'default',
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                      borderRadius: '8px',
                      padding: '5px 14px',
                      background: 'none',
                      color: 'var(--dsw-alias-label-secondary, inherit)',
                      opacity: canDiscard ? 1 : 0.4,
                    },
                  },
                  t.discard,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !canSave,
                    onClick: () => {
                      noteState[1](t.saving)
                      var payload = savePayload(summary, draft)
                      fetch('/modlens/config', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify(payload),
                      })
                        .then((r) =>
                          r.json().then((payload) => {
                            if (!r.ok) throw new Error(payload.error || '')
                            return payload
                          }),
                        )
                        .then((next) => {
                          // The save response carries no discovery. Read the
                          // current state here because the lazy probe may have
                          // landed after this save began.
                          summaryState[1]((prev) => {
                            if (!prev || !('discovery' in prev)) return next
                            var merged = Object.assign({}, next)
                            merged.discovery = prev.discovery
                            return merged
                          })
                          draftState[1](seed(next, next.provider))
                          noteState[1](t.saved)
                        })
                        .catch((error) => {
                          noteState[1](noteFrom(error, t.saveFailed))
                        })
                    },
                    style: {
                      appearance: 'none',
                      font: 'inherit',
                      fontSize: '13px',
                      lineHeight: 1.5,
                      cursor: canSave ? 'pointer' : 'default',
                      border: '1px solid transparent',
                      borderRadius: '8px',
                      padding: '5px 14px',
                      background: 'var(--dsw-alias-label-primary, currentColor)',
                      color: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
                      opacity: canSave ? 1 : 0.4,
                    },
                  },
                  t.save,
                ),
              ),
            )
          }
        }

        return h(
          'div',
          {
            style: {
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              background: open
                ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))'
                : 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
              borderRadius: '12px',
              transition: 'border-color .16s, background .16s',
            },
          },
          h(
            'button',
            {
              type: 'button',
              'aria-expanded': open,
              onClick: () => {
                if (open && summary === null) gen += 1
                openState[1](!open)
              },
              style: {
                appearance: 'none',
                width: '100%',
                font: 'inherit',
                color: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                background: 'none',
                border: 0,
                borderRadius: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '14px 16px',
              },
            },
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: '14px', fontWeight: 600 } }, t.title),
              h(
                'div',
                {
                  style: {
                    color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                    fontSize: '13px',
                    lineHeight: 1.5,
                  },
                },
                t.subtitle,
              ),
            ),
            chevron(open),
          ),
          open ? h('div', { style: { margin: '0 16px', paddingBottom: '8px' } }, body) : null,
        )
      }
    }

    function registerCard(ctx) {
      // Reaching for an undeclared service throws in cordis, so each optional
      // dependency rides a scoped ctx.inject of its own: the closure runs
      // where the service exists and never runs where it does not, exactly as
      // the host half takes webServer.
      if (typeof ctx.inject !== 'function') return

      // dsh's language service gets an inject of its own, and fills a handle
      // the card reads later. Listing it beside slots would be worse than
      // useless: ctx.inject waits for every service named, so on a host that
      // never provides locale the card would never register at all. Here a
      // missing service just leaves the handle empty, and the card falls back
      // to the page language.
      var localeRef = { current: null }
      ctx.inject(['locale'], (scope) => {
        localeRef.current = scope.locale
        if (typeof scope.effect === 'function') {
          scope.effect(
            () => () => {
              localeRef.current = null
            },
            'modlens: locale handle',
          )
        }
      })

      ctx.inject(['slots'], (scope) => {
        // The card and its route live and die together: with the host route
        // off (settingsCard: false, or no web profile) a card would only
        // render an error, which is not what turning a feature off means.
        // Any response at all proves the route exists; only a 404 or a
        // network failure reads as absent.
        fetch('/modlens/config')
          .then((response) => {
            if (response.status === 404) return
            try {
              mountCard(scope, localeRef)
            } catch (error) {
              console.error(`[modlens] settings card skipped: ${error}`)
            }
          })
          .catch(() => {})
      })
    }

    function mountCard(ctx, localeRef) {
      var react
      try {
        react = require('react')
      } catch (error) {
        console.error(`[modlens] settings card skipped: ${error}`)
        return
      }
      var ui = require('@deepseek-ai/dsh-client-ui-primitives')
      var Card = ConfigCard(react, ui, localeRef)
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({ name: 'settings.plugin.item', id: 'modlens', key: 'modlens', order: 30 }, Card)
      })
    }

    function apply(ctx) {
      registerCard(ctx)
      document.addEventListener('paste', onPaste, true)
      document.addEventListener('focusin', onFocusIn, true)
      // cordis effect: unregister on plugin disposal (HMR, profile reload).
      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            document.removeEventListener('paste', onPaste, true)
            document.removeEventListener('focusin', onFocusIn, true)
          },
          'modlens: paste-to-path listener',
        )
      }
    }

    exports.apply = apply
    // Exposed for the repo's tests only; not part of the plugin contract.
    exports.__card = {
      nextDraft: nextDraft,
      savePayload: savePayload,
      secretFieldProps: secretFieldProps,
      ConfigCard: ConfigCard,
    }
    // `slots` and `locale` are both optional, so neither is required here:
    // registerCard takes each on its own scoped inject.
    exports.inject = []
    return module.exports
  },
})
