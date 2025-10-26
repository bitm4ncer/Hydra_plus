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
const consoleContainer = document.getElementById('consoleContainerInner');
const consoleContent = document.getElementById('consoleContent');
const toggleConsoleBtn = document.getElementById('toggleConsoleBtn');
const clearConsoleBtn = document.getElementById('clearConsoleBtn');
const singlePresetDots = document.getElementById('singlePresetDots');
const albumPresetDots = document.getElementById('albumPresetDots');
const singleTrackPattern = document.getElementById('singleTrackPattern');
const albumTrackPattern = document.getElementById('albumTrackPattern');
const patternPreview = document.getElementById('patternPreview');
const patternPreviewAlbum = document.getElementById('patternPreviewAlbum');
const fileNamingContainer = document.getElementById('fileNamingContainer');
const toggleFileNamingBtn = document.getElementById('toggleFileNamingBtn');
const progressBarsContainer = document.getElementById('progressBarsContainer');
const progressBarsArea = document.getElementById('progressBarsArea');
const progressSection = document.getElementById('progressSection');
const currentTrackInfo = document.getElementById('currentTrackInfo');
const albumArtThumbnail = document.getElementById('albumArtThumbnail');
const downloadMetadataSettings = document.getElementById('downloadMetadataSettings');
const toggleDownloadMetadataBtn = document.getElementById('toggleDownloadMetadataBtn');
const debugWindowsToggle = document.getElementById('debugWindowsToggle');

// Console management
const MAX_CONSOLE_ENTRIES = 50;
let consoleEvents = [];

// Track bars being created to prevent race conditions
const barsBeingCreated = new Set();

// Helper to safely call chrome.storage (handles extension context invalidation)
function safeStorageSet(data, callback) {
  try {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) {
        // Extension context invalidated - ignore
        if (!chrome.runtime.lastError.message.includes('Extension context invalidated')) {
          console.error('Storage error:', chrome.runtime.lastError);
        }
      } else if (callback) {
        callback();
      }
    });
  } catch (error) {
    // Extension context invalidated - ignore silently
    if (!error.message.includes('Extension context invalidated')) {
      console.error('Storage error:', error);
    }
  }
}

function safeStorageSyncSet(data, callback) {
  try {
    chrome.storage.sync.set(data, () => {
      if (chrome.runtime.lastError) {
        // Extension context invalidated - ignore
        if (!chrome.runtime.lastError.message.includes('Extension context invalidated')) {
          console.error('Storage error:', chrome.runtime.lastError);
        }
      } else if (callback) {
        callback();
      }
    });
  } catch (error) {
    // Extension context invalidated - ignore silently
    if (!error.message.includes('Extension context invalidated')) {
      console.error('Storage error:', error);
    }
  }
}

// Track color assignments for concurrent tracks (excluding accent green)
const trackColors = ['#6a9fb5', '#ffa500', '#ff6ec7', '#00bfff', '#ff4500', '#9370db', '#32cd32', '#ff69b4'];
let trackColorMap = new Map(); // trackId -> color
let nextColorIndex = 0;

// Get or assign color for a track
function getTrackColor(trackId) {
  if (!trackId) return null;

  if (!trackColorMap.has(trackId)) {
    trackColorMap.set(trackId, trackColors[nextColorIndex % trackColors.length]);
    nextColorIndex++;

    // Clean up old track colors if map gets too large
    if (trackColorMap.size > 20) {
      const entries = Array.from(trackColorMap.entries());
      trackColorMap = new Map(entries.slice(-10)); // Keep last 10
    }
  }

  return trackColorMap.get(trackId);
}

// Add event to console
function addConsoleEvent(type, message, timestamp = null, trackId = null) {
  const time = timestamp ? new Date(timestamp) : new Date();
  const timeStr = time.toLocaleTimeString('en-US', { hour12: false });

  const event = { type, message, time: timeStr, timestamp: time, trackId };
  consoleEvents.push(event);

  // Keep only last MAX_CONSOLE_ENTRIES
  if (consoleEvents.length > MAX_CONSOLE_ENTRIES) {
    consoleEvents.shift();
  }

  // Add to DOM
  const entry = document.createElement('div');

  // Add track color if trackId provided
  const trackColor = getTrackColor(trackId);
  const messageStyle = trackColor ? ` style="color: ${trackColor};"` : '';
  const hasColorClass = trackColor ? ' has-track-color' : '';

  entry.className = `console-entry console-${type}${hasColorClass}`;

  entry.innerHTML = `
    <span class="console-time">${timeStr}</span>
    <span class="console-message"${messageStyle}>${message}</span>
  `;

  consoleContent.appendChild(entry);

  // Remove oldest entries from DOM if over limit
  while (consoleContent.children.length > MAX_CONSOLE_ENTRIES) {
    consoleContent.removeChild(consoleContent.firstChild);
  }

  // Auto-scroll to bottom
  consoleContent.scrollTop = consoleContent.scrollHeight;

  // IMPORTANT: Detect "Searching:" events and create progress bar in searching state
  if (type === 'info' && message.startsWith('Searching:') && trackId) {
    console.log('[Hydra+ PROGRESS] 🔍 Searching event detected for trackId:', trackId);
    createSearchingProgressBar(trackId, message);
  }

  // IMPORTANT: Detect "Downloading:" events and transition to downloading state
  if (type === 'info' && message.startsWith('Downloading:') && trackId) {
    console.log('[Hydra+ PROGRESS] ⬇️ Downloading event detected for trackId:', trackId);
    createInitialProgressBar(trackId, message);
  }

  // Store in chrome.storage.local for persistence (with error handling)
  safeStorageSet({ consoleEvents: consoleEvents });
}

