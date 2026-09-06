const STORAGE_KEY = "atobarai-data";
// 最後に保存した日だけは localStorage に置く（消えても「未保存」に戻るだけの目印）
const LAST_BACKUP_KEY = "atobarai-last-backup";
const BACKUP_VERSION = 1;
const STALE_DAYS = 30;

const PRESET_CATEGORIES = [
  "食費", "日用品", "交通", "趣味", "交際",
  "住まい", "光熱", "通信", "医療", "その他",
];

const screens = {
  home: document.getElementById("screen-home"),
  write: document.getElementById("screen-write"),
  list: document.getElementById("screen-list"),
  settings: document.getElementById("screen-settings"),
  card: document.getElementById("screen-card"),
};

const inputAmount = document.getElementById("input-amount");
const inputDate = document.getElementById("input-date");
const inputMemo = document.getElementById("input-memo");
const methodRow = document.getElementById("method-row");
const payNote = document.getElementById("pay-note");
const categoryPicker = document.getElementById("category-picker");
const writeError = document.getElementById("write-error");
const writeTitle = document.getElementById("write-title");
const writeBtn = document.getElementById("write-btn");
const deleteBtn = document.getElementById("delete-btn");

const monthLabel = document.getElementById("month-label");
const monthTotal = document.getElementById("month-total");
const monthNote = document.getElementById("month-note");
const categorySummary = document.getElementById("category-summary");
const entryListEl = document.getElementById("entry-list");

const cardListEl = document.getElementById("card-list");
const categoryManageEl = document.getElementById("category-manage");
const storageNote = document.getElementById("storage-note");
const backupResult = document.getElementById("backup-result");
const fileImport = document.getElementById("file-import");

const cardName = document.getElementById("card-name");
const cardClosing = document.getElementById("card-closing");
const cardOffset = document.getElementById("card-offset");
const cardPayday = document.getElementById("card-payday");
const cardExample = document.getElementById("card-example");
const cardError = document.getElementById("card-error");
const cardDelete = document.getElementById("card-delete");

// 記録画面で選んでいるもの
let selectedMethod = "cash";   // "cash" か カードのid
let selectedCategory = null;
let editingEntryId = null;
let editingCardId = null;

// 一覧の状態
let axis = "used";             // "used" = 使った月 / "pay" = 引き落とし月
let viewMonth = null;          // "YYYY-MM"

/* ---------- 保存 ---------- */

function defaultData() {
  return { cards: [], categories: PRESET_CATEGORIES.slice(), entries: [] };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!raw) return defaultData();
    return {
      cards: Array.isArray(raw.cards) ? raw.cards : [],
      categories: Array.isArray(raw.categories) && raw.categories.length ? raw.categories : PRESET_CATEGORIES.slice(),
      entries: Array.isArray(raw.entries) ? raw.entries : [],
    };
  } catch {
    return defaultData();
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

let data = load();

/* ---------- 日付とお金 ---------- */

const pad = (n) => String(n).padStart(2, "0");

function lastDayOf(y, m) {
  return new Date(y, m, 0).getDate(); // m は1始まり
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthOf(dateStr) {
  return dateStr.slice(0, 7);
}

function addMonths(monthStr, n) {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function formatMoney(n) {
  return "¥" + Math.round(n).toLocaleString("ja-JP");
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const w = "日月火水木金土"[new Date(y, m - 1, d).getDay()];
  return `${m}月${d}日(${w})`;
}

function formatMonth(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  return `${y}年${m}月`;
}

/* ---------- 引き落とし日の計算 ---------- */

// 使った日から、そのカードで実際に口座から出る日を求める。
// 締め日を過ぎていればひと月ぶん後ろの締めになる。
function payDateOf(dateStr, card) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const closing = card.closingDay === "end" ? lastDayOf(y, m) : card.closingDay;

  let closeY = y;
  let closeM = m;
  if (d > closing) {
    closeM += 1;
    if (closeM > 12) { closeM = 1; closeY += 1; }
  }

  let payY = closeY;
  let payM = closeM + Number(card.payMonthOffset);
  while (payM > 12) { payM -= 12; payY += 1; }

  // 31日払いのカードでも、2月なら末日に寄せる
  const last = lastDayOf(payY, payM);
  const payD = card.payDay === "end" ? last : Math.min(Number(card.payDay), last);
  return `${payY}-${pad(payM)}-${pad(payD)}`;
}

// 消したカードも定義は残す。過去の明細から名前が消えないようにするため
function findCard(id) {
  return data.cards.find((c) => c.id === id);
}

function activeCards() {
  return data.cards.filter((c) => !c.hidden);
}

function ruleText(card) {
  const closing = card.closingDay === "end" ? "月末" : `${card.closingDay}日`;
  const offset = ["締めたその月", "翌月", "翌々月"][Number(card.payMonthOffset)];
  const payday = card.payDay === "end" ? "末日" : `${card.payDay}日`;
  return `${closing}締め・${offset}${payday}払い`;
}

/* ---------- 画面 ---------- */

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("is-active"));
  screens[name].classList.add("is-active");
  window.scrollTo(0, 0);
}

