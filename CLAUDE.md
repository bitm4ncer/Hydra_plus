# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Hydra+** is a Spotify → Soulseek bridge that enables one-click music downloads from Spotify to Nicotine+ with automatic metadata management. Version 0.1.9.

**Architecture Flow:**
```
Browser Extension (Manifest V3)
    ↓ HTTP POST
State Server (Node.js, Port 3847) - Progress tracking, events, queue
    ↓ Poll /pending
Nicotine+ Plugin (Python) - Soulseek search & download
    ↓ HTTP POST /process-metadata
Metadata Worker (Node.js, Port 3848) - Spotify API, ID3 tagging, cover art
```

## Development Commands

### Server Development

**Install dependencies:**
```bash
cd Hydra+_Plugin/Server
npm install
```

**Start dual servers (production mode - minimized windows):**
```bash
cd Hydra+_Plugin/Server
start-dual-servers.bat
```

**Start dual servers (debug mode - separate console windows):**
```bash
cd Hydra+_Plugin/Server
start-dual-servers-debug.bat
```

**Start individual servers:**
```bash
# State server only (port 3847)
node state-server.js

# Metadata worker only (port 3848)
node metadata-worker.js
```

**Test servers:**
```bash
# State server health check
curl http://127.0.0.1:3847/ping

# Metadata worker health check
curl http://127.0.0.1:3848/ping

# Get status (events + progress)
curl http://127.0.0.1:3847/status
```

**Kill all servers:**
```bash
kill_server.bat
```

### Extension Development

**Load extension for testing:**
1. Navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `Hydra+_Extension/` directory

**Extension files:**
- `content.js` - Injected into Spotify pages, adds download buttons
- `popup.js` - Extension popup UI (settings, console, progress)
- `background.js` - Service worker for context menus
- `manifest.json` - Chrome extension manifest (v3)

### Plugin Development

**Plugin location (auto-installed):**
```
Windows: %APPDATA%\nicotine\plugins\Hydra+_Plugin\
Linux/Mac: ~/.nicotine/plugins/Hydra+_Plugin/
```

**Test plugin:**
1. Enable plugin in Nicotine+ Settings → Plugins
2. Plugin auto-starts servers on load
3. Check Nicotine+ logs for plugin output

## Dual Server Architecture

**CRITICAL:** Hydra+ uses a dual server architecture to separate concerns and improve stability.

### State Server (Port 3847)

**Purpose:** Lightweight state management that never crashes

**Responsibilities:**
- Download progress tracking (`activeDownloads` Map)
- Event log for extension console (`events` Array, max 50, 1hr TTL)
- Queue file operations (`nicotine-queue.json` read/write)
- Spotify credentials storage
- Search request queuing

**Key characteristics:**
- No heavy I/O or external API calls
- Always responds quickly (< 50ms)
- Fire-and-forget endpoints for progress/events (never blocks Python plugin)

**Main endpoints:**
- `GET /status` - Returns events + activeDownloads (polled by extension popup)
- `POST /progress` - Update download progress (fire-and-forget)
- `POST /event` - Add console event (fire-and-forget)
- `GET /pending` - Get unprocessed searches (polled by Python plugin)
- `POST /search` - Queue search request
- `POST /search-album` - Queue album search request

### Metadata Worker (Port 3848)

**Purpose:** Heavy processing that can safely crash/timeout

**Responsibilities:**
- Fetch Spotify page metadata (scraping album year, image URL)
- Fetch Spotify API metadata (genre, label - requires credentials)
- Download cover art from URLs (with LRU cache, 50MB max)
- Write ID3v2 tags to MP3 files (using node-id3)
- Write Vorbis comments to FLAC files (using flac-tagger)
- Rename files according to pattern
- Organize album tracks into folders

**Key characteristics:**
- Operations can take 5-30 seconds
- External dependencies: Spotify API, node-id3, flac-tagger
- Can crash without affecting state server
- Can be restarted independently via `POST /restart`

**Main endpoints:**
- `POST /process-metadata` - Process single track metadata (heavy operation)
- `POST /ensure-album-folder` - Create album folder
- `POST /organize-album` - Move tracks into album folder
- `POST /set-spotify-credentials` - Store API credentials
- `POST /test-spotify-credentials` - Test API connection

### Why Dual Servers?

1. **Stability**: Progress bars never disappear if metadata processing crashes
2. **Resilience**: State server responds even if metadata worker is down
3. **Debugging**: Easy to identify which component is failing
4. **Performance**: State operations never blocked by heavy metadata processing

## Python Plugin Architecture

**File:** `Hydra+_Plugin/__init__.py` (~2400 lines)

### Key Plugin Hooks

The plugin extends `BasePlugin` from Nicotine+ and implements these critical hooks:

**`_on_file_search_response(self, msg)`** - Called when search results arrive from a peer
- Receives search results from Soulseek network
- Scores files using `_calculate_file_score()` (bitrate, duration, size, filename match)
- Tracks top 5 candidates per search for auto-fallback
- Triggers auto-download if score > 100 after 15s or score > 50 after 30s

