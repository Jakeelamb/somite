export type PublicSourceProvider = "ncbi" | "ensembl";
export type PublicSourceFailures = Partial<Record<PublicSourceProvider, string>>;

export type PublicSourceOutcome = Readonly<{
  tone: "searching" | "results" | "empty" | "degraded" | "unavailable" | "idle";
  message: string;
  failed: PublicSourceProvider[];
}>;

const providerLabel: Record<PublicSourceProvider, string> = { ncbi: "NCBI", ensembl: "Ensembl" };

/** Keep an upstream outage distinct from a genuine zero-result biological search. */
export function publicSourceOutcome(
  searching: boolean,
  searched: boolean,
  resultCount: number,
  failures: PublicSourceFailures,
): PublicSourceOutcome {
  const failed = (["ncbi", "ensembl"] as const).filter((provider) => failures[provider]);
  if (searching) return { tone: resultCount ? "results" : "searching", message: "Searching live NCBI and Ensembl records…", failed };
  if (!searched) return { tone: "idle", message: "Searching public data alongside the local catalog…", failed };
  if (failed.length === 2) return { tone: "unavailable", message: "NCBI and Ensembl are unavailable. Your search is retained; retry when the providers recover.", failed };
  if (failed.length === 1) {
    const name = providerLabel[failed[0]!];
    return {
      tone: "degraded",
      message: resultCount
        ? `${name} is unavailable. Results from the other provider remain usable.`
        : `${name} is unavailable. The other provider returned no matches; this is not a complete search.`,
      failed,
    };
  }
  return resultCount
    ? { tone: "results", message: `${resultCount} public data result${resultCount === 1 ? "" : "s"} found.`, failed }
    : { tone: "empty", message: "No public data matches in NCBI or Ensembl · tools and workflows remain below", failed };
}
