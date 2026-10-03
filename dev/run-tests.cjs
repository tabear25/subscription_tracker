// ローカル（Node.js）でテストを実行する開発用スクリプト。GASには貼り付けない。
//   node dev/run-tests.cjs
// GASのサービス（UrlFetchApp など）を差し替えたうえで main.js / webhook.js / test.js を読み込み、
//   1) test.js の testLogic()（GASエディタで実行するものと同じ単体テスト）
//   2) LINEでの会話シナリオ（Notion・LINEはメモリ上の偽物）
//   3) 毎日の main()（請求予告・解約リマインド）のシナリオ
// を実行する。外部への通信は一切しない。
'use strict';
process.env.TZ = 'Asia/Tokyo';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SOURCE = ['main.js', 'webhook.js', 'test.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');

// ---------- GAS / Notion / LINE の偽物 ----------
const lineViolations = []; // LINEの仕様違反（本物なら 400 で送信失敗するもの）

// LINE Messaging API の上限チェック（文字数はUTF-16単位＝String.lengthで数える）
function lineMessageViolations(message) {
  const v = [];
  if (message.text.length > 5000) v.push('text > 5000');
  const items = message.quickReply ? message.quickReply.items : [];
  if (items.length > 13) v.push('quickReply > 13 items');
  items.forEach(i => {
    if (!i.action.label || i.action.label.length > 20) v.push(`label > 20: ${i.action.label}`);
    if (i.action.text.length > 300) v.push(`action text > 300: ${i.action.text}`);
  });
  return v;
}

function createEnv({ now, pages = [], props = {}, notionDown = false }) {
  const fixedNow = new Date(now).getTime();
  class FakeDate extends Date {
    constructor(...args) { if (args.length === 0) super(fixedNow); else super(...args); }
    static now() { return fixedNow; }
  }
  const store = Object.assign({ NOTION_TOKEN: 'test', DATABASE_ID: 'db', LINE_CHANNEL_ACCESS_TOKEN: 'test' }, props);
  const db = JSON.parse(JSON.stringify(pages));
  const sent = [];    // LINEに送ったメッセージ { type: 'reply'|'broadcast', message }
  const patches = []; // Notionへの更新 { id, properties }
  const logs = [];
  const res = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });

  const UrlFetchApp = {
    fetch(url, options = {}) {
      const body = options.payload ? JSON.parse(options.payload) : {};
      if (/\/v1\/databases\/[^/]+\/query$/.test(url)) {
        if (notionDown) {
          if (!options.muteHttpExceptions) throw new Error('Notion is down');
          return res(500, {});
        }
        const f = body.filter;
        const results = db.filter(p => !f || (p.properties[f.property].select || {}).name === f.select.equals);
        return res(200, { results, has_more: false, next_cursor: null });
      }
      const m = url.match(/\/v1\/pages\/([^/]+)$/);
      if (m) {
        const page = db.find(p => p.id === m[1]);
        patches.push({ id: m[1], properties: body.properties });
        Object.keys(body.properties).forEach(k => {
          const v = body.properties[k];
          page.properties[k] = v.select ? { type: 'select', select: v.select } : { type: 'date', date: v.date };
        });
        return res(200, page);
      }
      if (/api\.line\.me\/v2\/bot\/message\/(reply|broadcast)$/.test(url)) {
        const violations = lineMessageViolations(body.messages[0]);
        if (violations.length > 0) {
          lineViolations.push(...violations);
          return res(400, { message: violations.join(', ') });
        }
        sent.push({ type: url.endsWith('reply') ? 'reply' : 'broadcast', message: body.messages[0] });
        return res(200, {});
      }
      return res(404, {});
    }
  };
  const pad = n => ('0' + n).slice(-2);
  const ctx = vm.createContext({
    Date: FakeDate,
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' ')) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = String(v); },
      deleteProperty: k => { delete store[k]; }
    }) },
    UrlFetchApp,
    Utilities: { formatDate: (d, tz, fmt) => fmt
      .replace('yyyy', d.getFullYear()).replace('MM', pad(d.getMonth() + 1)).replace('dd', pad(d.getDate()))
      .replace(/\bM\b/, d.getMonth() + 1).replace(/\bd\b/, d.getDate()) },
    CalendarApp: { getDefaultCalendar: () => ({ createAllDayEvent: () => {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: () => ({ setMimeType: () => ({}) }) }
  });
  vm.runInContext(SOURCE, ctx, { filename: 'gas-bundle.js' });

  // LINEから文章を送ったことにして、返信を返す
  function say(text, userId = 'U1') {
    const before = sent.length;
    ctx.doPost({ postData: { contents: JSON.stringify({ events: [{
      type: 'message', replyToken: 'r', source: { userId }, message: { type: 'text', text } }] }) } });
    const reply = sent.slice(before).find(s => s.type === 'reply');
    assert.ok(reply, `返信がありません: ${text}`);
    return {
      text: reply.message.text,
      buttons: (reply.message.quickReply ? reply.message.quickReply.items : []).map(i => i.action.text)
    };
  }
  const pending = () => JSON.parse(store.PENDING_CANCELS || '{}');
  return { ctx, store, db, sent, patches, logs, say, pending };
}

