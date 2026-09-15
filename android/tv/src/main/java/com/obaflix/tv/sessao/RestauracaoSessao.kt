package com.obaflix.tv.sessao

/**
 * Decisao de restaurar a sessao na abertura do aplicativo. Puro, sem Android:
 * testado em JVM.
 *
 * ## O defeito que isto corrige
 *
 * Antes, qualquer falha ao renovar o refresh na abertura levava direto ao
 * pareamento: rede ainda subindo depois de ligar a TV, timeout, 5xx, 429 ou
 * Keystore indisponivel logo apos o boot. A credencial continuava guardada e
 * valida, mas a tela de login aparecia — e a pessoa pareava de novo.
 *
 * Agora so duas coisas encerram a sessao local:
 *  - o servidor **recusar** o refresh (401: revogado, expirado, reutilizado ou
 *    de outro aparelho);
 *  - nao existir credencial guardada.
 *
 * Todo o resto e temporario: a TV continua no carregamento, avisa que esta sem
 * conexao e tenta de novo, sem apagar nada.
 */

/** O que o armazenamento cifrado respondeu. */
enum class LeituraCredencial {
    /** Ha refresh guardado. */
    Presente,

    /** Nada guardado: primeira abertura, logout ou revogacao ja confirmada. */
    Ausente,

    /** Nao deu para ler agora (Keystore do fabricante ainda subindo, E/S). */
    Indisponivel,
}

sealed interface ResultadoRenovacao {
    data class Renovado(val deviceId: String) : ResultadoRenovacao

    /** O servidor recusou o refresh. Definitivo: a credencial local ja foi apagada. */
    data object Recusado : ResultadoRenovacao

    /** Rede, timeout, 5xx, 429, resposta ilegivel. A credencial fica. */
    data class Temporario(val motivo: String) : ResultadoRenovacao
}

/**
 * Classifica a resposta HTTP de `POST /api/tv/session`.
 *
 * So 401 e definitivo — e o unico status que o servidor usa para "este refresh
 * nao vale mais". 400 so acontece com corpo malformado (defeito do cliente, nao
 * da credencial) e 429 e bloqueio temporario por IP; apagar o login por eles
 * seria punir a pessoa por um problema que nao e dela.
 */
fun classificarStatusDeRenovacao(status: Int): ResultadoRenovacao? = when {
    status in 200..299 -> null // sucesso: quem chama le o corpo
    status == 401 -> ResultadoRenovacao.Recusado
    else -> ResultadoRenovacao.Temporario("http_$status")
}

sealed interface DecisaoDeAbertura {
    data class Entrar(val deviceId: String) : DecisaoDeAbertura
    data object Parear : DecisaoDeAbertura
}

/** Esperas entre tentativas. Depois da ultima, repete a ultima. */
val ESPERAS_DE_RESTAURACAO_MS: List<Long> = listOf(2_000, 4_000, 8_000, 15_000, 30_000)

/**
 * Leituras seguidas do armazenamento indisponivel antes de desistir da
 * credencial. Sem teto, um aparelho com Keystore quebrado ficaria para sempre
 * no carregamento; com teto, ele cai no pareamento, que ja funciona sem cofre.
 */
const val LEITURAS_INDISPONIVEIS_MAX = 5

/**
 * Restaura a sessao.
 *
 * Nunca decide `Parear` por falha temporaria de rede — tenta de novo
 * indefinidamente, avisando por `aoAguardar`. A pessoa continua podendo sair do
 * aplicativo; ao reabrir, o laco recomeca com a credencial intacta.
 */
suspend fun restaurarSessao(
    ler: suspend () -> LeituraCredencial,
    renovar: suspend () -> ResultadoRenovacao,
    esperar: suspend (Long) -> Unit,
    aoAguardar: (tentativa: Int, motivo: String) -> Unit = { _, _ -> },
): DecisaoDeAbertura {
    var tentativa = 0
    var leiturasIndisponiveis = 0

    while (true) {
        when (ler()) {
            LeituraCredencial.Ausente -> return DecisaoDeAbertura.Parear
            LeituraCredencial.Indisponivel -> {
                if (++leiturasIndisponiveis >= LEITURAS_INDISPONIVEIS_MAX) return DecisaoDeAbertura.Parear
                aoAguardar(++tentativa, "armazenamento_indisponivel")
                esperar(esperaDaTentativa(tentativa))
                continue
            }
            LeituraCredencial.Presente -> leiturasIndisponiveis = 0
        }

        when (val r = renovar()) {
            is ResultadoRenovacao.Renovado -> return DecisaoDeAbertura.Entrar(r.deviceId)
            ResultadoRenovacao.Recusado -> return DecisaoDeAbertura.Parear
            is ResultadoRenovacao.Temporario -> {
                aoAguardar(++tentativa, r.motivo)
                esperar(esperaDaTentativa(tentativa))
            }
        }
    }
}

fun esperaDaTentativa(tentativa: Int): Long =
    ESPERAS_DE_RESTAURACAO_MS[(tentativa - 1).coerceIn(0, ESPERAS_DE_RESTAURACAO_MS.lastIndex)]
