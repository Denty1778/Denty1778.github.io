const STORAGE_KEY = "ashiato-data";
const BACKUP_VERSION = 1;

// 歩数の決め方
const CHARS_PER_STEP = 4;
const MIN_STEPS = 5;
const MAX_STEPS = 60;

// 続けたときの倍率
const MULT_MIN = 1.0;
const MULT_MAX = 2.0;
const MULT_UP = 0.05;      // 1日続けるごとに上がる分
const MULT_DOWN = 0.1;     // 猶予を過ぎたあと1日ごとに下がる分
const GRACE_DAYS = 7;      // 書かなくても倍率が下がらない日数

// 実測: 40〜110文字くらいの日記だと、最初の1つが5日目、以降は2〜3日おきに生まれる
const STEPS_PER_LANDMARK = 80;
const LANDMARK_TYPES = ["町", "湖", "峠", "森", "岬"];

// 追加タグに方角を配る角度。黄金角なので、増えても方角が固まりにくい
const GOLDEN_ANGLE = 137.5;

const PRESET_TAGS = [
  { name: "仕事", angle: 0, color: "#B5502E" },
  { name: "学び", angle: 45, color: "#4A7B9D" },
  { name: "人と会った", angle: 90, color: "#BC7B28" },
  { name: "外出", angle: 135, color: "#5E8C5A" },
  { name: "買い物", angle: 180, color: "#8E5EA8" },
  { name: "家", angle: 225, color: "#A5714B" },
  { name: "体調", angle: 270, color: "#4B958E" },
];

const EXTRA_COLORS = [
  "#7A6BAE", "#B0724F", "#6B8E4E", "#A85A78",
  "#3F7E86", "#996A2E", "#5D6FA8", "#8C6F3F",
  "#B24A63", "#4E8C7A", "#8A5FA8", "#A67A2E",
  "#56789E", "#7F8B45", "#9E5540", "#647FAE",
];

const screens = {
  map: document.getElementById("screen-map"),
  write: document.getElementById("screen-write"),
  done: document.getElementById("screen-done"),
  detail: document.getElementById("screen-detail"),
  list: document.getElementById("screen-list"),
  settings: document.getElementById("screen-settings"),
};

const mapSvg = document.getElementById("map");
const mapEmpty = document.getElementById("map-empty");
const travelerEl = document.getElementById("traveler");
const statEl = document.getElementById("stat");

const writeForm = document.getElementById("write-form");
const inputText = document.getElementById("input-text");
const counterEl = document.getElementById("counter");
const tagPicker = document.getElementById("tag-picker");
const writeError = document.getElementById("write-error");
const writeTitle = document.getElementById("write-title");
const writeDate = document.getElementById("write-date");
const writeBtn = document.getElementById("write-btn");

const entryListEl = document.getElementById("entry-list");
const listCountEl = document.getElementById("list-count");
const tagManageEl = document.getElementById("tag-manage");
const storageNote = document.getElementById("storage-note");
const backupResult = document.getElementById("backup-result");
const fileImport = document.getElementById("file-import");

// 記録画面で選んでいるタグ
let selectedTags = [];

/* ---------- 保存 ---------- */

function defaultData() {
  return {
    entries: [],
    landmarks: [],
    tags: PRESET_TAGS.map((t) => ({ ...t })),
    state: {
      currentStreak: 0,
      currentMultiplier: MULT_MIN,
      totalSteps: 0,
      lastEntryDate: null,
    },
  };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!raw || !Array.isArray(raw.entries)) return defaultData();
    return {
      entries: raw.entries || [],
      landmarks: raw.landmarks || [],
      tags: Array.isArray(raw.tags) && raw.tags.length ? raw.tags : defaultData().tags,
      state: { ...defaultData().state, ...(raw.state || {}) },
    };
  } catch {
    return defaultData();
  }
}

