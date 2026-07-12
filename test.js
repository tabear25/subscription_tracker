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

  // --- コマンド解析（webhook.js） ---
  check('parseCommand: 一覧', parseCommand('一覧'), { action: 'list' });
  check('parseCommand: 解約', parseCommand('解約 Netflix'), { action: 'cancel', name: 'Netflix' });
  check('parseCommand: 使った', parseCommand('使った Spotify'), { action: 'used', name: 'Spotify' });
  check('parseCommand: 再開', parseCommand('再開 Disney Plus'), { action: 'reactivate', name: 'Disney Plus' });
  check('parseCommand: 不明', parseCommand('こんにちは'), { action: 'unknown' });

  console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
}

// テスト用の日付フォーマッタ（Utilitiesに依存せず yyyy-MM-dd を作る）
function formatYmd(date) {
  const y = date.getFullYear();
  const m = ('0' + (date.getMonth() + 1)).slice(-2);
  const d = ('0' + date.getDate()).slice(-2);
  return `${y}-${m}-${d}`;
}