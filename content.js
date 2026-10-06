(() => {
    const DEFAULT_CONFIG = { minTop: 60, maxTop: 220 };
    const TOLERANCE = 20; // Absorbs subpixel rendering and smooth-scroll offsets
    let siteConfig = { ...DEFAULT_CONFIG, exclusions: [] };
    let isBlacklisted = false;
    let isPickerActive = false;
    let shadowHost = null;

    // --- Dynamic Scroll Container Resolver ---
    function getScrollContainer() {
        const readerRoot = document.getElementById('reader-root');
        if (readerRoot && readerRoot.scrollHeight > readerRoot.clientHeight) {
            return readerRoot;
        }
        return window;
    }

    // --- Blacklist & Config Loader ---
    function isUrlMatched(url, pattern) {
        const regexStr = '^' + pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*') + '$';
        try {
            return new RegExp(regexStr).test(url);
        } catch {
            return false;
        }
    }

    async function loadConfig() {
        const hostname = window.location.hostname;
        const currentUrl = window.location.href;
        const data = await browser.storage.local.get(['blacklist', 'defaults', 'sites']);

        const blacklist = data.blacklist || [];
        isBlacklisted = blacklist.some(pattern => isUrlMatched(currentUrl, pattern));
        if (isBlacklisted) return;

        const defaults = data.defaults || DEFAULT_CONFIG;
        const siteSettings = (data.sites && data.sites[hostname]) || {};

        siteConfig = {
            minTop: siteSettings.minTop ?? defaults.minTop,
            maxTop: siteSettings.maxTop ?? defaults.maxTop,
            exclusions: siteSettings.exclusions || []
        };
    }

    loadConfig();

    browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') loadConfig();
    });

    function genericFilter(el) {
        const rect = el.getBoundingClientRect();
        if (rect.height === 0 || rect.width === 0) {
            return false;
        }

        if (el.closest('nav, header, footer, aside, [class*="nav" i], [class*="menu" i]')) {
            return false;
        }

        // for (const excluded of excludedNodes) {
        //     if (excluded === el || excluded.contains(el)) return false;
        // }

        return true;
    }

    // --- Target Element Collector ---
    function getCandidateElements() {
        const readerRoot = document.getElementById('reader-root');

        // const excludedNodes = [];
        // for (const sel of siteConfig.exclusions) {
        //     try {
        //         document.querySelectorAll(sel).forEach(node => excludedNodes.push(node));
        //     } catch (err) {
        //         console.warn('[Paragraph Scroller] Invalid exclusion selector:', sel);
        //     }
        // }

        // Reader View Active: Scope to title and article elements
        if (readerRoot) {
            const rawElements = Array.from(readerRoot.querySelectorAll(
                '#reader-title, #reader-content p, #reader-content h1, #reader-content h2, #reader-content h3, #reader-content h4, #reader-content h5, #reader-content h6, #reader-content blockquote, #reader-content li'
            ));

            return rawElements.filter(el => {
                const rect = el.getBoundingClientRect();
                if (rect.height === 0 || rect.width === 0) return false;
                if (el.innerText.trim().length === 0) return false;

                for (const excluded of excludedNodes) {
                    if (excluded === el || excluded.contains(el)) return false;
                }
                return true;
            });
        }

        // Standard Webpage Mode
        const contentEl = document.querySelector('article, #content, [id*="content" i]')
        const textElements = Array.from(contentEl.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, details'))
            .filter(genericFilter)
            .filter(el => el.innerText.trim().length !== 0)

        const mediaElements = Array.from(contentEl.querySelectorAll('div, svg, img'))
            .filter(genericFilter)
            .filter(el => {
                let textContained = false
                textElements.some(txtEl => {
                    if (el.contains(txtEl)) {
                        textContained = true
                        return true
                    }
                    return false
                })
                return !textContained
            })

        const len = mediaElements.length
        let filteredMediaEls = mediaElements.filter(el1 => {
            const descenCnt = mediaElements.reduce((descenCnt, el2) => {
                if (el1 === el2) return descenCnt
                if (el1.contains(el2)) return descenCnt + 1
                return descenCnt
            }, 0)
            console.log(descenCnt, el1)
            if (descenCnt > 19 || descenCnt / len > 0.5) return false
            return true
        })
        filteredMediaEls = filteredMediaEls.filter(el1 => {
            let isDescendent = false
            filteredMediaEls.some(el2 => {
                if (el1 === el2) return false
                if (el2.contains(el1)) {
                    isDescendent = true
                    return true
                }
                return false
            })
            return !isDescendent
        })
        return textElements.concat(filteredMediaEls)
    }


    // --- Active Element Resolver ---
    function getCurrentIndex(elements, minTop, direction) {
        const sign = direction === 1 ? 1 : -1
        // 1. Element aligned right at minTop (within subpixel tolerance)
        let bestIdx = -1;
        let bestDist = Infinity;
        for (let i = 0; i < elements.length; i++) {
            const top = elements[i].getBoundingClientRect().top;
            const dist = top - minTop

            if (dist * sign < 0) continue
            const Absdist = Math.abs(dist)
            if (Absdist < bestDist) {
                bestDist = Absdist;
                bestIdx = i;
            }
        }
        return bestIdx;
    }

    // --- Scrolling Engine ---
    function scrollToParagraph(direction) {
        const elements = getCandidateElements();
        if (elements.length === 0) return;

        const { minTop, maxTop } = siteConfig;
        const scrollContainer = getScrollContainer();
        const currentScroll = (scrollContainer === window)
            ? (window.scrollY || document.documentElement.scrollTop || 0)
            : scrollContainer.scrollTop;

        // const currentIdx = getCurrentIndex(elements, minTop, maxTop);
        let targetIdx = getCurrentIndex(elements, minTop, direction);
        if (targetIdx === -1) return
        let targetElement = elements[targetIdx]
        let delta = targetElement.getBoundingClientRect().top - minTop

        if (Math.abs(delta) <= 10) {
            if (direction === 1) {
                targetIdx = getCurrentIndex(elements, minTop + 10, direction);
            } else {
                targetIdx = getCurrentIndex(elements, minTop - 10, direction);
            }
            if (targetIdx === -1) return
            targetElement = elements[targetIdx]
            delta = targetElement.getBoundingClientRect().top - minTop
        }
        // console.log(targetElement)

        if (scrollContainer === window) {
            window.scrollBy({ top: delta, behavior: 'smooth' });
        } else {
            scrollContainer.scrollBy({ top: delta, behavior: 'smooth' });
        }
    }


    // --- Keyboard Shortcuts (Capture Phase) ---
    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;

        if (isBlacklisted || isPickerActive) return;
        const active = document.activeElement;
        const isTyping = active && (
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) ||
            active.isContentEditable
        );
        if (isTyping) return;

        // deal with the case where the page is so short that no scrolling happens

        if (e.code === 'KeyJ') {
            e.preventDefault();
            scrollToParagraph(1);
        } else if (e.code === 'KeyK') {
            e.preventDefault();
            scrollToParagraph(-1);
        }
    }, true);

    // --- Visual Threshold Bars (Isolated Shadow DOM) ---
    function toggleThresholdUI() {
        if (shadowHost) {
            shadowHost.remove();
            shadowHost = null;
            return;
        }

        shadowHost = document.createElement('div');
        shadowHost.id = 'para-scroller-ui-host';
        shadowHost.style.position = 'relative';
        shadowHost.style.zIndex = '2147483647';
        document.documentElement.appendChild(shadowHost);

        const shadow = shadowHost.attachShadow({ mode: 'closed' });
        const container = document.createElement('div');

        container.innerHTML = `
      <style>
        .guide-bar {
          position: fixed;
          left: 0;
          right: 0;
          height: 3px;
          z-index: 2147483647;
          user-select: none;
          display: flex;
          align-items: center;
          justify-content: flex-end;
          padding-right: 20px;
        }
        .bar-min { background-color: #2563eb; }
        .bar-max { background-color: #dc2626; }
        .handle {
          padding: 3px 8px;
          font-family: monospace;
          font-size: 11px;
          color: #fff;
          border-radius: 4px;
          cursor: ns-resize;
          box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        }
        .bar-min .handle { background-color: #2563eb; }
        .bar-max .handle { background-color: #dc2626; }
        .close-pill {
          position: fixed;
          bottom: 20px;
          right: 20px;
          background: #111827;
          color: #fff;
          font-family: sans-serif;
          font-size: 12px;
          padding: 8px 14px;
          border-radius: 9999px;
          cursor: pointer;
          z-index: 2147483647;
          box-shadow: 0 4px 6px rgba(0,0,0,0.3);
        }
      </style>
      <div id="minBar" class="guide-bar bar-min" style="top: ${siteConfig.minTop}px;">
        <span class="handle">Min: <span id="minVal">${siteConfig.minTop}</span>px (Drag)</span>
      </div>
      <div id="maxBar" class="guide-bar bar-max" style="top: ${siteConfig.maxTop}px;">
        <span class="handle">Max: <span id="maxVal">${siteConfig.maxTop}</span>px (Drag)</span>
      </div>
      <div id="closeBtn" class="close-pill">Done Adjusting</div>
    `;

        shadow.appendChild(container);

        const minBar = shadow.getElementById('minBar');
        const maxBar = shadow.getElementById('maxBar');
        const minVal = shadow.getElementById('minVal');
        const maxVal = shadow.getElementById('maxVal');

        function makeDraggable(bar, valEl, isMin) {
            let isDragging = false;

            bar.addEventListener('mousedown', (e) => {
                isDragging = true;
                e.preventDefault();
            });

            window.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                let y = Math.max(0, Math.min(window.innerHeight, e.clientY));

                if (isMin) {
                    y = Math.min(y, siteConfig.maxTop - 10);
                    siteConfig.minTop = y;
                } else {
                    y = Math.max(y, siteConfig.minTop + 10);
                    siteConfig.maxTop = y;
                }

                bar.style.top = `${y}px`;
                valEl.textContent = y;
            });

            window.addEventListener('mouseup', async () => {
                if (!isDragging) return;
                isDragging = false;

                const hostname = window.location.hostname;
                const data = await browser.storage.local.get(['sites']);
                const sites = data.sites || {};
                sites[hostname] = {
                    ...sites[hostname],
                    minTop: siteConfig.minTop,
                    maxTop: siteConfig.maxTop
                };
                await browser.storage.local.set({ sites });
            });
        }

        makeDraggable(minBar, minVal, true);
        makeDraggable(maxBar, maxVal, false);

        shadow.getElementById('closeBtn').addEventListener('click', () => {
            toggleThresholdUI();
        });
    }

    // --- Element Picker Mode ---
    function getUniqueSelector(el) {
        if (!el || el === document.body || el === document.documentElement) return null;
        if (el.id) return `#${CSS.escape(el.id)}`;

        const path = [];
        let curr = el;
        while (curr && curr.nodeType === Node.ELEMENT_NODE && curr !== document.body && curr !== document.documentElement) {
            let tag = curr.tagName.toLowerCase();
            if (curr.className && typeof curr.className === 'string') {
                const firstClass = curr.className.trim().split(/\s+/)[0];
                if (firstClass && !firstClass.includes(':')) {
                    tag += `.${CSS.escape(firstClass)}`;
                }
            }
            let sibling = curr;
            let nth = 1;
            while ((sibling = sibling.previousElementSibling)) {
                if (sibling.tagName === curr.tagName) nth++;
            }
            tag += `:nth-of-type(${nth})`;
            path.unshift(tag);
            if (path.length >= 3) break;
            curr = curr.parentElement;
        }
        return path.join(' > ');
    }

    function activatePicker() {
        isPickerActive = true;
        const readerRoot = document.getElementById('reader-root');
        const cursorTarget = readerRoot || document.body;
        cursorTarget.style.cursor = 'crosshair';

        const onHover = (e) => {
            if (!isPickerActive) return;
            e.target.style.outline = '2px dashed #e11d48';
            e.target.style.outlineOffset = '-2px';
        };

        const onLeave = (e) => {
            e.target.style.outline = '';
        };

        const onClick = async (e) => {
            if (!isPickerActive) return;
            e.preventDefault();
            e.stopPropagation();

            e.target.style.outline = '';
            cursorTarget.style.cursor = 'default';
            isPickerActive = false;

            document.removeEventListener('mouseover', onHover, true);
            document.removeEventListener('mouseout', onLeave, true);
            document.removeEventListener('click', onClick, true);

            const selector = getUniqueSelector(e.target);
            if (!selector) return;

            const hostname = window.location.hostname;
            const data = await browser.storage.local.get(['sites']);
            const sites = data.sites || {};
            const currentExclusions = sites[hostname]?.exclusions || [];

            if (!currentExclusions.includes(selector)) {
                currentExclusions.push(selector);
                sites[hostname] = {
                    ...sites[hostname],
                    exclusions: currentExclusions
                };
                await browser.storage.local.set({ sites });
                siteConfig.exclusions = currentExclusions;
            }
        };

        document.addEventListener('mouseover', onHover, true);
        document.addEventListener('mouseout', onLeave, true);
        document.addEventListener('click', onClick, true);
    }

    // --- Message Bus Listener ---
    browser.runtime.onMessage.addListener((message) => {
        if (message.command === 'TOGGLE_BARS') {
            toggleThresholdUI();
        } else if (message.command === 'START_PICKER') {
            activatePicker();
        }
    });
})();