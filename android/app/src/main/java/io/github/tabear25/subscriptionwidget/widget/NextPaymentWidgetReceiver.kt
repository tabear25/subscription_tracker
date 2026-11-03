package io.github.tabear25.subscriptionwidget.widget

import android.content.Context
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import io.github.tabear25.subscriptionwidget.work.RefreshWorker

class NextPaymentWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = NextPaymentWidget()

    // 1つ目のウィジェットを置いたとき：定期更新を始め、すぐに1回取得する
    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        RefreshWorker.schedulePeriodic(context)
        RefreshWorker.refreshNow(context)
    }

    // 最後のウィジェットを外したとき：定期更新を止める
    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        RefreshWorker.cancelPeriodic(context)
    }
}
