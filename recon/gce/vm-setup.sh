#!/bin/sh
# Runs on the VM. Installs Node, Playwright's Chromium and a remote display.
set -eu
sudo apt-get update -qq
sudo apt-get install -y -qq curl xvfb x11vnc novnc websockify
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y -qq nodejs
npm install --silent playwright@1.63.0
sudo npx playwright install-deps chromium
npx playwright install chromium
