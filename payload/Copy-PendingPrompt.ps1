param([switch]$EnvelopeInput)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$recoveryStartedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
try {
    $incoming = [Console]::In.ReadToEnd()
    $promptText = $incoming
    $binding = $null
    $bindingProvided = $false
    $options = @{}
    if ($EnvelopeInput) {
        $envelope = $incoming | ConvertFrom-Json -AsHashtable -ErrorAction Stop
        if ($envelope.recoveryRequestVersion -eq 1 -and $envelope.prompt -is [string]) {
            $promptText = $envelope.prompt
            $binding = $envelope.binding
            $bindingProvided = $true
            foreach ($key in @('selection', 'grant', 'restoreOnly')) {
                if ($envelope.ContainsKey($key)) { $options[$key] = $envelope[$key] }
            }
            if ($envelope.declinedAtMs -is [long] -or $envelope.declinedAtMs -is [int]) { $recoveryStartedAtMs = $envelope.declinedAtMs }
        } else { exit 1 }
    }
    if ([string]::IsNullOrEmpty($promptText)) { exit 1 }
    @{ at = [DateTime]::UtcNow.ToString('o'); status = 'preparing_recovery'; submitted = $false } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'recovery-status.json') -Encoding utf8
    try {
        # Current callers already captured a target while the card was open.
        # Only legacy callers need to load UI Automation in this bridge too.
        if (-not $bindingProvided) {
            Import-Module (Join-Path $PSScriptRoot 'LocalRecovery.psm1') -Force -DisableNameChecking
            $binding = Get-RecoveryBinding $promptText
        }
        if ($null -eq $binding) { throw 'no_captured_target' }
        $requestObject = @{ prompt = $promptText; binding = $binding; declined = $true; startedAtMs = $recoveryStartedAtMs }
        foreach ($key in $options.Keys) { $requestObject[$key] = $options[$key] }
        $request = $requestObject | ConvertTo-Json -Compress -Depth 6
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = Join-Path $PSHOME 'pwsh.exe'
        foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', (Join-Path $PSScriptRoot 'Restore-PendingPrompt.ps1'))) { $start.ArgumentList.Add($argument) }
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $start.RedirectStandardInput = $true
        $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
        $child = [Diagnostics.Process]::Start($start)
        $child.StandardInput.Write($request)
        $child.StandardInput.Close()
        $child.Dispose()
    } catch {
        $message = $_.Exception.Message
        $code = if ($message -match '^[a-z_]+$') { $message } else { 'accessibility_error' }
        @{ at = [DateTime]::UtcNow.ToString('o'); status = $code; submitted = $false } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'recovery-status.json') -Encoding utf8
        exit 1
    }
    # Legacy filename retained for existing MCP processes. This bridge never
    # reads or writes the clipboard: the worker receives text through stdin
    # and restores the editor directly with UI Automation's ValuePattern.
    exit 0
} catch { exit 1 }
