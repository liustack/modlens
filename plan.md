# Session Summary: Design Rationale

## 1. Goal: Provide Plug-in Capabilities for Agents/LLMs — Not a Monolithic Proxy

The initial idea was to build a Claude/Anthropic API-compatible proxy so that clients like Claude Code could use open-source models behind the scenes, intercepting capability gaps (image understanding, web search) along the way.

The direction was later narrowed to a lighter, more decoupled approach:

> **No proxy, no model replacement.**
> Instead, build a set of "Agent Skill plug-ins" — standalone CLIs that give any LLM/agent vision, search, and fetch capabilities via tool invocation.

This path is more universal, lower-coupling, easier to evolve, and avoids being locked to any single client protocol (Claude Code / Anthropic API).

---

## 2. Core Principle: One Skill Does One Thing (Composable and Pure)

A critical product principle was established early:

- **One skill, one responsibility**
- No all-in-one bundles; no cramming multiple concerns into a single CLI
- Composition is the agent's (or orchestrator's) job; low-level tools stay single-purpose

Capabilities are split into three independent plug-ins:

1. **modlens** — vision only
2. **modsearch** — search only
3. **modfetch** — web page fetching only

They relate to each other in a pipeline/composition model, not an all-in-one model.

---

## 3. Real Capability Gaps Being Addressed

### 3.1 Vision Plug-in (modlens)

Many open-source or text-only models lack multimodal vision. ModLens bridges the gap:

- **Input**: user-provided images (screenshots, documents, photos, charts)
- **Processing**: structured extraction via a pluggable vision backend (v1 uses Gemini CLI; future engines include PaddleOCR, DeepSeek OCR, and other multimodal models)
- **Output**: structured "text evidence"
- **Usage**: the upstream agent injects this output into context so text-only LLMs can "see" image content

In essence:

> **image → text evidence adapter layer**
> Enables non-multimodal models to consume image information in text form.

### 3.2 Search Plug-in (modsearch)

Many agents/models lack stable web search. This plug-in provides a unified entry point:

- **Input**: query
- **Output**: result list (title / url / snippet …)
- **Usage**: agent searches first, then decides which links to fetch

### 3.3 Fetch Plug-in (modfetch)

Search only returns links; to let a model actually "read" web content requires fetch:

- **Input**: URL
- **Output**: page body text (HTML → visible text extraction; non-HTML → best-effort)
- **Usage**: agent calls modfetch on selected search result URLs, feeds body text to the LLM for summarization/citation

---

## 4. Interaction Design: Minimal, Flat, Agent-Oriented

These tools are primarily **called by agents**, not typed by humans, so the design goals are:

- **No sub-commands** (no `modlens extract ...`)
- Flat parameters (e.g., `modlens -i ./img.png`)
- Short commands, short flags, predictable behavior

The underlying objective:

> **Minimize agent invocation cost and failure surface**
> (fewer parsing layers, fewer state branches, fewer tool-error categories).

---

## 5. Distribution Strategy: Pure JS/TS + npm — Minimal Install Friction

### 5.1 Why Go Was Ruled Out

Cross-compiled Go binaries were considered, but the friction points were too numerous:

- Multi-platform artifact maintenance (arch × os combinations)
- macOS Gatekeeper / quarantine UX
- Windows path / permission / AV false-positive issues
- Asking users to install Go and compile is awkward

### 5.2 Why JS/TS + npm Won

Key assumption: users of AI coding tools (Codex, Claude Code, etc.) almost always have Node.js installed.

- npm distribution lets agents auto-install/update/run with ease
- No cross-platform binary, permission, or release factory overhead

Decision:

> **Pure JS/TS via npm** — shortest install path, highest success rate.

---

## 6. Desired End State (from the Agent's Perspective)

The plug-in ecosystem should enable workflows like:

1. User provides images → call **modlens** for text evidence → inject into context → let LLM reason/summarize
2. User asks a question requiring live info → call **modsearch** for candidate links → select targets → call **modfetch** for body text → let LLM summarize with citations

One-liner:

> **Turn "vision / search / fetch" into three composable CLI skills**
> so any agent/LLM can acquire these capabilities via tool invocation, without relying on native multimodal or built-in web tools.

---

## 7. Naming and Product Positioning (Finalized)

- Vision plug-in: **modlens**
- Search plug-in: **modsearch**
- Fetch plug-in: **modfetch**

Naming convention:

- `mod*` prefix = modular capability patch
- Suffix = specific capability organ (lens / search / fetch)

This convention naturally extends to future plug-ins (e.g., modpdf, modaudio, modcache …), each adhering to single responsibility.
