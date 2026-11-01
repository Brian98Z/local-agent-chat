param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ClientProcessId
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$p = Get-Process -Id $ClientProcessId
$deadline = [DateTime]::UtcNow.AddSeconds(30)
$connected = $false
# Exact accessible label, represented without an encoding-dependent script literal.
$label = [string][char]0x25CF + '  ' + [char]0x672C + [char]0x673A + [char]0x5DF2 + [char]0x8FDE + [char]0x63A5
while ([DateTime]::UtcNow -lt $deadline) {
    $p.Refresh()
    if ($p.HasExited) { throw 'Native client exited before readiness.' }
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $pidCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ClientProcessId)
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCondition)
    foreach ($window in $windows) {
        $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $label)
        if ($window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
            $connected = $true
            break
        }
    }
    if ($connected) { break }
    Start-Sleep -Milliseconds 200
}
if (-not $connected) { throw 'Native client readiness timed out.' }
if (-not $p.CloseMainWindow()) { throw 'Could not close native client window.' }
if (-not $p.WaitForExit(15000)) { throw 'Native client did not exit.' }
