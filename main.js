// ==========================================
// ▼ 設定エリア ▼
// ==========================================
const NOTION_TOKEN = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
const DATABASE_ID = PropertiesService.getScriptProperties().getProperty('DATABASE_ID');

if (!NOTION_TOKEN || !DATABASE_ID) {
  throw new Error("プロパティ設定エラー: NOTION_TOKEN と DATABASE_ID を確認してください。");
}

const NOTIFY_DAYS_BEFORE = 7;

// Notionの列名
const PROP_NAME = 'Name';
const PROP_DATE = '更新日';
const PROP_PRICE = '料金';
const PROP_BILLING = 'Billing';

// ステータス管理
const PROP_STATUS = 'Status';
const ACTIVE_VALUE = 'Active';

function main() {
  const tasks = fetchNotionData();
  if (!tasks || tasks.length === 0) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  tasks.forEach(task => {
    if (!task.date) return;

    let paymentDate = new Date(task.date);
    paymentDate.setHours(0, 0, 0, 0);

    if (paymentDate < today) {
      const newDate = calculateNextPaymentDate(paymentDate, task.billing);
      if (newDate) {
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
    }
  });
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
      if (props[PROP_PRICE] && props[PROP_PRICE].number !== null) {
        price = "¥" + props[PROP_PRICE].number.toLocaleString();
      }

      // Billing
      let billing = null;
      if (props[PROP_BILLING] && props[PROP_BILLING].select) {
        billing = props[PROP_BILLING].select.name;
      }

      // Status (デバッグ用に取得)
      let status = null;
      if (props[PROP_STATUS] && props[PROP_STATUS].select) {
        status = props[PROP_STATUS].select.name;
      } else if (props[PROP_STATUS] && props[PROP_STATUS].status) {
        status = props[PROP_STATUS].status.name;
      }

      return { pageId: page.id, name, date: dateStr, price, billing, status };
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