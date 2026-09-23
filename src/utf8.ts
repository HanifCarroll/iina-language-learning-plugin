export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid UTF-16 input');
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Invalid UTF-16 input');
    else bytes += 3;
  }
  return bytes;
}
