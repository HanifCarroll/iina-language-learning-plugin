import { test, expect } from 'bun:test';
import { Session } from '../src/main';
import { IinaHost, type RawIina } from '../src/iina-host';

const source =
  '1\n00:00:00,000 --> 00:00:02,000\nBen öyle bir insan mıyım?\n\n2\n00:00:04,000 --> 00:00:06,000\nNext cue';
const secondary = '1\n00:00:00,000 --> 00:00:03,000\nAm I that kind of person?';

function fakePlayer(alreadyLoaded = false) {
  // 1. Create isolated event, message, and request records for this player.
  const events = new Map<string, () => void>();
  const overlay = new Map<string, (value: unknown) => void>();
  const sidebar = new Map<string, (value: unknown) => void>();
  const frames: Array<(value: string) => void> = [];
  const writes: string[] = [];
  const states: any[] = [];
  const overlayMessages: string[] = [];
  const overlayPayloads: Array<{
    name: string;
    value: unknown;
  }> = [];
  const actions: string[] = [];
  let panelShortcut: (() => void) | null = null;
  type FakeMenuItem = {
    title: string;
    action?: (() => void) | null;
    options?: {
      selected?: boolean;
      enabled?: boolean;
      keyBinding?: string;
    };
    items: FakeMenuItem[];
    addSubMenuItem(item: FakeMenuItem): FakeMenuItem;
  };
  const menuItems: FakeMenuItem[] = [];
  let chosenFile = '/tmp/synthetic-english.srt';

  // 2. Seed synthetic playback, subtitles, and provider settings.
  const props = new Map<string, any>([
    ['sub-visibility', true],
    ['sub-text', 'Ben öyle bir insan mıyım?'],
    ['sub-start', 0],
    ['sub-delay', 0],
    ['secondary-sub-delay', 0],
    ['sub-speed', 1],
    ['secondary-sub-visibility', true],
    ['secondary-sub-text', 'Am I that kind of person?']
  ]);
  const status: {
    url: string;
    position: number;
    duration: number | null;
    idle: boolean;
    paused: boolean;
  } = {
    url: 'file:///synthetic.mp4',
    position: 1,
    duration: 20,
    idle: false,
    paused: false
  };
  const settings = {
    endpoint: 'http://127.0.0.1:47891',
    model: 'synthetic',
    sourceLanguage: 'Turkish',
    explanationLanguage: 'English',
    includeSecondary: true,
    noKeyRequired: true,
    appearance: {
      showTranslation: false,
      sourceSize: 28,
      sourceColor: '#ffffff',
      sourceBottom: 8,
      translationSize: 25,
      translationColor: '#ffffff',
      translationGap: 12
    }
  };

  // 3. Implement only the IINA calls exercised by the session.
  const raw = {
    core: {
      status,
      window: { loaded: alreadyLoaded, visible: true },
      subtitle: {
        id: 1,
        secondID: 2,
        tracks: [
          {
            id: 1,
            isExternal: true,
            title: 'source',
            codec: 'subrip'
          },
          {
            id: 2,
            isExternal: true,
            title: 'secondary',
            codec: 'subrip'
          }
        ],
        loadTrack: (_path: string) => {
          actions.push('load subtitle');
          raw.core.subtitle.tracks.push({
            id: 3,
            isExternal: true,
            title: 'English',
            codec: 'subrip'
          });
        }
      },
      pause: () => {
        status.paused = true;
        actions.push('pause');
      },
      resume: () => {
        status.paused = false;
        actions.push('resume');
      },
      seekTo: (seconds: number) => {
        status.position = seconds;
        actions.push(`seek ${seconds}`);
      }
    },
    event: {
      on: (name: string, callback: () => void) => {
        events.set(name, callback);

        return name;
      },
      off: (name: string, id: string) => {
        if (name !== id) {
          throw new Error('Wrong listener identifier');
        }

        events.delete(name);
      }
    },
    file: {
      read: (path: string) => (path === '@sub/1' ? source : secondary),
      exists: () => true,
      handle: (path: string) => ({
        write: (value: string) => writes.push(`${path}:${value}`),
        close: () => {}
      })
    },
    mpv: {
      getString: (name: string) => props.get(name) ?? '',
      getNumber: (name: string) => props.get(name) ?? 0,
      getFlag: (name: string) => props.get(name) ?? false,
      set: (name: string, value: unknown) => {
        props.set(name, value);
      }
    },
    overlay: {
      simpleMode: () => actions.push('simple mode'),
      loadFile: () => {
        overlay.clear();
      },
      onMessage: (name: string, callback: (value: unknown) => void) => {
        overlay.set(name, callback);
      },
      postMessage: (name: string, encoded: string) => {
        overlayMessages.push(name);
        overlayPayloads.push({ name, value: JSON.parse(decodeURIComponent(encoded)) });
      },
      show: () => actions.push('overlay show'),
      hide: () => actions.push('overlay hide'),
      setClickable: (value: boolean) => actions.push(`overlay clickable ${value}`)
    },
    sidebar: {
      loadFile: () => {
        sidebar.clear();
      },
      onMessage: (name: string, callback: (value: unknown) => void) => {
        sidebar.set(name, callback);
      },
      postMessage: (name: string, encoded: string) => {
        if (name === 'state') {
          states.push(JSON.parse(decodeURIComponent(encoded)));
        }
      },
      show: () => actions.push('sidebar show'),
      hide: () => actions.push('sidebar hide')
    },
    menu: {
      item: (
        title: string,
        action?: (() => void) | null,
        options?: FakeMenuItem['options']
      ): FakeMenuItem => {
        if (options?.keyBinding) {
          expect(options.keyBinding).toBe('Alt+Meta+g');

          panelShortcut = action ?? null;
        }

        return {
          title,
          action,
          options,
          items: [],
          addSubMenuItem(item) {
            this.items.push(item);

            return this;
          }
        };
      },
      addItem: (item: FakeMenuItem) => menuItems.push(item),
      removeAllItems: () => {
        menuItems.length = 0;
      }
    },
    preferences: {
      get: () => settings,
      set: () => {},
      sync: () => {}
    },
    utils: {
      keychainRead: () => false,
      keychainWrite: () => true,
      chooseFile: async () => chosenFile,
      resolvePath: (path: string) =>
        path.startsWith('@data') ? '/tmp/plugins/.data/id' : '/tmp/private',
      exec: (_path: string, _args: string[], _cwd: null, hook: (value: string) => void) => {
        frames.push(hook);

        return new Promise<{ status: number }>(() => {});
      }
    }
  } as unknown as RawIina;

  // 4. Start the session through the same lifecycle events as IINA.
  const session = new Session(new IinaHost(raw, 'io.github.hanifcarroll.iina-language-learning'));
  session.start();
  if (!alreadyLoaded) {
    raw.core.window.loaded = true;
    events.get('iina.window-loaded')!();
  }
  events.get('iina.plugin-overlay-loaded')!();
  overlay.get('overlayReady')!({});
  sidebar.get('sidebarReady')!({});
  events.get('iina.menu-update')!();

  // 5. Expose recorded effects and controls for each test scenario.
  return {
    session,
    raw,
    status,
    props,
    events,
    overlay,
    sidebar,
    frames,
    writes,
    states,
    actions,
    overlayMessages,
    overlayPayloads,
    menuItems,
    setChosenFile: (path: string) => {
      chosenFile = path;
    },
    shortcut: () => panelShortcut?.(),
    tick: () => (session as any).tick(),
    close: () => events.get('iina.window-will-close')?.()
  };
}

