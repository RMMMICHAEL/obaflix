<#
.SYNOPSIS
    Mostra no terminal, ao vivo, por onde a reproducao do ObaFlix passou e onde ela parou.

.DESCRIPTION
    Le o logcat do aparelho e interpreta as linhas estruturadas "[oba]" emitidas
    pelo ObaLog (android/app/src/main/java/com/obaflix/bridge/ObaLog.kt).

    A diferenca para capturar-log-android.ps1: aquele script grava e filtra texto;
    este entende o formato. Ele agrupa por trilha (uma tentativa de reproducao),
    marca a fase de cada passo, mostra quanto tempo cada uma levou e, ao final de
    cada tentativa, imprime um veredito dizendo em qual fase o funil morreu.

    Funil observado, em ordem:
      sessao -> bridge -> extracao -> provedor -> manifesto -> cdn -> player

    Nenhum token e impresso: o proprio ObaLog ja remove a query das URLs antes de
    registra-las, entao a saida pode ser colada num chat.

.PARAMETER Arquivo
    Onde gravar a captura crua em UTF-8. Padrao: diag-android-<data>.txt.
    Use -Arquivo "" para nao gravar nada.

.PARAMETER Reler
    Nao captura: interpreta um arquivo ja gravado (UTF-8 ou UTF-16) e imprime o
    mesmo relatorio. Use para revisar uma captura antiga.

.PARAMETER Tudo
    Mostra tambem os passos de progresso normais. Sem este parametro, o modo ao
    vivo imprime so o essencial (inicio de trilha, alertas, falhas e vereditos).

.PARAMETER Dispositivo
    Endereco do emulador quando o adb nao o encontra sozinho
    (MEmu: 127.0.0.1:21503, LDPlayer: 127.0.0.1:5555).

.PARAMETER Adb
    Caminho do adb.exe, se a busca automatica falhar.

.EXAMPLE
    .\scripts\diag-android.ps1
    Captura ao vivo. Abra um episodio e pare com Ctrl+C.

.EXAMPLE
    .\scripts\diag-android.ps1 -Tudo
    Mesma captura, mas mostrando cada passo do funil.

.EXAMPLE
    .\scripts\diag-android.ps1 -Reler diag-android-20260824-2130.txt
    Reinterpreta uma captura ja feita.
#>
[CmdletBinding()]
param(
    [string]$Reler,
    [string]$Arquivo,
    [switch]$Tudo,
    [string]$Dispositivo,
    [string]$Adb
)

$ErrorActionPreference = "Stop"

# -- Formato -------------------------------------------------------------------
# Linha do ObaLog:  [oba] t=ab12 +1832ms fase=cdn ev=resposta status=206 host=...
# Linha de trilha:  [oba-trilha] [oba] t=ab12 ...   (reimpressao apos uma falha)
$RegexLinha = '\[oba\]\s+t=(?<trilha>\S+)\s+\+(?<ms>\d+)ms\s+fase=(?<fase>\S+)\s+ev=(?<ev>\S+)(?<resto>.*)$'

# Ordem do funil. O veredito e a ultima fase alcancada: se a trilha morreu em
# "cdn", extracao e manifesto ja tinham dado certo, e o problema esta nos
# headers/no CDN - nao no provedor.
$OrdemFase = @{
    sessao    = 0
    bridge    = 1
    extracao  = 2
    provedor  = 3
    manifesto = 4
    cdn       = 5
    documento = 5
    render    = 6
    player    = 7
}

$CorFase = @{
    sessao    = "DarkGray"
    bridge    = "Cyan"
    extracao  = "Cyan"
    provedor  = "Magenta"
    manifesto = "Yellow"
    cdn       = "Yellow"
    documento = "DarkGray"
    render    = "Red"
    player    = "Green"
}

