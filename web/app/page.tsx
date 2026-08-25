import type { Metadata } from "next";
import { AxialApp } from "./AxialApp";

export const metadata: Metadata = {
  title: "Axial — Visual Bioinformatics",
  description: "Build typed bioinformatics workflows on an infinite canvas.",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q } = await searchParams;
  return <AxialApp initialQuery={typeof q === "string" ? q : ""} />;
}
