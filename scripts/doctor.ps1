[CmdletBinding()]
param(
    [Alias("SkipSlow")][switch]$Quick,
    [switch]$Json,
    [switch]$LibraryOnly,
    [string]$CodexHome = (Join-Path $HOME ".codex"),
    [string]$WorkspaceRoot = "D:\Workspace",
    [string]$WorkerRoot = "D:\Workspace\MCP\cc-switch-worker-mcp",
    [string]$AgentReachExe = (Join-Path $HOME ".agent-reach-venv\Scripts\agent-reach.exe"),
    [string]$GitNexusExe = (Join-Path $env:APPDATA "npm\gitnexus.ps1"),
    [string]$GBrainExe = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function ConvertTo-DoctorStatus {
    param([AllowNull()][AllowEmptyString()][object]$Status)
    switch -Regex (([string]$Status).Trim().ToLowerInvariant()) {
        '^(ok|on|ready|healthy|enabled|pass|passed|true)$' { return "OK" }
        '^(fail|failed|error|unhealthy|fatal|false)$' { return "FAIL" }
        '^(warn|warning|off|degraded|disabled|partial|unknown|skipped)$' { return "WARN" }
        default { return "WARN" }
    }
}

function Get-SemanticStatusSummary {
    param([AllowEmptyCollection()][object[]]$Statuses)

    $ok = 0
    $warn = 0
    $fail = 0
    foreach ($status in @($Statuses)) {
        switch (ConvertTo-DoctorStatus $status) {
            "OK" { $ok++ }
            "WARN" { $warn++ }
            "FAIL" { $fail++ }
        }
    }
    return [pscustomobject]@{
        ok = $ok
        warn = $warn
        fail = $fail
        overall = if ($fail -gt 0) { "FAIL" } elseif ($warn -gt 0) { "WARN" } else { "OK" }
    }
}

function Add-DoctorCheck {
    param(
        [ValidateSet("OK", "WARN", "FAIL")][string]$Status,
        [string]$Area,
        [string]$Detail
    )
    $script:Checks.Add([pscustomobject]@{ status = $Status; area = $Area; detail = $Detail })
}

function Get-FirstOutputLine {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return "no output" }
    return (($Text -split "`r?`n") | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1).Trim()
}

function Invoke-ProcessCapture {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 60,
        [string]$WorkingDirectory = ""
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        return [pscustomobject]@{ exitCode = $null; timedOut = $false; stdout = ""; stderr = "Missing command: $FilePath" }
    }
    $actualFile = $FilePath
    $actualArguments = @($Arguments)
    if ([System.IO.Path]::GetExtension($FilePath) -ieq ".ps1") {
        $actualFile = (Get-Command pwsh -ErrorAction Stop).Source
        $actualArguments = @("-NoProfile", "-File", $FilePath) + $Arguments
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $actualFile
    if ($WorkingDirectory) { $startInfo.WorkingDirectory = [System.IO.Path]::GetFullPath($WorkingDirectory) }
    foreach ($argument in $actualArguments) { $startInfo.ArgumentList.Add($argument) }
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $completed = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $completed) {
        try { $process.Kill($true) } catch {}
        $process.WaitForExit()
    }
    return [pscustomobject]@{
        exitCode = if ($completed) { $process.ExitCode } else { $null }
        timedOut = -not $completed
        stdout = $stdout.GetAwaiter().GetResult().Trim()
        stderr = $stderr.GetAwaiter().GetResult().Trim()
    }
}

function Read-JsonResult {
    param([Parameter(Mandatory)][object]$Result)
    if ($Result.timedOut) { throw "command timed out" }
    if ([string]::IsNullOrWhiteSpace($Result.stdout)) {
        throw (Get-FirstOutputLine $Result.stderr)
    }
    return $Result.stdout | ConvertFrom-Json
}

