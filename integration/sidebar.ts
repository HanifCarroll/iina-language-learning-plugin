declare const iina: {
  onMessage(name: string, callback: (data: string) => void): void;
  postMessage(name: string, data: unknown): void;
};

const statusEl = document.querySelector<HTMLElement>("#status")!;
const selected = document.querySelector<HTMLElement>("#selection")!;
const answer = document.querySelector<HTMLElement>("#answer")!;
const lifecycle = document.querySelector<HTMLElement>("#lifecycle")!;
const mode = document.querySelector<HTMLSelectElement>("#mode")!;

document.querySelector("#start")!.addEventListener("click", () => {
  answer.textContent = "";
  iina.postMessage("start", { mode: mode.value });
});
document.querySelector("#stop")!.addEventListener("click", () => iina.postMessage("stop", {}));
document.querySelector("#close")!.addEventListener("click", () => iina.postMessage("close", {}));
document.querySelector("#disable")!.addEventListener("click", () => iina.postMessage("disableOverlay", {}));
document.querySelector("#next")!.addEventListener("click", () => iina.postMessage("nextCue", {}));

iina.onMessage("state", encoded => {
  try {
    const data = JSON.parse(decodeURIComponent(encoded));
    if (typeof data.status === "string") statusEl.textContent = data.status;
    if (typeof data.selection === "string") selected.textContent = data.selection;
    if (typeof data.lifecycle === "string") lifecycle.textContent = data.lifecycle;
    if (typeof data.delta === "string") {
      const bytes = Uint8Array.from(atob(data.delta), letter => letter.charCodeAt(0));
      answer.textContent += new TextDecoder().decode(bytes);
    }
  } catch { /* discard malformed host message */ }
});

document.addEventListener("visibilitychange", () => {
  iina.postMessage("visibility", { hidden: document.hidden });
});
iina.postMessage("sidebarReady", {});
