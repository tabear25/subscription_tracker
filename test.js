// ------------------------------------------
// ▼ テスト実行用コード ▼
// ------------------------------------------
function testRun() {
  console.log("🚀 テスト開始...");
  const tasks = fetchNotionData(); // Activeなものだけが取れるはず

  if (!tasks || tasks.length === 0) {
    console.log("⚠️ Activeなデータが見つかりませんでした。ステータス列の名前や値を確認してください。");
    return;
  }
  
  // Activeなもののうち、最初の1件でテスト
  const target = tasks[0];
  const today = new Date();
  
  console.log(`✅ テスト対象: ${target.name} (ステータス: ${target.status})`);
  
  if (target.name.includes("Disney Plus")) {
     console.error("❌ エラー: Disney Plus (解約済み) がまだ混ざっています！列設定を見直してください。");
  } else {
     const title = `🧪【テスト成功】${target.name} `;
     CalendarApp.getDefaultCalendar().createAllDayEvent(title, today, {
       description: `これは接続テストです。\n正しくActiveなものだけ抽出できています。\n金額: ${target.price}`
     });
     console.log(`✅ カレンダー登録成功！今日の予定に「${title}」が入りました。`);
  }
}

// ------------------------------------------
// ▼ LINE通知の疎通テスト用コード ▼
// （Notionを介さず、LINEへの配信だけを確認します）
// ------------------------------------------
function testLineNotification() {
  console.log("🚀 LINE通知テスト開始...");
  sendLineMessage("【テスト】LINE連携の確認です。これが届いていれば設定は成功です。");
  console.log("✅ 送信処理を実行しました。LINEに届いているか確認してください。（未設定の場合はスキップされます）");
}

