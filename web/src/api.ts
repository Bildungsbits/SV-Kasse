export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("Keine Verbindung zum Server. Bitte Internet prüfen.", 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* leer */
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Fehler ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Unbekannter Fehler");

export function go(path: string) {
  location.hash = path;
}
