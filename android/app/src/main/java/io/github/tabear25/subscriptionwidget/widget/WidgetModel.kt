package io.github.tabear25.subscriptionwidget.widget

import io.github.tabear25.subscriptionwidget.data.Payment
import io.github.tabear25.subscriptionwidget.data.StoredState
import java.text.NumberFormat
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters
import java.util.Locale

/** 直近の支払い（ウィジェットで一番大きく出す1件）。 */
data class NextPayment(
    val name: String,
    val dateLabel: String,
    val shortDateLabel: String,
    val daysLeftLabel: String,
    val priceLabel: String,
)

/** 直近の次に続く支払い（一覧の1行）。 */
data class PaymentRow(
    val dateLabel: String,
    val name: String,
    val priceLabel: String,
)

/** ウィジェットに表示する内容。状態ごとに分ける。 */
sealed interface WidgetContent {
    /** 接続先（GAS の URL・合言葉）が未設定。 */
    data object NotConfigured : WidgetContent

    /** 設定済みで、まだ一度も取得できていない（取得中）。 */
    data object Loading : WidgetContent

    /** 設定済みで、一度も取得できないまま失敗した。 */
    data class Failed(val message: String) : WidgetContent

    /** 表示できるデータがある。next が null なら契約中の支払い予定が無い。 */
    data class Ready(
        val next: NextPayment?,
        val upcoming: List<PaymentRow>,
        val monthlyTotalLabel: String,
        val restOfMonthLabel: String,
        val notionUrl: String?,
        val updatedLabel: String,
        /** 最後の取得に失敗したとき「11/3 9:00 時点」のように、いつのデータかを示す。成功していれば null。 */
        val staleLabel: String?,
    ) : WidgetContent
}

object WidgetModel {
    /** 一覧に出す最大件数（4×3 で使う件数）。 */
    const val MAX_UPCOMING_ROWS = 4

    fun build(state: StoredState, today: LocalDate, zone: ZoneId): WidgetContent {
        if (!state.isConfigured) return WidgetContent.NotConfigured
        val snapshot = state.snapshot
            ?: return if (state.lastError != null) WidgetContent.Failed(state.lastError) else WidgetContent.Loading

        // 取得後に日付が変わっても正しく見えるよう、過ぎた支払いはここで落とす
        val remaining = snapshot.payments
            .filter { !it.date.isBefore(today) }
            .sortedWith(compareBy<Payment>({ it.date }, { it.name }))
        val endOfMonth = today.with(TemporalAdjusters.lastDayOfMonth())
        // LINE の「今月の支払い」と同じく、今日から月末までの支払いを合計する（金額未登録は 0 円扱い）
        val restOfMonth = remaining.filter { !it.date.isAfter(endOfMonth) }.sumOf { it.price ?: 0L }

        val fetchedAt = state.fetchedAtMillis?.let { Instant.ofEpochMilli(it).atZone(zone) }
        val fetchedAtLabel = fetchedAt?.let {
            if (it.toLocalDate() == today) "%d:%02d".format(it.hour, it.minute)
            else "%d/%d %d:%02d".format(it.monthValue, it.dayOfMonth, it.hour, it.minute)
        }

        return WidgetContent.Ready(
            next = remaining.firstOrNull()?.let { toNextPayment(it, today) },
            upcoming = remaining.drop(1).take(MAX_UPCOMING_ROWS).map { toRow(it, today) },
            monthlyTotalLabel = yen(snapshot.monthlyTotal),
            restOfMonthLabel = yen(restOfMonth),
            notionUrl = snapshot.notionUrl,
            updatedLabel = fetchedAtLabel?.let { "$it 更新" }.orEmpty(),
            staleLabel = if (state.lastError != null && fetchedAtLabel != null) "$fetchedAtLabel 時点" else null,
        )
    }

    private fun toNextPayment(payment: Payment, today: LocalDate) = NextPayment(
        name = payment.name,
        dateLabel = longDate(payment.date, today),
        shortDateLabel = shortDate(payment.date, today),
        daysLeftLabel = daysLeft(ChronoUnit.DAYS.between(today, payment.date)),
        priceLabel = priceLabel(payment.price),
    )

    private fun toRow(payment: Payment, today: LocalDate) = PaymentRow(
        dateLabel = shortDate(payment.date, today),
        name = payment.name,
        priceLabel = priceLabel(payment.price),
    )

    /** 「11月8日（日）」。年が違えば「2027年3月1日（月）」。 */
    fun longDate(date: LocalDate, today: LocalDate): String {
        val prefix = if (date.year == today.year) "" else "${date.year}年"
        return "$prefix${date.monthValue}月${date.dayOfMonth}日（${weekday(date.dayOfWeek)}）"
    }

    /** 「11/8（日）」。年が違えば「2027/3/1（月）」（LINE の表記と同じ）。 */
    fun shortDate(date: LocalDate, today: LocalDate): String {
        val prefix = if (date.year == today.year) "" else "${date.year}/"
        return "$prefix${date.monthValue}/${date.dayOfMonth}（${weekday(date.dayOfWeek)}）"
    }

    /** 「今日」「明日」「あと5日」（LINE の表記と同じ）。 */
    fun daysLeft(days: Long): String = when {
        days <= 0L -> "今日"
        days == 1L -> "明日"
        else -> "あと${days}日"
    }

    fun yen(amount: Long): String = "¥" + NumberFormat.getIntegerInstance(Locale.JAPAN).format(amount)

    private fun priceLabel(price: Long?): String = price?.let { yen(it) } ?: "金額未登録"

    private fun weekday(dayOfWeek: DayOfWeek): String = WEEKDAYS[dayOfWeek.value % 7]

    // DayOfWeek.value は月曜=1〜日曜=7。7 で割った余りで日曜を先頭にする
    private val WEEKDAYS = listOf("日", "月", "火", "水", "木", "金", "土")
}
