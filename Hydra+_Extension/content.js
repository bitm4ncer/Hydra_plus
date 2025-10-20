// Configuration
const BRIDGE_URL = 'http://127.0.0.1:3847/search';
const BRIDGE_ALBUM_URL = 'http://127.0.0.1:3847/search-album';

// SVG icon for the copy button (embedded to avoid additional file loading)
const COPY_ICON_SVG = `
<svg width="16" height="16" viewBox="0 0 150 150" xmlns="http://www.w3.org/2000/svg" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;">
    <g transform="matrix(4.82005,0,0,4.82005,-45.5013,-45.919)">
        <path d="M36.71,9.57L21.15,9.57C19.038,9.57 17.3,11.308 17.3,13.42L17.3,17.17L13.3,17.17C11.192,17.164 9.451,18.892 9.44,21L9.44,36.58C9.445,38.69 11.18,40.425 13.29,40.43L28.85,40.43C30.962,40.43 32.7,38.692 32.7,36.58L32.7,32.83L36.7,32.83C38.808,32.836 40.549,31.108 40.56,29L40.56,13.42C40.555,11.31 38.82,9.575 36.71,9.57ZM29.62,36.57C29.62,36.992 29.272,37.34 28.85,37.34L13.29,37.34C12.87,37.335 12.525,36.99 12.52,36.57L12.52,21C12.52,20.578 12.868,20.23 13.29,20.23L28.85,20.23C28.853,20.23 28.857,20.23 28.86,20.23C29.277,20.23 29.62,20.573 29.62,20.99C29.62,20.993 29.62,20.997 29.62,21L29.62,36.58L29.62,36.57ZM37.48,29C37.48,29.422 37.132,29.77 36.71,29.77L32.71,29.77L32.71,21C32.71,18.888 30.972,17.15 28.86,17.15L20.38,17.15L20.38,13.42C20.38,12.998 20.728,12.65 21.15,12.65L36.71,12.65C37.13,12.655 37.475,13 37.48,13.42L37.48,29Z" style="fill:currentColor;fill-rule:nonzero;"/>
    </g>
</svg>
`;

// Hydra+ icon SVG (embedded inline for better performance and styling control)
const HYDRA_ICON_SVG = `
<svg width="16" height="16" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;">
    <g transform="matrix(1,0,0,1,-360.905,0)">
        <g transform="matrix(1,0,0,1,360.905,0)">
            <g transform="matrix(4.34939,-10.4134,5.38822,2.2505,-297.507,438.275)">
                <path d="M40.931,36.195C41.939,35.367 41.975,34.119 42.263,33.363C42.443,32.895 42.671,32.631 43.103,32.595C43.559,32.559 43.823,32.931 43.823,33.327C43.823,33.723 43.619,33.939 43.403,33.951C43.187,33.963 43.055,33.771 43.091,33.627C42.659,33.795 42.695,34.671 42.491,35.223C42.227,35.919 41.771,36.507 41.051,36.651C41.879,36.879 43.367,36.807 44.147,36.195C45.035,35.499 45.659,34.503 45.239,32.103C45.083,31.239 45.275,31.107 45.455,31.059C45.575,31.023 45.755,31.107 45.743,31.347C46.175,31.119 45.995,30.303 46.235,29.463C46.487,28.599 47.147,27.891 47.987,27.819C47.003,27.351 45.683,27.339 44.903,27.999C44.075,28.695 44.051,29.967 43.895,30.579C43.739,31.167 43.451,31.611 42.851,31.539C42.419,31.491 42.167,31.179 42.179,30.795C42.191,30.447 42.347,30.255 42.539,30.243C42.743,30.231 42.863,30.411 42.839,30.567C43.235,30.423 43.139,29.559 43.307,29.043C43.523,28.407 43.931,27.855 44.603,27.759C44.015,27.531 42.923,27.435 42.047,27.879C40.907,28.455 40.355,29.811 40.679,31.755C40.895,33.027 40.655,33.243 40.475,33.291C40.295,33.339 40.187,33.171 40.187,33.015C39.743,33.471 39.947,34.155 39.575,35.043C39.311,35.691 38.615,36.411 37.811,36.567C38.783,36.963 40.127,36.855 40.931,36.195Z" style="fill:rgb(185,255,55);fill-rule:nonzero;"/>
            </g>
            <g transform="matrix(3.69766,-0.74185,1.16093,5.78649,-105.667,-53.1991)">
                <path d="M42.419,32.715C42.779,32.715 43.079,32.667 43.307,32.523C43.727,32.259 43.859,31.719 43.799,31.311C43.559,31.671 43.043,31.647 42.455,31.575C42.443,30.915 42.551,30.435 43.019,30.147C42.287,29.883 41.627,30.171 41.387,30.807C41.315,30.987 41.279,31.191 41.255,31.407C41.003,31.383 40.739,31.383 40.547,31.431C39.947,31.587 39.563,32.127 39.779,32.859C40.103,32.451 40.559,32.451 41.231,32.583C41.219,33.231 41.147,33.843 40.703,34.071C41.123,34.155 41.711,34.047 42.059,33.651C42.251,33.423 42.359,33.099 42.419,32.715Z" style="fill:rgb(185,255,55);fill-rule:nonzero;"/>
            </g>
        </g>
    </g>
</svg>
`;

