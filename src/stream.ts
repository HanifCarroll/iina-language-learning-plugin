import { utf8Bytes } from './utf8';

export type StreamRecord =
  | { kind: 'ready' | 'done' }
  | {
      kind: 'delta' | 'error' | 'cancelled';
      value: string;
    };

function decodeBase64Utf8(value: string): string {
  // 1. Reject malformed frames before decoding.
  if (!value || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Invalid helper frame');
  }

  // 2. Decode base64 into escaped bytes without browser globals.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let bytes = '';
  for (let offset = 0; offset < value.length; offset += 4) {
    const first = alphabet.indexOf(value[offset]);
    const second = alphabet.indexOf(value[offset + 1]);
    const third = value[offset + 2] === '=' ? 0 : alphabet.indexOf(value[offset + 2]);
    const fourth = value[offset + 3] === '=' ? 0 : alphabet.indexOf(value[offset + 3]);
    if (first < 0 || second < 0 || third < 0 || fourth < 0) {
      throw new Error('Invalid helper frame');
    }

    bytes += `%${((first << 2) | (second >> 4)).toString(16).padStart(2, '0')}`;
    if (value[offset + 2] !== '=') {
      bytes += `%${(((second & 15) << 4) | (third >> 2)).toString(16).padStart(2, '0')}`;
    }
    if (value[offset + 3] !== '=') {
      bytes += `%${(((third & 3) << 6) | fourth).toString(16).padStart(2, '0')}`;
    }
  }

  // 3. Decode UTF-8 and reject invalid byte sequences.
  return decodeURIComponent(bytes);
}

export class HelperFrames {
  private bytes = '';
  private overflow = false;

  // IINA calls stdoutHook on a background file-handle queue. This method only queues
  // bytes. Never call IINA host APIs, file APIs, or update a WebView from that hook.
  enqueue(chunk: string): void {
    if (!chunk || this.overflow) {
      return;
    }

    if (this.bytes.length + chunk.length > 256 * 1024) {
      this.overflow = true;
      this.bytes = '';

      return;
    }

    this.bytes += chunk;
  }

  // Called only by the plugin timer on its normal JS execution path.
  drain(): StreamRecord[] {
    // 1. Report a bounded-buffer overflow once.
    if (this.overflow) {
      this.overflow = false;

      return [{ kind: 'error', value: 'helper_output_too_large' }];
    }

    // 2. Decode complete lines and retain a partial trailing frame.
    const records: StreamRecord[] = [];
    let newline: number;
    while ((newline = this.bytes.indexOf('\n')) >= 0) {
      const line = this.bytes.slice(0, newline).replace(/\r$/, '');
      this.bytes = this.bytes.slice(newline + 1);
      if (!line) {
        continue;
      }

      if (line === 'READY') {
        records.push({ kind: 'ready' });
      } else if (line === 'DONE') {
        records.push({ kind: 'done' });
      } else if (line.startsWith('DELTA ')) {
        try {
          records.push({ kind: 'delta', value: decodeBase64Utf8(line.slice(6)) });
        } catch {
          records.push({ kind: 'error', value: 'invalid_helper_frame' });
        }
      } else if (/^(ERROR|CANCELLED) [a-z0-9_]+$/.test(line)) {
        const [kind, value] = line.split(' ');
        records.push({ kind: kind.toLowerCase() as 'error' | 'cancelled', value });
      } else {
        records.push({ kind: 'error', value: 'invalid_helper_frame' });
      }
    }

    return records;
  }
}

type Handle = {
  write(data: string): void;
  close(): void;
};
type Host = {
  file: { handle(path: string, mode: string): Handle };
  utils: {
    exec(
      path: string,
      args: string[],
      cwd: null,
      stdout: (chunk: string) => void,
      stderr: null
    ): Promise<{ status: number }>;
  };
};

export class NativeStream {
  private readonly frames = new HelperFrames();
  private control: Handle | null = null;
  private payload: string | null;
  private cancelled = false;
  private terminal = false;
  private exited = false;
  private exitError = false;

  constructor(
    private readonly host: Host,
    private readonly executable: string,
    private readonly directory: string,
    payload: string,
    private readonly onRecord: (record: StreamRecord) => void
  ) {
    if (utf8Bytes(payload) > 128 * 1024) {
      throw new Error('Request exceeds helper limit');
    }

    this.payload = payload;
  }

  start(): void {
    this.host.utils
      .exec(
        this.executable,
        [this.directory],
        null,
        (chunk) => {
          this.frames.enqueue(chunk);
        },
        null
      )
      .then(
        () => {
          this.exited = true;
        },
        () => {
          this.exited = true;
          this.exitError = true;
        }
      );
  }

  cancel(): void {
    this.cancelled = true;
    if (this.control) {
      try {
        this.control.write('STOP\n');
        this.control.close();
      } catch {
        /* helper may have exited; request ownership still invalidates late data */
      }
      this.control = null;
    }
  }

  private sendRequest(): void {
    try {
      // 1. Open the private pipes only after the helper signals readiness.
      this.control = this.host.file.handle(`${this.directory}/control`, 'write');
      const input = this.host.file.handle(`${this.directory}/request`, 'write');
      if (!this.control || !input || this.payload === null) {
        throw new Error('Private pipe unavailable');
      }

      // 2. Send the payload once, honoring cancellation before authentication.
      // A Stop before READY must not send the authenticated request at all.
      input.write(this.cancelled ? '{}' : this.payload);
      input.close();
      this.payload = null;
      if (this.cancelled) {
        this.cancel();
      }
    } catch {
      this.cancel();
      this.terminal = true;
      this.onRecord({ kind: 'error', value: 'private_pipe_failed' });
    }
  }

  // Call from a plugin timer only. All IINA file APIs and UI callbacks stay here.
  pump(): boolean {
    // 1. Process queued frames on the normal plugin execution path.
    for (const record of this.frames.drain()) {
      if (this.terminal) {
        continue;
      }

      if (record.kind === 'ready') {
        this.sendRequest();
      } else {
        if (record.kind !== 'delta') {
          this.terminal = true;
          this.payload = null;
          try {
            this.control?.close();
          } catch {
            /* helper may already be gone */
          }
          this.control = null;
        }
        if (!this.cancelled || record.kind !== 'delta') {
          this.onRecord(record);
        }
      }
    }

    // 2. Treat an exit without a terminal frame as an interrupted request.
    if (this.exited && !this.terminal) {
      this.terminal = true;
      this.payload = null;
      this.onRecord({
        kind: 'error',
        value: this.exitError ? 'helper_start_failed' : 'helper_interrupted'
      });
    }

    return this.terminal || this.exited;
  }
}
