$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$tsxCli = Join-Path $projectRoot "node_modules\tsx\dist\cli.mjs"
$nodeCommand = Get-Command node.exe -ErrorAction Stop

if (-not (Test-Path -LiteralPath $tsxCli)) {
  throw "Dependências ausentes. Execute npm install em $projectRoot"
}

Push-Location $projectRoot
try {
  & $nodeCommand.Source $tsxCli "scripts\run-local-syncs.ts"
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}