// Track which rows have already been processed
const processedRows = new WeakSet();

/**
 * Parse duration string (mm:ss) to seconds
 */
function parseDuration(durationText) {
  try {
    const parts = durationText.split(':');
    if (parts.length === 2) {
      const minutes = parseInt(parts[0], 10);
      const seconds = parseInt(parts[1], 10);
      return minutes * 60 + seconds;
    }
    return 0;
  } catch (error) {
    return 0;
  }
}

/**
 * Remove remaster/deluxe/edition suffixes from track/album names
 * Examples:
 *   "The Trooper - 2015 Remaster" -> "The Trooper"
 *   "Fear of the Dark - 2015 Remastered" -> "Fear of the Dark"
 *   "Album Name (Deluxe Edition)" -> "Album Name"
 */
function stripVersionSuffixes(text) {
  if (!text) return text;

  // Pattern matches common suffixes:
  // - Remaster/Remastered with optional year
  // - Deluxe/Special/Limited Edition variants
  // - Live/Acoustic/Radio Edit versions
  // Handles both " - " and " (" separators
  const pattern = /\s*[-(\[]\s*(
    \d{4}\s+(Remaster(ed)?|Edition)|  # 2015 Remaster, 2015 Edition
    Remaster(ed)?(\s+\d{4})?|          # Remastered, Remaster 2015
    (Deluxe|Special|Limited|Expanded|Collector'?s)\s+(Edition|Version)|
    (Live|Acoustic|Radio|Single|Album)\s+(Version|Edit|Mix)|
    Bonus\s+Track\s+Version
  ).*$/ix;

  return text.replace(pattern, '').trim();
}

/**
 * Extract artist, track name, album name, track ID, and duration from a track row element
 */
function getTrackInfo(trackRow) {
  try {
    // Check if this is a Popular section row (artist page) or regular tracklist row
    const isPopularRow = trackRow.hasAttribute('data-testid') && trackRow.getAttribute('data-testid') === 'top-tracks-entity-row';

    // Find the track name element - try both Popular section and regular tracklist selectors
    let trackNameElement = null;
    if (isPopularRow) {
      // Popular section: track link is directly in the row
      trackNameElement = trackRow.querySelector('a[href*="/track/"]');
    } else {
      // Regular tracklist: track link is within tracklist-row container
      trackNameElement = trackRow.querySelector('[data-testid="tracklist-row"] a[href*="/track/"]');
    }

    if (!trackNameElement) return null;

    const trackName = stripVersionSuffixes(trackNameElement.textContent.trim());

    // Find artist name - try both structures
    let artistElement = null;
    if (isPopularRow) {
      artistElement = trackRow.querySelector('a[href*="/artist/"]');
    } else {
      artistElement = trackRow.querySelector('[data-testid="tracklist-row"] a[href*="/artist/"]');
    }

    // For Popular section on artist page, if no artist link found, extract from page
    let artistName = '';
    if (artistElement) {
      artistName = artistElement.textContent.trim();
    } else if (isPopularRow) {
      // Try to get artist from page title (h1) on artist pages
      const h1Elements = document.querySelectorAll('h1');
      for (const h1 of h1Elements) {
        const text = h1.textContent.trim();
        if (h1.closest('button') || text === 'Your Library' || text.length < 2) {
          continue;
        }
        artistName = text;
        break;
      }
    }

    if (!artistName) return null;

    // Extract album name from album link
    let albumName = '';
    let albumElement = null;
    if (isPopularRow) {
      albumElement = trackRow.querySelector('a[href*="/album/"]');
    } else {
      albumElement = trackRow.querySelector('[data-testid="tracklist-row"] a[href*="/album/"]');
    }

    if (albumElement) {
      albumName = stripVersionSuffixes(albumElement.textContent.trim());
      console.log('[Track Info] Found album:', albumName);
    } else {
      console.log('[Track Info] No album link found in track row');
    }

    // Extract track ID from track URL
    let trackId = '';
    const trackHref = trackNameElement.getAttribute('href');
    if (trackHref) {
      const trackIdMatch = trackHref.match(/\/track\/([a-zA-Z0-9]+)/);
      if (trackIdMatch) {
        trackId = trackIdMatch[1];
        console.log('[Track Info] Found track ID:', trackId);
      }
    }

    // Find duration - try multiple selectors
    let duration = 0;

    try {
      // Try to find the duration column (usually the last column in the track row)
      let durationCandidates;
      if (isPopularRow) {
        // Popular section: search all divs in the row
        durationCandidates = trackRow.querySelectorAll('div');
      } else {
        // Regular tracklist: search within tracklist-row
        durationCandidates = trackRow.querySelectorAll('[data-testid="tracklist-row"] div');
      }

      // Look for a cell that contains time format (mm:ss)
      for (let i = durationCandidates.length - 1; i >= 0; i--) {
        const text = durationCandidates[i].textContent.trim();
        const timePattern = /^\d+:\d+$/;
        if (timePattern.test(text)) {  // Matches "3:45" format
          duration = parseDuration(text);
          console.log('[Track Info] Found duration:', text, '=', duration, 'seconds');
          break;
        }
      }
    } catch (durationError) {
      console.log('[Track Info] Could not extract duration:', durationError);
      duration = 0;
    }

    return { artistName, trackName, albumName, trackId, duration };
  } catch (error) {
    console.error('Error extracting track info:', error);
    return null;
  }
}

/**
 * Copy text to clipboard
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
    return false;
  }
}

/**
 * Send track info to Nicotine+ bridge server
 */
async function sendToNicotine(trackInfo) {
  // Format query as "artist track" (space-separated, better for Soulseek)
  const query = `${trackInfo.artistName} ${trackInfo.trackName}`;

  // Get settings from Chrome storage with safe defaults
  let autoDownload = true; // Default to true (matches popup.js default)
  let metadataOverride = true; // Default to true
  let formatPreference = 'mp3'; // Default to mp3

  // Safely attempt to read from Chrome storage
  try {
    // Check if Chrome extension API is available
    if (typeof chrome !== 'undefined' && chrome?.storage?.sync) {
      const result = await chrome.storage.sync.get(['autoDownload', 'metadataOverride', 'formatPreference']);
      autoDownload = result.autoDownload !== false; // Default to true
      metadataOverride = result.metadataOverride !== false; // Default to true
      formatPreference = result.formatPreference || 'mp3'; // Default to mp3
      console.log('[Hydra+] sendToNicotine - Loaded settings from storage:', {
        autoDownload,
        metadataOverride,
        formatPreference,
        rawFormatPref: result.formatPreference
      });
    } else {
      // Chrome API not available, use defaults
      console.warn('[Hydra+] Chrome storage API not available - using default settings');
    }
  } catch (error) {
    // Any error accessing storage - use defaults and continue
    console.warn('[Hydra+] Could not access storage - using default settings:', error.message || error);
    // Continue with default values (don't return, just log and proceed)
  }

  console.log('[Nicotine+] Attempting to send:', query);
  console.log('[Nicotine+] Artist:', trackInfo.artistName);
  console.log('[Nicotine+] Track:', trackInfo.trackName);
  console.log('[Nicotine+] Album:', trackInfo.albumName);
  console.log('[Nicotine+] Track ID:', trackInfo.trackId);
  console.log('[Nicotine+] Duration:', trackInfo.duration, 'seconds');
  console.log('[Nicotine+] Auto-download:', autoDownload);
  console.log('[Nicotine+] Format preference:', formatPreference);
  console.log('[Nicotine+] Bridge URL:', BRIDGE_URL);

  try {
    const response = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: query,
        artist: trackInfo.artistName,
        track: trackInfo.trackName,
        album: trackInfo.albumName,
        track_id: trackInfo.trackId,
        duration: trackInfo.duration,
        auto_download: autoDownload,
        metadata_override: metadataOverride,
        format_preference: formatPreference
      })
    });

    console.log('[Nicotine+] Response status:', response.status);

    if (response.ok) {
      const result = await response.json();
      console.log('[Nicotine+] Success:', result);
      return true;
    } else {
      console.error('[Nicotine+] Bridge server returned error:', response.status);
      return false;
    }
  } catch (error) {
    console.error('[Nicotine+] Failed to send:', error);
    console.error('[Nicotine+] Error details:', error.message);
    return false;
  }
}

