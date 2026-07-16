Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-RepositoryRoot {
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
}

function Ensure-Directory {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
}

function Reset-PortableDirectory {
    param([Parameter(Mandatory)][string]$Path)
    $repo = [System.IO.Path]::GetFullPath((Get-RepositoryRoot)).TrimEnd('\')
    $resolved = [System.IO.Path]::GetFullPath($Path)
    $prefix = $repo + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to reset a path outside repository snapshot: $resolved"
    }
    if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    Ensure-Directory $resolved
}

function Get-ManifestList {
    param(
        [Parameter(Mandatory)][object]$Manifest,
        [Parameter(Mandatory)][string]$PropertyName
    )
    if (-not ($Manifest.PSObject.Properties.Name -contains $PropertyName)) { return @() }
    return @($Manifest.$PropertyName) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
}

function Get-InstalledSkillNames {
    param([Parameter(Mandatory)][string]$SkillsRoot)
    if (-not (Test-Path -LiteralPath $SkillsRoot)) { return @() }
    return @(Get-ChildItem -Directory -Force -LiteralPath $SkillsRoot |
        Where-Object {
            $_.Name -ne ".system" -and
            -not $_.Name.StartsWith(".portable-backup-", [System.StringComparison]::OrdinalIgnoreCase) -and
            (Test-Path -LiteralPath (Join-Path $_.FullName "SKILL.md"))
        } |
        Sort-Object Name |
        ForEach-Object { $_.Name })
}

function Remove-SkillRuntimeArtifacts {
    param([Parameter(Mandatory)][string]$Root)
    if (-not (Test-Path -LiteralPath $Root)) { return }
    Get-ChildItem -Recurse -Directory -Force -LiteralPath $Root |
        Where-Object { $_.Name -eq "__pycache__" } |
        Remove-Item -Recurse -Force
    Get-ChildItem -Recurse -File -Force -LiteralPath $Root |
        Where-Object { $_.Extension -in @(".pyc", ".pyo") } |
        Remove-Item -Force
}

