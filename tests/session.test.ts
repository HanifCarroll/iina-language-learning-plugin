import { test, expect } from 'bun:test';
import { Session } from '../src/main';
import { IinaHost, type RawIina } from '../src/iina-host';

const source = '1\n00:00:00,000 --> 00:00:02,000\nBen öyle bir insan mıyım?\n\n2\n00:00:04,000 --> 00:00:06,000\nNext cue';
const secondary = '1\n00:00:00,000 --> 00:00:03,000\nAm I that kind of person?';

function fakePlayer() {
  const events = new Map<string, () => void>();
  const overlay = new Map<string, (value: unknown) => void>();
  const sidebar = new Map<string, (value: unknown) => void>();
  const frames: Array<(value: string) => void> = [];
  const writes: string[] = [];
  const states: any[] = [];
  const overlayMessages: string[] = [];
  const actions: string[] = [];
  const props = new Map<string, any>([['sub-visibility', true], ['sub-text', 'Ben öyle bir insan mıyım?'],
    ['sub-start', 0], ['sub-delay', 0], ['secondary-sub-delay', 0], ['sub-speed', 1]]);
  const status = { url: 'file:///synthetic.mp4', position: 1, duration: 20, idle: false };
  const settings = { endpoint: 'http://127.0.0.1:47891', model: 'synthetic', sourceLanguage: 'Turkish',
    explanationLanguage: 'English', includeSecondary: true, noKeyRequired: true };
  const raw = {
    core: { status, window: { visible: true }, subtitle: { id: 1, secondID: 2,
      tracks: [{ id: 1, isExternal: true, title: 'source', codec: 'subrip' },
        { id: 2, isExternal: true, title: 'secondary', codec: 'subrip' }] },
      pause: () => actions.push('pause'), resume: () => actions.push('resume') },
    event: { on: (name: string, callback: () => void) => { events.set(name, callback); return name; },
      off: (name: string, id: string) => { if (name !== id) throw new Error('Wrong listener identifier'); events.delete(name); } },
    file: { read: (path: string) => path === '@sub/1' ? source : secondary,
      exists: () => true,
      handle: (path: string) => ({ write: (value: string) => writes.push(`${path}:${value}`), close: () => {} }) },
    mpv: { getString: (name: string) => props.get(name) ?? '', getNumber: (name: string) => props.get(name) ?? 0,
      getFlag: (name: string) => props.get(name) ?? false, set: (name: string, value: unknown) => { props.set(name, value); } },
    overlay: { simpleMode: () => {}, loadFile: () => { overlay.clear(); }, onMessage: (name: string, callback: (value: unknown) => void) => { overlay.set(name, callback); },
      postMessage: (name: string) => overlayMessages.push(name), show: () => actions.push('overlay show'), hide: () => actions.push('overlay hide'), setClickable: () => {} },
    sidebar: { loadFile: () => { sidebar.clear(); }, onMessage: (name: string, callback: (value: unknown) => void) => { sidebar.set(name, callback); },
      postMessage: (_name: string, encoded: string) => { states.push(JSON.parse(decodeURIComponent(encoded))); },
      show: () => actions.push('sidebar show'), hide: () => actions.push('sidebar hide') },
    preferences: { get: () => settings, set: () => {}, sync: () => {} },
    utils: { keychainRead: () => false, keychainWrite: () => true,
      resolvePath: (path: string) => path.startsWith('@data') ? '/tmp/plugins/.data/id' : '/tmp/private',
      exec: (_path: string, _args: string[], _cwd: null, hook: (value: string) => void) => {
        frames.push(hook); return new Promise<{ status: number }>(() => {});
      } }
  } as unknown as RawIina;
  const session = new Session(new IinaHost(raw, 'io.github.hanifcarroll.iina-language-learning'));
  session.start();
  events.get('iina.window-loaded')!();
  events.get('iina.plugin-overlay-loaded')!();
  overlay.get('overlayReady')!({});
  sidebar.get('sidebarReady')!({});
  return { session, raw, status, props, events, overlay, sidebar, frames, writes, states, actions, overlayMessages,
    tick: () => (session as any).tick(), close: () => events.get('iina.window-will-close')?.() };
}

function select(player: ReturnType<typeof fakePlayer>) {
  const pending = { cue: { trackId: 1, index: 0, text: 'Ben öyle bir insan mıyım?' }, start: 4, end: 8, text: 'öyle' };
  player.overlay.get('selected')!(pending);
  return pending;
}

test('cue advancement keeps selection, seek clears it, conversation survives seek', () => {
  const player = fakePlayer();
  const pending = select(player);
  player.status.position = 5;
  player.props.set('sub-text', 'Next cue');
  player.props.set('sub-start', 4);
  player.tick();
  player.overlay.get('explain')!(pending);
  expect(player.actions).toContain('pause');
  expect(player.overlayMessages.at(-1)).toBe('clear');
  expect(player.states.at(-1).cue).toBe('Ben öyle bir insan mıyım?');
  player.events.get('mpv.seek')!();
  expect(player.states.at(-1).cue).toBe('Ben öyle bir insan mıyım?');
  player.close();

  const seeking = fakePlayer();
  const prior = select(seeking);
  seeking.events.get('mpv.seek')!();
  seeking.overlay.get('explain')!(prior);
  expect(seeking.actions).not.toContain('pause');
  seeking.close();
});

