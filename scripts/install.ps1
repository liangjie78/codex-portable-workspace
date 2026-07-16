[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$CodexHome = (Join-Path $HOME ".codex"),
    [string]$ClaudeHome = (Join-Path $HOME ".claude"),
    [string]$AgentsHome = (Join-Path $HOME ".agents"),
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
$AgentsHome = [System.IO.Path]::GetFullPath($AgentsHome)
$WorkspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot)

if (-not $WorkerRoot) {
    $WorkerRoot = Join-Path $WorkspaceRoot "MCP\cc-switch-worker-mcp"
}
$WorkerRoot = [System.IO.Path]::GetFullPath($WorkerRoot)

if (-not $NodeExe) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw "Node.js required. Install Node.js, then re-run."
    }
    $NodeExe = $node.Source
}
$NodeExe = [System.IO.Path]::GetFullPath($NodeExe)
$appliedChanges = 0

if ($PSCmdlet.ShouldProcess($CodexHome, "Install Codex global guidance")) {
    Ensure-Directory $CodexHome
    $agentsTarget = Join-Path $CodexHome "AGENTS.md"
    if ((Test-Path -LiteralPath $agentsTarget) -and -not $Force) {
        throw "Destination already exists: $agentsTarget. Re-run with -Force after reviewing target."
    }
    if (Test-Path -LiteralPath $agentsTarget) {
        Backup-ExistingItem $agentsTarget | Out-Null
    }
    $agents = Render-PortableText ([System.IO.File]::ReadAllText((Join-Path $repo "codex\AGENTS.md"))) $CodexHome $WorkspaceRoot
    Write-Utf8NoBom $agentsTarget $agents
    $appliedChanges++
}

foreach ($prefix in @("01_", "02_", "04_", "05_")) {
    $sourceMatches = @(Get-ChildItem -File -LiteralPath (Join-Path $repo "workspace") |
        Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) })
    if ($sourceMatches.Count -ne 1) {
        throw "Expected one workspace rule prefix $prefix; found $($sourceMatches.Count)"
    }

    $sourceFile = $sourceMatches[0]
    $target = Join-Path $WorkspaceRoot $sourceFile.Name
    if ($PSCmdlet.ShouldProcess($target, "Install workspace rule")) {
        Ensure-Directory $WorkspaceRoot
        if ((Test-Path -LiteralPath $target) -and -not $Force) {
            throw "Destination already exists: $target. Re-run with -Force after reviewing target."
        }
        if (Test-Path -LiteralPath $target) {
            Backup-ExistingItem $target | Out-Null
        }
        $content = Render-PortableText ([System.IO.File]::ReadAllText($sourceFile.FullName)) $CodexHome $WorkspaceRoot
        Write-Utf8NoBom $target $content
        $appliedChanges++
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
if (-not (Test-Path -LiteralPath $inventoryTarget) -and $PSCmdlet.ShouldProcess($inventoryTarget, "Install local tool inventory template")) {
    Ensure-Directory $WorkspaceRoot
    $inventory = [System.IO.File]::ReadAllText($inventoryTemplateMatches[0].FullName)
    $inventory = $inventory.Replace("{{WORKSPACE_ROOT}}", $WorkspaceRoot).
        Replace("{{CODEX_HOME}}", $CodexHome).
        Replace("{{CLAUDE_HOME}}", $ClaudeHome)
    Write-Utf8NoBom $inventoryTarget $inventory
    $appliedChanges++
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
        $script:appliedChanges++
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
    $appliedChanges++
}

if ($InstallWorkerDependencies -and $PSCmdlet.ShouldProcess($WorkerRoot, "Install CC-Switch worker dependencies")) {
    Push-Location $WorkerRoot
    try {
        npm install --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw "Worker dependency installation failed with exit code $LASTEXITCODE" }
        $appliedChanges++
    } finally {
        Pop-Location
    }
}

$template = [System.IO.File]::ReadAllText((Join-Path $repo "codex\config.template.toml"))
$config = $template.Replace("{{WORKSPACE_TOML}}", (Convert-ToTomlPath $WorkspaceRoot))
$config = $config.Replace("{{NODE_EXE_TOML}}", (Convert-ToTomlPath $NodeExe))
$config = $config.Replace("{{WORKER_ENTRY_TOML}}", (Convert-ToTomlPath (Join-Path $WorkerRoot "src\cc-switch-worker-mcp.mjs")))

$configTarget = Join-Path $CodexHome "config.toml"
if ($PSCmdlet.ShouldProcess($configTarget, "Merge portable Codex config fields")) {
    if ((Test-Path -LiteralPath $configTarget) -and -not $Force) {
        throw "Destination already exists: $configTarget. Re-run with -Force after reviewing target."
    }
    Ensure-Directory $CodexHome
    if (Test-Path -LiteralPath $configTarget) {
        $existingConfig = [System.IO.File]::ReadAllText($configTarget)
        $mergedConfig = Merge-PortableCodexConfig $existingConfig $config
        if ($mergedConfig.Content -cne $existingConfig) {
            Write-Host "Config merge preview: $($mergedConfig.Changes -join '; ')"
            $configBackup = Backup-ExistingItem $configTarget
            Write-Host "Config backup: $configBackup"
            Write-Utf8NoBom $configTarget $mergedConfig.Content
            $appliedChanges++
        } else {
            Write-Host "Config already contains the portable fields; no config write needed."
        }
    } else {
        Write-Utf8NoBom $configTarget $config
        $appliedChanges++
    }
}

$inventoryPath = Join-Path $CodexHome "portable-install-inventory.json"
if ($PSCmdlet.ShouldProcess($inventoryPath, "Write installed inventory")) {
    Ensure-Directory $CodexHome
    $inventoryPath = Write-InstalledInventory $manifest $CodexHome $ClaudeHome $AgentsHome $WorkspaceRoot $WorkerRoot
    $appliedChanges++
}

if ($WhatIfPreference) {
    Write-Host "Preview complete. No files were written."
} elseif ($appliedChanges -gt 0) {
    Write-Host "Portable workspace installed."
    Write-Host "Installed inventory: $inventoryPath"
    Write-Host "Run: pwsh -NoProfile -File $PSScriptRoot\verify.ps1 -CheckInstalled -AuditInstalledCoverage -CodexHome `"$CodexHome`" -ClaudeHome `"$ClaudeHome`" -AgentsHome `"$AgentsHome`" -WorkspaceRoot `"$WorkspaceRoot`" -WorkerRoot `"$WorkerRoot`""
} else {
    Write-Host "No changes applied."
}
