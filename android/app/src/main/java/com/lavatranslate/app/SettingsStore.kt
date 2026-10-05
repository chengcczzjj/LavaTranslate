package com.lavatranslate.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.util.concurrent.CopyOnWriteArraySet
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 设置：JSON 文件放在应用私有目录。结构与桌面版一致（provider + providers[id] = {key, baseUrl, model}），
 * 另加手机专属的截屏方式与悬浮球位置。API Key 用 Android Keystore 里不可导出的 AES 密钥加密，
 * 设置页拿到的是打码形式；翻译界面需要明文时用 [plain]。服务商目录（默认地址等）只在网页里，这里不关心。
 */
class SettingsStore(ctx: Context) {
    private val file = File(ctx.filesDir, "settings.json")
    private val lock = Any()
    private var data: JSONObject = load()
    private val listeners = CopyOnWriteArraySet<() -> Unit>()

    private fun load(): JSONObject {
        val raw = try {
            JSONObject(file.readText())
        } catch (_: Exception) {
            JSONObject()
        }
        val d = JSONObject(DEFAULTS.toString())
        for (k in raw.keys()) d.put(k, raw.get(k))
        return d
    }

    private fun write() {
        val tmp = File(file.path + ".tmp")
        tmp.writeText(data.toString(2))
        tmp.renameTo(file)
    }

    /** 给设置页：Key 打码 */
    fun public(): JSONObject = synchronized(lock) { mapKeys(Secrets::mask) }

    /** 给翻译界面：Key 解密 */
    fun plain(): JSONObject = synchronized(lock) { mapKeys(Secrets::decrypt) }

    private fun mapKeys(f: (String) -> String): JSONObject {
        val out = JSONObject(data.toString())
        val ps = out.optJSONObject("providers") ?: return out
        for (id in ps.keys()) {
            val c = ps.optJSONObject(id) ?: continue
            c.put("key", f(c.optString("key")))
        }
        return out
    }

    /** providers 按服务商逐项合并；设置页回传的打码 Key 表示未修改（与桌面版 settings.update 一致） */
    fun update(patch: JSONObject): JSONObject {
        synchronized(lock) {
            for (k in patch.keys()) {
                if (k != "providers") {
                    data.put(k, patch.get(k))
                    continue
                }
                val pp = patch.optJSONObject("providers") ?: continue
                val providers = data.optJSONObject("providers") ?: JSONObject().also { data.put("providers", it) }
                for (id in pp.keys()) {
                    val c = pp.optJSONObject(id) ?: continue
                    val prev = providers.optJSONObject(id)
                    val next = JSONObject().put("key", "").put("baseUrl", "").put("model", "")
                    prev?.keys()?.forEach { next.put(it, prev.get(it)) }
                    for (f in c.keys()) {
                        when (f) {
                            "key" -> {
                                val v = c.optString("key")
                                next.put("key", if (Secrets.isMasked(v)) prev?.optString("key") ?: "" else Secrets.encrypt(v.trim()))
                            }
                            "baseUrl" -> next.put("baseUrl", c.optString("baseUrl").trim())
                            else -> next.put(f, c.get(f))
                        }
                    }
                    providers.put(id, next)
                }
            }
            write()
        }
        listeners.forEach { it() }
        return public()
    }

    fun str(key: String): String = synchronized(lock) { data.optString(key) }
    fun bool(key: String): Boolean = synchronized(lock) { data.optBoolean(key) }
    fun num(key: String): Double = synchronized(lock) { data.optDouble(key) }

    fun onChange(l: () -> Unit) = listeners.add(l)
    fun offChange(l: () -> Unit) = listeners.remove(l)

    companion object {
        val DEFAULTS: JSONObject = JSONObject()
            .put("targetLang", "zh-Hans")
            .put("provider", "deepseek")
            .put("providers", JSONObject())
            .put("replyAssist", true)
            .put("replyTone", "auto")
            .put("styleHint", "")
            // projection：每次会话授权一次（系统截屏授权）；accessibility：无障碍服务截屏，开一次一直有效
            .put("captureMode", "projection")
            .put("bubbleEnabled", false)
            .put("bubbleSide", "right")
            .put("bubbleY", 0.38)
            .put("firstRunDone", false)
            // 应用内更新：自动检查（Wi-Fi 下自动下载）、上次检查时间
            .put("autoUpdate", true)
            .put("updateCheckedAt", 0)
            // 省电：多久不用悬浮球就自动退出（分钟，0 = 从不）；系统打开省电模式时自动退出
            .put("idleExit", 60)
            .put("saverExit", true)
    }
}

/** API Key 加密：密文前缀 enc:，内容是 IV + AES-GCM 密文 */
object Secrets {
    private const val ALIAS = "lava.secrets"
    private const val PREFIX = "enc:"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    fun encrypt(plain: String): String {
        if (plain.isEmpty() || plain.startsWith(PREFIX)) return plain
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        return PREFIX + Base64.encodeToString(c.iv + c.doFinal(plain.toByteArray()), Base64.NO_WRAP)
    }

    fun decrypt(stored: String): String {
        if (!stored.startsWith(PREFIX)) return stored
        return try {
            val raw = Base64.decode(stored.substring(PREFIX.length), Base64.NO_WRAP)
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
            String(c.doFinal(raw, 12, raw.size - 12))
        } catch (_: Exception) {
            ""
        }
    }

    /** 打码：•••• + 末 4 位 */
    fun mask(stored: String): String = decrypt(stored).let { if (it.isEmpty()) "" else "•••• " + it.takeLast(4) }

    fun isMasked(v: String) = v.startsWith("••••")
}
