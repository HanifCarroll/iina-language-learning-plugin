# Release and IINA community-list checklist

The public name is **Neden**. This project has not been pushed, released, or submitted to IINA. The plugin identifier stays `io.github.hanifcarroll.iina-language-learning` so current installations and Keychain items retain their identity.

## Package route

The tested IINA 1.5.0-beta2 installer first looks for a `.iinaplgz` asset in the GitHub repository's **latest release**. If none exists, it downloads the `main` source archive and expects a loadable plugin at its root. This repository keeps build output ignored under `dist/`, so GitHub installation requires a latest release with **one** verified `.iinaplgz` asset. The source checkout by itself is not the installation package. IINA reads `ghVersion` from `main/Info.json` when checking for updates; increment that integer with each published version. Keep `ghRepo` aligned with the actual public repository URL.

## Before the first public release

1. Confirm that `Info.json`, the README, sidebar text, and the community-list description use **Neden**. Preserve the plugin identifier.
2. Publish the source repository at the `ghRepo` path in `Info.json`. Until then, its URL and automatic update check are not live.
3. Review the full Git history for credentials, private media, and complete commercial subtitle tracks. A local pattern scan of all tracked blobs found no apparent credentials, and the tracked subtitle fixtures are synthetic; this is not a guarantee that every possible secret pattern was found. Review the packaged file list and third-party license notices. Only synthetic fixtures belong in the public repository.
4. In a clean checkout on the tested macOS/IINA setup, run `bun install --frozen-lockfile` and `bun run release:check`. Upload the resulting current-version archive as the **only** `.iinaplgz` asset in the latest GitHub release.
5. Install that release through IINA's **Install from GitHub** control in a clean profile. Check first-run permissions, menu and sidebar loading, external SRT/VTT selection, local mock streaming, Stop, Hide/Resume, native subtitle restoration, and update detection. Use no real credential or billable endpoint.
6. Resolve or explicitly label the remaining native checks in `ACCEPTANCE_REPORT.md`. Do not turn automated tests into native pass claims. State only the macOS and IINA versions actually tested.
7. Add the name, GitHub URL, short description, and plugin identifier to IINA's `README.md` Community Plugins list and `plugins.json` in a focused pull request against `develop`. IINA's contribution guide requests disclosure of AI use in the PR description. The current [community list](https://github.com/iina/iina/blob/develop/README.md#iina-plugins-list) and [JSON catalog](https://github.com/iina/iina/blob/develop/plugins.json) do not list Neden as of September 24, 2026.

Suggested catalog entry once the repository and release are live:

```json
{
  "name": "Neden",
  "url": "https://github.com/hanifcarroll/iina-language-learning-plugin",
  "desc": "Select subtitle phrases for contextual AI explanations and follow-up chat.",
  "id": "io.github.hanifcarroll.iina-language-learning"
}
```

The local archive is generated output. Earlier archive versions are disposable; Git history retains earlier source. This checklist does not authorize a public push, release, or upstream pull request on its own.
