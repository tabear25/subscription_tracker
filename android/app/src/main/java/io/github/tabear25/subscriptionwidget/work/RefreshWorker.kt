package io.github.tabear25.subscriptionwidget.work

import android.content.Context
import androidx.glance.appwidget.updateAll
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.github.tabear25.subscriptionwidget.data.SubscriptionApi
import io.github.tabear25.subscriptionwidget.data.WidgetStore
import io.github.tabear25.subscriptionwidget.widget.NextPaymentWidget
import kotlinx.coroutines.CancellationException
import java.util.concurrent.TimeUnit

/** GAS から最新のデータを取得して保存し、ウィジェットを描き直す。 */
class RefreshWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val store = WidgetStore(applicationContext)
        if (store.isConfigured) {
            try {
                val json = SubscriptionApi.fetch(store.gasUrl, store.token)
                store.saveSuccess(json, System.currentTimeMillis())
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                // 前回のデータは残したまま、失敗したことだけを記録する（ウィジェットに「何時時点」と出る）
                store.saveFailure(SubscriptionApi.describeError(error))
            }
        }
        // 取得に失敗しても描き直す（日付が変わっていれば「あと何日」や今月の残りが変わるため）
        NextPaymentWidget().updateAll(applicationContext)
        return Result.success()
    }

    companion object {
        private const val PERIODIC_WORK_NAME = "periodic-refresh"
        private const val ONE_TIME_WORK_NAME = "refresh-now"

        // 支払日は1日単位でしか変わらないので、数時間ごとで足りる
        private const val REFRESH_INTERVAL_HOURS = 3L

        fun schedulePeriodic(context: Context) {
            val request = PeriodicWorkRequestBuilder<RefreshWorker>(REFRESH_INTERVAL_HOURS, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(PERIODIC_WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun cancelPeriodic(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_WORK_NAME)
        }

        /** 更新ボタン・設定の保存のときに、すぐ1回取得する。オフラインならすぐ失敗して「何時時点」を出す。 */
        fun refreshNow(context: Context) {
            val request = OneTimeWorkRequestBuilder<RefreshWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork(ONE_TIME_WORK_NAME, ExistingWorkPolicy.REPLACE, request)
        }
    }
}
