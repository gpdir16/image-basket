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

const items = new Map(); // 탭·페이지 세션·URL -> item (확장 재시작 시 소실)
const inflight = new Map(); // requestId -> 캡처 중 entry
const pendingUrls = new Set(); // 같은 페이지에서 진행 중인 중복 요청 방지
const downloadToItem = new Map();
const zipDownloads = new Map(); // downloadId -> zip blob url (완료 후 revoke)
let seq = 0;
let requestSeq = 0;
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

// 짧은 변이 작은 아이콘은 제외하되 긴 세로 만화와 서로 다른 크기의 본문은 유지.
const SMART_MIN_DIM = 320;

function smartPick(items) {
    return items.filter(
        (it) =>
            it.type === "image" &&
            Number.isFinite(it.width) &&
            Number.isFinite(it.height) &&
            Math.min(it.width, it.height) >= SMART_MIN_DIM,
    );
}

// ---------- 미디어 및 파일명 ----------

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

// 실제 내비게이션만 새 페이지로 구분하며 SPA의 URL 변경은 같은 문서로 유지한다.
function filterItems(items, filter, tab, pageId) {
    if (filter === "all") return items;
    if (!tab) return [];
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
    return p ? p.id : 0;
}
function trackPages() {
    browser.webNavigation.onCommitted.addListener((d) => {
        if (d.frameId !== 0) return;
        const p = pageIds.get(d.tabId) || { id: 0 };
        p.id += 1; // 새 문서 — 새 세션
        p.url = d.url;
        pageIds.set(d.tabId, p);
        bump();
    });
    // SPA: pushState/replaceState/해시 변경 — 같은 문서. 세션 유지, URL만 갱신.
    browser.webNavigation.onHistoryStateUpdated.addListener((d) => {
        if (d.frameId !== 0) return;
        const p = pageIds.get(d.tabId) || { id: 0 };
        p.url = d.url;
        pageIds.set(d.tabId, p);
        bump();
    });
    browser.runtime.onMessage.addListener((message) => {
        if (message.type === "pageChanged") bump();
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

function captureKey(tabId, pageId, url) {
    return JSON.stringify([tabId, pageId, url]);
}

function normalizedUrl(url) {
    try {
        const parsed = new URL(url);
        parsed.hash = "";
        return parsed.href;
    } catch (e) {
        return url;
    }
}

async function scanTab(tabId) {
    let frames;
    try {
        frames = await browser.webNavigation.getAllFrames({ tabId });
    } catch (e) {
        return null; // 브라우저 내부 페이지처럼 스크립트 접근이 불가능한 경우
    }
    if (!frames?.length) return null;
    const reports = new Map();
    await Promise.all(frames.map(async (frame) => {
        try {
            let report;
            try {
                report = await browser.tabs.sendMessage(tabId, { type: "scanPage" }, { frameId: frame.frameId });
            } catch (e) {
                // 확장 설치 전에 열려 있던 문서에도 동일한 스캐너를 적용한다.
                await browser.tabs.executeScript(tabId, { file: "content.js", frameId: frame.frameId });
                report = await browser.tabs.sendMessage(tabId, { type: "scanPage" }, { frameId: frame.frameId });
            }
            if (report?.records) reports.set(frame.frameId, report);
        } catch (e) {}
    }));
    if (!reports.has(0)) return null;
    const result = [];
    const visited = new Set();
    function append(frameId) {
        if (visited.has(frameId)) return;
        visited.add(frameId);
        const report = reports.get(frameId);
        if (!report) return;
        for (const record of report.records) {
            if (record.urls.length) result.push(record);
            if (!record.frameUrl) continue;
            const child = frames.find((frame) =>
                frame.parentFrameId === frameId && !visited.has(frame.frameId) &&
                normalizedUrl(reports.get(frame.frameId)?.url || frame.url) === normalizedUrl(record.frameUrl));
            if (child) append(child.frameId);
        }
    }
    append(0);
    return result;
}

async function updatePageOrder(tabId) {
    const pageId = pageIdFor(tabId);
    const records = await scanTab(tabId);
    if (!records || pageId !== pageIdFor(tabId)) return;
    const positions = new Map();
    for (const record of records) {
        for (const url of record.urls) {
            const key = normalizedUrl(url);
            if (!positions.has(key)) positions.set(key, { order: positions.size, ...record });
        }
    }
    // 같은 리소스가 다른 페이지의 캐시에서 재사용되더라도 현재 페이지에 따로 표시한다.
    const reusable = new Map();
    for (const it of items.values()) {
        if (it.blob) reusable.set(normalizedUrl(it.url), it);
    }
    for (const [url, position] of positions) {
        const original = reusable.get(url);
        if (!original || !settings[original.type]) continue;
        const key = captureKey(tabId, pageId, original.url);
        if (!items.has(key)) {
            items.set(key, {
                ...original, id: ++seq, key, tabId, pageId,
                pageUrl: pageIds.get(tabId)?.url || null,
                blobUrl: URL.createObjectURL(original.blob), status: "ready",
                capturedAt: Date.now(), pageOrder: position.order,
            });
            bump();
        }
    }
    for (const it of items.values()) {
        if (it.tabId !== tabId || it.pageId !== pageId) continue;
        const position = positions.get(normalizedUrl(it.url));
        it.pageOrder = position?.order ?? Number.MAX_SAFE_INTEGER;
        if (position?.width && position?.height) {
            it.width = position.width;
            it.height = position.height;
        }
    }
    evict();
    updateBadge();
}

async function getItems(filter, tab) {
    if (!tab) tab = await resolveTab();
    const tabIds = filter === "all" ? [...new Set([...items.values()].map((it) => it.tabId))] : tab ? [tab.id] : [];
    await Promise.all(tabIds.filter((id) => id >= 0).map(updatePageOrder));
    const all = [...items.values()].sort((a, b) =>
        a.tabId - b.tabId || a.pageId - b.pageId ||
        (a.pageOrder ?? Number.MAX_SAFE_INTEGER) - (b.pageOrder ?? Number.MAX_SAFE_INTEGER) ||
        (a.requestOrder ?? a.id) - (b.requestOrder ?? b.id));
    const list = filterItems(all, filter, tab, pageIdFor(tab?.id));
    const digits = Math.max(4, String(list.length).length);
    list.forEach((it, index) => {
        it.downloadFilename = `${String(index + 1).padStart(digits, "0")}-${it.filename}`;
    });
    return list;
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
    items.delete(item.key || captureKey(item.tabId, item.pageId, item.url));
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
    if (total <= MAX_TOTAL) {
        updateBadge();
        return;
    }
    for (const it of order) {
        if (it.status !== "saved" && it.status !== "saving") {
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
        key: entry.key,
        requestOrder: entry.requestOrder,
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
    items.set(entry.key, item);
    bump();
    evict();
    updateBadge();
}

// 256MB 초과로 캡처를 중단한 항목도 목록에 표시 (조용히 사라지지 않게)
function addTooBigItem(entry) {
    const item = {
        id: ++seq,
        key: entry.key,
        requestOrder: entry.requestOrder,
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
    items.set(entry.key, item);
    bump();
    updateBadge();
}

async function saveItem(id, filename) {
    const item = findItem(id);
    if (!canDownload(item)) return false;
    const name = filename || item.downloadFilename || item.filename;
    const operation = lockDownloads([item]);
    try {
        if (!item.blobUrl) item.blobUrl = URL.createObjectURL(item.blob);
        operation.url = item.blobUrl;
        await startDownload({ url: operation.url, filename: name }, operation, downloadToItem);
        return true;
    } catch (e) {
        finishDownload(operation, false);
        return false;
    }
}

function clearAll() {
    for (const it of [...items.values()]) {
        if (it.status !== "saving") drop(it);
    }
    updateBadge();
}

// ---------- 다운로드 상태 및 ZIP 저장 ----------

const ZIP_MAX_ENTRIES = 65000; // ZIP64 미지원: 기존 상한을 넘으면 명시적으로 실패.
const earlyDownloadStates = new Map();
let startingDownloads = 0;

function canDownload(item) {
    return item && item.blob && (item.status === "ready" || item.status === "saved");
}

function lockDownloads(list) {
    const operation = { items: [], previousStatuses: new Map(), url: null, finished: false };
    for (const item of list) {
        if (!canDownload(item)) continue;
        operation.items.push(item);
        operation.previousStatuses.set(item, item.status);
        item.status = "saving";
    }
    if (operation.items.length) {
        bump();
        updateBadge();
    }
    return operation;
}

function finishDownload(operation, complete) {
    if (operation.finished) return;
    operation.finished = true;
    for (const item of operation.items) {
        item.status = complete ? "saved" : operation.previousStatuses.get(item);
        if (item.blobUrl && (complete || item.blobUrl === operation.url)) {
            if (item.blobUrl !== operation.url) URL.revokeObjectURL(item.blobUrl);
            item.blobUrl = null;
        }
    }
    if (operation.url) {
        URL.revokeObjectURL(operation.url);
        operation.url = null;
    }
    if (operation.items.length) {
        bump();
        updateBadge();
    }
}

async function startDownload(options, operation, registry) {
    // onChanged가 download()의 Promise보다 먼저 완료되어도 상태를 잃지 않는다.
    startingDownloads++;
    try {
        const id = await browser.downloads.download(options);
        registry.set(id, operation);
        const state = earlyDownloadStates.get(id);
        if (state) {
            earlyDownloadStates.delete(id);
            registry.delete(id);
            finishDownload(operation, state === "complete");
        }
        return id;
    } finally {
        startingDownloads--;
        if (!startingDownloads) earlyDownloadStates.clear();
    }
}

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function downloadZip(entries, base, selected, operation = lockDownloads(selected)) {
    try {
        if (entries.length > ZIP_MAX_ENTRIES) {
            throw new Error(`ZIP 항목 수가 ${ZIP_MAX_ENTRIES}개를 초과했습니다.`);
        }
        const blob = await buildZip(entries);
        operation.url = URL.createObjectURL(blob);
        await startDownload({ url: operation.url, filename: `${base}-${stamp()}.zip` }, operation, zipDownloads);
        return entries.length;
    } catch (e) {
        finishDownload(operation, false);
        throw e;
    }
}

// 생성 시작부터 잠가 중복 저장을 막으며 저장 완료 항목도 다시 저장할 수 있다.
async function zipAll(list) {
    const operation = lockDownloads(list);
    if (!operation.items.length) return 0;
    const entries = operation.items.map((it) => ({ name: it.downloadFilename || it.filename, blob: it.blob }));
    return downloadZip(entries, "image-basket", operation.items, operation);
}

async function decodeDims(blob) {
    try {
        const bmp = await createImageBitmap(blob);
        try {
            if (bmp.width > 0 && bmp.height > 0) return { width: bmp.width, height: bmp.height };
        } finally {
            bmp.close();
        }
    } catch (e) {
        // Firefox에서 SVG 등은 ImageBitmap이 실패해도 Image로 읽을 수 있다.
    }
    let url;
    let image;
    try {
        url = URL.createObjectURL(blob);
        image = new Image();
        return await new Promise((resolve) => {
            image.onload = () => {
                const width = image.naturalWidth;
                const height = image.naturalHeight;
                resolve(width > 0 && height > 0 ? { width, height } : null);
            };
            image.onerror = () => resolve(null);
            image.src = url;
        });
    } catch (e) {
        return null;
    } finally {
        if (image) image.onload = image.onerror = null;
        if (url) URL.revokeObjectURL(url);
    }
}

async function smartZip(list) {
    const candidates = list.filter((it) => canDownload(it) && it.type === "image");
    const filenames = new Map(candidates.map((it) => [it, it.downloadFilename || it.filename]));
    const operation = lockDownloads(candidates);
    if (!operation.items.length) return 0;
    try {
        for (const item of operation.items) {
            if (!(item.width > 0 && item.height > 0)) {
                const dims = await decodeDims(item.blob);
                if (dims) Object.assign(item, dims); // 복사본이 아닌 원본에 캐시.
            }
        }
        const picked = smartPick(operation.items);
        const chosen = new Set(picked);
        for (const item of operation.items) {
            if (!chosen.has(item)) {
                item.status = operation.previousStatuses.get(item);
                operation.previousStatuses.delete(item);
            }
        }
        operation.items = picked;
        bump();
        updateBadge();
        if (!picked.length) return 0;
        return await downloadZip(
            picked.map((it) => ({ name: filenames.get(it), blob: it.blob })),
            "image-basket-smart",
            picked,
            operation,
        );
    } catch (e) {
        finishDownload(operation, false);
        throw e;
    }
}

// ---------- 캡처 (브라우저 전용) ----------

function cleanup(entry) {
    inflight.delete(entry.requestId);
    pendingUrls.delete(entry.key);
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
            const key = captureKey(details.tabId, pageIdFor(details.tabId), details.url);
            if (items.has(key) || pendingUrls.has(key)) return;
            let filter;
            try {
                filter = browser.webRequest.filterResponseData(details.requestId);
            } catch (e) {
                return;
            }
            pendingUrls.add(key);
            const entry = {
                requestId: details.requestId,
                key,
                requestOrder: ++requestSeq,
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
                    } else entry.chunks.push(new Uint8Array(e.data)); // 응답 버퍼를 보관해 완료 시 Blob으로 묶는다.
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

    // 헤더 판별이 본문보다 먼저 끝나도록 대기시킨다. StreamFilter 본문은 압축 해제되어 전달된다.
    browser.webRequest.onHeadersReceived.addListener(
        (details) => {
            const entry = inflight.get(details.requestId);
            if (!entry) return;
            const ct = (getHeader(details.responseHeaders, "content-type") || "").split(";")[0].trim().toLowerCase();
            const type = mediaType(ct);
            const ok = details.statusCode === 200 && type && settings[type];
            if (!ok) {
                entry.dead = true;
                cleanup(entry);
                try {
                    entry.filter.disconnect();
                } catch (e) {}
                return;
            }
            entry.type = type;
            entry.contentType = ct;
            entry.host = new URL(details.url).host;
            entry.filename = pickFilename(details.responseHeaders, details.url, entry.contentType, type);
        },
        { urls: ["<all_urls>"] },
        ["blocking", "responseHeaders"],
    );

    browser.downloads.onChanged.addListener((delta) => {
        const state = delta.state && delta.state.current;
        if (state !== "complete" && state !== "interrupted") return;
        const registry = zipDownloads.has(delta.id) ? zipDownloads : downloadToItem;
        const operation = registry.get(delta.id);
        if (operation) {
            registry.delete(delta.id);
            finishDownload(operation, state === "complete");
        } else if (startingDownloads) {
            earlyDownloadStates.set(delta.id, state);
        }
    });
}

if (typeof browser !== "undefined") main(); // 브라우저에서만 캡처 시작 (node require 방지)
