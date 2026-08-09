#!/bin/sh
# index.html is the artifact body: the artifact host supplies the document shell.
# Anywhere else (Vercel, GitHub Pages, a local server) needs a real document,
# so wrap the same single source rather than keeping a second copy by hand.
set -e
cd "$(dirname "$0")"
{
  printf '%s\n' '<!doctype html>'
  printf '%s\n' '<html lang="en">'
  printf '%s\n' '<head>'
  printf '%s\n' '<meta charset="utf-8">'
  printf '%s\n' '<meta name="viewport" content="width=device-width,initial-scale=1">'
  printf '%s\n' '<meta name="color-scheme" content="dark">'
  printf '%s\n' '<meta name="description" content="Build spec for CHROMA, a gesture-driven psychedelic music visualizer, with a live WebGL prototype.">'
  printf '%s\n' '</head>'
  printf '%s\n' '<body>'
  cat index.html
  printf '%s\n' '</body>'
  printf '%s\n' '</html>'
} > standalone.html
echo "standalone.html: $(wc -c < standalone.html) bytes"
