const DB_NAME = "yorugaku";
const DB_VERSION = 1;
const STORE = "questions";
const LEGACY_KEY = "yorugaku-questions";
// バックアップした日時だけは localStorage に置く（消えても「未保存」に戻るだけの目印なので）
const LAST_BACKUP_KEY = "yorugaku-last-backup";
const BACKUP_VERSION = 1;
const STALE_DAYS = 7;
const THEME_KEY = "yorugaku-theme";

// 実体は style.css の [data-theme] 側。ここに持つのは見本の丸に塗る2色だけ
const THEMES = [
  { id: "yoru", name: "夜", bg: "#1F1C2E", dot: "#8B7FE8" },
  { id: "ai", name: "藍", bg: "#182433", dot: "#5B9BD5" },
  { id: "sumi", name: "墨", bg: "#212125", dot: "#B9B9C0" },
  { id: "tomoshibi", name: "灯", bg: "#201A15", dot: "#D19A5B" },
  { id: "asa", name: "朝", bg: "#FFFBF5", dot: "#9A6A35" },
];
const MAX_PER_SESSION = 20;
const MAX_IMAGE_EDGE = 1600;
const JPEG_QUALITY = 0.8;

const screens = {
  home: document.getElementById("screen-home"),
  save: document.getElementById("screen-save"),
  list: document.getElementById("screen-list"),
  quiz: document.getElementById("screen-quiz"),
  result: document.getElementById("screen-result"),
  settings: document.getElementById("screen-settings"),
};

const saveForm = document.getElementById("save-form");
const inputQuestion = document.getElementById("input-question");
const inputAnswer = document.getElementById("input-answer");
const saveError = document.getElementById("save-error");
const savedNote = document.getElementById("saved-note");
const saveTitle = document.getElementById("save-title");
const saveBtn = document.getElementById("save-btn");

const questionListEl = document.getElementById("question-list");
const listCountEl = document.getElementById("list-count");
const listSubEl = document.getElementById("list-sub");
const quizSubEl = document.getElementById("quiz-sub");
const goQuizBtn = document.getElementById("go-quiz");
const storageNote = document.getElementById("storage-note");
const backupNote = document.getElementById("backup-note");
const backupResult = document.getElementById("backup-result");
const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const fileImport = document.getElementById("file-import");

const quizQuestionEl = document.getElementById("quiz-question");
const quizAnswerEl = document.getElementById("quiz-answer");
const quizQuestionImg = document.getElementById("quiz-question-img");
const quizAnswerImg = document.getElementById("quiz-answer-img");
const answerCard = document.getElementById("answer-card");
const revealBtn = document.getElementById("reveal-btn");
const judgeEl = document.getElementById("judge");
const progressText = document.getElementById("progress-text");
const progressFill = document.getElementById("progress-fill");

// 編集中の問題id。新規作成のときは null
let editingId = null;
// 出題中のセッション
let session = null;
// 保存画面で選択中の画像（まだ保存していない）
let pending = { question: null, answer: null };

/* ---------- IndexedDB ---------- */

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function runTx(mode, action) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const loadQuestions = () => runTx("readonly", (store) => store.getAll());
const putQuestion = (q) => runTx("readwrite", (store) => store.put(q));
const deleteQuestion = (id) => runTx("readwrite", (store) => store.delete(id));

// localStorage 版で保存したデータがあれば一度だけ引き継ぐ
async function migrateLegacyData() {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;

  try {
    const old = JSON.parse(raw) || [];
    for (const q of old) {
      await putQuestion({
        ...q,
        questionImage: null,
        answerImage: null,
      });
    }
  } catch {
    return; // 壊れていたら消さずに残しておく
  }
  localStorage.removeItem(LEGACY_KEY);
}

/* ---------- 画像 ---------- */

// スクショをそのまま入れると1枚で数MBになるので、長辺を縮めてJPEGにする
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("画像を変換できませんでした。"))),
        "image/jpeg",
        JPEG_QUALITY
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("この画像は読み込めませんでした。"));
    };
    img.src = url;
  });
}

// 一覧や出題で作った URL は、描き直すたびに解放する
let viewUrls = [];
function viewUrl(blob) {
  const url = URL.createObjectURL(blob);
  viewUrls.push(url);
  return url;
}
function releaseViewUrls() {
  viewUrls.forEach(URL.revokeObjectURL);
  viewUrls = [];
}

