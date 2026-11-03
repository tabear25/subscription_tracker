package io.github.tabear25.subscriptionwidget.data

import org.json.JSONException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.time.LocalDate

class SnapshotJsonTest {
    @Test
    fun widget_jsの応答を読む() {
        // GAS の dev/run-tests.cjs で確かめている応答と同じ形
        val json = """
            {"ok":true,"today":"2026-10-02","monthlyTotal":17710,"activeCount":4,
             "notionUrl":"https://www.notion.so/db",
             "payments":[
               {"name":"Spotify ","date":"2026-10-05","price":980,"billing":"Monthly"},
               {"name":"ジム","date":"2026-10-31","price":null,"billing":"Monthly"}
             ]}
        """.trimIndent()
        val snapshot = SnapshotJson.parse(json)
        assertEquals(17710L, snapshot.monthlyTotal)
        assertEquals(4, snapshot.activeCount)
        assertEquals("https://www.notion.so/db", snapshot.notionUrl)
        // Notion の名前の末尾の空白は取り除く
        assertEquals(Payment("Spotify", LocalDate.of(2026, 10, 5), 980), snapshot.payments[0])
        assertNull(snapshot.payments[1].price)
    }

    @Test
    fun okがfalseならGASのエラーコードを返す() {
        val error = assertThrows(GasError::class.java) { SnapshotJson.parse("""{"ok":false,"error":"unauthorized"}""") }
        assertEquals("unauthorized", error.code)
    }

    @Test
    fun JSONでない応答は読めない() {
        // ウェブアプリのアクセス設定が「全員」でないと、Google のログイン画面（HTML）が返る
        assertThrows(JSONException::class.java) { SnapshotJson.parse("<!DOCTYPE html><html></html>") }
    }
}
