package com.nuvio.app.integration.obaflix

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Offers (CTA and "REMOVER ANÚNCIOS") exist only for an account the server says must see ads, on a build that may sell,
 * and never for an account already known to be exempt. Nothing local (plan name, preference) decides this.
 */
@Composable
internal fun obaflixPremiumOfferVisible(): Boolean {
    val adsRequired by ObaflixRights.adsRequired.collectAsState()
    val offer by ObaflixRights.offer.collectAsState()
    val eligibility by ObaflixAdEligibility.flow.collectAsState()
    LaunchedEffect(Unit) { ObaflixRights.ensureLoaded() }
    return ObaflixPremium.purchasesEnabled && adsRequired == true && offer != null &&
        eligibility != ObaflixAdEligibility.State.INELIGIBLE
}

/** The single reusable "SEJA PREMIUM" banner (Home, Search, Library). Draws nothing, and takes no space, when not offered. */
@Composable
internal fun ObaflixPremiumCta(modifier: Modifier = Modifier, horizontalPadding: androidx.compose.ui.unit.Dp = 16.dp) {
    if (!obaflixPremiumOfferVisible()) return
    val shape = RoundedCornerShape(22.dp)
    Box(modifier = modifier.fillMaxWidth().padding(horizontal = horizontalPadding, vertical = 8.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp)
                .clip(shape)
                .background(Brush.horizontalGradient(listOf(Color(0xFFC62828), Color(0xFF4A0B0B))))
                .background(Brush.radialGradient(listOf(Color.White.copy(alpha = 0.14f), Color.Transparent), center = Offset(80f, 0f), radius = 420f))
                .clickable { ObaflixPremium.open() }
                .padding(horizontal = 18.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CrownIcon(Modifier.size(30.dp))
            Spacer(Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text("SEJA PREMIUM", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 17.sp, maxLines = 1)
                Text(if (ObaflixPremium.demoMode) "Remova os anúncios \u00b7 DEMO" else "Remova os anúncios", color = Color.White.copy(alpha = 0.88f), fontSize = 13.sp, maxLines = 1)
            }
            Text("›", color = Color.White, fontSize = 30.sp)
        }
    }
}

@Composable
private fun CrownIcon(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val crown = Path().apply {
            moveTo(w * 0.08f, h * 0.78f)
            lineTo(w * 0.04f, h * 0.28f)
            lineTo(w * 0.30f, h * 0.52f)
            lineTo(w * 0.50f, h * 0.16f)
            lineTo(w * 0.70f, h * 0.52f)
            lineTo(w * 0.96f, h * 0.28f)
            lineTo(w * 0.92f, h * 0.78f)
            close()
        }
        drawPath(crown, Color.White)
        drawRect(Color.White, topLeft = Offset(w * 0.08f, h * 0.84f), size = androidx.compose.ui.geometry.Size(w * 0.84f, h * 0.10f))
    }
}

/** The simple sales page and the existing Pix checkout, as a screen layer above the app. */
@Composable
internal fun ObaflixPremiumHost(modifier: Modifier = Modifier) {
    val open by ObaflixPremium.pageOpen.collectAsState()
    if (!open) return
    val state by ObaflixPremium.checkout.collectAsState()
    val offer by ObaflixRights.offer.collectAsState()
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color(0xFF101010))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
    ) {
        TextButton(onClick = { ObaflixPremium.close() }, modifier = Modifier.align(Alignment.TopEnd).padding(8.dp)) {
            Text("✕", color = Color.White, fontSize = 22.sp)
        }
        Column(
            modifier = Modifier.align(Alignment.Center).padding(28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            when (val s = state) {
                PremiumCheckout.Sales -> {
                    CrownIcon(Modifier.size(48.dp))
                    Text("Premium Obaflix", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 26.sp)
                    Text("Remova os anúncios", color = Color.White.copy(alpha = 0.85f), fontSize = 16.sp)
                    offer?.let {
                        Text(it.priceLabel, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 34.sp)
                        Text(
                            "Pagamento único via Pix por ${it.periodLabel}. Não renova automaticamente.",
                            color = Color.White.copy(alpha = 0.7f), fontSize = 13.sp, textAlign = TextAlign.Center,
                        )
                    }
                    if (ObaflixPremium.demoMode) {
                        Text("MODO DEMONSTRATIVO \u2014 pagamento desativado", color = Color(0xFFFF8A80), fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                    }
                    Button(onClick = { ObaflixPremium.toForm() }, enabled = offer != null && !ObaflixPremium.demoMode) { Text("Continuar para o pagamento") }
                }
                is PremiumCheckout.Form -> PixForm(s.error)
                PremiumCheckout.Creating -> {
                    CircularProgressIndicator(color = Color.White)
                    Text("Gerando o Pix…", color = Color.White)
                }
                is PremiumCheckout.Waiting -> PixWaiting(s.pixCode)
                PremiumCheckout.Paid -> {
                    Text("Premium ativado", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 24.sp)
                    Text("Os anúncios foram removidos da sua conta.", color = Color.White.copy(alpha = 0.85f), textAlign = TextAlign.Center)
                    Button(onClick = { ObaflixPremium.close() }) { Text("Fechar") }
                }
                is PremiumCheckout.Failed -> {
                    Text(s.message, color = Color.White, textAlign = TextAlign.Center)
                    Button(onClick = { ObaflixPremium.toForm() }) { Text("Gerar novo Pix") }
                }
            }
        }
    }
}

@Composable
private fun PixForm(error: String?) {
    var document by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    Text("Dados para o Pix", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 20.sp)
    OutlinedTextField(document, { document = it }, label = { Text("CPF ou CNPJ") }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
    OutlinedTextField(phone, { phone = it }, label = { Text("Telefone com DDD") }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone))
    OutlinedTextField(name, { name = it }, label = { Text("Nome (se sua conta não tiver)") }, singleLine = true)
    error?.let { Text(it, color = Color(0xFFFF8A80), textAlign = TextAlign.Center) }
    Button(onClick = { ObaflixPremium.submit(document, phone, name) }) { Text("Gerar Pix") }
}

@Composable
private fun PixWaiting(code: String) {
    val clipboard = LocalClipboardManager.current
    Text("Pague com Pix", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 20.sp)
    Text(code, color = Color.White.copy(alpha = 0.8f), fontSize = 11.sp, maxLines = 4, textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth())
    Button(onClick = { clipboard.setText(AnnotatedString(code)) }) { Text("Copiar código Pix") }
    CircularProgressIndicator(color = Color.White, modifier = Modifier.size(28.dp))
    Text("Aguardando a confirmação do pagamento…", color = Color.White.copy(alpha = 0.8f), textAlign = TextAlign.Center)
}