/* ---------- カレンダー ---------- */

const calGrid = document.getElementById("cal-grid");
const calDetail = document.getElementById("cal-detail");

let calAxis = "pay";     // 既定は引き落とし日。このアプリで見たいのはこちら
let calMonth = null;     // "YYYY-MM"
let calSelected = null;  // "YYYY-MM-DD"

function pickOf(a) {
  return a === "used" ? (e) => e.date : (e) => e.payDate;
}

// 桁が多いとマスからあふれるので、1万円以上は「1.2万」の形に縮める
function shortMoney(n) {
  if (n >= 10000) {
    const man = n / 10000;
    return (man >= 100 ? Math.round(man) : Math.round(man * 10) / 10) + "万";
  }
  return n.toLocaleString("ja-JP");
}

function renderCalendar() {
  if (!calMonth) calMonth = monthOf(todayStr());

  const [y, m] = calMonth.split("-").map(Number);
  document.getElementById("cal-month").textContent = formatMonth(calMonth);
  document.querySelectorAll("[data-cal-axis]").forEach((b) => b.classList.toggle("is-on", b.dataset.calAxis === calAxis));

  const pick = pickOf(calAxis);
  const byDay = new Map();
  data.entries.forEach((e) => {
    const key = pick(e);
    if (monthOf(key) !== calMonth) return;
    byDay.set(key, (byDay.get(key) || 0) + e.amount);
  });

  calGrid.innerHTML = "";
  ["日", "月", "火", "水", "木", "金", "土"].forEach((label, i) => {
    const cell = document.createElement("span");
    cell.className = "cal-dow" + (i === 0 ? " sun" : i === 6 ? " sat" : "");
    cell.textContent = label;
    calGrid.appendChild(cell);
  });

  const firstDow = new Date(y, m - 1, 1).getDay();
  const days = lastDayOf(y, m);
  const today = todayStr();

  for (let i = 0; i < firstDow; i++) {
    const blank = document.createElement("span");
    blank.className = "cal-day is-blank";
    calGrid.appendChild(blank);
  }

  for (let d = 1; d <= days; d++) {
    const key = `${y}-${pad(m)}-${pad(d)}`;
    const amount = byDay.get(key) || 0;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cal-day" + (amount ? " has-amount" : "") + (key === today ? " is-today" : "");
    btn.setAttribute("aria-pressed", String(calSelected === key));
    btn.setAttribute("aria-label", `${m}月${d}日` + (amount ? ` ${formatMoney(amount)}` : ""));

    const num = document.createElement("span");
    num.textContent = String(d);
    btn.appendChild(num);

    if (amount) {
      const amt = document.createElement("span");
      amt.className = "cal-amt";
      amt.textContent = shortMoney(amount);
      btn.appendChild(amt);
    }

    btn.addEventListener("click", () => {
      calSelected = calSelected === key ? null : key;
      renderCalendar();
    });
    calGrid.appendChild(btn);
  }

  const total = [...byDay.values()].reduce((a, b) => a + b, 0);
  document.getElementById("cal-total").innerHTML =
    (calAxis === "pay" ? "この月に出ていく額 " : "この月に使った額 ") + `<b>${formatMoney(total)}</b>`;

  renderCalDetail();
}

