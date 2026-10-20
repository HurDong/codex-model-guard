# Local Windows accessibility only: no screenshots, model calls, key injection,
# application patches or security-setting changes. Submission requires an
# explicit model/effort selection plus an exact, one-use prompt grant.
Set-StrictMode -Version Latest
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
if (-not ('CodexRecoveryForeground' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodexRecoveryForeground {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
}

function Normalize-RecoveryText([string]$Text) {
    return $Text.Replace("`r`n", "`n").Replace("`r", "`n").TrimEnd("`n")
}

function Get-RecoveryElements($Root, $Type) {
    return $Root.FindAll([Windows.Automation.TreeScope]::Descendants,
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $Type))
}

function Get-RecoveryValue($Element) {
    $pattern = $null
    if (-not $Element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { throw 'value_pattern_unavailable' }
    return [string]$pattern.Current.Value
}

function Get-RecoveryView([long]$WindowId = 0, [bool]$AllowMissingComposer = $false) {
    $foregroundId = [CodexRecoveryForeground]::GetForegroundWindow().ToInt64()
    if ($WindowId -eq 0) { $WindowId = $foregroundId }
    if ($foregroundId -ne $WindowId) { throw 'focus_changed' }
    $root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowId)
    $processInfo = Get-Process -Id $root.Current.ProcessId
    if ($processInfo.Path -notmatch '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$') { throw 'other_app' }
    $documents = @(Get-RecoveryElements $root ([Windows.Automation.ControlType]::Document) | Where-Object { $_.Current.AutomationId -eq 'RootWebArea' })
    if ($documents.Count -ne 1) { throw 'ambiguous_document' }
    $document = $documents[0]
    $buttons = @(Get-RecoveryElements $document ([Windows.Automation.ControlType]::Button))
    $headers = @($buttons | Where-Object { $_.Current.Name -in @('채팅 액션', 'Chat actions') })
    if ($headers.Count -ne 1 -or -not $headers[0].Current.AutomationId) { throw 'missing_chat_identity' }
    $editors = @(Get-RecoveryElements $document ([Windows.Automation.ControlType]::Edit) | Where-Object {
        $_.Current.Name -match '^(Codex와 함께 작업하세요|Ask Codex|Work with Codex|Message Codex|Ask anything)' -and -not $_.Current.IsOffscreen
    })
    if ($editors.Count -gt 1 -or ($editors.Count -eq 0 -and -not $AllowMissingComposer)) { throw 'ambiguous_composer' }
    return @{
        WindowId = $WindowId; ProcessId = $root.Current.ProcessId; Root = $root; Document = $document
        DocumentName = $document.Current.Name; HeaderId = $headers[0].Current.AutomationId
        Composer = $(if ($editors.Count -eq 1) { $editors[0] } else { $null }); Buttons = $buttons
    }
}

function Get-RecoveryBinding([string]$Prompt) {
    $view = Get-RecoveryView -AllowMissingComposer $true
    # Rendering removes Markdown delimiters and trailing whitespace. Bind the
    # view now, then verify the last message's raw editor value after blocking.
    return @{
        windowId = $view.WindowId; processId = $view.ProcessId
        documentName = $view.DocumentName; headerId = $view.HeaderId
    }
}

function Assert-RecoveryView($Binding, [bool]$AllowMissingComposer = $false) {
    $view = Get-RecoveryView $Binding.windowId $AllowMissingComposer
    if ($view.ProcessId -ne $Binding.processId) { throw 'chat_changed_process' }
    if ($view.DocumentName -cne $Binding.documentName) { throw 'chat_changed_document' }
    if ($view.HeaderId -cne $Binding.headerId) { throw 'chat_changed_header' }
    return $view
}

function Get-RecoveryAdmissionView($Binding) {
    # First-message admission may replace the page title and React header.
    # Preserve the actual foreground window/process, then authenticate the
    # last raw user message before freezing the final page identity.
    $view = Get-RecoveryView $Binding.windowId $true
    if ($view.ProcessId -ne $Binding.processId) { throw 'chat_changed_process' }
    return $view
}

function Test-RecoveryControlFocused($Element) {
    $focused = [Windows.Automation.AutomationElement]::FocusedElement
    return $null -ne $focused -and [Windows.Automation.Automation]::Compare($Element, $focused)
}

function Set-RecoveryConfirmationFocus($Binding, [string]$Title = '시작 설정', [int]$WaitMilliseconds = 600) {
    # Native Esc handling is inside the card, while Ctrl+Enter also has a
    # global shortcut. Put focus inside this specific confirmation so native
    # Escape reaches its cancel handler. No global key hook or key injection.
    $deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMilliseconds)
    do {
        $view = Get-RecoveryAdmissionView $Binding
        $titles = @(Get-RecoveryElements $view.Document ([Windows.Automation.ControlType]::Text) | Where-Object {
            -not $_.Current.IsOffscreen -and $_.Current.Name.Trim() -match ('^' + [regex]::Escape($Title) + '(?:\s|$)')
        })
        $decline = @($view.Buttons | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.IsEnabled -and $_.Current.Name -match '^(거절|거부|Decline)(\s|$)' })
        $accept = @($view.Buttons | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.IsEnabled -and $_.Current.Name -match '^(수락|승인|Accept)(\s|$)' })
        if ($titles.Count -gt 0 -and $decline.Count -eq 1 -and $accept.Count -eq 1) {
            # Recheck foreground/process immediately before moving focus.
            $null = Get-RecoveryAdmissionView $Binding
            $decline[0].SetFocus()
            if (Test-RecoveryControlFocused $decline[0]) { return $true }
        }
        if ([DateTime]::UtcNow -ge $deadline) { return $false }
        Start-Sleep -Milliseconds 80
    } while ($true)
}

