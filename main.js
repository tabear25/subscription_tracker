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
const PROP_URL = 'URL';             // サービスのアカウント（契約管理）ページ。値上げ検知のチェック先、解約・再契約リンクの予備にも使う（URL型 or テキスト型）
const PROP_PRICE_WATCH = '価格監視'; // チェックボックス。ONのサービスだけ価格チェックする
const PROP_PRICE_CHECKED = '料金確認日'; // 日付。価格を自動チェックした最終日（月1の判定と二重チェック防止に使う）
const PROP_LAST_USED = '最終利用日'; // 日付。最後にそのサービスを使った日（未使用検知に使う）
const PROP_CANCEL_URL = '解約用URL';   // 解約ページのURL（URL型 or テキスト型）。LINEの解約案内で最優先に表示する
const PROP_RESTART_URL = '再契約URL';  // 申し込み（再契約）ページのURL（URL型 or テキスト型）。LINEの再契約案内で最優先に表示する
const PROP_CANCEL_HOWTO = '解約方法';  // 解約の手順メモ（テキスト型）
const PROP_PAYMENT_METHOD = '支払方法'; // 「App Store」「Google Play」「docomo」など（セレクト型 or テキスト型）。解約先の案内を切り替える
const PROP_ALIASES = '別名';           // LINEで呼ぶときの別名（カンマ区切り。例: ネトフリ）

// 「解約したい」と言ったまま「解約済み」の連絡がないサービスに、支払日の何日前にLINEで確認するか
const CANCEL_REMINDER_DAYS = [3, 1];

// 「これ解約したい」のような返信を、その日に通知したサービスとして扱う時間
const BROADCAST_CONTEXT_TTL_HOURS = 24;
// 「これ」「それ」や名前なしの続きの発言を、直前にLINEで話したサービスとして扱う時間
const CONTEXT_TTL_MINUTES = 120;

// スクリプトプロパティに保存する状態のキー（ツールが自動で書き込む。手動設定は不要）
const PENDING_CANCELS_KEY = 'PENDING_CANCELS';  // 解約手続き待ちのサービス
const CONTEXT_KEY_PREFIX = 'LINE_CONTEXT_';     // 直前に話題にしたサービス（会話の文脈）

