# modlens skill launcher (Windows, PowerShell 5.1 compatible).
#
# The Windows twin of run.sh: identical resolution order, identical diagnostic
# fields, identical exit codes. One stable action for the agent ("run
# modlens"); this script picks a working way to run it here.
#
# Invoke it per-process so no global policy is touched:
#   powershell -ExecutionPolicy Bypass -File run.ps1 -q "test"
#
# Resolution order (kept identical in run.sh):
#   1. A compatible modlens already on PATH  -> run it directly.
#   2. npx present                             -> run the pinned npm version.
#   3. bunx present                            -> run the pinned version via Bun.
#   4. (phase B placeholder) a native artifact -> not published yet.
#   5. Nothing usable                          -> structured diagnosis, exit 78.
#
# It never writes PATH, never needs admin rights, never fetches a second script,
# and has no postinstall step.

$ErrorActionPreference = 'Stop'

# --- Version constants: stamped by scripts/release.mjs at release time. --------
# Do not edit $Pinned by hand; scripts/stamp.test.mjs asserts it equals the
# package.json version, and the release script rewrites it on every bump.
$Package = '@liustack/modlens'
$Bin = 'modlens'
$Pinned = '3.26.0'
# -------------------------------------------------------------------------------

$NativeNote = 'no native artifact is published for this tool yet; phase A ships npm launch paths only'

# Environment snapshot, filled by Collect and read by the emitters.
$script:Arch = ''
$script:CliPresent = $false
$script:CliPath = $null
$script:CliVer = $null
$script:CliCompat = $false
$script:NpxPresent = $false
$script:NpxPath = $null
$script:BunxPresent = $false
$script:BunxPath = $null
$script:NodePresent = $false
$script:NodeVer = $null
$script:NodeFloorOk = $false
$script:Selected = 'none'

# First "X.Y.Z" token printed by `$Bin --version`.
function Get-CliVersion {
    try { $out = & $Bin --version 2>$null } catch { return '' }
    if (-not $out) { return '' }
    $line = [string]($out | Select-Object -First 1)
    $m = [regex]::Match($line, '[0-9]+\.[0-9]+\.[0-9]+')
    if ($m.Success) { return $m.Value } else { return '' }
}

# Compatible = same major version as $Pinned AND not older than $Pinned.
# Same major keeps a globally installed CLI usable without a forced re-download;
# not-older refuses a stale build that predates the version this skill needs.
function Test-Compatible {
    param([string] $Ver)
    $f = $Ver -split '\.'
    $p = $Pinned -split '\.'
    if ($f.Count -lt 3 -or $p.Count -lt 3) { return $false }
    $fMaj = [int]$f[0]; $fMin = [int]$f[1]; $fPat = [int]$f[2]
    $pMaj = [int]$p[0]; $pMin = [int]$p[1]; $pPat = [int]$p[2]
    if ($fMaj -ne $pMaj) { return $false }
    if ($fMin -gt $pMin) { return $true }
    if ($fMin -lt $pMin) { return $false }
    return ($fPat -ge $pPat)
}

# The npx path runs the CLI on this machine's node, so npx is only usable when
# node itself meets the CLI's floor. An old node with a working npx used to be
# selected anyway, a path known to fail at run time.
$NodeFloor = '22.19.0'
function Test-NodeMeetsFloor {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
    try { $nv = ((& node --version 2>$null) -replace '^v', '') } catch { return $false }
    if (-not $nv) { return $false }
    $n = $nv -split '\.'
    $f = $NodeFloor -split '\.'
    if ($n.Count -lt 2) { return $false }
    $nMaj = [int]$n[0]; $nMin = [int]$n[1]
    $fMaj = [int]$f[0]; $fMin = [int]$f[1]
    if ($nMaj -gt $fMaj) { return $true }
    if ($nMaj -lt $fMaj) { return $false }
    return ($nMin -ge $fMin)
}

