"""
Nicotine+ Hydra+ Plugin

Multi-headed Spotify → Soulseek bridge with intelligent auto-download.
Connects to the bridge server to receive track searches from the browser
extension and automatically triggers searches in Nicotine+.

Version: 0.1.5
"""

__version__ = "0.1.5"

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
            'bridge_url': 'http://127.0.0.1:3847',
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
        self.server_process = None  # Track server process if we started it
        self.active_searches = {}  # Track searches with metadata and ranked download candidates
        self.active_downloads = {}  # Track {virtual_path: search_token} for fallback
        self.nicotine_online = False  # Track if Nicotine+ is connected to the network
        self.waiting_for_connection = False  # Track if we're waiting for connection
        self.server_was_running = False  # Track if server was previously running
        self.last_cleanup_time = time.time()  # Track last cleanup of old data
        self.metadata_cache = {}  # Cache prefetched metadata {(token, track_index): metadata_dict}

        # Get plugin directory and server path
        self.plugin_dir = os.path.dirname(os.path.abspath(__file__))
        self.server_path = os.path.join(self.plugin_dir, 'Server', 'bridge-server.js')

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
            self.log(f"[Hydra+] Error checking online status: {e}")
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
            self.log("[Hydra+] WARNING: package.json not found, skipping dependency check")
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
        self.log(f"[Hydra+] Missing npm packages: {', '.join(missing_packages)}")
        self.log("[Hydra+] Installing dependencies... (this may take a moment)")

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
                self.log("[Hydra+] SUCCESS: Dependencies installed successfully")
                return True
            else:
                stderr_output = result.stderr.decode('utf-8', errors='ignore')
                self.log(f"[Hydra+] ERROR: npm install failed: {stderr_output}")
                return False

        except FileNotFoundError:
            self.log("[Hydra+] ERROR: npm not found - please install Node.js")
            return False
        except subprocess.TimeoutExpired:
            self.log("[Hydra+] ERROR: npm install timed out")
            return False
        except Exception as e:
            self.log(f"[Hydra+] ERROR: Error installing dependencies: {e}")
            return False

    def _start_server(self):
        """Start the bridge server if it's not running."""
        if not self.settings.get('auto_start_server', True):
            self.log("[Hydra+] Auto-start disabled in settings")
            return False

        if not os.path.exists(self.server_path):
            self.log(f"[Hydra+] Server not found at: {self.server_path}")
            return False

        # Check and install dependencies if needed
        if not self._check_npm_dependencies():
            self.log("[Hydra+] ERROR: Failed to install npm dependencies")
            return False

        try:
            self.log(f"[Hydra+] Starting bridge server...")
            self.log(f"[Hydra+] Server path: {self.server_path}")

            # Start the Node.js server in the background
            # Use CREATE_NO_WINDOW flag on Windows to hide console window
            startupinfo = None
            if os.name == 'nt':  # Windows
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW

            self.server_process = subprocess.Popen(
                ['node', self.server_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                startupinfo=startupinfo
            )

            self.log("[Hydra+] Bridge server process started, will verify in background")
            return True

        except FileNotFoundError:
            self.log("[Hydra+] ERROR: NODE.JS NOT FOUND - Please install Node.js")
            return False
        except Exception as e:
            self.log(f"[Hydra+] ERROR: Starting server failed: {e}")
            return False

    def _cleanup_server_process(self):
        """Kill any existing server process and clean up."""
        try:
            # Try to terminate our tracked process first
            if self.server_process:
                try:
                    self.log("[Hydra+] Terminating existing server process...")
                    self.server_process.terminate()
                    self.server_process.wait(timeout=3)
                    self.log("[Hydra+] ✓ Old process terminated")
                except:
                    try:
                        self.server_process.kill()
                        self.log("[Hydra+] ✓ Old process killed (force)")
                    except:
                        pass
                finally:
                    self.server_process = None

            # Also kill any node.js processes running bridge-server.js (Windows-specific cleanup)
            if os.name == 'nt':  # Windows
                try:
                    import subprocess
                    # Find and kill any node processes running bridge-server.js
                    subprocess.run(['taskkill', '/F', '/FI', 'IMAGENAME eq node.exe', '/FI', f'WINDOWTITLE eq *bridge-server.js*'],
                                   capture_output=True, timeout=5)
                except:
                    pass
        except Exception as e:
            self.log(f"[Hydra+] Cleanup error (non-fatal): {e}")

    def _verify_server_startup(self):
        """Background task to verify server started successfully."""
        max_attempts = 10
        for attempt in range(max_attempts):
            time.sleep(1)
            if self._is_server_running():
                self.log(f"[Hydra+] ✓ BRIDGE CONNECTED → Port 3847 (took {attempt + 1}s)")
                return

        self.log("[Hydra+] ⚠ Bridge server did not respond after 10s")
        self.log("[Hydra+] The server process was started but may not be ready yet")

    def _check_and_start_server(self):
        """
        Check if server is running and start if needed.
        Runs in background thread to avoid blocking plugin load.
        """
        try:
            if self._is_server_running():
                self.log("[Hydra+] ✓ Bridge server already running")
            else:
                self.log("[Hydra+] ⚠ BRIDGE OFFLINE → Auto-start attempt...")
                if self._start_server():
                    self.log("[Hydra+] ✓ Bridge server started successfully")
                else:
                    self.log("[Hydra+] ✗ Could not start bridge server")
                    self.log("[Hydra+] Please start it manually: node bridge-server.js")
        except Exception as e:
            self.log(f"[Hydra+] Error checking/starting server: {e}")

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
        self.log(f"  [BRIDGE]    → {bridge_url}")
        self.log(f"  [POLLING]   → Every {poll_interval}s")
        self.log("═══════════════════════════════════════════════════════════")
        self.log("  🐍 Multi-headed beast awakened!")
        self.log("═══════════════════════════════════════════════════════════")
        self.log(f"  v{__version__}")
        self.log("═══════════════════════════════════════════════════════════")
        self.log("[Hydra+] Waiting for Nicotine+ to connect to the network...")

        # Subscribe to search result events for auto-download
        events.connect("file-search-response", self._on_file_search_response)

        # Start polling thread (it will wait for connection before processing)
        self.running = True
        self.waiting_for_connection = True
        self.thread = Thread(target=self._poll_queue, daemon=True)
        self.thread.start()

        # Check if server is running and start if needed (in background to avoid blocking startup)
        server_thread = Thread(target=self._check_and_start_server, daemon=True)
        server_thread.start()

    def unloaded_notification(self):
        """Called when the plugin is disabled or unloaded."""
        self.log("[Hydra+] Plugin unloading...")

        # Stop polling thread
        self.running = False
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=5)

        # Stop server if we started it
        if self.server_process:
            try:
                self.log("[Hydra+] Stopping bridge server...")
                self.server_process.terminate()
                self.server_process.wait(timeout=5)
                self.log("[Hydra+] Bridge server stopped")
            except Exception as e:
                self.log(f"[Hydra+] Error stopping server: {e}")

        self.log("[Hydra+] Plugin unloaded")

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
                self.log(f"[Hydra+] Cannot reach bridge server: {e}")
                self._last_error_time = time.time()
            return []
        except Exception as e:
            # Suppress timeout errors from logging since they're normal during metadata processing
            error_msg = str(e)
            if 'timed out' not in error_msg:
                self.log(f"[Hydra+] Error fetching searches: {e}")
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
                self.log(f"[Hydra+] Error marking processed: {e}")
            return False

    def _cleanup_old_data(self):
        """Cleanup old processed timestamps and stale searches to prevent memory leaks."""
        try:
            current_time = time.time()

            # Only cleanup every 5 minutes to reduce overhead
            if current_time - self.last_cleanup_time < 300:
                return

            self.last_cleanup_time = current_time

            # Clean up processed timestamps older than 1 hour
            one_hour_ago = current_time - 3600
            old_timestamps = [ts for ts, processed_at in self.processed_timestamps.items()
                            if processed_at < one_hour_ago]

            for ts in old_timestamps:
                del self.processed_timestamps[ts]

            if old_timestamps:
                self.log(f"[Hydra+] Cleaned {len(old_timestamps)} old processed timestamps")

            # Clean up stale active searches (older than 10 minutes)
            ten_minutes_ago = current_time - 600
            stale_searches = [token for token, info in self.active_searches.items()
                            if info.get('timestamp', current_time) < ten_minutes_ago]

            for token in stale_searches:
                del self.active_searches[token]

            if stale_searches:
                self.log(f"[Hydra+] Cleaned {len(stale_searches)} stale active searches")

        except Exception as e:
            self.log(f"[Hydra+] Error in cleanup: {e}")

    def _trigger_search(self, query, artist='', track='', album='', track_id='', duration=0, auto_download=False, metadata_override=True, search_type='track', format_preference='mp3'):
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
        auto_dl_status = "Auto Download enabled" if auto_download else "Auto Download disabled"
        format_status = f"Format: {format_preference.upper()}"
        self.log(f"[Hydra+] >> NEW SEARCH << {query} ({auto_dl_status}, {format_status})")
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
                self.log(f"[Hydra+] ⚠ Search '{query}' - auto-download unavailable (no token)")

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
                    'timestamp': time.time(),
                    'download_candidates': [],  # List of {file, user, score, size, attrs}
                    'current_attempt': -1,  # -1 = not started, 0+ = attempt index
                    'download_started_at': None,
                    'last_download_path': None,
                    'last_download_user': None,  # Username of last download attempt (for abort)
                    'result_count': 0
                }
                self.log(f"[Hydra+: DL] ✓ Tracking search (token={search_token})")

            return True
        except Exception as e:
            self.log(f"[Hydra+] ✗ ERROR triggering search!")
            self.log(f"[Hydra+] Exception: {type(e).__name__}: {str(e)}")
            import traceback
            self.log(f"[Hydra+] Traceback: {traceback.format_exc()}")
            return False

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
            self.log(f"[Hydra+: DL] Error processing search response: {e}")
            import traceback
            self.log(f"[Hydra+: DL] Traceback: {traceback.format_exc()}")

    def _process_track_search_results(self, token, search_info, username, file_list):
        """Process search results for a single track."""
        # Log when we receive results (first time only)
        if search_info['result_count'] == 0:
            self.log(f"[Hydra+: DL] 📥 Receiving results for '{search_info['query']}'")

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

                self.log(f"[Hydra+: DL] ★ BEST MATCH → {file_name}{bitrate_info}{format_info} (score: {int(score)})")

        # Increment result count
        search_info['result_count'] += len(file_list)

    def _process_album_search_results(self, token, search_info, username, file_list, msg=None):
        """Process search results for an album - group by folder and score folders."""
        import os

        # Log when we receive results (first time only)
        if search_info['result_count'] == 0:
            self.log(f"[Hydra+: ALBUM] 📥 Receiving folder results for '{search_info['query']}'")

        # Debug: Always log that we received results
        self.log(f"[Hydra+: ALBUM] Received {len(file_list)} results from {username}")

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
        self.log(f"[Hydra+: ALBUM] Found {len(folders)} folders from {username} with {len(file_list)} files")

        # Score each folder based on completeness and quality
        expected_track_count = len(search_info['tracks'])

        for folder_path, files in folders.items():
            score = self._score_album_folder(folder_path, files, search_info, upload_speed)

            # Debug: Log all folder scores
            self.log(f"[Hydra+: ALBUM] Folder score: {int(score)} - {folder_path} ({len(files)} files)")

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

        # Log best folder if we have a good candidate
        if search_info['folder_candidates'] and search_info['result_count'] == 0:
            best = search_info['folder_candidates'][0]
            self.log(f"[Hydra+: ALBUM] ★ Best folder: {best['folder_path']} (score: {int(best['score'])}, {len(best['tracks_found'])} files)")

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
                self.log(f"[Hydra+: DL] ✗ All {len(candidates)} candidates exhausted for '{search_info['query']}'")
                # Clean up - no more candidates
                if token in self.active_searches:
                    del self.active_searches[token]
                return

            candidate = candidates[attempt_index]

            self.log(f"[Hydra+: DL] ⬇ HEAD #1 → {candidate['file']} (score: {int(candidate['score'])})")

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

            # Track this download for monitoring
            self.active_downloads[candidate['file']] = token

            # Don't log success - the download starting message is enough

        except Exception as e:
            self.log(f"[Hydra+: DL] ✗ Error queuing download: {e}")
            import traceback
            self.log(f"[Hydra+: DL] Traceback: {traceback.format_exc()}")

            # Try next candidate if available
            if attempt_index + 1 < len(search_info['download_candidates']):
                self.log(f"[Hydra+: DL] 🐍 HEAD #{attempt_index + 1} FAILED → Trying next head...")
                self._try_download_candidate(token, search_info, attempt_index + 1, "Fallback after error")
            else:
                # No more candidates
                if token in self.active_searches:
                    del self.active_searches[token]

    def _try_next_download_candidate(self, token, search_info, reason):
        """
        Try the next download candidate after a failure.

        Args:
            token: Search token
            search_info: Search metadata dict
            reason: Reason for fallback (for logging)
        """
        next_attempt = search_info['current_attempt'] + 1

        self.log(f"[Hydra+: DL] 🔄 Attempting fallback (reason: {reason})")
        self.log(f"[Hydra+: DL] Last download path: {search_info.get('last_download_path', 'NONE')}")

        # Remove failed download from tracking and abort it from Nicotine+ queue
        if search_info.get('last_download_path') and search_info['last_download_path'] in self.active_downloads:
            virtual_path = search_info['last_download_path']
            username = search_info.get('last_download_user')
            self.log(f"[Hydra+: DL] Attempting to abort: {virtual_path}")
            self.log(f"[Hydra+: DL] Username: {username}")

            # Find the transfer object and try to abort it
            transfer_to_abort = None
            if hasattr(self.core, 'downloads') and hasattr(self.core.downloads, 'transfers'):
                transfer_count = len(self.core.downloads.transfers)
                self.log(f"[Hydra+: DL] Checking {transfer_count} transfers...")

                for transfer in self.core.downloads.transfers.values():
                    if hasattr(transfer, 'virtual_path') and transfer.virtual_path == virtual_path:
                        transfer_to_abort = transfer
                        self.log(f"[Hydra+: DL] Found transfer in queue")
                        break

                if transfer_to_abort:
                    # Try clear_downloads FIRST (before aborting, while transfer is still valid)
                    # If this works, we don't need to abort since it's already removed
                    cleared = False
                    if hasattr(self.core.downloads, 'clear_downloads'):
                        try:
                            self.log(f"[Hydra+: DL] Calling clear_downloads to remove from UI...")
                            self.core.downloads.clear_downloads([transfer_to_abort])
                            self.log(f"[Hydra+: DL] ✓ Called clear_downloads successfully")
                            cleared = True
                        except Exception as e:
                            self.log(f"[Hydra+: DL] ✗ clear_downloads failed: {e}")
                            import traceback
                            self.log(f"[Hydra+: DL] {traceback.format_exc()}")

                    # Only try abort if clear failed or isn't available
                    if not cleared:
                        if hasattr(self.core.downloads, 'abort_downloads'):
                            try:
                                self.log(f"[Hydra+: DL] Calling abort_downloads with Transfer object...")
                                self.core.downloads.abort_downloads([transfer_to_abort])
                                self.log(f"[Hydra+: DL] ✓ Called abort_downloads successfully")
                            except Exception as e:
                                self.log(f"[Hydra+: DL] ✗ abort_downloads failed: {e}")
                                # Try abort_transfer as last resort
                                if hasattr(self.core.downloads, 'abort_transfer'):
                                    try:
                                        self.log(f"[Hydra+: DL] Trying abort_transfer instead...")
                                        self.core.downloads.abort_transfer(transfer_to_abort)
                                        self.log(f"[Hydra+: DL] ✓ Called abort_transfer successfully")
                                    except Exception as e2:
                                        self.log(f"[Hydra+: DL] ✗ abort_transfer also failed: {e2}")
                        elif hasattr(self.core.downloads, 'abort_transfer'):
                            try:
                                self.log(f"[Hydra+: DL] Calling abort_transfer...")
                                self.core.downloads.abort_transfer(transfer_to_abort)
                                self.log(f"[Hydra+: DL] ✓ Called abort_transfer successfully")
                            except Exception as e:
                                self.log(f"[Hydra+: DL] ✗ abort_transfer failed: {e}")

                    # List available methods for debugging (only on first abort attempt)
                    if not hasattr(self, '_abort_methods_logged'):
                        methods = [m for m in dir(self.core.downloads) if not m.startswith('_') and ('abort' in m.lower() or 'clear' in m.lower() or 'remove' in m.lower() or 'cancel' in m.lower())]
                        if methods:
                            self.log(f"[Hydra+: DL] Available abort/clear/remove methods: {', '.join(methods)}")
                        self._abort_methods_logged = True
                else:
                    self.log(f"[Hydra+: DL] Transfer not found in transfers dict (may have been removed)")
            else:
                self.log(f"[Hydra+: DL] ✗ downloads.transfers not available")

            # Remove from tracking
            del self.active_downloads[virtual_path]
            self.log(f"[Hydra+: DL] Removed from tracking dict")

        # Try next candidate (logging happens in _try_download_candidate)
        self._try_download_candidate(token, search_info, next_attempt, f"Trying next candidate")

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
                self.log(f"[Hydra+: DL] Error checking search {token}: {e}")
                import traceback
                self.log(f"[Hydra+: DL] Traceback: {traceback.format_exc()}")

                # Remove problematic search after timeout
                if current_time - search_info['timestamp'] > 60:
                    del self.active_searches[token]

    def _check_track_download_ready(self, token, search_info, current_time):
        """Check if a track search is ready to download."""
        elapsed = current_time - search_info['timestamp']

        # Skip if already attempted download
        if search_info['current_attempt'] >= 0:
            return

        # Wait at least 15 seconds to collect results, max 30 seconds
        if elapsed < 15:
            return

        candidates = search_info['download_candidates']

        # If we have candidates, try the best one
        if candidates and candidates[0]['score'] > 100 and elapsed >= 15:
            self._try_download_candidate(token, search_info, 0, "Initial download")

        elif elapsed > 30:
            # Timeout - download best we have if score is reasonable
            if candidates and candidates[0]['score'] > 50:
                self._try_download_candidate(token, search_info, 0, "Timeout - downloading best available")
            else:
                best_score = candidates[0]['score'] if candidates else 0
                self.log(f"[Hydra+: DL] ✗ NO MATCH → '{search_info['query']}' (best score: {best_score}/50)")
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
                self.log(f"[Hydra+: ALBUM] ✗ No suitable folder found for '{search_info['album_name']}' (best score: {best_score}/100)")
                # Remove from tracking
                del self.active_searches[token]

    def _start_album_download(self, token, search_info, best_folder):
        """Start downloading tracks from the best album folder."""
        try:
            self.log(f"[Hydra+: ALBUM] ⬇ Selected folder: {best_folder['folder_path']}")
            self.log(f"[Hydra+: ALBUM] ⬇ From user: {best_folder['user']} (score: {int(best_folder['score'])})")

            # Store best folder info
            search_info['best_folder'] = best_folder

            # Match expected tracks with files in the folder
            tracks_to_download = self._match_album_tracks(search_info, best_folder)

            if not tracks_to_download:
                self.log(f"[Hydra+: ALBUM] ✗ Could not match any tracks in folder")
                del self.active_searches[token]
                return

            search_info['tracks_to_download'] = tracks_to_download
            search_info['current_track_index'] = 0

            self.log(f"[Hydra+: ALBUM] ✓ Matched {len(tracks_to_download)}/{len(search_info['tracks'])} tracks")

            # CRITICAL: Create album folder FIRST (before any downloads)
            # This prevents orphaned files if server crashes during processing
            download_dir = self._get_download_directory(tracks_to_download[0])
            if download_dir:
                album_folder = self._ensure_album_folder(search_info, download_dir)
                if album_folder:
                    search_info['album_folder_path'] = album_folder
                    self.log(f"[Hydra+: ALBUM] ✓ Album folder ready: {os.path.basename(album_folder)}")
                else:
                    self.log(f"[Hydra+: ALBUM] ⚠ Could not create album folder, continuing anyway...")
            else:
                self.log(f"[Hydra+: ALBUM] ⚠ Could not determine download directory")

            self.log(f"[Hydra+: ALBUM] Starting track 1/{len(tracks_to_download)}...")

            # ALBUM-LEVEL PREFETCH: Fetch album metadata ONCE (year, cover art)
            # This is shared across all tracks and should not be fetched per-track
            if len(tracks_to_download) > 0:
                first_track_info = tracks_to_download[0]['track_info']
                self._prefetch_album_metadata(token, first_track_info)

            # Start downloading first track
            self._download_next_album_track(token, search_info)

        except Exception as e:
            self.log(f"[Hydra+: ALBUM] Error starting album download: {e}")
            import traceback
            self.log(f"[Hydra+: ALBUM] Traceback: {traceback.format_exc()}")
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
                        self.log(f"[Hydra+: ALBUM] ✓ Found download directory (config.sections): {download_dir}")
                        return download_dir

                # Try legacy config format
                if hasattr(config, 'data') and 'transfers' in config.data:
                    download_dir = config.data['transfers'].get('downloaddir')
                    if download_dir:
                        self.log(f"[Hydra+: ALBUM] ✓ Found download directory (config.data): {download_dir}")
                        return download_dir

            # Method 2: Check core.downloads
            if hasattr(self.core, 'downloads') and hasattr(self.core.downloads, 'download_folder'):
                download_dir = self.core.downloads.download_folder
                if download_dir:
                    self.log(f"[Hydra+: ALBUM] ✓ Found download directory (core.downloads): {download_dir}")
                    return download_dir

            self.log(f"[Hydra+: ALBUM] ⚠ Could not find download directory in config")
            return None

        except Exception as e:
            self.log(f"[Hydra+: ALBUM] Error getting download directory: {e}")
            import traceback
            self.log(f"[Hydra+: ALBUM] Traceback: {traceback.format_exc()}")
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
                self.log(f"[Hydra+: ALBUM] Missing album_artist or album_name")
                return None

            self.log(f"[Hydra+: ALBUM] Creating album folder: {album_artist} - {album_name}")

            # Send request to bridge server to create folder
            payload = {
                'album_artist': album_artist,
                'album_name': album_name,
                'year': year,
                'download_dir': download_dir
            }

            url = f"{self.settings['bridge_url']}/ensure-album-folder"
            req = Request(url,
                         data=json.dumps(payload).encode('utf-8'),
                         headers={'Content-Type': 'application/json'})

            with urlopen(req, timeout=10) as response:
                result = json.loads(response.read().decode('utf-8'))

                if result.get('success'):
                    folder_path = result.get('folder_path', '')
                    self.log(f"[Hydra+: ALBUM] ✓ Folder created: {result.get('folder_name', '')}")
                    return folder_path
                else:
                    error = result.get('error', 'Unknown error')
                    self.log(f"[Hydra+: ALBUM] ✗ Failed to create folder: {error}")
                    return None

        except URLError as e:
            self.log(f"[Hydra+: ALBUM] ✗ Cannot reach bridge server: {e}")
            return None
        except Exception as e:
            self.log(f"[Hydra+: ALBUM] Error creating album folder: {e}")
            import traceback
            self.log(f"[Hydra+: ALBUM] Traceback: {traceback.format_exc()}")
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
            """Normalize text for flexible matching - handles underscores, dots, etc."""
            import re
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
                    self.log(f"[Hydra+: PREFETCH-ALBUM] ⚠ No track_id, skipping album metadata prefetch")
                    return

                album_name = first_track_info.get('album', 'Unknown Album')
                self.log(f"[Hydra+: PREFETCH-ALBUM] Fetching album metadata for: {album_name}")

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

                        # Store in cache with 'album' key so all tracks can share it
                        cache_key = (token, 'album')
                        self.metadata_cache[cache_key] = album_metadata

                        self.log(f"[Hydra+: PREFETCH-ALBUM] ✓ Album metadata cached (year={album_metadata.get('year', 'N/A')})")

                except URLError as e:
                    self.log(f"[Hydra+: PREFETCH-ALBUM] ⚠ Failed to fetch album metadata: {e}")
                except Exception as e:
                    self.log(f"[Hydra+: PREFETCH-ALBUM] ⚠ Error prefetching album metadata: {e}")

            except Exception as e:
                self.log(f"[Hydra+: PREFETCH-ALBUM] ✗ Fatal error in prefetch worker: {e}")
                import traceback
                self.log(f"[Hydra+: PREFETCH-ALBUM] {traceback.format_exc()}")

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

            self.log(f"[Hydra+: ALBUM] ⬇ Track {current_index + 1}/{len(tracks_to_download)}: {track_info['artist']} - {track_info['track']}")

            # Queue the download
            self.core.downloads.enqueue_download(
                username=track_to_download['user'],
                virtual_path=track_to_download['file_path'],
                size=track_to_download['file_size'],
                file_attributes=track_to_download.get('file_attrs')
            )

            # Track this download
            self.active_downloads[track_to_download['file_path']] = token
            search_info['download_started_at'] = time.time()

        except Exception as e:
            self.log(f"[Hydra+: ALBUM] Error downloading track: {e}")
            import traceback
            self.log(f"[Hydra+: ALBUM] Traceback: {traceback.format_exc()}")

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
                self.log(f"[Hydra+: META] File not found: {file_path}")
                return

            # Check if file is MP3 or FLAC
            file_lower = file_path.lower()
            if not (file_lower.endswith('.mp3') or file_lower.endswith('.flac')):
                self.log(f"[Hydra+: META] Unsupported format (only MP3/FLAC), skipping: {file_path}")
                return

            # Check if metadata override is enabled for this search
            if not search_info.get('metadata_override', True):
                self.log(f"[Hydra+: META] Metadata override disabled for this track")
                return

            self.log(f"[Hydra+: META] Sending to Node server for processing...")

            # Prepare request data
            payload = {
                'file_path': file_path,
                'artist': search_info.get('artist', ''),
                'track': search_info.get('track', ''),
                'album': search_info.get('album', ''),
                'track_id': search_info.get('track_id', '')
            }

            # Send to Node server
            url = f"{self.settings['bridge_url']}/process-metadata"
            req = Request(url,
                         data=json.dumps(payload).encode('utf-8'),
                         headers={'Content-Type': 'application/json'})

            with urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode('utf-8'))

                if result.get('success'):
                    self.log(f"[Hydra+: META] ✓ Processing successful!")

                    if result.get('renamed'):
                        new_name = os.path.basename(result['new_path'])
                        self.log(f"[Hydra+: META]   Renamed: {new_name}")

                    if result.get('tags_updated'):
                        artist = search_info.get('artist', '')
                        track = search_info.get('track', '')
                        album = search_info.get('album', '')
                        if artist:
                            self.log(f"[Hydra+: META]   Artist: {artist}")
                        if track:
                            self.log(f"[Hydra+: META]   Track: {track}")
                        if album:
                            self.log(f"[Hydra+: META]   Album: {album}")

                        # Log additional metadata from server response
                        if result.get('year'):
                            self.log(f"[Hydra+: META]   Year: {result['year']}")
                        if result.get('track_number'):
                            self.log(f"[Hydra+: META]   Track: #{result['track_number']}")
                        if result.get('genre'):
                            self.log(f"[Hydra+: META]   Genre: {result['genre']}")
                        if result.get('label'):
                            self.log(f"[Hydra+: META]   Label: {result['label']}")

                    if result.get('cover_embedded'):
                        self.log(f"[Hydra+: META]   Cover: ✓ Embedded")
                else:
                    self.log(f"[Hydra+: META] ✗ Failed: {result.get('error', 'Unknown error')}")

        except URLError as e:
            self.log(f"[Hydra+: META] ✗ Cannot reach Node server: {e}")
            self.log(f"[Hydra+: META] Make sure bridge server is running")
        except Exception as e:
            self.log(f"[Hydra+: META] ✗ Error: {e}")
            import traceback
            self.log(f"[Hydra+: META] {traceback.format_exc()}")

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

            self.log(f"[Hydra+: ALBUM] ✓ Album download complete!")
            self.log(f"[Hydra+: ALBUM] Downloaded: {downloaded_count}/{len(tracks_to_download)} tracks")
            self.log(f"[Hydra+: ALBUM] All tracks were processed immediately (no batch processing)")

            # Check if album folder was created
            album_folder = search_info.get('album_folder_path')
            if album_folder:
                import os
                self.log(f"[Hydra+: ALBUM] Location: {album_folder}")
                self.log(f"[Hydra+: ALBUM] Folder: {os.path.basename(album_folder)}")

            # Clean up
            del self.active_searches[token]

        except Exception as e:
            self.log(f"[Hydra+: ALBUM] Error finalizing album: {e}")
            import traceback
            self.log(f"[Hydra+: ALBUM] Traceback: {traceback.format_exc()}")
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

            self.log(f"[Hydra+: ALBUM] Creating album folder and organizing {len(track_file_paths)} files...")

            # Send to bridge server to create album folder and move files
            payload = {
                'album_artist': search_info['album_artist'],
                'album_name': search_info['album_name'],
                'year': search_info.get('year', ''),
                'track_files': track_file_paths
            }

            url = f"{self.settings['bridge_url']}/create-album-folder"
            req = Request(url,
                         data=json.dumps(payload).encode('utf-8'),
                         headers={'Content-Type': 'application/json'})

            with urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode('utf-8'))

                if result.get('success'):
                    folder_path = result.get('folder_path', '')
                    self.log(f"[Hydra+: ALBUM] ✓ Album organized: {folder_path}")
                else:
                    error = result.get('error', 'Unknown error')
                    self.log(f"[Hydra+: ALBUM] ✗ Failed to organize album: {error}")

        except Exception as e:
            self.log(f"[Hydra+: ALBUM] Error organizing album folder: {e}")
            import traceback
            self.log(f"[Hydra+: ALBUM] Traceback: {traceback.format_exc()}")

    def _process_album_metadata_and_organize(self, downloaded_tracks, search_info):
        """Process metadata for all tracks, then organize into album folder."""
        try:
            self.log(f"[Hydra+: ALBUM-META] Starting batch processing...")
            self._process_album_metadata_batch(downloaded_tracks, search_info)
            self.log(f"[Hydra+: ALBUM-META] Batch processing complete, organizing folder...")
        except Exception as e:
            self.log(f"[Hydra+: ALBUM-META] ⚠ Error during metadata processing: {e}")
            import traceback
            self.log(f"[Hydra+: ALBUM-META] Traceback: {traceback.format_exc()}")
            self.log(f"[Hydra+: ALBUM-META] Continuing to organize files despite errors...")

        # CRITICAL: Always organize folder, even if metadata processing failed
        # This ensures files are moved into album folder regardless of server crashes
        try:
            self._organize_album_folder(downloaded_tracks, search_info)
        except Exception as e:
            self.log(f"[Hydra+: ALBUM] ✗ Error organizing album folder: {e}")
            import traceback
            self.log(f"[Hydra+: ALBUM] Traceback: {traceback.format_exc()}")

    def download_finished_notification(self, user, virtual_path, real_path):
        """
        Called when a download completes successfully.

        Args:
            user: Username who shared the file
            virtual_path: Network path of file
            real_path: Local filesystem path where file was saved
        """
        try:
            # Check if this download is tracked
            if virtual_path not in self.active_downloads:
                return

            # Get search token and metadata
            token = self.active_downloads[virtual_path]

            if token not in self.active_searches:
                return

            search_info = self.active_searches[token]

            # Only process if this was an auto-download from browser
            if not search_info.get('auto_download', False):
                return

            search_type = search_info.get('type', 'track')

            if search_type == 'album':
                # Handle album track completion
                self._handle_album_track_completion(token, search_info, virtual_path, real_path)
            else:
                # Handle regular track completion
                self._handle_track_completion(token, search_info, virtual_path, real_path)

        except Exception as e:
            self.log(f"[Hydra+] Error in download_finished_notification: {e}")
            import traceback
            self.log(f"[Hydra+] Traceback: {traceback.format_exc()}")

    def _handle_track_completion(self, token, search_info, virtual_path, real_path):
        """Handle completion of a single track download."""
        # Debug: Log the paths we received
        self.log(f"[Hydra+: META] Download complete - virtual_path: {virtual_path}")
        self.log(f"[Hydra+: META] Download complete - real_path: {real_path}")

        # Process metadata in background thread to avoid blocking
        from threading import Thread
        thread = Thread(
            target=self._process_downloaded_file,
            args=(real_path, search_info),
            daemon=True
        )
        thread.start()

        # Clean up tracking
        del self.active_downloads[virtual_path]
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

            self.log(f"[Hydra+: ALBUM] ✓ Track {current_index + 1}/{len(tracks_to_download)} downloaded: {track_info['track']}")

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

        # Clean up download tracking
        del self.active_downloads[virtual_path]

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
                self.log(f"[Hydra+: ALBUM] ✗ File not found: {real_path}")
                return

            # Check if file is MP3 or FLAC
            file_lower = real_path.lower()
            if not (file_lower.endswith('.mp3') or file_lower.endswith('.flac')):
                self.log(f"[Hydra+: ALBUM] ⚠ Unsupported format, skipping metadata: {real_path}")
                return

            # Get album folder path (created upfront)
            album_folder_path = search_info.get('album_folder_path')
            if not album_folder_path:
                self.log(f"[Hydra+: ALBUM] ⚠ No album folder path, processing without move")

            self.log(f"[Hydra+: ALBUM] Processing track {track_index + 1} metadata...")

            # Process metadata with album folder as target (will rename AND move)
            success, new_path = self._process_single_track_metadata(
                real_path,
                track_info,
                token,
                track_index,
                target_folder=album_folder_path
            )

            if success:
                self.log(f"[Hydra+: ALBUM] ✓ Track {track_index + 1} complete: {os.path.basename(new_path)}")
            else:
                self.log(f"[Hydra+: ALBUM] ✗ Track {track_index + 1} failed metadata processing")

        except Exception as e:
            self.log(f"[Hydra+: ALBUM] ✗ Error processing track {track_index + 1} immediately: {e}")
            import traceback
            self.log(f"[Hydra+: ALBUM] Traceback: {traceback.format_exc()}")

    def _process_album_metadata_batch_safe(self, downloaded_tracks, search_info):
        """
        Safe wrapper for batch metadata processing with comprehensive error handling.
        """
        try:
            self._process_album_metadata_batch(downloaded_tracks, search_info)
        except Exception as e:
            self.log(f"[Hydra+: ALBUM-META] ✗ FATAL ERROR in batch processing: {e}")
            import traceback
            self.log(f"[Hydra+: ALBUM-META] Traceback: {traceback.format_exc()}")

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

        self.log(f"[Hydra+: ALBUM-META] Starting batch of {total_tracks} tracks...")

        for i, track_data in enumerate(downloaded_tracks):
            try:
                file_path = track_data['file_path']
                track_info = track_data['track_info']
            except (KeyError, TypeError) as e:
                self.log(f"[Hydra+: ALBUM-META] ✗ Invalid track data at index {i}: {e}")
                failed += 1
                continue

            try:
                self.log(f"[Hydra+: ALBUM-META] Processing {i + 1}/{total_tracks}: {track_info.get('track', 'Unknown')}")

                # Process this track's metadata with prefetched cache
                success, new_path = self._process_single_track_metadata(file_path, track_info, token, i)

                if success:
                    successful += 1
                    # Update the file path in downloaded_tracks with the renamed path
                    track_data['file_path'] = new_path
                    self.log(f"[Hydra+: ALBUM-META] ✓ Track {i + 1}/{total_tracks} complete")
                else:
                    failed += 1
                    self.log(f"[Hydra+: ALBUM-META] ✗ Track {i + 1}/{total_tracks} failed")

                # CRITICAL: Add delay between tracks to prevent server overload
                # The server does background work (cover download, tag writing) that takes time
                # Processing tracks too quickly causes concurrent background jobs to pile up
                if i < total_tracks - 1:
                    time.sleep(2)  # 2 second delay to let server finish background work

            except Exception as e:
                self.log(f"[Hydra+: ALBUM-META] ✗ Exception processing track {i + 1}: {e}")
                import traceback
                self.log(f"[Hydra+: ALBUM-META] Traceback: {traceback.format_exc()}")
                failed += 1
                # Continue with next track even on error

        self.log(f"[Hydra+: ALBUM-META] ✓ Batch complete: {successful} succeeded, {failed} failed")

        # Cleanup: Remove cached metadata for this album
        if token:
            keys_to_remove = [k for k in self.metadata_cache.keys() if k[0] == token]
            for key in keys_to_remove:
                del self.metadata_cache[key]
            if keys_to_remove:
                self.log(f"[Hydra+: ALBUM-META] Cleaned up {len(keys_to_remove)} cached metadata entries")

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
                self.log(f"[Hydra+: ALBUM-META] ✗ File not found: {file_path}")
                return (False, file_path)

            # Check if file is MP3 or FLAC
            file_lower = file_path.lower()
            if not (file_lower.endswith('.mp3') or file_lower.endswith('.flac')):
                self.log(f"[Hydra+: ALBUM-META] ✗ Unsupported format (only MP3/FLAC), skipping: {file_path}")
                return (False, file_path)

            # Check if we have prefetched ALBUM metadata in cache (shared across all tracks)
            album_metadata = None
            if token is not None:
                cache_key = (token, 'album')
                album_metadata = self.metadata_cache.get(cache_key)
                if album_metadata:
                    self.log(f"[Hydra+: ALBUM-META]   Using cached album metadata (year={album_metadata.get('year', 'N/A')})")

            # Prepare request data with track number and prefetched album metadata
            payload = {
                'file_path': file_path,
                'artist': track_info.get('artist', ''),
                'track': track_info.get('track', ''),
                'album': track_info.get('album', ''),
                'track_id': track_info.get('track_id', ''),
                'track_number': track_info.get('track_number', 0)
            }

            # Add prefetched album metadata if available (server will skip Spotify page fetch)
            if album_metadata:
                payload['prefetched_year'] = album_metadata.get('year', '')
                payload['prefetched_image_url'] = album_metadata.get('image_url', '')

            # Add target folder if specified (server will move file after processing)
            if target_folder:
                payload['target_folder'] = target_folder

            # Send to Node server with REDUCED timeout (server responds immediately now)
            url = f"{self.settings['bridge_url']}/process-metadata"
            req = Request(url,
                         data=json.dumps(payload).encode('utf-8'),
                         headers={'Content-Type': 'application/json'})

            # CRITICAL FIX: Timeout reduced to 15s (server replies after rename, not after full processing)
            with urlopen(req, timeout=15) as response:
                result = json.loads(response.read().decode('utf-8'))

                if result.get('success'):
                    new_path = result.get('new_path', file_path)
                    if result.get('renamed'):
                        new_name = os.path.basename(new_path)
                        self.log(f"[Hydra+: ALBUM-META]   ✓ Renamed: {new_name}")
                    return (True, new_path)
                else:
                    self.log(f"[Hydra+: ALBUM-META]   ✗ Failed: {result.get('error', 'Unknown error')}")
                    return (False, file_path)

        except URLError as e:
            error_msg = str(e).lower()
            error_repr = repr(e).lower()
            # Check if this is a server crash (connection refused/reset)
            is_server_crash = any(x in error_msg or x in error_repr for x in [
                'connection refused', 'connection reset', 'forcibly closed',
                'cannot connect', 'connection aborted', 'winerror 10054', '10054'
            ])

            if is_server_crash:
                self.log(f"[Hydra+: ALBUM-META] ✗ SERVER CRASH DETECTED: {e}")
                self.log(f"[Hydra+: ALBUM-META] Waiting for server to restart...")

                # Wait for server to restart (up to 30 seconds)
                max_wait = 30
                for attempt in range(max_wait):
                    time.sleep(1)
                    try:
                        # Try to ping the server
                        ping_url = f"{self.settings['bridge_url']}/ping"
                        ping_req = Request(ping_url)
                        with urlopen(ping_req, timeout=2) as ping_response:
                            if ping_response.getcode() == 200:
                                self.log(f"[Hydra+: ALBUM-META] ✓ Server back online after {attempt + 1}s")
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
                                            self.log(f"[Hydra+: ALBUM-META] File was already renamed to: {possible_name}")
                                            actual_file_path = possible_path
                                            break

                                # If file exists AND was properly renamed with artist name, consider it successful
                                # Only the first format includes the artist name, others are incomplete
                                if os.path.exists(actual_file_path) and actual_file_path != file_path:
                                    # Verify it has the correct format with artist name
                                    if artist_name and artist_name in os.path.basename(actual_file_path):
                                        self.log(f"[Hydra+: ALBUM-META] ✓ Track was already processed before crash")
                                        return (True, actual_file_path)
                                    else:
                                        self.log(f"[Hydra+: ALBUM-META] ⚠ File renamed but missing artist name, needs retry")
                                        # Fall through to retry

                                # File doesn't exist in any form, try retry
                                self.log(f"[Hydra+: ALBUM-META] Retrying failed track: {os.path.basename(file_path)}")
                                return self._process_single_track_metadata(file_path, track_info, token, track_index)
                    except:
                        pass  # Server not ready yet, continue waiting

                # Server didn't come back online
                self.log(f"[Hydra+: ALBUM-META] ✗ Server did not restart within {max_wait}s")
                return (False, file_path)

            # Not a crash, just a timeout or other error
            if 'timed out' in error_msg:
                self.log(f"[Hydra+: ALBUM-META] ⚠ Timeout (continuing): {file_path}")
            else:
                self.log(f"[Hydra+: ALBUM-META] ✗ Cannot reach Node server: {e}")
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
                self.log(f"[Hydra+: ALBUM-META] ✗ SERVER CRASH DETECTED: {e}")
                self.log(f"[Hydra+: ALBUM-META] Waiting for server to restart...")

                # Wait for server to restart (up to 30 seconds)
                max_wait = 30
                for attempt in range(max_wait):
                    time.sleep(1)
                    try:
                        # Try to ping the server
                        ping_url = f"{self.settings['bridge_url']}/ping"
                        ping_req = Request(ping_url)
                        with urlopen(ping_req, timeout=2) as ping_response:
                            if ping_response.getcode() == 200:
                                self.log(f"[Hydra+: ALBUM-META] ✓ Server back online after {attempt + 1}s")
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
                                            self.log(f"[Hydra+: ALBUM-META] File was already renamed to: {possible_name}")
                                            actual_file_path = possible_path
                                            break

                                # If file exists AND was properly renamed with artist name, consider it successful
                                # Only the first format includes the artist name, others are incomplete
                                if os.path.exists(actual_file_path) and actual_file_path != file_path:
                                    # Verify it has the correct format with artist name
                                    if artist_name and artist_name in os.path.basename(actual_file_path):
                                        self.log(f"[Hydra+: ALBUM-META] ✓ Track was already processed before crash")
                                        return (True, actual_file_path)
                                    else:
                                        self.log(f"[Hydra+: ALBUM-META] ⚠ File renamed but missing artist name, needs retry")
                                        # Fall through to retry

                                # File doesn't exist in any form, try retry
                                self.log(f"[Hydra+: ALBUM-META] Retrying failed track: {os.path.basename(file_path)}")
                                return self._process_single_track_metadata(file_path, track_info, token, track_index)
                    except:
                        pass  # Server not ready yet, continue waiting

                # Server didn't come back online
                self.log(f"[Hydra+: ALBUM-META] ✗ Server did not restart within {max_wait}s")
                return (False, file_path)

            # Not a crash, just a regular error
            self.log(f"[Hydra+: ALBUM-META] ✗ Error: {e}")
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

            self.log(f"[Hydra+: ALBUM-META] Starting processing for: {os.path.basename(file_path)}")
            self.log(f"[Hydra+: ALBUM-META] Track #{track_info.get('track_number', 0)}: {track_info.get('track', '')}")

            # Verify file exists and is MP3
            if not os.path.exists(file_path):
                self.log(f"[Hydra+: ALBUM-META] ✗ File not found: {file_path}")
                return

            # Check if file is MP3 or FLAC
            file_lower = file_path.lower()
            if not (file_lower.endswith('.mp3') or file_lower.endswith('.flac')):
                self.log(f"[Hydra+: ALBUM-META] ✗ Unsupported format (only MP3/FLAC), skipping: {file_path}")
                return

            # Prepare request data with track number
            payload = {
                'file_path': file_path,
                'artist': track_info.get('artist', ''),
                'track': track_info.get('track', ''),
                'album': track_info.get('album', ''),
                'track_id': track_info.get('track_id', ''),
                'track_number': track_info.get('track_number', 0)
            }

            self.log(f"[Hydra+: ALBUM-META] Sending request to bridge server...")

            # Send to Node server with shorter timeout to avoid blocking
            url = f"{self.settings['bridge_url']}/process-metadata"
            req = Request(url,
                         data=json.dumps(payload).encode('utf-8'),
                         headers={'Content-Type': 'application/json'})

            with urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode('utf-8'))

                if result.get('success'):
                    self.log(f"[Hydra+: ALBUM-META] ✓ Processing successful!")

                    if result.get('renamed'):
                        new_name = os.path.basename(result['new_path'])
                        self.log(f"[Hydra+: ALBUM-META]   Renamed to: {new_name}")
                        # Update the file path in downloaded_tracks
                        if 'downloaded_tracks' in search_info:
                            for i, path in enumerate(search_info['downloaded_tracks']):
                                if path == file_path:
                                    search_info['downloaded_tracks'][i] = result['new_path']
                                    self.log(f"[Hydra+: ALBUM-META]   Updated tracking path")
                                    break
                else:
                    self.log(f"[Hydra+: ALBUM-META] ✗ Failed: {result.get('error', 'Unknown error')}")

        except URLError as e:
            self.log(f"[Hydra+: ALBUM-META] ✗ Cannot reach Node server: {e}")
            self.log(f"[Hydra+: ALBUM-META] Make sure bridge server is running")
        except Exception as e:
            self.log(f"[Hydra+: ALBUM-META] ✗ Error: {e}")
            import traceback
            self.log(f"[Hydra+: ALBUM-META] {traceback.format_exc()}")

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
                    self.log(f"[Hydra+: ALBUM] ⚠ First track not transferring after 15s")

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
                            self.log(f"[Hydra+: ALBUM] Removing {len(transfers_to_remove)} queued track(s) from previous folder")

                            # Try clear_downloads FIRST (removes from UI)
                            cleared = False
                            if hasattr(self.core.downloads, 'clear_downloads'):
                                try:
                                    self.core.downloads.clear_downloads(transfers_to_remove)
                                    self.log(f"[Hydra+: ALBUM] ✓ Cleared {len(transfers_to_remove)} transfer(s) from queue")
                                    cleared = True
                                except Exception as e:
                                    self.log(f"[Hydra+: ALBUM] ✗ clear_downloads failed: {e}")

                            # Fallback to abort_downloads if clear didn't work
                            if not cleared:
                                if hasattr(self.core.downloads, 'abort_downloads'):
                                    try:
                                        self.core.downloads.abort_downloads(transfers_to_remove)
                                        self.log(f"[Hydra+: ALBUM] ✓ Aborted {len(transfers_to_remove)} transfer(s)")
                                    except Exception as e:
                                        self.log(f"[Hydra+: ALBUM] ✗ abort_downloads failed: {e}")
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
                        self.log(f"[Hydra+: ALBUM] 🔄 Trying next folder (score: {int(next_folder['score'])})")
                        self.log(f"[Hydra+: ALBUM] From user: {next_folder['user']}")

                        # Reset for new folder
                        search_info['best_folder'] = next_folder
                        search_info['current_track_index'] = 0
                        search_info['download_started_at'] = None
                        search_info['downloaded_tracks'] = []

                        # Re-match tracks for new folder
                        tracks_to_download = self._match_album_tracks(search_info, next_folder)
                        if tracks_to_download:
                            search_info['tracks_to_download'] = tracks_to_download
                            self.log(f"[Hydra+: ALBUM] ✓ Matched {len(tracks_to_download)}/{len(search_info['tracks'])} tracks in new folder")
                            self._download_next_album_track(token, search_info)
                        else:
                            self.log(f"[Hydra+: ALBUM] ✗ Could not match tracks in new folder, giving up")
                            del self.active_searches[token]
                    else:
                        self.log(f"[Hydra+: ALBUM] ✗ No more folders to try, giving up")
                        del self.active_searches[token]

                    return

            # After 90 seconds, check if the download is stuck
            if download_elapsed > 90:
                current_track = tracks_to_download[current_index]
                virtual_path = current_track['file_path']

                # Check if download is still in the active_downloads tracking
                if virtual_path not in self.active_downloads:
                    # Download isn't being tracked - might have failed silently
                    self.log(f"[Hydra+: ALBUM] ⚠ Track {current_index + 1} not in tracking (after 90s)")
                    self.log(f"[Hydra+: ALBUM] Skipping to next track...")

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
                    self.log(f"[Hydra+: ALBUM] ⚠ Track {current_index + 1}: {skip_reason} (after 90s)")
                    self.log(f"[Hydra+: ALBUM] Skipping to next track...")

                    # Remove stuck download from queue using hierarchical abort approach
                    if transfer_obj:
                        # Try clear_downloads FIRST (removes from UI)
                        cleared = False
                        if hasattr(self.core.downloads, 'clear_downloads'):
                            try:
                                self.core.downloads.clear_downloads([transfer_obj])
                                self.log(f"[Hydra+: ALBUM] ✓ Cleared stuck track from queue")
                                cleared = True
                            except Exception as e:
                                self.log(f"[Hydra+: ALBUM] ✗ clear_downloads failed: {e}")

                        # Fallback to abort_downloads if clear didn't work
                        if not cleared:
                            if hasattr(self.core.downloads, 'abort_downloads'):
                                try:
                                    self.core.downloads.abort_downloads([transfer_obj])
                                    self.log(f"[Hydra+: ALBUM] ✓ Aborted stuck track")
                                except Exception as e:
                                    self.log(f"[Hydra+: ALBUM] ✗ abort_downloads failed: {e}")
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
                self.log(f"[Hydra+: ALBUM] ⚠ Album download timeout (30 minutes)")

                # Finalize with whatever we have
                if search_info.get('downloaded_tracks'):
                    self.log(f"[Hydra+: ALBUM] Finalizing with {len(search_info['downloaded_tracks'])} downloaded tracks...")
                    self._finalize_album_download(token, search_info)
                else:
                    self.log(f"[Hydra+: ALBUM] ✗ No tracks downloaded, aborting")
                    del self.active_searches[token]

        except Exception as e:
            self.log(f"[Hydra+: ALBUM] Error monitoring album download: {e}")
            import traceback
            self.log(f"[Hydra+: ALBUM] Traceback: {traceback.format_exc()}")

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
                        self.log(f"[Hydra+: DL] ⚠ {fallback_reason} (after 60s)")
                        self._try_next_download_candidate(token, search_info, fallback_reason)

                # Cleanup if download has been active for too long (5 minutes total)
                search_elapsed = current_time - search_info['timestamp']
                if search_elapsed > 300:
                    self.log(f"[Hydra+: DL] ⚠ Timeout - removing search after 5 minutes")
                    # Clean up tracking
                    if search_info['last_download_path'] in self.active_downloads:
                        del self.active_downloads[search_info['last_download_path']]
                    del self.active_searches[token]

            except Exception as e:
                self.log(f"[Hydra+: DL] Error monitoring downloads for search {token}: {e}")
                import traceback
                self.log(f"[Hydra+: DL] Traceback: {traceback.format_exc()}")

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
            tracks = search_data.get('tracks', [])
            auto_download = search_data.get('auto_download', False)
            metadata_override = search_data.get('metadata_override', True)
            format_preference = search_data.get('format_preference', 'mp3')

            self.log(f"[Hydra+: ALBUM] 🎵 Starting: {album_artist} - {album_name} ({len(tracks)} tracks, auto_download={auto_download}, format={format_preference.upper()})")

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
                self.log(f"[Hydra+: ALBUM] ⚠ Failed to get search token")
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
                self.log(f"[Hydra+: ALBUM] ✓ Tracking album search (token={search_token})")
            else:
                self.log(f"[Hydra+: ALBUM] ⚠ Not tracking (auto_download disabled)")

            return True

        except Exception as e:
            self.log(f"[Hydra+: ALBUM] ERROR: {type(e).__name__}: {str(e)}")
            import traceback
            self.log(f"[Hydra+: ALBUM] Traceback: {traceback.format_exc()}")
            return False

    def _poll_queue(self):
        """Poll the bridge server for new searches."""
        self.log("[Hydra+] Polling loop started")

        # Wait for Nicotine+ to connect to the network before processing searches
        connection_wait_start = time.time()
        max_wait_time = 60  # 60 seconds max wait (reduced from 5 min)

        while self.running and self.waiting_for_connection:
            try:
                # Check if Nicotine+ is online
                if self._is_nicotine_online():
                    self.nicotine_online = True
                    self.waiting_for_connection = False
                    self.log("[Hydra+] ✓ NICOTINE+ ONLINE → Plugin ready!")
                    break

                # Check if we've waited too long
                elapsed = time.time() - connection_wait_start
                if elapsed > max_wait_time:
                    # After 60s, assume we're ready and let it try
                    self.nicotine_online = True
                    self.waiting_for_connection = False
                    self.log("[Hydra+] ✓ Connection wait timeout - activating plugin")
                    break

                # Log progress every 10 seconds
                if int(elapsed) % 10 == 0 and elapsed > 0:
                    self.log(f"[Hydra+] Waiting for Nicotine+ connection... ({int(elapsed)}s)")

                # Wait before checking again
                time.sleep(1)

            except Exception as e:
                self.log(f"[Hydra+] Error checking connection: {e}")
                # Activate anyway on error to avoid blocking
                self.nicotine_online = True
                self.waiting_for_connection = False
                break

        while self.running:
            try:
                # Check if server is running and auto-restart if it went offline
                server_running = self._is_server_running()
                if self.server_was_running and not server_running:
                    # Server went offline - attempt auto-restart
                    self.log("════════════════════════════════════════════════════════════════")
                    self.log("  ⚠️  Bridge server went offline - attempting auto-restart...")
                    self.log("════════════════════════════════════════════════════════════════")
                    self.server_was_running = False

                    # Attempt to restart the server
                    if self.settings.get('auto_start_server', True):
                        # First, clean up any zombie processes
                        self._cleanup_server_process()

                        # Wait a moment for port to be released
                        time.sleep(1)

                        # Now start fresh server
                        if self._start_server():
                            self.log("[Hydra+] ✓ Bridge server restarted successfully")
                        else:
                            self.log("[Hydra+] ✗ Failed to restart bridge server - please restart Nicotine+ manually")
                    else:
                        self.log("[Hydra+] Auto-start disabled - please restart Nicotine+ manually")
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
                        auto_download = search.get('auto_download', False)
                        metadata_override = search.get('metadata_override', True)
                        format_preference = search.get('format_preference', 'mp3')

                        if not query:
                            continue

                        success = self._trigger_search(query, artist, track, album, track_id, duration, auto_download, metadata_override, 'track', format_preference)

                    if success:
                        # Mark as processed on server
                        self._mark_processed(timestamp)

                        # Track locally to prevent duplicates (with cleanup timestamp)
                        self.processed_timestamps[timestamp] = time.time()

                        # Add a small delay between searches
                        time.sleep(0.5)

            except Exception as e:
                self.log(f"[Hydra+] Error in poll loop: {e}")

            # Check for auto-download opportunities (event-driven now, just check timeouts)
            try:
                self._check_and_download_ready_searches()
            except Exception as e:
                self.log(f"[Hydra+] Error in auto-download check: {e}")

            # Monitor active downloads for failures/timeouts
            try:
                self._monitor_downloads()
            except Exception as e:
                self.log(f"[Hydra+] Error in download monitoring: {e}")

            # Wait before next poll
            time.sleep(self.poll_interval)
