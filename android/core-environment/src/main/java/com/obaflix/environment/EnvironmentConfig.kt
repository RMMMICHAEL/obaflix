package com.obaflix.environment

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader

data class Condition(val type: String, val operator: String, val value: Any)

data class TargetSpec(
    val id: String,
    val from: String?,
    val to: String?
)

data class Rule(
    val id: String,
    val description: String,
    val conditions: List<Condition>,
    val action: String,
    val targets: List<TargetSpec>
)

class EnvironmentConfig(private val context: Context) {

    private var rules: List<Rule> = emptyList()

    fun load() {
        try {
            val input = context.assets.open("environment_config.json")
            val reader = BufferedReader(InputStreamReader(input))
            val json = reader.readText()
            reader.close()

            val obj = JSONObject(json)
            val arr = obj.getJSONArray("rules")

            val parsedRules = mutableListOf<Rule>()

            for (i in 0 until arr.length()) {
                val r = arr.getJSONObject(i)
                val ruleId = r.getString("id")

                try {
                    val conds = r.getJSONArray("conditions")
                    val targetsArr = r.getJSONArray("targets")

                    val conditions = (0 until conds.length()).map { j ->
                        val c = conds.getJSONObject(j)
                        Condition(c.getString("type"), c.getString("operator"), c.get("value"))
                    }

                    // CORRECAO 4: valida cada target. Se um for invalido,
                    // descarta a regra inteira (nao aceita silenciosamente).
                    val targets = mutableListOf<TargetSpec>()
                    for (k in 0 until targetsArr.length()) {
                        val spec = parseTarget(targetsArr.get(k))
                        if (spec == null) {
                            Log.w("ObaflixEnvConfig", "Regra '$ruleId': target [$k] invalido. Regra descartada.")
                            targets.clear()
                            break
                        }
                        targets.add(spec)
                    }

                    if (targets.isNotEmpty()) {
                        parsedRules.add(
                            Rule(
                                id = ruleId,
                                description = r.getString("description"),
                                conditions = conditions,
                                action = r.getString("action"),
                                targets = targets
                            )
                        )
                    }
                } catch (e: Exception) {
                    Log.w("ObaflixEnvConfig", "Regra '$ruleId' invalida: ${e.message}. Descartada.")
                }
            }

            rules = parsedRules
        } catch (e: Exception) {
            Log.e("ObaflixEnvConfig", "Falha ao carregar config: ${e.message}")
            rules = emptyList()
        }
    }

    // CORRECAO 4: retorna null para target invalido
    private fun parseTarget(value: Any): TargetSpec? {
        return when (value) {
            is String -> {
                if (value.isBlank()) null
                else TargetSpec(id = value, from = null, to = null)
            }
            is JSONObject -> {
                val from = value.optString("from", "")
                val to = value.optString("to", "")
                if (from.isBlank() || to.isBlank()) {
                    Log.w("ObaflixEnvConfig", "Target {from,to} incompleto: from='$from' to='$to'")
                    null
                } else {
                    TargetSpec(id = value.optString("id", ""), from = from, to = to)
                }
            }
            else -> {
                Log.w("ObaflixEnvConfig", "Tipo de target inesperado: ${value.javaClass.simpleName}")
                null
            }
        }
    }

    fun shouldApply(rule: Rule, env: EnvironmentState): Boolean {
        return rule.conditions.all { c ->
            when (c.type) {
                "vpn" -> evalBool(c, env.isVpn)
                "emulator" -> evalBool(c, env.isEmulator)
                "region" -> evalRegion(c, env.region)
                "review_mode" -> evalBool(c, env.isReviewMode)
                else -> false
            }
        }
    }

    private fun evalBool(c: Condition, actual: Boolean): Boolean {
        val expected = c.value as? Boolean ?: false
        return when (c.operator) {
            "is" -> actual == expected
            "is_not" -> actual != expected
            else -> false
        }
    }

    private fun evalRegion(c: Condition, actual: String?): Boolean {
        if (actual == null) return false
        val regions = when (val v = c.value) {
            is JSONArray -> (0 until v.length()).map { v.getString(it) }
            is List<*> -> v.map { it.toString() }
            else -> return false
        }
        return when (c.operator) {
            "in" -> regions.any { it.uppercase() == actual }
            "not_in" -> regions.none { it.uppercase() == actual }
            else -> false
        }
    }

    fun getActiveRules(env: EnvironmentState): List<Rule> = rules.filter { shouldApply(it, env) }
}