**`download_finished_notification(self, user, virtual_path, real_path)`** - Called when download completes
- Routes to `_handle_track_completion()` or `_handle_album_track_completion()`
- Sends metadata to metadata worker for processing
- Implements fallback: tries next candidate if download fails
- Updates progress tracking via state server

### Auto-Download Scoring System

**File:** `_calculate_file_score()` in `__init__.py`

**Scoring breakdown (max 310 points):**
- Bitrate (max 100): 320kbps=100, 256=80, 192=60, 128=40
- Duration match (max 100): ±2sec=100, ±5sec=80, ±10sec=50, ±20sec=25
- File size (max 50): >8MB=50, >5MB=40, >3MB=30, >1MB=20
- Filename match (max 50): Exact=50, proportional for partial matches
- File type bonus (+10): .mp3, .flac, .alac, .wav

**Format preference handling:**
- `format_preference='mp3'`: MP3 gets +50 bonus, FLAC gets -30 penalty
- `format_preference='flac'`: FLAC gets +100 bonus, MP3 gets -50 penalty
- Auto-fallback to alternative formats if preferred unavailable

**Download triggers:**
- Score > 100 after 15s: Download immediately (high confidence)
- Score > 50 after 30s: Download best candidate (timeout)
- Top 5 candidates tracked for auto-fallback on failure

### Adaptive Polling

**File:** `_poll_queue()` in `__init__.py`

**Modes:**
- **Active mode** (2s interval): When searches or downloads are active
- **Idle mode** (10s interval): No activity for 30s-5min
- **Sleep mode** (30s interval): No activity for 5+ minutes

**Activity tracking:**
- Updated on: new searches, active searches, active downloads
- Reduces CPU usage by 80-93% during idle periods
- Instant response when active

### Memory Management

**Metadata Cache:**
- TTL: 10 minutes
- Max size: 1000 entries
- LRU eviction when full
- Cleanup interval: 1 minute

**Cover Art Cache (in metadata worker):**
- Max size: 50MB
- LRU eviction when full
- Prevents memory exhaustion on large album batches

**Processed Timestamps:**
- Retention: 15 minutes
- Cleanup interval: 1 minute

## Album vs Single Track Handling

### Single Track Downloads

1. Extension sends `POST /search` to state server
2. State server queues search
3. Python plugin polls `/pending`, gets search
4. Plugin calls `core.search.do_search()` in Nicotine+
5. Results arrive via `_on_file_search_response()`
6. Best candidate downloaded via `core.downloads.download_file()`
7. On completion: `download_finished_notification()` → `_handle_track_completion()`
8. Metadata processed via `POST /process-metadata` to metadata worker
9. File renamed to: `{artist} - {track}.mp3` (default pattern)

### Album Downloads

1. Extension sends `POST /search-album` with array of tracks
2. State server queues album search (sets `search_type='album'`)
3. Plugin searches for first track (best match = album anchor)
4. Plugin calls `_match_album_tracks()` to match folder structure
5. Plugin calls `_prefetch_album_metadata()` in background thread
6. All tracks downloaded to temp location
7. After all downloads: `_finalize_album_download()`
8. Metadata processed in batch via `_process_album_metadata_batch()`
9. Tracks moved to album folder via `POST /organize-album`
10. Files renamed to: `{trackNum} {artist} - {track}.mp3` (default pattern)

**Key difference:** Albums match entire folder structure and process metadata in batch to share cover art downloads.

## Metadata Processing

### MP3 Files (ID3v2)

**Package:** `node-id3` (npm)

**Tags written:**
- Title (TIT2)
- Artist (TPE1)
- Album (TALB)
- Year (TYER)
- Track Number (TRCK)
- Genre (TCON) - requires Spotify API
- Publisher/Label (TPUB) - requires Spotify API
- Cover Art (APIC) - embedded as JPEG

**Implementation:** `processMetadata()` in `metadata-worker.js`

### FLAC Files (Vorbis Comments)

**Package:** `flac-tagger` (npm)

**Tags written:**
- TITLE
- ARTIST
- ALBUM
- DATE (year)
- TRACKNUMBER
- GENRE - requires Spotify API
- ORGANIZATION (label) - requires Spotify API
- Cover art - embedded via `METADATA_BLOCK_PICTURE`

**Implementation:** `processFLACMetadata()` in `metadata-worker.js`

### Spotify API Integration

**Optional:** Adds genre and label tags if credentials configured

**Setup:**
1. Create app at developer.spotify.com/dashboard
2. Get Client ID and Client Secret
3. Store via extension popup or `POST /set-spotify-credentials`
4. Credentials saved to `spotify-credentials.json`

**Rate limiting:** Not implemented - Spotify API is rate-limited by design

## File Rename Patterns

**Default patterns (configurable via extension popup):**
- Single track: `{artist} - {track}`
- Album track: `{trackNum} {artist} - {track}`

