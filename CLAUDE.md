# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## ⚠️ CRITICAL: LIVE PLUGIN LOCATION ⚠️

**ALL CHANGES TO THE PLUGIN MUST BE MADE IN THE LIVE INSTANCE:**

```
C:\Users\USER\AppData\Roaming\nicotine\plugins\Hydra+_0.1.0_Plugin\
```

**DO NOT** edit files in the repository folder `c:\GitHub\Hydra_plus\` when making plugin changes!

**The live plugin location contains:**
- `__init__.py` - Main plugin logic (EDIT THIS FILE DIRECTLY)
- `Server\bridge-server.js` - Bridge server + metadata processor (EDIT THIS FILE DIRECTLY)
- `Server\package.json` - Node dependencies
- `Server\nicotine-queue.json` - Queue file (auto-generated)

**When making changes:**
1. Edit files directly in `C:\Users\USER\AppData\Roaming\nicotine\plugins\Hydra+_0.1.0_Plugin\`
2. Restart Nicotine+ to reload the plugin
3. Check Nicotine+ console for error messages
4. Test functionality immediately

---

## Project Overview

Nicotine+ Browser Link is a browser extension that sends tracks from Spotify Web Player to Nicotine+ (Soulseek client) for automatic searching and downloading with professional metadata management. The system consists of three components:

1. **Browser Extension** - Adds copy and send buttons to Spotify Web Player tracks with settings popup
2. **Bridge Server** - Node.js HTTP server that queues searches and processes MP3 metadata
3. **Nicotine+ Plugin** - Python plugin that polls the bridge and triggers searches with auto-download

## Architecture & Data Flow

```
Browser Extension (content.js + popup.js)
  ↓ HTTP POST to http://127.0.0.1:3847/search
  ↓ Settings: auto_download, metadata_override, spotify credentials
Bridge Server (bridge-server.js)
  ↓ Writes to nicotine-queue.json
  ↓ Stores Spotify API credentials (optional)
Nicotine+ Plugin (__init__.py)
  ↓ Polls /pending, reads queue
  ↓ Triggers search with do_search()
Nicotine+ Search & Download
  ↓ Event-driven auto-download with fallback
Download Complete
  ↓ Sends file to bridge for metadata processing
Bridge Server Metadata Processor
  ↓ Scrapes Spotify page for year/track#
  ↓ Uses Spotify API for genre/label (if credentials provided)
  ↓ Downloads cover art, writes ID3 tags with node-id3
  ↓ Renames file to "Artist - Track.mp3"
Clean MP3 Ready!
```

**Key Communication Points:**
- Extension → Bridge: `POST /search` with `{query, artist, track, album, track_id, duration, auto_download, metadata_override}`
- Extension → Bridge: `POST /set-spotify-credentials` with `{clientId, clientSecret}`
- Extension → Bridge: `POST /test-spotify-credentials` (validates API connection)
- Plugin → Bridge: `GET /pending` to retrieve unprocessed searches
- Plugin → Bridge: `POST /mark-processed` with `{timestamp}` after triggering search
- Plugin → Bridge: `POST /process-metadata` with `{file_path, artist, track, album, track_id}` after download

## File Locations

**Browser Extension (this repository):**
- [content.js](content.js) - Main content script, DOM manipulation, track extraction
- [popup.js](popup.js) - Extension popup for settings (auto-download, metadata override, Spotify API)
- [popup.html](popup.html) - Extension popup UI with toggles and credential inputs
- [styles.css](styles.css) - Button styling for Spotify integration
- [manifest.json](manifest.json) - Chrome extension manifest (v3)

**⚠️ Nicotine+ Plugin (LIVE LOCATION - EDIT THESE FILES DIRECTLY):**
- `C:\Users\USER\AppData\Roaming\nicotine\plugins\Hydra+_0.1.0_Plugin\__init__.py` - Main plugin logic
- `C:\Users\USER\AppData\Roaming\nicotine\plugins\Hydra+_0.1.0_Plugin\Server\bridge-server.js` - Bridge server + metadata processor
- `C:\Users\USER\AppData\Roaming\nicotine\plugins\Hydra+_0.1.0_Plugin\Server\package.json` - Node dependencies (node-id3)
- `C:\Users\USER\AppData\Roaming\nicotine\plugins\Hydra+_0.1.0_Plugin\Server\nicotine-queue.json` - Queue file

## Development Commands

**Install Dependencies:**
```bash
cd "C:\Users\USER\AppData\Roaming\nicotine\plugins\Hydra+_0.1.0_Plugin\Server"
npm install
```

**Start Bridge Server:**
```bash
node "C:\Users\USER\AppData\Roaming\nicotine\plugins\Hydra+_0.1.0_Plugin\Server\bridge-server.js"
```

**Check Bridge Status:**
```bash
curl http://localhost:3847/status
```

**Test Search Submission:**
```bash
curl -X POST http://localhost:3847/search -H "Content-Type: application/json" -d "{\"query\": \"Artist - Track\", \"artist\": \"Artist\", \"track\": \"Track\", \"album\": \"Album\", \"track_id\": \"spotify_id\", \"duration\": 180, \"auto_download\": true, \"metadata_override\": true}"
```

**Test Spotify API Credentials:**
```bash
curl -X POST http://localhost:3847/test-spotify-credentials -H "Content-Type: application/json" -d "{\"clientId\": \"YOUR_CLIENT_ID\", \"clientSecret\": \"YOUR_CLIENT_SECRET\"}"
```

**Reload Extension (Chrome/Edge):**
Navigate to `chrome://extensions/` or `edge://extensions/`, find the extension, and click the reload icon.