test('overlay accepts clicks only while a readable source track is active', () => {
  const player = fakePlayer();

  expect(player.actions).toContain('overlay clickable true');

  player.raw.core.subtitle.id = 0;
  player.tick();

  expect(player.actions.at(-1)).toBe('overlay clickable false');

  player.raw.core.subtitle.id = 1;
  player.tick();

  expect(player.actions.at(-1)).toBe('overlay clickable true');

  player.props.set('sub-text', 'Different subtitle');
  player.tick();

  expect(player.actions.at(-1)).toBe('overlay clickable false');

  player.close();
});

test('late install initializes an already loaded player only once', () => {
  const player = fakePlayer(true);

  expect(player.actions.filter((action) => action === 'simple mode')).toHaveLength(1);
  expect(player.states.at(-1).status).toBe('Select a subtitle phrase to begin.');

  player.events.get('iina.window-loaded')!();

  expect(player.actions.filter((action) => action === 'simple mode')).toHaveLength(1);

  player.close();
});

test('header close hides the sidebar even without a conversation', () => {
  const player = fakePlayer();
  player.sidebar.get('close')!({});

  expect(player.actions.at(-1)).toBe('sidebar hide');

  player.close();
});

test('Plugin menu loads an SRT and selects source and secondary tracks in this window', async () => {
  const player = fakePlayer();

  expect(player.menuItems.map((item) => item.title)).toEqual([
    'Toggle Neden Panel',
    'Add SRT/VTT File…',
    'Source Subtitle',
    'Secondary Subtitle'
  ]);

  player.menuItems[1].action?.();
  await Promise.resolve();

  expect(player.actions).toContain('load subtitle');

  player.events.get('iina.menu-update')!();
  const sourceMenu = player.menuItems.find((item) => item.title === 'Source Subtitle')!;
  const secondaryMenu = player.menuItems.find((item) => item.title === 'Secondary Subtitle')!;

  expect(sourceMenu.action).toBeNull();
  expect(secondaryMenu.action).toBeNull();
  expect(sourceMenu.items.map((item) => item.title)).toEqual([
    'Off',
    'source',
    'secondary',
    'English'
  ]);

  secondaryMenu.items.at(-1)!.action?.();

  expect(player.raw.core.subtitle.secondID).toBe(3);

  sourceMenu.items[0].action?.();

  expect(player.raw.core.subtitle.id).toBe(0);

  player.events.get('iina.menu-update')!();

  expect(
    player.menuItems.find((item) => item.title === 'Secondary Subtitle')!.items.at(-1)!.options
      ?.selected
  ).toBe(true);

  player.close();
});

