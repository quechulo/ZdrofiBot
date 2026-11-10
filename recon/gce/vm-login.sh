#!/bin/sh
# Runs on the VM. Opens the login browser on a display you reach through the SSH
# tunnel at http://localhost:6080/vnc.html. VNC listens on localhost only.
# Usage: sh recon/gce/vm-login.sh <session-name>
set -eu
NAME=${1:?Usage: sh recon/gce/vm-login.sh <session-name>}

Xvfb :99 -screen 0 1280x900x24 &
XVFB=$!
sleep 1
x11vnc -display :99 -localhost -nopw -forever -quiet &
VNC=$!
websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
WEB=$!
trap 'kill $WEB $VNC $XVFB 2>/dev/null || true' EXIT

echo "Open http://localhost:6080/vnc.html on your Mac and connect."
DISPLAY=:99 node recon/login.mjs "$NAME"