## Key Implementation Details

### Track Information Extraction (content.js)

The `getTrackInfo()` function extracts:
- **Track Name**: From `[data-testid="tracklist-row"] a[href*="/track/"]`
- **Artist Name**: From `[data-testid="tracklist-row"] a[href*="/artist/"]`
- **Album Name**: From `[data-testid="tracklist-row"] a[href*="/album/"]` (when available)
- **Track ID**: Extracted from track URL via regex `/\/track\/([a-zA-Z0-9]+)/`
- **Duration**: From the last column matching `/^\d+:\d+$/` pattern (mm:ss format), parsed to seconds

All data is sent to bridge server and tracked through the download lifecycle for metadata processing.

### Extension Popup Settings (popup.js + popup.html)

**UI Structure:**
1. **Server Status** - Green/red indicator showing bridge server connection
2. **Auto-Download Toggle** - Enable/disable automatic downloads
3. **Metadata Override Toggle** - Enable/disable metadata replacement
4. **Spotify API Credentials** (conditional) - Only visible when Metadata Override is ON

**States:**
- **Input State**: Shows Client ID and Secret fields with "Save & Test Connection" button
- **Connected State**: Shows "🟢 Spotify API Connected" with "Edit credentials" link to return to input state

**Connection Test:**
- When "Save & Test Connection" clicked → `POST /test-spotify-credentials`
- Server attempts OAuth2 token fetch
- If successful → switches to Connected State
- If failed → shows error, remains in Input State

**Auto-Save:**
- Credential fields auto-save 500ms after user stops typing
- Settings persist across popup opens/closes
- Credentials automatically sent to bridge server on popup open

### Button Injection System (content.js)

Buttons are injected into track rows using:
1. `MutationObserver` watches for new track rows (`[data-testid="tracklist-row"]`)
2. `processTrackRow()` finds the "more options" button (`[data-testid="more-button"]`)
3. Copy and Nicotine+ buttons are inserted before the menu button
4. `WeakSet` prevents duplicate processing

### Auto-Download System (Event-Driven with Intelligent Fallback)

**Architecture Overview:**
1. Plugin subscribes to `"file-search-response"` event when loaded
2. Search results arrive asynchronously from peers via event callbacks
3. Each result is scored and top 5 candidates are tracked in real-time
4. After 15-30s, best match is downloaded
5. Download monitoring detects failures/stalls and triggers automatic fallback
6. Up to 5 retry attempts with different candidates
7. 60-second timeout per attempt - detects stuck downloads

**Event Handler:** `_on_file_search_response(msg)`
- Receives: `msg.token`, `msg.username`, `msg.list` (file results)
- Extracts: `file_name`, `file_size`, `file_attrs` from each result (structure: `[code, name, size, ext, attrs]`)
- Scores each file and maintains sorted list of top 5 candidates
- Real-time updates as better matches arrive
- Only logs when new best match found (score >100) to reduce log spam

