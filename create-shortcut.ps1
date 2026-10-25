$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$exe = Join-Path $root 'LocalAgentChat.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Build LocalAgentChat.exe first.' }
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$name = 'Agent ' + [string][char]0x672C + [char]0x5730 + [char]0x804A + [char]0x5929 + [char]0x5BA4
$path = Join-Path $desktop ($name + '.lnk')
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($path)
if ((Test-Path -LiteralPath $path) -and $link.TargetPath -ne $exe) {
    throw 'An unrelated shortcut already uses this name; not overwriting it.'
}
$link.TargetPath = $exe
$link.WorkingDirectory = $root
$link.Arguments = ''
$link.IconLocation = (Join-Path $root 'chat-icon.ico') + ',0'
$link.Description = 'Local Agent Chat - native group chat and admission'
$link.WindowStyle = 1
$link.Save()
$verify = $shell.CreateShortcut($path)
if ($verify.TargetPath -ne $exe -or $verify.WorkingDirectory -ne $root -or $verify.IconLocation -ne ((Join-Path $root 'chat-icon.ico') + ',0')) {
    throw 'Shortcut readback verification failed.'
}
[pscustomobject]@{ Shortcut = $path; Target = $verify.TargetPath; WorkingDirectory = $verify.WorkingDirectory; Icon = $verify.IconLocation; Arguments = $verify.Arguments } | ConvertTo-Json
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($verify)
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
