#!/bin/sh
# modlens skill launcher (macOS / Linux).
#
# One stable action for the agent ("run modlens"); this script picks a working
# way to run it in the current environment. Written to POSIX sh so it runs under
# dash, busybox ash, and bash alike. Invoke it with `bash run.sh ...` (or plain
# `sh run.sh ...`) so a lost execute bit after a file copy never matters.
#
# Resolution order (kept identical in run.ps1):
#   1. A compatible modlens already on PATH  -> run it directly.
#   2. npx present                             -> run the pinned npm version.
#   3. bunx present                            -> run the pinned version via Bun.
#   4. (phase B placeholder) a native artifact -> not published yet.
#   5. Nothing usable                          -> structured diagnosis, exit 78.
#
# It never writes PATH, never needs admin rights, never fetches a second script,
# and has no postinstall step.
set -eu

# --- Version constants: stamped by scripts/release.mjs at release time. --------
# Do not edit PINNED by hand; scripts/stamp.test.mjs asserts it equals the
# package.json version, and the release script rewrites it on every bump.
PKG="@liustack/modlens"
BIN="modlens"
PINNED="3.26.0"
# -------------------------------------------------------------------------------

NATIVE_NOTE="no native artifact is published for this tool yet; phase A ships npm launch paths only"

# Split "X.Y.Z" (extra suffix ignored) into the globals _MAJ, _MIN, _PAT.
# Any non-numeric component becomes 0 so integer tests below never abort.
parse_semver() {
  _raw="$1"
  _MAJ="${_raw%%.*}"
  _rest="${_raw#*.}"
  if [ "$_rest" = "$_raw" ]; then
    _MIN=0
    _PAT=0
  else
    _MIN="${_rest%%.*}"
    _rest2="${_rest#*.}"
    if [ "$_rest2" = "$_rest" ]; then _PAT=0; else _PAT="${_rest2%%.*}"; fi
  fi
  case "$_MAJ" in '' | *[!0-9]*) _MAJ=0 ;; esac
  case "$_MIN" in '' | *[!0-9]*) _MIN=0 ;; esac
  case "$_PAT" in '' | *[!0-9]*) _PAT=0 ;; esac
}

# Compatible = same major version as PINNED AND not older than PINNED.
# Same major keeps a globally installed CLI usable without a forced re-download;
# not-older refuses a stale build that predates the version this skill needs.
compatible() {
  parse_semver "$1"
  _f_maj=$_MAJ
  _f_min=$_MIN
  _f_pat=$_PAT
  parse_semver "$PINNED"
  [ "$_f_maj" = "$_MAJ" ] || return 1
  if [ "$_f_min" -gt "$_MIN" ]; then return 0; fi
  if [ "$_f_min" -lt "$_MIN" ]; then return 1; fi
  [ "$_f_pat" -ge "$_PAT" ]
}

# First "X.Y.Z" token printed by `$BIN --version`.
cli_version() {
  "$BIN" --version 2>/dev/null | head -n 1 |
    sed -n 's/.*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p'
}

# The npx path runs the CLI on this machine's node, so npx is only usable when
# node itself meets the CLI's floor. An old node with a working npx used to be
# selected anyway, a path known to fail at run time.
NODE_FLOOR="22.19.0"
node_meets_floor() {
  command -v node >/dev/null 2>&1 || return 1
  _nv="$(node --version 2>/dev/null | sed 's/^v//')"
  [ -n "$_nv" ] || return 1
  parse_semver "$NODE_FLOOR"
  _floor_maj="$_MAJ"
  _floor_min="$_MIN"
  parse_semver "$_nv"
  if [ "$_MAJ" -gt "$_floor_maj" ]; then return 0; fi
  if [ "$_MAJ" -lt "$_floor_maj" ]; then return 1; fi
  [ "$_MIN" -ge "$_floor_min" ]
}

# Echo exactly one word: the chosen launch path.
resolve() {
  if command -v "$BIN" >/dev/null 2>&1; then
    _v="$(cli_version)"
    if [ -n "$_v" ] && compatible "$_v"; then
      echo "path"
      return
    fi
  fi
  if command -v npx >/dev/null 2>&1 && node_meets_floor; then
    echo "npx"
    return
  fi
  if command -v bunx >/dev/null 2>&1; then
    echo "bunx"
    return
  fi
  # Phase B goes here: check a versioned user cache, then download and verify a
  # native artifact into it. Any such download must use curl (never a piped
  # second script), which does not stamp quarantine / Mark-of-the-Web the way a
  # browser does, matching design.md 8.3.
  echo "none"
}

