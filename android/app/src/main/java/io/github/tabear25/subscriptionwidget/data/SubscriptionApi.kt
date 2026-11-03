package io.github.tabear25.subscriptionwidget.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONException
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

object SubscriptionApi {
    private const val CONNECT_TIMEOUT_MILLIS = 15_000
    // GAS は Notion を読んでから返すので、応答まで数秒かかることがある
    private const val READ_TIMEOUT_MILLIS = 30_000

    /**
     * GAS のウェブアプリからデータを取得し、検証済みの JSON 文字列を返す。
     * GAS の /exec は script.googleusercontent.com へリダイレクトするが、どちらも https なので自動で追従する。
     */
    suspend fun fetch(gasUrl: String, token: String): String = withContext(Dispatchers.IO) {
        val trimmedUrl = gasUrl.trim()
        val separator = if (trimmedUrl.contains('?')) '&' else '?'
        val url = URL(trimmedUrl + separator + "token=" + URLEncoder.encode(token.trim(), "UTF-8"))
        val connection = url.openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = CONNECT_TIMEOUT_MILLIS
            connection.readTimeout = READ_TIMEOUT_MILLIS
            connection.instanceFollowRedirects = true
            val status = connection.responseCode
            if (status != HttpURLConnection.HTTP_OK) throw IOException("HTTP $status")
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            SnapshotJson.parse(body)
            body
        } finally {
            connection.disconnect()
        }
    }

    /** 取得失敗の理由を、設定画面に出す日本語にする。 */
    fun describeError(error: Throwable): String = when (error) {
        is GasError -> when (error.code) {
            "unauthorized" -> "合言葉が GAS の WIDGET_TOKEN と一致しません。"
            "not_configured" -> "GAS のスクリプトプロパティに WIDGET_TOKEN が設定されていません。"
            "notion_error" -> "GAS が Notion からデータを取得できませんでした。"
            else -> "GAS がエラーを返しました（${error.code}）。"
        }
        is JSONException -> "GAS の応答を読めませんでした。URL と、ウェブアプリのアクセス設定（全員）を確認してください。"
        is IOException -> "通信できませんでした（${error.message ?: "原因不明"}）。"
        else -> "取得に失敗しました（${error.javaClass.simpleName}）。"
    }
}
