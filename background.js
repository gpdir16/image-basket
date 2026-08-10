const MAX_ITEM = 256 * 1024 * 1024; // 단일 항목 상한: 초과 시 캡처 중단 ("256MB 초과" 표시)
const MAX_TOTAL = 512 * 1024 * 1024; // 보관 총량 상한: 초과 시 저장된 항목부터 오래된 순으로 제거

const EXT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/x-icon": ".ico",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/webm": ".weba",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/flac": ".flac",
    "audio/aac": ".aac",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/ogg": ".ogv",
    "video/quicktime": ".mov",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
    "video/mpeg": ".mpg",
};

const items = new Map(); // url -> item (메모리 보관: 확장 재시작 시 소실)
const inflight = new Map(); // requestId -> 캡처 중 entry
const pendingUrls = new Set(); // 중복 캡처 방지 (진행 중 요청)
const downloadToItem = new Map();
const zipDownloads = new Map(); // downloadId -> zip blob url (완료 후 revoke)
let seq = 0;
let revision = 0; // items 상태 변경 카운터 — popup이 변경 시에만 재렌더 (깜빡임 방지)
let settings = { image: true, video: true, audio: true };
const SETTINGS_VERSION = 2; // 스키마 버전 — 불일치(구버전 잔재) 시 저장된 설정을 버리고 기본값 사용

// 저장된 설정 검증: 버전이 맞을 때만 병합, 아니면 기본값(모두 켜짐)
function loadSettings(stored, version) {
    return stored && version === SETTINGS_VERSION ? { ...settings, ...stored } : { ...settings };
}

function bump() {
    revision++;
}
function getRevision() {
    return revision;
}

// 지능형 선별 기준 (필요하면 조정)
const SMART_MIN_DIM = 320; // 짧은 변 최소 px — 프로필사진/썸네일/아이콘 제외
const SMART_MAX_RATIO = 5; // 최대 종횡비 — 가로/세로 배너 제외
const SMART_CLUSTER_MIN = 3; // 같은 크기 그룹 최소 수 — 만화 페이지 등 감지