**Supported placeholders:**
- `{artist}` - Artist name
- `{track}` - Track title
- `{album}` - Album name
- `{year}` - Release year
- `{trackNum}` - Track number (zero-padded)

**Version suffix stripping:**
The extension automatically removes common suffixes from track/album names:
- "2015 Remaster", "Remastered 2015"
- "Deluxe Edition", "Special Edition", "Limited Edition"
- "Live Version", "Acoustic Version", "Radio Edit"

**Implementation:** `stripVersionSuffixes()` in `content.js`

## Extension Implementation Notes

### MutationObserver Throttling

**File:** `content.js`

**Problem:** Spotify's dynamic DOM causes 100s of observer triggers per second

**Solution:**
- Throttle to max 10 triggers/second (100ms delay)
- Filter observer to only track rows and action bars
- Cleanup observers on page unload

**Implementation:** `scheduleProcessing()` with `PROCESS_THROTTLE_MS = 100`

### Navigation Detection

**Method:** 500ms polling interval for URL changes (not MutationObserver)

**Reason:** Lightweight polling is more efficient than heavy DOM observation for simple URL checking

### Progress Polling

**Extension polls** `GET /status` every 1 second to update popup console and progress bars

**State server returns:**
```json
{
  "events": [...],  // Console events (max 50)
  "activeDownloads": {
    "trackId": {
      "filename": "Artist - Track.mp3",
      "progress": 75,
      "bytesDownloaded": 3000000,
      "totalBytes": 4000000
    }
  }
}
```

## Common Development Patterns

### Adding a New Endpoint to State Server

1. Add handler in `state-server.js` after line 279 (`http.createServer()`)
2. Use fire-and-forget pattern for non-critical operations (no await on response)
3. Update health metrics: `healthMetrics.requestCount++`
4. Return JSON with proper headers

### Adding a New Endpoint to Metadata Worker

1. Add route in `metadata-worker.js` using Express: `app.post('/endpoint', async (req, res) => {...})`
2. Wrap in try-catch and return proper error responses
3. Log operations with `log()` helper
4. Handle long operations with proper timeouts

### Modifying Plugin Search Logic

1. Main search scoring in `_calculate_file_score()` (line ~912)
2. Search result handling in `_on_file_search_response()` (line ~1052)
3. Track vs album routing via `search_info['search_type']`
4. Always update `last_activity_time` for adaptive polling

### Adding New Metadata Fields

1. Update `processMetadata()` or `processFLACMetadata()` in `metadata-worker.js`
2. Add field to Spotify API fetch in `getSpotifyMetadata()`
3. Update search queue structure in state server if needed
4. Test with both MP3 and FLAC files

## Important Configuration Files

**`spotify-credentials.json`** - Spotify API credentials (git-ignored)
- Template: `spotify-credentials.json.template`
- Format: `{"clientId": "...", "clientSecret": "..."}`

**`nicotine-queue.json`** - Search queue managed by state server
- Format: Array of search objects
- Processed searches marked via `POST /mark-processed`

**`debug-settings.json`** - Controls terminal window visibility
- `{"debugWindows": false}` - Minimized server windows
- `{"debugWindows": true}` - Visible console windows for debugging

## Testing Scenarios

### Test Single Track Download
1. Load extension in chrome://extensions/
2. Go to open.spotify.com, find a track
3. Click Hydra+ button next to track
4. Check extension popup console for events
5. Verify progress bar appears and updates
6. Check download folder for tagged file

### Test Album Download
1. Go to Spotify album page
2. Click "Send Album" button
3. Watch progress bars for all tracks
4. Verify all tracks downloaded to album folder
5. Check metadata tags on all tracks
6. Verify track numbering is correct

### Test Fallback System
1. Search for obscure track (few results)
2. Monitor extension console
3. If first download fails, should try next candidate automatically
4. Check event log for fallback messages

### Test Metadata Worker Crash Recovery
1. Kill metadata worker: `taskkill /F /IM node.exe /FI "WINDOWTITLE eq *metadata*"`
2. State server should continue working
3. Extension popup should still show events/progress
4. Downloads continue but metadata processing fails gracefully

## Troubleshooting Guide

**Servers won't start:**
- Check Node.js installed: `node --version`
- Check ports 3847/3848 not in use: `netstat -ano | findstr :3847`
- Kill existing node processes: `taskkill /F /IM node.exe`

**Extension buttons not appearing:**
- Check extension loaded at chrome://extensions/
- Refresh Spotify page
- Check browser console for errors

**Downloads not starting:**
- Verify Nicotine+ plugin enabled
- Check plugin is online (connected to Soulseek)
- Check state server running: `curl http://127.0.0.1:3847/ping`

**Metadata not applied:**
- Check metadata worker running: `curl http://127.0.0.1:3848/ping`
- Verify Spotify credentials configured (for genre/label)
- Check file format is supported (MP3 or FLAC)

**Progress bars stuck:**
- Check Python plugin is sending progress updates
- Verify extension popup is polling `/status`
- Clear stuck progress: Button in extension popup
