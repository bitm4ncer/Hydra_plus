#!/usr/bin/env node

/**
 * Nicotine+ Bridge Server
 *
 * This Node.js server acts as a bridge between the browser extension
 * and the Nicotine+ plugin. It receives track information from the browser
 * and writes it to a file that the Nicotine+ plugin monitors.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const { promises: fsPromises } = require('fs');
const path = require('path');

// IMPROVED: Configure HTTP agents with optimized connection management
// Prevents connection pool exhaustion while avoiding socket hoarding
const httpAgent = new http.Agent({
  maxSockets: 20,           // Max concurrent connections per host
  maxFreeSockets: 5,        // Max idle sockets to keep (prevent hoarding)
  timeout: 30000,           // Socket timeout: 30s
  keepAlive: true,
  keepAliveMsecs: 30000     // Keep alive for 30s, then recycle
});

const httpsAgent = new https.Agent({
  maxSockets: 20,           // Max concurrent HTTPS connections (for Spotify)
  maxFreeSockets: 5,        // Max idle sockets to keep
  timeout: 30000,           // Socket timeout: 30s
  keepAlive: true,
  keepAliveMsecs: 30000     // Keep alive for 30s, then recycle
});

// Load required npm packages with error handling
let NodeID3, FlacTagger;
try {
  NodeID3 = require('node-id3');
} catch (err) {
  console.error('[Hydra+] ERROR: node-id3 package not found!');
  console.error('[Hydra+] Please run: npm install');
  console.error('[Hydra+] Error:', err.message);
  process.exit(1);
}

try {
  FlacTagger = require('flac-tagger');
} catch (err) {
  console.error('[Hydra+] ERROR: flac-tagger package not found!');
  console.error('[Hydra+] Please run: npm install');
  console.error('[Hydra+] Error:', err.message);
  process.exit(1);
}

// Configuration
const PORT = 3847;
const QUEUE_FILE = path.join(__dirname, 'nicotine-queue.json');
const CREDENTIALS_FILE = path.join(__dirname, 'spotify-credentials.json');

// Metadata processing queue to prevent concurrent processing
const metadataQueue = [];
let isProcessingMetadata = false;
let activeProcessingCount = 0; // Track number of tracks currently being processed

// IMPROVED: LRU Cover art cache with size limits to prevent memory leaks
// Key: imageUrl, Value: { buffer: Buffer, timestamp: number, size: number }
const coverArtCache = new Map();
const COVER_ART_CACHE_MAX_SIZE = 50 * 1024 * 1024; // 50MB max cache size
const COVER_ART_CACHE_MAX_AGE = 5 * 60 * 1000; // 5 minutes TTL
let coverArtCacheTotalSize = 0;

// IMPROVED: Request tracking for cleanup (AbortController support)
const activeRequests = new Set(); // Track active HTTP requests
const activeTimeouts = new Set(); // Track all active timeouts for cleanup

// Health metrics for monitoring
const healthMetrics = {
  startTime: Date.now(),
  requestCount: 0,
  errorCount: 0,
  metadataProcessed: 0,
  cacheHits: 0,
  cacheMisses: 0,
  memoryPeakMB: 0,
  lastHealthCheck: Date.now()
};

// Note: Album batch processing is handled via sequential metadata queue processing
// which naturally prevents concurrent issues by processing one track at a time

// IMPROVED: Event tracking with TTL and size limits
const MAX_EVENTS = 50; // Reduced from 100 to save memory
const EVENT_MAX_AGE = 60 * 60 * 1000; // 1 hour TTL for events
let eventIdCounter = 0;
const events = [];

// Active download progress tracking
// Key: trackId, Value: {filename, progress, bytesDownloaded, totalBytes, lastUpdate}
const activeDownloads = new Map();
const PROGRESS_MAX_AGE = 10 * 60 * 1000; // 10 minutes TTL for stale progress entries

// IMPROVED: Helper to track timeouts for cleanup
function createTrackedTimeout(callback, delay) {
  const timeoutId = setTimeout(() => {
    activeTimeouts.delete(timeoutId);
    callback();
  }, delay);
  activeTimeouts.add(timeoutId);
  return timeoutId;
}

// IMPROVED: Helper to clear tracked timeout
function clearTrackedTimeout(timeoutId) {
  if (timeoutId) {
    clearTimeout(timeoutId);
    activeTimeouts.delete(timeoutId);
  }
}

// IMPROVED: Cleanup old events based on age
function cleanupOldEvents() {
  const now = Date.now();
  const cutoffTime = now - EVENT_MAX_AGE;

  // Remove events older than 1 hour
  let removed = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const eventTime = new Date(events[i].timestamp).getTime();
    if (eventTime < cutoffTime) {
      events.splice(i, 1);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[Hydra+: CLEANUP] Removed ${removed} old events`);
  }
}

// Add event to tracking (for popup console)
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

  // Periodically cleanup old events (every 100 events)
  if (eventIdCounter % 100 === 0) {
    cleanupOldEvents();
  }

  return event;
}

// Cleanup stale progress entries
function cleanupStaleProgress() {
  const now = Date.now();
  const staleCutoff = now - PROGRESS_MAX_AGE; // 10 minutes for stale
  const completedCutoff = 60000; // 1 minute for completed

  let removed = 0;
  for (const [trackId, progressData] of activeDownloads.entries()) {
    // Remove if stale (no updates in 10 minutes)
    if (progressData.lastUpdate < staleCutoff) {
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
    console.log(`[Hydra+: PROGRESS] Cleaned up ${removed} stale/completed progress entries`);
  }
}

// Update or add download progress
function updateDownloadProgress(trackId, filename, progress, bytesDownloaded, totalBytes) {
  const now = Date.now();
  const existingEntry = activeDownloads.get(trackId);

  activeDownloads.set(trackId, {
    filename,
    progress,
    bytesDownloaded,
    totalBytes,
    lastUpdate: now,
    completedAt: progress >= 100 ? (existingEntry?.completedAt || now) : null
  });

  // Auto-remove completed downloads after 1 minute
  if (progress >= 100) {
    const completedAt = existingEntry?.completedAt || now;
    if (now - completedAt > 60000) {
      activeDownloads.delete(trackId);
      console.log(`[Hydra+: PROGRESS] Auto-removed completed download: ${filename.substring(0, 40)}`);
    }
  }

  // Periodically cleanup stale entries (every 50 updates)
  if (activeDownloads.size > 0 && activeDownloads.size % 50 === 0) {
    cleanupStaleProgress();
  }
}

// Remove completed download from progress tracking
function removeDownloadProgress(trackId) {
  activeDownloads.delete(trackId);
}

// IMPROVED: LRU cache management for cover art
function evictOldestCacheEntry() {
  if (coverArtCache.size === 0) return;

  // Find oldest entry
  let oldestKey = null;
  let oldestTime = Infinity;

  for (const [key, value] of coverArtCache.entries()) {
    if (value.timestamp < oldestTime) {
      oldestTime = value.timestamp;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    const entry = coverArtCache.get(oldestKey);
    coverArtCacheTotalSize -= entry.size;
    coverArtCache.delete(oldestKey);
    console.log(`[Hydra+: CACHE] Evicted oldest entry (${Math.round(entry.size / 1024)}KB freed)`);
  }
}

// IMPROVED: Add cover art to cache with size management
function addToCoverArtCache(imageUrl, buffer) {
  const size = buffer.length;

  // Evict entries until we have room
  while (coverArtCacheTotalSize + size > COVER_ART_CACHE_MAX_SIZE && coverArtCache.size > 0) {
    evictOldestCacheEntry();
  }

  // If single image is larger than max cache, don't cache it
  if (size > COVER_ART_CACHE_MAX_SIZE) {
    console.log(`[Hydra+: CACHE] Image too large to cache (${Math.round(size / 1024 / 1024)}MB)`);
    return;
  }

  coverArtCache.set(imageUrl, {
    buffer: buffer,
    timestamp: Date.now(),
    size: size
  });

  coverArtCacheTotalSize += size;
  console.log(`[Hydra+: CACHE] Added to cache (${Math.round(size / 1024)}KB, total: ${Math.round(coverArtCacheTotalSize / 1024 / 1024)}MB)`);
}

// IMPROVED: Cleanup expired cache entries
function cleanupExpiredCache() {
  const now = Date.now();
  const cutoffTime = now - COVER_ART_CACHE_MAX_AGE;

  let removed = 0;
  let freedBytes = 0;

  for (const [key, value] of coverArtCache.entries()) {
    if (value.timestamp < cutoffTime) {
      freedBytes += value.size;
      coverArtCacheTotalSize -= value.size;
      coverArtCache.delete(key);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[Hydra+: CACHE] Expired ${removed} entries (${Math.round(freedBytes / 1024)}KB freed)`);
  }
}

// IMPROVED: Update health metrics
function updateHealthMetrics() {
  const memUsage = process.memoryUsage();
  const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);

  if (memMB > healthMetrics.memoryPeakMB) {
    healthMetrics.memoryPeakMB = memMB;
  }

  healthMetrics.lastHealthCheck = Date.now();
}

// Spotify API credentials (optional, set via extension popup)
let spotifyCredentials = {
  clientId: null,
  clientSecret: null,
  accessToken: null,
  tokenExpiry: 0
};

// File rename pattern (configurable via extension popup)
let renamePattern = {
  singleTrack: '{artist} - {track}',  // Default for single downloads
  albumTrack: '{trackNum} {artist} - {track}'  // Default for album downloads
};

// Initialize queue file if it doesn't exist
if (!fs.existsSync(QUEUE_FILE)) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify({ searches: [] }, null, 2));
}

// Load saved credentials from file if they exist
function loadCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
      spotifyCredentials.clientId = saved.clientId || null;
      spotifyCredentials.clientSecret = saved.clientSecret || null;

      if (spotifyCredentials.clientId && spotifyCredentials.clientSecret) {
        console.log('[Hydra+: API] ✓ Loaded saved credentials');
      }
    }
  } catch (error) {
    console.error('[Hydra+: API] ✗ Error loading credentials:', error.message);
  }
}

// Save credentials to file
function saveCredentials(clientId, clientSecret) {
  try {
    const data = { clientId, clientSecret };
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2));
    console.log('[Hydra+: API] ✓ Credentials saved');
  } catch (error) {
    console.error('[Hydra+: API] ✗ Error saving credentials:', error.message);
  }
}

// Load credentials on startup
loadCredentials();

/**
 * Clean up old processed searches (older than 1 hour)
 */