function save(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

let data = load();

/* ---------- 日付 ---------- */

// 日付が変わってすぐ書くこともあるので、午前4時までは前日扱いにする
function todayKey() {
  const now = new Date();
  if (now.getHours() < 4) now.setDate(now.getDate() - 1);
  return keyOf(now);
}

function keyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  const weekday = "日月火水木金土"[new Date(y, m - 1, d).getDay()];
  return `${y}年${m}月${d}日（${weekday}）`;
}

function daysBetween(fromKey, toKey) {
  const [y1, m1, d1] = fromKey.split("-").map(Number);
  const [y2, m2, d2] = toKey.split("-").map(Number);
  const a = new Date(y1, m1 - 1, d1);
  const b = new Date(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

/* ---------- タグ ---------- */

// 消したタグも定義は残す。過去の地図の色と方角を変えないため
function findTag(name) {
  return data.tags.find((t) => t.name === name);
}

function visibleTags() {
  return data.tags.filter((t) => !t.hidden);
}

// 黄金角で方角を配りつつ、既にあるタグと近すぎたら次の候補にずらす
function nextAngle() {
  const used = data.tags.map((t) => ((t.angle % 360) + 360) % 360);
  const apart = (a, b) => {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d);
  };

  for (let i = data.tags.length; i < data.tags.length + 60; i++) {
    const candidate = (i * GOLDEN_ANGLE) % 360;
    if (used.every((u) => apart(u, candidate) >= 12)) return candidate;
  }
  return (data.tags.length * GOLDEN_ANGLE) % 360;
}

// まだ使っていない色を優先する
function nextColor() {
  const used = new Set(data.tags.map((t) => t.color));
  const free = EXTRA_COLORS.find((c) => !used.has(c));
  if (free) return free;
  return EXTRA_COLORS[(data.tags.length - PRESET_TAGS.length) % EXTRA_COLORS.length];
}

function addTag(name) {
  const trimmed = name.trim();
  if (!trimmed) return null;

  // 一度消したタグを足し直したときは、前と同じ色・方角で戻す
  const existing = findTag(trimmed);
  if (existing) {
    delete existing.hidden;
    save(data);
    return existing;
  }

  const tag = { name: trimmed, angle: Math.round(nextAngle() * 10) / 10, color: nextColor() };
  data.tags.push(tag);
  save(data);
  return tag;
}

function compassOf(angle) {
  const names = ["東", "北東", "北", "北西", "西", "南西", "南", "南東"];
  const i = Math.round((((angle % 360) + 360) % 360) / 45) % 8;
  return names[i];
}

/* ---------- 進み方 ---------- */

function baseSteps(text) {
  const n = Math.round(text.trim().length / CHARS_PER_STEP);
  return Math.min(Math.max(n, MIN_STEPS), MAX_STEPS);
}

// 選んだタグの方角を合成する。タグが無いときは前回の向きを少しだけずらす
function directionOf(tagNames, prevAngle) {
  const tags = tagNames.map(findTag).filter(Boolean);

  if (tags.length === 0) {
    return prevAngle === null ? 0 : prevAngle + (Math.random() * 30 - 15);
  }

  let x = 0;
  let y = 0;
  tags.forEach((t) => {
    const r = (t.angle * Math.PI) / 180;
    x += Math.cos(r);
    y += Math.sin(r);
  });
  if (x === 0 && y === 0) return tags[0].angle;
  return (Math.atan2(y, x) * 180) / Math.PI;
}

// 書いた時刻でわずかに揺らす。同じ内容でも日によって形が変わる
function timeWobble(date) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  return ((minutes % 21) - 10) * 1.2;
}

function multiplierAfter(lastDate, today, current, streak) {
  if (lastDate === null) return { multiplier: MULT_MIN, streak: 1 };

  const gap = daysBetween(lastDate, today);

  if (gap <= 0) return { multiplier: current, streak };
  if (gap === 1) {
    return {
      multiplier: Math.min(current + MULT_UP, MULT_MAX),
      streak: streak + 1,
    };
  }
  if (gap <= GRACE_DAYS) {
    // 少し休んだくらいでは下げない
    return { multiplier: current, streak: 1 };
  }
  const over = gap - GRACE_DAYS;
  return {
    multiplier: Math.max(current - MULT_DOWN * over, MULT_MIN),
    streak: 1,
  };
}

