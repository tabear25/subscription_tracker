package io.github.tabear25.subscriptionwidget.settings

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.updateAll
import io.github.tabear25.subscriptionwidget.data.SnapshotJson
import io.github.tabear25.subscriptionwidget.data.SubscriptionApi
import io.github.tabear25.subscriptionwidget.data.WidgetStore
import io.github.tabear25.subscriptionwidget.widget.NextPaymentWidget
import io.github.tabear25.subscriptionwidget.widget.NextPaymentWidgetReceiver
import io.github.tabear25.subscriptionwidget.widget.WidgetModel
import io.github.tabear25.subscriptionwidget.work.RefreshWorker
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId

/**
 * 接続先（GAS のウェブアプリの URL と合言葉）の設定画面。
 * アプリアイコンからも、ウィジェット長押しの「ウィジェットを設定」からも開く。
 */
class SettingsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // ウィジェットの設定として開かれたときは、どう閉じてもウィジェットを残す（未設定ならウィジェットに案内が出る）
        val appWidgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        }

        setContent {
            SettingsTheme {
                SettingsScreen(WidgetStore(this))
            }
        }
    }
}

@Composable
private fun SettingsTheme(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val colorScheme = if (isSystemInDarkTheme()) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    MaterialTheme(colorScheme = colorScheme, content = content)
}

/** 画面下に出す結果のメッセージ。 */
private data class StatusMessage(val text: String, val isError: Boolean)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsScreen(store: WidgetStore) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var gasUrl by rememberSaveable { mutableStateOf(store.gasUrl) }
    var token by rememberSaveable { mutableStateOf(store.token) }
    var showToken by rememberSaveable { mutableStateOf(false) }
    var isBusy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf(initialStatus(store)) }

    // ウィジェットの選択画面に出すプレビューを登録する（Android 15 以降。1時間に2回程度までの制限がある）
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 35) {
            runCatching { GlanceAppWidgetManager(context).setWidgetPreviews(NextPaymentWidgetReceiver::class) }
        }
    }

    fun saveAndFetch() {
        val url = gasUrl.trim()
        if (!url.startsWith("https://")) {
            status = StatusMessage("URL は https:// から始まるものを入力してください。", isError = true)
            return
        }
        if (token.isBlank()) {
            status = StatusMessage("合言葉を入力してください。", isError = true)
            return
        }
        store.saveSettings(url, token)
        RefreshWorker.schedulePeriodic(context)
        isBusy = true
        scope.launch {
            status = try {
                val json = SubscriptionApi.fetch(store.gasUrl, store.token)
                store.saveSuccess(json, System.currentTimeMillis())
                val snapshot = SnapshotJson.parse(json)
                StatusMessage(
                    "取得できました。契約中 ${snapshot.activeCount} 件、月額換算 ${WidgetModel.yen(snapshot.monthlyTotal)} です。",
                    isError = false,
                )
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                val message = SubscriptionApi.describeError(error)
                store.saveFailure(message)
                StatusMessage(message, isError = true)
            } finally {
                isBusy = false
            }
            NextPaymentWidget().updateAll(context)
        }
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("次の支払いウィジェットの設定") }) },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .padding(innerPadding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = "GAS のウェブアプリの URL と、スクリプトプロパティ WIDGET_TOKEN に設定した合言葉を入力してください。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = gasUrl,
                onValueChange = { gasUrl = it },
                label = { Text("GAS の URL") },
                placeholder = { Text("https://script.google.com/macros/s/…/exec") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                label = { Text("合言葉（WIDGET_TOKEN）") },
                singleLine = true,
                visualTransformation = if (showToken) VisualTransformation.None else PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                trailingIcon = {
                    TextButton(onClick = { showToken = !showToken }) {
                        Text(if (showToken) "隠す" else "表示")
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = { saveAndFetch() },
                enabled = !isBusy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (isBusy) "取得しています…" else "保存して取得")
            }
            status?.let { message ->
                Surface(
                    color = if (message.isError) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer,
                    contentColor = if (message.isError) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSecondaryContainer,
                    shape = MaterialTheme.shapes.large,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = message.text,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
        }
    }
}

/** 画面を開いたときに出す、前回の取得結果。 */
private fun initialStatus(store: WidgetStore): StatusMessage? {
    val state = store.load()
    if (state.lastError != null) return StatusMessage("前回の取得に失敗しました。${state.lastError}", isError = true)
    val fetchedAt = state.fetchedAtMillis ?: return null
    val time = Instant.ofEpochMilli(fetchedAt).atZone(ZoneId.systemDefault())
    return StatusMessage(
        "最後に取得したのは ${time.monthValue}/${time.dayOfMonth} %d:%02d です。".format(time.hour, time.minute),
        isError = false,
    )
}
