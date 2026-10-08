package com.lavatranslate.app.web

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View
import com.lavatranslate.app.LavaApp
import org.json.JSONObject

/** 翻译界面网页的通用方法（两种宿主共用）：复制、改设置、震动、代发模型请求。处理了返回 true */
object CommonBridge {
    fun handle(ctx: Context, root: View, bridge: Bridge, m: String, a: JSONObject, reply: Bridge.Reply): Boolean {
        val app = LavaApp.instance
        when (m) {
            "copy" -> {
                ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("LavaTranslate", a.optString("text")))
                reply.ok()
            }
            "settings" -> reply.ok(app.settings.update(a))
            "haptic" -> {
                root.performHapticFeedback(
                    when (a.optString("kind")) {
                        "long" -> HapticFeedbackConstants.LONG_PRESS
                        "confirm" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
                        else -> HapticFeedbackConstants.CLOCK_TICK
                    }
                )
                reply.ok()
            }
            "net.req" -> app.net.request(bridge, a)
            "net.abort" -> app.net.abort(a.optString("rid"))
            "preconnect" -> app.net.preconnect(a.optString("url"))
            else -> return false
        }
        return true
    }
}