# Return exactly one word: the chosen launch path.
function Resolve-LaunchKind {
    $cli = Get-Command $Bin -ErrorAction SilentlyContinue
    if ($cli) {
        $v = Get-CliVersion
        if ($v -and (Test-Compatible $v)) { return 'path' }
    }
    if ((Get-Command npx -ErrorAction SilentlyContinue) -and (Test-NodeMeetsFloor)) { return 'npx' }
    if (Get-Command bunx -ErrorAction SilentlyContinue) { return 'bunx' }
    # Phase B goes here: check a versioned user cache, then download and verify a
    # native artifact into it. Any such download must use curl.exe (written in
    # full so PowerShell 5.1 does not resolve `curl` to its Invoke-WebRequest
    # alias), never Invoke-WebRequest, which stamps Mark-of-the-Web; see
    # design.md 8.3.
    return 'none'
}

# Run the resolved CLI and return its output (used to chain the CLI's own
# doctor). Passes every argument through untouched.
function Invoke-Cli {
    param([string[]] $CliArgs)
    switch ($script:Selected) {
        'path' { & $Bin @CliArgs }
        'npx' { & npx --yes --package "$Package@$Pinned" $Bin @CliArgs }
        'bunx' { & bunx --bun "$Package@$Pinned" @CliArgs }
    }
}

function Get-Arch {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        'x86' { return 'x86' }
        default { return $env:PROCESSOR_ARCHITECTURE }
    }
}

# Probe the environment once into the $script:* snapshot.
function Collect {
    $script:Arch = Get-Arch

    $cli = Get-Command $Bin -ErrorAction SilentlyContinue
    if ($cli) {
        $script:CliPresent = $true
        $script:CliPath = $cli.Source
        $script:CliVer = Get-CliVersion
        $script:CliCompat = [bool]($script:CliVer -and (Test-Compatible $script:CliVer))
    }

    $npx = Get-Command npx -ErrorAction SilentlyContinue
    if ($npx) { $script:NpxPresent = $true; $script:NpxPath = $npx.Source }

    $bunx = Get-Command bunx -ErrorAction SilentlyContinue
    if ($bunx) { $script:BunxPresent = $true; $script:BunxPath = $bunx.Source }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $script:NodePresent = $true
        try { $script:NodeVer = ((& node --version 2>$null) -replace '^v', '') } catch { $script:NodeVer = $null }
        $script:NodeFloorOk = Test-NodeMeetsFloor
    }

    $script:Selected = Resolve-LaunchKind
}

# Assemble the structured diagnosis. $Chained, when a parsed object, becomes
# cliDoctor; otherwise cliDoctor is null.
function Build-DiagnosisJson {
    param($Chained)
    $checked = [ordered]@{
        pathCli = [ordered]@{ present = $script:CliPresent; path = $script:CliPath; version = $script:CliVer; compatible = $script:CliCompat }
        npx     = [ordered]@{ present = $script:NpxPresent; path = $script:NpxPath; nodeMeetsFloor = $script:NodeFloorOk }
        bunx    = [ordered]@{ present = $script:BunxPresent; path = $script:BunxPath }
        node    = [ordered]@{ present = $script:NodePresent; version = $script:NodeVer }
    }
    $steps = @()
    if ($script:Selected -eq 'none') {
        $major = $Pinned.Split('.')[0]
        $first = "Install Node 22.19+ from https://nodejs.org so npx can run $Package@$Pinned, then re-run this launcher."
        if ($script:NpxPresent -and (-not $script:NodeFloorOk)) {
            $first = "npx is present but node $(if ($script:NodeVer) { $script:NodeVer } else { 'missing' }) is below the $NodeFloor floor this CLI needs. Upgrade Node at https://nodejs.org, then re-run this launcher."
        }
        $steps = @(
            $first,
            "No JavaScript runtime? Install Bun from https://bun.sh to use bunx, or put a compatible $Bin (major $major, at or above $Pinned) on PATH."
        )
    }
    $obj = [ordered]@{
        tool           = $Bin
        package        = $Package
        pinnedVersion  = $Pinned
        os             = 'windows'
        arch           = $script:Arch
        checked        = $checked
        nativeArtifact = [ordered]@{ available = $false; note = $NativeNote }
        selected       = $script:Selected
        nextSteps      = @($steps)
        cliDoctor      = $Chained
    }
    return ($obj | ConvertTo-Json -Depth 20)
}