# Eventos que, sozinhos, ja explicam uma reproducao quebrada. O texto e o que
# aparece no veredito - vale mais que o nome cru do evento.
$Explicacao = @{
    "extracao_falhou"       = "o provedor nao entregou nenhum stream"
    "provedor_falhou"       = "o provedor recusou ou nao respondeu"
    "stream_inseguro"       = "o stream veio em HTTP; o app so aceita HTTPS"
    "destino_bloqueado"     = "o stream aponta para um endereco de rede local"
    "sem_referer"           = "segmento pedido sem Referer/Origin - o CDN costuma devolver 403"
    "status_nao_2xx"        = "o CDN recusou o arquivo"
    "erro_rede"             = "a requisicao ao CDN nao completou"
    "corpo_vazio"           = "a resposta veio sem corpo"
    "processo_morreu"       = "o renderer da WebView morreu (midia invalida ou falta de memoria)"
    "js_video_erro"         = "o elemento <video> abortou a reproducao"
    "js_travado"            = "o player ficou esperando buffer sem avancar"
    "js_hls_erro"           = "o hls.js reportou erro"
    "cdn_nao_liberado"      = "nenhum host de CDN foi liberado - todo segmento sai sem Referer"
    "requested_with_nao_suportado" = "WebView antiga: o header X-Requested-With ainda vaza para o provedor"
}

# -- Estado por trilha ---------------------------------------------------------
$script:Trilhas = @{}

function Get-Trilha([string]$id) {
    if (-not $script:Trilhas.ContainsKey($id)) {
        $script:Trilhas[$id] = [pscustomobject]@{
            Id         = $id
            Provedor   = "?"
            FaseMax    = -1
            NomeFase   = "-"
            Passos     = 0
            Alertas    = New-Object System.Collections.ArrayList
            Falhas     = New-Object System.Collections.ArrayList
            Reproduziu = $false
            UltimoMs   = 0
            Fechada    = $false
        }
    }
    return $script:Trilhas[$id]
}

function ConvertTo-Campos([string]$resto) {
    $campos = [ordered]@{}
    # "chave=valor" ou "chave="valor com espaco"" - o ObaLog cita o segundo caso.
    foreach ($m in [regex]::Matches($resto, '(?<k>[A-Za-z][\w]*)=(?:"(?<v1>[^"]*)"|(?<v2>\S+))')) {
        $valor = if ($m.Groups['v1'].Success) { $m.Groups['v1'].Value } else { $m.Groups['v2'].Value }
        $campos[$m.Groups['k'].Value] = $valor
    }
    return $campos
}

function Format-Campos($campos) {
    $prioridade = @('provedor','status','tipo','codigo','detalhe','host','arquivo','url','ms','motivo','causa','diagnostico')
    $partes = @()
    foreach ($chave in $prioridade) {
        if ($campos.Contains($chave)) { $partes += "$chave=$($campos[$chave])" }
    }
    foreach ($chave in $campos.Keys) {
        if ($prioridade -notcontains $chave) { $partes += "$chave=$($campos[$chave])" }
    }
    return ($partes -join "  ")
}

function Write-Veredito($t) {
    if ($t.Fechada) { return }
    $t.Fechada = $true

    Write-Host ""
    if ($t.Reproduziu) {
        Write-Host ("  VEREDITO t=$($t.Id) [$($t.Provedor)]: reproduziu " +
                    "(chegou a fase player em $($t.UltimoMs)ms, $($t.Passos) passos)") -ForegroundColor Green
    } else {
        $motivo = "parou na fase '$($t.NomeFase)'"
        if ($t.Falhas.Count -gt 0) { $motivo = $t.Falhas[$t.Falhas.Count - 1] }
        Write-Host ("  VEREDITO t=$($t.Id) [$($t.Provedor)]: NAO reproduziu - $motivo") -ForegroundColor Red
        if ($t.Alertas.Count -gt 0) {
            $vistos = $t.Alertas | Select-Object -Unique
            foreach ($a in $vistos) { Write-Host "            aviso: $a" -ForegroundColor DarkYellow }
        }
    }
    Write-Host ""
}