function Copy-PortableItem {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [switch]$Force
    )
    if (-not (Test-Path -LiteralPath $Source)) {
        throw "Source does not exist: $Source"
    }
    if ((Test-Path -LiteralPath $Destination) -and -not $Force) {
        throw "Destination already exists: $Destination. Re-run with -Force after reviewing the target."
    }
    $parent = Split-Path -Parent $Destination
    if ($parent) { Ensure-Directory $parent }
    if (Test-Path -LiteralPath $Destination) {
        $resolved = [System.IO.Path]::GetFullPath($Destination)
        if ([string]::IsNullOrWhiteSpace($resolved) -or $resolved.Length -lt 4) {
            throw "Refusing unsafe replacement target: $resolved"
        }
        Backup-ExistingItem $resolved | Out-Null
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Backup-ExistingItem {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $parent = Split-Path -Parent $Path
    $leaf = Split-Path -Leaf $Path
    $backup = Join-Path $parent ".portable-backup-$stamp-$leaf"
    Copy-Item -LiteralPath $Path -Destination $backup -Recurse -Force
    return $backup
}

function Convert-ToTomlPath {
    param([Parameter(Mandatory)][string]$Path)
    return ([System.IO.Path]::GetFullPath($Path) -replace '\\', '/')
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Content
    )
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Render-PortableText {
    param(
        [Parameter(Mandatory)][string]$Content,
        [Parameter(Mandatory)][string]$CodexHome,
        [Parameter(Mandatory)][string]$WorkspaceRoot
    )
    $agentsPath = Join-Path $CodexHome "AGENTS.md"
    return $Content.Replace("{{CODEX_AGENTS}}", $agentsPath).Replace("{{WORKSPACE_ROOT}}", $WorkspaceRoot)
}

function Get-SimpleTomlTemplateSections {
    param([Parameter(Mandatory)][string]$Content)

    $sections = [System.Collections.Generic.List[object]]::new()
    $current = [pscustomobject]@{
        Name = ""
        Values = [System.Collections.Specialized.OrderedDictionary]::new()
    }
    $sections.Add($current)
    foreach ($line in ($Content -split "`r?`n")) {
        if ($line -match '^\s*\[(?<name>[^\[\]]+)\]\s*$') {
            $current = [pscustomobject]@{
                Name = $Matches.name
                Values = [System.Collections.Specialized.OrderedDictionary]::new()
            }
            $sections.Add($current)
        } elseif ($line -match '^\s*(?<key>[A-Za-z0-9_-]+)\s*=') {
            $current.Values[$Matches.key] = $line.Trim()
        }
    }
    return @($sections)
}

function Merge-SimpleTomlSection {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][System.Collections.Generic.List[string]]$Lines,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Section,
        [Parameter(Mandatory)][System.Collections.Specialized.OrderedDictionary]$Values,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[string]]$Changes,
        [switch]$Overwrite
    )

    $start = 0
    $end = $Lines.Count
    if ($Section) {
        $header = "[$Section]"
        $headerIndex = -1
        for ($i = 0; $i -lt $Lines.Count; $i++) {
            if ($Lines[$i].Trim() -ceq $header) {
                $headerIndex = $i
                break
            }
        }
        if ($headerIndex -lt 0) {
            if ($Lines.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($Lines[$Lines.Count - 1])) {
                $Lines.Add("")
            }
            $Lines.Add($header)
            foreach ($entry in $Values.GetEnumerator()) {
                $Lines.Add([string]$entry.Value)
                $Changes.Add("[$Section] $($entry.Key): added")
            }
            return
        }
        $start = $headerIndex + 1
        for ($i = $start; $i -lt $Lines.Count; $i++) {
            $trimmed = $Lines[$i].Trim()
            if ($trimmed.StartsWith("[") -and $trimmed.EndsWith("]")) {
                $end = $i
                break
            }
        }
    } else {
        for ($i = 0; $i -lt $Lines.Count; $i++) {
            $trimmed = $Lines[$i].Trim()
            if ($trimmed.StartsWith("[") -and $trimmed.EndsWith("]")) {
                $end = $i
                break
            }
        }
    }

    foreach ($entry in $Values.GetEnumerator()) {
        $keyPattern = '^\s*' + [regex]::Escape([string]$entry.Key) + '\s*='
        $existingIndex = -1
        for ($i = $start; $i -lt $end; $i++) {
            if ($Lines[$i] -match $keyPattern) {
                $existingIndex = $i
                break
            }
        }
        if ($existingIndex -ge 0) {
            if ($Overwrite -and $Lines[$existingIndex].Trim() -cne [string]$entry.Value) {
                $value = ($Lines[$existingIndex] -split '=', 2)[1].TrimStart()
                $valueEnd = $existingIndex + 1
                if ($value.StartsWith("[") -or $value.StartsWith("{")) {
                    $balance = 0
                    for ($i = $existingIndex; $i -lt $end; $i++) {
                        foreach ($character in $Lines[$i].ToCharArray()) {
                            if ($character -in @('[', '{')) { $balance++ }
                            elseif ($character -in @(']', '}')) { $balance-- }
                        }
                        $valueEnd = $i + 1
                        if ($balance -le 0) { break }
                    }
                }
                $Lines[$existingIndex] = [string]$entry.Value
                while ($valueEnd -gt $existingIndex + 1) {
                    $Lines.RemoveAt($existingIndex + 1)
                    $valueEnd--
                    $end--
                }
                $Changes.Add("$(if ($Section) { "[$Section] " })$($entry.Key): updated")
            }
            continue
        }
        $Lines.Insert($end, [string]$entry.Value)
        $end++
        $Changes.Add("$(if ($Section) { "[$Section] " })$($entry.Key): added")
    }
}

function Merge-PortableCodexConfig {
    param(
        [Parameter(Mandatory)][string]$Existing,
        [Parameter(Mandatory)][string]$Template
    )

    $newLine = if ($Existing.Contains("`r`n")) { "`r`n" } else { "`n" }
    $hadTrailingNewLine = $Existing.EndsWith("`n")
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in ($Existing -split "`r?`n")) { $lines.Add($line) }
    $changes = [System.Collections.Generic.List[string]]::new()

    foreach ($section in (Get-SimpleTomlTemplateSections $Template)) {
        $managed = $section.Name.StartsWith("projects.", [System.StringComparison]::Ordinal) -or
            $section.Name -ceq "mcp_servers.cc-switch-worker" -or
            $section.Name -ceq "mcp_servers.openaiDeveloperDocs"
        Merge-SimpleTomlSection -Lines $lines -Section $section.Name -Values $section.Values -Changes $changes -Overwrite:$managed
    }

    $content = $lines -join $newLine
    if ($hadTrailingNewLine -and -not $content.EndsWith($newLine)) { $content += $newLine }
    return [pscustomobject]@{
        Content = $content
        Changes = @($changes)
    }
}

