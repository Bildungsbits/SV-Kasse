export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// Admin-Token nur im Arbeitsspeicher: weder Cookie noch localStorage.
// Beim Neuladen oder Verlassen des Adminbereichs ist es weg, dann muss das Passwort neu eingegeben werden.
let adminToken: string | null = null;
export const setAdminToken = (t: string | null) => {
  adminToken = t;
};

export async function api<T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> {
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (adminToken && path.startsWith("/api/admin/")) headers.Authorization = `Bearer ${adminToken}`;
    res = await fetch(path, {
      method,
      headers,
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
