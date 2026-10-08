package com.lavatranslate.app

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.lavatranslate.app.capture.LavaAccessibilityService

/** 下拉快捷开关「翻译屏幕」：收起通知栏后翻译当前屏幕 */
class TranslateTileService : LavaTile(quick = false)

/** 下拉快捷开关「快捷回复」：收起通知栏后打开输入翻译（不截屏），回复外语聊天用 */
class QuickReplyTileService : LavaTile(quick = true)

abstract class LavaTile(private val quick: Boolean) : TileService() {
    override fun onStartListening() {
        qsTile?.apply {
            state = Tile.STATE_INACTIVE
            updateTile()
        }
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    override fun onClick() {
        // 无障碍模式：直接让服务收起通知栏再开始，不经过中转页面
        val svc = LavaAccessibilityService.instance
        if (svc != null && Build.VERSION.SDK_INT >= 31) {
            if (quick) svc.quickFromShade() else svc.translateFromShade()
            return
        }
        // 否则经由透明中转页：打开页面会让通知栏收起
        val intent = Intent(this, ConsentActivity::class.java)
            .putExtra(if (quick) ConsentActivity.EXTRA_QUICK else ConsentActivity.EXTRA_TRANSLATE, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, if (quick) 1 else 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