// Load console events from storage
function loadConsoleEvents() {
  chrome.storage.local.get(['consoleEvents'], (data) => {
    console.log('[Hydra+ Popup] Loading console events:', {
      hasEvents: !!data.consoleEvents,
      eventCount: data.consoleEvents ? data.consoleEvents.length : 0
    });

    if (data.consoleEvents && data.consoleEvents.length > 0) {
      consoleEvents = data.consoleEvents;

      console.log('[Hydra+ Popup] Sample events:', data.consoleEvents.slice(-3).map(e => ({
        type: e.type,
        message: e.message.substring(0, 40),
        time: e.time
      })));

      // Clear placeholder
      consoleContent.innerHTML = '';

      // Render events
      consoleEvents.forEach(event => {
        const entry = document.createElement('div');

        // Add track color if trackId exists
        const trackColor = getTrackColor(event.trackId);
        const messageStyle = trackColor ? ` style="color: ${trackColor};"` : '';
        const hasColorClass = trackColor ? ' has-track-color' : '';

        entry.className = `console-entry console-${event.type}${hasColorClass}`;

        entry.innerHTML = `
          <span class="console-time">${event.time}</span>
          <span class="console-message"${messageStyle}>${event.message}</span>
        `;
        consoleContent.appendChild(entry);

        // NOTE: Don't create progress bars here - they're created in addConsoleEvent()
        // This function is called when loading from storage (can be called multiple times)
        // Creating bars here would cause duplicates on every storage change
      });

      console.log('[Hydra+ Popup] Rendered', consoleEvents.length, 'events to DOM');

      // Auto-scroll to bottom
      consoleContent.scrollTop = consoleContent.scrollHeight;
    } else {
      console.log('[Hydra+ Popup] No events in storage');
    }
  });
}

// Clear console button
clearConsoleBtn.addEventListener('click', async () => {
  // Clear events array
  consoleEvents = [];

  // Clear track color map to reset colors
  trackColorMap.clear();
  nextColorIndex = 0;

  // Clear progress bars
  clearProgressBars();

  // Clear DOM
  consoleContent.innerHTML = '<div class="console-entry console-info"><span class="console-time">--:--:--</span><span class="console-message">Console cleared</span></div>';

  // Clear storage (events and active downloads)
  safeStorageSet({ consoleEvents: [], activeDownloads: {} });

  // Clear progress data from bridge server
  try {
    await fetch(`${BRIDGE_URL}/clear-progress`, {
      method: 'POST',
      mode: 'cors'
    });
  } catch (error) {
    // Ignore if server is offline
  }

  // Add a brief confirmation message that will be replaced by next event
  setTimeout(() => {
    consoleContent.innerHTML = '<div class="console-entry console-info"><span class="console-time">--:--:--</span><span class="console-message">Waiting for events...</span></div>';
  }, 1000);
});

// Toggle console visibility
toggleConsoleBtn.addEventListener('click', () => {
  const isCollapsed = consoleContainer.classList.toggle('collapsed');
  toggleConsoleBtn.textContent = isCollapsed ? 'Show' : 'Hide';

  // Save preference
  safeStorageSet({ consoleCollapsed: isCollapsed });
});

// Load console collapse state
chrome.storage.local.get(['consoleCollapsed'], (data) => {
  if (data.consoleCollapsed) {
    consoleContainer.classList.add('collapsed');
    toggleConsoleBtn.textContent = 'Show';
  }
});

// Toggle file naming section visibility
toggleFileNamingBtn.addEventListener('click', () => {
  const isCollapsed = fileNamingContainer.classList.toggle('collapsed');
  toggleFileNamingBtn.textContent = isCollapsed ? 'Show' : 'Hide';

  // Add accent color when showing "Show"
  if (isCollapsed) {
    toggleFileNamingBtn.classList.add('toggle-show');
  } else {
    toggleFileNamingBtn.classList.remove('toggle-show');
  }

  // Save preference
  safeStorageSet({ fileNamingCollapsed: isCollapsed });
});

// Load file naming collapse state
chrome.storage.local.get(['fileNamingCollapsed'], (data) => {
  if (data.fileNamingCollapsed) {
    fileNamingContainer.classList.add('collapsed');
    toggleFileNamingBtn.textContent = 'Show';
    toggleFileNamingBtn.classList.add('toggle-show');
  }
});

// Toggle download metadata section visibility
toggleDownloadMetadataBtn.addEventListener('click', () => {
  const isCollapsed = downloadMetadataSettings.classList.toggle('collapsed');
  toggleDownloadMetadataBtn.textContent = isCollapsed ? 'Show' : 'Hide';

  // Add accent color when showing "Show"
  if (isCollapsed) {
    toggleDownloadMetadataBtn.classList.add('toggle-show');
  } else {
    toggleDownloadMetadataBtn.classList.remove('toggle-show');
  }

  // Save preference
  safeStorageSet({ downloadMetadataCollapsed: isCollapsed });
});

