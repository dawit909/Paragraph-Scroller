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

    // --- Target Element Collector ---
    function getCandidateElements() {
        const readerRoot = document.getElementById('reader-root');

        const excludedNodes = [];
        for (const sel of siteConfig.exclusions) {
            try {
                document.querySelectorAll(sel).forEach(node => excludedNodes.push(node));
            } catch (err) {
                console.warn('[Paragraph Scroller] Invalid exclusion selector:', sel);
            }
        }

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
        const rawElements = Array.from(document.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote'));

        return rawElements.filter(el => {
            const rect = el.getBoundingClientRect();
            if (rect.height === 0 || rect.width === 0) return false;
            if (el.innerText.trim().length === 0) return false;

            if (el.closest('nav, header, footer, aside, [class*="nav" i], [class*="menu" i]')) {
                return false;
            }

            for (const excluded of excludedNodes) {
                if (excluded === el || excluded.contains(el)) return false;
            }

            return true;
        });
    }

    // --- Active Element Resolver ---
    function getCurrentIndex(elements, minTop, maxTop) {
        // 1. Element aligned right at minTop (within subpixel tolerance)
        let bestIdx = -1;
        let bestDist = Infinity;
        for (let i = 0; i < elements.length; i++) {
            const top = elements[i].getBoundingClientRect().top;
            const dist = Math.abs(top - minTop);
            if (dist <= TOLERANCE && dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }
        if (bestIdx !== -1) return bestIdx;

        // 2. Element spanning across minTop (tall paragraph currently being read)
        for (let i = 0; i < elements.length; i++) {
            const rect = elements[i].getBoundingClientRect();
            if (rect.top < minTop && rect.bottom > minTop) {
                return i;
            }
        }

        // 3. First element sitting inside the visual reading window [minTop, maxTop]
        for (let i = 0; i < elements.length; i++) {
            const top = elements[i].getBoundingClientRect().top;
            if (top >= minTop && top <= maxTop) {
                return i;
            }
        }

        // 4. Last element that has scrolled past minTop
        for (let i = elements.length - 1; i >= 0; i--) {
            if (elements[i].getBoundingClientRect().top < minTop) {
                return i;
            }
        }

        return 0;
    }

    // --- Scrolling Engine ---
    function scrollToParagraph(direction) {
        if (isBlacklisted) return;
        const elements = getCandidateElements();
        if (elements.length === 0) return;

        const { minTop, maxTop } = siteConfig;
        const scrollContainer = getScrollContainer();
        const currentScroll = (scrollContainer === window)
            ? (window.scrollY || document.documentElement.scrollTop || 0)
            : scrollContainer.scrollTop;

        const currentIdx = getCurrentIndex(elements, minTop, maxTop);
        let targetElement = null;

        if (direction === 1) { // Down
            if (currentIdx + 1 < elements.length) {
                targetElement = elements[currentIdx + 1];
            } else {
                targetElement = elements.find(el => el.getBoundingClientRect().top > maxTop);
            }

            // Downward Safeguard: Skip micro-deltas (less than 5px)
            if (targetElement) {
                const delta = targetElement.getBoundingClientRect().top - minTop;
                if (delta <= 5) {
                    const idx = elements.indexOf(targetElement);
                    if (idx !== -1 && idx + 1 < elements.length) {
                        targetElement = elements[idx + 1];
                    }
                }
            }
        } else { // Up
            if (currentIdx > 0) {
                targetElement = elements[currentIdx - 1];
            } else {
                // If at or before element 0, scroll cleanly to the top of the container
                if (currentScroll > 0) {
                    if (scrollContainer === window) {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    } else {
                        scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
                    }
                }
                return;
            }

            // Upward Safeguard: Target must move viewport up by at least 5px
            if (targetElement) {
                const delta = targetElement.getBoundingClientRect().top - minTop;
                if (delta >= -5) {
                    const idx = elements.indexOf(targetElement);
                    if (idx > 0) {
                        targetElement = elements[idx - 1];
                    } else {
                        targetElement = null;
                        if (currentScroll > 0) {
                            if (scrollContainer === window) {
                                window.scrollTo({ top: 0, behavior: 'smooth' });
                            } else {
                                scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
                            }
                            return;
                        }
                    }
                }
            }
        }

        if (targetElement) {
            const targetTop = targetElement.getBoundingClientRect().top;
            const delta = targetTop - minTop;

            if (scrollContainer === window) {
                window.scrollBy({ top: delta, behavior: 'smooth' });
            } else {
                scrollContainer.scrollBy({ top: delta, behavior: 'smooth' });
            }
        }
    }

    // --- Keyboard Shortcuts (Capture Phase) ---
    document.addEventListener('keydown', (e) => {
        if (isBlacklisted || isPickerActive) return;
        const active = document.activeElement;
        const isTyping = active && (
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) ||
            active.isContentEditable
        );
        if (isTyping) return;

        if (e.key === 'j' || e.key === 'J') {
            e.preventDefault();
            scrollToParagraph(1);
        } else if (e.key === 'k' || e.key === 'K') {
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