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
const NodeID3 = require('node-id3');

// Configuration
const PORT = 3847;
const QUEUE_FILE = path.join(__dirname, 'nicotine-queue.json');
const CREDENTIALS_FILE = path.join(__dirname, 'spotify-credentials.json');

// Metadata processing queue to prevent concurrent processing
const metadataQueue = [];
let isProcessingMetadata = false;

// Spotify API credentials (optional, set via extension popup)
let spotifyCredentials = {
  clientId: null,
  clientSecret: null,
  accessToken: null,
  tokenExpiry: 0
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
          metadata_override: data.metadata_override !== false // Default to true
        };

        const success = addToQueue(searchData);

        if (success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: 'Search added to queue'
          }));
        } else {
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
          metadata_override: data.metadata_override !== false
        };

        console.log('[Hydra+: ALBUM] auto_download =', albumSearchData.auto_download);
        console.log('[Hydra+: ALBUM] metadata_override =', albumSearchData.metadata_override);

        const success = addToQueue(albumSearchData);

        if (success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: `Album search added to queue: ${data.album_name} (${data.tracks.length} tracks)`
          }));
          console.log(`[Hydra+: ALBUM] ✓ QUEUED → ${data.album_artist} - ${data.album_name} (${data.tracks.length} tracks)`);
        } else {
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

  // Handle GET to /status
  if (req.method === 'GET' && req.url === '/status') {
    try {
      const queueContent = fs.readFileSync(QUEUE_FILE, 'utf8');
      const queue = JSON.parse(queueContent);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'running',
        queueSize: queue.searches.length,
        unprocessed: queue.searches.filter(s => !s.processed).length
      }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read queue' }));
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
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read queue' }));
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

  // 404 for other routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ===== METADATA QUEUE PROCESSING =====

// Process metadata queue sequentially to avoid concurrent request issues
async function processMetadataQueue() {
  if (isProcessingMetadata) {
    return; // Already processing
  }

  if (metadataQueue.length === 0) {
    console.log('[Hydra+: META] Queue empty');
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

    // Process next item in queue
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
      }
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

    // Overall timeout for the entire API call sequence
    const overallTimeout = setTimeout(() => {
      console.error('[Hydra+: API] ⚠ Timeout after 20s');
      resolve({});
    }, 20000);

    const options = {
      hostname: 'api.spotify.com',
      path: `/v1/tracks/${trackId}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
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
              }
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

            artistReq.setTimeout(10000); // 10 second timeout for artist request

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

    trackReq.setTimeout(10000); // 10 second timeout for track request
  });
}

// ===== METADATA PROCESSING FUNCTIONS =====

// Sanitize filename by removing invalid characters
function sanitizeFilename(text) {
  if (!text) return '';
  return text.replace(/[<>:"/\\|?*]/g, '').trim();
}

// Rename file to "Artist - Track.mp3" or "01 Artist - Track.mp3" format
async function renameFile(oldPath, artist, track, trackNumber) {
  try {
    const dir = path.dirname(oldPath);
    const ext = path.extname(oldPath);
    const artistClean = sanitizeFilename(artist);
    const trackClean = sanitizeFilename(track);

    if (!artistClean || !trackClean) {
      return oldPath; // Can't rename without artist and track
    }

    // Add track number prefix if provided (for album downloads)
    let newFilename;
    if (trackNumber && trackNumber > 0) {
      const trackNumPadded = String(trackNumber).padStart(2, '0');
      newFilename = `${trackNumPadded} ${artistClean} - ${trackClean}${ext}`;
    } else {
      newFilename = `${artistClean} - ${trackClean}${ext}`;
    }

    const newPath = path.join(dir, newFilename);

    // If already correct name
    if (oldPath === newPath) {
      return oldPath;
    }

    // Handle duplicates
    let finalPath = newPath;
    let counter = 1;
    while (fs.existsSync(finalPath)) {
      let base;
      if (trackNumber && trackNumber > 0) {
        const trackNumPadded = String(trackNumber).padStart(2, '0');
        base = `${trackNumPadded} ${artistClean} - ${trackClean}`;
      } else {
        base = `${artistClean} - ${trackClean}`;
      }
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

    // Set timeout to prevent hanging
    const timeout = setTimeout(() => {
      console.error('[Hydra+: META] ⚠ Spotify page timeout (10s)');
      resolve({});
    }, 10000);

    const req = https.get(trackUrl, (res) => {
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

    req.setTimeout(10000); // 10 second timeout
  });
}

// Download cover art from URL
async function downloadCoverArt(imageUrl) {
  return new Promise((resolve) => {
    if (!imageUrl) {
      resolve(null);
      return;
    }

    console.log(`[Hydra+: META] ⬇ Downloading cover...`);

    // Set timeout to prevent hanging
    const timeout = setTimeout(() => {
      console.error('[Hydra+: META] ⚠ Cover timeout (15s)');
      resolve(null);
    }, 15000);

    const req = https.get(imageUrl, (imgRes) => {
      clearTimeout(timeout);
      const chunks = [];
      imgRes.on('data', chunk => chunks.push(chunk));
      imgRes.on('end', () => {
        const buffer = Buffer.concat(chunks);
        console.log(`[Hydra+: META] ✓ Cover: ${buffer.length} bytes`);
        resolve(buffer);
      });
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[Hydra+: META] ✗ Image error: ${err.message}`);
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timeout);
      console.error('[Hydra+: META] ⚠ Cover request timeout');
      resolve(null);
    });

    req.setTimeout(15000); // 15 second timeout
  });
}

