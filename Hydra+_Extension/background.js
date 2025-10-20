const BRIDGE_URL = 'http://127.0.0.1:3847';
const POLL_INTERVAL = 3000; // Poll every 3 seconds

let lastEventId = 0;
let pollInterval = null;
let serverWasOffline = false; // Track server state to detect restarts

// Load last event ID from storage
chrome.storage.local.get(['lastEventId'], (data) => {
  if (data.lastEventId) {
    lastEventId = data.lastEventId;
    console.log('[Hydra+ BG] Loaded lastEventId from storage:', lastEventId);
  }
});

// Poll bridge server for events in background
async function pollEvents() {
  try {
    const response = await fetch(`${BRIDGE_URL}/status`, {
      method: 'GET',
      mode: 'cors'
    });

    if (response.ok) {
      const data = await response.json();

      // CRITICAL FIX: Detect server restart by checking if event IDs decreased
      // If server restarted, eventIdCounter resets to 0, so we need to reset our tracking
      if (data.events && Array.isArray(data.events) && data.events.length > 0) {
        const maxServerEventId = Math.max(...data.events.map(e => e.id));

        // If server came back online OR if event IDs went backwards (server restart)
        if (serverWasOffline || (maxServerEventId < lastEventId && maxServerEventId < 10)) {
          console.log('[Hydra+ BG] Server restart detected! Resetting lastEventId');
          console.log('[Hydra+ BG] Old lastEventId:', lastEventId, 'New max server ID:', maxServerEventId);
          lastEventId = 0; // Reset to catch all new events
          chrome.storage.local.set({ lastEventId: 0 });
          serverWasOffline = false;
        }
      }

      // Process events if provided by server
      if (data.events && Array.isArray(data.events)) {
        // Filter out events we've already seen
        const newEvents = data.events.filter(event => event.id > lastEventId);

        console.log('[Hydra+ BG] Poll result:', {
          totalEvents: data.events.length,
          newEvents: newEvents.length,
          lastEventId: lastEventId,
          serverEventIds: data.events.map(e => e.id).join(', ')
        });

        if (newEvents.length > 0) {
          // Update last event ID
          newEvents.forEach(event => {
            if (event.id > lastEventId) {
              lastEventId = event.id;
            }
          });

          // Store last event ID
          chrome.storage.local.set({ lastEventId: lastEventId });

          // Load existing console events from storage
          chrome.storage.local.get(['consoleEvents'], (storageData) => {
            let consoleEvents = storageData.consoleEvents || [];

            // Add new events to console
            newEvents.forEach(event => {
              const time = event.timestamp ? new Date(event.timestamp) : new Date();
              const timeStr = time.toLocaleTimeString('en-US', { hour12: false });

              console.log('[Hydra+ BG] Adding event to storage:', {
                id: event.id,
                type: event.type,
                message: event.message.substring(0, 50)
              });

              consoleEvents.push({
                type: event.type || 'info',
                message: event.message,
                time: timeStr,
                timestamp: time,
                trackId: event.trackId
              });
            });

            // Keep only last 50 events
            const MAX_CONSOLE_ENTRIES = 50;
            if (consoleEvents.length > MAX_CONSOLE_ENTRIES) {
              consoleEvents = consoleEvents.slice(-MAX_CONSOLE_ENTRIES);
            }

            // Save back to storage
            chrome.storage.local.set({ consoleEvents: consoleEvents });
            console.log('[Hydra+ BG] Saved', consoleEvents.length, 'events to storage');
          });
        }
      }

      // Process active downloads progress if provided by server
      if (data.activeDownloads) {
        // Store active downloads progress in storage
        chrome.storage.local.set({ activeDownloads: data.activeDownloads });
      }
    }
  } catch (error) {
    // Server is offline
    if (!serverWasOffline) {
      console.log('[Hydra+ BG] Server went offline');
      serverWasOffline = true;
    }
  }
}

// Start polling when extension loads
function startPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
  }
  pollInterval = setInterval(pollEvents, POLL_INTERVAL);
  // Poll immediately on start
  pollEvents();
}

// Start polling
startPolling();

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