test('sidebar track controls share IINA state with the menu and reject stale or forged choices', async () => {
  // 1. Create two player windows with independently owned track state.
  const player = fakePlayer();
  const other = fakePlayer();
  const epoch = player.states.at(-1).mediaEpoch;

  expect(player.states.at(-1).subtitleTracks.map((track: { id: number }) => track.id)).toEqual([
    1, 2
  ]);
  expect(player.states.at(-1).sourceId).toBe(1);
  expect(player.states.at(-1).secondaryId).toBe(2);

  // 2. Apply valid choices only to the owning window.
  player.sidebar.get('selectSubtitleTrack')!({
    role: 'source',
    id: 2,
    epoch
  });

  expect(player.raw.core.subtitle.id).toBe(2);
  expect(player.states.at(-1).sourceId).toBe(2);
  expect(other.raw.core.subtitle.id).toBe(1);

  player.events.get('iina.menu-update')!();

  expect(
    player.menuItems.find((item) => item.title === 'Source Subtitle')!.items[2].options?.selected
  ).toBe(true);

  // 3. Reject forged roles and IDs while allowing a newly added track.
  player.sidebar.get('selectSubtitleTrack')!({
    role: 'secondary',
    id: 999,
    epoch
  });
  player.sidebar.get('selectSubtitleTrack')!({
    role: 'primary',
    id: 1,
    epoch
  });

  expect(player.raw.core.subtitle.secondID).toBe(2);

  player.sidebar.get('addSubtitleFile')!({});
  await Promise.resolve();

  expect(player.states.at(-1).subtitleTracks.map((track: { id: number }) => track.id)).toEqual([
    1, 2, 3
  ]);

  // 4. Reject the original media epoch after replacing the movie.
  player.raw.core.subtitle.id = 1;
  player.status.url = 'file:///replacement.mp4';
  player.events.get('mpv.file-loaded')!();
  player.sidebar.get('selectSubtitleTrack')!({
    role: 'source',
    id: 2,
    epoch
  });

  expect(player.raw.core.subtitle.id).toBe(1);

  player.close();
  other.close();
});

test('a file picked for an earlier movie is not loaded into replacement media', async () => {
  const player = fakePlayer();
  const oldSourceAction = player.menuItems.find((item) => item.title === 'Source Subtitle')!
    .items[0].action!;
  let finishPick!: (path: string) => void;
  player.raw.utils.chooseFile = () =>
    new Promise((resolve) => {
      finishPick = resolve;
    });
  player.menuItems[1].action?.();
  player.status.url = 'file:///replacement.mp4';
  player.events.get('mpv.file-loaded')!();
  finishPick('/tmp/synthetic-english.srt');
  await Promise.resolve();

  expect(player.actions).not.toContain('load subtitle');

  oldSourceAction();

  expect(player.raw.core.subtitle.id).toBe(1);

  player.close();
});

function select(player: ReturnType<typeof fakePlayer>) {
  const pending = {
    cue: {
      trackId: 1,
      index: 0,
      text: 'Ben öyle bir insan mıyım?'
    },
    start: 4,
    end: 8,
    text: 'öyle'
  };
  player.overlay.get('selected')!(pending);

  return pending;
}

test('selection starts one request; its captured context survives cue advancement and seek', () => {
  const player = fakePlayer();
  select(player);

  expect(player.actions.filter((action) => action === 'pause')).toHaveLength(1);
  expect(player.frames).toHaveLength(1);
  expect(player.overlayMessages.at(-1)).toBe('clear');
  expect(player.states.at(-1).cue).toBe('Ben öyle bir insan mıyım?');

  player.status.position = 5;
  player.props.set('sub-text', 'Next cue');
  player.props.set('sub-start', 4);
  player.tick();

  expect(player.states.at(-1).cue).toBe('Ben öyle bir insan mıyım?');

  player.events.get('mpv.seek')!();

  expect(player.states.at(-1).cue).toBe('Ben öyle bir insan mıyım?');

  player.close();
});