function Expand-RecoveryControl($Element) {
    if (-not $Element.Current.IsEnabled -or $Element.Current.IsOffscreen) { throw 'control_not_available' }
    $pattern = $null
    if ($Element.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
        $pattern.Expand()
    } elseif ($Element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke()
    } elseif ($Element.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        $pattern.Select()
    } else { throw 'control_pattern_unavailable' }
}

function Get-RecoveryModelItems($Root) {
    # Current native picker exposes menuitemradio as RadioButton, not MenuItem.
    foreach ($type in @([Windows.Automation.ControlType]::MenuItem, [Windows.Automation.ControlType]::RadioButton)) {
        Get-RecoveryElements $Root $type | Where-Object {
            -not $_.Current.IsOffscreen -and $_.Current.Name -match '^GPT[-\s]'
        }
    }
}

function Test-RecoveryAttachmentEvidence($ImageNames, $ButtonNames, [string]$Text = '') {
    # Images also represent ordinary editor/file/skill icons. Only explicit
    # attachment labels or the client's structured file context are evidence.
    if ($Text -match '(?m)^# Files (mentioned|pasted) by the user:|^Image attachment: true|^<image\s+(name|path)=') { return $true }
    foreach ($name in $ButtonNames) {
        if ($name -match '(?i)^(remove|delete)\s+(attachment|file|image)(\s|$)|^(첨부\s*(파일|이미지|항목)?|파일|이미지).*(제거|삭제)$') { return $true }
    }
    foreach ($name in $ImageNames) {
        if ($name -match '(?i)^(user uploaded image|uploaded image|attached image|image attachment|첨부\s*이미지|업로드한\s*이미지)(\s|$)|\.(png|jpe?g|gif|webp|bmp|pdf|docx?|xlsx?|pptx?|zip)$') { return $true }
    }
    return $false
}

