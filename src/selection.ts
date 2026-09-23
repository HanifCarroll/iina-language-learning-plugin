export type DisplayCue = { trackId: number; index: number; text: string };
export type PendingSelection = { cue: DisplayCue; start: number; end: number; text: string };

export class SelectionState {
  current: DisplayCue | null = null;
  displayed: DisplayCue | null = null;
  pending: PendingSelection | null = null;
  dragging = false;

  cueChanged(cue: DisplayCue | null): void {
    this.current = cue;
    if (!this.dragging && !this.pending) this.displayed = cue;
  }

  beginDrag(): void {
    if (this.displayed) this.dragging = true;
  }

  finishDrag(start: number, end: number): PendingSelection | null {
    this.dragging = false;
    const cue = this.displayed;
    if (cue && Number.isInteger(start) && Number.isInteger(end) &&
      start >= 0 && end > start && end <= cue.text.length) {
      const text = cue.text.slice(start, end);
      if (text.trim() && text.length <= 4_000) {
        this.pending = { cue, start, end, text };
        return this.pending;
      }
    }
    this.dismiss();
    return null;
  }

  dismiss(): void {
    this.dragging = false;
    this.pending = null;
    this.displayed = this.current;
  }

  seek(): void {
    this.dismiss();
  }
}
