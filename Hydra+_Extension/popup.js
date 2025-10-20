// Configuration
const BRIDGE_URL = 'http://127.0.0.1:3847';

// Get DOM elements
const autoDownloadToggle = document.getElementById('autoDownloadToggle');
const formatPreferenceSection = document.getElementById('formatPreferenceSection');
const formatPreferenceToggle = document.getElementById('formatPreferenceToggle');
const formatLabelMp3 = document.getElementById('formatLabelMp3');
const formatLabelFlac = document.getElementById('formatLabelFlac');
const metadataSection = document.getElementById('metadataSection');
const metadataOverrideToggle = document.getElementById('metadataOverrideToggle');
const credentialsSection = document.getElementById('credentialsSection');
const apiConnectedState = document.getElementById('apiConnectedState');
const apiInputState = document.getElementById('apiInputState');
const editCredentialsLink = document.getElementById('editCredentials');
const serverStatus = document.getElementById('serverStatus');
const serverStatusText = document.getElementById('serverStatusText');
const spotifyClientId = document.getElementById('spotifyClientId');
const spotifyClientSecret = document.getElementById('spotifyClientSecret');
const saveCredentialsBtn = document.getElementById('saveCredentials');
const savedIndicator = document.getElementById('savedIndicator');
const apiErrorIndicator = document.getElementById('apiErrorIndicator');
const resetServerBtn = document.getElementById('resetServerBtn');
const consoleContainer = document.getElementById('consoleContainer');
const consoleContent = document.getElementById('consoleContent');
const toggleConsoleBtn = document.getElementById('toggleConsoleBtn');
const patternPreset = document.getElementById('patternPreset');
const singleTrackPattern = document.getElementById('singleTrackPattern');
const albumTrackPattern = document.getElementById('albumTrackPattern');
const patternPreview = document.getElementById('patternPreview');
const patternPreviewAlbum = document.getElementById('patternPreviewAlbum');

// Console management
const MAX_CONSOLE_ENTRIES = 50;
let consoleEvents = [];

// Add event to console
function addConsoleEvent(type, message, timestamp = null) {
  const time = timestamp ? new Date(timestamp) : new Date();
  const timeStr = time.toLocaleTimeString('en-US', { hour12: false });

  const event = { type, message, time: timeStr, timestamp: time };
  consoleEvents.push(event);

  // Keep only last MAX_CONSOLE_ENTRIES
  if (consoleEvents.length > MAX_CONSOLE_ENTRIES) {
    consoleEvents.shift();
  }

  // Add to DOM
  const entry = document.createElement('div');
  entry.className = `console-entry console-${type}`;
  entry.innerHTML = `
    <span class="console-time">${timeStr}</span>
    <span class="console-message">${message}</span>
  `;

  consoleContent.appendChild(entry);

  // Remove oldest entries from DOM if over limit
  while (consoleContent.children.length > MAX_CONSOLE_ENTRIES) {
    consoleContent.removeChild(consoleContent.firstChild);
  }

  // Auto-scroll to bottom
  consoleContent.scrollTop = consoleContent.scrollHeight;

  // Store in chrome.storage.local for persistence
  chrome.storage.local.set({ consoleEvents: consoleEvents });
}

// Load console events from storage
function loadConsoleEvents() {
  chrome.storage.local.get(['consoleEvents'], (data) => {
    if (data.consoleEvents && data.consoleEvents.length > 0) {
      consoleEvents = data.consoleEvents;

      // Clear placeholder
      consoleContent.innerHTML = '';

      // Render events
      consoleEvents.forEach(event => {
        const entry = document.createElement('div');
        entry.className = `console-entry console-${event.type}`;
        entry.innerHTML = `
          <span class="console-time">${event.time}</span>
          <span class="console-message">${event.message}</span>
        `;
        consoleContent.appendChild(entry);
      });

      // Auto-scroll to bottom
      consoleContent.scrollTop = consoleContent.scrollHeight;
    }
  });
}

// Toggle console visibility
toggleConsoleBtn.addEventListener('click', () => {
  const isCollapsed = consoleContainer.classList.toggle('collapsed');
  toggleConsoleBtn.textContent = isCollapsed ? 'Show' : 'Hide';

  // Save preference
  chrome.storage.local.set({ consoleCollapsed: isCollapsed });
});