function renderCalDetail() {
  calDetail.innerHTML = "";
  if (!calSelected) return;

  const pick = pickOf(calAxis);
  const rows = data.entries.filter((e) => pick(e) === calSelected);

  const head = document.createElement("p");
  head.className = "cal-detail-head";
  head.textContent =
    formatDate(calSelected) + (calAxis === "pay" ? " に出ていくもの" : " に使ったもの");
  calDetail.appendChild(head);

  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "cal-row-sub";
    empty.textContent = "この日の記録はありません。";
    calDetail.appendChild(empty);
    return;
  }

  rows.forEach((e) => {
    const row = document.createElement("div");
    row.className = "cal-row";

    const name = document.createElement("span");
    name.className = "cal-row-name";
    name.textContent = e.memo || e.category;

    const card = e.method === "cash" ? null : findCard(e.method);
    const sub = document.createElement("span");
    sub.className = "cal-row-sub";
    sub.textContent =
      e.method === "cash"
        ? "現金"
        : (card ? card.name : "不明なカード") + (calAxis === "pay" ? `・${formatDate(e.date)}に使用` : "");
    name.appendChild(sub);

    const val = document.createElement("span");
    val.className = "cal-row-val";
    val.textContent = formatMoney(e.amount);

    row.appendChild(name);
    row.appendChild(val);
    calDetail.appendChild(row);
  });
}

document.querySelectorAll("[data-cal-axis]").forEach((btn) =>
  btn.addEventListener("click", () => {
    calAxis = btn.dataset.calAxis;
    calSelected = null;
    renderCalendar();
  })
);

document.getElementById("cal-prev").addEventListener("click", () => {
  calMonth = addMonths(calMonth, -1);
  calSelected = null;
  renderCalendar();
});

document.getElementById("cal-next").addEventListener("click", () => {
  calMonth = addMonths(calMonth, 1);
  calSelected = null;
  renderCalendar();
});

/* ---------- ホーム ---------- */

function sumBy(pick, monthStr) {
  return data.entries.reduce((n, e) => (monthOf(pick(e)) === monthStr ? n + e.amount : n), 0);
}

function refreshHome() {
  const thisMonth = monthOf(todayStr());
  const nextMonth = addMonths(thisMonth, 1);

  document.getElementById("this-used").textContent = formatMoney(sumBy((e) => e.date, thisMonth));
  document.getElementById("this-pay").textContent = formatMoney(sumBy((e) => e.payDate, thisMonth));
  document.getElementById("next-pay").textContent = formatMoney(sumBy((e) => e.payDate, nextMonth));
  document.getElementById("next-pay-month").textContent = `${formatMonth(nextMonth)}に口座から出る額`;

  // 来月の内訳。どのカードがいつ、いくら引き落とすか
  const box = document.getElementById("next-breakdown");
  box.innerHTML = "";

  const groups = new Map();
  data.entries.forEach((e) => {
    if (monthOf(e.payDate) !== nextMonth) return;
    const key = e.method === "cash" ? "cash" : e.method;
    if (!groups.has(key)) groups.set(key, { total: 0, dates: new Set() });
    const g = groups.get(key);
    g.total += e.amount;
    g.dates.add(e.payDate);
  });

  if (groups.size === 0) {
    const note = document.createElement("p");
    note.className = "card-sub";
    note.textContent = "まだ予定はありません。";
    box.appendChild(note);
  }

  [...groups.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([key, g]) => {
      const row = document.createElement("div");
      row.className = "breakdown-row";

      const name = document.createElement("span");
      name.className = "breakdown-name";
      const card = key === "cash" ? null : findCard(key);
      name.textContent = key === "cash" ? "現金・その場払い" : card ? card.name : "不明なカード";

      if (key !== "cash" && g.dates.size === 1) {
        const day = document.createElement("span");
        day.className = "breakdown-date";
        day.textContent = formatDate([...g.dates][0]);
        name.appendChild(day);
      }

      const val = document.createElement("span");
      val.className = "breakdown-val";
      val.textContent = formatMoney(g.total);

      row.appendChild(name);
      row.appendChild(val);
      box.appendChild(row);
    });

  renderCalendar();

  const hint = document.getElementById("home-hint");
  if (activeCards().length === 0) {
    hint.textContent = "設定でカードを登録すると、カード払いの引き落とし日が自動で決まります。";
  } else {
    hint.textContent = "";
  }
}

/* ---------- 記録 ---------- */

