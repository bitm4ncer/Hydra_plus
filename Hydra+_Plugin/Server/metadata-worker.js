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
let renamePattern = {
  singleTrack: '{artist} - {track}',  // Default for single downloads
  albumTrack: '{trackNum} {artist} - {track}'  // Default for album downloads
};

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
    const { artist, track, album, year, genre, label, trackNumber, coverArtPath } = metadata;

    // Build ffmpeg command (escape values that may contain spaces)
    let metadataArgs = [];
    if (artist) metadataArgs.push('-metadata', `"artist=${artist}"`);
    if (track) metadataArgs.push('-metadata', `"title=${track}"`);
    if (album) metadataArgs.push('-metadata', `"album=${album}"`);
    if (year) metadataArgs.push('-metadata', `"date=${year}"`);
    if (genre) metadataArgs.push('-metadata', `"genre=${genre}"`);
    if (label) metadataArgs.push('-metadata', `"publisher=${label}"`);
    if (trackNumber) metadataArgs.push('-metadata', `"track=${trackNumber}"`);

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
    const { artist, track, album, year, genre, label, trackNumber, coverArtPath } = metadata;

    // Build metaflac commands
    const commands = [];

    // Remove existing tags
    commands.push(`metaflac --remove-all-tags "${filePath}"`);

    // Add new tags
    if (artist) commands.push(`metaflac --set-tag="ARTIST=${artist}" "${filePath}"`);
    if (track) commands.push(`metaflac --set-tag="TITLE=${track}" "${filePath}"`);
    if (album) commands.push(`metaflac --set-tag="ALBUM=${album}" "${filePath}"`);
    if (year) commands.push(`metaflac --set-tag="DATE=${year}" "${filePath}"`);
    if (genre) commands.push(`metaflac --set-tag="GENRE=${genre}" "${filePath}"`);
    if (label) commands.push(`metaflac --set-tag="LABEL=${label}" "${filePath}"`);
    if (trackNumber) commands.push(`metaflac --set-tag="TRACKNUMBER=${trackNumber}" "${filePath}"`);

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
async function renameFile(filePath, artist, track, trackNumber = 0, album = '', year = '') {
  try {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);

    // Sanitize inputs
    const sanitize = (str) => String(str || '').replace(/[<>:"/\\|?*]/g, '_');
    const artistClean = sanitize(artist);
    const trackClean = sanitize(track);
    const albumClean = sanitize(album);
    const yearClean = sanitize(year);

    if (!artistClean && !trackClean) {
      log(`✗ Cannot rename - missing both artist and track name`);
      return filePath;
    }

    // Choose pattern based on whether this is an album track
    const pattern = (trackNumber && trackNumber > 0) ? renamePattern.albumTrack : renamePattern.singleTrack;

    // Build filename from pattern
    let newName = pattern;

    // Replace tokens with actual values
    newName = newName.replace(/\{trackNum\}/g, trackNumber ? String(trackNumber).padStart(2, '0') : '');
    newName = newName.replace(/\{artist\}/g, artistClean);
    newName = newName.replace(/\{track\}/g, trackClean);
    newName = newName.replace(/\{album\}/g, albumClean);
    newName = newName.replace(/\{year\}/g, yearClean);

    // Clean up extra spaces/separators left by empty tokens
    newName = newName.replace(/\s+/g, ' ').replace(/\s*-\s*-\s*/g, ' - ').trim();
    newName = newName.replace(/^-\s*/, '').replace(/\s*-$/, ''); // Remove leading/trailing dashes

    const newPath = path.join(dir, newName + ext);

    // Don't rename if filename is already correct
    if (filePath === newPath) {
      return filePath;
    }

    // Handle duplicates
    let finalPath = newPath;
    let counter = 1;
    while (fsSync.existsSync(finalPath) && finalPath !== filePath) {
      const base = newName;
      finalPath = path.join(dir, `${base} (${counter})${ext}`);
      counter++;
    }

    // Rename file
    await fs.rename(filePath, finalPath);
    log(`✓ Renamed: ${path.basename(filePath)} → ${path.basename(finalPath)}`);

    return finalPath;
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
  const { pattern, singleTrack, albumTrack } = req.body;

  // Support both old format (single string) and new format (object with singleTrack/albumTrack)
  if (singleTrack || albumTrack) {
    if (singleTrack) renamePattern.singleTrack = singleTrack;
    if (albumTrack) renamePattern.albumTrack = albumTrack;
    log(`✓ Rename pattern updated: single="${renamePattern.singleTrack}", album="${renamePattern.albumTrack}"`);
  } else if (pattern) {
    // Legacy support: if single pattern string provided, use for both
    renamePattern.singleTrack = pattern;
    renamePattern.albumTrack = pattern;
    log(`✓ Rename pattern updated (legacy): ${pattern}`);
  } else {
    return res.status(400).json({ error: 'Missing pattern' });
  }

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
      trackId,
      trackNumber,
      prefetchedYear,
      prefetchedImageUrl,
      targetFolder,
      shouldFetchSpotify = true,
      shouldDownloadCoverArt = true,
      shouldWriteTags = true,
      shouldRename = true
    } = req.body;

    if (!filePath || !fsSync.existsSync(filePath)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    // Result object to return to Python plugin
    const result = {
      success: true,
      original_path: filePath,
      new_path: filePath,
      renamed: false,
      moved_to_folder: false,
      tags_updated: false,
      cover_embedded: false,
      year: null,
      track_number: trackNumber || null,
      genre: null,
      label: null
    };

    log(`Processing metadata for: ${path.basename(filePath)}`);

    // Check if file format is supported
    const ext = path.extname(filePath).toLowerCase();
    const isMP3 = ext === '.mp3';
    const isFLAC = ext === '.flac';

    if (!isMP3 && !isFLAC) {
      return res.status(400).json({ error: `Unsupported format: ${ext} (only MP3/FLAC supported)` });
    }

    log(`Format detected: ${isMP3 ? 'MP3' : 'FLAC'}`);

    // ========================================================================
    // STEP 1: RENAME FILE FIRST (before any network operations that could timeout)
    // ========================================================================
    let currentFilePath = filePath;
    if (shouldRename && artist && track) {
      const newPath = await renameFile(currentFilePath, artist, track, trackNumber, album, prefetchedYear);
      if (newPath !== currentFilePath) {
        currentFilePath = newPath;
        result.new_path = newPath;
        result.renamed = true;
      }
    }

    // ========================================================================
    // STEP 2: MOVE TO TARGET FOLDER if specified (for album downloads)
    // CRITICAL: Move immediately after rename to prevent orphaned files on crash
    // ========================================================================
    if (targetFolder) {
      try {
        if (!fsSync.existsSync(targetFolder)) {
          throw new Error(`Target folder does not exist: ${targetFolder}`);
        }

        const fileName = path.basename(currentFilePath);
        const targetPath = path.join(targetFolder, fileName);

        // Only move if not already in target folder
        if (targetPath !== currentFilePath) {
          // Handle duplicates
          let finalPath = targetPath;
          let counter = 1;
          while (fsSync.existsSync(finalPath) && finalPath !== currentFilePath) {
            const ext = path.extname(fileName);
            const base = path.basename(fileName, ext);
            finalPath = path.join(targetFolder, `${base} (${counter})${ext}`);
            counter++;
          }

          await fs.rename(currentFilePath, finalPath);
          log(`✓ Moved to album folder: ${path.basename(targetFolder)}`);
          currentFilePath = finalPath;
          result.new_path = finalPath;
          result.moved_to_folder = true;
        } else {
          log(`Already in target folder`);
          result.moved_to_folder = true;
        }
      } catch (moveError) {
        log(`⚠ Failed to move to folder: ${moveError.message}`);
        // Don't fail the whole operation if move fails - file is still renamed
        result.moved_to_folder = false;
      }
    }

    // ========================================================================
    // CRITICAL FIX: Always send success response immediately after renaming/moving
    // This prevents Python plugin timeout issues, especially for album batches
    // ========================================================================
    res.json(result);

    // ========================================================================
    // Continue with metadata processing in background (don't block response)
    // This runs asynchronously and won't delay the next track in album batches
    // CRITICAL: All code in this block must be wrapped in try-catch to prevent server crashes
    // ========================================================================
    setTimeout(async () => {
      try {
        log('[META] Continuing metadata fetch in background...');

        // Step 3: Fetch extended metadata from Spotify
        // IMPROVED: Use prefetched metadata if available (skip Spotify page fetch)
        let spotifyMetadata = null;

        if (prefetchedYear || prefetchedImageUrl) {
          // Use prefetched metadata from Python cache
          log('✓ Using prefetched metadata from cache');
          spotifyMetadata = {
            year: prefetchedYear || null,
            imageUrl: prefetchedImageUrl || null,
            genre: null,
            label: null
          };
        } else if (shouldFetchSpotify && artist && track) {
          // Fallback: Fetch from Spotify (for single tracks or cache miss)
          try {
            spotifyMetadata = await getSpotifyMetadata(artist, track);
            if (spotifyMetadata) {
              log(`✓ Spotify metadata fetched`);
            }
          } catch (spotifyError) {
            log(`✗ Spotify metadata error: ${spotifyError.message}`);
            spotifyMetadata = {};
          }
        }

        // Step 4: Download cover art
        let coverArtPath = null;
        if (shouldDownloadCoverArt && spotifyMetadata && spotifyMetadata.imageUrl) {
          const coverArtFilename = `cover_${Date.now()}.jpg`;
          coverArtPath = path.join(path.dirname(currentFilePath), coverArtFilename);

          try {
            await downloadCoverArt(spotifyMetadata.imageUrl, coverArtPath);
            log(`✓ Cover art downloaded`);
          } catch (error) {
            log(`✗ Cover art download failed: ${error.message}`);
            coverArtPath = null;
          }
        }

        // Step 5: Write ID3 tags
        if (shouldWriteTags) {
          const tagMetadata = {
            artist,
            track,
            album,
            year: spotifyMetadata?.year,
            genre: spotifyMetadata?.genre,
            label: spotifyMetadata?.label,
            trackNumber: trackNumber,
            coverArtPath
          };

          let tagsWritten = false;
          if (isMP3) {
            tagsWritten = await writeId3Tags(currentFilePath, tagMetadata);
          } else if (isFLAC) {
            tagsWritten = await writeFlacTags(currentFilePath, tagMetadata);
          }

          if (tagsWritten) {
            log(`✓ Tags and cover art embedded`);
          }
        }

        // Clean up temporary cover art
        if (coverArtPath && fsSync.existsSync(coverArtPath)) {
          try {
            await fs.unlink(coverArtPath);
          } catch {}
        }

        const duration = Date.now() - startTime;
        log(`✓ Background metadata processing complete (${duration}ms)`);

      } catch (backgroundError) {
        log(`✗ Background processing error: ${backgroundError.message}`);
        // Don't crash the server - just log the error
      }
    }, 500); // 500ms delay to prevent concurrent job pile-up

  } catch (error) {
    log(`✗ Metadata processing failed: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * Ensure album folder exists
 */
app.post('/ensure-album-folder', async (req, res) => {
  try {
    // Support both old format (trackPath, artist, album) and new format (album_artist, album_name, download_dir)
    const { trackPath, artist, album, album_artist, album_name, download_dir } = req.body;

    // Determine which format is being used
    const artistName = album_artist || artist;
    const albumTitle = album_name || album;
    const baseDir = download_dir || (trackPath ? path.dirname(trackPath) : null);

    if (!artistName || !albumTitle || !baseDir) {
      return res.status(400).json({ error: 'Missing required parameters (need artist+album+path)' });
    }

    // Check if base directory exists
    if (!fsSync.existsSync(baseDir)) {
      return res.status(400).json({ error: `Base directory does not exist: ${baseDir}` });
    }

    // Sanitize folder name
    const folderName = `${artistName} - ${albumTitle}`.replace(/[<>:"/\\|?*]/g, '_');
    const albumPath = path.join(baseDir, folderName);

    // Create folder if it doesn't exist
    if (!fsSync.existsSync(albumPath)) {
      await fs.mkdir(albumPath, { recursive: true });
      log(`✓ Created album folder: ${folderName}`);
    } else {
      log(`Album folder already exists: ${folderName}`);
    }

    res.json({
      success: true,
      albumPath: albumPath,
      folder_path: albumPath, // Python expects 'folder_path'
      folder_name: folderName
    });
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
      log(`Rename pattern (single): ${renamePattern.singleTrack}`);
      log(`Rename pattern (album): ${renamePattern.albumTrack}`);
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
