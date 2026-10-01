# Valida o conjunto de artefatos de um candidato Electron já montado em $Dir.
# Usado pelos dois jobs de release-electron.yml (candidate e promote), para que o
# binário promovido passe exatamente pelos mesmos critérios do binário homologado.
# Não lê nem imprime secrets. Lança exceção em qualquer divergência.
param(
  [Parameter(Mandatory = $true)] [string] $Dir,
  [string] $Version = "1.0.12"
)

$ErrorActionPreference = "Stop"

$exeName = "Obaflix-Setup-$Version.exe"
$versaoRegex = [regex]::Escape($Version)
$exeRegex = [regex]::Escape($exeName)

$exe = Join-Path $Dir $exeName
$blockmap = "$exe.blockmap"
$latest = Join-Path $Dir "latest.yml"
$appUpdate = Join-Path $Dir "app-update.yml"

foreach ($arquivo in @($exe, $blockmap, $latest, $appUpdate)) {
  if (-not (Test-Path -LiteralPath $arquivo -PathType Leaf)) {
    throw "Artefato ausente: $arquivo"
  }
}

function Get-Info([string] $Caminho) {
  return [ordered]@{
    name   = [IO.Path]::GetFileName($Caminho)
    size   = (Get-Item -LiteralPath $Caminho).Length
    sha256 = (Get-FileHash -LiteralPath $Caminho -Algorithm SHA256).Hash
  }
}

# latest.yml: versão, nome do EXE e hash/tamanho que o updater vai conferir.
$latestText = Get-Content -LiteralPath $latest -Raw

if ($latestText -notmatch "(?m)^version:\s*$versaoRegex\s*$") {
  throw "latest.yml não declara version: $Version"
}
if ($latestText -notmatch "(?m)^\s*-\s*url:\s*$exeRegex\s*$") {
  throw "latest.yml (files[].url) não referencia $exeName"
}
if ($latestText -notmatch "(?m)^path:\s*$exeRegex\s*$") {
  throw "latest.yml (path) não referencia $exeName"
}

$exeInfo = Get-Info $exe
# electron-updater confere o sha512 em base64 declarado no latest.yml.
$sha512 = [Convert]::ToBase64String(
  [Convert]::FromHexString((Get-FileHash -LiteralPath $exe -Algorithm SHA512).Hash)
)
$exeInfo.sha512 = $sha512
$sha512Regex = [regex]::Escape($sha512)

if ($latestText -notmatch "(?m)^sha512:\s*$sha512Regex\s*$") {
  throw "latest.yml (sha512) não corresponde aos bytes do EXE"
}
if ($latestText -notmatch "(?m)^\s+sha512:\s*$sha512Regex\s*$") {
  throw "latest.yml (files[].sha512) não corresponde aos bytes do EXE"
}
if ($latestText -notmatch "(?m)^\s+size:\s*$($exeInfo.size)\s*$") {
  throw "latest.yml (files[].size) não corresponde ao tamanho do EXE"
}

# app-update.yml: feed que o próprio binário 1.0.12 vai consultar.
$appUpdateText = Get-Content -LiteralPath $appUpdate -Raw

foreach ($esperado in @(
  '(?m)^provider:\s*github\s*$',
  '(?m)^owner:\s*RMMMICHAEL\s*$',
  '(?m)^repo:\s*obaflix\s*$'
)) {
  if ($appUpdateText -notmatch $esperado) {
    throw "app-update.yml fora do esperado (github:RMMMICHAEL/obaflix): falhou em $esperado"
  }
}

# Authenticode obrigatório.
$sig = Get-AuthenticodeSignature -FilePath $exe

if ($sig.Status -ne "Valid") {
  throw "Assinatura Authenticode inválida: $($sig.Status)"
}

return [ordered]@{
  exe          = $exeInfo
  blockmap     = Get-Info $blockmap
  latest_yml   = Get-Info $latest
  app_update   = Get-Info $appUpdate
  feed         = "github:RMMMICHAEL/obaflix"
  authenticode = [ordered]@{
    status            = [string] $sig.Status
    signer_subject    = $sig.SignerCertificate.Subject
    signer_thumbprint = $sig.SignerCertificate.Thumbprint
  }
}
