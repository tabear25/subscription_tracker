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