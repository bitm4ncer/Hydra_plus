#!/usr/bin/env node

/**
 * Hydra+ State Server
 *
 * Lightweight server that manages application state:
 * - Progress tracking (activeDownloads Map)
 * - Event log (events array)
 * - Queue management (nicotine-queue.json)
 * - Credentials storage
 *
 * This server NEVER crashes because it does no heavy processing.
 * Port: 3847
 */

const http = require('http');
const fs = require('fs');
const { promises: fsPromises } = require('fs');
const path = require('path');

// Configuration
const PORT = 3847;
const QUEUE_FILE = path.join(__dirname, 'nicotine-queue.json');
const CREDENTIALS_FILE = path.join(__dirname, 'spotify-credentials.json');
const DEBUG_SETTINGS_FILE = path.join(__dirname, 'debug-settings.json');

// Health metrics
const healthMetrics = {
  startTime: Date.now(),
  requestCount: 0,
  errorCount: 0,
  lastHealthCheck: Date.now()
};

// Event tracking with TTL and size limits
const MAX_EVENTS = 50;
const EVENT_MAX_AGE = 60 * 60 * 1000; // 1 hour TTL
let eventIdCounter = 0;
const events = [];

// Active download progress tracking
// Key: trackId, Value: {filename, progress, bytesDownloaded, totalBytes, lastUpdate}
const activeDownloads = new Map();
const PROGRESS_MAX_AGE = 10 * 60 * 1000; // 10 minutes TTL

// Spotify credentials (stored in memory after load)
let spotifyCredentials = {
  clientId: null,
  clientSecret: null
};

// File rename patterns
let renamePatterns = {
  singleTrack: '{artist} - {track}',
  albumTrack: '{trackNum} {artist} - {track}'
};

// Debug mode setting (controls terminal window visibility)
let debugMode = {
  debugWindows: false
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Cleanup old events based on age
 */
function cleanupOldEvents() {
  const now = Date.now();
  const cutoffTime = now - EVENT_MAX_AGE;

  let removed = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const eventTime = new Date(events[i].timestamp).getTime();
    if (eventTime < cutoffTime) {
      events.splice(i, 1);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[Hydra+ STATE] Cleaned ${removed} old events`);
  }
}

/**
 * Add event to tracking (for popup console)
 */
function addEvent(type, message, trackId = null) {
  const event = {
    id: ++eventIdCounter,
    type: type, // 'info', 'success', 'error', 'warning'
    message: message,
    timestamp: new Date().toISOString(),
    trackId: trackId // Optional: for color-coding concurrent tracks in popup
  };

  events.push(event);

  // Keep only last MAX_EVENTS
  if (events.length > MAX_EVENTS) {
    events.shift();
  }

  // Periodic cleanup (every 50 events)
  if (events.length % 50 === 0) {
    cleanupOldEvents();
  }
}

/**
 * Update or add download progress
 */
function updateDownloadProgress(trackId, filename, progress, bytesDownloaded, totalBytes) {
  const now = Date.now();
  const existingEntry = activeDownloads.get(trackId);

  if (!existingEntry) {
    console.log(`[Hydra+ STATE] ✓ NEW download tracked: ${filename.substring(0, 40)} (ID: ${trackId})`);
  }

  activeDownloads.set(trackId, {
    filename,
    progress,
    bytesDownloaded,
    totalBytes,
    lastUpdate: now,
    completedAt: progress >= 100 ? (existingEntry?.completedAt || now) : null
  });

  console.log(`[Hydra+ STATE] activeDownloads size: ${activeDownloads.size}`);
}

/**
 * Cleanup stale progress entries
 */
function cleanupStaleProgress() {
  const now = Date.now();
  const completedCutoff = now - 60000; // 1 minute after completion

  let removed = 0;
  for (const [trackId, progressData] of activeDownloads.entries()) {
    // Remove if stale (no updates in 10 minutes and not complete)
    if (!progressData.completedAt && (now - progressData.lastUpdate) > PROGRESS_MAX_AGE) {
      activeDownloads.delete(trackId);
      removed++;
      continue;
    }

    // Remove if completed over 1 minute ago
    if (progressData.completedAt && (now - progressData.completedAt) > completedCutoff) {
      activeDownloads.delete(trackId);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[Hydra+ STATE] Cleaned ${removed} stale/completed progress entries`);
  }
}

/**
 * Load Spotify credentials from file
 */
async function loadSpotifyCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      const data = await fsPromises.readFile(CREDENTIALS_FILE, 'utf8');
      const creds = JSON.parse(data);
      spotifyCredentials.clientId = creds.clientId || null;
      spotifyCredentials.clientSecret = creds.clientSecret || null;
      console.log('[Hydra+ STATE] ✓ Loaded saved credentials');
    }
  } catch (error) {
    console.log('[Hydra+ STATE] No saved credentials found (first run)');
  }
}

