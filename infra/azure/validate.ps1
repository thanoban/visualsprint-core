param([Parameter(Mandatory=$true)][string]$BicepPath)
$ErrorActionPreference = 'Stop'
$taskAzureRoot = $PSScriptRoot
$taskCompiler = (Resolve-Path -LiteralPath $BicepPath).Path
New-Item -ItemType Directory -Force -Path (Join-Path $taskAzureRoot 'out') | Out-Null
& $taskCompiler --version
Get-ChildItem -LiteralPath $taskAzureRoot -Filter '*.bicep' -Recurse | ForEach-Object {
  & $taskCompiler build $_.FullName --outfile (Join-Path $taskAzureRoot ('out/' + $_.BaseName + '.json'))
  if ($LASTEXITCODE -ne 0) { throw ('Bicep compilation failed: ' + $_.Name) }
}
& node --test (Join-Path $taskAzureRoot 'test/parameters.test.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Offline parameter tests failed' }
& node (Join-Path $taskAzureRoot 'validate-parameters.mjs') (Join-Path $taskAzureRoot 'parameters/staging.example.json')
if ($LASTEXITCODE -ne 0) { throw 'Example schema validation failed' }
Write-Output 'LOCAL_SOURCE_VALIDATION_COMPLETE_NO_DEPLOYMENT'
