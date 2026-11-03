package io.github.tabear25.subscriptionwidget.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.coerceAtLeast
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.LinearProgressIndicator
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.components.CircleIconButton
import androidx.glance.appwidget.components.Scaffold
import androidx.glance.appwidget.components.TitleBar
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import io.github.tabear25.subscriptionwidget.R
import io.github.tabear25.subscriptionwidget.data.WidgetStore
import io.github.tabear25.subscriptionwidget.settings.SettingsActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.LocalDate
import java.time.ZoneId

/** ホーム画面の「次の支払い」ウィジェット。表示するデータは端末に保存した前回の取得結果から作る。 */
class NextPaymentWidget : GlanceAppWidget() {

    override val sizeMode = SizeMode.Responsive(RESPONSIVE_SIZES)

    override val previewSizeMode = SizeMode.Responsive(RESPONSIVE_SIZES)

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val content = withContext(Dispatchers.IO) {
            WidgetModel.build(WidgetStore(context).load(), LocalDate.now(), ZoneId.systemDefault())
        }
        provideContent {
            GlanceTheme {
                WidgetBody(content)
            }
        }
    }

    // ウィジェットの選択画面に出すプレビュー（Android 15 以降）。見本のデータで描く。
    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        provideContent {
            GlanceTheme {
                WidgetBody(PREVIEW_CONTENT)
            }
        }
    }

    companion object {
        private val WIDE_MIN_WIDTH = 240.dp
        // これより狭い横長（3列分など）では、カードの日付を短くして残り日数のチップが切れないようにする
        val FULL_WIDE_MIN_WIDTH = 320.dp
        private val SQUARE_MIN_HEIGHT = 200.dp
        private val LARGE_MIN_HEIGHT = 290.dp

        // 2×1 / 2×2 / 横長の1段 / 4×2 / 4×3（4×2 と 4×3 は3列分の幅も別に用意）。
        // 置いたサイズに収まるうち最も大きいものが選ばれる
        private val RESPONSIVE_SIZES = setOf(
            DpSize(100.dp, 50.dp),
            DpSize(100.dp, SQUARE_MIN_HEIGHT),
            DpSize(WIDE_MIN_WIDTH, 50.dp),
            DpSize(WIDE_MIN_WIDTH, SQUARE_MIN_HEIGHT),
            DpSize(WIDE_MIN_WIDTH, LARGE_MIN_HEIGHT),
            DpSize(FULL_WIDE_MIN_WIDTH, SQUARE_MIN_HEIGHT),
            DpSize(FULL_WIDE_MIN_WIDTH, LARGE_MIN_HEIGHT),
        )

        private val PREVIEW_CONTENT = WidgetContent.Ready(
            next = NextPayment("Netflix", "11月8日（日）", "11/8（日）", "あと5日", "¥1,590"),
            upcoming = listOf(
                PaymentRow("11/12（木）", "Spotify", "¥980"),
                PaymentRow("11/20（金）", "iCloud+", "¥400"),
                PaymentRow("11/28（土）", "ChatGPT Plus", "¥3,000"),
                PaymentRow("12/2（水）", "Amazon プライム", "¥5,900"),
            ),
            monthlyTotalLabel = "¥6,662",
            restOfMonthLabel = "¥5,970",
            notionUrl = null,
            updatedLabel = "9:00 更新",
            staleLabel = null,
        )

        fun layoutFor(size: DpSize): WidgetLayout = when {
            size.width < WIDE_MIN_WIDTH -> if (size.height < SQUARE_MIN_HEIGHT) WidgetLayout.SMALL else WidgetLayout.SQUARE
            size.height < SQUARE_MIN_HEIGHT -> WidgetLayout.WIDE_SHORT
            size.height < LARGE_MIN_HEIGHT -> WidgetLayout.WIDE
            else -> WidgetLayout.LARGE
        }
    }
}