function Test-RecoverySourceAttachments($View, $Editor, [string]$Text = '') {
    $parent = $Editor
    for ($depth = 0; $depth -lt 7; $depth++) {
        $parent = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)
        if ($null -eq $parent -or [Windows.Automation.Automation]::Compare($parent, $View.Document)) { break }
        $buttons = @(Get-RecoveryElements $parent ([Windows.Automation.ControlType]::Button))
        $cancel = @($buttons | Where-Object { $_.Current.Name -in @('취소','Cancel') })
        if ($cancel.Count -eq 1) {
            $images = @(Get-RecoveryElements $parent ([Windows.Automation.ControlType]::Image) | Where-Object { -not $_.Current.IsOffscreen })
            return Test-RecoveryAttachmentEvidence @($images | ForEach-Object { $_.Current.Name }) @($buttons | ForEach-Object { $_.Current.Name }) $Text
        }
    }
    throw 'source_attachments_not_verifiable'
}

function Confirm-RecoverySource($Binding, [string]$Expected, [bool]$RejectAttachments = $false) {
    $script:RecoveryStage = 'source_verification'
    $view = Assert-RecoveryView $Binding
    $editing = @(Get-RecoveryElements $view.Document ([Windows.Automation.ControlType]::Edit) | Where-Object { $_.Current.Name -in @('메시지 수정', 'Edit message') })
    if ($editing.Count -gt 0) { throw 'existing_message_edit_preserved' }
    $edits = @($view.Buttons | Where-Object { $_.Current.Name -in @('메시지 편집', 'Edit message') -and -not $_.Current.IsOffscreen })
    if ($edits.Count -eq 0) { throw 'source_message_edit_unavailable' }
    # The last user message must match exactly. Never search older messages
    # or trust a rendered occurrence inside an assistant/tool response.
    $null = Assert-RecoveryView $Binding
    Expand-RecoveryControl $edits[-1]
    $script:RecoveryStage = 'source_editor'
    $opened = $true
    $verified = $false
    $hasAttachments = $false
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(3)
        do {
            $view = Assert-RecoveryView $Binding
            $editing = @(Get-RecoveryElements $view.Document ([Windows.Automation.ControlType]::Edit) | Where-Object { $_.Current.Name -in @('메시지 수정', 'Edit message') })
            if ($editing.Count -eq 1) {
                $verified = (Normalize-RecoveryText (Get-RecoveryValue $editing[0])) -ceq $Expected
                if ($verified -and $RejectAttachments) {
                    $script:RecoveryStage = 'source_attachment_check'
                    $hasAttachments = Test-RecoverySourceAttachments $view $editing[0] $Expected
                    if ($hasAttachments) { throw 'attachments_preserved_use_original_edit' }
                }
                break
            }
            if ([DateTime]::UtcNow -ge $deadline) { throw 'source_verification_not_ready' }
            Start-Sleep -Milliseconds 100
        } while ($true)
    } catch {
        $_.Exception.Data['recoveryStage'] = $script:RecoveryStage
        throw
    } finally {
        if ($opened) {
            $script:RecoveryStage = 'source_cancel'
            $view = Assert-RecoveryView $Binding
            $cancel = @($view.Buttons | Where-Object { $_.Current.Name -in @('취소', 'Cancel') -and -not $_.Current.IsOffscreen })
            if ($cancel.Count -ne 1) { throw 'source_edit_cancel_ambiguous' }
            Expand-RecoveryControl $cancel[0]
            $deadline = [DateTime]::UtcNow.AddSeconds(2)
            do {
                $view = Assert-RecoveryView $Binding
                $editing = @(Get-RecoveryElements $view.Document ([Windows.Automation.ControlType]::Edit) | Where-Object { $_.Current.Name -in @('메시지 수정', 'Edit message') })
                if ($editing.Count -eq 0) { break }
                if ([DateTime]::UtcNow -ge $deadline) { throw 'source_edit_cancel_not_confirmed' }
                Start-Sleep -Milliseconds 100
            } while ($true)
        }
    }
    if (-not $verified) { throw 'latest_message_different' }
}

