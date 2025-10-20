# Hydra+ Dual Server Architecture

## Overview

Hydra+ now uses a **dual server architecture** to improve stability and reliability:

- **State Server** (Port 3847) - Lightweight, never crashes
- **Metadata Worker** (Port 3848) - Heavy processing, can crash safely

This separation ensures that **progress tracking and event logging** continue to work even if metadata processing crashes.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Nicotine+ Python Plugin                  │
│                                                              │
│  ┌──────────────────┐              ┌─────────────────┐     │
│  │ Progress Tracking├──────────────►│ State Server    │     │
│  │ Event Logging    │              │ (Port 3847)     │     │
│  └──────────────────┘              └─────────────────┘     │
│                                                              │
│  ┌──────────────────┐              ┌─────────────────┐     │
│  │ Metadata         ├──────────────►│ Metadata Worker │     │
│  │ Processing       │              │ (Port 3848)     │     │
│  └──────────────────┘              └─────────────────┘     │
└─────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
                                    ┌───────────────────┐
                                    │ Chrome Extension  │
                                    │ (Polls Port 3847) │
                                    └───────────────────┘
```

---

## State Server (Port 3847)

**Purpose**: Manage application state that must always be available

**Responsibilities**:
- ✅ Download progress tracking (`activeDownloads` Map)
- ✅ Event log management (`events` Array)
- ✅ Queue file operations (read/write `nicotine-queue.json`)
- ✅ Spotify credentials storage
- ✅ Rename pattern configuration
- ✅ Search queue management

**Endpoints**:
```
GET  /ping                      # Health check
GET  /status                    # Return events + activeDownloads (polled by extension)
POST /progress                  # Update download progress (fire-and-forget)
POST /remove-progress           # Remove completed download
POST /clear-progress            # Clear all progress bars
POST /event                     # Add console event (fire-and-forget)
GET  /pending                   # Get unprocessed searches
POST /mark-processed            # Mark searches as processed
POST /set-spotify-credentials   # Store Spotify credentials
POST /test-spotify-credentials  # Test Spotify API connection
POST /set-rename-pattern        # Set file rename pattern
POST /search                    # Queue search request
POST /search-album              # Queue album search request
```

**Characteristics**:
- Lightweight operations only
- No heavy I/O or API calls
- Never crashes
- Always responds quickly (< 50ms)

---

## Metadata Worker (Port 3848)

**Purpose**: Handle heavy processing that can fail or timeout

**Responsibilities**:
- ✅ Fetch Spotify page metadata (year, image URL)
- ✅ Fetch Spotify API metadata (genre, label)
- ✅ Download cover art from URLs
- ✅ Write ID3 tags to MP3 files (using ffmpeg)
- ✅ Write FLAC tags (using metaflac)
- ✅ Rename files according to pattern
- ✅ Organize album tracks into folders

**Endpoints**:
```
GET  /ping                      # Health check
POST /process-metadata          # Process single track metadata (heavy)
POST /ensure-album-folder       # Create album folder
POST /organize-album            # Move tracks into album folder
POST /restart                   # Kill worker (can restart independently)
```

**Characteristics**:
- Heavy operations (can take 5-30 seconds)
- External dependencies (Spotify API, ffmpeg, metaflac)
- Can crash or timeout
- If it crashes, state server continues working
- Can be restarted independently

---

## Startup

### Automatic (from Nicotine+)

The Python plugin automatically starts both servers:

```python
# Starts both servers when Nicotine+ starts
self.server_process = subprocess.Popen(['node', 'state-server.js'])
self.metadata_process = subprocess.Popen(['node', 'metadata-worker.js'])
```

### Manual (for testing)

**Background Mode** (minimized windows):
```bash
cd Hydra+_Plugin/Server
start-dual-servers.bat
```

**Debug Mode** (separate console windows):
```bash
cd Hydra+_Plugin/Server
start-dual-servers-debug.bat
```

**Individual Servers**:
```bash
# State Server only
node state-server.js

