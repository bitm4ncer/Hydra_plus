#!/bin/bash

# Colors - Lime green (#B9FF37 approximation)
GREEN='\033[1;92m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to wait for user
wait_for_enter() {
    echo ""
    echo -e "${GREEN}  Press ENTER to continue...${NC}"
    read
}

# Welcome Screen
clear
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo "                   H Y D R A +   I N S T A L L E R"
echo "                     Nicotine+ Browser Link v0.1.0"
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo "  This installer will guide you through 5 steps:"
echo ""
echo "   [1] Check Node.js installation"
echo "   [2] Verify Nicotine+ directory"
echo "   [3] Install Nicotine+ plugin"
echo "   [4] Install Node.js dependencies"
echo "   [5] Setup browser extension"
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo -e "${GREEN}  Press ENTER to begin installation...${NC}"
read

# ============================================================================
# STEP 1: Check Node.js
# ============================================================================
clear
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo "   STEP 1 OF 5: CHECKING NODE.JS"
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo "  Progress: [####....................] 20%"
echo ""
echo "  Checking if Node.js is installed..."
echo ""

if ! command -v node &> /dev/null; then
    echo -e "${RED}  +-------------------------------------------------------------------+${NC}"
    echo -e "${RED}  |  ERROR: Node.js is NOT installed!                                |${NC}"
    echo -e "${RED}  +-------------------------------------------------------------------+${NC}"
    echo ""
    echo "  Please install Node.js first:"
    echo ""

    # Detect OS
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "  macOS detected - Install options:"
        echo "    Option 1 (Homebrew): brew install node"
        echo "    Option 2 (Direct):   https://nodejs.org/"
        echo ""
        echo "  Opening Node.js download page in 3 seconds..."
        sleep 3
        open https://nodejs.org/en/download/
    else
        echo "  Linux detected - Install options:"
        echo "    Ubuntu/Debian: sudo apt install nodejs npm"
        echo "    Fedora:        sudo dnf install nodejs npm"
        echo "    Arch:          sudo pacman -S nodejs npm"
        echo "    Or download:   https://nodejs.org/"
        echo ""
        xdg-open https://nodejs.org/en/download/ 2>/dev/null || echo "  Visit: https://nodejs.org/"
    fi

    echo ""
    exit 1
fi

node --version
echo ""
echo -e "${GREEN}  +-------------------------------------------------------------------+${NC}"
echo -e "${GREEN}  |  SUCCESS: Node.js is installed and ready!                        |${NC}"
echo -e "${GREEN}  +-------------------------------------------------------------------+${NC}"

wait_for_enter

# ============================================================================
# STEP 2: Check Nicotine+ Directory
# ============================================================================
clear
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo "   STEP 2 OF 5: VERIFYING NICOTINE+ DIRECTORY"
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo "  Progress: [########................] 40%"
echo ""

# Define paths based on OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    NICOTINE_PLUGINS="$HOME/Library/Application Support/Nicotine/plugins"
    EXTENSION_DEST="$HOME/Library/Application Support/Hydra+/Extension"
    OS_NAME="macOS"
else
    # Linux
    NICOTINE_PLUGINS="$HOME/.local/share/nicotine/plugins"
    EXTENSION_DEST="$HOME/.local/share/Hydra+/Extension"
    OS_NAME="Linux"
fi

PLUGIN_NAME="Hydra+_0.1.0_Plugin"
PLUGIN_DEST="$NICOTINE_PLUGINS/$PLUGIN_NAME"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "  Checking: $NICOTINE_PLUGINS"
echo ""

if [ ! -d "$NICOTINE_PLUGINS" ]; then
    echo -e "${YELLOW}  +-------------------------------------------------------------------+${NC}"
    echo -e "${YELLOW}  |  WARNING: Nicotine+ plugins directory not found                  |${NC}"
    echo -e "${YELLOW}  +-------------------------------------------------------------------+${NC}"
    echo ""
    echo "  Creating plugins directory..."
    echo "  (Nicotine+ will detect it automatically on next start)"
    echo ""
    mkdir -p "$NICOTINE_PLUGINS"
