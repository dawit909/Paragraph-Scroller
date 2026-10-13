;(() => {
  if (typeof browser === "undefined") var browser = chrome

  // ==========================================================================
  // 1. Constants & Configuration
  // ==========================================================================
  const CONFIG = {
    minTop: 100,
    maxTopToScreenBottom: 120,
    subpixelThreshold: 1,
    nearOffsetThreshold: 30,
    minStepDelta: 10,
    programmaticScrollCooldown: 500,
    maxAncestorDepth: 10,
    ancestorWeightDecay: 0.85,
  }

  const TEXT_SELECTOR =
    "h1, h2, h3, h4, h5, h6, p, li, blockquote, details, figcaption, div"
  const MEDIA_SELECTOR = "figure, picture, img, svg"

  const BLOCK_TAGS = new Set([
    "p",
    "div",
    "article",
    "section",
    "li",
    "blockquote",
    "main",
    "aside",
    "header",
    "footer",
    "nav",
    "figure",
    "details",
    "table",
    "ul",
    "ol",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
  ])

  // Unified content-agnostic regex dictionaries
  const REGEXPS = {
    noise:
      /\b(ad|ads|advertisement|banner|breadcrumbs?|comment|comments|community|disqus|footer|gdpr|masthead|menu|outbrain|pagination|popular|recirc|recommend|related|replies|right[-_]col(umn)?|col(umn)?[-_]right|rail|rails|rss|share|shoutbox|sidebar|sidebars|skyscraper|social|sponsor|sponsored|taboola|tags|toolbar|trending|widget|widgets)\b|[-_](ad|ads|sidebar|rail|recirc|popular|trending|widget)[-_]/i,
    positive:
      /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i,
    negative:
      /-ad-|hidden|^hid$\vert{} hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i,
    commas: /\u002C|\u060C|\uFE50|\uFE10|\uFE11|\u2E41|\u2E34|\u2E32|\uFF0C/g,
  }

  const HIGHLIGHT_CLASS = "para-scroller-active-focus"

  // ==========================================================================
  // 2. State Management
  // ==========================================================================
  const state = {
    isBlacklisted: false,
    scrollableElements: null,
    articleContainerEl: null,
    activeFocusedElement: null,
    isDirty: true,
    fixedAnchorTop: null,
    manualScrollOccurred: false,
    lastProgrammaticScrollTime: 0,
  }

  let domObserver = null

  // ==========================================================================
  // 3. Shared Helpers & Utilities
  // ==========================================================================
  function wildcardToRegExp(pattern) {
    if (!pattern) return null
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
    try {
      return new RegExp("^" + escaped + "$")
    } catch {
      return null
    }
  }

  function pruneAncestors(elements) {
    return elements.filter(
      (candidate) =>
        !elements.some(
          (other) => candidate !== other && candidate.contains(other),
        ),
    )
  }

  function sortByReadingOrder(elements) {
    return elements.sort((a, b) => {
      if (a === b) return 0
      const pos = a.compareDocumentPosition(b)
      return pos & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : pos & Node.DOCUMENT_POSITION_PRECEDING
          ? 1
          : 0
    })
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
      })
    }
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function hasChildBlock(el) {
    for (let i = 0; i < el.children.length; i++) {
      if (BLOCK_TAGS.has(el.children[i].tagName.toLowerCase())) return true
    }
    return false
  }

  function getIdentifierString(el) {
    if (!el) return ""
    const className =
      typeof el.className === "string"
        ? el.className
        : el.className?.baseVal || ""
    const id = typeof el.id === "string" ? el.id : ""
    const label = el.getAttribute("aria-label") || ""
    const testId = el.getAttribute("data-testid") || ""
    const component = el.getAttribute("data-component") || ""
    const role = el.getAttribute("role") || ""
    return `${className} ${id} ${label} ${testId} ${component} ${role}`
  }

  function calcLinkDensity(el) {
    if (!el) return 0
    const total = el.textContent.trim().length
    if (total === 0) return 0
    let linkChars = 0
    const links = el.getElementsByTagName("a")
    for (let i = 0; i < links.length; i++) {
      linkChars += links[i].textContent.trim().length
    }
    return Math.min(1, Math.max(0, linkChars / total))
  }

  // ==========================================================================
  // 4. Double-BR Normalizer (WSJ Paywall Paragraph Splitter)
  // ==========================================================================
  function splitParagraphOnDoubleBrs(p) {
    const brs = p.querySelectorAll("br")
    if (brs.length < 2) return

    const chunks = []
    let currentChunk = []
    let consecutiveBrs = 0

    for (let i = 0; i < p.childNodes.length; i++) {
      const node = p.childNodes[i]

      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "BR") {
        consecutiveBrs++
      } else if (
        node.nodeType === Node.TEXT_NODE &&
        node.nodeValue.trim().length === 0
      ) {
        if (consecutiveBrs === 0) currentChunk.push(node)
      } else {
        if (consecutiveBrs >= 2) {
          if (currentChunk.length > 0) {
            chunks.push(currentChunk)
            currentChunk = []
          }
        } else if (consecutiveBrs === 1) {
          currentChunk.push(document.createElement("br"))
        }
        consecutiveBrs = 0
        currentChunk.push(node)
      }
    }

    if (currentChunk.length > 0) chunks.push(currentChunk)
    if (chunks.length <= 1) return

    const parent = p.parentNode
    if (!parent) return

    for (const chunk of chunks) {
      const newP = p.cloneNode(false)
      newP.classList.remove(HIGHLIGHT_CLASS)
      for (const child of chunk) {
        newP.appendChild(child)
      }
      if (newP.textContent.trim().length > 0) {
        parent.insertBefore(newP, p)
      }
    }

    parent.removeChild(p)
  }

  function normalizeParagraphBreaks(containerEl) {
    const paragraphs = Array.from(containerEl.querySelectorAll("p"))
    let modified = false

    for (const p of paragraphs) {
      if (p.querySelector("br")) {
        splitParagraphOnDoubleBrs(p)
        modified = true
      }
    }

    if (modified && domObserver) {
      domObserver.takeRecords()
    }
  }

  // ==========================================================================
  // 5. Blacklist Service
  // ==========================================================================
  async function checkBlacklist() {
    try {
      const data = await browser.storage.local.get(["blacklist"])
      const blacklist = Array.isArray(data?.blacklist) ? data.blacklist : []
      const currentUrl = window.location.href

      state.isBlacklisted = blacklist.some((pattern) => {
        const regex = wildcardToRegExp(pattern)
        return regex ? regex.test(currentUrl) : false
      })

      if (state.isBlacklisted && state.activeFocusedElement) {
        state.activeFocusedElement.classList.remove(HIGHLIGHT_CLASS)
        state.activeFocusedElement = null
      }
    } catch (_) {}
  }

  checkBlacklist()
  if (browser?.storage?.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.blacklist) checkBlacklist()
    })
  }

  // ==========================================================================
  // 6. Generic Noise & Filter Engine
  // ==========================================================================
  function isNoiseElement(el) {
    if (!el || el === document.body || el === document.documentElement)
      return false

    // Standard structural navigation and interactive landmarks
    const landmark = el.closest(
      'nav, footer, form, [role="navigation"], [role="complementary"], [role="toolbar"]',
    )
    if (
      landmark &&
      landmark !== document.body &&
      landmark !== document.documentElement
    ) {
      return true
    }

    // Evaluate <aside> tags: allow verified lead media, prune all other asides/sidebars
    const aside = el.closest("aside")
    if (aside && aside !== document.body) {
      const isLeadMedia =
        aside.hasAttribute("islead") ||
        (typeof aside.className === "string" &&
          aside.className.includes("lead")) ||
        Boolean(
          aside.closest(
            '[data-testid*="lead-media" i], [class*="lead-media" i]',
          ),
        )
      if (!isLeadMedia) return true
    }

    // Walk up the DOM tree and check unified component identifiers against the noise dictionary
    let curr = el
    while (
      curr &&
      curr !== document.body &&
      curr !== document.documentElement
    ) {
      if (curr.tagName === "ARTICLE" || curr.tagName === "MAIN") break
      const identifiers = getIdentifierString(curr)
      if (REGEXPS.noise.test(identifiers)) {
        return true
      }
      curr = curr.parentElement
    }

    return false
  }

  function getClassWeight(el) {
    let weight = 0
    const identifiers = getIdentifierString(el)
    if (identifiers) {
      if (REGEXPS.negative.test(identifiers)) weight -= 25
      if (REGEXPS.positive.test(identifiers)) weight += 25
    }
    return weight
  }

  function isQualifiedTextLeaf(el) {
    if (!isVisible(el) || isNoiseElement(el)) return false
    if (el.tagName === "A" || el.closest("a")) return false

    const text = el.textContent.trim()
    if (text.length < 25 || calcLinkDensity(el) > 0.45) return false

    let directTextLength = 0
    let hasBlock = false

    for (let node = el.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === Node.TEXT_NODE) {
        directTextLength += node.nodeValue.trim().length
      } else if (
        node.nodeType === Node.ELEMENT_NODE &&
        BLOCK_TAGS.has(node.tagName.toLowerCase())
      ) {
        hasBlock = true
      }
    }

    return !hasBlock || directTextLength > 20
  }

  function genericFilter(el) {
    if (!isVisible(el) || isNoiseElement(el)) return false

    if (el.closest('button, [role="button"], [role="toolbar"]')) {
      return false
    }
    if (el.tagName === "A" || el.closest("a")) return false

    const tag = el.tagName.toLowerCase()
    const rect = el.getBoundingClientRect()

    if (tag === "img" || tag === "picture" || tag === "figure")
      return rect.width >= 60 && rect.height >= 60
    if (tag === "svg") return rect.width >= 100 && rect.height >= 80

    const text = el.textContent.trim()
    if (text.length === 0 || calcLinkDensity(el) > 0.65) return false

    // Discard headings that reside inside link-heavy promo cards
    if (/^h[1-6]$/.test(tag)) {
      if (el.parentElement && calcLinkDensity(el.parentElement) > 0.6)
        return false
      return true
    }

    if (tag === "div") return !hasChildBlock(el) && text.length >= 25
    if (text.length < 15 && !el.closest("p, blockquote, figcaption"))
      return false

    return true
  }

  // ==========================================================================
  // 7. Article Container & Target Extraction
  // ==========================================================================
  function findMainContentContainer() {
    const candidates = Array.from(
      document.querySelectorAll(
        "p, div, section, li, blockquote, article, h1, h2, h3",
      ),
    ).filter(isQualifiedTextLeaf)
    if (candidates.length === 0) return document.body

    const containerScores = new Map()

    candidates.forEach((leaf) => {
      const text = leaf.textContent.trim()
      const commaCount = (text.match(REGEXPS.commas) || []).length
      const contentScore =
        1 + commaCount + Math.min(Math.floor(text.length / 100), 3)

      let current = leaf.parentElement
      let depth = 0
      let weight = 1.0

      while (
        current &&
        current !== document.body &&
        current !== document.documentElement &&
        depth < CONFIG.maxAncestorDepth
      ) {
        const entry = containerScores.get(current) || {
          score: 0,
          leaves: new Set(),
        }
        entry.score += contentScore * weight
        entry.leaves.add(leaf)
        containerScores.set(current, entry)

        weight *= CONFIG.ancestorWeightDecay
        depth++
        current = current.parentElement
      }
    })

    const evaluated = []
    for (const [container, data] of containerScores.entries()) {
      let finalScore = data.score + getClassWeight(container)
      if (data.leaves.size > 1)
        finalScore *= 1 + Math.log2(data.leaves.size) * 0.25

      const tag = container.tagName.toLowerCase()
      const id = container.id.toLowerCase()
      if (
        tag === "article" ||
        tag === "main" ||
        id === "main" ||
        container.getAttribute("role") === "main"
      ) {
        finalScore *= 1.4
      } else if (tag === "section" || id === "content") {
        finalScore *= 1.2
      }

      const linkDensity = calcLinkDensity(container)
      if (linkDensity > 0.45) continue
      finalScore *= 1 - linkDensity

      evaluated.push({ container, score: finalScore, count: data.leaves.size })
    }

    if (evaluated.length === 0) return document.body

    evaluated.sort((a, b) => b.score - a.score)
    let best = evaluated[0]

    const isSemanticBest =
      best.container.tagName === "ARTICLE" || best.container.tagName === "MAIN"

    for (const candidate of evaluated) {
      if (
        candidate.container.contains(best.container) &&
        candidate.container !== best.container
      ) {
        const isSemanticCandidate =
          candidate.container.tagName === "ARTICLE" ||
          candidate.container.tagName === "MAIN"
        if (isSemanticBest && !isSemanticCandidate) continue

        // Subsume into common ancestor only if it unifies disparate rows (+50% or more content)
        if (candidate.count >= best.count * 1.5) {
          best = candidate
        }
      }
    }

    return best.container
  }

  function extractTargetsFromContainer(containerEl) {
    normalizeParagraphBreaks(containerEl)

    const textElements = Array.from(
      containerEl.querySelectorAll(TEXT_SELECTOR),
    ).filter(genericFilter)

    if (!textElements.some((el) => el.tagName === "H1")) {
      const pageH1 = document.querySelector("h1")
      if (pageH1 && genericFilter(pageH1)) {
        const articleRoot =
          containerEl.closest('main, [role="main"], #main, #content, body') ||
          document.body
        if (articleRoot.contains(pageH1)) textElements.unshift(pageH1)
      }
    }

    const cleanTextElements = pruneAncestors(textElements)
    const mediaElements = Array.from(
      containerEl.querySelectorAll(MEDIA_SELECTOR),
    )
      .filter(genericFilter)
      .filter(
        (el) =>
          !cleanTextElements.some(
            (txtEl) => txtEl.contains(el) || el.contains(txtEl),
          ),
      )

    const cleanMediaElements = pruneAncestors(mediaElements)
    return cleanTextElements.concat(cleanMediaElements)
  }

  function updateScrollableElements() {
    const readerRoot = document.getElementById("foxy-rinna-root")
    if (readerRoot) {
      const rawElements = Array.from(
        readerRoot.querySelectorAll(
          "#foxy-rinna-title, #foxy-rinna-content p, #foxy-rinna-content h1, #foxy-rinna-content h2, #foxy-rinna-content h3, #foxy-rinna-content h4, #foxy-rinna-content h5, #foxy-rinna-content h6, #foxy-rinna-content blockquote, #foxy-rinna-content li, #foxy-rinna-content figcaption",
        ),
      ).filter(genericFilter)
      state.scrollableElements = sortByReadingOrder(pruneAncestors(rawElements))
      return
    }

    state.articleContainerEl = findMainContentContainer()
    state.scrollableElements = sortByReadingOrder(
      extractTargetsFromContainer(state.articleContainerEl),
    )
  }

  // ==========================================================================
  // 8. Navigation Engine
  // ==========================================================================
  function injectHighlightStyles() {
    const style = document.createElement("style")
    style.id = "para-scroller-focus-style"
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        background-color: rgba(59, 130, 246, 0.14) !important;
        border-radius: 8px !important;
        transition: background-color 0.15s ease-out !important;
      }
    `
    ;(document.head || document.documentElement).appendChild(style)
  }

  function getScrollContainer() {
    const readerRoot = document.getElementById("foxy-rinna-root")
    return readerRoot && readerRoot.scrollHeight > readerRoot.clientHeight
      ? readerRoot
      : window
  }

  function setFocus(el) {
    if (state.activeFocusedElement && state.activeFocusedElement !== el) {
      state.activeFocusedElement.classList.remove(HIGHLIGHT_CLASS)
    }
    state.activeFocusedElement = el
    if (state.activeFocusedElement) {
      state.activeFocusedElement.classList.add(HIGHLIGHT_CLASS)
    }
  }

  function resolveNextStepTarget(currentEl, direction) {
    const currentIdx = state.scrollableElements.indexOf(currentEl)
    if (currentIdx === -1) return null

    const currentTop = currentEl.getBoundingClientRect().top
    let nextIdx = currentIdx + direction

    while (nextIdx >= 0 && nextIdx < state.scrollableElements.length) {
      const { top } = state.scrollableElements[nextIdx].getBoundingClientRect()
      const dist = (top - currentTop) * direction

      // 1. Meaningful vertical progression in the direction of reading
      if (dist >= CONFIG.minStepDelta) return state.scrollableElements[nextIdx]
      nextIdx += direction
    }
    return null
  }

  function findClosestViewportTarget(direction) {
    const sign = direction === 1 ? 1 : -1
    let bestIdx = -1
    let bestDist = Infinity

    for (let i = 0; i < state.scrollableElements.length; i++) {
      const { top, bottom } =
        state.scrollableElements[i].getBoundingClientRect()
      const dist = top - CONFIG.minTop

      if (dist * sign < 0) {
        if (direction === 1) continue
        else if (bottom > CONFIG.minTop) {
          bestIxd = i
          break
        }
      }
      const absDist = Math.abs(dist)

      if (absDist < bestDist) {
        bestDist = absDist
        bestIdx = i
      }
    }
    if (bestIdx === -1) return null
    return state.scrollableElements[bestIdx]
  }

  function scrollToParagraph(direction) {
    if (
      state.isDirty ||
      !state.scrollableElements ||
      state.scrollableElements.length === 0
    ) {
      state.isDirty = false
      updateScrollableElements()
    }
    if (!state.scrollableElements || state.scrollableElements.length === 0)
      return

    const isMarkOnScreen =
      state.activeFocusedElement &&
      isVisible(state.activeFocusedElement) &&
      state.activeFocusedElement.getBoundingClientRect().bottom > 0 &&
      state.activeFocusedElement.getBoundingClientRect().top <
        window.innerHeight

    let targetElement = null
    let targetTop = CONFIG.minTop

    if (isMarkOnScreen) {
      if (state.manualScrollOccurred || state.fixedAnchorTop === null) {
        const rawTop = Math.round(
          state.activeFocusedElement.getBoundingClientRect().top,
        )
        state.fixedAnchorTop = Math.max(
          CONFIG.minTop,
          Math.min(window.innerHeight - CONFIG.maxTopToScreenBottom, rawTop),
        )
        state.manualScrollOccurred = false
      }
      targetTop = state.fixedAnchorTop
      targetElement = resolveNextStepTarget(
        state.activeFocusedElement,
        direction,
      )
    } else {
      targetElement = findClosestViewportTarget(direction)
      state.fixedAnchorTop = CONFIG.minTop
      state.manualScrollOccurred = false
    }

    if (!targetElement) return

    setFocus(targetElement)

    const finalDelta = targetElement.getBoundingClientRect().top - targetTop
    if (Math.abs(finalDelta) > CONFIG.subpixelThreshold) {
      state.lastProgrammaticScrollTime = Date.now()
      const container = getScrollContainer()
      container.scrollBy({ top: finalDelta, behavior: "smooth" })
    }
  }

  // ==========================================================================
  // 9. Event Subscriptions
  // ==========================================================================
  injectHighlightStyles()

  window.addEventListener(
    "scroll",
    () => {
      if (
        Date.now() - state.lastProgrammaticScrollTime >
        CONFIG.programmaticScrollCooldown
      ) {
        state.manualScrollOccurred = true
      }
    },
    { passive: true },
  )

  ;["wheel", "touchmove", "resize"].forEach((evt) => {
    window.addEventListener(
      evt,
      () => {
        state.manualScrollOccurred = true
      },
      { passive: true },
    )
  })

  domObserver = new MutationObserver(() => {
    state.isDirty = true
  })
  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  })

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat || state.isBlacklisted || e.altKey || e.ctrlKey || e.metaKey)
        return

      const active = document.activeElement
      const isTyping =
        active &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) ||
          active.isContentEditable ||
          active.getAttribute("role") === "textbox" ||
          Boolean(active.closest('[contenteditable="true"]')))
      if (isTyping) return

      if (e.code === "KeyJ") {
        e.preventDefault()
        scrollToParagraph(1)
      } else if (e.code === "KeyK") {
        e.preventDefault()
        scrollToParagraph(-1)
      }
    },
    true,
  )
})()

