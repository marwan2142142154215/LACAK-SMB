# Socket.IO / Engine.IO pakai reflection untuk sebagian parsing JSON internal.
-keep class io.socket.** { *; }
-dontwarn io.socket.**

# OkHttp/Okio platform-specific classes yang tidak relevan untuk Android.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
