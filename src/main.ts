import { canonicalEndpoint, Credentials } from './credentials';
import { Conversation, type ContextSnapshot, type RequestOwner } from './conversation';
import { IinaHost, type RawIina } from './iina-host';
import { NativeStream, type StreamRecord } from './stream';
import { contextForCue, cueAt, parseSubtitles, type Cue } from './subtitles';
import type { PendingSelection } from './selection';

declare const iina: RawIina;
const PLUGIN_ID = 'io.github.hanifcarroll.iina-language-learning';

type Settings = {
  endpoint: string; model: string; sourceLanguage: string; explanationLanguage: string;
  includeSecondary: boolean; noKeyRequired: boolean;
};
const DEFAULTS: Settings = {
  endpoint: '', model: '', sourceLanguage: 'Turkish', explanationLanguage: 'English',
  includeSecondary: true, noKeyRequired: false
};

function validSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') throw new Error('Invalid settings');
  const data = value as Record<string, unknown>;
  const model = typeof data.model === 'string' ? data.model.trim() : '';
  const sourceLanguage = typeof data.sourceLanguage === 'string' ? data.sourceLanguage.trim() : '';
  const explanationLanguage = typeof data.explanationLanguage === 'string' ? data.explanationLanguage.trim() : '';
  if (!model || model.length > 120 || !/^[\w./:-]+$/.test(model)) throw new Error('Enter a valid model name');
  if (!sourceLanguage || sourceLanguage.length > 64 || !explanationLanguage || explanationLanguage.length > 64) {
    throw new Error('Enter source and explanation languages');
  }
  if (typeof data.includeSecondary !== 'boolean' || typeof data.noKeyRequired !== 'boolean') throw new Error('Invalid settings');
  const endpoint = canonicalEndpoint(String(data.endpoint ?? '')).base;
  return { endpoint, model, sourceLanguage, explanationLanguage,
    includeSecondary: data.includeSecondary, noKeyRequired: data.noKeyRequired };
}

export class Session {
  private readonly credentials: Credentials;
  private settings: Settings;
  private hasSavedKey = false;
  private mediaEpoch = 0;
  private mediaUrl = '';
  private ended = false;
  private sourceId: number | null = null;
  private secondaryId: number | null = null;
  private source: Cue[] | null = null;
  private secondary: Cue[] = [];
  private pending: PendingSelection | null = null;
  private conversation: Conversation | null = null;
  private nextConversationId = 0;
  private nextStreamId = 0;
  private active: { owner: RequestOwner; stream: NativeStream } | null = null;
  private retiring: NativeStream[] = [];
  private resume: { epoch: number; url: string } | null = null;
  private overlayReady = false;
  private windowInitialized = false;
  private overlayPageRequested = false;
  private sidebarReady = false;
  private settingsOpen = false;
  private overlayEnabled = true;
  private status = 'Select a subtitle phrase to begin.';
  private cueIdentity = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: Array<{ name: string; id: string }> = [];
  private closed = false;

  constructor(readonly host: IinaHost) {
    this.credentials = new Credentials(host.raw.utils);
    const stored = host.raw.preferences.get('settings');
    this.settings = stored && typeof stored === 'object' ? { ...DEFAULTS, ...(stored as object) } : { ...DEFAULTS };
    try { if (this.settings.endpoint) this.hasSavedKey = this.credentials.hasSavedKey(this.settings.endpoint); }
    catch { /* invalid old configuration remains visibly unusable */ }
  }

  start(): void {
    const { event } = this.host.raw;
    const on = (name: string, callback: () => void) => this.listeners.push({ name, id: event.on(name, callback) });
    on('iina.window-loaded', () => this.windowLoaded());
    on('mpv.file-loaded', () => { this.ended = false; this.mediaChanged(); });
    on('mpv.seek', () => this.seek());
    on('mpv.end-file', () => { this.ended = true; this.mediaChanged(); });
    on('iina.window-will-close', () => this.teardown());
    // Installing into an already open player does not replay iina.window-loaded.
    if (this.host.raw.core.window.loaded === true) this.windowLoaded();
  }

  private windowLoaded(): void {
    if (this.windowInitialized || this.closed) return;
    this.windowInitialized = true;
    const { overlay, event } = this.host.raw;
    // Installed IINA initializes a hidden overlay after simpleMode loads.
    const name = 'iina.plugin-overlay-loaded';
    this.listeners.push({ name, id: event.on(name, () => {
      if (this.overlayPageRequested || this.closed) return;
      this.overlayPageRequested = true;
      this.loadViews();
    }) });
    overlay.simpleMode();
    this.mediaChanged();
    this.timer = setInterval(() => this.tick(), 100);
  }

