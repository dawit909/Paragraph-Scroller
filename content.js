; (() => {
  // --- Constants & Configuration ---
  const DEFAULT_CONFIG = { minTop: 60, maxTop: 220 }
  const TOLERANCE = 20
  const TEXT_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, details"
  const MEDIA_SELECTOR = "div, svg, img"
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
  ])
  const NOISE_SELECTOR = [
    "nav",
    "footer",
    "aside",
    '[role="navigation"]',
    '[role="complementary"]',
    '[role="toolbar"]',
    "form",
    '[class*="breadcrumb" i]',
    '[id*="breadcrumb" i]',
  ].join(", ")

  // --- Runtime State ---
  let siteConfig = { ...DEFAULT_CONFIG, exclusions: [] }
  let isBlacklisted = false
  let isPickerActive = false
  let shadowHost = null
  let scrollableElements = null
  let articleContainerEl = null
  let isDirty = true
  const isTest = true

  // --- Utility Helpers ---
  function getScrollContainer() {
    const readerRoot = document.getElementById("reader-root")
    return readerRoot && readerRoot.scrollHeight > readerRoot.clientHeight
      ? readerRoot
      : window
  }

  function isUrlMatched(url, pattern) {
    const regexStr =
      "^" +
      pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
      "$"
    try {
      return new RegExp(regexStr).test(url)
    } catch {
      return false
    }
  }

  function calcLinkDensity(el) {
    const total = el.textContent.trim().length
    if (total === 0) return 0
    let linkChars = 0
    const links = el.getElementsByTagName("a")
    for (let i = 0; i < links.length; i++) {
      linkChars += links[i].textContent.trim().length
    }
    return linkChars / total
  }

  function isExcludedByUser(el) {
    if (!siteConfig.exclusions || siteConfig.exclusions.length === 0)
      return false
    return siteConfig.exclusions.some((selector) => {
      try {
        return el.matches(selector) || el.closest(selector)
      } catch {
        return false
      }
    })
  }

  // --- Storage & Config Lifecycle ---
  async function loadConfig() {
    const hostname = window.location.hostname
    const currentUrl = window.location.href
    const data = await browser.storage.local.get([
      "blacklist",
      "defaults",
      "sites",
    ])

    const blacklist = data.blacklist || []
    isBlacklisted = blacklist.some((pattern) =>
      isUrlMatched(currentUrl, pattern),
    )
    if (isBlacklisted) return

    const defaults = data.defaults || DEFAULT_CONFIG
    const siteSettings = (data.sites && data.sites[hostname]) || {}

    siteConfig = {
      minTop: siteSettings.minTop ?? defaults.minTop,
      maxTop: siteSettings.maxTop ?? defaults.maxTop,
      exclusions: siteSettings.exclusions || [],
    }
  }

  loadConfig()
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local") loadConfig()
  })

  // --- Text Leaf Qualification (for Container Detection) ---
  function isQualifiedTextLeaf(el) {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
      return false
    if (el.closest(NOISE_SELECTOR)) return false
    if (el.tagName === "A" || el.closest("a")) return false

    const trimmed = el.textContent.trim()
    if (trimmed.length < 40 || !trimmed.includes(" ")) return false
    if (calcLinkDensity(el) > 0.45) return false

    let directTextLength = 0
    let hasBlockChild = false

    for (let node = el.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === Node.TEXT_NODE) {
        directTextLength += node.nodeValue.trim().length
      } else if (
        node.nodeType === Node.ELEMENT_NODE &&
        BLOCK_TAGS.has(node.tagName.toLowerCase())
      ) {
        hasBlockChild = true
      }
    }

    return !hasBlockChild || directTextLength > 35
  }

  // --- Heuristic Main Content Container Resolver ---
  function findMainContentContainer() {
    const containerScores = new Map()
    const candidates = Array.from(
      document.querySelectorAll("p, div, section, li, blockquote, article"),
    ).filter(isQualifiedTextLeaf)

    if (candidates.length === 0) return document.body

    candidates.forEach((leaf) => {
      const text = leaf.textContent.trim()
      const commaCount = (text.match(/,/g) || []).length
      const baseScore = 1 + Math.floor(text.length / 100) + commaCount * 1.5

      let current = leaf.parentElement
      let weight = 1.0
      let depth = 0

      while (
        current &&
        current !== document.body &&
        current !== document.documentElement &&
        depth < 10
      ) {
        const entry = containerScores.get(current) || {
          score: 0,
          leaves: new Set(),
        }
        entry.score += baseScore * weight
        entry.leaves.add(leaf)
        containerScores.set(current, entry)

        weight *= 0.82
        depth++
        current = current.parentElement
      }
    })

    const evaluated = []
    for (const [container, data] of containerScores.entries()) {
      let finalScore = data.score

      if (data.leaves.size > 1) {
        finalScore *= 1 + Math.log2(data.leaves.size) * 0.25
      }

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
      if (linkDensity > 0.4) continue

      finalScore *= 1 - linkDensity
      evaluated.push({ container, score: finalScore, leaves: data.leaves })
    }

    if (evaluated.length === 0) return document.body

    evaluated.sort((a, b) => b.score - a.score)
    let best = evaluated[0].container

    // Dominant-Child Narrowing (Prunes multi-column layout wrappers)
    let currentContainer = best
    while (currentContainer) {
      const directChildren = Array.from(currentContainer.children)
      const hasDirectProse = directChildren.some(
        (child) => child.tagName === "P" && isQualifiedTextLeaf(child),
      )
      if (hasDirectProse) break

      const totalLeaves =
        containerScores.get(currentContainer)?.leaves.size || 0
      if (totalLeaves === 0) break

      let dominantChild = null
      for (const child of directChildren) {
        const childLeaves = containerScores.get(child)?.leaves.size || 0
        if (childLeaves / totalLeaves >= 0.7) {
          dominantChild = child
          break
        }
      }

      if (dominantChild) {
        currentContainer = dominantChild
      } else {
        break
      }
    }

    return currentContainer
  }

  // --- Scroll Target Filtering & Extraction ---
  function genericFilter(el) {
    const rect = el.getBoundingClientRect()
    if (rect.height === 0 || rect.width === 0) return false
    if (el.closest(NOISE_SELECTOR)) return false
    if (el.tagName === "A" || el.closest("a")) return false
    if (isExcludedByUser(el)) return false

    const text = el.textContent.trim()
    if (text.length > 0 && text.length < 20) return false
    if (calcLinkDensity(el) > 0.5) return false

    return true
  }

  function extractScrollTargets(containerEl) {
    const textElements = Array.from(containerEl.querySelectorAll(TEXT_SELECTOR))
      .filter((el) => el.textContent.trim().length > 0)
      .filter(genericFilter)

    const mediaElements = Array.from(
      containerEl.querySelectorAll(MEDIA_SELECTOR),
    )
      .filter(genericFilter)
      .filter((el) => !textElements.some((txtEl) => el.contains(txtEl)))

    const len = mediaElements.length
    let filteredMediaEls = mediaElements.filter((el1) => {
      const descenCnt = mediaElements.reduce((cnt, el2) => {
        return el1 !== el2 && el1.contains(el2) ? cnt + 1 : cnt
      }, 0)
      return !(descenCnt > 19 || descenCnt / len > 0.5)
    })

    filteredMediaEls = filteredMediaEls.filter((el1) => {
      return !filteredMediaEls.some((el2) => el1 !== el2 && el2.contains(el1))
    })

    return textElements.concat(filteredMediaEls)
  }

  // --- Target Element Collector ---
  function updateScrollableElements() {
    const readerRoot = document.getElementById("reader-root")

    // Scoped resolution for Reader Mode
    if (readerRoot) {
      const rawElements = Array.from(
        readerRoot.querySelectorAll(
          "#reader-title, #reader-content p, #reader-content h1, #reader-content h2, #reader-content h3, #reader-content h4, #reader-content h5, #reader-content h6, #reader-content blockquote, #reader-content li",
        ),
      )

      scrollableElements = rawElements.filter((el) => {
        const rect = el.getBoundingClientRect()
        return (
          rect.height > 0 &&
          rect.width > 0 &&
          el.textContent.trim().length > 0 &&
          !isExcludedByUser(el)
        )
      })
      return
    }

    // Standard DOM resolution
    articleContainerEl = findMainContentContainer()
    scrollableElements = extractScrollTargets(articleContainerEl)

    if (isTest && scrollableElements) {
      for (let i = 0; i < scrollableElements.length; i++) {
        scrollableElements[i].style.borderStyle = "solid"
        scrollableElements[i].style.borderColor = "red"
        scrollableElements[i].style.borderWidth = "medium"
      }
    }
  }

  // Mutation-aware cache dirtying
  new MutationObserver(() => {
    isDirty = true
  }).observe(document.documentElement, { childList: true, subtree: true })

  // --- Active Element Resolver ---
  function getCurrentIndex(elements, minTop, direction) {
    const sign = direction === 1 ? 1 : -1
    let bestIdx = -1
    let bestDist = Infinity

    for (let i = 0; i < elements.length; i++) {
      const top = elements[i].getBoundingClientRect().top
      const dist = top - minTop

      if (dist * sign < 0) continue
      const absDist = Math.abs(dist)
      if (absDist < bestDist) {
        bestDist = absDist
        bestIdx = i
      }
    }
    return bestIdx
  }

  // --- Scrolling Engine ---
  function scrollToParagraph(direction) {
    if (isDirty || !scrollableElements) {
      isDirty = false
      updateScrollableElements()
    }
    if (!scrollableElements || scrollableElements.length === 0) return

    const { minTop } = siteConfig
    const scrollContainer = getScrollContainer()

    let targetIdx = getCurrentIndex(scrollableElements, minTop, direction)
    if (targetIdx === -1) return

    let targetElement = scrollableElements[targetIdx]
    let delta = targetElement.getBoundingClientRect().top - minTop

    if (Math.abs(delta) <= 30) {
      const offsetMinTop = direction === 1 ? minTop + 30 : minTop - 30
      targetIdx = getCurrentIndex(scrollableElements, offsetMinTop, direction)
      if (targetIdx === -1) return
      targetElement = scrollableElements[targetIdx]
      delta = targetElement.getBoundingClientRect().top - minTop
    }

    if (scrollContainer === window) {
      window.scrollBy({ top: delta, behavior: "smooth" })
    } else {
      scrollContainer.scrollBy({ top: delta, behavior: "smooth" })
    }
  }

  // --- Keyboard Shortcuts (Capture Phase) ---
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat || isBlacklisted || isPickerActive) return

      const active = document.activeElement
      const isTyping =
        active &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) ||
          active.isContentEditable)
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

  // --- Visual Threshold Bars (Isolated Shadow DOM) ---
  function toggleThresholdUI() {
    if (shadowHost) {
      shadowHost.remove()
      shadowHost = null
      return
    }

    shadowHost = document.createElement("div")
    shadowHost.id = "para-scroller-ui-host"
    shadowHost.style.position = "relative"
    shadowHost.style.zIndex = "2147483647"
    document.documentElement.appendChild(shadowHost)

    const shadow = shadowHost.attachShadow({ mode: "closed" })
    const container = document.createElement("div")

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
    `

    shadow.appendChild(container)

    const minBar = shadow.getElementById("minBar")
    const maxBar = shadow.getElementById("maxBar")
    const minVal = shadow.getElementById("minVal")
    const maxVal = shadow.getElementById("maxVal")

    function makeDraggable(bar, valEl, isMin) {
      let isDragging = false

      bar.addEventListener("mousedown", (e) => {
        isDragging = true
        e.preventDefault()
      })

      window.addEventListener("mousemove", (e) => {
        if (!isDragging) return
        let y = Math.max(0, Math.min(window.innerHeight, e.clientY))

        if (isMin) {
          y = Math.min(y, siteConfig.maxTop - 10)
          siteConfig.minTop = y
        } else {
          y = Math.max(y, siteConfig.minTop + 10)
          siteConfig.maxTop = y
        }

        bar.style.top = `${y}px`
        valEl.textContent = y
      })

      window.addEventListener("mouseup", async () => {
        if (!isDragging) return
        isDragging = false

        const hostname = window.location.hostname
        const data = await browser.storage.local.get(["sites"])
        const sites = data.sites || {}
        sites[hostname] = {
          ...sites[hostname],
          minTop: siteConfig.minTop,
          maxTop: siteConfig.maxTop,
        }
        await browser.storage.local.set({ sites })
      })
    }

    makeDraggable(minBar, minVal, true)
    makeDraggable(maxBar, maxVal, false)

    shadow.getElementById("closeBtn").addEventListener("click", () => {
      toggleThresholdUI()
    })
  }

  // --- Element Picker Mode ---
  function getUniqueSelector(el) {
    if (!el || el === document.body || el === document.documentElement)
      return null
    if (el.id) return `#${CSS.escape(el.id)}`

    const path = []
    let curr = el
    while (
      curr &&
      curr.nodeType === Node.ELEMENT_NODE &&
      curr !== document.body &&
      curr !== document.documentElement
    ) {
      let tag = curr.tagName.toLowerCase()
      if (curr.className && typeof curr.className === "string") {
        const firstClass = curr.className.trim().split(/\s+/)[0]
        if (firstClass && !firstClass.includes(":")) {
          tag += `.${CSS.escape(firstClass)}`
        }
      }
      let sibling = curr
      let nth = 1
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === curr.tagName) nth++
      }
      tag += `:nth-of-type(${nth})`
      path.unshift(tag)
      if (path.length >= 3) break
      curr = curr.parentElement
    }
    return path.join(" > ")
  }

  function activatePicker() {
    isPickerActive = true
    const readerRoot = document.getElementById("reader-root")
    const cursorTarget = readerRoot || document.body
    cursorTarget.style.cursor = "crosshair"

    const onHover = (e) => {
      if (!isPickerActive) return
      e.target.style.outline = "2px dashed #e11d48"
      e.target.style.outlineOffset = "-2px"
    }

    const onLeave = (e) => {
      e.target.style.outline = ""
    }

    const onClick = async (e) => {
      if (!isPickerActive) return
      e.preventDefault()
      e.stopPropagation()

      e.target.style.outline = ""
      cursorTarget.style.cursor = "default"
      isPickerActive = false

      document.removeEventListener("mouseover", onHover, true)
      document.removeEventListener("mouseout", onLeave, true)
      document.removeEventListener("click", onClick, true)

      const selector = getUniqueSelector(e.target)
      if (!selector) return

      const hostname = window.location.hostname
      const data = await browser.storage.local.get(["sites"])
      const sites = data.sites || {}
      const currentExclusions = sites[hostname]?.exclusions || []

      if (!currentExclusions.includes(selector)) {
        currentExclusions.push(selector)
        sites[hostname] = {
          ...sites[hostname],
          exclusions: currentExclusions,
        }
        await browser.storage.local.set({ sites })
        siteConfig.exclusions = currentExclusions
      }
    }

    document.addEventListener("mouseover", onHover, true)
    document.addEventListener("mouseout", onLeave, true)
    document.addEventListener("click", onClick, true)
  }

  // --- Message Bus Listener ---
  browser.runtime.onMessage.addListener((message) => {
    if (message.command === "TOGGLE_BARS") {
      toggleThresholdUI()
    } else if (message.command === "START_PICKER") {
      activatePicker()
    }
  })
})()