/**
 * Create and return a copy button element
 */
function createCopyButton(trackInfo) {
  const button = document.createElement('button');
  button.className = 'spotify-track-copy-btn';
  button.innerHTML = COPY_ICON_SVG;
  button.title = `Copy: ${trackInfo.artistName} - ${trackInfo.trackName}`;
  button.setAttribute('aria-label', 'Copy track information');

  // Handle click event
  button.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const textToCopy = `${trackInfo.artistName} - ${trackInfo.trackName}`;
    const success = await copyToClipboard(textToCopy);

    if (success) {
      // Visual feedback - change icon color briefly
      button.classList.add('copied');
      setTimeout(() => {
        button.classList.remove('copied');
      }, 1000);
    }
  });

  return button;
}

/**
 * Create and return a "Send to Nicotine+" button element
 */
function createNicotineButton(trackInfo) {
  const button = document.createElement('button');
  button.className = 'spotify-track-nicotine-btn';
  button.innerHTML = HYDRA_ICON_SVG;
  button.title = `Send to Nicotine+: ${trackInfo.artistName} - ${trackInfo.trackName}`;
  button.setAttribute('aria-label', 'Send to Nicotine+');

  // Handle click event - use capture phase to intercept before Spotify's handlers
  button.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    console.log('[Nicotine+] Button clicked for:', trackInfo);

    const success = await sendToNicotine(trackInfo);

    if (success === true) {
      // Visual feedback - change icon color briefly
      console.log('[Nicotine+] Button feedback: success');
      button.classList.add('sent');
      setTimeout(() => {
        button.classList.remove('sent');
      }, 1000);
    } else {
      // Error feedback
      console.log('[Nicotine+] Button feedback: error');
      button.classList.add('error');
      setTimeout(() => {
        button.classList.remove('error');
      }, 1000);
    }
  }, true);

  return button;
}