// Load console collapse state
chrome.storage.local.get(['consoleCollapsed'], (data) => {
  if (data.consoleCollapsed) {
    consoleContainer.classList.add('collapsed');
    toggleConsoleBtn.textContent = 'Show';
  }
});

// Load console events on popup open
loadConsoleEvents();

// Demo mode: Simulate events for testing (remove this in production)
// This demonstrates different event types when server doesn't provide events yet
window.addEventListener('load', () => {
  // Check if we should run demo mode (only if no events exist and it's first load)
  chrome.storage.local.get(['hasShownDemo', 'consoleEvents'], (data) => {
    if (!data.hasShownDemo && (!data.consoleEvents || data.consoleEvents.length === 0)) {
      // Mark demo as shown
      chrome.storage.local.set({ hasShownDemo: true });

      // Show sample events with delay
      setTimeout(() => {
        addConsoleEvent('info', 'Console initialized - waiting for bridge events');
      }, 500);
    }
  });
});

// Test Spotify API connection
async function testSpotifyConnection(clientId, clientSecret) {
  if (!clientId || !clientSecret) {
    return false;
  }

  try {
    // Send credentials to bridge server and request test
    const response = await fetch(`${BRIDGE_URL}/test-spotify-credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret })
    });

    const result = await response.json();
    return result.success || false;
  } catch (error) {
    // Don't log error if server is offline (expected behavior)
    if (isServerOnline) {
      console.error('Failed to test Spotify credentials:', error);
    }
    return false;
  }
}

// Show connected state
function showConnectedState() {
  apiInputState.style.display = 'none';
  apiConnectedState.style.display = 'block';
}

// Show input state
function showInputState() {
  apiConnectedState.style.display = 'none';
  apiInputState.style.display = 'block';
}

// Update format preference labels based on toggle state
function updateFormatLabels() {
  if (formatPreferenceToggle.checked) {
    // FLAC selected
    formatLabelMp3.classList.remove('active');
    formatLabelFlac.classList.add('active');
  } else {
    // MP3 selected
    formatLabelMp3.classList.add('active');
    formatLabelFlac.classList.remove('active');
  }
}

// Load saved settings immediately
async function loadSettings() {
  chrome.storage.sync.get(['autoDownload', 'formatPreference', 'metadataOverride', 'spotifyClientId', 'spotifyClientSecret', 'spotifyApiConnected'], async (data) => {
    // Auto-download defaults to true
    autoDownloadToggle.checked = data.autoDownload !== false;

    // Format preference: 'mp3' (default) or 'flac'
    // Toggle unchecked = MP3, checked = FLAC
    formatPreferenceToggle.checked = data.formatPreference === 'flac';
    updateFormatLabels();

    metadataOverrideToggle.checked = data.metadataOverride !== false; // Default to true
    spotifyClientId.value = data.spotifyClientId || '';
    spotifyClientSecret.value = data.spotifyClientSecret || '';

    // Show/hide format preference section based on auto-download setting
    updateFormatPreferenceSectionVisibility();
    // Show/hide metadata section based on auto-download setting
    updateMetadataSectionVisibility();
    // Show/hide credentials section based on metadata override setting
    updateCredentialsSectionVisibility();

    // Use cached connection state to immediately show correct UI (prevents flash)
    if (data.spotifyClientId && data.spotifyClientSecret) {
      if (data.spotifyApiConnected) {
        // Show connected state immediately based on cached state
        showConnectedState();
      } else {
        // Show input state if previously failed or never tested
        showInputState();
      }

      // Wait a moment for server status check, then verify connection in background if server is online
      setTimeout(async () => {
        // Only test connection if server is online (avoid failed fetch errors)
        if (isServerOnline) {
          const isConnected = await testSpotifyConnection(data.spotifyClientId, data.spotifyClientSecret);
          if (isConnected !== data.spotifyApiConnected) {
            // Update stored state if it changed
            chrome.storage.sync.set({ spotifyApiConnected: isConnected });

            // Update UI if state changed
            if (isConnected) {
              showConnectedState();
            } else {
              showInputState();
            }
          }
        }
      }, 100); // Small delay to let server status check complete
    } else {
      showInputState();
    }
  });
}

// Update format preference section visibility based on auto-download
function updateFormatPreferenceSectionVisibility() {
  if (autoDownloadToggle.checked) {
    formatPreferenceSection.style.display = 'flex';
  } else {
    formatPreferenceSection.style.display = 'none';
  }
}

// Update metadata section visibility based on auto-download
function updateMetadataSectionVisibility() {
  if (autoDownloadToggle.checked) {
    metadataSection.style.display = 'flex';
    credentialsSection.style.display = metadataOverrideToggle.checked ? 'block' : 'none';
  } else {
    metadataSection.style.display = 'none';
    credentialsSection.style.display = 'none';
  }
}

// Update credentials section visibility
function updateCredentialsSectionVisibility() {
  if (metadataOverrideToggle.checked && autoDownloadToggle.checked) {
    credentialsSection.style.display = 'block';
  } else {
    credentialsSection.style.display = 'none';
  }
}

// Load on popup open
loadSettings();

// Save settings when toggles change
autoDownloadToggle.addEventListener('change', () => {
  const autoDownload = autoDownloadToggle.checked;
  chrome.storage.sync.set({ autoDownload }, () => {
    console.log('Auto-download setting saved:', autoDownload);
  });
  // Update visibility of format preference and metadata sections
  updateFormatPreferenceSectionVisibility();
  updateMetadataSectionVisibility();
});

formatPreferenceToggle.addEventListener('change', () => {
  // Convert toggle state to preference: unchecked = 'mp3', checked = 'flac'
  const formatPreference = formatPreferenceToggle.checked ? 'flac' : 'mp3';
  console.log('[Hydra+] Format preference toggle changed:', {
    checked: formatPreferenceToggle.checked,
    formatPreference: formatPreference
  });
  chrome.storage.sync.set({ formatPreference }, () => {
    console.log('[Hydra+] Format preference saved to storage:', formatPreference);
    // Verify it was saved
    chrome.storage.sync.get(['formatPreference'], (result) => {
      console.log('[Hydra+] Verified storage contains:', result.formatPreference);
    });
  });
  updateFormatLabels();
});

metadataOverrideToggle.addEventListener('change', () => {
  const metadataOverride = metadataOverrideToggle.checked;
  chrome.storage.sync.set({ metadataOverride }, () => {
    console.log('Metadata override setting saved:', metadataOverride);
  });
  updateCredentialsSectionVisibility();
});

// Track server status globally
let isServerOnline = false;
let lastEventId = 0; // Track last processed event

// Check server status
async function checkServerStatus() {
  try {
    const response = await fetch(`${BRIDGE_URL}/status`, {
      method: 'GET',
      mode: 'cors'
    });

    if (response.ok) {
      const data = await response.json();
      serverStatus.classList.remove('offline');
      serverStatus.classList.add('online');
      serverStatusText.textContent = `Server online • ${data.unprocessed || 0} pending`;

      const wasOffline = !isServerOnline;
      isServerOnline = true;
      updateSaveButtonState();

      // IMPROVED: Send credentials and patterns only once when server comes online (not on every check)
      if (wasOffline) {
        sendCredentialsToServer();
        sendPatternsToServer();
        addConsoleEvent('success', 'Bridge server connected');
      }

      // Process events if provided by server
      if (data.events && Array.isArray(data.events)) {
        // Filter out events we've already seen
        const newEvents = data.events.filter(event => event.id > lastEventId);

        newEvents.forEach(event => {
          // Update last event ID
          if (event.id > lastEventId) {
            lastEventId = event.id;
          }

          // Add to console with appropriate type
          addConsoleEvent(event.type || 'info', event.message, event.timestamp);
        });

        // Store last event ID
        chrome.storage.local.set({ lastEventId: lastEventId });
      }
    } else {
      throw new Error('Server returned error');
    }
  } catch (error) {
    const wasOnline = isServerOnline;
    serverStatus.classList.remove('online');
    serverStatus.classList.add('offline');
    serverStatusText.textContent = 'Server offline';
    isServerOnline = false;
    updateSaveButtonState();

    if (wasOnline) {
      addConsoleEvent('error', 'Bridge server disconnected');
    }
  }
}

// Load last event ID from storage
chrome.storage.local.get(['lastEventId'], (data) => {
  if (data.lastEventId) {
    lastEventId = data.lastEventId;
  }
});

// Auto-save credentials when fields change (debounced)
let saveTimeout;
function autoSaveCredentials() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const clientId = spotifyClientId.value.trim();
    const clientSecret = spotifyClientSecret.value.trim();

    // Save to storage
    chrome.storage.sync.set({
      spotifyClientId: clientId,
      spotifyClientSecret: clientSecret
    }, () => {
      console.log('Spotify credentials auto-saved');
    });
  }, 500); // Save 500ms after user stops typing
}

spotifyClientId.addEventListener('input', autoSaveCredentials);
spotifyClientSecret.addEventListener('input', autoSaveCredentials);

// Update save button text/state based on server status
function updateSaveButtonState() {
  if (!isServerOnline) {
    saveCredentialsBtn.textContent = 'Save Credentials (Server Offline)';
    saveCredentialsBtn.disabled = true;
    saveCredentialsBtn.style.opacity = '0.5';
    saveCredentialsBtn.style.cursor = 'not-allowed';
  } else {
    saveCredentialsBtn.textContent = 'Save & Test Connection';
    saveCredentialsBtn.disabled = false;
    saveCredentialsBtn.style.opacity = '1';
    saveCredentialsBtn.style.cursor = 'pointer';
  }
}

// Set initial button state (assume offline until checked)
updateSaveButtonState();

// Manual save button - tests connection (only enabled when server is online)
saveCredentialsBtn.addEventListener('click', async () => {
  const clientId = spotifyClientId.value.trim();
  const clientSecret = spotifyClientSecret.value.trim();

  // Hide previous indicators
  savedIndicator.style.display = 'none';
  apiErrorIndicator.style.display = 'none';

  if (!clientId || !clientSecret) {
    apiErrorIndicator.textContent = '✗ Please enter both credentials';
    apiErrorIndicator.style.display = 'block';
    setTimeout(() => {
      apiErrorIndicator.style.display = 'none';
    }, 3000);
    return;
  }

  // Server is online - test connection
  saveCredentialsBtn.textContent = 'Testing connection...';
  saveCredentialsBtn.disabled = true;

  const isConnected = await testSpotifyConnection(clientId, clientSecret);

  updateSaveButtonState(); // Restore button state

  if (isConnected) {
    // Save to storage
    chrome.storage.sync.set({
      spotifyClientId: clientId,
      spotifyClientSecret: clientSecret,
      spotifyApiConnected: true
    }, () => {
      console.log('Spotify credentials saved and connected');

      // Send credentials to bridge server (no duplication - server already has them from test)
      // Note: Test connection already sent credentials, so this is just a safety redundancy
      fetch(`${BRIDGE_URL}/set-spotify-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret })
      }).catch(err => {
        if (isServerOnline) {
          console.error('Failed to send credentials to server:', err);
        }
      });

      // Show connected state
      showConnectedState();

      // Log to console
      addConsoleEvent('success', 'Spotify API credentials connected');
    });
  } else {
    // Save failed state to prevent flash on next popup open
    chrome.storage.sync.set({
      spotifyApiConnected: false
    });

    apiErrorIndicator.textContent = '✗ Connection failed - check credentials';
    apiErrorIndicator.style.display = 'block';
    setTimeout(() => {
      apiErrorIndicator.style.display = 'none';
    }, 3000);

    // Log to console
    addConsoleEvent('error', 'Spotify API connection failed');
  }
});

