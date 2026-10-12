(() => {
  // --- Constants & Configuration ---
  const DEFAULT_CONFIG = { minTop: 60, maxTop: 220 };
  const TEXT_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, details';
  const MEDIA_SELECTOR = 'div, svg, img';
  const BLOCK_TAGS = new Set([
    'p', 'div', 'article', 'section', 'li', 'blockquote', 'main', 'aside', 'header', 'footer'
  ]);
  const NOISE_SELECTOR = [
    'nav', 'footer', 'aside',
    '[role="navigation"]', '[role="complementary"]', '[role="toolbar"]',
    'form', '[class*="breadcrumb" i]', '[id*="breadcrumb" i]'
  ].join(', ');

  const HIGHLIGHT_CLASS = 'para-scroller-active-focus';

  // --- Runtime State ---
  let siteConfig = { ...DEFAULT_CONFIG, exclusions: [] };
  let isBlacklisted = false;
  let isPickerActive = false;
  let shadowHost = null;
  let scrollableElements = null;
  let articleContainerEl = null;
  let activeFocusedElement = null;
  let isDirty = true;
  const isTest = false;

  // Closed-loop anchor tracking (prevents subpixel drift)
  let fixedAnchorTop = null;
  let manualScrollOccurred = false;
  let lastProgrammaticScrollTime = 0;

  // --- Stylesheet Injection (Accent Background Tint Only) ---
  function injectHighlightStyles() {
    if (document.getElementById('para-scroller-focus-style')) return;
    const style = document.createElement('style');
    style.id = 'para-scroller-focus-style';
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        background-color: rgba(59, 130, 246, 0.12) !important;
        border-radius: 10px !important;
        transition: background-color 0.15s ease-out !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  injectHighlightStyles();

  // --- Non-Destructive Focus Marking ---
  function setFocusedElement(el) {
    if (activeFocusedElement && activeFocusedElement !== el) {
      activeFocusedElement.classList.remove(HIGHLIGHT_CLASS);
    }
    activeFocusedElement = el;
    if (activeFocusedElement) {
      activeFocusedElement.classList.add(HIGHLIGHT_CLASS);
    }
  }

  // --- Viewport State & Geometry Helpers ---
  function getScrollContainer() {
    const readerRoot = document.getElementById('reader-root');
    return readerRoot && readerRoot.scrollHeight > readerRoot.clientHeight ? readerRoot : window;
  }

  function isElementVisibleInViewport(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  }

  function isUrlMatched(url, pattern) {
    const regexStr = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    try {
      return new RegExp(regexStr).test(url);
    } catch {
      return false;
    }
  }

  function calcLinkDensity(el) {
    const total = el.textContent.trim().length;
    if (total === 0) return 0;
    let linkChars = 0;
    const links = el.getElementsByTagName('a');
    for (let i = 0; i < links.length; i++) {
      linkChars += links[i].textContent.trim().length;
    }
    return linkChars / total;
  }

  function isExcludedByUser(el) {
    if (!siteConfig.exclusions || siteConfig.exclusions.length === 0) return false;
    return siteConfig.exclusions.some((selector) => {
      try {
        return el.matches(selector) || el.closest(selector);
      } catch {
        return false;
      }
    });
  }

  // --- Config Loader ---
  async function loadConfig() {
    const hostname = window.location.hostname;
    const currentUrl = window.location.href;
    const data = await browser.storage.local.get(['blacklist', 'defaults', 'sites']);

    const blacklist = data.blacklist || [];
    isBlacklisted = blacklist.some((pattern) => isUrlMatched(currentUrl, pattern));
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

  // --- Noise & Sidebar Identification ---
  function isNoiseElement(el) {
    if (!el || el === document.body || el === document.documentElement) return false;

    // 1. Semantic landmarks & navigation chrome
    const landmarkNoise = el.closest(
      'nav, footer, aside, [role="navigation"], [role="complementary"], [role="toolbar"], form, [class*="breadcrumb" i], [id*="breadcrumb" i]'
    );
    if (landmarkNoise && landmarkNoise !== document.body && landmarkNoise !== document.documentElement) {
      return true;
    }

    // 2. Explicit sidebars, secondary columns, and rails
    const sideOrFeed = el.closest(
      '#sub, #Sub, [id="sub" i], #subinner, #SubInner, [id="subinner" i], #secondary, [id="secondary" i], ' +
      '[class*="layout--rail" i], [class*="duet--layout--rail" i], [class*="grid-layout__aside" i], ' +
      '[class*="aside-container" i], [class*="sidebar" i], [id*="sidebar" i], ' +
      '[class*="popular" i], [id*="popular" i], [class*="recirc" i], [id*="recirc" i], ' +
      '[class*="trending" i], [id*="trending" i], [class*="ranking" i], [id*="ranking" i], ' +
      '[class*="recommend" i], [id*="recommend" i], [aria-label*="popular" i], [aria-label*="recommend" i], ' +
      '[aria-label*="further reading" i], [aria-label*="related" i], [data-testid*="author" i]'
    );

    if (sideOrFeed && sideOrFeed !== document.body && sideOrFeed !== document.documentElement) {
      const cls = sideOrFeed.className;
      if (typeof cls === 'string' && /\b(has|with|no|without)[-_]sidebar\b/i.test(cls)) {
        return false;
      }
      return true;
    }

    return false;
  }

  // --- Candidate Leaf Evaluation (Main Container Detection) ---
  function isQualifiedTextLeaf(el) {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    if (isNoiseElement(el)) return false;
    if (el.tagName === 'A' || el.closest('a')) return false;

    const trimmed = el.textContent.trim();
    if (trimmed.length < 35 || !trimmed.includes(' ')) return false;
    if (calcLinkDensity(el) > 0.45) return false;

    let directTextLength = 0;
    let hasBlockChild = false;

    for (let node = el.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === Node.TEXT_NODE) {
        directTextLength += node.nodeValue.trim().length;
      } else if (node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(node.tagName.toLowerCase())) {
        hasBlockChild = true;
      }
    }

    return !hasBlockChild || directTextLength > 30;
  }

  // --- Main Content Container Resolver ---
  function findMainContentContainer() {
    const containerScores = new Map();
    const candidates = Array.from(
      document.querySelectorAll('p, div, section, li, blockquote, article, h1, h2, h3')
    ).filter(isQualifiedTextLeaf);

    if (candidates.length === 0) return document.body;

    candidates.forEach((leaf) => {
      const text = leaf.textContent.trim();
      const commaCount = (text.match(/,/g) || []).length;
      const baseScore = 1 + Math.floor(text.length / 100) + commaCount * 1.5;

      let current = leaf.parentElement;
      let weight = 1.0;
      let depth = 0;

      while (
        current &&
        current !== document.body &&
        current !== document.documentElement &&
        depth < 10
      ) {
        const entry = containerScores.get(current) || { score: 0, leaves: new Set() };
        entry.score += baseScore * weight;
        entry.leaves.add(leaf);
        containerScores.set(current, entry);

        weight *= 0.82;
        depth++;
        current = current.parentElement;
      }
    });

    const evaluated = [];
    for (const [container, data] of containerScores.entries()) {
      let finalScore = data.score;

      if (data.leaves.size > 1) {
        finalScore *= 1 + Math.log2(data.leaves.size) * 0.25;
      }

      const tag = container.tagName.toLowerCase();
      const id = container.id.toLowerCase();
      if (tag === 'article' || tag === 'main' || id === 'main' || container.getAttribute('role') === 'main') {
        finalScore *= 1.4;
      } else if (tag === 'section' || id === 'content') {
        finalScore *= 1.2;
      }

      const linkDensity = calcLinkDensity(container);
      if (linkDensity > 0.40) continue;

      finalScore *= 1 - linkDensity;
      evaluated.push({ container, score: finalScore, count: data.leaves.size });
    }

    if (evaluated.length === 0) return document.body;

    evaluated.sort((a, b) => b.score - a.score);
    let best = evaluated[0];

    const STRICT_SIDEBAR_SELECTOR = [
      'aside', '[role="complementary"]',
      '#sub', '#Sub', '[id="sub" i]', '#subinner', '#SubInner',
      '#secondary', '[id="secondary" i]',
      '[class*="layout--rail" i]', '[class*="duet--layout--rail" i]',
      '[class*="grid-layout__aside" i]', '[class*="aside-container" i]',
      '[id*="sidebar" i]', '.sidebar', '[class*="_sidebar" i]'
    ].join(', ');

    for (const candidate of evaluated) {
      if (candidate.container.contains(best.container) && candidate.container !== best.container) {
        if (candidate.container.querySelector(STRICT_SIDEBAR_SELECTOR)) {
          continue;
        }
        if (candidate.count > best.count) {
          best = candidate;
        }
      }
    }

    return best.container;
  }

  // --- Scroll Target Filtering ---
  function genericFilter(el) {
    const rect = el.getBoundingClientRect();
    if (rect.height === 0 || rect.width === 0) return false;
    if (isExcludedByUser(el)) return false;
    if (isNoiseElement(el)) return false;

    const tag = el.tagName.toLowerCase();
    if (tag === 'img' || tag === 'svg') return true;

    const text = el.textContent.trim();
    if (text.length === 0) return false;

    // Headings are always preserved regardless of character length
    if (/^h[1-6]$/.test(tag)) return true;

    if (calcLinkDensity(el) > 0.85) return false;

    return true;
  }

  function extractScrollTargets(containerEl) {
    const textElements = Array.from(containerEl.querySelectorAll(TEXT_SELECTOR))
      .filter(genericFilter);

    if (!textElements.some((el) => el.tagName === 'H1')) {
      const pageH1 = document.querySelector('h1');
      if (pageH1 && genericFilter(pageH1)) {
        const articleRoot = containerEl.closest('article, main, [role="main"], #main, #content, body');
        if (articleRoot && articleRoot.contains(pageH1)) {
          textElements.unshift(pageH1);
        }
      }
    }

    // Filter out parent text nodes containing other matched text nodes (e.g. blockquote > p)
    const cleanTextElements = textElements.filter((el1) => {
      return !textElements.some((el2) => el1 !== el2 && el1.contains(el2));
    });

    const mediaElements = Array.from(containerEl.querySelectorAll(MEDIA_SELECTOR))
      .filter(genericFilter)
      .filter((el) => !cleanTextElements.some((txtEl) => el.contains(txtEl)));

    const len = mediaElements.length;
    let filteredMediaEls = mediaElements.filter((el1) => {
      const descenCnt = mediaElements.reduce((cnt, el2) => {
        return el1 !== el2 && el1.contains(el2) ? cnt + 1 : cnt;
      }, 0);
      return !(descenCnt > 19 || descenCnt / len > 0.5);
    });

    filteredMediaEls = filteredMediaEls.filter((el1) => {
      return !filteredMediaEls.some((el2) => el1 !== el2 && el2.contains(el1));
    });

    const allTargets = cleanTextElements.concat(filteredMediaEls);

    // Sort strictly by vertical top position in document space
    allTargets.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      if (rectA.top !== rectB.top) {
        return rectA.top - rectB.top;
      }
      return rectA.left - rectB.left;
    });

    return allTargets;
  }

  function updateScrollableElements() {
    const readerRoot = document.getElementById('reader-root');

    if (readerRoot) {
      const rawElements = Array.from(
        readerRoot.querySelectorAll(
          '#reader-title, #reader-content p, #reader-content h1, #reader-content h2, #reader-content h3, #reader-content h4, #reader-content h5, #reader-content h6, #reader-content blockquote, #reader-content li'
        )
      );

      const filtered = rawElements.filter((el) => {
        const rect = el.getBoundingClientRect();
        return (
          rect.height > 0 &&
          rect.width > 0 &&
          el.textContent.trim().length > 0 &&
          !isExcludedByUser(el)
        );
      });

      const clean = filtered.filter((el1) => {
        return !filtered.some((el2) => el1 !== el2 && el1.contains(el2));
      });

      clean.sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        if (rectA.top !== rectB.top) {
          return rectA.top - rectB.top;
        }
        return rectA.left - rectB.left;
      });

      scrollableElements = clean;
      return;
    }

    articleContainerEl = findMainContentContainer();
    scrollableElements = extractScrollTargets(articleContainerEl);

    if (isTest && scrollableElements) {
      for (let i = 0; i < scrollableElements.length; i++) {
        scrollableElements[i].style.borderStyle = 'solid';
        scrollableElements[i].style.borderColor = 'red';
        scrollableElements[i].style.borderWidth = 'medium';
      }
    }
  }

  new MutationObserver(() => {
    isDirty = true;
  }).observe(document.documentElement, { childList: true, subtree: true });

  // --- Manual Scroll Detection ---
  function markManualScroll() {
    if (Date.now() - lastProgrammaticScrollTime > 500) {
      manualScrollOccurred = true;
    }
  }

  window.addEventListener('scroll', markManualScroll, { passive: true });
  ['wheel', 'touchmove'].forEach((evt) => {
    window.addEventListener(evt, () => { manualScrollOccurred = true; }, { passive: true });
  });

  // --- Active Element Resolvers ---
  function getCurrentIndex(elements, minTop, direction) {
    const sign = direction === 1 ? 1 : -1;
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let i = 0; i < elements.length; i++) {
      const top = elements[i].getBoundingClientRect().top;
      const dist = top - minTop;

      if (dist * sign < 0) continue;
      const absDist = Math.abs(dist);
      if (absDist < bestDist) {
        bestDist = absDist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  // --- Scrolling Engine ---
  function scrollToParagraph(direction) {
    if (isDirty || !scrollableElements || scrollableElements.length === 0) {
      isDirty = false;
      updateScrollableElements();
    }
    if (!scrollableElements || scrollableElements.length === 0) return;

    const { minTop } = siteConfig;
    const scrollContainer = getScrollContainer();
    const isMarkOnScreen = isElementVisibleInViewport(activeFocusedElement);

    let targetElement = null;
    let targetTop = minTop;

    if (activeFocusedElement && isMarkOnScreen) {
      // 1. Mark is on screen: move simply to the next element in sorted order
      if (manualScrollOccurred || fixedAnchorTop === null) {
        fixedAnchorTop = Math.round(activeFocusedElement.getBoundingClientRect().top);
        manualScrollOccurred = false;
      }
      targetTop = fixedAnchorTop;

      const currentIdx = scrollableElements.indexOf(activeFocusedElement);
      if (currentIdx !== -1) {
        const nextIdx = currentIdx + direction;
        if (nextIdx >= 0 && nextIdx < scrollableElements.length) {
          targetElement = scrollableElements[nextIdx];
        } else {
          return; // Boundary reached
        }
      }
    }

    if (!targetElement) {
      // 2. Mark is off screen: recover based on minTop and direction
      let targetIdx = getCurrentIndex(scrollableElements, minTop, direction);
      if (targetIdx === -1) return;

      targetElement = scrollableElements[targetIdx];
      let delta = targetElement.getBoundingClientRect().top - minTop;

      if (Math.abs(delta) <= 30) {
        const offsetMinTop = direction === 1 ? minTop + 30 : minTop - 30;
        const nextIdx = getCurrentIndex(scrollableElements, offsetMinTop, direction);
        if (nextIdx !== -1) {
          targetIdx = nextIdx;
          targetElement = scrollableElements[targetIdx];
        }
      }
      targetTop = minTop;
      fixedAnchorTop = minTop;
      manualScrollOccurred = false;
    }

    if (!targetElement) return;

    setFocusedElement(targetElement);

    // Closed-loop scroll delta calculation against fixed targetTop
    const finalDelta = targetElement.getBoundingClientRect().top - targetTop;
    if (Math.abs(finalDelta) > 1) {
      lastProgrammaticScrollTime = Date.now();
      if (scrollContainer === window) {
        window.scrollBy({ top: finalDelta, behavior: 'smooth' });
      } else {
        scrollContainer.scrollBy({ top: finalDelta, behavior: 'smooth' });
      }
    }
  }

  // --- Keyboard Shortcuts ---
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.repeat || isBlacklisted || isPickerActive) return;

      const active = document.activeElement;
      const isTyping =
        active &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable);
      if (isTyping) return;

      if (e.code === 'KeyJ') {
        e.preventDefault();
        scrollToParagraph(1);
      } else if (e.code === 'KeyK') {
        e.preventDefault();
        scrollToParagraph(-1);
      }
    },
    true
  );

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

  browser.runtime.onMessage.addListener((message) => {
    if (message.command === 'TOGGLE_BARS') {
      toggleThresholdUI();
    } else if (message.command === 'START_PICKER') {
      activatePicker();
    }
  });
})();