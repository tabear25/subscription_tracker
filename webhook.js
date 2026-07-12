// ==========================================
// ▼ LINE Webhook（双方向対応）▼
// ------------------------------------------
// このGASプロジェクトを「ウェブアプリ」としてデプロイし、
// 発行されたURLを LINE Developers Console の Webhook URL に設定すると、
// LINEのトークに送ったテキストでサブスクを操作できる。
//
// 対応コマンド（このトークにテキストを送る）:
//   一覧 / リスト                … 契約中サブスクと月額合計を返信
//   使った <サービス名>           … 最終利用日を今日に更新（未使用検知用）
//   解約 <サービス名>             … Status を Canceled に更新（通知停止）
//   再開 / 再契約 <サービス名>     … Status を Active に戻し、再契約URLへ誘導
//   ヘルプ                        … コマンド一覧
//
// ⚠️ セキュリティ上の注意:
//   GASの doPost(e) はHTTPヘッダーを読めないため、LINEの署名(X-Line-Signature)
//   による検証ができない。そのため、状態を変える操作は ALLOWED_LINE_USER_IDS
//   （許可ユーザーIDのカンマ区切り）で保護する。未設定の場合は誰でも操作できて
//   しまうため、本番では必ず設定すること（取得方法はdocs参照）。
// ==========================================

// LINEの署名検証に使う想定だったが、GASではヘッダーが読めないため現状は未使用。
// 将来GAS側で取得可能になった場合の拡張用に残している。
const LINE_CHANNEL_SECRET = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_SECRET');

// 操作を許可するLINEユーザーID（カンマ区切り）。設定すると、ここに無い相手からの操作を拒否する。
const ALLOWED_LINE_USER_IDS = PropertiesService.getScriptProperties().getProperty('ALLOWED_LINE_USER_IDS');

