#!/bin/bash
set -euo pipefail

# =========================================================
# deployServer.sh -- push a Node backend server from this repo to the
# directory its LaunchAgent actually runs from, then restart it.
#
# ⚠️ MAINTAINER TOOL, NOT FOR END USERS. This is macOS-only and assumes the
# specific launchd setup on the maintainer's Mac (labels com.ink2task.*, plus
# a deployed copy of each server outside the repo, kept there so OneDrive's
# cloud offload cannot evict running code). If you cloned this repo to run a
# server yourself, you do NOT need this script and it will not work for you:
# you run the server straight from the repo. See the per-server README, in
# short `cd <server> && npm install && npm start`, and to update just pull
# and restart it.
#
# WHY THIS EXISTS
# The Node servers here (ticktick/google/todoist) are not run from the repo.
# Each has a LaunchAgent whose WorkingDirectory points at a deployed COPY
# (e.g. ~/.ink2task-ticktick/app), and `launchctl kickstart` only reloads
# whatever code is already sitting in that copy. So editing the repo and
# restarting the service does nothing, silently.
#
# That drift went unnoticed for weeks: on 2026-08-21 the deployed TickTick
# server was ~285 lines behind the repo and missing src/reauth.ts entirely.
# Copying only the changed files would have crashed it on startup, because
# the repo's server.ts imports './reauth.js'. Hence: always sync the whole
# src/ directory, never a hand-picked subset.
#
# The deploy target is read from the LaunchAgent plist rather than hardcoded,
# so this cannot drift from the thing launchd genuinely uses.
#
# Usage:
#   ./deployServer.sh ticktick             # sync + restart + health check
#   ./deployServer.sh ticktick --check     # report drift, change nothing
#   ./deployServer.sh ticktick --dry-run   # show what would sync, change nothing
#   ./deployServer.sh --list               # show every known server and its state
#
# The Apple/Reminders server is deliberately NOT handled here: it is a
# compiled Swift binary (~/.ink2task/Ink2TaskServer), so its deploy is
# `swift build -c release` plus a binary copy, not a source sync.
# =========================================================

write_color_output() {
    local message="${1:-}"
    local color="${2:-}"
    case "$color" in
        "Red")    printf "\033[31m%s\033[0m\n" "$message" >&2 ;;
        "Green")  printf "\033[32m%s\033[0m\n" "$message" >&2 ;;
        "Yellow") printf "\033[33m%s\033[0m\n" "$message" >&2 ;;
        "Blue")   printf "\033[34m%s\033[0m\n" "$message" >&2 ;;
        *)         printf "%s\n" "$message" >&2 ;;
    esac
}

die() { write_color_output "ERROR: $1" "Red"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Guard: this script must only ever touch Ink2Task. Ink2Day is a separate
# fork with its own LaunchAgents (com.ink2day.*) and its own deployed copies.
case "$REPO_ROOT" in
    *Ink2Day*) die "Refusing to run: this looks like the Ink2Day tree. Ink2Task and Ink2Day are kept separate on purpose." ;;
esac

# server key -> "repo subdir : launchd label : default port"
server_repo_dir() {
    case "$1" in
        ticktick) echo "ticktick-server" ;;
        google)   echo "google-tasks-server" ;;
        todoist)  echo "todoist-server" ;;
        *) return 1 ;;
    esac
}
server_label() {
    case "$1" in
        ticktick) echo "com.ink2task.ticktick" ;;
        google)   echo "com.ink2task.google" ;;
        todoist)  echo "com.ink2task.todoist" ;;
        *) return 1 ;;
    esac
}
server_default_port() {
    case "$1" in
        ticktick) echo 8955 ;;
        google)   echo 8943 ;;
        todoist)  echo 8944 ;;
        *) return 1 ;;
    esac
}

ALL_SERVERS="ticktick google todoist"

