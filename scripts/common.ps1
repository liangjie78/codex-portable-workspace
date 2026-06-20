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
