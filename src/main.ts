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
  includeSecondary: boolean; noKeyRequired: boolean; secondaryBelowSource: boolean; appearance: Appearance;
};
type Appearance = { sourceSize: number; sourceColor: string; sourceBottom: number;
  translationSize: number; translationColor: string; translationGap: number };
type CueReplay = { epoch: number; url: string; conversationId: number; startMs: number; endMs: number;
  returnPositionMs: number; wasPaused: boolean; startedAt: number; phase: 'starting' | 'playing';
  sawPlaying: boolean; awaitingInitialSeek: boolean };
const DEFAULT_APPEARANCE: Appearance = { sourceSize: 28, sourceColor: '#ffffff',
  sourceBottom: 8, translationSize: 25, translationColor: '#ffffff', translationGap: 12 };
const DEFAULTS: Settings = {
  endpoint: '', model: '', sourceLanguage: 'Turkish', explanationLanguage: 'English',
  includeSecondary: true, noKeyRequired: false, secondaryBelowSource: false, appearance: DEFAULT_APPEARANCE
};

function validAppearance(value: unknown): Appearance {
  if (!value || typeof value !== 'object') throw new Error('Invalid subtitle appearance');
  const data = value as Record<string, unknown>;
  const number = (key: keyof Appearance, min: number, max: number): number => {
    const item = Number(data[key]);
    if (!Number.isInteger(item) || item < min || item > max) throw new Error(`Invalid ${key}`);
    return item;
  };
  const color = (key: 'sourceColor' | 'translationColor'): string => {
    const item = data[key];
    if (typeof item !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(item)) throw new Error(`Invalid ${key}`);
    return item;
  };
  return { sourceSize: number('sourceSize', 16, 56),
    sourceColor: color('sourceColor'), sourceBottom: number('sourceBottom', 4, 35),
    translationSize: number('translationSize', 16, 56), translationColor: color('translationColor'),
    translationGap: number('translationGap', 0, 80) };
}

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
    includeSecondary: data.includeSecondary, noKeyRequired: data.noKeyRequired,
    secondaryBelowSource: data.secondaryBelowSource === true,
    appearance: validAppearance(data.appearance) };
}

export class Session {
  private readonly credentials: Credentials;
  private settings: Settings;
  private appearancePreview: Appearance | null = null;
  private replay: CueReplay | null = null;
  private hasSavedKey = false;
  private mediaEpoch = 0;
  private mediaUrl = '';
  private ended = false;
  private sourceId: number | null = null;
  private secondaryId: number | null = null;
  private source: Cue[] | null = null;
  private secondary: Cue[] = [];
  private pending: PendingSelection | null = null;
  private lastSelection: { key: string; at: number } | null = null;
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
  private sidebarVisible = false;
  private settingsOpen = false;
  private overlayEnabled = true;
  private status = 'Select a subtitle phrase to begin.';
  private cueIdentity = '';
  private translationText = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private subtitleMenuState = '';
  private subtitleTrackState = '';
  private listeners: Array<{ name: string; id: string }> = [];
  private closed = false;

  constructor(readonly host: IinaHost) {
    this.credentials = new Credentials(host.raw.utils);
    const stored = host.raw.preferences.get('settings');
    this.settings = stored && typeof stored === 'object' ? { ...DEFAULTS, ...(stored as object),
      appearance: { ...DEFAULT_APPEARANCE, ...((stored as { appearance?: object }).appearance ?? {}) } } : { ...DEFAULTS };
    this.settings.secondaryBelowSource = this.settings.secondaryBelowSource === true;
    delete (this.settings.appearance as Appearance & { showTranslation?: boolean }).showTranslation;
    try { if (this.settings.endpoint) this.hasSavedKey = this.credentials.hasSavedKey(this.settings.endpoint); }
    catch { /* invalid old configuration remains visibly unusable */ }
  }

