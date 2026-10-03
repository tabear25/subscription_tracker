// ==========================================
// ▼ LINE Webhook（双方向対応）▼
// ------------------------------------------
// このGASプロジェクトを「ウェブアプリ」としてデプロイし、
// 発行されたURLを LINE Developers Console の Webhook URL に設定すると、
// LINEのトークに送ったふつうの文章でサブスクを確認・操作できる。
//
// 話しかけ方の例（サービス名はNotionの「Name」か「別名」。一部だけでもOK）:
//   Netflixっていつ支払いだっけ？         … 次回支払日・金額
//   支払い予定 / 今月の支払い / 来月いくら？ … 近い支払いの一覧と合計
//   一覧                                   … 契約中のサブスクと月額/年額合計
//   Netflix解約したい                      … 解約方法と期限を案内（Notionはまだ変えない）
//   Netflix解約した / 解約済み              … Notionを Canceled にして通知を止める
//   Netflix再契約したい                    … 再契約ページと次回支払日の目安を案内
//   Netflix再契約した                      … Notionを Active に戻し、次回支払日をセット
//   Netflix続ける / 解約取り消し            … 解約リマインドを止める・解約済みを取り消す
//   Netflix使った                          … 最終利用日を今日に記録（未使用検知用）
//   解約済み一覧 / ヘルプ
//   ※ 名前を省いた「これいつ？」「解約した」は、直前に話したサービス（または今日の通知）として扱う。
//
// 解約は「案内 → 完了の報告」の2段階にしている。各サービスの解約は外部から代行できない
// （公開APIが無い）ため、Notionだけ先に解約済みにして通知が止まり、実際には請求が続く…
// という事故を防ぐ。案内したまま報告が無ければ、支払日の前にLINEで念押しする（main.js）。
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

// 「支払い予定」で表示する日数
const UPCOMING_DAYS = 30;
// 1回の発言で同時に扱うサービスの上限（返信が長くなりすぎないように）
const MAX_TARGETS_PER_MESSAGE = 5;

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

  let reply;
  try {
    reply = respondToMessage(text, userId);
  } catch (err) {
    console.log('❌ 返信の作成でエラー: ' + err);
    reply = { text: '❌ 処理中にエラーが発生しました。少し時間をおいてもう一度送ってください。\n' + err };
  }
  replyLineMessage(replyToken, reply.text, reply.quickReply);
}

function isAllowedUser(userId) {
  if (!ALLOWED_LINE_USER_IDS) return true; // 未設定なら制限しない（READMEで設定を強く推奨）
  const allow = ALLOWED_LINE_USER_IDS.split(',').map(s => s.trim()).filter(Boolean);
  return !!userId && allow.indexOf(userId) !== -1;
}

// 受け取った文章への返信を作る。戻り値: { text, quickReply }
function respondToMessage(text, userId) {
  const intent = detectIntent(text);
  if (intent.action === 'help') return helpReply();

  const pages = fetchAllNotionPages();
  if (!pages) return { text: '❌ Notionからデータを取得できませんでした。少し時間をおいてもう一度送ってください。' };
  if (intent.action === 'canceledList') return canceledListReply(pages);

  const today = startOfToday();
  const resolved = resolveTargets(intent, text, pages, loadConversationContext(userId));
  const reply = buildReply(intent, resolved, pages, today);
  if (reply.contextIds && reply.contextIds.length > 0) {
    saveConversationContext(userId, reply.contextIds, reply.contextIntent || intent.action);
  }
  return reply;
}

function buildReply(intent, resolved, pages, today) {
  const action = intent.action;
  const targets = resolved.targets;

  if (action === 'list' && resolved.source !== 'exact') return activeListReply(pages, today);
  if (targets.length === 0) {
    // 名前らしき語があったのに見つからなかったら、その旨を添える（例:「hulu」が未登録）
    const notFound = looksLikeName(resolved.rest) ? `「${resolved.rest}」はNotionに見つかりませんでした。` : '';
    if (action === 'payment') return upcomingReply(pages, today, intent.window, notFound);
    if (action === 'cost') {
      return intent.window.explicit ? upcomingReply(pages, today, intent.window, notFound) : activeListReply(pages, today, notFound);
    }
    if (action === 'none') return unknownReply(notFound);
    return askWhichReply(action, defaultCandidates(action, pages, today), notFound);
  }
  const relatedNote = resolved.source === 'related'
    ? `「${resolved.original.map(p => p.name).join('」「')}」は${statusLabel(resolved.original[0])}です。` : '';
  // 名前の一部や文脈から複数に絞りきれないときや、別名の契約に読み替えて状態を変えるときは、取り違えないよう聞き返す
  if ((targets.length > 1 && resolved.source !== 'exact') || (relatedNote && STATE_CHANGING[action])) {
    return askWhichReply(action, targets, relatedNote || (resolved.source === 'partial' ? 'いくつか当てはまりました。' : ''));
  }
  const handler = TARGET_HANDLERS[action] || infoReply; // 問い合わせ（いつ/いくら/名前だけ）は情報カード
  const reply = combineReplies(targets.slice(0, MAX_TARGETS_PER_MESSAGE).map(page => handler(page, today)));
  if (relatedNote) reply.text = `ℹ️ ${relatedNote}契約中の「${targets[0].name}」について答えます。\n\n${reply.text}`;
  return reply;
}

// Notionの状態を変える操作（読み替えで対象を決めたときは実行前に確認する）
const STATE_CHANGING = { cancelDone: true, reactivateDone: true, keep: true, used: true };

// =====================================================================
// 発言の意図を読み取る
//  - キーワードの規則で判定する（毎回同じ結果になり、テストしやすい）。
//  - 複数当てはまるときは「操作」（解約・再契約など）を「問い合わせ」より優先し、
//    その中では文末に近いものを採る（日本語は述語が最後に来るため。
//    例:「解約したけど再契約したい」→ 再契約したい）。同じ位置で終わるなら表の上を優先する。
// =====================================================================

// 「した」の直後がこれなら完了とはみなさない（したい／したら／したか／したっけ／した？）
const NOT_DONE = '(?!い|ら|か|っけ|\\s*\\?)';
const DONE_SUFFIX = `(?:した${NOT_DONE}|しました|しておいた|しといた|してきた|済み?|完了|できた|できました)`;

