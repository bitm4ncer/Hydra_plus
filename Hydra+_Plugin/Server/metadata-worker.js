#!/usr/bin/env node
/**
 * Hydra+ Metadata Worker
 * Heavy processing server that handles metadata, Spotify API, cover art, ID3 tags
 * Port: 3848
 *
 * This worker can crash/restart without affecting state tracking in state-server.js
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
const PORT = 3848;

// Middleware
app.use(cors());
app.use(express.json());

// Spotify credentials storage
let spotifyCredentials = null;
let renamePattern = '{artist} - {track}';

// Helper: Log with timestamp
function log(message) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${timestamp}] [Metadata Worker] ${message}`);
}

// Helper: Delay function
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// SPOTIFY CREDENTIALS MANAGEMENT
// ============================================================================

/**
 * Load Spotify credentials from file
 */
async function loadSpotifyCredentials() {
  try {
    const credPath = path.join(__dirname, 'spotify-credentials.json');
    const data = await fs.readFile(credPath, 'utf8');
    spotifyCredentials = JSON.parse(data);
    log('✓ Loaded Spotify credentials from file');
    return spotifyCredentials;
  } catch (error) {
    log('No Spotify credentials file found');
    return null;
  }
}

/**
 * Save Spotify credentials to file
 */
async function saveSpotifyCredentials(credentials) {
  try {
    const credPath = path.join(__dirname, 'spotify-credentials.json');
    await fs.writeFile(credPath, JSON.stringify(credentials, null, 2));
    spotifyCredentials = credentials;
    log('✓ Saved Spotify credentials to file');
    return true;
  } catch (error) {
    log(`✗ Failed to save credentials: ${error.message}`);
    return false;
  }
}

/**
 * Get Spotify access token (refresh if needed)
 */