/** 置いたサイズごとのレイアウト。SMALL=2×1、SQUARE=2×2、WIDE_SHORT=横長の1段、WIDE=4×2、LARGE=4×3 以上。 */
enum class WidgetLayout { SMALL, SQUARE, WIDE_SHORT, WIDE, LARGE }

private val CONTENT_PADDING = 12.dp
private val SMALL_PADDING = 8.dp

@Composable
private fun WidgetBody(content: WidgetContent) {
    val size = LocalSize.current
    val layout = NextPaymentWidget.layoutFor(size)
    val isNarrow = size.width < NextPaymentWidget.FULL_WIDE_MIN_WIDTH
    val hasTitleBar = layout == WidgetLayout.WIDE || layout == WidgetLayout.LARGE
    val padding = if (layout == WidgetLayout.SMALL || layout == WidgetLayout.WIDE_SHORT) SMALL_PADDING else CONTENT_PADDING
    val cardRadius = innerRadius(padding)

    Scaffold(
        titleBar = if (hasTitleBar) {
            { Header(content) }
        } else {
            null
        },
        modifier = GlanceModifier.clickable(openAction(content)),
        horizontalPadding = padding,
    ) {
        when (layout) {
            WidgetLayout.SMALL -> SmallBody(content, cardRadius)
            WidgetLayout.SQUARE -> SquareBody(content, cardRadius)
            WidgetLayout.WIDE_SHORT -> WideShortBody(content, cardRadius)
            WidgetLayout.WIDE, WidgetLayout.LARGE -> WideBody(content, cardRadius, isLarge = layout == WidgetLayout.LARGE, isNarrow = isNarrow)
        }
    }
}

/** 内側のカードの角丸 = 端末が決める外側の角丸 − 余白（Android のウィジェットの指針の計算式）。 */
@Composable
private fun innerRadius(padding: Dp): Dp {
    val resources = LocalContext.current.resources
    val outer = (resources.getDimension(android.R.dimen.system_app_widget_background_radius) / resources.displayMetrics.density).dp
    return (outer - padding).coerceAtLeast(4.dp)
}