// Load download metadata collapse state
chrome.storage.local.get(['downloadMetadataCollapsed'], (data) => {
  if (data.downloadMetadataCollapsed) {
    downloadMetadataSettings.classList.add('collapsed');
    toggleDownloadMetadataBtn.textContent = 'Show';
    toggleDownloadMetadataBtn.classList.add('toggle-show');
  }
});

// Load console events on popup open
loadConsoleEvents();

// Listen for storage changes to update console in real-time
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.consoleEvents) {
    console.log('[Hydra+ Popup] Storage changed - consoleEvents updated');
    console.log('[Hydra+ Popup] New value:', {
      hasNewValue: !!changes.consoleEvents.newValue,
      newCount: changes.consoleEvents.newValue ? changes.consoleEvents.newValue.length : 0,
      oldCount: changes.consoleEvents.oldValue ? changes.consoleEvents.oldValue.length : 0
    });
    // Events were updated by background.js - reload them
    loadConsoleEvents();
  }
});

// Load and display active download progress bars
function loadActiveDownloads() {
  chrome.storage.local.get(['activeDownloads'], (data) => {
    console.log('[Hydra+ DEBUG] loadActiveDownloads called, data:', data);
    if (data.activeDownloads && Object.keys(data.activeDownloads).length > 0) {
      console.log('[Hydra+ DEBUG] Active downloads found:', Object.keys(data.activeDownloads).length);
      updateProgressBars(data.activeDownloads);
    } else {
      console.log('[Hydra+ DEBUG] No progress updates available (bars remain from events)');
      // DO NOT clear bars - they are created from events and should persist
      // Only update their heights when progress data arrives
    }
  });
}

// Track completion times for auto-removal after 1 minute
const completionTimes = new Map(); // trackId -> timestamp

// Progress bar state management
const PROGRESS_BAR_STATES = {
  SEARCHING: 'searching',    // 50% opacity - search queued, waiting for results
  DOWNLOADING: 'downloading', // 100% opacity - actively downloading
  COMPLETED: 'completed'      // 100% opacity - download finished
};

// Track progress bar lifecycle states
// Map: trackId -> {state, artist, track, album, filePath, progress, createdAt, completedAt}
const progressBarStates = new Map();

// Add mouseenter handler to show track info in header
function addTrackInfoHover(barContainer) {
  barContainer.addEventListener('mouseenter', () => {
    const artist = barContainer.getAttribute('data-artist') || '';
    const track = barContainer.getAttribute('data-track') || '';
    const album = barContainer.getAttribute('data-album') || '';
    const trackId = barContainer.getAttribute('data-track-id');
    const imageUrl = barContainer.getAttribute('data-image-url') || '';
    const trackColor = barContainer.getAttribute('data-track-color') || '#B9FF37';

    const trackInfo = generateTooltipText(artist, track, album);

    // Show track info with unique color code in tooltip
    currentTrackInfo.textContent = trackInfo + ' (' + trackColor + ')';
    currentTrackInfo.style.color = trackColor;

    // Show album artwork thumbnail if available
    if (imageUrl) {
      console.log('[Hydra+ PROGRESS] Showing thumbnail:', imageUrl);
      albumArtThumbnail.src = imageUrl;
      albumArtThumbnail.classList.add('visible');
    } else {
      console.log('[Hydra+ PROGRESS] No imageUrl for hover - thumbnail hidden');
    }
  });
}

