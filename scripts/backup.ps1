[CmdletBinding()]
param(
    [string]$CodexHome = (Join-Path $HOME ".codex"),
    [string]$ClaudeHome = (Join-Path $HOME ".claude"),
    [string]$AgentsHome = (Join-Path $HOME ".agents"),
    [string]$WorkspaceRoot = "D:\Workspace",
    [string]$WorkerRoot = "D:\Workspace\MCP\cc-switch-worker-mcp",
    [switch]$SkipWorkerOfflineSuite
)

. (Join-Path $PSScriptRoot "common.ps1")
$repo = Get-RepositoryRoot
$repoParent = Split-Path -Parent $repo
$candidate = Join-Path $repoParent (".portable-candidate-" + [guid]::NewGuid().ToString("N"))
$rollback = Join-Path $repoParent (".portable-rollback-" + [guid]::NewGuid().ToString("N"))
$managedRoots = @("workspace", "skills\shared", "skills\codex", "skills\claude", "skills\agents")

function Remove-TransactionPath {
    param([Parameter(Mandatory)][string]$Path)
    $resolved = [System.IO.Path]::GetFullPath($Path)
    $prefix = [System.IO.Path]::GetFullPath($repoParent).TrimEnd('\') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove transaction path outside repository parent: $resolved"
    }
    if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

function Assert-WorkerMirror {
    param([Parameter(Mandatory)][string]$PortableRoot)
    $portableFiles = @{}
    Get-ChildItem -Recurse -File -Force -LiteralPath $PortableRoot | ForEach-Object {
        $portableFiles[$_.FullName.Substring($PortableRoot.Length + 1)] = $_.FullName
    }
    $installedFiles = @{}
    Get-ChildItem -Recurse -File -Force -LiteralPath $WorkerRoot |
        Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' } |
        ForEach-Object { $installedFiles[$_.FullName.Substring($WorkerRoot.Length + 1)] = $_.FullName }
    foreach ($relative in $portableFiles.Keys) {
        if (-not $installedFiles.ContainsKey($relative)) { throw "Installed worker is missing portable file: $relative" }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $portableFiles[$relative]).Hash -cne
            (Get-FileHash -Algorithm SHA256 -LiteralPath $installedFiles[$relative]).Hash) {
            throw "Installed worker drift: $relative. Apply the portable source with scripts\install.ps1 before backup."
        }
    }
    foreach ($relative in $installedFiles.Keys) {
        if ($portableFiles.ContainsKey($relative)) { continue }
        if ($relative -eq "99_Retrospective.md" -or $relative.StartsWith("docs\", [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        throw "Unexpected installed worker file: $relative"
    }
}

function Invoke-WorkerOfflineSuite {
    if ($SkipWorkerOfflineSuite) { return }
    $node = (Get-Command node -ErrorAction Stop).Source
    $script = Join-Path $WorkerRoot "scripts\verify-offline.mjs"
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
        throw "Installed Worker offline suite is missing: $script"
    }
    Push-Location $WorkerRoot
    try {
        & $node $script
        if ($LASTEXITCODE -ne 0) {
            throw "Installed Worker offline suite failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

function Write-CandidateSnapshots {
    param([Parameter(Mandatory)][string]$TargetRepo)

    foreach ($prefix in @("01_", "02_", "04_", "05_")) {
        $sourceMatches = @(Get-ChildItem -File -LiteralPath $WorkspaceRoot |
            Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) })
        if ($sourceMatches.Count -ne 1) {
            throw "Expected one workspace rule prefix $prefix; found $($sourceMatches.Count)"
        }
        Write-PortableTemplate $sourceMatches[0].FullName (Join-Path $TargetRepo "workspace\$($sourceMatches[0].Name)") $CodexHome $WorkspaceRoot
    }

    $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $TargetRepo "skills\manifest.json") | ConvertFrom-Json
    foreach ($item in @(
        @{ Names = (Get-ManifestList $manifest "shared_skills"); SourceRoot = (Join-Path $CodexHome "skills"); TargetRoot = "skills\shared" },
        @{ Names = (Get-ManifestList $manifest "codex_skills"); SourceRoot = (Join-Path $CodexHome "skills"); TargetRoot = "skills\codex" },
        @{ Names = (Get-ManifestList $manifest "claude_skills"); SourceRoot = (Join-Path $ClaudeHome "skills"); TargetRoot = "skills\claude" },
        @{ Names = (Get-ManifestList $manifest "agent_skills"); SourceRoot = (Join-Path $AgentsHome "skills"); TargetRoot = "skills\agents" }
    )) {
        foreach ($skill in @($item.Names)) {
            $source = Join-Path $item.SourceRoot $skill
            $destination = Join-Path $TargetRepo "$($item.TargetRoot)\$skill"
            if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
            Ensure-Directory (Split-Path -Parent $destination)
            Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
        }
    }
    foreach ($skillsRoot in @("skills\shared", "skills\codex", "skills\claude", "skills\agents")) {
        Remove-SkillRuntimeArtifacts (Join-Path $TargetRepo $skillsRoot)
    }
}

