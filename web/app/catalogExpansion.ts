export type CatalogExpansionActivity = {
  operatorId: string;
  title: string;
  phase: "resolving" | "failed";
  detail?: string;
};

export function catalogExpansionPresentation(activity: CatalogExpansionActivity) {
  const sourceWorkflow = activity.operatorId.startsWith("nf.");
  if (activity.phase === "resolving") {
    return {
      tone: "working" as const,
      headline: sourceWorkflow ? "Resolving and pinning source…" : "Building rule graph…",
      summary: sourceWorkflow ? `Fetching the exact ${activity.title} release.` : `Reading ${activity.title} at its pinned release.`,
      detail: null,
    };
  }

  const missingDag = /did not produce a DAG/i.test(activity.detail ?? "");
  return {
    tone: "error" as const,
    headline: `Couldn’t add ${activity.title}`,
    summary: sourceWorkflow
      ? "Somite could not resolve and pin this workflow’s source, so your canvas was left unchanged."
      : missingDag
      ? "Nextflow did not return a process graph, so your canvas was left unchanged."
      : "Somite could not build this workflow’s process graph, so your canvas was left unchanged.",
    detail: activity.detail ?? null,
  };
}
