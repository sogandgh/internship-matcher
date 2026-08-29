#!/bin/bash
# Double-click this file in Finder to start the Internship Matcher.
# It checks Node.js, installs dependencies the first time, picks a free
# port, starts the server, and opens the app in your browser.

set -u

# Finder launches scripts from your home folder, so move to the project first.
cd "$(dirname "$0")" || exit 1

keep_open() {
  echo ""
  echo "Press Return to close this window."
  read -r _
}
trap keep_open EXIT

echo "────────────────────────────────────────────"
echo "   Internship Matcher"
echo "────────────────────────────────────────────"
echo ""

# --- 1. Is Node.js installed? -------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "✗  Node.js isn't installed on this Mac."
  echo ""
  echo "   Opening the download page now."
  echo "   Download the macOS Installer, run it, then"
  echo "   double-click start.command again."
  sleep 2
  open "https://nodejs.org/en/download"
  exit 1
fi

NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗  Node.js $(node -v) is too old — version 18 or newer is needed."
  echo ""
  echo "   Opening the download page now. Install the latest"
  echo "   version, then double-click start.command again."
  sleep 2
  open "https://nodejs.org/en/download"
  exit 1
fi

echo "✓  Node.js $(node -v)"

# --- 2. Dependencies ----------------------------------------------------
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "•  Installing dependencies — one time only, takes about a minute…"
  echo ""
  if ! npm install --no-audit --no-fund; then
    echo ""
    echo "✗  Installing dependencies failed."
    echo "   Check your internet connection and try again."
    exit 1
  fi
  echo ""
  echo "✓  Dependencies installed"
else
  echo "✓  Dependencies already installed"
fi

# --- 3. Claude API key (optional) ---------------------------------------
if [ -n "${ANTHROPIC_API_KEY:-}" ] || grep -qs '^ANTHROPIC_API_KEY=sk-' .env; then
  echo "✓  Claude API key found — the Analyze button is enabled"
else
  echo "•  No Claude API key — everything works except the Analyze button"
fi

# --- 4. Find a free port ------------------------------------------------
PORT=3000
while lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done
export PORT

echo ""
echo "────────────────────────────────────────────"
echo "   Opening http://localhost:$PORT"
echo ""
echo "   Keep this window open while you use the app."
echo "   To stop it: press Control-C, or close this window."
echo "────────────────────────────────────────────"
echo ""

# Give the server a moment to boot, then open the browser.
( sleep 2; open "http://localhost:$PORT" ) &

node server.js