async function getSpotifyAccessToken() {
  if (!spotifyCredentials) {
    await loadSpotifyCredentials();
  }

  // Support both camelCase (from extension) and snake_case (legacy) formats
  const clientId = spotifyCredentials?.clientId || spotifyCredentials?.client_id;
  const clientSecret = spotifyCredentials?.clientSecret || spotifyCredentials?.client_secret;

  if (!spotifyCredentials || !clientId || !clientSecret) {
    throw new Error('Spotify credentials not configured');
  }

  // Check if token is still valid (with 5 minute buffer)
  if (spotifyCredentials.access_token && spotifyCredentials.expires_at) {
    const expiresAt = new Date(spotifyCredentials.expires_at);
    const now = new Date();
    if (expiresAt - now > 5 * 60 * 1000) {
      return spotifyCredentials.access_token;
    }
  }

  // Refresh token
  log('Refreshing Spotify access token...');
  const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  return new Promise((resolve, reject) => {
    const postData = 'grant_type=client_credentials';
    const options = {
      hostname: 'accounts.spotify.com',
      port: 443,
      path: '/api/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': postData.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', async () => {
        try {
          const response = JSON.parse(data);
          if (response.access_token) {
            const expiresAt = new Date(Date.now() + response.expires_in * 1000);
            spotifyCredentials.access_token = response.access_token;
            spotifyCredentials.expires_at = expiresAt.toISOString();
            await saveSpotifyCredentials(spotifyCredentials);
            log('✓ Spotify token refreshed');
            resolve(response.access_token);
          } else {
            reject(new Error('No access token in response'));
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ============================================================================
// SPOTIFY API FUNCTIONS
// ============================================================================

/**
 * Search Spotify for track metadata
 */
async function searchSpotify(artist, track) {
  try {
    const accessToken = await getSpotifyAccessToken();
    const query = encodeURIComponent(`artist:${artist} track:${track}`);
    const url = `https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.spotify.com',
        port: 443,
        path: `/v1/search?q=${query}&type=track&limit=1`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.tracks && response.tracks.items && response.tracks.items.length > 0) {
              const trackData = response.tracks.items[0];
              const metadata = {
                year: trackData.album.release_date ? trackData.album.release_date.split('-')[0] : null,
                imageUrl: trackData.album.images && trackData.album.images.length > 0 ? trackData.album.images[0].url : null,
                genre: null, // Need to get from artist endpoint
                label: null, // Need to get from album endpoint
                albumId: trackData.album.id,
                artistId: trackData.artists[0].id
              };
              resolve(metadata);
            } else {
              resolve(null);
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  } catch (error) {
    log(`✗ Spotify search failed: ${error.message}`);
    return null;
  }
}

/**
 * Get artist genre from Spotify
 */
async function getArtistGenre(artistId) {
  try {
    const accessToken = await getSpotifyAccessToken();

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.spotify.com',
        port: 443,
        path: `/v1/artists/${artistId}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.genres && response.genres.length > 0) {
              resolve(response.genres[0]); // Return first genre
            } else {
              resolve(null);
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  } catch (error) {
    log(`✗ Failed to get artist genre: ${error.message}`);
    return null;
  }
}

/**
 * Get album label from Spotify
 */
async function getAlbumLabel(albumId) {
  try {
    const accessToken = await getSpotifyAccessToken();

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.spotify.com',
        port: 443,
        path: `/v1/albums/${albumId}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.label) {
              resolve(response.label);
            } else {
              resolve(null);
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  } catch (error) {
    log(`✗ Failed to get album label: ${error.message}`);
    return null;
  }
}

/**
 * Get complete Spotify metadata for a track
 */
async function getSpotifyMetadata(artist, track) {
  try {
    // Search for track
    const trackMetadata = await searchSpotify(artist, track);
    if (!trackMetadata) {
      return null;
    }

    // Get genre from artist
    if (trackMetadata.artistId) {
      trackMetadata.genre = await getArtistGenre(trackMetadata.artistId);
    }

    // Get label from album
    if (trackMetadata.albumId) {
      trackMetadata.label = await getAlbumLabel(trackMetadata.albumId);
    }

    return trackMetadata;
  } catch (error) {
    log(`✗ Failed to get Spotify metadata: ${error.message}`);
    return null;
  }
}

// ============================================================================
// COVER ART DOWNLOAD
// ============================================================================

/**
 * Download cover art from URL
 */
async function downloadCoverArt(imageUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const protocol = imageUrl.startsWith('https') ? https : http;

    protocol.get(imageUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download cover art: ${response.statusCode}`));
        return;
      }

      const fileStream = fsSync.createWriteStream(outputPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve(outputPath);
      });

      fileStream.on('error', (error) => {
        fsSync.unlink(outputPath, () => {}); // Delete partial file
        reject(error);
      });
    }).on('error', reject);
  });
}

// ============================================================================
// ID3 TAG WRITING
// ============================================================================

/**
 * Write ID3 tags to MP3 file using ffmpeg
 */