function travelerMood() {
  const { currentMultiplier, lastEntryDate } = data.state;
  if (data.entries.length === 0) return "旅人はまだ歩きだしていません。";

  const gap = daysBetween(lastEntryDate, todayKey());
  if (gap > GRACE_DAYS) return "旅人は足を止めて、あなたを待っています。";
  if (gap >= 2) return "旅人は道ばたで休んでいます。";

  if (currentMultiplier >= 1.8) return "旅人は風のように進んでいます。";
  if (currentMultiplier >= 1.5) return "旅人の足取りは軽やかです。";
  if (currentMultiplier >= 1.2) return "旅人は調子よく歩いています。";
  return "旅人はゆっくりと歩いています。";
}

/* ---------- 画面 ---------- */

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("is-active"));
  screens[name].classList.add("is-active");
  window.scrollTo(0, 0);
}

/* ---------- 地図 ---------- */

function drawMap() {
  mapSvg.innerHTML = "";

  const pts = [{ x: 0, y: 0 }].concat(data.entries.map((e) => ({ x: e.x, y: e.y })));
  mapEmpty.hidden = data.entries.length > 0;

  // 全体が収まるように枠を決める。はみ出しても自動で縮む
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  pts.forEach((p) => {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  });

  const span = Math.max(maxX - minX, maxY - minY, 120);
  const pad = span * 0.12;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const size = span + pad * 2;
  mapSvg.setAttribute("viewBox", `${cx - size / 2} ${cy - size / 2} ${size} ${size}`);

  const scale = size / 100; // 線の太さを見た目で一定に保つ

  const ns = "http://www.w3.org/2000/svg";
  const make = (tag, attrs) => {
    const el = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  };

  // 出発点
  mapSvg.appendChild(make("circle", { cx: 0, cy: 0, r: 1.6 * scale, fill: "#7C6C58" }));

  // 一日ぶんずつ線を引く。色はその日のタグ
  data.entries.forEach((e, i) => {
    const from = i === 0 ? { x: 0, y: 0 } : data.entries[i - 1];
    const tag = e.tags.length ? findTag(e.tags[0]) : null;
    mapSvg.appendChild(
      make("line", {
        x1: from.x, y1: from.y, x2: e.x, y2: e.y,
        stroke: tag ? tag.color : "#8A7A63",
        "stroke-width": 1.7 * scale,
        "stroke-linecap": "round",
      })
    );
  });

  // ランドマーク。軌跡が折り返して近づくことがあるので、
  // 名前が重なる場合は丸だけ描く（押せば名前は読める）
  const labeled = [];
  data.landmarks.forEach((lm) => {
    const g = make("g", { class: "landmark-hit" });
    g.appendChild(make("circle", { cx: lm.x, cy: lm.y, r: 3.4 * scale, fill: "#FBF5E9", stroke: "#9A5B2E", "stroke-width": 1 * scale }));

    const room = labeled.every((p) => Math.hypot(p.x - lm.x, p.y - lm.y) >= 8 * scale);
    if (room) {
      const label = make("text", {
        x: lm.x, y: lm.y + 1.3 * scale,
        "text-anchor": "middle",
        "font-size": 3.4 * scale,
        fill: "#9A5B2E",
        "font-family": "serif",
      });
      label.textContent = lm.type;
      g.appendChild(label);
      labeled.push(lm);
    }

    // 指で押せるように、見た目より広い当たり判定を重ねる
    const hit = make("circle", { cx: lm.x, cy: lm.y, r: 8 * scale, fill: "transparent" });
    g.appendChild(hit);
    g.addEventListener("click", () => openDetail(lm));
    mapSvg.appendChild(g);
  });

  // 旅人
  const last = data.entries.length ? data.entries[data.entries.length - 1] : { x: 0, y: 0 };
  mapSvg.appendChild(make("circle", { cx: last.x, cy: last.y, r: 2.6 * scale, fill: "#33291E" }));
  mapSvg.appendChild(make("circle", { cx: last.x, cy: last.y, r: 4.6 * scale, fill: "none", stroke: "#33291E", "stroke-width": 0.6 * scale, opacity: 0.4 }));
}

