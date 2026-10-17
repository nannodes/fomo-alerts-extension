// © 2026 FOMO Alerts. All rights reserved.
// Toolbar popup: only explains where FOMO Alerts lives. Everything else (linking Telegram, access, alerts) is on
// fomo.family itself: the FOMO Alerts window in the profile menu, the card under Buy/Sell and the side-panel tab.
const $ = (id) => document.getElementById(id);
// opened as the options page (a tab) instead of the toolbar popup
if (location.search.includes('tab') || window.innerWidth > 500) document.body.classList.add('tab');
$('version').textContent = 'v' + chrome.runtime.getManifest().version;
$('open').addEventListener('click', async () => {
  // an open fomo.family tab is reused, else a new one
  const [tab] = await chrome.tabs.query({ url: 'https://fomo.family/*' }).catch(() => []);
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } else {
    await chrome.tabs.create({ url: 'https://fomo.family/' });
  }
  window.close();
});