// Edit credentials link
editCredentialsLink.addEventListener('click', (e) => {
  e.preventDefault();
  showInputState();
});

// IMPROVED: Consolidated credential sending - only send when server comes online
function sendCredentialsToServer() {
  chrome.storage.sync.get(['spotifyClientId', 'spotifyClientSecret'], (data) => {
    if (data.spotifyClientId && data.spotifyClientSecret && isServerOnline) {
      fetch(`${BRIDGE_URL}/set-spotify-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: data.spotifyClientId,
          clientSecret: data.spotifyClientSecret
        })
      }).catch(err => {
        if (isServerOnline) {
          console.error('Failed to send credentials to server:', err);
        }
      });
    }
  });
}

// Send rename patterns to server when it comes online
function sendPatternsToServer() {
  chrome.storage.sync.get(['singleTrackPattern', 'albumTrackPattern'], (data) => {
    const singlePattern = data.singleTrackPattern || '{artist} - {track}';
    const albumPattern = data.albumTrackPattern || '{trackNum} {artist} - {track}';

    if (isServerOnline) {
      fetch(`${BRIDGE_URL}/set-rename-pattern`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          singleTrack: singlePattern,
          albumTrack: albumPattern
        })
      }).catch(err => {
        if (isServerOnline) {
          console.error('Failed to send patterns to server:', err);
        }
      });
    }
  });
}

// Check server status on popup open
checkServerStatus();

// Refresh status every 3 seconds (consolidated into checkServerStatus)
setInterval(checkServerStatus, 3000);

// Reset server button handler
resetServerBtn.addEventListener('click', async () => {
  if (!isServerOnline) {
    serverStatusText.textContent = 'Server offline - cannot restart';
    return;
  }

  // Disable button and show loading state
  resetServerBtn.disabled = true;
  const originalText = resetServerBtn.textContent;
  resetServerBtn.textContent = 'Restarting...';

  // Log restart attempt
  addConsoleEvent('info', 'Restarting bridge server...');

  try {
    // Call restart endpoint
    const response = await fetch(`${BRIDGE_URL}/restart`, {
      method: 'POST',
      mode: 'cors'
    });

    if (response.ok) {
      serverStatusText.textContent = 'Server restarting...';

      // Wait a bit for the server to shut down
      await new Promise(resolve => setTimeout(resolve, 500));

      // Update status to show it's offline
      serverStatus.classList.remove('online');
      serverStatus.classList.add('offline');
      isServerOnline = false;

      // Wait for server to come back online (check every 500ms for up to 10 seconds)
      let attempts = 0;
      const maxAttempts = 20;

      const checkRestart = setInterval(async () => {
        attempts++;

        try {
          const statusResponse = await fetch(`${BRIDGE_URL}/status`, {
            method: 'GET',
            mode: 'cors'
          });

          if (statusResponse.ok) {
            clearInterval(checkRestart);
            serverStatus.classList.remove('offline');
            serverStatus.classList.add('online');
            isServerOnline = true;
            serverStatusText.textContent = 'Server restarted successfully';

            // Reset button state
            resetServerBtn.disabled = false;
            resetServerBtn.textContent = originalText;

            // Send credentials and patterns to server after restart
            sendCredentialsToServer();
            sendPatternsToServer();

            // Log success
            addConsoleEvent('success', 'Bridge server restarted successfully');
          }
        } catch (error) {
          // Server still not up
          if (attempts >= maxAttempts) {
            clearInterval(checkRestart);
            serverStatusText.textContent = 'Restart timeout - check manually';

            // Reset button state
            resetServerBtn.disabled = false;
            resetServerBtn.textContent = originalText;

            // Log timeout
            addConsoleEvent('warning', 'Server restart timeout - check manually');
          }
        }
      }, 500);
    } else {
      throw new Error('Restart request failed');
    }
  } catch (error) {
    console.error('Failed to restart server:', error);
    serverStatusText.textContent = 'Restart failed';

    // Reset button state
    resetServerBtn.disabled = false;
    resetServerBtn.textContent = originalText;

    // Log error
    addConsoleEvent('error', 'Server restart failed');
  }
});

// ===== FILE NAMING PATTERN MANAGEMENT =====

// Example data for preview
const previewData = {
  artist: 'Iron Maiden',
  track: 'The Trooper',
  album: 'Piece of Mind',
  year: '1983',
  trackNum: '01'
};

// Generate preview from pattern
function generatePreview(pattern, includeTrackNum = false) {
  let preview = pattern;

  // Replace tokens
  preview = preview.replace(/\{trackNum\}/g, includeTrackNum ? previewData.trackNum : '');
  preview = preview.replace(/\{artist\}/g, previewData.artist);
  preview = preview.replace(/\{track\}/g, previewData.track);
  preview = preview.replace(/\{album\}/g, previewData.album);
  preview = preview.replace(/\{year\}/g, previewData.year);

  // Clean up extra spaces/separators
  preview = preview.replace(/\s+/g, ' ').replace(/\s*-\s*-\s*/g, ' - ').trim();
  preview = preview.replace(/^-\s*/, '').replace(/\s*-$/, '');

  return preview + '.mp3';
}

// Update preview displays
function updatePreviews() {
  const singlePattern = singleTrackPattern.value || '{artist} - {track}';
  const albumPattern = albumTrackPattern.value || '{trackNum} {artist} - {track}';

  patternPreview.textContent = generatePreview(singlePattern, false);
  patternPreviewAlbum.textContent = generatePreview(albumPattern, true);
}

// Send pattern to bridge server
async function sendPatternToServer(singlePattern, albumPattern) {
  if (!isServerOnline) {
    console.log('[Hydra+] Server offline - pattern will be sent when server connects');
    return;
  }

  try {
    const response = await fetch(`${BRIDGE_URL}/set-rename-pattern`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        singleTrack: singlePattern,
        albumTrack: albumPattern
      })
    });

    if (response.ok) {
      console.log('[Hydra+] Rename pattern sent to server');
      addConsoleEvent('success', 'File naming pattern updated');
    } else {
      console.error('[Hydra+] Failed to send pattern to server');
    }
  } catch (error) {
    if (isServerOnline) {
      console.error('[Hydra+] Error sending pattern to server:', error);
    }
  }
}

// Load saved patterns
function loadPatterns() {
  chrome.storage.sync.get(['singleTrackPattern', 'albumTrackPattern'], (data) => {
    const singlePattern = data.singleTrackPattern || '{artist} - {track}';
    const albumPattern = data.albumTrackPattern || '{trackNum} {artist} - {track}';

    singleTrackPattern.value = singlePattern;
    albumTrackPattern.value = albumPattern;

    // Check if current pattern matches a preset
    updatePresetSelection(singlePattern);

    updatePreviews();

    // Send to server when loaded
    sendPatternToServer(singlePattern, albumPattern);
  });
}

// Update preset dropdown based on current single track pattern
function updatePresetSelection(pattern) {
  const presetOptions = Array.from(patternPreset.options);
  const matchingOption = presetOptions.find(opt => opt.value === pattern);

  if (matchingOption) {
    patternPreset.value = pattern;
  } else {
    patternPreset.value = 'custom';
  }
}

// Preset dropdown change handler
patternPreset.addEventListener('change', () => {
  const selectedValue = patternPreset.value;

  if (selectedValue !== 'custom') {
    singleTrackPattern.value = selectedValue;

    // Set default album pattern based on preset
    if (selectedValue.includes('{trackNum}')) {
      albumTrackPattern.value = selectedValue;
    } else {
      albumTrackPattern.value = '{trackNum} ' + selectedValue;
    }

    // Save and update
    savePatterns();
  }
});

// Input change handlers with debouncing
let patternSaveTimeout;
function savePatterns() {
  clearTimeout(patternSaveTimeout);
  patternSaveTimeout = setTimeout(() => {
    const singlePattern = singleTrackPattern.value.trim() || '{artist} - {track}';
    const albumPattern = albumTrackPattern.value.trim() || '{trackNum} {artist} - {track}';

    chrome.storage.sync.set({
      singleTrackPattern: singlePattern,
      albumTrackPattern: albumPattern
    }, () => {
      console.log('[Hydra+] Patterns saved:', { singlePattern, albumPattern });
      updatePreviews();
      updatePresetSelection(singlePattern);
      sendPatternToServer(singlePattern, albumPattern);
    });
  }, 500);
}

singleTrackPattern.addEventListener('input', () => {
  updatePreviews();
  savePatterns();
});

albumTrackPattern.addEventListener('input', () => {
  updatePreviews();
  savePatterns();
});

// Load patterns on startup
loadPatterns();
