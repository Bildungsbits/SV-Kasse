const enc = new TextEncoder();

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export interface TokenPayload {
  role: "admin" | "cashier";
  shift?: string;
  exp: number; // unix seconds
}

export async function signToken(payload: TokenPayload, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifyToken(token: string | undefined, secret: string): Promise<TokenPayload | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64url(sig) as BufferSource, enc.encode(body) as BufferSource);
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64url(body))) as TokenPayload;
    if (typeof p.exp !== "number" || p.exp < Date.now() / 1000) return null;
    return p;
  } catch {
    return null;
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// --- Passwort-Hash (PBKDF2) für ein im Adminbereich geändertes Passwort ---
const ITER = 100_000;

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: ITER }, key, 256);
  return `${ITER}$${b64url(salt)}$${b64url(bits)}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [iter, salt, hash] = stored.split("$");
  if (!iter || !salt || !hash) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: unb64url(salt) as BufferSource, iterations: Number(iter) },
    key,
    256,
  );
  return timingSafeEqual(b64url(bits), hash);
}

/** Zufälliger numerischer Code (kryptografisch, ohne Modulo-Verzerrung). */
export function randomCode(length: number): string {
  let out = "";
  const buf = new Uint32Array(1);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4_000_000_000) out += (buf[0] % 10).toString();
  }
  return out;
}
