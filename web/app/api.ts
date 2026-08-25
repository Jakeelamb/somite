export const SOMITE_SERVER = process.env.NEXT_PUBLIC_SOMITE_SERVER ?? "http://localhost:7310";

export async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SOMITE_SERVER}${path}`, init);
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}
