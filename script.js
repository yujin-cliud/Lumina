import {
  getFirestore, collection, addDoc, getDocs, deleteDoc, doc, updateDoc,
  getDoc, setDoc, increment, query, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
document.addEventListener("DOMContentLoaded", () => {
  let diaryData = [];
  let filteredData = [];
  let currentIndex = 0;
  let editingEntryId = null;
  let editingEntryUid = null;
// --- 過去リストのページング ---
const PAST_PAGE_SIZE = 10;    // 最初は10件
let pastVisibleCount = PAST_PAGE_SIZE;
let pastLoadMoreBtn = null;   // ボタン参照
// --- 自動読み込み用 ---
let pastObserver = null;
let pastSentinel = null;
let pastAutoloadLock = false;

  // --- プロフィール取得キャッシュ（uid → {iconUrl}） ---
  const profileCache = new Map();

  async function getProfile(uid) {
    if (!uid) return {};
    if (profileCache.has(uid)) return profileCache.get(uid);
    try {
      const ref = window.doc(window.db, "profiles", uid);
      const snap = await getDoc(ref);
      const data = snap.exists() ? snap.data() : {};
      profileCache.set(uid, data);
      return data;
    } catch (e) {
      console.warn("profile load error", e);
      return {};
    }
  }

  async function saveProfile(uid, iconUrl) {
    const ref = window.doc(window.db, "profiles", uid);
    await setDoc(ref, { iconUrl }, { merge: true });
    profileCache.set(uid, { iconUrl });
  }
// ===== 通知設定：プロフィール読込/保存ユーティリティ =====
async function loadNotifySettings(uid) {
  if (!uid) return {
    commentOnMyPost: true, replyToMyComment: true, mention: true, likeOnMyPost: false
  };
  try {
    const ref = window.doc(window.db, "profiles", uid);
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : {};
    return (data.notify) || {
      commentOnMyPost: true, replyToMyComment: true, mention: true, likeOnMyPost: false
    };
  } catch {
    return { commentOnMyPost: true, replyToMyComment: true, mention: true, likeOnMyPost: false };
  }
}

async function saveNotifySettings(uid, notify) {
  if (!uid) return;
  const ref = window.doc(window.db, "profiles", uid);
  await setDoc(ref, { notify }, { merge: true });
}

// ===== 通知UIの開閉 =====
const bell = document.getElementById("iconBell");
const badge = document.getElementById("notifBadge");
const notifModal = document.getElementById("notif-modal");

bell?.addEventListener("click", async () => {
  // ログイン必須：未ログインなら案内（あなたのUI方針に合わせて文言調整OK）
  if (!window.currentUser?.uid) {
    alert("通知を使うにはログインが必要です。投稿フォームの案内からログインしてください。");
    return;
  }
  // チェックボックスへ現在値を反映
  const n = await loadNotifySettings(window.currentUser.uid);
  document.getElementById("notifyCommentOnMyPost").checked = !!n.commentOnMyPost;
  document.getElementById("notifyReplyToMyComment").checked = !!n.replyToMyComment;
  document.getElementById("notifyMention").checked = !!n.mention;
  document.getElementById("notifyLikeOnMyPost").checked = !!n.likeOnMyPost;

  notifModal.classList.add("active");
});

document.getElementById("notifCancelBtn")?.addEventListener("click", () => {
  notifModal.classList.remove("active");
});

// ===== 設定保存 =====
document.getElementById("notifSaveBtn")?.addEventListener("click", async () => {
  try {
    const uid = window.currentUser?.uid;
    if (!uid) return;

    const notify = {
      commentOnMyPost: document.getElementById("notifyCommentOnMyPost").checked,
      replyToMyComment: document.getElementById("notifyReplyToMyComment").checked,
      mention: document.getElementById("notifyMention").checked,
      likeOnMyPost: document.getElementById("notifyLikeOnMyPost").checked
    };
    await saveNotifySettings(uid, notify);
    notifModal.classList.remove("active");
    alert("通知設定を保存しました！");
  } catch (e) {
    console.error(e);
    alert("保存に失敗しました。通信環境をご確認ください。");
  }
});

// =====（任意）バッジの初期値：今は0扱いで非表示 =====
function setBadge(count) {
  if (!badge) return;
  if (count > 0) {
    badge.style.display = "inline-flex";
    badge.textContent = String(count);
  } else {
    badge.style.display = "none";
    badge.textContent = "";
  }
}
setBadge(0); // 次回、通知箱を作ったらonSnapshotで更新する

  let selectedIcon = null;
  // --- 追加：投稿用に選択中アイコンURLを取得（未選択時はデフォルト） ---
function getSelectedIconUrlForEntry() {
  if (typeof selectedIcon === "string" && selectedIcon.trim()) {
    return selectedIcon;
  }
  const picked = document.querySelector(".profile-icon.selected, .profile-icon.is-selected");
  if (picked && picked.dataset && picked.dataset.icon) return picked.dataset.icon;
  return "image/avatars/1.png";
}

// --- 追加：表示用の優先ロジック（entry > profiles > デフォルト） ---
function resolveIconUrlForEntry(entry) {
  if (entry && entry.iconUrl) return entry.iconUrl;
  return "image/avatars/1.png";
}

  // 初期：プロフィール反映
  (async () => {
    const uid = window.currentUser?.uid;
    const prof = await getProfile(uid);
    if (prof?.iconUrl) {
      selectedIcon = prof.iconUrl;
      document.querySelectorAll(".profile-icon").forEach(i => {
        if (i.dataset.icon === selectedIcon) i.classList.add("selected");
      });
    }
  })();

  // プロフィールアイコン選択
  document.querySelectorAll(".profile-icon").forEach(icon => {
    icon.addEventListener("click", async () => {
      document.querySelectorAll(".profile-icon").forEach(i => i.classList.remove("selected"));
      icon.classList.add("selected");
      selectedIcon = icon.dataset.icon;

      const uid = window.currentUser?.uid;
      if (!uid) {
        alert("ログイン中です。数秒後にお試しください。");
        return;
      }

      try {
        await saveProfile(uid, selectedIcon);
        displayEntry();
      } catch (e) {
        console.error(e);
        alert("アイコンの保存に失敗しました。通信環境をご確認ください。");
      }
    });
  });

  // スプラッシュ非表示
  const splash = document.getElementById("splash-screen");
  if (splash) {
    setTimeout(() => {
      splash.style.transition = "opacity 1s ease";
      splash.style.opacity = "0";
      setTimeout(() => {
        splash.style.display = "none";
      }, 1000);
    }, 800);
  }

  document.getElementById("closeFormBtn")?.addEventListener("click", function () {
    const formWrapper = document.querySelector(".form-wrapper");
    if (formWrapper) {
      formWrapper.classList.remove("active");
    }
  });

async function loadEntries() {
  diaryData = [];

  // すべてのドキュメントを取得（createdAt が無い古い投稿も含む）
  const snap = await getDocs(collection(window.db, "diaries"));
  snap.forEach(d => diaryData.push({ ...d.data(), id: d.id }));

  // createdAt（Timestamp / {seconds,...}）と旧 date(ISO) の両対応で新しい順にソート
  diaryData.sort((a, b) => {
    const da = getEntryDate(a);
    const db = getEntryDate(b);
    return (db?.getTime?.() || 0) - (da?.getTime?.() || 0);
  });

  filteredData = [...diaryData];
  currentIndex = 0;
}



  function getEntryDate(entry) {
  const ts = entry?.createdAt;

  // Firestore Timestamp 型（toDate を持つ）
  if (ts && typeof ts.toDate === "function") return ts.toDate();

  // {seconds, nanoseconds} のプレーンオブジェクトで来るケース
  if (ts && typeof ts.seconds === "number") return new Date(ts.seconds * 1000);

  // 旧データ: ISO文字列 'date'
  if (entry?.date) return new Date(entry.date);

  return null;
}

function formatDateJa(d) {
  if (!d) return "";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
function formatDate(iso) {
  const d = iso ? new Date(iso) : null;
  return formatDateJa(d);
}

  function convertNewlinesToBr(text) {
    return text.replace(/\n/g, "<br>");
  }
// URLの ?q= を初期表示に適用（存在する時だけ）
function applyQueryFromURL() {
  const raw = (new URLSearchParams(location.search).get("q") || "").trim();
  if (!raw) return; // q が無ければ何もしない

  // 検索欄へ反映
  const input = document.getElementById("searchInput");
  if (input) input.value = raw.toLowerCase();

  // フィルタを適用
  const keyword = raw.toLowerCase();
  filteredData = diaryData.filter(e =>
    (e.title   || "").toLowerCase().includes(keyword) ||
    (e.content || "").toLowerCase().includes(keyword) ||
    (Array.isArray(e.tags) ? e.tags.join(",") : String(e.tags || "")).toLowerCase().includes(keyword)
  );
  currentIndex = 0;
  displayEntry();
}

  function createExpandableContent(text, maxLines = 5) {
  const wrapper = document.createElement("div");
  wrapper.className = "expandable-content";

  // 本文（最初は折りたたみ状態で描画）
  const p = document.createElement("p");
  p.className = "entry-content collapsed";
  p.style.setProperty("--line-clamp", String(maxLines)); // CSS変数があれば利用、無ければ無視されてもOK
  p.innerHTML = convertNewlinesToBr(text);

  // 「続きを読む」ボタン（必要時のみ表示するため最初は隠す）
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "readmore-btn btn-paper is-ghost";
  btn.textContent = "続きを読む";
  btn.hidden = true;

  // トグル
  let expanded = false;
  btn.addEventListener("click", () => {
    expanded = !expanded;
    if (expanded) {
      p.classList.remove("collapsed");
      btn.textContent = "閉じる";
    } else {
      p.classList.add("collapsed");
      btn.textContent = "続きを読む";
    }
  });

  wrapper.appendChild(p);
  wrapper.appendChild(btn);

  // 描画後に「本当に5行を超えて見切れているか」を実測してボタンの要否を決める
  requestAnimationFrame(() => {
    const isClamped = p.scrollHeight > p.clientHeight + 1; // +1は誤差吸収
    if (isClamped) {
      // 5行超でクランプが効いている → ボタンを表示
      btn.hidden = false;
    } else {
      // 5行以内 → クランプ不要。ボタン撤去＆全文表示
      p.classList.remove("collapsed");
      btn.remove();
    }
  });

  return wrapper;
}



  // --- メイン描画 ---
  function displayEntry() {
    const container = document.getElementById("diary-container");
    container.innerHTML = "";
    const entry = filteredData[currentIndex];
    if (!entry) return;

    const isOwner = entry.uid === window.currentUser?.uid;

    const entryHTML = document.createElement("div");
    entryHTML.className = "entry";
    entryHTML.dataset.entryId = entry.id || "";

    // タイトル
entryHTML.innerHTML = `<h3>${entry.title}</h3>`;

// ギザギザ線（タイトルの“直後”）
const divider = document.createElement("div");
divider.className = "zigzag-divider";
entryHTML.querySelector("h3").insertAdjacentElement("afterend", divider);

// 画像（ある場合のみ。ギザギザ線の“後ろ”）
if (entry.imageUrl) {
  const img = document.createElement("img");
  img.src = entry.imageUrl;
  img.className = "diary-image";
  divider.insertAdjacentElement("afterend", img);
}

// 本文（画像の“後ろ”。画像がなければギザギザ線の“後ろ”）
const expandable = createExpandableContent(entry.content);
const afterNode = entryHTML.querySelector(".diary-image") || divider;
afterNode.insertAdjacentElement("afterend", expandable);


    
    const byline = document.createElement("div");
byline.className = "byline";

const avatarImg = document.createElement("img");
avatarImg.className = "avatar";
avatarImg.alt = "avatar";
avatarImg.src = resolveIconUrlForEntry(entry); // 最優先ロジック適用

const byText = document.createElement("small");
const _d = getEntryDate(entry);
byText.innerHTML = `by ${entry.authorName || "匿名さん"}${_d ? " ｜ " + formatDateJa(_d) : ""}`;
byline.appendChild(avatarImg);
byline.appendChild(byText);
entryHTML.appendChild(byline);

// 投稿に iconUrl が無いときだけ profiles を補完
(async () => {
  if (!entry.iconUrl && entry.uid) {
    try {
      const prof = await getProfile(entry.uid);
      if (prof?.iconUrl) avatarImg.src = prof.iconUrl;
    } catch (_) {}
  }
})();


   

    // ── 2行目：ユーザー名の“下”に［お気に入り／コメント］
    const metaActions = document.createElement("div");
    metaActions.className = "entry-meta-actions";

    // 💛 お気に入り
    const likedKey = `liked_${entry.id}`;
    const isLiked  = !!localStorage.getItem(likedKey);

    const favWrap = document.createElement("span");
    favWrap.className = "entry-fav-inline";

    const likeBtn = document.createElement("button");
    likeBtn.type = "button";
    likeBtn.className ="likeBtn iconBtn";
    likeBtn.dataset.entryId = entry.id;
    likeBtn.setAttribute("aria-pressed", String(isLiked));
    likeBtn.innerHTML = `<img src="image/${isLiked ? "お気に入り済み.svg" : "お気に入り.svg"}"
  alt="${isLiked ? "お気に入り済み" : "お気に入り"}" class="favSvg">`;
likeBtn.setAttribute("aria-label", isLiked ? "お気に入り済み" : "お気に入り");




    const likeCount = document.createElement("span");
    likeCount.className = "likeCount";
    likeCount.textContent = String(entry.likes ?? 0);

    favWrap.appendChild(likeBtn);
    favWrap.appendChild(likeCount);

    // 🗨 コメント
    const cmtWrap = document.createElement("span");
    cmtWrap.className = "entry-comment-inline";

    const cmtBtn = document.createElement("button");
    cmtBtn.type = "button";
    cmtBtn.className = "commentBtn iconBtn";
    cmtBtn.innerHTML = `<img src="image/comment.svg" alt="コメント" class="commentIcon">`;
    cmtBtn.addEventListener("click", () => {
      openCommentModal(entry.id);
    });

    const cmtCount = document.createElement("span");
    cmtCount.className = "commentCount";
    cmtCount.textContent = "...";

    cmtWrap.appendChild(cmtBtn);
    cmtWrap.appendChild(cmtCount);

    // 件数取得（保険で catch あり）
    const commentRef = window.collection(window.db, "diaries", entry.id, "comments");
    window.getDocs(commentRef)
      .then(snap => { cmtCount.textContent = String(snap.size); })
      .catch(() => { cmtCount.textContent = "0"; });

    // 2行目へ追加
    metaActions.appendChild(favWrap);
    metaActions.appendChild(cmtWrap);
    entryHTML.appendChild(metaActions);

    // --- タグ（お気に入り＆コメントの下に表示） ---
    if (Array.isArray(entry.tags) && entry.tags.length > 0) {
      const tagsDiv = document.createElement("div");
      tagsDiv.className = "entry-tags";
      tagsDiv.innerHTML = entry.tags
        .map(t => `<span class="tag" data-tag="${t}">#${t}</span>`)
        .join(" ");
      entryHTML.appendChild(tagsDiv);
    }

    // 投稿カードを画面に
    container.appendChild(entryHTML);

    // 所有者ボタン（削除・編集）はカードの一番下に
    if (isOwner) {
      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "この投稿を削除";
      deleteBtn.className = "delete-btn btn-paper is-danger";
      deleteBtn.addEventListener("click", async () => {
        const ok = confirm("この投稿を削除する？");
        if (!ok) return;
        await window.deleteDoc(window.doc(window.db, "diaries", entry.id));
        await loadEntries();
        displayEntry();
      });

      const editBtn = document.createElement("button");
      editBtn.textContent = "編集";
      editBtn.className = "edit-btn btn-paper is-primary";
      editBtn.addEventListener("click", () => {
        openEditModal(entry);
      });

      const actions = document.createElement("div");
      actions.className = "entry-actions";
      actions.appendChild(deleteBtn);
      actions.appendChild(editBtn);
      entryHTML.appendChild(actions);
    }

    displayThumbnails();
    renderPastList();

  }


  // コメント読み込み
    async function loadComments(entryId) {
    const list = document.getElementById("comment-list");
    list.innerHTML = "読み込み中…";
    const ref = window.collection(window.db, "diaries", entryId, "comments");
    const snap = await window.getDocs(ref);
    const comments = [];
    snap.forEach(d => comments.push(d.data()));
    list.innerHTML = comments.length
      ? comments.map(c => {
          let d = "";
          if (c.date && typeof c.date.toDate === "function") {
            const t = c.date.toDate();
            d = `${t.getFullYear()}/${String(t.getMonth()+1).padStart(2,"0")}/${String(t.getDate()).padStart(2,"0")} `
              + `${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}`;
          } else if (typeof c.date === "string") {
            // 旧データ（string）互換
            d = new Date(c.date).toLocaleString();
          }
          return `<p>🗨 <strong>${c.name}</strong>：${c.text} <small>（${d}）</small></p>`;
        }).join("")
      : "<p>コメントはまだありません</p>";
  }

  // ▼ 「もっと読み込む」ボタン（なければ生成／あれば再利用）
function ensurePastAutoLoad(totalCount) {
  const parent = document.getElementById("lumina-past-grid");
  if (!parent) return;

  const oldBtn = document.getElementById("pastLoadMoreBtn");
  if (oldBtn) oldBtn.remove();

  if (!pastSentinel) {
    pastSentinel = document.createElement("div");
    pastSentinel.id = "pastSentinel";
    pastSentinel.style.cssText = "height:1px;";
    parent.appendChild(pastSentinel);
  } else if (pastSentinel.parentElement !== parent) {
    parent.appendChild(pastSentinel);
  }

  if (pastObserver) pastObserver.disconnect();

  pastObserver = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) return;
    if (pastAutoloadLock) return;
    pastAutoloadLock = true;

    const remaining = Math.max(0, totalCount - pastVisibleCount);
    if (remaining > 0) {
      pastVisibleCount += PAST_PAGE_SIZE;
      renderPastList();
    } else {
      pastObserver.disconnect();
    }
    setTimeout(() => (pastAutoloadLock = false), 150);
  }, { root: null, rootMargin: "0px 0px 240px 0px", threshold: 0 });

  pastObserver.observe(pastSentinel);
}


// ▼ 過去投稿（縦リスト）：いま表示中の投稿を除外、全文で描画、10件ずつ
function renderPastList() {
  const container = document.getElementById("lumina-past-grid");
  if (!container) return;
  container.innerHTML = "";

  const current = filteredData[currentIndex]?.id || null;
  const all = filteredData.filter(e => e.id !== current);
  const visible = all.slice(0, pastVisibleCount);

  visible.forEach(entry => {
    const card = document.createElement("article");
    card.className = "diary-entry";
    card.dataset.entryId = entry.id || "";
    fillCardFull(card, entry);
    container.appendChild(card);
  });

  // スクロール到達で自動追加
  ensurePastAutoLoad(all.length);
}




// ▼ 抜粋表示（カード内）
function fillCardExcerpt(card, entry) {
  card.classList.remove("is-expanded");
  card.innerHTML = "";

  if (entry.imageUrl) {
    const img = document.createElement("img");
    img.src = entry.imageUrl;
    img.alt = entry.title || "";
    img.className = "diary-image";
    card.appendChild(img);
  }

  const h3 = document.createElement("h3");
  h3.className = "entry-title";
  h3.textContent = entry.title || "(無題)";
  card.appendChild(h3);

  const p = document.createElement("p");
  p.className = "entry-content";
  const text = (entry.content || "").replace(/\n/g, " ");
  p.textContent = text.length > 80 ? text.slice(0, 80) + "…" : text;
  card.appendChild(p);
}

// ▼ 全文表示（カード内）
// ▼ 全文表示（カード内：メインと同じ構成で描画）
function fillCardFull(card, entry) {
  card.classList.add("is-expanded");
  card.innerHTML = "";

  // タイトル
  const h3 = document.createElement("h3");
  h3.className = "entry-title";
  h3.textContent = entry.title || "(無題)";
  card.appendChild(h3);

  // ギザギザ線
  const divider = document.createElement("div");
  divider.className = "zigzag-divider";
  card.appendChild(divider);

  // 画像（あれば）
  if (entry.imageUrl) {
    const img = document.createElement("img");
    img.src = entry.imageUrl;
    img.alt = entry.title || "";
    img.className = "diary-image";
    divider.insertAdjacentElement("afterend", img);
  }

  // 本文（メインと同じ“続きを読む”UI）
  const expandable = createExpandableContent(entry.content || "");
  const afterNode = card.querySelector(".diary-image") || divider;
  afterNode.insertAdjacentElement("afterend", expandable);

  // by行（アイコン＋名前＋日付）
  const byline = document.createElement("div");
  byline.className = "byline";
  const avatarImg = document.createElement("img");
avatarImg.className = "avatar";
avatarImg.alt = "avatar";
avatarImg.src = resolveIconUrlForEntry(entry); // 最優先ロジック適用
const byText = document.createElement("small");
const _d = getEntryDate(entry);
byText.innerHTML = `by ${entry.authorName || "匿名さん"}${_d ? " ｜ " + formatDateJa(_d) : ""}`;
byline.appendChild(avatarImg);
byline.appendChild(byText);
card.appendChild(byline);

// 投稿に iconUrl が無いときだけ profiles を補完
(async () => {
  if (!entry.iconUrl && entry.uid) {
    try {
      const prof = await getProfile(entry.uid);
      if (prof?.iconUrl) avatarImg.src = prof.iconUrl;
    } catch (_) {}
  }
})();


  // お気に入り／コメント（メインと同じUI）
  const metaActions = document.createElement("div");
  metaActions.className = "entry-meta-actions";

  // 💛 お気に入り
  const likedKey = `liked_${entry.id}`;
  const isLiked  = !!localStorage.getItem(likedKey);

  const favWrap = document.createElement("span");
  favWrap.className = "entry-fav-inline";

  const likeBtn = document.createElement("button");
  likeBtn.type = "button";
  likeBtn.className = "likeBtn iconBtn";
  likeBtn.dataset.entryId = entry.id;
  likeBtn.setAttribute("aria-pressed", String(isLiked));
  likeBtn.innerHTML = `<img src="image/${isLiked ? "お気に入り済み.svg" : "お気に入り.svg"}"
  alt="${isLiked ? "お気に入り済み" : "お気に入り"}" class="favSvg">`;
likeBtn.setAttribute("aria-label", isLiked ? "お気に入り済み" : "お気に入り");




  const likeCount = document.createElement("span");
  likeCount.className = "likeCount";
  likeCount.textContent = String(entry.likes ?? 0);

  favWrap.appendChild(likeBtn);
  favWrap.appendChild(likeCount);

  // 🗨 コメント
  const cmtWrap = document.createElement("span");
  cmtWrap.className = "entry-comment-inline";

  const cmtBtn = document.createElement("button");
  cmtBtn.type = "button";
  cmtBtn.className = "commentBtn iconBtn";
  cmtBtn.innerHTML = `<img src="image/comment.svg" alt="コメント" class="commentIcon">`;
  cmtBtn.addEventListener("click", () => openCommentModal(entry.id));

  const cmtCount = document.createElement("span");
  cmtCount.className = "commentCount";
  cmtCount.textContent = "...";

  cmtWrap.appendChild(cmtBtn);
  cmtWrap.appendChild(cmtCount);


  // 件数取得
  const commentRef = window.collection(window.db, "diaries", entry.id, "comments");
  window.getDocs(commentRef)
    .then(snap => { cmtCount.textContent = String(snap.size); })
    .catch(() => { cmtCount.textContent = "0"; });

  metaActions.appendChild(favWrap);
  metaActions.appendChild(cmtWrap);
  card.appendChild(metaActions);

  // タグ
  if (Array.isArray(entry.tags) && entry.tags.length > 0) {
    const tagsDiv = document.createElement("div");
    tagsDiv.className = "entry-tags";
    tagsDiv.innerHTML = entry.tags
      .map(t => `<span class="tag" data-tag="${t}">#${t}</span>`)
      .join(" ");
    card.appendChild(tagsDiv);
  }
// 所有者だけに「削除」「編集」を表示
const isOwner = entry.uid === window.currentUser?.uid;
if (isOwner) {
  const actions = document.createElement("div");
  actions.className = "entry-actions";

  // 削除
  const deleteBtn = document.createElement("button");
  deleteBtn.textContent = "この投稿を削除";
  deleteBtn.className = "delete-btn btn-paper is-danger";
  deleteBtn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (!confirm("この投稿を削除する？")) return;
    await window.deleteDoc(window.doc(window.db, "diaries", entry.id));
    await loadEntries();
    displayEntry();
  });

  // 編集
  const editBtn = document.createElement("button");
  editBtn.textContent = "編集";
  editBtn.className = "edit-btn btn-paper is-primary";
  editBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openEditModal(entry);
  });

  actions.appendChild(deleteBtn);
  actions.appendChild(editBtn);
  card.appendChild(actions);
}
}

 
// ▼ 同じカードをトグル（別要素を増やさない）
function toggleInlineInPlace(card, entry) {
  if (card.classList.contains("is-expanded")) {
    fillCardExcerpt(card, entry);     // 折りたたみ
  } else {
    // 同時に1つだけ開く：他カードを閉じる
    const container = document.getElementById("lumina-past-grid");
    container?.querySelectorAll(".diary-entry.is-expanded")?.forEach(el => {
      const id = el.dataset.entryId;
      const ent = (filteredData || []).find(e => e.id === id);
      if (ent) fillCardExcerpt(el, ent);
      else el.classList.remove("is-expanded");
    });
    fillCardFull(card, entry);        // 展開
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

  // 検索・タグ
  document.getElementById("searchBtn")?.addEventListener("click", () => {
    const keyword = document.getElementById("searchInput").value.trim().toLowerCase();
    if (!keyword) return alert("検索ワードを入力してな！");
    filteredData = diaryData.filter(e =>
      (e.title   || "").toLowerCase().includes(keyword) ||
      (e.content || "").toLowerCase().includes(keyword) ||
      (Array.isArray(e.tags) ? e.tags.join(",") : String(e.tags || "")).toLowerCase().includes(keyword)
    );
    currentIndex = 0;
    displayEntry();
  });

  document.getElementById("clearBtn")?.addEventListener("click", () => {
    filteredData = [...diaryData];
    currentIndex = 0;
    document.getElementById("searchInput").value = "";
    displayEntry();
  });

  document.addEventListener("click", (e) => {
    if (e.target.classList.contains("tag")) {
      const tag = e.target.dataset.tag.toLowerCase();
      document.getElementById("searchInput").value = tag;
      filteredData = diaryData.filter(e => (e.tags || []).some(t => t.toLowerCase() === tag));
      currentIndex = 0;
      displayEntry();
    }
  });
  // ▼ サムネ横スクロール帯を描画（現在表示中は除外）
function displayThumbnails() {
  const bar = document.getElementById("lumina-thumb-track");
  if (!bar) return;
  bar.innerHTML = "";

  filteredData.forEach((entry, index) => {
    if (index === currentIndex) return; // いま表示中はサムネから除外

    const div = document.createElement("div");
    div.className = "thumbnail-item";

    const contentPreview = (entry.content || "").replace(/\n/g, " ").slice(0, 30);
    if (entry.imageUrl) {
      div.innerHTML = `
        <img src="${entry.imageUrl}" class="thumbnail-image" />
        <div class="thumbnail-text">${entry.title || "(無題)"}<br><small>${entry.authorName || ""}</small></div>`;
    } else {
      div.innerHTML = `
        <div class="thumbnail-text">
          <strong>${entry.title || "(無題)"}</strong><br>
          ${contentPreview}${(entry.content || "").length > 30 ? "…" : ""}<br>
          <small>${entry.authorName || ""}</small>
        </div>`;
    }

    div.addEventListener("click", () => {
      currentIndex = index;
      displayEntry();
    });

    bar.appendChild(div);
  });
}

  // メニュー・フォーム開閉
  document.getElementById("menuToggle")?.addEventListener("click", () => {
    const menu = document.getElementById("menuItems");
    const icon = document.getElementById("menuToggle");
    menu.classList.toggle("active");
    icon.classList.toggle("flipped");
  });
// キャンセルボタンでフォームを閉じる
document.getElementById("cancelBtn")?.addEventListener("click", () => {
  formWrapper.classList.remove("active");

  // アイコン選択枠もリセット（必要なら）
  document.querySelectorAll(".profile-icon.is-selected")
    .forEach(el => el.classList.remove("is-selected"));
});

  const formWrapper = document.querySelector(".form-wrapper");
  const iconPost = document.getElementById("iconPost");
  iconPost?.addEventListener("click", () => {
    formWrapper.classList.toggle("active");
  });
  // ヘッダーロゴ（タイトル）クリックで「最新投稿」に戻る
document.querySelector(".header-logo")?.addEventListener("click", async () => {
  // 検索欄をクリア（フィルタもリセットしたいので）
  const input = document.getElementById("searchInput");
  if (input) input.value = "";

  // 投稿を再取得して最新順に並べ直し
  await loadEntries();          // Firestoreから再ロード（常に最新に）
  filteredData = [...diaryData]; // 念のためフィルタ解除
  currentIndex = 0;              // 先頭（最新）へ

  displayEntry();
  

  

  // 画面上部へスクロール
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// ── 新規投稿：送信ハンドラ
const submitBtn = document.getElementById("submitBtn");
submitBtn?.addEventListener("click", async () => {
  const uid      = window.currentUser?.uid || null;
  const nameEl   = document.getElementById("username");
  const titleEl  = document.getElementById("title");
  const contentEl= document.getElementById("content");
  const tagsEl   = document.getElementById("tags");

  // 名前は「入力値 > GoogleのdisplayName > 匿名さん」の優先順
const authorName =
  (nameEl?.value || "").trim() ||
  (window.currentUser?.displayName || "").trim() ||
  "匿名さん";

const title    = (titleEl?.value || "").trim();
const content  = (contentEl?.value || "").trim();
const tagsRaw  = (tagsEl?.value || "").trim();

// 入力チェック（最低限）
if (!title)   return alert("タイトルを入力して下さい");
if (!content) return alert("本文を入力して下さい");

// タグは配列化（空なら []）
const tags = tagsRaw
  ? tagsRaw.split(",").map(t => t.trim()).filter(Boolean)
  : [];

// 画像は今は任意（未実装なら空でOK）
const imageUrl = "";

const entry = {
  uid,
  authorName,
  title,
  content,
  tags,
  imageUrl,
  likes: 0,
  iconUrl: getSelectedIconUrlForEntry(),
  createdAt: serverTimestamp()   // ← サーバ時刻を保存
};




  try {
    // Firestoreへ保存
const colRef = window.collection(window.db, "diaries");
const ref = await window.addDoc(colRef, entry);

// ★ サーバー確定版を読み直す
const snap  = await getDoc(ref);
const saved = { id: ref.id, ...snap.data() };

// ★ UI 更新には saved を使う
diaryData.unshift(saved);
filteredData = [...diaryData];
currentIndex = 0;
displayEntry();


    // 入力クリア
    if (nameEl)    nameEl.value = "";
    if (titleEl)   titleEl.value = "";
    if (contentEl) { contentEl.value = ""; contentEl.style.height = "auto"; }
    if (tagsEl)    tagsEl.value = "";

    // フォームを閉じる
    formWrapper.classList.remove("active");

    // 最新順で再描画（新規投稿を先頭に）
    await loadEntries();
    currentIndex = 0;
    displayEntry();
    alert("投稿したで！");
  } catch (err) {
    console.error("投稿エラー:", err);
    alert("投稿に失敗したで…。通信状況を確認してもう一度試してな。");
  }
});

  // ショートカット：タグ検索入力にフォーカス
  document.getElementById("iconTag")?.addEventListener("click", () => {
    const input = document.getElementById("searchInput");
    input.scrollIntoView({ behavior: "smooth", block: "center" });
    input.focus();
  });

  // 「お気に入りだけ」フィルタ
  document.getElementById("iconFavorite")?.addEventListener("click", () => {
    filteredData = diaryData.filter(entry => {
      const likedKey = `liked_${entry.id}`;
      return localStorage.getItem(likedKey);
    });
    currentIndex = 0;
    displayEntry();
  });

  // --- お気に入りトグル ---
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest?.(".likeBtn");
    if (!btn) return;

    const entryId = btn.dataset.entryId;
    if (!entryId) return;

    const favWrap = btn.parentElement;
    const countEl = favWrap?.querySelector(".likeCount");

    const likedKey = `liked_${entryId}`;
    const wasLiked = !!localStorage.getItem(likedKey);
    const delta = wasLiked ? -1 : 1;

    // 楽観的UI
    btn.setAttribute("aria-pressed", String(!wasLiked));
    btn.innerHTML = `<img src="image/${!wasLiked ? "お気に入り済み.svg" : "お気に入り.svg"}"
  alt="${!wasLiked ? "お気に入り済み" : "お気に入り"}" class="favSvg">`;
btn.setAttribute("aria-label", !wasLiked ? "お気に入り済み" : "お気に入り");


    if (countEl) {
      const prev = parseInt(countEl.textContent || "0", 10);
      countEl.textContent = String(Math.max(0, prev + delta));
    }
    if (wasLiked) localStorage.removeItem(likedKey);
    else localStorage.setItem(likedKey, "1");

    // Firestore反映（失敗時ロールバック）
    try {
      const ref = window.doc(window.db, "diaries", entryId);
      await window.updateDoc(ref, { likes: increment(delta) });
    } catch (err) {
      console.error("likes update failed:", err);
      // ロールバック
      btn.setAttribute("aria-pressed", String(wasLiked));
      btn.innerHTML = `<img src="image/${wasLiked ? "お気に入り済み.svg" : "お気に入り.svg"}"
  alt="${wasLiked ? "お気に入り済み" : "お気に入り"}" class="favSvg">`;
btn.setAttribute("aria-label", wasLiked ? "お気に入り済み" : "お気に入り");


      if (countEl) {
        const now = parseInt(countEl.textContent || "0", 10);
        countEl.textContent = String(Math.max(0, now - delta));
      }
      if (wasLiked) localStorage.setItem(likedKey, "1");
      else localStorage.removeItem(likedKey);
    }
  });

  // 編集モーダル
  function openEditModal(entry) {
    editingEntryId  = entry.id;
    editingEntryUid = entry.uid || null;

    document.getElementById("editTitle").value    = entry.title   || "";
    document.getElementById("editContent").value  = entry.content || "";
    document.getElementById("editTags").value     = Array.isArray(entry.tags) ? entry.tags.join(", ") : (entry.tags || "");
    document.getElementById("editImageUrl").value = entry.imageUrl || "";
    document.getElementById("editModal").classList.add("active");
    const ec = document.getElementById("editContent");
    if (ec) { ec.style.height = "auto"; ec.style.height = ec.scrollHeight + "px"; }
  }
    
  function closeEditModal() {
    editingEntryId = null;
    editingEntryUid = null;
    document.getElementById("editModal").classList.remove("active");
  }

  document.getElementById("saveEditBtn")?.addEventListener("click", async () => {
  try {
    const updatedTitle    = document.getElementById("editTitle").value.trim();
    const updatedContent  = document.getElementById("editContent").value.trim();
    const updatedTagsRaw  = document.getElementById("editTags").value;
    const updatedImageUrl = document.getElementById("editImageUrl").value.trim();

    if (!editingEntryId) return;

    // 本人チェック
    if (!window.currentUser || !editingEntryUid || window.currentUser.uid !== editingEntryUid) {
      alert("この投稿を編集する権限がありません。");
      return;
    }

    const updatedTags = updatedTagsRaw.split(",").map(t => t.trim()).filter(Boolean);

    const entryRef = window.doc(window.db, "diaries", editingEntryId);
    await window.updateDoc(entryRef, {
      title: updatedTitle,
      content: updatedContent,
      tags: updatedTags,
      imageUrl: updatedImageUrl
    });

    // 反映
    closeEditModal();
    await loadEntries();
    displayEntry();
    alert("保存したよ！");
  } catch (err) {
    console.error("編集の保存に失敗しました:", err);
    alert("保存中にエラーが発生しました。");
  }
});


      
  document.getElementById("editContent")?.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = this.scrollHeight + "px";
  });

  document.getElementById("cancelEditBtn")?.addEventListener("click", () => {
    closeEditModal();
  });

  // コメントモーダル
  function openCommentModal(postId) {
    const modal = document.getElementById("comment-modal");
    modal.classList.add("active");
    modal.dataset.postId = postId;
    loadComments(postId);
  }
    const ct = document.getElementById("comment-text");
    if (ct) { ct.style.height = "auto"; ct.style.height = ct.scrollHeight + "px"; }

  document.getElementById("close-comment-modal")?.addEventListener("click", () => {
    document.getElementById("comment-modal").classList.remove("active");
  });
  document.getElementById("comment-cancel")?.addEventListener("click", () => {
    document.getElementById("comment-modal").classList.remove("active");
  });

  document.getElementById("comment-text")?.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = this.scrollHeight + "px";
  });

    document.getElementById("comment-submit")?.addEventListener("click", async () => {
    const name = document.getElementById("comment-name").value.trim() || "匿名さん";
    const text = document.getElementById("comment-text").value.trim();
    const postId = document.getElementById("comment-modal").dataset.postId;
    if (!text) return alert("コメントを入力してな！");

    const comment = { name, text, date: serverTimestamp() };

    try {
      const ref = window.collection(window.db, "diaries", postId, "comments");
      await window.addDoc(ref, comment);

      // モーダル内リストを更新
      await loadComments(postId);

      // 件数も更新（いま表示中のカードだけ反映）
      try {
  const cRef  = window.collection(window.db, "diaries", postId, "comments");
  const cSnap = await window.getDocs(cRef);
  const newCount = String(cSnap.size);

  // メイン（diary-container）側を更新
  document.getElementById("diary-container")
    ?.querySelectorAll(".commentCount")
    ?.forEach(el => { el.textContent = newCount; });

  // data-entry-id が一致する過去投稿カードも更新
  document.querySelectorAll(`[data-entry-id="${postId}"] .commentCount`)
    ?.forEach(el => { el.textContent = newCount; });
} catch (_) { /* 無視 */ }


      // 入力クリア & モーダルを正しく閉じる
      document.getElementById("comment-name").value = "";
      document.getElementById("comment-text").value = "";
      const modal = document.getElementById("comment-modal");
      modal.classList.remove("active");
      modal.style.display = ""; // 次回も開けるように
    } catch (err) {
      console.error("コメント保存エラー：", err);
      alert("コメントの保存に失敗したで…");
    }
  });


  // 🔸 レトロ紙ボタンをコメント送信に“確実に”適用（ここが今回の追記）
  document.getElementById("comment-submit")?.classList.add("btn-paper", "is-primary");

  // 初期ロード