function Read-Linha([string]$linha, [bool]$aoVivo) {
    # A reimpressao da trilha repete linhas ja contabilizadas; serve para leitura
    # humana, nao deve inflar os contadores.
    $ehReimpressao = $linha -match '\[oba-trilha\]'

    $m = [regex]::Match($linha, $RegexLinha)
    if (-not $m.Success) { return }

    $id     = $m.Groups['trilha'].Value
    $ms     = [int]$m.Groups['ms'].Value
    $fase   = $m.Groups['fase'].Value
    $ev     = $m.Groups['ev'].Value
    $campos = ConvertTo-Campos $m.Groups['resto'].Value

    $ehFalha  = $linha -match '^\s*\S+\s+E[/ ]' -or $linha -match ' E/Obaflix' -or $Explicacao.ContainsKey($ev)
    $ehAlerta = $linha -match ' W/Obaflix'

    if ($ehReimpressao) {
        if ($Tudo) {
            Write-Host ("      | +${ms}ms $fase/$ev  " + (Format-Campos $campos)) -ForegroundColor DarkGray
        }
        return
    }

    # Nova trilha: fecha a anterior com veredito antes de comecar a proxima.
    if ($fase -eq 'sessao' -and $ev -eq 'inicio') {
        foreach ($anterior in @($script:Trilhas.Values | Where-Object { -not $_.Fechada -and $_.Id -ne $id })) {
            Write-Veredito $anterior
        }
        $script:Trilhas.Remove($id) | Out-Null
        $t = Get-Trilha $id
        if ($campos.Contains('provedor')) { $t.Provedor = $campos['provedor'] }
        Write-Host ("=== trilha $id  provedor=$($t.Provedor)  " +
                    "embed=$(if ($campos.Contains('embed')) { $campos['embed'] } else { '-' })") -ForegroundColor White
        return
    }

    $t = Get-Trilha $id
    $t.Passos++
    $t.UltimoMs = $ms
    if ($campos.Contains('provedor') -and $t.Provedor -eq '?') { $t.Provedor = $campos['provedor'] }

    $ordem = if ($OrdemFase.ContainsKey($fase)) { $OrdemFase[$fase] } else { 0 }
    if ($ordem -gt $t.FaseMax) { $t.FaseMax = $ordem; $t.NomeFase = $fase }

    # Sucesso confirmado so quando o <video> avisa que esta tocando.
    if ($ev -eq 'js_reproduzindo') {
        $t.Reproduziu = $true
        Write-Host ("  [OK] t=$id reproduzindo em ${ms}ms  " + (Format-Campos $campos)) -ForegroundColor Green
        return
    }

    $texto = "  +${ms}ms " + $fase.PadRight(9) + " " + $ev.PadRight(24) + " " + (Format-Campos $campos)

    if ($ehFalha) {
        $porque = if ($Explicacao.ContainsKey($ev)) { $Explicacao[$ev] } else { $ev }
        [void]$t.Falhas.Add("$fase/$ev - $porque")
        Write-Host $texto -ForegroundColor Red
        Write-Host ("           ^ $porque") -ForegroundColor DarkRed
    }
    elseif ($ehAlerta) {
        if ($Explicacao.ContainsKey($ev)) { [void]$t.Alertas.Add("$ev - $($Explicacao[$ev])") }
        Write-Host $texto -ForegroundColor Yellow
    }
    elseif ($Tudo -or -not $aoVivo) {
        $cor = if ($CorFase.ContainsKey($fase)) { $CorFase[$fase] } else { "Gray" }
        Write-Host $texto -ForegroundColor $cor
    }
}

# -- Modo releitura ------------------------------------------------------------
if ($Reler) {
    if (-not (Test-Path $Reler)) { throw "Arquivo nao encontrado: $Reler" }
    $bytes = [System.IO.File]::ReadAllBytes($Reler)
    # Capturas feitas com "adb logcat > arquivo" no PowerShell saem em UTF-16LE.
    $conteudo = if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
        [System.Text.Encoding]::Unicode.GetString($bytes)
    } else {
        [System.Text.Encoding]::UTF8.GetString($bytes)
    }

    Write-Host ""
    Write-Host "Relendo $Reler" -ForegroundColor White
    Write-Host ("-" * 78)
    foreach ($linha in ($conteudo -split "`r?`n")) { Read-Linha $linha $false }
    foreach ($t in @($script:Trilhas.Values | Where-Object { -not $_.Fechada })) { Write-Veredito $t }
    return
}