// Main metadata processing function
async function processMetadata(data, res) {
  const { file_path, artist, track, album, track_id } = data;

  console.log(`[Hydra+: META] >> PROCESSING << ${path.basename(file_path)}`);

  const result = {
    success: true,
    original_path: file_path,
    new_path: file_path,
    renamed: false,
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
      throw new Error('File not found');
    }

    // Check if it's an MP3 file
    if (!file_path.toLowerCase().endsWith('.mp3')) {
      throw new Error('Not an MP3 file');
    }

    // Step 1: Fetch extended metadata from Spotify page (year, track#, image)
    const spotifyMeta = await fetchSpotifyMetadata(track_id);

    // Step 2: Fetch API metadata if credentials are available (genre, label)
    let apiMeta = {};
    if (track_id) {
      if (spotifyCredentials.clientId && spotifyCredentials.clientSecret) {
        console.log('[Hydra+: API] Fetching metadata...');
        apiMeta = await fetchSpotifyAPIMetadata(track_id);
      } else {
        console.log('[Hydra+: API] No credentials (skipping genre/label)');
      }
    }

    // Step 3: Rename file (with track number if provided)
    const trackNum = data.track_number || 0;
    const newPath = await renameFile(file_path, artist, track, trackNum);
    result.new_path = newPath;
    result.renamed = (newPath !== file_path);

    // Step 4: Download cover art
    const coverData = await downloadCoverArt(spotifyMeta.imageUrl);

    // Step 5: Write tags with node-id3
    const tags = {
      title: track || '',
      artist: artist || '',
      album: album || ''
    };

    // Add year if available
    if (spotifyMeta.year) {
      tags.year = spotifyMeta.year;
    }

    // Add track number if available (from Spotify or explicitly provided)
    if (data.track_number) {
      tags.trackNumber = String(data.track_number);
    } else if (spotifyMeta.trackNumber) {
      tags.trackNumber = spotifyMeta.trackNumber;
    }

    // Add genre if available from API
    if (apiMeta.genre) {
      tags.genre = apiMeta.genre;
    }

    // Add publisher/label if available from API
    if (apiMeta.label) {
      tags.publisher = apiMeta.label;
    }

    // Add cover art if available
    if (coverData) {
      tags.image = {
        mime: 'image/jpeg',
        type: { id: 3, name: 'front cover' },
        description: 'Cover',
        imageBuffer: coverData
      };
    }

    // Write the tags (node-id3 will replace all existing tags with only what we specify)
    let writeSuccess = false;
    try {
      console.log(`[Hydra+: META] ⚡ Writing ID3 tags...`);
      writeSuccess = NodeID3.write(tags, newPath);
    } catch (id3Error) {
      console.error(`[Hydra+: META] ✗ ID3 exception: ${id3Error.message}`);
      console.error(`[Hydra+: META] Stack: ${id3Error.stack}`);
      result.success = false;
      result.error = `ID3 write failed: ${id3Error.message}`;
    }

    if (writeSuccess) {
      result.tags_updated = true;
      result.cover_embedded = (coverData !== null);
      result.year = spotifyMeta.year || null;
      result.track_number = spotifyMeta.trackNumber || null;
      result.genre = apiMeta.genre || null;
      result.label = apiMeta.label || null;

      console.log(`[Hydra+: META] ✓ SUCCESS`);
      if (artist) console.log(`[Hydra+: META]   Artist: ${artist}`);
      if (track) console.log(`[Hydra+: META]   Title: ${track}`);
      if (album) console.log(`[Hydra+: META]   Album: ${album}`);
      if (spotifyMeta.year) console.log(`[Hydra+: META]   Year: ${spotifyMeta.year}`);
      if (spotifyMeta.trackNumber) console.log(`[Hydra+: META]   Track: #${spotifyMeta.trackNumber}`);
      if (apiMeta.genre) console.log(`[Hydra+: META]   Genre: ${apiMeta.genre}`);
      if (apiMeta.label) console.log(`[Hydra+: META]   Label: ${apiMeta.label}`);
      if (coverData) console.log(`[Hydra+: META]   Cover: embedded`);
    } else if (result.success) {
      // Only log this if we didn't already set an error above
      console.error(`[Hydra+: META] ✗ Write returned false`);
      result.success = false;
      result.error = 'Failed to write tags';
    }

  } catch (error) {
    console.error(`[Hydra+: META] ✗ Error: ${error.message}`);
    console.error(`[Hydra+: META] Stack: ${error.stack}`);
    result.success = false;
    result.error = error.message;
  }

  res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

// Create album folder and move files
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

// Start server
server.listen(PORT, '127.0.0.1', () => {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  >> HYDRA+ BRIDGE SERVER <<');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  [PORT]      → ${PORT}`);
  console.log('  [STATUS]    → 🟢 ONLINE');
  console.log(`  [QUEUE]     → ${path.basename(QUEUE_FILE)}`);
  console.log('  [ENDPOINTS] → /search /pending /process-metadata');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  Multi-headed beast ready to hunt... 🐍🐍🐍');
  console.log('════════════════════════════════════════════════════════════════\n');
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Hydra+] Shutting down...');
  server.close(() => {
    console.log('[Hydra+] ✓ Server closed');
    process.exit(0);
  });
});
