const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 without String.fromCharCode.apply on huge arrays (React Native chokes on those). */
export const toBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    const triple = (a << 16) | (b << 8) | c
    out += ALPHABET[(triple >> 18) & 63] + ALPHABET[(triple >> 12) & 63] + (i + 1 < bytes.length ? ALPHABET[(triple >> 6) & 63] : '=') + (i + 2 < bytes.length ? ALPHABET[triple & 63] : '=')
  }
  return out
}

export const fromBase64 = (text: string): Uint8Array => {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n = (ALPHABET.indexOf(clean[i]) << 18) | (ALPHABET.indexOf(clean[i + 1]) << 12) | ((ALPHABET.indexOf(clean[i + 2]) & 63) << 6) | (ALPHABET.indexOf(clean[i + 3]) & 63)
    out[o++] = (n >> 16) & 255
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255
    if (i + 3 < clean.length) out[o++] = n & 255
  }
  return out.subarray(0, o)
}
