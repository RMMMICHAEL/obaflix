package com.nuvio.android

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.nuvio.app.integration.obaflix.ads.ObaflixRewardedHomologacao

/** DEBUG-only Rewarded test screen (Galaxy S9+). Lives in the debug source set, so release has no such component. */
class RewardedHomologActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var status: TextView
    private lateinit var log: TextView
    private lateinit var exibir: Button

    private val refresh = object : Runnable {
        override fun run() {
            status.text = "LevelPlay pronto: ${ObaflixRewardedHomologacao.sdkPronto()}   Rewarded pronto: ${ObaflixRewardedHomologacao.rewardedPronto()}"
            exibir.isEnabled = ObaflixRewardedHomologacao.rewardedPronto() // only when loaded; never auto-shows
            log.text = ObaflixRewardedHomologacao.linhas.value.joinToString("\n")
            main.postDelayed(this, 500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        root.addView(TextView(this).apply { text = "Obaflix - Rewarded HML (DEBUG)\nNada e liberado por este teste." })
        status = TextView(this).also { root.addView(it) }
        fun botao(titulo: String, acao: () -> Unit) = Button(this).apply {
            text = titulo
            setOnClickListener { acao() }
            root.addView(this, ViewGroup.LayoutParams(-1, -2))
        }
        botao("1. Inicializar LevelPlay") { ObaflixRewardedHomologacao.iniciar(this) }
        botao("2. Recarregar manualmente") { ObaflixRewardedHomologacao.carregar(this) }
        exibir = botao("3. Exibir Rewarded (so quando pronto)") { ObaflixRewardedHomologacao.exibir(this) }
            .also { it.isEnabled = false }
        botao("Test Suite LevelPlay") { ObaflixRewardedHomologacao.abrirTestSuite(this) }
        log = TextView(this).apply { textSize = 12f }
        root.addView(ScrollView(this).apply { addView(log) }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
    }

    override fun onResume() { super.onResume(); main.post(refresh) }
    override fun onPause() { main.removeCallbacks(refresh); super.onPause() }
}
