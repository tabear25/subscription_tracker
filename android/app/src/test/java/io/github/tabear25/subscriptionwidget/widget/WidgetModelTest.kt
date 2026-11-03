package io.github.tabear25.subscriptionwidget.widget

import io.github.tabear25.subscriptionwidget.data.Payment
import io.github.tabear25.subscriptionwidget.data.Snapshot
import io.github.tabear25.subscriptionwidget.data.StoredState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime

class WidgetModelTest {
    private val zone = ZoneId.of("Asia/Tokyo")
    private val today = LocalDate.of(2026, 11, 3)
    private val fetchedAt = ZonedDateTime.of(2026, 11, 3, 9, 5, 0, 0, zone).toInstant().toEpochMilli()

    private val snapshot = Snapshot(
        monthlyTotal = 6662,
        activeCount = 6,
        notionUrl = "https://www.notion.so/db",
        payments = listOf(
            Payment("過ぎた支払い", LocalDate.of(2026, 11, 1), 500),
            Payment("Netflix", LocalDate.of(2026, 11, 8), 1590),
            Payment("Spotify", LocalDate.of(2026, 11, 12), 980),
            Payment("iCloud+", LocalDate.of(2026, 11, 20), 400),
            Payment("ChatGPT Plus", LocalDate.of(2026, 11, 28), 3000),
            Payment("Amazon プライム", LocalDate.of(2026, 12, 2), 5900),
            Payment("Spotify", LocalDate.of(2026, 12, 12), 980),
        ),
    )

    private fun ready(state: StoredState, day: LocalDate = today) =
        WidgetModel.build(state, day, zone) as WidgetContent.Ready

    private fun stored(snapshot: Snapshot?, lastError: String? = null) =
        StoredState(isConfigured = true, snapshot = snapshot, fetchedAtMillis = fetchedAt.takeIf { snapshot != null }, lastError = lastError)

    @Test
    fun 直近の支払い_続く支払い_今月の残りを作る() {
        val content = ready(stored(snapshot))
        val next = content.next!!
        assertEquals("Netflix", next.name)
        assertEquals("11月8日（日）", next.dateLabel)
        assertEquals("11/8（日）", next.shortDateLabel)
        assertEquals("あと5日", next.daysLeftLabel)
        assertEquals("¥1,590", next.priceLabel)
        // 過ぎた支払い（11/1）は出さない。一覧は最大4件
        assertEquals(
            listOf("11/12（木） Spotify ¥980", "11/20（金） iCloud+ ¥400", "11/28（土） ChatGPT Plus ¥3,000", "12/2（水） Amazon プライム ¥5,900"),
            content.upcoming.map { "${it.dateLabel} ${it.name} ${it.priceLabel}" },
        )
        assertEquals("¥6,662", content.monthlyTotalLabel)
        // 今日（11/3）から月末までの合計: 1,590 + 980 + 400 + 3,000
        assertEquals("¥5,970", content.restOfMonthLabel)
        assertEquals("9:05 更新", content.updatedLabel)
        assertNull(content.staleLabel)
        assertEquals("https://www.notion.so/db", content.notionUrl)
    }

    @Test
    fun 日付が変わったらその日の基準で計算し直す() {
        // 取得は 11/3 のまま、12/1 に描き直した場合
        val content = ready(stored(snapshot), day = LocalDate.of(2026, 12, 1))
        assertEquals("Amazon プライム", content.next!!.name)
        assertEquals("明日", content.next!!.daysLeftLabel)
        assertEquals("¥6,880", content.restOfMonthLabel) // 12/2 の 5,900 + 12/12 の 980
        assertEquals("11/3 9:05 更新", content.updatedLabel)
    }

    @Test
    fun 当日の支払いは今日と表示し今月の残りに含める() {
        val content = ready(stored(snapshot), day = LocalDate.of(2026, 11, 8))
        assertEquals("今日", content.next!!.daysLeftLabel)
        assertEquals("¥5,970", content.restOfMonthLabel)
    }

    @Test
    fun 金額未登録は表示を変え_合計では0円として扱う() {
        val noPrice = snapshot.copy(payments = listOf(Payment("ジム", LocalDate.of(2026, 11, 10), null), Payment("Spotify", LocalDate.of(2026, 11, 12), 980)))
        val content = ready(stored(noPrice))
        assertEquals("金額未登録", content.next!!.priceLabel)
        assertEquals("¥980", content.restOfMonthLabel)
    }

    @Test
    fun 年が違う支払いは年から表示する() {
        val yearly = snapshot.copy(payments = listOf(Payment("Adobe", LocalDate.of(2027, 3, 1), 86880)))
        val content = ready(stored(yearly))
        assertEquals("2027年3月1日（月）", content.next!!.dateLabel)
        assertEquals("2027/3/1（月）", content.next!!.shortDateLabel)
        assertEquals("¥0", content.restOfMonthLabel)
    }

    @Test
    fun 契約中の支払いが無ければnextはnull() {
        val content = ready(stored(snapshot.copy(monthlyTotal = 0, payments = emptyList())))
        assertNull(content.next)
        assertEquals("¥0", content.monthlyTotalLabel)
    }

    @Test
    fun 取得に失敗したら前回のデータといつ時点かを出す() {
        val content = ready(stored(snapshot, lastError = "通信できませんでした"))
        assertEquals("Netflix", content.next!!.name)
        assertEquals("9:05 時点", content.staleLabel)
    }

    @Test
    fun 未設定_読み込み中_失敗の状態を分ける() {
        assertEquals(WidgetContent.NotConfigured, WidgetModel.build(StoredState(false, null, null, null), today, zone))
        assertEquals(WidgetContent.Loading, WidgetModel.build(stored(null), today, zone))
        assertEquals(WidgetContent.Failed("合言葉が違います"), WidgetModel.build(stored(null, lastError = "合言葉が違います"), today, zone))
    }
}
