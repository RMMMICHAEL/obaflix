# Regras comuns aos APKs móvel e TV: os dois módulos a carregam no release.
-allowaccessmodification
-repackageclasses 'com.obaflix.internal'
-keepattributes LineNumberTable,Signature,InnerClasses,EnclosingMethod
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations,AnnotationDefault
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
}
