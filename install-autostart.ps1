# Per-user Windows sign-in startup. No administrator rights or visible console.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$launcher = Join-Path $root 'start-hidden.vbs'
if (-not (Test-Path -LiteralPath $launcher)) { throw 'Gateway launcher missing' }
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$command = '"' + (Join-Path $env:SystemRoot 'System32\wscript.exe') + '" //B "' + $launcher + '"'
New-Item -Path $registry -Force | Out-Null
New-ItemProperty -Path $registry -Name 'ChatGPTWebGateway' -Value $command -PropertyType String -Force | Out-Null
Write-Output 'STARTUP_REGISTERED=HKCU'
Write-Output ('STARTUP_VALUE=' + (Get-ItemPropertyValue -Path $registry -Name 'ChatGPTWebGateway'))