// 순수 함수: 지능형 선별 (test.js에서 검증)
function smartPick(items) {
    const filtered = items.filter(
        (it) =>
            it.type === "image" &&
            it.width &&
            it.height &&
            Math.min(it.width, it.height) >= SMART_MIN_DIM &&
            Math.max(it.width, it.height) / Math.min(it.width, it.height) <= SMART_MAX_RATIO,
    );
    if (!filtered.length) return [];
    // 같은 크기(10px 단위) 클러스터: 만화 페이지처럼 동일 치수 이미지 묶음이 있으면 그것만
    const groups = new Map();
    for (const it of filtered) {
        const k = `${Math.round(it.width / 10) * 10}x${Math.round(it.height / 10) * 10}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(it);
    }
    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    return best.length >= SMART_CLUSTER_MIN ? best : filtered;
}

// ---------- 순수 함수 (test.js에서 검증) ----------

function mediaType(ct) {
    const m = /^(image|video|audio)\//.exec(ct || "");
    return m ? m[1] : null;
}

function getHeader(headers, name) {
    const h = (headers || []).find((x) => x.name.toLowerCase() === name);
    return h ? h.value : null;
}

function pickFilename(headers, url, ct, type) {
    let name = "";
    const cd = getHeader(headers, "content-disposition");
    if (cd) {
        const m = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd);
        if (m) {
            const raw = m[1].trim();
            try {
                name = decodeURIComponent(raw);
            } catch (e) {
                name = raw;
            }
        }
    }
    if (!name) {
        try {
            name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
        } catch (e) {}
    }
    if (!name || name === "/") name = type + "-" + new Date().toISOString().replace(/[:.]/g, "-");
    name = name
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
        .trim()
        .slice(0, 160);
    const ext = EXT[ct] || "";
    if (ext && !/\.[a-z0-9]{1,5}$/i.test(name)) name += ext;
    return name;
}

function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
}

// ---------- 상태 API (popup에서 호출) ----------

function getSettings() {
    return { ...settings };
}
function setSettings(s) {
    settings = { ...settings, ...s };
    browser.storage.local.set({ settings, settingsVersion: SETTINGS_VERSION });
}

// 항목 필터: page = 현재 탭의 현재 페이지(해시 무시), tab = 현재 탭, all = 전체
// 항목 필터: page = 현재 탭의 현재 페이지 세션(SPA pushState는 같은 세션), tab = 현재 탭, all = 전체
// pageId = webNavigation으로 추적한 문서 세션 id — URL 비교 대신 이걸로 판별 (SPA에서 URL이 변해도 유지)
function filterItems(items, filter, tab, pageId) {
    if (!tab || filter === "all") return items;
    if (filter === "tab") return items.filter((it) => it.tabId === tab.id);
    if (pageId == null) {
        // 세션 추적 전(경계) — URL 비교로 폴백
        const url = (tab.url || "").split("#")[0];
        return items.filter((it) => it.tabId === tab.id && it.pageUrl && it.pageUrl.split("#")[0] === url);
    }
    return items.filter((it) => it.tabId === tab.id && it.pageId === pageId);
}

let activeTab = null; // 활성 탭 추적 — 필터 기준. 이벤트로 계속 갱신 (팝업이 직접 물어보지 않아도 됨)

// 탭별 페이지 세션 id — webNavigation으로 추적. SPA(pushState)는 같은 문서 세션을 유지하고,
// 실제 내비게이션(커밋)만 새 세션을 시작한다. '이 페이지' 필터는 URL 비교 대신 이 id로 판별.
const pageIds = new Map(); // tabId -> { id, url }
function pageIdFor(tabId) {
    const p = pageIds.get(tabId);
    return p ? p.id : null;
}
function trackPages() {
    browser.webNavigation.onCommitted.addListener((d) => {
        if (d.frameId !== 0) return;
        const p = pageIds.get(d.tabId) || { id: 0 };
        p.id += 1; // 새 문서 — 새 세션
        p.url = d.url;
        pageIds.set(d.tabId, p);
    });
    // SPA: pushState/replaceState/해시 변경 — 같은 문서. 세션 유지, URL만 갱신.
    browser.webNavigation.onHistoryStateUpdated.addListener((d) => {
        if (d.frameId !== 0) return;
        const p = pageIds.get(d.tabId) || { id: 0 };
        p.id += 1;
        p.url = d.url;
        pageIds.set(d.tabId, p);
    });
    browser.tabs.onRemoved.addListener((tabId) => pageIds.delete(tabId));
}

async function resolveTab() {
    if (activeTab) return activeTab;
    try {
        const [t] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
        return t || null;
    } catch (e) {
        return null;
    }
}

async function getItems(filter, tab) {
    const all = [...items.values()].sort((a, b) => b.capturedAt - a.capturedAt);
    if (filter === "all") return all;
    if (!tab) tab = await resolveTab();
    return filterItems(all, filter, tab, pageIdFor(tab && tab.id));
}

// 필터별 개수 — popup 버튼에 표시 (캡처 유무가 즉시 보이게)
async function getCounts() {
    const all = [...items.values()];
    const tab = await resolveTab();
    return {
        all: all.length,
        tab: filterItems(all, "tab", tab, pageIdFor(tab && tab.id)).length,
        page: filterItems(all, "page", tab, pageIdFor(tab && tab.id)).length,
    };
}

function trackActiveTab() {
    browser.tabs.onActivated.addListener((info) => {
        browser.tabs.get(info.tabId).then(
            (t) => {
                activeTab = t;
                bump();
            },
            () => {},
        );
    });
    browser.tabs.onUpdated.addListener((id, change, t) => {
        if (activeTab && activeTab.id === id && change.url) {
            activeTab.url = t.url;
            bump();
        }
    });
    browser.windows.onFocusChanged.addListener((wid) => {
        if (wid === browser.windows.WINDOW_ID_NONE) return;
        browser.tabs.query({ active: true, windowId: wid }).then(
            ([t]) => {
                if (t) {
                    activeTab = t;
                    bump();
                }
            },
            () => {},
        );
    });
}
function findItem(id) {
    for (const it of items.values()) if (it.id === id) return it;
    return null;
}

function updateBadge() {
    const n = [...items.values()].filter((it) => it.status === "ready").length;
    browser.browserAction.setBadgeText({ text: n ? String(n) : "" });
}

function drop(item) {
    if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
    items.delete(item.url);
    bump();
}

function evict() {
    let total = 0;
    for (const it of items.values()) total += it.size;
    if (total <= MAX_TOTAL) return;
    const order = [...items.values()].sort((a, b) => a.capturedAt - b.capturedAt);
    for (const it of order) {
        if (it.status === "saved") {
            drop(it);
            total -= it.size;
            if (total <= MAX_TOTAL) break;
        }
    }
    for (const it of order) {
        if (it.status !== "saved") {
            drop(it);
            total -= it.size;
            if (total <= MAX_TOTAL) break;
        }
    }
    updateBadge();
}

function finalize(entry) {
    const blob = new Blob(entry.chunks, { type: entry.contentType });
    entry.chunks = null;
    if (!blob.size) return;
    const item = {
        id: ++seq,
        url: entry.url,
        host: entry.host,
        filename: entry.filename,
        size: blob.size,
        type: entry.type,
        blob,
        blobUrl: URL.createObjectURL(blob),
        status: "ready",
        capturedAt: Date.now(),
        tabId: entry.tabId,
        pageUrl: entry.pageUrl,
        pageId: entry.pageId,
    };
    items.set(entry.url, item);
    bump();
    evict();
    updateBadge();
}

// 256MB 초과로 캡처를 중단한 항목도 목록에 표시 (조용히 사라지지 않게)
function addTooBigItem(entry) {
    const item = {
        id: ++seq,
        url: entry.url,
        host: entry.host,
        filename: entry.filename,
        size: entry.size,
        type: entry.type,
        blob: null,
        blobUrl: null,
        status: "tooBig",
        capturedAt: Date.now(),
        tabId: entry.tabId,
        pageUrl: entry.pageUrl,
        pageId: entry.pageId,
    };
    items.set(entry.url, item);
    bump();
    updateBadge();
}

async function saveItem(id) {
    const item = findItem(id);
    if (!item || item.status !== "ready") return false;
    if (!item.blobUrl && item.blob) item.blobUrl = URL.createObjectURL(item.blob);
    item.status = "saving";
    bump();
    updateBadge();
    try {
        const dlId = await browser.downloads.download({ url: item.blobUrl, filename: item.filename });
        downloadToItem.set(dlId, item);
        return true;
    } catch (e) {
        item.status = "ready";
        bump();
        updateBadge();
        return false;
    }
}

function clearAll() {
    for (const it of [...items.values()]) drop(it);
    updateBadge();
}

// ---------- ZIP 저장 ----------

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function downloadZip(entries, base, items) {
    const limited = entries.slice(0, 65000); // EOCD 항목 수가 16비트 — 초과 시 ZIP 손상 방지
    const blob = await buildZip(limited);
    const url = URL.createObjectURL(blob);
    const dlId = await browser.downloads.download({ url, filename: `${base}-${stamp()}.zip` });
    zipDownloads.set(dlId, { url, items });
    return limited.length;
}

// 저장 대기 중인 전체 항목을 ZIP 하나로 (list = 필터 적용된 항목)
async function zipAll(list) {
    const ready = list.filter((it) => it.status === "ready" && it.blob);
    if (!ready.length) return 0;
    return downloadZip(
        ready.map((it) => ({ name: it.filename, blob: it.blob })),
        "image-basket",
        ready,
    );
}

// 지능형 선별: 이미지만 대상 — 작은 이미지(프로필/썸네일)·배너 제외, 같은 크기 묶음(만화) 우선
async function decodeDims(blob) {
    try {
        const bmp = await createImageBitmap(blob);
        const d = { width: bmp.width, height: bmp.height };
        bmp.close();
        return d;
    } catch (e) {
        return null;
    } // SVG 등 디코딩 불가 → 선별 제외
}

async function smartZip(list) {
    const ready = list.filter((it) => it.status === "ready" && it.blob && it.type === "image");
    const withDims = [];
    for (const it of ready) {
        const d = await decodeDims(it.blob);
        if (d) withDims.push({ ...it, ...d });
    }
    const picked = smartPick(withDims);
    if (!picked.length) return 0;
    return downloadZip(
        picked.map((it) => ({ name: it.filename, blob: it.blob })),
        "image-basket-smart",
        picked,
    );
}

// ---------- 캡처 (브라우저 전용) ----------

function cleanup(entry) {
    inflight.delete(entry.requestId);
    pendingUrls.delete(entry.url);
}

function main() {
    trackActiveTab();
    trackPages();
    browser.storage.local.get(["settings", "settingsVersion"]).then((s) => {
        settings = loadSettings(s.settings, s.settingsVersion);
        if (s.settings && s.settingsVersion !== SETTINGS_VERSION) {
            browser.storage.local.set({ settings, settingsVersion: SETTINGS_VERSION }); // 구버전 잔재 정리
        }
    });

    // 모든 http(s) 요청에 필터를 붙이고, 응답 헤더 확인 후 미디어가 아니면 즉시 disconnect.
    // ponytail: 요청마다 필터 객체 생성 오버헤드 있음 — 헤더 판별이 본문 도착 전에 끝나므로
    // 본문 데이터는 비대상 요청에 대해 필터를 거치지 않는다.
    browser.webRequest.onBeforeRequest.addListener(
        (details) => {
            if (details.type === "main_frame" || details.type === "sub_frame") return;
            if (!/^https?:/i.test(details.url)) return;
            if (/\/favicon\.ico$/i.test(details.url)) return; // 사이트 아이콘 노이즈 제외
            if (items.has(details.url) || pendingUrls.has(details.url)) return;
            let filter;
            try {
                filter = browser.webRequest.filterResponseData(details.requestId);
            } catch (e) {
                return;
            }
            pendingUrls.add(details.url);
            const entry = {
                requestId: details.requestId,
                url: details.url,
                tabId: details.tabId,
                pageUrl: details.documentUrl || null,
                pageId: pageIdFor(details.tabId),
                filter,
                chunks: [],
                size: 0,
                tooBig: false,
                dead: false,
            };
            inflight.set(details.requestId, entry);
            filter.ondata = (e) => {
                if (!entry.dead) {
                    entry.size += e.data.byteLength;
                    if (entry.size > MAX_ITEM) {
                        entry.tooBig = true;
                        entry.chunks = [];
                    } else entry.chunks.push(new Uint8Array(e.data)); // 복사본 저장 — write()가 버퍼를 재사용/파괴해도 안전
                }
                filter.write(e.data); // 원본 흐름은 그대로 통과 — 페이지 로딩에 영향 없음
            };
            filter.onstop = () => {
                try {
                    if (!entry.dead && entry.type) {
                        if (entry.tooBig) addTooBigItem(entry);
                        else finalize(entry);
                    }
                } finally {
                    // finalize가 던져도 반드시 close — 안 닫으면 페이지 요청이 영구 정지됨
                    cleanup(entry);
                    try {
                        filter.close();
                    } catch (e) {}
                }
            };
            filter.onerror = () => {
                cleanup(entry);
                try {
                    filter.disconnect();
                } catch (e) {}
            };
        },
        { urls: ["<all_urls>"] },
        ["blocking"],
    );

    // 미디어 판별: 200 OK + Content-Type + 타입 토글 + 인코딩 없음(압축본은 그대로 저장하면 깨짐)
    browser.webRequest.onHeadersReceived.addListener(
        (details) => {
            const entry = inflight.get(details.requestId);
            if (!entry) return;
            const ct = getHeader(details.responseHeaders, "content-type");
            const type = mediaType(ct);
            const ok = details.statusCode === 200 && type && settings[type] && !getHeader(details.responseHeaders, "content-encoding");
            if (!ok) {
                entry.dead = true;
                cleanup(entry);
                try {
                    entry.filter.disconnect();
                } catch (e) {}
                return;
            }
            entry.type = type;
            entry.contentType = ct.split(";")[0].trim();
            entry.host = new URL(details.url).host;
            entry.filename = pickFilename(details.responseHeaders, details.url, entry.contentType, type);
        },
        { urls: ["<all_urls>"] },
        ["responseHeaders"],
    );

    browser.downloads.onChanged.addListener((delta) => {
        if (zipDownloads.has(delta.id)) {
            const z = zipDownloads.get(delta.id);
            if (delta.state && delta.state.current === "complete") {
                URL.revokeObjectURL(z.url);
                zipDownloads.delete(delta.id);
                // ZIP에 담긴 항목은 저장 완료 처리 — 중복 ZIP 방지 (blob은 미리보기/재저장용으로 유지)
                for (const it of z.items) {
                    it.status = "saved";
                    if (it.blobUrl) {
                        URL.revokeObjectURL(it.blobUrl);
                        it.blobUrl = null;
                    }
                }
                bump();
                updateBadge();
            } else if (delta.state && delta.state.current === "interrupted") {
                URL.revokeObjectURL(z.url);
                zipDownloads.delete(delta.id); // 항목은 ready 유지 — 재시도 가능
            }
            return;
        }
        const item = downloadToItem.get(delta.id);
        if (!item) return;
        if (delta.state && delta.state.current === "complete") {
            downloadToItem.delete(delta.id);
            URL.revokeObjectURL(item.blobUrl); // 파일은 이미 디스크에 있음 — URL만 해제
            item.blobUrl = null;
            item.status = "saved";
            bump();
            updateBadge();
        } else if (delta.state && delta.state.current === "interrupted") {
            downloadToItem.delete(delta.id);
            item.status = "ready"; // 재시도 가능
            bump();
            updateBadge();
        }
    });
}

if (typeof browser !== "undefined") main(); // 브라우저에서만 캡처 시작 (node require 방지)
