[CmdletBinding()]
param(
    [switch]$CheckInstalled,
    [switch]$AuditInstalledCoverage,
    [string]$CodexHome = (Join-Path $HOME ".codex"),
    [string]$ClaudeHome = (Join-Path $HOME ".claude"),
    [string]$AgentsHome = (Join-Path $HOME ".agents"),
    [string]$WorkspaceRoot = "D:\Workspace",
    [string]$WorkerRoot = "D:\Workspace\MCP\cc-switch-worker-mcp"
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

function Add-WorkerMirrorErrors {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$InstalledRoot
    )
    if (-not (Test-Path -LiteralPath $SourceRoot) -or -not (Test-Path -LiteralPath $InstalledRoot)) { return }
    $sourceFiles = @{}
    Get-ChildItem -Recurse -File -Force -LiteralPath $SourceRoot | ForEach-Object {
        $sourceFiles[$_.FullName.Substring($SourceRoot.Length + 1)] = $_.FullName
    }
    $installedFiles = @{}
    Get-ChildItem -Recurse -File -Force -LiteralPath $InstalledRoot |
        Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' } |
        ForEach-Object { $installedFiles[$_.FullName.Substring($InstalledRoot.Length + 1)] = $_.FullName }

    foreach ($relative in $sourceFiles.Keys) {
        if (-not $installedFiles.ContainsKey($relative)) {
            $errors.Add("Installed worker file missing: $relative")
            continue
        }
        $expectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceFiles[$relative]).Hash
        $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedFiles[$relative]).Hash
        if ($expectedHash -cne $actualHash) {
            $errors.Add("Installed worker drift: $relative")
        }
    }
    foreach ($relative in $installedFiles.Keys) {
        if ($sourceFiles.ContainsKey($relative)) { continue }
        if ($relative -eq '99_Retrospective.md' -or $relative.StartsWith('docs\', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        $errors.Add("Unexpected installed worker file outside explicit runtime allowances: $relative")
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
    "scripts\ci.ps1",
    "scripts\doctor.ps1",
    "scripts\verify.ps1",
    "scripts\smoke-portable-workspace.ps1",
    ".github\workflows\ci.yml",
    "tools\cc-switch-worker-mcp\src\cc-switch-worker-mcp.mjs"
)) {
    Require-RepoPath $path
}

$templatePath = Join-Path $repo "codex\config.template.toml"
if (Test-Path -LiteralPath $templatePath) {
    $template = [System.IO.File]::ReadAllText($templatePath)
    if (-not $template.Contains("cc-switch-worker")) {
        $errors.Add("Config template missing cc-switch-worker MCP block")
    }
    if (-not $template.Contains("openaiDeveloperDocs")) {
        $errors.Add("Config template missing OpenAI Developer Docs MCP block")
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

foreach ($prefix in @("01_", "02_", "04_", "05_")) {
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
    }

    if ($CheckInstalled) {
        Require-Path (Join-Path $CodexHome "AGENTS.md")
        Require-Path (Join-Path $CodexHome "config.toml")
        foreach ($prefix in @("01_", "02_", "04_", "05_")) {
            $installedMatches = @(Get-ChildItem -File -LiteralPath $WorkspaceRoot -ErrorAction SilentlyContinue |
                Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) })
            if ($installedMatches.Count -ne 1) {
                $errors.Add("Expected one installed workspace rule prefix $prefix; found $($installedMatches.Count)")
                continue
            }
            $sourceMatches = @(Get-ChildItem -File -LiteralPath (Join-Path $repo "workspace") |
                Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) })
            if ($sourceMatches.Count -eq 1) {
                $expected = Render-PortableText ([System.IO.File]::ReadAllText($sourceMatches[0].FullName)) $CodexHome $WorkspaceRoot
                $actual = [System.IO.File]::ReadAllText($installedMatches[0].FullName)
                if ($actual -cne $expected) {
                    $errors.Add("Installed workspace rule differs from portable source: $($installedMatches[0].FullName)")
                }
            }
        }
        Require-Path (Join-Path $WorkerRoot "src\cc-switch-worker-mcp.mjs")
        Add-WorkerMirrorErrors (Join-Path $repo "tools\cc-switch-worker-mcp") $WorkerRoot

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
            if ($config.Contains("{{")) {
                $errors.Add("Codex config still contains unresolved template placeholders")
            }
        }

        $inventoryPath = Join-Path $CodexHome "portable-install-inventory.json"
        Require-Path $inventoryPath
        if (Test-Path -LiteralPath $inventoryPath) {
            try {
                $inventory = Get-Content -Raw -Encoding UTF8 -LiteralPath $inventoryPath | ConvertFrom-Json
                if ($inventory.schema_version -ne 1) {
                    $errors.Add("Unsupported installed inventory schema: $($inventory.schema_version)")
                }
                $inventoryByPath = @{}
                foreach ($entry in @($inventory.files)) {
                    $path = [System.IO.Path]::GetFullPath([string]$entry.path)
                    $inventoryByPath[$path] = [string]$entry.sha256
                    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                        $errors.Add("Installed inventory path is missing: $path")
                        continue
                    }
                    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
                    if ($actualHash -cne ([string]$entry.sha256).ToLowerInvariant()) {
                        $errors.Add("Installed inventory hash mismatch: $path")
                    }
                }
                foreach ($path in (Get-ManagedInstalledFiles $manifest $CodexHome $ClaudeHome $AgentsHome $WorkspaceRoot $WorkerRoot)) {
                    if (-not $inventoryByPath.ContainsKey([System.IO.Path]::GetFullPath($path))) {
                        $errors.Add("Installed file missing from versioned inventory: $path")
                    }
                }
            } catch {
                $errors.Add("Could not validate installed inventory: $($_.Exception.Message)")
            }
        }
    }
}

