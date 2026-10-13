document.addEventListener("DOMContentLoaded", async () => {
  const elements = {
    list: document.getElementById("blacklistEl"),
    emptyMsg: document.getElementById("emptyMsg"),
    addCurrentBtn: document.getElementById("addCurrentBtn"),
    editBtn: document.getElementById("editBtn"),
    customInput: document.getElementById("customPatternInput"),
    addCustomBtn: document.getElementById("addCustomBtn"),
    status: document.getElementById("patternStatus"),
  }

  let isEditMode = false
  let blacklist = []
  let currentHostname = null
  let activeTabUrl = ""

  // Safe tab query without failing on restricted chrome:// or about: protocols
  try {
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    })
    if (tab?.url) {
      activeTabUrl = tab.url
      if (tab.url.startsWith("http://") || tab.url.startsWith("https://")) {
        currentHostname = new URL(tab.url).hostname
      }
    }
  } catch (err) {
    console.warn("Could not inspect active tab:", err)
  }

  function wildcardToRegExp(raw) {
    let pattern = (raw || "").trim()
    if (!pattern) return null
    if (!pattern.includes("*")) pattern = `*${pattern}*`
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
    try {
      return new RegExp("^" + escaped + "$")
    } catch {
      return null
    }
  }

  async function persistBlacklist(newList) {
    blacklist = newList
    await browser.storage.local.set({ blacklist })
    render()
  }

  function render() {
    elements.list.innerHTML = ""
    const hasItems = blacklist.length > 0

    elements.emptyMsg.style.display = hasItems ? "none" : "block"
    elements.editBtn.style.display = hasItems ? "inline-block" : "none"
    elements.editBtn.textContent = isEditMode ? "Done" : "Edit"

    if (!hasItems && isEditMode) isEditMode = false

    if (hasItems) {
      blacklist.forEach((pattern, index) => {
        const li = document.createElement("li")
        li.className = "list-item"

        if (isEditMode) {
          const input = document.createElement("input")
          input.type = "text"
          input.className = "pattern-input"
          input.value = pattern

          const delBtn = document.createElement("button")
          delBtn.className = "delete-btn"
          delBtn.innerHTML = "&times;"
          delBtn.title = "Delete"
          delBtn.addEventListener("click", () => {
            const updated = [...blacklist]
            updated.splice(index, 1)
            persistBlacklist(updated)
          })

          li.append(input, delBtn)
        } else {
          const span = document.createElement("span")
          span.className = "pattern-text"
          span.textContent = pattern
          li.appendChild(span)
        }
        elements.list.appendChild(li)
      })
    }

    if (activeTabUrl) {
      const isMatched = blacklist.some((pattern) => {
        const regex = wildcardToRegExp(pattern)
        return regex ? regex.test(activeTabUrl) : false
      })
      elements.addCurrentBtn.textContent = isMatched
        ? "Site is Blacklisted"
        : "Add Current Site"
      elements.addCurrentBtn.disabled = isMatched
      elements.addCurrentBtn.style.opacity = isMatched ? "0.6" : "1"
    } else {
      elements.addCurrentBtn.disabled = true
      elements.addCurrentBtn.style.opacity = "0.6"
    }
  }

  function testPatternInput() {
    const raw = elements.customInput.value.trim()
    elements.customInput.classList.remove("is-invalid", "is-matching")
    elements.status.textContent = ""
    elements.status.className = "pattern-status"

    if (!raw) {
      elements.addCustomBtn.disabled = true
      elements.addCustomBtn.style.opacity = "0.6"
      return
    }

    const regex = wildcardToRegExp(raw)
    if (!regex) {
      elements.customInput.classList.add("is-invalid")
      elements.status.classList.add("status-error")
      elements.status.textContent = "Invalid pattern syntax"
      elements.addCustomBtn.disabled = true
      elements.addCustomBtn.style.opacity = "0.6"
      return
    }

    elements.addCustomBtn.disabled = false
    elements.addCustomBtn.style.opacity = "1"

    if (activeTabUrl && regex.test(activeTabUrl)) {
      elements.customInput.classList.add("is-matching")
      elements.status.classList.add("status-match")
      elements.status.textContent = "✓ Matches current page"
    } else {
      elements.status.classList.add("status-info")
      elements.status.textContent = "Valid pattern"
    }
  }

  async function addPattern(rawPattern) {
    let pattern = (rawPattern || "").trim()
    if (!pattern) return
    if (!pattern.includes("*")) pattern = `*${pattern}*`
    if (!wildcardToRegExp(pattern)) return

    if (!blacklist.includes(pattern)) {
      await persistBlacklist([...blacklist, pattern])
    }
    elements.customInput.value = ""
    testPatternInput()
  }

  elements.editBtn.addEventListener("click", async () => {
    if (isEditMode) {
      const inputs = elements.list.querySelectorAll(".pattern-input")
      const updated = []
      inputs.forEach((input) => {
        const val = input.value.trim()
        if (val && !updated.includes(val) && wildcardToRegExp(val))
          updated.push(val)
      })
      isEditMode = false
      await persistBlacklist(updated)
    } else {
      isEditMode = true
      render()
    }
  })

  elements.addCurrentBtn.addEventListener("click", () => {
    if (currentHostname) addPattern(`*${currentHostname}*`)
  })

  elements.addCustomBtn.addEventListener("click", () =>
    addPattern(elements.customInput.value),
  )
  elements.customInput.addEventListener("input", testPatternInput)
  elements.customInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault()
      addPattern(elements.customInput.value)
    }
  })

  const stored = await browser.storage.local.get(["blacklist"])
  blacklist = Array.isArray(stored?.blacklist) ? stored.blacklist : []
  render()
})