test('Disable Overlay during a stream cancels, invalidates, resumes, and restores only this window', () => {
  const left = fakePlayer();
  const right = fakePlayer();
  select(left);
  select(right);
  left.frames[0]('READY\n');
  left.tick();
  right.frames[0]('READY\n');
  right.tick();
  left.frames[0]('DELTA UGFydA==\n');
  left.tick();

  expect(left.states.at(-1).turns[0].answer).toBe('Part');

  left.sidebar.get('disableOverlay')!({});

  expect(left.writes.some((value) => value.endsWith('/control:STOP\n'))).toBe(true);
  expect(left.actions).toContain('resume');
  expect(left.props.get('sub-visibility')).toBe(true);
  expect(right.props.get('sub-visibility')).toBe(false);
  expect(right.actions).not.toContain('resume');

  left.frames[0]('DELTA bGF0ZQ==\nDONE\n');
  left.tick();

  expect(left.states.at(-1).open).toBe(false);
  expect(left.states.at(-1).overlayEnabled).toBe(false);

  left.close();
  right.close();
});

test('media replacement rejects old stream results and never resumes the new media', () => {
  const player = fakePlayer();
  select(player);
  player.frames[0]('READY\n');
  player.tick();
  player.status.url = 'file:///replacement.mp4';
  player.events.get('mpv.file-loaded')!();
  player.frames[0]('DELTA U1RBTEU=\nDONE\n');
  player.tick();

  expect(player.states.at(-1).open).toBe(false);

  player.sidebar.get('close')!({});

  expect(player.actions).not.toContain('resume');
  expect(player.writes.some((value) => value.endsWith('/control:STOP\n'))).toBe(true);

  player.close();
});

test('settings dismissal does not resume, while native dismissal preserves chat and resumes', () => {
  const player = fakePlayer();
  select(player);
  player.sidebar.get('settingsView')!({ open: true, view: 'ai' });
  player.sidebar.get('visibility')!({ hidden: true });

  expect(player.states.at(-1).open).toBe(true);
  expect(player.actions).not.toContain('resume');

  player.sidebar.get('settingsView')!({ open: false, view: 'chat' });
  player.sidebar.get('visibility')!({ hidden: true });

  expect(player.states.at(-1).open).toBe(true);
  expect(player.states.at(-1).phrase).toBe('öyle');
  expect(player.actions).toContain('resume');

  player.close();
});

test('Hide/Resume cancels an active stream, preserves incomplete chat, and next selection replaces it', () => {
  const player = fakePlayer();
  select(player);
  const firstId = player.states.at(-1).conversationId;
  player.frames[0]('READY\nDELTA UGFydA==\n');
  player.tick();
  player.sidebar.get('close')!({});

  expect(player.states.at(-1).conversationId).toBe(firstId);
  expect(player.states.at(-1).turns[0].answer).toBe('Part');
  expect(player.states.at(-1).turns[0].status).toBe('incomplete');
  expect(player.actions).toContain('resume');
  expect(player.writes.some((value) => value.endsWith('/control:STOP\n'))).toBe(true);

  player.frames[0]('DELTA bGF0ZQ==\nDONE\n');
  player.tick();

  expect(player.states.at(-1).turns[0].answer).toBe('Part');

  player.shortcut();

  expect(player.actions.at(-1)).toBe('sidebar show');
  expect(player.states.at(-1).conversationId).toBe(firstId);

  const next = {
    cue: {
      trackId: 1,
      index: 1,
      text: 'Next cue'
    },
    start: 0,
    end: 4,
    text: 'Next'
  };
  player.overlay.get('selected')!(next);

  expect(player.states.at(-1).conversationId).not.toBe(firstId);
  expect(player.states.at(-1).phrase).toBe('Next');

  player.close();
});

test('a follow-up after reopening retained chat pauses playback again', () => {
  const player = fakePlayer();
  select(player);
  player.frames[0]('READY\nDELTA SGVsbG8=\nDONE\n');
  player.tick();
  const id = player.states.at(-1).conversationId;
  player.sidebar.get('close')!({});
  player.shortcut();
  const pauses = player.actions.filter((action) => action === 'pause').length;
  player.sidebar.get('followUp')!({ question: 'Why this wording?' });

  expect(player.actions.filter((action) => action === 'pause')).toHaveLength(pauses + 1);
  expect(player.states.at(-1).conversationId).toBe(id);
  expect(player.states.at(-1).turns[1].question).toBe('Why this wording?');

  player.sidebar.get('close')!({});

  expect(player.actions.filter((action) => action === 'resume')).toHaveLength(2);

  player.close();
});