/** タップしたときの動作。データがあれば Notion を開き、無ければ設定画面を開く。 */
@Composable
private fun openAction(content: WidgetContent): Action {
    val notionUrl = (content as? WidgetContent.Ready)?.notionUrl
    return if (notionUrl != null) {
        actionStartActivity(Intent(Intent.ACTION_VIEW, Uri.parse(notionUrl)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } else {
        actionStartActivity<SettingsActivity>()
    }
}

// ---------- 4×2 / 4×3 ----------

@Composable
private fun Header(content: WidgetContent) {
    val colors = GlanceTheme.colors
    TitleBar(
        startIcon = ImageProvider(R.drawable.ic_calendar),
        title = LocalContext.current.getString(R.string.widget_name),
        iconColor = colors.primary,
        textColor = colors.onSurface,
        actions = {
            val ready = content as? WidgetContent.Ready
            if (ready?.staleLabel != null) {
                Image(
                    provider = ImageProvider(R.drawable.ic_error),
                    contentDescription = null,
                    colorFilter = ColorFilter.tint(colors.error),
                    modifier = GlanceModifier.size(14.dp),
                )
                Spacer(GlanceModifier.width(4.dp))
                Label(ready.staleLabel, colors.error, 12.sp, FontWeight.Medium)
            } else if (!ready?.updatedLabel.isNullOrEmpty()) {
                Label(ready!!.updatedLabel, colors.onSurfaceVariant, 12.sp)
            }
            CircleIconButton(
                imageProvider = ImageProvider(R.drawable.ic_refresh),
                contentDescription = LocalContext.current.getString(R.string.refresh),
                onClick = actionRunCallback<RefreshAction>(),
                backgroundColor = null,
                contentColor = colors.onSurfaceVariant,
            )
        },
    )
}

@Composable
private fun WideBody(content: WidgetContent, cardRadius: Dp, isLarge: Boolean, isNarrow: Boolean) {
    Column(modifier = GlanceModifier.fillMaxSize().padding(bottom = CONTENT_PADDING)) {
        WideHero(content, cardRadius, isNarrow)
        if (content is WidgetContent.Ready) {
            Spacer(GlanceModifier.height(8.dp))
            if (isLarge) TotalTiles(content, cardRadius) else TotalsLine(content)
            Spacer(GlanceModifier.height(if (isLarge) 8.dp else 6.dp))
            UpcomingList(content.upcoming.take(if (isLarge) WidgetModel.MAX_UPCOMING_ROWS else 2))
        }
    }
}

@Composable
private fun WideHero(content: WidgetContent, cardRadius: Dp, isNarrow: Boolean) {
    val colors = GlanceTheme.colors
    // 高さは固定しない。端末のフォント（Pixel は Google Sans）によって行の高さが変わり、
    // 固定すると2行目（日付と残り日数）の下が切れるため（実機で確認）
    Row(
        modifier = GlanceModifier
            .fillMaxWidth()
            .cornerRadius(cardRadius)
            .background(colors.primaryContainer)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val next = (content as? WidgetContent.Ready)?.next
        if (next != null) {
            Column(modifier = GlanceModifier.defaultWeight()) {
                Label(next.name, colors.onPrimaryContainer, 22.sp, FontWeight.Bold)
                Spacer(GlanceModifier.height(2.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Label(if (isNarrow) next.shortDateLabel else next.dateLabel, colors.onPrimaryContainer, 14.sp)
                    Spacer(GlanceModifier.width(8.dp))
                    DaysLeftChip(next.daysLeftLabel, 12.sp)
                }
            }
            Spacer(GlanceModifier.width(12.dp))
            Label(next.priceLabel, colors.onPrimaryContainer, if (isNarrow) 24.sp else 28.sp, FontWeight.Bold)
        } else {
            StatusMessage(content, titleSize = 16.sp)
        }
    }
}

@Composable
private fun TotalsLine(content: WidgetContent.Ready) {
    val colors = GlanceTheme.colors
    Row(
        modifier = GlanceModifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Label("月額換算 ", colors.onSurfaceVariant, 12.sp, FontWeight.Medium)
        Label(content.monthlyTotalLabel, colors.onSurface, 16.sp, FontWeight.Bold)
        Spacer(GlanceModifier.width(20.dp))
        Label("今月の残り ", colors.onSurfaceVariant, 12.sp, FontWeight.Medium)
        Label(content.restOfMonthLabel, colors.onSurface, 16.sp, FontWeight.Bold)
    }
}

@Composable
private fun TotalTiles(content: WidgetContent.Ready, cardRadius: Dp) {
    Row(modifier = GlanceModifier.fillMaxWidth()) {
        TotalTile("月額換算", content.monthlyTotalLabel, cardRadius, GlanceModifier.defaultWeight())
        Spacer(GlanceModifier.width(8.dp))
        TotalTile("今月の残り", content.restOfMonthLabel, cardRadius, GlanceModifier.defaultWeight())
    }
}

@Composable
private fun TotalTile(label: String, value: String, cardRadius: Dp, modifier: GlanceModifier) {
    val colors = GlanceTheme.colors
    Column(
        modifier = modifier
            .cornerRadius(cardRadius)
            .background(colors.secondaryContainer)
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Label(label, colors.onSecondaryContainer, 12.sp, FontWeight.Medium)
        Spacer(GlanceModifier.height(2.dp))
        Label(value, colors.onSecondaryContainer, 22.sp, FontWeight.Bold)
    }
}

@Composable
private fun UpcomingList(rows: List<PaymentRow>) {
    val colors = GlanceTheme.colors
    Column(modifier = GlanceModifier.fillMaxWidth().padding(horizontal = 4.dp)) {
        rows.forEach { row ->
            Row(
                modifier = GlanceModifier.fillMaxWidth().padding(vertical = 1.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Label(row.dateLabel, colors.onSurfaceVariant, 14.sp, modifier = GlanceModifier.width(84.dp))
                Spacer(GlanceModifier.width(8.dp))
                Label(row.name, colors.onSurface, 14.sp, modifier = GlanceModifier.defaultWeight())
                Spacer(GlanceModifier.width(8.dp))
                Label(row.priceLabel, colors.onSurface, 14.sp, FontWeight.Medium)
            }
        }
    }
}

// ---------- 2×2 ----------

@Composable
private fun SquareBody(content: WidgetContent, cardRadius: Dp) {
    val colors = GlanceTheme.colors
    Column(modifier = GlanceModifier.fillMaxSize().padding(vertical = CONTENT_PADDING)) {
        Row(
            modifier = GlanceModifier.fillMaxWidth().padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Image(
                provider = ImageProvider(R.drawable.ic_calendar),
                contentDescription = null,
                colorFilter = ColorFilter.tint(colors.primary),
                modifier = GlanceModifier.size(16.dp),
            )
            Spacer(GlanceModifier.width(6.dp))
            Label(LocalContext.current.getString(R.string.widget_name), colors.onSurfaceVariant, 12.sp, FontWeight.Medium)
        }
        Spacer(GlanceModifier.height(8.dp))
        Column(
            modifier = GlanceModifier
                .fillMaxWidth()
                .defaultWeight()
                .cornerRadius(cardRadius)
                .background(colors.primaryContainer)
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            val next = (content as? WidgetContent.Ready)?.next
            if (next != null) {
                Label(next.name, colors.onPrimaryContainer, 16.sp, FontWeight.Bold)
                Spacer(GlanceModifier.defaultWeight())
                Label(next.priceLabel, colors.onPrimaryContainer, 26.sp, FontWeight.Bold)
                Spacer(GlanceModifier.defaultWeight())
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Label(next.shortDateLabel, colors.onPrimaryContainer, 12.sp)
                    Spacer(GlanceModifier.width(6.dp))
                    DaysLeftChip(next.daysLeftLabel, 11.sp)
                }
            } else {
                StatusMessage(content, titleSize = 14.sp)
            }
        }
        if (content is WidgetContent.Ready) {
            Spacer(GlanceModifier.height(8.dp))
            TotalRow("月額換算", content.monthlyTotalLabel)
            TotalRow("今月の残り", content.restOfMonthLabel)
        }
    }
}

@Composable
private fun TotalRow(label: String, value: String) {
    val colors = GlanceTheme.colors
    Row(
        modifier = GlanceModifier.fillMaxWidth().padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Label(label, colors.onSurfaceVariant, 12.sp, FontWeight.Medium, GlanceModifier.defaultWeight())
        Label(value, colors.onSurface, 14.sp, FontWeight.Bold)
    }
}

// ---------- 2×1 ----------

@Composable
private fun SmallBody(content: WidgetContent, cardRadius: Dp) {
    val colors = GlanceTheme.colors
    Box(modifier = GlanceModifier.fillMaxSize().padding(vertical = SMALL_PADDING)) {
        Column(
            modifier = GlanceModifier
                .fillMaxSize()
                .cornerRadius(cardRadius)
                .background(colors.primaryContainer)
                .padding(horizontal = 14.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val next = (content as? WidgetContent.Ready)?.next
            if (next != null) {
                Label(next.name, colors.onPrimaryContainer, 14.sp, FontWeight.Bold)
                Label(next.priceLabel, colors.onPrimaryContainer, 22.sp, FontWeight.Bold)
                Label("${next.shortDateLabel}・${next.daysLeftLabel}", colors.onPrimaryContainer, 12.sp)
            } else {
                StatusMessage(content, titleSize = 14.sp)
            }
        }
    }
}

// ---------- 横長の1段（4×1 など） ----------

@Composable
private fun WideShortBody(content: WidgetContent, cardRadius: Dp) {
    val colors = GlanceTheme.colors
    Row(
        modifier = GlanceModifier.fillMaxSize().padding(vertical = SMALL_PADDING),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = GlanceModifier
                .defaultWeight()
                .fillMaxHeight()
                .cornerRadius(cardRadius)
                .background(colors.primaryContainer)
                .padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val next = (content as? WidgetContent.Ready)?.next
            if (next != null) {
                Column(modifier = GlanceModifier.defaultWeight()) {
                    Label(next.name, colors.onPrimaryContainer, 14.sp, FontWeight.Bold)
                    Label("${next.shortDateLabel}・${next.daysLeftLabel}", colors.onPrimaryContainer, 12.sp)
                }
                Spacer(GlanceModifier.width(8.dp))
                Label(next.priceLabel, colors.onPrimaryContainer, 22.sp, FontWeight.Bold)
            } else {
                StatusMessage(content, titleSize = 14.sp)
            }
        }
        if (content is WidgetContent.Ready) {
            Spacer(GlanceModifier.width(12.dp))
            Column(modifier = GlanceModifier.width(112.dp)) {
                Label("月額換算", colors.onSurfaceVariant, 12.sp, FontWeight.Medium)
                Label(content.monthlyTotalLabel, colors.onSurface, 14.sp, FontWeight.Bold)
                Label("今月の残り", colors.onSurfaceVariant, 12.sp, FontWeight.Medium)
                Label(content.restOfMonthLabel, colors.onSurface, 14.sp, FontWeight.Bold)
            }
        }
    }
}

// ---------- 共通の部品 ----------

/** データが無いときのカードの中身（未設定・読み込み中・失敗・契約なし）。 */
@Composable
private fun StatusMessage(content: WidgetContent, titleSize: TextUnit) {
    val colors = GlanceTheme.colors
    Column(modifier = GlanceModifier.fillMaxWidth()) {
        when (content) {
            WidgetContent.NotConfigured -> {
                Label("接続先の設定が必要です", colors.onPrimaryContainer, titleSize, FontWeight.Bold)
                Label("タップして GAS の URL と合言葉を入力", colors.onPrimaryContainer, 12.sp)
            }
            WidgetContent.Loading -> {
                Label("データを読み込んでいます", colors.onPrimaryContainer, titleSize, FontWeight.Medium)
                Spacer(GlanceModifier.height(12.dp))
                LinearProgressIndicator(
                    modifier = GlanceModifier.fillMaxWidth(),
                    color = colors.primary,
                    backgroundColor = colors.widgetBackground,
                )
            }
            is WidgetContent.Failed -> {
                Label("データを取得できませんでした", colors.onPrimaryContainer, titleSize, FontWeight.Bold)
                Label("タップして設定を確認", colors.onPrimaryContainer, 12.sp)
            }
            is WidgetContent.Ready -> {
                Label("契約中のサブスクはありません", colors.onPrimaryContainer, titleSize, FontWeight.Medium)
            }
        }
    }
}

@Composable
private fun DaysLeftChip(text: String, fontSize: TextUnit) {
    val colors = GlanceTheme.colors
    Box(
        modifier = GlanceModifier
            .cornerRadius(10.dp)
            .background(colors.primary)
            .padding(horizontal = 8.dp, vertical = 2.dp),
    ) {
        Label(text, colors.onPrimary, fontSize, FontWeight.Medium)
    }
}

@Composable
private fun Label(
    text: String,
    color: ColorProvider,
    fontSize: TextUnit,
    fontWeight: FontWeight = FontWeight.Normal,
    modifier: GlanceModifier = GlanceModifier,
) {
    Text(
        text = text,
        modifier = modifier,
        maxLines = 1,
        style = TextStyle(color = color, fontSize = fontSize, fontWeight = fontWeight),
    )
}
