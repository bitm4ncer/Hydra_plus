===============================================================================

          $@*1,c                 ,7***
   r*$   $$$$$$s                $$$$$
 ,$$$$$$ $$$$$$$;                $$$$$  _____              $$$$$
,$$$$$$$ $$$$$$$ ___     ,r@$$$$$$$$ l$$ $$,,s@&s,  s@&s,_$$$$$
$$$$$$ss$$$$$$$l $$$$;  $$$$.$$$$;  $$$$l_  $$$$, $$$ $$$$   ~$$$$.     ~$$$$.  
$$$$$$$ `$$$$$$$ ;$$$$;  $$$$l$$$$;  $$$$;   $$$$     $$$$;   $$$$$$~  :$$$$$$$$$$$:
 l$$$$$  $$$$$l   l$$$$s  s$$$$ l$$$$s s$$_   $$$$     $$$$s s$$$$$$___      ~$$$$.
  L*$$$  $$$$$$     L*@$$$$$$$$$  L*$$$$$$$ $$ $$$$$      L*$$$$$$$  *$$$     
    ^^   $@*!'            $$$$$      `````     ^^^^^           ^^^^^     
                          $$$$$
                        ,$$$$$$$
                     L*@@*!'

===============================================================================
                             --- v0.1.0 ---

          SPOTIFY → SOULSEEK BRIDGE  |  Multi-headed auto-download beast 


┌──────────────────────────────────────────────────────────────────────────────┐
│                            >> WHAT IS THIS? <<                               │
└──────────────────────────────────────────────────────────────────────────────┘

  Click a button in Spotify → Auto-search & download on Soulseek
  → Clean metadata & artwork applied automatically

  ╔═══════════════════════════════════════════════════════════════════════════╗
  ║  BROWSER EXTENSION  →  BRIDGE SERVER  →  NICOTINE+ PLUGIN  →  DOWNLOAD  ║
  ╚═══════════════════════════════════════════════════════════════════════════╝