function cleanupOldSearches(queue) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const cleaned = queue.searches.filter(search => {
    // Keep unprocessed searches
    if (!search.processed) return true;

    // Keep recent processed searches (within last hour)
    const searchTime = new Date(search.timestamp);
    return searchTime > oneHourAgo;
  });

  const removed = queue.searches.length - cleaned.length;
  if (removed > 0) {
    console.log(`[Hydra+] ✓ Cleaned ${removed} old searches`);
  }

  return cleaned;
}

/**
 * Add a search to the queue
 */
function addToQueue(searchData) {
  try {
    // Read current queue
    const queueContent = fs.readFileSync(QUEUE_FILE, 'utf8');
    const queue = JSON.parse(queueContent);

    // Clean up old processed searches
    queue.searches = cleanupOldSearches(queue);

    // Add new search with timestamp
    queue.searches.push({
      ...searchData,
      timestamp: new Date().toISOString(),
      processed: false
    });

    // Write back to file
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
    console.log(`[Hydra+] >> QUEUED << ${searchData.query}`);
    return true;
  } catch (error) {
    console.error('Error adding to queue:', error);
    return false;
  }
}

/**
 * Handle HTTP requests
 */
const server = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS request (CORS preflight)
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Handle POST to /search
  if (req.method === 'POST' && req.url === '/search') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);

        if (!data.query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing query field' }));
          return;
        }

        // Validate and set defaults for optional fields
        const searchData = {
          query: data.query,
          artist: data.artist || '',
          track: data.track || '',
          album: data.album || '',
          track_id: data.track_id || '',
          duration: data.duration || 0,
          auto_download: data.auto_download || false,
          metadata_override: data.metadata_override !== false, // Default to true
          format_preference: data.format_preference || 'mp3' // Default to mp3
        };

        const success = addToQueue(searchData);

        // Create trackId for color coding
        const trackId = searchData.track_id || `${searchData.artist}-${searchData.track}`.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);

        if (success) {
          // Add event for popup console with trackId
          addEvent('info', `Queued: ${searchData.artist} - ${searchData.track}`, trackId);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: 'Search added to queue'
          }));
        } else {
          addEvent('error', `Failed to queue: ${searchData.artist} - ${searchData.track}`, trackId);

          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Failed to add to queue'
          }));
        }
      } catch (error) {
        console.error('[Hydra+] ✗ Parse error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });

    return;
  }

  // Handle POST to /search-album - Album download request
  if (req.method === 'POST' && req.url === '/search-album') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);

        console.log('[Hydra+: ALBUM] >> RECEIVED << Album request');
        console.log('[Hydra+: ALBUM] auto_download =', data.auto_download);
        console.log('[Hydra+: ALBUM] metadata_override =', data.metadata_override);

        if (!data.album_id || !data.album_name || !data.album_artist || !data.tracks) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required album fields' }));
          return;
        }

        if (!Array.isArray(data.tracks) || data.tracks.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Tracks must be a non-empty array' }));
          return;
        }

        // Create album search data
        const albumSearchData = {
          type: 'album',
          query: `${data.album_artist} ${data.album_name}`, // Search for "Artist Album" to find folders
          album_id: data.album_id,
          album_name: data.album_name,
          album_artist: data.album_artist,
          year: data.year || '',
          tracks: data.tracks, // Array of track objects
          auto_download: data.auto_download || false,
          metadata_override: data.metadata_override !== false,
          format_preference: data.format_preference || 'mp3' // Default to mp3
        };

        console.log('[Hydra+: ALBUM] auto_download =', albumSearchData.auto_download);
        console.log('[Hydra+: ALBUM] metadata_override =', albumSearchData.metadata_override);

        const success = addToQueue(albumSearchData);

        // Create trackId for album (use album name for consistent color)
        const albumTrackId = `album-${data.album_artist}-${data.album_name}`.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);

        if (success) {
          // Add event for popup console with albumTrackId
          addEvent('info', `Queued album: ${data.album_artist} - ${data.album_name} (${data.tracks.length} tracks)`, albumTrackId);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: `Album search added to queue: ${data.album_name} (${data.tracks.length} tracks)`
          }));
          console.log(`[Hydra+: ALBUM] ✓ QUEUED → ${data.album_artist} - ${data.album_name} (${data.tracks.length} tracks)`);
        } else {
          addEvent('error', `Failed to queue album: ${data.album_artist} - ${data.album_name}`, albumTrackId);

          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Failed to add album to queue'
          }));
        }
      } catch (error) {
        console.error('[Hydra+: ALBUM] ✗ Parse error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });

    return;
  }

  // Handle GET to /ping - simple health check endpoint
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // IMPROVED: Enhanced health check and status endpoint
  if (req.method === 'GET' && req.url === '/status') {
    try {
      updateHealthMetrics();

      const queueContent = fs.readFileSync(QUEUE_FILE, 'utf8');
      const queue = JSON.parse(queueContent);

      const memUsage = process.memoryUsage();
      const uptimeSeconds = Math.floor((Date.now() - healthMetrics.startTime) / 1000);

      // Convert activeDownloads Map to object for JSON serialization
      const activeDownloadsObj = {};
      for (const [trackId, progressData] of activeDownloads.entries()) {
        activeDownloadsObj[trackId] = progressData;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'running',
        uptime: uptimeSeconds,
        queueSize: queue.searches.length,
        unprocessed: queue.searches.filter(s => !s.processed).length,
        processing: activeProcessingCount, // Number of tracks currently being processed
        events: events, // Recent events for popup console
        activeDownloads: activeDownloadsObj, // Active download progress for popup
        health: {
          memory: {
            heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
            peakMB: healthMetrics.memoryPeakMB,
            coverCacheMB: Math.round(coverArtCacheTotalSize / 1024 / 1024),
            coverCacheEntries: coverArtCache.size
          },
          metrics: {
            requestCount: healthMetrics.requestCount,
            errorCount: healthMetrics.errorCount,
            metadataProcessed: healthMetrics.metadataProcessed,
            cacheHitRate: healthMetrics.cacheHits + healthMetrics.cacheMisses > 0
              ? Math.round((healthMetrics.cacheHits / (healthMetrics.cacheHits + healthMetrics.cacheMisses)) * 100)
              : 0
          },
          queues: {
            metadataQueue: metadataQueue.length,
            activeTimeouts: activeTimeouts.size
          }
        }
      }));
    } catch (error) {
      console.error('[Hydra+: ERROR] Status endpoint error:', error.message);
      healthMetrics.errorCount++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Failed to read queue',
        details: error.message,
        events: events
      }));
    }
    return;
  }

  // Handle GET to /pending - get unprocessed searches for Nicotine+ plugin
  if (req.method === 'GET' && req.url === '/pending') {
    try {
      const queueContent = fs.readFileSync(QUEUE_FILE, 'utf8');
      const queue = JSON.parse(queueContent);

      // Return only unprocessed searches
      const pending = queue.searches.filter(s => !s.processed);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ searches: pending }));
    } catch (error) {
      console.error('[Hydra+: ERROR] Pending endpoint error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Failed to read queue',
        details: error.message
      }));
    }
    return;
  }

  // Handle POST to /mark-processed - mark searches as processed
  if (req.method === 'POST' && req.url === '/mark-processed') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { timestamp } = data;

        if (!timestamp) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing timestamp field' }));
          return;
        }

        // Read queue
        const queueContent = fs.readFileSync(QUEUE_FILE, 'utf8');
        const queue = JSON.parse(queueContent);

        // Mark search as processed
        let found = false;
        for (const search of queue.searches) {
          if (search.timestamp === timestamp) {
            search.processed = true;
            found = true;
            break;
          }
        }

        if (found) {
          // Write back to file
          fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Search not found' }));
        }
      } catch (error) {
        console.error('[Hydra+] ✗ Mark processed error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });

    return;
  }

  // Handle POST to /test-spotify-credentials - test API credentials
  if (req.method === 'POST' && req.url === '/test-spotify-credentials') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        // Temporarily set credentials
        const originalClientId = spotifyCredentials.clientId;
        const originalClientSecret = spotifyCredentials.clientSecret;

        spotifyCredentials.clientId = data.clientId;
        spotifyCredentials.clientSecret = data.clientSecret;
        spotifyCredentials.accessToken = null;
        spotifyCredentials.tokenExpiry = 0;

        // Try to get access token
        const token = await getSpotifyAccessToken();

        // Restore original credentials if test failed
        if (!token) {
          spotifyCredentials.clientId = originalClientId;
          spotifyCredentials.clientSecret = originalClientSecret;
          spotifyCredentials.accessToken = null;
          spotifyCredentials.tokenExpiry = 0;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: !!token }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });

    return;
  }

  // Handle POST to /set-spotify-credentials - receive API credentials from extension
  if (req.method === 'POST' && req.url === '/set-spotify-credentials') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        spotifyCredentials.clientId = data.clientId || null;
        spotifyCredentials.clientSecret = data.clientSecret || null;
        spotifyCredentials.accessToken = null; // Reset token
        spotifyCredentials.tokenExpiry = 0;

        // Save credentials to file for persistence
        if (spotifyCredentials.clientId && spotifyCredentials.clientSecret) {
          saveCredentials(spotifyCredentials.clientId, spotifyCredentials.clientSecret);
        }

        console.log('[Hydra+: API] ✓ Credentials received and saved');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });

    return;
  }

  // Handle POST to /process-metadata - process MP3 metadata
  if (req.method === 'POST' && req.url === '/process-metadata') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        // Add to queue instead of processing immediately
        metadataQueue.push({ data, res });
        console.log(`[Hydra+: META] >> QUEUE << Request added (size: ${metadataQueue.length})`);

        // Start processing if not already processing
        if (!isProcessingMetadata) {
          processMetadataQueue();
        }
      } catch (error) {
        console.error('[Hydra+: META] ✗ Parse error:', error);
        console.error('[Hydra+: META] Stack:', error.stack);
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        }
      }
    });

    return;
  }

  // Handle POST to /event - Receive event from Python plugin
  if (req.method === 'POST' && req.url === '/event') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { type, message, trackId } = data;

        // Debug: Log received event
        console.log(`[Hydra+: EVENT] Received: [${type}] ${message.substring(0, 60)} (trackId: ${trackId || 'none'})`);

        // Add event to tracking
        addEvent(type || 'info', message, trackId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        console.error('[Hydra+: EVENT] ✗ Error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });

    return;
  }

  // Handle POST to /progress - Receive download progress update from Python plugin
  if (req.method === 'POST' && req.url === '/progress') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { trackId, filename, progress, bytesDownloaded, totalBytes } = data;

        // Debug: Log progress update (throttled to avoid spam)
        if (progress === 0 || progress >= 100 || Math.floor(progress) % 10 === 0) {
          console.log(`[Hydra+: PROGRESS] ${filename.substring(0, 40)}: ${Math.round(progress)}%`);
        }

        // Update active download progress
        updateDownloadProgress(trackId, filename, progress, bytesDownloaded, totalBytes);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        console.error('[Hydra+: PROGRESS] ✗ Error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });

    return;
  }

  // Handle POST to /remove-progress - Remove download from active progress tracking
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
          console.log(`[Hydra+: PROGRESS] Removed download: ${progressData.filename.substring(0, 40)}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        console.error('[Hydra+: PROGRESS] ✗ Error removing progress:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });

    return;
  }

  // Handle POST to /ensure-album-folder - Create album folder (upfront, before downloads)
  if (req.method === 'POST' && req.url === '/ensure-album-folder') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        await ensureAlbumFolder(data, res);
      } catch (error) {
        console.error('[Hydra+: FOLDER] ✗ Error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });

    return;
  }

  // Handle POST to /create-album-folder - Create album folder and move files
  if (req.method === 'POST' && req.url === '/create-album-folder') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        await createAlbumFolder(data, res);
      } catch (error) {
        console.error('[Hydra+: FOLDER] ✗ Error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });

    return;
  }

  // Handle POST to /set-rename-pattern - receive file rename pattern from extension
  if (req.method === 'POST' && req.url === '/set-rename-pattern') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);

        // Validate pattern includes required tokens
        if (data.singleTrack && typeof data.singleTrack === 'string') {
          renamePattern.singleTrack = data.singleTrack;
        }
        if (data.albumTrack && typeof data.albumTrack === 'string') {
          renamePattern.albumTrack = data.albumTrack;
        }

        console.log('[Hydra+: CONFIG] ✓ Rename pattern updated:', renamePattern);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          pattern: renamePattern
        }));
      } catch (error) {
        console.error('[Hydra+: CONFIG] ✗ Error setting rename pattern:', error.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: error.message
        }));
      }
    });

    return;
  }

  // Handle POST to /restart - Kill the bridge server
  if (req.method === 'POST' && req.url === '/restart') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Server shutting down...' }));

    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('  ⚠️  KILL SERVER - Please restart Nicotine+ manually');
    console.log('  This will restart the server with updated settings');
    console.log('════════════════════════════════════════════════════════════════\n');

    // Give time for response to be sent
    setTimeout(() => {
      process.exit(0); // Exit - server will NOT auto-restart, user must restart Nicotine+
    }, 100);

    return;
  }

  // 404 for other routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ===== METADATA QUEUE PROCESSING =====

// Process metadata queue sequentially to avoid concurrent request issues
// IMPROVED: Fast response for album batches by immediate reply after rename
async function processMetadataQueue() {
  if (isProcessingMetadata) {
    return; // Already processing
  }

  if (metadataQueue.length === 0) {
    return;
  }

  isProcessingMetadata = true;
  const { data, res } = metadataQueue.shift();

  console.log(`[Hydra+: META] ⚡ Processing (${metadataQueue.length} remaining)`);

  try {
    await processMetadata(data, res);
  } catch (error) {
    console.error('[Hydra+: META] ✗ Processing error:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
  } finally {
    isProcessingMetadata = false;

    // Process next item in queue immediately (don't wait for background tasks)
    if (metadataQueue.length > 0) {
      setImmediate(() => processMetadataQueue());
    }
  }
}

// ===== SPOTIFY API FUNCTIONS =====

// Get Spotify access token using Client Credentials flow
async function getSpotifyAccessToken() {
  return new Promise((resolve) => {
    if (!spotifyCredentials.clientId || !spotifyCredentials.clientSecret) {
      resolve(null);
      return;
    }

    // Check if we have a valid token
    if (spotifyCredentials.accessToken && Date.now() < spotifyCredentials.tokenExpiry) {
      resolve(spotifyCredentials.accessToken);
      return;
    }

    // Request new token
    const auth = Buffer.from(`${spotifyCredentials.clientId}:${spotifyCredentials.clientSecret}`).toString('base64');
    const postData = 'grant_type=client_credentials';

    const options = {
      hostname: 'accounts.spotify.com',
      path: '/api/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': postData.length
      },
      agent: httpsAgent
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            spotifyCredentials.accessToken = json.access_token;
            spotifyCredentials.tokenExpiry = Date.now() + (json.expires_in * 1000) - 60000; // Expire 1 min early
            console.log('[Hydra+: API] ✓ Access token obtained');
            resolve(json.access_token);
          } else {
            console.error('[Hydra+: API] ✗ No access token in response');
            resolve(null);
          }
        } catch (e) {
          console.error('[Hydra+: API] ✗ Token parse error:', e.message);
          resolve(null);
        }
      });
      res.on('error', (err) => {
        console.error('[Hydra+: API] ✗ Token response error:', err.message);
        resolve(null);
      });
    });

    req.on('error', (err) => {
      console.error('[Hydra+: API] ✗ Token request error:', err.message);
      resolve(null);
    });

    req.write(postData);
    req.end();
  });
}

// Fetch track details from Spotify Web API (genre, label, etc.)
async function fetchSpotifyAPIMetadata(trackId) {
  return new Promise(async (resolve) => {
    const accessToken = await getSpotifyAccessToken();
    if (!accessToken) {
      resolve({});
      return;
    }

    // Overall timeout for the entire API call sequence - increased to 60s
    const overallTimeout = setTimeout(() => {
      console.error('[Hydra+: API] ⚠ Timeout after 60s');
      resolve({});
    }, 60000);

    const options = {
      hostname: 'api.spotify.com',
      path: `/v1/tracks/${trackId}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      agent: httpsAgent
    };

    const trackReq = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const track = JSON.parse(data);
          const metadata = {};

          // Extract genres from artist (tracks don't have genre, but artists do)
          if (track.artists && track.artists.length > 0) {
            const artistId = track.artists[0].id;

            // Fetch artist details for genres
            const artistOptions = {
              hostname: 'api.spotify.com',
              path: `/v1/artists/${artistId}`,
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${accessToken}`
              },
              agent: httpsAgent
            };

            const artistReq = https.get(artistOptions, (artistRes) => {
              let artistData = '';
              artistRes.on('data', chunk => artistData += chunk);
              artistRes.on('end', () => {
                try {
                  clearTimeout(overallTimeout);
                  const artist = JSON.parse(artistData);
                  if (artist.genres && artist.genres.length > 0) {
                    metadata.genre = artist.genres.join(', ');
                  }

                  // Extract label from album
                  if (track.album && track.album.label) {
                    metadata.label = track.album.label;
                  }

                  console.log(`[Hydra+: API] ✓ Genre=${metadata.genre || 'N/A'}, Label=${metadata.label || 'N/A'}`);
                  resolve(metadata);
                } catch (e) {
                  clearTimeout(overallTimeout);
                  console.error('[Hydra+: API] ✗ Artist parse error:', e.message);
                  resolve({});
                }
              });
              artistRes.on('error', (err) => {
                clearTimeout(overallTimeout);
                console.error('[Hydra+: API] ✗ Artist response error:', err.message);
                resolve({});
              });
            });

            artistReq.on('error', (err) => {
              clearTimeout(overallTimeout);
              console.error('[Hydra+: API] ✗ Artist request error:', err.message);
              resolve({});
            });

            artistReq.on('timeout', () => {
              artistReq.destroy();
              clearTimeout(overallTimeout);
              console.error('[Hydra+: API] ⚠ Artist request timeout');
              resolve({});
            });

            artistReq.setTimeout(30000); // 30 second timeout for artist request - increased

          } else {
            // No artist, just return label if available
            clearTimeout(overallTimeout);
            if (track.album && track.album.label) {
              metadata.label = track.album.label;
            }
            resolve(metadata);
          }

        } catch (e) {
          clearTimeout(overallTimeout);
          console.error('[Hydra+: API] ✗ Track parse error:', e.message);
          resolve({});
        }
      });
      res.on('error', (err) => {
        clearTimeout(overallTimeout);
        console.error('[Hydra+: API] ✗ Track response error:', err.message);
        resolve({});
      });
    });

    trackReq.on('error', (err) => {
      clearTimeout(overallTimeout);
      console.error('[Hydra+: API] ✗ Track request error:', err.message);
      resolve({});
    });

    trackReq.on('timeout', () => {
      trackReq.destroy();
      clearTimeout(overallTimeout);
      console.error('[Hydra+: API] ⚠ Track request timeout');
      resolve({});
    });

    trackReq.setTimeout(30000); // 30 second timeout for track request - increased
  });
}

// ===== METADATA PROCESSING FUNCTIONS =====

// Sanitize filename by removing invalid characters
function sanitizeFilename(text) {
  if (!text) return '';
  return text.replace(/[<>:"/\\|?*]/g, '').trim();
}

// Rename file using configurable pattern
// Supports tokens: {artist}, {track}, {trackNum}, {album}, {year}
async function renameFile(oldPath, artist, track, trackNumber, album = '', year = '') {
  try {
    const dir = path.dirname(oldPath);
    const ext = path.extname(oldPath);
    const artistClean = sanitizeFilename(artist);
    const trackClean = sanitizeFilename(track);
    const albumClean = sanitizeFilename(album);
    const yearClean = sanitizeFilename(year);

    if (!artistClean && !trackClean) {
      console.error(`[Hydra+: META] ✗ Cannot rename - missing both artist and track name`);
      return oldPath;
    }

    // Choose pattern based on whether this is an album track
    const pattern = (trackNumber && trackNumber > 0) ? renamePattern.albumTrack : renamePattern.singleTrack;

    // Build filename from pattern
    let newFilename = pattern;

    // Replace tokens with actual values
    newFilename = newFilename.replace(/\{trackNum\}/g, trackNumber ? String(trackNumber).padStart(2, '0') : '');
    newFilename = newFilename.replace(/\{artist\}/g, artistClean);
    newFilename = newFilename.replace(/\{track\}/g, trackClean);
    newFilename = newFilename.replace(/\{album\}/g, albumClean);
    newFilename = newFilename.replace(/\{year\}/g, yearClean);

    // Clean up extra spaces/separators left by empty tokens
    newFilename = newFilename.replace(/\s+/g, ' ').replace(/\s*-\s*-\s*/g, ' - ').trim();
    newFilename = newFilename.replace(/^-\s*/, '').replace(/\s*-$/, ''); // Remove leading/trailing dashes

    // Add file extension
    newFilename = `${newFilename}${ext}`;

    const newPath = path.join(dir, newFilename);

    // If already correct name
    if (oldPath === newPath) {
      return oldPath;
    }

    // Handle duplicates
    let finalPath = newPath;
    let counter = 1;
    while (fs.existsSync(finalPath)) {
      const base = newFilename.replace(ext, '');
      finalPath = path.join(dir, `${base} (${counter})${ext}`);
      counter++;
    }

    await fsPromises.rename(oldPath, finalPath);
    console.log(`[Hydra+: META] ✓ Renamed → ${path.basename(finalPath)}`);
    return finalPath;

  } catch (error) {
    console.error(`[Hydra+: META] ✗ Rename failed: ${error.message}`);
    return oldPath;
  }
}

// Fetch extended metadata from Spotify page
async function fetchSpotifyMetadata(trackId) {
  return new Promise((resolve) => {
    if (!trackId) {
      resolve({});
      return;
    }

    const trackUrl = `https://open.spotify.com/track/${trackId}`;

    // Set timeout to prevent hanging - increased to 30s for slower connections
    const timeout = setTimeout(() => {
      console.error('[Hydra+: META] ⚠ Spotify page timeout (30s)');
      resolve({});
    }, 30000);

    const req = https.get(trackUrl, { agent: httpsAgent }, (res) => {
      clearTimeout(timeout);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const metadata = {};

          // Extract year from release date
          const releaseDateMatch = data.match(/<meta name="music:release_date" content="([^"]+)"/);
          if (releaseDateMatch) {
            const releaseDate = releaseDateMatch[1];
            metadata.year = releaseDate.split('-')[0]; // Extract year from YYYY-MM-DD
          }

          // Extract track number
          const trackNumMatch = data.match(/<meta name="music:album:track" content="(\d+)"/);
          if (trackNumMatch) {
            metadata.trackNumber = trackNumMatch[1];
          }

          // Extract cover image URL (higher quality)
          const imageMatch = data.match(/<meta property="og:image" content="([^"]+)"/);
          if (imageMatch) {
            metadata.imageUrl = imageMatch[1];
          }

          console.log(`[Hydra+: META] ✓ Year=${metadata.year}, Track#=${metadata.trackNumber}`);
          resolve(metadata);

        } catch (e) {
          console.error(`[Hydra+: META] ✗ Parse error: ${e.message}`);
          resolve({});
        }
      });
      res.on('error', (err) => {
        clearTimeout(timeout);
        console.error(`[Hydra+: META] ✗ Spotify response error: ${err.message}`);
        resolve({});
      });
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[Hydra+: META] ✗ Spotify fetch error: ${err.message}`);
      resolve({});
    });

    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timeout);
      console.error('[Hydra+: META] ⚠ Spotify request timeout');
      resolve({});
    });

    req.setTimeout(30000); // 30 second timeout - increased for slower connections
  });
}

// IMPROVED: Download cover art with LRU cache management
async function downloadCoverArt(imageUrl, trackId = null) {
  return new Promise((resolve) => {
    if (!imageUrl) {
      resolve(null);
      return;
    }

    // Check cache first (cover art is same for all tracks in album)
    const cached = coverArtCache.get(imageUrl);
    if (cached) {
      // Cache hit - reuse the downloaded image
      const age = Date.now() - cached.timestamp;
      if (age < COVER_ART_CACHE_MAX_AGE) {
        healthMetrics.cacheHits++;
        console.log(`[Hydra+: META] ✓ Using cached cover (${cached.buffer.length} bytes)`);
        resolve(cached.buffer);
        return;
      } else {
        // Cache expired, remove it
        coverArtCacheTotalSize -= cached.size;
        coverArtCache.delete(imageUrl);
      }
    }

    healthMetrics.cacheMisses++;
    console.log(`[Hydra+: META] ⬇ Downloading cover...`);
    addEvent('info', 'Downloading cover art from Spotify', trackId);

    // Set timeout to prevent hanging - 30s for slower connections
    const timeout = createTrackedTimeout(() => {
      console.error('[Hydra+: META] ⚠ Cover timeout (30s)');
      healthMetrics.errorCount++;
      resolve(null);
    }, 30000);

    const req = https.get(imageUrl, { agent: httpsAgent }, (imgRes) => {
      clearTrackedTimeout(timeout);
      const chunks = [];
      imgRes.on('data', chunk => chunks.push(chunk));
      imgRes.on('end', () => {
        const buffer = Buffer.concat(chunks);
        console.log(`[Hydra+: META] ✓ Cover: ${buffer.length} bytes`);

        // IMPROVED: Use cache management function with size limits
        addToCoverArtCache(imageUrl, buffer);

        resolve(buffer);
      });
      imgRes.on('error', (err) => {
        clearTrackedTimeout(timeout);
        console.error(`[Hydra+: META] ✗ Image response error: ${err.message}`);
        healthMetrics.errorCount++;
        resolve(null);
      });
    });

    req.on('error', (err) => {
      clearTrackedTimeout(timeout);
      console.error(`[Hydra+: META] ✗ Image error: ${err.message}`);
      healthMetrics.errorCount++;
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      clearTrackedTimeout(timeout);
      console.error('[Hydra+: META] ⚠ Cover request timeout');
      healthMetrics.errorCount++;
      resolve(null);
    });

    req.setTimeout(30000); // 30 second timeout
  });
}

// Main metadata processing function
async function processMetadata(data, res) {
  const { file_path, artist, track, album, track_id, prefetched_year, prefetched_image_url, target_folder } = data;

  console.log(`[Hydra+: META] >> PROCESSING << ${path.basename(file_path)}`);

  // Track active processing
  activeProcessingCount++;

  // Create a unique trackId for color-coding in popup (use file path hash or track_id)
  const popupTrackId = track_id || `${artist}-${track}`.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);

  // Add event for popup console with trackId for color coding
  addEvent('info', `Processing: ${artist} - ${track}`, popupTrackId);

  const result = {
    success: true,
    original_path: file_path,
    new_path: file_path,
    renamed: false,
    moved_to_folder: false,
    tags_updated: false,
    cover_embedded: false,
    year: null,
    track_number: null,
    genre: null,
    label: null
  };

  try {
    // Check if file exists
    if (!fs.existsSync(file_path)) {
      addEvent('error', `File not found: ${path.basename(file_path)}`, popupTrackId);
      throw new Error('File not found');
    }

    // Detect file format
    const ext = path.extname(file_path).toLowerCase();
    const isMP3 = ext === '.mp3';
    const isFLAC = ext === '.flac';

    if (!isMP3 && !isFLAC) {
      throw new Error(`Unsupported format: ${ext} (only MP3/FLAC supported)`);
    }

    console.log(`[Hydra+: META] Format detected: ${isMP3 ? 'MP3' : 'FLAC'}`);

    // STEP 1: RENAME FILE FIRST (before any network operations that could timeout)
    const trackNum = data.track_number || 0;
    const albumName = album || '';
    const yearStr = prefetched_year ? String(prefetched_year) : '';
    let newPath = await renameFile(file_path, artist, track, trackNum, albumName, yearStr);
    result.new_path = newPath;
    result.renamed = (newPath !== file_path);

    // STEP 2: MOVE TO TARGET FOLDER if specified (for album downloads)
    // CRITICAL: Move immediately after rename to prevent orphaned files on crash
    if (target_folder) {
      try {
        if (!fs.existsSync(target_folder)) {
          throw new Error(`Target folder does not exist: ${target_folder}`);
        }

        const fileName = path.basename(newPath);
        const targetPath = path.join(target_folder, fileName);

        // Only move if not already in target folder
        if (targetPath !== newPath) {
          // Handle duplicates
          let finalPath = targetPath;
          let counter = 1;
          while (fs.existsSync(finalPath) && finalPath !== newPath) {
            const ext = path.extname(fileName);
            const base = path.basename(fileName, ext);
            finalPath = path.join(target_folder, `${base} (${counter})${ext}`);
            counter++;
          }

          await fsPromises.rename(newPath, finalPath);
          console.log(`[Hydra+: META] ✓ Moved to album folder: ${path.basename(target_folder)}`);
          newPath = finalPath;
          result.new_path = finalPath;
          result.moved_to_folder = true;
        } else {
          console.log(`[Hydra+: META] Already in target folder`);
          result.moved_to_folder = true;
        }
      } catch (moveError) {
        console.error(`[Hydra+: META] ⚠ Failed to move to folder: ${moveError.message}`);
        // Don't fail the whole operation if move fails - file is still renamed
        result.moved_to_folder = false;
      }
    }

    // CRITICAL FIX: Always send success response immediately after renaming/moving
    // This prevents Python plugin timeout issues, especially for album batches
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }

    // Continue with metadata processing in background (don't block response)
    // This runs asynchronously and won't delay the next track in album batches
    // CRITICAL: All code in this block must be wrapped in try-catch to prevent server crashes
    // CRITICAL FIX: Add small delay to prevent concurrent background job pile-up
    setTimeout(() => {
      (async () => {
        try {
          console.log('[Hydra+: META] Continuing metadata fetch in background...');

          // Step 2: Fetch extended metadata from Spotify page (year, track#, image)
          // IMPROVED: Use prefetched metadata if available (skip Spotify page fetch)
          let spotifyMeta = {};

          if (prefetched_year || prefetched_image_url) {
            // Use prefetched metadata from Python cache
            console.log('[Hydra+: META] ✓ Using prefetched metadata from cache');
            spotifyMeta = {
              year: prefetched_year || null,
              imageUrl: prefetched_image_url || null
            };
          } else {
            // Fallback: Fetch from Spotify page (for single tracks or cache miss)
            try {
              spotifyMeta = await fetchSpotifyMetadata(track_id);
            } catch (spotifyError) {
              console.error(`[Hydra+: META] ✗ Spotify metadata error: ${spotifyError.message}`);
              spotifyMeta = {};
            }
          }

          // Step 3: Fetch API metadata if credentials are available (genre, label)
          let apiMeta = {};
          if (track_id) {
            if (spotifyCredentials.clientId && spotifyCredentials.clientSecret) {
              console.log('[Hydra+: API] Fetching metadata...');
              try {
                apiMeta = await fetchSpotifyAPIMetadata(track_id);
              } catch (apiError) {
                console.error(`[Hydra+: API] ✗ API metadata error: ${apiError.message}`);
                apiMeta = {};
              }
            } else {
              console.log('[Hydra+: API] No credentials (skipping genre/label)');
            }
          }

          // Step 4: Download cover art
          let coverData = null;
          try {
            coverData = await downloadCoverArt(spotifyMeta.imageUrl, popupTrackId);
          } catch (coverError) {
            console.error(`[Hydra+: META] ✗ Cover download error: ${coverError.message}`);
            coverData = null;
          }

          // Step 5: Write tags (format-specific)
          let writeSuccess = false;
          const trackNumber = data.track_number || spotifyMeta.trackNumber || '';

          if (isMP3) {
            // MP3: Use NodeID3 with enhanced safety checks
            try {
              // Verify file exists and is accessible before tagging
              if (!fs.existsSync(newPath)) {
                throw new Error(`MP3 file not found: ${newPath}`);
              }

              // Check file size - skip if suspiciously small or large
              const stats = fs.statSync(newPath);
              if (stats.size < 1000) {
                throw new Error(`MP3 file too small (${stats.size} bytes), possibly corrupted`);
              }
              if (stats.size > 500 * 1024 * 1024) {
                console.log(`[Hydra+: META] ⚠ Large MP3 file (${Math.round(stats.size / 1024 / 1024)}MB), skipping metadata to prevent crash`);
                writeSuccess = true; // Skip but don't fail
              } else {
                const tags = {
                  title: track || '',
                  artist: artist || '',
                  album: album || ''
                };

                if (spotifyMeta.year) tags.year = spotifyMeta.year;
                if (trackNumber) tags.trackNumber = String(trackNumber);
                if (apiMeta.genre) tags.genre = apiMeta.genre;
                if (apiMeta.label) tags.publisher = apiMeta.label;

                // Attach cover if available - with size validation
                if (coverData) {
                  // Validate cover data size (max 10MB to prevent crashes)
                  if (coverData.length > 10 * 1024 * 1024) {
                    console.log(`[Hydra+: META] ⚠ Cover too large (${Math.round(coverData.length / 1024 / 1024)}MB), skipping embed`);
                  } else {
                    tags.image = {
                      mime: 'image/jpeg',
                      type: { id: 3, name: 'front cover' },
                      description: 'Cover',
                      imageBuffer: coverData
                    };
                  }
                }

                console.log(`[Hydra+: META] ⚡ Writing ID3 tags (MP3)...`);

                // Wrap NodeID3.write in additional safety - use Promise.race with timeout
                // to prevent indefinite hangs that can cause event loop stalls
                let timeoutId;
                const writePromise = new Promise((resolve, reject) => {
                  try {
                    const result = NodeID3.write(tags, newPath);
                    resolve(result);
                  } catch (err) {
                    reject(err);
                  }
                });

                const timeoutPromise = new Promise((resolve) => {
                  timeoutId = setTimeout(() => {
                    console.error(`[Hydra+: META] ⚠ NodeID3.write timeout (10s)`);
                    resolve(false);
                  }, 10000); // 10 second timeout
                });

                writeSuccess = await Promise.race([writePromise, timeoutPromise]);

                // CRITICAL: Clear timeout to prevent memory leaks
                if (timeoutId) clearTimeout(timeoutId);

                if (!writeSuccess) {
                  console.error(`[Hydra+: META] ✗ NodeID3.write returned false`);
                }
              }
            } catch (id3Error) {
              console.error(`[Hydra+: META] ✗ ID3 exception: ${id3Error.message}`);
              console.error(`[Hydra+: META] Stack: ${id3Error.stack}`);
              writeSuccess = false;
            }

          } else if (isFLAC) {
            // FLAC: Use flac-tagger with comprehensive error handling
            try {
              console.log(`[Hydra+: META] ⚡ Writing Vorbis comments (FLAC)...`);

              // Verify file exists before attempting to tag
              if (!fs.existsSync(newPath)) {
                throw new Error(`FLAC file not found: ${newPath}`);
              }

              const tagger = new FlacTagger(newPath);

              // Build Vorbis comment tags
              const flacTags = {
                TITLE: track || '',
                ARTIST: artist || '',
                ALBUM: album || ''
              };

              if (spotifyMeta.year) flacTags.DATE = String(spotifyMeta.year);
              if (trackNumber) flacTags.TRACKNUMBER = String(trackNumber);
              if (apiMeta.genre) flacTags.GENRE = apiMeta.genre;
              if (apiMeta.label) flacTags.LABEL = apiMeta.label;

              await tagger.setTag(flacTags);

              // Add cover art if available
              if (coverData) {
                try {
                  await tagger.setPicture({ buffer: coverData });
                } catch (pictureError) {
                  console.error(`[Hydra+: META] ✗ FLAC picture embedding failed: ${pictureError.message}`);
                  // Continue without picture
                }
              }

              await tagger.save();
              writeSuccess = true;
            } catch (flacError) {
              console.error(`[Hydra+: META] ✗ FLAC exception: ${flacError.message}`);
              console.error(`[Hydra+: META] Stack: ${flacError.stack}`);
              writeSuccess = false;
            }
          }

          if (writeSuccess) {
            console.log(`[Hydra+: META] ✓ SUCCESS`);
            if (artist) console.log(`[Hydra+: META]   Artist: ${artist}`);
            if (track) console.log(`[Hydra+: META]   Title: ${track}`);
            if (album) console.log(`[Hydra+: META]   Album: ${album}`);
            if (spotifyMeta.year) console.log(`[Hydra+: META]   Year: ${spotifyMeta.year}`);
            if (trackNumber) console.log(`[Hydra+: META]   Track: #${trackNumber}`);
            if (apiMeta.genre) console.log(`[Hydra+: META]   Genre: ${apiMeta.genre}`);
            if (apiMeta.label) console.log(`[Hydra+: META]   Label: ${apiMeta.label}`);
            if (coverData) console.log(`[Hydra+: META]   Cover: embedded`);

            // Add success event for popup console with trackId
            addEvent('success', `Complete: ${artist} - ${track}`, popupTrackId);

            // Remove from active downloads progress tracking
            removeDownloadProgress(popupTrackId);
          } else {
            console.error(`[Hydra+: META] ✗ Metadata write failed`);
            addEvent('warning', `Metadata write failed: ${artist} - ${track}`, popupTrackId);

            // Remove from active downloads progress tracking even if metadata write failed
            removeDownloadProgress(popupTrackId);
          }
        } catch (bgError) {
          // Catch any errors in background processing to prevent server crash
          console.error(`[Hydra+: META] ✗ Background processing error: ${bgError.message}`);
          console.error(`[Hydra+: META] Stack: ${bgError.stack}`);
        } finally {
          // Always decrement counter when background processing finishes
          activeProcessingCount = Math.max(0, activeProcessingCount - 1);
        }
      })().catch((asyncError) => {
        // Additional safety net for async errors
        console.error(`[Hydra+: META] ✗ Async processing error: ${asyncError.message}`);
        console.error(`[Hydra+: META] Stack: ${asyncError.stack}`);
        // Decrement counter on async errors too
        activeProcessingCount = Math.max(0, activeProcessingCount - 1);
      });
    }, 500); // 500ms delay to prevent concurrent background job pile-up

    return; // Exit here since we already sent response

  } catch (error) {
    console.error(`[Hydra+: META] ✗ Error: ${error.message}`);
    console.error(`[Hydra+: META] Stack: ${error.stack}`);
    result.success = false;
    result.error = error.message;

    // Decrement processing counter on error
    activeProcessingCount = Math.max(0, activeProcessingCount - 1);

    // Add error event with trackId
    addEvent('error', `Failed: ${artist} - ${track} (${error.message})`, popupTrackId);

    // Send error response if we haven't sent one yet
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
  }
}

