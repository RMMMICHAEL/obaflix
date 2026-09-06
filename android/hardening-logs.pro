# Remocao dos logs de desenvolvimento no release.
#
# Vive separado de hardening-rules.pro por um motivo so: e a UNICA regra do
# hardening que precisa poder ficar de fora. Validar o fluxo de anuncio num APK
# de producao (anuncio real, minificado, assinado) exige ver a trilha do ObaLog
# — ads_hold_armed, ads_episode_intent, ads_dismiss_confirmed, unity_init_start
# —, e ela sai toda por Log.d. Com estas linhas aplicadas, R8 apaga as chamadas
# e o aparelho fica mudo mesmo com BuildConfig.DIAG_LOGS ligado.
#
# Quem aplica:
#
#   :app  — sempre, EXCETO com -PdiagLogs (ver app/build.gradle)
#   :tv   — sempre, sem excecao (comportamento inalterado)
#
# Warn/Error nunca sao removidos, aqui ou la: ObaLog.alerta e ObaLog.falha
# continuam saindo em qualquer release. O proprio ObaLog ainda aplica
# higienizacao de URL/token antes de escrever qualquer linha.

-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
}
