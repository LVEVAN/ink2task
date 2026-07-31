#!/bin/bash
#
# Ink2Task Mac server -- one-shot setup.
#
# Builds the server, installs it as a login-time LaunchAgent (auto-start,
# auto-restart), writes a default config, and prints the LAN IP to enter in
# the Supernote plugin. Safe to re-run; it just refreshes everything.
#
set -euo pipefail

LABEL="com.ink2task.server"
SR_DIR="$HOME/.ink2task"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf "\033[34m==>\033[0m %s\n" "$1"; }
warn() { printf "\033[33m!! \033[0m %s\n" "$1"; }
ok()   { printf "\033[32m✓  \033[0m %s\n" "$1"; }

# 1. Toolchain -------------------------------------------------------------
if ! xcode-select -p >/dev/null 2>&1; then
  warn "Xcode Command Line Tools are required to build the server."
  warn "Run:  xcode-select --install"
  warn "…then re-run this script once it finishes installing."
  exit 1
fi
if ! command -v swift >/dev/null 2>&1; then
  warn "Swift not found even though Command Line Tools are present."
  warn "Open Xcode once, or run: sudo xcode-select --switch /Library/Developer/CommandLineTools"
  exit 1
fi

# 2. Build -----------------------------------------------------------------
say "Building the server (this can take a minute the first time)…"
( cd "$SCRIPT_DIR" && swift build -c release )
BIN_SRC="$SCRIPT_DIR/.build/release/Ink2TaskServer"
[ -x "$BIN_SRC" ] || { warn "Build did not produce $BIN_SRC"; exit 1; }
ok "Built."

# 3. Install binary to a stable spot (outside any cloud folder) ------------
mkdir -p "$SR_DIR"
cp "$BIN_SRC" "$SR_DIR/Ink2TaskServer"
ok "Installed to $SR_DIR/Ink2TaskServer"

# 4. Config ----------------------------------------------------------------
if [ ! -f "$SR_DIR/config.json" ]; then
  printf "Which Apple Reminders list should sync? [Reminders]: "
  read -r LIST_NAME || true
  LIST_NAME="${LIST_NAME:-Reminders}"
  cat > "$SR_DIR/config.json" <<EOF
{
  "listName": "$LIST_NAME",
  "port": 8942
}
EOF
  ok "Wrote config for list \"$LIST_NAME\" (edit $SR_DIR/config.json to change)."
else
  ok "Keeping existing config ($SR_DIR/config.json)."
fi

# 5. LaunchAgent -----------------------------------------------------------
say "Installing the login-time service…"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$SR_DIR/Ink2TaskServer</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$SR_DIR/server.log</string>
    <key>StandardErrorPath</key>
    <string>$SR_DIR/server.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
ok "Service installed (starts at login, restarts on crash)."

# 6. Reminders permission + LAN IP ----------------------------------------
say "On first start, macOS will ask to let Ink2TaskServer access Reminders."
say "Click ALLOW -- the server won't serve until you do (it's a one-time grant)."

IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
echo
ok "Setup done."
echo "-------------------------------------------------------------"
if [ -n "$IP" ]; then
  echo "  In the Supernote plugin settings, set:"
  echo "     Mac IP address : $IP"
  echo "     Port           : 8942"
  echo "     Reminders list : (the list you chose above)"
else
  warn "Could not auto-detect your LAN IP. Find it in System Settings > Wi-Fi > Details."
fi
echo "  Tip: give this Mac a DHCP reservation so its IP doesn't change."
echo "  Log: $SR_DIR/server.log"
echo "-------------------------------------------------------------"
