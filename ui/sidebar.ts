type Bridge = { onMessage(name: string, callback: (data: string) => void): void; postMessage(name: string, data: unknown): void };
declare const iina: Bridge;
type ViewState = {
  status: string; open: boolean; overlayEnabled: boolean; phrase: string; cue: string;
  turns: Array<{ question: string; answer: string; status: string; error?: string }>;
  settings: { endpoint: string; model: string; sourceLanguage: string; explanationLanguage: string;
    includeSecondary: boolean; noKeyRequired: boolean; hasSavedKey: boolean; requestUrl: string };
};

export function mountSidebar(doc: Document, bridge: Bridge): void {
  const element = <T extends HTMLElement>(id: string): T => doc.getElementById(id) as T;
  const question = element<HTMLTextAreaElement>('question');
  let state: ViewState | null = null;
  let settingsOpen = false;

  function render(): void {
    if (!state) return;
    element('status').textContent = state.status;
    element('disableOverlay').textContent = state.overlayEnabled ? 'Disable Overlay' : 'Enable Overlay';
    element('conversation').hidden = !state.open || settingsOpen;
    element('settings').hidden = !settingsOpen;
    element('phrase').textContent = state.phrase;
    element('sourceCue').textContent = state.cue;
    const turns = element('turns');
    turns.replaceChildren();
    for (const turn of state.turns) {
      const card = doc.createElement('div'); card.className = 'turn';
      const title = doc.createElement('h3'); title.textContent = turn.question || 'Explanation';
      const answer = doc.createElement('p'); answer.textContent = turn.answer;
      const status = doc.createElement('small'); status.textContent = turn.error ? `${turn.status}: ${turn.error}` : turn.status;
      card.append(title, answer, status); turns.append(card);
    }
    const busy = state.turns.at(-1)?.status === 'streaming';
    element<HTMLButtonElement>('send').disabled = !!busy;
    element('stop').hidden = !busy;
    element('retry').hidden = !['failed', 'incomplete'].includes(state.turns.at(-1)?.status ?? '');
    if (!settingsOpen) return;
    for (const key of ['endpoint', 'model', 'sourceLanguage', 'explanationLanguage'] as const) {
      const input = element<HTMLInputElement>(key);
      if (doc.activeElement !== input) input.value = state.settings[key];
    }
    element<HTMLInputElement>('includeSecondary').checked = state.settings.includeSecondary;
    element<HTMLInputElement>('noKeyRequired').checked = state.settings.noKeyRequired;
    element('keyStatus').textContent = state.settings.hasSavedKey ? 'A key is saved for this endpoint.' : 'No key is saved for this endpoint.';
    element('requestUrl').textContent = state.settings.requestUrl ? `Requests go to ${state.settings.requestUrl}` : '';
  }

  function sendQuestion(): void {
    const value = question.value.trim();
    if (!value) return;
    bridge.postMessage('followUp', { question: value });
    question.value = '';
  }

  element('settingsToggle').addEventListener('click', () => { settingsOpen = true; bridge.postMessage('settingsView', { open: true }); render(); });
  element('back').addEventListener('click', () => { settingsOpen = false; bridge.postMessage('settingsView', { open: false }); render(); });
  element('send').addEventListener('click', sendQuestion);
  element('stop').addEventListener('click', () => bridge.postMessage('stop', {}));
  element('retry').addEventListener('click', () => bridge.postMessage('retry', {}));
  element('close').addEventListener('click', () => bridge.postMessage('close', {}));
  element('disableOverlay').addEventListener('click', () => bridge.postMessage(state?.overlayEnabled ? 'disableOverlay' : 'enableOverlay', {}));
  element('saveSettings').addEventListener('click', () => {
    const keyInput = element<HTMLInputElement>('apiKey');
    const payload = {
      endpoint: element<HTMLInputElement>('endpoint').value,
      model: element<HTMLInputElement>('model').value,
      sourceLanguage: element<HTMLInputElement>('sourceLanguage').value,
      explanationLanguage: element<HTMLInputElement>('explanationLanguage').value,
      includeSecondary: element<HTMLInputElement>('includeSecondary').checked,
      noKeyRequired: element<HTMLInputElement>('noKeyRequired').checked,
      key: keyInput.value
    };
    keyInput.value = '';
    bridge.postMessage('saveSettings', payload);
  });
  question.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendQuestion(); }
  });
  question.addEventListener('keyup', event => event.stopPropagation());
  bridge.onMessage('state', encoded => {
    try {
      const next: unknown = JSON.parse(decodeURIComponent(encoded));
      if (!next || typeof next !== 'object') return;
      state = next as ViewState;
      render();
    } catch { /* discard malformed host message */ }
  });
  bridge.onMessage('showConversation', () => { settingsOpen = false; render(); });
  doc.addEventListener('visibilitychange', () => bridge.postMessage('visibility', { hidden: doc.hidden }));
  bridge.postMessage('sidebarReady', {});
}

if (typeof document !== 'undefined' && typeof iina !== 'undefined') mountSidebar(document, iina);
