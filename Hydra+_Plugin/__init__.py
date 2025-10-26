"""
Nicotine+ Hydra+ Plugin

Multi-headed Spotify → Soulseek bridge with intelligent auto-download.
Connects to the bridge server to receive track searches from the browser
extension and automatically triggers searches in Nicotine+.

Version: 0.1.9
"""

__version__ = "0.1.9"

from pynicotine.pluginsystem import BasePlugin
from pynicotine.events import events
import json
import time
import subprocess
import os
from threading import Thread
from urllib.request import urlopen, Request
from urllib.error import URLError


class Plugin(BasePlugin):
    """
    Nicotine+ Hydra+ Plugin

    Multi-headed Spotify → Soulseek bridge. Connects to the bridge server
    via HTTP and polls for new searches from the browser extension.
    Features intelligent auto-download with automatic fallback.
    """

    def __init__(self, *args, **kwargs):
        """Initialize the plugin."""
        super().__init__(*args, **kwargs)

        # Plugin settings
        self.settings = {
            'bridge_url': 'http://127.0.0.1:3847',        # State server (progress, events, queue)
            'metadata_url': 'http://127.0.0.1:3848',      # Metadata worker (Spotify, tags, covers)
            'poll_interval': 2,
            'auto_start_server': True,
            # Metadata processing settings (handled by Node.js server)
            'auto_fix_metadata': True,
            'auto_download_covers': True,
        }

        # Settings metadata for UI
        self.metasettings = {
            'bridge_url': {
                'description': 'Bridge server URL',
                'type': 'string'
            },
            'poll_interval': {
                'description': 'Poll interval in seconds',
                'type': 'int'
            },
            'auto_start_server': {
                'description': 'Automatically start bridge server if not running',
                'type': 'bool'
            },
            'auto_fix_metadata': {
                'description': 'Automatically fix MP3 metadata via Node.js server (requires bridge server running)',
                'type': 'bool'
            },
            'auto_download_covers': {
                'description': 'Automatically download and embed album artwork from Spotify via Node.js server',
                'type': 'bool'
            },
        }

        # Runtime state
        self.running = False
        self.thread = None
        self.processed_timestamps = {}  # Track processed searches with timestamps {search_ts: processed_at}
        self.server_process = None  # Track state server process if we started it
        self.metadata_process = None  # Track metadata worker process if we started it
        self.active_searches = {}  # Track searches with metadata and ranked download candidates
        self.active_downloads = {}  # Track {virtual_path: search_token} for fallback
        self.nicotine_online = False  # Track if Nicotine+ is connected to the network
        self.waiting_for_connection = False  # Track if we're waiting for connection
        self.server_was_running = False  # Track if server was previously running
        self.last_cleanup_time = time.time()  # Track last cleanup of old data
        # IMPROVED: Metadata cache with TTL and size limits
        self.metadata_cache = {}  # {(token, track_index): {'data': metadata_dict, 'timestamp': time}}
        self.metadata_cache_max_age = 10 * 60  # 10 minute TTL
        self.metadata_cache_max_size = 1000  # Max 1000 entries
        # IMPROVED: Adaptive polling state
        self.last_activity_time = time.time()
        self.current_poll_interval = 2  # Start with normal interval
        self.poll_mode = 'active'  # 'active', 'idle', or 'sleep'
        # Progress monitoring
        self.progress_thread = None  # Thread for monitoring download progress
        self.progress_running = False  # Flag to control progress monitoring thread
        # Debug mode flag
        self.debug_mode = False  # Set during initialization based on debug-settings.json

        # Get plugin directory and server paths
        self.plugin_dir = os.path.dirname(os.path.abspath(__file__))
        self.server_path = os.path.join(self.plugin_dir, 'Server', 'bridge-server.js')  # Legacy (will be replaced)
        self.state_server_path = os.path.join(self.plugin_dir, 'Server', 'state-server.js')
        self.metadata_worker_path = os.path.join(self.plugin_dir, 'Server', 'metadata-worker.js')

    def debug_log(self, message):
        """Log message only when debug mode is enabled."""
        if self.debug_mode:
            self.log(message)

    def _is_nicotine_online(self):
        """Check if Nicotine+ is connected to the Soulseek server."""
        try:
            # Try multiple methods to detect connection

            # Method 1: Check core.server_conn (most reliable)
            if hasattr(self.core, 'server_conn') and self.core.server_conn:
                return True

            # Method 2: Check if we can access search functionality
            if hasattr(self.core, 'search') and hasattr(self.core.search, 'do_search'):
                # If search object exists, we can assume connection is ready
                return True

            # Method 3: Check core.users login_status
            if hasattr(self.core, 'users') and hasattr(self.core.users, 'login_status'):
                return self.core.users.login_status

            # Fallback: Assume online if we have core.search (plugin framework is ready)
            # The connection check was too strict - if the plugin loaded, Nicotine+ is likely ready
            if hasattr(self.core, 'search'):
                return True

            return False
        except Exception as e:
            # Log error for debugging
            self.log(f" Error checking online status: {e}")
            # Assume online to avoid blocking - better to try and fail than never try
            return True

    def _is_server_running(self):
        """Check if the bridge server is running."""
        try:
            req = Request(f'{self.settings["bridge_url"]}/status')
            with urlopen(req, timeout=2) as response:
                return response.status == 200
        except:
            return False

    def _check_npm_dependencies(self):
        """Check if npm dependencies are installed, and install them if missing."""
        server_dir = os.path.join(self.plugin_dir, 'Server')
        node_modules_dir = os.path.join(server_dir, 'node_modules')
        package_json = os.path.join(server_dir, 'package.json')

        # Check if package.json exists
        if not os.path.exists(package_json):
            self.log("WARNING: package.json not found, skipping dependency check")
            return True

        # Check if node_modules exists and has the required packages
        required_packages = ['node-id3', 'flac-tagger']
        missing_packages = []

        if not os.path.exists(node_modules_dir):
            missing_packages = required_packages
        else:
            for package in required_packages:
                package_dir = os.path.join(node_modules_dir, package)
                if not os.path.exists(package_dir):
                    missing_packages.append(package)

        # If all packages are installed, we're good
        if not missing_packages:
            return True

        # Install missing packages
        self.log(f" Missing npm packages: {', '.join(missing_packages)}")
        self.log("Installing dependencies... (this may take a moment)")

        try:
            startupinfo = None
            if os.name == 'nt':  # Windows
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW

            # Run npm install (use npm.cmd on Windows)
            npm_cmd = 'npm.cmd' if os.name == 'nt' else 'npm'
            result = subprocess.run(
                [npm_cmd, 'install'],
                cwd=server_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                startupinfo=startupinfo,
                timeout=60  # 60 second timeout
            )

            if result.returncode == 0:
                self.log("SUCCESS: Dependencies installed successfully")
                return True
            else:
                stderr_output = result.stderr.decode('utf-8', errors='ignore')
                self.log(f" ERROR: npm install failed: {stderr_output}")
                return False

        except FileNotFoundError:
            self.log("ERROR: npm not found - please install Node.js")
            return False
        except subprocess.TimeoutExpired:
            self.log("ERROR: npm install timed out")
            return False
        except Exception as e:
            self.log(f" ERROR: Error installing dependencies: {e}")
            return False

    def _start_server(self):
        """Start both state server and metadata worker."""
        if not self.settings.get('auto_start_server', True):
            self.log("Auto-start disabled in settings")
            return False

        if not os.path.exists(self.state_server_path):
            self.log(f" State server not found at: {self.state_server_path}")
            return False

        if not os.path.exists(self.metadata_worker_path):
            self.log(f" Metadata worker not found at: {self.metadata_worker_path}")
            return False

        # Check and install dependencies if needed
        if not self._check_npm_dependencies():
            self.log("ERROR: Failed to install npm dependencies")
            return False

        try:
            # Read debug setting from file BEFORE starting servers
            show_console = False
            debug_settings_file = os.path.join(os.path.dirname(self.state_server_path), 'debug-settings.json')

            try:
                if os.path.exists(debug_settings_file):
                    with open(debug_settings_file, 'r') as f:
                        debug_data = json.load(f)
                        show_console = debug_data.get('debugWindows', False)
                        self.debug_mode = show_console  # Store debug mode flag
            except Exception as e:
                # Silent - only log errors if critical
                pass

            # In debug mode, start a combined debug console for both servers
            if show_console and os.name == 'nt':
                debug_console_path = os.path.join(os.path.dirname(self.state_server_path), 'debug-console.bat')

                # Start the debug console which will run both servers
                self.server_process = subprocess.Popen(
                    ['cmd.exe', '/c', 'start', 'cmd.exe', '/k', debug_console_path],
                    creationflags=subprocess.CREATE_NEW_CONSOLE
                )

                # Give it time to start both servers
                time.sleep(2)

                # Store a dummy metadata process reference (both are managed by debug console)
                self.metadata_process = self.server_process

                # Show debug mode banner
                self.log(f"▒▒▒▒▒ DEBUG MODE ENABLED ____ Check debug console for detailed logs")

            else:
                # Normal mode - run servers hidden in background
                state_startupinfo = None
                if os.name == 'nt':
                    state_startupinfo = subprocess.STARTUPINFO()
                    state_startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    state_startupinfo.wShowWindow = 0  # SW_HIDE

                self.server_process = subprocess.Popen(
                    ['node', self.state_server_path],
                    startupinfo=state_startupinfo
                )

                time.sleep(1)

                metadata_startupinfo = None
                if os.name == 'nt':
                    metadata_startupinfo = subprocess.STARTUPINFO()
                    metadata_startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    metadata_startupinfo.wShowWindow = 0  # SW_HIDE

                self.metadata_process = subprocess.Popen(
                    ['node', self.metadata_worker_path],
                    startupinfo=metadata_startupinfo
                )

            return True

        except FileNotFoundError:
            self.log("ERROR: NODE.JS NOT FOUND - Please install Node.js")
            return False
        except Exception as e:
            self.log(f" ERROR: Starting servers failed: {e}")
            return False

    def _cleanup_server_process(self):
        """Kill both state server and metadata worker processes and clean up."""
        try:
            # Terminate state server process
            if self.server_process:
                try:
                    self.log("Terminating state server process...")
                    self.server_process.terminate()
                    self.server_process.wait(timeout=3)
                    self.log("State server terminated")
                except:
                    try:
                        self.server_process.kill()
                        self.log("State server killed (force)")
                    except:
                        pass
                finally:
                    self.server_process = None

            # Terminate metadata worker process
            if self.metadata_process:
                try:
                    self.log("Terminating metadata worker process...")
                    self.metadata_process.terminate()
                    self.metadata_process.wait(timeout=3)
                    self.log("Metadata worker terminated")
                except:
                    try:
                        self.metadata_process.kill()
                        self.log("Metadata worker killed (force)")
                    except:
                        pass
                finally:
                    self.metadata_process = None

            # Also kill any node.js processes running the servers (Windows-specific cleanup)
            if os.name == 'nt':  # Windows
                try:
                    import subprocess
                    # Find and kill any node processes running state-server.js or metadata-worker.js
                    subprocess.run(['taskkill', '/F', '/FI', 'IMAGENAME eq node.exe', '/FI', f'WINDOWTITLE eq *state-server.js*'],
                                   capture_output=True, timeout=5)
                    subprocess.run(['taskkill', '/F', '/FI', 'IMAGENAME eq node.exe', '/FI', f'WINDOWTITLE eq *metadata-worker.js*'],
                                   capture_output=True, timeout=5)
                except:
                    pass
        except Exception as e:
            self.log(f" Cleanup error (non-fatal): {e}")

    def _verify_server_startup(self):
        """Background task to verify server started successfully."""
        max_attempts = 10
        for attempt in range(max_attempts):
            time.sleep(1)
            if self._is_server_running():
                self.log(f"▓▓▓▓▓▓▓▓▓▓▓▓▓▓ SERVER ONLINE ▓▓▓▓▓▓▓▓▓▓▓▓▓▓")
                return

        self.log("▒▒ Server timeout - may still be starting...")
        self.log("░░ Check debug console if issues persist")

    def _check_and_start_server(self):
        """
        Check if server is running and start if needed.
        Runs in background thread to avoid blocking plugin load.
        """
        try:
            if self._is_server_running():
                self.log("▓▓▓▓▓▓▓▓▓▓▓▓▓▓ SERVER ONLINE ▓▓▓▓▓▓▓▓▓▓▓▓▓▓")
            else:
                self.log("░░ SERVER OFFLINE ____ Auto-start attempt...")
                if self._start_server():
                    # Verification happens in background thread
                    pass
                else:
                    self.log("Could not start servers")
                    self.log("Please check Node.js installation")
        except Exception as e:
            self.log(f" Error checking/starting server: {e}")

    def loaded_notification(self):
        """Called when the plugin is loaded and enabled."""
        bridge_url = self.settings['bridge_url']
        poll_interval = self.settings['poll_interval']

        self.pending_endpoint = f'{bridge_url}/pending'
        self.mark_processed_endpoint = f'{bridge_url}/mark-processed'
        self.poll_interval = poll_interval

        # Eye-catching startup banner
        self.log("═══════════════════════════════════════════════════════════")
        self.log("  >> /////////////////////  Hydra+ /////////////////////  <<")
        self.log("═══════════════════════════════════════════════════════════")
        self.log(f"  [SERVER]    → {bridge_url}")
        self.log("═══════════════════════════════════════════════════════════")
        self.log("  Multi-headed beast awakened!")
        self.log("═══════════════════════════════════════════════════════════")
        self.log(f"  v{__version__}")
        self.log("═══════════════════════════════════════════════════════════")
        self.log("░░ HYDRA INITIALIZED")

        # Subscribe to search result events for auto-download
        events.connect("file-search-response", self._on_file_search_response)

        # Start polling thread (it will wait for connection before processing)
        self.running = True
        self.waiting_for_connection = True
        self.thread = Thread(target=self._poll_queue, daemon=True)
        self.thread.start()

        # Start progress monitoring thread
        self.progress_running = True
        self.progress_thread = Thread(target=self._monitor_download_progress, daemon=True)
        self.progress_thread.start()

        # Check if server is running and start if needed (in background to avoid blocking startup)
        server_thread = Thread(target=self._check_and_start_server, daemon=True)
        server_thread.start()

    def unloaded_notification(self):
        """Called when the plugin is disabled or unloaded."""
        self.log("Plugin unloading...")

        # Stop polling thread
        self.running = False
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=5)

        # Stop progress monitoring thread
        self.progress_running = False
        if self.progress_thread and self.progress_thread.is_alive():
            self.progress_thread.join(timeout=5)

        # Stop server if we started it
        if self.server_process:
            try:
                self.log("Stopping servers...")
                self.server_process.terminate()
                self.server_process.wait(timeout=5)
                self.log("Servers stopped")
            except Exception as e:
                self.log(f" Error stopping server: {e}")

        self.log("Plugin unloaded")

    def _get_pending_searches(self):
        """Fetch pending searches from the bridge server."""
        try:
            req = Request(self.pending_endpoint)
            # Increased timeout to 30s since metadata processing can be slow
            with urlopen(req, timeout=30) as response:
                data = json.loads(response.read().decode('utf-8'))
                return data.get('searches', [])
        except URLError as e:
            # Only log error occasionally to avoid spam
            if not hasattr(self, '_last_error_time') or time.time() - self._last_error_time > 60:
                self.log(f" Cannot reach bridge server: {e}")
                self._last_error_time = time.time()
            return []
        except Exception as e:
            # Suppress timeout errors from logging since they're normal during metadata processing
            error_msg = str(e)
            if 'timed out' not in error_msg:
                self.log(f" Error fetching searches: {e}")
            return []

    def _mark_processed(self, timestamp):
        """Mark a search as processed on the bridge server."""
        try:
            data = json.dumps({'timestamp': timestamp}).encode('utf-8')
            req = Request(self.mark_processed_endpoint, data=data, headers={'Content-Type': 'application/json'})

            # Increased timeout to match _get_pending_searches
            with urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode('utf-8'))
                return result.get('success', False)
        except Exception as e:
            # Suppress timeout errors from logging
            error_msg = str(e)
            if 'timed out' not in error_msg:
                self.log(f" Error marking processed: {e}")
            return False

    def _cleanup_old_data(self):
        """IMPROVED: Cleanup old data with more frequent runs and metadata cache cleanup."""
        try:
            current_time = time.time()

            # IMPROVED: Run cleanup every 1 minute instead of 5
            if current_time - self.last_cleanup_time < 60:
                return

            self.last_cleanup_time = current_time

            # IMPROVED: Clean up processed timestamps older than 15 minutes (not 1 hour)
            fifteen_min_ago = current_time - 900
            old_timestamps = [ts for ts, processed_at in self.processed_timestamps.items()
                            if processed_at < fifteen_min_ago]

            for ts in old_timestamps:
                del self.processed_timestamps[ts]

            if old_timestamps:
                self.log(f" Cleaned {len(old_timestamps)} old processed timestamps")

            # Clean up stale active searches (older than 10 minutes)
            ten_minutes_ago = current_time - 600
            stale_searches = [token for token, info in self.active_searches.items()
                            if info.get('timestamp', current_time) < ten_minutes_ago]

            for token in stale_searches:
                del self.active_searches[token]

            if stale_searches:
                self.log(f" Cleaned {len(stale_searches)} stale active searches")

            # IMPROVED: Clean up expired metadata cache entries
            cache_cutoff = current_time - self.metadata_cache_max_age
            expired_cache = [key for key, value in self.metadata_cache.items()
                           if value.get('timestamp', current_time) < cache_cutoff]

            for key in expired_cache:
                del self.metadata_cache[key]

            if expired_cache:
                self.log(f" Cleaned {len(expired_cache)} expired metadata cache entries")

            # IMPROVED: Enforce cache size limit (LRU eviction)
            if len(self.metadata_cache) > self.metadata_cache_max_size:
                # Sort by timestamp and keep newest entries
                sorted_cache = sorted(self.metadata_cache.items(),
                                    key=lambda x: x[1].get('timestamp', 0),
                                    reverse=True)
                # Keep only max_size entries
                self.metadata_cache = dict(sorted_cache[:self.metadata_cache_max_size])
                removed = len(sorted_cache) - self.metadata_cache_max_size
                self.log(f" Evicted {removed} old metadata cache entries (LRU)")

        except Exception as e:
            self.log(f" Error in cleanup: {e}")

    def _trigger_search(self, query, artist='', track='', album='', track_id='', duration=0, auto_download=False, metadata_override=True, search_type='track', format_preference='mp3', image_url=''):
        """
        Trigger a search in Nicotine+.

        Args:
            query: The search query string
            artist: Artist name from Spotify
            track: Track name from Spotify
            album: Album name from Spotify
            track_id: Spotify track ID
            duration: Track duration in seconds
            auto_download: Whether to auto-download the best match
            metadata_override: Whether to override metadata after download
            search_type: 'track' or 'album' - determines search behavior
            format_preference: Preferred audio format ('mp3' or 'flac')
        """
        # Format search started message
        if artist and track:
            track_display = f"{artist} - {track}"
        else:
            track_display = query

        auto_dl_status = "AUTO DOWNLOAD" if auto_download else "Manual"
        format_status = f"Format: {format_preference.upper()}"
        self.log(f"░░░░░ HEAD1 HUNTING ____ Search Started: {track_display} ( {auto_dl_status} {format_status} )")

        # Send event to bridge for popup console
        if artist and track:
            track_id_safe = track_id or f"{artist}{track}".replace(' ', '').replace('-', '')[:20]
            event_msg = f"Searching: {artist} - {track}"
        else:
            track_id_safe = query.replace(' ', '').replace('-', '')[:20]
            event_msg = f"Searching: {query}"
        self._send_event_to_bridge('info', event_msg, track_id_safe)

        try:
            # Use the core.search.do_search method
            # Mode "global" = network-wide search
            search_token = self.core.search.do_search(query, "global")

            # If do_search returns None, try to get the token from the searches dict
            if not search_token and hasattr(self.core.search, 'searches'):
                # Get all search tokens
                available_tokens = list(self.core.search.searches.keys())
                if available_tokens:
                    # Use the most recent search token (last in the list)
                    search_token = available_tokens[-1]

            # Only log if auto-download failed to get token
            if auto_download and not search_token:
                self.log(f" Search '{query}' - auto-download unavailable (no token)")

            # Track this search if auto-download is enabled
            if auto_download and search_token:
                self.active_searches[search_token] = {
                    'type': search_type,  # 'track' or 'album'
                    'query': query,
                    'duration': duration,
                    'auto_download': auto_download,
                    'metadata_override': metadata_override,
                    'format_preference': format_preference,  # 'mp3' or 'flac'
                    # Spotify metadata for post-processing
                    'artist': artist,
                    'track': track,
                    'album': album,
                    'track_id': track_id,
                    'image_url': image_url,
                    'timestamp': time.time(),
                    'download_candidates': [],  # List of {file, user, score, size, attrs}
                    'current_attempt': -1,  # -1 = not started, 0+ = attempt index
                    'download_started_at': None,
                    'last_download_path': None,
                    'last_download_user': None,  # Username of last download attempt (for abort)
                    'result_count': 0
                }
                self.debug_log(f"[DL] Tracking search (token={search_token})")

            return True
        except Exception as e:
            self.log(f"ERROR triggering search!")
            self.log(f" Exception: {type(e).__name__}: {str(e)}")
            import traceback
            self.log(f" Traceback: {traceback.format_exc()}")
            return False

    def _send_event_to_bridge(self, event_type, message, track_id=None):
        """Send an event to the bridge server for popup console display (fire-and-forget).

        Args:
            event_type: Event type ('info', 'success', 'error', 'warning')
            message: Event message
            track_id: Optional track ID for color-coding
        """
        import json
        from urllib.request import Request, urlopen

        bridge_url = self.settings.get('bridge_url', 'http://127.0.0.1:3847')
        url = f"{bridge_url}/event"

        data = {
            'type': event_type,
            'message': message,
            'trackId': track_id
        }

        # FIRE-AND-FORGET: Single attempt with short timeout, don't block on failure
        try:
            req = Request(url,
                         data=json.dumps(data).encode('utf-8'),
                         headers={'Content-Type': 'application/json'},
                         method='POST')

            # Very short timeout since bridge responds instantly
            urlopen(req, timeout=0.3)
            return True

        except Exception:
            # Silently fail - don't spam logs or block processing
            # Bridge might be restarting or offline temporarily
            return False

    def _send_progress_update(self, track_id, filename, progress, bytes_downloaded, total_bytes, artist='', track='', album='', file_path='', image_url=''):
        """Send download progress update to bridge server (fire-and-forget).

        Args:
            track_id: Track ID for color-coding
            filename: Name of file being downloaded
            progress: Progress percentage (0-100)
            bytes_downloaded: Bytes downloaded so far
            total_bytes: Total file size in bytes
            artist: Artist name (for tooltip display)
            track: Track title (for tooltip display)
            album: Album name (for tooltip display)
            file_path: Full path to file (for folder opening)
            image_url: Album artwork URL (for thumbnail display)
        """
        try:
            import json
            from urllib.request import Request, urlopen

            bridge_url = self.settings.get('bridge_url', 'http://127.0.0.1:3847')
            url = f"{bridge_url}/progress"

            data = {
                'trackId': track_id,
                'filename': filename,
                'progress': progress,
                'bytesDownloaded': bytes_downloaded,
                'totalBytes': total_bytes,
                'artist': artist,
                'track': track,
                'album': album,
                'filePath': file_path,
                'imageUrl': image_url
            }

            req = Request(url,
                         data=json.dumps(data).encode('utf-8'),
                         headers={'Content-Type': 'application/json'},
                         method='POST')

            # FIRE-AND-FORGET: Very short timeout since bridge responds instantly
            urlopen(req, timeout=0.3)
        except Exception as e:
            # Log errors for debugging (only log every 10th error to avoid spam)
            if not hasattr(self, '_progress_error_count'):
                self._progress_error_count = 0
            self._progress_error_count += 1
            if self._progress_error_count % 10 == 1:
                self.log(f"[PROGRESS] Bridge connection error: {str(e)[:50]}")

    def _remove_progress_tracking(self, track_id):
        """Remove download from bridge server's progress tracking when download is deleted."""
        try:
            import json
            from urllib.request import Request, urlopen

            bridge_url = self.settings.get('bridge_url', 'http://127.0.0.1:3847')
            url = f"{bridge_url}/remove-progress"

            data = {'trackId': track_id}

            req = Request(url,
                         data=json.dumps(data).encode('utf-8'),
                         headers={'Content-Type': 'application/json'},
                         method='POST')

            # Non-blocking - don't wait for response
            urlopen(req, timeout=0.5)
        except Exception:
            # Silently fail - don't spam logs if bridge is offline
            pass

    def _monitor_download_progress(self):
        """Background thread to monitor active download progress and send updates to bridge."""
        import os

        self.debug_log("[PROGRESS] Progress monitoring thread started")

        # Track which downloads we're monitoring (virtual_path -> track_id)
        monitored_downloads = {}

        while self.progress_running:
            try:
                # Check if we have access to downloads
                if not hasattr(self.core, 'downloads') or not hasattr(self.core.downloads, 'transfers'):
                    time.sleep(2)
                    continue

                # Get all active transfers
                transfers = self.core.downloads.transfers
                current_paths = set()

                # Build set of current paths that are actually being tracked
                for virtual_path, transfer in transfers.items():
                    # Only include if it's in our active tracking and not finished
                    if virtual_path in self.active_downloads:
                        if not (hasattr(transfer, 'status') and transfer.status in ('Finished', 'Paused', 'Filtered')):
                            current_paths.add(virtual_path)

                # Detect removed downloads (were monitored but no longer in current tracked paths)
                removed_paths = set(monitored_downloads.keys()) - current_paths
                for removed_path in removed_paths:
                    track_id = monitored_downloads.pop(removed_path, None)
                    if track_id:
                        # DON'T notify bridge to remove - let completion handler send 100% update
                        # The bridge will auto-cleanup after 60 seconds
                        # self._remove_progress_tracking(track_id)
                        self.debug_log(f"[PROGRESS] Download finished from monitoring: trackId={track_id}")

                # DEBUG: Log monitoring cycle (disabled to reduce spam)
                # if len(transfers) > 0:
                #     active_count = sum(1 for vp in transfers.keys() if vp in self.active_downloads)
                #     self.log(f"[PROGRESS] Monitoring {len(transfers)} transfers ({active_count} tracked)")

                for virtual_path, transfer in transfers.items():
                    try:
                        # Skip if transfer doesn't have required attributes
                        if not hasattr(transfer, 'size') or not hasattr(transfer, 'current_byte_offset'):
                            continue

                        # Skip completed downloads (only monitor active downloads)
                        # Check if transfer has a status attribute and if it's finished
                        if hasattr(transfer, 'status') and transfer.status in ('Finished', 'Paused', 'Filtered'):
                            continue

                        # Skip downloads that are no longer in our active tracking
                        if virtual_path not in self.active_downloads:
                            continue

                        # Get progress data
                        total_bytes = transfer.size
                        bytes_downloaded = transfer.current_byte_offset or 0

                        # Skip if no valid size or progress
                        if total_bytes is None or total_bytes <= 0:
                            continue

                        # Calculate progress percentage
                        progress = min(100, (bytes_downloaded / total_bytes) * 100)

                        # Get filename from virtual path
                        filename = os.path.basename(virtual_path)

                        # Try to find track ID from active_downloads
                        track_id = None
                        search_token = None
                        search_info = None

                        if virtual_path in self.active_downloads:
                            search_token = self.active_downloads[virtual_path]
                            if search_token in self.active_searches:
                                search_info = self.active_searches[search_token]

                                # IMPROVED: For album downloads, use album-level trackId and calculate cumulative progress
                                if search_info.get('type') == 'album' and 'album_track_id' in search_info:
                                    track_id = search_info['album_track_id']

                                    # Calculate cumulative album progress
                                    completed_tracks = search_info.get('completed_track_count', 0)
                                    total_tracks = len(search_info.get('tracks_to_download', []))
                                    total_album_bytes = search_info.get('total_album_bytes', 0)

                                    if total_album_bytes > 0:
                                        # Calculate bytes from completed tracks
                                        completed_bytes = 0
                                        tracks_to_download = search_info.get('tracks_to_download', [])
                                        for i in range(completed_tracks):
                                            if i < len(tracks_to_download):
                                                completed_bytes += tracks_to_download[i].get('file_size', 0)

                                        # Add current track's progress
                                        total_downloaded_bytes = completed_bytes + bytes_downloaded
                                        progress = min(100, (total_downloaded_bytes / total_album_bytes) * 100)

                                        # Use album name as filename for progress bar
                                        filename = search_info.get('album_name', filename)
                                    else:
                                        # Fallback: Use track count if byte size unknown
                                        if total_tracks > 0:
                                            current_track_progress = progress / 100.0  # Normalize to 0-1
                                            progress = ((completed_tracks + current_track_progress) / total_tracks) * 100
                                            filename = search_info.get('album_name', filename)
                                else:
                                    # Single track download - use original logic
                                    track_id = search_info.get('track_id', '') or f"{search_info.get('artist', '')}-{search_info.get('track', '')}".replace(' ', '')[:20]

                        # Fallback: generate track ID from filename
                        if not track_id:
                            track_id = filename.replace(' ', '').replace('-', '')[:20]

                        # Track this download so we can detect when it's removed
                        monitored_downloads[virtual_path] = track_id

                        # Send progress update to bridge
                        # Extract metadata for tooltip and thumbnail display
                        artist = search_info.get('artist', '') if search_info else ''
                        track_name = search_info.get('track', '') if search_info else ''
                        album_name = search_info.get('album', '') if search_info else ''
                        image_url = search_info.get('image_url', '') if search_info else ''

                        # CASCADE MODE: Track HEAD1 start and calculate maximum progress
                        # Mark when HEAD1 starts downloading (progress > 0)
                        if search_info and search_info.get('cascade_mode'):
                            # Check if HEAD1 just started (progress > 0 for first time)
                            if progress > 0 and not search_info.get('cascade_head1_started'):
                                search_info['cascade_head1_started'] = True
                                self.log("[CASCADE] HEAD1 download started (showing progress)")

                            # Find maximum progress among all cascade heads
                            max_progress = progress
                            max_bytes_downloaded = bytes_downloaded
                            max_total_bytes = total_bytes
                            fastest_filename = filename

                            cascade_heads = search_info.get('cascade_heads', [])
                            for cascade_head in cascade_heads:
                                cascade_transfer_key = cascade_head['transfer_key']
                                if cascade_transfer_key in transfers:
                                    cascade_transfer = transfers[cascade_transfer_key]
                                    if hasattr(cascade_transfer, 'size') and hasattr(cascade_transfer, 'current_byte_offset'):
                                        cascade_total = cascade_transfer.size
                                        cascade_downloaded = cascade_transfer.current_byte_offset or 0

                                        if cascade_total and cascade_total > 0:
                                            cascade_progress = min(100, (cascade_downloaded / cascade_total) * 100)

                                            # Use highest progress
                                            if cascade_progress > max_progress:
                                                max_progress = cascade_progress
                                                max_bytes_downloaded = cascade_downloaded
                                                max_total_bytes = cascade_total
                                                fastest_filename = os.path.basename(cascade_head['virtual_path'])

                            # Send only the maximum progress
                            self._send_progress_update(track_id, fastest_filename, max_progress, max_bytes_downloaded, max_total_bytes, artist, track_name, album_name, '', image_url)

                            # Log cascade progress (show all heads for debugging)
                            if int(max_progress) % 10 == 0 or max_progress == 100:
                                heads_count = len(cascade_heads)
                                self.debug_log(f"[CASCADE] Max progress: {int(max_progress)}% ({heads_count} head(s) active)")

                        # RACE MODE: Calculate maximum progress among all racing heads
                        # Only send the highest progress to UI (fastest download wins display)
                        elif search_info and search_info.get('race_mode'):
                            # Find maximum progress among all racing heads
                            max_progress = progress
                            max_bytes_downloaded = bytes_downloaded
                            max_total_bytes = total_bytes
                            fastest_filename = filename

                            race_heads = search_info.get('race_heads', [])
                            for race_head in race_heads:
                                race_transfer_key = race_head['transfer_key']
                                if race_transfer_key in transfers:
                                    race_transfer = transfers[race_transfer_key]
                                    if hasattr(race_transfer, 'size') and hasattr(race_transfer, 'current_byte_offset'):
                                        race_total = race_transfer.size
                                        race_downloaded = race_transfer.current_byte_offset or 0

                                        if race_total and race_total > 0:
                                            race_progress = min(100, (race_downloaded / race_total) * 100)

                                            # Use highest progress
                                            if race_progress > max_progress:
                                                max_progress = race_progress
                                                max_bytes_downloaded = race_downloaded
                                                max_total_bytes = race_total
                                                fastest_filename = os.path.basename(race_head['virtual_path'])

                            # Send only the maximum progress
                            self._send_progress_update(track_id, fastest_filename, max_progress, max_bytes_downloaded, max_total_bytes, artist, track_name, album_name, '', image_url)

                            # Log race progress (show all heads for debugging)
                            if int(max_progress) % 10 == 0 or max_progress == 100:
                                self.debug_log(f"[RACE] Max progress: {int(max_progress)}% (showing fastest of {len(race_heads)} racing downloads)")

                        # For albums, send cumulative bytes instead of current track bytes
                        elif search_info and search_info.get('type') == 'album' and 'album_track_id' in search_info:
                            completed_tracks = search_info.get('completed_track_count', 0)
                            total_album_bytes = search_info.get('total_album_bytes', 0)
                            tracks_to_download = search_info.get('tracks_to_download', [])

                            # Calculate cumulative bytes for display
                            cumulative_bytes = 0
                            for i in range(completed_tracks):
                                if i < len(tracks_to_download):
                                    cumulative_bytes += tracks_to_download[i].get('file_size', 0)
                            cumulative_bytes += bytes_downloaded

                            self._send_progress_update(track_id, filename, progress, cumulative_bytes, total_album_bytes, artist, track_name, album_name, '', image_url)
                        else:
                            # Regular single track progress
                            self._send_progress_update(track_id, filename, progress, bytes_downloaded, total_bytes, artist, track_name, album_name, '', image_url)

                        # Log progress updates (reduced verbosity for albums)
                        if search_info and search_info.get('type') == 'album':
                            # Only log every 10% for albums to reduce spam
                            if int(progress) % 10 == 0 or progress == 100:
                                current_track = search_info.get('current_track_index', 0) + 1
                                total_tracks = len(search_info.get('tracks_to_download', []))
                                self.debug_log(f"[PROGRESS] {filename}: {int(progress)}% (Track {current_track}/{total_tracks})")
                        else:
                            # Log all progress for single tracks
                            self.debug_log(f"[PROGRESS] {filename[:40]}: {int(progress)}% (ID: {track_id})")

                    except Exception as e:
                        # Skip this transfer if there's an error
                        continue

            except Exception as e:
                # Log error but don't crash the thread
                pass

            # Sleep for 1.5 seconds before next update
            time.sleep(1.5)

    def _get_file_format(self, filename):
        """Extract format from file extension."""
        filename_lower = filename.lower()
        if '.' in filename_lower:
            ext = filename_lower.split('.')[-1]
            return ext  # 'mp3', 'flac', 'alac', 'wav', 'm4a', etc.
        return ''

    def _extract_bitrate(self, filename):
        """Extract bitrate from filename (e.g., '320kbps', '256', 'V0')."""
        import re
        filename_lower = filename.lower()

        # Look for explicit bitrate patterns
        bitrate_match = re.search(r'(\d+)\s*k', filename_lower)
        if bitrate_match:
            return int(bitrate_match.group(1))

        # V0/V2 are typically 245/190 kbps average
        if 'v0' in filename_lower:
            return 245
        if 'v2' in filename_lower:
            return 190

        return 0

    def _calculate_file_score(self, file_name, file_size, file_attrs, target_duration, query, format_preference='mp3'):
        """
        Calculate a score for a file based on multiple criteria.
        Higher score = better match.

        Args:
            file_name: Filename string
            file_size: File size in bytes
            file_attrs: Dictionary of file attributes (bitrate, duration, etc.)
            target_duration: Target track duration in seconds
            query: Original search query
            format_preference: Preferred audio format ('mp3' or 'flac')

        Returns:
            Score (higher = better match)
        """
        score = 0
        filename_lower = file_name.lower()

        # Extract bitrate from file attributes (preferred) or filename fallback
        bitrate = 0
        if file_attrs:
            # Bitrate is typically in kbps in the attributes
            bitrate = file_attrs.get(0, 0)  # Attribute 0 is usually bitrate
            if bitrate == 0:
                bitrate = file_attrs.get('bitrate', 0)

        # Fallback to extracting from filename if no attribute bitrate
        if bitrate == 0:
            bitrate = self._extract_bitrate(filename_lower)

        # Score based on bitrate (max 100 points)
        if bitrate >= 320:
            score += 100
        elif bitrate >= 256:
            score += 80
        elif bitrate >= 192:
            score += 60
        elif bitrate >= 128:
            score += 40

        # Extract duration from file attributes (preferred)
        file_duration = 0
        if file_attrs:
            # Duration is typically in seconds in attribute 1
            file_duration = file_attrs.get(1, 0)
            if file_duration == 0:
                file_duration = file_attrs.get('duration', 0)

        # Score based on duration match (max 100 points) - CRITICAL for correct track
        if target_duration > 0 and file_duration > 0:
            duration_diff = abs(file_duration - target_duration)
            if duration_diff <= 2:  # Within 2 seconds - excellent match
                score += 100
            elif duration_diff <= 5:  # Within 5 seconds - good match
                score += 80
            elif duration_diff <= 10:  # Within 10 seconds - ok match
                score += 50
            elif duration_diff <= 20:  # Within 20 seconds - poor match
                score += 25

        # Score based on file size (max 50 points)
        # Typical 3-minute 320kbps MP3 is ~7-8MB
        if file_size > 8000000:  # > 8MB
            score += 50
        elif file_size > 5000000:  # > 5MB
            score += 40
        elif file_size > 3000000:  # > 3MB
            score += 30
        elif file_size > 1000000:  # > 1MB
            score += 20

        # Score based on filename match quality (max 50 points)
        query_lower = query.lower()
        if query_lower in filename_lower:
            score += 50
        else:
            # Calculate similarity (simple word matching)
            query_words = set(query_lower.split())
            filename_words = set(filename_lower.split())
            matches = len(query_words & filename_words)
            if matches > 0:
                score += (matches / len(query_words)) * 50

        # CRITICAL: Format preference scoring with smart fallback
        file_format = self._get_file_format(file_name)

        if format_preference == 'mp3':
            # User prefers MP3 (lossy)
            if file_format == 'mp3':
                score += 200  # Tier 1: Preferred format
            elif file_format in ['flac', 'alac', 'wav']:
                score += 100  # Tier 2: Lossless fallback (better than nothing)
            else:
                score -= 50   # Tier 3: Other formats (not preferred)

        elif format_preference == 'flac':
            # User prefers FLAC (lossless)
            if file_format == 'flac':
                score += 200  # Tier 1: Preferred format
            elif file_format in ['alac', 'wav']:
                score += 180  # Tier 2: Other lossless formats (nearly as good)
            elif file_format == 'mp3':
                score += 100  # Tier 3: MP3 fallback (lossy but acceptable)
            else:
                score -= 50   # Tier 4: Other formats (not preferred)

        # Smart penalty for remixes and alternate versions
        # ONLY apply penalty if the user is NOT searching for these variants
        remix_indicators = [
            'remix', 'mix)', 'rmx', 'edit', 'version', 'feat.', 'ft.', 'featuring',
            'live', 'acoustic', 'instrumental', 'cover', 'karaoke', 'radio edit',
            'extended', 'club', 'dub', 'vip'
        ]

        # Check if user is actually searching for a remix/variant
        query_lower = query.lower()
        user_wants_variant = any(indicator in query_lower for indicator in remix_indicators)

        # Only penalize remix/variant files if user is NOT searching for them
        if not user_wants_variant:
            # Check for remix indicators in filename
            file_has_variant = False
            for indicator in remix_indicators:
                if indicator in filename_lower:
                    score -= 50
                    file_has_variant = True
                    break

            # Additional penalty for parentheses/brackets with extra info (often remixes/features)
            # e.g., "Track Name (Another Artist Remix)" or "Track Name [feat. Someone]"
            if not file_has_variant:  # Don't double-penalize
                import re
                if re.search(r'\([^)]*(?:remix|feat|ft|featuring|edit|version|mix|live|acoustic|instrumental)[^)]*\)', filename_lower):
                    score -= 30
                elif re.search(r'\[[^\]]*(?:remix|feat|ft|featuring|edit|version|mix|live|acoustic|instrumental)[^\]]*\]', filename_lower):
                    score -= 30

        return score

    def _on_file_search_response(self, msg):
        """
        Event handler called when search results arrive from a peer.

        Args:
            msg: Message object with attributes:
                - token: Search token
                - username: User who sent results
                - list: List of files (each with name, size, attrs)
                - privatelist: Private files list
                - freeulslots: Upload slots available
                - inqueue: Download queue size
                - ulspeed: Upload speed
        """
        try:
            token = msg.token
            username = msg.username
            file_list = msg.list if hasattr(msg, 'list') else []

            # Check if this is a search we're tracking for auto-download
            if token not in self.active_searches:
                return

            search_info = self.active_searches[token]

            # Only process if auto-download is enabled for this search
            if not search_info.get('auto_download', False):
                return

            # Skip logging if no results
            if len(file_list) == 0:
                return

            # Check if this is an album search or track search
            search_type = search_info.get('type', 'track')

            if search_type == 'album':
                # Handle album folder search
                self._process_album_search_results(token, search_info, username, file_list, msg)
            else:
                # Handle regular track search
                self._process_track_search_results(token, search_info, username, file_list)

        except Exception as e:
            self.debug_log(f"[DL] Error processing search response: {e}")
            import traceback
            self.debug_log(f"[DL] Traceback: {traceback.format_exc()}")

    def _process_track_search_results(self, token, search_info, username, file_list):
        """Process search results for a single track."""
        # Log when we receive results (first time only)
        if search_info['result_count'] == 0:
            self.debug_log(f"[DL] Receiving results for '{search_info['query']}'")

            # Send event to bridge for popup console
            track_id_safe = search_info.get('track_id', '') or f"{search_info.get('artist', '')}-{search_info.get('track', '')}".replace(' ', '')[:20]
            self._send_event_to_bridge('info', f"Receiving results for: {search_info.get('artist', '')} - {search_info.get('track', '')}", track_id_safe)

        # Process each file in the results
        for file_data in file_list:
            # Extract file information from the result
            # file_data structure: [code, name, size, ext, attrs]
            if len(file_data) < 3:
                continue

            file_name = file_data[1] if len(file_data) > 1 else ""
            file_size = file_data[2] if len(file_data) > 2 else 0
            file_attrs = file_data[4] if len(file_data) > 4 else {}

            # Calculate score for this file
            score = self._calculate_file_score(
                file_name,
                file_size,
                file_attrs,
                search_info['duration'],
                search_info['query'],
                search_info.get('format_preference', 'mp3')
            )

            # Add to candidates list and keep top 5
            candidate = {
                'file': file_name,
                'user': username,
                'score': score,
                'size': file_size,
                'attrs': file_attrs
            }

            candidates = search_info['download_candidates']
            candidates.append(candidate)

            # Sort by score (descending) and keep top 5
            candidates.sort(key=lambda x: x['score'], reverse=True)
            search_info['download_candidates'] = candidates[:5]

            # Log if this is a new top candidate with good score
            if len(candidates) > 0 and candidates[0] == candidate and score > 100:
                bitrate_info = ""
                if file_attrs:
                    bitrate = file_attrs.get(0, file_attrs.get('bitrate', 0))
                    if bitrate:
                        bitrate_info = f" [{bitrate}kbps]"

                # Add format information
                file_format = self._get_file_format(file_name).upper()
                format_pref = search_info.get('format_preference', 'mp3').upper()
                format_info = f" {file_format}"

                # Add indicator if using fallback format
                if file_format.lower() != search_info.get('format_preference', 'mp3').lower():
                    format_info += " (fallback)"

                # Determine HEAD number based on current candidate position
                head_num = len(candidates)
                self.log(f"░░░░░▒▒▒ HEAD{head_num} SPOTTED ____ Score {int(score)} → {file_name}{bitrate_info}{format_info}")

                # Send event to bridge for popup console
                track_id_safe = search_info.get('track_id', '') or f"{search_info.get('artist', '')}-{search_info.get('track', '')}".replace(' ', '')[:20]
                self._send_event_to_bridge('info', f"Head spotted: {file_name}{bitrate_info}{format_info} (score: {int(score)})", track_id_safe)

        # Increment result count
        search_info['result_count'] += len(file_list)

    def _process_album_search_results(self, token, search_info, username, file_list, msg=None):
        """Process search results for an album - group by folder and score folders."""
        import os

        # Log when we receive results (first time only)
        if search_info['result_count'] == 0:
            self.log(f"[ALBUM] Hunting for folders...")

        # Debug: Always log that we received results
        self.debug_log(f"[ALBUM] Received {len(file_list)} results from {username}")

        # Extract upload speed from message if available
        upload_speed = 0
        if msg and hasattr(msg, 'ulspeed'):
            upload_speed = msg.ulspeed  # Upload speed in bytes/sec

        # Group files by folder
        folders = {}  # {folder_path: [file_list]}

        for file_data in file_list:
            if len(file_data) < 2:
                continue

            file_path = file_data[1] if len(file_data) > 1 else ""
            if not file_path:
                continue

            # Extract folder path (everything except the filename)
            folder_path = os.path.dirname(file_path).replace('\\', '/')

            if folder_path not in folders:
                folders[folder_path] = []

            folders[folder_path].append({
                'path': file_path,
                'size': file_data[2] if len(file_data) > 2 else 0,
                'attrs': file_data[4] if len(file_data) > 4 else {}
            })

        # Debug: Log how many folders we found
        self.debug_log(f"[ALBUM] Found {len(folders)} folders from {username} with {len(file_list)} files")

        # Score each folder based on completeness and quality
        expected_track_count = len(search_info['tracks'])

        for folder_path, files in folders.items():
            score = self._score_album_folder(folder_path, files, search_info, upload_speed)

            # Debug: Log all folder scores
            self.debug_log(f"[ALBUM] Folder score: {int(score)} - {folder_path} ({len(files)} files)")

            # Only consider folders with reasonable scores
            if score < 50:
                continue

            # Check if this folder is already in candidates
            existing = None
            for candidate in search_info['folder_candidates']:
                if candidate['folder_path'] == folder_path and candidate['user'] == username:
                    existing = candidate
                    break

            if existing:
                # Update existing candidate if score improved
                if score > existing['score']:
                    existing['score'] = score
                    existing['tracks_found'] = files
                    existing['upload_speed'] = upload_speed
            else:
                # Add new candidate
                search_info['folder_candidates'].append({
                    'user': username,
                    'folder_path': folder_path,
                    'tracks_found': files,
                    'score': score,
                    'upload_speed': upload_speed
                })

        # Sort candidates by score and keep top 5
        search_info['folder_candidates'].sort(key=lambda x: x['score'], reverse=True)
        search_info['folder_candidates'] = search_info['folder_candidates'][:5]

        # Log best folder summary when we get first results
        if search_info['folder_candidates'] and search_info['result_count'] == 0:
            best = search_info['folder_candidates'][0]
            folder_name = best['folder_path'].split('/')[-1] if '/' in best['folder_path'] else best['folder_path']
            self.log(f"░░░░░▒▒▒ HEAD1 SPOTTED ____ Score {int(best['score'])} → {folder_name} ({len(best['tracks_found'])} tracks)")

        # Increment result count
        search_info['result_count'] += len(file_list)

    def _score_album_folder(self, folder_path, files, search_info, upload_speed=0):
        """
        Score a folder based on how well it matches the album requirements.

        Args:
            folder_path: Path to the folder
            files: List of file dicts in the folder
            search_info: Album search info with expected tracks
            upload_speed: User's upload speed in bytes/sec (0 if unknown)

        Returns:
            Score (higher = better match)
        """
        score = 0
        folder_lower = folder_path.lower()
        album_name_lower = search_info['album_name'].lower()
        artist_name_lower = search_info['album_artist'].lower()

        # Track count match (max 100 points)
        expected_count = len(search_info['tracks'])
        mp3_count = sum(1 for f in files if f['path'].lower().endswith('.mp3'))

        if mp3_count >= expected_count:
            score += 100
        elif mp3_count >= expected_count * 0.8:  # At least 80% of tracks
            score += 70
        elif mp3_count >= expected_count * 0.5:  # At least 50% of tracks
            score += 40

        # Folder name matches album (max 50 points)
        if album_name_lower in folder_lower:
            score += 50
        else:
            # Check for word matching
            album_words = set(album_name_lower.split())
            folder_words = set(folder_lower.split('/'))
            matches = len(album_words & folder_words)
            if matches > 0:
                score += (matches / len(album_words)) * 50

        # Folder name matches artist (max 30 points)
        if artist_name_lower in folder_lower:
            score += 30

        # Quality indicators in folder name (max 50 points)
        if '320' in folder_lower or '320kbps' in folder_lower:
            score += 50
        elif 'flac' in folder_lower:
            score += 50
        elif '256' in folder_lower:
            score += 30
        elif 'v0' in folder_lower:
            score += 25

        # Year match (max 20 points)
        if search_info.get('year') and search_info['year'] in folder_lower:
            score += 20

        # Average file quality (max 50 points)
        total_bitrate = 0
        bitrate_count = 0
        for file_info in files:
            attrs = file_info.get('attrs', {})
            if attrs:
                bitrate = attrs.get(0, attrs.get('bitrate', 0))
                if bitrate > 0:
                    total_bitrate += bitrate
                    bitrate_count += 1

        if bitrate_count > 0:
            avg_bitrate = total_bitrate / bitrate_count
            if avg_bitrate >= 320:
                score += 50
            elif avg_bitrate >= 256:
                score += 35
            elif avg_bitrate >= 192:
                score += 20

        # Upload speed bonus (max 100 points) - HEAVILY WEIGHT FAST UPLOADERS
        if upload_speed > 0:
            # Convert to KB/s for easier understanding
            speed_kbps = upload_speed / 1024
            if speed_kbps >= 1000:  # >= 1 MB/s - excellent
                score += 100
            elif speed_kbps >= 500:  # >= 500 KB/s - very good
                score += 75
            elif speed_kbps >= 250:  # >= 250 KB/s - good
                score += 50
            elif speed_kbps >= 100:  # >= 100 KB/s - okay
                score += 25
            elif speed_kbps >= 50:  # >= 50 KB/s - slow
                score += 10

        return score

    def _try_download_candidate(self, token, search_info, attempt_index, reason):
        """
        Attempt to download a specific candidate from the ranked list.

        Args:
            token: Search token
            search_info: Search metadata dict
            attempt_index: Index into download_candidates list
            reason: Reason for this download attempt (for logging)
        """
        try:
            candidates = search_info['download_candidates']

            if attempt_index >= len(candidates):
                self.log(f"[DL] All {len(candidates)} candidates exhausted for '{search_info['query']}'")
                # Clean up - no more candidates
                if token in self.active_searches:
                    del self.active_searches[token]
                return

            candidate = candidates[attempt_index]

            # Format artist - track display
            artist = search_info.get('artist', '')
            track = search_info.get('track', '')
            track_display = f"{artist} - {track}"
            head_num = attempt_index + 1
            score = int(candidate['score'])

            self.log(f"░░░░░▒▒▒▒▒ HEAD{head_num} FIRST BITE ____ Download Started: {track_display} ({score})")

            # Send event to bridge for popup console
            track_id_safe = search_info.get('track_id', '') or f"{artist}-{track}".replace(' ', '')[:20]
            format_info = self._get_file_format(candidate['file']).upper()
            bitrate_info = self._extract_bitrate(candidate['file']) or ''
            quality_str = f"{format_info} {bitrate_info}".strip()
            self._send_event_to_bridge('info', f"Downloading: {track_display} ({quality_str})", track_id_safe)

            # Queue the download
            self.core.downloads.enqueue_download(
                username=candidate['user'],
                virtual_path=candidate['file'],
                size=candidate['size'],
                file_attributes=candidate.get('attrs')
            )

            # Update tracking
            search_info['current_attempt'] = attempt_index
            search_info['download_started_at'] = time.time()
            search_info['last_download_path'] = candidate['file']
            search_info['last_download_user'] = candidate['user']  # Store username for abort
            search_info['head_number'] = attempt_index + 1  # Store HEAD number (1-indexed)
            search_info['head_score'] = int(candidate['score'])  # Store score for logging

            # Track this download for monitoring
            # CRITICAL: Use the same key format as Nicotine+ transfers dictionary: username + virtual_path
            transfer_key = candidate['user'] + candidate['file']
            self.active_downloads[transfer_key] = token
            self.debug_log(f"[PROGRESS] Tracking download: {transfer_key[:80]} (token={token})")

            # CASCADE MODE: Track all cascade heads so we can abort losers when one wins
            if search_info.get('cascade_mode'):
                if 'cascade_heads' not in search_info:
                    search_info['cascade_heads'] = []

                search_info['cascade_heads'].append({
                    'index': attempt_index,
                    'transfer_key': transfer_key,
                    'virtual_path': candidate['file'],
                    'username': candidate['user'],
                    'started_at': time.time(),
                    'score': candidate['score']
                })
                self.debug_log(f"[CASCADE] Registered HEAD{attempt_index + 1} in cascade (score: {candidate['score']})")

            # LEGACY RACE MODE: Track all racing heads (kept for backward compatibility)
            elif search_info.get('race_mode'):
                if 'race_heads' not in search_info:
                    search_info['race_heads'] = []

                search_info['race_heads'].append({
                    'index': attempt_index,
                    'transfer_key': transfer_key,
                    'virtual_path': candidate['file'],
                    'username': candidate['user'],
                    'started_at': time.time(),
                    'score': candidate['score']
                })
                self.debug_log(f"[RACE] Registered HEAD{attempt_index + 1} in race (score: {candidate['score']})")

            # Don't log success - the download starting message is enough

        except Exception as e:
            self.debug_log(f"[DL] Error queuing download: {e}")
            import traceback
            self.debug_log(f"[DL] Traceback: {traceback.format_exc()}")

            # Try next candidate if available
            if attempt_index + 1 < len(search_info['download_candidates']):
                self.log(f"[DL] HEAD #{attempt_index + 1} FAILED → Trying next head...")
                self._try_download_candidate(token, search_info, attempt_index + 1, "Fallback after error")
            else:
                # No more candidates
                if token in self.active_searches:
                    del self.active_searches[token]

    def _abort_transfer_by_path(self, virtual_path, username=None, remove_from_tracking=True):
        """
        Abort a download transfer by its virtual path.

        Args:
            virtual_path: Virtual path of the file to abort
            username: Username (optional, for more precise matching)
            remove_from_tracking: Whether to remove from active_downloads dict

        Returns:
            True if transfer was found and aborted, False otherwise
        """
        try:
            # Find the transfer object
            transfer_to_abort = None
            if hasattr(self.core, 'downloads') and hasattr(self.core.downloads, 'transfers'):
                for transfer in self.core.downloads.transfers.values():
                    if hasattr(transfer, 'virtual_path') and transfer.virtual_path == virtual_path:
                        transfer_to_abort = transfer
                        self.debug_log(f"[ABORT] Found transfer to abort: {virtual_path[:60]}")
                        break

                if transfer_to_abort:
                    # Try clear_downloads FIRST (cleanest removal)
                    cleared = False
                    if hasattr(self.core.downloads, 'clear_downloads'):
                        try:
                            self.core.downloads.clear_downloads([transfer_to_abort])
                            self.debug_log(f"[ABORT] ✓ Cleared transfer via clear_downloads")
                            cleared = True
                        except Exception as e:
                            self.debug_log(f"[ABORT] clear_downloads failed: {e}")

                    # Try abort if clear failed
                    if not cleared:
                        if hasattr(self.core.downloads, 'abort_downloads'):
                            try:
                                self.core.downloads.abort_downloads([transfer_to_abort])
                                self.debug_log(f"[ABORT] ✓ Aborted via abort_downloads")
                            except Exception as e:
                                self.debug_log(f"[ABORT] abort_downloads failed: {e}")
                                # Try abort_transfer as last resort
                                if hasattr(self.core.downloads, 'abort_transfer'):
                                    try:
                                        self.core.downloads.abort_transfer(transfer_to_abort)
                                        self.debug_log(f"[ABORT] ✓ Aborted via abort_transfer")
                                    except Exception as e2:
                                        self.debug_log(f"[ABORT] abort_transfer also failed: {e2}")
                        elif hasattr(self.core.downloads, 'abort_transfer'):
                            try:
                                self.core.downloads.abort_transfer(transfer_to_abort)
                                self.debug_log(f"[ABORT] ✓ Aborted via abort_transfer")
                            except Exception as e:
                                self.debug_log(f"[ABORT] abort_transfer failed: {e}")

                    # Remove from tracking if requested
                    if remove_from_tracking:
                        transfer_key = (username + virtual_path) if username else virtual_path
                        if transfer_key in self.active_downloads:
                            del self.active_downloads[transfer_key]
                            self.debug_log(f"[ABORT] Removed from tracking")

                    return True
                else:
                    self.debug_log(f"[ABORT] Transfer not found (may have completed/aborted already)")
                    return False
            else:
                self.debug_log(f"[ABORT] downloads.transfers not available")
                return False

        except Exception as e:
            self.debug_log(f"[ABORT] Error aborting transfer: {e}")
            return False

    def _try_next_download_candidate(self, token, search_info, reason):
        """
        Try the next download candidate after a failure.

        Args:
            token: Search token
            search_info: Search metadata dict
            reason: Reason for fallback (for logging)
        """
        # RACE MODE: Don't retry - multiple downloads are already racing
        # If we're in race mode, other heads are already running in parallel
        if search_info.get('race_mode'):
            self.log(f"[RACE] Retry skipped - {len(search_info.get('race_heads', []))} downloads already racing")
            return

        # CASCADE MODE: Don't retry - cascading system handles backups automatically
        # Cascade heads will launch on schedule (10s/60s/120s) if needed
        if search_info.get('cascade_mode'):
            self.log(f"[CASCADE] Retry skipped - cascading system will handle backups automatically")
            return

        next_attempt = search_info['current_attempt'] + 1

        self.log(f"[DL] 🔄 Attempting fallback (reason: {reason})")
        self.log(f"[DL] Last download path: {search_info.get('last_download_path', 'NONE')}")

        # Send event to bridge for popup console
        track_id_safe = search_info.get('track_id', '') or f"{search_info.get('artist', '')}-{search_info.get('track', '')}".replace(' ', '')[:20]
        self._send_event_to_bridge('warning', f"Retrying: {search_info.get('artist', '')} - {search_info.get('track', '')} ({reason})", track_id_safe)

        # Remove failed download from tracking and abort it from Nicotine+ queue
        if search_info.get('last_download_path'):
            virtual_path = search_info['last_download_path']
            username = search_info.get('last_download_user')
            self.log(f"[DL] Aborting failed download: {virtual_path[:60]}")
            self._abort_transfer_by_path(virtual_path, username, remove_from_tracking=True)

        # Try next candidate (logging happens in _try_download_candidate)
        self._try_download_candidate(token, search_info, next_attempt, f"Trying next candidate")

    def _check_cascade_launches(self):
        """Check if we should launch additional cascade heads (HEAD2, HEAD3)."""
        if not self.active_searches:
            return

        current_time = time.time()

        for token, search_info in list(self.active_searches.items()):
            if not search_info.get('cascade_mode'):
                continue

            try:
                elapsed = current_time - search_info['cascade_start_time']
                heads_launched = search_info.get('cascade_heads_launched', 1)
                candidates = search_info.get('download_candidates', [])

                # HEAD2 launch logic (10s delay if HEAD1 hasn't started, or 60s timeout)
                if heads_launched == 1 and len(candidates) >= 2 and candidates[1]['score'] > 50:
                    head1_started = search_info.get('cascade_head1_started', False)

                    # Launch HEAD2 if HEAD1 hasn't started after 10s
                    if not head1_started and elapsed >= 10:
                        self.log(f"[CASCADE] HEAD1 no response after 10s → launching HEAD2 (score: {candidates[1]['score']})")
                        self._try_download_candidate(token, search_info, 1, "CASCADE HEAD2 (HEAD1 stalled)")
                        search_info['cascade_heads_launched'] = 2

                    # Launch HEAD2 if HEAD1 taking too long (60s timeout)
                    elif head1_started and elapsed >= 60:
                        self.log(f"[CASCADE] HEAD1 taking too long (60s) → launching HEAD2 as backup (score: {candidates[1]['score']})")
                        self._try_download_candidate(token, search_info, 1, "CASCADE HEAD2 (timeout)")
                        search_info['cascade_heads_launched'] = 2

                # HEAD3 launch logic (120s total timeout)
                elif heads_launched == 2 and len(candidates) >= 3 and candidates[2]['score'] > 50:
                    if elapsed >= 120:
                        self.log(f"[CASCADE] HEAD1/HEAD2 taking too long (120s) → launching HEAD3 as final backup (score: {candidates[2]['score']})")
                        self._try_download_candidate(token, search_info, 2, "CASCADE HEAD3 (final backup)")
                        search_info['cascade_heads_launched'] = 3

            except Exception as e:
                self.debug_log(f"[CASCADE] Error checking cascade for {token}: {e}")
                import traceback
                self.debug_log(f"[CASCADE] Traceback: {traceback.format_exc()}")

    def _check_and_download_ready_searches(self):
        """Check active searches and download if enough time has passed to collect results."""
        if not self.active_searches:
            return

        current_time = time.time()

        for token, search_info in list(self.active_searches.items()):
            try:
                search_type = search_info.get('type', 'track')

                if search_type == 'album':
                    # Handle album downloads
                    self._check_album_download_ready(token, search_info, current_time)
                else:
                    # Handle regular track downloads
                    self._check_track_download_ready(token, search_info, current_time)

            except Exception as e:
                self.debug_log(f"[DL] Error checking search {token}: {e}")
                import traceback
                self.debug_log(f"[DL] Traceback: {traceback.format_exc()}")

                # Remove problematic search after timeout
                if current_time - search_info['timestamp'] > 60:
                    del self.active_searches[token]

    def _check_track_download_ready(self, token, search_info, current_time):
        """Check if a track search is ready to download."""
        elapsed = current_time - search_info['timestamp']

        # Skip if already started cascade downloads
        if search_info.get('cascade_mode'):
            return

        # Skip if already attempted download
        if search_info['current_attempt'] >= 0:
            return

        # Wait at least 15 seconds to collect results, max 30 seconds
        if elapsed < 15:
            return

        candidates = search_info['download_candidates']

        # CASCADE MODE: Start HEAD1 (best quality) first, add backups only if needed
        # Quality over speed: give best candidate a chance before adding parallel downloads
        if candidates and candidates[0]['score'] > 100 and elapsed >= 15:
            # Count viable candidates for potential cascading
            viable_candidates = [c for c in candidates[:3] if c['score'] > 50]

            if len(viable_candidates) >= 1:
                best_score = candidates[0]['score']
                self.log(f"[CASCADE] Starting HEAD1 (score: {best_score}) - will cascade HEAD2/HEAD3 if needed")

                # Initialize cascade tracking
                search_info['cascade_mode'] = True
                search_info['cascade_start_time'] = current_time
                search_info['cascade_head1_started'] = False  # Will be set when progress > 0
                search_info['cascade_heads_launched'] = 1
                search_info['cascade_heads'] = []

                # Start HEAD1 only (best quality candidate)
                self._try_download_candidate(token, search_info, 0, "CASCADE HEAD1 (best quality)")

                self.log(f"[CASCADE] ✓ HEAD1 launched, {len(viable_candidates) - 1} backup(s) available")
            else:
                # Not enough viable candidates, fall back to single download
                self._try_download_candidate(token, search_info, 0, "Single download")

        elif elapsed > 30:
            # Timeout - download best we have if score is reasonable
            if candidates and candidates[0]['score'] > 50:
                # Start with cascade even at timeout
                viable_candidates = [c for c in candidates[:3] if c['score'] > 50]

                if len(viable_candidates) >= 1:
                    self.log(f"[CASCADE] Timeout - starting HEAD1 with cascade backup")
                    search_info['cascade_mode'] = True
                    search_info['cascade_start_time'] = current_time
                    search_info['cascade_head1_started'] = False
                    search_info['cascade_heads_launched'] = 1
                    search_info['cascade_heads'] = []
                    self._try_download_candidate(token, search_info, 0, "CASCADE HEAD1 (timeout)")
                else:
                    # Only one viable candidate
                    self._try_download_candidate(token, search_info, 0, "Timeout - downloading best available")
            else:
                best_score = candidates[0]['score'] if candidates else 0
                self.log(f"[DL] NO MATCH → '{search_info['query']}' (best score: {best_score}/50)")
                # Remove from tracking - no good candidates
                del self.active_searches[token]

    def _check_album_download_ready(self, token, search_info, current_time):
        """Check if an album search is ready to start downloading tracks."""
        elapsed = current_time - search_info['timestamp']

        # Skip if already started downloading
        if search_info.get('best_folder'):
            return

        # Wait at least 20 seconds to collect folder results, max 40 seconds
        if elapsed < 20:
            return

        folder_candidates = search_info.get('folder_candidates', [])

        # Check if we have a good folder candidate
        if folder_candidates and folder_candidates[0]['score'] > 150 and elapsed >= 20:
            # Start downloading from best folder
            self._start_album_download(token, search_info, folder_candidates[0])

        elif elapsed > 40:
            # Timeout - use best we have if score is reasonable
            if folder_candidates and folder_candidates[0]['score'] > 100:
                self._start_album_download(token, search_info, folder_candidates[0])
            else:
                best_score = folder_candidates[0]['score'] if folder_candidates else 0
                self.log(f"[ALBUM] No suitable folder found for '{search_info['album_name']}' (best score: {best_score}/100)")
                # Remove from tracking
                del self.active_searches[token]

    def _start_album_download(self, token, search_info, best_folder):
        """Start downloading tracks from the best album folder."""
        try:
            folder_name = best_folder['folder_path'].split('/')[-1] if '/' in best_folder['folder_path'] else best_folder['folder_path']
            self.log(f"░░░░░▒▒▒▒▒ HEAD1 FIRST BITE ____ Album Download Started: {folder_name}")
            self.debug_log(f"[ALBUM] Selected folder: {best_folder['folder_path']}")
            self.debug_log(f"[ALBUM] From user: {best_folder['user']} (score: {int(best_folder['score'])})")

            # Store best folder info
            search_info['best_folder'] = best_folder

            # Match expected tracks with files in the folder
            tracks_to_download = self._match_album_tracks(search_info, best_folder)

            if not tracks_to_download:
                self.log(f"[ALBUM] Could not match any tracks in folder")
                del self.active_searches[token]
                return

            search_info['tracks_to_download'] = tracks_to_download
            search_info['current_track_index'] = 0

            self.debug_log(f"[ALBUM] Matched {len(tracks_to_download)}/{len(search_info['tracks'])} tracks")

            # CHANGE: Don't create album folder yet - we'll create it after first track downloads
            # This way we can extract the download directory from the actual download path
            search_info['album_folder_created'] = False

            self.debug_log(f"[ALBUM] Starting track 1/{len(tracks_to_download)}...")

            # ALBUM-LEVEL PREFETCH: Fetch album metadata ONCE (year, cover art)
            # This is shared across all tracks and should not be fetched per-track
            if len(tracks_to_download) > 0:
                first_track_info = tracks_to_download[0]['track_info']
                self._prefetch_album_metadata(token, first_track_info)

            # Start downloading first track
            self._download_next_album_track(token, search_info)

        except Exception as e:
            self.debug_log(f"[ALBUM] Error starting album download: {e}")
            import traceback
            self.debug_log(f"[ALBUM] Traceback: {traceback.format_exc()}")
            del self.active_searches[token]

    def _get_download_directory(self, track_to_download):
        """Get download directory from Nicotine+ configuration."""
        try:
            # Try multiple methods to get the download directory

            # Method 1: Check core.config
            if hasattr(self.core, 'config'):
                config = self.core.config
                # Try modern config format
                if hasattr(config, 'sections') and hasattr(config.sections, 'transfers'):
                    download_dir = config.sections.get('transfers', {}).get('downloaddir')
                    if download_dir:
                        self.debug_log(f"[ALBUM] Found download directory (config.sections): {download_dir}")
                        return download_dir

                # Try legacy config format
                if hasattr(config, 'data') and 'transfers' in config.data:
                    download_dir = config.data['transfers'].get('downloaddir')
                    if download_dir:
                        self.debug_log(f"[ALBUM] Found download directory (config.data): {download_dir}")
                        return download_dir

            # Method 2: Check core.downloads
            if hasattr(self.core, 'downloads') and hasattr(self.core.downloads, 'download_folder'):
                download_dir = self.core.downloads.download_folder
                if download_dir:
                    self.debug_log(f"[ALBUM] Found download directory (core.downloads): {download_dir}")
                    return download_dir

            self.debug_log(f"[ALBUM] Could not find download directory in config")
            return None

        except Exception as e:
            self.debug_log(f"[ALBUM] Error getting download directory: {e}")
            import traceback
            self.debug_log(f"[ALBUM] Traceback: {traceback.format_exc()}")
            return None

    def _ensure_album_folder(self, search_info, download_dir):
        """Create album folder before downloads start (crash-resistant)."""
        try:
            from urllib.request import urlopen, Request
            from urllib.error import URLError
            import json

            album_artist = search_info.get('album_artist', '')
            album_name = search_info.get('album_name', '')
            year = search_info.get('year', '')

            if not album_artist or not album_name:
                self.log(f"[ALBUM] Missing album_artist or album_name")
                return None

            self.debug_log(f"[ALBUM] Creating album folder: {album_artist} - {album_name}")

            # Send request to bridge server to create folder
            payload = {
                'album_artist': album_artist,
                'album_name': album_name,
                'year': year,
                'download_dir': download_dir
            }

            url = f"{self.settings['metadata_url']}/ensure-album-folder"
            req = Request(url,
                         data=json.dumps(payload).encode('utf-8'),
                         headers={'Content-Type': 'application/json'})

            with urlopen(req, timeout=10) as response:
                result = json.loads(response.read().decode('utf-8'))

                if result.get('success'):
                    folder_path = result.get('folder_path', '')
                    self.log(f"[ALBUM] Folder created: {result.get('folder_name', '')}")
                    return folder_path
                else:
                    error = result.get('error', 'Unknown error')
                    self.log(f"[ALBUM] Failed to create folder: {error}")
                    return None

        except URLError as e:
            self.log(f"[ALBUM] Cannot reach bridge server: {e}")
            return None
        except Exception as e:
            self.debug_log(f"[ALBUM] Error creating album folder: {e}")
            import traceback
            self.debug_log(f"[ALBUM] Traceback: {traceback.format_exc()}")
            return None

    def _match_album_tracks(self, search_info, best_folder):
        """
        Match expected album tracks with files in the best folder.

        Returns list of {track_info, file_path, file_size, file_attrs, user}
        """
        import os

        expected_tracks = search_info['tracks']
        folder_files = best_folder['tracks_found']
        user = best_folder['user']

        matched_tracks = []

        # Helper function to normalize text for flexible matching
        def normalize_for_matching(text):
            """Normalize text for flexible matching - handles underscores, dots, remaster suffixes, etc."""
            import re

            # Strip version suffixes (Remaster, Deluxe Edition, etc.) BEFORE other normalization
            # This matches patterns like "- 2015 Remaster", "(Deluxe Edition)", "[Live Version]", etc.
            suffix_pattern = r'\s*[-(\[]\s*(\d{4}\s+(Remaster(ed)?|Edition)|Remaster(ed)?(\s+\d{4})?|(Deluxe|Special|Limited|Expanded|Collector\'?s)\s+(Edition|Version)|(Live|Acoustic|Radio|Single|Album)\s+(Version|Edit|Mix)|Bonus\s+Track\s+Version).*$'
            text = re.sub(suffix_pattern, '', text, flags=re.IGNORECASE)

            # Replace underscores, dots, dashes with spaces
            text = text.replace('_', ' ').replace('.', ' ').replace('-', ' ')
            # Remove parentheses and brackets
            text = re.sub(r'[(\[{}\])]', ' ', text)
            # Remove extra punctuation except apostrophes
            text = re.sub(r'[^\w\s\']', ' ', text)
            # Collapse multiple spaces
            text = re.sub(r'\s+', ' ', text)
            return text.strip().lower()

        for track_info in expected_tracks:
            track_name_original = track_info['track'].lower()
            artist_name_original = track_info['artist'].lower()

            # Normalize for flexible matching
            track_name_normalized = normalize_for_matching(track_name_original)
            artist_name_normalized = normalize_for_matching(artist_name_original)

            # Find best matching file for this track
            best_match = None
            best_match_score = 0

            for file_info in folder_files:
                file_path = file_info['path']
                file_name_original = os.path.basename(file_path).lower()

                # Skip non-MP3 files
                if not file_name_original.endswith('.mp3'):
                    continue

                # Normalize filename (remove .mp3 for matching)
                file_name_clean = file_name_original.replace('.mp3', '')
                file_name_normalized = normalize_for_matching(file_name_clean)

                # Calculate match score
                score = 0

                # Track name in filename (50 points) - use normalized versions
                track_name_found = False
                track_name_position = -1
                if track_name_normalized in file_name_normalized:
                    score += 50
                    track_name_found = True
                    track_name_position = file_name_normalized.find(track_name_normalized)
                else:
                    # Word matching
                    track_words = set(track_name_normalized.split())
                    file_words = set(file_name_normalized.split())
                    matches = len(track_words & file_words)
                    if matches > 0:
                        score += (matches / len(track_words)) * 50

                # Artist name in filename (30 points)
                if artist_name_normalized in file_name_normalized:
                    score += 30

                # Track number matching (20 points) - use original filename for regex
                track_num = track_info.get('track_number', 0)
                if track_num > 0:
                    # Look for track number patterns like "01", "1.", "01 -", etc.
                    import re
                    track_patterns = [
                        rf'\b0?{track_num}\b',  # "01" or "1"
                        rf'\b0?{track_num}\.',  # "01." or "1."
                        rf'\b0?{track_num}\s*-',  # "01 -" or "1-"
                    ]
                    for pattern in track_patterns:
                        if re.search(pattern, file_name_original):
                            score += 20
                            break

                # "LESS IS MORE" STRATEGY - Penalize files with extra text after the track name
                # Clean files like "01 Artist - Track.mp3" should rank higher than
                # "01 Artist - Track (Underground Version Mix).mp3"
                if track_name_found and track_name_position >= 0:
                    # Extract everything after the track name (normalized)
                    after_track = file_name_normalized[track_name_position + len(track_name_normalized):].strip()

                    # Remove common separators
                    after_track_clean = after_track.lstrip(' ')

                    # If there's text after the track name, penalize it
                    if after_track_clean:
                        # Heavy penalty for extra content
                        penalty = min(50, len(after_track_clean) * 2)  # 2 points per character, max 50

                        # Extra penalties for specific variant indicators
                        variant_indicators = [
                            'remix', 'mix', 'rmx', 'edit', 'version', 'feat', 'ft', 'featuring',
                            'live', 'acoustic', 'instrumental', 'cover', 'karaoke', 'radio',
                            'extended', 'club', 'dub', 'vip', 'remaster', 'deluxe', 'bonus',
                            'explicit', 'clean', 'original', 'alternate', 'demo'
                        ]

                        for indicator in variant_indicators:
                            if indicator in after_track_clean:
                                penalty += 30  # Additional 30 point penalty for variants
                                break

                        score -= penalty

                if score > best_match_score:
                    best_match_score = score
                    best_match = file_info

            # Only include tracks with reasonable match score
            if best_match and best_match_score > 30:
                matched_tracks.append({
                    'track_info': track_info,
                    'file_path': best_match['path'],
                    'file_size': best_match['size'],
                    'file_attrs': best_match['attrs'],
                    'user': user
                })

        return matched_tracks

    def _prefetch_album_metadata(self, token, first_track_info):
        """
        Prefetch ALBUM-LEVEL metadata once (year, cover art URL).
        This is shared across all tracks in the album - no need to fetch per-track.

        Args:
            token: Search token
            first_track_info: Track metadata dict from first track (to get album info)
        """
        from threading import Thread

        def prefetch_worker():
            try:
                from urllib.request import urlopen, Request
                from urllib.error import URLError
                import re

                track_id = first_track_info.get('track_id', '')
                if not track_id:
                    self.debug_log(f"[PREFETCH] No track_id, skipping album metadata prefetch")
                    return

                album_name = first_track_info.get('album', 'Unknown Album')
                self.debug_log(f"[PREFETCH] Fetching album metadata for: {album_name}")

                # Fetch album metadata from Spotify page (year, cover URL)
                track_url = f"https://open.spotify.com/track/{track_id}"

                try:
                    req = Request(track_url, headers={
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    })

                    with urlopen(req, timeout=30) as response:
                        html = response.read().decode('utf-8')

                        album_metadata = {}

                        # Extract year from release date (ALBUM-LEVEL)
                        release_match = re.search(r'<meta name="music:release_date" content="([^"]+)"', html)
                        if release_match:
                            release_date = release_match.group(1)
                            album_metadata['year'] = release_date.split('-')[0]

                        # Extract cover image URL (ALBUM-LEVEL)
                        image_match = re.search(r'<meta property="og:image" content="([^"]+)"', html)
                        if image_match:
                            album_metadata['image_url'] = image_match.group(1)

                        # IMPROVED: Store in cache with TTL wrapper
                        cache_key = (token, 'album')
                        self.metadata_cache[cache_key] = {
                            'data': album_metadata,
                            'timestamp': time.time()
                        }

                        self.debug_log(f"[PREFETCH] Album metadata cached (year={album_metadata.get('year', 'N/A')})")

                except URLError as e:
                    self.debug_log(f"[PREFETCH] Failed to fetch album metadata: {e}")
                except Exception as e:
                    self.debug_log(f"[PREFETCH] Error prefetching album metadata: {e}")

            except Exception as e:
                self.debug_log(f"[PREFETCH] Fatal error in prefetch worker: {e}")
                import traceback
                self.debug_log(f"[PREFETCH] {traceback.format_exc()}")

        # Start prefetch in background thread
        thread = Thread(target=prefetch_worker, daemon=True)
        thread.start()

    def _download_next_album_track(self, token, search_info):
        """Download the next track in the album queue."""
        try:
            tracks_to_download = search_info['tracks_to_download']
            current_index = search_info['current_track_index']

            if current_index >= len(tracks_to_download):
                # All tracks downloaded - finalize album
                self._finalize_album_download(token, search_info)
                return

            track_to_download = tracks_to_download[current_index]
            track_info = track_to_download['track_info']

            self.debug_log(f"[ALBUM] Track {current_index + 1}/{len(tracks_to_download)}: {track_info['artist']} - {track_info['track']}")

            # IMPROVED: Generate album-level trackId for unified progress bar
            # This ensures all tracks in the album share the same progress bar
            album_track_id = f"album_{token}"
            if 'album_track_id' not in search_info:
                search_info['album_track_id'] = album_track_id
                # Initialize album progress tracking
                search_info['completed_track_count'] = 0
                search_info['total_album_bytes'] = sum(t.get('file_size', 0) for t in tracks_to_download)
                self.debug_log(f"[ALBUM] Album trackId: {album_track_id}, Total size: {search_info['total_album_bytes']} bytes")

            # Store current track info for progress calculation
            search_info['current_track_size'] = track_to_download.get('file_size', 0)
            search_info['current_track_path'] = track_to_download['file_path']

            # Send event to bridge for popup console
            track_id_safe = track_info.get('track_id', '') or f"{track_info['artist']}{track_info['track']}".replace(' ', '').replace('-', '')[:20]
            album_info = f" (Album: {search_info.get('album_name', '')})" if search_info.get('album_name') else ''
            self._send_event_to_bridge('info', f"Downloading: {track_info['artist']} - {track_info['track']}{album_info}", track_id_safe)

            # Queue the download
            self.core.downloads.enqueue_download(
                username=track_to_download['user'],
                virtual_path=track_to_download['file_path'],
                size=track_to_download['file_size'],
                file_attributes=track_to_download.get('file_attrs')
            )

            # Track this download
            # CRITICAL: Use the same key format as Nicotine+ transfers dictionary: username + virtual_path
            transfer_key = track_to_download['user'] + track_to_download['file_path']
            self.active_downloads[transfer_key] = token
            search_info['download_started_at'] = time.time()

        except Exception as e:
            self.debug_log(f"[ALBUM] Error downloading track: {e}")
            import traceback
            self.debug_log(f"[ALBUM] Traceback: {traceback.format_exc()}")

            # Try next track or give up
            search_info['current_track_index'] += 1
            if search_info['current_track_index'] < len(search_info['tracks_to_download']):
                self._download_next_album_track(token, search_info)
            else:
                self._finalize_album_download(token, search_info)


    def _process_downloaded_file(self, file_path, search_info):
        """
        Send file to Node.js server for metadata processing.
        Runs in background thread.

        Args:
            file_path: Local path to downloaded MP3 file
            search_info: Dict with artist, track, album, track_id, etc.
        """
        try:
            from urllib.request import urlopen, Request
            from urllib.error import URLError
            import json
            import os

            # Wait a moment for file to be fully written
            time.sleep(1)

            # Verify file exists and is MP3
            if not os.path.exists(file_path):
                self.log(f"[META] File not found: {file_path}")
                return

            # Check if file is MP3 or FLAC
            file_lower = file_path.lower()
            if not (file_lower.endswith('.mp3') or file_lower.endswith('.flac')):
                self.log(f"[META] Unsupported format (only MP3/FLAC), skipping: {file_path}")
                return

            # Check if metadata override is enabled for this search
            if not search_info.get('metadata_override', True):
                self.log(f"[META] Metadata override disabled for this track")
                return

            self.debug_log(f"[META] Sending to metadata server for processing...")

            # Prepare request data (using camelCase for Node.js)
            payload = {
                'filePath': file_path,  # camelCase for Node.js
                'artist': search_info.get('artist', ''),
                'track': search_info.get('track', ''),
                'album': search_info.get('album', ''),
                'trackId': search_info.get('track_id', '')  # camelCase for Node.js
            }

            # Send to Metadata Worker
            url = f"{self.settings['metadata_url']}/process-metadata"
            req = Request(url,
                         data=json.dumps(payload).encode('utf-8'),
                         headers={'Content-Type': 'application/json'})

            with urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode('utf-8'))

                if result.get('success'):
                    # Format FINISHED message
                    artist = search_info.get('artist', '')
                    track = search_info.get('track', '')
                    track_display = f"{artist} - {track}"
                    head_num = search_info.get('head_number', 1)

                    if result.get('renamed'):
                        self.log(f"▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  HEAD{head_num} FINISHED  ____ {track_display}        ^~~~~~~<:===<")

                    if result.get('tags_updated'):
                        artist = search_info.get('artist', '')
                        track = search_info.get('track', '')
                        album = search_info.get('album', '')
                        if artist:
                            self.log(f"[META]   Artist: {artist}")
                        if track:
                            self.log(f"[META]   Track: {track}")
                        if album:
                            self.log(f"[META]   Album: {album}")

                        # Log additional metadata from server response
                        if result.get('year'):
                            self.log(f"[META]   Year: {result['year']}")
                        if result.get('track_number'):
                            self.log(f"[META]   Track: #{result['track_number']}")
                        if result.get('genre'):
                            self.log(f"[META]   Genre: {result['genre']}")
                        if result.get('label'):
                            self.log(f"[META]   Label: {result['label']}")

                    if result.get('cover_embedded'):
                        self.log(f"[META]   Cover: Embedded")
                else:
                    self.log(f"[META] Failed: {result.get('error', 'Unknown error')}")

        except URLError as e:
            self.log(f"[META] Cannot reach Node server: {e}")
            self.log(f"[META] Make sure bridge server is running")
        except Exception as e:
            self.log(f"[META] Error: {e}")
            import traceback
            self.log(f"[META] {traceback.format_exc()}")

    def _finalize_album_download(self, token, search_info):
        """
        Finalize album download.
        CRITICAL: No batch processing anymore - each track was processed immediately after download.
        """
        try:
            tracks_to_download = search_info.get('tracks_to_download', [])
            current_index = search_info.get('current_track_index', 0)

            # Calculate how many tracks we actually downloaded
            downloaded_count = current_index  # current_index is incremented after each download

            self.log(f"[ALBUM] Album download complete!")
            self.log(f"[ALBUM] Downloaded: {downloaded_count}/{len(tracks_to_download)} tracks")
            self.log(f"[ALBUM] All tracks were processed immediately (no batch processing)")

            # IMPROVED: Send final 100% progress update for album-level progress bar
            if 'album_track_id' in search_info:
                album_track_id = search_info['album_track_id']
                album_name = search_info.get('album_name', 'Album')
                artist = search_info.get('artist', '')
                album_folder = search_info.get('album_folder_path', '')
                image_url = search_info.get('image_url', '')
                self._send_progress_update(album_track_id, album_name, 100, 0, 0, artist, '', album_name, album_folder, image_url)
                self.log(f"[PROGRESS] Album progress complete at 100%")

            # Check if album folder was created
            album_folder = search_info.get('album_folder_path')
            if album_folder:
                import os
                self.log(f"[ALBUM] Location: {album_folder}")
                self.log(f"[ALBUM] Folder: {os.path.basename(album_folder)}")

            # Clean up
            del self.active_searches[token]

        except Exception as e:
            self.debug_log(f"[ALBUM] Error finalizing album: {e}")
            import traceback
            self.debug_log(f"[ALBUM] Traceback: {traceback.format_exc()}")
            if token in self.active_searches:
                del self.active_searches[token]

    def _organize_album_folder(self, downloaded_tracks, search_info):
        """Organize downloaded files into album folder."""
        try:
            from urllib.request import urlopen, Request
            from urllib.error import URLError
            import json
            import os

            # Extract file paths (already renamed if metadata processing occurred)
            track_file_paths = [track_data['file_path'] for track_data in downloaded_tracks]

            self.log(f"[ALBUM] Creating album folder and organizing {len(track_file_paths)} files...")

            # Send to bridge server to create album folder and move files
            payload = {
                'album_artist': search_info['album_artist'],
                'album_name': search_info['album_name'],
                'year': search_info.get('year', ''),
                'track_files': track_file_paths
            }

            url = f"{self.settings['metadata_url']}/organize-album"
            req = Request(url,
                         data=json.dumps(payload).encode('utf-8'),
                         headers={'Content-Type': 'application/json'})

            with urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode('utf-8'))

                if result.get('success'):
                    folder_path = result.get('folder_path', '')
                    self.log(f"[ALBUM] Album organized: {folder_path}")
                else:
                    error = result.get('error', 'Unknown error')
                    self.log(f"[ALBUM] Failed to organize album: {error}")

        except Exception as e:
            self.debug_log(f"[ALBUM] Error organizing album folder: {e}")
            import traceback
            self.debug_log(f"[ALBUM] Traceback: {traceback.format_exc()}")

    def _process_album_metadata_and_organize(self, downloaded_tracks, search_info):
        """Process metadata for all tracks, then organize into album folder."""
        try:
            self.log(f"[ALBUM-META] Starting batch processing...")
            self._process_album_metadata_batch(downloaded_tracks, search_info)
            self.log(f"[ALBUM-META] Batch processing complete, organizing folder...")
        except Exception as e:
            self.log(f"[ALBUM-META] Error during metadata processing: {e}")
            import traceback
            self.log(f"[ALBUM-META] Traceback: {traceback.format_exc()}")
            self.log(f"[ALBUM-META] Continuing to organize files despite errors...")

        # CRITICAL: Always organize folder, even if metadata processing failed
        # This ensures files are moved into album folder regardless of server crashes
        try:
            self._organize_album_folder(downloaded_tracks, search_info)
        except Exception as e:
            self.debug_log(f"[ALBUM] Error organizing album folder: {e}")
            import traceback
            self.debug_log(f"[ALBUM] Traceback: {traceback.format_exc()}")

    def download_finished_notification(self, user, virtual_path, real_path):
        """
        Called when a download completes successfully.

        Args:
            user: Username who shared the file
            virtual_path: Network path of file
            real_path: Local filesystem path where file was saved
        """
        try:
            # CRITICAL: Use the same key format as we stored: username + virtual_path
            transfer_key = user + virtual_path

            # Check if this download is tracked
            if transfer_key not in self.active_downloads:
                return

            # Get search token and metadata
            token = self.active_downloads[transfer_key]

            if token not in self.active_searches:
                return

            search_info = self.active_searches[token]

            # Only process if this was an auto-download from browser
            if not search_info.get('auto_download', False):
                return

            # RACE MODE: Check if another head already won
            # This prevents race condition where multiple heads finish simultaneously
            if search_info.get('race_mode'):
                # If race_mode is False, another head already won and cleared it
                # If race_winner is set, another head already claimed victory
                if not search_info.get('race_mode') or search_info.get('race_winner'):
                    head_num = search_info.get('head_number', 1)
                    self.log(f"[RACE] HEAD{head_num} finished but race already won by HEAD{search_info.get('race_winner', '?')} - discarding this download")

                    # Remove from tracking
                    if transfer_key in self.active_downloads:
                        del self.active_downloads[transfer_key]

                    # Delete the downloaded file (loser)
                    try:
                        import os
                        if os.path.exists(real_path):
                            os.remove(real_path)
                            self.log(f"[RACE] Deleted losing download: {os.path.basename(real_path)}")
                    except Exception as e:
                        self.debug_log(f"[RACE] Failed to delete losing file: {e}")

                    return  # Don't process this download further

                # Mark this head as the winner immediately (claim victory)
                search_info['race_winner'] = search_info.get('head_number', 1)

            # CASCADE MODE: Check if another head already won
            # Prevents race condition where multiple cascade heads finish simultaneously
            if search_info.get('cascade_mode'):
                # If cascade_winner is set, another head already claimed victory
                if search_info.get('cascade_winner'):
                    # Find which head number this is
                    head_num = 0
                    for cascade_head in search_info.get('cascade_heads', []):
                        if cascade_head['transfer_key'] == transfer_key:
                            head_num = cascade_head['index'] + 1
                            break

                    self.log(f"[CASCADE] HEAD{head_num} finished but race already won by HEAD{search_info.get('cascade_winner', '?')} - discarding this download")

                    # Remove from tracking
                    if transfer_key in self.active_downloads:
                        del self.active_downloads[transfer_key]

                    # Delete the downloaded file (loser)
                    try:
                        import os
                        if os.path.exists(real_path):
                            os.remove(real_path)
                            self.log(f"[CASCADE] Deleted losing download: {os.path.basename(real_path)}")
                    except Exception as e:
                        self.debug_log(f"[CASCADE] Failed to delete losing file: {e}")

                    return  # Don't process this download further

                # Find which head won (determine index)
                winning_head_index = -1
                winning_score = 0
                for cascade_head in search_info.get('cascade_heads', []):
                    if cascade_head['transfer_key'] == transfer_key:
                        winning_head_index = cascade_head['index']
                        winning_score = cascade_head['score']
                        break

                # Mark this head as the winner immediately (claim victory)
                search_info['cascade_winner'] = winning_head_index + 1

            # Send final 100% progress update before completion event
            track_id_safe = search_info.get('track_id', '') or f"{search_info.get('artist', '')}-{search_info.get('track', '')}".replace(' ', '')[:20]
            import os
            filename = os.path.basename(real_path)

            # Format COMPLETE message
            artist = search_info.get('artist', '')
            track = search_info.get('track', '')
            album = search_info.get('album', '')
            image_url = search_info.get('image_url', '')
            track_display = f"{artist} - {track}"

            # Determine which head completed (for logging)
            head_num = 1
            if search_info.get('race_mode'):
                head_num = search_info.get('head_number', 1)
            elif search_info.get('cascade_mode'):
                # Find which cascade head this is
                for cascade_head in search_info.get('cascade_heads', []):
                    if cascade_head['transfer_key'] == transfer_key:
                        head_num = cascade_head['index'] + 1
                        break

            # Send 100% progress to show completion in progress bar
            self._send_progress_update(track_id_safe, filename, 100, 0, 0, artist, track, album, real_path, image_url)
            self.log(f"░░░░░▒▒▒▒▒▓▓▓▓▓ HEAD{head_num} COMPLETE ____ {track_display}")

            # Remove from active tracking NOW so monitoring thread stops tracking it
            if transfer_key in self.active_downloads:
                del self.active_downloads[transfer_key]
                self.debug_log(f"[PROGRESS] Removed from tracking: {filename[:40]}")

            # RACE MODE CLEANUP: Abort all other racing downloads when one wins
            if search_info.get('race_mode'):
                race_heads = search_info.get('race_heads', [])
                winning_head = search_info.get('current_attempt', -1)

                self.log(f"[RACE] HEAD{winning_head + 1} WON (score: {search_info.get('head_score', 0)}) - Aborting {len(race_heads) - 1} other racing downloads...")
                aborted_count = 0

                for race_head in race_heads:
                    # Skip the winner
                    if race_head['index'] == winning_head:
                        continue

                    # Abort this racing head immediately
                    other_key = race_head['transfer_key']
                    if other_key in self.active_downloads:
                        self.log(f"[RACE] Aborting HEAD{race_head['index'] + 1} (score: {race_head['score']})")
                        if self._abort_transfer_by_path(
                            race_head['virtual_path'],
                            race_head['username'],
                            remove_from_tracking=True
                        ):
                            aborted_count += 1

                if aborted_count > 0:
                    self.log(f"[RACE] ✓ Aborted {aborted_count} losing download(s), winner proceeds to metadata processing")

                # Clear race mode and winner flag
                search_info['race_mode'] = False
                search_info['race_heads'] = []
                search_info['race_winner'] = None

            # CASCADE MODE CLEANUP: Abort all other cascade downloads when one wins
            elif search_info.get('cascade_mode'):
                cascade_heads = search_info.get('cascade_heads', [])
                winning_head_index = -1
                winning_score = 0

                # Find the winning head
                for cascade_head in cascade_heads:
                    if cascade_head['transfer_key'] == transfer_key:
                        winning_head_index = cascade_head['index']
                        winning_score = cascade_head['score']
                        break

                self.log(f"[CASCADE] HEAD{winning_head_index + 1} WON (score: {winning_score}) - Aborting {len(cascade_heads) - 1} other cascade downloads...")
                aborted_count = 0

                for cascade_head in cascade_heads:
                    # Skip the winner
                    if cascade_head['index'] == winning_head_index:
                        continue

                    # Abort this cascade head immediately
                    other_key = cascade_head['transfer_key']
                    if other_key in self.active_downloads:
                        self.log(f"[CASCADE] Aborting HEAD{cascade_head['index'] + 1} (score: {cascade_head['score']})")
                        if self._abort_transfer_by_path(
                            cascade_head['virtual_path'],
                            cascade_head['username'],
                            remove_from_tracking=True
                        ):
                            aborted_count += 1

                if aborted_count > 0:
                    self.log(f"[CASCADE] ✓ Aborted {aborted_count} losing download(s), winner proceeds to metadata processing")

                # Clear cascade mode and winner flag
                search_info['cascade_mode'] = False
                search_info['cascade_heads'] = []
                search_info['cascade_winner'] = None

            # FALLBACK CLEANUP: For non-race/cascade mode, abort other candidates (legacy retry logic)
            elif len(search_info.get('download_candidates', [])) > 1:
                candidates = search_info.get('download_candidates', [])
                current_attempt = search_info.get('current_attempt', 0)

                self.debug_log(f"[CLEANUP] Download succeeded (HEAD{current_attempt + 1}), aborting other attempts...")
                aborted_count = 0

                for i, candidate in enumerate(candidates):
                    # Skip the successful download
                    if i == current_attempt:
                        continue

                    # Abort other attempts
                    other_virtual_path = candidate['file']
                    other_username = candidate['user']

                    # Check if this download is still active
                    other_transfer_key = other_username + other_virtual_path
                    if other_transfer_key in self.active_downloads:
                        self.debug_log(f"[CLEANUP] Aborting HEAD{i + 1}: {other_virtual_path[:60]}")
                        if self._abort_transfer_by_path(other_virtual_path, other_username, remove_from_tracking=True):
                            aborted_count += 1

                if aborted_count > 0:
                    self.log(f"[CLEANUP] ✓ Aborted {aborted_count} parallel download(s)")

            # Send event to bridge for popup console
            self._send_event_to_bridge('success', f"Downloaded: {filename}", track_id_safe)

            search_type = search_info.get('type', 'track')

            if search_type == 'album':
                # Handle album track completion
                self._handle_album_track_completion(token, search_info, virtual_path, real_path)
            else:
                # Handle regular track completion
                self._handle_track_completion(token, search_info, virtual_path, real_path)

        except Exception as e:
            self.log(f" Error in download_finished_notification: {e}")
            import traceback
            self.log(f" Traceback: {traceback.format_exc()}")

    def _handle_track_completion(self, token, search_info, virtual_path, real_path):
        """Handle completion of a single track download."""
        # Debug: Log the paths we received
        self.debug_log(f"[META] Download complete - virtual_path: {virtual_path}")
        self.debug_log(f"[META] Download complete - real_path: {real_path}")

        # Send event to bridge for popup console
        import os
        filename = os.path.basename(real_path)
        track_id_safe = search_info.get('track_id', '') or f"{search_info.get('artist', '')}-{search_info.get('track', '')}".replace(' ', '')[:20]
        self._send_event_to_bridge('success', f"Download complete: {filename}", track_id_safe)

        # Process metadata in background thread to avoid blocking
        from threading import Thread
        thread = Thread(
            target=self._process_downloaded_file,
            args=(real_path, search_info),
            daemon=True
        )
        thread.start()

        # IMPORTANT: Don't delete from active_downloads immediately!
        # Let the progress monitoring thread detect completion and clean up after showing 100%
        # The monitoring thread will handle cleanup via _remove_progress_tracking
        # del self.active_downloads[virtual_path]  # DISABLED - let progress monitoring handle cleanup
        del self.active_searches[token]

    def _handle_album_track_completion(self, token, search_info, virtual_path, real_path):
        """
        Handle completion of an album track download.
        CRITICAL: Process metadata and move to folder IMMEDIATELY (not batched)
        """
        current_index = search_info['current_track_index']
        tracks_to_download = search_info['tracks_to_download']

        if current_index < len(tracks_to_download):
            current_track = tracks_to_download[current_index]
            track_info = current_track['track_info']

            self.log(f"[ALBUM] Track {current_index + 1}/{len(tracks_to_download)} downloaded: {track_info['track']}")

            # IMPROVED: Increment completed track count for cumulative progress calculation
            search_info['completed_track_count'] = search_info.get('completed_track_count', 0) + 1

            # CRITICAL: Create album folder after first track downloads (not before)
            # This way we can extract the download directory from the actual download path
            if not search_info.get('album_folder_created', False):
                import os
                download_dir = os.path.dirname(real_path)
                self.log(f"[ALBUM] Extracted download directory from first track: {download_dir}")

                album_folder = self._ensure_album_folder(search_info, download_dir)
                if album_folder:
                    search_info['album_folder_path'] = album_folder
                    search_info['album_folder_created'] = True
                    self.log(f"[ALBUM] Album folder created: {os.path.basename(album_folder)}")
                else:
                    self.log(f"[ALBUM] Could not create album folder, continuing anyway...")
                    search_info['album_folder_created'] = True  # Mark as attempted to avoid retries

            # CRITICAL CHANGE: Process metadata and move to folder IMMEDIATELY
            # Don't wait for all downloads to complete - process each track right away
            # This prevents batch processing pile-up that causes server crashes
            from threading import Thread
            thread = Thread(
                target=self._process_track_immediately,
                args=(real_path, track_info, token, current_index, search_info),
                daemon=True
            )
            thread.start()

        # IMPORTANT: Don't delete from active_downloads immediately!
        # Let progress monitoring thread show 100% completion before cleanup
        # del self.active_downloads[virtual_path]  # DISABLED - let progress monitoring handle cleanup

        # Move to next track
        search_info['current_track_index'] += 1
        self._download_next_album_track(token, search_info)

    def _process_track_immediately(self, real_path, track_info, token, track_index, search_info):
        """
        Process a single track immediately after download (not batched).
        CRITICAL: This is the new approach that prevents batch processing pile-up.
        """
        try:
            import time
            import os

            # Wait a moment for file to be fully written
            time.sleep(1)

            # Verify file exists
            if not os.path.exists(real_path):
                self.log(f"[ALBUM] File not found: {real_path}")
                return

            # Check if file is MP3 or FLAC
            file_lower = real_path.lower()
            if not (file_lower.endswith('.mp3') or file_lower.endswith('.flac')):
                self.log(f"[ALBUM] Unsupported format, skipping metadata: {real_path}")
                return

            # Get album folder path (created after first download)
            album_folder_path = search_info.get('album_folder_path')
            if not album_folder_path:
                self.log(f"[ALBUM] No album folder path, processing without move")
            else:
                self.log(f"[ALBUM] Album folder: {os.path.basename(album_folder_path)}")

            self.log(f"[ALBUM] Processing track {track_index + 1} metadata...")

            # Process metadata with album folder as target (will rename AND move)
            success, new_path = self._process_single_track_metadata(
                real_path,
                track_info,
                token,
                track_index,
                target_folder=album_folder_path
            )

            if success:
                if album_folder_path:
                    self.log(f"[ALBUM] Track {track_index + 1} moved to album: {os.path.basename(new_path)}")
                else:
                    self.log(f"[ALBUM] Track {track_index + 1} complete: {os.path.basename(new_path)}")
            else:
                self.log(f"[ALBUM] Track {track_index + 1} failed metadata processing")

        except Exception as e:
            self.debug_log(f"[ALBUM] Error processing track {track_index + 1} immediately: {e}")
            import traceback
            self.debug_log(f"[ALBUM] Traceback: {traceback.format_exc()}")

    def _process_album_metadata_batch_safe(self, downloaded_tracks, search_info):
        """
        Safe wrapper for batch metadata processing with comprehensive error handling.
        """
        try:
            self._process_album_metadata_batch(downloaded_tracks, search_info)
        except Exception as e:
            self.log(f"[ALBUM-META] FATAL ERROR in batch processing: {e}")
            import traceback
            self.log(f"[ALBUM-META] Traceback: {traceback.format_exc()}")

    def _process_album_metadata_batch(self, downloaded_tracks, search_info):
        """
        Process metadata for all album tracks in sequence.
        IMPROVED: Uses prefetched metadata cache to eliminate wait time and reduce server load.

        Updates the downloaded_tracks list with renamed file paths.
        """
        import time

        total_tracks = len(downloaded_tracks)
        successful = 0
        failed = 0
        token = search_info.get('token', '')

        self.log(f"[ALBUM-META] Starting batch of {total_tracks} tracks...")

        for i, track_data in enumerate(downloaded_tracks):
            try:
                file_path = track_data['file_path']
                track_info = track_data['track_info']
            except (KeyError, TypeError) as e:
                self.log(f"[ALBUM-META] Invalid track data at index {i}: {e}")
                failed += 1
                continue

            try:
                self.log(f"[ALBUM-META] Processing {i + 1}/{total_tracks}: {track_info.get('track', 'Unknown')}")

                # Process this track's metadata with prefetched cache
                success, new_path = self._process_single_track_metadata(file_path, track_info, token, i)

                if success:
                    successful += 1
                    # Update the file path in downloaded_tracks with the renamed path
                    track_data['file_path'] = new_path
                    self.log(f"[ALBUM-META] Track {i + 1}/{total_tracks} complete")
                else:
                    failed += 1
                    self.log(f"[ALBUM-META] Track {i + 1}/{total_tracks} failed")

                # CRITICAL: Add delay between tracks to prevent server overload
                # The server does background work (cover download, tag writing) that takes time
                # Processing tracks too quickly causes concurrent background jobs to pile up
                if i < total_tracks - 1:
                    time.sleep(2)  # 2 second delay to let server finish background work

            except Exception as e:
                self.log(f"[ALBUM-META] Exception processing track {i + 1}: {e}")
                import traceback
                self.log(f"[ALBUM-META] Traceback: {traceback.format_exc()}")
                failed += 1
                # Continue with next track even on error

        self.log(f"[ALBUM-META] Batch complete: {successful} succeeded, {failed} failed")

        # Cleanup: Remove cached metadata for this album
        if token:
            keys_to_remove = [k for k in self.metadata_cache.keys() if k[0] == token]
            for key in keys_to_remove:
                del self.metadata_cache[key]
            if keys_to_remove:
                self.log(f"[ALBUM-META] Cleaned up {len(keys_to_remove)} cached metadata entries")

    def _process_single_track_metadata(self, file_path, track_info, token=None, track_index=None, target_folder=None):
        """
        Process metadata for a single track.
        IMPROVED: Uses prefetched metadata cache to skip Spotify page fetch, dramatically reducing processing time.
        CRITICAL: Now supports target_folder to move file immediately after processing.

        Args:
            file_path: Path to the downloaded file
            track_info: Track metadata dict
            token: Search token (optional, for cache lookup)
            track_index: Track index in album (optional, for cache lookup)
            target_folder: Target folder to move file to after processing (optional, for album downloads)

        Returns:
            Tuple of (success: bool, new_path: str)
            - success: True if processing succeeded, False otherwise
            - new_path: The renamed/moved file path if successful, otherwise original path
        """
        try:
            from urllib.request import urlopen, Request
            from urllib.error import URLError
            import json
            import os
            import time

            # Verify file exists and is MP3
            if not os.path.exists(file_path):
                self.log(f"[ALBUM-META] File not found: {file_path}")
                return (False, file_path)

            # Check if file is MP3 or FLAC
            file_lower = file_path.lower()
            if not (file_lower.endswith('.mp3') or file_lower.endswith('.flac')):
                self.log(f"[ALBUM-META] Unsupported format (only MP3/FLAC), skipping: {file_path}")
                return (False, file_path)

            # IMPROVED: Check if we have prefetched ALBUM metadata in cache (with TTL check)
            album_metadata = None
            if token is not None:
                cache_key = (token, 'album')
                cached_entry = self.metadata_cache.get(cache_key)
                if cached_entry:
                    # Check if cache entry is still valid
                    age = time.time() - cached_entry.get('timestamp', 0)
                    if age < self.metadata_cache_max_age:
                        album_metadata = cached_entry.get('data')
                        self.log(f"[ALBUM-META]   Using cached album metadata (year={album_metadata.get('year', 'N/A')})")
                    else:
                        # Expired, remove it
                        del self.metadata_cache[cache_key]
                        self.log(f"[ALBUM-META]   Cached metadata expired (age={int(age)}s)")

            # Prepare request data with track number and prefetched album metadata (using camelCase for Node.js)
            payload = {
                'filePath': file_path,  # camelCase for Node.js
                'artist': track_info.get('artist', ''),
                'track': track_info.get('track', ''),
                'album': track_info.get('album', ''),
                'trackId': track_info.get('track_id', ''),  # camelCase for Node.js
                'trackNumber': track_info.get('track_number', 0),  # camelCase for Node.js
                'headNumber': track_info.get('head_number', 1),  # camelCase for Node.js
                'headScore': track_info.get('head_score', 0)  # camelCase for Node.js
            }

            # Add prefetched album metadata if available (server will skip Spotify page fetch)
            if album_metadata:
                payload['prefetchedYear'] = album_metadata.get('year', '')  # camelCase for Node.js
                payload['prefetchedImageUrl'] = album_metadata.get('image_url', '')  # camelCase for Node.js

            # Add target folder if specified (server will move file after processing)
            if target_folder:
                payload['targetFolder'] = target_folder  # camelCase for Node.js

            # Send to Metadata Worker with REDUCED timeout (server responds immediately now)
            url = f"{self.settings['metadata_url']}/process-metadata"
            req = Request(url,
                         data=json.dumps(payload).encode('utf-8'),
                         headers={'Content-Type': 'application/json'})

            # CRITICAL FIX: Timeout reduced to 15s (server replies after rename, not after full processing)
            with urlopen(req, timeout=15) as response:
                result = json.loads(response.read().decode('utf-8'))

                if result.get('success'):
                    new_path = result.get('new_path', file_path)
                    if result.get('renamed'):
                        # Format FINISHED message for album tracks
                        artist = track_info.get('artist', '')
                        track_name = track_info.get('track', '')
                        track_display = f"{artist} - {track_name}"
                        head_num = track_info.get('head_number', 1)
                        self.log(f"▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  HEAD{head_num} FINISHED  ____ {track_display}        ^~~~~~~<:===<")
                    return (True, new_path)
                else:
                    self.log(f"[ALBUM-META]   Failed: {result.get('error', 'Unknown error')}")
                    return (False, file_path)

        except URLError as e:
            error_msg = str(e).lower()
            error_repr = repr(e).lower()

            # Check if this is a server crash (connection refused/reset)
            is_crash = any(x in error_msg or x in error_repr for x in [
                'connection refused', 'connection reset', 'forcibly closed',
                'cannot connect', 'connection aborted', 'winerror 10054', '10054'
            ])

            # Check if this is a timeout (might mean server is stuck)
            is_timeout = 'timed out' in error_msg

            # If timeout, check if server is still alive
            if is_timeout and not is_crash:
                self.log(f"[ALBUM-META] Timeout, checking metadata worker health...")
                try:
                    ping_url = f"{self.settings['metadata_url']}/ping"
                    ping_req = Request(ping_url)
                    with urlopen(ping_req, timeout=2) as ping_response:
                        if ping_response.getcode() == 200:
                            # Server is alive but slow - just fail this track
                            self.log(f"[ALBUM-META] Server alive but slow, skipping track")
                            return (False, file_path)
                except:
                    # Server not responding - treat as crash
                    self.log(f"[ALBUM-META] Server not responding after timeout")
                    is_crash = True

            # If not a crash or stuck server, just fail
            if not is_crash:
                self.log(f"[ALBUM-META] Error: {e}")
                return (False, file_path)

            # Server crashed or stuck - wait for restart and retry
            self.log(f"[ALBUM-META] Server restarting, will retry...")
            max_wait = 30
            for attempt in range(max_wait):
                time.sleep(1)
                try:
                    # Try to ping the metadata worker
                    ping_url = f"{self.settings['metadata_url']}/ping"
                    ping_req = Request(ping_url)
                    with urlopen(ping_req, timeout=2) as ping_response:
                        if ping_response.getcode() == 200:
                            self.log(f"[ALBUM-META] Metadata worker back online after {attempt + 1}s")
                            time.sleep(2)  # Give server time to stabilize

                            # Check if file was already renamed before the crash
                            actual_file_path = file_path
                            if not os.path.exists(file_path):
                                # Try to find the renamed file
                                dir_path = os.path.dirname(file_path)
                                track_name = track_info.get('track', '')
                                artist_name = track_info.get('artist', '')
                                track_num = track_info.get('track_number', 0)

                                possible_names = [
                                    f"{track_num:02d} {artist_name} - {track_name}.mp3",
                                    f"{track_num:02d} - {track_name}.mp3",
                                    f"{track_num:02d} {track_name}.mp3"
                                ]

                                for possible_name in possible_names:
                                    possible_path = os.path.join(dir_path, possible_name)
                                    if os.path.exists(possible_path):
                                        self.log(f"[ALBUM-META] File was already renamed to: {possible_name}")
                                        actual_file_path = possible_path
                                        break

                            # Check if rename was successful
                            if os.path.exists(actual_file_path) and actual_file_path != file_path:
                                if artist_name and artist_name in os.path.basename(actual_file_path):
                                    self.log(f"[ALBUM-META] Track was already processed before crash")
                                    return (True, actual_file_path)
                                else:
                                    self.log(f"[ALBUM-META] File renamed but missing artist name, needs retry")

                            # Retry the track
                            self.log(f"[ALBUM-META] Retrying failed track: {os.path.basename(file_path)}")
                            return self._process_single_track_metadata(file_path, track_info, token, track_index, target_folder)
                except:
                    pass  # Server not ready yet, continue waiting

            # Server didn't come back online
            self.log(f"[ALBUM-META] Server did not restart within {max_wait}s")
            return (False, file_path)
        except Exception as e:
            error_msg = str(e).lower()
            error_repr = repr(e).lower()
            # Check if this is a server crash (connection refused/reset)
            is_server_crash = any(x in error_msg or x in error_repr for x in [
                'connection refused', 'connection reset', 'forcibly closed',
                'cannot connect', 'connection aborted', 'winerror 10054', '10054'
            ])

            if is_server_crash:
                self.log(f"[ALBUM-META] Server restarting, will retry...")

                # Wait for server to restart (up to 30 seconds)
                max_wait = 30
                for attempt in range(max_wait):
                    time.sleep(1)
                    try:
                        # Try to ping the metadata worker
                        ping_url = f"{self.settings['metadata_url']}/ping"
                        ping_req = Request(ping_url)
                        with urlopen(ping_req, timeout=2) as ping_response:
                            if ping_response.getcode() == 200:
                                self.log(f"[ALBUM-META] Metadata worker back online after {attempt + 1}s")
                                time.sleep(2)  # Give server time to stabilize

                                # Check if file was already renamed before the crash
                                # The server might have renamed the file before crashing
                                actual_file_path = file_path
                                if not os.path.exists(file_path):
                                    # Try to find the renamed file (format: "NN Artist - Track.mp3")
                                    dir_path = os.path.dirname(file_path)
                                    track_name = track_info.get('track', '')
                                    artist_name = track_info.get('artist', '')
                                    track_num = track_info.get('track_number', 0)

                                    # Try various possible renamed formats
                                    possible_names = [
                                        f"{track_num:02d} {artist_name} - {track_name}.mp3",
                                        f"{track_num:02d} - {track_name}.mp3",
                                        f"{track_num:02d} {track_name}.mp3"
                                    ]

                                    for possible_name in possible_names:
                                        possible_path = os.path.join(dir_path, possible_name)
                                        if os.path.exists(possible_path):
                                            self.log(f"[ALBUM-META] File was already renamed to: {possible_name}")
                                            actual_file_path = possible_path
                                            break

                                # If file exists AND was properly renamed with artist name, consider it successful
                                # Only the first format includes the artist name, others are incomplete
                                if os.path.exists(actual_file_path) and actual_file_path != file_path:
                                    # Verify it has the correct format with artist name
                                    if artist_name and artist_name in os.path.basename(actual_file_path):
                                        self.log(f"[ALBUM-META] Track was already processed before crash")
                                        return (True, actual_file_path)
                                    else:
                                        self.log(f"[ALBUM-META] File renamed but missing artist name, needs retry")
                                        # Fall through to retry

                                # File doesn't exist in any form, try retry
                                self.log(f"[ALBUM-META] Retrying failed track: {os.path.basename(file_path)}")
                                return self._process_single_track_metadata(file_path, track_info, token, track_index, target_folder)
                    except:
                        pass  # Server not ready yet, continue waiting

                # Server didn't come back online
                self.log(f"[ALBUM-META] Server did not restart within {max_wait}s")
                return (False, file_path)

            # Not a crash, just a regular error
            self.log(f"[ALBUM-META] Error: {e}")
            return (False, file_path)

    def _process_album_track_metadata(self, file_path, track_info, search_info):
        """Process metadata for an album track with track number."""
        try:
            from urllib.request import urlopen, Request
            from urllib.error import URLError
            import json
            import os

            # Wait for file to be fully written
            time.sleep(2)

            self.log(f"[ALBUM-META] Starting processing for: {os.path.basename(file_path)}")
            self.log(f"[ALBUM-META] Track #{track_info.get('track_number', 0)}: {track_info.get('track', '')}")

            # Verify file exists and is MP3
            if not os.path.exists(file_path):
                self.log(f"[ALBUM-META] File not found: {file_path}")
                return

            # Check if file is MP3 or FLAC
            file_lower = file_path.lower()
            if not (file_lower.endswith('.mp3') or file_lower.endswith('.flac')):
                self.log(f"[ALBUM-META] Unsupported format (only MP3/FLAC), skipping: {file_path}")
                return

            # IMPROVED: Check if we have prefetched ALBUM metadata in cache (with TTL check)
            album_metadata = None
            token = search_info.get('token')
            if token is not None:
                cache_key = (token, 'album')
                cached_entry = self.metadata_cache.get(cache_key)
                if cached_entry:
                    # Check if cache entry is still valid
                    age = time.time() - cached_entry.get('timestamp', 0)
                    if age < self.metadata_cache_max_age:
                        album_metadata = cached_entry.get('data')
                        self.log(f"[ALBUM-META]   Using cached album metadata (year={album_metadata.get('year', 'N/A')})")
                    else:
                        # Expired, remove it
                        del self.metadata_cache[cache_key]
                        self.log(f"[ALBUM-META]   Cached metadata expired (age={int(age)}s)")

            # Prepare request data with track number (using camelCase for Node.js)
            payload = {
                'filePath': file_path,  # camelCase for Node.js
                'artist': track_info.get('artist', ''),
                'track': track_info.get('track', ''),
                'album': track_info.get('album', ''),
                'trackId': track_info.get('track_id', ''),  # camelCase for Node.js
                'trackNumber': track_info.get('track_number', 0),  # camelCase for Node.js
                'headNumber': search_info.get('head_number', 1),  # camelCase for Node.js
                'headScore': search_info.get('head_score', 0)  # camelCase for Node.js
            }

            # Add prefetched album metadata if available (server will skip Spotify page fetch)
            if album_metadata:
                payload['prefetchedYear'] = album_metadata.get('year', '')  # camelCase for Node.js
                payload['prefetchedImageUrl'] = album_metadata.get('image_url', '')  # camelCase for Node.js

            # Add target folder if specified (server will move file after processing)
            target_folder = search_info.get('album_folder_path')
            if target_folder:
                payload['targetFolder'] = target_folder  # camelCase for Node.js

            self.debug_log(f"[ALBUM-META] Sending request to metadata server...")

            # Send to Metadata Worker with shorter timeout to avoid blocking
            url = f"{self.settings['metadata_url']}/process-metadata"
            req = Request(url,
                         data=json.dumps(payload).encode('utf-8'),
                         headers={'Content-Type': 'application/json'})

            with urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode('utf-8'))

                if result.get('success'):
                    if result.get('renamed'):
                        # Format FINISHED message for album tracks
                        artist = track_info.get('artist', '')
                        track_name = track_info.get('track', '')
                        track_display = f"{artist} - {track_name}"
                        head_num = search_info.get('head_number', 1)
                        self.log(f"▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  HEAD{head_num} FINISHED  ____ {track_display}        ^~~~~~~<:===<")

                        # Update the file path in downloaded_tracks
                        if 'downloaded_tracks' in search_info:
                            for i, path in enumerate(search_info['downloaded_tracks']):
                                if path == file_path:
                                    search_info['downloaded_tracks'][i] = result['new_path']
                                    self.debug_log(f"[ALBUM-META]   Updated tracking path")
                                    break
                else:
                    self.log(f"[ALBUM-META] Failed: {result.get('error', 'Unknown error')}")

        except URLError as e:
            self.log(f"[ALBUM-META] Cannot reach Node server: {e}")
            self.log(f"[ALBUM-META] Make sure bridge server is running")
        except Exception as e:
            self.log(f"[ALBUM-META] Error: {e}")
            import traceback
            self.log(f"[ALBUM-META] {traceback.format_exc()}")

    def _monitor_album_download(self, token, search_info, current_time):
        """Monitor an album download to detect stuck/failed track downloads."""
        try:
            # Check if download has started
            if not search_info.get('download_started_at'):
                return

            # Check if we're currently downloading a track
            current_index = search_info.get('current_track_index', 0)
            tracks_to_download = search_info.get('tracks_to_download', [])

            # If we've finished all tracks, skip monitoring
            if current_index >= len(tracks_to_download):
                return

            # Check how long the current track download has been active
            download_elapsed = current_time - search_info['download_started_at']

            # EARLY VALIDATION: Check first track within 15 seconds
            # If the first track doesn't start transferring within 15s, try a different folder
            if current_index == 0 and download_elapsed > 15:
                current_track = tracks_to_download[current_index]
                virtual_path = current_track['file_path']

                # Check if download started transferring
                download_found = False
                download_started_transferring = False

                if hasattr(self.core, 'downloads') and hasattr(self.core.downloads, 'transfers'):
                    for transfer in self.core.downloads.transfers.values():
                        if hasattr(transfer, 'virtual_path') and transfer.virtual_path == virtual_path:
                            download_found = True
                            if hasattr(transfer, 'current_byte_offset') and transfer.current_byte_offset is not None and transfer.current_byte_offset > 0:
                                download_started_transferring = True
                            break

                # If first track isn't transferring after 15s, try next best folder
                if not download_started_transferring:
                    self.log(f"[ALBUM] First track not transferring after 15s")

                    # Remove all queued tracks from the current folder attempt
                    # This prevents orphaned downloads in the queue when switching folders
                    if hasattr(self.core, 'downloads') and hasattr(self.core.downloads, 'transfers'):
                        transfers_to_remove = []

                        # Find all tracks from this album in the download queue
                        for track in tracks_to_download:
                            track_path = track['file_path']

                            # Find matching transfer
                            for transfer in self.core.downloads.transfers.values():
                                if hasattr(transfer, 'virtual_path') and transfer.virtual_path == track_path:
                                    transfers_to_remove.append(transfer)
                                    break

                        # Remove all found transfers using the hierarchical abort approach
                        if transfers_to_remove:
                            self.log(f"[ALBUM] Removing {len(transfers_to_remove)} queued track(s) from previous folder")

                            # Try clear_downloads FIRST (removes from UI)
                            cleared = False
                            if hasattr(self.core.downloads, 'clear_downloads'):
                                try:
                                    self.core.downloads.clear_downloads(transfers_to_remove)
                                    self.log(f"[ALBUM] Cleared {len(transfers_to_remove)} transfer(s) from queue")
                                    cleared = True
                                except Exception as e:
                                    self.log(f"[ALBUM] clear_downloads failed: {e}")

                            # Fallback to abort_downloads if clear didn't work
                            if not cleared:
                                if hasattr(self.core.downloads, 'abort_downloads'):
                                    try:
                                        self.core.downloads.abort_downloads(transfers_to_remove)
                                        self.log(f"[ALBUM] Aborted {len(transfers_to_remove)} transfer(s)")
                                    except Exception as e:
                                        self.log(f"[ALBUM] abort_downloads failed: {e}")
                                        # Try abort_transfer individually as last resort
                                        if hasattr(self.core.downloads, 'abort_transfer'):
                                            for transfer in transfers_to_remove:
                                                try:
                                                    self.core.downloads.abort_transfer(transfer)
                                                except:
                                                    pass
                                elif hasattr(self.core.downloads, 'abort_transfer'):
                                    # Abort each transfer individually
                                    for transfer in transfers_to_remove:
                                        try:
                                            self.core.downloads.abort_transfer(transfer)
                                        except:
                                            pass

                        # Remove all tracks from tracking
                        for track in tracks_to_download:
                            track_path = track['file_path']
                            if track_path in self.active_downloads:
                                del self.active_downloads[track_path]

                    # Try next best folder
                    folder_candidates = search_info.get('folder_candidates', [])

                    # Find the next candidate (skip the one we just tried)
                    current_folder = search_info.get('best_folder')
                    tried_folders = search_info.get('tried_folders', [])
                    if current_folder:
                        tried_folders.append(current_folder['folder_path'])
                        search_info['tried_folders'] = tried_folders

                    # Find next untried folder
                    next_folder = None
                    for candidate in folder_candidates:
                        if candidate['folder_path'] not in tried_folders:
                            next_folder = candidate
                            break

                    if next_folder:
                        self.log(f"[ALBUM] 🔄 Trying next folder (score: {int(next_folder['score'])})")
                        self.log(f"[ALBUM] From user: {next_folder['user']}")

                        # Reset for new folder
                        search_info['best_folder'] = next_folder
                        search_info['current_track_index'] = 0
                        search_info['download_started_at'] = None
                        search_info['downloaded_tracks'] = []

                        # Re-match tracks for new folder
                        tracks_to_download = self._match_album_tracks(search_info, next_folder)
                        if tracks_to_download:
                            search_info['tracks_to_download'] = tracks_to_download
                            self.log(f"[ALBUM] Matched {len(tracks_to_download)}/{len(search_info['tracks'])} tracks in new folder")
                            self._download_next_album_track(token, search_info)
                        else:
                            self.log(f"[ALBUM] Could not match tracks in new folder, giving up")
                            del self.active_searches[token]
                    else:
                        self.log(f"[ALBUM] No more folders to try, giving up")
                        del self.active_searches[token]

                    return

            # After 90 seconds, check if the download is stuck
            if download_elapsed > 90:
                current_track = tracks_to_download[current_index]
                virtual_path = current_track['file_path']

                # Check if download is still in the active_downloads tracking
                if virtual_path not in self.active_downloads:
                    # Download isn't being tracked - might have failed silently
                    self.log(f"[ALBUM] Track {current_index + 1} not in tracking (after 90s)")
                    self.log(f"[ALBUM] Skipping to next track...")

                    # Move to next track
                    search_info['current_track_index'] += 1
                    search_info['download_started_at'] = None
                    self._download_next_album_track(token, search_info)
                    return

                # Check download status in core.downloads
                download_found = False
                download_started_transferring = False
                transfer_obj = None

                if hasattr(self.core, 'downloads') and hasattr(self.core.downloads, 'transfers'):
                    for transfer in self.core.downloads.transfers.values():
                        if hasattr(transfer, 'virtual_path') and transfer.virtual_path == virtual_path:
                            download_found = True
                            transfer_obj = transfer
                            if hasattr(transfer, 'current_byte_offset') and transfer.current_byte_offset is not None and transfer.current_byte_offset > 0:
                                download_started_transferring = True
                            break

                # If download is stuck or not found, skip to next track
                should_skip = False
                skip_reason = ""

                if not download_found:
                    should_skip = True
                    skip_reason = "Download disappeared from queue"
                elif not download_started_transferring:
                    should_skip = True
                    skip_reason = "Download stuck in queue (not transferring)"

                if should_skip:
                    self.log(f"[ALBUM] Track {current_index + 1}: {skip_reason} (after 90s)")
                    self.log(f"[ALBUM] Skipping to next track...")

                    # Remove stuck download from queue using hierarchical abort approach
                    if transfer_obj:
                        # Try clear_downloads FIRST (removes from UI)
                        cleared = False
                        if hasattr(self.core.downloads, 'clear_downloads'):
                            try:
                                self.core.downloads.clear_downloads([transfer_obj])
                                self.log(f"[ALBUM] Cleared stuck track from queue")
                                cleared = True
                            except Exception as e:
                                self.log(f"[ALBUM] clear_downloads failed: {e}")

                        # Fallback to abort_downloads if clear didn't work
                        if not cleared:
                            if hasattr(self.core.downloads, 'abort_downloads'):
                                try:
                                    self.core.downloads.abort_downloads([transfer_obj])
                                    self.log(f"[ALBUM] Aborted stuck track")
                                except Exception as e:
                                    self.log(f"[ALBUM] abort_downloads failed: {e}")
                                    # Try abort_transfer as last resort
                                    if hasattr(self.core.downloads, 'abort_transfer'):
                                        try:
                                            self.core.downloads.abort_transfer(transfer_obj)
                                        except:
                                            pass
                            elif hasattr(self.core.downloads, 'abort_transfer'):
                                try:
                                    self.core.downloads.abort_transfer(transfer_obj)
                                except:
                                    pass

                    # Remove from tracking
                    if virtual_path in self.active_downloads:
                        del self.active_downloads[virtual_path]

                    # Move to next track
                    search_info['current_track_index'] += 1
                    search_info['download_started_at'] = None
                    self._download_next_album_track(token, search_info)

            # Overall timeout - 30 minutes for entire album
            album_elapsed = current_time - search_info['timestamp']
            if album_elapsed > 1800:
                self.log(f"[ALBUM] Album download timeout (30 minutes)")

                # Finalize with whatever we have
                if search_info.get('downloaded_tracks'):
                    self.log(f"[ALBUM] Finalizing with {len(search_info['downloaded_tracks'])} downloaded tracks...")
                    self._finalize_album_download(token, search_info)
                else:
                    self.log(f"[ALBUM] No tracks downloaded, aborting")
                    del self.active_searches[token]

        except Exception as e:
            self.debug_log(f"[ALBUM] Error monitoring album download: {e}")
            import traceback
            self.debug_log(f"[ALBUM] Traceback: {traceback.format_exc()}")

    def _monitor_downloads(self):
        """Monitor active downloads and trigger fallback if stuck or failed."""
        if not self.active_searches:
            return

        current_time = time.time()

        for token, search_info in list(self.active_searches.items()):
            try:
                # Handle album download monitoring separately
                if search_info.get('type') == 'album':
                    self._monitor_album_download(token, search_info, current_time)
                    continue

                # Skip if download not started yet
                if search_info.get('current_attempt', -1) < 0:
                    continue

                # Check how long download has been active
                download_elapsed = current_time - search_info['download_started_at']

                # Check download status after 60 seconds
                if download_elapsed > 60:
                    last_path = search_info['last_download_path']

                    # Check if download is still in downloads list and its status
                    download_found = False
                    download_started_transferring = False
                    download_status = None
                    transfer_obj = None

                    # Look for this download in core.downloads
                    if hasattr(self.core, 'downloads') and hasattr(self.core.downloads, 'transfers'):
                        for transfer in self.core.downloads.transfers.values():
                            if hasattr(transfer, 'virtual_path') and transfer.virtual_path == last_path:
                                download_found = True
                                transfer_obj = transfer
                                if hasattr(transfer, 'status'):
                                    download_status = transfer.status
                                # Check if any bytes have been transferred
                                if hasattr(transfer, 'current_byte_offset') and transfer.current_byte_offset is not None and transfer.current_byte_offset > 0:
                                    download_started_transferring = True
                                break

                    # If download is stuck in queue (not started) or failed, try next candidate
                    should_fallback = False
                    fallback_reason = ""

                    if not download_found:
                        should_fallback = True
                        fallback_reason = "Download disappeared from queue"
                    elif not download_started_transferring:
                        should_fallback = True
                        fallback_reason = "Download stuck in queue (not transferring)"
                        # Try to abort the stuck download
                        if transfer_obj and hasattr(self.core.downloads, 'abort_transfer'):
                            try:
                                self.core.downloads.abort_transfer(transfer_obj)
                            except:
                                pass
                    elif download_status and str(download_status) in ['USER_LOGGED_OFF', 'CONNECTION_CLOSED', 'CONNECTION_TIMEOUT', 'FILTERED', 'CANCELLED']:
                        should_fallback = True
                        fallback_reason = f"Download failed: {download_status}"

                    if should_fallback:
                        self.log(f"[DL] {fallback_reason} (after 60s)")
                        self._try_next_download_candidate(token, search_info, fallback_reason)

                # Cleanup if download has been active for too long (5 minutes total)
                search_elapsed = current_time - search_info['timestamp']
                if search_elapsed > 300:
                    self.log(f"[DL] Timeout - removing search after 5 minutes")
                    # Clean up tracking
                    if search_info['last_download_path'] in self.active_downloads:
                        del self.active_downloads[search_info['last_download_path']]
                    del self.active_searches[token]

            except Exception as e:
                self.debug_log(f"[DL] Error monitoring downloads for search {token}: {e}")
                import traceback
                self.debug_log(f"[DL] Traceback: {traceback.format_exc()}")

    def _trigger_album_search(self, search_data):
        """
        Trigger an album search and track it for folder-based downloading.

        Args:
            search_data: Dictionary containing album information and tracks
        """
        try:
            query = search_data['query']
            album_id = search_data.get('album_id', '')
            album_name = search_data.get('album_name', '')
            album_artist = search_data.get('album_artist', '')
            year = search_data.get('year', '')
            image_url = search_data.get('image_url', '')
            tracks = search_data.get('tracks', [])
            auto_download = search_data.get('auto_download', False)
            metadata_override = search_data.get('metadata_override', True)
            format_preference = search_data.get('format_preference', 'mp3')

            self.log(f"░░░░░ HEAD1 HUNTING ____ Search Started: {album_artist} - {album_name}")
            self.debug_log(f"[ALBUM] {len(tracks)} tracks, auto_download={auto_download}, format={format_preference.upper()}")

            # Trigger search for album folder
            # Get tokens BEFORE the search to compare (do_search sometimes returns None)
            tokens_before = set(self.core.search.searches.keys()) if hasattr(self.core.search, 'searches') else set()

            search_token = self.core.search.do_search(query, "global")

            # If do_search returns None, find the newly created token by comparing before/after
            if not search_token and hasattr(self.core.search, 'searches'):
                tokens_after = set(self.core.search.searches.keys())
                new_tokens = tokens_after - tokens_before

                if new_tokens:
                    # Use the newly created token
                    search_token = list(new_tokens)[0]
                elif tokens_after:
                    # Fallback: use most recent token
                    search_token = max(tokens_after)

            if not search_token:
                self.log(f"[ALBUM] Failed to get search token")
                return False

            # Track album search
            if auto_download and search_token:
                self.active_searches[search_token] = {
                    'type': 'album',
                    'query': query,
                    'album_id': album_id,
                    'album_name': album_name,
                    'album_artist': album_artist,
                    'year': year,
                    'image_url': image_url,
                    'tracks': tracks,  # List of track dicts with track_number, artist, track, album, track_id, duration
                    'auto_download': auto_download,
                    'metadata_override': metadata_override,
                    'format_preference': format_preference,
                    'timestamp': time.time(),
                    'folder_candidates': [],  # List of {user, folder_path, tracks_found, score}
                    'best_folder': None,  # {user, folder_path, tracks}
                    'tracks_to_download': [],  # List of {track_info, file_path, user}
                    'downloaded_tracks': [],  # List of file paths after download
                    'current_track_index': 0,
                    'download_started_at': None,
                    'result_count': 0
                }
                self.log(f"[ALBUM] Tracking album search (token={search_token})")
            else:
                self.log(f"[ALBUM] Not tracking (auto_download disabled)")

            return True

        except Exception as e:
            self.log(f"[ALBUM] ERROR: {type(e).__name__}: {str(e)}")
            import traceback
            self.debug_log(f"[ALBUM] Traceback: {traceback.format_exc()}")
            return False

    def _poll_queue(self):
        """Poll the bridge server for new searches."""
        self.log("Polling loop started")

        # Wait for Nicotine+ to connect to the network before processing searches
        connection_wait_start = time.time()
        max_wait_time = 60  # 60 seconds max wait (reduced from 5 min)

        while self.running and self.waiting_for_connection:
            try:
                # Check if Nicotine+ is online
                if self._is_nicotine_online():
                    self.nicotine_online = True
                    self.waiting_for_connection = False
                    self.log("NICOTINE+ ONLINE → Plugin ready!")
                    break

                # Check if we've waited too long
                elapsed = time.time() - connection_wait_start
                if elapsed > max_wait_time:
                    # After 60s, assume we're ready and let it try
                    self.nicotine_online = True
                    self.waiting_for_connection = False
                    self.log("Connection wait timeout - activating plugin")
                    break

                # Log progress every 10 seconds
                if int(elapsed) % 10 == 0 and elapsed > 0:
                    self.log(f" Waiting for Nicotine+ connection... ({int(elapsed)}s)")

                # Wait before checking again
                time.sleep(1)

            except Exception as e:
                self.log(f" Error checking connection: {e}")
                # Activate anyway on error to avoid blocking
                self.nicotine_online = True
                self.waiting_for_connection = False
                break

        while self.running:
            try:
                # Check if server is running and auto-restart if it went offline
                server_running = self._is_server_running()
                if self.server_was_running and not server_running:
                    # Server went offline - attempt auto-restart (normal during metadata processing)
                    self.log("Bridge server restarting...")
                    self.server_was_running = False

                    # Attempt to restart the server
                    if self.settings.get('auto_start_server', True):
                        # First, clean up any zombie processes
                        self._cleanup_server_process()

                        # Wait a moment for port to be released
                        time.sleep(1)

                        # Now start fresh server
                        if self._start_server():
                            self.log("Bridge server restarted successfully")
                        else:
                            self.log("Failed to restart bridge server - please restart Nicotine+ manually")
                    else:
                        self.log("Auto-start disabled - please restart Nicotine+ manually")
                elif server_running:
                    self.server_was_running = True

                # Periodically check connection status (but don't block)
                # Only check every 30 seconds to avoid overhead
                if hasattr(self, '_last_connection_check'):
                    if time.time() - self._last_connection_check > 30:
                        self.nicotine_online = self._is_nicotine_online()
                        self._last_connection_check = time.time()
                else:
                    self._last_connection_check = time.time()
                # Fetch pending searches from server
                searches = self._get_pending_searches()

                # IMPROVED: Update activity tracking if we have searches
                if searches:
                    self.last_activity_time = time.time()

                # Process each search
                for search in searches:
                    timestamp = search.get('timestamp')

                    if not timestamp:
                        continue

                    # Skip if we've already processed this timestamp
                    if timestamp in self.processed_timestamps:
                        continue

                    # Periodic cleanup of old data
                    self._cleanup_old_data()

                    # Check if this is an album search or track search
                    search_type = search.get('type', 'track')

                    if search_type == 'album':
                        # Handle album search
                        success = self._trigger_album_search(search)
                    else:
                        # Handle regular track search
                        query = search.get('query')
                        artist = search.get('artist', '')
                        track = search.get('track', '')
                        album = search.get('album', '')
                        track_id = search.get('track_id', '')
                        duration = search.get('duration', 0)
                        image_url = search.get('image_url', '')
                        auto_download = search.get('auto_download', False)
                        metadata_override = search.get('metadata_override', True)
                        format_preference = search.get('format_preference', 'mp3')

                        if not query:
                            continue

                        success = self._trigger_search(query, artist, track, album, track_id, duration, auto_download, metadata_override, 'track', format_preference, image_url)

                    if success:
                        # Mark as processed on server
                        self._mark_processed(timestamp)

                        # Track locally to prevent duplicates (with cleanup timestamp)
                        self.processed_timestamps[timestamp] = time.time()

                        # IMPROVED: Update activity time on successful search
                        self.last_activity_time = time.time()

                        # Add a small delay between searches
                        time.sleep(0.5)

            except Exception as e:
                self.log(f" Error in poll loop: {e}")

            # Check for auto-download opportunities (event-driven now, just check timeouts)
            try:
                self._check_and_download_ready_searches()
                # IMPROVED: Update activity if we have active searches
                if self.active_searches:
                    self.last_activity_time = time.time()
            except Exception as e:
                self.log(f" Error in auto-download check: {e}")

            # Check if we should launch cascade backups (HEAD2/HEAD3)
            try:
                self._check_cascade_launches()
            except Exception as e:
                self.log(f" Error in cascade check: {e}")

            # Monitor active downloads for failures/timeouts
            try:
                self._monitor_downloads()
                # IMPROVED: Update activity if we have active downloads
                if self.active_downloads:
                    self.last_activity_time = time.time()
            except Exception as e:
                self.log(f" Error in download monitoring: {e}")

            # IMPROVED: Adaptive polling - adjust interval based on activity
            time_since_activity = time.time() - self.last_activity_time
            old_mode = self.poll_mode

            if self.active_searches or self.active_downloads or time_since_activity < 30:
                # Active mode: activity in last 30 seconds
                self.poll_mode = 'active'
                self.current_poll_interval = 2
            elif time_since_activity < 300:  # 5 minutes
                # Idle mode: no activity for 30s-5min
                self.poll_mode = 'idle'
                self.current_poll_interval = 10
            else:
                # Sleep mode: no activity for 5+ minutes
                self.poll_mode = 'sleep'
                self.current_poll_interval = 15  # Max 15 seconds (reduced from 30)

            # Log mode changes
            if old_mode != self.poll_mode:
                self.log(f" Poll mode: {old_mode} → {self.poll_mode} (interval: {self.current_poll_interval}s)")

            # Wait before next poll
            time.sleep(self.current_poll_interval)
