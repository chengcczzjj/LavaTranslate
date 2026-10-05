package com.lavatranslate.app.web

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import org.json.JSONObject
import java.io.ByteArrayInputStream

/**
 * 原生 ↔ 网页的消息通道（WebMessageListener）。
 * 网页发：{id, m: 方法名, a: 参数}，有 id 的要回 {id, ok, r | e}；原生主动推送：{ev: 事件名, d: 数据}。
 * 页面从 https://appassets.androidplatform.net/web/ 加载（本地 assets），只有这个来源能用 lava 通道。
 */
class Bridge(private val web: WebView, private val handle: (m: String, a: JSONObject, reply: Reply) -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private var proxy: JavaScriptReplyProxy? = null
    private val queue = ArrayList<String>()

    init {
        WebViewCompat.addWebMessageListener(web, "lava", setOf(ORIGIN)) { _, message, _, _, replyProxy ->
            if (proxy !== replyProxy) {
                proxy = replyProxy
                queue.forEach { replyProxy.postMessage(it) }
                queue.clear()
            }
            val msg = try {
                JSONObject(message.data ?: return@addWebMessageListener)
            } catch (_: Exception) {
                return@addWebMessageListener
            }
            val reply = Reply(msg.optInt("id", 0))
            try {
                handle(msg.optString("m"), msg.optJSONObject("a") ?: JSONObject(), reply)
            } catch (e: Exception) {
                reply.err(e.message ?: e.toString())
            }
        }
    }

    /** 推送事件（任意线程） */
    fun emit(event: String, data: Any? = null) = post(JSONObject().put("ev", event).put("d", data ?: JSONObject.NULL).toString())

    /** 页面重新加载后旧的通道失效 */
    fun reset() = main.post { proxy = null }

    private fun post(s: String) = main.post {
        val p = proxy
        if (p == null) queue.add(s) else p.postMessage(s)
    }

    inner class Reply(private val id: Int) {
        fun ok(result: Any? = null) {
            if (id != 0) post(JSONObject().put("id", id).put("ok", true).put("r", result ?: JSONObject.NULL).toString())
        }

        fun err(message: String) {
            if (id != 0) post(JSONObject().put("id", id).put("ok", false).put("e", message).toString())
        }
    }

    companion object {
        const val ORIGIN = "https://appassets.androidplatform.net"
    }
}

/** 截图帧：网页用 fetch('/frame/<id>') 直接取 RGBA 原始像素，不走消息通道 */
object FrameStore {
    @Volatile
    var current: com.lavatranslate.app.capture.Frame? = null

    /** 调试版保留最近一帧，用于 OCR 性能对比 */
    @Volatile
    var last: com.lavatranslate.app.capture.Frame? = null
}

@SuppressLint("SetJavaScriptEnabled")
fun createWebView(ctx: Context, page: String, transparent: Boolean): WebView {
    // 放在这里而不是 Application.onCreate：它会载入整个 WebView 引擎，只开着无障碍截屏的进程用不到
    WebView.setWebContentsDebuggingEnabled(com.lavatranslate.app.BuildConfig.DEBUG)
    val assets = WebViewAssetLoader.AssetsPathHandler(ctx)
    val loader = WebViewAssetLoader.Builder()
        // 路径相对于前缀：/web/x → assets/web/x
        .addPathHandler("/web/") { path -> assets.handle("web/$path") }
        .addPathHandler("/frame/") { path ->
            val f = FrameStore.current
            if (f == null || path.substringBefore('?') != f.id.toString()) null
            else WebResourceResponse("application/octet-stream", null, ByteArrayInputStream(f.rgba)).apply {
                responseHeaders = mapOf("Cache-Control" to "no-store")
            }
        }
        .build()
    return WebView(ctx).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.textZoom = 100
        settings.mediaPlaybackRequiresUserGesture = false
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        overScrollMode = WebView.OVER_SCROLL_NEVER
        if (transparent) setBackgroundColor(Color.TRANSPARENT)
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // 页面里的外部链接（获取 Key 的网页等）交给浏览器
                val url = request.url
                if (url.host == Uri.parse(Bridge.ORIGIN).host) return false
                ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, url).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
                return true
            }
        }
        loadUrl("${Bridge.ORIGIN}/web/$page")
    }
}
