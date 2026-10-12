(() => {
  // Polyfill browser namespace for Chrome/Chromium compatibility
  if (typeof browser === 'undefined') var browser = chrome;

  // ==========================================================================
  // 1. Constants & Configuration
  // ==========================================================================
  const CONFIG = {
    minTop: 100,
    subpixelThreshold: 1,
    nearOffsetThreshold: 30,
    minStepDelta: 10,
    programmaticScrollCooldown: 500
  };

  const TEXT_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, details, figcaption, div';
  const MEDIA_SELECTOR = 'figure, picture, img, svg';

  const BLOCK_TAGS = new Set([
    'p', 'div', 'article', 'section', 'li', 'blockquote', 'main', 'aside',
    'header', 'footer', 'nav', 'figure', 'details', 'table', 'ul', 'ol',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
  ]);

  const REGEXPS = {
    unlikelyCandidates:
      /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i,
    okMaybeItsACandidate:
      /and|article|body|column|content|main|shadow/i,
    positive:
      /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i,
    negative:
      /-ad-|hidden|^hid$\vert{} hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i,
    commas: /\u002C|\u060C|\uFE50|\uFE10|\uFE11|\u2E41|\u2E34|\u2E32|\uFF0C/g
  };

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
  let isBlacklisted = false;
  let scrollableElements = null;
  let articleContainerEl = null;
  let activeFocusedElement = null;
  let isDirty = true;

  let fixedAnchorTop = null;
  let manualScrollOccurred = false;
  let lastProgrammaticScrollTime = 0;

  // ==========================================================================
  // 3. Blacklist Enforcement
  // ==========================================================================
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
    try {
      const data = await browser.storage.local.get(['blacklist']);
      const blacklist = Array.isArray(data.blacklist) ? data.blacklist : [];
      isBlacklisted = blacklist.some((pattern) => isUrlMatched(window.location.href, pattern));

      if (isBlacklisted && activeFocusedElement) {
        activeFocusedElement.classList.remove(HIGHLIGHT_CLASS);
        activeFocusedElement = null;
      }
    } catch (_) { }
  }

  checkBlacklist();
  if (browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.blacklist) {
        checkBlacklist();
      }
    });
  }

  // ==========================================================================
  // 4. Focus Indicator & Non-Destructive Highlighting
  // ==========================================================================
  function injectHighlightStyles() {
    if (document.getElementById('para-scroller-focus-style')) return;
    const style = document.createElement('style');
    style.id = 'para-scroller-focus-style';
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        background-color: rgba(59, 130, 246, 0.14) !important;
        border-radius: 8px !important;
        transition: background-color 0.15s ease-out !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  injectHighlightStyles();

  function setFocusedElement(el) {
    if (activeFocusedElement && activeFocusedElement !== el) {
      activeFocusedElement.classList.remove(HIGHLIGHT_CLASS);
    }
    activeFocusedElement = el;
    if (activeFocusedElement) {
      activeFocusedElement.classList.add(HIGHLIGHT_CLASS);
    }
  }

  // ==========================================================================
  // 5. Structure & Heuristic Scanners
  // ==========================================================================
  function hasChildBlockElement(el) {
    for (let i = 0; i < el.children.length; i++) {
      const childTag = el.children[i].tagName.toLowerCase();
      if (BLOCK_TAGS.has(childTag)) return true;
    }
    return false;
  }

  function getSafeStringAttributes(el) {
    const className = typeof el.className === 'string' ? el.className : (el.className?.baseVal || '');
    const id = typeof el.id === 'string' ? el.id : '';
    return { className, id, combined: className + ' ' + id };
  }

  function getClassWeight(el) {
    let weight = 0;
    const { className, id } = getSafeStringAttributes(el);
    if (className) {
      if (REGEXPS.negative.test(className)) weight -= 25;
      if (REGEXPS.positive.test(className)) weight += 25;
    }
    if (id) {
      if (REGEXPS.negative.test(id)) weight -= 25;
      if (REGEXPS.positive.test(id)) weight += 25;
    }
    return weight;
  }

  function isNoiseElement(el) {
    if (!el || el === document.body || el === document.documentElement) return false;

    // Semantic landmarks & navigation chrome
    const landmarkNoise = el.closest(
      'nav, footer, aside, [role="navigation"], [role="complementary"], [role="toolbar"], form, [class*="breadcrumb" i], [id*="breadcrumb" i]'
    );
    if (landmarkNoise && landmarkNoise !== document.body && landmarkNoise !== document.documentElement) {
      return true;
    }

    // Explicit sidebars, secondary columns, rails, and recommendation widgets
    const sideOrFeed = el.closest(
      '#sub, #Sub, [id="sub" i], #subinner, #SubInner, [id="subinner" i], #secondary, [id="secondary" i], ' +
      '[class*="layout--rail" i], [class*="duet--layout--rail" i], [class*="grid-layout__aside" i], ' +
      '[class*="aside-container" i], [class*="sidebar" i], [id*="sidebar" i], ' +
      '[class*="right-column" i], [class*="right_column" i], [data-testid*="column-right" i], [data-testid*="right-rail" i], ' +
      '[data-testid*="column-left-rail" i], [data-testid*="horizontal-collection" i], ' +
      '[class*="popular" i], [id*="popular" i], [class*="recirc" i], [id*="recirc" i], ' +
      '[class*="trending" i], [id*="trending" i], [class*="ranking" i], [id*="ranking" i], ' +
      '[class*="recommend" i], [id*="recommend" i], [aria-label*="popular" i], [aria-label*="recommend" i], ' +
      '[aria-label*="further reading" i], [aria-label*="related" i], [aria-label*="what to read next" i], ' +
      '[data-testid*="author" i], [class*="author-module" i], [class*="comments" i], [id*="comments" i], ' +
      '[data-testid*="links-grid" i], [data-indexcard="true"]'
    );

    if (sideOrFeed && sideOrFeed !== document.body && sideOrFeed !== document.documentElement) {
      const cls = sideOrFeed.className;
      if (typeof cls === 'string' && /\b(has|with|no|without)[-_]sidebar\b/i.test(cls)) {
        return false;
      }
      return true;
    }

    // Ancestral regex check
    let curr = el;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      if (curr.tagName === 'ARTICLE' || curr.tagName === 'MAIN') break;
      const { combined } = getSafeStringAttributes(curr);
      if (REGEXPS.unlikelyCandidates.test(combined) && !REGEXPS.okMaybeItsACandidate.test(combined)) {
        return true;
      }
      curr = curr.parentElement;
    }

    return false;
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

  function isQualifiedTextLeaf(el) {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    if (isNoiseElement(el)) return false;
    if (el.tagName === 'A' || el.closest('a')) return false;

    const trimmed = el.textContent.trim();
    if (trimmed.length < 25) return false;
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

    return !hasBlockChild || directTextLength > 20;
  }

  // ==========================================================================
  // 6. Deep Content Container Resolver
  // ==========================================================================
  function findMainContentContainer() {
    const candidates = Array.from(
      document.querySelectorAll('p, div, section, li, blockquote, article, h1, h2, h3')
    ).filter(isQualifiedTextLeaf);

    if (candidates.length === 0) return document.body;

    const containerScores = new Map();

    candidates.forEach((leaf) => {
      const text = leaf.textContent.trim();
      const commaCount = (text.match(REGEXPS.commas) || []).length;
      const contentScore = 1 + commaCount + Math.min(Math.floor(text.length / 100), 3);

      let current = leaf.parentElement;
      let depth = 0;
      let weight = 1.0;

      while (
        current &&
        current !== document.body &&
        current !== document.documentElement &&
        depth < 10
      ) {
        const entry = containerScores.get(current) || { score: 0, leaves: new Set() };
        entry.score += contentScore * weight;
        entry.leaves.add(leaf);
        containerScores.set(current, entry);

        weight *= 0.85;
        depth++;
        current = current.parentElement;
      }
    });

    const evaluated = [];
    for (const [container, data] of containerScores.entries()) {
      let finalScore = data.score;
      finalScore += getClassWeight(container);

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
      if (linkDensity > 0.45) continue;
      finalScore *= 1 - linkDensity;

      evaluated.push({ container, score: finalScore, count: data.leaves.size });
    }

    if (evaluated.length === 0) return document.body;

    evaluated.sort((a, b) => b.score - a.score);
    let best = evaluated[0];

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
  // 7. Scroll Target Extraction & Noise Pruning
  // ==========================================================================
  function genericFilter(el) {
    const rect = el.getBoundingClientRect();
    if (rect.height === 0 || rect.width === 0) return false;
    if (isNoiseElement(el)) return false;

    if (
      el.closest(
        'button, [role="button"], [role="toolbar"], [class*="toolbar" i], [class*="action" i], [class*="share" i], [class*="byline-action" i], [data-testid*="share" i], [data-testid*="save" i]'
      )
    ) {
      return false;
    }

    if (el.tagName === 'A' || el.closest('a')) return false;

    const tag = el.tagName.toLowerCase();

    if (tag === 'img' || tag === 'picture' || tag === 'figure') {
      return rect.width >= 60 && rect.height >= 60;
    }

    if (tag === 'svg') {
      return rect.width >= 100 && rect.height >= 80;
    }

    const text = el.textContent.trim();
    if (text.length === 0) return false;

    if (calcLinkDensity(el) > 0.65) return false;

    if (tag === 'div') {
      if (hasChildBlockElement(el)) return false;
      if (text.length < 25) return false;
      return true;
    }

    if (/^h[1-6]$/.test(tag)) return true;
    if (text.length < 15 && !el.closest('p, blockquote, figcaption')) return false;

    return true;
  }

  function sortByReadingOrder(elements) {
    return elements.sort((a, b) => {
      if (a === b) return 0;
      const position = a.compareDocumentPosition(b);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  function extractScrollTargets(containerEl) {
    const textElements = Array.from(containerEl.querySelectorAll(TEXT_SELECTOR)).filter(genericFilter);

    if (!textElements.some((el) => el.tagName === 'H1')) {
      const pageH1 = document.querySelector('h1');
      if (pageH1 && genericFilter(pageH1)) {
        const articleRoot = containerEl.closest('article, main, [role="main"], #main, #content, body');
        if (articleRoot && articleRoot.contains(pageH1)) {
          textElements.unshift(pageH1);
        }
      }
    }

    const cleanTextElements = textElements.filter(
      (el1) => !textElements.some((el2) => el1 !== el2 && el1.contains(el2))
    );

    const rawMediaElements = Array.from(containerEl.querySelectorAll(MEDIA_SELECTOR))
      .filter(genericFilter)
      .filter((el) => !cleanTextElements.some((txtEl) => txtEl.contains(el) || el.contains(txtEl)));

    const cleanMediaElements = rawMediaElements.filter(
      (el1) => !rawMediaElements.some((el2) => el1 !== el2 && el1.contains(el2))
    );

    const allTargets = cleanTextElements.concat(cleanMediaElements);
    return sortByReadingOrder(allTargets);
  }

  function updateScrollableElements() {
    const readerRoot = document.getElementById('reader-root');

    if (readerRoot) {
      const rawElements = Array.from(
        readerRoot.querySelectorAll(
          '#reader-title, #reader-content p, #reader-content h1, #reader-content h2, #reader-content h3, #reader-content h4, #reader-content h5, #reader-content h6, #reader-content blockquote, #reader-content li, #reader-content figcaption'
        )
      );

      const filtered = rawElements.filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.height > 0 && rect.width > 0 && el.textContent.trim().length > 0;
      });

      const clean = filtered.filter((el1) => !filtered.some((el2) => el1 !== el2 && el1.contains(el2)));
      scrollableElements = sortByReadingOrder(clean);
      return;
    }

    articleContainerEl = findMainContentContainer();
    scrollableElements = extractScrollTargets(articleContainerEl);
  }

  // ==========================================================================
  // 8. Navigation & Closed-Loop Scrolling Engine
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
      if (manualScrollOccurred || fixedAnchorTop === null) {
        const rawTop = Math.round(activeFocusedElement.getBoundingClientRect().top);
        fixedAnchorTop = Math.max(minTop, Math.min(window.innerHeight - 120, rawTop));
        manualScrollOccurred = false;
      }
      targetTop = fixedAnchorTop;

      const currentIdx = scrollableElements.indexOf(activeFocusedElement);
      if (currentIdx !== -1) {
        const currentTop = activeFocusedElement.getBoundingClientRect().top;
        const currentLeft = activeFocusedElement.getBoundingClientRect().left;
        let nextIdx = currentIdx + direction;

        while (nextIdx >= 0 && nextIdx < scrollableElements.length) {
          const candidateRect = scrollableElements[nextIdx].getBoundingClientRect();
          const directionalDiff = (candidateRect.top - currentTop) * direction;
          const horizontalDiff = Math.abs(candidateRect.left - currentLeft);

          // 1. Normal reading progression (strictly in the direction of navigation)
          const isNextRow = directionalDiff >= CONFIG.minStepDelta;
          // 2. Cross-column wrap (transitioning to a new visual column)
          const isColumnWrap = horizontalDiff > 150 && Math.abs(candidateRect.top - currentTop) > 50;

          if (isNextRow || isColumnWrap) {
            targetElement = scrollableElements[nextIdx];
            break;
          }

          nextIdx += direction;
        }

        if (!targetElement) return;
      }
    }

    if (!targetElement) {
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
  // 9. Event Listeners & Observers
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

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.repeat || isBlacklisted || e.altKey || e.ctrlKey || e.metaKey) return;

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
})();