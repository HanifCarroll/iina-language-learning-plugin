#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
bun run build
cd dist
rm -f io.github.hanifcarroll.iina-language-learning.iinaplugin-*.iinaplgz
printf 'y\n' | /Applications/IINA.app/Contents/MacOS/iina-plugin pack io.github.hanifcarroll.iina-language-learning.iinaplugin
