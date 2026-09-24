# Neden

A pre-release IINA plugin that lets you select a subtitle phrase, read an AI explanation in context, and ask follow-up questions without leaving the video.

Tested on **macOS 27.0** and **IINA 1.5.0-beta2**. The packaged helper was built and tested on Apple silicon. Other combinations have not been tested.

## Install the current local build

Install [Bun](https://bun.sh/), Swift/Xcode command-line tools, and IINA. From a clean checkout:

```sh
bun install --frozen-lockfile
bun run release:check
```

In IINA's plugin settings, choose **Install Local Package** and select `dist/io.github.hanifcarroll.iina-language-learning.iinaplugin-0.1.12.iinaplgz`. Restart IINA after an update; hot plugin reload crashed in one test of IINA 1.5.0-beta2. The GitHub repository installation route will be available only after a public release with an archive asset is published.

## Use it

1. Open a video and the Neden sidebar. In **Subtitles**, choose **Add SRT/VTT file…** for a user-supplied UTF-8 source subtitle file, then choose it under **Source subtitle**. Add and choose an optional translation under **Secondary subtitle**. The **Plugin → Neden** menu offers the same track controls. Selectable explanations require an external SRT or VTT source track.
2. In **AI settings**, enter an OpenAI-compatible HTTPS API base URL and exact model ID. Enter a key if that endpoint requires one. The plugin appends `/chat/completions` to the base URL. Saving settings does not send a request.
3. Double-click a source word or drag across a phrase. Completing the selection pauses playback and **immediately sends one request**. It may incur a provider charge. A click without selected text does nothing.
4. Read the streamed explanation and ask follow-ups in the same chat. **Replay line** plays the selected cue once without another AI request, then returns to your previous position and pause state; **Stop replay** returns early. **Stop** marks a partial answer incomplete. The **×** beside Neden hides the sidebar, retains the chat in that player window, and resumes eligible playback. **⌥⌘G** hides or reopens the sidebar. Selecting another phrase replaces the chat.

The sidebar separates **Chat**, **Subtitles**, and **AI settings**. When both tracks are selected and the source overlay is usable, Neden stacks the secondary and selectable source lines. **Swap positions** reverses their order and saves that choice. Under **Subtitles → Appearance**, size, color, and vertical spacing can be adjusted separately. Appearance edits preview on the video; **Apply appearance** saves them, while leaving Subtitles restores the saved values. Saving AI settings alone does not save an appearance preview. The **Include secondary subtitle text in AI context** setting controls requests independently of display. To put plugin sidebars on the right in the tested IINA version, use **Video → Show Video Panel → Layout → Sidebar Position → Plugins**; that IINA setting affects all plugin sidebars.

## Privacy and limits

A request sends the selected phrase, its complete cue, up to three earlier and three later source cues, optional secondary subtitle context, and chat turns directly to the configured endpoint. It does not send the video or complete subtitle file. API keys are stored through IINA's macOS Keychain integration, not in plugin preferences. There is no project-operated server, account, telemetry, or automatic retry. The plugin makes no provider request until a nonempty selection is completed or a follow-up or manual retry is sent.

The bundled Swift helper performs real incremental HTTPS streaming. It needs IINA's **video-overlay** and **file-system** permissions; the latter permits the helper to make network requests outside IINA's own HTTP domain checks. It accepts HTTP only for explicit loopback test endpoints. System TLS validation and same-origin redirect restrictions apply. The helper has first-byte, idle, and total request timeouts of 20, 30, and 120 seconds. Cancellation invalidates late UI results, but it cannot guarantee that a provider stops work or billing immediately.

Turn **Selectable subtitle overlay** off under **Subtitles → Overlay control** before disabling the plugin. Turning it off cancels active work, clears the chat, resumes eligible playback, and restores native subtitles. Raw disable in IINA Preferences has no teardown callback in the tested version: a helper can run until its total timeout, subtitles can remain hidden, and playback can remain paused. If needed, recover with **Subtitles → Show Subtitles**, **Subtitles → Show Secondary Subtitles**, and **Playback → Resume**.

Each subtitle file is limited to 8 MiB and 50,000 cues; each cue or selection to 4,000 characters; each follow-up to 2,000 characters; chat to 20 turns; request JSON to 128 KiB; and an answer or SSE event to 64 KiB. Limits fail visibly. Full-length user-supplied SRT/VTT files within these limits are valid inputs. Complete commercial subtitle tracks are not included in this repository.

## Development and evidence

`bun run release:check` runs the TypeScript and DOM tests, typechecks, compiles the Swift helper, packages the plugin, checks the archive, and exercises the helper against local controlled endpoints. [The acceptance report](ACCEPTANCE_REPORT.md) distinguishes automated, installed-IINA, and still-outstanding checks. The [specification](docs/SPEC.md) defines behavior; the [evaluation plan](docs/EVAL_PLAN.md) describes the synthetic language cases. No real provider key or user media is committed.

The source is MIT licensed. The package includes notices for `markdown-it` and its bundled dependencies. The ignored `.references/` clones were used for research; no substantial reference implementation was copied. See [the release checklist](docs/RELEASE.md) before publishing or proposing an IINA community-list entry.