**Scoring Algorithm:** `_calculate_file_score(file_name, file_size, file_attrs, target_duration, query)`
Uses actual file attributes from Soulseek network (not just filename parsing):
- **Bitrate** from `attrs[0]` (max 100 pts): 320kbps=100, 256kbps=80, 192kbps=60, 128kbps=40
- **Duration Match** from `attrs[1]` (max 100 pts): ±2sec=100, ±5sec=80, ±10sec=50, ±20sec=25
- **File Size** (max 50 pts): >8MB=50, >5MB=40, >3MB=30, >1MB=20
- **Filename Match** (max 50 pts): Exact match=50, word matching=proportional
- **File Type** (10 pts): .mp3 files get bonus

**Download Flow:**
1. **Initial Download** (`_try_download_candidate`):
   - After 15s if score >100, or 30s if score >50
   - Queues download with `core.downloads.enqueue_download(username, virtual_path, size, file_attributes)`
   - Sets `current_attempt=0`, `download_started_at=now()`
   - Tracks in `active_downloads` dict for monitoring
   - Logs: `[Auto-Download] ⬇ Starting download: file.mp3 (score: 245)`

2. **Download Monitoring** (`_monitor_downloads`, runs every 2s):
   - Checks downloads active >60s
   - Iterates `core.downloads.transfers.values()` to find download by `virtual_path`
   - Checks if bytes transferred (`transfer.current_byte_offset > 0`)
   - Detects failures: download not found, stuck in queue (0 bytes after 60s), or failed status
   - Attempts to abort stuck download with `core.downloads.abort_transfer()`
   - Triggers fallback if stuck/failed
   - Logs: `[Auto-Download] ⚠ Download stuck in queue (not transferring) (after 60s)`

3. **Automatic Fallback** (`_try_next_download_candidate`):
   - Increments `current_attempt`
   - Tries next candidate from ranked list
   - Continues until success or all 5 candidates exhausted
   - 5-minute total timeout per search
   - Clean log output: Only shows important transitions

**Data Structures:**
```python
active_searches[token] = {
    'query': 'Artist Track',
    'duration': 405,
    'artist': 'Pink Floyd',
    'track': 'Comfortably Numb',
    'album': 'The Wall',
    'track_id': '3n3Ppam7vgaVa1ia',
    'auto_download': True,
    'metadata_override': True,  # NEW: Controls metadata processing
    'download_candidates': [  # Sorted by score, top 5
        {'file': 'path', 'user': 'user1', 'score': 310, 'size': 123, 'attrs': {}},
        {'file': 'path', 'user': 'user2', 'score': 305, 'size': 456, 'attrs': {}},
        ...
    ],
    'current_attempt': 0,  # -1=not started, 0+=attempt index
    'download_started_at': 1234567890,
    'last_download_path': 'path',
    'result_count': 31
}

active_downloads['path'] = token  # Map downloads back to searches
```

**Log Cleanup:**
- Only logs best matches with score >100: `[Auto-Download] ★ Best match: file.mp3 [320kbps] (score: 245)`
- Skips "Received 0 results" spam
- Single-line download start: `[Auto-Download] ⬇ Starting download: file.mp3 (score: 245)`
- Concise error messages: `[Auto-Download] ✗ No suitable match found (best score: 35/50)`

### Bridge Server Architecture (bridge-server.js)

**Endpoints:**
- `POST /search` - Add search to queue (from browser extension)
- `GET /pending` - Get unprocessed searches (from plugin)
- `POST /mark-processed` - Mark search as processed (from plugin)
- `POST /set-spotify-credentials` - Store API credentials (from extension)
- `POST /test-spotify-credentials` - Validate credentials with actual API call (from extension)
- `POST /process-metadata` - Process MP3 file after download (from plugin)
- `GET /status` - Health check

**Spotify API Integration:**
- OAuth2 Client Credentials flow
- Automatic token refresh (cached for ~1 hour)
- Fetches track and artist data
- Extracts Genre (from artist) and Label (from album)

**Metadata Processing Pipeline:**
1. **Scrape Spotify page** (`fetchSpotifyMetadata`):
   - Fetches HTML from `https://open.spotify.com/track/{id}`
   - Extracts Year from `<meta name="music:release_date">`
   - Extracts Track Number from `<meta name="music:album:track">`
   - Extracts high-quality image URL from `<meta property="og:image">`

