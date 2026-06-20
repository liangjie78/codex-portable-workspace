[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$CodexHome = (Join-Path $HOME ".codex"),
    [string]$ClaudeHome = (Join-Path $HOME ".claude"),
    [string]$WorkspaceRoot = "D:\Workspace",
    [string]$WorkerRoot = "",
    [string]$NodeExe = "",
    [switch]$Force,
    [switch]$InstallWorkerDependencies
)

. (Join-Path $PSScriptRoot "common.ps1")
$repo = Get-RepositoryRoot
$CodexHome = [System.IO.Path]::GetFullPath($CodexHome)
$ClaudeHome = [System.IO.Path]::GetFullPath($ClaudeHome)
$WorkspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot)
if (-not $WorkerRoot) { $WorkerRoot = Join-Path $WorkspaceRoot "Tools\cc-switch-worker-mcp" }
$WorkerRoot = [System.IO.Path]::GetFullPath($WorkerRoot)
if (-not $NodeExe) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw "Node.js is required. Install Node.js and re-run." }
    $NodeExe = $node.Source
}
$NodeExe = [System.IO.Path]::GetFullPath($NodeExe)

Ensure-Directory $CodexHome
Ensure-Directory $ClaudeHome
Ensure-Directory $WorkspaceRoot

if ($PSCmdlet.ShouldProcess($CodexHome, "Install Codex global guidance")) {
    $agentsTarget = Join-Path $CodexHome "AGENTS.md"
    if ((Test-Path -LiteralPath $agentsTarget) -and -not $Force) { throw "Destination already exists: $agentsTarget" }
    if (Test-Path -LiteralPath $agentsTarget) { Backup-ExistingItem $agentsTarget | Out-Null }
    $agents = Render-PortableText ([System.IO.File]::ReadAllText((Join-Path $repo "codex\AGENTS.md"))) $CodexHome $WorkspaceRoot
    Write-Utf8NoBom $agentsTarget $agents
}

foreach ($prefix in @("01_", "04_", "05_")) {
    $sourceMatches = @(Get-ChildItem -File -LiteralPath (Join-Path $repo "workspace") |
        Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) })
    if ($sourceMatches.Count -ne 1) { throw "Expected one workspace rule for prefix $prefix; found $($sourceMatches.Count)" }
    $sourceFile = $sourceMatches[0]
    if ($PSCmdlet.ShouldProcess($WorkspaceRoot, "Install $($sourceFile.Name)")) {
        $target = Join-Path $WorkspaceRoot $sourceFile.Name
        if ((Test-Path -LiteralPath $target) -and -not $Force) { throw "Destination already exists: $target" }
        if (Test-Path -LiteralPath $target) { Backup-ExistingItem $target | Out-Null }
        $content = Render-PortableText ([System.IO.File]::ReadAllText($sourceFile.FullName)) $CodexHome $WorkspaceRoot
        Write-Utf8NoBom $target $content
    }
}

$inventoryTarget = Join-Path $WorkspaceRoot "00_本机环境与工具清单.md"
if (-not (Test-Path -LiteralPath $inventoryTarget)) {
    $inventory = [System.IO.File]::ReadAllText((Join-Path $repo "workspace\00_本机环境与工具清单.template.md"))
    $inventory = $inventory.Replace("{{WORKSPACE_ROOT}}", $WorkspaceRoot).Replace("{{CODEX_HOME}}", $CodexHome).Replace("{{CLAUDE_HOME}}", $ClaudeHome)
    Write-Utf8NoBom $inventoryTarget $inventory
}

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repo "skills\manifest.json") | ConvertFrom-Json
foreach ($skill in $manifest.shared_skills) {
    $source = Join-Path $repo "skills\shared\$skill"
    foreach ($targetRoot in @((Join-Path $CodexHome "skills"), (Join-Path $ClaudeHome "skills"))) {
        Ensure-Directory $targetRoot
        if ($PSCmdlet.ShouldProcess($targetRoot, "Install skill $skill")) {
            Copy-PortableItem $source (Join-Path $targetRoot $skill) -Force:$Force
        }
    }
}

if ($PSCmdlet.ShouldProcess($WorkerRoot, "Install customized CC-Switch worker")) {
    Copy-PortableItem (Join-Path $repo "tools\cc-switch-worker-mcp") $WorkerRoot -Force:$Force
}

if ($InstallWorkerDependencies) {
    Push-Location $WorkerRoot
    try { & npm install --ignore-scripts }
    finally { Pop-Location }
}

$template = [System.IO.File]::ReadAllText((Join-Path $repo "codex\config.template.toml"))
$workerEntry = Join-Path $WorkerRoot "src\cc-switch-worker-mcp.mjs"
$config = $template.Replace("{{WORKSPACE_TOML}}", (Convert-ToTomlPath $WorkspaceRoot))
$config = $config.Replace("{{NODE_EXE_TOML}}", (Convert-ToTomlPath $NodeExe))
$config = $config.Replace("{{WORKER_ENTRY_TOML}}", (Convert-ToTomlPath $workerEntry))
$configTarget = Join-Path $CodexHome "config.toml"
if ((Test-Path -LiteralPath $configTarget) -and -not $Force) {
    throw "Config already exists: $configTarget. Re-run with -Force after backing it up."
}
if (Test-Path -LiteralPath $configTarget) { Backup-ExistingItem $configTarget | Out-Null }
Write-Utf8NoBom $configTarget $config

Write-Host "Portable workspace installed."
Write-Host "Run: $PSScriptRoot\verify.ps1 -CheckInstalled -CodexHome `"$CodexHome`" -ClaudeHome `"$ClaudeHome`" -WorkspaceRoot `"$WorkspaceRoot`" -WorkerRoot `"$WorkerRoot`""