function page(id, o) {
  const select = name => ({ type: 'select', select: name ? { name } : null });
  const text = s => ({ type: 'rich_text', rich_text: s ? [{ plain_text: s }] : [] });
  const url = s => ({ type: 'url', url: s || null });
  return { id, properties: {
    Name: { type: 'title', title: o.name ? [{ plain_text: o.name }] : [] },
    URL: url(o.url),
    '解約用URL': url(o.cancelUrl),
    '再契約URL': url(o.restartUrl),
    '更新日': { type: 'date', date: o.date ? { start: o.date } : null },
    '料金': { type: 'number', number: o.price === undefined ? null : o.price },
    Billing: select(o.billing),
    Status: select(o.status),
    '最終利用日': { type: 'date', date: o.lastUsed ? { start: o.lastUsed } : null },
    '解約方法': text(o.howto),
    '支払方法': select(o.pay),
    '別名': text(o.aliases)
  } };
}

// ---------- テストの実行 ----------
const results = [];
function test(name, fn) {
  try { fn(); results.push(['✅', name]); } catch (e) { results.push(['❌', name, e.message]); }
}

test('testLogic()（test.js の単体テスト）', () => {
  const env = createEnv({ now: '2026-10-02T10:00:00+09:00' });
  env.ctx.testLogic();
  const failures = env.logs.filter(l => l.startsWith('ERROR'));
  assert.deepStrictEqual(failures, []);
  assert.match(env.logs[env.logs.length - 1], /0 件失敗/);
});

const PAGES = [
  page('netflix', { name: 'Netflix', date: '2026-10-15', price: 1490, billing: 'Monthly', status: 'Active', lastUsed: '2026-09-20' }),
  page('spotify', { name: 'Spotify', date: '2026-10-05', price: 980, billing: 'Monthly', status: 'Active', pay: 'App Store' }),
  page('disney', { name: 'Disney Plus', date: '2026-05-01', price: 990, billing: 'Monthly', status: 'Canceled' }),
  page('adobe', { name: 'Adobe Creative Cloud', date: '2027-03-01', price: 86880, billing: 'Yearly', status: 'Active', aliases: 'アドビ' }),
  page('gym', { name: 'ジム', date: '2026-10-31', price: 8000, billing: 'Monthly', status: 'Active', howto: '受付で退会届を出す' })
];
const chat = () => createEnv({ now: '2026-10-02T10:00:00+09:00', pages: PAGES, props: { ALLOWED_LINE_USER_IDS: 'U1' } });

test('会話: 「いつ支払い？」に次回支払日で答える（呼び名・別名でも）', () => {
  const env = chat();
  assert.match(env.say('Netflixっていつ支払いだっけ？').text, /次回支払日: 10\/15（木） あと13日/);
  assert.match(env.say('ネトフリの次の引き落としは？').text, /📅 Netflix/);
  assert.match(env.say('アドビっていくら？').text, /¥86,880（毎年）/);
  assert.match(env.say('来月の支払い').text, /来月（11月）の支払い予定（3件・合計 ¥10,470）/);
});

test('会話: 解約したい → 案内（Notionは変えない）→ 解約した → Canceled', () => {
  const env = chat();
  const guide = env.say('Netflix解約したい');
  assert.match(guide.text, /https:\/\/www\.netflix\.com\/cancelplan/);
  assert.match(guide.text, /2日前の 10\/13（火） までに/);
  assert.deepStrictEqual(guide.buttons, ['Netflix 解約済み', 'Netflix 続ける']);
  assert.strictEqual(env.patches.length, 0);
  assert.ok(env.pending().netflix);

  assert.match(env.say('解約した').text, /✅ Netflix を解約済み/); // 名前なしでも直前の案内のサービス
  assert.deepStrictEqual(env.patches, [{ id: 'netflix', properties: { Status: { select: { name: 'Canceled' } } } }]);
  assert.strictEqual(env.pending().netflix, undefined);

  assert.match(env.say('Netflix 解約取り消し').text, /契約中（Active）に戻しました/);
});

