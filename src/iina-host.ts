import type { Keychain } from './credentials';

export type SubtitleTrack = { id: number; isExternal: boolean; title: string | null; formattedTitle?: string; codec: string | null };
export type MenuItem = { addSubMenuItem(item: MenuItem): MenuItem };
export type RawIina = {
  core: {
    status: { url: string; position: number; duration: number | null; idle: boolean; paused: boolean };
    window: { loaded: boolean; visible: boolean };
    subtitle: { id: number | null; secondID: number | null; tracks: SubtitleTrack[]; loadTrack(path: string): void };
    pause(): void; resume(): void; seekTo(seconds: number): void;
  };
  event: { on(name: string, callback: () => void): string; off(name: string, id: string): void };
  file: { read(path: string, options: object): string | undefined; exists(path: string): boolean;
    handle(path: string, mode: string): { write(value: string): void; close(): void } };
  mpv: { getString(name: string): string | null; getNumber(name: string): number; getFlag(name: string): boolean; set(name: string, value: unknown): void };
  overlay: { simpleMode(): void; loadFile(path: string): void; onMessage(name: string, callback: (data: unknown) => void): void;
    postMessage(name: string, value: string): void; show(): void; hide(): void; setClickable(value: boolean): void };
  sidebar: { loadFile(path: string): void; onMessage(name: string, callback: (data: unknown) => void): void;
    postMessage(name: string, value: string): void; show(): void; hide(): void };
  menu: { item(title: string, action?: (() => void) | null,
    options?: { keyBinding?: string; selected?: boolean; enabled?: boolean }): MenuItem;
    addItem(item: MenuItem): void; removeAllItems(): void };
  preferences: { get(name: string): unknown; set(name: string, value: unknown): void; sync(): void };
  utils: Keychain & { resolvePath(path: string): string;
    chooseFile(title: string, options: { allowedFileTypes: string[] }): Promise<string>;
    exec(path: string, args: string[], cwd: null, stdout: (chunk: string) => void, stderr: null): Promise<{ status: number }> };
};

export class IinaHost {
  private ownedPrimary: boolean | null = null;
  private ownedSecondary: boolean | null = null;
  private overlayClickable: boolean | null = null;
  constructor(readonly raw: RawIina, private readonly pluginId: string) {}

  get mediaUrl(): string { return this.raw.core.status.url || ''; }
  get sourceId(): number | null { return this.raw.core.subtitle.id; }
  get secondaryId(): number | null { return this.raw.core.subtitle.secondID; }
  get positionMs(): number { return (this.raw.core.status.position || 0) * 1000; }
  get paused(): boolean { return this.raw.core.status.paused; }
  get delayMs(): number { return (this.raw.mpv.getNumber('sub-delay') || 0) * 1000; }
  get secondaryDelayMs(): number { return (this.raw.mpv.getNumber('secondary-sub-delay') || 0) * 1000; }
  get subtitleSpeed(): number { return this.raw.mpv.getNumber('sub-speed') || 1; }
  get displayedSource(): string { return this.raw.mpv.getString('sub-text') || ''; }
  get displayedStartMs(): number { return this.raw.mpv.getNumber('sub-start') * 1000; }
  get secondaryText(): string { return this.raw.mpv.getString('secondary-sub-text') || ''; }
  get subtitleTracks(): SubtitleTrack[] { return this.raw.core.subtitle.tracks; }
  get windowVisible(): boolean { return this.raw.core.window.visible; }
  get playable(): boolean {
    const status = this.raw.core.status;
    return !status.idle && (status.duration === null || !Number.isFinite(status.duration) ||
      status.position < status.duration - 0.1);
  }

  externalTrack(id: number | null): SubtitleTrack | null {
    return id === null ? null : this.raw.core.subtitle.tracks.find(track => track.id === id && track.isExternal) ?? null;
  }

  readTrack(id: number): string {
    const text = this.raw.file.read(`@sub/${id}`, {});
    if (typeof text !== 'string') throw new Error('Selected external subtitle file is unreadable');
    return text;
  }

  chooseSubtitleFile(): Promise<string> {
    return this.raw.utils.chooseFile('Add SRT or VTT subtitles', { allowedFileTypes: ['srt', 'vtt'] });
  }

  loadSubtitleFile(path: string): void { this.raw.core.subtitle.loadTrack(path); }
  selectSource(id: number): void { this.raw.core.subtitle.id = id; }
  selectSecondary(id: number): void { this.raw.core.subtitle.secondID = id; }

  ownPrimary(): void {
    if (this.ownedPrimary !== null) return;
    this.ownedPrimary = !!this.raw.mpv.getFlag('sub-visibility');
    this.raw.mpv.set('sub-visibility', false);
  }

  restorePrimary(): void {
    if (this.ownedPrimary === null) return;
    if (this.raw.mpv.getFlag('sub-visibility') === false) this.raw.mpv.set('sub-visibility', this.ownedPrimary);
    this.ownedPrimary = null;
  }

  ownSecondary(): void {
    if (this.ownedSecondary !== null) return;
    this.ownedSecondary = !!this.raw.mpv.getFlag('secondary-sub-visibility');
    this.raw.mpv.set('secondary-sub-visibility', false);
  }

  restoreSecondary(): void {
    if (this.ownedSecondary === null) return;
    if (this.raw.mpv.getFlag('secondary-sub-visibility') === false)
      this.raw.mpv.set('secondary-sub-visibility', this.ownedSecondary);
    this.ownedSecondary = null;
  }

  pause(): void { this.raw.core.pause(); }
  resume(): void { this.raw.core.resume(); }
  seekTo(positionMs: number): void { this.raw.core.seekTo(positionMs / 1000); }
  showOverlay(): void { this.setOverlayClickable(false); this.raw.overlay.show(); }
  setOverlayClickable(clickable: boolean): void {
    if (this.overlayClickable === clickable) return;
    this.raw.overlay.setClickable(clickable);
    this.overlayClickable = clickable;
  }
  hideOverlay(): void { this.setOverlayClickable(false); this.raw.overlay.hide(); }
  showSidebar(): void { this.raw.sidebar.show(); }
  hideSidebar(): void { this.raw.sidebar.hide(); }

  toOverlay(name: string, data: unknown): void { this.raw.overlay.postMessage(name, encodeURIComponent(JSON.stringify(data))); }
  toSidebar(name: string, data: unknown): void { this.raw.sidebar.postMessage(name, encodeURIComponent(JSON.stringify(data))); }

  helperPath(): string {
    const data = this.raw.utils.resolvePath('@data/.');
    const parent = data.replace(/\/\.data\/[^/]+\/?$/, '');
    if (parent === data) throw new Error('Could not locate plugin package');
    for (const suffix of ['iinaplugin-dev', 'iinaplugin']) {
      const path = `${parent}/${this.pluginId}.${suffix}/native/stream-helper`;
      if (this.raw.file.exists(path)) return path;
    }
    throw new Error('Packaged streaming helper is unavailable');
  }

  requestDirectory(id: number): string {
    const root = this.raw.utils.resolvePath('@tmp/.');
    return `${root}/request-${Date.now().toString(36)}-${id}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