┌──────────────────────────────────────────────────────────────────────────────┐
│                              >> FEATURES <<                                  │
└──────────────────────────────────────────────────────────────────────────────┘

  [√] One-click send from Spotify to Nicotine+
  [√] Smart auto-download with quality scoring
  [√] Automatic fallback - tries top 5 candidates on failure
  [√] Professional metadata management:
      • Renames to "Artist - Track.mp3"
      • Fixes ID3 tags (Artist, Title, Album, Year, Track#)
      • Embeds high-quality album artwork
      • Optional: Genre & Label (with Spotify API)
  [√] Extension popup with full control
  [√] Visual feedback on all actions


┌──────────────────────────────────────────────────────────────────────────────┐
│                           >> QUICK START <<                                  │
└──────────────────────────────────────────────────────────────────────────────┘

  1. INSTALL BROWSER EXTENSION
     • chrome://extensions/ → Enable Developer Mode
     • Load unpacked → Select "Spotify_TrackCopy" folder

  2. INSTALL NICOTINE+ PLUGIN
     • Copy "nicotine_browser_link" to:
       Windows: C:\Users\[You]\AppData\Roaming\nicotine\plugins\
       Linux:   ~/.local/share/nicotine/plugins/
     • Nicotine+ → Settings → Plugins → Enable "Nicotine+ Hydra+"

  3. INSTALL NODE.JS DEPENDENCIES
     • Navigate to plugin Server folder:
       cd "C:\Users\[You]\AppData\Roaming\nicotine\plugins\nicotine_browser_link\Server"
     • Run: npm install
     • Bridge auto-starts when plugin enabled!

  4. USE IT
     • Go to open.spotify.com (any playlist/album)
     • Click Send button (▶) next to any track
     • Orange = Success, Red = Error
     • Nicotine+ auto-searches and downloads!


┌──────────────────────────────────────────────────────────────────────────────┐
│                       >> METADATA PROCESSING <<                              │
└──────────────────────────────────────────────────────────────────────────────┘

  WITHOUT SPOTIFY API:              WITH SPOTIFY API:
  ────────────────────              ─────────────────
  [√] Artist Name                   [√] All without API features +
  [√] Track Title                   [√] Genre
  [√] Album Name                    [√] Label/Publisher
  [√] Release Year
  [√] Track Number
  [√] High-Quality Artwork

  Get API credentials: developer.spotify.com/dashboard
  → Create App → Copy Client ID & Secret → Paste in extension popup

  Credentials are only stored locally and free to use.

┌──────────────────────────────────────────────────────────────────────────────┐
│                      >> AUTO-DOWNLOAD SCORING <<                             │
└──────────────────────────────────────────────────────────────────────────────┘

  BITRATE (max 100)      DURATION (max 100)      FILE SIZE (max 50)
  320kbps = 100          ±2sec  = 100            >8MB = 50
  256kbps = 80           ±5sec  = 80             >5MB = 40
  192kbps = 60           ±10sec = 50             >3MB = 30
  128kbps = 40           ±20sec = 25             >1MB = 20

  FILENAME MATCH (max 50)                        FILE TYPE (+10)
  Exact = 50, Word match = proportional          .mp3 = +10

  ═══════════════════════════════════════════════════════════════════════════

  TRIGGERS:
  • Score >100 after 15s → Download now (high confidence)
  • Score >50 after 30s  → Download best (timeout)
  • Top 5 candidates tracked for auto-fallback

  PLANNED: User-defined scoring preferences!


┌──────────────────────────────────────────────────────────────────────────────┐
│                         >> REQUIREMENTS <<                                   │
└──────────────────────────────────────────────────────────────────────────────┘

  BROWSER:    Vivaldi, Brave, Chrome, Edge (Manifest V3)
  SERVER:     Node.js v14+, npm package: node-id3
  PLUGIN:     Nicotine+ (Soulseek client), Python, Internet


┌──────────────────────────────────────────────────────────────────────────────┐
│                           >> ARCHITECTURE <<                                 │
└──────────────────────────────────────────────────────────────────────────────┘

  ┌──────────────┐
  │ SPOTIFY WEB  │  Click Send
  └──────┬───────┘
         │
         ▼ HTTP POST
  ┌──────────────┐
  │    BRIDGE    │  Queue JSON
  │   (Node.js)  │
  └──────┬───────┘
         │
         ▼ Poll /pending
  ┌──────────────┐
  │  NICOTINE+   │  do_search()
  │   PLUGIN     │
  └──────┬───────┘
         │
         ▼ Download complete
  ┌──────────────┐
  │   METADATA   │  Fix tags, rename, artwork
  │  PROCESSOR   │
  └──────┬───────┘
         │
         ▼
    Clean MP3!


┌──────────────────────────────────────────────────────────────────────────────┐
│                            >> FILE TREE <<                                   │
└──────────────────────────────────────────────────────────────────────────────┘

  Spotify_TrackCopy/          nicotine_browser_link/
  ├── icon/                   ├── Server/
  ├── assets/                 │   ├── bridge-server.js
  ├── manifest.json           │   ├── package.json
  ├── content.js              │   ├── node_modules/
  ├── popup.html              │   └── nicotine-queue.json
  ├── popup.js                ├── __init__.py
  ├── styles.css              └── PLUGININFO
  └── README.txt


┌──────────────────────────────────────────────────────────────────────────────┐
│                          >> TROUBLESHOOTING <<                               │
└──────────────────────────────────────────────────────────────────────────────┘

  Buttons not showing?        → Refresh Spotify, check chrome://extensions/
  Send button red?            → Bridge not running, check plugin enabled
  Not auto-searching?         → Enable plugin in Nicotine+ settings
  Metadata not applied?       → Enable "Metadata Override" in popup
  Spotify API won't connect?  → Verify credentials, create new app


================================================================================

              Made with <3 for the Soulseek community

================================================================================
