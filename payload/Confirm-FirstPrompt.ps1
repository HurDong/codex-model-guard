param([string]$StateRoot = (Join-Path $PSScriptRoot 'state'))

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$mutex = $null
$locked = $false
try {
    $event = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if (-not $event.session_id) { throw 'Missing session_id.' }
    if ($event.hook_event_name -notin @('SessionStart', 'UserPromptSubmit')) { exit 0 }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $key = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$event.session_id)))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
    $mutex = [Threading.Mutex]::new($false, ('Local\CodexFirstPrompt-' + $key))
    try { $locked = $mutex.WaitOne(3000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Timed out waiting for first-prompt state.' }
    [IO.Directory]::CreateDirectory($StateRoot) | Out-Null
    $statePath = Join-Path $StateRoot ($key + '.txt')

    if ($event.hook_event_name -eq 'SessionStart') {
        # Only genuinely new sessions are armed. Resume/fork/compact stay untouched.
        if ($event.source -eq 'startup' -and -not [IO.File]::Exists($statePath)) {
            [IO.File]::WriteAllText($statePath, 'armed', [Text.UTF8Encoding]::new($false))
        }
        exit 0
    }

    # Existing sessions with no startup marker are not interrupted.
    if (-not [IO.File]::Exists($statePath)) { exit 0 }
    if ([IO.File]::ReadAllText($statePath).Trim() -ne 'armed') { exit 0 }
    # The next submission counts as acknowledgement; this does not validate effort.
    [IO.File]::WriteAllText($statePath, 'warned', [Text.UTF8Encoding]::new($false))
    $reason = '첫 요청 전 설정 확인: 모델과 추론 강도(effort)가 원하는 값인지 입력창 아래에서 확인해 주세요. 확인·변경한 후 같은 질문을 다시 전송하면 시작합니다. 이 채팅에서는 다시 묻지 않습니다.'
    @{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress
} catch {
    [Console]::Error.WriteLine('First-prompt hook error: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($null -ne $mutex) { $mutex.Dispose() }
}
