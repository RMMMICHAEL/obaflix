<#
.SYNOPSIS
    Captura o log do player do Obaflix TV e resume o que decidiu cada fonte.

.DESCRIPTION
    O logcat do aparelho mistura o app com o sistema inteiro. Este script filtra
    so as linhas do Obaflix, grava em UTF-8 (o "adb logcat > arquivo" do
    PowerShell grava em UTF-16 e o arquivo fica ilegivel depois) e, ao terminar,
    imprime um resumo por servidor: o que foi extraido, o que o CDN respondeu,
    qual decodificador entrou e por que a fonte parou.

    Precisa de um APK com diagnostico ligado (construido com -PdiagLogs). Sem
    isso o R8 remove as chamadas de log e a captura sai vazia — o script avisa
    quando percebe isso.

.PARAMETER Arquivo
    Onde gravar. Padrao: log-tv-<data-hora>.txt na pasta atual.

.PARAMETER Dispositivo
    Endereco do aparelho. Sem este parametro o script tenta as portas conhecidas
    de emulador (MEmu 21503, LDPlayer 5555) e, se nada responder, usa o unico
    aparelho conectado.

.PARAMETER Resumir
    Nao captura: le um arquivo ja gravado e imprime so o resumo.

.PARAMETER Adb
    Caminho do adb.exe, se a busca automatica falhar.

.EXAMPLE
    .\scripts\log-tv.ps1
    Captura ao vivo. Reproduza um episodio e pare com Ctrl+C para ver o resumo.

.EXAMPLE
    .\scripts\log-tv.ps1 -Resumir log-tv-20260830-2140.txt
    So resume uma captura anterior.
#>
[CmdletBinding()]
param(
    [string]$Arquivo,
    [string]$Dispositivo,
    [string]$Resumir,
    [string]$Adb
)

$ErrorActionPreference = 'Stop'

function Find-Adb {
    param([string]$Preferido)
    if ($Preferido -and (Test-Path $Preferido)) { return $Preferido }
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidatos = @(
        "D:\Android\Sdk\platform-tools\adb.exe",
        "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
        "$env:USERPROFILE\AppData\Local\Android\Sdk\platform-tools\adb.exe"
    )
    foreach ($c in $candidatos) { if (Test-Path $c) { return $c } }
    throw "adb.exe nao encontrado. Passe -Adb com o caminho completo."
}

function Resolve-Dispositivo {
    param([string]$AdbPath, [string]$Preferido)
    if ($Preferido) {
        & $AdbPath connect $Preferido | Out-Null
        return $Preferido
    }
    # Emuladores costumam precisar de um connect antes de aparecer na lista.
    foreach ($porta in @('127.0.0.1:21503', '127.0.0.1:5555', '127.0.0.1:62001')) {
        & $AdbPath connect $porta 2>&1 | Out-Null
    }
    $linhas = & $AdbPath devices | Select-Object -Skip 1 |
        Where-Object { $_ -match '\sdevice$' }
    if (-not $linhas) { throw "Nenhum aparelho conectado. Ligue a depuracao USB ou abra o emulador." }
    $primeiro = ($linhas | Select-Object -First 1) -split '\s+' | Select-Object -First 1
    if ($linhas.Count -gt 1) {
        Write-Host "Varios aparelhos conectados; usando $primeiro. Use -Dispositivo para escolher." -ForegroundColor Yellow
    }
    return $primeiro
}