function Write-PortableTemplate {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$CodexHome,
        [Parameter(Mandatory)][string]$WorkspaceRoot
    )
    $content = [System.IO.File]::ReadAllText($Source)
    $content = $content.Replace((Join-Path $CodexHome "AGENTS.md"), "{{CODEX_AGENTS}}")
    $content = $content.Replace($WorkspaceRoot, "{{WORKSPACE_ROOT}}")
    Write-Utf8NoBom $Destination $content
}

function Get-ManagedInstalledFiles {
    param(
        [Parameter(Mandatory)][object]$Manifest,
        [Parameter(Mandatory)][string]$CodexHome,
        [Parameter(Mandatory)][string]$ClaudeHome,
        [Parameter(Mandatory)][string]$AgentsHome,
        [Parameter(Mandatory)][string]$WorkspaceRoot,
        [Parameter(Mandatory)][string]$WorkerRoot
    )

    $paths = [System.Collections.Generic.List[string]]::new()
    foreach ($path in @((Join-Path $CodexHome "AGENTS.md"), (Join-Path $CodexHome "config.toml"))) {
        $paths.Add([System.IO.Path]::GetFullPath($path))
    }
    foreach ($prefix in @("01_", "02_", "04_", "05_")) {
        $matches = @(Get-ChildItem -File -LiteralPath $WorkspaceRoot -ErrorAction SilentlyContinue |
            Where-Object { $_.Name.StartsWith($prefix, [System.StringComparison]::Ordinal) })
        if ($matches.Count -eq 1) { $paths.Add($matches[0].FullName) }
    }

    $targets = @(
        @{ Root = (Join-Path $CodexHome "skills"); Skills = @((Get-ManifestList $Manifest "shared_skills") + (Get-ManifestList $Manifest "codex_skills")) },
        @{ Root = (Join-Path $ClaudeHome "skills"); Skills = @((Get-ManifestList $Manifest "shared_skills") + (Get-ManifestList $Manifest "claude_skills")) },
        @{ Root = (Join-Path $AgentsHome "skills"); Skills = @(Get-ManifestList $Manifest "agent_skills") }
    )
    foreach ($target in $targets) {
        foreach ($skill in $target.Skills) {
            $skillRoot = Join-Path $target.Root $skill
            if (-not (Test-Path -LiteralPath $skillRoot)) { continue }
            Get-ChildItem -Recurse -File -Force -LiteralPath $skillRoot |
                Where-Object { $_.FullName -notmatch '[\\/]__pycache__[\\/]' -and $_.Extension -notin @('.pyc', '.pyo') } |
                ForEach-Object { $paths.Add($_.FullName) }
        }
    }

    if (Test-Path -LiteralPath $WorkerRoot) {
        Get-ChildItem -Recurse -File -Force -LiteralPath $WorkerRoot |
            Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' } |
            ForEach-Object { $paths.Add($_.FullName) }
    }

    return @($paths | Sort-Object -Unique)
}

function Write-InstalledInventory {
    param(
        [Parameter(Mandatory)][object]$Manifest,
        [Parameter(Mandatory)][string]$CodexHome,
        [Parameter(Mandatory)][string]$ClaudeHome,
        [Parameter(Mandatory)][string]$AgentsHome,
        [Parameter(Mandatory)][string]$WorkspaceRoot,
        [Parameter(Mandatory)][string]$WorkerRoot
    )

    $entries = foreach ($path in (Get-ManagedInstalledFiles $Manifest $CodexHome $ClaudeHome $AgentsHome $WorkspaceRoot $WorkerRoot)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        [ordered]@{
            path = $path
            sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
        }
    }
    $inventory = [ordered]@{
        schema_version = 1
        generated_at = (Get-Date).ToUniversalTime().ToString('o')
        files = @($entries)
    }
    $path = Join-Path $CodexHome "portable-install-inventory.json"
    Write-Utf8NoBom $path ($inventory | ConvertTo-Json -Depth 5)
    return $path
}
