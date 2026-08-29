export const SOMITE_SERVER = process.env.NEXT_PUBLIC_SOMITE_SERVER ?? "http://localhost:7310";

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
  const response = await fetch(`${SOMITE_SERVER}${path}`, init);
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string; state_revision?: string } | null;
    throw new JsonRequestError(detail?.error ?? `${response.status} ${response.statusText}`, response.status, detail);
  }
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}