/**
 * Save Spotify credentials to file
 */
async function saveSpotifyCredentials() {
  try {
    await fsPromises.writeFile(
      CREDENTIALS_FILE,
      JSON.stringify(spotifyCredentials, null, 2),
      'utf8'
    );
    console.log('[Hydra+ STATE] ✓ Credentials saved');
  } catch (error) {
    console.error('[Hydra+ STATE] ✗ Error saving credentials:', error.message);
  }
}

/**
 * Load debug settings from file
 */
async function loadDebugSettings() {
  try {
    if (fs.existsSync(DEBUG_SETTINGS_FILE)) {
      const data = await fsPromises.readFile(DEBUG_SETTINGS_FILE, 'utf8');
      const settings = JSON.parse(data);
      debugMode.debugWindows = settings.debugWindows || false;
      console.log('[Hydra+ STATE] ✓ Loaded debug settings:', debugMode);
    }
  } catch (error) {
    console.log('[Hydra+ STATE] No saved debug settings found (using defaults)');
  }
}

/**
 * Save debug settings to file
 */
async function saveDebugSettings() {
  try {
    await fsPromises.writeFile(
      DEBUG_SETTINGS_FILE,
      JSON.stringify(debugMode, null, 2),
      'utf8'
    );
    console.log('[Hydra+ STATE] ✓ Debug settings saved');
  } catch (error) {
    console.error('[Hydra+ STATE] ✗ Error saving debug settings:', error.message);
  }
}

// ============================================================================
// QUEUE FILE OPERATIONS
// ============================================================================

/**
 * Read queue from file
 * Handles both old format {searches: [...]} and new format [...]
 */
async function readQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const data = await fsPromises.readFile(QUEUE_FILE, 'utf8');
      const parsed = JSON.parse(data);

      // Handle old format: {searches: [...]}
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.searches)) {
        return parsed.searches;
      }

      // Handle new format: [...]
      if (Array.isArray(parsed)) {
        return parsed;
      }

      // Invalid format
      console.error('[Hydra+ STATE] ✗ Queue file has invalid format, resetting to empty array');
      return [];
    }
    return [];
  } catch (error) {
    console.error('[Hydra+ STATE] ✗ Error reading queue:', error.message);
    return [];
  }
}

/**
 * Write queue to file (new format: direct array)
 */
