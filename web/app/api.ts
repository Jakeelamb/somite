const DEFAULT_SOMITE_SERVER = "http://localhost:7310";
let somiteServer = DEFAULT_SOMITE_SERVER;

export function normalizedSomiteServerUrl(value: string | undefined): string {
  if (!value) return DEFAULT_SOMITE_SERVER;
  const candidate = new URL(value);
  if ((candidate.protocol !== "http:" && candidate.protocol !== "https:")
    || candidate.username
    || candidate.password
    || candidate.pathname !== "/"
    || candidate.search
    || candidate.hash) {
    throw new Error("Somite's runner URL must be an HTTP(S) origin without credentials or a path");
  }
  return candidate.origin;
}

export function configureSomiteServer(value: string): void {
  somiteServer = normalizedSomiteServerUrl(value);
}

export function somiteServerUrl(): string {
  return somiteServer;
}

export class JsonRequestError extends Error {
  readonly status: number;
  readonly body: { error?: string; state_revision?: string } | null;

  constructor(
    message: string,
    status: number,
    body: { error?: string; state_revision?: string } | null,
  ) {
    super(message);
    this.name = "JsonRequestError";
    this.status = status;
    this.body = body;
  }
}

export async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${somiteServerUrl()}${path}`, init);
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string; state_revision?: string } | null;
    throw new JsonRequestError(detail?.error ?? `${response.status} ${response.statusText}`, response.status, detail);
  }
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}