// ------------------------------------------
// ▼ ロジックの単体テスト ▼
// （NotionやLINEに触れない純粋関数だけを検証します。GASでそのまま実行できます）
// ------------------------------------------
function testLogic() {
  let pass = 0, fail = 0;
  function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`✅ ${label}`); }
    else { fail++; console.error(`❌ ${label} … 期待:${e} 実際:${a}`); }
  }

  // --- 課金サイクル: 四半期の追加を確認 ---
  const base = new Date(2026, 0, 15); // 2026-01-15
  check('Quarterly: 3ヶ月後',
    formatYmd(calculateNextPaymentDate(base, 'Quarterly')), '2026-04-15');
  check('Monthly: 1ヶ月後',
    formatYmd(calculateNextPaymentDate(base, 'Monthly')), '2026-02-15');
  check('Yearly: 1年後',
    formatYmd(calculateNextPaymentDate(base, 'Yearly')), '2027-01-15');
  check('未知のbillingはnull', calculateNextPaymentDate(base, 'Weekly'), null);

  // --- 月額換算: 四半期は÷3 ---
  check('月額換算 Quarterly(3000→1000)', monthlyEquivalent(3000, 'Quarterly'), 1000);
  check('月額換算 Yearly(12000→1000)', monthlyEquivalent(12000, 'Yearly'), 1000);
  check('月額換算 未設定は0', monthlyEquivalent(1000, null), 0);

  // --- 価格抽出 ---
  check('extractPrices: ¥と円の両方を拾う',
    extractPrices('プランA ¥1,480 / プランB 980円 / 重複 ¥1,480').sort((a, b) => a - b),
    [980, 1480]);
  check('extractPrices: 金額なしは空', extractPrices('no price here'), []);

  // --- 未使用検知 ---
  const today = new Date(2026, 2, 1); // 2026-03-01
  const tasks = [
    { name: '古い', lastUsed: '2025-12-01' },  // 90日前 → 未使用候補
    { name: '最近', lastUsed: '2026-02-25' },  // 数日前 → 対象外
    { name: '未記録', lastUsed: null }          // 記録なし → 対象外
  ];
  check('detectUnusedTasks: 古いものだけ',
    detectUnusedTasks(tasks, today).map(t => t.name), ['古い']);

  // --- 月末の支払日: 存在しない日は月末にそろえる（2月分を飛ばさない） ---
  check('Monthly: 1/31 → 2/28',
    formatYmd(calculateNextPaymentDate(new Date(2026, 0, 31), 'Monthly')), '2026-02-28');
  check('Monthly: うるう年 1/31 → 2/29',
    formatYmd(calculateNextPaymentDate(new Date(2028, 0, 31), 'Monthly')), '2028-02-29');
  check('Yearly: 2/29 → 翌年2/28',
    formatYmd(calculateNextPaymentDate(new Date(2028, 1, 29), 'Yearly')), '2029-02-28');
  check('Quarterly: 11/30 → 2/28',
    formatYmd(calculateNextPaymentDate(new Date(2026, 10, 30), 'Quarterly')), '2027-02-28');
  check('Notionの選択肢「Every 3 months」「3 months」も3ヶ月ごと',
    [billingMonths('Every 3 months'), billingMonths('3 months'), monthlyEquivalent(3000, 'Every 3 months')], [3, 3, 1000]);

  // --- 過去の支払日の繰り上げ（31日払いが数サイクル遅れても31日のまま） ---
  const oct2 = new Date(2026, 9, 2);
  check('rollForward: 8/31 Monthly → 10/31',
    formatYmd(rollForwardPaymentDate(new Date(2026, 7, 31), 'Monthly', oct2)), '2026-10-31');
  check('rollForward: 未来日はそのまま',
    formatYmd(rollForwardPaymentDate(new Date(2026, 9, 15), 'Monthly', oct2)), '2026-10-15');
  check('rollForward: Billing不明の過去日はそのまま',
    formatYmd(rollForwardPaymentDate(new Date(2026, 8, 1), null, oct2)), '2026-09-01');
  check('nextPaymentDate: 日付未登録はnull', nextPaymentDate({ date: null, billing: 'Monthly' }, oct2), null);
  check('nextPaymentDate: Billing不明の過去日はstale',
    nextPaymentDate({ date: '2026-09-01', billing: null }, oct2).stale, true);

  // --- 期間内の支払日 ---
  const monthlyTask = { date: '2026-10-05', billing: 'Monthly' };
  check('paymentDatesBetween: 30日間に1回',
    paymentDatesBetween(monthlyTask, oct2, new Date(2026, 9, 31)).map(formatYmd), ['2026-10-05']);
  check('paymentDatesBetween: 60日間に2回',
    paymentDatesBetween(monthlyTask, oct2, new Date(2026, 10, 30)).map(formatYmd), ['2026-10-05', '2026-11-05']);
  check('paymentDatesBetween: 期間外の年払いは0回',
    paymentDatesBetween({ date: '2027-03-01', billing: 'Yearly' }, oct2, new Date(2026, 9, 31)), []);
  check('describeDaysUntil', [0, 1, 13, -3].map(describeDaysUntil), ['今日', '明日', 'あと13日', '3日前']);

  // --- LINEの文章から意図を読み取る（webhook.js） ---
  const intents = [
    ['Netflixっていつ支払いだっけ？', 'payment'],
    ['Netflix解約したい', 'cancelWant'],
    ['解約 Netflix', 'cancelWant'],
    ['Netflixやめよっかな', 'cancelWant'],
    ['Netflix解約したら いつまで使える？', 'cancelWant'],
    ['Ｎｅｔｆｌｉｘ　解約したい？', 'cancelWant'],
    ['Netflix解約した', 'cancelDone'],
    ['Netflix 解約済み', 'cancelDone'],
    ['Netflix解約しといた', 'cancelDone'],
    ['Netflix やめた', 'cancelDone'],
    ['解約したけど再契約したい', 'reactivateWant'],
    ['再開 Disney Plus', 'reactivateWant'],
    ['Netflix再契約した', 'reactivateDone'],
    ['Netflix 続ける', 'keep'],
    ['Netflix 解約取り消し', 'keep'],
    ['やっぱり解約しない', 'keep'],
    ['使った Spotify', 'used'],
    ['Netflix使ったのいつ？', 'payment'],
    ['今月あといくら払う？', 'payment'],
    ['来月いくら？', 'cost'],
    ['一覧', 'list'],
    ['解約済み一覧', 'canceledList'],
    ['ヘルプ', 'help'],
    ['こんにちは', 'none']
  ];
  intents.forEach(([text, expected]) => check(`detectIntent: ${text}`, detectIntent(text).action, expected));
  check('detectIntent: 来月の期間', detectIntent('来月の支払い').window, { type: 'month', offset: 1, explicit: true });

  // --- 文章に出てくるサービスを探す ---
  const pages = [
    { pageId: 'n', name: 'Netflix', status: 'Active', aliases: [] },
    { pageId: 'd', name: 'Disney Plus', status: 'Canceled', aliases: [] },
    { pageId: 'p', name: 'Prime', status: 'Active', aliases: [] },
    { pageId: 'pv', name: 'Prime Video', status: 'Active', aliases: [] },
    { pageId: 'x', name: 'X', status: 'Active', aliases: [] },
    { pageId: 'a', name: 'Adobe Creative Cloud', status: 'Active', aliases: ['アドビ'] }
  ];
  const mentioned = text => findMentionedPages(text, pages).pages.map(p => p.pageId);
  check('findMentionedPages: 名前', mentioned('Netflixっていつ支払い？'), ['n']);
  check('findMentionedPages: 組み込みの呼び名', mentioned('ネトフリ解約したい'), ['n']);
  check('findMentionedPages: Notionの別名', mentioned('アドビ いつ'), ['a']);
  check('findMentionedPages: 長いほうを優先', mentioned('prime video 解約'), ['pv']);
  check('findMentionedPages: 英字は単語の途中で当てない', mentioned('netflix 解約'), ['n']);
  check('findMentionedPages: 1文字の名前', mentioned('x 解約'), ['x']);
  check('findMentionedPages: 名前の一部', mentioned('disney 再契約したい'), ['d']);
  check('findMentionedPages: 2つ', mentioned('NetflixとXいつ？'), ['n', 'x']);
  check('nameRemainder: 名前なし', nameRemainder(normalizeText('解約したい')), '');
  check('nameRemainder: 未登録の名前', nameRemainder(normalizeText('Hulu 解約したい')), 'hulu');
  check('nameRemainder: 一般的な語は残さない', nameRemainder(normalizeText('支払いスケジュール')), '');

  // --- 名前どおりのページが解約済みなら、その名前を含む契約中のページに読み替える ---
  const bundlePages = [
    { pageId: 'l', name: 'LYP Premium with Netflix', status: 'Active', aliases: [] },
    { pageId: 'n', name: 'Netflix', status: 'Canceled', aliases: [] }
  ];
  const resolve = (action, text) => {
    const r = resolveTargets({ action: action }, text, bundlePages, null);
    return [r.source, r.targets.map(p => p.pageId)];
  };
  check('読み替え: 解約したい → 契約中のLYP', resolve('cancelWant', 'Netflix解約したい'), ['related', ['l']]);
  check('読み替えなし: 再契約したい → 解約済みのNetflix', resolve('reactivateWant', 'Netflix再契約したい'), ['exact', ['n']]);

  // --- 名前を省いた発言の扱い（文脈） ---
  const ctxPages = [{ pageId: 'n', name: 'Netflix', status: 'Active' }, { pageId: 's', name: 'Spotify', status: 'Active' }];
  const ids = list => list.map(p => p.pageId);
  check('文脈: 解約案内の直後の「解約した」は使う',
    ids(contextPages('cancelDone', '解約した', '', ctxPages, { ids: ['n'], intent: 'cancelWant' })), ['n']);
  check('文脈: 案内なしの「解約した」は使わない',
    ids(contextPages('cancelDone', '解約した', '', ctxPages, { ids: ['n'], intent: 'info' })), []);
  check('文脈: 問い合わせは「これ」のときだけ',
    [ids(contextPages('payment', 'いつ?', '', ctxPages, { ids: ['n'], intent: 'info' })),
     ids(contextPages('payment', 'これいつ?', '', ctxPages, { ids: ['n'], intent: 'info' }))], [[], ['n']]);
  check('文脈: 複数の話題は「これ」のときだけ',
    [ids(contextPages('cancelWant', '解約したい', '', ctxPages, { ids: ['n', 's'], intent: 'info' })),
     ids(contextPages('cancelWant', 'これ解約したい', '', ctxPages, { ids: ['n', 's'], intent: 'info' }))], [[], ['n', 's']]);
  const now = new Date(2026, 9, 2, 12, 0).getTime();
  check('文脈: 期限内で新しいほう',
    pickConversationContext({ ids: ['n'], at: now - 60 * 1000 }, { ids: ['s'], at: now - 3600 * 1000 }, now).ids, ['n']);
  check('文脈: 期限切れは無視',
    pickConversationContext({ ids: ['n'], at: now - 3 * 3600 * 1000 }, null, now), null);

  // --- 解約方法の案内 ---
  check('支払方法の判定',
    ['App Store', 'Apple Pay', 'Google Play', 'au', 'auかんたん決済', 'クレジットカード'].map(detectBillingStore),
    ['apple', null, 'google', 'carrier', 'carrier', null]);
  check('解約方法: Notionの解約用URLが最優先',
    resolveCancelProcedure({ name: 'Netflix', cancelUrl: 'https://example.com/cancel', paymentMethod: 'App Store' }).url,
    'https://example.com/cancel');
  check('解約方法: App Store経由ならAppleのページ',
    resolveCancelProcedure({ name: 'Netflix', paymentMethod: 'App Store' }).url, 'https://apps.apple.com/account/subscriptions');
  check('解約方法: 主要サービスは組み込みのページ',
    resolveCancelProcedure({ name: 'Netflix' }).url, 'https://www.netflix.com/cancelplan');
  check('解約方法: キャリア決済ならサービスのページを出さない',
    resolveCancelProcedure({ name: 'Netflix', paymentMethod: 'docomo' }).url, null);
  check('解約方法: 情報が無ければ検索リンク',
    [resolveCancelProcedure({ name: 'ジム' }).fallback, resolveCancelProcedure({ name: 'ジム' }).searchUrl.indexOf('https://www.google.com/search?q=') === 0],
    [true, true]);
  check('解約方法: 最後の手段は「URL」（契約管理ページ）',
    resolveCancelProcedure({ name: 'ジム', url: 'https://example.com/mypage' }).url, 'https://example.com/mypage');
  check('再契約の方法: 「再契約URL」が最優先',
    resolveRestartProcedure({ name: 'Netflix', restartUrl: 'https://example.com/join', url: 'https://example.com/account' }).url,
    'https://example.com/join');
  check('組み込みの解約ページは名前がサービス名で始まるときだけ（バンドル契約を取り違えない）',
    [!!findServicePreset('Netflix'), !!findServicePreset('LYP Premium with Netflix'), !!findServicePreset('Disneyplus (JP)')],
    [true, false, true]);

  // --- LINEのボタン・リマインド文 ---
  // LINEは絵文字を2文字と数える（UTF-16）ので String.length で20以内
  const longLabel = quickReplyItem('🛑 Adobe Creative Cloud コンプリートプラン', 'x').action.label;
  check('ボタン名は20文字以内（絵文字は2文字）', longLabel.length <= 20 && longLabel.indexOf('🛑') === 0, true);
  check('絵文字の途中で切らない', truncateChars('🛑🛑🛑', 4), '🛑…');
  check('解約リマインド文',
    buildCancelReminderMessage({ name: 'Netflix', price: '¥1,490' }, new Date(2026, 9, 5), 3).indexOf('Netflix（¥1,490）') !== -1, true);

  console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
}

// テスト用の日付フォーマッタ（Utilitiesに依存せず yyyy-MM-dd を作る）
function formatYmd(date) {
  const y = date.getFullYear();
  const m = ('0' + (date.getMonth() + 1)).slice(-2);
  const d = ('0' + date.getDate()).slice(-2);
  return `${y}-${m}-${d}`;
}