test('selected secondary stays above source through cue gaps and restores native rendering on mismatch or disable', () => {
  // 1. Own secondary rendering while the source track is usable.
  const player = fakePlayer();
  player.tick();

  expect(player.states.at(-1).settings.appearance).not.toHaveProperty('showTranslation');
  expect(player.props.get('secondary-sub-visibility')).toBe(false);
  expect(player.overlayMessages).toContain('translation');
  expect(player.overlayPayloads.filter((item) => item.name === 'translation').at(-1)?.value).toBe(
    'Am I that kind of person?'
  );

  player.sidebar.get('saveAppearance')!({
    sourceSize: 33,
    sourceColor: '#eeeeee',
    sourceBottom: 12,
    translationSize: 24,
    translationColor: '#ffffff',
    translationGap: 18
  });

  expect(player.props.get('secondary-sub-visibility')).toBe(false);
  expect(player.states.at(-1).settings.appearance.sourceSize).toBe(33);

  // 2. Keep ownership through cue gaps and restore it on mismatched source text.
  player.status.position = 3;
  player.props.set('sub-text', '');
  player.tick();

  expect(player.props.get('secondary-sub-visibility')).toBe(false);

  player.props.set('sub-text', 'Unexpected source text');
  player.tick();

  expect(player.props.get('secondary-sub-visibility')).toBe(true);

  // 3. Reclaim matching subtitles and release tracks that are turned off.
  player.status.position = 1;
  player.props.set('sub-text', 'Ben öyle bir insan mıyım?');
  player.tick();

  expect(player.props.get('secondary-sub-visibility')).toBe(false);

  player.raw.core.subtitle.secondID = 0;
  player.tick();

  expect(player.props.get('secondary-sub-visibility')).toBe(true);

  player.raw.core.subtitle.secondID = 2;
  player.tick();

  expect(player.props.get('secondary-sub-visibility')).toBe(false);

  // 4. Restore native secondary visibility when the overlay is disabled.
  player.sidebar.get('disableOverlay')!({});

  expect(player.props.get('secondary-sub-visibility')).toBe(true);

  player.close();
});

test('swapping subtitle positions persists without changing tracks, native visibility, or starting a request', () => {
  const player = fakePlayer();
  const saved: any[] = [];
  player.raw.preferences.set = (_name, value) => {
    saved.push(value);
  };
  const actionCount = player.actions.length;
  const streamCount = player.frames.length;
  player.sidebar.get('swapSubtitleOrder')!({});

  expect(saved.at(-1).secondaryBelowSource).toBe(true);
  expect(player.states.at(-1).settings.secondaryBelowSource).toBe(true);
  expect(player.overlayPayloads.filter((item) => item.name === 'subtitleOrder').at(-1)?.value).toBe(
    true
  );
  expect(player.props.get('secondary-sub-visibility')).toBe(false);
  expect(player.raw.core.subtitle.id).toBe(1);
  expect(player.raw.core.subtitle.secondID).toBe(2);
  expect(player.actions).toHaveLength(actionCount);
  expect(player.frames).toHaveLength(streamCount);

  player.sidebar.get('saveSettings')!({
    endpoint: 'http://127.0.0.1:47891',
    model: 'synthetic',
    sourceLanguage: 'Turkish',
    explanationLanguage: 'English',
    includeSecondary: true,
    noKeyRequired: true,
    key: ''
  });

  expect(player.states.at(-1).settings.secondaryBelowSource).toBe(true);

  player.sidebar.get('swapSubtitleOrder')!({});

  expect(player.overlayPayloads.filter((item) => item.name === 'subtitleOrder').at(-1)?.value).toBe(
    false
  );

  player.close();
});

test('appearance changes preview without saving and leaving Subtitles restores native state', () => {
  const player = fakePlayer();
  const saved: unknown[] = [];
  player.raw.preferences.set = (_name, value) => {
    saved.push(value);
  };
  player.tick();
  const draft = {
    sourceSize: 34,
    sourceColor: '#ffcc00',
    sourceBottom: 14,
    translationSize: 26,
    translationColor: '#eeeeee',
    translationGap: 20
  };

  player.sidebar.get('settingsView')!({ open: true, view: 'subtitles' });
  player.sidebar.get('previewAppearance')!(draft);

  expect(player.overlayPayloads.filter((item) => item.name === 'appearance').at(-1)?.value).toEqual(
    draft
  );
  expect(player.props.get('secondary-sub-visibility')).toBe(false);
  expect(player.states.at(-1).settings.appearance.sourceSize).toBe(28);
  expect(saved).toHaveLength(0);

  player.sidebar.get('settingsView')!({ open: false, view: 'chat' });

  expect(
    player.overlayPayloads.filter((item) => item.name === 'appearance').at(-1)?.value
  ).toMatchObject({ sourceSize: 28 });
  expect(player.props.get('secondary-sub-visibility')).toBe(false);

  player.sidebar.get('settingsView')!({ open: true, view: 'subtitles' });
  player.sidebar.get('previewAppearance')!(draft);
  player.sidebar.get('saveAppearance')!(draft);

  expect(saved).toHaveLength(1);
  expect(player.states.at(-1).settings.appearance).toEqual(draft);

  player.sidebar.get('disableOverlay')!({});
  const messageCount = player.overlayPayloads.length;
  player.sidebar.get('previewAppearance')!({ ...draft, sourceSize: 40 });

  expect(player.overlayPayloads).toHaveLength(messageCount);

  player.close();
});