let editUrls = [];
function editUrl(blob) {
  const url = URL.createObjectURL(blob);
  editUrls.push(url);
  return url;
}
function releaseEditUrls() {
  editUrls.forEach(URL.revokeObjectURL);
  editUrls = [];
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/* ---------- 共通 ---------- */

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("is-active"));
  screens[name].classList.add("is-active");
  window.scrollTo(0, 0);
}

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

async function refreshHome() {
  const count = (await loadQuestions()).length;
  listSubEl.textContent = count === 0 ? "まだ問題がありません" : `${count}問を保存中`;
  quizSubEl.textContent =
    count === 0 ? "先に問題を保存してください" : `${Math.min(count, MAX_PER_SESSION)}問を出題します`;
  goQuizBtn.disabled = count === 0;
}

/* ---------- 保存・編集 ---------- */

function showPreview(which, blob) {
  const box = document.getElementById(`preview-${which}`);
  const img = document.getElementById(`preview-${which}-img`);

  if (blob) {
    img.src = editUrl(blob);
    box.hidden = false;
  } else {
    img.removeAttribute("src");
    box.hidden = true;
  }
}

async function openSaveScreen(id) {
  releaseEditUrls();
  editingId = id || null;
  saveError.hidden = true;
  savedNote.hidden = true;
  pending = { question: null, answer: null };

  if (editingId) {
    const list = await loadQuestions();
    const q = list.find((item) => item.id === editingId);
    saveTitle.textContent = "問題を編集する";
    saveBtn.textContent = "更新する";
    inputQuestion.value = q ? q.questionText : "";
    inputAnswer.value = q ? q.answerText : "";
    pending.question = q ? q.questionImage || null : null;
    pending.answer = q ? q.answerImage || null : null;
  } else {
    saveTitle.textContent = "問題を保存する";
    saveBtn.textContent = "保存する";
    inputQuestion.value = "";
    inputAnswer.value = "";
  }

  showPreview("question", pending.question);
  showPreview("answer", pending.answer);
  showScreen("save");
}

function setupAttach(which) {
  const fileInput = document.getElementById(`file-${which}`);

  document.getElementById(`attach-${which}`).addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = ""; // 同じファイルを選び直せるようにする
    if (!file) return;

    try {
      pending[which] = await compressImage(file);
      saveError.hidden = true;
      showPreview(which, pending[which]);
    } catch (err) {
      saveError.textContent = err.message;
      saveError.hidden = false;
    }
  });

  document.getElementById(`remove-${which}`).addEventListener("click", () => {
    pending[which] = null;
    showPreview(which, null);
  });
}

setupAttach("question");
setupAttach("answer");

saveForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const questionText = inputQuestion.value.trim();
  const answerText = inputAnswer.value.trim();

  // テキストと画像は、どちらか一方あればよい
  if ((!questionText && !pending.question) || (!answerText && !pending.answer)) {
    saveError.textContent = "問題と解答の両方に、テキストか画像のどちらかを入れてください。";
    saveError.hidden = false;
    (questionText || pending.question ? inputAnswer : inputQuestion).focus();
    return;
  }
  saveError.hidden = true;

  try {
    if (editingId) {
      const list = await loadQuestions();
      const q = list.find((item) => item.id === editingId);
      if (q) {
        q.questionText = questionText;
        q.answerText = answerText;
        q.questionImage = pending.question;
        q.answerImage = pending.answer;
        await putQuestion(q);
      }
      editingId = null;
      await renderList();
      showScreen("list");
      return;
    }

    await putQuestion({
      id: String(Date.now()) + Math.random().toString(36).slice(2, 7),
      questionText,
      answerText,
      questionImage: pending.question,
      answerImage: pending.answer,
      createdAt: new Date().toISOString(),
      lastAnsweredAt: null,
      correctCount: 0,
      incorrectCount: 0,
    });
  } catch {
    saveError.textContent = "保存できませんでした。端末の空き容量を確認してください。";
    saveError.hidden = false;
    return;
  }

  // 続けて何問も登録することが多いので、保存後は入力欄だけ空にしてこの画面に留まる
  releaseEditUrls();
  pending = { question: null, answer: null };
  inputQuestion.value = "";
  inputAnswer.value = "";
  showPreview("question", null);
  showPreview("answer", null);
  inputQuestion.focus();
  savedNote.hidden = false;
  await refreshHome();
});

/* ---------- 一覧 ---------- */

