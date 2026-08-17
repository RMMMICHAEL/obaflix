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
    Sem este parametro o script tenta as portas conhecidas por conta propria.

.PARAMETER Adb
    Caminho do adb.exe. So e necessario se a busca automatica falhar.

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
    [string]$Dispositivo,
    [string]$Adb
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
# Emuladores e o SDK costumam ser instalados fora do disco do sistema, entao a
# lista fixa cobre so os casos comuns e a busca resolve o resto.
$candidatos = @(
    "adb",
    "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
    "$env:ProgramFiles\Microvirt\MEmu\adb.exe",
    "${env:ProgramFiles(x86)}\Microvirt\MEmu\adb.exe",
    "C:\LDPlayer\LDPlayer9\adb.exe",
    "C:\Program Files\BlueStacks_nxt\HD-Adb.exe"
)
if ($Adb) { $candidatos = @($Adb) + $candidatos }

function Find-Adb {
    foreach ($candidato in $script:candidatos) {
        if (-not $candidato) { continue }
        $encontrado = Get-Command $candidato -ErrorAction SilentlyContinue
        if ($encontrado) { return $encontrado.Source }
        if (Test-Path $candidato) { return $candidato }
    }

    # Mesmos layouts de instalacao, mas em qualquer disco: e so Test-Path, entao
    # sai barato e evita cair na varredura recursiva no caso comum de o SDK ou o
    # emulador estarem no D:.
    $relativos = @(
        "Android\Sdk\platform-tools\adb.exe",
        "platform-tools\adb.exe",
        "Programas\Microvirt\MEmu\adb.exe",
        "Program Files\Microvirt\MEmu\adb.exe",
        "Program Files (x86)\Microvirt\MEmu\adb.exe",
        "Microvirt\MEmu\adb.exe",
        "LDPlayer\LDPlayer9\adb.exe",
        "LDPlayer9\adb.exe",
        "Nox\bin\adb.exe"
    )
    foreach ($disco in (Get-PSDrive -PSProvider FileSystem)) {
        foreach ($relativo in $relativos) {
            $caminho = Join-Path $disco.Root $relativo
            if (Test-Path $caminho) { return $caminho }
        }
    }

    Write-Host "adb nao esta nos caminhos usuais; procurando nos discos..." -ForegroundColor DarkGray
    $raizes = @()
    foreach ($disco in (Get-PSDrive -PSProvider FileSystem)) {
        foreach ($sub in @("Android", "Programas", "Program Files", "Program Files (x86)", "LDPlayer", "Nox")) {
            $caminho = Join-Path $disco.Root $sub
            if (Test-Path $caminho) { $raizes += $caminho }
        }
    }
    foreach ($raiz in $raizes) {
        $achado = Get-ChildItem -Path $raiz -Filter "adb.exe" -Recurse -Depth 4 -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($achado) { return $achado.FullName }
    }
    return $null
}

$adb = Find-Adb
if (-not $adb) {
    Write-Host ""
    Write-Host "adb.exe nao encontrado." -ForegroundColor Red
    Write-Host "Passe o caminho direto, por exemplo:" -ForegroundColor Yellow
    Write-Host "  .\scripts\capturar-log-android.ps1 -Adb 'D:\Android\Sdk\platform-tools\adb.exe'"
    return
}
Write-Host "adb: $adb" -ForegroundColor DarkGray

function Get-Dispositivos {
    return & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "\tdevice$" }
}

if ($Dispositivo) {
    Write-Host "conectando em $Dispositivo..." -ForegroundColor DarkGray
    & $adb connect $Dispositivo | Out-Null
}

$dispositivos = Get-Dispositivos
if (-not $dispositivos -and -not $Dispositivo) {
    # Emulador aberto nem sempre aparece sozinho: cada um escuta numa porta
    # propria e o adb so a enxerga depois de um connect explicito.
    Write-Host "nenhum dispositivo listado; tentando as portas conhecidas..." -ForegroundColor DarkGray
    foreach ($porta in @("127.0.0.1:21503", "127.0.0.1:21513", "127.0.0.1:5555", "127.0.0.1:5556", "127.0.0.1:62001")) {
        & $adb connect $porta 2>&1 | Out-Null
        $dispositivos = Get-Dispositivos
        if ($dispositivos) { Write-Host "conectado em $porta" -ForegroundColor DarkGray; break }
    }
}

if (-not $dispositivos) {
    Write-Host ""
    Write-Host "Nenhum dispositivo conectado." -ForegroundColor Red
    Write-Host "Confira se o emulador esta aberto e com depuracao USB ligada." -ForegroundColor Yellow
    Write-Host "Se souber a porta, passe direto:" -ForegroundColor Yellow
    Write-Host "  .\scripts\capturar-log-android.ps1 -Dispositivo 127.0.0.1:21503"
    return
}
# @() forca array: com um unico dispositivo o Where-Object devolve string, e
# indexar direto pegava o primeiro CARACTERE do serial em vez do serial.
$serial = (@($dispositivos)[0] -split '\s+')[0]
Write-Host "dispositivo: $serial" -ForegroundColor DarkGray

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