fi

echo -e "${GREEN}  +-------------------------------------------------------------------+${NC}"
echo -e "${GREEN}  |  SUCCESS: Plugin directory is ready                              |${NC}"
echo -e "${GREEN}  +-------------------------------------------------------------------+${NC}"

wait_for_enter

# ============================================================================
# STEP 3: Install Plugin
# ============================================================================
clear
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo "   STEP 3 OF 5: INSTALLING NICOTINE+ PLUGIN"
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo "  Progress: [############............] 60%"
echo ""

if [ -d "$PLUGIN_DEST" ]; then
    echo "  Removing old installation..."
    rm -rf "$PLUGIN_DEST"
    echo ""
fi

echo "  Copying plugin files..."
echo ""

if [ ! -f "$SCRIPT_DIR/Hydra+_0.1.0_Extension/popup.js" ]; then
    echo -e "${RED}  +-------------------------------------------------------------------+${NC}"
    echo -e "${RED}  |  ERROR: Source files not found!                                  |${NC}"
    echo -e "${RED}  +-------------------------------------------------------------------+${NC}"
    echo ""
    echo "  Make sure you're running this from the extracted Hydra+ folder."
    echo ""
    exit 1
fi

if [ ! -f "$SCRIPT_DIR/Hydra+_0.1.0_Plugin/__init__.py" ]; then
    echo -e "${RED}  +-------------------------------------------------------------------+${NC}"
    echo -e "${RED}  |  ERROR: Plugin files not found!                                  |${NC}"
    echo -e "${RED}  +-------------------------------------------------------------------+${NC}"
    echo ""
    echo "  Expected: $SCRIPT_DIR/Hydra+_0.1.0_Plugin/"
    echo ""
    exit 1
fi

cp -R "$SCRIPT_DIR/Hydra+_0.1.0_Plugin" "$PLUGIN_DEST"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}  +-------------------------------------------------------------------+${NC}"
    echo -e "${GREEN}  |  SUCCESS: Plugin files installed                                 |${NC}"
    echo -e "${GREEN}  +-------------------------------------------------------------------+${NC}"
    echo ""
    echo "  Location: $PLUGIN_DEST"
else
    echo -e "${RED}  +-------------------------------------------------------------------+${NC}"
    echo -e "${RED}  |  ERROR: Failed to copy plugin files                              |${NC}"
    echo -e "${RED}  +-------------------------------------------------------------------+${NC}"
    exit 1
fi

wait_for_enter

# ============================================================================
# STEP 4: Install Dependencies
# ============================================================================
clear
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo "   STEP 4 OF 5: INSTALLING NODE.JS DEPENDENCIES"
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo "  Progress: [################........] 80%"
echo ""
echo "  Installing npm packages (node-id3)..."
echo "  This may take a moment..."
echo ""

cd "$PLUGIN_DEST/Server"
if [ -f "package.json" ]; then
    npm install --silent --no-progress
    if [ $? -eq 0 ]; then
        echo ""
        echo -e "${GREEN}  +-------------------------------------------------------------------+${NC}"
        echo -e "${GREEN}  |  SUCCESS: Dependencies installed                                 |${NC}"
        echo -e "${GREEN}  +-------------------------------------------------------------------+${NC}"
    else
        echo ""
        echo -e "${RED}  +-------------------------------------------------------------------+${NC}"
        echo -e "${RED}  |  ERROR: Failed to install dependencies                           |${NC}"
        echo -e "${RED}  +-------------------------------------------------------------------+${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}  +-------------------------------------------------------------------+${NC}"
    echo -e "${YELLOW}  |  WARNING: package.json not found                                 |${NC}"
    echo -e "${YELLOW}  +-------------------------------------------------------------------+${NC}"
fi

wait_for_enter

