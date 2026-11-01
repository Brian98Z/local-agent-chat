param(
    [string]$Store = (Join-Path (Split-Path $PSScriptRoot -Parent) 'local-agent-chat-hot'),
    [string]$DataDir = (Join-Path $PSScriptRoot 'data-hot'),
    [ValidateRange(0, 65535)][int]$Port = 4317
)
$ErrorActionPreference = 'Stop'
try {
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    $Store = [IO.Path]::GetFullPath($Store)
    $DataDir = [IO.Path]::GetFullPath($DataDir)
    # Run visibly. Do not hide script execution or change execution policy.
    & $node (Join-Path $PSScriptRoot 'hot-launcher.mjs') start --store $Store --data-dir $DataDir --port $Port
    if ($LASTEXITCODE -ne 0) { throw 'Controlled startup failed; see the console output.' }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