/**
 * Check if we're on an album page
 */
function isAlbumPage() {
  const url = window.location.href;
  return url.includes('/album/');
}

/**
 * Extract album ID from current URL
 */
function getAlbumId() {
  const url = window.location.href;
  const match = url.match(/\/album\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Get album information from the page
 */
function getAlbumInfo() {
  try {
    const albumId = getAlbumId();
    if (!albumId) {
      console.log('[Album Info] No album ID found in URL');
      return null;
    }

    // Find album title - be more specific to avoid getting button text
    // Look for the main heading that's NOT inside a button
    let albumTitleElement = null;
    const headings = document.querySelectorAll('h1');
    for (const h1 of headings) {
      // Skip if inside a button or if text is "Your Library" or other UI text
      const text = h1.textContent.trim();
      if (h1.closest('button') || text === 'Your Library' || text.length < 2) {
        continue;
      }
      albumTitleElement = h1;
      break;
    }

    if (!albumTitleElement) {
      console.log('[Album Info] Album title element not found');
      return null;
    }

    const albumName = stripVersionSuffixes(albumTitleElement.textContent.trim());
    console.log('[Album Info] Extracted album name:', albumName);

    // Find album artist - look in the metadata section near the album title
    // Try to find artist link near the album header (more specific selector)
    let albumArtistElement = null;

    // Strategy 1: Find artist link in the same parent container as the h1
    const headerContainer = albumTitleElement.closest('[data-testid="entity-header"]') ||
                           albumTitleElement.closest('header') ||
                           albumTitleElement.closest('section');

    if (headerContainer) {
      albumArtistElement = headerContainer.querySelector('a[href*="/artist/"]');
      console.log('[Album Info] Found artist in header container');
    }

    // Strategy 2: Look for artist link that's a sibling or near-sibling of the h1
    if (!albumArtistElement) {
      // Get the parent of the h1 and search within a limited scope
      const h1Parent = albumTitleElement.parentElement;
      if (h1Parent) {
        // First try within the immediate parent
        albumArtistElement = h1Parent.querySelector('a[href*="/artist/"]');

        // If not found, try the parent's parent (grandparent scope)
        if (!albumArtistElement && h1Parent.parentElement) {
          albumArtistElement = h1Parent.parentElement.querySelector('a[href*="/artist/"]');
        }

        if (albumArtistElement) {
          console.log('[Album Info] Found artist near h1 element');
        }
      }
    }

    // Strategy 3: Find artist link that appears BEFORE the first track row
    // This prevents selecting from recommendations or "More by" sections
    if (!albumArtistElement) {
      const firstTrackRow = document.querySelector('[data-testid="tracklist-row"]');
      const allArtistLinks = document.querySelectorAll('a[href*="/artist/"]');

      for (const link of allArtistLinks) {
        const linkText = link.textContent.trim();
        // Skip empty links or very short text (likely icons)
        if (linkText.length < 2) continue;

        // If we have a track row, only accept artist links that appear before it in the DOM
        if (firstTrackRow) {
          const linkPosition = link.compareDocumentPosition(firstTrackRow);
          // DOCUMENT_POSITION_FOLLOWING (4) means firstTrackRow comes after link
          if (linkPosition & Node.DOCUMENT_POSITION_FOLLOWING) {
            albumArtistElement = link;
            console.log('[Album Info] Found artist before track listing');
            break;
          }
        } else {
          // No track row found yet, just use the first valid artist link
          albumArtistElement = link;
          console.log('[Album Info] Found artist via DOM traversal (no tracklist yet)');
          break;
        }
      }
    }

    if (!albumArtistElement) {
      console.log('[Album Info] Album artist element not found');
      return null;
    }

    const albumArtist = albumArtistElement.textContent.trim();
    console.log('[Album Info] Extracted artist:', albumArtist);
    console.log('[Album Info] Artist element href:', albumArtistElement.href);
    console.log('[Album Info] Artist element text:', albumArtistElement.textContent);

    // Try to find year from metadata (it's usually in a span near the album info)
    let year = '';
    const metadataElements = document.querySelectorAll('span[data-encore-id="text"]');
    for (const elem of metadataElements) {
      const text = elem.textContent.trim();
      // Look for 4-digit year
      const yearMatch = text.match(/\b(19|20)\d{2}\b/);
      if (yearMatch) {
        year = yearMatch[0];
        break;
      }
    }

    console.log('[Album Info] Found album:', albumArtist, '-', albumName, year ? `(${year})` : '');

    return {
      albumId,
      albumName,
      albumArtist,
      year
    };
  } catch (error) {
    console.error('Error extracting album info:', error);
    return null;
  }
}

/**
 * Get all tracks from the album page
 */
function getAllAlbumTracks(albumName, albumArtist) {
  const tracks = [];
  const trackRows = document.querySelectorAll('[data-testid="tracklist-row"]');

  let trackNumber = 1;
  for (const row of trackRows) {
    const trackInfo = getTrackInfo(row);
    if (trackInfo) {
      tracks.push({
        track_number: trackNumber,
        artist: albumArtist || trackInfo.artistName, // Use album artist first, fallback to track artist
        track: trackInfo.trackName,
        album: albumName || trackInfo.albumName, // Use provided album name or fallback to extracted
        track_id: trackInfo.trackId,
        duration: trackInfo.duration
      });
      trackNumber++;
    }
  }

  console.log('[Album Info] Found', tracks.length, 'tracks');
  return tracks;
}

/**
 * Send album to Nicotine+
 */
async function sendAlbumToNicotine(albumInfo, tracks) {
  // Get settings from Chrome storage with safe defaults
  let autoDownload = true; // Default to true (matches popup.js default)
  let metadataOverride = true; // Default to true
  let formatPreference = 'mp3'; // Default to mp3

  // Safely attempt to read from Chrome storage
  try {
    // Check if Chrome extension API is available
    if (typeof chrome !== 'undefined' && chrome?.storage?.sync) {
      const result = await chrome.storage.sync.get(['autoDownload', 'metadataOverride', 'formatPreference']);
      autoDownload = result.autoDownload !== false; // Default to true
      metadataOverride = result.metadataOverride !== false; // Default to true
      formatPreference = result.formatPreference || 'mp3'; // Default to mp3
    }
    // If storage not available, silently use defaults (no warning needed)
  } catch (error) {
    // Any error accessing storage - silently use defaults and continue
  }

  console.log('[Album] Attempting to send:', albumInfo.albumArtist, '-', albumInfo.albumName);
  console.log('[Album] Tracks:', tracks.length);
  console.log('[Album] Auto-download:', autoDownload);
  console.log('[Album] Format preference:', formatPreference);

  try {
    const response = await fetch(BRIDGE_ALBUM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        album_id: albumInfo.albumId,
        album_name: albumInfo.albumName,
        album_artist: albumInfo.albumArtist,
        year: albumInfo.year,
        tracks: tracks,
        auto_download: autoDownload,
        metadata_override: metadataOverride,
        format_preference: formatPreference
      })
    });

    console.log('[Album] Response status:', response.status);

    if (response.ok) {
      const result = await response.json();
      console.log('[Album] Success:', result);
      return true;
    } else {
      console.error('[Album] Bridge server returned error:', response.status);
      return false;
    }
  } catch (error) {
    console.error('[Album] Failed to send:', error);
    console.error('[Album] Error details:', error.message);
    return false;
  }
}