# -- Localiza o adb ------------------------------------------------------------
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
    foreach ($c in $script:candidatos) {
        if (-not $c) { continue }
        $achado = Get-Command $c -ErrorAction SilentlyContinue
        if ($achado) { return $achado.Source }
        if (Test-Path $c) { return $c }
    }
    # Mesmos layouts de instalacao em qualquer disco: so Test-Path, sai barato e
    # cobre o caso comum do SDK/emulador morarem no D:.
    $relativos = @(
        "Android\Sdk\platform-tools\adb.exe",
        "platform-tools\adb.exe",
        "Programas\Microvirt\MEmu\adb.exe",
        "Program Files\Microvirt\MEmu\adb.exe",
        "Microvirt\MEmu\adb.exe",
        "LDPlayer\LDPlayer9\adb.exe",
        "LDPlayer9\adb.exe",
        "Nox\bin\adb.exe"
    )
    foreach ($disco in (Get-PSDrive -PSProvider FileSystem)) {
        foreach ($rel in $relativos) {
            $caminho = Join-Path $disco.Root $rel
            if (Test-Path $caminho) { return $caminho }
        }
    }
    return $null
}

$adb = Find-Adb
if (-not $adb) {
    Write-Host ""
    Write-Host "adb.exe nao encontrado." -ForegroundColor Red
    Write-Host "  .\scripts\diag-android.ps1 -Adb 'D:\Android\Sdk\platform-tools\adb.exe'" -ForegroundColor Yellow
    return
}

function Get-Dispositivos { & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "\tdevice$" } }

if ($Dispositivo) { & $adb connect $Dispositivo | Out-Null }
$dispositivos = Get-Dispositivos
if (-not $dispositivos -and -not $Dispositivo) {
    # Emulador aberto nem sempre aparece sozinho: cada um escuta numa porta e o
    # adb so a enxerga depois de um connect explicito.
    foreach ($porta in @("127.0.0.1:21503","127.0.0.1:21513","127.0.0.1:5555","127.0.0.1:5556","127.0.0.1:62001")) {
        & $adb connect $porta 2>&1 | Out-Null
        $dispositivos = Get-Dispositivos
        if ($dispositivos) { break }
    }
}
if (-not $dispositivos) {
    Write-Host ""
    Write-Host "Nenhum dispositivo conectado. Abra o emulador ou ligue a depuracao USB." -ForegroundColor Red
    Write-Host "  .\scripts\diag-android.ps1 -Dispositivo 127.0.0.1:21503" -ForegroundColor Yellow
    return
}
# @() forca array: com um unico dispositivo o Where-Object devolve string e
# indexar direto pegaria o primeiro CARACTERE do serial.
$serial = (@($dispositivos)[0] -split '\s+')[0]

if ($null -eq $Arquivo) { $Arquivo = "diag-android-$(Get-Date -Format 'yyyyMMdd-HHmm').txt" }
$gravando = -not [string]::IsNullOrWhiteSpace($Arquivo)
if ($gravando) { Set-Content -Path $Arquivo -Value "" -Encoding utf8 }

& $adb -s $serial logcat -c

Write-Host ""
Write-Host "adb: $adb   dispositivo: $serial" -ForegroundColor DarkGray
Write-Host "Abra um episodio no app. Pare com Ctrl+C." -ForegroundColor White
if ($gravando) { Write-Host "Captura crua em: $Arquivo" -ForegroundColor DarkGray }
Write-Host ("-" * 78)
Write-Host "branco = trilha nova | amarelo = degradou | vermelho = falhou | verde = tocando" -ForegroundColor DarkGray
if (-not $Tudo) { Write-Host "(use -Tudo para ver cada passo do funil)" -ForegroundColor DarkGray }
Write-Host ("-" * 78)

try {
    # Sem filterspec de tag: o logcat separa a spec por ':' e tags com barra ja
    # causaram captura vazia. Filtrar aqui e mais confiavel.
    & $adb -s $serial logcat -v time | ForEach-Object {
        if ($_ -notmatch '\[oba') { return }
        if ($gravando) { Add-Content -Path $Arquivo -Value $_ -Encoding utf8 }
        Read-Linha $_ $true
    }
}
finally {
    foreach ($t in @($script:Trilhas.Values | Where-Object { -not $_.Fechada })) { Write-Veredito $t }
    if ($gravando) {
        Write-Host "Captura salva em $Arquivo - releia com:" -ForegroundColor DarkGray
        Write-Host "  .\scripts\diag-android.ps1 -Reler $Arquivo -Tudo" -ForegroundColor DarkGray
    }
}
