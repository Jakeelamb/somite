import { SomiteApp } from "./SomiteApp";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q } = await searchParams;
  const serverUrl = process.env.SOMITE_SERVER_URL
    ?? process.env.NEXT_PUBLIC_SOMITE_SERVER
    ?? "http://localhost:7310";
  return <SomiteApp initialQuery={typeof q === "string" ? q : ""} serverUrl={serverUrl} />;
}
