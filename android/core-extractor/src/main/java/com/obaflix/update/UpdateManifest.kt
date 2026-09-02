package com.obaflix.update

import org.json.JSONException
import org.json.JSONObject

/**
 * Uma entrada do manifesto: o que existe hoje, publicado, para uma plataforma.
 *
 * `size` e `sha256` sao opcionais de proposito — o manifesto pode ser
 * publicado so com o essencial (versao e URL) e ganhar os dois depois, sem
 * quebrar quem ja consulta. Quando ausentes, a verificacao de integridade do
 * arquivo baixado simplesmente nao roda para aquele campo.
 */
data class PlatformUpdate(
    val versionName: String,
    val versionCode: Int,
    val url: String,
    val size: Long?,
    val sha256: String?,
)

data class UpdateManifest(
    val schemaVersion: Int,
    val android: PlatformUpdate?,
    val androidTv: PlatformUpdate?,
)

/** As duas plataformas que consultam este manifesto. `chave` e o nome do campo no JSON. */
enum class Plataforma(val chave: String) {
    ANDROID("android"),
    ANDROID_TV("androidTv"),
}

private val SHA256_HEX = Regex("^[0-9a-f]{64}$")

/**
 * Le o manifesto central de atualizacao (hospedado no R2, ver
 * docs/auto-atualizacao.md).
 *
 * Cada plataforma e opcional de proposito: publicar so o Android, por
 * exemplo, nao pode invalidar o manifesto inteiro para a TV. Uma entrada
 * malformada — URL vazia, sem HTTPS, versionCode invalido — e tratada como
 * ausente, nunca como erro fatal: o resto do manifesto continua valendo, e
 * quem pediu aquela plataforma especifica ve "nada publicado" em vez de uma
 * excecao.
 *
 * So o JSON de nivel superior ilegivel e que interrompe a leitura — isso sim
 * significa que o manifesto inteiro nao pode ser confiado.
 */
object UpdateManifestParser {

    fun parse(texto: String): UpdateManifest {
        val raiz = try {
            JSONObject(texto)
        } catch (e: JSONException) {
            throw IllegalArgumentException("manifesto nao e JSON valido: ${e.message}", e)
        }
        return UpdateManifest(
            schemaVersion = raiz.optInt("schemaVersion", 1),
            android = plataforma(raiz.optJSONObject("android")),
            androidTv = plataforma(raiz.optJSONObject("androidTv")),
        )
    }

    private fun plataforma(objeto: JSONObject?): PlatformUpdate? {
        objeto ?: return null
        val versionName = objeto.optString("versionName", "").trim()
        val versionCode = objeto.optInt("versionCode", -1)
        // https:// obrigatorio aqui, nao so por convencao: e a unica coisa que
        // impede um manifesto comprometido de apontar a instalacao para um
        // host que responde em texto claro.
        val url = objeto.optString("url", "").trim()
        if (versionName.isEmpty() || versionCode <= 0 || !url.startsWith("https://")) return null

        val size = objeto.optLong("size", -1L).takeIf { it > 0 }
        val sha256 = objeto.optString("sha256", "").trim().lowercase()
            .takeIf { SHA256_HEX.matches(it) }

        return PlatformUpdate(versionName, versionCode, url, size, sha256)
    }
}