function renderMethodRow() {
  methodRow.innerHTML = "";

  const make = (value, label) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = label;
    btn.setAttribute("aria-pressed", String(selectedMethod === value));
    btn.addEventListener("click", () => {
      selectedMethod = value;
      renderMethodRow();
      updatePayNote();
    });
    methodRow.appendChild(btn);
  };

  make("cash", "現金・その場払い");
  activeCards().forEach((c) => make(c.id, c.name));

  // 消したカードの記録を開いたときは、そのカードも選べるようにしておく
  const current = selectedMethod === "cash" ? null : findCard(selectedMethod);
  if (current && current.hidden) make(current.id, current.name + "（削除済み）");
}

// いつ引き落とされるかを、記録する前に見せる
function updatePayNote() {
  if (selectedMethod === "cash") {
    payNote.className = "pay-note is-plain";
    payNote.textContent = "その日に出ていく扱いになります。";
    return;
  }
  const card = findCard(selectedMethod);
  if (!card || !inputDate.value) {
    payNote.textContent = "";
    return;
  }
  payNote.className = "pay-note";
  payNote.textContent = `引き落としは ${formatDate(payDateOf(inputDate.value, card))} になります`;
}

function renderCategoryPicker() {
  categoryPicker.innerHTML = "";
  data.categories.forEach((name) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = name;
    btn.setAttribute("aria-pressed", String(selectedCategory === name));
    btn.addEventListener("click", () => {
      selectedCategory = selectedCategory === name ? null : name;
      renderCategoryPicker();
    });
    categoryPicker.appendChild(btn);
  });
}

function openWrite(entry) {
  writeError.hidden = true;
  editingEntryId = entry ? entry.id : null;

  writeTitle.textContent = entry ? "記録を直す" : "記録する";
  writeBtn.textContent = entry ? "更新する" : "記録する";
  deleteBtn.hidden = !entry;

  inputAmount.value = entry ? String(entry.amount) : "";
  inputDate.value = entry ? entry.date : todayStr();
  inputMemo.value = entry ? entry.memo : "";
  selectedMethod = entry ? entry.method : "cash";
  selectedCategory = entry ? entry.category : null;

  // 使っていたカードが消えている場合は現金に戻す
  if (selectedMethod !== "cash" && !findCard(selectedMethod)) selectedMethod = "cash";

  renderMethodRow();
  renderCategoryPicker();
  updatePayNote();
  showScreen("write");
}

inputAmount.addEventListener("input", () => {
  // 全角で打たれることがあるので、半角に直してから数字だけ残す
  const cleaned = inputAmount.value
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^\d]/g, "");
  if (cleaned !== inputAmount.value) inputAmount.value = cleaned;
});

inputDate.addEventListener("change", updatePayNote);

document.getElementById("write-form").addEventListener("submit", (e) => {
  e.preventDefault();

  const amount = Number(inputAmount.value);
  if (!amount || amount <= 0) {
    writeError.textContent = "金額を入れてください。";
    writeError.hidden = false;
    inputAmount.focus();
    return;
  }
  if (!inputDate.value) {
    writeError.textContent = "日付を入れてください。";
    writeError.hidden = false;
    return;
  }
  writeError.hidden = true;

  const card = selectedMethod === "cash" ? null : findCard(selectedMethod);
  const entry = {
    id: editingEntryId || String(Date.now()) + Math.random().toString(36).slice(2, 7),
    date: inputDate.value,
    amount,
    category: selectedCategory || "その他",
    memo: inputMemo.value.trim(),
    method: card ? card.id : "cash",
    payDate: card ? payDateOf(inputDate.value, card) : inputDate.value,
    createdAt: new Date().toISOString(),
  };

  if (editingEntryId) {
    const i = data.entries.findIndex((x) => x.id === editingEntryId);
    if (i >= 0) data.entries[i] = { ...data.entries[i], ...entry };
  } else {
    data.entries.push(entry);
  }
  save();

  editingEntryId = null;
  refreshHome();
  showScreen("home");
});

deleteBtn.addEventListener("click", () => {
  if (!editingEntryId) return;
  if (!confirm("この記録を削除しますか？")) return;

  data.entries = data.entries.filter((e) => e.id !== editingEntryId);
  save();
  editingEntryId = null;
  refreshHome();
  showScreen("home");
});

/* ---------- 一覧 ---------- */

function entriesOfMonth() {
  const pick = axis === "used" ? (e) => e.date : (e) => e.payDate;
  return data.entries
    .filter((e) => monthOf(pick(e)) === viewMonth)
    .sort((a, b) => (pick(b) < pick(a) ? -1 : pick(b) > pick(a) ? 1 : 0));
}

