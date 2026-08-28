# As regras da ponte JS e do OkHttp chegam pelo consumer-rules.pro do
# :core-extractor — nao ha copia a manter aqui.

# O androidx.security depende do Tink, que referencia anotacoes do ErrorProne.
# Sao anotacoes de tempo de compilacao (@Immutable, @CanIgnoreReturnValue e
# afins): nao existem em runtime e nada as le. Silenciar e o tratamento correto —
# empacota-las so aumentaria o APK sem mudar comportamento nenhum.
-dontwarn com.google.errorprone.annotations.**

# O ZXing traz suporte opcional a JavaSE/AWT que nao existe no Android. Usamos
# apenas o codificador de QR, que e Java puro e nao toca nessas classes.
-dontwarn java.awt.**
-dontwarn javax.imageio.**