2. **Fetch API metadata** (`fetchSpotifyAPIMetadata`, optional):
   - Only if credentials provided
   - Gets track data from `https://api.spotify.com/v1/tracks/{id}`
   - Gets artist data from `https://api.spotify.com/v1/artists/{id}`
   - Extracts Genre (array) and Label (string)

3. **Rename file** (`renameFile`):
   - Sanitizes artist and track names (removes `< > : " / \ | ? *`)
   - Creates "Artist - Track.mp3" filename
   - Handles duplicates with (1), (2), etc.

4. **Download cover art** (`downloadCoverArt`):
   - Downloads JPEG from high-quality Spotify image URL
   - Returns Buffer

5. **Write ID3 tags** (`node-id3`):
   - Sets: title, artist, album, year, trackNumber
   - Optionally adds: genre, publisher (label)
   - Embeds cover art as APIC frame
   - **Clears junk**: comments, userDefinedText, popularimeter, lyrics
   - Writes to file with `NodeID3.write()`

**Example Log Output:**
```
[Metadata] Fetched from Spotify: Year=2024, Track#=6
[Spotify API] Access token obtained
[Spotify API] Fetched: Genre=deep house, tech house, Label=Columbia Records
[Metadata] Processing: C:\Downloads\file.mp3
[Metadata] Renamed: file.mp3 → Artist - Track.mp3
[Metadata] Downloading cover from: https://i.scdn.co/image/...
[Metadata] Downloaded cover: 29493 bytes
[Metadata] ✓ Tags written successfully
[Metadata]   Artist: Artist Name
[Metadata]   Title: Track Name
[Metadata]   Album: Album Name
[Metadata]   Year: 2024
[Metadata]   Track: #6
[Metadata]   Genre: genre1, genre2
[Metadata]   Label: Record Label
[Metadata]   Cover: embedded
```

### Plugin Metadata Processing Flow (__init__.py)

**Hook:** `download_finished_notification(self, user, virtual_path, real_path)`

**Process:**
1. Check if download tracked: `virtual_path in self.active_downloads`
2. Get search metadata: `token = self.active_downloads[virtual_path]`
3. Verify auto-download enabled: `search_info['auto_download']`
4. **Check metadata override**: `search_info['metadata_override']` (NEW!)
5. If metadata override enabled → send to Node.js server
6. If disabled → skip metadata processing, keep original file/tags
7. Clean up tracking: Remove from `active_downloads` and `active_searches`

**Metadata Override Flag:**
- Controlled by extension popup toggle
- Sent with each search request
- Stored in `active_searches[token]['metadata_override']`
- If `False`: Download works normally but no metadata changes
- If `True`: Full metadata processing pipeline executes

**HTTP Request to Bridge:**
```python
payload = {
    'file_path': real_path,
    'artist': search_info.get('artist', ''),
    'track': search_info.get('track', ''),
    'album': search_info.get('album', ''),
    'track_id': search_info.get('track_id', '')
}

url = f"{self.settings['bridge_url']}/process-metadata"
req = Request(url, data=json.dumps(payload).encode('utf-8'),
             headers={'Content-Type': 'application/json'})
response = urlopen(req, timeout=30)
```

## Configuration

