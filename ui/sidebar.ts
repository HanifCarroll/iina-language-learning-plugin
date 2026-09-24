import MarkdownIt from 'markdown-it/browser';

type Bridge = { onMessage(name: string, callback: (data: string) => void): void; postMessage(name: string, data: unknown): void };
declare const iina: Bridge;
type ViewState = {
  status: string; open: boolean; conversationId: number | null; overlayEnabled: boolean;
  replaying: boolean; replayAvailable: boolean; phrase: string; cue: string;
  mediaEpoch: number; hasMedia: boolean; sourceId: number | null; secondaryId: number | null;
  subtitleTracks: Array<{ id: number; title: string; isExternal: boolean }>;
  turns: Array<{ question: string; answer: string; status: string; error?: string }>;
  settings: { endpoint: string; model: string; sourceLanguage: string; explanationLanguage: string;
    includeSecondary: boolean; noKeyRequired: boolean; secondaryBelowSource: boolean;
    hasSavedKey: boolean; requestUrl: string;
    appearance: { sourceSize: number; sourceColor: string; sourceBottom: number;
      translationSize: number; translationColor: string; translationGap: number } };
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
  let view: 'chat' | 'subtitles' | 'ai' = 'chat';
  let appearanceDraftActive = false;
  let renderedConversationId: number | null = null;
  let renderedAnswers: string[] = [];
  let renderedTrackOptions = '';

  function resizeQuestion(): void {
    const turns = element('turns');
    const atBottom = turns.scrollHeight - turns.scrollTop - turns.clientHeight < 48;
    question.style.height = 'auto';
    question.style.height = `${Math.max(38, Math.min(question.scrollHeight, 68))}px`;
    if (atBottom) turns.scrollTop = turns.scrollHeight;
  }

  function renderTrackChoices(): void {
    if (!state) return;
    const tracks = state.subtitleTracks ?? [];
    const signature = JSON.stringify(tracks);
    if (signature !== renderedTrackOptions) {
      for (const id of ['sourceTrack', 'secondaryTrack']) {
        const select = element<HTMLSelectElement>(id);
        const off = doc.createElement('option');
        off.value = '0';
        off.textContent = 'Off';
        select.replaceChildren(off);
        for (const track of tracks) {
          const option = doc.createElement('option');
          option.value = String(track.id);
          option.textContent = track.isExternal ? track.title : `${track.title} (IINA only)`;
          select.append(option);
        }
      }
      renderedTrackOptions = signature;
    }
    element<HTMLSelectElement>('sourceTrack').value = String(state.sourceId ?? 0);
    element<HTMLSelectElement>('secondaryTrack').value = String(state.secondaryId ?? 0);
    element<HTMLSelectElement>('sourceTrack').disabled = !state.hasMedia;
    element<HTMLSelectElement>('secondaryTrack').disabled = !state.hasMedia;
    element<HTMLButtonElement>('addSubtitleFile').disabled = !state.hasMedia;
  }

  function setView(next: typeof view): void {
    if (view === next) return;
    view = next;
    appearanceDraftActive = false;
    bridge.postMessage('settingsView', { open: next !== 'chat', view: next });
    render();
    appearanceDraftActive = next === 'subtitles';
  }

  function render(): void {
    if (!state) return;
    const busy = state.turns.at(-1)?.status === 'streaming';
    const status = element('status');
    status.textContent = state.status;
    const routineStatus = ['Complete', 'Generating…', 'Preparing explanation…'];
    status.hidden = routineStatus.includes(state.status) ||
      (view !== 'chat' && state.status === 'Select a subtitle phrase to begin.');
    element<HTMLInputElement>('overlayEnabled').checked = state.overlayEnabled;
    for (const [tab, name] of [['chatTab', 'chat'], ['subtitlesTab', 'subtitles'], ['aiTab', 'ai']] as const) {
      if (view === name) element(tab).setAttribute('aria-current', 'page');
      else element(tab).removeAttribute('aria-current');
    }
    element('chatView').hidden = view !== 'chat';
    element('subtitlesView').hidden = view !== 'subtitles';
    element('aiView').hidden = view !== 'ai';
    element('conversation').hidden = !state.open;
    renderTrackChoices();
    const sourceId = state.sourceId;
    const secondaryId = state.secondaryId;
    const sourceTrack = state.subtitleTracks?.find(track => track.id === sourceId);
    const secondaryTrack = state.subtitleTracks?.find(track => track.id === secondaryId);
    const top = state.settings.secondaryBelowSource ? sourceTrack : secondaryTrack;
    const bottom = state.settings.secondaryBelowSource ? secondaryTrack : sourceTrack;
    element('subtitleOrder').textContent = `Top: ${top?.title ?? '—'} · Bottom: ${bottom?.title ?? '—'}`;
    element<HTMLButtonElement>('swapSubtitleOrder').disabled = !state.hasMedia || !sourceTrack || !secondaryTrack;
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
    const replay = element<HTMLButtonElement>('replay');
    replay.hidden = !state.replayAvailable;
    replay.textContent = state.replaying ? 'Stop replay' : 'Replay line';
    if (element('sourceCue').textContent !== state.cue) element('sourceCue').textContent = state.cue;
    element('fullCue').hidden = state.phrase.trim() === state.cue.trim();
    const turns = element('turns');
    const newTurn = !conversationChanged && turns.childElementCount > 0 && state.turns.length > turns.childElementCount;
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
        const answer = doc.createElement('div'); answer.className = 'answer';
        const turnStatus = doc.createElement('small'); turnStatus.className = 'turn-status';
        assistant.append(answer, turnStatus); card.append(assistant); turns.append(card);
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
    if (newTurn) turns.scrollTop = turns.scrollHeight;
    element<HTMLButtonElement>('send').disabled = !!busy;
    element('stop').hidden = !busy;
    element('retry').hidden = !['failed', 'incomplete'].includes(state.turns.at(-1)?.status ?? '');
    if (view === 'chat') return;
    for (const key of ['endpoint', 'model', 'sourceLanguage', 'explanationLanguage'] as const) {
      const input = element<HTMLInputElement>(key);
      if (doc.activeElement !== input) input.value = state.settings[key];
    }
    element<HTMLInputElement>('includeSecondary').checked = state.settings.includeSecondary;
    element<HTMLInputElement>('noKeyRequired').checked = state.settings.noKeyRequired;
    if (!appearanceDraftActive) {
      for (const key of ['sourceSize', 'sourceColor', 'sourceBottom', 'translationSize', 'translationColor', 'translationGap'] as const) {
        element<HTMLInputElement>(key).value = String(state.settings.appearance[key]);
      }
    }
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

  function readAppearance(): ViewState['settings']['appearance'] {
    return {
      sourceSize: Number(element<HTMLInputElement>('sourceSize').value),
      sourceColor: element<HTMLInputElement>('sourceColor').value,
      sourceBottom: Number(element<HTMLInputElement>('sourceBottom').value),
      translationSize: Number(element<HTMLInputElement>('translationSize').value),
      translationColor: element<HTMLInputElement>('translationColor').value,
      translationGap: Number(element<HTMLInputElement>('translationGap').value)
    };
  }

  element('chatTab').addEventListener('click', () => setView('chat'));
  element('subtitlesTab').addEventListener('click', () => setView('subtitles'));
  element('aiTab').addEventListener('click', () => setView('ai'));
  element('addSubtitleFile').addEventListener('click', () => bridge.postMessage('addSubtitleFile', {}));
  element('swapSubtitleOrder').addEventListener('click', () => bridge.postMessage('swapSubtitleOrder', {}));
  for (const [id, role] of [['sourceTrack', 'source'], ['secondaryTrack', 'secondary']] as const) {
    element<HTMLSelectElement>(id).addEventListener('change', () => bridge.postMessage('selectSubtitleTrack', {
      role, id: Number(element<HTMLSelectElement>(id).value), epoch: state?.mediaEpoch
    }));
  }
  element('send').addEventListener('click', sendQuestion);
  element('stop').addEventListener('click', () => bridge.postMessage('stop', {}));
  element('retry').addEventListener('click', () => bridge.postMessage('retry', {}));
  element('replay').addEventListener('click', () => bridge.postMessage('replayCue', {}));
  element('close').addEventListener('click', () => bridge.postMessage('close', {}));
  element<HTMLInputElement>('overlayEnabled').addEventListener('change', () => {
    const enabled = element<HTMLInputElement>('overlayEnabled').checked;
    bridge.postMessage(enabled ? 'enableOverlay' : 'disableOverlay', {});
  });
  element('saveAppearance').addEventListener('click', () => bridge.postMessage('saveAppearance', readAppearance()));
  for (const key of ['sourceSize', 'sourceColor', 'sourceBottom', 'translationSize', 'translationColor', 'translationGap']) {
    element(key).addEventListener('input', () => bridge.postMessage('previewAppearance', readAppearance()));
  }
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
  bridge.onMessage('showConversation', () => { view = 'chat'; appearanceDraftActive = false; render(); });
  bridge.onMessage('appearancePreviewEnded', () => {
    appearanceDraftActive = false;
    render();
    appearanceDraftActive = view === 'subtitles';
  });
  doc.addEventListener('visibilitychange', () => bridge.postMessage('visibility', { hidden: doc.hidden }));
  bridge.postMessage('sidebarReady', {});
  bridge.postMessage('visibility', { hidden: doc.hidden });
}

if (typeof document !== 'undefined' && typeof iina !== 'undefined') mountSidebar(document, iina);
