# IINA Language Learning

A macOS IINA plugin for selecting an external source subtitle phrase and asking an AI provider to explain it. The explanation streams into IINA's sidebar. Chat lasts only for the current media session.

## Tested environment

macOS 27 on Apple silicon, IINA 1.5.0-beta2 (build 172), and its bundled mpv. Other versions are not yet verified. The plugin supports full-length user-supplied UTF-8 SRT and WebVTT files, subject to the limits below. Embedded or bitmap tracks remain available in IINA, but selectable explanations require an external text track. Complete commercial subtitle tracks are valid runtime input; none are included in this repository.

## Build and install

Install Bun, Swift/Xcode command-line tools, and IINA. Then run:

```sh
bun install --frozen-lockfile
bun test
bun run build
python3 tests/test_stream_helper.py dist/io.github.hanifcarroll.iina-language-learning.iinaplugin/native/stream-helper
/Applications/IINA.app/Contents/MacOS/iina-plugin pack dist/io.github.hanifcarroll.iina-language-learning.iinaplugin
```

The build runs `tsc --noEmit`, compiles the Swift helper, and writes an ignored `.iinaplugin` folder under `dist/`. IINA's bundled packer writes an ignored `.iinaplgz` archive in the current directory. Install the archive through IINA's plugin settings. Version 0.1.7 initializes in an already loaded player window; if the Language Learning sidebar is temporarily empty after reinstalling, reopen it or restart IINA. The project does not modify IINA itself.

## Use

1. Open a video in IINA and load a UTF-8 SRT or WebVTT source track. To show English above Turkish, load an English track as IINA's **Secondary Subtitle**, then enable **Show secondary subtitle above source** in plugin Settings. This option starts off. The plugin draws the secondary line above its selectable source line and temporarily hides IINA's duplicate native text. Adjust each line's size and color, the source distance from the bottom, and the gap between lines. Turning off stacked display restores native secondary rendering.
2. Open the Language Learning sidebar and enter an HTTPS API base URL and model. The plugin appends `/chat/completions`. HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` test endpoints. Enter an API key unless the endpoint needs none. Save settings before selecting text. A newly entered key goes directly to the plugin's verified IINA Keychain API; saved keys are never shown in the sidebar.
3. Double-click a word or drag across a phrase in the source subtitle. Completing the selection pauses playback, opens the conversation, and sends one request to the configured provider; a single click without selected text does nothing. Send follow-ups from the same sidebar. **Stop** marks partial output incomplete; **Retry** manually starts a new request for that turn. **Hide / Resume** hides the panel, keeps the chat in this window, and resumes eligible playback of the same media. Press **⌥⌘G** to hide or reopen the panel. A follow-up after reopening pauses playback again; the next selected phrase replaces the previous conversation.

Changing provider, language, or secondary-context settings ends an open conversation; make a fresh selection to use the new settings. The secondary subtitle display is independent of whether its text is included in AI context. Subtitle appearance can be changed without clearing chat. The sidebar formats model Markdown locally with HTML, links, and image loading disabled. The complete source cue is available through **Full subtitle line**; subtitle content remains plain text. The follow-up input grows to three lines, while the message list scrolls above it. A new follow-up scrolls into view; streaming follows the bottom unless you scroll up to read.

To put the plugin sidebar on the right in IINA 1.5.0-beta2, open **Video → Show Video Panel → Layout → Sidebar Position** and select the trailing side for **Plugins**. This is an IINA setting for all plugin sidebars, not a setting of this plugin alone.

**Disable Overlay** in plugin Settings is the supported safe shutdown control. It cancels active work, closes the conversation under the same-media resume rule, and restores native subtitle visibility owned by that window. Raw disable in IINA Preferences does not call plugin cleanup in IINA 1.5.0-beta2. In that case a helper can run until its 120-second total timeout, native subtitles can remain hidden, and playback can remain paused. Recover with **Subtitles → Show Subtitles**, **Subtitles → Show Secondary Subtitles** if needed, and **Playback → Resume** if paused. A request may still be billable after raw disable.

## Network and limits

The plugin uses a packaged, per-request Swift executable with `URLSession` for real SSE streaming. Its private request and control FIFOs carry the key and Stop command; IINA's process-launch arguments contain only a private directory path. The executable needs IINA's `file-system` permission and sends network requests outside IINA's `http` allowed-domain checks. It accepts HTTPS or loopback HTTP, follows only same-origin 307/308 redirects, uses system TLS validation, and has first-byte/idle/total timeouts of 20/30/120 seconds. Stop and Disable Overlay invalidate late UI results and ask the helper to cancel. Raw Preferences disable cannot guarantee immediate cancellation or prevent billing.

Limits: 8 MiB and 50,000 cues per subtitle file; 4,000 characters per cue/selection; 2,000 characters per follow-up; 20 turns; 128 KiB request JSON; 64 KiB answer and SSE event. Exceeding a limit fails visibly. The plugin does not silently drop required neighboring cues or completed turns. No automatic retry or provider switch occurs.

See [the spec](docs/SPEC.md), [implementation plan](IMPLEMENTATION_PLAN.md), [evaluation plan](docs/EVAL_PLAN.md), and [acceptance report](ACCEPTANCE_REPORT.md) for behavior and current verification. `bun test tests/evals.test.ts` checks 12 synthetic request cases and the scoring rules; `bun run evals --template` creates an ignored review worksheet, and `bun run evals .tmp/eval-review.json` gives per-case verdicts after responses are reviewed. `bun tests/live_eval.ts --mock` checks collection through the packaged helper with only a local endpoint. A prior authorized synthetic provider evaluation is documented in the acceptance report. No provider key or complete commercial subtitle track is committed.

## Dependencies and provenance

- Runtime: IINA's public plugin APIs (IINA is GPL-3.0), macOS Foundation/URLSession, and markdown-it 15.0.2 (MIT) for local Markdown rendering. markdown-it's bundled dependencies and their license notices are included in the plugin's `licenses/` directory. No IINA source is copied.
- Development: TypeScript 5.9.3 (Apache-2.0), happy-dom 20.8.3 (MIT), and `@types/bun` 1.3.14 (MIT), plus their pinned lockfile dependencies. Bun runs tests and bundles JavaScript. These tools are not bundled into the plugin archive.
- Phase 0 references are in ignored `.references/` and were used for research only. No substantial source was copied. The plugin's own source is MIT licensed.