function Invoke-PortableDoctor {
    $script:Checks = [System.Collections.Generic.List[object]]::new()
    $repository = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    $WorkspaceRoot = [System.IO.Path]::GetFullPath($WorkspaceRoot)
    $WorkerRoot = [System.IO.Path]::GetFullPath($WorkerRoot)

    Add-DoctorCheck $(if ($PSVersionTable.PSVersion.Major -ge 7) { "OK" } else { "FAIL" }) "PowerShell" "pwsh $($PSVersionTable.PSVersion)"
    $configPath = Join-Path $CodexHome "config.toml"
    Add-DoctorCheck $(if (Test-Path -LiteralPath $configPath -PathType Leaf) { "OK" } else { "FAIL" }) "Codex config" $(if (Test-Path -LiteralPath $configPath -PathType Leaf) { "config.toml exists" } else { "config.toml is missing" })

    if (Test-Path -LiteralPath $AgentReachExe -PathType Leaf) {
        try {
            $result = Invoke-ProcessCapture $AgentReachExe @("doctor", "--json") 120
            $report = Read-JsonResult $result
            $rawStatuses = @($report.PSObject.Properties | ForEach-Object { [string]$_.Value.status })
            $semantic = Get-SemanticStatusSummary $rawStatuses
            $rawCounts = @($rawStatuses | Group-Object | Sort-Object Name | ForEach-Object { "$($_.Name.ToLowerInvariant())=$($_.Count)" }) -join ", "
            Add-DoctorCheck $semantic.overall "Agent Reach" $rawCounts
        } catch {
            Add-DoctorCheck "FAIL" "Agent Reach" $_.Exception.Message
        }
    } else {
        Add-DoctorCheck "FAIL" "Agent Reach" "agent-reach executable is missing"
    }

    if (-not $GBrainExe) {
        $gbrainCommand = Get-Command gbrain -ErrorAction SilentlyContinue
        if ($gbrainCommand) { $GBrainExe = $gbrainCommand.Source }
    }
    if ($GBrainExe -and (Test-Path -LiteralPath $GBrainExe -PathType Leaf)) {
        try {
            $result = Invoke-ProcessCapture $GBrainExe @("doctor", "--json") 90
            $report = Read-JsonResult $result
            $checkStatuses = @($report.checks | ForEach-Object { $_.status })
            $semantic = Get-SemanticStatusSummary @([string]$report.status, $checkStatuses)
            $counts = Get-SemanticStatusSummary $checkStatuses
            Add-DoctorCheck $semantic.overall "GBrain" "status=$($report.status), health_score=$($report.health_score), checks OK=$($counts.ok) WARN=$($counts.warn) FAIL=$($counts.fail)"
        } catch {
            Add-DoctorCheck "FAIL" "GBrain" $_.Exception.Message
        }
    } else {
        Add-DoctorCheck "FAIL" "GBrain" "gbrain executable is missing"
    }

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $workerEntry = Join-Path $WorkerRoot "src\cc-switch-worker-mcp.mjs"
    if ($nodeCommand -and (Test-Path -LiteralPath $workerEntry -PathType Leaf)) {
        try {
            $result = Invoke-ProcessCapture $nodeCommand.Source @($workerEntry, "--doctor") 60
            $report = Read-JsonResult $result
            $failedChecks = @($report.checks | Where-Object { $_.ok -ne $true }).Count
            Add-DoctorCheck $(if ($report.ok -eq $true -and $failedChecks -eq 0) { "OK" } else { "FAIL" }) "Worker doctor" "version=$($report.server_version), failed_checks=$failedChecks"
        } catch {
            Add-DoctorCheck "FAIL" "Worker doctor" $_.Exception.Message
        }
    } else {
        Add-DoctorCheck "FAIL" "Worker doctor" "node or installed Worker source is missing"
    }

    if (Test-Path -LiteralPath $GitNexusExe -PathType Leaf) {
        $statusResult = Invoke-ProcessCapture $GitNexusExe @("status") 60
        if ($statusResult.exitCode -eq 0 -and $statusResult.stdout -match 'Status:\s*(?:✅\s*)?up-to-date') {
            Add-DoctorCheck "OK" "GitNexus index" "index is up-to-date"
        } elseif ($statusResult.exitCode -eq 0) {
            Add-DoctorCheck "WARN" "GitNexus index" (Get-FirstOutputLine $statusResult.stdout)
        } else {
            Add-DoctorCheck "FAIL" "GitNexus index" (Get-FirstOutputLine ($statusResult.stderr + "`n" + $statusResult.stdout))
        }
        try {
            $queryResult = Invoke-ProcessCapture $GitNexusExe @("query", "portable install inventory", "--repo", $repository, "--limit", "1") 60
            $query = Read-JsonResult $queryResult
            $queryCount = @($query.processes).Count + @($query.definitions).Count
            Add-DoctorCheck $(if ($queryCount -gt 0) { "OK" } else { "WARN" }) "GitNexus query" "real query returned $queryCount graph result(s)"
        } catch {
            Add-DoctorCheck "FAIL" "GitNexus query" $_.Exception.Message
        }
    } else {
        Add-DoctorCheck "FAIL" "GitNexus" "gitnexus executable is missing"
    }

    $verifyArguments = @("-NoProfile", "-File", (Join-Path $repository "scripts\verify.ps1"))
    if (-not $Quick) {
        $verifyArguments += @("-CheckInstalled", "-AuditInstalledCoverage", "-CodexHome", $CodexHome, "-WorkspaceRoot", $WorkspaceRoot, "-WorkerRoot", $WorkerRoot)
    }
    $verifyResult = Invoke-ProcessCapture (Get-Command pwsh -ErrorAction Stop).Source $verifyArguments 180
    Add-DoctorCheck $(if ($verifyResult.exitCode -eq 0) { "OK" } else { "FAIL" }) "Portable workspace" $(if ($verifyResult.exitCode -eq 0) { "repository and requested installed checks passed" } else { Get-FirstOutputLine ($verifyResult.stderr + "`n" + $verifyResult.stdout) })

    if (-not $Quick -and $nodeCommand) {
        $offlineScript = Join-Path $WorkerRoot "scripts\verify-offline.mjs"
        if (Test-Path -LiteralPath $offlineScript -PathType Leaf) {
            $offlineResult = Invoke-ProcessCapture -FilePath $nodeCommand.Source -Arguments @($offlineScript) -TimeoutSeconds 240 -WorkingDirectory $WorkerRoot
            Add-DoctorCheck $(if ($offlineResult.exitCode -eq 0) { "OK" } else { "FAIL" }) "Worker offline suite" $(if ($offlineResult.exitCode -eq 0) { "offline suite passed" } else { Get-FirstOutputLine ($offlineResult.stderr + "`n" + $offlineResult.stdout) })
        } else {
            Add-DoctorCheck "FAIL" "Worker offline suite" "verify-offline.mjs is missing"
        }
    }

    $summary = Get-SemanticStatusSummary @($script:Checks | ForEach-Object { $_.status })
    return [pscustomobject]@{
        mode = if ($Quick) { "quick" } else { "full" }
        summary = $summary
        checks = @($script:Checks)
    }
}

function Write-PortableDoctorReport {
    param([Parameter(Mandatory)][object]$Report)
    if ($Json) {
        $Report | ConvertTo-Json -Depth 6
        return
    }
    Write-Host "Portable workspace doctor"
    Write-Host "OK=$($Report.summary.ok) WARN=$($Report.summary.warn) FAIL=$($Report.summary.fail)"
    foreach ($check in $Report.checks) {
        Write-Host "[$($check.status)] $($check.area): $($check.detail)"
    }
}

if (-not $LibraryOnly) {
    $report = Invoke-PortableDoctor
    Write-PortableDoctorReport $report
    if ($report.summary.fail -gt 0) { exit 1 }
    if ($report.summary.warn -gt 0) { exit 2 }
    exit 0
}