function refreshMap() {
  drawMap();
  travelerEl.textContent = travelerMood();
  statEl.textContent = data.entries.length
    ? `${data.entries.length}日ぶん・${Math.round(data.state.totalSteps)}歩・ランドマーク${data.landmarks.length}`
    : "";
}

/* ---------- 記録 ---------- */

function renderTagPicker() {
  tagPicker.innerHTML = "";
  visibleTags().forEach((tag) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tag-chip";
    btn.setAttribute("aria-pressed", String(selectedTags.includes(tag.name)));

    const dot = document.createElement("span");
    dot.className = "tag-dot";
    dot.style.background = tag.color;

    const name = document.createElement("span");
    name.textContent = tag.name;

    const dir = document.createElement("span");
    dir.className = "tag-dir";
    dir.textContent = compassOf(tag.angle);

    btn.appendChild(dot);
    btn.appendChild(name);
    btn.appendChild(dir);

    btn.addEventListener("click", () => {
      const i = selectedTags.indexOf(tag.name);
      if (i >= 0) selectedTags.splice(i, 1);
      else selectedTags.push(tag.name);
      renderTagPicker();
    });

    tagPicker.appendChild(btn);
  });
}

function openWrite() {
  writeError.hidden = true;
  const today = todayKey();
  const existing = data.entries.find((e) => e.date === today);

  writeDate.textContent = formatDate(today);
  writeTitle.textContent = existing ? "今日の出来事（書き直し）" : "今日の出来事";
  writeBtn.textContent = existing ? "書き直す" : "記録する";
  inputText.value = existing ? existing.text : "";
  selectedTags = existing ? existing.tags.slice() : [];

  updateCounter();
  renderTagPicker();
  showScreen("write");
}

function updateCounter() {
  const n = inputText.value.trim().length;
  counterEl.textContent = `${n}文字 → およそ${Math.min(Math.max(Math.round(n / CHARS_PER_STEP), MIN_STEPS), MAX_STEPS)}歩`;
}

inputText.addEventListener("input", updateCounter);

writeForm.addEventListener("submit", (e) => {
  e.preventDefault();

  const text = inputText.value.trim();
  if (!text) {
    writeError.textContent = "ひとことでいいので書いてください。";
    writeError.hidden = false;
    inputText.focus();
    return;
  }
  writeError.hidden = true;

  const today = todayKey();
  const now = new Date();
  const existingIndex = data.entries.findIndex((en) => en.date === today);

  // 書き直しのときは、その日のぶんを一度取り消してから引き直す
  if (existingIndex >= 0) {
    const old = data.entries[existingIndex];
    data.state.totalSteps -= old.steps;
    data.entries.splice(existingIndex, 1);
    data.landmarks = data.landmarks.filter((lm) => lm.entryId !== old.id);
  }

  const prev = data.entries.length ? data.entries[data.entries.length - 1] : null;
  const prevAngle = prev ? prev.angle : null;

  const applied =
    existingIndex >= 0
      ? { multiplier: data.state.currentMultiplier, streak: data.state.currentStreak }
      : multiplierAfter(data.state.lastEntryDate, today, data.state.currentMultiplier, data.state.currentStreak);

  const steps = Math.round(baseSteps(text) * applied.multiplier);
  const angle = directionOf(selectedTags, prevAngle) + timeWobble(now);
  const rad = (angle * Math.PI) / 180;

  const from = prev || { x: 0, y: 0 };
  const entry = {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 7),
    date: today,
    text,
    tags: selectedTags.slice(),
    steps,
    multiplier: applied.multiplier,
    angle,
    x: from.x + Math.cos(rad) * steps,
    y: from.y - Math.sin(rad) * steps,
    createdAt: now.toISOString(),
  };

  data.entries.push(entry);
  data.state.totalSteps += steps;
  data.state.currentMultiplier = applied.multiplier;
  data.state.currentStreak = applied.streak;
  data.state.lastEntryDate = today;

  const born = growLandmarks(entry, from);
  save(data);

  document.getElementById("done-steps").innerHTML = `${steps}<span>歩</span>`;
  document.getElementById("done-title").textContent = existingIndex >= 0 ? "書き直しました" : "今日のぶん、進みました";
  document.getElementById("done-note").textContent = born
    ? `${born.type}にたどり着きました。`
    : travelerMood();

  refreshMap();
  showScreen("done");
});

