// Configuration
const BRIDGE_URL = 'http://127.0.0.1:3847';

// Get DOM elements
const autoDownloadToggle = document.getElementById('autoDownloadToggle');
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
    console.error('Failed to test Spotify credentials:', error);
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

// Load saved settings immediately
async function loadSettings() {
  chrome.storage.sync.get(['autoDownload', 'metadataOverride', 'spotifyClientId', 'spotifyClientSecret', 'spotifyApiConnected'], async (data) => {
    autoDownloadToggle.checked = data.autoDownload || false;
    metadataOverrideToggle.checked = data.metadataOverride !== false; // Default to true
    spotifyClientId.value = data.spotifyClientId || '';
    spotifyClientSecret.value = data.spotifyClientSecret || '';

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

// Update credentials section visibility
function updateCredentialsSectionVisibility() {
  if (metadataOverrideToggle.checked) {
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

      // Send credentials to server when it comes online
      if (wasOffline) {
        sendCredentialsToServer();
      }
    } else {
      throw new Error('Server returned error');
    }
  } catch (error) {
    serverStatus.classList.remove('online');
    serverStatus.classList.add('offline');
    serverStatusText.textContent = 'Server offline';
    isServerOnline = false;
    updateSaveButtonState();
  }
}

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

      // Send credentials to bridge server
      fetch(`${BRIDGE_URL}/set-spotify-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret })
      }).catch(err => console.error('Failed to send credentials to server:', err));

      // Show connected state
      showConnectedState();
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
  }
});

// Edit credentials link
editCredentialsLink.addEventListener('click', (e) => {
  e.preventDefault();
  showInputState();
});

// Send credentials to server on popup open if they exist (only when server is online)
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
      }).catch(err => console.error('Failed to send credentials to server:', err));
    }
  });
}

// Check server status on popup open and update button state
checkServerStatus();

// Refresh status every 3 seconds
setInterval(checkServerStatus, 3000);
