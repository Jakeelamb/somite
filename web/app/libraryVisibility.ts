import type { Operator } from "./types";
import { operatorContinues, type PendingConnection } from "./graphInteractions.ts";
import { opaqueNfcoreFallback } from "./sourceWorkflowPresentation.ts";

const SOURCE_PREFIXES = ["files.", "sheet.", "archive.", "sra.", "ncbi.", "ensembl."] as const;

export function libraryOperatorIsSource(operator: Pick<Operator, "id">) {
  return SOURCE_PREFIXES.some((prefix) => operator.id.startsWith(prefix));
}

function visibleSpecializedInput(operator: Pick<Operator, "id">) {
  return operator.id === "files.import_kraken2_database";
}

/** One predicate owns both Add-list contents and its visible item count. */
export function libraryOperatorIsVisible(operator: Pick<Operator, "id" | "kind" | "palette">) {
  return (!libraryOperatorIsSource(operator) || visibleSpecializedInput(operator))
    && operator.kind !== "source"
    && !opaqueNfcoreFallback(operator);
}

/** Hidden source utilities appear only when they exactly bridge the selected typed port. */
export function libraryOperatorIsAvailable(operator: Operator, continuation: PendingConnection | null | undefined) {
  return libraryOperatorIsVisible(operator)
    || Boolean(continuation && operatorContinues(operator, continuation));
}
