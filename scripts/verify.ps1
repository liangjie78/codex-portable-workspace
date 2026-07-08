[CmdletBinding()]
param(
    [switch]$CheckInstalled,
    [switch]$AuditInstalledCoverage,
    [string]$CodexHome = (Join-Path $HOME ".codex"),
    [string]$ClaudeHome = (Join-Path $HOME ".claude"),
    [string]$AgentsHome = (Join-Path $HOME ".agents"),
    [string]$WorkspaceRoot = "D:\Workspace",
    [string]$WorkerRoot = "D:\Workspace\Tools\cc-switch-worker-mcp",
    [string]$CodexMemoryMcpRoot = "D:\Workspace\Projects\Project-013-CodexMemory\03_Source\codex-memory-mcp"
)

. (Join-Path $PSScriptRoot "common.ps1")
$repo = Get-RepositoryRoot
$errors = [System.Collections.Generic.List[string]]::new()

function Require-Path {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        $errors.Add("Missing: $Path")
    }
}

function Require-RepoPath {
    param([Parameter(Mandatory)][string]$RelativePath)
    Require-Path (Join-Path $repo $RelativePath)
}

function Add-SkillCoverageErrors {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$SkillsRoot,
        [Parameter(Mandatory)][string[]]$ExpectedSkills
    )

    $actualSkills = @(Get-InstalledSkillNames $SkillsRoot)
    $expected = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($skill in $ExpectedSkills) {
        [void]$expected.Add($skill)
    }

    foreach ($skill in $actualSkills) {
        if (-not $expected.Contains($skill)) {
            $errors.Add("Untracked installed $Label skill: $skill. Add it to skills\manifest.json, then run scripts\backup.ps1.")
        }
    }

    $actual = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($skill in $actualSkills) {
        [void]$actual.Add($skill)
    }

    foreach ($skill in $ExpectedSkills) {
        if (-not $actual.Contains($skill)) {
            $errors.Add("Manifest lists missing installed $Label skill: $skill under $SkillsRoot")
        }
    }
}

foreach ($path in @(
    "README.md",
    ".gitignore",
    "codex\AGENTS.md",
    "codex\config.template.toml",
    "skills\manifest.json",
    "scripts\install.ps1",
    "scripts\backup.ps1",
    "scripts\verify.ps1",
    "tools\cc-switch-worker-mcp\src\cc-switch-worker-mcp.mjs",
    "tools\codex-memory-mcp\src\server.mjs",
    "tools\codex-memory-mcp\src\cli.mjs",
    "tools\codex-memory-mcp\src\cardStore.mjs"
)) {
    Require-RepoPath $path
}

$templatePath = Join-Path $repo "codex\config.template.toml"
if (Test-Path -LiteralPath $templatePath) {
    $template = [System.IO.File]::ReadAllText($templatePath)
    if (-not $template.Contains("cc-switch-worker")) {
        $errors.Add("Config template missing cc-switch-worker MCP block")
    }
    if (-not $template.Contains("codex-memory")) {
        $errors.Add("Config template missing codex-memory MCP block")
    }
}

$inventoryTemplates = @(Get-ChildItem -File -LiteralPath (Join-Path $repo "workspace") |
    Where-Object {
        $_.Name.StartsWith("00_", [System.StringComparison]::Ordinal) -and
        $_.Name.EndsWith(".template.md", [System.StringComparison]::Ordinal)
    })
if ($inventoryTemplates.Count -ne 1) {
    $errors.Add("Expected one workspace inventory template prefix 00_; found $($inventoryTemplates.Count)")
}

foreach ($prefix in @("01_", "04_", "05_")) {
    $matches = @(Get-ChildItem -File -LiteralPath (Join-Path $repo "workspace") |
        Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) })
    if ($matches.Count -ne 1) {
        $errors.Add("Expected one workspace prefix $prefix; found $($matches.Count)")
    }
}

