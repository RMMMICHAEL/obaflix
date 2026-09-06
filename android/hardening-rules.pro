# Hardening comum aos aplicativos movel e TV.
#
# O arquivo padrao proguard-android-optimize ja faz shrinking, otimizacao e
# ofuscacao. Estas regras apertam a superficie sem manter pacotes inteiros e sem
# alterar pontos acessados por nome (manifest, JavascriptInterface e bibliotecas
# com consumer rules cuidam dos proprios contratos).

# Permite ao R8 fundir mais classes e remover acessores sinteticos.
-allowaccessmodification

# Move classes ofuscadas para um namespace neutro. Isso esconde a estrutura de
# pacotes original; componentes Android declarados no manifest sao adaptados
# automaticamente pelo Android Gradle Plugin.
-repackageclasses 'com.obaflix.internal'

# Mantem so os atributos necessarios a reflexao e ao retrace. SourceFile e a
# extensao de debug do Kotlin nao entram no APK; LineNumberTable preserva a
# capacidade de simbolizar crashes com mapping.txt.
-keepattributes LineNumberTable,Signature,InnerClasses,EnclosingMethod
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations,AnnotationDefault

# Verbosidade de desenvolvimento nao deve sobreviver a um release. Warn/Error
# continuam disponiveis quando -PdiagLogs e usado; o proprio ObaLog ainda aplica
# higienizacao de URL/token.
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
}
