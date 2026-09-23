#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
package=dist/io.github.hanifcarroll.iina-language-learning.iinaplugin
mkdir -p "$package/native" "$package/ui"
bun run typecheck
swiftc -O native/stream-helper.swift -o "$package/native/stream-helper"
bun build src/main.ts --target browser --format iife --outfile "$package/main.js" >/dev/null
bun build ui/overlay.ts --target browser --format iife --outfile "$package/ui/overlay.js" >/dev/null
bun build ui/sidebar.ts --target browser --format iife --outfile "$package/ui/sidebar.js" >/dev/null
cp Info.json "$package/Info.json"
cp LICENSE "$package/LICENSE"
cp ui/overlay.html ui/overlay.css ui/sidebar.html ui/sidebar.css "$package/ui/"
printf '%s\n' "$package"