# Metadata Worker only
node metadata-worker.js
```

---

## Benefits

### 1. **Stability**
- Progress bars never disappear due to metadata crashes
- Event log always available
- Queue operations never fail

### 2. **Resilience**
- Metadata worker can crash and restart without affecting state
- State server is lightweight and never crashes
- Extension continues to work even if metadata worker is down

### 3. **Debugging**
- Easy to identify which component is failing
- Can restart metadata worker independently
- Separate logs for each server

### 4. **Performance**
- State server responds instantly (< 50ms)
- Metadata worker doesn't block state operations
- Progress updates never timeout

---

## Migration from Old Bridge Server

### Old Architecture (bridge-server.js)
- Single server on Port 3847
- Mixed responsibilities (state + metadata)
- Crashes during metadata processing
- Takes down progress tracking when it crashes

### New Architecture
- State server on Port 3847 (same port!)
- Metadata worker on Port 3848 (new)
- Separated concerns
- State server never crashes
- Metadata worker can fail safely

### Compatibility
- Chrome extension unchanged (still polls Port 3847)
- Python plugin updated to route requests correctly
- No changes needed to existing queue files

---

## Testing

### Test State Server
```bash
# Health check
curl http://127.0.0.1:3847/ping

# Status (events + progress)
curl http://127.0.0.1:3847/status

# Add event
curl -X POST http://127.0.0.1:3847/event \
  -H "Content-Type: application/json" \
  -d '{"type":"info","message":"Test event"}'

# Update progress
curl -X POST http://127.0.0.1:3847/progress \
  -H "Content-Type: application/json" \
  -d '{"trackId":"test123","filename":"test.mp3","progress":50,"bytesDownloaded":1000000,"totalBytes":2000000}'
```

### Test Metadata Worker
```bash
# Health check
curl http://127.0.0.1:3848/ping

# Process metadata (requires valid file path)
curl -X POST http://127.0.0.1:3848/process-metadata \
  -H "Content-Type: application/json" \
  -d '{"filePath":"C:/path/to/file.mp3","artist":"Artist","track":"Track"}'
```

---

## Troubleshooting

### State Server Won't Start
1. Check if port 3847 is already in use:
   ```bash
   netstat -ano | findstr :3847
   ```
2. Kill any existing node processes:
   ```bash
   taskkill /F /IM node.exe
   ```
3. Check logs in Nicotine+ plugin console

### Metadata Worker Won't Start
1. Check if port 3848 is already in use:
   ```bash
   netstat -ano | findstr :3848
   ```
2. Verify ffmpeg and metaflac are installed
3. Check Spotify credentials are configured

### Progress Bars Not Updating
1. Verify state server is running:
   ```bash
   curl http://127.0.0.1:3847/ping
   ```
2. Check browser console for polling errors
3. Verify Python plugin is sending progress updates

### Metadata Processing Fails
1. Check metadata worker is running:
   ```bash
   curl http://127.0.0.1:3848/ping
   ```
2. Verify Spotify credentials:
   ```bash
   curl -X POST http://127.0.0.1:3848/test-spotify-credentials
   ```
3. Check metadata worker can be restarted independently

---

## File Structure

```
Hydra+_Plugin/
└── Server/
    ├── state-server.js                   # NEW: Lightweight state management
    ├── metadata-worker.js                # NEW: Heavy metadata processing
    ├── bridge-server.js                  # LEGACY: Will be deprecated
    ├── start-dual-servers.bat            # NEW: Start both servers (background)
    ├── start-dual-servers-debug.bat      # NEW: Start both servers (debug)
    ├── start-bridge-debug.bat            # LEGACY: Start old bridge server
    ├── nicotine-queue.json               # Queue file (managed by state server)
    ├── spotify-credentials.json          # Credentials (shared by both servers)
    └── DUAL-SERVER-ARCHITECTURE.md       # This file
```

---

## Future Improvements

1. **Health Monitoring**: State server monitors metadata worker health
2. **Auto-Restart**: State server restarts metadata worker if it crashes
3. **Load Balancing**: Multiple metadata workers for parallel processing
4. **Metrics**: Track crash frequency and processing times
5. **Web UI**: Dashboard showing server status and metrics

---

## Version History

- **v0.1.8** (2025-01-XX) - Dual server architecture implemented
- **v0.1.7** (2025-01-XX) - Fire-and-forget event system
- **v0.1.6** (2025-01-XX) - Single bridge server architecture