test('会話: App Store経由・自分で書いた手順を案内に出す', () => {
  const env = chat();
  assert.match(env.say('Spotify解約したい').text, /App Store経由の課金[\s\S]*apps\.apple\.com\/account\/subscriptions/);
  const gym = env.say('ジムやめたい').text;
  assert.match(gym, /受付で退会届を出す/);
  assert.doesNotMatch(gym, /google\.com\/search/);
});

test('会話: 再契約したい → 再契約した → Active＋次回支払日', () => {
  const env = chat();
  assert.match(env.say('disney 再契約したい').text, /今日再契約した場合の次回支払日（目安）: 11\/2（月）/);
  env.say('再契約した');
  assert.deepStrictEqual(env.patches, [{ id: 'disney', properties: {
    Status: { select: { name: 'Active' } }, '更新日': { date: { start: '2026-11-02' } } } }]);
  assert.match(env.say('これいつ？').text, /📅 Disney Plus/);
});

test('会話: 特定できないときはボタンで聞き返す・誤操作しない', () => {
  const env = chat();
  const ask = env.say('解約したい');
  assert.match(ask.text, /どのサービスを解約しますか？/);
  assert.deepStrictEqual(ask.buttons, ['Spotify 解約したい', 'Netflix 解約したい', 'ジム 解約したい', 'Adobe Creative Cloud 解約したい']);
  env.say('Netflixいつ？');
  assert.match(env.say('解約した').text, /どのサービスを解約済みにしますか？/); // 案内していないので文脈は使わない
  assert.match(env.say('Hulu 解約したい').text, /「hulu」はNotionに見つかりませんでした/);
  assert.strictEqual(env.patches.length, 0);
});

test('会話: Notionの「解約用URL」「再契約URL」を優先し、バンドル契約を取り違えない', () => {
  const env = createEnv({ now: '2026-10-02T10:00:00+09:00', props: { ALLOWED_LINE_USER_IDS: 'U1' }, pages: [
    page('claude', { name: 'Claude', date: '2026-10-10', price: 21140, billing: 'Monthly', status: 'Active',
      url: 'https://claude.ai/settings', cancelUrl: 'https://claude.ai/settings/billing', restartUrl: 'https://claude.ai/upgrade' }),
    page('lyp', { name: 'LYP Premium with Netflix', date: '2026-10-25', price: 2290, billing: 'Monthly', status: 'Active',
      cancelUrl: 'https://premium.lycorp.co.jp/cancel' }),
    page('netflix', { name: 'Netflix', date: '2026-02-28', billing: 'Monthly', status: 'Canceled',
      restartUrl: 'https://www.netflix.com/signup' }),
    page('blank', { name: '' })
  ] });
  const claude = env.say('Claude解約したい').text;
  assert.match(claude, /🔗 https:\/\/claude\.ai\/settings\/billing/);
  assert.doesNotMatch(claude, /App Store・Google Play/); // 自分で書いたURLがあれば一般的な注意は出さない
  const lyp = env.say('ネトフリ解約したい').text;       // 契約中のNetflixはLYP経由のもの
  assert.match(lyp, /LYP Premium with Netflix の解約[\s\S]*premium\.lycorp\.co\.jp\/cancel/);
  assert.doesNotMatch(lyp, /netflix\.com\/cancelplan/);
  assert.match(env.say('Netflix再契約したい').text, /🔗 https:\/\/www\.netflix\.com\/signup/);
  assert.doesNotMatch(env.say('解約済み一覧').text, /No Name/); // 名前が空の行は出さない
});

test('会話: 許可されていないユーザーは操作できない', () => {
  const env = chat();
  assert.match(env.say('Netflix解約した', 'U-other').text, /許可されていません/);
  assert.strictEqual(env.patches.length, 0);
});