// 累計歩数が区切りを越えるたびに、その日の線の上にランドマークを置く。
// 1日で2つ以上越えることがあるので、越えた地点それぞれに割り当てる
function growLandmarks(entry, from) {
  const before = data.state.totalSteps - entry.steps;
  const crossed = Math.floor(data.state.totalSteps / STEPS_PER_LANDMARK) - Math.floor(before / STEPS_PER_LANDMARK);
  if (crossed <= 0) return null;

  let last = null;
  for (let i = 0; i < crossed; i++) {
    const index = Math.floor(before / STEPS_PER_LANDMARK) + i + 1;
    // 区切りに達したのが線のどのあたりかを求めて、そこに置く
    const t = entry.steps > 0 ? (index * STEPS_PER_LANDMARK - before) / entry.steps : 1;
    last = {
      id: entry.id + "-lm" + i,
      type: LANDMARK_TYPES[index % LANDMARK_TYPES.length],
      x: from.x + (entry.x - from.x) * t,
      y: from.y + (entry.y - from.y) * t,
      entryId: entry.id,
      createdAt: entry.createdAt,
    };
    data.landmarks.push(last);
  }
  return last;
}

/* ---------- ランドマーク詳細 ---------- */

function openDetail(lm) {
  const entry = data.entries.find((e) => e.id === lm.entryId);
  document.getElementById("detail-type").textContent = lm.type;
  document.getElementById("detail-date").textContent = entry ? formatDate(entry.date) : "記録が見つかりません";
  document.getElementById("detail-text").textContent = entry ? entry.text : "";

  const box = document.getElementById("detail-tags");
  box.innerHTML = "";
  if (entry) renderTagMarks(box, entry.tags);

  showScreen("detail");
}

function renderTagMarks(box, names) {
  names.forEach((name) => {
    const tag = findTag(name);
    const mark = document.createElement("span");
    mark.className = "tag-mark";

    const dot = document.createElement("span");
    dot.className = "tag-dot";
    dot.style.background = tag ? tag.color : "#8A7A63";

    const label = document.createElement("span");
    label.textContent = name;

    mark.appendChild(dot);
    mark.appendChild(label);
    box.appendChild(mark);
  });
}

/* ---------- 一覧 ---------- */

function renderList() {
  const entries = data.entries.slice().reverse();
  entryListEl.innerHTML = "";
  listCountEl.textContent = entries.length ? `${entries.length}件` : "";

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "まだ記録はありません。";
    entryListEl.appendChild(empty);
    return;
  }

  entries.forEach((e) => {
    const box = document.createElement("div");
    box.className = "entry";

    const date = document.createElement("p");
    date.className = "entry-date";
    date.textContent = `${formatDate(e.date)}・${e.steps}歩`;

    const text = document.createElement("p");
    text.className = "entry-text";
    text.textContent = e.text;

    const tags = document.createElement("div");
    tags.className = "detail-tags";
    renderTagMarks(tags, e.tags);

    box.appendChild(date);
    box.appendChild(text);
    if (e.tags.length) box.appendChild(tags);
    entryListEl.appendChild(box);
  });
}

