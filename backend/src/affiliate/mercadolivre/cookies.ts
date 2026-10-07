interface ParsedSetCookie {
  name: string;
  value: string;
  maxAge: number | null;
  expires: Date | null;
  attributes: string;
}

function parseSetCookie(header: string): ParsedSetCookie {
  const parts = header.split(";").map((p) => p.trim());
  const [nameValue, ...rest] = parts as [string, ...string[]];
  const eqIdx = nameValue.indexOf("=");
  const name = nameValue.slice(0, eqIdx).trim();
  const value = nameValue.slice(eqIdx + 1).trim();

  let maxAge: number | null = null;
  let expires: Date | null = null;

  for (const attr of rest) {
    const lower = attr.toLowerCase();
    if (lower.startsWith("max-age=")) {
      maxAge = Number(attr.slice("max-age=".length));
    } else if (lower.startsWith("expires=")) {
      expires = new Date(attr.slice("expires=".length));
    }
  }

  return { name, value, maxAge, expires, attributes: rest.join("; ") };
}

function deveRemover(parsed: ParsedSetCookie): boolean {
  if (parsed.maxAge !== null && parsed.maxAge <= 0) return true;
  if (parsed.expires !== null && parsed.expires <= new Date()) return true;
  return false;
}

export function mergeCookies(
  cookieAtual: string,
  setCookies: string[],
): string {
  const jar = new Map<string, string>();

  if (cookieAtual.trim()) {
    for (const par of cookieAtual.split(";")) {
      const idx = par.indexOf("=");
      if (idx === -1) continue;
      const k = par.slice(0, idx).trim();
      const v = par.slice(idx + 1).trim();
      if (k) jar.set(k, v);
    }
  }

  for (const header of setCookies) {
    if (!header.trim()) continue;
    const parsed = parseSetCookie(header);
    if (deveRemover(parsed)) {
      jar.delete(parsed.name);
    } else {
      jar.set(parsed.name, parsed.value);
    }
  }

  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}
