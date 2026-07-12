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

// 「最終利用日」がこの日数以上前なら、未使用サブスクの候補として月末リマインドで通知する。
const UNUSED_DAYS = 60;

// 価格チェック（値上げ検知）の最短間隔。前回チェックからこの日数が経つまで再チェックしない＝実質「月1」。
const PRICE_CHECK_INTERVAL_DAYS = 28;
// 1回の実行で価格チェックする最大件数。GASの実行時間制限（6分）を超えないための保険。
const MAX_PRICE_CHECKS_PER_RUN = 5;

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
const CANCELED_VALUE = 'Canceled'; // LINEの「解約」コマンドで設定するステータス

// 追加機能用の列名（無くてもエラーにせず、その機能だけスキップする）
const PROP_URL = 'URL';             // 値上げ検知/再契約誘導に使うサービスのURL（URL型 or テキスト型）
const PROP_PRICE_WATCH = '価格監視'; // チェックボックス。ONのサービスだけ価格チェックする
const PROP_PRICE_CHECKED = '料金確認日'; // 日付。価格を自動チェックした最終日（月1の判定と二重チェック防止に使う）
const PROP_LAST_USED = '最終利用日'; // 日付。最後にそのサービスを使った日（未使用検知に使う）

function main() {
  try {
    runDailyCheck();
  } catch (e) {
    console.log('❌ main 実行エラー: ' + e);
    // 失敗をサイレントにしないため、可能ならLINEへ通知する（通知自体が失敗しても握りつぶす）
    try { sendLineMessage('❌ サブスク通知スクリプトでエラーが発生しました。\n' + e); } catch (ignore) {}
    throw e;
  }
}

// 毎日トリガーから呼ばれる本体。
function runDailyCheck() {
  const tasks = fetchNotionData() || [];

  const today = startOfToday();

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

  // 値上げ検知: 価格監視ONのサービスを月1ペースでチェックする。
  checkPricesForAll(tasks, today);

  // 毎月末日に、サブスク見直しを促すリマインド（未使用候補つき）をLINEへ送る
  if (isLastDayOfMonth(today)) {
    sendLineMessage(buildMonthlyReminderMessage(tasks, today));
    console.log('🔔 月末リマインド送信');
  }
}

function fetchNotionData() {
  const url = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;
  const options = {
    method: 'post',
    headers: notionHeaders(),
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
    return data.results.map(parseNotionPage);
  } catch (e) {
    console.log("データ取得エラー: " + e);
    return [];
  }
}

// Notionのページ1件を、このツールで扱う形のオブジェクトに変換する。
// 追加プロパティ（URL/価格監視/料金確認日/最終利用日）は存在しなくても安全に null/false になる。
function parseNotionPage(page) {
  const props = page.properties || {};

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
  if (props[PROP_PRICE] && props[PROP_PRICE].number !== null && props[PROP_PRICE].number !== undefined) {
    priceNumber = props[PROP_PRICE].number;
    price = "¥" + priceNumber.toLocaleString();
  }

  // Billing
  let billing = null;
  if (props[PROP_BILLING] && props[PROP_BILLING].select) {
    billing = props[PROP_BILLING].select.name;
  }

  // Status（Select型 / Status型 のどちらでも読めるようにする）
  let status = null;
  if (props[PROP_STATUS] && props[PROP_STATUS].select) {
    status = props[PROP_STATUS].select.name;
  } else if (props[PROP_STATUS] && props[PROP_STATUS].status) {
    status = props[PROP_STATUS].status.name;
  }

  // URL（URL型のほか、テキスト型で入れている場合も拾う）
  let url = null;
  if (props[PROP_URL]) {
    if (props[PROP_URL].url) {
      url = props[PROP_URL].url;
    } else if (props[PROP_URL].rich_text && props[PROP_URL].rich_text.length > 0) {
      url = props[PROP_URL].rich_text[0].plain_text;
    }
  }

  // 価格監視（チェックボックス）
  let priceWatch = false;
  if (props[PROP_PRICE_WATCH] && typeof props[PROP_PRICE_WATCH].checkbox === 'boolean') {
    priceWatch = props[PROP_PRICE_WATCH].checkbox;
  }

  // 料金確認日
  let priceCheckedDate = null;
  if (props[PROP_PRICE_CHECKED] && props[PROP_PRICE_CHECKED].date) {
    priceCheckedDate = props[PROP_PRICE_CHECKED].date.start;
  }

  // 最終利用日
  let lastUsed = null;
  if (props[PROP_LAST_USED] && props[PROP_LAST_USED].date) {
    lastUsed = props[PROP_LAST_USED].date.start;
  }

  return {
    pageId: page.id, name, date: dateStr, price, priceNumber, billing, status,
    url, priceWatch, priceCheckedDate, lastUsed
  };
}

