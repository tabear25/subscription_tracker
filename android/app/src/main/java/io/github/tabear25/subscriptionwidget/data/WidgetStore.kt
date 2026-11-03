package io.github.tabear25.subscriptionwidget.data

import android.content.Context

/** ウィジェットの描画に必要な、端末に保存している状態。 */
data class StoredState(
    val isConfigured: Boolean,
    val snapshot: Snapshot?,
    val fetchedAtMillis: Long?,
    val lastError: String?,
)

/**
 * 接続先の設定と、最後に取得できたデータを端末内（アプリ専用領域）に保存する。
 * 取得に失敗しても前回のデータは消さず、エラーだけを記録する（ウィジェットは前回のデータを出し続ける）。
 */
class WidgetStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    val gasUrl: String get() = prefs.getString(KEY_GAS_URL, "").orEmpty()
    val token: String get() = prefs.getString(KEY_TOKEN, "").orEmpty()
    val isConfigured: Boolean get() = gasUrl.isNotBlank() && token.isNotBlank()

    fun saveSettings(gasUrl: String, token: String) {
        val changed = gasUrl.trim() != this.gasUrl || token.trim() != this.token
        val editor = prefs.edit()
            .putString(KEY_GAS_URL, gasUrl.trim())
            .putString(KEY_TOKEN, token.trim())
        // 接続先が変わったら、前の接続先のデータは表示しない
        if (changed) editor.remove(KEY_JSON).remove(KEY_FETCHED_AT).remove(KEY_LAST_ERROR)
        editor.commit()
    }

    fun saveSuccess(json: String, fetchedAtMillis: Long) {
        prefs.edit()
            .putString(KEY_JSON, json)
            .putLong(KEY_FETCHED_AT, fetchedAtMillis)
            .remove(KEY_LAST_ERROR)
            .commit()
    }

    fun saveFailure(message: String) {
        prefs.edit().putString(KEY_LAST_ERROR, message).commit()
    }

    fun load(): StoredState {
        val json = prefs.getString(KEY_JSON, null)
        // 保存済みの JSON は取得時に検証しているが、読めなければ「データなし」として扱う
        val snapshot = json?.let { runCatching { SnapshotJson.parse(it) }.getOrNull() }
        return StoredState(
            isConfigured = isConfigured,
            snapshot = snapshot,
            fetchedAtMillis = if (prefs.contains(KEY_FETCHED_AT)) prefs.getLong(KEY_FETCHED_AT, 0L) else null,
            lastError = prefs.getString(KEY_LAST_ERROR, null),
        )
    }

    private companion object {
        const val PREFS_NAME = "widget"
        const val KEY_GAS_URL = "gas_url"
        const val KEY_TOKEN = "token"
        const val KEY_JSON = "snapshot_json"
        const val KEY_FETCHED_AT = "fetched_at"
        const val KEY_LAST_ERROR = "last_error"
    }
}