async function writeId3Tags(filePath, metadata) {
  try {
    const { artist, track, year, genre, label, coverArtPath } = metadata;

    // Build ffmpeg command (escape values that may contain spaces)
    let metadataArgs = [];
    if (artist) metadataArgs.push('-metadata', `"artist=${artist}"`);
    if (track) metadataArgs.push('-metadata', `"title=${track}"`);
    if (year) metadataArgs.push('-metadata', `"date=${year}"`);
    if (genre) metadataArgs.push('-metadata', `"genre=${genre}"`);
    if (label) metadataArgs.push('-metadata', `"publisher=${label}"`);

    // Create temporary output file
    const tempPath = `${filePath}.temp.mp3`;

    // Build ffmpeg command with cover art if available
    let ffmpegCmd;
    if (coverArtPath && fsSync.existsSync(coverArtPath)) {
      ffmpegCmd = [
        'ffmpeg',
        '-i', `"${filePath}"`,
        '-i', `"${coverArtPath}"`,
        '-map', '0:a',
        '-map', '1:0',
        '-c', 'copy',
        '-id3v2_version', '3',
        ...metadataArgs,
        '-metadata:s:v', 'title="Album cover"',
        '-metadata:s:v', 'comment="Cover (front)"',
        `"${tempPath}"`
      ].join(' ');
    } else {
      ffmpegCmd = [
        'ffmpeg',
        '-i', `"${filePath}"`,
        '-c', 'copy',
        '-id3v2_version', '3',
        ...metadataArgs,
        `"${tempPath}"`
      ].join(' ');
    }

    // Execute ffmpeg
    await execAsync(ffmpegCmd);

    // Replace original file with tagged file
    await fs.unlink(filePath);
    await fs.rename(tempPath, filePath);

    log(`✓ ID3 tags written to: ${path.basename(filePath)}`);
    return true;
  } catch (error) {
    log(`✗ Failed to write ID3 tags: ${error.message}`);
    // Clean up temp file if it exists
    try {
      await fs.unlink(`${filePath}.temp.mp3`);
    } catch {}
    return false;
  }
}

/**
 * Write ID3 tags to FLAC file using metaflac
 */
async function writeFlacTags(filePath, metadata) {
  try {
    const { artist, track, year, genre, label, coverArtPath } = metadata;

    // Build metaflac commands
    const commands = [];

    // Remove existing tags
    commands.push(`metaflac --remove-all-tags "${filePath}"`);

    // Add new tags
    if (artist) commands.push(`metaflac --set-tag="ARTIST=${artist}" "${filePath}"`);
    if (track) commands.push(`metaflac --set-tag="TITLE=${track}" "${filePath}"`);
    if (year) commands.push(`metaflac --set-tag="DATE=${year}" "${filePath}"`);
    if (genre) commands.push(`metaflac --set-tag="GENRE=${genre}" "${filePath}"`);
    if (label) commands.push(`metaflac --set-tag="LABEL=${label}" "${filePath}"`);

    // Add cover art if available
    if (coverArtPath && fsSync.existsSync(coverArtPath)) {
      commands.push(`metaflac --import-picture-from="${coverArtPath}" "${filePath}"`);
    }

    // Execute all commands
    for (const cmd of commands) {
      await execAsync(cmd);
    }

    log(`✓ FLAC tags written to: ${path.basename(filePath)}`);
    return true;
  } catch (error) {
    log(`✗ Failed to write FLAC tags: ${error.message}`);
    return false;
  }
}

// ============================================================================
// FILE RENAMING
// ============================================================================

/**
 * Rename file according to pattern
 */