function calculateNextPaymentDate(currentDate, billingType) {
  const newDate = new Date(currentDate);
  if (!billingType) return null;

  switch (billingType) {
    case 'Monthly':
      newDate.setMonth(newDate.getMonth() + 1);
      break;
    case 'Quarterly': // 四半期（3ヶ月ごと）
      newDate.setMonth(newDate.getMonth() + 3);
      break;
    case 'Yearly':
      newDate.setFullYear(newDate.getFullYear() + 1);
      break;
    case '2 years':
      newDate.setFullYear(newDate.getFullYear() + 2);
      break;
    default:
      return null;
  }
  return newDate;
}

// Notionページのプロパティをまとめて更新する汎用関数。
function updateNotionProperties(pageId, properties) {
  const url = `https://api.notion.com/v1/pages/${pageId}`;
  const options = {
    method: 'patch',
    headers: notionHeaders(),
    payload: JSON.stringify({ properties: properties }),
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  if (code !== 200) {
    console.log(`❌ Notion更新エラー: ${code} ${response.getContentText()}`);
    return false;
  }
  return true;
}

function updateNotionDate(pageId, newDate) {
  return updateNotionProperties(pageId, {
    [PROP_DATE]: { date: { start: formatIso(newDate) } }
  });
}

function notionHeaders() {
  return {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  };
}

function formatDate(date) {
  return Utilities.formatDate(date, "JST", "yyyy/MM/dd");
}

// Notion APIに渡す ISO 日付（yyyy-MM-dd）
function formatIso(date) {
  return Utilities.formatDate(date, "JST", "yyyy-MM-dd");
}

// 時刻を切り捨てた「今日」
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// from から to までの日数差（時刻は無視）。to のほうが新しければ正の値。
function daysBetween(from, to) {
  const ms = startOfDay(to).getTime() - startOfDay(from).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
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
  if (billing === 'Quarterly') return priceNumber / 3;
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

// =====================================================================
// 値上げ検知（価格チェック）
//  - 価格監視がONで URL があるサービスを対象に、月1ペースでページを取得し、
//    登録料金がページ上に見当たらなければ「値上げ/プラン変更の可能性」を通知する。
//  - GASのdoPostではJSレンダリング後のページは取れないため、HTMLに金額が
//    直書きされているページ向けのベストエフォート。取れない場合は手動確認を促す。
// =====================================================================
function checkPricesForAll(tasks, today) {
  let checks = 0;
  (tasks || []).forEach(task => {
    if (checks >= MAX_PRICE_CHECKS_PER_RUN) return;
    if (!task.priceWatch || !task.url) return;

    // 前回チェックから PRICE_CHECK_INTERVAL_DAYS 未満なら今回はスキップ（＝月1相当）
    if (task.priceCheckedDate) {
      const sinceLast = daysBetween(new Date(task.priceCheckedDate), today);
      if (sinceLast < PRICE_CHECK_INTERVAL_DAYS) return;
    }

    checks++;
    checkPrice(task, today);
  });
}

function checkPrice(task, today) {
  let html;
  try {
    const res = UrlFetchApp.fetch(task.url, { muteHttpExceptions: true, followRedirects: true });
    const code = res.getResponseCode();
    if (code !== 200) {
      // 取得失敗時は確認日を更新しない（次回また試す）
      console.log(`⚠️ 価格ページ取得失敗(${code}): ${task.name}`);
      return;
    }
    html = res.getContentText();
  } catch (e) {
    console.log(`⚠️ 価格ページ取得エラー: ${task.name} ${e}`);
    return;
  }

  const prices = extractPrices(html);

  // 取得に成功したら確認日を更新（同じ月に何度もチェックしないため）
  updateNotionProperties(task.pageId, {
    [PROP_PRICE_CHECKED]: { date: { start: formatIso(today) } }
  });

  if (prices.length === 0) {
    sendLineMessage(
      `🔍 価格チェック\n「${task.name}」のページから金額を自動取得できませんでした。\n` +
      `手動で最新料金を確認してください。\n${task.url}`
    );
    return;
  }

  if (task.priceNumber !== null && prices.indexOf(task.priceNumber) === -1) {
    // 登録料金と同じ金額がページ上に見当たらない → 値上げ/プラン変更の可能性
    const nearest = prices.slice().sort((a, b) =>
      Math.abs(a - task.priceNumber) - Math.abs(b - task.priceNumber)
    )[0];
    sendLineMessage(
      `⚠️ 料金変更の可能性\n「${task.name}」\n` +
      `登録料金: ¥${task.priceNumber.toLocaleString()}\n` +
      `ページ上に同額が見つかりませんでした（参考: ¥${nearest.toLocaleString()} など）。\n` +
      `値上げ・プラン変更の可能性があります。確認してください。\n${task.url}`
    );
  } else {
    console.log(`✅ 価格チェックOK: ${task.name}`);
  }
}

// HTMLテキストから日本円の金額（数値）を抽出する。「¥1,000」「1,000円」の両方に対応。
function extractPrices(html) {
  if (!html) return [];
  const found = {};
  const patterns = [
    /[¥￥]\s*([0-9][0-9,]*)/g,
    /([0-9][0-9,]*)\s*円/g
  ];
  patterns.forEach(re => {
    let m;
    while ((m = re.exec(html)) !== null) {
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      if (!isNaN(n) && n > 0) found[n] = true;
    }
  });
  return Object.keys(found).map(Number);
}

// =====================================================================
// 未使用サブスク検知
//  - 「最終利用日」が UNUSED_DAYS 以上前のActive契約を解約候補として返す。
//  - 最終利用日が未記録のものは判定不能として対象外にする（LINEの「使った」で記録できる）。
// =====================================================================
function detectUnusedTasks(tasks, today) {
  return (tasks || []).filter(task => {
    if (!task.lastUsed) return false;
    return daysBetween(new Date(task.lastUsed), today) >= UNUSED_DAYS;
  });
}

// 毎月末リマインドのメッセージを組み立てる（固定文 + 現状サマリー + 未使用候補）。
function buildMonthlyReminderMessage(tasks, today) {
  const list = tasks || [];
  const baseDay = today || startOfToday();
  const totalMonthly = list.reduce((sum, t) => sum + monthlyEquivalent(t.priceNumber, t.billing), 0);

  const lines = [
    MONTHLY_REMINDER_TEXT,
    '',
    '現在の契約状況',
    `・契約中: ${list.length}件`,
    `・月額換算合計: ¥${Math.round(totalMonthly).toLocaleString()}`,
    `・年額換算合計: ¥${Math.round(totalMonthly * 12).toLocaleString()}`
  ];

  const unused = detectUnusedTasks(list, baseDay);
  if (unused.length > 0) {
    lines.push('', `💤 ${UNUSED_DAYS}日以上使っていない可能性:`);
    unused.forEach(t => lines.push(`・${t.name}（最終利用 ${formatDate(new Date(t.lastUsed))}）`));
    lines.push('解約する場合は「解約 サービス名」とこのトークに送ってください。');
  }

  const noRecord = list.filter(t => !t.lastUsed).length;
  if (noRecord > 0) {
    lines.push('', `ℹ️ 利用日が未記録: ${noRecord}件（使ったら「使った サービス名」と送ると記録できます）`);
  }

  return lines.join('\n');
}