**Port Number (3847):**
- [content.js:2](content.js#L2) - `BRIDGE_URL`
- [popup.js:2](popup.js#L2) - `BRIDGE_URL`
- [manifest.json:24-26](manifest.json#L24) - `host_permissions`
- `bridge-server.js:19` - `PORT`
- `__init__.py` - `bridge_url` setting

**Plugin Settings (Nicotine+):**
- `bridge_url` - Default: `http://127.0.0.1:3847`
- `poll_interval` - Default: 2 seconds
- `auto_start_server` - Default: true (attempts to start bridge if not running)

**Extension Settings (Browser):**
- `autoDownload` - Stored in `chrome.storage.sync`
- `metadataOverride` - Stored in `chrome.storage.sync`, default: true
- `spotifyClientId` - Stored in `chrome.storage.sync`, auto-saved
- `spotifyClientSecret` - Stored in `chrome.storage.sync`, auto-saved
- `spotifyApiConnected` - Stored in `chrome.storage.sync`, tracks connection state

## Common Issues & Debugging

**Buttons not appearing:**
- Check Spotify DOM structure hasn't changed (look for `[data-testid="tracklist-row"]`)
- Verify content script loads (`chrome://extensions/` → inspect views)
- Check browser console for errors (F12)

**Bridge connection failed (red button):**
- Verify bridge server is running: `curl http://localhost:3847/status`
- Check firewall/port blocking
- Review `manifest.json` host_permissions

**Plugin not triggering searches:**
- Check Nicotine+ console for `[Browser Link]` log messages
- Verify plugin is enabled in Settings → Plugins
- Ensure Node.js is installed (required for auto-start)
- Check bridge server accessibility from plugin

**Auto-download not working:**
- Enable toggle in extension popup
- Check Nicotine+ console for `[Auto-Download]` messages
- Look for "★ Best match" logs (only appears for score >100)
- Verify download triggers: Score >100 after 15s OR >50 after 30s
- Common issues:
  - File attributes may be in different format - check `file_data[4]` structure
  - Duration from Spotify must match file duration (±2-20 seconds tolerance)
  - No results = no peers sharing the track
  - Transfer iteration error: Must use `transfers.values()` not nested loop
  - Event import: Use `from pynicotine.events import events`, not `self.core.events`

**Download stuck/failing but not falling back:**
- Check monitoring is running every 2 seconds
- Verify 60s timeout working: Should show "⚠ Download stuck in queue"
- Check candidate list: Must have multiple candidates (top 5) for fallback
- Review fallback logs for attempt numbers
- Common issues:
  - `current_attempt` not being incremented properly
  - Download path mismatch between tracking and actual download
  - Transfer status string comparison (use `str(status)` for comparison)

**Metadata not being applied:**
- Check "Metadata Override" toggle in extension popup (must be ON)
- Verify bridge server is running (metadata processing runs on Node.js)
- Check Nicotine+ console for `[Metadata]` messages
- Ensure file is .mp3 format (other formats not supported)
- Check bridge server terminal for metadata processing logs

**Spotify API not connecting:**
- Click "Save & Test Connection" in extension popup
- Verify credentials are correct (Client ID and Secret)
- Try creating a new app in Spotify Developer Dashboard
- Check bridge server is running
- Look for "[Spotify API] Access token obtained" in server logs
- Common issues:
  - Wrong credentials (copy-paste errors)
  - Client Secret visible vs hidden field mismatch
  - App not activated in Spotify Dashboard

**Genre/Label not appearing:**
- Verify Spotify API credentials are entered and connected
- Check popup shows "🟢 Spotify API Connected"
- Look for `[Spotify API] Fetched: Genre=..., Label=...` in server logs
- Note: Some artists have no genre, some albums have no label

**Cover art not embedding:**
- Check internet connection (downloads from Spotify CDN)
- Verify track_id is valid (22 characters, alphanumeric)
- Look for `[Metadata] Downloaded cover: N bytes` in server logs
- Some rare tracks may not have artwork on Spotify

## What Metadata Gets Embedded

**Without Spotify API Credentials:**
- ✅ Artist, Title, Album (from extension extraction)
- ✅ Year (from Spotify page scraping)
- ✅ Track Number (from Spotify page scraping)
- ✅ High-quality Album Artwork (from Spotify CDN)

**With Spotify API Credentials:**
All of the above, PLUS:
- ✅ Genre (from Spotify Web API artist data)
- ✅ Label/Publisher (from Spotify Web API album data)

**What Gets Removed:**
- ❌ Comments (often contain download site URLs)
- ❌ User-defined text frames (junk)
- ❌ Ratings/Popularimeter
- ❌ Unsynchronized lyrics

## Dependencies

**Browser Extension:**
- Chrome/Edge with Manifest V3 support
- Spotify Web Player access

**Bridge Server:**
- Node.js (v14 or higher)
- npm packages:
  - `node-id3` - ID3v2 tag manipulation

**Nicotine+ Plugin:**
- Nicotine+ (Soulseek client)
- Python (bundled with Nicotine+)
- Internet connection (for Spotify metadata/cover art)
- No Python dependencies (uses stdlib only)

## Optional: Spotify API Setup

To enable Genre and Label metadata:

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Log in with Spotify account
3. Click "Create App"
4. Fill in app name and description
5. Copy Client ID and Client Secret
6. Open extension popup
7. Enable "Metadata Override" toggle
8. Paste credentials (auto-saved)
9. Click "Save & Test Connection"
10. If successful → shows "🟢 Spotify API Connected"
