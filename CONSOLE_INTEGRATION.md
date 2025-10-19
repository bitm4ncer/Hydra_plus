# Console Integration Guide

## Overview

The Hydra+ extension popup now includes an **Activity Log** console that displays major events from the bridge server in real-time. This provides users with visibility into download operations, metadata processing, and server status changes.

## Features

- **Real-time event display** with color-coded event types
- **Persistent storage** - events are saved across popup sessions
- **Collapsible interface** - toggle show/hide to save space
- **Auto-scroll** to latest events
- **Circular buffer** - maintains last 50 events
- **Event filtering** - prevents duplicate event display using event IDs

## Event Types

The console supports four event types, each with distinct styling:

| Type | Color | Use Case |
|------|-------|----------|
| `success` | Green (#B9FF37) | Successful operations (downloads complete, connections established) |
| `error` | Red (#e22134) | Failed operations, connection errors |
| `warning` | Orange (#ffa500) | Non-critical issues, timeouts |
| `info` | Blue (#6a9fb5) | General information, status updates |

## Bridge Server Integration

### Current Status Endpoint

The extension polls `http://127.0.0.1:3847/status` every 3 seconds.

### Enhanced Status Response Format

To support the console, the `/status` endpoint should return events in this format:

```json
{
  "unprocessed": 5,
  "events": [
    {
      "id": 123,
      "type": "success",
      "message": "Download finished: Artist - Track Name",
      "timestamp": "2025-01-15T10:30:45.000Z"
    },
    {
      "id": 124,
      "type": "info",
      "message": "Track queued: Another Artist - Another Track",
      "timestamp": "2025-01-15T10:30:50.000Z"
    }
  ]
}
```

### Event Object Schema

```typescript
interface ConsoleEvent {
  id: number;           // Unique, incrementing event ID
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;      // Human-readable event description
  timestamp: string;    // ISO 8601 timestamp (optional, defaults to current time)
}
```

### Event ID Management

- Each event must have a **unique, incrementing ID**
- The extension tracks `lastEventId` to avoid displaying duplicate events
- Events with `id <= lastEventId` are filtered out
- When the extension restarts, it loads `lastEventId` from storage to maintain continuity

### Recommended Events to Track

Here are suggested events for the bridge server to emit:

#### Download Events
- `Track queued: {artist} - {track}`
- `Download started: {artist} - {track}`
- `Download finished: {artist} - {track}`
- `Download failed: {artist} - {track} - {reason}`
- `Album download started: {album_name} ({track_count} tracks)`
- `Album download complete: {album_name}`

#### Metadata Events
- `Metadata applied: {artist} - {track}`
- `Metadata fetch failed: {track} - using fallback`
- `Spotify API rate limit - retrying in {seconds}s`

#### Server Events
- `Bridge server started`
- `Bridge server shutting down`
- `Nicotine+ connection established`
- `Nicotine+ connection lost`

#### Error Events
- `Server crashed - auto-restarting`
- `Track retry: {artist} - {track} (attempt {n})`
- `File already exists: {filename} - renamed`

## Frontend Implementation Details

### Event Storage

Events are stored in two locations:
1. **In-memory array** (`consoleEvents`) - for current session
2. **Chrome storage local** - for persistence across sessions

```javascript
chrome.storage.local.set({
  consoleEvents: consoleEvents,
  lastEventId: lastEventId
});
```

### Adding Events

The `addConsoleEvent()` function handles:
- Timestamp formatting (HH:MM:SS)
- DOM element creation
- Circular buffer management (max 50 events)
- Auto-scroll to latest
- Storage persistence

```javascript
addConsoleEvent('success', 'Download finished: Artist - Track Name');
```

### Toggle Visibility

Users can show/hide the console using the toggle button. The state is saved in `chrome.storage.local`:

```javascript
chrome.storage.local.get(['consoleCollapsed'], (data) => {
  if (data.consoleCollapsed) {
    consoleContainer.classList.add('collapsed');
  }
});
```

## Testing Without Server Implementation

For testing purposes, the console includes a demo mode that initializes with a placeholder message. The extension also logs local events like:
- Server connection/disconnection
- Spotify API credential changes
- Server restart operations

To test with simulated events, you can manually call:

```javascript
addConsoleEvent('success', 'Test success message');
addConsoleEvent('error', 'Test error message');
addConsoleEvent('warning', 'Test warning message');
addConsoleEvent('info', 'Test info message');
```

## Styling

The console uses a dark theme consistent with the extension's design:
- Background: `#1a1a1a`
- Border: `#121212` with inset shadow
- Text: Monospace font (Courier New) at 10px
- Custom scrollbar styling
- 180px max height with overflow scroll

## Future Enhancements

Potential improvements:
1. **Event filtering** - Allow users to filter by event type
2. **Clear button** - Clear all console events
3. **Export logs** - Download console events as JSON/CSV
4. **Event notifications** - Browser notifications for critical events
5. **Search functionality** - Search through console history
6. **Event badges** - Show unread event count on extension icon

## Example Server Implementation

Here's a pseudocode example for the bridge server:

```python
# Event tracking
event_id_counter = 0
recent_events = []  # Keep last 100 events
MAX_EVENTS = 100

def add_event(event_type, message):
    global event_id_counter
    event_id_counter += 1

    event = {
        'id': event_id_counter,
        'type': event_type,
        'message': message,
        'timestamp': datetime.now().isoformat()
    }

    recent_events.append(event)

    # Keep only last MAX_EVENTS
    if len(recent_events) > MAX_EVENTS:
        recent_events.pop(0)

# Status endpoint
@app.route('/status', methods=['GET'])
def status():
    return jsonify({
        'unprocessed': get_queue_count(),
        'events': recent_events[-50:]  # Return last 50 events
    })

# Usage examples
add_event('info', 'Track queued: Artist - Track')
add_event('success', 'Download finished: Artist - Track')
add_event('error', 'Download failed: Artist - Track - No sources found')
```

## Conclusion

The console provides valuable real-time feedback to users about download operations and system status. The implementation is lightweight, persistent, and ready to integrate with the bridge server's event system.