function Get-RecoveryModelButton($View) {
    $buttons = @($View.Buttons | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.Name -match '^(GPT[-\s]|추론 수준 선택$|Select reasoning)' })
    if ($buttons.Count -ne 1) { throw 'model_button_ambiguous' }
    return $buttons[0]
}

function Test-RecoveryModelName([string]$Label, [string]$Model) {
    if ($Model -notmatch '^gpt-(\d+(?:\.\d+)?)-([a-z0-9-]+)$') { return $false }
    $version = [regex]::Escape($Matches[1])
    $family = [regex]::Escape($Matches[2]).Replace('\-', '[-\s]+')
    return $Label -match ('(?i)^GPT[-\s]*' + $version + '[-\s]+' + $family + '(?=\s|$)')
}

function Get-RecoveryEffortName([string]$Label) {
    $names = [ordered]@{
        ultra = 'Ultra|울트라'; persistent = 'Persistent'; max = 'Max|Maximum|최대'
        xhigh = 'Extra\s*High|XHigh|매우\s*높음'; high = 'High|Extended|높음'
        medium = 'Medium|Standard|보통|중간'; low = 'Low|Light|낮음|가벼움'
        minimal = 'Minimal|최소'; none = 'None|없음'
    }
    foreach ($entry in $names.GetEnumerator()) {
        if ($Label -match ('(?i)(?:^|\s)(' + $entry.Value + ')\s*$')) { return $entry.Key }
    }
    return ''
}

function Set-RecoveryDraft($Binding, [string]$Text) {
    $view = Assert-RecoveryView $Binding
    $pattern = $null
    if (-not $view.Composer.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -or $pattern.Current.IsReadOnly) { throw 'composer_not_editable' }
    $pattern.SetValue($Text)
    try {
        $view.Composer.SetFocus()
        $textPattern = $null
        if ($view.Composer.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
            $range = $textPattern.DocumentRange.Clone()
            $range.MoveEndpointByRange([Windows.Automation.TextPatternRangeEndpoint]::Start, $range, [Windows.Automation.TextPatternRangeEndpoint]::End)
            $range.Select()
        }
    } catch { } # Optional caret positioning may reference a replaced text range.
}

function Get-RecoveryChoiceItems($Root) {
    foreach ($type in @([Windows.Automation.ControlType]::MenuItem, [Windows.Automation.ControlType]::ListItem, [Windows.Automation.ControlType]::RadioButton)) {
        $items = @(Get-RecoveryElements $Root $type | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.IsEnabled })
        if ($items.Count) { $items }
    }
}

function Get-RecoveryChoiceEffort([string]$Label) {
    foreach ($pair in @(@('xhigh','Extra\s*High|XHigh|매우\s*높음'),@('ultra','Ultra|울트라'),@('max','Max|최대'),@('high','High|Extended|높음'),@('medium','Medium|Standard|보통|중간'),@('low','Low|Light|낮음'),@('minimal','Minimal|최소'),@('none','None|없음'))) {
        if ($Label -match ('(?i)^('+$pair[1]+')(\s|$)')) { return $pair[0] }
    }
    return Get-RecoveryEffortName $Label
}

