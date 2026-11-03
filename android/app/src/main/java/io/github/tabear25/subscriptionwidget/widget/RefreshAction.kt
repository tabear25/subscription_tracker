package io.github.tabear25.subscriptionwidget.widget

import android.content.Context
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.ActionCallback
import io.github.tabear25.subscriptionwidget.work.RefreshWorker

/** 見出しの更新ボタン。通信は時間がかかることがあるので WorkManager に任せる。 */
class RefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        RefreshWorker.refreshNow(context)
    }
}
