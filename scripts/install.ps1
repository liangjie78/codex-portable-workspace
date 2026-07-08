[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$CodexHome = (Join-Path $HOME ".codex"),
    [string]$ClaudeHome = (Join-Path $HOME ".claude"),
    [string]$AgentsHome = (Join-Path $HOME ".agents"),
    [string]$WorkspaceRoot = "D:\Workspace",
    [string]$WorkerRoot = "",
    [string]$CodexMemoryMcpRoot = "",
    [string]$CodexMemoryRoot = "",
    [string]$NodeExe = "",
    [switch]$Force,
    [switch]$InstallWorkerDependencies
)

. (Join-Path $PSScriptRoot "common.ps1")
$repo = Get-RepositoryRoot

$CodexHome = [System.IO.Path]::GetFullPath($CodexHome)
$ClaudeHome = [System.IO.Path]::GetFullPath($ClaudeHome)
$AgentsHome = [System.IO.Path]::GetFullPath($AgentsHome)
$WorkspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot)

if (-not $WorkerRoot) {
    $WorkerRoot = Join-Path $WorkspaceRoot "Tools\cc-switch-worker-mcp"
}
if (-not $CodexMemoryMcpRoot) {
    $CodexMemoryMcpRoot = Join-Path $WorkspaceRoot "Projects\Project-013-CodexMemory\03_Source\codex-memory-mcp"
}
if (-not $CodexMemoryRoot) {
    $CodexMemoryRoot = Join-Path $WorkspaceRoot "CodexMemory"
}

$WorkerRoot = [System.IO.Path]::GetFullPath($WorkerRoot)
$CodexMemoryMcpRoot = [System.IO.Path]::GetFullPath($CodexMemoryMcpRoot)
$CodexMemoryRoot = [System.IO.Path]::GetFullPath($CodexMemoryRoot)

if (-not $NodeExe) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw "Node.js required. Install Node.js, then re-run."
    }
    $NodeExe = $node.Source
}
$NodeExe = [System.IO.Path]::GetFullPath($NodeExe)

Ensure-Directory $CodexHome
Ensure-Directory $ClaudeHome
Ensure-Directory $AgentsHome
Ensure-Directory $WorkspaceRoot
Ensure-Directory $CodexMemoryRoot

if ($PSCmdlet.ShouldProcess($CodexHome, "Install Codex global guidance")) {
    $agentsTarget = Join-Path $CodexHome "AGENTS.md"
    if ((Test-Path -LiteralPath $agentsTarget) -and -not $Force) {
        throw "Destination already exists: $agentsTarget. Re-run with -Force after reviewing target."
    }
    if (Test-Path -LiteralPath $agentsTarget) {
        Backup-ExistingItem $agentsTarget | Out-Null
    }
    $agents = Render-PortableText ([System.IO.File]::ReadAllText((Join-Path $repo "codex\AGENTS.md"))) $CodexHome $WorkspaceRoot
    Write-Utf8NoBom $agentsTarget $agents
}

foreach ($prefix in @("01_", "04_", "05_")) {
    $sourceMatches = @(Get-ChildItem -File -LiteralPath (Join-Path $repo "workspace") |
        Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) })
    if ($sourceMatches.Count -ne 1) {
        throw "Expected one workspace rule prefix $prefix; found $($sourceMatches.Count)"
    }

    $sourceFile = $sourceMatches[0]
    $target = Join-Path $WorkspaceRoot $sourceFile.Name
    if ($PSCmdlet.ShouldProcess($target, "Install workspace rule")) {
        if ((Test-Path -LiteralPath $target) -and -not $Force) {
            throw "Destination already exists: $target. Re-run with -Force after reviewing target."
        }
        if (Test-Path -LiteralPath $target) {
            Backup-ExistingItem $target | Out-Null
        }
        $content = Render-PortableText ([System.IO.File]::ReadAllText($sourceFile.FullName)) $CodexHome $WorkspaceRoot
        Write-Utf8NoBom $target $content
    }
}

$inventoryTemplateMatches = @(Get-ChildItem -File -LiteralPath (Join-Path $repo "workspace") |
    Where-Object {
        $_.Name.StartsWith("00_", [System.StringComparison]::Ordinal) -and
        $_.Name.EndsWith(".template.md", [System.StringComparison]::Ordinal)
    })