  start(): void {
    const { event } = this.host.raw;
    this.refreshSubtitleMenu();
    const on = (name: string, callback: () => void) => this.listeners.push({ name, id: event.on(name, callback) });
    on('iina.menu-update', () => this.refreshSubtitleMenu());
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
      this.host.toOverlay('appearance', this.appearancePreview ?? this.settings.appearance);
      this.host.toOverlay('subtitleOrder', this.settings.secondaryBelowSource);
      this.updateCue(true);
    });
    overlay.onMessage('selected', value => this.selectionReceived(value));
    overlay.onMessage('selectionCleared', () => { this.pending = null; });
    sidebar.loadFile('ui/sidebar.html');
    sidebar.onMessage('sidebarReady', () => { this.sidebarReady = true; this.render(); });
    sidebar.onMessage('followUp', value => this.followUp(value));
    sidebar.onMessage('stop', () => this.stop());
    sidebar.onMessage('retry', () => this.retry());
    sidebar.onMessage('replayCue', () => this.toggleReplay());
    sidebar.onMessage('close', () => this.dismissSidebar());
    sidebar.onMessage('disableOverlay', () => this.disableOverlay());
    sidebar.onMessage('enableOverlay', () => this.enableOverlay());
    sidebar.onMessage('saveSettings', value => this.saveSettings(value));
    sidebar.onMessage('saveAppearance', value => this.saveAppearance(value));
    sidebar.onMessage('previewAppearance', value => this.previewAppearance(value));
    sidebar.onMessage('addSubtitleFile', () => { void this.addSubtitleFile(); });
    sidebar.onMessage('selectSubtitleTrack', value => this.selectSubtitleTrack(value));
    sidebar.onMessage('swapSubtitleOrder', () => this.swapSubtitleOrder());
    sidebar.onMessage('settingsView', value => {
      const data = value as { open?: unknown; view?: unknown } | null;
      this.settingsOpen = data?.view === 'subtitles' || data?.view === 'ai' ||
        (data?.view === undefined && data?.open === true);
      if (!this.settingsOpen || data?.view === 'ai') this.discardAppearancePreview();
    });
    sidebar.onMessage('visibility', value => {
      const hidden = (value as { hidden?: unknown })?.hidden;
      if (hidden === false) this.sidebarVisible = true;
      if (hidden === true && this.host.windowVisible) {
        this.sidebarVisible = false;
        if (this.settingsOpen) {
          this.discardAppearancePreview();
          this.host.toSidebar('appearancePreviewEnded', {});
        }
        if (this.conversation && !this.settingsOpen) this.hideConversation();
      }
    });
  }

  private togglePanel(): void {
    if (this.sidebarVisible) {
      if (this.conversation && !this.settingsOpen) this.hideConversation();
      else { this.sidebarVisible = false; this.host.hideSidebar(); }
    } else {
      this.host.showSidebar();
      this.sidebarVisible = true;
      this.render();
    }
  }

  private refreshSubtitleMenu(): void {
    // 1. Read the tracks and selections for this player window.
    const tracks = this.host.subtitleTracks;
    const sourceId = this.host.sourceId;
    const secondaryId = this.host.secondaryId;
    const signature = JSON.stringify([this.mediaUrl, sourceId, secondaryId,
      tracks.map(track => [track.id, track.formattedTitle, track.title])]);
    if (signature === this.subtitleMenuState) return;

    // 2. Rebuild the menu before IINA displays it.
    const { menu } = this.host.raw;
    const epoch = this.mediaEpoch;
    menu.removeAllItems();
    menu.addItem(menu.item('Toggle Neden Panel', () => this.togglePanel(), { keyBinding: 'Alt+Meta+g' }));
    menu.addItem(menu.item('Add SRT/VTT File…', () => { void this.addSubtitleFile(); }, { enabled: !!this.mediaUrl }));

    // 3. Add IINA's current tracks under each subtitle role.
    for (const [name, selectedId, select] of [
      ['Source Subtitle', sourceId, (id: number) => this.selectSubtitleTrack({ role: 'source', id, epoch })],
      ['Secondary Subtitle', secondaryId, (id: number) => this.selectSubtitleTrack({ role: 'secondary', id, epoch })]
    ] as const) {
      const group = menu.item(name, null);
      group.addSubMenuItem(menu.item('Off', () => select(0), { selected: selectedId === null || selectedId === 0 }));
      for (const track of tracks) {
        const title = track.formattedTitle || track.title || `Track ${track.id}`;
        group.addSubMenuItem(menu.item(title, () => select(track.id), { selected: selectedId === track.id }));
      }
      menu.addItem(group);
    }

    this.subtitleMenuState = signature;
  }

  private selectSubtitleTrack(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const { role, id, epoch } = value as { role?: unknown; id?: unknown; epoch?: unknown };
    if ((role !== 'source' && role !== 'secondary') || !Number.isInteger(id) ||
      epoch !== this.mediaEpoch || !this.mediaUrl || this.mediaUrl !== this.host.mediaUrl) return;
    if (id !== 0 && !this.host.subtitleTracks.some(track => track.id === id)) return;

    if (role === 'source') this.host.selectSource(id as number);
    else this.host.selectSecondary(id as number);
    this.syncTracks();
    this.updateCue(true);
    this.render();
  }

  private async addSubtitleFile(): Promise<void> {
    // 1. Associate the picker with the movie that opened it.
    const epoch = this.mediaEpoch;
    if (!this.mediaUrl || this.closed) return;

    // 2. Load only a supported file while that movie still owns the window.
    try {
      const path = await this.host.chooseSubtitleFile();
      if (!path || this.closed || epoch !== this.mediaEpoch || this.mediaUrl !== this.host.mediaUrl) return;

      if (!/\.(srt|vtt)$/i.test(path)) throw new Error('Choose an SRT or VTT subtitle file');

      this.host.loadSubtitleFile(path);
      this.status = 'Subtitle file added. Choose its role under Subtitle tracks.';
      this.syncTracks();
      this.updateCue(true);
    } catch (error) {
      this.status = error instanceof Error ? error.message : 'Could not load subtitle file';
    }

    this.render();
  }

  private readCues(id: number): Cue[] {
    const text = this.host.readTrack(id);
    return parseSubtitles(text, /^\uFEFF?WEBVTT(?:\s|$)/.test(text) ? 'vtt' : 'srt');
  }

  private mediaChanged(): void {
    if (this.closed) return;
    this.replay = null;
    this.discardAppearancePreview();
    this.cancelRequest();
    this.conversation = null;
    this.resume = null;
    this.pending = null;
    this.lastSelection = null;
    this.mediaEpoch++;
    this.mediaUrl = this.host.mediaUrl;
    this.host.restorePrimary();
    this.host.restoreSecondary();
    this.sourceId = null;
    this.secondaryId = null;
    this.subtitleTrackState = '';
    this.source = null;
    this.secondary = [];
    this.cueIdentity = '';
    this.translationText = '';
    this.host.setOverlayClickable(false);
    if (this.overlayReady) this.host.toOverlay('clear', {});
    if (this.overlayReady) this.host.toOverlay('translation', '');
    this.host.hideSidebar();
    this.sidebarVisible = false;
    this.syncTracks();
    this.render();
  }

  private syncTracks(): void {
    const signature = JSON.stringify([this.host.sourceId, this.host.secondaryId,
      this.host.subtitleTracks.map(track => [track.id, track.formattedTitle, track.title, track.isExternal])]);
    let changed = signature !== this.subtitleTrackState;
    this.subtitleTrackState = signature;
    if (!this.overlayEnabled || !this.mediaUrl || this.ended) {
      if (changed) this.render();
      return;
    }
    const sourceId = this.host.sourceId;
    if (sourceId !== this.sourceId) {
      changed = true;
      this.host.restorePrimary();
      this.host.restoreSecondary();
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
        catch { /* display uses IINA's current text; context has no parsed secondary cues */ }
      }
    }
    if (changed) this.render();
  }

  private updateCue(force = false): void {
    if (!this.overlayReady || !this.overlayEnabled) return;
    const sourceId = this.sourceId;
    let cue: Cue | null = null;
    let sourceReady = false;
    if (sourceId !== null && this.source) {
      cue = cueAt(this.source, this.host.positionMs, this.host.delayMs, this.host.subtitleSpeed);
      const displayed = this.host.displayedSource;
      const mismatch = 'Subtitle timing or text does not match the selected file.';
      if (displayed && (!cue || cue.text !== displayed || Math.abs(cue.startMs - this.host.displayedStartMs) > 50)) {
        cue = null;
        this.host.restorePrimary();
        this.host.restoreSecondary();
        if (this.status !== mismatch) { this.status = mismatch; this.render(); }
      } else {
        sourceReady = true;
        this.host.ownPrimary();
        if (this.status === mismatch) { this.status = 'Select a subtitle phrase to begin.'; this.render(); }
      }
    }
    const showSecondary = sourceReady && this.secondaryId !== null && this.secondaryId !== 0;
    if (showSecondary) this.host.ownSecondary();
    else this.host.restoreSecondary();
    this.host.setOverlayClickable(sourceReady);
    const translation = showSecondary ? this.host.secondaryText : '';
    if (force || translation !== this.translationText) {
      this.translationText = translation;
      this.host.toOverlay('translation', translation);
    }
    const identity = cue ? `${sourceId}:${cue.index}:${cue.text}` : 'none';
    if (force || identity !== this.cueIdentity) {
      this.cueIdentity = identity;
      this.host.toOverlay('cue', cue ? { trackId: sourceId, index: cue.index, text: cue.text } : null);
    }
  }

  private seek(): void {
    const replay = this.replay;
    if (replay) {
      const position = this.host.positionMs;
      const initialSeek = replay.awaitingInitialSeek && Date.now() - replay.startedAt < 1_500 &&
        (Math.abs(position - replay.startMs) <= 300 || Math.abs(position - replay.returnPositionMs) <= 300);
      replay.awaitingInitialSeek = false;
      if (!initialSeek) { this.replay = null; this.render(); }
    }
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
    this.replay = null;
    const key = `${this.mediaEpoch}:${this.sourceId}:${sourceCue.index}:${start}:${end}`;
    if (this.sidebarVisible && this.lastSelection?.key === key && Date.now() - this.lastSelection.at < 500) return;
    this.lastSelection = { key, at: Date.now() };
    this.pending = { cue: { trackId: this.sourceId!, index: sourceCue.index, text: sourceCue.text }, start, end, text };
    this.explain(this.pending);
  }

  private explain(value: unknown): void {
    if (!this.overlayEnabled || !this.source || !this.pending || !value || typeof value !== 'object') return;
    const submitted = value as PendingSelection;
    if (submitted.text !== this.pending.text || submitted.start !== this.pending.start ||
      submitted.end !== this.pending.end || submitted.cue?.index !== this.pending.cue.index ||
      submitted.cue?.trackId !== this.sourceId) return;
    const pending = this.pending;
    this.pending = null;
    this.discardAppearancePreview();
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
      this.sidebarVisible = true;
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
      const deepSeekFlash = new URL(endpoint.base).hostname === 'api.deepseek.com' &&
        this.settings.model === 'deepseek-flash';
      const payload = JSON.stringify({ url: endpoint.requestUrl, key,
        body: { model: this.settings.model, stream: true, messages: request.messages,
          ...(deepSeekFlash ? { thinking: { type: 'disabled' } } : {}) } });
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
    this.finishReplay(true);
    const question = (value as { question?: unknown }).question;
    try {
      const request = this.conversation.followUp(typeof question === 'string' ? question : '');
      this.pauseForConversation();
      this.launch(request);
    }
    catch (error) { this.status = error instanceof Error ? error.message : 'Could not send follow-up'; this.render(); }
  }

  private retry(): void {
    if (!this.conversation) return;
    this.finishReplay(true);
    try {
      const request = this.conversation.retry();
      this.pauseForConversation();
      this.launch(request);
    }
    catch (error) { this.status = error instanceof Error ? error.message : 'Retry unavailable'; this.render(); }
  }

  private pauseForConversation(): void {
    if (this.resume || !this.host.playable || this.mediaUrl !== this.host.mediaUrl) return;
    this.resume = { epoch: this.mediaEpoch, url: this.mediaUrl };
    this.host.pause();
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

  private hideConversation(): void {
    if (!this.conversation) return;
    this.finishReplay(true);
    this.conversation.stop();
    this.cancelRequest();
    this.host.hideSidebar();
    this.sidebarVisible = false;
    this.lastSelection = null;
    const resume = this.resume;
    this.resume = null;
    if (resume && resume.epoch === this.mediaEpoch && resume.url === this.host.mediaUrl && this.host.playable) this.host.resume();
    this.status = 'Conversation saved in this window.';
    this.render();
  }

  private dismissSidebar(): void {
    this.discardAppearancePreview();
    if (this.conversation) {
      this.hideConversation();
      return;
    }

    this.sidebarVisible = false;
    this.host.hideSidebar();
  }

  private closeConversation(): void {
    this.hideConversation();
    this.conversation = null;
    this.render();
  }

  private disableOverlay(): void {
    this.finishReplay(true);
    this.discardAppearancePreview();
    this.closeConversation();
    this.cancelRequest();
    this.pending = null;
    this.overlayEnabled = false;
    this.host.hideOverlay();
    this.host.restorePrimary();
    this.host.restoreSecondary();
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
      const next = validSettings({ ...(value as object), appearance: this.settings.appearance,
        secondaryBelowSource: this.settings.secondaryBelowSource });
      const key = (value as { key?: unknown }).key;
      if (key !== '' && key !== undefined) {
        if (typeof key !== 'string') throw new Error('Invalid API key');
        this.credentials.save(next.endpoint, key);
      }
      const changed = JSON.stringify({ ...next, appearance: undefined }) !== JSON.stringify({ ...this.settings, appearance: undefined }) || !!key;
      this.settings = next;
      this.hasSavedKey = this.credentials.hasSavedKey(next.endpoint);
      this.host.raw.preferences.set('settings', next);
      this.host.raw.preferences.sync();
      if (changed && this.conversation) { this.closeConversation(); this.host.showSidebar(); this.sidebarVisible = true; }
      this.status = 'Settings saved. No request was sent.';
    } catch (error) { this.status = error instanceof Error ? error.message : 'Could not save settings'; }
    this.render();
  }

  private swapSubtitleOrder(): void {
    const next = { ...this.settings, secondaryBelowSource: !this.settings.secondaryBelowSource };
    try {
      this.host.raw.preferences.set('settings', next);
      this.host.raw.preferences.sync();
      this.settings = next;
      if (this.overlayReady) this.host.toOverlay('subtitleOrder', next.secondaryBelowSource);
      this.render();
    } catch (error) {
      this.status = error instanceof Error ? error.message : 'Could not save subtitle order';
      this.render();
    }
  }

  private saveAppearance(value: unknown): void {
    try {
      const appearance = validAppearance(value);
      const next = { ...this.settings, appearance };
      this.host.raw.preferences.set('settings', next);
      this.host.raw.preferences.sync();
      this.settings = next;
      this.appearancePreview = null;
      if (this.overlayReady) this.host.toOverlay('appearance', this.settings.appearance);
      this.updateCue(true);
      this.status = 'Subtitle appearance saved.';
    } catch (error) { this.status = error instanceof Error ? error.message : 'Could not save subtitle appearance'; }
    this.render();
  }

  private previewAppearance(value: unknown): void {
    if (!this.settingsOpen || !this.overlayEnabled) return;
    try {
      this.appearancePreview = validAppearance(value);
    } catch { return; }

    if (this.overlayReady) this.host.toOverlay('appearance', this.appearancePreview);
    this.updateCue(true);
  }

  private discardAppearancePreview(): void {
    if (!this.appearancePreview) return;
    this.appearancePreview = null;
    if (this.overlayReady) this.host.toOverlay('appearance', this.settings.appearance);
    this.updateCue(true);
  }

  private toggleReplay(): void {
    if (this.replay) { this.finishReplay(true); return; }

    // 1. Resolve the selected cue against this window's current playback timeline.
    const conversation = this.conversation;
    if (!conversation || conversation.context.selection.mediaEpoch !== this.mediaEpoch ||
      conversation.context.selection.sourceTrackId !== this.host.sourceId ||
      this.mediaUrl !== this.host.mediaUrl || !this.host.playable) return;
    const selection = conversation.context.selection;
    const speed = this.host.subtitleSpeed;
    const startMs = Math.max(0, selection.cueStartMs / speed + this.host.delayMs);
    const duration = this.host.raw.core.status.duration;
    const cueEndMs = selection.cueEndMs / speed + this.host.delayMs;
    const endMs = duration !== null && Number.isFinite(duration) && duration > 0 ?
      Math.min(duration * 1000, cueEndMs) : cueEndMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs - startMs < 100) return;

    // 2. Keep the current watch position and pause state for the return trip.
    this.replay = { epoch: this.mediaEpoch, url: this.mediaUrl, conversationId: conversation.id,
      startMs, endMs, returnPositionMs: this.host.positionMs, wasPaused: this.host.paused,
      startedAt: Date.now(), phase: 'starting', sawPlaying: false, awaitingInitialSeek: true };
    try {
      this.host.seekTo(startMs);
      this.host.resume();
    } catch {
      this.replay = null;
      this.status = 'Could not replay this line.';
    }
    this.render();
  }

  private tickReplay(): void {
    const replay = this.replay;
    if (!replay) return;
    if (replay.epoch !== this.mediaEpoch || replay.url !== this.host.mediaUrl ||
      this.conversation?.context.selection.sourceTrackId !== this.host.sourceId ||
      replay.conversationId !== this.conversation?.id) { this.replay = null; this.render(); return; }

    const position = this.host.positionMs;
    if (replay.phase === 'starting') {
      if (position >= replay.startMs - 250 && position < replay.endMs) replay.phase = 'playing';
      else if (Date.now() - replay.startedAt > 5_000) {
        this.finishReplay(true);
        this.status = 'Could not replay this line.';
        this.render();
        return;
      } else return;
    }

    if (!this.host.paused) replay.sawPlaying = true;
    if ((replay.sawPlaying && this.host.paused) || position < replay.startMs - 500 || position > replay.endMs + 1_000) {
      this.replay = null;
      this.render();
      return;
    }
    if (position >= replay.endMs - 50) this.finishReplay(true);
  }

  private finishReplay(restorePosition: boolean): void {
    const replay = this.replay;
    if (!replay) return;
    this.replay = null;
    if (restorePosition && replay.epoch === this.mediaEpoch && replay.url === this.host.mediaUrl) {
      this.host.pause();
      this.host.seekTo(replay.returnPositionMs);
      if (!replay.wasPaused) this.host.resume();
    }
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
      status: this.status, open: !!conversation, conversationId: conversation?.id ?? null,
      overlayEnabled: this.overlayEnabled,
      replaying: this.replay !== null,
      replayAvailable: !!conversation && conversation.context.selection.mediaEpoch === this.mediaEpoch &&
        conversation.context.selection.sourceTrackId === this.host.sourceId &&
        this.mediaUrl === this.host.mediaUrl && this.host.playable,
      mediaEpoch: this.mediaEpoch, hasMedia: !!this.mediaUrl,
      sourceId: this.host.sourceId, secondaryId: this.host.secondaryId,
      subtitleTracks: this.host.subtitleTracks.map(track => ({ id: track.id,
        title: track.formattedTitle || track.title || `Track ${track.id}`, isExternal: track.isExternal })),
      phrase: conversation?.context.selection.exactText ?? '',
      cue: conversation?.context.selection.cueText ?? '',
      turns: conversation?.turns ?? [],
      settings: { ...this.settings, hasSavedKey: this.hasSavedKey, requestUrl }
    });
  }

  private tick(): void {
    if (this.closed) return;
    if (this.host.mediaUrl !== this.mediaUrl) { this.ended = false; this.mediaChanged(); }
    this.tickReplay();
    this.syncTracks();
    this.updateCue();
    const active = this.active;
    if (active && active.stream.pump() && this.active === active) this.active = null;
    this.retiring = this.retiring.filter(stream => !stream.pump());
  }

  private teardown(): void {
    this.closed = true;
    this.replay = null;
    this.conversation?.stop();
    this.cancelRequest();
    this.conversation = null;
    this.resume = null;
    this.pending = null;
    this.host.restorePrimary();
    this.host.restoreSecondary();
    this.host.hideOverlay();
    if (this.timer) clearInterval(this.timer);
    for (const { name, id } of this.listeners) this.host.raw.event.off(name, id);
    this.listeners = [];
  }
}

if (typeof iina !== 'undefined') new Session(new IinaHost(iina, PLUGIN_ID)).start();
