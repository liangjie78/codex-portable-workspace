[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$node = (Get-Command node -ErrorAction Stop).Source
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-portable-smoke-" + [guid]::NewGuid().ToString("N"))
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
    param([string]$Name, [bool]$Passed)
    $checks.Add([pscustomobject]@{ name = $Name; passed = $Passed })
    if (-not $Passed) { throw "Smoke check failed: $Name" }
}

function Invoke-Script {
    param([string]$Script, [string[]]$Arguments)
    $output = @(& $pwsh -NoProfile -File $Script @Arguments 2>&1)
    $script:FullScriptOutput = @($output | ForEach-Object { [string]$_ }) -join "`n"
    $script:LastScriptOutput = @($output | Select-Object -Last 8 | ForEach-Object { [string]$_ }) -join "`n"
    return $LASTEXITCODE
}

function Copy-Repository {
    param([string]$Destination)
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -Force -LiteralPath $repo |
        Where-Object { $_.Name -ne ".git" } |
        Copy-Item -Destination $Destination -Recurse -Force
}

function Get-RuleFile {
    param([string]$WorkspaceRoot, [string]$Prefix)
    $matches = @(Get-ChildItem -File -LiteralPath $WorkspaceRoot |
        Where-Object { $_.Name.StartsWith($Prefix, [System.StringComparison]::Ordinal) })
    if ($matches.Count -ne 1) { throw "Expected one $Prefix rule under $WorkspaceRoot" }
    return $matches[0].FullName
}

function Get-ManagedDigest {
    param([string]$Repository)
    $rows = foreach ($relative in @("workspace", "skills\shared", "skills\codex", "skills\claude", "skills\agents")) {
        $path = Join-Path $Repository $relative
        Get-ChildItem -Recurse -File -Force -LiteralPath $path | ForEach-Object {
            "$($_.FullName.Substring($Repository.Length + 1))=$((Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash)"
        }
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($rows | Sort-Object) -join "`n")
    return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes))
}

function New-IsolatedPaths {
    param([string]$Base)
    return @{
        Codex = (Join-Path $Base "codex")
        Claude = (Join-Path $Base "claude")
        Agents = (Join-Path $Base "agents")
        Workspace = (Join-Path $Base "workspace")
        Worker = (Join-Path $Base "worker")
    }
}

function Install-Arguments {
    param([hashtable]$Paths)
    return @(
        "-CodexHome", $Paths.Codex,
        "-ClaudeHome", $Paths.Claude,
        "-AgentsHome", $Paths.Agents,
        "-WorkspaceRoot", $Paths.Workspace,
        "-WorkerRoot", $Paths.Worker,
        "-NodeExe", $node,
        "-Force"
    )
}

function Verify-Arguments {
    param([hashtable]$Paths)
    return @(
        "-CheckInstalled", "-AuditInstalledCoverage",
        "-CodexHome", $Paths.Codex,
        "-ClaudeHome", $Paths.Claude,
        "-AgentsHome", $Paths.Agents,
        "-WorkspaceRoot", $Paths.Workspace,
        "-WorkerRoot", $Paths.Worker
    )
}