# Run the resolved CLI without exec, so its output can be captured (used to
# chain the CLI's own doctor). Passes every argument through untouched.
run_cli() {
  case "$G_SEL" in
    path) "$BIN" "$@" ;;
    npx) npx --yes --package "$PKG@$PINNED" "$BIN" "$@" ;;
    bunx) bunx --bun "$PKG@$PINNED" "$@" ;;
  esac
}

detect_os() { uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]'; }

detect_arch() {
  _a="$(uname -m 2>/dev/null)"
  case "$_a" in
    x86_64 | amd64) echo "x64" ;;
    aarch64 | arm64) echo "arm64" ;;
    *) echo "$_a" ;;
  esac
}

# Escape a value for a JSON string literal (backslash and double quote).
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# Render "null" for an empty value, else an escaped JSON string.
jstr() {
  if [ -z "$1" ]; then printf 'null'; else printf '"%s"' "$(json_escape "$1")"; fi
}

# 1 -> true, anything else -> false.
jbool() { if [ "$1" = "1" ]; then printf 'true'; else printf 'false'; fi; }

# Probe the environment once into G_* globals shared by the emitters.
collect() {
  G_OS="$(detect_os)"
  G_ARCH="$(detect_arch)"

  G_CLI_PRESENT=0
  G_CLI_PATH=""
  G_CLI_VER=""
  G_CLI_COMPAT=0
  if command -v "$BIN" >/dev/null 2>&1; then
    G_CLI_PRESENT=1
    G_CLI_PATH="$(command -v "$BIN")"
    G_CLI_VER="$(cli_version)"
    if [ -n "$G_CLI_VER" ] && compatible "$G_CLI_VER"; then G_CLI_COMPAT=1; fi
  fi

  G_NPX_PRESENT=0
  G_NPX_PATH=""
  if command -v npx >/dev/null 2>&1; then
    G_NPX_PRESENT=1
    G_NPX_PATH="$(command -v npx)"
  fi

  G_BUNX_PRESENT=0
  G_BUNX_PATH=""
  if command -v bunx >/dev/null 2>&1; then
    G_BUNX_PRESENT=1
    G_BUNX_PATH="$(command -v bunx)"
  fi

  G_NODE_PRESENT=0
  G_NODE_VER=""
  if command -v node >/dev/null 2>&1; then
    G_NODE_PRESENT=1
    G_NODE_VER="$(node --version 2>/dev/null | sed 's/^v//')"
  fi

  G_NODE_FLOOR_OK=0
  if node_meets_floor; then G_NODE_FLOOR_OK=1; fi

  G_SEL="$(resolve)"
}

# Build the nextSteps JSON array body (without the brackets) into G_NEXTSTEPS.
compute_next_steps() {
  if [ "$G_SEL" = "none" ]; then
    if [ "$G_NPX_PRESENT" = 1 ] && [ "$G_NODE_FLOOR_OK" = 0 ]; then
      _s1="npx is present but node ${G_NODE_VER:-missing} is below the $NODE_FLOOR floor this CLI needs. Upgrade Node at https://nodejs.org, then re-run this launcher."
    else
      _s1="Install Node 22.19+ from https://nodejs.org so npx can run $PKG@$PINNED, then re-run this launcher."
    fi
    _s2="No JavaScript runtime? Install Bun from https://bun.sh to use bunx, or put a compatible $BIN (major ${PINNED%%.*}, at or above $PINNED) on PATH."
    G_NEXTSTEPS="$(printf '"%s", "%s"' "$(json_escape "$_s1")" "$(json_escape "$_s2")")"
  else
    G_NEXTSTEPS=""
  fi
}

