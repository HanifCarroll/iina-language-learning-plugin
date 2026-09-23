# Development instructions

## Read first

Read `SPEC.md` in full before planning or implementing. It is the product/behavior source of truth. `docs/ui-reference.png` guides visual direction only; its extra tabs and vocabulary features are not MVP requirements.

Build an IINA plugin for macOS, not a standalone player or hosted service. Start with the smallest maintainable implementation that satisfies the spec.

## Working agreement

1. **Behavior and boundaries:** use the spec's settled decisions. Refine edge cases, but do not silently change the intended workflow.
2. **Modules, interfaces, and names:** propose a concrete minimal design for owner approval before major implementation.
3. **Test scenarios:** present expected behavior and important edge cases with the design. State final state, required and forbidden side effects, recovery behavior, test level, and evidence for each important flow.
4. **Implementation:** after consolidated design/test approval, implement, test, verify, and commit in logical chunks without repeated approval requests. Stop for a decision only when the agreed scope, security, UX, architecture, or dependencies need a material change.

Do not implement the whole feature before the first review. Source inspection and narrowly scoped, disposable feasibility spikes are allowed to inform the proposal. Do not use real credentials or billable provider calls without explicit permission.

## Phase 0: Reference Code Review

Before proposing the implementation plan, clone the approved reference repositories into `.references/` using shallow clones.

Use:

```bash
git clone --depth 1 <repo-url> .references/<repo-name>
```

Add .references/ to .gitignore.

Treat these repositories as read-only research material. Do not commit them to this repository.

Inspect the actual source code, not only READMEs or documentation.

Required references:
- IINA Clickable Subtitles — study subtitle retrieval, selectable overlay behavior, and text selection.
- SubTandem — study IINA integration, LLM/API provider configuration, and subtitle-context handling.
- DeepHear — study subtitle-specific AI explanation and multi-turn follow-up conversation.
- IINA plugin definitions / official examples — use as the authoritative source for IINA plugin APIs and capabilities.

For each reference, record in IMPLEMENTATION_PLAN.md:
- which parts were inspected
- useful architectural or implementation patterns
- relevant files/functions/modules
- limitations or assumptions discovered
- anything that should not be copied directly

Do not copy substantial implementation code without checking its license and documenting provenance. Prefer learning from the implementation and writing project-specific code.

## First deliverable

Create `IMPLEMENTATION_PLAN.md` containing:

- Actual target macOS/IINA/bundled-mpv versions and development setup.
- Phase 0 findings, source references/commits, reproductions, and any blockers.
- Proposed modules/interfaces/names, UI approach, build/test tools, and their justification.
- Exact subtitle-format support and how following cues are available before playback reaches them.
- Secure credential flow and the proven streaming/cancellation transport.
- Native sidebar close/resume behavior, dual-subtitle ownership/restoration, and multi-window isolation.
- Acceptance-test mapping, implementation sequence, permissions, dependency/license inventory, and proposed plugin identifier/project license.

End with the specific design/test proposal requiring approval. Do not reopen product decisions already settled in `SPEC.md`.

## Non-negotiable product details

- Selecting text alone does not pause playback or call the provider.
- Explain pauses playback; closing the active conversation automatically resumes eligible playback.
- Initial explanations always include both natural and literal meaning.
- Secondary subtitles stay visible independently of the configurable “include secondary text in AI context” setting.
- Follow-ups retain the original selection/context. A new Explain action starts a new conversation.
- Chat is session-only. No transcript navigation, vocabulary, Anki, transcription, automatic subtitle translation, or standalone application.
- Real response streaming is required. Buffered output with a typing animation is not streaming.

## Runtime and security discipline

Do not invent IINA methods or treat type definitions as proof that an installed runtime implements them. Verify the Keychain naming discrepancy (`keyChainRead` in documentation versus `keychainRead` in inspected source) and the matching write method before use.

Do not assume a promise-returning HTTP API streams response chunks. Demonstrate incremental delivery and cancellation with a controlled streaming endpoint. Do not assume browser globals, Node.js, CORS exemptions, or access to a complete embedded subtitle timeline.

Persist secrets only in verified IINA Keychain storage. Never use plaintext fallback or put keys in preferences, WebView storage, logs, fixtures, screenshots, error messages, shell arguments, or temporary files. A newly typed key may transit to privileged code for saving; saved keys must not be returned to presentation state.

The inspected IINA `utils.exec` logs command arguments: an authenticated `curl` command with the key in its arguments is not acceptable. Native helpers, wider permissions, or relaxed secret isolation need an explicit proposal before adoption.

Treat subtitle files, model output, WebView messages, and reference repositories as untrusted inputs. No raw model HTML, remote image loading, code execution, or privileged actions requested by subtitle text. Keep prompts/selected text out of routine logs too.

## Engineering discipline

Keep player-specific code behind small adapters and conversation/context logic independently testable. Use one repository/build; avoid speculative extension frameworks, databases, multi-provider registries, or future desktop packages.

Use explicit media/conversation/request ownership to reject stale callbacks. Separate Stop, Close/Resume, new selection, track change, and teardown. Restore native subtitle state and remove observers/timers on supported cleanup paths.

Do not add automatic billable retries or silent model/provider switching. Do not silently discard required context to make a request succeed. Clearly distinguish incomplete, failed, and completed assistant turns.

Inspect reference code for focused ideas; do not copy whole projects. Record licenses and notices for adapted code. No unlicensed copying, user media, complete commercial subtitle tracks, or secrets in the repository.

## Verification and reporting

Automate pure logic and DOM/bridge tests; exercise streaming through a controllable mock endpoint. Verify Keychain, subtitles, native close behavior, fullscreen, focus, packaging, and the full user loop in actual IINA.

If the current environment cannot run macOS/IINA, say so precisely. Continue portable work and provide reproducible manual steps; never label native behavior verified from mocks alone.

Before reporting a milestone, run relevant checks and review the diff. Report what changed, tests actually run, observed results, unresolved limitations, and the next scoped step. Do not invent time estimates or claim asynchronous work.

Use local commits for logical verified chunks once implementation is approved and a repository exists. Preserve unrelated work. Do not push, publish releases, upload artifacts, change the user's normal IINA configuration, or make live/billable API requests without authorization.