// LINE Messaging API の上限
const LINE_TEXT_MAX = 5000;
const QUICK_REPLY_MAX = 13;

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
  const fetched = fetchNotionData();
  const tasks = fetched || [];

  const today = startOfToday();
  const pending = loadPendingCancels();
  const withButtons = isLineTwoWayEnabled();
  const notifiedIds = [];
  const remindedIds = [];

  tasks.forEach(task => {
    let paymentDate = parseYmd(task.date);
    if (!paymentDate) return;

    if (paymentDate < today) {
      // 過去日が複数サイクル分たまっていても、今日以降になるまで繰り上げる。
      // 1回だけの繰り上げだと過去日のまま残り、「7日前ちょうど」の通知条件を
      // 飛び越えて支払予告が送られないことがあるため。
      const newDate = rollForwardPaymentDate(paymentDate, task.billing, today);
      if (newDate.getTime() !== paymentDate.getTime()) {
        updateNotionDate(task.pageId, newDate);
        console.log(`🔄 自動更新: ${task.name} を ${formatDate(paymentDate)} から ${formatDate(newDate)} に変更`);
        paymentDate = newDate;
      }
    }

    const diffDays = daysBetween(today, paymentDate);
    const isPending = !!pending[task.pageId];

    if (diffDays === NOTIFY_DAYS_BEFORE) {
      const title = `💸【請求予告】${task.name} (${task.price})`;
      CalendarApp.getDefaultCalendar().createAllDayEvent(title, paymentDate, {
        description: `Notion Expenses trackerからの自動通知\n金額: ${task.price}\n支払日: ${formatDate(paymentDate)}`
      });
      console.log(`🔔 通知作成: ${task.name}`);

      let text = `💸 請求予告\n${task.name}\n金額: ${task.price}\n支払日: ${formatDate(paymentDate)}（${NOTIFY_DAYS_BEFORE}日前）`;
      if (isPending) text += '\n⏳ 解約手続き待ちです。済んだら「解約済み」と返信してください。';
      sendLineMessage(text, withButtons ? [
        quickReplyItem('🛑 解約したい', `${task.name} 解約したい`),
        quickReplyItem('📅 支払い予定', '支払い予定')
      ] : null);
      notifiedIds.push(task.pageId);
    } else if (isPending && CANCEL_REMINDER_DAYS.indexOf(diffDays) !== -1) {
      // 「解約したい」と言ったまま完了の連絡がない → 請求日の前に念押しする
      sendLineMessage(buildCancelReminderMessage(task, paymentDate, diffDays), [
        quickReplyItem('✅ 解約済み', `${task.name} 解約済み`),
        quickReplyItem('📝 解約方法', `${task.name} 解約したい`),
        quickReplyItem('👌 続ける', `${task.name} 続ける`)
      ]);
      console.log(`⏰ 解約リマインド送信: ${task.name}`);
      remindedIds.push(task.pageId);
    }
  });

  // 通知への返信（「これ解約したい」など）が、今日通知したサービスを指せるように覚えておく
  rememberNotifiedServices(notifiedIds, remindedIds);

  // 解約済み・削除済みになったサービスを解約待ちから外す（Notionの取得に失敗した日は消さない）
  if (fetched) cleanUpPendingCancels(pending, tasks);

  // 値上げ検知: 価格監視ONのサービスを月1ペースでチェックする。
  checkPricesForAll(tasks, today);

  // 毎月末日に、サブスク見直しを促すリマインド（未使用候補つき）をLINEへ送る
  if (isLastDayOfMonth(today)) {
    sendLineMessage(buildMonthlyReminderMessage(tasks, today),
      withButtons ? buildMonthlyReminderQuickReplies(tasks, today) : null);
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
    // 取得失敗は null（「契約0件」と区別するため。呼び出し側は `|| []` で扱う）
    console.log("データ取得エラー: " + e);
    return null;
  }
}

// ステータスを問わず全ページを取得する（LINEでの問い合わせ・解約済みの再契約に使う）。失敗時は null。
function fetchAllNotionPages() {
  const url = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;
  const pages = [];
  let cursor = null;
  for (let i = 0; i < 20; i++) { // 1回100件 × 最大20回
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: notionHeaders(),
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      console.log(`❌ Notion取得エラー: ${res.getResponseCode()} ${res.getContentText()}`);
      return null;
    }
    const data = JSON.parse(res.getContentText());
    (data.results || []).forEach(page => {
      const title = page.properties && page.properties[PROP_NAME] && page.properties[PROP_NAME].title;
      if (title && title.some(t => (t.plain_text || '').trim())) pages.push(parseNotionPage(page)); // 名前が空の行は無視
    });
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return pages;
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

  // 解約・再契約の案内用（任意の列）
  const cancelUrl = propText(props[PROP_CANCEL_URL]);
  const restartUrl = propText(props[PROP_RESTART_URL]);
  const cancelHowto = propText(props[PROP_CANCEL_HOWTO]);
  const paymentMethod = propText(props[PROP_PAYMENT_METHOD]);
  const aliasText = propText(props[PROP_ALIASES]);
  const aliases = aliasText ? aliasText.split(/[,、，\/／|｜\n]+/).map(s => s.trim()).filter(Boolean) : [];

  // Status列が「ステータス型」なら書き込みも同じ型で行う（既定はセレクト型）
  const statusType = props[PROP_STATUS] && props[PROP_STATUS].type === 'status' ? 'status' : 'select';

  return {
    pageId: page.id, name, date: dateStr, price, priceNumber, billing, status,
    url, priceWatch, priceCheckedDate, lastUsed,
    cancelUrl, restartUrl, cancelHowto, paymentMethod, aliases, statusType
  };
}

// テキスト系の列（テキスト/URL/セレクト/マルチセレクト）を文字列で読む。無ければ null。
function propText(prop) {
  if (!prop) return null;
  if (typeof prop.url === 'string' && prop.url) return prop.url;
  if (prop.select) return prop.select.name;
  if (prop.multi_select && prop.multi_select.length > 0) return prop.multi_select.map(o => o.name).join(',');
  const rich = prop.rich_text || prop.title;
  if (rich && rich.length > 0) return rich.map(r => r.plain_text).join('').trim() || null;
  return null;
}