$forbiddenNames = @("auth.json", "credentials.json", "cookies.json")
$secretPatterns = @(
    'gh[pousr]_[A-Za-z0-9]{30,}',
    'sk-[A-Za-z0-9_-]{20,}',
    'AKIA[0-9A-Z]{16}',
    '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----',
    '(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*["''][^"'']{12,}["'']'
)
$secretRegexes = @($secretPatterns | ForEach-Object { [regex]::new($_, [System.Text.RegularExpressions.RegexOptions]::Compiled) })

function Test-ForbiddenSensitiveName {
    param([Parameter(Mandatory)][string]$Name)
    $lower = $Name.ToLowerInvariant()
    return $forbiddenNames -contains $lower -or
        $lower -eq '.env' -or $lower.StartsWith('.env.', [System.StringComparison]::Ordinal) -or
        $lower -match '^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.+\.(pem|key|p12|pfx|jks|keystore))$'
}

function Test-FileForSecret {
    param([Parameter(Mandatory)][string]$Path)
    $reader = [System.IO.StreamReader]::new($Path, [System.Text.UTF8Encoding]::new($false, $false), $true, 65536)
    try {
        $buffer = [char[]]::new(65536)
        $tail = ''
        while (($count = $reader.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $chunk = $tail + [string]::new($buffer, 0, $count)
            foreach ($pattern in $secretRegexes) {
                if ($pattern.IsMatch($chunk)) { return $true }
            }
            $tail = if ($chunk.Length -gt 4096) { $chunk.Substring($chunk.Length - 4096) } else { $chunk }
        }
        return $false
    } finally {
        $reader.Dispose()
    }
}

$files = @(Get-ChildItem -Recurse -File -Force -LiteralPath $repo |
    Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' })

foreach ($file in $files) {
    if ($file.FullName -match '[\\/]\.portable-backup-') {
        $errors.Add("Portable backup must not be committed: $($file.FullName)")
    }
    if (Test-ForbiddenSensitiveName $file.Name) {
        $errors.Add("Forbidden sensitive filename: $($file.FullName)")
    }
    if ($file.Extension -in @(".log", ".pyc", ".pyo")) {
        $errors.Add("Runtime artifact must not be committed: $($file.FullName)")
    }
    try {
        if (Test-FileForSecret $file.FullName) {
            $errors.Add("Possible secret pattern in: $($file.FullName)")
        }
    } catch {
        $errors.Add("Could not scan file for secrets: $($file.FullName)")
    }
}

if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Host "Verification passed. Files scanned: $($files.Count)"
exit 0
