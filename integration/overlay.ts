declare const iina: {
  onMessage(name: string, callback: (data: string) => void): void;
  postMessage(name: string, data: unknown): void;
};

const cue = document.querySelector<HTMLDivElement>("#cue")!;
const explain = document.querySelector<HTMLButtonElement>("#explain")!;
const clear = document.querySelector<HTMLButtonElement>("#clear")!;
let shownCue = "";
let pendingCue = "";
let selection: { text: string; start: number; end: number; cue: string } | null = null;

function showCue(text: string): void {
  shownCue = text;
  cue.textContent = text;
}

function clearSelection(): void {
  selection = null;
  explain.hidden = true;
  clear.hidden = true;
  window.getSelection()?.removeAllRanges();
  if (pendingCue !== shownCue) showCue(pendingCue);
  iina.postMessage("selectionCleared", {});
}

function captureSelection(): void {
  const selected = window.getSelection();
  if (!selected || selected.isCollapsed || selected.rangeCount !== 1) return;
  const range = selected.getRangeAt(0);
  if (range.startContainer !== cue.firstChild || range.endContainer !== cue.firstChild) return;
  const text = selected.toString();
  if (!text.trim() || text.length > 4000) return;
  selection = { text, start: range.startOffset, end: range.endOffset, cue: shownCue };
  explain.hidden = false;
  clear.hidden = false;
  iina.postMessage("selected", { start: range.startOffset, end: range.endOffset, length: text.length });
}

cue.addEventListener("mouseup", () => setTimeout(captureSelection, 0));
cue.addEventListener("dblclick", () => setTimeout(captureSelection, 0));
explain.addEventListener("click", () => {
  if (!selection) return;
  iina.postMessage("explain", selection);
});
clear.addEventListener("click", clearSelection);
iina.onMessage("cue", data => {
  try {
    pendingCue = decodeURIComponent(data);
    if (!selection) showCue(pendingCue);
  } catch { /* discard malformed host message */ }
});
iina.onMessage("clear", clearSelection);
iina.postMessage("overlayReady", {});
