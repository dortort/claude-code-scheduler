// file:// token mode: the per-page token the sidecar checks in X-CB-Token,
// HMAC-SHA256(key = the secret's UTF-8 bytes, msg = "page:" + page), hex.

export const PAGE_TOKEN_TOOL = 'page_token'

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** HMAC-SHA256 (RFC 2104) over the digest the environment offers. */
export async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const BLOCK = 64
  const k = new Uint8Array(BLOCK)
  k.set(key.length > BLOCK ? await sha256(key) : key)
  const inner = new Uint8Array(BLOCK)
  const outer = new Uint8Array(BLOCK)
  for (let i = 0; i < BLOCK; i += 1) {
    const byte = k[i] ?? 0
    inner[i] = byte ^ 0x36
    outer[i] = byte ^ 0x5c
  }
  return sha256(concat(outer, await sha256(concat(inner, message))))
}

export async function pageToken(secret: string, page: string): Promise<string> {
  const encoder = new TextEncoder()
  const mac = await hmacSha256(encoder.encode(secret), encoder.encode(`page:${page}`))
  let hex = ''
  for (const b of mac) hex += b.toString(16).padStart(2, '0')
  return hex
}

/** What the page_token tool answers: the head tags a file:// page carries. */
export function tokenTags(port: number, page: string, token: string): string {
  const attr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return [
    `Head tags for ${page} opened from disk (file://). The token works for this page path and this session only, and goes stale after /callbacks rotate.`,
    '',
    `<meta name="cb-token" content="${token}">`,
    `<meta name="cb-endpoint" content="http://127.0.0.1:${port}">`,
    `<meta name="cb-page" content="${attr(page)}">`,
    `<script src="http://127.0.0.1:${port}/_cb/client.js" defer></script>`,
  ].join('\n')
}