/**
 * Create album download button
 */
function createAlbumButton(albumInfo) {
  const button = document.createElement('button');
  button.className = 'spotify-album-nicotine-btn';
  // Use larger SVG for album button (30px instead of 20px = 50% bigger)
  const iconContainer = document.createElement('div');
  iconContainer.innerHTML = HYDRA_ICON_SVG;
  iconContainer.style.width = '30px';
  iconContainer.style.height = '30px';
  iconContainer.querySelector('svg').style.width = '100%';
  iconContainer.querySelector('svg').style.height = '100%';
  button.appendChild(iconContainer);
  button.title = `Download Album to Nicotine+: ${albumInfo.albumName}`;
  button.setAttribute('aria-label', 'Download Album to Nicotine+');

  button.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    console.log('[Album] Button clicked - extracting current album data...');

    // Re-extract album info to ensure we have the current page's data
    const currentAlbumInfo = getAlbumInfo();
    if (!currentAlbumInfo) {
      console.error('[Album] Could not extract album info on click');
      button.classList.add('error');
      setTimeout(() => button.classList.remove('error'), 2000);
      return;
    }

    console.log('[Album] Extracted album info:', {
      albumName: currentAlbumInfo.albumName,
      albumArtist: currentAlbumInfo.albumArtist,
      albumId: currentAlbumInfo.albumId,
      year: currentAlbumInfo.year
    });

    const currentTracks = getAllAlbumTracks(currentAlbumInfo.albumName, currentAlbumInfo.albumArtist);
    if (currentTracks.length === 0) {
      console.error('[Album] No tracks found on click');
      button.classList.add('error');
      setTimeout(() => button.classList.remove('error'), 2000);
      return;
    }

    console.log('[Album] Button clicked for:', currentAlbumInfo.albumName);
    console.log('[Album] Tracks:', currentTracks.length);

    const success = await sendAlbumToNicotine(currentAlbumInfo, currentTracks);

    if (success) {
      button.classList.add('sent');
      setTimeout(() => {
        button.classList.remove('sent');
      }, 2000);
    } else {
      button.classList.add('error');
      setTimeout(() => {
        button.classList.remove('error');
      }, 2000);
    }
  }, true);

  return button;
}