# ── Resumo ───────────────────────────────────────────────────────────────────
# A ordem importa: o resumo conta a historia de uma fonte na sequencia em que
# ela acontece, e nao na ordem em que as linhas aparecem misturadas no logcat.
function Write-Resumo {
    param([string]$Caminho)

    if (-not (Test-Path $Caminho)) { Write-Host "Arquivo nao encontrado: $Caminho" -ForegroundColor Red; return }
    $linhas = Get-Content -LiteralPath $Caminho -Encoding UTF8

    if (-not ($linhas | Where-Object { $_ -match '\[oba\]' })) {
        Write-Host ""
        Write-Host "Nenhuma linha [oba] na captura." -ForegroundColor Red
        Write-Host "O APK instalado esta sem diagnostico. Reinstale um construido com:" -ForegroundColor Yellow
        Write-Host "  .\gradlew :tv:assembleRelease -PdiagLogs" -ForegroundColor Yellow
        return
    }

    Write-Host ""
    Write-Host "──────────── resumo por servidor ────────────" -ForegroundColor Cyan

    $interessantes = @(
        'tv_fonte_extraida', 'tv_fonte_falhou', 'tv_manifesto_pulado',
        'tv_manifesto_recusado', 'tv_manifesto_inconclusivo', 'tv_midia_preparada',
        'tv_watchdog_inicio', 'tv_watchdog_fim', 'tv_carga_falhou',
        'tv_decoder_video', 'tv_formato_video', 'tv_primeiro_quadro',
        'tv_reproducao_iniciada', 'tv_fonte_nao_iniciou', 'tv_erro_media3',
        'tv_quadros_perdidos', 'tls_conscrypt_ativo', 'tv_tls_em_uso',
        'tv_manifesto_morto', 'tv_watchdog_estendido',
        'tv_failover', 'tv_tentativa_obsoleta',
        'tv_sonda_desafio', 'midia_guardada', 'midia_candidata_ignorada',
        'overlay_tecla', 'overlay_aberto', 'overlay_fechado', 'sf_media'
    )
    $padrao = ($interessantes -join '|')

    foreach ($linha in $linhas) {
        # A trilha e um replay do que ja saiu: sem pular, cada falha
        # aparece duas vezes no resumo e a leitura dobra de tamanho.
        if ($linha -match 'oba-trilha') { continue }
        if ($linha -notmatch "ev=($padrao)\b") { continue }
        $ev = $Matches[1]
        # Tira o cabecalho do logcat; a linha do Obaflix ja se explica sozinha.
        $limpa = $linha -replace '^.*?\[oba\]', '[oba]'
        $cor = switch -Regex ($ev) {
            'nao_iniciou|falhou|recusado|erro_media3' { 'Red' }
            'inconclusivo|quadros_perdidos'           { 'Yellow' }
            'reproducao_iniciada|primeiro_quadro'     { 'Green' }
            default                                   { 'Gray' }
        }
        Write-Host $limpa -ForegroundColor $cor
    }

    Write-Host "─────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host "Captura completa em: $Caminho"
    Write-Host "Pode colar o resumo acima; hosts aparecem sem querystring e sem token."
}

# ── Execucao ─────────────────────────────────────────────────────────────────

if ($Resumir) { Write-Resumo -Caminho $Resumir; return }

$adbPath = Find-Adb -Preferido $Adb
$alvo = Resolve-Dispositivo -AdbPath $adbPath -Preferido $Dispositivo
if (-not $Arquivo) { $Arquivo = "log-tv-$(Get-Date -Format 'yyyyMMdd-HHmm').txt" }

Write-Host "Aparelho: $alvo"
Write-Host "Gravando em: $Arquivo"
Write-Host ""
Write-Host "Abra um episodio agora. Pare com Ctrl+C quando o problema acontecer." -ForegroundColor Cyan
Write-Host ""

# Buffer limpo: sem isto a captura comeca com o historico de sessoes antigas
# e o resumo mistura a falha de hoje com a de ontem.
& $adbPath -s $alvo logcat -c 2>&1 | Out-Null

$escritor = [System.IO.StreamWriter]::new($Arquivo, $false, [System.Text.UTF8Encoding]::new($false))
try {
    & $adbPath -s $alvo logcat -v time -s Obaflix:V ObaFoco:V AndroidRuntime:E ExoPlayerImplInternal:E | ForEach-Object {
        $escritor.WriteLine($_)
        $escritor.Flush()
        if ($_ -match 'ev=tv_(fonte_nao_iniciou|carga_falhou|erro_media3)') {
            Write-Host $_ -ForegroundColor Red
        } elseif ($_ -match 'ev=tv_(reproducao_iniciada|primeiro_quadro)') {
            Write-Host $_ -ForegroundColor Green
        } else {
            Write-Host $_ -ForegroundColor DarkGray
        }
    }
} finally {
    $escritor.Dispose()
    Write-Resumo -Caminho $Arquivo
}