async function renderList() {
  releaseViewUrls();

  const questions = (await loadQuestions()).slice().reverse();
  questionListEl.innerHTML = "";
  listCountEl.textContent = questions.length ? `${questions.length}問` : "";

  backupResult.hidden = true;
  exportBtn.disabled = questions.length === 0;
  refreshBackupNote();

  if (questions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "まだ問題がありません。";
    questionListEl.appendChild(empty);
    storageNote.textContent = "";
    return;
  }

  questions.forEach((q) => {
    const item = document.createElement("div");
    item.className = "q-item";

    const head = document.createElement("div");
    head.className = "q-head";

    if (q.questionImage) {
      const thumb = document.createElement("img");
      thumb.className = "q-thumb";
      thumb.src = viewUrl(q.questionImage);
      thumb.alt = "";
      head.appendChild(thumb);
    }

    const text = document.createElement("p");
    text.className = "q-text";
    text.textContent = q.questionText || "（画像のみ）";
    if (!q.questionText) text.classList.add("q-text-muted");
    head.appendChild(text);

    const meta = document.createElement("p");
    meta.className = "q-meta";
    const answered = q.correctCount + q.incorrectCount;
    const marks = [];
    if (q.questionImage || q.answerImage) marks.push("画像あり");
    marks.push(formatDate(q.createdAt));
    marks.push(answered === 0 ? "未出題" : `${answered}回中 ${q.incorrectCount}回まちがい`);
    meta.textContent = marks.join("・");

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "icon-btn";
    editBtn.textContent = "編集";
    editBtn.addEventListener("click", () => openSaveScreen(q.id));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-btn danger";
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", () => removeQuestion(q));

    const actions = document.createElement("div");
    actions.className = "q-actions";
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    const foot = document.createElement("div");
    foot.className = "q-foot";
    foot.appendChild(meta);
    foot.appendChild(actions);

    item.appendChild(head);
    item.appendChild(foot);
    questionListEl.appendChild(item);
  });

  showStorageNote(questions);
}

async function showStorageNote(questions) {
  const images = questions.reduce(
    (n, q) => n + (q.questionImage ? 1 : 0) + (q.answerImage ? 1 : 0),
    0
  );
  if (images === 0) {
    storageNote.textContent = "";
    return;
  }

  const bytes = questions.reduce(
    (n, q) => n + (q.questionImage ? q.questionImage.size : 0) + (q.answerImage ? q.answerImage.size : 0),
    0
  );
  storageNote.textContent = `画像 ${images}枚・約${formatSize(bytes)}`;
}

// 削除は取り消せないので必ず確認する
async function removeQuestion(q) {
  const label = q.questionText || "（画像のみの問題）";
  const head = label.length > 20 ? label.slice(0, 20) + "…" : label;
  if (!confirm(`この問題を削除しますか？\n\n「${head}」`)) return;

  await deleteQuestion(q.id);
  await renderList();
  await refreshHome();
}

/* ---------- 配色 ---------- */

function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) || THEMES[0];
  document.documentElement.setAttribute("data-theme", theme.id);
  localStorage.setItem(THEME_KEY, theme.id);

  // スマホでアドレスバーの色が背景とずれないようにする。
  // body の背景色を読むと切り替え途中の色を拾うので、変数から直接取る
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    if (bg) meta.setAttribute("content", bg);
  }

  document.querySelectorAll(".theme-row").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.theme === theme.id));
  });
}

function buildThemeList() {
  const box = document.getElementById("theme-list");
  box.innerHTML = "";

  THEMES.forEach((theme) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-row";
    btn.dataset.theme = theme.id;

    const chip = document.createElement("span");
    chip.className = "theme-chip";
    chip.style.background = theme.bg;

    const dot = document.createElement("span");
    dot.className = "theme-dot";
    dot.style.background = theme.dot;
    chip.appendChild(dot);

    const name = document.createElement("span");
    name.className = "theme-name";
    name.textContent = theme.name;

    const check = document.createElement("span");
    check.className = "theme-check";
    check.textContent = "選択中";

    btn.appendChild(chip);
    btn.appendChild(name);
    btn.appendChild(check);
    btn.addEventListener("click", () => applyTheme(theme.id));
    box.appendChild(btn);
  });
}

buildThemeList();
applyTheme(localStorage.getItem(THEME_KEY) || THEMES[0].id);

/* ---------- バックアップ ---------- */