function doPost(e) {
  try {
    const body = e && e.postData ? e.postData.contents : null;
    if (body) {
      const json = JSON.parse(body);
      (json.events || []).forEach(handleLineEvent);
    }
  } catch (err) {
    console.log('❌ doPost エラー: ' + err);
  }
  // LINEには常に200を返す（エラーを返すとLINE側が再送を繰り返すため）
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleLineEvent(event) {
  if (!event || event.type !== 'message' || !event.message || event.message.type !== 'text') return;

  const replyToken = event.replyToken;
  const userId = event.source ? event.source.userId : null;
  const text = (event.message.text || '').trim();

  if (!isAllowedUser(userId)) {
    console.log('⚠️ 許可されていないユーザーからの操作: ' + userId);
    replyLineMessage(replyToken, '⚠️ このアカウントからの操作は許可されていません。');
    return;
  }

  replyLineMessage(replyToken, routeCommand(text));
}

function isAllowedUser(userId) {
  if (!ALLOWED_LINE_USER_IDS) return true; // 未設定なら制限しない（READMEで設定を強く推奨）
  const allow = ALLOWED_LINE_USER_IDS.split(',').map(s => s.trim()).filter(Boolean);
  return !!userId && allow.indexOf(userId) !== -1;
}

// テキストをコマンドに分解する（純粋関数。Notion等には触れないのでテストしやすい）。
function parseCommand(text) {
  const t = (text || '').trim();
  if (/^(ヘルプ|help|使い方|メニュー)$/i.test(t)) return { action: 'help' };
  if (/^(一覧|リスト|list)$/i.test(t)) return { action: 'list' };

  const m = t.match(/^(解約|キャンセル|やめる|使った|利用|再開|再契約|もう一回|また始め|また)\s*(.*)$/);
  if (!m) return { action: 'unknown' };

  const keyword = m[1];
  const name = (m[2] || '').trim();
  if (/^(解約|キャンセル|やめる)/.test(keyword)) return { action: 'cancel', name: name };
  if (/^(使った|利用)/.test(keyword)) return { action: 'used', name: name };
  return { action: 'reactivate', name: name }; // 再開系
}

function routeCommand(text) {
  const cmd = parseCommand(text);

  switch (cmd.action) {
    case 'help':    return helpMessage();
    case 'list':    return listSubscriptions();
    case 'unknown': return '🤔 コマンドを認識できませんでした。\n\n' + helpMessage();
  }

  if (!cmd.name) {
    return 'サービス名も付けて送ってください。例:「解約 Netflix」';
  }
  if (cmd.action === 'cancel')     return cancelSubscription(cmd.name);
  if (cmd.action === 'used')       return markUsed(cmd.name);
  if (cmd.action === 'reactivate') return reactivateSubscription(cmd.name);
  return helpMessage();
}

function helpMessage() {
  return [
    '🤖 使えるコマンド',
    '・一覧 … 契約中の一覧と月額合計',
    '・使った <サービス名> … 利用日を今日に記録',
    '・解約 <サービス名> … 解約して通知を止める',
    '・再開 <サービス名> … 再開して再契約ページへ誘導',
    '',
    '例:「解約 Netflix」'
  ].join('\n');
}

// --- 各コマンドの実体 ---

function listSubscriptions() {
  const tasks = fetchNotionData() || [];
  if (tasks.length === 0) return '契約中のサブスクはありません。';

  const total = tasks.reduce((sum, t) => sum + monthlyEquivalent(t.priceNumber, t.billing), 0);
  const lines = ['📋 契約中のサブスク', ''];
  tasks.forEach(t => lines.push(`・${t.name}（${t.price} / ${t.billing || '?'}）`));
  lines.push('', `月額換算合計: ¥${Math.round(total).toLocaleString()}`);
  return lines.join('\n');
}

function cancelSubscription(name) {
  const resolved = resolveSingle(name);
  if (resolved.error) return resolved.error;

  const ok = updateNotionProperties(resolved.page.pageId, {
    [PROP_STATUS]: statusValue(CANCELED_VALUE)
  });
  return ok
    ? `✅「${resolved.page.name}」を解約（${CANCELED_VALUE}）にしました。今後の通知を停止します。`
    : `❌「${resolved.page.name}」の更新に失敗しました。`;
}

function markUsed(name) {
  const resolved = resolveSingle(name);
  if (resolved.error) return resolved.error;

  const today = startOfToday();
  const ok = updateNotionProperties(resolved.page.pageId, {
    [PROP_LAST_USED]: { date: { start: formatIso(today) } }
  });
  return ok
    ? `✅「${resolved.page.name}」の最終利用日を ${formatDate(today)} に記録しました。`
    : `❌「${resolved.page.name}」の更新に失敗しました。`;
}

function reactivateSubscription(name) {
  const resolved = resolveSingle(name);
  if (resolved.error) return resolved.error;

  const page = resolved.page;
  const today = startOfToday();
  // 次回支払日を推定（Billing不明ならとりあえず1ヶ月後）。実際の請求日に合わせてユーザーが直せばよい。
  const next = calculateNextPaymentDate(today, page.billing) || calculateNextPaymentDate(today, 'Monthly');

  const ok = updateNotionProperties(page.pageId, {
    [PROP_STATUS]: statusValue(ACTIVE_VALUE),
    [PROP_DATE]: { date: { start: formatIso(next) } }
  });
  if (!ok) return `❌「${page.name}」の更新に失敗しました。`;

  let msg = `🔄「${page.name}」を再開（${ACTIVE_VALUE}）にしました。\n` +
            `次回支払予定: ${formatDate(next)}（推定。実際の請求日に合わせて修正してください）`;
  if (page.url) {
    msg += `\n\n再契約はこちら:\n${page.url}`;
  } else {
    msg += `\n※ 再契約URLは未登録です（NotionのURL列に入れると次回から誘導します）。`;
  }
  return msg;
}

// 名前でNotionを検索し、ちょうど1件に絞れたらそのページを返す。
// 0件 / 複数件 のときは利用者に返すメッセージを error として返す。
function resolveSingle(name) {
  const pages = findNotionPagesByName(name);
  if (pages.length === 0) {
    return { error: `「${name}」に一致するサービスが見つかりませんでした。` };
  }
  if (pages.length > 1) {
    const names = pages.map(p => `・${p.name}`).join('\n');
    return { error: `複数のサービスが一致しました。正式名称で送ってください:\n${names}` };
  }
  return { page: pages[0] };
}

// Name に指定文字列を含むページを、ステータスを問わず検索する（解約済みの再開にも使うため）。
function findNotionPagesByName(name) {
  const url = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;
  const options = {
    method: 'post',
    headers: notionHeaders(),
    payload: JSON.stringify({
      filter: { property: PROP_NAME, title: { contains: name } }
    }),
    muteHttpExceptions: true
  };
  const res = UrlFetchApp.fetch(url, options);
  if (res.getResponseCode() !== 200) {
    console.log('❌ Notion検索エラー: ' + res.getContentText());
    return [];
  }
  const data = JSON.parse(res.getContentText());
  return (data.results || []).map(parseNotionPage);
}

// Status（Select型）の書き込み用の値。存在しない選択肢名でもNotionが自動で追加する。
function statusValue(name) {
  return { select: { name: name } };
}

// Webhookの返信用。broadcastと違い、replyToken宛にその場で返信する。
function replyLineMessage(replyToken, text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.log('ℹ️ LINE_CHANNEL_ACCESS_TOKEN 未設定のため、返信をスキップしました。');
    return;
  }
  if (!replyToken) return;

  const options = {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: 'text', text: text }]
    }),
    muteHttpExceptions: true
  };

  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', options);
  if (res.getResponseCode() !== 200) {
    console.log(`❌ LINE返信エラー: ${res.getResponseCode()} ${res.getContentText()}`);
  }
}