function Set-RecoverySelectedSettings($Binding, $Selection, [string]$Expected) {
    if ($Selection.model -notmatch '^gpt-[a-zA-Z0-9.:-]+$' -or $Selection.effort -notmatch '^[a-zA-Z0-9_-]+$') { throw 'invalid_settings_selection' }
    $script:RecoveryStage = 'applying_selected_model'
    $view = Assert-RecoveryView $Binding
    if ((Normalize-RecoveryText (Get-RecoveryValue $view.Composer)) -cne (Normalize-RecoveryText $Expected)) { throw 'draft_changed_during_settings' }
    $button = Get-RecoveryModelButton $view
    if (-not (Test-RecoveryModelName $button.Current.Name $Selection.model)) {
        if (@(Get-RecoveryModelItems $view.Root).Count -lt 2) { Expand-RecoveryControl $button }
        $deadline = [DateTime]::UtcNow.AddSeconds(4)
        do {
            $view = Assert-RecoveryView $Binding
            $items = @(Get-RecoveryModelItems $view.Root)
            $match = @($items | Where-Object { Test-RecoveryModelName $_.Current.Name $Selection.model })
            if ($match.Count -eq 1) { $null = Assert-RecoveryView $Binding; Expand-RecoveryControl $match[0]; break }
            if ($match.Count -gt 1) { throw 'selected_model_ambiguous' }
            $choose = @(Get-RecoveryElements $view.Root ([Windows.Automation.ControlType]::MenuItem) | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.Name -in @('모델 선택','Select model','Choose model') })
            if ($choose.Count -eq 1) { Expand-RecoveryControl $choose[0] }
            if ([DateTime]::UtcNow -ge $deadline) { throw 'selected_model_unavailable' }
            Start-Sleep -Milliseconds 80
        } while ($true)
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
        $view = Assert-RecoveryView $Binding
        $button = Get-RecoveryModelButton $view
        if (Test-RecoveryModelName $button.Current.Name $Selection.model) { break }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'selected_model_not_applied' }
        Start-Sleep -Milliseconds 80
    } while ($true)
    $script:RecoveryStage = 'applying_selected_effort'
    if ((Get-RecoveryEffortName $button.Current.Name) -ne $Selection.effort) {
        # /reasoning is a native composer command with explicit choices. It
        # avoids guessing numeric slider positions or silently clamping Ultra.
        $null = Assert-RecoveryView $Binding
        if ((Normalize-RecoveryText (Get-RecoveryValue $view.Composer)) -cne (Normalize-RecoveryText $Expected)) { throw 'draft_changed_during_settings' }
        $visibleMenus = @(Get-RecoveryElements $view.Document ([Windows.Automation.ControlType]::Menu) | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.Name -match '^GPT[-\s]' })
        if ($visibleMenus.Count) {
            $view = Assert-RecoveryView $Binding
            $button = Get-RecoveryModelButton $view
            $collapse = $null
            if ($button.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$collapse)) {
                if ($collapse.Current.ExpandCollapseState -eq [Windows.Automation.ExpandCollapseState]::Expanded) { $collapse.Collapse() }
            }
            else { Expand-RecoveryControl $button }
            $view = Assert-RecoveryView $Binding
        }
        $view.Composer.SetFocus()
        Set-RecoveryDraft $Binding '/reasoning '
        try {
            $deadline = [DateTime]::UtcNow.AddSeconds(4)
            do {
                $view = Assert-RecoveryView $Binding
                $current = Normalize-RecoveryText (Get-RecoveryValue $view.Composer)
                if ($current -notin @('/reasoning ', '/reasoning', '')) { throw 'draft_changed_during_settings' }
                $items = @(Get-RecoveryChoiceItems $view.Root)
                $matches = @($items | Where-Object { (Get-RecoveryChoiceEffort $_.Current.Name) -eq $Selection.effort })
                if ($matches.Count -eq 1) { $null = Assert-RecoveryView $Binding; Expand-RecoveryControl $matches[0]; break }
                if ($matches.Count -gt 1) { throw 'selected_effort_ambiguous' }
                if ([DateTime]::UtcNow -ge $deadline) { throw 'selected_effort_unavailable' }
                Start-Sleep -Milliseconds 80
            } while ($true)
            $deadline = [DateTime]::UtcNow.AddSeconds(3)
            do {
                $view = Assert-RecoveryView $Binding
                $button = Get-RecoveryModelButton $view
                if ((Test-RecoveryModelName $button.Current.Name $Selection.model) -and (Get-RecoveryEffortName $button.Current.Name) -eq $Selection.effort) { break }
                if ([DateTime]::UtcNow -ge $deadline) { throw 'selected_effort_not_applied' }
                Start-Sleep -Milliseconds 80
            } while ($true)
        } finally {
            # Restore only our own temporary command; never replace a new draft.
            $view = Assert-RecoveryView $Binding
            if ((Get-RecoveryValue $view.Composer) -in @('/reasoning ', '/reasoning', '')) { Set-RecoveryDraft $Binding $Expected }
        }
    }
    $view = Assert-RecoveryView $Binding
    if (@($view.Buttons | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.Name -in @('중지','Stop') }).Count) { throw 'chat_became_busy_before_send' }
    if ((Normalize-RecoveryText (Get-RecoveryValue $view.Composer)) -cne (Normalize-RecoveryText $Expected)) { throw 'draft_changed_during_settings' }
    $button = Get-RecoveryModelButton $view
    if (-not (Test-RecoveryModelName $button.Current.Name $Selection.model) -or (Get-RecoveryEffortName $button.Current.Name) -ne $Selection.effort) { throw 'settings_not_verified' }
    # Restore focus, which also dismisses composer slash-command suggestions.
    $view.Composer.SetFocus()
}

