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

      // Verify connection in background and update if changed
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
    } else {
      throw new Error('Server returned error');
    }
  } catch (error) {
    serverStatus.classList.remove('online');
    serverStatus.classList.add('offline');
    serverStatusText.textContent = 'Server offline';
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

// Manual save button - now tests connection
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

  // Test connection
  saveCredentialsBtn.textContent = 'Testing connection...';
  saveCredentialsBtn.disabled = true;

  const isConnected = await testSpotifyConnection(clientId, clientSecret);

  saveCredentialsBtn.textContent = 'Save & Test Connection';
  saveCredentialsBtn.disabled = false;

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

// Send credentials to server on popup open if they exist
chrome.storage.sync.get(['spotifyClientId', 'spotifyClientSecret'], (data) => {
  if (data.spotifyClientId && data.spotifyClientSecret) {
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

// Check server status on popup open
checkServerStatus();

// Refresh status every 3 seconds
setInterval(checkServerStatus, 3000);
