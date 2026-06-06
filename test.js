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
// ▼ ロジック検証用テスト（Notion/LINE/カレンダーに接続しません） ▼
// ------------------------------------------
function _assert(cond, label) {
  if (cond) {
    console.log(`✅ ${label}`);
  } else {
    console.error(`❌ ${label}`);
  }
}

// 四半期（Quarterly）を含む課金サイクルの計算を検証する。
function testBillingCycles() {
  console.log("🚀 課金サイクル計算テスト開始...");
  // 月末日は setMonth の桁あふれ（例: 1/31+1ヶ月→3月）が起きるため、月中の日付で検証する。
  const base = new Date(2024, 0, 15); // 2024-01-15

  const monthly = calculateNextPaymentDate(base, 'Monthly');
  _assert(monthly.getMonth() === 1, 'Monthly: 翌月になる');

  const quarterly = calculateNextPaymentDate(base, 'Quarterly');
  _assert(quarterly.getMonth() === 3, 'Quarterly: 3ヶ月後（4月）になる');

  const yearly = calculateNextPaymentDate(base, 'Yearly');
  _assert(yearly.getFullYear() === 2025, 'Yearly: 翌年になる');

  _assert(calculateNextPaymentDate(base, 'Unknown') === null, '未知のBilling: null を返す');

  // 月額換算
  _assert(monthlyEquivalent(3000, 'Quarterly') === 1000, 'Quarterly 月額換算: 3000→1000');
  _assert(monthlyEquivalent(1200, 'Yearly') === 100, 'Yearly 月額換算: 1200→100');
  _assert(monthlyEquivalent(1000, 'Monthly') === 1000, 'Monthly 月額換算: 1000→1000');
}

// 値上げ検知のヒューリスティック（価格がページ上に見えるか）を検証する。
function testPriceHeuristic() {
  console.log("🚀 値上げ検知ヒューリスティックテスト開始...");
  const html = '<html><body><p>月額 <b>1,480</b>円でご利用いただけます</p></body></html>';

  _assert(priceAppearsOnPage(html, 1480) === true, '登録料金1480がページ上に見つかる');
  _assert(priceAppearsOnPage(html, 1980) === false, '別料金1980は見つからない（=変更の可能性）');
  // 数字の途中での誤マッチを避ける（21480 の一部として 1480 を拾わない）
  _assert(priceAppearsOnPage('<p>会員番号214805</p>', 1480) === false, '数字の途中は誤検知しない');
}

// 未使用サブスク検知（最終利用日が閾値超過）を検証する。
function testUnusedDetection() {
  console.log("🚀 未使用サブスク検知テスト開始...");
  const today = new Date(2026, 5, 6); // 2026-06-06

  const old = new Date(today); old.setDate(old.getDate() - 90);
  const recent = new Date(today); recent.setDate(recent.getDate() - 10);

  const tasks = [
    { name: '古いサブスク', price: '¥500', lastUsed: Utilities.formatDate(old, 'JST', 'yyyy-MM-dd') },
    { name: '最近使った', price: '¥500', lastUsed: Utilities.formatDate(recent, 'JST', 'yyyy-MM-dd') },
    { name: '未記録', price: '¥500', lastUsed: null }
  ];

  const unused = findUnusedSubscriptions(tasks, today);
  _assert(unused.length === 1, '未使用候補は1件のみ');
  _assert(unused.length === 1 && unused[0].task.name === '古いサブスク', '抽出されたのは古いサブスク');
}

// 上記ロジックテストをまとめて実行する。
function testAllLogic() {
  testBillingCycles();
  testPriceHeuristic();
  testUnusedDetection();
  console.log("🏁 ロジックテスト完了");
}