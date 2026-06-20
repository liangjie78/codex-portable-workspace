[CmdletBinding()]
param(
    [string]$CodexHome = (Join-Path $HOME ".codex"),
    [string]$ClaudeHome = (Join-Path $HOME ".claude"),
    [string]$WorkspaceRoot = "D:\Workspace",
    [string]$WorkerRoot = "D:\Workspace\Tools\cc-switch-worker-mcp"
)

. (Join-Path $PSScriptRoot "common.ps1")
$repo = Get-RepositoryRoot

Write-PortableTemplate (Join-Path $CodexHome "AGENTS.md") (Join-Path $repo "codex\AGENTS.md") $CodexHome $WorkspaceRoot
foreach ($prefix in @("01_", "04_", "05_")) {
    $sourceMatches = @(Get-ChildItem -File -LiteralPath $WorkspaceRoot |
        Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) })
    if ($sourceMatches.Count -ne 1) { throw "Expected one workspace rule for prefix $prefix; found $($sourceMatches.Count)" }
    $sourceFile = $sourceMatches[0]
    Write-PortableTemplate $sourceFile.FullName (Join-Path $repo "workspace\$($sourceFile.Name)") $CodexHome $WorkspaceRoot
}

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repo "skills\manifest.json") | ConvertFrom-Json
foreach ($skill in $manifest.shared_skills) {
    $source = Join-Path $ClaudeHome "skills\$skill"
    if (-not (Test-Path -LiteralPath $source)) { $source = Join-Path $CodexHome "skills\$skill" }
    $destination = Join-Path $repo "skills\shared\$skill"
    if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}
Get-ChildItem -Recurse -Directory -Force -LiteralPath (Join-Path $repo "skills\shared") |
    Where-Object { $_.Name -eq "__pycache__" } |
    Remove-Item -Recurse -Force
Get-ChildItem -Recurse -File -Force -LiteralPath (Join-Path $repo "skills\shared") |
    Where-Object { $_.Extension -in @(".pyc", ".pyo") } |
    Remove-Item -Force

$toolDestination = Join-Path $repo "tools\cc-switch-worker-mcp"
if (Test-Path -LiteralPath $toolDestination) { Remove-Item -LiteralPath $toolDestination -Recurse -Force }
Ensure-Directory $toolDestination
foreach ($name in @("bin", "src", "scripts", "package.json", "package-lock.json", "README.md", "README.zh-CN.md", "LICENSE", ".gitignore")) {
    $source = Join-Path $WorkerRoot $name
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $toolDestination $name) -Recurse -Force }
}

& (Join-Path $PSScriptRoot "verify.ps1")
if ($LASTEXITCODE -ne 0) { throw "Verification failed after backup." }
Write-Host "Portable sources refreshed. Review git diff before committing."