/**
 * Process album page and add album download button
 */
let albumProcessed = false;
function processAlbumPage() {
  // Only process once per page
  if (albumProcessed) return;

  const albumInfo = getAlbumInfo();
  if (!albumInfo) {
    console.log('[Album] Could not extract album info');
    return;
  }

  // Pass album name and artist to ensure tracks get the correct metadata
  const tracks = getAllAlbumTracks(albumInfo.albumName, albumInfo.albumArtist);
  if (tracks.length === 0) {
    console.log('[Album] No tracks found yet, waiting...');
    return;
  }

  // Find the action bar where we should add the button
  // Spotify typically has buttons in a div with specific classes
  // Common selectors: action bar row, button container near play button
  const actionBar = document.querySelector('[data-testid="action-bar-row"]') ||
                    document.querySelector('[data-testid="top-level-queue-button"]')?.parentElement ||
                    document.querySelector('[data-testid="add-button"]')?.parentElement;

  if (!actionBar) {
    console.log('[Album] Action bar not found yet');
    return;
  }

  // Remove any existing album button first (in case of stale button)
  const existingButton = actionBar.querySelector('.spotify-album-nicotine-btn');
  if (existingButton) {
    console.log('[Album] Removing existing album button');
    existingButton.remove();
  }

  const albumButton = createAlbumButton(albumInfo);
  actionBar.appendChild(albumButton);

  albumProcessed = true;
  console.log('[Album] Album download button added for:', albumInfo.albumName);
}