test('Disable Overlay during a stream cancels, invalidates, resumes, and restores only this window', () => {
  const left = fakePlayer();
  const right = fakePlayer();
  left.overlay.get('explain')!(select(left));
  right.overlay.get('explain')!(select(right));
  left.frames[0]('READY\n'); left.tick();
  right.frames[0]('READY\n'); right.tick();
  left.frames[0]('DELTA UGFydA==\n'); left.tick();
  expect(left.states.at(-1).turns[0].answer).toBe('Part');
  left.sidebar.get('disableOverlay')!({});
  expect(left.writes.some(value => value.endsWith('/control:STOP\n'))).toBe(true);
  expect(left.actions).toContain('resume');
  expect(left.props.get('sub-visibility')).toBe(true);
  expect(right.props.get('sub-visibility')).toBe(false);
  expect(right.actions).not.toContain('resume');
  left.frames[0]('DELTA bGF0ZQ==\nDONE\n'); left.tick();
  expect(left.states.at(-1).open).toBe(false);
  expect(left.states.at(-1).overlayEnabled).toBe(false);
  left.close(); right.close();
});

test('media replacement rejects old stream results and never resumes the new media', () => {
  const player = fakePlayer();
  player.overlay.get('explain')!(select(player));
  player.frames[0]('READY\n'); player.tick();
  player.status.url = 'file:///replacement.mp4';
  player.events.get('mpv.file-loaded')!();
  player.frames[0]('DELTA U1RBTEU=\nDONE\n'); player.tick();
  expect(player.states.at(-1).open).toBe(false);
  player.sidebar.get('close')!({});
  expect(player.actions).not.toContain('resume');
  expect(player.writes.some(value => value.endsWith('/control:STOP\n'))).toBe(true);
  player.close();
});

test('settings dismissal does not resume, while native conversation dismissal does', () => {
  const player = fakePlayer();
  player.overlay.get('explain')!(select(player));
  player.sidebar.get('settingsView')!({ open: true });
  player.sidebar.get('visibility')!({ hidden: true });
  expect(player.states.at(-1).open).toBe(true);
  expect(player.actions).not.toContain('resume');
  player.sidebar.get('settingsView')!({ open: false });
  player.sidebar.get('visibility')!({ hidden: true });
  expect(player.states.at(-1).open).toBe(false);
  expect(player.actions).toContain('resume');
  player.close();
});

test('window teardown cancels an active request and restores native primary visibility', () => {
  const player = fakePlayer();
  player.overlay.get('explain')!(select(player));
  player.frames[0]('READY\n'); player.tick();
  player.close();
  expect(player.writes.some(value => value.endsWith('/control:STOP\n'))).toBe(true);
  expect(player.props.get('sub-visibility')).toBe(true);
  expect(player.actions).not.toContain('resume');
  expect(player.events.size).toBe(0);
});

test('late Stop cannot relabel a completed answer', () => {
  const player = fakePlayer();
  player.overlay.get('explain')!(select(player));
  player.frames[0]('READY\n'); player.tick();
  player.frames[0]('DELTA SGVsbG8=\nDONE\n'); player.tick();
  player.sidebar.get('stop')!({});
  expect(player.states.at(-1).turns[0].status).toBe('complete');
  expect(player.states.at(-1).status).toBe('Complete');
  player.close();
});

test('subtitle mismatch restores native source and a later match reclaims it', () => {
  const player = fakePlayer();
  player.props.set('sub-text', 'Different source');
  player.tick();
  expect(player.props.get('sub-visibility')).toBe(true);
  expect(player.states.at(-1).status).toContain('does not match');
  player.props.set('sub-text', 'Ben öyle bir insan mıyım?');
  player.tick();
  expect(player.props.get('sub-visibility')).toBe(false);
  expect(player.states.at(-1).status).toBe('Select a subtitle phrase to begin.');
  player.close();
});

test('request contains frozen neighboring and secondary context, with no key on keyless endpoint', () => {
  const player = fakePlayer();
  player.overlay.get('explain')!(select(player));
  player.frames[0]('READY\n'); player.tick();
  const request = player.writes.find(value => value.includes('/request:'))!;
  const payload = JSON.parse(request.slice(request.indexOf('/request:') + 9));
  expect(payload.key).toBeNull();
  expect(payload.url).toBe('http://127.0.0.1:47891/chat/completions');
  const prompt = JSON.parse(payload.body.messages[1].content);
  expect(prompt.selected).toBe('öyle');
  expect(prompt.after).toEqual(['Next cue']);
  expect(prompt.secondary).toEqual(['Am I that kind of person?']);
  player.close();
});

test('forged or stale bridge selections never pause or start a request', () => {
  const player = fakePlayer();
  const forged = { cue: { trackId: 1, index: 0, text: 'Different cue' }, start: 0, end: 4, text: 'Diff' };
  player.overlay.get('selected')!(forged);
  player.overlay.get('explain')!(forged);
  player.sidebar.get('followUp')!({ question: 'Send anyway' });
  expect(player.actions).not.toContain('pause');
  expect(player.frames).toHaveLength(0);
  player.close();
});

test('new Explain invalidates the prior request and keeps its own selected phrase', () => {
  const player = fakePlayer();
  player.overlay.get('explain')!(select(player));
  player.frames[0]('READY\n'); player.tick();
  const next = { cue: { trackId: 1, index: 1, text: 'Next cue' }, start: 0, end: 4, text: 'Next' };
  player.overlay.get('selected')!(next);
  player.overlay.get('explain')!(next);
  player.frames[0]('DELTA U1RBTEU=\nDONE\n'); player.tick();
  expect(player.states.at(-1).phrase).toBe('Next');
  expect(player.states.at(-1).turns[0].answer).toBe('');
  expect(player.writes.some(value => value.endsWith('/control:STOP\n'))).toBe(true);
  player.close();
});
