package io.github.tabear25.subscriptionwidget.data

import org.json.JSONObject
import java.time.LocalDate

/** 支払い予定1件。Notion に金額が入っていないときは price が null。 */
data class Payment(
    val name: String,
    val date: LocalDate,
    val price: Long?,
)

/** GAS（widget.js の doGet）から取得したデータ一式。 */
data class Snapshot(
    val monthlyTotal: Long,
    val activeCount: Int,
    val notionUrl: String?,
    val payments: List<Payment>,
)

/** GAS が ok=false を返したときのエラー。code は widget.js の error と同じ文字列。 */
class GasError(val code: String) : Exception("GAS error: $code")

object SnapshotJson {
    /** doGet の応答を読む。ok=false なら GasError、JSON でなければ org.json.JSONException を投げる。 */
    fun parse(json: String): Snapshot {
        val root = JSONObject(json)
        if (!root.optBoolean("ok", false)) {
            throw GasError(root.optString("error", "unknown"))
        }
        val paymentArray = root.getJSONArray("payments")
        val payments = (0 until paymentArray.length()).map { index ->
            val item = paymentArray.getJSONObject(index)
            Payment(
                // Notion の名前の末尾に空白が入っていることがある（例: "Post Coffee "）
                name = item.getString("name").trim(),
                date = LocalDate.parse(item.getString("date")),
                price = if (item.isNull("price")) null else Math.round(item.getDouble("price")),
            )
        }
        return Snapshot(
            monthlyTotal = root.getLong("monthlyTotal"),
            activeCount = root.optInt("activeCount", 0),
            notionUrl = if (root.isNull("notionUrl")) null else root.optString("notionUrl").ifBlank { null },
            payments = payments,
        )
    }
}