test('native Settings dismissal discards unsaved subtitle preview without resuming playback', () => {
  const player = fakePlayer();
  select(player);
  player.sidebar.get('settingsView')!({ open: true, view: 'subtitles' });
  player.sidebar.get('previewAppearance')!({
    sourceSize: 34,
    sourceColor: '#ffcc00',
    sourceBottom: 14,
    translationSize: 26,
    translationColor: '#eeeeee',
    translationGap: 20
  });
  player.sidebar.get('visibility')!({ hidden: true });

  expect(
    player.overlayPayloads.filter((item) => item.name === 'appearance').at(-1)?.value
  ).toMatchObject({ sourceSize: 28 });
  expect(player.props.get('secondary-sub-visibility')).toBe(false);
  expect(player.actions).not.toContain('resume');

  player.close();
});

test('failed appearance save keeps the stored appearance and leaving Subtitles removes its preview', () => {
  const player = fakePlayer();
  const draft = {
    sourceSize: 34,
    sourceColor: '#ffcc00',
    sourceBottom: 14,
    translationSize: 26,
    translationColor: '#eeeeee',
    translationGap: 20
  };
  player.raw.preferences.set = () => {
    throw new Error('Storage unavailable');
  };
  player.sidebar.get('settingsView')!({ open: true, view: 'subtitles' });
  player.sidebar.get('previewAppearance')!(draft);
  player.sidebar.get('saveAppearance')!(draft);

  expect(player.states.at(-1).status).toBe('Storage unavailable');
  expect(player.states.at(-1).settings.appearance.sourceSize).toBe(28);

  player.sidebar.get('settingsView')!({ open: false, view: 'chat' });

  expect(
    player.overlayPayloads.filter((item) => item.name === 'appearance').at(-1)?.value
  ).toMatchObject({ sourceSize: 28 });

  player.close();
});

test('saving provider settings does not accidentally commit an appearance preview', () => {
  const player = fakePlayer();
  const saved: any[] = [];
  player.raw.preferences.set = (_name, value) => {
    saved.push(value);
  };
  player.sidebar.get('settingsView')!({ open: true, view: 'subtitles' });
  player.sidebar.get('previewAppearance')!({
    sourceSize: 34,
    sourceColor: '#ffcc00',
    sourceBottom: 14,
    translationSize: 26,
    translationColor: '#eeeeee',
    translationGap: 20
  });
  player.sidebar.get('saveSettings')!({
    endpoint: 'http://127.0.0.1:47891',
    model: 'synthetic',
    sourceLanguage: 'Turkish',
    explanationLanguage: 'English',
    includeSecondary: true,
    noKeyRequired: true,
    appearance: { sourceSize: 34 }
  });

  expect(saved.at(-1).appearance.sourceSize).toBe(28);
  expect(
    player.overlayPayloads.filter((item) => item.name === 'appearance').at(-1)?.value
  ).toMatchObject({ sourceSize: 34 });

  player.sidebar.get('settingsView')!({ open: true, view: 'ai' });

  expect(
    player.overlayPayloads.filter((item) => item.name === 'appearance').at(-1)?.value
  ).toMatchObject({ sourceSize: 28 });

  player.close();
});

test('Replay line plays the captured cue once, returns to the watch position, and starts no request', () => {
  const player = fakePlayer();
  select(player);
  const requests = player.frames.length;
  player.sidebar.get('replayCue')!({});

  expect(player.actions).toContain('seek 0');
  expect(player.status.paused).toBe(false);
  expect(player.states.at(-1).replaying).toBe(true);

  player.status.position = 0.1;
  player.tick();
  player.status.position = 1.98;
  player.tick();

  expect(player.actions.at(-1)).toBe('seek 1');
  expect(player.status.position).toBe(1);
  expect(player.status.paused).toBe(true);
  expect(player.states.at(-1).replaying).toBe(false);
  expect(player.frames).toHaveLength(requests);

  player.close();
});

