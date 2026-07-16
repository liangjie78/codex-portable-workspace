[CmdletBinding()]
param(
    [string]$RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$RepositoryRoot = [System.IO.Path]::GetFullPath($RepositoryRoot)
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-portable-ci-" + [guid]::NewGuid().ToString("N"))

$parseErrors = [System.Collections.Generic.List[string]]::new()
Get-ChildItem -File -LiteralPath (Join-Path $RepositoryRoot "scripts") -Filter "*.ps1" | ForEach-Object {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    foreach ($error in $errors) { $parseErrors.Add("$($_.Name):$($error.Extent.StartLineNumber): $($error.Message)") }
}
if ($parseErrors.Count -gt 0) { throw ($parseErrors -join "`n") }

& $pwsh -NoProfile -File (Join-Path $RepositoryRoot "scripts\verify.ps1")
if ($LASTEXITCODE -ne 0) { throw "Repository verification failed with exit code $LASTEXITCODE" }

& $pwsh -NoProfile -File (Join-Path $RepositoryRoot "scripts\smoke-portable-workspace.ps1")
if ($LASTEXITCODE -ne 0) { throw "Portable workspace smoke failed with exit code $LASTEXITCODE" }

try {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    $workerRoot = Join-Path $tempRoot "worker"
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot "tools\cc-switch-worker-mcp") -Destination $workerRoot -Recurse
    Push-Location $workerRoot
    try {
        & $npm ci --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
        $previousDoctorIsolation = $env:CC_SWITCH_WORKER_DOCTOR_ISOLATED
        $previousCodexHome = $env:CODEX_HOME
        try {
            $env:CC_SWITCH_WORKER_DOCTOR_ISOLATED = "1"
            $env:CODEX_HOME = Join-Path $tempRoot "codex"
            & $npm run mcp:verify:offline
            if ($LASTEXITCODE -ne 0) { throw "Worker offline suite failed with exit code $LASTEXITCODE" }
        } finally {
            $env:CC_SWITCH_WORKER_DOCTOR_ISOLATED = $previousDoctorIsolation
            $env:CODEX_HOME = $previousCodexHome
        }
        & $npm audit --omit=dev --audit-level=moderate
        if ($LASTEXITCODE -ne 0) { throw "Production dependency audit failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
} finally {
    $resolved = [System.IO.Path]::GetFullPath($tempRoot)
    $prefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + [System.IO.Path]::DirectorySeparatorChar
    if ($resolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

Write-Host "CI verification passed."