async function writeQueue(queue) {
  try {
    await fsPromises.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
  } catch (error) {
    console.error('[Hydra+ STATE] ✗ Error writing queue:', error.message);
  }
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = http.createServer(async (req, res) => {
  healthMetrics.requestCount++;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // ============================================================================
  // GET /ping - Health check
  // ============================================================================
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
    return;
  }

  // ============================================================================
  // GET /status - Return events + activeDownloads
  // ============================================================================
  if (req.method === 'GET' && req.url === '/status') {
    // Convert Map to object for JSON serialization
    const activeDownloadsObj = {};
    for (const [key, value] of activeDownloads.entries()) {
      activeDownloadsObj[key] = value;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      totalEvents: events.length,
      events: events,
      activeDownloads: activeDownloadsObj,
      serverUptime: Date.now() - healthMetrics.startTime,
      requestCount: healthMetrics.requestCount
    }));
    return;
  }

  // ============================================================================
  // POST /progress - Update download progress (FIRE-AND-FORGET)
  // ============================================================================
  if (req.method === 'POST' && req.url === '/progress') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { trackId, filename, progress, bytesDownloaded, totalBytes } = data;

        // CRITICAL: Return immediately (fire-and-forget)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));

        // Process progress update asynchronously
        setImmediate(() => {
          if (progress === 0 || progress >= 100 || Math.floor(progress) % 10 === 0) {
            console.log(`[Hydra+ STATE] ${filename.substring(0, 40)}: ${Math.round(progress)}%`);
          }
          updateDownloadProgress(trackId, filename, progress, bytesDownloaded, totalBytes);
        });
      } catch (error) {
        console.error('[Hydra+ STATE] ✗ Progress error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });

    return;
  }

  // ============================================================================
  // POST /remove-progress - Remove download from tracking
  // ============================================================================
  if (req.method === 'POST' && req.url === '/remove-progress') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { trackId } = data;

        if (trackId && activeDownloads.has(trackId)) {
          const progressData = activeDownloads.get(trackId);
          activeDownloads.delete(trackId);
          console.log(`[Hydra+ STATE] Removed: ${progressData.filename.substring(0, 40)}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        console.error('[Hydra+ STATE] ✗ Remove progress error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });

    return;
  }

  // ============================================================================
  // POST /clear-progress - Clear all progress
  // ============================================================================
  if (req.method === 'POST' && req.url === '/clear-progress') {
    const count = activeDownloads.size;
    activeDownloads.clear();
    console.log(`[Hydra+ STATE] Cleared ${count} downloads`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, cleared: count }));
    return;
  }

  // ============================================================================
  // POST /event - Add console event (FIRE-AND-FORGET)
  // ============================================================================
  if (req.method === 'POST' && req.url === '/event') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { type, message, trackId } = data;

        // CRITICAL: Return immediately
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));

        // Process event asynchronously
        setImmediate(() => {
          console.log(`[Hydra+ STATE] Event: [${type}] ${message.substring(0, 60)}`);
          addEvent(type || 'info', message, trackId);
        });
      } catch (error) {
        console.error('[Hydra+ STATE] ✗ Event error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });

    return;
  }

  // ============================================================================
  // GET /pending - Get unprocessed searches
  // ============================================================================
  if (req.method === 'GET' && req.url === '/pending') {
    const queue = await readQueue();
    const pending = queue.filter(item => !item.processed);

    // Only log when there are pending searches (reduce spam)
    if (pending.length > 0) {
      console.log(`[Hydra+ STATE] /pending called - returning ${pending.length} unprocessed searches`);
      console.log(`[Hydra+ STATE] First pending: ${pending[0].artist || pending[0].query} - ${pending[0].track || 'search'}`);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Return as 'searches' for backward compatibility with Python plugin
    res.end(JSON.stringify({ searches: pending }));
    return;
  }

  // ============================================================================
  // POST /mark-processed - Mark searches as processed
  // ============================================================================
  if (req.method === 'POST' && req.url === '/mark-processed') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        // Handle both old format (timestamp) and new format (search_ids array)
        const queue = await readQueue();
        let markedCount = 0;

        if (data.timestamp) {
          // Old format: {timestamp: "..."}
          for (const item of queue) {
            if (item.timestamp === data.timestamp) {
              item.processed = true;
              markedCount++;
            }
          }
        } else if (data.search_ids && Array.isArray(data.search_ids)) {
          // New format: {search_ids: [...]}
          for (const item of queue) {
            if (data.search_ids.includes(item.search_id)) {
              item.processed = true;
              markedCount++;
            }
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Missing timestamp or search_ids' }));
          return;
        }

        await writeQueue(queue);

        console.log(`[Hydra+ STATE] ✓ Marked ${markedCount} search(es) as processed`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        console.error('[Hydra+ STATE] ✗ Mark processed error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });

    return;
  }

  // ============================================================================
  // POST /search - Queue single track search
  // ============================================================================
  if (req.method === 'POST' && req.url === '/search') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        // Handle both old format (with 'query' field) and new format (with 'artist' and 'track')
        let artist = data.artist || '';
        let track = data.track || '';
        let query = data.query || '';

        // If query is provided but artist/track are empty, use query as track
        if (query && !artist && !track) {
          track = query;
        }

        // Validate that we have something to search
        if (!artist && !track && !query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Missing artist, track, or query field' }));
          return;
        }

        const queue = await readQueue();
        const searchEntry = {
          search_id: Date.now(),
          type: 'track',
          query: query,  // Keep original query for compatibility
          artist: artist,
          track: track,
          album: data.album || '',
          duration: data.duration || 0,
          format: data.format || data.format_preference || 'mp3',
          track_id: data.track_id || null,
          auto_download: data.auto_download !== undefined ? data.auto_download : true,
          metadata_override: data.metadata_override !== false,  // Default to true
          processed: false,
          timestamp: new Date().toISOString()
        };

        queue.push(searchEntry);
        await writeQueue(queue);

        console.log(`[Hydra+ STATE] ✓ Queued: ${artist || query} - ${track || 'search'}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, search_id: searchEntry.search_id }));
      } catch (error) {
        console.error('[Hydra+ STATE] ✗ Search error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });

    return;
  }

  // ============================================================================
  // POST /search-album - Queue album search
  // ============================================================================
  if (req.method === 'POST' && req.url === '/search-album') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        // DEBUG: Log received data to understand what's being sent
        console.log(`[Hydra+ STATE] DEBUG: Received album search data:`, JSON.stringify(data, null, 2));

        const queue = await readQueue();

        // Extract artist and album with all format support
        const artist = data.artist || data.album_artist || data.albumArtist || '';
        const album = data.album || data.album_name || data.albumName || '';

        const searchEntry = {
          search_id: Date.now(),
          type: 'album',
          query: `${artist} ${album}`,  // Generate query for Python plugin
          artist: artist,
          album: album,
          album_name: album,      // Add for Python compatibility
          album_artist: artist,   // Add for Python compatibility
          tracks: data.tracks || [],
          format: data.format || data.format_preference || 'MP3',
          format_preference: (data.format || data.format_preference || 'MP3').toLowerCase(),
          album_id: data.album_id || data.albumId || null,
          year: data.year || null,
          auto_download: data.auto_download !== undefined ? data.auto_download : true,
          metadata_override: data.metadata_override !== undefined ? data.metadata_override : true,
          processed: false,
          timestamp: new Date().toISOString()
        };

        queue.push(searchEntry);
        await writeQueue(queue);

        console.log(`[Hydra+ STATE] ✓ Queued album: ${artist} - ${album} (${data.tracks.length} tracks)`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, search_id: searchEntry.search_id }));
      } catch (error) {
        console.error('[Hydra+ STATE] ✗ Album search error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });

    return;
  }

  // ============================================================================
  // POST /set-spotify-credentials - Save API credentials
  // ============================================================================
  if (req.method === 'POST' && req.url === '/set-spotify-credentials') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        spotifyCredentials.clientId = data.clientId || null;
        spotifyCredentials.clientSecret = data.clientSecret || null;

        await saveSpotifyCredentials();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        console.error('[Hydra+ STATE] ✗ Set credentials error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });

    return;
  }

  // ============================================================================
  // POST /test-spotify-credentials - Test if credentials work
  // ============================================================================
  if (req.method === 'POST' && req.url === '/test-spotify-credentials') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      hasCredentials: !!(spotifyCredentials.clientId && spotifyCredentials.clientSecret)
    }));
    return;
  }

  // ============================================================================
  // POST /set-rename-pattern - Save file rename patterns
  // ============================================================================
  if (req.method === 'POST' && req.url === '/set-rename-pattern') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.singleTrack) renamePatterns.singleTrack = data.singleTrack;
        if (data.albumTrack) renamePatterns.albumTrack = data.albumTrack;

        console.log('[Hydra+ STATE] ✓ Rename pattern updated:', renamePatterns);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, patterns: renamePatterns }));
      } catch (error) {
        console.error('[Hydra+ STATE] ✗ Set pattern error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });

    return;
  }

  // ============================================================================
  // POST /set-debug-mode - Save debug windows setting
  // ============================================================================
  if (req.method === 'POST' && req.url === '/set-debug-mode') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (typeof data.debugWindows === 'boolean') {
          debugMode.debugWindows = data.debugWindows;
        }

        // Persist to file
        await saveDebugSettings();

        console.log('[Hydra+ STATE] ✓ Debug mode updated and saved:', debugMode);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, debugMode: debugMode }));
      } catch (error) {
        console.error('[Hydra+ STATE] ✗ Set debug mode error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });

    return;
  }

  // ============================================================================
  // GET /get-debug-mode - Get current debug windows setting
  // ============================================================================
  if (req.method === 'GET' && req.url === '/get-debug-mode') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, debugMode: debugMode }));
    return;
  }

  // ============================================================================
  // POST /restart - Restart the server
  // ============================================================================
  if (req.method === 'POST' && req.url === '/restart') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Restarting server...' }));

    // Exit gracefully - plugin will detect and restart
    console.log('[Hydra+ STATE] ⚠️ Restart requested via API');
    setTimeout(() => {
      process.exit(0);
    }, 500);

    return;
  }

  // 404 - Not Found
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

server.listen(PORT, async () => {
  await loadSpotifyCredentials();
  await loadDebugSettings();

  // Set console window title on Windows
  if (process.platform === 'win32') {
    process.title = 'Hydra+ State Server (Port 3847)';
  }

  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  >> HYDRA+ STATE SERVER <<');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  [PORT]      → ${PORT}`);
  console.log('  [STATUS]    → 🟢 ONLINE');
  console.log('  [ROLE]      → State Management (Progress, Events, Queue)');
  console.log('  [ENDPOINTS] → /status /progress /event /search /pending');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('');
});

// Periodic cleanup
setInterval(() => {
  cleanupStaleProgress();
  cleanupOldEvents();
}, 60000); // Every minute

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Hydra+ STATE] Shutting down gracefully...');
  server.close(() => {
    console.log('[Hydra+ STATE] Server closed');
    process.exit(0);
  });
});

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('[Hydra+ STATE] CRITICAL - Uncaught exception:', error);
  healthMetrics.errorCount++;
  // Don't exit - state server must stay up!
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Hydra+ STATE] Unhandled rejection:', reason);
  healthMetrics.errorCount++;
  // Don't exit - state server must stay up!
});