# Emit the structured diagnosis. $1, when a JSON object, is embedded as cliDoctor.
emit_json() {
  _chained="${1:-}"
  compute_next_steps
  printf '{\n'
  printf '  "tool": %s,\n' "$(jstr "$BIN")"
  printf '  "package": %s,\n' "$(jstr "$PKG")"
  printf '  "pinnedVersion": %s,\n' "$(jstr "$PINNED")"
  printf '  "os": %s,\n' "$(jstr "$G_OS")"
  printf '  "arch": %s,\n' "$(jstr "$G_ARCH")"
  printf '  "checked": {\n'
  printf '    "pathCli": { "present": %s, "path": %s, "version": %s, "compatible": %s },\n' \
    "$(jbool "$G_CLI_PRESENT")" "$(jstr "$G_CLI_PATH")" "$(jstr "$G_CLI_VER")" "$(jbool "$G_CLI_COMPAT")"
  printf '    "npx": { "present": %s, "path": %s, "nodeMeetsFloor": %s },\n' "$(jbool "$G_NPX_PRESENT")" "$(jstr "$G_NPX_PATH")" "$(jbool "$G_NODE_FLOOR_OK")"
  printf '    "bunx": { "present": %s, "path": %s },\n' "$(jbool "$G_BUNX_PRESENT")" "$(jstr "$G_BUNX_PATH")"
  printf '    "node": { "present": %s, "version": %s }\n' "$(jbool "$G_NODE_PRESENT")" "$(jstr "$G_NODE_VER")"
  printf '  },\n'
  printf '  "nativeArtifact": { "available": false, "note": %s },\n' "$(jstr "$NATIVE_NOTE")"
  printf '  "selected": %s,\n' "$(jstr "$G_SEL")"
  printf '  "nextSteps": [%s],\n' "$G_NEXTSTEPS"
  # First character of the captured output, via POSIX parameter expansion
  # (cut -c1 would take the first char of every line, not of the whole string).
  _first="${_chained%"${_chained#?}"}"
  if [ -n "$_chained" ] && [ "$_first" = "{" ]; then
    printf '  "cliDoctor": %s\n' "$_chained"
  else
    printf '  "cliDoctor": null\n'
  fi
  printf '}\n'
}

# Human-readable diagnosis for `doctor` without --json.
emit_text() {
  printf '%s launcher diagnosis\n\n' "$BIN"
  printf '  os / arch:      %s / %s\n' "$G_OS" "$G_ARCH"
  printf '  pinned version: %s (%s)\n' "$PINNED" "$PKG"
  if [ "$G_CLI_PRESENT" = 1 ]; then
    printf '  %s on PATH:  %s (version %s, %s)\n' "$BIN" "$G_CLI_PATH" \
      "${G_CLI_VER:-unknown}" "$([ "$G_CLI_COMPAT" = 1 ] && echo compatible || echo incompatible)"
  else
    printf '  %s on PATH:  no\n' "$BIN"
  fi
  _npx_desc="no"
  if [ "$G_NPX_PRESENT" = 1 ]; then
    if [ "$G_NODE_FLOOR_OK" = 1 ]; then
      _npx_desc="$G_NPX_PATH"
    else
      _npx_desc="$G_NPX_PATH (unusable: node ${G_NODE_VER:-missing} is below $NODE_FLOOR)"
    fi
  fi
  printf '  npx:            %s\n' "$_npx_desc"
  printf '  bunx:           %s\n' "$([ "$G_BUNX_PRESENT" = 1 ] && echo "$G_BUNX_PATH" || echo no)"
  printf '  node:           %s\n' "$([ "$G_NODE_PRESENT" = 1 ] && echo "${G_NODE_VER:-yes}" || echo no)"
  printf '  selected path:  %s\n' "$G_SEL"
  if [ "$G_SEL" = "none" ]; then
    printf '\nNo runtime can launch %s here. %s\n' "$BIN" "$NATIVE_NOTE"
    printf 'Next steps:\n'
    printf '  - Install Node 22.19+ from https://nodejs.org, then re-run this launcher.\n'
    printf '  - Or install Bun from https://bun.sh, or put a compatible %s on PATH.\n' "$BIN"
  fi
}

# `doctor [--json] [extra...]`: launcher selection diagnosis. When a CLI is
# resolvable, chain the CLI's own doctor (engine/config diagnosis) so one call
# reports both layers. Extra flags pass through to the chained CLI doctor.
doctor() {
  collect
  _json=0
  for _a in "$@"; do
    if [ "$_a" = "--json" ]; then _json=1; fi
  done
  if [ "$_json" = 1 ]; then
    _chained=""
    if [ "$G_SEL" != "none" ]; then
      _chained="$(run_cli doctor "$@" 2>/dev/null)" || _chained=""
    fi
    emit_json "$_chained"
  else
    emit_text
    if [ "$G_SEL" != "none" ]; then
      printf '\n--- %s doctor ---\n' "$BIN"
      run_cli doctor "$@" || true
    fi
  fi
}

# Default action: forward every argument to the resolved CLI, inheriting stdio
# and exit code. No usable runtime -> structured diagnosis on stderr, exit 78
# (EX_CONFIG) so the agent never mistakes the diagnosis for a result.
run() {
  _sel="$(resolve)"
  case "$_sel" in
    path) exec "$BIN" "$@" ;;
    npx) exec npx --yes --package "$PKG@$PINNED" "$BIN" "$@" ;;
    bunx) exec bunx --bun "$PKG@$PINNED" "$@" ;;
    none)
      collect
      emit_json "" >&2
      exit 78
      ;;
  esac
}

case "${1:-}" in
  doctor)
    shift
    doctor "$@"
    ;;
  where)
    resolve
    ;;
  *)
    run "$@"
    ;;
esac
