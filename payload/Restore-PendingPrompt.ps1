$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$result = @{ status = 'failed'; submitted = $false }
$request = $null
$workerStartedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
try {
    Import-Module (Join-Path $PSScriptRoot 'LocalRecovery.psm1') -Force -DisableNameChecking
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable
    $result = Invoke-LocalRecovery $request
} catch {
    # No request text, screen text, titles, or exception stack in the status file.
    $message = $_.Exception.Message
    $code = if ($message -match '^[a-z_]+$') { $message } else { 'accessibility_error' }
    $result = @{ status = $code; submitted = $false; stage = [string]$_.Exception.Data['recoveryStage'] }
    $result.errorType = $_.Exception.GetType().FullName
    $result.errorId = $_.FullyQualifiedErrorId
    if ($request -and $request.ContainsKey('selection')) {
        $result.model = $request.selection.model
        $result.effort = $request.selection.effort
    }
    if ($_.Exception.Data.Contains('submitted')) { $result.submitted = $_.Exception.Data['submitted'] }
} finally {
    $result.at = [DateTime]::UtcNow.ToString('o')
    $result.workerElapsedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $workerStartedAtMs
    if ($request -and $request.startedAtMs -is [long]) {
        $result.elapsedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $request.startedAtMs
    }
    $result | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'recovery-status.json') -Encoding utf8
}
