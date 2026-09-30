package com.obaflix.environment

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader

data class Condition(val type: String, val operator: String, val value: Any)

data class Rule(
    val id: String,
    val description: String,
    val conditions: List<Condition>,
    val action: String,
    val targets: List<String>
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
            rules = (0 until arr.length()).map { i ->
                val r = arr.getJSONObject(i)
                val conds = r.getJSONArray("conditions")
                val targetsArr = r.getJSONArray("targets")
                Rule(
                    id = r.getString("id"),
                    description = r.getString("description"),
                    conditions = (0 until conds.length()).map { j ->
                        val c = conds.getJSONObject(j)
                        Condition(c.getString("type"), c.getString("operator"), c.get("value"))
                    },
                    action = r.getString("action"),
                    targets = (0 until targetsArr.length()).map { k -> targetsArr.getString(k) }
                )
            }
        } catch (_: Exception) {
            rules = emptyList()
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
        // Converte JSONArray em List<String>
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