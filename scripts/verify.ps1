[CmdletBinding()]
param(
    [switch]$CheckInstalled,
    [string]$CodexHome = (Join-Path $HOME ".codex"),
    [string]$ClaudeHome = (Join-Path $HOME ".claude"),
    [string]$WorkspaceRoot = "D:\Workspace",
    [string]$WorkerRoot = "D:\Workspace\Tools\cc-switch-worker-mcp"
)

. (Join-Path $PSScriptRoot "common.ps1")
$repo = Get-RepositoryRoot
$errors = [System.Collections.Generic.List[string]]::new()

function Require-Path([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { $errors.Add("Missing: $Path") }
}

foreach ($path in @(
    "README.md", ".gitignore", "codex\AGENTS.md", "codex\config.template.toml",
    "skills\manifest.json",
    "scripts\install.ps1", "scripts\backup.ps1", "scripts\verify.ps1",
    "tools\cc-switch-worker-mcp\src\cc-switch-worker-mcp.mjs"
)) { Require-Path (Join-Path $repo $path) }
foreach ($prefix in @("01_", "04_", "05_")) {
    $matches = @(Get-ChildItem -File -LiteralPath (Join-Path $repo "workspace") |
        Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) })
    if ($matches.Count -ne 1) { $errors.Add("Expected one workspace rule with prefix $prefix; found $($matches.Count)") }
}

$manifestPath = Join-Path $repo "skills\manifest.json"
if (Test-Path -LiteralPath $manifestPath) {
    $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
    foreach ($skill in $manifest.shared_skills) {
        Require-Path (Join-Path $repo "skills\shared\$skill\SKILL.md")
    }
}

$forbiddenNames = @("auth.json", ".env", "credentials.json", "cookies.json")
$files = Get-ChildItem -Recurse -File -Force -LiteralPath $repo |
    Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' }
foreach ($file in $files) {
    if ($file.FullName -match '[\\/]\.portable-backup-') {
        $errors.Add("Portable backup must not be committed: $($file.FullName)")
    }
    if ($forbiddenNames -contains $file.Name.ToLowerInvariant()) {
        $errors.Add("Forbidden filename: $($file.FullName)")
    }
    if ($file.Extension -in @(".log", ".pyc", ".pyo")) {
        $errors.Add("Runtime artifact: $($file.FullName)")
    }
}

$secretPatterns = @(
    'gh[pousr]_[A-Za-z0-9]{30,}',
    'sk-[A-Za-z0-9_-]{20,}',
    'AKIA[0-9A-Z]{16}',
    '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----',
    '(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*["''][^"'']{12,}["'']'
)
foreach ($file in $files) {
    if ($file.Length -gt 5MB) { continue }
    try { $text = [System.IO.File]::ReadAllText($file.FullName) } catch { continue }
    foreach ($pattern in $secretPatterns) {
        if ([regex]::IsMatch($text, $pattern)) {
            $errors.Add("Possible secret pattern in: $($file.FullName)")
            break
        }
    }
}

if ($CheckInstalled) {
    foreach ($path in @(
        (Join-Path $CodexHome "AGENTS.md"),
        (Join-Path $CodexHome "config.toml"),
        (Join-Path $WorkerRoot "src\cc-switch-worker-mcp.mjs")
    )) { Require-Path $path }
    foreach ($prefix in @("01_", "04_", "05_")) {
        $matches = @(Get-ChildItem -File -LiteralPath $WorkspaceRoot |
            Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) })
        if ($matches.Count -ne 1) { $errors.Add("Expected one installed workspace rule with prefix $prefix; found $($matches.Count)") }
    }
    $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
    foreach ($skill in $manifest.shared_skills) {
        Require-Path (Join-Path $CodexHome "skills\$skill\SKILL.md")
        Require-Path (Join-Path $ClaudeHome "skills\$skill\SKILL.md")
    }
    $configPath = Join-Path $CodexHome "config.toml"
    if (Test-Path -LiteralPath $configPath) {
        $config = [System.IO.File]::ReadAllText($configPath)
        if ($config.Contains("{{")) { $errors.Add("Unresolved placeholder in $configPath") }
        if (-not $config.Contains("cc-switch-worker")) { $errors.Add("Worker MCP missing from $configPath") }
    }
}

if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Host "Verification passed. Files scanned: $($files.Count)"
exit 0