const INTENT_RULES = [
  { action: 'help', re: /ヘルプ|^help$|使い方|つかいかた|メニュー|できること|コマンド/g },
  { action: 'canceledList', re: /(?:解約|キャンセル)(?:済み?|した)?の?\s*(?:サブスク|サービス|もの|やつ)?\s*(?:一覧|リスト)|(?:解約|キャンセル)(?:済み?|した)の?\s*(?:サブスク|サービス|もの|やつ)/g },
  { action: 'keep', re: /(?:解約|キャンセル)\s*(?:は|を)?\s*(?:しない|しません|やめ(?:る|た|ます|とく|ておく|よう|よっ)?|取り?消(?:す|し|した)?|中止)|やっぱ(?:り)?\s*(?:続け|継続|残)|継続(?:する|します|したい|で)|続ける|続けます|続けたい/g },
  { action: 'cancelDone', re: new RegExp(`(?:解約|退会|キャンセル)\\s*${DONE_SUFFIX}|(?:やめ|辞め|止め)(?:た${NOT_DONE}|ました)`, 'g') },
  { action: 'reactivateDone', re: new RegExp(`(?:再契約|再開|再登録|再加入|再入会)\\s*${DONE_SUFFIX}|入り直し(?:た${NOT_DONE}|ました)`, 'g') },
  { action: 'reactivateWant', re: /再契約|再開|再登録|再加入|再入会|入り直|また\s*(?:使|始|入|契約|加入|登録|見|聴|聞)|もう一(?:回|度)\s*(?:使|始|入|契約|加入|登録)|復活/g },
  { action: 'cancelWant', re: /解約|退会|キャンセル|(?:やめ|辞め|止め)(?:たい|る|よう|よっ|ます|とく)/g },
  { action: 'used', re: new RegExp(`使っ(?:た${NOT_DONE}|てる|ています)|使いました|(?:利用|使用)し(?:た${NOT_DONE}|ました)`, 'g') },
  // ここから下は「問い合わせ」。上の「操作」が1つも当てはまらないときだけ使う。
  { action: 'payment', query: true, re: /いつ|支払い?|払い|払う|引き?落と?し|請求|課金|更新日|次回|何日|期限|締め|予定|スケジュール|今後|直近|これから|今月|来月|今週|来週/g },
  { action: 'cost', query: true, re: /いくら|金額|料金|値段|合計|総額|月額|年額|トータル|出費|支出|固定費|費用/g },
  { action: 'list', query: true, re: /一覧|リスト|^list$|契約中|全部|全て|すべて|何を?契約|契約して(?:る|い)/g }
];

// 戻り値: { action, window }。action が 'none' なら意図の語なし（サービス名だけ、など）。
function detectIntent(text) {
  const norm = normalizeText(text);
  let best = null;
  INTENT_RULES.forEach((rule, order) => {
    const end = lastMatchEnd(rule.re, norm);
    if (end < 0) return;
    // 「使ったのいつ？」のような質問は利用記録にしない
    if (rule.action === 'used' && /\?|いつ/.test(norm)) return;
    const candidate = { action: rule.action, end: end, order: order, query: !!rule.query };
    if (!best || isPreferredIntent(candidate, best)) best = candidate;
  });
  return { action: best ? best.action : 'none', window: detectWindow(norm) };
}

function isPreferredIntent(a, b) {
  if (a.query !== b.query) return !a.query;
  if (a.end !== b.end) return a.end > b.end;
  return a.order < b.order;
}

