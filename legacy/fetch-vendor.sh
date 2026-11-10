#!/bin/sh
# One-time setup: download the two vendored frontend libraries.
# Not a build step — just fetching pinned static files.
set -e
cd "$(dirname "$0")/static/vendor"
curl -fsSL -o marked.umd.js https://cdn.jsdelivr.net/npm/marked@18.1.3/lib/marked.umd.js
curl -fsSL -o purify.min.js  https://cdn.jsdelivr.net/npm/dompurify@3.4.17/dist/purify.min.js
sha256sum marked.umd.js purify.min.js
echo "expected:"
echo "c34a221dc89e91833a88822e7717b8a0cf27118f8c9a8779dffb48a6be31f97a  marked.umd.js"
echo "cd37898f9782adf54820c413191b5691803f0f137c799d6edcfd38523b4c2c31  purify.min.js"