/**
 * Process a single track row and add copy button and Nicotine+ button
 */
function processTrackRow(trackRow) {
  // Skip if already processed
  if (processedRows.has(trackRow)) return;

  // Extract track information
  const trackInfo = getTrackInfo(trackRow);
  if (!trackInfo) return;

  // Find the menu button (three-dot button)
  const menuButton = trackRow.querySelector('[data-testid="more-button"], button[aria-label*="More options"], button[aria-haspopup="menu"]');
  if (!menuButton) return;

  // Create buttons
  const nicotineButton = createNicotineButton(trackInfo);
  const copyButton = createCopyButton(trackInfo);

  // Insert buttons before the menu button (Nicotine+ button first, then copy button)
  menuButton.parentElement.insertBefore(nicotineButton, menuButton);
  menuButton.parentElement.insertBefore(copyButton, menuButton);

  // Mark as processed
  processedRows.add(trackRow);
}

/**
 * Find and process all track rows in the page
 */
function processAllTrackRows() {
  // Regular tracklist rows (albums, playlists)
  const trackRows = document.querySelectorAll('[data-testid="tracklist-row"]');
  trackRows.forEach(row => processTrackRow(row));

  // Popular section rows (artist pages) - these use a different structure
  const popularRows = document.querySelectorAll('div[data-testid="top-tracks-entity-row"]');
  popularRows.forEach(row => processTrackRow(row));
}

/**
 * Initialize the extension
 */
function init() {
  // Process initial tracks
  processAllTrackRows();

  // If on album page, add album download button
  if (isAlbumPage()) {
    processAlbumPage();
  }

  // Set up MutationObserver to handle dynamically loaded content
  const observer = new MutationObserver((mutations) => {
    let shouldProcess = false;

    for (const mutation of mutations) {
      // Check if new nodes were added
      if (mutation.addedNodes.length > 0) {
        shouldProcess = true;
        break;
      }
    }

    if (shouldProcess) {
      processAllTrackRows();

      // Try to add album button if on album page and not yet added
      if (isAlbumPage() && !albumProcessed) {
        processAlbumPage();
      }
    }
  });

  // Observe the entire document for changes
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  console.log('Nicotine+ Browser Link extension initialized');
}

// Reset album processed flag when navigating (Spotify is a SPA)
// IMPROVED: Cleanup observer and optimize navigation detection
let lastUrl = location.href;
let lastAlbumId = null;
const navigationObserver = new MutationObserver(() => {
  const url = location.href;
  const currentAlbumId = getAlbumId();

  if (url !== lastUrl || currentAlbumId !== lastAlbumId) {
    console.log('[Album] Navigation detected - resetting album state');
    lastUrl = url;
    lastAlbumId = currentAlbumId;
    albumProcessed = false; // Reset flag when URL changes

    // Re-process if we navigated to an album page
    if (isAlbumPage()) {
      setTimeout(() => processAlbumPage(), 500); // Small delay for content to load
    }
  }
});

navigationObserver.observe(document, { subtree: true, childList: true });

// Cleanup on page unload to prevent memory leaks
window.addEventListener('beforeunload', () => {
  if (navigationObserver) {
    navigationObserver.disconnect();
  }
});

// Wait for the page to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
