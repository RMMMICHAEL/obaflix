package com.obaflix.download

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.documentfile.provider.DocumentFile

/**
 * A pasta de downloads escolhida pelo usuario, via Storage Access Framework.
 *
 * ## Por que SAF e nao permissao de armazenamento
 *
 * `ACTION_OPEN_DOCUMENT_TREE` da acesso **so** a arvore que a pessoa apontou, e
 * o proprio sistema desenha o seletor. Nao ha `READ_EXTERNAL_STORAGE`,
 * `WRITE_EXTERNAL_STORAGE` nem `MANAGE_EXTERNAL_STORAGE` no manifesto — o app
 * nao consegue ler nada fora da pasta escolhida, e isso e verificavel olhando
 * o manifesto. Nas versoes recentes do Android essas permissoes legadas nem
 * concederiam acesso amplo de qualquer forma.
 *
 * `takePersistableUriPermission` faz a concessao sobreviver a reinicio do
 * aparelho, entao a pergunta acontece **uma vez**, nao a cada download.
 */
object DownloadFolder {

    private const val PREFS = "obaflix_downloads"
    private const val CHAVE_ARVORE = "arvore_uri"

    /** Intent do seletor nativo de diretorio. Quem lanca e a Activity. */
    fun intentDeEscolha(): Intent =
        Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
        }

    /**
     * Guarda a arvore escolhida e pede a concessao persistente.
     *
     * Devolve false quando o sistema recusa persistir — acontece com alguns
     * provedores de documentos de terceiros. Nesse caso nada e gravado, e a
     * proxima tentativa de download volta a perguntar, que e o comportamento
     * honesto: fingir que temos acesso daria erro so na hora de escrever.
     */
    fun guardar(context: Context, tree: Uri): Boolean {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        val ok = runCatching {
            context.contentResolver.takePersistableUriPermission(tree, flags)
        }.isSuccess
        if (!ok) return false
        prefs(context).edit().putString(CHAVE_ARVORE, tree.toString()).apply()
        return true
    }

    /** A arvore guardada, ou null se nunca escolheram uma. */
    fun uriGuardada(context: Context): Uri? =
        prefs(context).getString(CHAVE_ARVORE, null)?.let(Uri::parse)

    /**
     * A arvore guardada **que ainda vale**.
     *
     * A concessao pode sumir sem aviso: o usuario limpa os dados do app,
     * desmonta o cartao SD, apaga a pasta, ou revoga o acesso nas
     * configuracoes. Perguntar ao ContentResolver quais concessoes ainda
     * existem e a unica forma confiavel de saber — um `DocumentFile` sobre uma
     * URI revogada nao lanca, so devolve `exists() == false`, que se confunde
     * com "a pasta foi apagada".
     */
    fun arvoreValida(context: Context): DocumentFile? {
        val uri = uriGuardada(context) ?: return null
        val temConcessao = runCatching {
            context.contentResolver.persistedUriPermissions.any {
                it.uri == uri && it.isWritePermission
            }
        }.getOrDefault(false)
        if (!temConcessao) return null

        val doc = runCatching { DocumentFile.fromTreeUri(context, uri) }.getOrNull()
        return doc?.takeIf { it.isDirectory && it.canWrite() }
    }

    fun temPastaValida(context: Context): Boolean = arvoreValida(context) != null

    /** Esquece a arvore guardada. Nao revoga nada — so para de tentar usa-la. */
    fun esquecer(context: Context) {
        prefs(context).edit().remove(CHAVE_ARVORE).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * Caracteres que nao podem entrar num nome de arquivo.
     *
     * Cobre o que o SAF recusa e o que o FAT32 do cartao SD recusa — a uniao
     * dos dois, porque a pasta escolhida pode estar em qualquer um.
     */
    private val PROIBIDOS = charArrayOf('\\', '/', ':', '*', '?', '"', '<', '>', '|')

    /**
     * Nome de arquivo seguro a partir de um titulo livre.
     *
     * Sem expressao regular de proposito: a classe de caracteres precisaria
     * escapar barra invertida, aspas e um intervalo de controle, e um escape
     * perdido aqui nao daria erro — geraria um nome que o provedor de
     * documentos recusa so na hora de gravar, com o download ja em andamento.
     * A comparacao caractere a caractere nao tem esse modo de falha.
     *
     * O titulo vem do catalogo, entao tambem limita o tamanho: alguns
     * provedores de documentos truncam em silencio e produzem colisao entre
     * dois episodios de nome parecido.
     */
    fun nomeSeguro(titulo: String, extensao: String): String {
        val limpo = StringBuilder(titulo.length)
        var espacoPendente = false
        for (c in titulo) {
            val invalido = c.code < 0x20 || c in PROIBIDOS
            if (invalido || c == ' ') {
                espacoPendente = limpo.isNotEmpty()
                continue
            }
            if (espacoPendente) {
                limpo.append(' ')
                espacoPendente = false
            }
            limpo.append(c)
        }
        val base = limpo.toString()
            .trimEnd('.')
            .take(100)
            .trim()
            .ifBlank { "video" }
        return "$base.$extensao"
    }
}
