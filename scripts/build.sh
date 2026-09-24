#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
package=dist/io.github.hanifcarroll.iina-language-learning.iinaplugin
rm -rf "$package"
mkdir -p "$package/native" "$package/ui" "$package/licenses"
bun run typecheck
swiftc -O native/stream-helper.swift -o "$package/native/stream-helper"
bun build src/main.ts --target browser --format iife --outfile "$package/main.js" >/dev/null
bun build ui/overlay.ts --target browser --format iife --outfile "$package/ui/overlay.js" >/dev/null
bun build ui/sidebar.ts --target browser --format iife --outfile "$package/ui/sidebar.js" >/dev/null
cp Info.json "$package/Info.json"
cp LICENSE "$package/LICENSE"
cp ui/overlay.html ui/overlay.css ui/sidebar.html ui/sidebar.css "$package/ui/"
cp node_modules/markdown-it/LICENSE "$package/licenses/markdown-it.LICENSE"
cp node_modules/entities/LICENSE "$package/licenses/entities.LICENSE"
cp node_modules/linkify-it/LICENSE "$package/licenses/linkify-it.LICENSE"
cp node_modules/mdurl/LICENSE "$package/licenses/mdurl.LICENSE"
cp node_modules/uc.micro/LICENSE.txt "$package/licenses/uc.micro.LICENSE"
cp node_modules/punycode.js/LICENSE-MIT.txt "$package/licenses/punycode.js.LICENSE"
cp node_modules/argparse/LICENSE "$package/licenses/argparse.LICENSE"
printf '%s\n' "$package"