function renderList() {
  if (!viewMonth) viewMonth = monthOf(todayStr());

  monthLabel.textContent = formatMonth(viewMonth);
  document.querySelectorAll(".axis-btn").forEach((b) => b.classList.toggle("is-on", b.dataset.axis === axis));

  const rows = entriesOfMonth();
  const total = rows.reduce((n, e) => n + e.amount, 0);
  monthTotal.textContent = formatMoney(total);
  monthNote.textContent =
    axis === "used" ? "この月に使った合計" : "この月に口座から出る合計";

  // カテゴリ別
  categorySummary.innerHTML = "";
  const byCat = new Map();
  rows.forEach((e) => byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount));
  const max = Math.max(...byCat.values(), 1);

  [...byCat.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, value]) => {
      const row = document.createElement("div");
      row.className = "sum-row";

      const label = document.createElement("span");
      label.className = "sum-name";
      label.textContent = name;

      const bar = document.createElement("span");
      bar.className = "sum-bar";
      const fill = document.createElement("span");
      fill.style.width = `${(value / max) * 100}%`;
      bar.appendChild(fill);

      const val = document.createElement("span");
      val.className = "sum-val";
      val.textContent = formatMoney(value);

      row.appendChild(label);
      row.appendChild(bar);
      row.appendChild(val);
      categorySummary.appendChild(row);
    });

  // 明細
  entryListEl.innerHTML = "";
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "この月の記録はありません。";
    entryListEl.appendChild(empty);
    return;
  }

  rows.forEach((e) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "entry";

    const main = document.createElement("div");
    main.className = "entry-main";

    const title = document.createElement("div");
    title.className = "entry-title";
    title.textContent = e.memo || e.category;

    const meta = document.createElement("div");
    meta.className = "entry-meta";
    const card = e.method === "cash" ? null : findCard(e.method);
    const way = e.method === "cash" ? "現金" : card ? card.name : "不明なカード";
    meta.textContent =
      axis === "used"
        ? `${formatDate(e.date)}・${e.category}・${way}` + (e.method === "cash" ? "" : ` → ${formatDate(e.payDate)}引き落とし`)
        : `${formatDate(e.payDate)}引き落とし・${e.category}・${way}` + (e.method === "cash" ? "" : `（${formatDate(e.date)}に使用）`);

    main.appendChild(title);
    main.appendChild(meta);

    const amount = document.createElement("span");
    amount.className = "entry-amount";
    amount.textContent = formatMoney(e.amount);

    btn.appendChild(main);
    btn.appendChild(amount);
    btn.addEventListener("click", () => openWrite(e));
    entryListEl.appendChild(btn);
  });
}

document.querySelectorAll(".axis-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    axis = btn.dataset.axis;
    renderList();
  })
);

document.getElementById("prev-month").addEventListener("click", () => {
  viewMonth = addMonths(viewMonth, -1);
  renderList();
});

document.getElementById("next-month").addEventListener("click", () => {
  viewMonth = addMonths(viewMonth, 1);
  renderList();
});

/* ---------- カードの設定 ---------- */

function fillDaySelects() {
  [cardClosing, cardPayday].forEach((sel) => {
    sel.innerHTML = "";
    for (let i = 1; i <= 31; i++) {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = `${i}日`;
      sel.appendChild(o);
    }
    const end = document.createElement("option");
    end.value = "end";
    end.textContent = "月末";
    sel.appendChild(end);
  });
}

function currentCardForm() {
  return {
    name: cardName.value.trim(),
    closingDay: cardClosing.value === "end" ? "end" : Number(cardClosing.value),
    payMonthOffset: Number(cardOffset.value),
    payDay: cardPayday.value === "end" ? "end" : Number(cardPayday.value),
  };
}

// 設定した内容で、実際にいつ引き落とされるかを見せる
function updateCardExample() {
  const card = currentCardForm();
  const today = todayStr();
  const [y, m] = today.split("-").map(Number);
  const early = `${y}-${pad(m)}-05`;
  const late = `${y}-${pad(m)}-25`;

  cardExample.textContent =
    `この設定だと、${formatDate(early)}に使った分は ${formatDate(payDateOf(early, card))}、` +
    `${formatDate(late)}に使った分は ${formatDate(payDateOf(late, card))} に引き落としになります。`;
}