# Reads one key out of a LaunchAgent plist. Empty output means absent.
plist_value() {
    local plist="$1" key="$2"
    /usr/bin/plutil -extract "$key" raw -o - "$plist" 2>/dev/null || true
}

# ---------------------------------------------------------
# --list: show every known server, whether it is deployed, and its drift
# ---------------------------------------------------------
list_servers() {
    printf '%-10s %-26s %-9s %-9s %s\n' "SERVER" "LAUNCHD LABEL" "AGENT" "LOADED" "DEPLOY DIR / DRIFT"
    for s in $ALL_SERVERS; do
        local label plist agent loaded target drift
        label="$(server_label "$s")"
        plist="$HOME/Library/LaunchAgents/$label.plist"
        agent="no"; loaded="no"; target=""; drift=""
        [ -f "$plist" ] && agent="yes"
        launchctl list "$label" >/dev/null 2>&1 && loaded="yes"
        if [ -f "$plist" ]; then
            target="$(plist_value "$plist" WorkingDirectory)"
            if [ -n "$target" ] && [ -d "$target/src" ]; then
                drift="$(count_drift "$REPO_ROOT/$(server_repo_dir "$s")/src" "$target/src")"
                target="$target  [$drift]"
            elif [ -n "$target" ]; then
                target="$target  [no src/ yet]"
            fi
        else
            target="(not deployed)"
        fi
        printf '%-10s %-26s %-9s %-9s %s\n' "$s" "$label" "$agent" "$loaded" "$target"
    done
}