function Send-RecoverySelectedPrompt($Binding, $Request) {
    $script:RecoveryStage = 'verifying_before_send'
    $view = Assert-RecoveryView $Binding
    if ((Normalize-RecoveryText (Get-RecoveryValue $view.Composer)) -cne (Normalize-RecoveryText $Request.prompt)) { throw 'draft_changed_before_send' }
    $button = Get-RecoveryModelButton $view
    if (-not (Test-RecoveryModelName $button.Current.Name $Request.selection.model) -or (Get-RecoveryEffortName $button.Current.Name) -ne $Request.selection.effort) { throw 'settings_changed_before_send' }
    $send = @($view.Buttons | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.IsEnabled -and $_.Current.Name -in @('보내기','전송','메시지 보내기','프롬프트 보내기','Send','Send message') })
    if ($send.Count -ne 1) { throw 'send_button_ambiguous' }
    $grant = $Request.grant
    if ($null -eq $grant -or $grant.model -cne $Request.selection.model -or $grant.effort -cne $Request.selection.effort) { throw 'send_grant_missing' }
    $stateRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'state'))
    $grantPath = [IO.Path]::GetFullPath([string]$grant.path)
    if ([IO.Path]::GetDirectoryName($grantPath) -cne $stateRoot -or [IO.Path]::GetFileName($grantPath) -notmatch '^[a-f0-9]{64}\.txt$') { throw 'invalid_send_grant_path' }
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes((Normalize-RecoveryText $Request.prompt)))).ToLowerInvariant()
    if ($grant.promptHash -cne $hash -or [IO.File]::ReadAllText($grantPath).Trim() -cne 'armed') { throw 'send_grant_does_not_match' }
    $token = @{kind='selected-submit';model=$grant.model;effort=$grant.effort;promptHash=$hash;expiresAt=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+15000)} | ConvertTo-Json -Compress
    $null = Assert-RecoveryView $Binding
    [IO.File]::WriteAllText($grantPath, $token, [Text.UTF8Encoding]::new($false))
    $attempted = $false
    try {
        $view = Assert-RecoveryView $Binding
        if ((Normalize-RecoveryText (Get-RecoveryValue $view.Composer)) -cne (Normalize-RecoveryText $Request.prompt)) { throw 'draft_changed_before_send' }
        $currentButton = Get-RecoveryModelButton $view
        if (-not (Test-RecoveryModelName $currentButton.Current.Name $Request.selection.model) -or (Get-RecoveryEffortName $currentButton.Current.Name) -ne $Request.selection.effort) { throw 'settings_changed_before_send' }
        if (@($view.Buttons | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.Name -in @('중지','Stop') }).Count) { throw 'chat_became_busy_before_send' }
        $send = @($view.Buttons | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.IsEnabled -and $_.Current.Name -in @('보내기','전송','메시지 보내기','프롬프트 보내기','Send','Send message') })
        if ($send.Count -ne 1) { throw 'send_button_ambiguous' }
        $script:RecoveryStage = 'sending_selected_prompt'
        $attempted = $true
        Expand-RecoveryControl $send[0]
        $deadline = [DateTime]::UtcNow.AddSeconds(3)
        do {
            $view = Assert-RecoveryView $Binding
            $current = Get-RecoveryValue $view.Composer
            $busy = @($view.Buttons | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.Name -in @('중지','Stop') }).Count -gt 0
            if ($busy -or [string]::IsNullOrWhiteSpace($current) -or $current -ceq $view.Composer.Current.Name) {
                return @{status='selected_settings_submitted';promptRestored=$true;model=$Request.selection.model;effort=$Request.selection.effort;submitted=$true}
            }
            if ([DateTime]::UtcNow -ge $deadline) { throw 'submission_not_confirmed_do_not_retry' }
            Start-Sleep -Milliseconds 80
        } while ($true)
    } catch {
        if ($attempted) { $_.Exception.Data['submitted'] = 'unknown' }
        throw
    } finally {
        # The editor may clear before the new hook reads the grant. Keep an
        # attempted send's token until consumed (once) or its 15-second expiry.
        if (-not $attempted -and [IO.File]::ReadAllText($grantPath) -ceq $token) { [IO.File]::WriteAllText($grantPath, 'armed', [Text.UTF8Encoding]::new($false)) }
    }
}