/* ---------- 設定 ---------- */

function renderTagManage() {
  tagManageEl.innerHTML = "";
  visibleTags().forEach((tag) => {
    const row = document.createElement("div");
    row.className = "tag-row";

    const dot = document.createElement("span");
    dot.className = "tag-dot";
    dot.style.background = tag.color;

    const name = document.createElement("span");
    name.className = "tag-name";
    name.textContent = tag.name;

    const dir = document.createElement("span");
    dir.className = "tag-dir";
    dir.textContent = compassOf(tag.angle);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "del-btn";
    del.textContent = "削除";
    del.addEventListener("click", () => removeTag(tag));

    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(dir);
    row.appendChild(del);
    tagManageEl.appendChild(row);
  });

  const bytes = new Blob([localStorage.getItem(STORAGE_KEY) || ""]).size;
  storageNote.textContent = `${data.entries.length}件の記録・約${bytes < 1024 ? bytes + "B" : Math.round(bytes / 1024) + "KB"}`;
}

// 選択肢から外すだけで、定義そのものは残す。
// 消してしまうと過去の線の色が失われるため（同じ名前で足し直せば元に戻る）
function removeTag(tag) {
  const used = data.entries.filter((e) => e.tags.includes(tag.name)).length;
  const message = used
    ? `「${tag.name}」を選択肢から消しますか？\n\n${used}件の記録に付いていますが、記録も地図の色もそのまま残ります。`
    : `「${tag.name}」を消しますか？`;
  if (!confirm(message)) return;

  tag.hidden = true;
  save(data);
  renderTagManage();
}

/* ---------- バックアップ ---------- */

function showBackupResult(message, isError) {
  backupResult.textContent = message;
  backupResult.classList.toggle("is-error", !!isError);
  backupResult.hidden = false;
}

document.getElementById("export-btn").addEventListener("click", () => {
  if (data.entries.length === 0) {
    showBackupResult("まだ記録がありません。", true);
    return;
  }
  const payload = { app: "ashiato", version: BACKUP_VERSION, exportedAt: new Date().toISOString(), data };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const now = new Date();

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ashiato-backup-${keyOf(now)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  showBackupResult(`${data.entries.length}件を書き出しました。`);
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

  if (!confirm(`${incoming.entries.length}件の記録を読み込みます。\n\n今ある記録は置き換わります。よろしいですか？`)) return;

  data = {
    entries: incoming.entries,
    landmarks: incoming.landmarks || [],
    tags: Array.isArray(incoming.tags) && incoming.tags.length ? incoming.tags : defaultData().tags,
    state: { ...defaultData().state, ...(incoming.state || {}) },
  };
  save(data);
  refreshMap();
  renderTagManage();
  showBackupResult(`${data.entries.length}件を復元しました。`);
});

/* ---------- 画面遷移 ---------- */

document.getElementById("go-write").addEventListener("click", openWrite);

document.getElementById("go-list").addEventListener("click", () => {
  renderList();
  showScreen("list");
});

document.getElementById("go-settings").addEventListener("click", () => {
  backupResult.hidden = true;
  renderTagManage();
  showScreen("settings");
});

document.querySelectorAll("[data-back]").forEach((btn) =>
  btn.addEventListener("click", () => {
    refreshMap();
    showScreen(btn.dataset.back);
  })
);

function hookAddTag(inputId, buttonId, after) {
  const input = document.getElementById(inputId);
  const run = () => {
    const tag = addTag(input.value);
    if (!tag) return;
    input.value = "";
    after(tag);
  };
  document.getElementById(buttonId).addEventListener("click", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run();
    }
  });
}

hookAddTag("new-tag", "add-tag", (tag) => {
  if (!selectedTags.includes(tag.name)) selectedTags.push(tag.name);
  renderTagPicker();
});

hookAddTag("new-tag-2", "add-tag-2", renderTagManage);

refreshMap();
