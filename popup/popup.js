document.addEventListener('DOMContentLoaded', async () => {
    const blacklistEl = document.getElementById('blacklistEl');
    const emptyMsg = document.getElementById('emptyMsg');
    const addCurrentBtn = document.getElementById('addCurrentBtn');
    const editBtn = document.getElementById('editBtn');
    const customPatternInput = document.getElementById('customPatternInput');
    const addCustomBtn = document.getElementById('addCustomBtn');

    let isEditMode = false;
    let blacklist = [];
    let currentUrl = null;
    let activeTabUrl = '';

    // Safe tab URL extraction without throwing on restricted/about: pages
    try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url) {
            activeTabUrl = tab.url;
            if (tab.url.startsWith('http://') || tab.url.startsWith('https://')) {
                currentUrl = new URL(tab.url);
            }
        }
    } catch (err) {
        console.warn('Could not inspect active tab URL:', err);
    }

    function isUrlMatched(url, pattern) {
        if (!url || !pattern) return false;
        const regexStr = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
        try {
            return new RegExp(regexStr).test(url);
        } catch {
            return false;
        }
    }

    async function loadBlacklist() {
        const data = await browser.storage.local.get(['blacklist']);
        blacklist = Array.isArray(data.blacklist) ? data.blacklist : [];
        render();
    }

    function render() {
        blacklistEl.innerHTML = '';

        if (blacklist.length === 0) {
            emptyMsg.style.display = 'block';
            editBtn.style.display = 'none';
            if (isEditMode) {
                isEditMode = false;
                editBtn.textContent = 'Edit';
            }
        } else {
            emptyMsg.style.display = 'none';
            editBtn.style.display = 'inline-block';
            editBtn.textContent = isEditMode ? 'Done' : 'Edit';

            blacklist.forEach((pattern, index) => {
                const li = document.createElement('li');
                li.className = 'list-item';

                if (isEditMode) {
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'pattern-input';
                    input.value = pattern;

                    input.addEventListener('change', (e) => {
                        const val = e.target.value.trim();
                        if (val) {
                            blacklist[index] = val;
                        }
                    });

                    const delBtn = document.createElement('button');
                    delBtn.className = 'delete-btn';
                    delBtn.innerHTML = '&times;';
                    delBtn.title = 'Delete';
                    delBtn.addEventListener('click', async () => {
                        blacklist.splice(index, 1);
                        await browser.storage.local.set({ blacklist });
                        render();
                    });

                    li.appendChild(input);
                    li.appendChild(delBtn);
                } else {
                    const span = document.createElement('span');
                    span.className = 'pattern-text';
                    span.textContent = pattern;
                    li.appendChild(span);
                }

                blacklistEl.appendChild(li);
            });
        }

        // Toggle button state if active tab is already matched
        if (activeTabUrl) {
            const alreadyBlacklisted = blacklist.some((p) => isUrlMatched(activeTabUrl, p));
            if (alreadyBlacklisted) {
                addCurrentBtn.textContent = 'Site is Blacklisted';
                addCurrentBtn.disabled = true;
                addCurrentBtn.style.opacity = '0.6';
            } else {
                addCurrentBtn.textContent = 'Add Current Site';
                addCurrentBtn.disabled = false;
                addCurrentBtn.style.opacity = '1';
            }
        } else {
            addCurrentBtn.disabled = true;
            addCurrentBtn.style.opacity = '0.6';
        }
    }

    // Commit edited input values to storage
    async function saveEdits() {
        const inputs = blacklistEl.querySelectorAll('.pattern-input');
        const updated = [];
        inputs.forEach((input) => {
            const val = input.value.trim();
            if (val && !updated.includes(val)) {
                updated.push(val);
            }
        });

        blacklist = updated;
        await browser.storage.local.set({ blacklist });
    }

    // Add a pattern to the list and sync storage
    async function addPattern(rawPattern) {
        let pattern = rawPattern.trim();
        if (!pattern) return;

        if (!pattern.includes('*')) {
            pattern = `*${pattern}*`;
        }

        try {
            compileWildcard(pattern); // Final validation pass
        } catch {
            return;
        }

        if (!blacklist.includes(pattern)) {
            blacklist.push(pattern);
            await browser.storage.local.set({ blacklist });
            render();
        }

        customPatternInput.value = '';
        testPatternInput(); // Resets validation styling and status text
    }

    // Toggle Edit/Done mode
    editBtn.addEventListener('click', async () => {
        if (isEditMode) {
            await saveEdits();
            isEditMode = false;
            render();
        } else {
            isEditMode = true;
            render();
        }
    });

    // Add current site hostname
    addCurrentBtn.addEventListener('click', async () => {
        if (!currentUrl || !currentUrl.hostname) return;
        await addPattern(`*${currentUrl.hostname}*`);
    });

    // Add custom pattern handlers
    addCustomBtn.addEventListener('click', () => {
        addPattern(customPatternInput.value);
    });

    customPatternInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addPattern(customPatternInput.value);
        }
    });

    const patternStatus = document.getElementById('patternStatus');

    // Convert a wildcard string to a RegExp object safely
    function compileWildcard(raw) {
        let pattern = raw.trim();
        if (!pattern) return null;
        if (!pattern.includes('*')) {
            pattern = `*${pattern}*`;
        }

        const regexStr = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
        return new RegExp(regexStr);
    }

    // Real-time syntax and active tab testing
    function testPatternInput() {
        const raw = customPatternInput.value.trim();

        customPatternInput.classList.remove('is-invalid', 'is-matching');
        patternStatus.textContent = '';
        patternStatus.className = 'pattern-status';

        if (!raw) {
            addCustomBtn.disabled = true;
            addCustomBtn.style.opacity = '0.6';
            return;
        }

        try {
            const regex = compileWildcard(raw);
            addCustomBtn.disabled = false;
            addCustomBtn.style.opacity = '1';

            if (activeTabUrl && regex.test(activeTabUrl)) {
                customPatternInput.classList.add('is-matching');
                patternStatus.classList.add('status-match');
                patternStatus.textContent = '✓ Matches current page';
            } else {
                patternStatus.classList.add('status-info');
                patternStatus.textContent = 'Valid pattern';
            }
        } catch (err) {
            customPatternInput.classList.add('is-invalid');
            patternStatus.classList.add('status-error');
            patternStatus.textContent = 'Invalid pattern syntax';
            addCustomBtn.disabled = true;
            addCustomBtn.style.opacity = '0.6';
        }
    }

    // Attach real-time input listener
    customPatternInput.addEventListener('input', testPatternInput);

    await loadBlacklist();
});