# Human-readable diagnosis for `doctor` without --json.
function Write-DiagnosisText {
    Write-Output "$Bin launcher diagnosis"
    Write-Output ''
    Write-Output ("  os / arch:      windows / {0}" -f $script:Arch)
    Write-Output ("  pinned version: {0} ({1})" -f $Pinned, $Package)
    if ($script:CliPresent) {
        $verdict = if ($script:CliCompat) { 'compatible' } else { 'incompatible' }
        Write-Output ("  {0} on PATH:  {1} (version {2}, {3})" -f $Bin, $script:CliPath, $script:CliVer, $verdict)
    }
    else {
        Write-Output ("  {0} on PATH:  no" -f $Bin)
    }
    $npxDesc = 'no'
    if ($script:NpxPresent) {
        if ($script:NodeFloorOk) { $npxDesc = $script:NpxPath }
        else { $npxDesc = "$($script:NpxPath) (unusable: node $(if ($script:NodeVer) { $script:NodeVer } else { 'missing' }) is below $NodeFloor)" }
    }
    Write-Output ("  npx:            {0}" -f $npxDesc)
    Write-Output ("  bunx:           {0}" -f $(if ($script:BunxPresent) { $script:BunxPath } else { 'no' }))
    Write-Output ("  node:           {0}" -f $(if ($script:NodePresent) { $script:NodeVer } else { 'no' }))
    Write-Output ("  selected path:  {0}" -f $script:Selected)
    if ($script:Selected -eq 'none') {
        Write-Output ''
        Write-Output ("No runtime can launch {0} here. {1}" -f $Bin, $NativeNote)
        Write-Output 'Next steps:'
        Write-Output '  - Install Node 22.19+ from https://nodejs.org, then re-run this launcher.'
        Write-Output ("  - Or install Bun from https://bun.sh, or put a compatible {0} on PATH." -f $Bin)
    }
}

# `doctor [--json] [extra...]`: launcher selection diagnosis. When a CLI is
# resolvable, chain the CLI's own doctor so one call reports both layers. Extra
# flags pass through to the chained CLI doctor.
function Invoke-Doctor {
    param([string[]] $DocArgs)
    Collect
    $json = $false
    foreach ($a in $DocArgs) { if ($a -eq '--json') { $json = $true } }
    if ($json) {
        $chained = $null
        if ($script:Selected -ne 'none') {
            try {
                $raw = (Invoke-Cli -CliArgs (@('doctor') + $DocArgs) 2>$null | Out-String).Trim()
                if ($raw.StartsWith('{')) { $chained = ($raw | ConvertFrom-Json) }
            }
            catch { $chained = $null }
        }
        Write-Output (Build-DiagnosisJson $chained)
    }
    else {
        Write-DiagnosisText
        if ($script:Selected -ne 'none') {
            Write-Output ''
            Write-Output "--- $Bin doctor ---"
            Invoke-Cli -CliArgs (@('doctor') + $DocArgs)
        }
    }
}

# Default action: forward every argument to the resolved CLI and exit with its
# code. No usable runtime -> structured diagnosis on stderr, exit 78 (EX_CONFIG)
# so the agent never mistakes the diagnosis for a result.
function Invoke-Run {
    param([string[]] $CliArgs)
    $sel = Resolve-LaunchKind
    switch ($sel) {
        'path' { & $Bin @CliArgs; exit $LASTEXITCODE }
        'npx' { & npx --yes --package "$Package@$Pinned" $Bin @CliArgs; exit $LASTEXITCODE }
        'bunx' { & bunx --bun "$Package@$Pinned" @CliArgs; exit $LASTEXITCODE }
        'none' {
            Collect
            [Console]::Error.WriteLine((Build-DiagnosisJson $null))
            exit 78
        }
    }
}

$Command = ''
if ($args.Count -ge 1) { $Command = [string]$args[0] }
$Rest = @()
if ($args.Count -gt 1) { $Rest = $args[1..($args.Count - 1)] }

switch ($Command) {
    'doctor' { Invoke-Doctor -DocArgs $Rest }
    'where' { Collect; Write-Output $script:Selected }
    default { Invoke-Run -CliArgs $args }
}
