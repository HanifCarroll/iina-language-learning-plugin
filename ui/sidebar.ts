import MarkdownIt from 'markdown-it/browser';

type Bridge = { onMessage(name: string, callback: (data: string) => void): void; postMessage(name: string, data: unknown): void };
declare const iina: Bridge;
type ViewState = {
  status: string; open: boolean; conversationId: number | null; overlayEnabled: boolean; phrase: string; cue: string;
  turns: Array<{ question: string; answer: string; status: string; error?: string }>;
  settings: { endpoint: string; model: string; sourceLanguage: string; explanationLanguage: string;
    includeSecondary: boolean; noKeyRequired: boolean; hasSavedKey: boolean; requestUrl: string };
};

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
// Provider text may format explanations, but it cannot create links or load images.
markdown.renderer.rules.link_open = () => '';
markdown.renderer.rules.link_close = () => '';
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

export function mountSidebar(doc: Document, bridge: Bridge): void {
  const element = <T extends HTMLElement>(id: string): T => doc.getElementById(id) as T;
  const question = element<HTMLTextAreaElement>('question');
  let state: ViewState | null = null;
  let settingsOpen = false;
  let renderedConversationId: number | null = null;
  let renderedAnswers: string[] = [];

  function resizeQuestion(): void {
    const turns = element('turns');
    const atBottom = turns.scrollHeight - turns.scrollTop - turns.clientHeight < 48;
    question.style.height = 'auto';
    question.style.height = `${Math.max(38, Math.min(question.scrollHeight, 68))}px`;
    if (atBottom) turns.scrollTop = turns.scrollHeight;
  }

  function render(): void {
    if (!state) return;
    const busy = state.turns.at(-1)?.status === 'streaming';
    const status = element('status');
    status.textContent = state.status;
    status.hidden = state.open && ['Complete', 'Generating…', 'Preparing explanation…'].includes(state.status);
    element('disableOverlay').textContent = state.overlayEnabled ? 'Disable Overlay' : 'Enable Overlay';
    element('settingsToggle').hidden = settingsOpen;
    element('conversation').hidden = !state.open || settingsOpen;
    element('settings').hidden = !settingsOpen;
    const conversationChanged = renderedConversationId !== state.conversationId;
    if (conversationChanged) {
      renderedConversationId = state.conversationId;
      renderedAnswers = [];
      element('turns').replaceChildren();
      question.value = '';
      resizeQuestion();
      element<HTMLDetailsElement>('fullCue').open = false;
    }
    if (element('phrase').textContent !== state.phrase) element('phrase').textContent = state.phrase;
    if (element('sourceCue').textContent !== state.cue) element('sourceCue').textContent = state.cue;
    element('fullCue').hidden = state.phrase.trim() === state.cue.trim();
    const turns = element('turns');
    const newTurn = !conversationChanged && turns.childElementCount > 0 && state.turns.length > turns.childElementCount;
    const stickToBottom = newTurn || (turns.childElementCount > 0 && turns.scrollHeight - turns.scrollTop - turns.clientHeight < 48);
    state.turns.forEach((turn, index) => {
      let card = turns.children[index] as HTMLElement | undefined;
      if (!card) {
        card = doc.createElement('article'); card.className = 'turn';
        if (turn.question) {
          const user = doc.createElement('div'); user.className = 'user-message';
          const label = doc.createElement('span'); label.className = 'message-label'; label.textContent = 'You';
          const text = doc.createElement('p'); text.textContent = turn.question;
          user.append(label, text); card.append(user);
        }
        const assistant = doc.createElement('div'); assistant.className = 'assistant-message';
        const label = doc.createElement('span'); label.className = 'message-label'; label.textContent = 'Explanation';
        const answer = doc.createElement('div'); answer.className = 'answer';
        const turnStatus = doc.createElement('small'); turnStatus.className = 'turn-status';
        assistant.append(label, answer, turnStatus); card.append(assistant); turns.append(card);
      }
      const answer = card.querySelector<HTMLElement>('.answer')!;
      if (renderedAnswers[index] !== turn.answer) {
        answer.innerHTML = turn.answer ? markdown.render(turn.answer) : '<p class="placeholder">Waiting for response…</p>';
        renderedAnswers[index] = turn.answer;
      }
      const turnStatus = card.querySelector<HTMLElement>('.turn-status')!;
      turnStatus.textContent = turn.error ? `${turn.status}: ${turn.error}` : turn.status === 'streaming' ? 'Generating…' : turn.status === 'complete' ? '' : turn.status;
      turnStatus.hidden = turn.status === 'complete';
    });
    while (turns.children.length > state.turns.length) {
      turns.lastElementChild?.remove();
      renderedAnswers.pop();
    }
    if (stickToBottom) turns.scrollTop = turns.scrollHeight;
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
    if (!value || !state?.open || state.turns.at(-1)?.status === 'streaming') return;
    bridge.postMessage('followUp', { question: value });
    question.value = '';
    resizeQuestion();
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
  question.addEventListener('input', resizeQuestion);
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