[cardClosing, cardOffset, cardPayday].forEach((el) => el.addEventListener("change", updateCardExample));

function openCard(card) {
  cardError.hidden = true;
  editingCardId = card ? card.id : null;

  document.getElementById("card-title").textContent = card ? "カードを直す" : "カードを追加";
  cardDelete.hidden = !card;
  cardName.value = card ? card.name : "";
  cardClosing.value = card ? String(card.closingDay) : "15";
  cardOffset.value = card ? String(card.payMonthOffset) : "1";
  cardPayday.value = card ? String(card.payDay) : "10";

  updateCardExample();
  showScreen("card");
}

document.getElementById("card-form").addEventListener("submit", (e) => {
  e.preventDefault();

  const form = currentCardForm();
  if (!form.name) {
    cardError.textContent = "カード名を入れてください。";
    cardError.hidden = false;
    cardName.focus();
    return;
  }
  cardError.hidden = true;

  if (editingCardId) {
    const card = findCard(editingCardId);
    Object.assign(card, form);

    // 締め日を直したときは、これまでの記録も引き落とし日を計算し直せるようにする
    const used = data.entries.filter((x) => x.method === card.id);
    if (used.length > 0 && confirm(`これまでの${used.length}件も、新しい設定で引き落とし日を計算し直しますか？\n\n「いいえ」を選ぶと、過去の記録はそのまま残ります。`)) {
      used.forEach((x) => { x.payDate = payDateOf(x.date, card); });
    }
  } else {
    data.cards.push({ id: String(Date.now()) + Math.random().toString(36).slice(2, 7), ...form });
  }

  save();
  editingCardId = null;
  renderSettings();
  refreshHome();
  showScreen("settings");
});

cardDelete.addEventListener("click", () => {
  const card = findCard(editingCardId);
  if (!card) return;

  const used = data.entries.filter((x) => x.method === card.id).length;
  const message = used
    ? `「${card.name}」を一覧から消しますか？\n\n${used}件の記録に使われていますが、記録も引き落とし日もカード名もそのまま残ります。`
    : `「${card.name}」を消しますか？`;
  if (!confirm(message)) return;

  card.hidden = true;
  save();
  editingCardId = null;
  renderSettings();
  refreshHome();
  showScreen("settings");
});

/* ---------- 設定 ---------- */

function renderSettings() {
  cardListEl.innerHTML = "";
  if (activeCards().length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "まだカードを登録していません。";
    cardListEl.appendChild(empty);
  }

  activeCards().forEach((card) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "card-row";

    const main = document.createElement("div");
    main.className = "card-row-main";
    const name = document.createElement("div");
    name.textContent = card.name;
    const rule = document.createElement("div");
    rule.className = "card-row-rule";
    rule.textContent = ruleText(card);
    main.appendChild(name);
    main.appendChild(rule);

    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "›";

    row.appendChild(main);
    row.appendChild(arrow);
    row.addEventListener("click", () => openCard(card));
    cardListEl.appendChild(row);
  });

  categoryManageEl.innerHTML = "";
  data.categories.forEach((name) => {
    const row = document.createElement("div");
    row.className = "tag-row";

    const label = document.createElement("span");
    label.className = "tag-name";
    label.textContent = name;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "del-btn";
    del.textContent = "削除";
    del.addEventListener("click", () => removeCategory(name));

    row.appendChild(label);
    row.appendChild(del);
    categoryManageEl.appendChild(row);
  });

  const bytes = new Blob([localStorage.getItem(STORAGE_KEY) || ""]).size;
  storageNote.textContent = `${data.entries.length}件の記録・約${bytes < 1024 ? bytes + "B" : Math.round(bytes / 1024) + "KB"}`;

  refreshBackupAge();
  document.getElementById("backup-how").textContent =
    navigator.canShare && navigator.canShare({ files: [new File([""], "a.json", { type: "application/json" })] })
      ? "「保存」を押すと共有メニューが開きます。自分宛に送るか、クラウドに置いておくと安心です。"
      : "「保存」を押すとファイルがダウンロードされます。";
}

function removeCategory(name) {
  const used = data.entries.filter((e) => e.category === name).length;
  const message = used
    ? `「${name}」を消しますか？\n\n${used}件の記録に使われていますが、記録はそのまま残ります。`
    : `「${name}」を消しますか？`;
  if (!confirm(message)) return;

  data.categories = data.categories.filter((c) => c !== name);
  save();
  renderSettings();
}

