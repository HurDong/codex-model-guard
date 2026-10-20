param([switch]$ReadOnly)
$ErrorActionPreference = 'Stop'
@{at=[DateTime]::UtcNow.ToString('o');status='target_capture_started'} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'keyboard-status.json') -Encoding utf8
try {
    Import-Module (Join-Path $PSScriptRoot 'LocalRecovery.psm1') -Force -DisableNameChecking
    $binding = Get-RecoveryBinding ''
    if ($ReadOnly) { $binding | ConvertTo-Json -Compress; exit 0 }
    $title = '시작 설정'
    try {
        $copy = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ui-copy.json') -Raw | ConvertFrom-Json
        if ($copy.name -is [string] -and $copy.name.Trim()) { $title = $copy.name }
    } catch {}
    $ready = $false
    $focusError = $null
    try { $ready = Set-RecoveryConfirmationFocus $binding -Title $title } catch { $focusError = $_.Exception.GetType().Name }
    @{at=[DateTime]::UtcNow.ToString('o');status=$(if ($ready) {'card_focused'} else {'card_focus_not_confirmed'});errorType=$focusError} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'keyboard-status.json') -Encoding utf8
    $binding.escapeFocusReady = $ready
    $binding | ConvertTo-Json -Compress
} catch {
    @{at=[DateTime]::UtcNow.ToString('o');status='target_unavailable'} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'keyboard-status.json') -Encoding utf8
    exit 1
}