  private loadViews(): void {
    const { overlay, sidebar } = this.host.raw;
    // IINA clears message listeners when loadFile is called.
    overlay.loadFile('ui/overlay.html');
    overlay.onMessage('overlayReady', () => {
      this.overlayReady = true;
      if (this.overlayEnabled) this.host.showOverlay();
      this.updateCue(true);
    });
    overlay.onMessage('selected', value => this.selectionReceived(value));
    overlay.onMessage('selectionCleared', () => { this.pending = null; });
    overlay.onMessage('explain', value => this.explain(value));
    sidebar.loadFile('ui/sidebar.html');
    sidebar.onMessage('sidebarReady', () => { this.sidebarReady = true; this.render(); });
    sidebar.onMessage('followUp', value => this.followUp(value));
    sidebar.onMessage('stop', () => this.stop());
    sidebar.onMessage('retry', () => this.retry());
    sidebar.onMessage('close', () => this.closeConversation());
    sidebar.onMessage('disableOverlay', () => this.disableOverlay());
    sidebar.onMessage('enableOverlay', () => this.enableOverlay());
    sidebar.onMessage('saveSettings', value => this.saveSettings(value));
    sidebar.onMessage('settingsView', value => { this.settingsOpen = (value as { open?: unknown })?.open === true; });
    sidebar.onMessage('visibility', value => {
      if ((value as { hidden?: unknown })?.hidden === true && this.host.windowVisible && this.conversation && !this.settingsOpen) {
        this.closeConversation();
      }
    });
  }

  private readCues(id: number): Cue[] {
    const text = this.host.readTrack(id);
    return parseSubtitles(text, /^\uFEFF?WEBVTT(?:\s|$)/.test(text) ? 'vtt' : 'srt');
  }

  private mediaChanged(): void {
    if (this.closed) return;
    this.cancelRequest();
    this.conversation = null;
    this.resume = null;
    this.pending = null;
    this.mediaEpoch++;
    this.mediaUrl = this.host.mediaUrl;
    this.host.restorePrimary();
    this.sourceId = null;
    this.secondaryId = null;
    this.source = null;
    this.secondary = [];
    this.cueIdentity = '';
    if (this.overlayReady) this.host.toOverlay('clear', {});
    this.host.hideSidebar();
    this.syncTracks();
    this.render();
  }

  private syncTracks(): void {
    if (!this.overlayEnabled || !this.mediaUrl || this.ended) return;
    let changed = false;
    const sourceId = this.host.sourceId;
    if (sourceId !== this.sourceId) {
      changed = true;
      this.host.restorePrimary();
      this.pending = null;
      if (this.overlayReady) this.host.toOverlay('clear', {});
      this.sourceId = sourceId;
      this.source = null;
      const track = this.host.externalTrack(sourceId);
      if (track && sourceId !== null) {
        try { this.source = this.readCues(sourceId); this.status = 'Select a subtitle phrase to begin.'; }
        catch (error) { this.status = error instanceof Error ? error.message : 'Subtitle file is unreadable'; }
      } else this.status = 'Select an external UTF-8 SRT or VTT source subtitle track.';
    }
    const secondaryId = this.host.secondaryId;
    if (secondaryId !== this.secondaryId) {
      changed = true;
      this.secondaryId = secondaryId;
      this.secondary = [];
      if (this.host.externalTrack(secondaryId) && secondaryId !== null) {
        try { this.secondary = this.readCues(secondaryId); }
        catch { /* native secondary remains visible; context simply has no parsed secondary cues */ }
      }
    }
    if (changed) this.render();
  }

  private updateCue(force = false): void {
    if (!this.overlayReady || !this.overlayEnabled) return;
    const sourceId = this.sourceId;
    let cue: Cue | null = null;
    if (sourceId !== null && this.source) {
      cue = cueAt(this.source, this.host.positionMs, this.host.delayMs, this.host.subtitleSpeed);
      const displayed = this.host.displayedSource;
      const mismatch = 'Subtitle timing or text does not match the selected file.';
      if (displayed && (!cue || cue.text !== displayed || Math.abs(cue.startMs - this.host.displayedStartMs) > 50)) {
        cue = null;
        this.host.restorePrimary();
        if (this.status !== mismatch) { this.status = mismatch; this.render(); }
      } else {
        this.host.ownPrimary();
        if (this.status === mismatch) { this.status = 'Select a subtitle phrase to begin.'; this.render(); }
      }
    }
    const identity = cue ? `${sourceId}:${cue.index}:${cue.text}` : 'none';
    if (force || identity !== this.cueIdentity) {
      this.cueIdentity = identity;
      this.host.toOverlay('cue', cue ? { trackId: sourceId, index: cue.index, text: cue.text } : null);
    }
  }

