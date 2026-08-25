import type { Metadata } from "next";
import { SomiteApp } from "./SomiteApp";

export const metadata: Metadata = {
  title: "Somite — Visual Bioinformatics",
  description: "Build typed bioinformatics workflows on an infinite canvas.",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q } = await searchParams;
  return <SomiteApp initialQuery={typeof q === "string" ? q : ""} />;
}
