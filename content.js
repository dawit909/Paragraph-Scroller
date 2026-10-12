(() => {
  // ==========================================================================
  // 1. Constants & Configuration
  // ==========================================================================
  const CONFIG = {
    minTop: 100,
    subpixelThreshold: 1,
    nearOffsetThreshold: 30,
    programmaticScrollCooldown: 500
  };

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

  const STRICT_SIDEBAR_SELECTOR = [
    'aside', '[role="complementary"]',
    '#sub', '#Sub', '[id="sub" i]', '#subinner', '#SubInner',
    '#secondary', '[id="secondary" i]',
    '[class*="layout--rail" i]', '[class*="duet--layout--rail" i]',
    '[class*="grid-layout__aside" i]', '[class*="aside-container" i]',
    '[id*="sidebar" i]', '.sidebar', '[class*="_sidebar" i]'
  ].join(', ');

  const HIGHLIGHT_CLASS = 'para-scroller-active-focus';

  // ==========================================================================
  // 2. Runtime State
  // ==========================================================================
  let scrollableElements = null;
  let articleContainerEl = null;
  let activeFocusedElement = null;
  let isDirty = true;

  // Closed-loop anchoring state
  let fixedAnchorTop = null;
  let manualScrollOccurred = false;
  let lastProgrammaticScrollTime = 0;

  // ==========================================================================
  // 3. Focus Indicator & Highlighting
  // ==========================================================================
  function injectHighlightStyles() {
    if (document.getElementById('para-scroller-focus-style')) return;
    const style = document.createElement('style');
    style.id = 'para-scroller-focus-style';
    style.textContent = `
    .${HIGHLIGHT_CLASS} {
      border-radius: 10px !important;
      transition: background-color 0.15s ease-out !important;
    }
    .${HIGHLIGHT_CLASS}.para-theme-light {
      background-color: rgba(59, 130, 246, 0.12) !important;
    }
    .${HIGHLIGHT_CLASS}.para-theme-dark {
      background-color: rgba(245, 158, 11, 0.16) !important;
    }
  `;
    (document.head || document.documentElement).appendChild(style);
  }

  function isDarkTheme(el) {
    let curr = el;
    while (curr && curr !== document.documentElement) {
      const bg = window.getComputedStyle(curr).backgroundColor;
      const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (match) {
        const r = parseInt(match[1], 10);
        const g = parseInt(match[2], 10);
        const b = parseInt(match[3], 10);
        // Relative luminance formula (ITU-R BT.709)
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return luminance < 128;
      }
      curr = curr.parentElement;
    }
    return false;
  }

  function setFocusedElement(el) {
    if (activeFocusedElement && activeFocusedElement !== el) {
      activeFocusedElement.classList.remove(HIGHLIGHT_CLASS, 'para-theme-light', 'para-theme-dark');
    }
    activeFocusedElement = el;
    if (activeFocusedElement) {
      const themeClass = isDarkTheme(activeFocusedElement) ? 'para-theme-dark' : 'para-theme-light';
      activeFocusedElement.classList.add(HIGHLIGHT_CLASS, themeClass);
    }
  }

  // ==========================================================================
  // 4. Viewport & Geometry Utilities
  // ==========================================================================
  function getScrollContainer() {
    const readerRoot = document.getElementById('reader-root');
    return readerRoot && readerRoot.scrollHeight > readerRoot.clientHeight ? readerRoot : window;
  }

  function isElementVisibleInViewport(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
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

  function sortByVerticalPosition(elements) {
    return elements.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      return rectA.top !== rectB.top ? rectA.top - rectB.top : rectA.left - rectB.left;
    });
  }

  // ==========================================================================
  // 5. Heuristic Noise & Structure Scanners
  // ==========================================================================
  function isNoiseElement(el) {
    if (!el || el === document.body || el === document.documentElement) return false;

    // Structural landmarks and navigation chrome
    const landmarkNoise = el.closest(NOISE_SELECTOR);
    if (landmarkNoise && landmarkNoise !== document.body && landmarkNoise !== document.documentElement) {
      return true;
    }

    // Portal sidebars, recommendation blocks, and social rails
    const sideOrFeed = el.closest(
      '#sub, #Sub, [id="sub" i], #subinner, #SubInner, [id="subinner" i], #secondary, [id="secondary" i], ' +
      '[class*="layout--rail" i]', '[class*="duet--layout--rail" i]', '[class*="grid-layout__aside" i], ' +
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

  // ==========================================================================
  // 6. Content Container Detection (LCA + Subsumption)
  // ==========================================================================
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

    // Ancestor subsumption: Promote containers that hold more prose blocks without sidebars
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

  // ==========================================================================
  // 7. Scroll Target Extraction & Normalization
  // ==========================================================================
  function genericFilter(el) {
    const rect = el.getBoundingClientRect();
    if (rect.height === 0 || rect.width === 0) return false;
    if (isNoiseElement(el)) return false;

    const tag = el.tagName.toLowerCase();
    if (tag === 'img' || tag === 'svg') return true;

    const text = el.textContent.trim();
    if (text.length === 0) return false;

    // Headings are never dropped by prose length constraints
    if (/^h[1-6]$/.test(tag)) return true;
    if (calcLinkDensity(el) > 0.85) return false;

    return true;
  }

  function extractScrollTargets(containerEl) {
    const textElements = Array.from(containerEl.querySelectorAll(TEXT_SELECTOR)).filter(genericFilter);

    // Capture standalone h1 elements sitting above the container in article headers
    if (!textElements.some((el) => el.tagName === 'H1')) {
      const pageH1 = document.querySelector('h1');
      if (pageH1 && genericFilter(pageH1)) {
        const articleRoot = containerEl.closest('article, main, [role="main"], #main, #content, body');
        if (articleRoot && articleRoot.contains(pageH1)) {
          textElements.unshift(pageH1);
        }
      }
    }

    // Retain only innermost text blocks (e.g., discard parent blockquote if its p is captured)
    const cleanTextElements = textElements.filter(
      (el1) => !textElements.some((el2) => el1 !== el2 && el1.contains(el2))
    );

    // Extract non-text media containers that don't already wrap matched text
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

    // Retain top-most media containers
    filteredMediaEls = filteredMediaEls.filter(
      (el1) => !filteredMediaEls.some((el2) => el1 !== el2 && el2.contains(el1))
    );

    return sortByVerticalPosition(cleanTextElements.concat(filteredMediaEls));
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
        return rect.height > 0 && rect.width > 0 && el.textContent.trim().length > 0;
      });

      const clean = filtered.filter((el1) => !filtered.some((el2) => el1 !== el2 && el1.contains(el2)));
      scrollableElements = sortByVerticalPosition(clean);
      return;
    }

    articleContainerEl = findMainContentContainer();
    scrollableElements = extractScrollTargets(articleContainerEl);
  }

  // ==========================================================================
  // 8. Navigation & Closed-Loop Scrolling Engine
  // ==========================================================================
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

  function scrollToParagraph(direction) {
    if (isDirty || !scrollableElements || scrollableElements.length === 0) {
      isDirty = false;
      updateScrollableElements();
    }
    if (!scrollableElements || scrollableElements.length === 0) return;

    const minTop = CONFIG.minTop;
    const scrollContainer = getScrollContainer();
    const isMarkOnScreen = isElementVisibleInViewport(activeFocusedElement);

    let targetElement = null;
    let targetTop = minTop;

    if (activeFocusedElement && isMarkOnScreen) {
      // On-screen navigation: Anchor to existing screen position without subpixel drift
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
      // Off-screen recovery: Re-anchor closest element to minTop line
      let targetIdx = getCurrentIndex(scrollableElements, minTop, direction);
      if (targetIdx === -1) return;

      targetElement = scrollableElements[targetIdx];
      let delta = targetElement.getBoundingClientRect().top - minTop;

      if (Math.abs(delta) <= CONFIG.nearOffsetThreshold) {
        const offsetMinTop = direction === 1 ? minTop + CONFIG.nearOffsetThreshold : minTop - CONFIG.nearOffsetThreshold;
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

    const finalDelta = targetElement.getBoundingClientRect().top - targetTop;
    if (Math.abs(finalDelta) > CONFIG.subpixelThreshold) {
      lastProgrammaticScrollTime = Date.now();
      if (scrollContainer === window) {
        window.scrollBy({ top: finalDelta, behavior: 'smooth' });
      } else {
        scrollContainer.scrollBy({ top: finalDelta, behavior: 'smooth' });
      }
    }
  }

  // ==========================================================================
  // 9. Event Observers & Initialization
  // ==========================================================================
  function markManualScroll() {
    if (Date.now() - lastProgrammaticScrollTime > CONFIG.programmaticScrollCooldown) {
      manualScrollOccurred = true;
    }
  }

  window.addEventListener('scroll', markManualScroll, { passive: true });
  ['wheel', 'touchmove'].forEach((evt) => {
    window.addEventListener(evt, () => { manualScrollOccurred = true; }, { passive: true });
  });

  new MutationObserver(() => {
    isDirty = true;
  }).observe(document.documentElement, { childList: true, subtree: true });


  // --- Blacklist Enforcement ---
  let isBlacklisted = false;
  function isUrlMatched(url, pattern) {
    if (!url || !pattern) return false;
    const regexStr = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    try {
      return new RegExp(regexStr).test(url);
    } catch {
      return false;
    }
  }

  async function checkBlacklist() {
    const data = await browser.storage.local.get(['blacklist']);
    const blacklist = Array.isArray(data.blacklist) ? data.blacklist : [];
    isBlacklisted = blacklist.some((pattern) => isUrlMatched(window.location.href, pattern));

    if (isBlacklisted && activeFocusedElement) {
      activeFocusedElement.classList.remove(HIGHLIGHT_CLASS);
      activeFocusedElement = null;
    }
  }

  checkBlacklist();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.blacklist) {
      checkBlacklist();
    }
  });

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.repeat || isBlacklisted) return;
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

  injectHighlightStyles();
})();