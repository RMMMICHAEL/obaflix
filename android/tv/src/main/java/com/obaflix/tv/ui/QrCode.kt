package com.obaflix.tv.ui

import android.graphics.Bitmap
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * QR Code desenhado na TV.
 *
 * Detalhes que decidem se a camera do celular consegue ler de longe:
 *
 *  - Correcao de erro em nivel M. Alta (H) engrossaria os modulos sem ganho:
 *    a tela nao suja nem amassa como papel, e o que atrapalha aqui e reflexo,
 *    nao dano.
 *  - Margem branca de 2 modulos. Sem a zona silenciosa a leitura falha, e o
 *    padrao do zxing (4) desperdicaria area util numa tela ja distante.
 *  - Fundo branco solido, mesmo num tema escuro. Camera de celular tem muito
 *    mais dificuldade com QR invertido do que a especificacao sugere.
 */
private const val BRANCO = 0xFFFFFFFF.toInt()
private const val PRETO = 0xFF000000.toInt()

@Composable
fun lembrarQrCode(conteudo: String, ladoPx: Int): ImageBitmap? =
    remember(conteudo, ladoPx) { gerarQrCode(conteudo, ladoPx)?.asImageBitmap() }

private fun gerarQrCode(conteudo: String, ladoPx: Int): Bitmap? = runCatching {
    val hints = mapOf(
        EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
        EncodeHintType.MARGIN to 2,
        EncodeHintType.CHARACTER_SET to "UTF-8",
    )
    val matriz = QRCodeWriter().encode(conteudo, BarcodeFormat.QR_CODE, ladoPx, ladoPx, hints)

    val largura = matriz.width
    val altura = matriz.height
    val pixels = IntArray(largura * altura)
    for (y in 0 until altura) {
        val linha = y * largura
        for (x in 0 until largura) {
            pixels[linha + x] = if (matriz[x, y]) PRETO else BRANCO
        }
    }
    Bitmap.createBitmap(pixels, largura, altura, Bitmap.Config.ARGB_8888)
}.getOrNull()
