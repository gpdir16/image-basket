(() => {
    // 이미 열린 탭에 재주입해도 리스너와 관찰자를 중복 등록하지 않는다.
    if (globalThis.imageBasketScanner) return;
    globalThis.imageBasketScanner = true;

    function scanPage() {
        const records = [];
        let index = 0;
        function visit(root) {
            for (const el of root.querySelectorAll("*")) {
                if (el.shadowRoot) visit(el.shadowRoot);
                const rect = el.getBoundingClientRect();
                if (!rect.width || !rect.height) continue;
                const style = getComputedStyle(el);
                if (style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") continue;
                const urls = [];
                let width = 0;
                let height = 0;
                if (el.localName === "img") {
                    // srcset/picture에서는 브라우저가 실제 선택한 리소스만 사용한다.
                    urls.push(el.currentSrc || el.src);
                    width = el.naturalWidth;
                    height = el.naturalHeight;
                } else if (el.localName === "video" || el.localName === "audio") {
                    urls.push(el.currentSrc || el.src);
                    if (el.poster) urls.push(el.poster);
                } else if (el.localName === "image") {
                    urls.push(el.href?.baseVal);
                }
                for (const match of style.backgroundImage.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)) {
                    urls.push(match[1] || match[2] || match[3]);
                }
                const record = {
                    urls: urls.filter(Boolean).map((url) => {
                        try { return new URL(url, document.baseURI).href; } catch (e) { return ""; }
                    }).filter(Boolean),
                    width,
                    height,
                    top: rect.top + scrollY,
                    left: rect.left + scrollX,
                    index: index++,
                };
                if (el.localName === "iframe" || el.localName === "frame") record.frameUrl = el.src || "about:blank";
                if (record.urls.length || record.frameUrl) records.push(record);
            }
        }
        visit(document);
        // DOM 순서가 아니라 CSS 배치를 기준으로 읽고, 같은 위치에서는 DOM 순서를 유지한다.
        records.sort((a, b) => a.top - b.top || a.left - b.left || a.index - b.index);
        return { url: location.href, records };
    }

    browser.runtime.onMessage.addListener((message) => {
        if (message.type === "scanPage") return Promise.resolve(scanPage());
    });
    let timer;
    function changed() {
        clearTimeout(timer);
        timer = setTimeout(() => {
            browser.runtime.sendMessage({ type: "pageChanged" }).catch(() => {});
        }, 150);
    }
    new MutationObserver(changed).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "sizes", "style", "class", "hidden"],
    });
    document.addEventListener("load", changed, true);
    addEventListener("resize", changed);
})();