test('Replay line can be stopped and respects user seeks, media replacement, and other windows', () => {
  // 1. Verify replay and Stop affect only their own window.
  const left = fakePlayer();
  const right = fakePlayer();
  select(left);
  select(right);
  left.sidebar.get('replayCue')!({});

  expect(right.actions).not.toContain('seek 0');

  left.sidebar.get('replayCue')!({});

  expect(left.status.position).toBe(1);
  expect(left.status.paused).toBe(true);

  left.sidebar.get('replayCue')!({});

  // 2. Cancel replay when the user seeks outside the selected cue.
  left.status.position = 0.1;
  left.tick();
  left.status.position = 10;
  left.events.get('mpv.seek')!();
  left.tick();

  expect(left.states.at(-1).replaying).toBe(false);
  expect(left.status.position).toBe(10);

  left.sidebar.get('replayCue')!({});

  // 3. Discard the return position when the media changes.
  const oldReturns = left.actions.filter((action) => action === 'seek 10').length;
  left.status.url = 'file:///replacement.mp4';
  left.events.get('mpv.file-loaded')!();

  expect(left.states.at(-1).replaying).toBe(false);
  expect(left.actions.filter((action) => action === 'seek 10')).toHaveLength(oldReturns);

  left.close();
  right.close();
});

test('hiding the panel during replay returns to the watch position before resuming', () => {
  const player = fakePlayer();
  select(player);
  player.sidebar.get('replayCue')!({});
  player.status.position = 0.2;
  player.tick();
  player.sidebar.get('close')!({});

  expect(player.status.position).toBe(1);
  expect(player.status.paused).toBe(false);
  expect(player.states.at(-1).replaying).toBe(false);
  expect(player.states.at(-1).open).toBe(true);

  player.close();
});

test('Replay line uses the selected cue timestamp with current subtitle delay and speed', () => {
  const player = fakePlayer();
  player.props.set('sub-delay', 1);
  player.props.set('sub-speed', 2);
  player.props.set('sub-text', 'Next cue');
  player.props.set('sub-start', 4);
  player.status.position = 3.5;
  player.tick();
  player.overlay.get('selected')!({
    cue: {
      trackId: 1,
      index: 1,
      text: 'Next cue'
    },
    start: 0,
    end: 4,
    text: 'Next'
  });
  player.sidebar.get('replayCue')!({});

  expect(player.actions).toContain('seek 3');

  player.status.position = 3.1;
  player.tick();
  player.status.position = 3.98;
  player.tick();

  expect(player.status.position).toBe(3.5);
  expect(player.status.paused).toBe(true);

  player.close();
});

test('Replay line ignores its own seek event but cancels an immediate user seek', () => {
  const player = fakePlayer();
  select(player);
  player.sidebar.get('replayCue')!({});
  player.events.get('mpv.seek')!();

  expect(player.states.at(-1).replaying).toBe(true);

  player.status.position = 8;
  player.events.get('mpv.seek')!();

  expect(player.states.at(-1).replaying).toBe(false);
  expect(player.status.position).toBe(8);

  player.close();
});

test('Replay line still completes when seeking lands partway into a cue', () => {
  const player = fakePlayer();
  select(player);
  player.sidebar.get('replayCue')!({});
  player.status.position = 0.45;
  player.tick();
  player.status.position = 2.3;
  player.tick();

  expect(player.states.at(-1).replaying).toBe(false);
  expect(player.status.position).toBe(1);

  player.close();
});

test('Replay line works when the media duration is unavailable', () => {
  const player = fakePlayer();
  select(player);
  player.status.duration = null;
  player.sidebar.get('replayCue')!({});

  expect(player.states.at(-1).replaying).toBe(true);

  player.status.position = 0.1;
  player.tick();
  player.status.position = 1.98;
  player.tick();

  expect(player.status.position).toBe(1);

  player.close();
});

test('changing the source track makes the captured line unavailable for replay', () => {
  const player = fakePlayer();
  select(player);
  player.sidebar.get('replayCue')!({});
  player.raw.core.subtitle.id = 2;
  player.tick();

  expect(player.states.at(-1).replaying).toBe(false);
  expect(player.states.at(-1).replayAvailable).toBe(false);

  const seeks = player.actions.filter((action) => action.startsWith('seek ')).length;
  player.sidebar.get('replayCue')!({});

  expect(player.actions.filter((action) => action.startsWith('seek '))).toHaveLength(seeks);

  player.close();
});

test('window teardown cancels an active request and restores native primary visibility', () => {
  const player = fakePlayer();
  select(player);
  player.frames[0]('READY\n');
  player.tick();
  player.close();

  expect(player.writes.some((value) => value.endsWith('/control:STOP\n'))).toBe(true);
  expect(player.props.get('sub-visibility')).toBe(true);
  expect(player.actions).not.toContain('resume');
  expect(player.events.size).toBe(0);
});

