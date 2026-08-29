export type CatalogExpansionActivity = {
  operatorId: string;
  title: string;
  phase: "resolving" | "failed";
  detail?: string;
};

export function catalogExpansionPresentation(activity: CatalogExpansionActivity) {
  if (activity.phase === "resolving") {
    return {
      tone: "working" as const,
      headline: "Building process graph…",
      summary: `Reading ${activity.title} at its pinned release.`,
      detail: null,
    };
  }

  const missingDag = /did not produce a DAG/i.test(activity.detail ?? "");
  return {
    tone: "error" as const,
    headline: `Couldn’t add ${activity.title}`,
    summary: missingDag
      ? "Nextflow did not return a process graph, so your canvas was left unchanged."
      : "Somite could not build this workflow’s process graph, so your canvas was left unchanged.",
    detail: activity.detail ?? null,
  };
}
