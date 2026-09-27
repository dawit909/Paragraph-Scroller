document.addEventListener('DOMContentLoaded', async () => {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || !activeTab.url) return;

    const url = new URL(activeTab.url);
    const hostname = url.hostname;
    document.getElementById('siteDomain').textContent = hostname;

    // --- Bridge to Content Script ---
    async function sendMessageToTab(command) {
        try {
            await browser.tabs.sendMessage(activeTab.id, { command });
            window.close();
        } catch {
            alert('Cannot run on this page (ensure you are not on an internal or restricted browser page).');
        }
    }

    document.getElementById('toggleBarsBtn').addEventListener('click', () => {
        sendMessageToTab('TOGGLE_BARS');
    });

    document.getElementById('startPickerBtn').addEventListener('click', () => {
        sendMessageToTab('START_PICKER');
    });

    // --- Render Exclusions & Blacklist ---
    async function refreshUI() {
        const data = await browser.storage.local.get(['sites', 'blacklist']);
        const sites = data.sites || {};
        const exclusions = sites[hostname]?.exclusions || [];
        const blacklist = data.blacklist || [];

        // Render exclusions
        const exclusionContainer = document.getElementById('exclusionList');
        exclusionContainer.innerHTML = '';
        if (exclusions.length === 0) {
            exclusionContainer.innerHTML = '<span class="empty-state">No exclusions set for this site.</span>';
        } else {
            exclusions.forEach((sel, index) => {
                const row = document.createElement('div');
                row.className = 'item-row';
                row.innerHTML = `
          <span title="${sel}">${sel}</span>
          <button class="delete-btn" data-type="exclusion" data-index="${index}">&times;</button>
        `;
                exclusionContainer.appendChild(row);
            });
        }

        // Render blacklist
        const blacklistContainer = document.getElementById('blacklistView');
        blacklistContainer.innerHTML = '';
        if (blacklist.length === 0) {
            blacklistContainer.innerHTML = '<span class="empty-state">No rules registered.</span>';
        } else {
            blacklist.forEach((rule, index) => {
                const row = document.createElement('div');
                row.className = 'item-row';
                row.innerHTML = `
          <span title="${rule}">${rule}</span>
          <button class="delete-btn" data-type="blacklist" data-index="${index}">&times;</button>
        `;
                blacklistContainer.appendChild(row);
            });
        }
    }

    // --- Add to Blacklist ---
    document.getElementById('addBlacklistBtn').addEventListener('click', async () => {
        const input = document.getElementById('blacklistInput');
        const val = input.value.trim();
        if (!val) return;

        const data = await browser.storage.local.get(['blacklist']);
        const blacklist = data.blacklist || [];
        if (!blacklist.includes(val)) {
            blacklist.push(val);
            await browser.storage.local.set({ blacklist });
        }
        input.value = '';
        refreshUI();
    });

    // --- Deletion Delegate ---
    document.addEventListener('click', async (e) => {
        if (!e.target.classList.contains('delete-btn')) return;
        const type = e.target.dataset.type;
        const index = parseInt(e.target.dataset.index, 10);

        if (type === 'exclusion') {
            const data = await browser.storage.local.get(['sites']);
            const sites = data.sites || {};
            if (sites[hostname]?.exclusions) {
                sites[hostname].exclusions.splice(index, 1);
                await browser.storage.local.set({ sites });
            }
        } else if (type === 'blacklist') {
            const data = await browser.storage.local.get(['blacklist']);
            const blacklist = data.blacklist || [];
            blacklist.splice(index, 1);
            await browser.storage.local.set({ blacklist });
        }
        refreshUI();
    });

    // --- Reset Site Settings ---
    document.getElementById('resetSiteBtn').addEventListener('click', async () => {
        const data = await browser.storage.local.get(['sites']);
        const sites = data.sites || {};
        delete sites[hostname];
        await browser.storage.local.set({ sites });
        refreshUI();
    });

    refreshUI();
});