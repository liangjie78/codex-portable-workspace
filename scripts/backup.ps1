[CmdletBinding()]
param(
    [string]$CodexHome = (Join-Path $HOME ".codex"),
    [string]$ClaudeHome = (Join-Path $HOME ".claude"),
    [string]$AgentsHome = (Join-Path $HOME ".agents"),
    [string]$WorkspaceRoot = "D:\Workspace",
    [string]$WorkerRoot = "D:\Workspace\Tools\cc-switch-worker-mcp",
    [string]$CodexMemoryMcpRoot = "D:\Workspace\Projects\Project-013-CodexMemory\03_Source\codex-memory-mcp"
)

. (Join-Path $PSScriptRoot "common.ps1")
$repo = Get-RepositoryRoot

Write-PortableTemplate (Join-Path $CodexHome "AGENTS.md") (Join-Path $repo "codex\AGENTS.md") $CodexHome $WorkspaceRoot

foreach ($prefix in @("01_", "04_", "05_")) {
    $sourceMatches = @(Get-ChildItem -File -LiteralPath $WorkspaceRoot |
        Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) })
    if ($sourceMatches.Count -ne 1) {
        throw "Expected one workspace rule prefix $prefix; found $($sourceMatches.Count)"
    }
    $sourceFile = $sourceMatches[0]
    Write-PortableTemplate $sourceFile.FullName (Join-Path $repo "workspace\$($sourceFile.Name)") $CodexHome $WorkspaceRoot
}

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repo "skills\manifest.json") | ConvertFrom-Json

foreach ($skill in (Get-ManifestList $manifest "shared_skills")) {
    $source = Join-Path $ClaudeHome "skills\$skill"
    if (-not (Test-Path -LiteralPath $source)) {
        $source = Join-Path $CodexHome "skills\$skill"
    }
    $destination = Join-Path $repo "skills\shared\$skill"
    Reset-PortableDirectory $destination
    Remove-Item -LiteralPath $destination -Force
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

foreach ($skill in (Get-ManifestList $manifest "codex_skills")) {
    $source = Join-Path $CodexHome "skills\$skill"
    $destination = Join-Path $repo "skills\codex\$skill"
    Reset-PortableDirectory $destination
    Remove-Item -LiteralPath $destination -Force
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

foreach ($skill in (Get-ManifestList $manifest "claude_skills")) {
    $source = Join-Path $ClaudeHome "skills\$skill"
    $destination = Join-Path $repo "skills\claude\$skill"
    Reset-PortableDirectory $destination
    Remove-Item -LiteralPath $destination -Force
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

foreach ($skill in (Get-ManifestList $manifest "agent_skills")) {
    $source = Join-Path $AgentsHome "skills\$skill"
    $destination = Join-Path $repo "skills\agents\$skill"
    Reset-PortableDirectory $destination
    Remove-Item -LiteralPath $destination -Force
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

foreach ($skillsRoot in @("skills\shared", "skills\codex", "skills\claude", "skills\agents")) {
    Remove-SkillRuntimeArtifacts (Join-Path $repo $skillsRoot)
}

$workerDestination = Join-Path $repo "tools\cc-switch-worker-mcp"
Reset-PortableDirectory $workerDestination
foreach ($relative in @(".gitignore", "package.json", "package-lock.json", "README.md", "README.zh-CN.md", "LICENSE", "bin", "src", "scripts")) {
    $source = Join-Path $WorkerRoot $relative
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination $workerDestination -Recurse -Force
    }
}

$memoryDestination = Join-Path $repo "tools\codex-memory-mcp"
Reset-PortableDirectory $memoryDestination
foreach ($relative in @(".gitignore", "package.json", "README.md", "codex_config_snippet.toml", "docs", "src", "scripts")) {
    $source = Join-Path $CodexMemoryMcpRoot $relative
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination $memoryDestination -Recurse -Force
    }
}

& (Join-Path $PSScriptRoot "verify.ps1") `
    -AuditInstalledCoverage `
    -CodexHome $CodexHome `
    -ClaudeHome $ClaudeHome `
    -AgentsHome $AgentsHome `
    -WorkspaceRoot $WorkspaceRoot `
    -WorkerRoot $WorkerRoot `
    -CodexMemoryMcpRoot $CodexMemoryMcpRoot
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