// 正規表現（gフラグ付き）が最後に当てはまった位置の終端。無ければ -1。
function lastMatchEnd(re, text) {
  re.lastIndex = 0;
  let end = -1;
  let m;
  while ((m = re.exec(text)) !== null) {
    end = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  return end;
}

// 「今月」「来月」「今週」「来週」→ 支払い予定を出す期間
function detectWindow(norm) {
  if (/今月/.test(norm)) return { type: 'month', offset: 0, explicit: true };
  if (/来月/.test(norm)) return { type: 'month', offset: 1, explicit: true };
  if (/今週/.test(norm)) return { type: 'days', days: 7, explicit: true };
  if (/来週/.test(norm)) return { type: 'days', days: 14, explicit: true };
  return { type: 'days', days: UPCOMING_DAYS, explicit: false };
}

// 全角/半角・大文字/小文字・空白の違いをならす（「Ｎｅｔｆｌｉｘ？」→「netflix?」）
function normalizeText(text) {
  let t = String(text == null ? '' : text);
  try { t = t.normalize('NFKC'); } catch (e) { /* 正規化できない環境ではそのまま使う */ }
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
}

// =====================================================================
// 発言に出てくるサービスを探す
//  1) Name・別名（Notionの「別名」列や、よく使われる呼び名）が文中にそのまま出てくるもの
//  2) 無ければ、名前の一部だけ書かれたもの（例:「disney」→「Disney Plus」）
//  3) それも無ければ、直前に話したサービス（「これ」「それ」や、名前なしの続きの発言）
// =====================================================================

// 解約系・問い合わせは契約中のものを、再契約系は契約中でないものを優先する
const PREFERS_INACTIVE = { reactivateWant: true, reactivateDone: true };
// 文脈（直前のサービス）を使う条件
const QUERY_ACTIONS = { payment: true, cost: true, none: true };
const DONE_REQUIRES = { cancelDone: 'cancelWant', reactivateDone: 'reactivateWant' };
const DEMONSTRATIVE_RE = /これ|それ|あれ|この|その|あの|こいつ|そいつ|こちら|そちら/;

function resolveTargets(intent, text, pages, context) {
  const norm = normalizeText(text);
  const mention = findMentionedPages(norm, pages);
  let targets = mention.pages;
  let source = mention.exact ? 'exact' : 'partial';
  if (targets.length === 0) {
    targets = contextPages(intent.action, norm, mention.rest, pages, context);
    source = 'context';
  }
  const wantActive = !PREFERS_INACTIVE[intent.action];
  const fits = p => isActive(p) === wantActive;
  const preferred = targets.filter(fits);
  const original = targets;
  if (preferred.length > 0) {
    targets = preferred;
  } else if (source === 'context') {
    // 文脈から拾ったサービスが意図に合わない状態なら（契約中のものを「再契約したい」など）、候補から聞き直す
    targets = [];
  } else if (source === 'exact') {
    // 名前どおりのページが意図に合わない状態なら、その名前を含む別の契約を探す
    // （例: Notionの「Netflix」は解約済みで、いま契約中なのは「LYP Premium with Netflix」）
    const related = relatedPages(targets, pages).filter(fits);
    if (related.length > 0) {
      targets = related;
      source = 'related';
    }
  }
  return { targets: targets, source: source, rest: mention.rest, original: original };
}

// matched の名前（呼び名を含む）を、単語として名前に含む別のページ
function relatedPages(matched, pages) {
  const names = [];
  matched.forEach(m => pageNameKeys(m).forEach(k => { if (names.indexOf(k.key) === -1) names.push(k.key); }));
  return pages.filter(p => matched.indexOf(p) === -1 &&
    pageNameKeys(p).some(k => names.some(n => findKeyInText(k.key, n) !== -1)));
}

function contextPages(action, norm, rest, pages, context) {
  if (!context || !context.ids || context.ids.length === 0) return [];
  if (action === 'list') return [];
  if (looksLikeName(rest)) return []; // 別のサービス名らしき語がある
  const pointing = DEMONSTRATIVE_RE.test(norm);
  // 問い合わせは「これ」「それ」と言ったときだけ（「今月の支払い」などを取り違えないため）
  if (QUERY_ACTIONS[action] && !pointing) return [];
  // 直前の話題が複数（支払い予定の一覧など）なら、「これ」「それ」と言ったときだけその中から選ぶ
  if (context.ids.length > 1 && !pointing) return [];
  // 「解約した」「再契約した」は、直前に同じサービスの案内をした流れのときだけ（誤操作防止）
  if (DONE_REQUIRES[action] && context.intent !== DONE_REQUIRES[action]) return [];
  return context.ids.map(id => pages.find(p => p.pageId === id)).filter(Boolean);
}

// 戻り値: { pages, exact, rest }。rest は意図の語や助詞を除いた残り（名前の手がかり）。
function findMentionedPages(text, pages) {
  const norm = normalizeText(text);
  const rest = nameRemainder(norm);

  const hits = [];
  pages.forEach(page => {
    let best = null;
    pageNameKeys(page).forEach(k => {
      const idx = findKeyInText(norm, k.key);
      if (idx === -1) return;
      const hit = { page: page, start: idx, end: idx + k.key.length, rank: k.rank };
      if (!best || isBetterHit(hit, best)) best = hit;
    });
    if (best) hits.push(best);
  });
  if (hits.length > 0) return { pages: pickNonOverlapping(hits).map(h => h.page), exact: true, rest: rest };

  const found = [];
  rest.split(' ').filter(isNameToken).forEach(token => {
    pages.forEach(page => {
      if (found.indexOf(page) === -1 && pageNameKeys(page).some(k => k.key.indexOf(token) !== -1)) found.push(page);
    });
  });
  return { pages: found, exact: false, rest: rest };
}

// ページの呼び名（正規化済み）。rank: 0=Name, 1=Notionの「別名」, 2=よく使われる呼び名（組み込み）
function pageNameKeys(page) {
  const keys = [];
  const add = (raw, rank) => {
    const n = normalizeText(raw);
    [n, n.replace(/ /g, '')].forEach(key => {
      if (key && !keys.some(k => k.key === key)) keys.push({ key: key, rank: rank });
    });
  };
  add(page.name, 0);
  (page.aliases || []).forEach(a => add(a, 1));
  const preset = findServicePreset(page.name);
  if (preset) preset.names.forEach(a => add(a, 2));
  return keys;
}

// 文中で key が出てくる位置。英数字は単語の途中では一致させない（「x」が「netflix」に当たらないように）。
function findKeyInText(text, key) {
  const alnum = /[a-z0-9]/;
  let from = 0;
  while (true) {
    const idx = text.indexOf(key, from);
    if (idx === -1) return -1;
    const okBefore = !alnum.test(key.charAt(0)) || !alnum.test(text.charAt(idx - 1));
    const okAfter = !alnum.test(key.charAt(key.length - 1)) || !alnum.test(text.charAt(idx + key.length));
    if (okBefore && okAfter) return idx;
    from = idx + 1;
  }
}

function isBetterHit(a, b) {
  const lenA = a.end - a.start;
  const lenB = b.end - b.start;
  return lenA !== lenB ? lenA > lenB : a.rank < b.rank;
}

// 重なった一致は長いほう（同じ長さなら Name を）採る。「Prime Video」と書いたら「Prime」は外す。
function pickNonOverlapping(hits) {
  const sorted = hits.slice().sort((a, b) => ((b.end - b.start) - (a.end - a.start)) || (a.rank - b.rank));
  const chosen = [];
  sorted.forEach(h => {
    const clash = chosen.some(c => h.start < c.end && c.start < h.end &&
      !(h.start === c.start && h.end === c.end && h.rank === c.rank));
    if (!clash) chosen.push(h);
  });
  return chosen.sort((a, b) => a.start - b.start);
}

// 名前の部分一致・文脈の判定用に、意図の語や助詞などを取り除いた残りを返す
const FILLER_WORDS = [
  'お願いします', 'よろしく', 'お願い', 'おねがい', 'ください', '下さい', '教えて', 'おしえて', '知りたい',
  '見せて', 'みせて', '確認したい', '確認', '方法', 'やり方', '手続き', '手続', '手順', 'ページ', 'リンク', 'url',
  'なんにち', '何日', '次の', '次', '今度', '日付', 'どうやって', 'どうすれば', 'どうしたら', 'どう', 'どこから',
  'どこで', 'どこ', 'どれ', 'こと', 'もの', 'やつ', 'サブスク', 'サービス', 'プラン', '会員', 'メンバーシップ',
  'アカウント', '契約', 'じゃあ', 'じゃ', 'では', 'なら', 'えっと', 'ちょっと', 'とりあえず', 'ねえ', 'こいつ',
  'そいつ', 'こちら', 'そちら', 'これ', 'それ', 'あれ', 'この', 'その', 'あの', 'ってさ', 'って', 'だっけ', 'っけ',
  'だった', 'だよね', 'かなあ', 'かなー', 'かな', 'ですか', 'ますか', 'です', 'ます', 'しようかな', 'しよう',
  'したい', 'したく', 'したら', 'する', 'して', 'した', 'たい', 'いい', 'もう', 'まだ', '今日', '明日', '昨日',
  'まで', 'から', 'だけ', 'けれど', 'けど', 'ので', 'のに', 'ある', 'ない', 'いる', 'なの', '何',
  'カレンダー', 'まとめ', '全体', '状況', 'お金'
];
const FILLER_RE = new RegExp(
  FILLER_WORDS.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|') + '|[をはがもにへとでやかなよねのわだ]',
  'g');

function nameRemainder(norm) {
  let s = norm;
  INTENT_RULES.forEach(rule => { s = s.replace(rule.re, ' '); });
  return s.replace(FILLER_RE, ' ')
    .replace(/[?!.,、。・…~〜「」『』()\[\]【】:：;；'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// サービス名らしい語か（英数字なら3文字以上、それ以外は2文字以上でカタカナ・漢字・英数字を含む）
function isNameToken(token) {
  if (/^[a-z0-9.+\-&']+$/.test(token)) return token.length >= 3;
  return Array.from(token).length >= 2 && /[a-z0-9\u30a1-\u30fa\u4e00-\u9fff]/.test(token);
}

function looksLikeName(rest) {
  return (rest || '').split(' ').some(isNameToken);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =====================================================================
// サービスごとの返信
//  各関数は { name, text, quickReply, contextIds, contextIntent } を返す。
//  contextIds は「直前に話したサービス」として覚えるページID。
// =====================================================================

const TARGET_HANDLERS = {
  cancelWant: cancelGuideReply,
  cancelDone: cancelDoneReply,
  keep: keepReply,
  reactivateWant: reactivateGuideReply,
  reactivateDone: reactivateDoneReply,
  used: usedReply
};

function isActive(page) { return page.status === ACTIVE_VALUE; }
function isCanceled(page) { return page.status === CANCELED_VALUE; }

function statusLabel(page) {
  if (isActive(page)) return '契約中';
  if (isCanceled(page)) return '解約済み';
  return page.status ? `Status「${page.status}」` : 'Status未設定';
}

// 「次回支払日: 10/15（木） あと13日」
function nextPaymentLine(page, today) {
  const next = nextPaymentDate(page, today);
  if (!next) return '次回支払日: 未登録（Notionの「更新日」に入れてください）';
  if (next.stale) return `次回支払日: ${formatDateJa(next.date, today)}のまま（Billing未設定のため自動で進められません）`;
  return `次回支払日: ${formatDateJa(next.date, today)} ${describeDaysUntil(daysBetween(today, next.date))}`;
}

// 「いつ支払い？」「いくら？」やサービス名だけのときの情報カード
function infoReply(page, today) {
  if (isCanceled(page)) {
    return {
      name: page.name,
      text: [
        `ℹ️ ${page.name}（解約済み）`,
        `金額: ${priceWithCycle(page)}`,
        '',
        `再契約するときは「${page.name} 再契約したい」と送ってください。`
      ].join('\n'),
      quickReply: [quickReplyItem('🔄 再契約したい', `${page.name} 再契約したい`)],
      contextIds: [page.pageId],
      contextIntent: 'info'
    };
  }
  const lines = [`📅 ${page.name}`, nextPaymentLine(page, today), `金額: ${priceWithCycle(page)}`];
  if (!isActive(page)) lines.push(`※ ${statusLabel(page)}のため、支払予告の対象外です。`);
  if (loadPendingCancels()[page.pageId]) lines.push('⏳ 解約手続き待ち（済んだら「解約済み」と送ってください）');
  const lastUsed = parseYmd(page.lastUsed);
  if (lastUsed) lines.push(`最終利用: ${formatDateJa(lastUsed, today)} ${describeDaysUntil(daysBetween(today, lastUsed))}`);
  return {
    name: page.name,
    text: lines.join('\n'),
    quickReply: [
      quickReplyItem('🛑 解約したい', `${page.name} 解約したい`),
      quickReplyItem('📅 支払い予定', '支払い予定')
    ],
    contextIds: [page.pageId],
    contextIntent: 'info'
  };
}

// 「解約したい」: 解約方法と期限を案内し、完了の報告を待つ（Notionはまだ変えない）
function cancelGuideReply(page, today) {
  if (isCanceled(page)) {
    return {
      name: page.name,
      text: `${page.name} はすでに解約済みです。\n再契約するときは「${page.name} 再契約したい」と送ってください。`,
      quickReply: [quickReplyItem('🔄 再契約したい', `${page.name} 再契約したい`)],
      contextIds: [page.pageId],
      contextIntent: 'info'
    };
  }
  setPendingCancel(page, today);

  const lines = [`🛑 ${page.name} の解約`, nextPaymentLine(page, today), `金額: ${priceWithCycle(page)}`];
  const next = nextPaymentDate(page, today);
  if (next && !next.stale) lines.push(cancelDeadlineHint(next.date, daysBetween(today, next.date), today));
  lines.push('');
  procedureLines(resolveCancelProcedure(page), '解約方法', '💡 Notionの「解約用URL」「解約方法」に書いておくと、ここに表示します。')
    .forEach(l => lines.push(l));
  lines.push('');
  lines.push(`手続きが終わったら「${page.name} 解約済み」と送ってください（下のボタンでもOK）。Notionを解約済みにして通知を止めます。`);
  lines.push(`⏰ それまでは支払日の${reminderDaysText()}にリマインドします（不要なら「続ける」）。`);
  return {
    name: page.name,
    text: lines.join('\n'),
    quickReply: [
      quickReplyItem('✅ 解約済みにした', `${page.name} 解約済み`),
      quickReplyItem('👌 やめずに続ける', `${page.name} 続ける`)
    ],
    contextIds: [page.pageId],
    contextIntent: 'cancelWant'
  };
}

function cancelDeadlineHint(date, days, today) {
  if (days <= 0) return '⚠️ 今日が支払日です。今回分は請求済みかもしれません。次回分を止めるなら早めに手続きを。';
  if (days === 1) return '⚠️ 明日が支払日です。今日中の手続きがおすすめです。';
  return `→ 前日の ${formatDateJa(addDays(date, -1), today)} までに手続きすれば、次回の請求を止められることが多いです。`;
}

function reminderDaysText() {
  return CANCEL_REMINDER_DAYS.map(d => (d === 1 ? '前日' : `${d}日前`)).join('と');
}

// 「解約した」「解約済み」: Notionを Canceled にする
function cancelDoneReply(page, today) {
  if (isCanceled(page)) {
    clearPendingCancel(page.pageId);
    return { name: page.name, text: `${page.name} はすでに解約済みです。`, contextIds: [page.pageId] };
  }
  const ok = updateNotionProperties(page.pageId, { [PROP_STATUS]: statusValue(page, CANCELED_VALUE) });
  if (!ok) return { name: page.name, text: `❌「${page.name}」の更新に失敗しました。` };
  clearPendingCancel(page.pageId);

  const lines = [`✅ ${page.name} を解約済み（${CANCELED_VALUE}）にしました。今後の支払予告・リマインドは届きません。`];
  const preset = findServicePreset(page.name);
  const next = nextPaymentDate(page, today);
  if (preset && preset.endsImmediately) {
    lines.push(`※ ${preset.note}`);
  } else if (next && !next.stale && daysBetween(today, next.date) >= 1) {
    lines.push(`※ 多くのサービスは次回支払日の前日 ${formatDateJa(addDays(next.date, -1), today)} まで使えます。`);
  }
  return {
    name: page.name,
    text: lines.join('\n'),
    quickReply: [quickReplyItem('↩️ 取り消す', `${page.name} 解約取り消し`)],
    contextIds: [page.pageId]
  };
}

// 「続ける」「解約取り消し」: 解約リマインドを止める。解約済みにしていたら契約中に戻す（支払日はそのまま）。
function keepReply(page, today) {
  const wasPending = clearPendingCancel(page.pageId);
  if (isCanceled(page)) {
    const ok = updateNotionProperties(page.pageId, { [PROP_STATUS]: statusValue(page, ACTIVE_VALUE) });
    if (!ok) return { name: page.name, text: `❌「${page.name}」の更新に失敗しました。` };
    return {
      name: page.name,
      text: `↩️ ${page.name} の解約を取り消して、契約中（${ACTIVE_VALUE}）に戻しました。\n${nextPaymentLine(page, today)}`,
      contextIds: [page.pageId]
    };
  }
  return {
    name: page.name,
    text: `👌 ${page.name} は契約を続けます。${wasPending ? '解約リマインドを止めました。' : ''}\n${nextPaymentLine(page, today)}`,
    quickReply: [quickReplyItem('📅 支払い予定', '支払い予定')],
    contextIds: [page.pageId]
  };
}

// 「再契約したい」: 再契約ページと、再契約した場合の次回支払日の目安を案内する（Notionはまだ変えない）
function reactivateGuideReply(page, today) {
  if (isActive(page)) {
    return {
      name: page.name,
      text: `${page.name} は契約中です。\n${nextPaymentLine(page, today)}\n金額: ${priceWithCycle(page)}`,
      quickReply: [quickReplyItem('🛑 解約したい', `${page.name} 解約したい`)],
      contextIds: [page.pageId],
      contextIntent: 'info'
    };
  }
  const lines = [`🔄 ${page.name} の再契約`, ''];
  procedureLines(resolveRestartProcedure(page), '再契約の方法', '💡 Notionの「再契約URL」に申し込みページを書いておくと、ここに表示します。')
    .forEach(l => lines.push(l));
  lines.push('');
  lines.push(`今日再契約した場合の次回支払日（目安）: ${formatDateJa(estimateRestartPaymentDate(page, today), today)}`);
  lines.push(`金額: ${priceWithCycle(page)}（登録されている金額）`);
  lines.push('');
  lines.push(`再契約が終わったら「${page.name} 再契約した」と送ってください（下のボタンでもOK）。Notionを契約中に戻し、次回支払日をセットして通知を再開します。`);
  return {
    name: page.name,
    text: lines.join('\n'),
    quickReply: [quickReplyItem('✅ 再契約した', `${page.name} 再契約した`)],
    contextIds: [page.pageId],
    contextIntent: 'reactivateWant'
  };
}

// 「再契約した」: Notionを Active に戻し、次回支払日（今日から1サイクル後の目安）を入れる
function reactivateDoneReply(page, today) {
  clearPendingCancel(page.pageId);
  if (isActive(page)) {
    return { name: page.name, text: `${page.name} はすでに契約中です。\n${nextPaymentLine(page, today)}`, contextIds: [page.pageId] };
  }
  const next = estimateRestartPaymentDate(page, today);
  const ok = updateNotionProperties(page.pageId, {
    [PROP_STATUS]: statusValue(page, ACTIVE_VALUE),
    [PROP_DATE]: { date: { start: formatIso(next) } }
  });
  if (!ok) return { name: page.name, text: `❌「${page.name}」の更新に失敗しました。` };
  return {
    name: page.name,
    text: [
      `✅ ${page.name} を契約中（${ACTIVE_VALUE}）に戻しました。`,
      `次回支払日: ${formatDateJa(next, today)}（今日再契約した前提の目安${page.billing ? '' : '。Billing未設定のため1ヶ月後で仮置き'}）`,
      '実際の請求日と違う場合は、Notionの「更新日」を直してください。支払予告の通知を再開します。'
    ].join('\n'),
    quickReply: [quickReplyItem('📅 支払い予定', '支払い予定')],
    contextIds: [page.pageId]
  };
}

// 今日再契約した場合の次回支払日（Billing不明ならとりあえず1ヶ月後）
function estimateRestartPaymentDate(page, today) {
  return calculateNextPaymentDate(today, page.billing) || calculateNextPaymentDate(today, 'Monthly');
}

function usedReply(page, today) {
  const ok = updateNotionProperties(page.pageId, {
    [PROP_LAST_USED]: { date: { start: formatIso(today) } }
  });
  return {
    name: page.name,
    text: ok
      ? `✅「${page.name}」の最終利用日を ${formatDate(today)} に記録しました。`
      : `❌「${page.name}」の更新に失敗しました（Notionに「${PROP_LAST_USED}」列があるか確認してください）。`,
    contextIds: [page.pageId]
  };
}

// 複数サービスへの返信を1通にまとめる
function combineReplies(replies) {
  if (replies.length === 1) return replies[0];
  const quick = [];
  const ids = [];
  replies.forEach(r => {
    (r.quickReply || []).forEach(item => {
      let it = item;
      // どのサービスのボタンか分かるように名前を添える（例:「🛑 解約したい（Netflix）」）
      if (r.name && it.action.text.indexOf(r.name + ' ') === 0) {
        const room = 20 - it.action.label.length - 2;
        if (room >= 2) it = quickReplyItem(`${it.action.label}（${truncateChars(r.name, room)}）`, it.action.text);
      }
      if (!quick.some(q => q.action.text === it.action.text)) quick.push(it);
    });
    (r.contextIds || []).forEach(id => { if (ids.indexOf(id) === -1) ids.push(id); });
  });
  return {
    text: replies.map(r => r.text).join('\n\n―――――\n\n'),
    quickReply: quick.slice(0, QUICK_REPLY_MAX),
    contextIds: ids,
    contextIntent: replies[0].contextIntent
  };
}

// =====================================================================
// 一覧系の返信
// =====================================================================

// 「支払い予定」「今月の支払い」「来月いくら？」。lead は先頭に添える一言。
function upcomingReply(pages, today, window, lead) {
  const range = upcomingRange(window, today);
  const actives = pages.filter(isActive);
  const items = [];
  actives.forEach(p => paymentDatesBetween(p, range.from, range.to).forEach(d => items.push({ page: p, date: d })));
  items.sort((a, b) => (a.date - b.date) || a.page.name.localeCompare(b.page.name));
  const quickReply = [
    quickReplyItem('📅 今月', '今月の支払い'),
    quickReplyItem('📅 来月', '来月の支払い'),
    quickReplyItem('📋 一覧', '一覧')
  ];
  const lines = lead ? [lead, ''] : [];

  if (items.length === 0) {
    lines.push(`📅 ${range.label}の支払い予定はありません。`);
    const after = soonestPayment(actives, addDays(range.to, 1));
    if (after) lines.push(`次は ${formatDateJa(after.date, today)} ${after.page.name}（${after.page.price}）です。`);
    return { text: lines.join('\n'), quickReply: quickReply };
  }

  const pending = loadPendingCancels();
  const total = items.reduce((sum, it) => sum + (it.page.priceNumber || 0), 0);
  lines.push(`📅 ${range.label}の支払い予定（${items.length}件・合計 ¥${total.toLocaleString()}）`);
  items.forEach(it => {
    lines.push(`${formatDateJa(it.date, today)} ${it.page.name} ${it.page.price}${pending[it.page.pageId] ? ' ⏳' : ''}`);
  });
  if (items.some(it => pending[it.page.pageId])) lines.push('⏳ = 解約手続き待ち');
  const undated = actives.filter(p => !parseYmd(p.date)).length;
  if (undated > 0) lines.push(`※ 更新日が未登録のサービスが${undated}件あります（Notionに入れると予定に出ます）`);

  const ids = [];
  items.forEach(it => { if (ids.indexOf(it.page.pageId) === -1) ids.push(it.page.pageId); });
  return { text: lines.join('\n'), quickReply: quickReply, contextIds: ids, contextIntent: 'info' };
}

// 表示する期間（from〜to、両端を含む）と見出し
function upcomingRange(window, today) {
  if (window.type === 'month') {
    const first = new Date(today.getFullYear(), today.getMonth() + window.offset, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    if (window.offset === 0) {
      return { from: today, to: last, label: `今月（〜${Utilities.formatDate(last, 'JST', 'M/d')}）` };
    }
    return { from: first, to: last, label: `来月（${first.getMonth() + 1}月）` };
  }
  const to = addDays(today, window.days - 1);
  return { from: today, to: to, label: `今後${window.days}日（〜${Utilities.formatDate(to, 'JST', 'M/d')}）` };
}

// from以降でいちばん早い支払い { page, date }
function soonestPayment(pages, from) {
  let best = null;
  pages.forEach(p => {
    const next = nextPaymentDate(p, from);
    if (next && !next.stale && (!best || next.date < best.date)) best = { page: p, date: next.date };
  });
  return best;
}

// 次回支払日が近い順（未登録は最後）
function compareByNextPayment(a, b) {
  const da = a.next && !a.next.stale ? a.next.date.getTime() : Infinity;
  const db = b.next && !b.next.stale ? b.next.date.getTime() : Infinity;
  if (da !== db) return da < db ? -1 : 1;
  return a.page.name.localeCompare(b.page.name);
}

// 「一覧」。lead は先頭に添える一言。
function activeListReply(pages, today, lead) {
  const actives = pages.filter(isActive);
  if (actives.length === 0) {
    return { text: (lead || '') + '契約中のサブスクはありません。', quickReply: [quickReplyItem('🗂 解約済み一覧', '解約済み一覧')] };
  }
  const pending = loadPendingCancels();
  const rows = actives.map(p => ({ page: p, next: nextPaymentDate(p, today) })).sort(compareByNextPayment);
  const lines = lead ? [lead, ''] : [];
  lines.push(`📋 契約中のサブスク（${actives.length}件）`);
  rows.forEach(r => {
    const when = r.next && !r.next.stale ? `次回${formatDateJa(r.next.date, today)}` : '次回未登録';
    lines.push(`・${r.page.name} ${priceShort(r.page)} ${when}${pending[r.page.pageId] ? ' ⏳' : ''}`);
  });
  const monthly = actives.reduce((sum, p) => sum + monthlyEquivalent(p.priceNumber, p.billing), 0);
  lines.push('', `月額換算: ¥${Math.round(monthly).toLocaleString()} / 年額換算: ¥${Math.round(monthly * 12).toLocaleString()}`);
  if (rows.some(r => pending[r.page.pageId])) lines.push('⏳ = 解約手続き待ち');
  return {
    text: lines.join('\n'),
    quickReply: [quickReplyItem('📅 支払い予定', '支払い予定'), quickReplyItem('🗂 解約済み一覧', '解約済み一覧')]
  };
}

// 「解約済み一覧」
function canceledListReply(pages) {
  const inactive = pages.filter(p => !isActive(p)).sort((a, b) => a.name.localeCompare(b.name));
  if (inactive.length === 0) {
    return { text: '解約済みのサブスクはありません。', quickReply: [quickReplyItem('📋 一覧', '一覧')] };
  }
  const lines = [`🗂 解約済みのサブスク（${inactive.length}件）`];
  inactive.forEach(p => lines.push(`・${p.name} ${priceShort(p)}${isCanceled(p) ? '' : `（${statusLabel(p)}）`}`));
  lines.push('', '再契約するときは「サービス名 再契約したい」と送ってください。');
  return {
    text: lines.join('\n'),
    quickReply: inactive.slice(0, QUICK_REPLY_MAX).map(p => quickReplyItem(`🔄 ${p.name}`, `${p.name} 再契約したい`))
  };
}

// 対象のサービスが特定できないときに、候補をボタンで出して聞き返す
const ACTION_PHRASES = {
  cancelWant: '解約したい', cancelDone: '解約済み', keep: '続ける',
  reactivateWant: '再契約したい', reactivateDone: '再契約した', used: '使った'
};
const ACTION_QUESTIONS = {
  cancelWant: 'どのサービスを解約しますか？', cancelDone: 'どのサービスを解約済みにしますか？',
  keep: 'どのサービスを続けますか？', reactivateWant: 'どのサービスを再契約しますか？',
  reactivateDone: 'どのサービスを契約中に戻しますか？', used: 'どのサービスを使いましたか？'
};

// lead: 質問の前に添える一言（「いくつか当てはまりました。」など）
function askWhichReply(action, candidates, lead) {
  if (candidates.length === 0) {
    const none = PREFERS_INACTIVE[action] ? '解約済みのサービスはありません。' : '契約中のサービスはありません。';
    return { text: (lead || '') + none };
  }
  const head = (lead || '') + (ACTION_QUESTIONS[action] || 'どのサービスのことですか？');
  const shown = candidates.slice(0, QUICK_REPLY_MAX);
  const lines = [head].concat(shown.map(p => `・${p.name}`));
  if (candidates.length > shown.length) lines.push(`…ほか${candidates.length - shown.length}件（名前で送ってください）`);
  const phrase = ACTION_PHRASES[action] || 'いつ支払い？';
  return { text: lines.join('\n'), quickReply: shown.map(p => quickReplyItem(p.name, `${p.name} ${phrase}`)) };
}

// 聞き返すときの候補: 再契約系は解約済み、続けるは解約待ち、それ以外は契約中（支払日が近い順）
function defaultCandidates(action, pages, today) {
  if (PREFERS_INACTIVE[action]) return pages.filter(p => !isActive(p)).sort((a, b) => a.name.localeCompare(b.name));
  if (action === 'keep') {
    const pending = loadPendingCancels();
    const waiting = pages.filter(p => pending[p.pageId]);
    if (waiting.length > 0) return waiting;
  }
  return pages.filter(isActive)
    .map(p => ({ page: p, next: nextPaymentDate(p, today) }))
    .sort(compareByNextPayment)
    .map(r => r.page);
}

function helpReply() {
  return {
    text: [
      '🤖 こんな風に話しかけてください（サービス名は一部だけでもOK）',
      '・Netflix いつ支払い？ … 次回支払日と金額',
      '・支払い予定 / 今月の支払い / 来月いくら？',
      '・一覧 … 契約中のサブスクと合計',
      '・Netflix 解約したい … 解約方法と期限を案内',
      '・Netflix 解約済み … Notionを解約済みにする',
      '・Netflix 再契約したい … 再契約の案内',
      '・Netflix 再契約した … Notionを契約中に戻す',
      '・Netflix 使った … 最終利用日を記録',
      '・解約済み一覧',
      '',
      '名前を省いて「これいつ？」「解約した」と送ると、直前に話したサービスのこととして扱います。'
    ].join('\n'),
    quickReply: [
      quickReplyItem('📋 一覧', '一覧'),
      quickReplyItem('📅 支払い予定', '支払い予定'),
      quickReplyItem('🛑 解約したい', '解約したい'),
      quickReplyItem('🔄 再契約したい', '再契約したい')
    ]
  };
}

function unknownReply(lead) {
  return {
    text: [
      lead ? `🤔 ${lead}名前を確かめるか、例えばこう送ってください:` : '🤔 うまく読み取れませんでした。例えばこう送ってください:',
      '・Netflix いつ支払い？',
      '・Netflix 解約したい',
      '・今月の支払い',
      '・一覧 / ヘルプ'
    ].join('\n'),
    quickReply: [
      quickReplyItem('📋 一覧', '一覧'),
      quickReplyItem('📅 支払い予定', '支払い予定'),
      quickReplyItem('❓ ヘルプ', 'ヘルプ')
    ]
  };
}

// =====================================================================
// 解約・再契約の方法
//  解約: Notionの「解約用URL」「解約方法」 > 「支払方法」（App Store等） > 組み込みの主要サービス > 「URL」（契約管理ページ） > Google検索
//  再契約: Notionの「再契約URL」 > 「URL」 > 「支払方法」 > 組み込みの主要サービス > Google検索
// =====================================================================

// App Store / Google Play / キャリア経由の課金は、サービスのWebサイトではなくそちらで解約する
const BILLING_STORES = {
  apple: {
    label: 'App Store経由の課金',
    url: 'https://apps.apple.com/account/subscriptions',
    steps: 'iPhoneの「設定」→ 一番上の自分の名前 →「サブスクリプション」→ 対象を選んで「サブスクリプションをキャンセル」',
    restartSteps: 'iPhoneの「設定」→ 自分の名前 →「サブスクリプション」で対象を選んで再登録',
    note: 'App Store経由の契約は、サービスのWebサイトからは解約できません。'
  },
  google: {
    label: 'Google Play経由の課金',
    url: 'https://play.google.com/store/account/subscriptions',
    steps: 'Google Playアプリ → 右上のプロフィールアイコン →「お支払いと定期購入」→「定期購入」→ 対象を選んで「定期購入を解約」',
    restartSteps: 'Google Playアプリ → プロフィールアイコン →「お支払いと定期購入」→「定期購入」で対象を選んで再登録',
    note: 'Google Play経由の契約は、サービスのWebサイトからは解約できません。'
  },
  carrier: {
    label: '携帯キャリア経由の課金',
    url: null,
    steps: 'キャリアの会員ページ（My docomo / My au / My SoftBank など）の契約中サービスから手続き',
    restartSteps: 'キャリアの会員ページ（My docomo / My au / My SoftBank など）から申し込み',
    note: 'キャリア決済の契約は、サービスのWebサイトからは解約できないことがあります。'
  }
};

// よく使われるサービスの解約ページ（参考）。names は「Notionの名前がこれで始まっていたら該当」かつ
// 「LINEでこの呼び名でも通じる」（正規化後の小文字で書く）。画面やURLはサービス側の都合で
// 変わることがあるため、合わなくなったらNotionの「解約用URL」「再契約URL」に正しいものを書けば優先される。
const SERVICE_PRESETS = [
  { names: ['netflix', 'ネットフリックス', 'ネトフリ'],
    cancelUrl: 'https://www.netflix.com/cancelplan', homeUrl: 'https://www.netflix.com/' },
  { names: ['youtube premium', 'youtube music', 'youtubeプレミアム', 'ユーチューブプレミアム'],
    cancelUrl: 'https://www.youtube.com/paid_memberships', homeUrl: 'https://www.youtube.com/premium' },
  { names: ['spotify', 'スポティファイ'],
    cancelUrl: 'https://www.spotify.com/jp/account/', steps: 'アカウントページ →「プランを管理」→ 解約',
    homeUrl: 'https://www.spotify.com/jp/premium/' },
  { names: ['amazon prime', 'amazonプライム', 'アマゾンプライム', 'アマプラ', 'プライム会員'],
    cancelUrl: 'https://www.amazon.co.jp/gp/primecentral',
    steps: '「プライム会員情報」→「プライム会員資格を終了し、特典の利用を止める」',
    homeUrl: 'https://www.amazon.co.jp/amazonprime' },
  { names: ['kindle unlimited', 'kindleアンリミテッド', 'キンドルアンリミテッド'],
    cancelUrl: 'https://www.amazon.co.jp/kindle-dbs/ku/ku-central',
    steps: '「メンバーシップを管理」→「メンバーシップを解約する」（ブラウザから。アプリからは解約できません）' },
  { names: ['u-next', 'unext', 'ユーネクスト'],
    cancelUrl: 'https://help.unext.jp/guide/detail/how-to-cancel-the-contract-web',
    steps: 'U-NEXTのWebサイト →「アカウント・契約」→「契約・解約」→「契約内容の確認・解約」',
    note: 'U-NEXTは解約した時点で見られなくなります。', endsImmediately: true,
    homeUrl: 'https://video.unext.jp/' },
  { names: ['disney+', 'disney plus', 'disneyプラス', 'ディズニープラス', 'ディズニー+'],
    steps: 'Disney+にログイン → プロフィール →「アカウント」→「サブスクリプション」→「Disney+を解約」',
    homeUrl: 'https://www.disneyplus.com/' },
  { names: ['chatgpt'],
    cancelUrl: 'https://chatgpt.com/', steps: 'プロフィールアイコン →「設定」→「アカウント」→ プランの「管理」→ 解約',
    note: '次回請求の24時間前までに手続きしてください。' },
  { names: ['claude'],
    cancelUrl: 'https://claude.ai/settings/billing', steps: '「設定」→「請求」→「キャンセル」',
    note: '次回請求の24時間前までに手続きしてください。' },
  { names: ['adobe', 'creative cloud'],
    cancelUrl: 'https://account.adobe.com/plans', steps: '「プランを管理」→「プランを解約」',
    note: '年間プラン（月々払い）は途中解約で解約料がかかる場合があります。' },
  { names: ['microsoft 365', 'office 365'],
    cancelUrl: 'https://account.microsoft.com/services', steps: 'サブスクリプションの「管理」→「定期請求をオフにする」' },
  { names: ['apple music', 'アップルミュージック'], store: 'apple' },
  { names: ['icloud', 'アイクラウド'], store: 'apple' },
  { names: ['apple one'], store: 'apple' },
  { names: ['apple tv', 'アップルtv'], store: 'apple' },
  { names: ['apple arcade'], store: 'apple' }
];

// 名前がサービス名で始まるものだけ該当とみなす（「LYP Premium with Netflix」をNetflixとして扱わないため）
function findServicePreset(name) {
  const n = normalizeText(name);
  if (!n) return null;
  const compact = n.replace(/ /g, '');
  return SERVICE_PRESETS.find(preset =>
    preset.names.some(k => n.indexOf(k) === 0 || compact.indexOf(k.replace(/ /g, '')) === 0)) || null;
}

// Notionの「支払方法」から、どこで解約するかを判定する
function detectBillingStore(paymentMethod) {
  const m = normalizeText(paymentMethod);
  if (!m) return null;
  if (/app ?store|iphone|ipad|ios|itunes|アップストア/.test(m) || (/apple|アップル/.test(m) && !/apple ?pay/.test(m))) return 'apple';
  if (/google ?play|play ?store|android|グーグルプレイ|playストア/.test(m)) return 'google';
  if (/docomo|ドコモ|softbank|ソフトバンク|ワイモバイル|y!?mobile|楽天モバイル|キャリア|(^|[^a-z])au([^a-z]|$)/.test(m)) return 'carrier';
  return null;
}

function resolveCancelProcedure(page) {
  const preset = findServicePreset(page.name);
  const storeKey = detectBillingStore(page.paymentMethod) || (preset && preset.store) || null;
  const store = storeKey ? BILLING_STORES[storeKey] : null;
  const curated = !!(page.cancelUrl || page.cancelHowto); // Notionに自分で書いた手順がある
  const url = page.cancelUrl || (store ? store.url : preset && (preset.cancelUrl || preset.homeUrl)) || page.url || null;
  const steps = page.cancelHowto || (store ? store.steps : preset && preset.steps) || null;
  const notes = [];
  if (store) notes.push(store.note);
  else if (preset && preset.note) notes.push(preset.note);
  if (!store && !curated && !page.paymentMethod) {
    notes.push('App Store・Google Play・キャリア決済で契約した場合は、そちらからの解約が必要です。');
  }
  return {
    via: store ? store.label : null,
    url: url,
    steps: steps,
    notes: notes,
    searchUrl: googleSearchUrl(`${page.name} 解約 方法`),
    fallback: !url && !steps
  };
}

function resolveRestartProcedure(page) {
  const preset = findServicePreset(page.name);
  const storeKey = detectBillingStore(page.paymentMethod) || (preset && preset.store) || null;
  const store = storeKey ? BILLING_STORES[storeKey] : null;
  const url = page.restartUrl || page.url || (store ? store.url : preset && (preset.homeUrl || preset.cancelUrl)) || null;
  const steps = store ? store.restartSteps : null;
  return {
    via: store ? store.label : null,
    url: url,
    steps: steps,
    notes: [],
    searchUrl: googleSearchUrl(`${page.name} 再開 方法`),
    fallback: !url && !steps
  };
}

// 案内の本文（見出し・手順・リンク・注意）。手順もリンクも無いときだけ検索リンクを出す。
function procedureLines(proc, heading, tip) {
  const lines = [`📝 ${heading}${proc.via ? `（${proc.via}）` : ''}`];
  if (proc.steps) lines.push(proc.steps);
  if (proc.url) lines.push(`🔗 ${proc.url}`);
  if (proc.fallback) lines.push(`🔍 検索: ${proc.searchUrl}`);
  proc.notes.forEach(n => lines.push(`※ ${n}`));
  if (proc.fallback && tip) lines.push(tip);
  return lines;
}

function googleSearchUrl(query) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(query);
}

// =====================================================================
// Notion・LINEへの書き込み
// =====================================================================

// Status列の書き込み用の値。セレクト型なら存在しない選択肢名でもNotionが自動で追加する。
function statusValue(page, name) {
  return page && page.statusType === 'status' ? { status: { name: name } } : { select: { name: name } };
}

// Webhookの返信用。broadcastと違い、replyToken宛にその場で返信する（返信は無料・通数にカウントされない）。
function replyLineMessage(replyToken, text, quickReplyItems) {
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
      messages: [buildTextMessage(text, quickReplyItems)]
    }),
    muteHttpExceptions: true
  };

  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', options);
  if (res.getResponseCode() !== 200) {
    console.log(`❌ LINE返信エラー: ${res.getResponseCode()} ${res.getContentText()}`);
  }
}
