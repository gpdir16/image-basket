// 브라우저 언어에 맞는 문자열 (i18n)
const t = (k, subs) => browser.i18n.getMessage(k, subs);
const ICONS = { image: "🖼", video: "🎬", audio: "🎵" };
const TYPE_NAMES = { image: t("typeImage"), video: t("typeVideo"), audio: t("typeAudio") };
const FILTER_NAMES = { page: t("filterPage"), tab: t("filterTab"), all: t("filterAll") };
const STATUS = { ready: t("statusReady"), saving: t("statusSaving"), saved: t("statusSaved"), tooBig: t("statusTooBig") };

let bg = null;
let filter = "page";
let lastRev = -1;
let lastFilter = null;
let refreshId = 0;
let pendingRefresh = null;
let zipRunning = false;
const pendingSaves = new Set();
let counts = null; // {all, tab, page} — 제목 배지/빈 목록에 표시
const thumbCache = new Map(); // itemId -> object URL — 재렌더해도 썸네일이 깜빡이지 않게 유지

function renderItem(it) {
    const li = document.createElement("li");
    if (it.type === "image" && it.blob) {
        const img = document.createElement("img");
        img.className = "thumb";
        let u = thumbCache.get(it.id);
        if (!u) {
            u = URL.createObjectURL(it.blob);
            thumbCache.set(it.id, u);
        }
        img.src = u;
        img.title = it.url;
        li.appendChild(img);
    } else {
        const ic = document.createElement("span");
        ic.className = "thumb icon";
        ic.textContent = ICONS[it.type];
        li.appendChild(ic);
    }
    const info = document.createElement("div");
    info.className = "info";
    info.title = it.url;
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = it.downloadFilename || it.filename;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${it.host} · ${bg.fmtSize(it.size)} · ${STATUS[it.status] || ""}`;
    info.append(name, meta);
    li.appendChild(info);
    if (it.status === "ready" || it.status === "saved") {
        const btn = document.createElement("button");
        btn.textContent = it.status === "saved" ? t("saveAgain") : t("save");
        btn.disabled = pendingSaves.has(it.id);
        btn.onclick = async () => {
            if (pendingSaves.has(it.id)) return;
            pendingSaves.add(it.id);
            btn.disabled = true;
            try {
                if (!(await bg.saveItem(it.id, name.textContent))) setStatus(t("saveFailed"));
            } catch (e) {
                setStatus(t("error") + e.message);
            } finally {
                pendingSaves.delete(it.id);
                await refresh(true);
                btn.disabled = false;
            }
        };
        li.appendChild(btn);
    }
    return li;
}

function render(items) {
    const list = document.getElementById("list");
    list.textContent = "";
    const visible = new Set();
    if (!items.length) {
        const li = document.createElement("li");
        li.className = "empty";
        let msg = t(filter === "page" ? "emptyPage" : filter === "tab" ? "emptyTab" : "emptyNone");
        if (counts && counts.all > items.length) {
            msg += t("emptyOther", [String(counts.all), String(counts.tab)]);
        }
        li.textContent = msg;
        list.appendChild(li);
    } else {
        for (const it of items) {
            visible.add(it.id);
            list.appendChild(renderItem(it));
        }
    }
    // 더 이상 보이지 않는 항목의 썸네일 URL 해제
    for (const [id, u] of thumbCache) {
        if (!visible.has(id)) {
            URL.revokeObjectURL(u);
            thumbCache.delete(id);
        }
    }
}

function updateCounts() {
    // 제목 옆 배지: 현재 필터의 항목 수만 표시
    const el = document.getElementById("count");
    el.textContent = counts && counts[filter] > 0 ? `· ${counts[filter]}` : "";
    // 비울 항목이 없으면 비우기 숨김
    document.getElementById("clear").hidden = !counts || counts.all === 0;
}

async function refresh(force) {
    if (!bg) return;
    const rev = bg.getRevision();
    const requestedFilter = filter;
    if (!force) {
        if (rev === lastRev && requestedFilter === lastFilter) return;
        if (pendingRefresh && pendingRefresh.rev === rev && pendingRefresh.filter === requestedFilter) return;
    } else {
        // 강제 갱신이 실패해도 다음 주기에서 다시 시도하도록 캐시를 무효화
        lastRev = -1;
        lastFilter = null;
    }
    const id = ++refreshId;
    pendingRefresh = { id, rev, filter: requestedFilter };
    try {
        const items = await bg.getItems(requestedFilter);
        const nextCounts = await bg.getCounts();
        // 페이지 검사 중 필터나 갱신 요청이 바뀌면 오래된 응답은 버림
        if (id !== refreshId || requestedFilter !== filter) return;
        counts = nextCounts;
        updateCounts();
        render(items);
        lastRev = rev;
        lastFilter = requestedFilter;
    } catch (e) {
        if (id === refreshId && requestedFilter === filter) setStatus(t("error") + e.message);
    } finally {
        if (pendingRefresh && pendingRefresh.id === id) pendingRefresh = null;
    }
}

function setStatus(text) {
    // 딤 오버레이 + 중앙 다이얼로그, 확인 버튼으로 닫기
    const el = document.getElementById("toast");
    el.querySelector("#toastText").textContent = text;
    el.classList.add("show");
}

// ---------- 드롭다운 메뉴 ----------

function closeMenus() {
    document.querySelectorAll(".menu").forEach((m) => m.classList.remove("open"));
    syncArrows();
}

function toggleMenu(id) {
    const m = document.getElementById(id);
    const willOpen = !m.classList.contains("open");
    closeMenus();
    if (willOpen) m.classList.add("open");
}

function syncArrows() {
    for (const [btnId, menuId] of [
        ["typeBtn", "typeMenu"],
        ["filterBtn", "filterMenu"],
        ["zipAll", "zipMenu"],
    ]) {
        document.getElementById(btnId).setAttribute("aria-expanded", document.getElementById(menuId).classList.contains("open") ? "true" : "false");
    }
}

function updateTypeLabel() {
    const on = ["image", "video", "audio"].filter((t) => document.querySelector(`input[data-type="${t}"]`).checked);
    document.getElementById("typeLabel").textContent = on.length ? on.map((t) => TYPE_NAMES[t]).join("·") : t("typeAllOff");
}

async function runZip(kind) {
    if (!bg || zipRunning) return;
    zipRunning = true;
    const requestedFilter = filter;
    const buttons = ["zipAll", "zipNormal", "zipSmart"].map((id) => document.getElementById(id));
    buttons.forEach((btn) => { btn.disabled = true; });
    try {
        const items = await bg.getItems(requestedFilter);
        const n = kind === "smart" ? await bg.smartZip(items) : await bg.zipAll(items);
        setStatus(kind === "smart" ? (n ? t("zipSmartStarted", [String(n)]) : t("zipSmartNone")) : n ? t("zipStarted", [String(n)]) : t("zipNone"));
    } catch (e) {
        setStatus(t("error") + e.message);
    } finally {
        zipRunning = false;
        buttons.forEach((btn) => { btn.disabled = false; });
        await refresh(true);
    }
}

async function init() {
    bg = await browser.runtime.getBackgroundPage();
    const s = await bg.getSettings();

    // i18n — 브라우저 언어에 맞는 문자열 적용
    document.documentElement.lang = browser.i18n.getUILanguage().startsWith("ko") ? "ko" : "en";
    document.querySelectorAll("[data-i18n]").forEach((el) => {
        el.textContent = t(el.dataset.i18n);
    });

    // 유형/범위 — 네이티브 checkbox/radio (accent-color로 Nova 톤)
    ["image", "video", "audio"].forEach((t) => {
        document.querySelector(`input[data-type="${t}"]`).checked = !!s[t];
    });
    updateTypeLabel();
    document.getElementById("filterLabel").textContent = FILTER_NAMES[filter];
    document.querySelector(`input[name="f"][value="${filter}"]`).checked = true;

    // 메뉴 열기/닫기 — 버튼을 누르면 메뉴가 열리고, 메뉴 항목을 골라야 다운로드 실행
    for (const [btnId, menuId] of [
        ["typeBtn", "typeMenu"],
        ["filterBtn", "filterMenu"],
        ["zipAll", "zipMenu"],
    ]) {
        document.getElementById(btnId).addEventListener("click", () => toggleMenu(menuId));
    }
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".menu-wrap")) closeMenus();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMenus();
    });

    // 유형 토글 (메뉴는 열린 채 유지 — 여러 개 선택 가능)
    document.querySelectorAll("input[data-type]").forEach((el) => {
        el.addEventListener("change", () => {
            bg.setSettings({ [el.dataset.type]: el.checked });
            updateTypeLabel();
        });
    });

    // 범위 (선택 즉시 닫힘)
    document.querySelectorAll('input[name="f"]').forEach((el) => {
        el.addEventListener("change", () => {
            filter = el.value;
            document.getElementById("filterLabel").textContent = FILTER_NAMES[filter];
            closeMenus();
            refresh(true);
        });
    });

    // 다운로드 — 메뉴에서 일반/지능형 선택 시 실행
    document.getElementById("zipNormal").addEventListener("click", () => {
        closeMenus();
        runZip("normal");
    });
    document.getElementById("zipSmart").addEventListener("click", () => {
        closeMenus();
        runZip("smart");
    });

    document.getElementById("clear").addEventListener("click", () => {
        bg.clearAll();
        refresh(false);
    });
    document.getElementById("toastOk").addEventListener("click", () => {
        document.getElementById("toast").classList.remove("show");
    });
    refresh(false);
    setInterval(() => refresh(false), 1000); // 변경 감지만 — 실제 재렌더는 리비전이 바뀔 때만
}

init();
