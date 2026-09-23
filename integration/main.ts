declare const iina: any;

const { core, event: hostEvent, file, mpv, overlay, sidebar, utils } = iina;
const pluginId = "org.hanif.phase0.integration";
const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const allowedModes = new Set(["stream", "slow-first", "slow-idle", "redirect-other", "unauth", "long", "invalid-host"]);
const listeners: string[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let mediaEpoch = 0;
let overlayReady = false;
let sidebarReady = false;
let overlayEnabled = true;
let priorPrimaryVisibility: boolean | null = null;
let selected: { text: string; start: number; end: number; cue: string } | null = null;
let conversationOpen = false;
let resumeUrl = "";
let resumeEpoch = -1;
let requestCounter = 0;
let request: { id: number; control: any; directory: string; buffer: string; cancelled: boolean;
  started: number; exit?: number; error?: boolean; frame?: (line: string) => void } | null = null;
const events: Array<Record<string, string | number | boolean>> = [];

function record(name: string, details: Record<string, string | number | boolean> = {}): void {
  events.push({ at: Date.now(), instance: instanceId, name, ...details });
  if (events.length > 1000) events.shift();
  try { file.write(`@data/integration-events-${instanceId}.json`, JSON.stringify(events)); } catch { /* diagnostics are optional */ }
}

function toSidebar(data: Record<string, string>): void {
  if (sidebarReady) sidebar.postMessage("state", encodeURIComponent(JSON.stringify(data)));
}

function helperRoot(): string {
  const dataPath: string = utils.resolvePath("@data/.");
  const pluginsPath = dataPath.replace(/\/\.data\/[^/]+\/?$/, "");
  for (const suffix of ["iinaplugin-dev", "iinaplugin"]) {
    const candidate = `${pluginsPath}/${pluginId}.${suffix}`;
    if (file.exists(`${candidate}/native/stream-helper`)) return candidate;
  }
  throw new Error("packaged helper unavailable");
}

function updateCue(): void {
  if (!overlayReady || !overlayEnabled) return;
  const text: string = mpv.getString("sub-text") || "";
  overlay.postMessage("cue", encodeURIComponent(text));
}

function ownPrimaryVisibility(): void {
  if (!overlayEnabled || priorPrimaryVisibility !== null) return;
  priorPrimaryVisibility = !!mpv.getFlag("sub-visibility");
  mpv.set("sub-visibility", false);
  record("primary_hidden", { prior: priorPrimaryVisibility });
}

function restorePrimaryVisibility(): void {
  if (priorPrimaryVisibility === null) return;
  if (mpv.getFlag("sub-visibility") === false) {
    mpv.set("sub-visibility", priorPrimaryVisibility);
  }
  record("primary_restored", { value: !!mpv.getFlag("sub-visibility") });
  priorPrimaryVisibility = null;
}

function cancelRequest(): void {
  if (!request || request.cancelled) return;
  request.cancelled = true;
  try { request.control?.write("STOP\n"); request.control?.close(); } catch { /* process may already be gone */ }
  record("cancel_requested", { request: request.id });
}

function closeConversation(native: boolean): void {
  if (!conversationOpen) return;
  cancelRequest();
  conversationOpen = false;
  sidebar.hide();
  const sameMedia = resumeEpoch === mediaEpoch && resumeUrl === core.status.url;
  const position = core.status.position;
  const duration = core.status.duration;
  const playable = !core.status.idle &&
    (typeof position !== "number" || typeof duration !== "number" || position < duration - 0.1);
  if (sameMedia && playable) core.resume();
  record(native ? "native_close" : "explicit_close", { resumed: sameMedia && playable });
  toSidebar({ lifecycle: sameMedia && playable ? "Closed and resumed" : "Closed without resume" });
}

function startStream(mode: string): void {
  if (!allowedModes.has(mode) || request) return;
  let root: string;
  try { root = helperRoot(); } catch {
    toSidebar({ status: "Packaged helper missing" }); return;
  }
  if (typeof utils.keychainWrite !== "function" || typeof utils.keychainRead !== "function") {
    toSidebar({ status: "IINA Keychain API unavailable" }); return;
  }
  const fixture = `fixture-${Date.now()}-${Math.random()}`;
  if (utils.keychainWrite("integration", "mock", fixture) !== true) {
    toSidebar({ status: "Fixture Keychain save failed" }); return;
  }
  const key = utils.keychainRead("integration", "mock");
  if (key !== fixture) { toSidebar({ status: "Fixture Keychain read failed" }); return; }
  const id = ++requestCounter;
  const directory = `${utils.resolvePath("@tmp/.")}/request-${instanceId}-${id}`;
  const active: NonNullable<typeof request> = {
    id, control: null, directory, buffer: "", cancelled: false, started: Date.now()
  };
  request = active;
  const path = mode === "stream" ? "chat/completions" : mode;
  const timeouts = mode === "slow-first" ? { firstByteMs: 400 } :
    mode === "slow-idle" ? { idleMs: 400 } : mode === "long" ? { totalMs: 20_000 } : {};
  const payload = JSON.stringify({
    url: mode === "invalid-host" ? "http://example.com/chat/completions" : `http://127.0.0.1:47891/${path}`,
    key,
    body: { model: "synthetic", stream: true,
      messages: [{ role: "user", content: selected?.text || "synthetic integration check" }] },
    timeouts
  });
  record("request_started", { request: id, mode });
  toSidebar({ status: "Starting local stream" });
  function frame(line: string): void {
    if (request !== active) return;
    if (line === "READY") {
      try {
        active.control = file.handle(directory + "/control", "write");
        const input = file.handle(directory + "/request", "write");
        if (!active.control || !input) throw new Error("pipe unavailable");
        input.write(payload);
        input.close();
        if (active.cancelled) active.control.write("STOP\n");
      } catch { toSidebar({ status: "Private pipe failed" }); cancelRequest(); }
    } else if (line.startsWith("DELTA ")) {
      if (active.cancelled) return;
      record("delta", { request: id, elapsedMs: Date.now() - active.started });
      toSidebar({ delta: line.slice(6), status: "Streaming" });
    } else if (line === "DONE" || line.startsWith("ERROR ") || line.startsWith("CANCELLED ")) {
      record("terminal", { request: id, elapsedMs: Date.now() - active.started, state: line });
      toSidebar({ status: line });
    }
  }
  active.frame = frame;
  // IINA calls this hook from a file-handle queue. Host APIs here can race plugin unload.
  utils.exec(`${root}/native/stream-helper`, [directory], null, (chunk: string) => {
    active.buffer += chunk;
  }, null).then((result: { status: number }) => {
    active.exit = result.status;
  }, () => {
    active.error = true;
  });
}

function drainProcess(): void {
  const active = request;
  if (!active) return;
  if (active.buffer.length > 100_000) { cancelRequest(); active.buffer = ""; }
  let index: number;
  while ((index = active.buffer.indexOf("\n")) >= 0) {
    const line = active.buffer.slice(0, index);
    active.buffer = active.buffer.slice(index + 1);
    if (line) active.frame?.(line);
  }
  if (active.exit !== undefined || active.error) {
    record(active.error ? "process_error" : "process_exit", {
      request: active.id, status: active.exit ?? -1, elapsedMs: Date.now() - active.started
    });
    try { active.control?.close(); } catch { /* already closed */ }
    request = null;
    if (active.error) toSidebar({ status: "Helper could not start" });
  }
}

function registerBridge(): void {
overlay.onMessage("overlayReady", () => {
  overlayReady = true;
  overlay.setClickable(true);
  overlay.show();
  updateCue();
  record("overlay_ready");
});
overlay.onMessage("selected", (value: any) => {
  record("selected", { start: Number(value?.start) || 0, end: Number(value?.end) || 0,
    length: Number(value?.length) || 0 });
});
overlay.onMessage("explain", (value: any) => {
  if (!value || typeof value.text !== "string" || typeof value.cue !== "string" ||
      !Number.isInteger(value.start) || !Number.isInteger(value.end) ||
      value.text.length > 4000 || value.end <= value.start ||
      value.cue.slice(value.start, value.end) !== value.text) return;
  selected = { text: value.text, cue: value.cue, start: value.start, end: value.end };
  resumeUrl = core.status.url;
  resumeEpoch = mediaEpoch;
  conversationOpen = true;
  core.pause();
  sidebar.show();
  toSidebar({ selection: selected.text, status: "Selection captured; no request sent" });
  record("explain", { start: selected.start, end: selected.end, length: selected.text.length });
});
overlay.onMessage("selectionCleared", () => { selected = null; record("selection_cleared"); });

sidebar.onMessage("sidebarReady", () => {
  sidebarReady = true;
  toSidebar({ status: "Ready; synthetic local endpoint only" });
  record("sidebar_ready");
});
sidebar.onMessage("start", (value: any) => startStream(value?.mode));
sidebar.onMessage("stop", () => { cancelRequest(); toSidebar({ status: "Cancellation requested" }); });
sidebar.onMessage("close", () => closeConversation(false));
sidebar.onMessage("disableOverlay", () => {
  cancelRequest();
  overlayEnabled = false;
  overlay.hide();
  restorePrimaryVisibility();
  record("overlay_disabled");
  toSidebar({ status: "Overlay disabled; native primary restored" });
});
sidebar.onMessage("nextCue", () => {
  const next = (core.status.position || 0) < 7 ? 9 : 5;
  core.pause();
  core.seekTo(next);
  record("fixture_seek", { position: next });
});
sidebar.onMessage("visibility", (value: any) => {
  const hidden = value?.hidden === true;
  record("sidebar_visibility", { hidden, windowVisible: !!core.window.visible });
  if (hidden && core.window.visible && conversationOpen) closeConversation(true);
});
}

listeners.push(hostEvent.on("iina.window-loaded", () => {
  overlay.loadFile("ui/overlay.html");
  sidebar.loadFile("ui/sidebar.html");
  registerBridge();
  sidebar.show();
  timer = setInterval(() => { updateCue(); drainProcess(); }, 50);
  record("window_loaded");
}));
listeners.push(hostEvent.on("mpv.file-loaded", () => {
  mediaEpoch++;
  selected = null;
  conversationOpen = false;
  cancelRequest();
  restorePrimaryVisibility();
  const mediaUrl: string = core.status.url || "";
  if (mediaUrl.endsWith("/clip.mp4")) {
    core.pause();
    core.seekTo(1);
    try {
      const root = helperRoot();
      core.subtitle.loadTrack(root + "/fixtures/clip.tr.srt");
      core.subtitle.loadTrack(root + "/fixtures/clip.en.srt");
      setTimeout(() => {
        const tracks = core.subtitle.tracks.filter((track: any) => track.isExternal);
        if (tracks.length >= 2) {
          core.subtitle.id = tracks[0].id;
          core.subtitle.secondID = tracks[1].id;
          ownPrimaryVisibility();
          updateCue();
          record("fixture_tracks", { count: tracks.length, source: tracks[0].id, secondary: tracks[1].id });
        }
      }, 700);
    } catch { record("fixture_load_error"); }
  }
  record("file_loaded", { epoch: mediaEpoch });
}));
listeners.push(hostEvent.on("mpv.sub-text.changed", updateCue));
listeners.push(hostEvent.on("iina.plugin-overlay-loaded", () => {
  registerBridge();
  overlay.show();
  overlay.setClickable(true);
  overlayReady = true;
  updateCue();
  record("webview_loaded");
}));
listeners.push(hostEvent.on("iina.window-will-close", () => {
  cancelRequest();
  restorePrimaryVisibility();
  if (timer) clearInterval(timer);
  for (const id of listeners) hostEvent.off(id);
  record("window_close");
}));
record("init", { iina: core.getVersion().iina });