function daysSince(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function refreshBackupNote() {
  const last = localStorage.getItem(LAST_BACKUP_KEY);
  backupNote.classList.remove("is-stale");

  if (!last) {
    backupNote.textContent = "バックアップはまだ保存していません。";
    return;
  }

  const days = daysSince(last);
  if (days <= 0) {
    backupNote.textContent = "今日バックアップを保存しました。";
    return;
  }
  backupNote.textContent = `最後のバックアップから${days}日`;
  // 7日開かないとブラウザにデータを消されることがあるので、そこを目安に色を変える
  if (days >= STALE_DAYS) backupNote.classList.add("is-stale");
}

function showBackupResult(message, isError) {
  backupResult.textContent = message;
  backupResult.classList.toggle("is-error", !!isError);
  backupResult.hidden = false;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const head = dataUrl.slice(0, comma);
  const mime = (head.match(/:(.*?);/) || [])[1] || "image/jpeg";
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function exportBackup() {
  const questions = await loadQuestions();
  if (questions.length === 0) return;

  try {
    const payload = {
      app: "yorugaku",
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      questions: [],
    };

    for (const q of questions) {
      payload.questions.push({
        ...q,
        questionImage: q.questionImage ? await blobToDataUrl(q.questionImage) : null,
        answerImage: q.answerImage ? await blobToDataUrl(q.answerImage) : null,
      });
    }

    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `yorugaku-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
    refreshBackupNote();
    showBackupResult(`${questions.length}問を書き出しました（${formatSize(blob.size)}）。`);
  } catch {
    showBackupResult("バックアップを保存できませんでした。", true);
  }
}

// 読み込んだ1件を、欠けている項目を補いながら整える。不正なら null
function normalizeImported(raw) {
  if (!raw || typeof raw !== "object") return null;

  const questionText = typeof raw.questionText === "string" ? raw.questionText : "";
  const answerText = typeof raw.answerText === "string" ? raw.answerText : "";
  let questionImage = null;
  let answerImage = null;

  try {
    if (typeof raw.questionImage === "string" && raw.questionImage.startsWith("data:")) {
      questionImage = dataUrlToBlob(raw.questionImage);
    }
    if (typeof raw.answerImage === "string" && raw.answerImage.startsWith("data:")) {
      answerImage = dataUrlToBlob(raw.answerImage);
    }
  } catch {
    return null;
  }

  if (!questionText && !questionImage) return null;
  if (!answerText && !answerImage) return null;

  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : String(Date.now()) + Math.random().toString(36).slice(2, 7),
    questionText,
    answerText,
    questionImage,
    answerImage,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    lastAnsweredAt: typeof raw.lastAnsweredAt === "string" ? raw.lastAnsweredAt : null,
    correctCount: Number.isFinite(raw.correctCount) ? raw.correctCount : 0,
    incorrectCount: Number.isFinite(raw.incorrectCount) ? raw.incorrectCount : 0,
  };
}

async function importBackup(file) {
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    showBackupResult("このファイルは読み込めませんでした。", true);
    return;
  }

  const rows = payload && Array.isArray(payload.questions) ? payload.questions : null;
  if (!rows) {
    showBackupResult("このアプリのバックアップファイルではないようです。", true);
    return;
  }

  const items = rows.map(normalizeImported).filter(Boolean);
  const skipped = rows.length - items.length;

  if (items.length === 0) {
    showBackupResult("読み込める問題がありませんでした。", true);
    return;
  }

  const existing = await loadQuestions();
  const existingIds = new Set(existing.map((q) => q.id));
  const updated = items.filter((q) => existingIds.has(q.id)).length;
  const added = items.length - updated;

  const message =
    `${items.length}問を読み込みます。\n\n` +
    `・新しく追加: ${added}問\n` +
    `・上書き: ${updated}問\n\n` +
    `今ある問題は消えません。よろしいですか？`;
  if (!confirm(message)) return;

  try {
    for (const q of items) await putQuestion(q);
  } catch {
    showBackupResult("復元の途中で保存できなくなりました。空き容量を確認してください。", true);
    await renderList();
    await refreshHome();
    return;
  }

  await renderList();
  await refreshHome();
  showBackupResult(
    `復元しました。追加${added}問・上書き${updated}問` + (skipped > 0 ? `（読めなかった${skipped}件は飛ばしました）` : "") + "。"
  );
}

exportBtn.addEventListener("click", exportBackup);
importBtn.addEventListener("click", () => fileImport.click());
fileImport.addEventListener("change", async () => {
  const file = fileImport.files[0];
  fileImport.value = "";
  if (file) await importBackup(file);
});

/* ---------- 出題 ---------- */

// 間違えた問題ほど出やすく、正解を重ねた問題は出にくくする重み付きランダム
function questionWeight(q) {
  let w = 1 + q.incorrectCount * 2 - q.correctCount * 0.5;
  if (!q.lastAnsweredAt) w += 1;
  return Math.max(w, 0.5);
}

function buildOrder(questions) {
  const pool = questions.slice();
  const order = [];

  while (pool.length > 0 && order.length < MAX_PER_SESSION) {
    const total = pool.reduce((sum, q) => sum + questionWeight(q), 0);
    let r = Math.random() * total;
    let picked = pool.length - 1;

    for (let i = 0; i < pool.length; i++) {
      r -= questionWeight(pool[i]);
      if (r <= 0) {
        picked = i;
        break;
      }
    }
    order.push(pool[picked].id);
    pool.splice(picked, 1);
  }
  return order;
}

async function startQuiz() {
  const questions = await loadQuestions();
  if (questions.length === 0) return;

  session = { order: buildOrder(questions), index: 0, correct: 0, wrong: 0 };
  await showQuestion();
  showScreen("quiz");
}

function fillSlot(textEl, imgEl, text, blob) {
  textEl.textContent = text || "";
  textEl.hidden = !text;

  if (blob) {
    imgEl.src = viewUrl(blob);
    imgEl.hidden = false;
  } else {
    imgEl.removeAttribute("src");
    imgEl.hidden = true;
  }
}

async function showQuestion() {
  releaseViewUrls();

  const questions = await loadQuestions();
  const q = questions.find((item) => item.id === session.order[session.index]);

  // 出題中に問題が消えることは通常ないが、念のため飛ばす
  if (!q) {
    session.index++;
    if (session.index >= session.order.length) return finishQuiz();
    return showQuestion();
  }

  fillSlot(quizQuestionEl, quizQuestionImg, q.questionText, q.questionImage);
  fillSlot(quizAnswerEl, quizAnswerImg, q.answerText, q.answerImage);

  answerCard.hidden = true;
  judgeEl.hidden = true;
  revealBtn.hidden = false;

  progressText.textContent = `${session.index + 1} / ${session.order.length}問`;
  progressFill.style.width = `${(session.index / session.order.length) * 100}%`;
}

async function answer(isCorrect) {
  const questions = await loadQuestions();
  const q = questions.find((item) => item.id === session.order[session.index]);

  if (q) {
    if (isCorrect) q.correctCount++;
    else q.incorrectCount++;
    q.lastAnsweredAt = new Date().toISOString();
    await putQuestion(q);
  }

  if (isCorrect) session.correct++;
  else session.wrong++;

  session.index++;
  if (session.index >= session.order.length) await finishQuiz();
  else await showQuestion();
}

async function finishQuiz() {
  const total = session.correct + session.wrong;
  const rate = total === 0 ? 0 : Math.round((session.correct / total) * 100);

  document.getElementById("rate-num").textContent = rate;
  document.getElementById("rate-detail").textContent = `${total}問中 ${session.correct}問 正解`;
  document.getElementById("sum-total").textContent = total;
  document.getElementById("sum-correct").textContent = session.correct;
  document.getElementById("sum-wrong").textContent = session.wrong;
  document.getElementById("result-note").textContent =
    session.wrong > 0
      ? "間違えた問題は、次回から優先的に出題されます。"
      : "全問正解です。おやすみなさい。";

  releaseViewUrls();
  await refreshHome();
  showScreen("result");
}

revealBtn.addEventListener("click", () => {
  answerCard.hidden = false;
  judgeEl.hidden = false;
  revealBtn.hidden = true;
});

document.getElementById("correct-btn").addEventListener("click", () => answer(true));
document.getElementById("wrong-btn").addEventListener("click", () => answer(false));
document.getElementById("again-btn").addEventListener("click", startQuiz);

/* ---------- 画面遷移 ---------- */

goQuizBtn.addEventListener("click", startQuiz);
document.getElementById("go-save").addEventListener("click", () => openSaveScreen(null));
document.getElementById("add-from-list").addEventListener("click", () => openSaveScreen(null));

document.getElementById("go-settings").addEventListener("click", () => showScreen("settings"));

document.getElementById("go-list").addEventListener("click", async () => {
  await renderList();
  showScreen("list");
});

document.querySelectorAll("[data-back]").forEach((btn) =>
  btn.addEventListener("click", async () => {
    releaseViewUrls();
    releaseEditUrls();
    await refreshHome();
    showScreen(btn.dataset.back);
  })
);

(async () => {
  await migrateLegacyData();
  await refreshHome();
})();
