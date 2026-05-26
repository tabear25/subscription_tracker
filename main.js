// ==========================================
// ▼ 設定エリア ▼
// ==========================================
const NOTION_TOKEN = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
const DATABASE_ID = PropertiesService.getScriptProperties().getProperty('DATABASE_ID');

if (!NOTION_TOKEN || !DATABASE_ID) {
  throw new Error("プロパティ設定エラー: NOTION_TOKEN と DATABASE_ID を確認してください。");
}

// LINE通知用（未設定でもカレンダー機能は動作する。設定時のみLINE配信を行う）
const LINE_CHANNEL_ACCESS_TOKEN = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');

const NOTIFY_DAYS_BEFORE = 7;

// 毎月末日に送る、サブスク見直しを促すリマインド文
const MONTHLY_REMINDER_TEXT = '先月、新規で新しいサブスクリプションの登録をしたり、料金プランの変更をしたりしていませんか？';

// Notionの列名
const PROP_NAME = 'Name';
const PROP_DATE = '更新日';
const PROP_PRICE = '料金';
const PROP_BILLING = 'Billing';

// ステータス管理
const PROP_STATUS = 'Status';
const ACTIVE_VALUE = 'Active';

function main() {
  const tasks = fetchNotionData() || [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  tasks.forEach(task => {
    if (!task.date) return;

    let paymentDate = new Date(task.date);
    paymentDate.setHours(0, 0, 0, 0);

    if (paymentDate < today) {
      // 過去日が複数サイクル分たまっていても、今日以降になるまで繰り上げ続ける。
      // 1回だけの繰り上げだと過去日のまま残り、「7日前ちょうど」の通知条件を
      // 飛び越えて支払予告が送られないことがあるため。
      let newDate = paymentDate;
      while (newDate < today) {
        const advanced = calculateNextPaymentDate(newDate, task.billing);
        if (!advanced) break; // billing 不明などで進められない場合は中断（無限ループ防止）
        newDate = advanced;
      }
      if (newDate.getTime() !== paymentDate.getTime()) {
        updateNotionDate(task.pageId, newDate);
        console.log(`🔄 自動更新: ${task.name} を ${formatDate(paymentDate)} から ${formatDate(newDate)} に変更`);
        paymentDate = newDate;
      }
    }

    const diffTime = paymentDate.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === NOTIFY_DAYS_BEFORE) {
      const title = `💸【請求予告】${task.name} (${task.price})`;
      CalendarApp.getDefaultCalendar().createAllDayEvent(title, paymentDate, {
        description: `Notion Expenses trackerからの自動通知\n金額: ${task.price}\n支払日: ${formatDate(paymentDate)}`
      });
      console.log(`🔔 通知作成: ${task.name}`);

      sendLineMessage(`💸 請求予告\n${task.name}\n金額: ${task.price}\n支払日: ${formatDate(paymentDate)}（${NOTIFY_DAYS_BEFORE}日前）`);
    }
  });

  // 毎月末日に、サブスク見直しを促すリマインドをLINEへ送る
  if (isLastDayOfMonth(today)) {
    sendLineMessage(buildMonthlyReminderMessage(tasks));
    console.log('🔔 月末リマインド送信');
  }
}

