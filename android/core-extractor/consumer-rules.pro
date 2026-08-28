# Regras que viajam junto com o modulo — aplicadas no R8 de quem o consome.
# Antes viviam so no app/proguard-rules.pro; aqui elas acompanham o codigo, e o
# app de TV as recebe sem ninguem precisar lembrar de copiar.

# A ponte JS e chamada por nome a partir do JavaScript. Sem isto o R8 renomeia
# os metodos e a extracao para de responder — falha silenciosa, so em release.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

-dontwarn okhttp3.**
-dontwarn okio.**
