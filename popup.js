const DEFAULTS = { excludeUB: false, usd: true, eur: true };

chrome.storage.sync.get(DEFAULTS).then((opts) => {
  for (const key of Object.keys(DEFAULTS)) {
    const box = document.getElementById(key);
    box.checked = opts[key];
    box.addEventListener('change', () => chrome.storage.sync.set({ [key]: box.checked }));
  }
});

document.getElementById('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  document.getElementById('status').textContent = 'Cleared — reload the page';
});
