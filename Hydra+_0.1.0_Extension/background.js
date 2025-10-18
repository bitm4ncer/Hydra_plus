const BRIDGE_URL = 'http://127.0.0.1:3847';

// Create context menu when extension is installed
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'nicotine-search',
    title: 'Nicotine+ Search',
    contexts: ['selection']
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'nicotine-search' && info.selectionText) {
    const query = info.selectionText.trim();

    try {
      const response = await fetch(`${BRIDGE_URL}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: query,
          artist: '',
          track: '',
          duration: 0,
          auto_download: false
        })
      });

      if (response.ok) {
        // Show success notification
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icon/icon-48.png',
          title: 'Nicotine+ Search',
          message: `Search sent: "${query}"`,
          priority: 1
        });
      } else {
        throw new Error('Bridge server error');
      }
    } catch (error) {
      // Show error notification
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon/icon-48.png',
        title: 'Nicotine+ Search Failed',
        message: 'Could not connect to bridge server',
        priority: 2
      });
    }
  }
});
