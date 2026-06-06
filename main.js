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

// 追加プロパティ
const PROP_URL = 'URL';            // サービス/料金ページ（値上げ検知・継続/再契約への導線）
const PROP_CANCEL_URL = '解約URL';  // 解約ページ（任意。未設定なら URL にフォールバック）
const PROP_LAST_USED = '最終利用日'; // 最終利用日（未使用検知のシグナル。手動で更新する）

// 最終利用日からこの日数を超えて記録が更新されていなければ「未使用候補」とみなす
const UNUSED_THRESHOLD_DAYS = 60;

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

  // 毎月1日に、月1の点検（値上げ検知・未使用サブスク検知）を行う。
  // 日次トリガーの中で「今日が1日か」を判定するため、専用トリガーは不要。
  if (isFirstDayOfMonth(today)) {
    // 値上げ検知（サービスページを月1で確認）
    const priceCandidates = checkPriceChanges(tasks);
    if (priceCandidates.length > 0) {
      sendLineMessage(buildPriceCheckMessage(priceCandidates));
      console.log(`🔔 値上げ（料金変更）の可能性: ${priceCandidates.length}件`);
    }

    // 使っていないサブスク検知 → 解約/再契約の見直しをLINEで促す
    const unused = findUnusedSubscriptions(tasks, today);
    if (unused.length > 0) {
      sendLineMessage(buildUnusedAlertMessage(unused));
      console.log(`🔔 未使用サブスク検知: ${unused.length}件`);
    }
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

      // URL（料金/サービスページ。値上げ検知・継続/再契約への導線に使用）
      let url = null;
      if (props[PROP_URL] && props[PROP_URL].url) {
        url = props[PROP_URL].url;
      }

      // 解約URL（任意。未設定なら url にフォールバック）
      let cancelUrl = null;
      if (props[PROP_CANCEL_URL] && props[PROP_CANCEL_URL].url) {
        cancelUrl = props[PROP_CANCEL_URL].url;
      }

      // 最終利用日（未使用検知のシグナル）
      let lastUsed = null;
      if (props[PROP_LAST_USED] && props[PROP_LAST_USED].date) {
        lastUsed = props[PROP_LAST_USED].date.start;
      }

      // Status (デバッグ用に取得)
      let status = null;
      if (props[PROP_STATUS] && props[PROP_STATUS].select) {
        status = props[PROP_STATUS].select.name;
      } else if (props[PROP_STATUS] && props[PROP_STATUS].status) {
        status = props[PROP_STATUS].status.name;
      }

      return { pageId: page.id, name, date: dateStr, price, priceNumber, billing, status, url, cancelUrl, lastUsed };
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
  } else if (billingType === 'Quarterly') {
    newDate.setMonth(newDate.getMonth() + 3);
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

// 月初日（1日）かどうか。月1の点検（値上げ検知・未使用検知）の実行判定に使う。
function isFirstDayOfMonth(date) {
  return date.getDate() === 1;
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

// ==========================================
// ▼ 値上げ検知（サービスページを月1で確認） ▼
// ==========================================

// 正規表現で使う特殊文字をエスケープする。
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ページ本文に、登録中の金額が「1480」「1,480」などの表記で（数字の途中ではなく）含まれるか判定する。
// 任意ページから価格を確実に抽出するのは困難なため、「登録料金が今もページ上に見えるか」だけを確認する
// ヒューリスティックを採用している（見当たらない＝価格が変わったかもしれない、というシグナル）。
function priceAppearsOnPage(html, priceNumber) {
  if (!html || priceNumber === null || priceNumber === undefined) return false;

  // script/style を除いた上でタグを空白に置換し、表示テキストに近い形にする。
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  const n = Math.round(priceNumber);
  const plain = String(n);                    // 例: 1480
  const grouped = n.toLocaleString('en-US');  // 例: 1,480

  // 前後が数字でない位置に plain または grouped があれば「見つかった」とみなす。
  const re = new RegExp('(^|[^0-9])(' + escapeRegExp(plain) + '|' + escapeRegExp(grouped) + ')([^0-9]|$)');
  return re.test(text);
}

// 値上げ（料金変更）の可能性があるサブスクを返す。
// URL が登録され、かつ登録料金がページ上に見当たらないものを候補とする。
function checkPriceChanges(tasks) {
  const candidates = [];

  (tasks || []).forEach(task => {
    if (!task.url || task.priceNumber === null || task.priceNumber === undefined) return;

    let html;
    try {
      const res = UrlFetchApp.fetch(task.url, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SubscriptionTracker/1.0)' }
      });
      const code = res.getResponseCode();
      if (code !== 200) {
        console.log(`⚠️ 価格確認スキップ (${task.name}): HTTP ${code}`);
        return;
      }
      html = res.getContentText();
    } catch (e) {
      console.log(`⚠️ 価格確認スキップ (${task.name}): ${e}`);
      return;
    }

    if (!priceAppearsOnPage(html, task.priceNumber)) {
      candidates.push(task);
    }
  });

  return candidates;
}

// 値上げ検知の通知メッセージを組み立てる。
function buildPriceCheckMessage(candidates) {
  const lines = [
    '📈 料金変更（値上げ）の可能性を検知しました',
    '',
    '登録中の料金がサービスページ上で見つかりませんでした。プランや価格が変わっていないか確認してください。',
    ''
  ];

  candidates.forEach(t => {
    lines.push(`■ ${t.name}（登録料金: ${t.price}）`);
    lines.push(`　確認: ${t.url}`);
    lines.push('');
  });

  lines.push('※ ページ構成により誤検知の場合があります。変更がなければそのままでOKです。');
  return lines.join('\n');
}

// ==========================================
// ▼ 使っていないサブスク検知 / 解約・再契約への誘導 ▼
// ==========================================

// 最終利用日が UNUSED_THRESHOLD_DAYS を超えて古いサブスクを返す。
// 最終利用日が未記録のものは（判定材料がないため）対象外とする。
function findUnusedSubscriptions(tasks, today) {
  const base = new Date(today);
  base.setHours(0, 0, 0, 0);

  const result = [];
  (tasks || []).forEach(task => {
    if (!task.lastUsed) return; // 未記録は対象外（ノイズ回避）

    const last = new Date(task.lastUsed);
    last.setHours(0, 0, 0, 0);

    const diffDays = Math.floor((base.getTime() - last.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays > UNUSED_THRESHOLD_DAYS) {
      result.push({ task, diffDays });
    }
  });

  return result;
}

// 未使用サブスクの見直し（解約 / 継続・再契約）を促すメッセージを組み立てる。
// LINEは送信専用のため、URI（リンク）で解約・継続の導線を提示する。
function buildUnusedAlertMessage(unusedList) {
  const lines = [
    '🧹 しばらく使っていないサブスクがあります',
    '',
    `最終利用日から${UNUSED_THRESHOLD_DAYS}日以上が経過しています。解約するか、継続するか見直してみませんか？`,
    ''
  ];

  unusedList.forEach(({ task, diffDays }) => {
    lines.push(`■ ${task.name}（${task.price} / ${diffDays}日未使用）`);

    const cancel = task.cancelUrl || task.url;
    const service = task.url;
    if (cancel) lines.push(`　解約はこちら: ${cancel}`);
    if (service) lines.push(`　継続・再契約はこちら: ${service}`);
    if (!cancel && !service) lines.push('　（Notionに「解約URL」「URL」を登録すると導線を表示できます）');
    lines.push('');
  });

  lines.push('継続する場合は、Notionの「最終利用日」を今日に更新すると次回から通知されません。');
  return lines.join('\n');
}