async function renameFile(filePath, artist, track) {
  try {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);

    // Replace pattern placeholders
    let newName = renamePattern
      .replace('{artist}', artist)
      .replace('{track}', track);

    // Sanitize filename (remove invalid characters)
    newName = newName.replace(/[<>:"/\\|?*]/g, '_');

    const newPath = path.join(dir, newName + ext);

    // Don't rename if filename is already correct
    if (filePath === newPath) {
      return filePath;
    }

    // Rename file
    await fs.rename(filePath, newPath);
    log(`✓ Renamed: ${path.basename(filePath)} → ${path.basename(newPath)}`);

    return newPath;
  } catch (error) {
    log(`✗ Failed to rename file: ${error.message}`);
    return filePath; // Return original path on error
  }
}

// ============================================================================
// ALBUM FOLDER MANAGEMENT
// ============================================================================

/**
 * Create album folder in parent directory
 */
async function createAlbumFolder(trackPath, artist, album) {
  try {
    const trackDir = path.dirname(trackPath);

    // Sanitize folder name
    const folderName = `${artist} - ${album}`.replace(/[<>:"/\\|?*]/g, '_');
    const albumPath = path.join(trackDir, folderName);

    // Create folder if it doesn't exist
    if (!fsSync.existsSync(albumPath)) {
      await fs.mkdir(albumPath, { recursive: true });
      log(`✓ Created album folder: ${folderName}`);
    }

    return albumPath;
  } catch (error) {
    log(`✗ Failed to create album folder: ${error.message}`);
    return null;
  }
}

/**
 * Move track file into album folder
 */
async function moveToAlbumFolder(filePath, albumFolderPath) {
  try {
    const filename = path.basename(filePath);
    const newPath = path.join(albumFolderPath, filename);

    // Don't move if already in correct location
    if (filePath === newPath) {
      return filePath;
    }

    await fs.rename(filePath, newPath);
    log(`✓ Moved to album folder: ${filename}`);

    return newPath;
  } catch (error) {
    log(`✗ Failed to move to album folder: ${error.message}`);
    return filePath;
  }
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * Health check endpoint
 */
app.get('/ping', (req, res) => {
  res.json({
    status: 'ok',
    server: 'metadata-worker',
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

/**
 * Set Spotify credentials
 */
app.post('/set-spotify-credentials', async (req, res) => {
  try {
    const { client_id, client_secret } = req.body;

    if (!client_id || !client_secret) {
      return res.status(400).json({ error: 'Missing client_id or client_secret' });
    }

    const credentials = {
      client_id,
      client_secret,
      access_token: null,
      expires_at: null
    };

    const saved = await saveSpotifyCredentials(credentials);
    if (saved) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Failed to save credentials' });
    }
  } catch (error) {
    log(`✗ Error setting credentials: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Test Spotify credentials
 */
app.post('/test-spotify-credentials', async (req, res) => {
  try {
    const token = await getSpotifyAccessToken();
    res.json({
      success: true,
      hasToken: !!token
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Set rename pattern
 */
app.post('/set-rename-pattern', (req, res) => {
  const { pattern } = req.body;
  if (!pattern) {
    return res.status(400).json({ error: 'Missing pattern' });
  }

  renamePattern = pattern;
  log(`✓ Rename pattern updated: ${pattern}`);
  res.json({ success: true });
});

/**
 * Process single track metadata
 * This is the main endpoint that does all the heavy processing
 */
app.post('/process-metadata', async (req, res) => {
  const startTime = Date.now();

  try {
    const {
      filePath,
      artist,
      track,
      album,
      shouldFetchSpotify = true,
      shouldDownloadCoverArt = true,
      shouldWriteTags = true,
      shouldRename = true
    } = req.body;

    if (!filePath || !fsSync.existsSync(filePath)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    const result = {
      success: false,
      filePath: filePath,
      metadata: {},
      actions: {
        spotifyFetch: false,
        coverArtDownload: false,
        tagsWritten: false,
        fileRenamed: false
      }
    };

    log(`Processing metadata for: ${path.basename(filePath)}`);

    // Step 1: Fetch Spotify metadata
    let spotifyMetadata = null;
    if (shouldFetchSpotify && artist && track) {
      spotifyMetadata = await getSpotifyMetadata(artist, track);
      if (spotifyMetadata) {
        result.metadata = spotifyMetadata;
        result.actions.spotifyFetch = true;
        log(`✓ Spotify metadata fetched`);
      }
    }

    // Step 2: Download cover art
    let coverArtPath = null;
    if (shouldDownloadCoverArt && spotifyMetadata && spotifyMetadata.imageUrl) {
      const coverArtFilename = `cover_${Date.now()}.jpg`;
      coverArtPath = path.join(path.dirname(filePath), coverArtFilename);

      try {
        await downloadCoverArt(spotifyMetadata.imageUrl, coverArtPath);
        result.actions.coverArtDownload = true;
        log(`✓ Cover art downloaded`);
      } catch (error) {
        log(`✗ Cover art download failed: ${error.message}`);
      }
    }

    // Step 3: Write ID3 tags
    let currentFilePath = filePath;
    if (shouldWriteTags) {
      const ext = path.extname(filePath).toLowerCase();
      const tagMetadata = {
        artist,
        track,
        year: spotifyMetadata?.year,
        genre: spotifyMetadata?.genre,
        label: spotifyMetadata?.label,
        coverArtPath
      };

      let tagsWritten = false;
      if (ext === '.mp3') {
        tagsWritten = await writeId3Tags(currentFilePath, tagMetadata);
      } else if (ext === '.flac') {
        tagsWritten = await writeFlacTags(currentFilePath, tagMetadata);
      }

      result.actions.tagsWritten = tagsWritten;
    }

    // Step 4: Rename file
    if (shouldRename && artist && track) {
      const newPath = await renameFile(currentFilePath, artist, track);
      if (newPath !== currentFilePath) {
        currentFilePath = newPath;
        result.actions.fileRenamed = true;
        result.filePath = newPath;
      }
    }

    // Clean up temporary cover art
    if (coverArtPath && fsSync.existsSync(coverArtPath)) {
      try {
        await fs.unlink(coverArtPath);
      } catch {}
    }

    result.success = true;
    const duration = Date.now() - startTime;
    log(`✓ Metadata processing complete (${duration}ms)`);

    res.json(result);
  } catch (error) {
    log(`✗ Metadata processing failed: ${error.message}`);
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
});

/**
 * Ensure album folder exists
 */
app.post('/ensure-album-folder', async (req, res) => {
  try {
    const { trackPath, artist, album } = req.body;

    if (!trackPath || !artist || !album) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const albumPath = await createAlbumFolder(trackPath, artist, album);

    if (albumPath) {
      res.json({ success: true, albumPath });
    } else {
      res.status(500).json({ error: 'Failed to create album folder' });
    }
  } catch (error) {
    log(`✗ Error creating album folder: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Organize album tracks into folder
 */
app.post('/organize-album', async (req, res) => {
  try {
    const { trackPaths, artist, album } = req.body;

    if (!trackPaths || !Array.isArray(trackPaths) || trackPaths.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid trackPaths array' });
    }

    if (!artist || !album) {
      return res.status(400).json({ error: 'Missing artist or album' });
    }

    // Create album folder
    const albumPath = await createAlbumFolder(trackPaths[0], artist, album);
    if (!albumPath) {
      return res.status(500).json({ error: 'Failed to create album folder' });
    }

    // Move all tracks into album folder
    const results = [];
    for (const trackPath of trackPaths) {
      if (fsSync.existsSync(trackPath)) {
        const newPath = await moveToAlbumFolder(trackPath, albumPath);
        results.push({ originalPath: trackPath, newPath });
      }
    }

    res.json({
      success: true,
      albumPath,
      tracks: results
    });
  } catch (error) {
    log(`✗ Error organizing album: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Restart worker (allows clean restart without affecting state server)
 */
app.post('/restart', (req, res) => {
  log('Restart requested - shutting down...');
  res.json({ success: true, message: 'Metadata worker shutting down' });

  setTimeout(() => {
    process.exit(0);
  }, 500);
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

async function startServer() {
  try {
    // Load Spotify credentials on startup
    await loadSpotifyCredentials();

    app.listen(PORT, () => {
      // Set console window title on Windows
      if (process.platform === 'win32') {
        process.title = 'Hydra+ Metadata Worker (Port 3848)';
      }

      log(`========================================`);
      log(`Metadata Worker started on port ${PORT}`);
      log(`Spotify credentials: ${spotifyCredentials ? 'Configured' : 'Not configured'}`);
      log(`Rename pattern: ${renamePattern}`);
      log(`========================================`);
    });
  } catch (error) {
    log(`✗ Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  log('Received SIGINT - shutting down gracefully');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Received SIGTERM - shutting down gracefully');
  process.exit(0);
});

// Start the server
startServer();