(async () => {
  await loadEntries();
  filteredData = [...diaryData];
  currentIndex = 0;

  const hasQ = !!new URLSearchParams(location.search).get("q");
  if (hasQ) {
    // ★ URL直リンク検索を適用
    applyQueryFromURL();
  } else {
    // 通常の初期表示
    displayEntry();
  }

  window.initThumbAutoSlide?.();
})();


});
 // DOMContentLoaded ここまで

// 📌 本文欄の高さ自動調整（フォーム上）
const contentTextarea = document.getElementById("content");
contentTextarea?.addEventListener("input", () => {
  contentTextarea.style.height = "auto";
  contentTextarea.style.height = contentTextarea.scrollHeight + "px";
});

/***** 画像アップロード（Cloudinary unsigned） *****/
const CLOUD_NAME   = "dvzapaede";
const UPLOAD_PRESET= "todoku_upload";

const pickImageBtn  = document.getElementById("pickImageBtn");
const editImageFile = document.getElementById("editImageFile");
const editImageUrl  = document.getElementById("editImageUrl");
const uploadHint    = document.getElementById("uploadHint");

pickImageBtn?.addEventListener("click", () => {
  editImageFile?.click();
});

editImageFile?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  try {
    if (uploadHint) uploadHint.textContent = "アップロード中…";
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", UPLOAD_PRESET);

    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/upload`, {
      method: "POST",
      body: formData
    });
    if (!res.ok) throw new Error("Cloudinary upload failed");
    const json = await res.json();

    if (editImageUrl) editImageUrl.value = json.secure_url || json.url || "";
    if (uploadHint) uploadHint.textContent = "アップロード完了！";
  } catch (err) {
    console.error(err);
    if (uploadHint) uploadHint.textContent = "アップロード失敗。もう一度お試しください。";
    alert("画像のアップロードに失敗しました。通信状況をご確認ください。");
  } finally {
    if (editImageFile) editImageFile.value = "";
  }
});
// ===== Google ログイン/ログアウト (Firebase v10.12.2) =====
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const auth = getAuth();
const provider = new GoogleAuthProvider();
function updateAuthButtonsUI(user) {
  const { loginBtn, logoutBtn, headerLoginBtn, headerLogoutBtn } = getAuthButtons();
  const isLoggedIn = !!user && !user.isAnonymous;

  // フォーム内
  if (loginBtn)  loginBtn.classList.toggle("is-hidden", isLoggedIn);
  if (logoutBtn) logoutBtn.classList.toggle("is-hidden", !isLoggedIn);

  // ヘッダー
  if (headerLoginBtn)  headerLoginBtn.classList.toggle("is-hidden", isLoggedIn);
  if (headerLogoutBtn) headerLogoutBtn.classList.toggle("is-hidden", !isLoggedIn);
}

// ★ ボタンの参照は毎回安全に取り直す
function getAuthButtons() {
  return {
    // 既存（フォーム内）
    loginBtn:  document.getElementById("loginBtn"),
    logoutBtn: document.getElementById("logoutBtn"),
    // 追加（ヘッダー用）
    headerLoginBtn:  document.getElementById("headerLoginBtn"),
    headerLogoutBtn: document.getElementById("headerLogoutBtn"),
  };
}


function bindAuthButtonEvents() {
  const { loginBtn, logoutBtn, headerLoginBtn, headerLogoutBtn } = getAuthButtons();

  // ログイン（フォーム&ヘッダー）
  [loginBtn, headerLoginBtn].forEach(btn => {
    if (!btn) return;
    btn.onclick = null;
    btn.onclick = async () => {
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        console.error("Googleログイン失敗:", e);
        if (e && e.code === "auth/popup-blocked") {
          const { signInWithRedirect } =
            await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
          await signInWithRedirect(auth, provider);
        }
      }
    };
  });

  // ログアウト（フォーム&ヘッダー）
  [logoutBtn, headerLogoutBtn].forEach(btn => {
    if (!btn) return;
    btn.onclick = null;
    btn.onclick = async () => {
      try { await signOut(auth); }
      catch (e) { console.error("ログアウト失敗:", e); }
    };
  });
}

// ★ ページ読み込み時に必ず結び直す
document.addEventListener("DOMContentLoaded", bindAuthButtonEvents);
// すでにDOMが出来ているケースにも対応
bindAuthButtonEvents();
// フォーム出し分け
function applyAuthUIToForm(user) {
  const form = document.getElementById("diary-form");
  const prompt = document.getElementById("loginPrompt");
  const isLoggedIn = !!user && !user.isAnonymous;

  if (form && prompt) {
    if (isLoggedIn) {
      form.classList.remove("is-hidden");
      prompt.classList.add("is-hidden");
    } else {
      form.classList.add("is-hidden");
      prompt.classList.remove("is-hidden");
    }
  }
}


// 統合版（ここだけ残す）
onAuthStateChanged(auth, (user) => {
  window.currentUser = user || null;

  // 既存のUI更新をここに集約
  applyAuthUIToForm(user);
  updateAuthButtonsUI(user);
  autoFillName(user);

  // ログもここだけ
  console.log(
    "Auth:",
    user ? "signed in" : "signed out",
    { uid: user?.uid ?? null, isAnonymous: user?.isAnonymous ?? null, email: user?.email ?? null }
  );
});



// 初回反映（DOM用意後）
document.addEventListener("DOMContentLoaded", () => {
  applyAuthUIToForm(window.currentUser || null);
  bindAuthButtonEvents(); // フォーム内の loginBtn を結び直す
});

// ★ 状態に応じてボタンの表示を切替


// ===== 名前のオートフィル & ローカル保存（Step 1）=====
const LUMINA_NAME_KEY = "luminaName";

// 保存済みの名前を取得
function getSavedName() {
  try { return localStorage.getItem(LUMINA_NAME_KEY) || ""; } catch { return ""; }
}

// 名前を保存
function saveName(v) {
  try { localStorage.setItem(LUMINA_NAME_KEY, v ?? ""); } catch {}
}

// input#username に値をセット
function setNameField(val) {
  const el = document.getElementById("username");
  if (el && typeof val === "string") el.value = val;
}

/**
 * ログイン状態に応じて名前欄を自動入力
 * 優先度：現在の入力値 → localStorage → Googleの displayName
 */
function autoFillName(user) {
  const input = document.getElementById("username");
  if (!input) return;

  const current   = (input.value || "").trim();
  const fromLS    = (getSavedName() || "").trim();
  const fromAuth  = ((user && user.displayName) || "").trim();

  const next = current || fromLS || fromAuth;
  if (next) setNameField(next);
}

// 入力が変わったらローカル保存（次回の初期値にする）
document.addEventListener("input", (e) => {
  if (e?.target && e.target.id === "username") {
    saveName(e.target.value.trim());
  }
  autoFillName(window.currentUser || null);
});
// ==========================
// ダミー投稿一括投入（暫定ユーティリティ）
// ==========================
async function seedDummyEntries(count = 8) {
  const uid = window.currentUser?.uid;
  if (!uid) {
    alert("先にログインしてから実行してね（匿名でもOK）");
    return;
  }

  const iconPool = [
    "image/avatars/1.png",
    "image/avatars/2.png",
    "image/avatars/3.png",
    "image/avatars/4.png",
    "image/avatars/5.png",
    "image/avatars/6.png",
  ];
  const names = ["ゆら", "ソラ", "ミナ", "レイ", "ハル", "アオ", "ナギ", "ヒカリ"];
  const sampleTitles = [
    "朝の空気、新しい一歩",
    "コーヒー一杯ぶんの余白",
    "窓辺でひと休み",
    "小雨の音が心地いい",
    "メモに残した小さな発見",
    "スニーカーが語る距離",
    "夕焼けの帰り道",
    "はじまりのページ"
  ];
  const sampleBodies = [
    "思ってたより世界は近い。手のひらの体温で少しやわらぐ。",
    "浅煎りの香り。深呼吸して今日の再起動。",
    "答えはまだ分からないけど、探すのはちょっと楽しい。",
    "静かな音が背中を押す。少しだけ前に。",
    "忘れないうちに書き留めた。小さなきっかけが、大きな分岐に。",
    "歩いた距離だけ、少しだけやさしくなれた気がする。",
    "色が溶けていく時間、言葉は少なくていい。",
    "一行目は怖い。だけど書き始めたら、続きは意外と出てくる。"
  ];

  const colRef = window.collection(window.db, "diaries");

  let created = 0;
  for (let i = 0; i < count; i++) {
    const iconUrl = iconPool[i % iconPool.length];
    const authorName = names[i % names.length];

    const entry = {
      uid,
      authorName,
      title: sampleTitles[i % sampleTitles.length],
      content: sampleBodies[i % sampleBodies.length],
      tags: "dummy",
      imageUrl: null,
      likes: 0,
      iconUrl,
      createdAt: serverTimestamp() // ← ここを修正
    };

    try {
      await window.addDoc(colRef, entry);
      created++;
    } catch (e) {
      console.error("ダミー投入エラー:", e);
    }
  }

  alert(`ダミー投稿を ${created} 件追加しました`);
}

// コンソールから呼べるように
window.seedDummyEntries = seedDummyEntries;

// ====== Likeボタン 再バインド・二重発火ガード（後付け版 / no <script> tags） ======
(function(){
  // --- Safari古め対策：Element.prototype.replaceWith が無い場合のフォールバック ---
  if (!Element.prototype.replaceWith) {
    Element.prototype.replaceWith = function() {
      const parent = this.parentNode;
      if (!parent) return;
      const args = Array.prototype.slice.call(arguments);
      for (let i = 0; i < args.length; i++) {
        const node = args[i] instanceof Node
          ? args[i]
          : document.createTextNode(String(args[i]));
        if (i === 0) {
          parent.replaceChild(node, this);
        } else {
          parent.insertBefore(node, this.nextSibling);
        }
      }
    };
  }

  // ▼ ユーティリティ
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

  /**
   * Firestore側の更新呼び出し（あなたの既存関数にブリッジ）
   * - 既存に toggleLike(docId, liked) 相当があればそれを呼ぶ
   */
  async function apiToggleLike(docId, liked) {
    // 例: 既存の関数名に合わせてここを書き換えてOK
    if (typeof window.toggleLike === 'function') {
      return await window.toggleLike(docId, liked);
    }
    if (window.likeApi && typeof window.likeApi.toggle === 'function') {
      return await window.likeApi.toggle(docId, liked);
    }
    // 何もなければ成功扱い（UI検証用）
    return Promise.resolve({ ok: true });
  }

  // ファイル先頭か即時関数の外で定数を定義してもOK
const LIKE_ICON_UNLIKED = 'image/お気に入り.svg';
const LIKE_ICON_LIKED   = 'image/お気に入り済み.svg';

// UI反映（楽観更新/ロールバック共通）
function applyLikeUI(btn, liked){
  // カウント更新
  const countEl =
    btn.closest('.entry-meta-actions, .entry-actions, .diary-entry')
    ?.querySelector('.likeCount');
  if (countEl) {
    const now = parseInt(countEl.textContent || '0', 10) || 0;
    countEl.textContent = String(liked ? now + 1 : Math.max(0, now - 1));
  }

  // ボタン状態（aria とクラス）
  btn.classList.toggle('is-liked', liked);
  btn.setAttribute('aria-pressed', liked ? 'true' : 'false');

  // ▼ アイコン差し替え（imgタグの場合）
  const iconImg = btn.querySelector('img.favSvg, img');
  if (iconImg) {
    iconImg.src = liked ? LIKE_ICON_LIKED : LIKE_ICON_UNLIKED;
    iconImg.alt = liked ? 'お気に入り済み' : 'お気に入り';
    return;
  }

  // ▼ SVGの場合はクラス切り替え
  const svg = btn.querySelector('.favSvg, svg');
  if (svg) svg.classList.toggle('is-liked', liked);
}


  // 既存の click/touch リスナーを**完全除去**してから pointerup を付け直す
  function rebindLikeButton(oldBtn){
    if (!(oldBtn instanceof HTMLElement)) return oldBtn;
    if (oldBtn.dataset.rebound === '1') return oldBtn;

    // クローン置換で既存リスナーを丸ごと剥がす
    const btn = oldBtn.cloneNode(true);
    oldBtn.replaceWith(btn);
    btn.dataset.rebound = '1';

    // 初期状態の推定
    let liked =
      btn.classList.contains('is-liked') ||
      btn.getAttribute('aria-pressed') === 'true';
    btn.setAttribute('aria-pressed', liked ? 'true' : 'false');

    // 連打ロック
    let lock = false;

    // 余計な click をキャプチャで潰す（保険）
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      return false;
    }, true);

    // pointerup 一本化
    btn.addEventListener('pointerup', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (lock) return;
      lock = true;

      const docId = btn.dataset.docid || btn.getAttribute('data-id') || null;

      // --- 楽観的UI更新 ---
      const prevLiked = liked;
      liked = !liked;
      applyLikeUI(btn, liked);

      try {
        await apiToggleLike(docId, liked); // Firestore 反映
      } catch (err) {
        console.error('toggleLike failed:', err);
        // 失敗 → ロールバック
        liked = prevLiked;
        applyLikeUI(btn, liked);
      } finally {
        setTimeout(() => { lock = false; }, 300); // 連打吸収
      }
    }, { passive: false });

    // iOSゴーストタップ対策（最終保険）
    btn.style.touchAction = 'manipulation';

    return btn;
  }

  function bindAllLikeButtons(){
    $$('.likeBtn').forEach(rebindLikeButton);
  }

  // 初期化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAllLikeButtons);
  } else {
    bindAllLikeButtons();
  }

  // 動的追加に追従
  const mo = new MutationObserver((muts)=>{
    for (const m of muts) {
      m.addedNodes.forEach(node=>{
        if (!(node instanceof HTMLElement)) return;
        if (node.matches && node.matches('.likeBtn')) rebindLikeButton(node);
        if (node.querySelectorAll) node.querySelectorAll('.likeBtn').forEach(rebindLikeButton);
      });
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
})();