function fetchNotionData() {
  const url = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;
  const options = {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    // StatusがActiveのものだけ取得する
    payload: JSON.stringify({
      filter: {
        property: PROP_STATUS,
        select: {
          equals: ACTIVE_VALUE
        }
      }
    })
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const data = JSON.parse(response.getContentText());
    
    return data.results.map(page => {
      const props = page.properties;
      
      // タイトル
      let name = "No Name";
      if (props[PROP_NAME] && props[PROP_NAME].title && props[PROP_NAME].title.length > 0) {
        name = props[PROP_NAME].title[0].plain_text;
      }

      // 日付
      let dateStr = null;
      if (props[PROP_DATE] && props[PROP_DATE].date) {
        dateStr = props[PROP_DATE].date.start;
      }

      // 金額
      let price = "-";
      let priceNumber = null;
      if (props[PROP_PRICE] && props[PROP_PRICE].number !== null) {
        priceNumber = props[PROP_PRICE].number;
        price = "¥" + priceNumber.toLocaleString();
      }

      // Billing
      let billing = null;
      if (props[PROP_BILLING] && props[PROP_BILLING].select) {
        billing = props[PROP_BILLING].select.name;
      }

      // Status (デバッグ用に取得)
      let status = null;
      if (props[PROP_STATUS] && props[PROP_STATUS].select) {
        status = props[PROP_STATUS].select.name;
      } else if (props[PROP_STATUS] && props[PROP_STATUS].status) {
        status = props[PROP_STATUS].status.name;
      }

      return { pageId: page.id, name, date: dateStr, price, priceNumber, billing, status };
    });
  } catch (e) {
    console.log("データ取得エラー: " + e);
    return [];
  }
}

function calculateNextPaymentDate(currentDate, billingType) {
  const newDate = new Date(currentDate);
  if (!billingType) return null;

  if (billingType === 'Monthly') {
    newDate.setMonth(newDate.getMonth() + 1);
  } else if (billingType === 'Yearly') {
    newDate.setFullYear(newDate.getFullYear() + 1);
  } else if (billingType === '2 years') {
    newDate.setFullYear(newDate.getFullYear() + 2);
  } else {
    return null;
  }
  return newDate;
}

function updateNotionDate(pageId, newDate) {
  const url = `https://api.notion.com/v1/pages/${pageId}`;
  const dateStr = Utilities.formatDate(newDate, "JST", "yyyy-MM-dd");
  
  const payload = {
    properties: {
      [PROP_DATE]: {
        date: { start: dateStr }
      }
    }
  };

  const options = {
    method: 'patch',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload)
  };
  UrlFetchApp.fetch(url, options);
}

function formatDate(date) {
  return Utilities.formatDate(date, "JST", "yyyy/MM/dd");
}

// LINE Messaging API（broadcast）で友だち全員にテキストを配信する。
// LINE Notify は 2025-03-31 に終了したため Messaging API を使用する。
// トークン未設定なら何もしない（既存のカレンダー機能を壊さないため）。
function sendLineMessage(text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.log("ℹ️ LINE_CHANNEL_ACCESS_TOKEN 未設定のため、LINE送信をスキップしました。");
    return;
  }

  const options = {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      messages: [{ type: 'text', text: text }]
    }),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/broadcast', options);
  const code = response.getResponseCode();
  if (code === 200) {
    console.log("📲 LINE送信成功");
  } else {
    console.log(`❌ LINE送信エラー: ${code} ${response.getContentText()}`);
  }
}

// 課金サイクルを月額換算する。未知/未設定の billing は 0 を返す。
function monthlyEquivalent(priceNumber, billing) {
  if (priceNumber === null || priceNumber === undefined) return 0;
  if (billing === 'Monthly') return priceNumber;
  if (billing === 'Yearly') return priceNumber / 12;
  if (billing === '2 years') return priceNumber / 24;
  return 0;
}

// 月末日かどうか（翌日が1日なら末日）。月の長さ（28/29/30/31）を問わず正しく判定する。
function isLastDayOfMonth(date) {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  return next.getDate() === 1;
}

// 毎月末リマインドのメッセージを組み立てる（固定文 + 現状サマリー）。
function buildMonthlyReminderMessage(tasks) {
  const list = tasks || [];
  const totalMonthly = list.reduce((sum, t) => sum + monthlyEquivalent(t.priceNumber, t.billing), 0);

  return [
    MONTHLY_REMINDER_TEXT,
    '',
    '現在の契約状況',
    `・契約中: ${list.length}件`,
    `・月額換算合計: ¥${Math.round(totalMonthly).toLocaleString()}`
  ].join('\n');
}