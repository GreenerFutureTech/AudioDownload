$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskExtension = Join-Path $taskRoot 'extension'
$taskArtifacts = Join-Path $taskRoot 'artifacts'
New-Item -ItemType Directory -Path $taskArtifacts -Force | Out-Null
$taskVersion = (Get-Content -LiteralPath (Join-Path $taskExtension 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$taskZip = Join-Path $taskArtifacts "AudioDownload-$taskVersion.zip"
Compress-Archive -Path (Join-Path $taskExtension '*') -DestinationPath $taskZip -Force
Write-Output "Packaged extension: $taskZip"
