export const AXIAL_SERVER = process.env.NEXT_PUBLIC_AXIAL_SERVER ?? "http://localhost:7310";

export async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${AXIAL_SERVER}${path}`, init);
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}
