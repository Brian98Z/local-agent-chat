[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$ControlledUpdates,
    [string]$Store = (Join-Path (Split-Path $PSScriptRoot -Parent) 'local-agent-chat-hot'),
    [string]$DataDir = (Join-Path $PSScriptRoot 'data-hot'),
    [ValidateRange(0, 65535)][int]$Port = 4317,
    [string]$ShortcutDirectory = [Environment]::GetFolderPath('DesktopDirectory')
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$arguments = ''
$exe = Join-Path $root 'LocalAgentChat.exe'
$name = 'Agent ' + [string][char]0x672C + [char]0x5730 + [char]0x804A + [char]0x5929 + [char]0x5BA4
if ($ControlledUpdates) {
    $exe = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    $entry = Join-Path $root 'hot-launcher.mjs'
    if (-not (Test-Path -LiteralPath $entry)) { throw 'Missing hot-launcher.mjs.' }
    $Store = [IO.Path]::GetFullPath($Store)
    $DataDir = [IO.Path]::GetFullPath($DataDir)
    foreach ($value in @($entry, $Store, $DataDir)) {
        if ($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n")) { throw 'Paths cannot contain quotes or newlines.' }
    }
    $quote = { param([string]$Value) '"' + [regex]::Replace($Value, '(\\+)$', '$1$1') + '"' }
    $arguments = (& $quote $entry) + ' start --store ' + (& $quote $Store) + ' --data-dir ' + (& $quote $DataDir) + ' --port ' + $Port
    $name += ' - Controlled Updates'
} elseif (-not (Test-Path -LiteralPath $exe)) { throw 'Build LocalAgentChat.exe first.' }
if (-not (Test-Path -LiteralPath $ShortcutDirectory -PathType Container)) { throw 'ShortcutDirectory must already exist.' }
$path = Join-Path $ShortcutDirectory ($name + '.lnk')
if ($ControlledUpdates -and (Test-Path -LiteralPath $path)) { throw 'Controlled shortcut already exists; refusing to change an existing shortcut.' }
if (-not $PSCmdlet.ShouldProcess($path, 'Create visible application shortcut')) {
    [pscustomobject]@{ Shortcut = $path; Target = $exe; WorkingDirectory = $root; Arguments = $arguments; WindowStyle = 1 }
    return
}
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($path)
if ((Test-Path -LiteralPath $path) -and $link.TargetPath -ne $exe) {
    throw 'An unrelated shortcut already uses this name; not overwriting it.'
}
$link.TargetPath = $exe
$link.WorkingDirectory = $root
$link.Arguments = $arguments
$link.IconLocation = (Join-Path $root 'chat-icon.ico') + ',0'
$link.Description = if ($ControlledUpdates) { 'Local Agent Chat - controlled native updates' } else { 'Local Agent Chat - native group chat and admission' }
$link.WindowStyle = 1
$link.Save()
$verify = $shell.CreateShortcut($path)
if ($verify.TargetPath -ne $exe -or $verify.Arguments -ne $arguments -or $verify.WorkingDirectory -ne $root -or $verify.IconLocation -ne ((Join-Path $root 'chat-icon.ico') + ',0') -or $verify.WindowStyle -ne $link.WindowStyle) {
    throw 'Shortcut readback verification failed.'
}
[pscustomobject]@{ Shortcut = $path; Target = $verify.TargetPath; WorkingDirectory = $verify.WorkingDirectory; Icon = $verify.IconLocation; Arguments = $verify.Arguments } | ConvertTo-Json
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($verify)
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