const PENDING = JSON.stringify({
  spotify: { name: 'Spotify', since: '2026-09-28' },
  yt: { name: 'YouTube Premium', since: '2026-09-28' },
  hulu: { name: 'Hulu', since: '2026-09-28' },
  disney: { name: 'Disney Plus', since: '2026-09-01' }
});
const DAILY = [
  page('netflix', { name: 'Netflix', date: '2026-10-09', price: 1490, billing: 'Monthly', status: 'Active' }),
  page('spotify', { name: 'Spotify', date: '2026-10-05', price: 980, billing: 'Monthly', status: 'Active' }),
  page('yt', { name: 'YouTube Premium', date: '2026-10-03', price: 1280, billing: 'Monthly', status: 'Active' }),
  page('hulu', { name: 'Hulu', date: '2026-10-04', price: 1026, billing: 'Monthly', status: 'Active' }),
  page('disney', { name: 'Disney Plus', date: '2026-05-01', price: 990, billing: 'Monthly', status: 'Canceled' }),
  page('gym31', { name: 'Gym', date: '2026-08-31', price: 8000, billing: 'Monthly', status: 'Active' })
];

test('毎日のmain(): 請求予告・解約リマインド（3日前と前日）・掃除・31日払いの繰り上げ', () => {
  const env = createEnv({ now: '2026-10-02T08:30:00+09:00', pages: DAILY, props: { ALLOWED_LINE_USER_IDS: 'U1', PENDING_CANCELS: PENDING } });
  env.ctx.main();
  const texts = env.sent.map(s => s.message.text);
  assert.strictEqual(texts.length, 3);
  assert.match(texts[0], /請求予告\nNetflix/);
  assert.deepStrictEqual(env.sent[0].message.quickReply.items.map(i => i.action.text), ['Netflix 解約したい', '支払い予定']);
  assert.match(texts[1], /解約手続きはお済みですか？\nSpotify[\s\S]*あと3日/);
  assert.match(texts[2], /YouTube Premium[\s\S]*明日/);
  assert.ok(!texts.some(t => /Hulu/.test(t))); // 2日前は送らない
  assert.deepStrictEqual(Object.keys(env.pending()).sort(), ['hulu', 'spotify', 'yt']); // 解約済みのDisneyは外れる
  assert.deepStrictEqual(env.patches, [{ id: 'gym31', properties: { '更新日': { date: { start: '2026-10-31' } } } }]);
});

test('毎日のmain(): Webhook未設定ならボタンなし・Notion障害時は解約待ちを消さない', () => {
  const plain = createEnv({ now: '2026-10-02T08:30:00+09:00', pages: [DAILY[0]] });
  plain.ctx.main();
  assert.strictEqual(plain.sent[0].message.quickReply, undefined);

  const down = createEnv({ now: '2026-10-02T08:30:00+09:00', pages: DAILY, props: { PENDING_CANCELS: PENDING }, notionDown: true });
  down.ctx.main();
  assert.strictEqual(down.store.PENDING_CANCELS, PENDING);
});

test('長いサービス名でもLINEの文字数制限内に収まる（月末リマインド・会話）', () => {
  const longName = 'Adobe Creative Cloud コンプリートプラン（年間・月々払い）';
  const pages = [
    page('long', { name: longName, date: '2026-11-15', price: 7780, billing: 'Monthly', status: 'Active', lastUsed: '2026-06-01' }),
    page('long2', { name: longName + ' 2', date: '2026-11-20', price: 1000, billing: 'Monthly', status: 'Active', lastUsed: '2026-06-01' })
  ];
  const monthEnd = createEnv({ now: '2026-10-31T08:30:00+09:00', pages, props: { ALLOWED_LINE_USER_IDS: 'U1' } });
  monthEnd.ctx.main();
  assert.strictEqual(monthEnd.sent.length, 1);
  const env = createEnv({ now: '2026-10-02T10:00:00+09:00', pages, props: { ALLOWED_LINE_USER_IDS: 'U1' } });
  env.say('解約したい');
  env.say('adobe いつ？');
  env.say(`${longName}と${longName} 2 いつ？`);
});

test('LINEに送ったメッセージがすべて仕様の上限内', () => {
  assert.deepStrictEqual(lineViolations, []);
});

results.forEach(r => console.log(r.slice(0, 2).join(' ') + (r[2] ? `\n   ${r[2].split('\n').join('\n   ')}` : '')));
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - failed} 件成功 / ${failed} 件失敗`);
process.exitCode = failed ? 1 : 0;