function Invoke-LocalRecovery($Request, [bool]$RequireBlocked = $true, [int]$WaitMilliseconds = 10000) {
    $script:RecoveryStage = 'waiting_for_composer'
    $promptText = [string]$Request.prompt
    if ([string]::IsNullOrEmpty($promptText)) { throw 'empty_prompt' }
    if ($RequireBlocked -and $Request.declined -ne $true) { throw 'decline_required' }
    $expected = Normalize-RecoveryText $promptText
    $binding = $Request.binding
    $mutex = [Threading.Mutex]::new($false, ('Local\CodexPromptRecovery-' + $binding.windowId))
    $locked = $false
    try {
        $locked = $mutex.WaitOne(0)
        if (-not $locked) { throw 'recovery_already_running' }
        $deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMilliseconds)
        do {
            $view = Get-RecoveryAdmissionView $binding
            if ($null -eq $view.Composer) {
                if ([DateTime]::UtcNow -ge $deadline) { throw 'blocked_message_not_ready' }
                Start-Sleep -Milliseconds 150
                continue
            }
            $current = Normalize-RecoveryText (Get-RecoveryValue $view.Composer)
            # The placeholder is exposed as Value on some empty Electron editors.
            $isEmpty = [string]::IsNullOrWhiteSpace($current) -or $current -ceq $view.Composer.Current.Name
            if (-not $isEmpty -and $current -cne $expected) { throw 'existing_draft_preserved' }
            $busy = @($view.Buttons | Where-Object { $_.Current.Name -in @('중지', 'Stop') -and -not $_.Current.IsOffscreen }).Count -gt 0
            $sourceReady = @($view.Buttons | Where-Object { $_.Current.Name -in @('메시지 편집', 'Edit message') -and -not $_.Current.IsOffscreen }).Count -gt 0
            # A declined MCP callback is the authority. Accessible warning text
            # is localized/aria-only and is not a reliable completion signal.
            if (-not $busy -and $sourceReady -and $view.Composer.Current.IsEnabled) { break }
            if ([DateTime]::UtcNow -ge $deadline) { throw 'blocked_message_not_ready' }
            Start-Sleep -Milliseconds 150
        } while ($true)

        $candidateBinding = @{
            windowId = $binding.windowId; processId = $binding.processId
            documentName = $view.DocumentName; headerId = $view.HeaderId
        }
        Confirm-RecoverySource $candidateBinding $expected ($Request.ContainsKey('selection'))
        $binding = $candidateBinding
        $script:RecoveryStage = 'restoring_composer'

        # Repeat binding/draft checks directly before mutation, including for
        # a second request or a user switching chats during hook completion.
        $view = Assert-RecoveryView $binding
        $current = Normalize-RecoveryText (Get-RecoveryValue $view.Composer)
        if (-not [string]::IsNullOrWhiteSpace($current) -and $current -cne $view.Composer.Current.Name -and $current -cne $expected) { throw 'existing_draft_preserved' }
        $pattern = $null
        if (-not $view.Composer.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -or $pattern.Current.IsReadOnly) { throw 'composer_not_editable' }
        if ($current -cne $expected) { $pattern.SetValue($promptText) }
        $deadline = [DateTime]::UtcNow.AddSeconds(3)
        do {
            $view = Assert-RecoveryView $binding
            if ((Normalize-RecoveryText (Get-RecoveryValue $view.Composer)) -ceq $expected) { break }
            if ([DateTime]::UtcNow -ge $deadline) { throw 'restoration_not_confirmed' }
            Start-Sleep -Milliseconds 100
        } while ($true)
        try {
            $view.Composer.SetFocus()
            $textPattern = $null
            if ($view.Composer.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
                $range = $textPattern.DocumentRange.Clone()
                $range.MoveEndpointByRange([Windows.Automation.TextPatternRangeEndpoint]::Start, $range, [Windows.Automation.TextPatternRangeEndpoint]::End)
                $range.Select()
            }
        } catch { } # Caret placement is optional; restored text was verified.
        if ($Request.ContainsKey('selection')) {
            Set-RecoverySelectedSettings $binding $Request.selection $promptText
            return Send-RecoverySelectedPrompt $binding $Request
        }
        if ($Request.ContainsKey('restoreOnly') -and $Request.restoreOnly) {
            return @{status='restored_without_sending';promptRestored=$true;submitted=$false}
        }
        if (@(Get-RecoveryModelItems $view.Root).Count -lt 2) {
            $script:RecoveryStage = 'opening_model_menu'
            $models = @($view.Buttons | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.Name -match '^(GPT[-\s]|추론 수준 선택$|Select reasoning)' })
            if ($models.Count -ne 1) { throw 'restored_but_model_button_ambiguous' }
            $null = Assert-RecoveryView $binding
            Expand-RecoveryControl $models[0]
            $deadline = [DateTime]::UtcNow.AddSeconds(4)
            $selected = $false
            do {
                $view = Assert-RecoveryView $binding
                if (@(Get-RecoveryModelItems $view.Root).Count -ge 2) { break }
                if (-not $selected) {
                    $choose = @(Get-RecoveryElements $view.Root ([Windows.Automation.ControlType]::MenuItem) | Where-Object {
                        -not $_.Current.IsOffscreen -and $_.Current.Name -in @('모델 선택', 'Select model', 'Choose model')
                    })
                    if ($choose.Count -eq 1) {
                        $null = Assert-RecoveryView $binding
                        Expand-RecoveryControl $choose[0]
                        $selected = $true
                    }
                }
                if ([DateTime]::UtcNow -ge $deadline) { throw 'restored_but_model_menu_not_confirmed' }
                Start-Sleep -Milliseconds 100
            } while ($true)
        }
        $view = Assert-RecoveryView $binding
        if ((Normalize-RecoveryText (Get-RecoveryValue $view.Composer)) -cne $expected) { throw 'draft_changed_during_recovery' }
        return @{ status = 'restored_model_menu_open'; promptRestored = $true; modelMenuOpen = $true; submitted = $false }
    } catch {
        if (-not $_.Exception.Data.Contains('recoveryStage')) { $_.Exception.Data['recoveryStage'] = $script:RecoveryStage }
        throw
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

Export-ModuleMember -Function Get-RecoveryBinding, Invoke-LocalRecovery, Get-RecoveryView, Get-RecoveryValue, Expand-RecoveryControl, Set-RecoveryConfirmationFocus
