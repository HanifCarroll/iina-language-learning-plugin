#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
package=dist/org.hanif.phase0.integration.iinaplugin
mkdir -p "$package/native" "$package/ui" "$package/fixtures"
swiftc -O native/stream-helper.swift -o "$package/native/stream-helper"
bun build integration/main.ts --target browser --outfile "$package/main.js" >/dev/null
bun build integration/overlay.ts --target browser --outfile "$package/ui/overlay.js" >/dev/null
bun build integration/sidebar.ts --target browser --outfile "$package/ui/sidebar.js" >/dev/null
cp integration/Info.json "$package/Info.json"
cp integration/overlay.html integration/overlay.css integration/sidebar.html integration/sidebar.css "$package/ui/"
cp tests/fixtures/clip.tr.srt tests/fixtures/clip.en.srt "$package/fixtures/"
