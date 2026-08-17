<#
.SYNOPSIS
    Captura e resume os logs do ObaFlix no Android.

.DESCRIPTION
    Mostra ao vivo apenas as linhas do app, com destaque para as que dizem qual
    caminho a extracao do SuperFlix seguiu, e salva tudo em UTF-8. Capturas
    feitas com "adb logcat > arquivo.txt" no PowerShell saem em UTF-16 e ficam
    ilegiveis depois; por isso a gravacao aqui e explicita.

.PARAMETER Resumir
    Nao captura nada: le um arquivo de log ja existente (UTF-8 ou UTF-16) e
    imprime so as linhas relevantes, com tokens longos mascarados. Use para
    revisar uma captura antiga antes de compartilhar.

.PARAMETER Arquivo
    Onde gravar a captura. Padrao: log-obaflix-<data>.txt na pasta atual.

.PARAMETER Dispositivo
    Endereco do emulador, quando o adb nao o encontra sozinho.
    MEmu costuma ser 127.0.0.1:21503 e LDPlayer 127.0.0.1:5555.

.EXAMPLE
    .\scripts\capturar-log-android.ps1
    Captura ao vivo. Reproduza um episodio e pare com Ctrl+C.

.EXAMPLE
    .\scripts\capturar-log-android.ps1 -Resumir android-player-log.txt
    Resume um log ja capturado.
#>
[CmdletBinding()]
param(
    [string]$Resumir,
    [string]$Arquivo,
    [string]$Dispositivo
)

$ErrorActionPreference = "Stop"

# Casa a TAG do log ("D/Obaflix", "D/Obaflix/Superflix"), nao o texto solto.
# Procurar so por "obaflix" trazia junto o nome do pacote (D/com.obaflix) e as
# linhas de continuacao de mensagens quebradas.
$PadraoTag = '[VDIWEF]/Obaflix'

# Linhas que respondem "por que ainda pede para escolher o servidor?".
$PadraoRelevante = '\[direto\]|\[direto_falhou\]|\[bootstrap|\[cloudflare\]|\[sources\]|\[profile\]|\[probe_stop\]|\[source_skip\]|\[ok\]|\[media\]|\[page\]|\[provider/|\[bridge\]|\[extract\]|\[intercept/'

function Read-ArquivoLog([string]$Caminho) {
    $bytes = [System.IO.File]::ReadAllBytes($Caminho)
    # Capturas antigas vieram em UTF-16LE; detecta pelo BOM em vez de adivinhar.
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
        return [System.Text.Encoding]::Unicode.GetString($bytes)
    }
    return [System.Text.Encoding]::UTF8.GetString($bytes)
}

function Limpar-Linha([string]$Linha) {
    $texto = ($Linha -replace '\s+', ' ').Trim()
    # Mascara tokens e assinaturas para a saida poder ser compartilhada.
    return [regex]::Replace($texto, '[A-Za-z0-9_\-]{40,}', { param($m) "<$($m.Value.Length)ch>" })
}

function Escrever-Colorido([string]$Linha) {
    $cor = "DarkGray"
    if ($Linha -match '\[direto\]')                      { $cor = "Green" }
    elseif ($Linha -match 'falhou|erro=|Exception|\bE/') { $cor = "Red" }
    elseif ($Linha -match '\[bootstrap')                 { $cor = "Cyan" }
    elseif ($Linha -match '\[ok\]|\[profile\]|\[sources\]|\[probe_stop\]') { $cor = "Yellow" }
    elseif ($Linha -match '\[cloudflare\]|\[media\]')    { $cor = "Magenta" }
    Write-Host $Linha -ForegroundColor $cor
}

# ── Modo resumo ───────────────────────────────────────────────────────────────
if ($Resumir) {
    if (-not (Test-Path $Resumir)) { throw "Arquivo nao encontrado: $Resumir" }

    $conteudo = Read-ArquivoLog $Resumir
    $linhas = $conteudo -split "`r?`n" | Where-Object {
        $_ -match $PadraoTag -and $_ -notmatch 'GC freed'
    }

    Write-Host ""
    Write-Host "Resumo de $Resumir  ($($linhas.Count) linhas do app)" -ForegroundColor White
    Write-Host ("-" * 70)
    foreach ($linha in $linhas) { Escrever-Colorido (Limpar-Linha $linha) }
    Write-Host ("-" * 70)
    Write-Host "Tokens longos ja mascarados. Confira antes de compartilhar." -ForegroundColor DarkGray
    return
}

# ── Localiza o adb ────────────────────────────────────────────────────────────
$candidatos = @(
    "adb",
    "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
    "$env:ProgramFiles\Microvirt\MEmu\adb.exe",
    "${env:ProgramFiles(x86)}\Microvirt\MEmu\adb.exe",
    "C:\Program Files\Microvirt\MEmuHyperv\adb.exe",
    "C:\LDPlayer\LDPlayer9\adb.exe",
    "D:\LDPlayer\LDPlayer9\adb.exe",
    "C:\Program Files\BlueStacks_nxt\HD-Adb.exe"
)

$adb = $null
foreach ($candidato in $candidatos) {
    $encontrado = Get-Command $candidato -ErrorAction SilentlyContinue
    if ($encontrado) { $adb = $encontrado.Source; break }
    if (Test-Path $candidato) { $adb = $candidato; break }
}
if (-not $adb) {
    throw "adb nao encontrado. Instale o platform-tools ou passe o caminho em `$env:PATH."
}
Write-Host "adb: $adb" -ForegroundColor DarkGray

if ($Dispositivo) {
    Write-Host "conectando em $Dispositivo..." -ForegroundColor DarkGray
    & $adb connect $Dispositivo | Out-Null
}

$dispositivos = & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "\tdevice$" }
if (-not $dispositivos) {
    Write-Host ""
    Write-Host "Nenhum dispositivo conectado." -ForegroundColor Red
    Write-Host "Com o emulador aberto, tente indicar a porta:" -ForegroundColor Yellow
    Write-Host "  .\scripts\capturar-log-android.ps1 -Dispositivo 127.0.0.1:21503   # MEmu"
    Write-Host "  .\scripts\capturar-log-android.ps1 -Dispositivo 127.0.0.1:5555    # LDPlayer"
    return
}
Write-Host "dispositivo: $(($dispositivos[0] -split '\s+')[0])" -ForegroundColor DarkGray

if (-not $Arquivo) {
    $Arquivo = "log-obaflix-$(Get-Date -Format 'yyyyMMdd-HHmmss').txt"
}

& $adb logcat -c
Set-Content -Path $Arquivo -Value "" -Encoding utf8

Write-Host ""
Write-Host "Capturando. Abra um episodio e escolha o Player 2 (SuperFlix)." -ForegroundColor White
Write-Host "Pare com Ctrl+C. Gravando em: $Arquivo" -ForegroundColor White
Write-Host ("-" * 70)
Write-Host "verde = resolveu sozinho | vermelho = falhou | ciano = bootstrap" -ForegroundColor DarkGray
Write-Host ("-" * 70)

# Sem filtro de tag: o logcat separa a filterspec por ':' e o tag do extrator
# ("Obaflix/Superflix") ja causou captura vazia. Filtrar aqui e mais confiavel.
& $adb logcat -v time | ForEach-Object {
    if ($_ -notmatch $PadraoTag) { return }
    if ($_ -match 'GC freed') { return }
    Add-Content -Path $Arquivo -Value $_ -Encoding utf8
    if ($_ -match $PadraoRelevante) { Escrever-Colorido (Limpar-Linha $_) }
}