# ============================================================================
# STEP 5: Setup Extension
# ============================================================================
clear
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo "   STEP 5 OF 5: SETTING UP BROWSER EXTENSION"
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo "  Progress: [####################] 100%"
echo ""

if [ -d "$EXTENSION_DEST" ]; then
    echo "  Removing old extension..."
    rm -rf "$EXTENSION_DEST"
    echo ""
fi

echo "  Copying extension files..."
echo ""

mkdir -p "$EXTENSION_DEST"
cp -R "$SCRIPT_DIR/Hydra+_0.1.0_Extension/"* "$EXTENSION_DEST/"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}  +-------------------------------------------------------------------+${NC}"
    echo -e "${GREEN}  |  SUCCESS: Extension files copied                                 |${NC}"
    echo -e "${GREEN}  +-------------------------------------------------------------------+${NC}"
    echo ""
    echo "  Location: $EXTENSION_DEST"
else
    echo -e "${RED}  +-------------------------------------------------------------------+${NC}"
    echo -e "${RED}  |  ERROR: Failed to copy extension files                           |${NC}"
    echo -e "${RED}  +-------------------------------------------------------------------+${NC}"
    exit 1
fi

wait_for_enter

# ============================================================================
# Success Screen
# ============================================================================
clear
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo "             INSTALLATION COMPLETE!"
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo "  FILES INSTALLED:"
echo "  ------------------------------------------------------------------------"
echo ""
echo "   Plugin:    $PLUGIN_DEST"
echo "   Extension: $EXTENSION_DEST"
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo -e "${GREEN}  Press ENTER to see Step 1 (Load Extension)...${NC}"
read

# ============================================================================
# Step 1: Load Extension
# ============================================================================
clear
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo "   SETUP STEP 1: LOAD BROWSER EXTENSION"
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  1. Open Chrome, Brave, or Edge browser"
else
    echo "  1. Open Chrome, Chromium, Brave, or Edge browser"
fi
echo "  2. Type in address bar: chrome://extensions/"
echo "  3. Turn ON 'Developer mode' (toggle in top-right corner)"
echo "  4. Click 'Load unpacked' button"
echo "  5. Navigate to this folder:"
echo ""
echo "     $EXTENSION_DEST"
echo ""
echo "  6. Click 'Select' or 'Open'"
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo -e "${GREEN}  Press ENTER when done to see Step 2 (Enable Plugin)...${NC}"
read

# ============================================================================
# Step 2: Enable Plugin
# ============================================================================
clear
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo "   SETUP STEP 2: ENABLE NICOTINE+ PLUGIN"
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo "  1. Open Nicotine+ application"
echo "  2. Click menu: Settings > Plugins"
echo "  3. Scroll to find 'Hydra+ (Browser Link)'"
echo "  4. Click the checkbox to enable it"
echo "  5. Click 'OK' button to save and close"
echo ""
echo "  NOTE: The bridge server will start automatically!"
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo -e "${GREEN}  Press ENTER when done to see Step 3 (Usage Guide)...${NC}"
read

# ============================================================================
# Step 3: Usage
# ============================================================================
clear
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo "   SETUP STEP 3: START USING HYDRA+"
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo "  1. Go to: open.spotify.com"
echo "  2. Open any playlist or album"
echo "  3. You'll see a send button (>) next to each track"
echo "  4. Click the button to send track to Nicotine+"
echo ""
echo "     Orange = Success!"
echo "     Red = Error (check if plugin is enabled)"
echo ""
echo "  5. Click extension icon (toolbar) to access settings"
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo "   TIP: Configure in extension popup"
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo "    - Auto-download toggle"
echo "    - Metadata override"
echo "    - Spotify API credentials (optional - adds Genre and Label)"
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo "   Need help? Visit: github.com/bitm4ncer/Hydra_plus"
echo ""
echo -e "${GREEN}  ========================================================================${NC}"
echo ""
echo "  Installation complete! Press any key to exit..."
read