test('late Stop cannot relabel a completed answer', () => {
  const player = fakePlayer();
  select(player);
  player.frames[0]('READY\n');
  player.tick();
  player.frames[0]('DELTA SGVsbG8=\nDONE\n');
  player.tick();
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

test('natural cue boundaries do not flash native subtitles when the playhead cache lags', () => {
  const player = fakePlayer();
  const displayedCue = () =>
    player.overlayPayloads.filter((item) => item.name === 'cue').at(-1)?.value;

  // 1. mpv has cleared the cue while the cached playhead is still inside it.
  player.status.position = 1.95;
  player.props.set('sub-text', '');
  player.props.set('sub-start', NaN);
  player.tick();

  expect(displayedCue()).toBeNull();
  expect(player.props.get('sub-visibility')).toBe(false);
  expect(player.props.get('secondary-sub-visibility')).toBe(false);

  // 2. The next native cue arrives before IINA refreshes its cached playhead.
  player.status.position = 3.95;
  player.props.set('sub-text', 'Next cue');
  player.props.set('sub-start', 4);
  player.tick();

  expect(displayedCue()).toEqual({
    trackId: 1,
    index: 1,
    text: 'Next cue'
  });
  expect(player.props.get('sub-visibility')).toBe(false);
  expect(player.props.get('secondary-sub-visibility')).toBe(false);

  // 3. A later playhead update keeps the same rendering and cue identity.
  player.status.position = 4.1;
  player.tick();

  expect(player.props.get('sub-visibility')).toBe(false);
  expect(player.states.at(-1).status).not.toContain('does not match');

  player.close();
});

test('request contains frozen neighboring and secondary context, with no key on keyless endpoint', () => {
  const player = fakePlayer();
  select(player);
  player.frames[0]('READY\n');
  player.tick();
  const request = player.writes.find((value) => value.includes('/request:'))!;
  const payload = JSON.parse(request.slice(request.indexOf('/request:') + 9));

  expect(payload.key).toBeNull();
  expect(payload.url).toBe('http://127.0.0.1:47891/chat/completions');
  expect(payload.body.thinking).toBeUndefined();

  const prompt = JSON.parse(payload.body.messages[1].content);

  expect(prompt.selected).toBe('öyle');
  expect(prompt.after).toEqual(['Next cue']);
  expect(prompt.secondary).toEqual(['Am I that kind of person?']);

  player.close();
});

test('DeepSeek Flash requests disable thinking and use the context prompt', () => {
  const player = fakePlayer();
  player.sidebar.get('saveSettings')!({
    endpoint: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    sourceLanguage: 'Turkish',
    explanationLanguage: 'English',
    includeSecondary: true,
    noKeyRequired: true,
    key: ''
  });
  const urlDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'URL');
  Object.defineProperty(globalThis, 'URL', { value: undefined, configurable: true });
  try {
    select(player);
  } finally {
    if (urlDescriptor) {
      Object.defineProperty(globalThis, 'URL', urlDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'URL');
    }
  }
  player.frames[0]('READY\n');
  player.tick();
  const request = player.writes.find((value) => value.includes('/request:'))!;
  const payload = JSON.parse(request.slice(request.indexOf('/request:') + 9));

  expect(payload.body.thinking).toEqual({ type: 'disabled' });
  expect(payload.body.messages[0].content).toContain(
    'Following cues may qualify the selected line'
  );
  expect(JSON.parse(payload.body.messages[1].content).task).toBeUndefined();

  player.close();
});

test('forged or stale bridge selections never pause or start a request', () => {
  const player = fakePlayer();
  const forged = {
    cue: {
      trackId: 1,
      index: 0,
      text: 'Different cue'
    },
    start: 0,
    end: 4,
    text: 'Diff'
  };
  player.overlay.get('selected')!(forged);
  player.sidebar.get('followUp')!({ question: 'Send anyway' });

  expect(player.actions).not.toContain('pause');
  expect(player.frames).toHaveLength(0);

  player.close();
});

test('duplicate selection delivery does not create a second request', () => {
  const player = fakePlayer();
  const selected = select(player);
  player.overlay.get('selected')!(selected);

  expect(player.frames).toHaveLength(1);
  expect(player.actions.filter((action) => action === 'pause')).toHaveLength(1);

  player.close();
});

test('new selection invalidates the prior request and keeps its own selected phrase', () => {
  const player = fakePlayer();
  select(player);
  player.frames[0]('READY\n');
  player.tick();
  const next = {
    cue: {
      trackId: 1,
      index: 1,
      text: 'Next cue'
    },
    start: 0,
    end: 4,
    text: 'Next'
  };
  player.overlay.get('selected')!(next);
  player.frames[0]('DELTA U1RBTEU=\nDONE\n');
  player.tick();

  expect(player.states.at(-1).phrase).toBe('Next');
  expect(player.states.at(-1).turns[0].answer).toBe('');
  expect(player.writes.some((value) => value.endsWith('/control:STOP\n'))).toBe(true);

  player.close();
});