// Create album folder and move files
/**
 * Ensure album folder exists (called upfront before downloads start)
 * CRITICAL: Creates folder FIRST to prevent crashes from leaving orphaned files
 */
async function ensureAlbumFolder(data, res) {
  const { album_artist, album_name, year, download_dir } = data;

  console.log(`[Hydra+: FOLDER] >> ENSURE EXISTS << ${album_artist} - ${album_name}`);

  const result = {
    success: true,
    folder_path: null,
    folder_name: null
  };

  try {
    // Validate input
    if (!album_artist || !album_name || !download_dir) {
      throw new Error('Missing required fields: album_artist, album_name, or download_dir');
    }

    // Verify download directory exists
    if (!fs.existsSync(download_dir)) {
      throw new Error(`Download directory not found: ${download_dir}`);
    }

    // Create album folder name: "Artist - Album (Year)"
    const artistClean = sanitizeFilename(album_artist);
    const albumClean = sanitizeFilename(album_name);
    const yearPart = year ? ` (${year})` : '';
    const albumFolderName = `${artistClean} - ${albumClean}${yearPart}`;
    const albumFolderPath = path.join(download_dir, albumFolderName);

    // Create album folder if it doesn't exist
    if (!fs.existsSync(albumFolderPath)) {
      await fsPromises.mkdir(albumFolderPath, { recursive: true });
      console.log(`[Hydra+: FOLDER] ✓ Created → ${albumFolderName}`);

      // Create trackId for album folder event
      const albumTrackId = `album-${album_artist}-${album_name}`.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
      addEvent('success', `Album folder created: ${albumFolderName}`, albumTrackId);
    } else {
      console.log(`[Hydra+: FOLDER] Already exists: ${albumFolderName}`);
    }

    result.folder_path = albumFolderPath;
    result.folder_name = albumFolderName;

  } catch (error) {
    console.error(`[Hydra+: FOLDER] ✗ Error: ${error.message}`);
    result.success = false;
    result.error = error.message;
  }

  res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

async function createAlbumFolder(data, res) {
  const { album_artist, album_name, year, track_files } = data;

  console.log(`[Hydra+: FOLDER] >> CREATING << ${album_artist} - ${album_name}`);

  const result = {
    success: true,
    folder_path: null,
    moved_files: [],
    errors: []
  };

  try {
    // Validate input
    if (!album_artist || !album_name || !track_files || !Array.isArray(track_files)) {
      throw new Error('Missing required fields: album_artist, album_name, or track_files');
    }

    // Get the directory from the first file (all should be in same download folder)
    if (track_files.length === 0) {
      throw new Error('No track files provided');
    }

    const firstFilePath = track_files[0];
    if (!fs.existsSync(firstFilePath)) {
      throw new Error(`First file not found: ${firstFilePath}`);
    }

    const downloadDir = path.dirname(firstFilePath);

    // Create album folder name: "Artist - Album (Year)"
    const artistClean = sanitizeFilename(album_artist);
    const albumClean = sanitizeFilename(album_name);
    const yearPart = year ? ` (${year})` : '';
    const albumFolderName = `${artistClean} - ${albumClean}${yearPart}`;
    const albumFolderPath = path.join(downloadDir, albumFolderName);

    // Create album folder if it doesn't exist
    if (!fs.existsSync(albumFolderPath)) {
      await fsPromises.mkdir(albumFolderPath, { recursive: true });
      console.log(`[Hydra+: FOLDER] ✓ Created → ${albumFolderName}`);
    } else {
      console.log(`[Hydra+: FOLDER] Already exists: ${albumFolderName}`);
    }

    result.folder_path = albumFolderPath;

    // Move each track file into the album folder
    for (const filePath of track_files) {
      try {
        if (!fs.existsSync(filePath)) {
          console.log(`[Hydra+: FOLDER] ⚠ File not found: ${path.basename(filePath)}`);
          result.errors.push(`File not found: ${path.basename(filePath)}`);
          continue;
        }

        const fileName = path.basename(filePath);
        const newPath = path.join(albumFolderPath, fileName);

        // Handle duplicates
        let finalPath = newPath;
        let counter = 1;
        while (fs.existsSync(finalPath) && finalPath !== filePath) {
          const ext = path.extname(fileName);
          const base = path.basename(fileName, ext);
          finalPath = path.join(albumFolderPath, `${base} (${counter})${ext}`);
          counter++;
        }

        // Move file (only if not already in the right place)
        if (finalPath !== filePath) {
          await fsPromises.rename(filePath, finalPath);
          console.log(`[Hydra+: FOLDER] ✓ Moved → ${fileName}`);
          result.moved_files.push(finalPath);
        } else {
          console.log(`[Hydra+: FOLDER] Already in place: ${fileName}`);
          result.moved_files.push(finalPath);
        }

      } catch (error) {
        console.error(`[Hydra+: FOLDER] ✗ Error moving ${path.basename(filePath)}: ${error.message}`);
        result.errors.push(`Failed to move ${path.basename(filePath)}: ${error.message}`);
      }
    }

    console.log(`[Hydra+: FOLDER] ✓ COMPLETED → ${result.moved_files.length}/${track_files.length} files`);

    if (result.errors.length > 0) {
      result.success = result.moved_files.length > 0; // Partial success if at least one file moved
    }

  } catch (error) {
    console.error(`[Hydra+: FOLDER] ✗ Error: ${error.message}`);
    result.success = false;
    result.error = error.message;
  }

  res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

// Global error handlers to prevent server crashes
process.on('uncaughtException', (error) => {
  console.error('[Hydra+: FATAL] ✗ Uncaught Exception:', error);
  console.error('[Hydra+: FATAL] Stack:', error.stack);
  console.error('[Hydra+: FATAL] Server continues...');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Hydra+: FATAL] ✗ Unhandled Rejection:', promise);
  console.error('[Hydra+: FATAL] Reason:', reason);
  console.error('[Hydra+: FATAL] Server continues...');
});

// IMPROVED: Periodic cleanup to prevent memory leaks
const cleanupInterval = setInterval(() => {
  cleanupExpiredCache();
  cleanupOldEvents();
  updateHealthMetrics();
}, 2 * 60 * 1000); // Every 2 minutes

// IMPROVED: Track cleanup interval for shutdown
activeTimeouts.add(cleanupInterval);

// Start server
server.listen(PORT, '127.0.0.1', () => {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  >> HYDRA+ BRIDGE SERVER <<');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  [PORT]      → ${PORT}`);
  console.log('  [STATUS]    → 🟢 ONLINE');
  console.log(`  [QUEUE]     → ${path.basename(QUEUE_FILE)}`);
  console.log('  [ENDPOINTS] → /search /pending /process-metadata /status');
  console.log('  [FEATURES]  → LRU Cache, Health Metrics, Auto-Cleanup');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  Multi-headed beast ready to hunt... 🐍🐍🐍');
  console.log('════════════════════════════════════════════════════════════════\n');
});

// IMPROVED: Handle graceful shutdown with resource cleanup
process.on('SIGINT', () => {
  console.log('\n[Hydra+] Shutting down...');

  // Clear all active timeouts/intervals
  console.log(`[Hydra+] Clearing ${activeTimeouts.size} active timers...`);
  for (const timeoutId of activeTimeouts) {
    clearTimeout(timeoutId);
    clearInterval(timeoutId);
  }
  activeTimeouts.clear();

  // Clear caches
  console.log(`[Hydra+] Clearing cover art cache (${coverArtCache.size} entries, ${Math.round(coverArtCacheTotalSize / 1024 / 1024)}MB)...`);
  coverArtCache.clear();
  coverArtCacheTotalSize = 0;

  server.close(() => {
    console.log('[Hydra+] ✓ Server closed gracefully');
    process.exit(0);
  });
});