// Add click handler for folder opening
function addFolderClickHandler(barContainer) {
  barContainer.style.cursor = 'pointer';
  barContainer.addEventListener('click', async () => {
    const path = barContainer.getAttribute('data-file-path');
    const artist = barContainer.getAttribute('data-artist');
    const track = barContainer.getAttribute('data-track');
    const trackId = barContainer.getAttribute('data-track-id');

    console.log('[Hydra+ PROGRESS] ========== CLICK DETECTED ==========');
    console.log('[Hydra+ PROGRESS] Track ID:', trackId);
    console.log('[Hydra+ PROGRESS] Artist:', artist || '(empty)');
    console.log('[Hydra+ PROGRESS] Track:', track || '(empty)');
    console.log('[Hydra+ PROGRESS] File path:', path || 'NOT SET');
    console.log('[Hydra+ PROGRESS] ====================================');

    if (path) {
      console.log('[Hydra+ PROGRESS] Opening folder for:', artist, '-', track);

      // Add visual feedback
      barContainer.classList.add('click-feedback');
      setTimeout(() => barContainer.classList.remove('click-feedback'), 300);

      try {
        console.log('[Hydra+ PROGRESS] Sending request to:', `${BRIDGE_URL}/open-folder`);
        console.log('[Hydra+ PROGRESS] Payload:', JSON.stringify({ filePath: path }));

        const response = await fetch(`${BRIDGE_URL}/open-folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: path })
        });

        console.log('[Hydra+ PROGRESS] ✓ Response status:', response.status);

        const result = await response.json();
        console.log('[Hydra+ PROGRESS] ✓ Response body:', result);

        if (!response.ok) {
          console.error('[Hydra+ PROGRESS] ✗ Server responded with error:', response.status);
        }
      } catch (error) {
        console.error('[Hydra+ PROGRESS] ✗ Failed to open folder:', error);
        console.error('[Hydra+ PROGRESS] ✗ Error details:', error.message);
      }
    } else {
      console.warn('[Hydra+ PROGRESS] ⚠ No file path available - cannot open folder');
      console.warn('[Hydra+ PROGRESS] ⚠ This means the download hasn\'t started yet or the path wasn\'t sent from Python plugin');
    }
  });
}

// Create progress bar in SEARCHING state (50% opacity)
async function createSearchingProgressBar(trackId, message) {
  console.log('[Hydra+ PROGRESS] 🔍 Creating searching bar for trackId:', trackId);

  // Check if bar already exists OR is being created
  const existingBar = progressBarsArea.querySelector(`[data-track-id="${trackId}"]`);
  if (existingBar || barsBeingCreated.has(trackId)) {
    console.log('[Hydra+ PROGRESS] Bar already exists or is being created for:', trackId);
    return; // Don't create duplicate
  }

  // Mark this bar as being created
  barsBeingCreated.add(trackId);

  // Extract search info from message (e.g., "Searching: Artist - Track")
  const searchInfo = message.replace('Searching:', '').trim();

  // Try to parse artist and track from searchInfo (format: "Artist - Track")
  let artist = '';
  let track = '';
  if (searchInfo.includes(' - ')) {
    const parts = searchInfo.split(' - ');
    artist = parts[0].trim();
    track = parts[1].trim();
  }

  console.log('[Hydra+ PROGRESS] Parsed search info:', { artist, track, searchInfo });

  // Fetch album artwork immediately from Spotify API
  let imageUrl = '';
  if (artist && track) {
    try {
      console.log('[Hydra+ PROGRESS] Fetching artwork for:', artist, '-', track);
      const artworkResponse = await fetch('http://127.0.0.1:3848/get-album-artwork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artist, track })
      });

      if (artworkResponse.ok) {
        const artworkData = await artworkResponse.json();
        if (artworkData.success && artworkData.imageUrl) {
          imageUrl = artworkData.imageUrl;
          console.log('[Hydra+ PROGRESS] ✓ Got artwork:', imageUrl.substring(0, 50) + '...');

          // Store in state server for later metadata processing
          fetch('http://127.0.0.1:3847/store-artwork', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trackId, imageUrl })
          }).catch(err => console.warn('[Hydra+ PROGRESS] Failed to cache artwork:', err));
        }
      }
    } catch (error) {
      console.warn('[Hydra+ PROGRESS] Failed to fetch artwork:', error.message);
    }
  }

  // Get unique track color (matches console log color)
  const trackColor = getTrackColor(trackId);

  // Create new vertical bar at 5% height with 50% opacity
  const barContainer = document.createElement('div');
  barContainer.className = 'vertical-progress-bar state-searching'; // Add searching state class
  barContainer.setAttribute('data-track-id', trackId);
  barContainer.setAttribute('data-track-color', trackColor); // Store color for hover tooltip
  barContainer.setAttribute('data-artist', artist);
  barContainer.setAttribute('data-track', track);
  barContainer.setAttribute('data-album', '');

  // Store image URL for thumbnail display (if we got one)
  if (imageUrl) {
    barContainer.setAttribute('data-image-url', imageUrl);
  }

  // Add hover listener to show track info in header
  addTrackInfoHover(barContainer);

  // Add click handler for folder opening
  addFolderClickHandler(barContainer);

  // Create the fill element at 5% height
  const fill = document.createElement('div');
  fill.className = 'progress-bar-fill-vertical';
  fill.style.height = '5%'; // Start at 5%
  fill.style.backgroundColor = trackColor || '#B9FF37';

  barContainer.appendChild(fill);
  progressBarsArea.appendChild(barContainer);

  // Store state with parsed artist/track and imageUrl
  progressBarStates.set(trackId, {
    state: PROGRESS_BAR_STATES.SEARCHING,
    artist: artist,
    track: track,
    album: '',
    filePath: '',
    imageUrl: imageUrl,
    progress: 5,
    createdAt: Date.now(),
    completedAt: null
  });

  // Remove from "being created" set
  barsBeingCreated.delete(trackId);

  console.log('[Hydra+ PROGRESS] ✓ Searching bar created at 5% (50% opacity) for:', searchInfo.substring(0, 30));
}

// Transition progress bar to DOWNLOADING state (100% opacity)
function createInitialProgressBar(trackId, message) {
  console.log('[Hydra+ PROGRESS] ⬇️ Transitioning to downloading state for trackId:', trackId);

  // Extract filename from message (e.g., "Downloading: Artist - Track (MP3)")
  const filename = message.replace('Downloading:', '').trim();

  // CRITICAL: Check if bar already exists for this trackId
  // This handles retries (HEAD1, HEAD2, HEAD3) which reuse the same trackId
  let barContainer = progressBarsArea.querySelector(`[data-track-id="${trackId}"]`);

  // Also check if bar is currently being created
  if (barsBeingCreated.has(trackId)) {
    console.log('[Hydra+ PROGRESS] Bar is being created, will update when ready');
    return;
  }

  // If bar exists (either in SEARCHING or DOWNLOADING state), reuse it
  if (barContainer) {
    console.log('[Hydra+ PROGRESS] Reusing existing bar (retry or state transition)');

    // Remove searching state, ensure downloading state
    barContainer.classList.remove('state-searching');
    if (!barContainer.classList.contains('state-downloading')) {
      barContainer.classList.add('state-downloading');
    }

    // Update tooltip
    const tooltip = barContainer.querySelector('.progress-bar-tooltip');
    if (tooltip) {
      tooltip.textContent = filename;
    }

    // Update state tracking
    const existingState = progressBarStates.get(trackId);
    if (existingState) {
      existingState.state = PROGRESS_BAR_STATES.DOWNLOADING;
      // Reset progress to 5% for retry attempts (don't leave at old partial progress)
      existingState.progress = 5;
      progressBarStates.set(trackId, existingState);

      // Also reset the fill element to 5%
      const fill = barContainer.querySelector('.progress-bar-fill-vertical');
      if (fill) {
        fill.style.height = '5%';
      }
    }

    console.log('[Hydra+ PROGRESS] ✓ Bar reused and reset to 5% for new download attempt');
    return; // CRITICAL: Return here to prevent creating new bar below
  }

  // BAR DOESN'T EXIST - Create new bar directly in downloading state
  console.log('[Hydra+ PROGRESS] Creating new bar in downloading state');

  // Get unique track color (matches console log color)
  const trackColor = getTrackColor(trackId);

  // Create new vertical bar at 5% height with 100% opacity
  barContainer = document.createElement('div');
  barContainer.className = 'vertical-progress-bar state-downloading';
  barContainer.setAttribute('data-track-id', trackId);
  barContainer.setAttribute('data-track-color', trackColor); // Store color for hover tooltip
  barContainer.setAttribute('data-artist', '');
  barContainer.setAttribute('data-track', '');
  barContainer.setAttribute('data-album', '');

  // Add hover listener to show track info in header
  addTrackInfoHover(barContainer);

  // Add click handler for folder opening
  addFolderClickHandler(barContainer);

  // Create the fill element at 5% height
  const fill = document.createElement('div');
  fill.className = 'progress-bar-fill-vertical';
  fill.style.height = '5%'; // Start at 5%
  fill.style.backgroundColor = trackColor || '#B9FF37';

  barContainer.appendChild(fill);
  progressBarsArea.appendChild(barContainer);

  // Store state
  progressBarStates.set(trackId, {
    state: PROGRESS_BAR_STATES.DOWNLOADING,
    artist: '',
    track: '',
    album: '',
    filePath: '',
    progress: 5,
    createdAt: Date.now(),
    completedAt: null
  });

  console.log('[Hydra+ PROGRESS] ✓ New downloading bar created at 5% (100% opacity):', filename.substring(0, 30));
}

// Store completed downloads persistently (moved from completionTimes)
let completedDownloads = new Map(); // trackId -> {filename, progress, filePath, completedAt, trackId}

// Cache the pattern so we don't need async lookup every time
let cachedTooltipPattern = '{artist} - {track}';

// Load pattern on startup
chrome.storage.sync.get(['singleTrackPattern'], (data) => {
  if (data.singleTrackPattern) {
    cachedTooltipPattern = data.singleTrackPattern;
  }
});

// Listen for pattern changes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.singleTrackPattern) {
    cachedTooltipPattern = changes.singleTrackPattern.newValue || '{artist} - {track}';
  }
});

// Generate tooltip text based on user's file naming pattern (synchronous)
function generateTooltipText(artist, track, album, trackNum = '') {
  // Use cached pattern (already loaded from storage)
  let pattern = cachedTooltipPattern;

  // If no metadata provided, return fallback
  if (!artist && !track && !album) {
    return 'Downloading...';
  }

  // Replace tokens with actual values
  let text = pattern;
  text = text.replace(/\{artist\}/g, artist || '');
  text = text.replace(/\{track\}/g, track || '');
  text = text.replace(/\{album\}/g, album || '');
  text = text.replace(/\{trackNum\}/g, trackNum || '');
  text = text.replace(/\{year\}/g, ''); // Year not available in progress data

  // Clean up extra spaces/separators
  text = text.replace(/\s+/g, ' ').replace(/\s*-\s*-\s*/g, ' - ').trim();
  text = text.replace(/^-\s*/, '').replace(/\s*-$/, '');

  // Fallback if empty after cleanup
  if (!text || text === '-') {
    return 'Downloading...';
  }

  return text;
}

// Update vertical progress bars in separate section above Activity Log
function updateProgressBars(activeDownloads) {
  console.log('[Hydra+ PROGRESS] updateProgressBars called, downloads:', Object.keys(activeDownloads).length);
  const now = Date.now();
  let hasActiveBars = false;

  // Update progress from activeDownloads
  for (const [trackId, progressData] of Object.entries(activeDownloads)) {
    const { filename, artist, track, album, progress, filePath, imageUrl } = progressData;

    // Update or create state
    if (!progressBarStates.has(trackId)) {
      // New download - create state
      progressBarStates.set(trackId, {
        state: PROGRESS_BAR_STATES.DOWNLOADING,
        artist: artist || '',
        track: track || '',
        album: album || '',
        filePath: filePath || '',
        imageUrl: imageUrl || '',
        progress: progress,
        createdAt: now,
        completedAt: null
      });
    } else {
      // Update existing state
      const state = progressBarStates.get(trackId);
      state.artist = artist || state.artist;
      state.track = track || state.track;
      state.album = album || state.album;
      state.filePath = filePath || state.filePath;
      state.imageUrl = imageUrl || state.imageUrl;
      state.progress = progress;

      // Transition to completed state if progress = 100
      if (progress >= 100 && state.state !== PROGRESS_BAR_STATES.COMPLETED) {
        console.log('[Hydra+ PROGRESS] ✓ Download completed:', artist || filename, '-', track || '');
        state.state = PROGRESS_BAR_STATES.COMPLETED;
        state.completedAt = now;
      }

      progressBarStates.set(trackId, state);
    }
  }

  // CRITICAL: Don't remove bars! Only remove if:
  // 1. Completed more than 2 minutes ago
  // 2. User manually clears them
  const TWO_MINUTES = 2 * 60 * 1000;
  const existingBars = progressBarsArea.querySelectorAll('.vertical-progress-bar');
  existingBars.forEach(bar => {
    const trackId = bar.getAttribute('data-track-id');
    const state = progressBarStates.get(trackId);

    // Remove only if completed and expired
    if (state && state.state === PROGRESS_BAR_STATES.COMPLETED && state.completedAt) {
      if (now - state.completedAt > TWO_MINUTES) {
        console.log('[Hydra+ PROGRESS] Removing expired bar (completed 2+ min ago):', trackId.substring(0, 10));
        bar.remove();
        progressBarStates.delete(trackId);
      }
    }
  });

  // Update all bars based on progressBarStates
  // STABLE ORDER: Sort by creation timestamp (oldest first) to maintain consistent visual order
  const sortedStates = Array.from(progressBarStates.entries()).sort((a, b) => {
    return a[1].createdAt - b[1].createdAt; // Oldest on left, newest on right
  });

  for (const [trackId, state] of sortedStates) {
    const { artist, track, album, progress, filePath, imageUrl } = state;
    const isComplete = progress >= 100;

    // Debug: Log metadata
    if (artist || track) {
      console.log('[Hydra+ PROGRESS] Metadata for', trackId.substring(0, 10), ':', { artist, track, album, imageUrl: imageUrl || '(none)' });
    }

    // Get unique track color (matches console log color)
    const trackColor = getTrackColor(trackId);

    // Generate tooltip text from metadata
    const tooltipText = generateTooltipText(artist, track, album);
    console.log('[Hydra+ PROGRESS] Tooltip text:', tooltipText);

    // Find existing bar or create new one
    let barContainer = progressBarsArea.querySelector(`[data-track-id="${trackId}"]`);

    if (!barContainer) {
      // Create new vertical bar
      console.log('[Hydra+ PROGRESS] Creating new bar for:', tooltipText, 'progress:', progress, 'state:', state.state);
      barContainer = document.createElement('div');
      barContainer.className = `vertical-progress-bar state-${state.state}`;
      barContainer.setAttribute('data-track-id', trackId);
      barContainer.setAttribute('data-track-color', trackColor); // Store color for hover tooltip
      barContainer.setAttribute('data-artist', artist || '');
      barContainer.setAttribute('data-track', track || '');
      barContainer.setAttribute('data-album', album || '');

      // Store file path for folder opening
      if (filePath) {
        barContainer.setAttribute('data-file-path', filePath);
      }

      // Store image URL for thumbnail display
      if (imageUrl) {
        barContainer.setAttribute('data-image-url', imageUrl);
      }

      // Add hover listener to show track info in header
      addTrackInfoHover(barContainer);

      // Add click handler for folder opening
      addFolderClickHandler(barContainer);

      // Create the fill element (grows from bottom)
      const fill = document.createElement('div');
      fill.className = 'progress-bar-fill-vertical';
      // Ensure minimum visibility (5% minimum)
      const displayProgress = Math.max(5, progress);
      fill.style.height = `${displayProgress}%`;
      fill.style.backgroundColor = trackColor || '#B9FF37';

      // Add completed class if already at 100%
      if (isComplete) {
        barContainer.classList.add('completed');
        fill.classList.add('completed');
      }

      barContainer.appendChild(fill);

      // Insert bar in correct position based on createdAt timestamp
      // This maintains consistent visual order even when bars are created out of order
      const existingBars = Array.from(progressBarsArea.querySelectorAll('.vertical-progress-bar'));
      let insertPosition = null;

      for (const existingBar of existingBars) {
        const existingTrackId = existingBar.getAttribute('data-track-id');
        const existingState = progressBarStates.get(existingTrackId);

        if (existingState && existingState.createdAt > state.createdAt) {
          insertPosition = existingBar;
          break;
        }
      }

      if (insertPosition) {
        progressBarsArea.insertBefore(barContainer, insertPosition);
      } else {
        progressBarsArea.appendChild(barContainer);
      }
    } else {
      // Update existing bar
      console.log('[Hydra+ PROGRESS] Updating bar for:', tooltipText, 'progress:', progress, 'state:', state.state);

      // Update state class
      barContainer.className = `vertical-progress-bar state-${state.state}`;

      // Update data attributes (including imageUrl if it becomes available)
      if (imageUrl && !barContainer.getAttribute('data-image-url')) {
        barContainer.setAttribute('data-image-url', imageUrl);
      }

      const fill = barContainer.querySelector('.progress-bar-fill-vertical');
      if (fill) {
        // Ensure minimum visibility (5% minimum)
        const displayProgress = Math.max(5, progress);
        fill.style.height = `${displayProgress}%`;
        fill.style.backgroundColor = trackColor || '#B9FF37';

        // Add completed class when reaching 100%
        if (isComplete) {
          if (!barContainer.classList.contains('completed')) {
            barContainer.classList.add('completed');
            fill.classList.add('completed');
          }
        } else {
          barContainer.classList.remove('completed');
          fill.classList.remove('completed');
        }
      }

      // Update tooltip text and metadata attributes
      const tooltip = barContainer.querySelector('.progress-bar-tooltip');
      if (tooltip) {
        tooltip.textContent = tooltipText;
      }
      barContainer.setAttribute('data-artist', artist || '');
      barContainer.setAttribute('data-track', track || '');
      barContainer.setAttribute('data-album', album || '');

      // Update file path
      if (filePath) {
        barContainer.setAttribute('data-file-path', filePath);
      }
    }
    hasActiveBars = true;
  }

  // Log progress bar status (section is always visible)
  console.log('[Hydra+ PROGRESS] Active bars:', progressBarStates.size);
  if (progressBarStates.size > 0) {
    console.log('[Hydra+ PROGRESS] ✓ Showing', progressBarStates.size, 'vertical progress bar(s)');
  } else {
    console.log('[Hydra+ PROGRESS] No progress bars - all cleared or expired');
  }
}

// Clear all progress bars (section remains visible, just empty)
function clearProgressBars() {
  progressBarsContainer.innerHTML = '';
  completionTimes.clear();
  progressBarStates.clear(); // Clear state tracking
  completedDownloads.clear(); // Clear completed downloads
  console.log('[Hydra+ PROGRESS] All progress bars and states cleared');
}

// Load active downloads on popup open
loadActiveDownloads();

// Poll for progress updates every 0.5 seconds for smooth animation
setInterval(() => {
  loadActiveDownloads();
}, 500);

// Add mouseleave listener to clear track info when mouse leaves progress bars
progressBarsContainer.addEventListener('mouseleave', () => {
  currentTrackInfo.textContent = '';
  currentTrackInfo.style.color = '#B9FF37'; // Reset to default accent color

  // Hide album artwork thumbnail
  albumArtThumbnail.classList.remove('visible');
  albumArtThumbnail.src = '';
});

// Demo mode: Simulate events for testing (remove this in production)
// This demonstrates different event types when server doesn't provide events yet
window.addEventListener('load', () => {
  // Check if we should run demo mode (only if no events exist and it's first load)
  chrome.storage.local.get(['hasShownDemo', 'consoleEvents'], (data) => {
    if (!data.hasShownDemo && (!data.consoleEvents || data.consoleEvents.length === 0)) {
      // Mark demo as shown
      safeStorageSet({ hasShownDemo: true });

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
  chrome.storage.sync.get(['autoDownload', 'formatPreference', 'metadataOverride', 'spotifyClientId', 'spotifyClientSecret', 'spotifyApiConnected', 'debugWindows'], async (data) => {
    // Auto-download defaults to true
    autoDownloadToggle.checked = data.autoDownload !== false;

    // Format preference: 'mp3' (default) or 'flac'
    // Toggle unchecked = MP3, checked = FLAC
    formatPreferenceToggle.checked = data.formatPreference === 'flac';
    updateFormatLabels();

    metadataOverrideToggle.checked = data.metadataOverride !== false; // Default to true
    debugWindowsToggle.checked = data.debugWindows === true; // Default to false
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
            safeStorageSyncSet({ spotifyApiConnected: isConnected });

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
  safeStorageSyncSet({ autoDownload }, () => {
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
  safeStorageSyncSet({ formatPreference }, () => {
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
  safeStorageSyncSet({ metadataOverride }, () => {
    console.log('Metadata override setting saved:', metadataOverride);
  });
  updateCredentialsSectionVisibility();
});

debugWindowsToggle.addEventListener('change', () => {
  const debugWindows = debugWindowsToggle.checked;
  safeStorageSyncSet({ debugWindows }, () => {
    console.log('[Hydra+] Debug windows setting saved:', debugWindows);
  });
  // Send to server immediately
  sendDebugSettingToServer();
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

      // Enhanced status display with more insights
      let statusParts = ['Server online'];

      // Show processing status if available
      if (data.processing > 0) {
        statusParts.push(`<span style="color: #B9FF37;">${data.processing} active</span>`);
      }

      // Show queue size if available
      if (data.unprocessed > 0) {
        statusParts.push(`${data.unprocessed} queued`);
      }

      serverStatusText.innerHTML = statusParts.join(' • ');

      const wasOffline = !isServerOnline;
      isServerOnline = true;
      updateSaveButtonState();

      // IMPROVED: Send credentials and patterns only once when server comes online (not on every check)
      if (wasOffline) {
        sendCredentialsToServer();
        sendPatternsToServer();
        sendDebugSettingToServer();
        // Only log connection once when transitioning from offline to online
        addConsoleEvent('success', 'Bridge server connected');
      }

      // Note: Events are processed by background.js and stored in chrome.storage.local
      // Popup loads events from storage on startup via loadConsoleEvents()
      // This prevents duplicate processing and filtering issues
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

// Events are tracked and stored by background.js
// Popup loads events from storage via loadConsoleEvents()

// Auto-save credentials when fields change (debounced)
let saveTimeout;
function autoSaveCredentials() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const clientId = spotifyClientId.value.trim();
    const clientSecret = spotifyClientSecret.value.trim();

    // Save to storage
    safeStorageSyncSet({
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
    safeStorageSyncSet({
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
    safeStorageSyncSet({
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

// Send debug windows setting to server
function sendDebugSettingToServer() {
  chrome.storage.sync.get(['debugWindows'], (data) => {
    const debugWindows = data.debugWindows === true;

    if (isServerOnline) {
      fetch(`${BRIDGE_URL}/set-debug-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          debugWindows: debugWindows
        })
      }).catch(err => {
        if (isServerOnline) {
          console.error('Failed to send debug setting to server:', err);
        }
      });

      console.log('[Hydra+] Debug windows setting sent to server:', debugWindows);
      const statusMsg = debugWindows ? '🐛 Debug mode enabled - restart required' : 'Debug mode disabled - restart required';
      addConsoleEvent('info', statusMsg);
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
            sendDebugSettingToServer();

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
  artist: 'Prince',
  track: 'Purple Rain',
  album: 'Purple Rain',
  year: '1984',
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
  const singlePattern = singleTrackPattern.value || singleTrackPattern.placeholder || '{artist} - {track}';
  const albumPattern = albumTrackPattern.value || albumTrackPattern.placeholder || '{trackNum} {artist} - {track}';

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

// Preset pattern definitions for each field
const singleTrackPresets = [
  'custom',
  '{artist} - {track}',
  '{track}',
  '{artist} - {track} ({year})'
];

const albumTrackPresets = [
  'custom',
  '{trackNum} {artist} - {track}',
  '{trackNum} - {track}',
  '{trackNum} {track}',
  '{trackNum} - {album} - {track}'
];

// Update active dot for a specific field
function updateActiveDot(dotsContainer, pattern, presets) {
  const dots = dotsContainer.querySelectorAll('.preset-dot');
  let activeIndex = -1;

  // Find matching preset
  if (pattern) {
    activeIndex = presets.indexOf(pattern);
  }

  // If no match or empty, activate custom (index 0)
  if (activeIndex === -1) {
    activeIndex = 0;
  }

  // Update dots
  dots.forEach((dot, i) => {
    if (i === activeIndex) {
      dot.classList.add('active');
    } else {
      dot.classList.remove('active');
    }
  });
}

// Apply preset to a specific field
function applyPresetToField(inputField, pattern, dotsContainer, presets) {
  if (pattern === 'custom') {
    inputField.value = '';
    inputField.focus();
  } else {
    inputField.value = pattern;
  }

  updateActiveDot(dotsContainer, pattern, presets);
  updatePreviews();
  savePatterns();
}

// Handle single track preset dots
singlePresetDots.addEventListener('click', (e) => {
  const dot = e.target.closest('.preset-dot');
  if (!dot) return;

  const pattern = dot.getAttribute('data-preset');
  applyPresetToField(singleTrackPattern, pattern, singlePresetDots, singleTrackPresets);
});

// Handle album track preset dots
albumPresetDots.addEventListener('click', (e) => {
  const dot = e.target.closest('.preset-dot');
  if (!dot) return;

  const pattern = dot.getAttribute('data-preset');
  applyPresetToField(albumTrackPattern, pattern, albumPresetDots, albumTrackPresets);
});

// Load saved patterns
function loadPatterns() {
  chrome.storage.sync.get(['singleTrackPattern', 'albumTrackPattern'], (data) => {
    const singlePattern = data.singleTrackPattern || '{artist} - {track}';
    const albumPattern = data.albumTrackPattern || '{trackNum} {artist} - {track}';

    singleTrackPattern.value = singlePattern;
    albumTrackPattern.value = albumPattern;

    // Update dots for each field independently
    updateActiveDot(singlePresetDots, singlePattern, singleTrackPresets);
    updateActiveDot(albumPresetDots, albumPattern, albumTrackPresets);

    updatePreviews();

    // Send to server when loaded
    sendPatternToServer(singlePattern, albumPattern);
  });
}

// Input change handlers with debouncing
let patternSaveTimeout;
function savePatterns() {
  clearTimeout(patternSaveTimeout);
  patternSaveTimeout = setTimeout(() => {
    const singlePattern = singleTrackPattern.value.trim() || '{artist} - {track}';
    const albumPattern = albumTrackPattern.value.trim() || '{trackNum} {artist} - {track}';

    safeStorageSyncSet({
      singleTrackPattern: singlePattern,
      albumTrackPattern: albumPattern
    }, () => {
      console.log('[Hydra+] Patterns saved:', { singlePattern, albumPattern });
      updatePreviews();
      sendPatternToServer(singlePattern, albumPattern);
    });
  }, 500);
}

singleTrackPattern.addEventListener('input', () => {
  // Update dots based on current value
  updateActiveDot(singlePresetDots, singleTrackPattern.value, singleTrackPresets);
  updatePreviews();
  savePatterns();
});

albumTrackPattern.addEventListener('input', () => {
  // Update dots based on current value
  updateActiveDot(albumPresetDots, albumTrackPattern.value, albumTrackPresets);
  updatePreviews();
  savePatterns();
});

// Load patterns on startup
loadPatterns();
