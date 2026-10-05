package com.lavatranslate.app.web

import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * 网页里的模型请求由这里代发（WebView 里直接请求各家接口会被跨域拦截）：
 * 网页侧的 fetch 替身见 src/mobile/src/bridge.ts。响应头、正文分段（流式）、结束 / 出错都以 net 事件推回网页。
 */
class NetBridge {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.SECONDS)
        .build()
    private val calls = ConcurrentHashMap<String, Call>()

    fun request(bridge: Bridge, a: JSONObject) {
        val rid = a.getString("rid")
        val emit = { d: JSONObject -> bridge.emit("net", d.put("rid", rid)) }
        val method = a.optString("method", "GET").uppercase()
        val headers = a.optJSONObject("headers") ?: JSONObject()
        val b = Request.Builder().url(a.getString("url"))
        var contentType: String? = null
        for (k in headers.keys()) {
            val lk = k.lowercase()
            // 压缩由 OkHttp 自己协商并解压；长度、连接由 OkHttp 管理
            if (lk in SKIP) continue
            if (lk == "content-type") contentType = headers.getString(k)
            b.header(k, headers.getString(k))
        }
        val body = if (a.isNull("body")) null else a.getString("body")
        val reqBody = when {
            body != null -> body.toRequestBody(contentType?.toMediaTypeOrNull())
            method in setOf("POST", "PUT", "PATCH") -> ByteArray(0).toRequestBody(null)
            else -> null
        }
        val call = client.newCall(b.method(method, reqBody).build())
        calls[rid] = call
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                calls.remove(rid)
                if (!call.isCanceled()) emit(JSONObject().put("t", "err").put("msg", e.message ?: "网络错误"))
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { res ->
                    val hs = JSONObject()
                    for (name in res.headers.names()) hs.put(name, res.headers.values(name).joinToString(", "))
                    emit(JSONObject().put("t", "head").put("status", res.code).put("statusText", res.message).put("headers", hs))
                    try {
                        val reader = res.body.byteStream().reader(Charsets.UTF_8)
                        val buf = CharArray(8192)
                        while (true) {
                            val n = reader.read(buf)
                            if (n < 0) break
                            if (n > 0) emit(JSONObject().put("t", "data").put("s", String(buf, 0, n)))
                        }
                        emit(JSONObject().put("t", "end"))
                    } catch (e: IOException) {
                        if (!call.isCanceled()) emit(JSONObject().put("t", "err").put("msg", e.message ?: "连接中断"))
                    } finally {
                        calls.remove(rid)
                    }
                }
            }
        })
    }

    fun abort(rid: String) {
        calls.remove(rid)?.cancel()
    }

    /** 提前建立到接口地址的连接（TLS 握手）：发一个 HEAD 请求，连接留在连接池里 */
    fun preconnect(url: String) {
        try {
            val u = url.toHttpUrlOrNull()?.newBuilder()?.encodedPath("/")?.query(null)?.build() ?: return
            client.newCall(Request.Builder().url(u).head().build()).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {}
                override fun onResponse(call: Call, response: Response) = response.close()
            })
        } catch (_: Exception) {
        }
    }

    companion object {
        private val SKIP = setOf("accept-encoding", "content-length", "host", "connection")
    }
}