function calculateNextPaymentDate(currentDate, billingType) {
  const months = billingMonths(billingType);
  return months ? addMonthsClamped(currentDate, months) : null;
}

// 課金サイクルの月数。未知/未設定は null。
function billingMonths(billingType) {
  switch (billingType) {
    case 'Monthly': return 1;
    case 'Quarterly':      // 四半期（3ヶ月ごと）。Notionの選択肢名の揺れも同じ扱いにする
    case 'Every 3 months':
    case '3 months': return 3;
    case 'Yearly': return 12;
    case '2 years': return 24;
    default: return null;
  }
}

// months ヶ月後の同じ日。その月に同じ日が無ければ月末にそろえる（1/31 → 2/28）。
// setMonth だけだと 1/31 → 3/3 のように月があふれ、2月分の支払日を飛ばしてしまうため。
function addMonthsClamped(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

// 支払日が今日より前なら、今日以降になるまで課金サイクル分進めた日付を返す。
// 元の日付を基準に n サイクル後を計算するので、1/31 から数ヶ月分進めても「31日」がずれない。
// Billing不明などで進められない場合は、元の日付をそのまま返す。
function rollForwardPaymentDate(date, billing, today) {
  const start = startOfDay(date);
  if (start >= today) return start;
  const months = billingMonths(billing);
  if (!months) return start;
  for (let n = 1; n <= 1200; n++) {
    const d = addMonthsClamped(start, months * n);
    if (d >= today) return d;
  }
  return start;
}

// Notionの「更新日」から、今日以降の次回支払日を求める（Notionは書き換えない）。
// 戻り値: { date, stale }。stale=true は「過去日のまま進められない（Billing未設定）」。日付未登録なら null。
function nextPaymentDate(task, today) {
  const stored = parseYmd(task.date);
  if (!stored) return null;
  const date = rollForwardPaymentDate(stored, task.billing, today);
  return { date: date, stale: date < today };
}

// from〜to（両端を含む）に来る支払日をすべて返す（期間内に2回来る場合も含む）。
function paymentDatesBetween(task, from, to) {
  const next = nextPaymentDate(task, from);
  if (!next || next.stale || next.date > to) return [];
  const months = billingMonths(task.billing);
  if (!months) return [next.date];
  const dates = [];
  for (let n = 0; n < 100; n++) {
    const d = addMonthsClamped(next.date, months * n);
    if (d > to) break;
    dates.push(d);
  }
  return dates;
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

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

// LINE表示用の日付。今年なら「10/15（木）」、別の年なら「2027/3/1（月）」。
function formatDateJa(date, today) {
  const base = today || startOfToday();
  const pattern = date.getFullYear() === base.getFullYear() ? 'M/d' : 'yyyy/M/d';
  return `${Utilities.formatDate(date, "JST", pattern)}（${WEEKDAYS_JA[date.getDay()]}）`;
}

// 「今日」「明日」「あと13日」「3日前」
function describeDaysUntil(days) {
  if (days === 0) return '今日';
  if (days === 1) return '明日';
  if (days > 1) return `あと${days}日`;
  return `${-days}日前`;
}

// 課金サイクル（月数）の表示名
const BILLING_LABELS = { 1: '毎月', 3: '3ヶ月ごと', 12: '毎年', 24: '2年ごと' };
const BILLING_SHORT_LABELS = { 1: '月', 3: '3ヶ月', 12: '年', 24: '2年' };

function billingLabel(billing) {
  return BILLING_LABELS[billingMonths(billing)] || 'サイクル未設定';
}

function priceText(task) {
  return task.priceNumber === null || task.priceNumber === undefined ? '金額未登録' : task.price;
}

// 「¥1,490（毎月）」
function priceWithCycle(task) {
  return `${priceText(task)}（${billingLabel(task.billing)}）`;
}

// 「¥1,490/月」
function priceShort(task) {
  const cycle = BILLING_SHORT_LABELS[billingMonths(task.billing)];
  return cycle ? `${priceText(task)}/${cycle}` : priceText(task);
}

// Notionの日付文字列（yyyy-MM-dd、または日時）を、その日の0時（スクリプトのタイムゾーン）として読む。
function parseYmd(str) {
  const m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function addDays(date, days) {
  const d = startOfDay(date);
  d.setDate(d.getDate() + days);
  return d;
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
// 夏時間のあるタイムゾーンでも1日=23/25時間の日がずれないよう四捨五入する。
function daysBetween(from, to) {
  const ms = startOfDay(to).getTime() - startOfDay(from).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

// LINE Messaging API（broadcast）で友だち全員にテキストを配信する。
// LINE Notify は 2025-03-31 に終了したため Messaging API を使用する。
// トークン未設定なら何もしない（既存のカレンダー機能を壊さないため）。
// quickReplyItems を渡すと、タップで返信できるボタン（クイックリプライ）を付ける。
function sendLineMessage(text, quickReplyItems) {
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
      messages: [buildTextMessage(text, quickReplyItems)]
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

// LINEのテキストメッセージを組み立てる（quickReplyItems があればボタンを付ける）。
function buildTextMessage(text, quickReplyItems) {
  const message = { type: 'text', text: truncateChars(text, LINE_TEXT_MAX) };
  if (quickReplyItems && quickReplyItems.length > 0) {
    message.quickReply = { items: quickReplyItems.slice(0, QUICK_REPLY_MAX) };
  }
  return message;
}

// タップすると text をそのまま送信するボタン。label は最大20文字（LINEの仕様）。
function quickReplyItem(label, text) {
  return {
    type: 'action',
    action: { type: 'message', label: truncateChars(label, 20), text: truncateChars(text, 300) }
  };
}

// LINEの文字数上限に収まるよう切り詰める。LINEはUTF-16単位で数える（絵文字は2文字）ため
// String.length で測り、絵文字の途中では切らない。
function truncateChars(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  let out = '';
  for (const ch of Array.from(s)) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return out + '…';
}

// LINEで操作（Webhook）を使っているか。通知にボタンを付けるかどうかの判定に使う。
// （Webhook未設定だとボタンを押しても何も起きないため。ALLOWED_LINE_USER_IDS はWebhook利用時に設定するもの）
function isLineTwoWayEnabled() {
  return !!PropertiesService.getScriptProperties().getProperty('ALLOWED_LINE_USER_IDS');
}

// =====================================================================
// 解約手続き待ち
//  - LINEで「解約したい」と言ったサービスを覚えておき、「解約済み」「続ける」の連絡が
//    来るまで、支払日の CANCEL_REMINDER_DAYS 日前にLINEで念押しする。
//  - 実際の解約はサービス側でしかできないため、「手続きし忘れたまま請求日を迎える」のを防ぐ仕組み。
//  - スクリプトプロパティ PENDING_CANCELS に {pageId: {name, since}} で保存する。
// =====================================================================
function loadPendingCancels() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(PENDING_CANCELS_KEY) || '{}') || {};
  } catch (e) {
    return {};
  }
}

function savePendingCancels(map) {
  const props = PropertiesService.getScriptProperties();
  if (Object.keys(map).length === 0) props.deleteProperty(PENDING_CANCELS_KEY);
  else props.setProperty(PENDING_CANCELS_KEY, JSON.stringify(map));
}

function setPendingCancel(task, today) {
  const map = loadPendingCancels();
  if (!map[task.pageId]) {
    map[task.pageId] = { name: task.name, since: formatIso(today || startOfToday()) };
    savePendingCancels(map);
  }
}

// 解約待ちを外す。外したら true。
function clearPendingCancel(pageId) {
  const map = loadPendingCancels();
  if (!map[pageId]) return false;
  delete map[pageId];
  savePendingCancels(map);
  return true;
}

// Active一覧に無くなった（解約済み・削除済み）サービスを解約待ちから外す
function cleanUpPendingCancels(pending, activeTasks) {
  const activeIds = {};
  activeTasks.forEach(t => { activeIds[t.pageId] = true; });
  const stale = Object.keys(pending).filter(id => !activeIds[id]);
  if (stale.length === 0) return;
  const map = loadPendingCancels();
  stale.forEach(id => delete map[id]);
  savePendingCancels(map);
}

function buildCancelReminderMessage(task, paymentDate, diffDays) {
  return [
    '⏰ 解約手続きはお済みですか？',
    `${task.name}（${task.price}）`,
    `次回支払日: ${formatDateJa(paymentDate)} ${describeDaysUntil(diffDays)}`,
    '',
    '済んでいたら「解約済み」、やめずに続けるなら「続ける」を押してください。'
  ].join('\n');
}

// =====================================================================
// 会話の文脈（直前に話題にしたサービス）
//  - 「これっていつ支払い？」「じゃあ解約したい」のように名前を省いた発言を、
//    直前のやり取り（または今日の通知）のサービスとして扱うために使う。
//  - スクリプトプロパティ LINE_CONTEXT_<ユーザーID> / LINE_CONTEXT_broadcast に保存する。
// =====================================================================
function saveConversationContext(key, pageIds, intent) {
  if (!key || !pageIds || pageIds.length === 0) return;
  try {
    PropertiesService.getScriptProperties().setProperty(CONTEXT_KEY_PREFIX + key,
      JSON.stringify({ ids: pageIds.slice(0, QUICK_REPLY_MAX), intent: intent, at: Date.now() }));
  } catch (e) {
    console.log('⚠️ 会話の文脈を保存できませんでした: ' + e);
  }
}

function readConversationContext(key) {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(CONTEXT_KEY_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// ユーザーとの直前のやり取りと、今日の通知のうち、期限内で新しいほうの文脈を返す
function loadConversationContext(userId) {
  return pickConversationContext(
    userId ? readConversationContext(userId) : null,
    readConversationContext('broadcast'),
    Date.now());
}

function pickConversationContext(userContext, broadcastContext, nowMs) {
  const valid = [];
  if (userContext && nowMs - userContext.at <= CONTEXT_TTL_MINUTES * 60 * 1000) valid.push(userContext);
  if (broadcastContext && nowMs - broadcastContext.at <= BROADCAST_CONTEXT_TTL_HOURS * 60 * 60 * 1000) valid.push(broadcastContext);
  valid.sort((a, b) => b.at - a.at);
  return valid[0] || null;
}

// 今日通知したサービスを文脈として覚えておく。解約リマインドだけなら「解約済み」の返信にも使える。
function rememberNotifiedServices(notifiedIds, remindedIds) {
  const ids = remindedIds.concat(notifiedIds.filter(id => remindedIds.indexOf(id) === -1));
  if (ids.length === 0) return;
  const intent = notifiedIds.length === 0 ? 'cancelWant' : 'info';
  saveConversationContext('broadcast', ids, intent);
}

// 課金サイクルを月額換算する。未知/未設定の billing は 0 を返す。
function monthlyEquivalent(priceNumber, billing) {
  if (priceNumber === null || priceNumber === undefined) return 0;
  const months = billingMonths(billing);
  return months ? priceNumber / months : 0;
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
    lines.push('解約するなら「サービス名 解約したい」と送ってください（解約方法と期限を返します）。');
  }

  const noRecord = list.filter(t => !t.lastUsed).length;
  if (noRecord > 0) {
    lines.push('', `ℹ️ 利用日が未記録: ${noRecord}件（使ったら「サービス名 使った」と送ると記録できます）`);
  }

  return lines.join('\n');
}

// 月末リマインドのボタン: 未使用候補の「解約したい」＋来月の支払い・一覧
function buildMonthlyReminderQuickReplies(tasks, today) {
  const items = detectUnusedTasks(tasks || [], today || startOfToday())
    .slice(0, QUICK_REPLY_MAX - 2)
    .map(t => quickReplyItem(`🛑 ${t.name}`, `${t.name} 解約したい`));
  items.push(quickReplyItem('📅 来月の支払い', '来月の支払い'));
  items.push(quickReplyItem('📋 一覧', '一覧'));
  return items;
}