$manifestPath = Join-Path $repo "skills\manifest.json"
if (Test-Path -LiteralPath $manifestPath) {
    $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
    $sharedSkills = @(Get-ManifestList $manifest "shared_skills")
    $codexSkills = @(Get-ManifestList $manifest "codex_skills")
    $claudeSkills = @(Get-ManifestList $manifest "claude_skills")
    $agentSkills = @(Get-ManifestList $manifest "agent_skills")

    foreach ($skill in $sharedSkills) {
        Require-RepoPath "skills\shared\$skill\SKILL.md"
    }
    foreach ($skill in $codexSkills) {
        Require-RepoPath "skills\codex\$skill\SKILL.md"
    }
    foreach ($skill in $claudeSkills) {
        Require-RepoPath "skills\claude\$skill\SKILL.md"
    }
    foreach ($skill in $agentSkills) {
        Require-RepoPath "skills\agents\$skill\SKILL.md"
    }

    if ($AuditInstalledCoverage) {
        Add-SkillCoverageErrors "Codex" (Join-Path $CodexHome "skills") @($sharedSkills + $codexSkills)
        Add-SkillCoverageErrors "Claude" (Join-Path $ClaudeHome "skills") @($sharedSkills + $claudeSkills)
        Add-SkillCoverageErrors "Agents" (Join-Path $AgentsHome "skills") @($agentSkills)
        Require-Path (Join-Path $CodexMemoryMcpRoot "src\server.mjs")
        Require-Path (Join-Path $CodexMemoryMcpRoot "src\cli.mjs")
    }

    if ($CheckInstalled) {
        Require-Path (Join-Path $CodexHome "AGENTS.md")
        Require-Path (Join-Path $CodexHome "config.toml")
        Require-Path (Join-Path $WorkerRoot "src\cc-switch-worker-mcp.mjs")
        Require-Path (Join-Path $CodexMemoryMcpRoot "src\server.mjs")

        foreach ($skill in $sharedSkills) {
            Require-Path (Join-Path $CodexHome "skills\$skill\SKILL.md")
            Require-Path (Join-Path $ClaudeHome "skills\$skill\SKILL.md")
        }
        foreach ($skill in $codexSkills) {
            Require-Path (Join-Path $CodexHome "skills\$skill\SKILL.md")
        }
        foreach ($skill in $claudeSkills) {
            Require-Path (Join-Path $ClaudeHome "skills\$skill\SKILL.md")
        }
        foreach ($skill in $agentSkills) {
            Require-Path (Join-Path $AgentsHome "skills\$skill\SKILL.md")
        }

        $configPath = Join-Path $CodexHome "config.toml"
        if (Test-Path -LiteralPath $configPath) {
            $config = [System.IO.File]::ReadAllText($configPath)
            if (-not $config.Contains("codex-memory")) {
                $errors.Add("Codex config missing codex-memory MCP block")
            }
            if ($config.Contains("{{")) {
                $errors.Add("Codex config still contains unresolved template placeholders")
            }
        }
    }
}

$forbiddenNames = @("auth.json", ".env", "credentials.json", "cookies.json")
$secretPatterns = @(
    'gh[pousr]_[A-Za-z0-9]{30,}',
    'sk-[A-Za-z0-9_-]{20,}',
    'AKIA[0-9A-Z]{16}',
    '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----',
    '(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*["''][^"'']{12,}["'']'
)

$files = @(Get-ChildItem -Recurse -File -Force -LiteralPath $repo |
    Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' })

foreach ($file in $files) {
    if ($file.FullName -match '[\\/]\.portable-backup-') {
        $errors.Add("Portable backup must not be committed: $($file.FullName)")
    }
    if ($forbiddenNames -contains $file.Name.ToLowerInvariant()) {
        $errors.Add("Forbidden sensitive filename: $($file.FullName)")
    }
    if ($file.Extension -in @(".log", ".pyc", ".pyo")) {
        $errors.Add("Runtime artifact must not be committed: $($file.FullName)")
    }
    if ($file.Length -le 5MB) {
        try {
            $text = [System.IO.File]::ReadAllText($file.FullName)
            foreach ($pattern in $secretPatterns) {
                if ([regex]::IsMatch($text, $pattern)) {
                    $errors.Add("Possible secret pattern in: $($file.FullName)")
                    break
                }
            }
        } catch {
            $errors.Add("Could not scan file for secrets: $($file.FullName)")
        }
    }
}

if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Host "Verification passed. Files scanned: $($files.Count)"
exit 0