# Total changed/added/removed lines between a repo src/ and a deployed src/.
count_drift() {
    local repo_src="$1" dep_src="$2" total=0 f n
    for f in "$repo_src"/*.ts; do
        [ -e "$f" ] || continue
        n="$(basename "$f")"
        if [ -f "$dep_src/$n" ]; then
            total=$(( total + $(diff "$dep_src/$n" "$f" 2>/dev/null | grep -c '^[<>]' || true) ))
        else
            total=$(( total + $(wc -l < "$f" | tr -d ' ') ))
        fi
    done
    # files present in the deploy but gone from the repo
    for f in "$dep_src"/*.ts; do
        [ -e "$f" ] || continue
        n="$(basename "$f")"
        [ -f "$repo_src/$n" ] || total=$(( total + $(wc -l < "$f" | tr -d ' ') ))
    done
    if [ "$total" -eq 0 ]; then echo "in sync"; else echo "$total lines behind"; fi
}

# ---------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------
SERVER=""
MODE="deploy"
for arg in "$@"; do
    case "$arg" in
        --list)    list_servers; exit 0 ;;
        --check)   MODE="check" ;;
        --dry-run) MODE="dry-run" ;;
        -h|--help) sed -n '3,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*)        die "Unknown option: $arg" ;;
        *)         SERVER="$arg" ;;
    esac
done

[ -n "$SERVER" ] || die "Which server? One of: $ALL_SERVERS (or --list). See --help."
REPO_SUBDIR="$(server_repo_dir "$SERVER")" || die "Unknown server '$SERVER'. Known: $ALL_SERVERS"
LABEL="$(server_label "$SERVER")"
SRC_DIR="$REPO_ROOT/$REPO_SUBDIR"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -d "$SRC_DIR/src" ] || die "No source at $SRC_DIR/src"

# ---------------------------------------------------------
# Resolve the deploy target from launchd, not from a guess
# ---------------------------------------------------------
if [ ! -f "$PLIST" ]; then
    write_color_output "No LaunchAgent at $PLIST, so this server has no deployed copy to sync to." "Red"
    write_color_output "" ""
    write_color_output "If you are just running the server normally, you do not need this script at all:" "Yellow"
    write_color_output "  cd $REPO_SUBDIR && npm install && npm start" "Yellow"
    write_color_output "That runs it straight from the repo, so a git pull plus a restart is the whole update." "Yellow"
    write_color_output "" ""
    write_color_output "This script only exists for servers already running as a background LaunchAgent" "Yellow"
    write_color_output "from a copy outside the repo. See $REPO_SUBDIR/README.md to set that up." "Yellow"
    exit 1
fi

DEPLOY_DIR="$(plist_value "$PLIST" WorkingDirectory)"
LOG_FILE="$(plist_value "$PLIST" StandardOutPath)"
[ -n "$DEPLOY_DIR" ] || die "$PLIST has no WorkingDirectory key, so the deploy target cannot be determined."
[ -d "$DEPLOY_DIR" ] || die "LaunchAgent points at $DEPLOY_DIR but that directory does not exist."

write_color_output "Server:      $SERVER" "Blue"
write_color_output "Repo:        $SRC_DIR" "Blue"
write_color_output "Deploy dir:  $DEPLOY_DIR  (from $LABEL.plist)" "Blue"
write_color_output "Drift:       $(count_drift "$SRC_DIR/src" "$DEPLOY_DIR/src")" "Blue"
echo >&2

# Per-file drift detail, so a surprise is visible before anything is written.
write_color_output "Per-file changes (deployed -> repo):" "Yellow"
for f in "$SRC_DIR"/src/*.ts; do
    [ -e "$f" ] || continue
    n="$(basename "$f")"
    if [ -f "$DEPLOY_DIR/src/$n" ]; then
        c=$(diff "$DEPLOY_DIR/src/$n" "$f" | grep -c '^[<>]' || true)
        [ "$c" -gt 0 ] && printf '  %-18s %s changed lines\n' "$n" "$c" >&2
    else
        printf '  %-18s NEW FILE (%s lines)\n' "$n" "$(wc -l < "$f" | tr -d ' ')" >&2
    fi
done
for f in "$DEPLOY_DIR"/src/*.ts; do
    [ -e "$f" ] || continue
    n="$(basename "$f")"
    [ -f "$SRC_DIR/src/$n" ] || printf '  %-18s ONLY IN DEPLOY, will be left in place\n' "$n" >&2
done
echo >&2

if [ "$MODE" = "check" ]; then
    write_color_output "--check: nothing was changed." "Green"
    exit 0
fi

# ---------------------------------------------------------
# Preflight
# ---------------------------------------------------------
# Typecheck before shipping. These servers run straight from TypeScript via
# tsx, which strips types without checking them, so a type error would only
# ever surface as a runtime failure mid-sync on the device.
if [ -d "$SRC_DIR/node_modules" ]; then
    write_color_output "Typechecking..." "Blue"
    if ! (cd "$SRC_DIR" && npx tsc --noEmit); then
        die "Typecheck failed. Fix it before deploying, or the server will break at runtime."
    fi
    write_color_output "Typecheck clean" "Green"
else
    write_color_output "WARNING: no node_modules in the repo copy, skipping typecheck. Run 'npm ci' in $REPO_SUBDIR." "Yellow"
fi

[ -d "$DEPLOY_DIR/node_modules/tsx" ] || die "$DEPLOY_DIR has no node_modules/tsx. The LaunchAgent runs tsx from there, so it cannot start. Run 'npm ci' inside $DEPLOY_DIR first."

RSYNC_FLAGS=(-a --itemize-changes)
if [ "$MODE" = "dry-run" ]; then
    RSYNC_FLAGS+=(--dry-run)
    write_color_output "DRY RUN: showing what would change, writing nothing." "Yellow"
fi

# ---------------------------------------------------------
# Sync. Whole src/ directory, never a subset (see header).
# ---------------------------------------------------------
rsync "${RSYNC_FLAGS[@]}" "$SRC_DIR/src/" "$DEPLOY_DIR/src/"

# package.json/tsconfig.json matter too: a dependency change in the repo that
# never reaches the deploy means tsx resolves against the wrong tree.
PKG_CHANGED=0
if ! diff -q "$SRC_DIR/package.json" "$DEPLOY_DIR/package.json" >/dev/null 2>&1; then
    PKG_CHANGED=1
    rsync "${RSYNC_FLAGS[@]}" "$SRC_DIR/package.json" "$DEPLOY_DIR/package.json"
fi
if [ -f "$SRC_DIR/tsconfig.json" ] && ! diff -q "$SRC_DIR/tsconfig.json" "$DEPLOY_DIR/tsconfig.json" >/dev/null 2>&1; then
    rsync "${RSYNC_FLAGS[@]}" "$SRC_DIR/tsconfig.json" "$DEPLOY_DIR/tsconfig.json"
fi

# credentials.env holds the OAuth client id/secret. Regular API calls work
# without it because they only need the stored access token, so a missing
# credentials.env stays invisible until the token needs refreshing or the
# user reauthorizes, and then it fails with a confusing "Missing
# TICKTICK_CLIENT_ID". Copy it if the deploy has none. Never overwrite an
# existing one: the deployed copy may hold the real secret while the repo
# copy is the example.
if [ -f "$SRC_DIR/credentials.env" ] && [ ! -f "$DEPLOY_DIR/credentials.env" ]; then
    if [ "$MODE" != "dry-run" ]; then
        cp "$SRC_DIR/credentials.env" "$DEPLOY_DIR/credentials.env"
        chmod 600 "$DEPLOY_DIR/credentials.env"
    fi
    write_color_output "Copied credentials.env into the deploy (was missing; token refresh would have failed)." "Yellow"
elif [ ! -f "$DEPLOY_DIR/credentials.env" ]; then
    write_color_output "WARNING: no credentials.env in $DEPLOY_DIR and none in the repo to copy. Regular syncs will work, but token refresh and reauthorization will fail." "Yellow"
fi

if [ "$MODE" = "dry-run" ]; then
    write_color_output "DRY RUN complete. Nothing was written and the service was not restarted." "Green"
    exit 0
fi

if [ "$PKG_CHANGED" -eq 1 ]; then
    write_color_output "package.json changed, running npm ci in the deploy dir..." "Yellow"
    (cd "$DEPLOY_DIR" && npm ci) || die "npm ci failed in $DEPLOY_DIR. The service was NOT restarted, so the old code is still running."
fi

# ---------------------------------------------------------
# Restart and verify it actually came back
# ---------------------------------------------------------
write_color_output "Restarting $LABEL..." "Blue"
launchctl kickstart -k "gui/$(id -u)/$LABEL" || die "kickstart failed. Is the agent loaded? Check: launchctl list $LABEL"

PORT="$(server_default_port "$SERVER")"
if [ -f "$DEPLOY_DIR/config.json" ]; then
    P="$(/usr/bin/python3 -c "import json;print(json.load(open('$DEPLOY_DIR/config.json')).get('port',''))" 2>/dev/null || true)"
    [ -n "$P" ] && PORT="$P"
fi

write_color_output "Waiting for port $PORT..." "Blue"
UP=0
for _ in $(seq 1 20); do
    if /usr/bin/curl -sf --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then UP=1; break; fi
    sleep 0.5
done

echo >&2
if [ "$UP" -eq 1 ]; then
    write_color_output "$SERVER server is up and answering /health on port $PORT" "Green"
else
    write_color_output "Server did not answer /health on port $PORT within 10s." "Red"
    [ -n "$LOG_FILE" ] && [ -f "$LOG_FILE" ] && { write_color_output "Last 20 log lines ($LOG_FILE):" "Yellow"; tail -20 "$LOG_FILE" >&2; }
    exit 1
fi

if [ -n "$LOG_FILE" ] && [ -f "$LOG_FILE" ]; then
    write_color_output "Recent log ($LOG_FILE):" "Blue"
    tail -8 "$LOG_FILE" >&2
fi

write_color_output "Done. Remember the plugin half is deployed separately (plugin/buildPlugin.sh)." "Green"