if ($inventoryTemplateMatches.Count -ne 1) {
    throw "Expected one workspace inventory template prefix 00_; found $($inventoryTemplateMatches.Count)"
}
$inventoryTargetName = $inventoryTemplateMatches[0].Name -replace '\.template\.md$', '.md'
$inventoryTarget = Join-Path $WorkspaceRoot $inventoryTargetName
if (-not (Test-Path -LiteralPath $inventoryTarget)) {
    $inventory = [System.IO.File]::ReadAllText($inventoryTemplateMatches[0].FullName)
    $inventory = $inventory.Replace("{{WORKSPACE_ROOT}}", $WorkspaceRoot).
        Replace("{{CODEX_HOME}}", $CodexHome).
        Replace("{{CLAUDE_HOME}}", $ClaudeHome)
    Write-Utf8NoBom $inventoryTarget $inventory
}

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repo "skills\manifest.json") | ConvertFrom-Json

function Install-SkillSnapshot {
    param(
        [Parameter(Mandatory)][string]$SnapshotRoot,
        [Parameter(Mandatory)][string]$TargetSkillsRoot,
        [Parameter(Mandatory)][string]$SkillName
    )
    $source = Join-Path $SnapshotRoot $SkillName
    $target = Join-Path $TargetSkillsRoot $SkillName
    if ($PSCmdlet.ShouldProcess($target, "Install skill $SkillName")) {
        Copy-PortableItem -Source $source -Destination $target -Force:$Force
    }
}

foreach ($skill in (Get-ManifestList $manifest "shared_skills")) {
    Install-SkillSnapshot (Join-Path $repo "skills\shared") (Join-Path $CodexHome "skills") $skill
    Install-SkillSnapshot (Join-Path $repo "skills\shared") (Join-Path $ClaudeHome "skills") $skill
}

foreach ($skill in (Get-ManifestList $manifest "codex_skills")) {
    Install-SkillSnapshot (Join-Path $repo "skills\codex") (Join-Path $CodexHome "skills") $skill
}

foreach ($skill in (Get-ManifestList $manifest "claude_skills")) {
    Install-SkillSnapshot (Join-Path $repo "skills\claude") (Join-Path $ClaudeHome "skills") $skill
}

foreach ($skill in (Get-ManifestList $manifest "agent_skills")) {
    Install-SkillSnapshot (Join-Path $repo "skills\agents") (Join-Path $AgentsHome "skills") $skill
}

if ($PSCmdlet.ShouldProcess($WorkerRoot, "Install CC-Switch worker source")) {
    Copy-PortableItem -Source (Join-Path $repo "tools\cc-switch-worker-mcp") -Destination $WorkerRoot -Force:$Force
}

if ($InstallWorkerDependencies) {
    Push-Location $WorkerRoot
    try {
        npm install --ignore-scripts
    } finally {
        Pop-Location
    }
}

if ($PSCmdlet.ShouldProcess($CodexMemoryMcpRoot, "Install CodexMemory MCP source")) {
    Copy-PortableItem -Source (Join-Path $repo "tools\codex-memory-mcp") -Destination $CodexMemoryMcpRoot -Force:$Force
}

$template = [System.IO.File]::ReadAllText((Join-Path $repo "codex\config.template.toml"))
$config = $template.Replace("{{WORKSPACE_TOML}}", (Convert-ToTomlPath $WorkspaceRoot))
$config = $config.Replace("{{NODE_EXE_TOML}}", (Convert-ToTomlPath $NodeExe))
$config = $config.Replace("{{WORKER_ENTRY_TOML}}", (Convert-ToTomlPath (Join-Path $WorkerRoot "src\cc-switch-worker-mcp.mjs")))
$config = $config.Replace("{{CODEX_MEMORY_ENTRY_TOML}}", (Convert-ToTomlPath (Join-Path $CodexMemoryMcpRoot "src\server.mjs")))
$config = $config.Replace("{{CODEX_MEMORY_ROOT_TOML}}", (Convert-ToTomlPath $CodexMemoryRoot))

if ($PSCmdlet.ShouldProcess((Join-Path $CodexHome "config.toml"), "Install Codex config template")) {
    $configTarget = Join-Path $CodexHome "config.toml"
    if ((Test-Path -LiteralPath $configTarget) -and -not $Force) {
        throw "Destination already exists: $configTarget. Re-run with -Force after reviewing target."
    }
    if (Test-Path -LiteralPath $configTarget) {
        Backup-ExistingItem $configTarget | Out-Null
    }
    Write-Utf8NoBom $configTarget $config
}

Write-Host "Portable workspace installed."
Write-Host "Run: $PSScriptRoot\verify.ps1 -CheckInstalled -AuditInstalledCoverage -CodexHome `"$CodexHome`" -ClaudeHome `"$ClaudeHome`" -AgentsHome `"$AgentsHome`" -WorkspaceRoot `"$WorkspaceRoot`" -WorkerRoot `"$WorkerRoot`" -CodexMemoryMcpRoot `"$CodexMemoryMcpRoot`""