document.getElementById("add-category").addEventListener("click", addCategory);
document.getElementById("new-category").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addCategory(); }
});

function addCategory() {
  const input = document.getElementById("new-category");
  const name = input.value.trim();
  if (!name || data.categories.includes(name)) { input.value = ""; return; }

  data.categories.push(name);
  save();
  input.value = "";
  renderSettings();
}

/* ---------- バックアップ ---------- */

function showBackupResult(message, isError) {
  backupResult.textContent = message;
  backupResult.classList.toggle("is-error", !!isError);
  backupResult.hidden = false;
}

function daysSince(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function refreshBackupAge() {
  const el = document.getElementById("backup-age");
  const last = localStorage.getItem(LAST_BACKUP_KEY);
  el.classList.remove("is-stale");

  if (!last) {
    el.textContent = "まだ一度も保存していません。";
    if (data.entries.length > 0) el.classList.add("is-stale");
    return;
  }
  const days = daysSince(last);
  el.textContent = days <= 0 ? "今日、保存しました。" : `最後に保存してから${days}日`;
  if (days >= STALE_DAYS) el.classList.add("is-stale");
}

function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// スマホでは共有シートに出す。そこから自分宛に送ったりクラウドに置いたりできる。
// 対応していない端末では今までどおりダウンロードになる
async function saveBackupFile(blob, filename) {
  const file = new File([blob], filename, { type: "application/json" });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "あとばらい家計簿のバックアップ" });
      return "shared";
    } catch (err) {
      if (err && err.name === "AbortError") return "canceled";
      // 共有できなければ落として渡す
    }
  }
  downloadFile(blob, filename);
  return "downloaded";
}

document.getElementById("export-btn").addEventListener("click", async () => {
  if (data.entries.length === 0 && activeCards().length === 0) {
    showBackupResult("まだ保存するものがありません。", true);
    return;
  }
  const payload = { app: "atobarai", version: BACKUP_VERSION, exportedAt: new Date().toISOString(), data };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const result = await saveBackupFile(blob, `atobarai-backup-${todayStr()}.json`);

  if (result === "canceled") {
    showBackupResult("保存をやめました。", true);
    return;
  }

  localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
  refreshBackupAge();
  showBackupResult(
    result === "shared"
      ? `${data.entries.length}件を書き出しました。送り先を選んでください。`
      : `${data.entries.length}件を書き出しました。`
  );
});

document.getElementById("import-btn").addEventListener("click", () => fileImport.click());

fileImport.addEventListener("change", async () => {
  const file = fileImport.files[0];
  fileImport.value = "";
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    showBackupResult("このファイルは読み込めませんでした。", true);
    return;
  }

  const incoming = payload && payload.data;
  if (!incoming || !Array.isArray(incoming.entries)) {
    showBackupResult("このアプリのバックアップではないようです。", true);
    return;
  }
  if (!confirm(`${incoming.entries.length}件の記録を読み込みます。\n\n今あるデータは置き換わります。よろしいですか？`)) return;

  data = {
    cards: Array.isArray(incoming.cards) ? incoming.cards : [],
    categories: Array.isArray(incoming.categories) && incoming.categories.length ? incoming.categories : PRESET_CATEGORIES.slice(),
    entries: incoming.entries,
  };
  save();
  renderSettings();
  refreshHome();
  showBackupResult(`${data.entries.length}件を復元しました。`);
});

/* ---------- 画面遷移 ---------- */

document.getElementById("go-write").addEventListener("click", () => openWrite(null));

document.getElementById("go-list").addEventListener("click", () => {
  viewMonth = monthOf(todayStr());
  renderList();
  showScreen("list");
});

document.getElementById("go-settings").addEventListener("click", () => {
  backupResult.hidden = true;
  renderSettings();
  showScreen("settings");
});

document.getElementById("add-card").addEventListener("click", () => openCard(null));

document.querySelectorAll("[data-back]").forEach((btn) =>
  btn.addEventListener("click", () => {
    if (btn.dataset.back === "home") refreshHome();
    if (btn.dataset.back === "settings") renderSettings();
    showScreen(btn.dataset.back);
  })
);

fillDaySelects();
inputDate.value = todayStr();
refreshHome();

// ホーム画面に追加して使えるようにする（オフラインでも開ける）
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