function Get-DirtyManagedPaths {
    $pathspec = @("--") + $managedRoots
    $dirty = @(
        & git -C $repo diff --name-only @pathspec
        & git -C $repo diff --cached --name-only @pathspec
        & git -C $repo ls-files --others --exclude-standard @pathspec
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique
    return @($dirty)
}

try {
    Ensure-Directory $candidate
    Get-ChildItem -Force -LiteralPath $repo |
        Where-Object { $_.Name -ne ".git" } |
        Copy-Item -Destination $candidate -Recurse -Force

    Write-CandidateSnapshots $candidate
    Assert-WorkerMirror (Join-Path $candidate "tools\cc-switch-worker-mcp")
    & (Join-Path $candidate "scripts\verify.ps1") `
        -AuditInstalledCoverage `
        -CodexHome $CodexHome `
        -ClaudeHome $ClaudeHome `
        -AgentsHome $AgentsHome `
        -WorkspaceRoot $WorkspaceRoot `
        -WorkerRoot $WorkerRoot
    if ($LASTEXITCODE -ne 0) { throw "Candidate verification failed with exit code $LASTEXITCODE" }
    Invoke-WorkerOfflineSuite

    $dirtyManaged = @(Get-DirtyManagedPaths)
    if ($dirtyManaged.Count -gt 0) {
        throw "Managed snapshot paths contain user changes and were not replaced: $($dirtyManaged -join ', ')"
    }

    Ensure-Directory $rollback
    $replaced = [System.Collections.Generic.List[string]]::new()
    try {
        foreach ($relative in $managedRoots) {
            $target = Join-Path $repo $relative
            $replacement = Join-Path $candidate $relative
            $saved = Join-Path $rollback $relative
            Ensure-Directory (Split-Path -Parent $saved)
            if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $saved }
            $replaced.Add($relative)
            Move-Item -LiteralPath $replacement -Destination $target
        }
        & (Join-Path $repo "scripts\verify.ps1") `
            -AuditInstalledCoverage `
            -CodexHome $CodexHome `
            -ClaudeHome $ClaudeHome `
            -AgentsHome $AgentsHome `
            -WorkspaceRoot $WorkspaceRoot `
            -WorkerRoot $WorkerRoot
        if ($LASTEXITCODE -ne 0) { throw "Post-replacement verification failed with exit code $LASTEXITCODE" }
        $installedManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repo "skills\manifest.json") | ConvertFrom-Json
        Write-InstalledInventory $installedManifest $CodexHome $ClaudeHome $AgentsHome $WorkspaceRoot $WorkerRoot | Out-Null
    } catch {
        foreach ($relative in @($replaced) | Select-Object -Reverse) {
            $target = Join-Path $repo $relative
            $saved = Join-Path $rollback $relative
            if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
            if (Test-Path -LiteralPath $saved) {
                Ensure-Directory (Split-Path -Parent $target)
                Move-Item -LiteralPath $saved -Destination $target
            }
        }
        throw
    }
} finally {
    Remove-TransactionPath $candidate
    Remove-TransactionPath $rollback
}
