// ==========================================
// ▼ ホーム画面ウィジェット用の読み取り口（doGet）▼
// ------------------------------------------
// Android のホーム画面ウィジェットが「次の支払い」「月額換算合計」などを取りに来るための口。
// 読み取り専用で、Notion は書き換えない。
//
// 呼び出し方:
//   https://script.google.com/macros/s/<デプロイID>/exec?token=<WIDGET_TOKEN>
//
// ⚠️ セキュリティ上の注意:
//   LINE の Webhook を使う場合、このGASは「全員（Anyone）」がアクセスできるウェブアプリとして
//   デプロイされているため、URL を知っていれば誰でも呼べてしまう。そのため、スクリプトプロパティ
//   WIDGET_TOKEN（合言葉）と一致する token を付けたリクエストにだけ答える。
//   WIDGET_TOKEN が未設定のときは、すべて拒否する。
// ==========================================

const WIDGET_TOKEN_PROPERTY = 'WIDGET_TOKEN';

// 支払い予定を返す期間（今日から何日先まで）。「今月の残り」と一覧の表示に足りる長さにしている。
// この期間に支払いが無いサービスも、次回支払日だけは1件返す（年払いだけでも「予定なし」にならないように）。
const WIDGET_HORIZON_DAYS = 62;

function doGet(e) {
  return jsonOutput(handleWidgetRequest(e));
}

function handleWidgetRequest(e) {
  const expected = PropertiesService.getScriptProperties().getProperty(WIDGET_TOKEN_PROPERTY);
  if (!expected) return { ok: false, error: 'not_configured' };
  const token = e && e.parameter ? e.parameter.token : null;
  if (token !== expected) return { ok: false, error: 'unauthorized' };

  const tasks = fetchNotionData();
  if (!tasks) return { ok: false, error: 'notion_error' };
  return Object.assign({ ok: true }, buildWidgetData(tasks, startOfToday()));
}

// ウィジェットに渡すデータ。
// 次回支払日の繰り上げと月額換算は LINE と同じ関数を使い、LINE の回答と数字がずれないようにする。
// 「今月の残り」はウィジェット側で payments から合計する（日付が変わってもその場で計算し直せるように）。
function buildWidgetData(tasks, today) {
  const horizonEnd = addDays(today, WIDGET_HORIZON_DAYS);
  const payments = [];
  tasks.forEach(task => {
    let dates = paymentDatesBetween(task, today, horizonEnd);
    if (dates.length === 0) {
      const next = nextPaymentDate(task, today);
      if (next && !next.stale) dates = [next.date];
    }
    dates.forEach(date => payments.push({
      name: task.name,
      date: formatIso(date),
      price: task.priceNumber,
      billing: task.billing
    }));
  });
  payments.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

  const monthlyTotal = tasks.reduce((sum, t) => sum + monthlyEquivalent(t.priceNumber, t.billing), 0);
  return {
    today: formatIso(today),
    monthlyTotal: Math.round(monthlyTotal),
    activeCount: tasks.length,
    notionUrl: `https://www.notion.so/${String(DATABASE_ID).replace(/-/g, '')}`,
    payments: payments
  };
}

function jsonOutput(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