try {
    New-Item -ItemType Directory -Force -Path $root | Out-Null

    . (Join-Path $repo "scripts\doctor.ps1") -LibraryOnly
    $degradedSummary = Get-SemanticStatusSummary @("warn", "off", "degraded")
    Add-Check "doctor semantic warning/off/degraded is not green" ($degradedSummary.overall -eq "WARN" -and $degradedSummary.warn -eq 3)

    $whatIfBase = Join-Path $root "whatif"
    $whatIfPaths = New-IsolatedPaths $whatIfBase
    $whatIfExit = Invoke-Script (Join-Path $repo "scripts\install.ps1") @((Install-Arguments $whatIfPaths) + @("-InstallWorkerDependencies", "-WhatIf"))
    Add-Check "WhatIf exits successfully" ($whatIfExit -eq 0)
    Add-Check "WhatIf writes nothing" (-not (Test-Path -LiteralPath $whatIfBase))
    Add-Check "WhatIf does not report installation success" ($script:FullScriptOutput -notmatch 'Portable workspace installed\.')

    $installPaths = New-IsolatedPaths (Join-Path $root "install")
    $installExit = Invoke-Script (Join-Path $repo "scripts\install.ps1") (Install-Arguments $installPaths)
    Add-Check "isolated install succeeds" ($installExit -eq 0)

    $configPath = Join-Path $installPaths.Codex "config.toml"
    $syntheticConfig = @'
model = "fixture-model"
model_provider = "headroom"
synthetic_private_marker = "SYNTHETIC_PRIVATE_VALUE"

[model_providers.headroom]
base_url = "http://127.0.0.1:8787/v1"
requires_openai_auth = true

[mcp_servers.gbrain]
url = "http://127.0.0.1:3131/mcp"

[mcp_servers.gitnexus]
command = "gitnexus"

[hooks]
enabled = true

[memories]
enabled = true

[plugins."fixture@local"]
enabled = true

[mcp_servers.cc-switch-worker]
command = "old-node"
args = [
  "old-worker"
]
startup_timeout_sec = 1
custom_worker_field = "preserve-me"
'@
    [System.IO.File]::WriteAllText($configPath, $syntheticConfig, [System.Text.UTF8Encoding]::new($false))
    $configMergeExit = Invoke-Script (Join-Path $repo "scripts\install.ps1") (Install-Arguments $installPaths)
    if ($configMergeExit -ne 0) { Write-Error $script:LastScriptOutput }
    Add-Check "Force config merge succeeds" ($configMergeExit -eq 0)
    Add-Check "Force config merge does not print existing values" ($script:FullScriptOutput -notmatch 'SYNTHETIC_PRIVATE_VALUE')
    $mergedConfig = [System.IO.File]::ReadAllText($configPath)
    $preservedFragments = @(
        'model = "fixture-model"',
        'model_provider = "headroom"',
        '[model_providers.headroom]',
        '[mcp_servers.gbrain]',
        '[mcp_servers.gitnexus]',
        '[hooks]',
        '[memories]',
        '[plugins."fixture@local"]',
        'custom_worker_field = "preserve-me"'
    )
    Add-Check "Force config merge preserves unknown keys and integrations" (-not @($preservedFragments | Where-Object { -not $mergedConfig.Contains($_) }))
    Add-Check "Force config merge refreshes managed worker fields" ($mergedConfig -notmatch 'old-node|old-worker|startup_timeout_sec\s*=\s*1')
    $configBackups = @(Get-ChildItem -File -LiteralPath $installPaths.Codex -Filter ".portable-backup-*-config.toml")
    Add-Check "Force config merge creates a backup" ($configBackups.Count -eq 1)
    Add-Check "Config backup matches the pre-merge fixture" ([System.IO.File]::ReadAllText($configBackups[0].FullName) -ceq $syntheticConfig)
    Copy-Item -LiteralPath $configBackups[0].FullName -Destination $configPath -Force
    Add-Check "Config backup restores byte-for-byte" ([System.IO.File]::ReadAllText($configPath) -ceq $syntheticConfig)
    $remergeExit = Invoke-Script (Join-Path $repo "scripts\install.ps1") (Install-Arguments $installPaths)
    Add-Check "restored config can be merged again" ($remergeExit -eq 0)

    $verifyExit = Invoke-Script (Join-Path $repo "scripts\verify.ps1") (Verify-Arguments $installPaths)
    if ($verifyExit -ne 0) { Write-Error $script:LastScriptOutput }
    Add-Check "normal installed inventory verifies" ($verifyExit -eq 0)
    $installedInventoryCount = @((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $installPaths.Codex "portable-install-inventory.json") | ConvertFrom-Json).files).Count

    $ruleContents = @{}
    foreach ($prefix in @("01_", "04_", "05_")) {
        $path = Get-RuleFile $installPaths.Workspace $prefix
        $ruleContents[$path] = [System.IO.File]::ReadAllText($path)
        [System.IO.File]::WriteAllText($path, "BROKEN", [System.Text.UTF8Encoding]::new($false))
    }
    $brokenExit = Invoke-Script (Join-Path $repo "scripts\verify.ps1") (Verify-Arguments $installPaths)
    Add-Check "BROKEN rule bodies fail verification" ($brokenExit -ne 0)
    foreach ($entry in $ruleContents.GetEnumerator()) {
        [System.IO.File]::WriteAllText($entry.Key, $entry.Value, [System.Text.UTF8Encoding]::new($false))
    }

    foreach ($path in $ruleContents.Keys) { Remove-Item -LiteralPath $path -Force }
    $missingExit = Invoke-Script (Join-Path $repo "scripts\verify.ps1") (Verify-Arguments $installPaths)
    Add-Check "missing 01/04/05 rules fail verification" ($missingExit -ne 0)
    foreach ($entry in $ruleContents.GetEnumerator()) {
        [System.IO.File]::WriteAllText($entry.Key, $entry.Value, [System.Text.UTF8Encoding]::new($false))
    }
    $restoredExit = Invoke-Script (Join-Path $repo "scripts\verify.ps1") (Verify-Arguments $installPaths)
    Add-Check "restored installation verifies again" ($restoredExit -eq 0)

    $secretRepo = Join-Path $root "secret-repo"
    Copy-Repository $secretRepo
    [System.IO.File]::WriteAllText((Join-Path $secretRepo ".env.local"), "synthetic fixture", [System.Text.UTF8Encoding]::new($false))
    $envExit = Invoke-Script (Join-Path $secretRepo "scripts\verify.ps1") @()
    Add-Check ".env.local is rejected" ($envExit -ne 0)
    Remove-Item -LiteralPath (Join-Path $secretRepo ".env.local") -Force

    [System.IO.File]::WriteAllText((Join-Path $secretRepo "synthetic.pem"), "not a real certificate", [System.Text.UTF8Encoding]::new($false))
    $keyNameExit = Invoke-Script (Join-Path $secretRepo "scripts\verify.ps1") @()
    Add-Check "certificate and key filenames are rejected" ($keyNameExit -ne 0)
    Remove-Item -LiteralPath (Join-Path $secretRepo "synthetic.pem") -Force

    $largePath = Join-Path $secretRepo "synthetic-large.txt"
    $stream = [System.IO.File]::Open($largePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    try {
        $stream.SetLength(6MB)
        $stream.Position = 6MB - 64
        $marker = [System.Text.Encoding]::ASCII.GetBytes(("sk-" + ("A" * 24)))
        $stream.Write($marker, 0, $marker.Length)
    } finally {
        $stream.Dispose()
    }
    & git -C $secretRepo init --quiet
    & git -C $secretRepo add -- synthetic-large.txt
    $largeExit = Invoke-Script (Join-Path $secretRepo "scripts\verify.ps1") @()
    Add-Check "tracked 6 MB synthetic credential is rejected" ($largeExit -ne 0)

    $backupRepo = Join-Path $root "backup-repo"
    Copy-Repository $backupRepo
    & git -C $backupRepo init --quiet
    & git -C $backupRepo config core.autocrlf false
    & git -C $backupRepo add --all 2>$null
    & git -C $backupRepo -c user.name=Smoke -c user.email=smoke.invalid commit --quiet -m baseline
    [System.IO.File]::AppendAllText((Join-Path $backupRepo "README.md"), "`nUnrelated user edit.`n", [System.Text.UTF8Encoding]::new($false))
    $readmeBefore = [System.IO.File]::ReadAllText((Join-Path $backupRepo "README.md"))

    $backupPaths = New-IsolatedPaths (Join-Path $root "backup-install")
    $backupInstallExit = Invoke-Script (Join-Path $backupRepo "scripts\install.ps1") (Install-Arguments $backupPaths)
    Add-Check "backup fixture install succeeds" ($backupInstallExit -eq 0)
    $guidePath = Get-RuleFile $backupPaths.Workspace "02_"
    $guideOriginal = [System.IO.File]::ReadAllText($guidePath)
    [System.IO.File]::AppendAllText($guidePath, ("`n" + "sk-" + ("B" * 24)), [System.Text.UTF8Encoding]::new($false))
    $digestBeforeFailure = Get-ManagedDigest $backupRepo
    $backupArgs = @(
        "-CodexHome", $backupPaths.Codex,
        "-ClaudeHome", $backupPaths.Claude,
        "-AgentsHome", $backupPaths.Agents,
        "-WorkspaceRoot", $backupPaths.Workspace,
        "-WorkerRoot", $backupPaths.Worker,
        "-SkipWorkerOfflineSuite"
    )
    $failedBackupExit = Invoke-Script (Join-Path $backupRepo "scripts\backup.ps1") $backupArgs
    Add-Check "invalid candidate stops backup" ($failedBackupExit -ne 0)
    Add-Check "failed candidate leaves formal snapshots unchanged" ((Get-ManagedDigest $backupRepo) -ceq $digestBeforeFailure)
    Add-Check "failed candidate preserves unrelated user edit" ([System.IO.File]::ReadAllText((Join-Path $backupRepo "README.md")) -ceq $readmeBefore)

    [System.IO.File]::WriteAllText($guidePath, $guideOriginal, [System.Text.UTF8Encoding]::new($false))
    $recoveryExit = Invoke-Script (Join-Path $backupRepo "scripts\backup.ps1") $backupArgs
    if ($recoveryExit -ne 0) { Write-Error $script:LastScriptOutput }
    Add-Check "next backup succeeds after candidate failure" ($recoveryExit -eq 0)
    Add-Check "successful backup preserves unrelated user edit" ([System.IO.File]::ReadAllText((Join-Path $backupRepo "README.md")) -ceq $readmeBefore)

    [pscustomobject]@{ ok = $true; installed_inventory_files = $installedInventoryCount; checks = $checks } | ConvertTo-Json -Depth 4
} finally {
    $resolved = [System.IO.Path]::GetFullPath($root)
    $tempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + [System.IO.Path]::DirectorySeparatorChar
    if ($resolved.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