  private seek(): void {
    this.pending = null;
    if (this.overlayReady) this.host.toOverlay('seek', {});
    this.updateCue(true);
  }

  private selectionReceived(value: unknown): void {
    if (!this.overlayEnabled || !this.source || !value || typeof value !== 'object') return;
    const data = value as { cue?: { trackId?: unknown; index?: unknown; text?: unknown }; start?: unknown; end?: unknown };
    const { cue, start, end } = data;
    if (!cue || cue.trackId !== this.sourceId || !Number.isInteger(cue.index) ||
      typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)) return;
    const sourceCue = this.source[cue.index as number];
    if (!sourceCue || sourceCue.text !== cue.text || start < 0 || end <= start || end > sourceCue.text.length) return;
    const text = sourceCue.text.slice(start, end);
    if (!text.trim() || text.length > 4_000) return;
    this.pending = { cue: { trackId: this.sourceId!, index: sourceCue.index, text: sourceCue.text }, start, end, text };
  }

  private explain(value: unknown): void {
    if (!this.overlayEnabled || !this.source || !this.pending || !value || typeof value !== 'object') return;
    const submitted = value as PendingSelection;
    if (submitted.text !== this.pending.text || submitted.start !== this.pending.start ||
      submitted.end !== this.pending.end || submitted.cue?.index !== this.pending.cue.index ||
      submitted.cue?.trackId !== this.sourceId) return;
    const pending = this.pending;
    this.pending = null;
    if (this.overlayReady) this.host.toOverlay('clear', {});
    const sourceCue = this.source[pending.cue.index];
    try {
      const context = contextForCue(this.source, sourceCue.index, this.secondary, this.settings.includeSecondary,
        { sourceDelayMs: this.host.delayMs, secondaryDelayMs: this.host.secondaryDelayMs, speed: this.host.subtitleSpeed });
      const snapshot: ContextSnapshot = {
        selection: { mediaEpoch: this.mediaEpoch, sourceTrackId: this.sourceId!, cueIndex: sourceCue.index,
          cueStartMs: sourceCue.startMs, cueEndMs: sourceCue.endMs, cueText: sourceCue.text,
          rangeStartUtf16: pending.start, rangeEndUtf16: pending.end, exactText: pending.text },
        before: context.before.map(cue => ({ ...cue })), after: context.after.map(cue => ({ ...cue })),
        secondary: context.secondary.map(cue => ({ ...cue })),
        sourceLanguage: this.settings.sourceLanguage, explanationLanguage: this.settings.explanationLanguage
      };
      this.cancelRequest();
      this.conversation = new Conversation(++this.nextConversationId, snapshot);
      this.resume = { epoch: this.mediaEpoch, url: this.mediaUrl };
      this.host.pause();
      this.settingsOpen = false;
      if (this.sidebarReady) this.host.toSidebar('showConversation', {});
      this.host.showSidebar();
      this.status = 'Preparing explanation…';
      this.render();
      this.launch(this.conversation.beginInitial());
    } catch (error) { this.status = error instanceof Error ? error.message : 'Could not explain selection'; this.render(); }
  }

  private launch(request: { owner: RequestOwner; messages: unknown }): void {
    const conversation = this.conversation;
    if (!conversation) return;
    try {
      const endpoint = canonicalEndpoint(this.settings.endpoint);
      if (!this.settings.model) throw new Error('Set an API model in Settings');
      const key = this.settings.noKeyRequired ? null : this.credentials.readForRequest(endpoint.base);
      if (!this.settings.noKeyRequired && !key) throw new Error('Save an API key for this endpoint in Settings');
      const payload = JSON.stringify({ url: endpoint.requestUrl, key,
        body: { model: this.settings.model, stream: true, messages: request.messages } });
      const stream = new NativeStream(this.host.raw, this.host.helperPath(), this.host.requestDirectory(++this.nextStreamId),
        payload, record => this.streamRecord(request.owner, record));
      this.active = { owner: request.owner, stream };
      stream.start();
      this.status = 'Generating…';
    } catch (error) {
      conversation.fail(request.owner, error instanceof Error ? error.message : 'Request setup failed');
      this.status = error instanceof Error ? error.message : 'Request setup failed';
    }
    this.render();
  }

  private streamRecord(owner: RequestOwner, record: StreamRecord): void {
    if (!this.active || !this.sameOwner(this.active.owner, owner) || !this.conversation?.accepts(owner)) return;
    if (record.kind === 'delta') this.conversation.delta(owner, record.value);
    else if (record.kind === 'done') { this.conversation.complete(owner); this.status = 'Complete'; }
    else if (record.kind === 'error') { this.conversation.fail(owner, record.value); this.status = `Request failed: ${record.value}`; }
    else if (record.kind === 'cancelled') { this.conversation.fail(owner, 'Cancelled'); this.status = 'Cancelled'; }
    this.render();
  }

  private sameOwner(a: RequestOwner, b: RequestOwner): boolean {
    return a.mediaEpoch === b.mediaEpoch && a.conversationId === b.conversationId && a.requestId === b.requestId;
  }

  private followUp(value: unknown): void {
    if (!this.conversation || !value || typeof value !== 'object') return;
    const question = (value as { question?: unknown }).question;
    try { this.launch(this.conversation.followUp(typeof question === 'string' ? question : '')); }
    catch (error) { this.status = error instanceof Error ? error.message : 'Could not send follow-up'; this.render(); }
  }

  private retry(): void {
    if (!this.conversation) return;
    try { this.launch(this.conversation.retry()); }
    catch (error) { this.status = error instanceof Error ? error.message : 'Retry unavailable'; this.render(); }
  }

  private stop(): void {
    if (!this.conversation?.stop()) return;
    this.cancelRequest();
    this.status = 'Stopped; partial answer is incomplete.';
    this.render();
  }

  private cancelRequest(): void {
    if (!this.active) return;
    const active = this.active;
    this.active = null;
    active.stream.cancel();
    this.retiring.push(active.stream);
  }

  private closeConversation(): void {
    if (!this.conversation) return;
    this.conversation.stop();
    this.cancelRequest();
    this.conversation = null;
    this.host.hideSidebar();
    const resume = this.resume;
    this.resume = null;
    if (resume && resume.epoch === this.mediaEpoch && resume.url === this.host.mediaUrl && this.host.playable) this.host.resume();
    this.status = 'Conversation closed.';
    this.render();
  }

  private disableOverlay(): void {
    this.closeConversation();
    this.cancelRequest();
    this.pending = null;
    this.overlayEnabled = false;
    this.host.hideOverlay();
    this.host.restorePrimary();
    this.status = 'Overlay disabled; native subtitles restored.';
    this.render();
  }

  private enableOverlay(): void {
    if (this.overlayEnabled) return;
    this.overlayEnabled = true;
    this.sourceId = null;
    this.syncTracks();
    if (this.overlayReady) this.host.showOverlay();
    this.updateCue(true);
    this.render();
  }

  private saveSettings(value: unknown): void {
    try {
      const next = validSettings(value);
      const key = (value as { key?: unknown }).key;
      if (key !== '' && key !== undefined) {
        if (typeof key !== 'string') throw new Error('Invalid API key');
        this.credentials.save(next.endpoint, key);
      }
      const changed = JSON.stringify(next) !== JSON.stringify(this.settings) || !!key;
      this.settings = next;
      this.hasSavedKey = this.credentials.hasSavedKey(next.endpoint);
      this.host.raw.preferences.set('settings', next);
      this.host.raw.preferences.sync();
      if (changed && this.conversation) { this.closeConversation(); this.host.showSidebar(); }
      this.status = 'Settings saved. No request was sent.';
    } catch (error) { this.status = error instanceof Error ? error.message : 'Could not save settings'; }
    this.render();
  }

  private render(): void {
    if (!this.sidebarReady) return;
    let requestUrl = '';
    try {
      if (this.settings.endpoint) {
        requestUrl = canonicalEndpoint(this.settings.endpoint).requestUrl;
      }
    } catch { /* an unsaved invalid endpoint has no credential status */ }
    const conversation = this.conversation;
    this.host.toSidebar('state', {
      status: this.status, open: !!conversation, overlayEnabled: this.overlayEnabled,
      phrase: conversation?.context.selection.exactText ?? '',
      cue: conversation?.context.selection.cueText ?? '',
      turns: conversation?.turns ?? [],
      settings: { ...this.settings, hasSavedKey: this.hasSavedKey, requestUrl }
    });
  }

  private tick(): void {
    if (this.closed) return;
    if (this.host.mediaUrl !== this.mediaUrl) { this.ended = false; this.mediaChanged(); }
    this.syncTracks();
    this.updateCue();
    const active = this.active;
    if (active && active.stream.pump() && this.active === active) this.active = null;
    this.retiring = this.retiring.filter(stream => !stream.pump());
  }

  private teardown(): void {
    this.closed = true;
    this.conversation?.stop();
    this.cancelRequest();
    this.conversation = null;
    this.resume = null;
    this.pending = null;
    this.host.restorePrimary();
    this.host.hideOverlay();
    if (this.timer) clearInterval(this.timer);
    for (const { name, id } of this.listeners) this.host.raw.event.off(name, id);
    this.listeners = [];
  }
}

if (typeof iina !== 'undefined') new Session(new IinaHost(iina, PLUGIN_ID)).start();
