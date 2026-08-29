import type { AgentEvent, AgentSnapshot, AgentTransaction } from "./types";

export function mergeAgentSnapshots(current: AgentSnapshot, incoming: AgentSnapshot): AgentSnapshot {
  const events = new Map([...current.events, ...incoming.events].map((event) => [event.cursor, event]));
  return {
    ...incoming,
    cursor: Math.max(current.cursor, incoming.cursor),
    events: [...events.values()]
      .sort((left, right) => left.cursor - right.cursor)
      .slice(-500),
  };
}

export function agentPollCursorAfterSnapshot(
  currentCursor: number,
  incomingCursor: number,
  eventsWereCanonicallyConsumed: boolean,
) {
  return eventsWereCanonicallyConsumed
    ? Math.max(currentCursor, incomingCursor)
    : currentCursor;
}

export function unseenAgentTransactions(events: AgentEvent[], applied: ReadonlySet<string>): AgentTransaction[] {
  return events
    .slice()
    .sort((left, right) => left.cursor - right.cursor)
    .flatMap((event) => event.transaction ? [event.transaction] : [])
    .filter((transaction) => !applied.has(transaction.transaction_id));
}

export type AgentTransactionPlan = {
  apply: AgentTransaction[];
  represented: AgentTransaction[];
  gap: AgentTransaction | null;
};

export function agentBatchMatchesAuthoritativeState(
  plan: AgentTransactionPlan,
  currentStateRevision: string,
  authoritativeStateRevision: string | undefined,
) {
  if (plan.gap || !authoritativeStateRevision) return false;
  const plannedStateRevision = plan.apply.at(-1)?.state_revision ?? currentStateRevision;
  return plannedStateRevision === authoritativeStateRevision;
}

export function planAgentTransactions(
  events: AgentEvent[],
  applied: ReadonlySet<string>,
  currentStateRevision: string,
  authoritativeSnapshotAfterEvents = false,
): AgentTransactionPlan {
  const transactions = unseenAgentTransactions(events, applied);
  if (!transactions.length) return { apply: [], represented: [], gap: null };
  if (authoritativeSnapshotAfterEvents) {
    // The session read was requested only after this complete event batch had
    // arrived. Its accepted graph is therefore the authority even if a later
    // edit reused an older content revision; replaying any batch entry would
    // roll that newer server decision back.
    return { apply: [], represented: transactions, gap: null };
  }

  const represented: AgentTransaction[] = [];
  const apply: AgentTransaction[] = [];
  let nextIndex = transactions.findLastIndex(
    (transaction) => transaction.state_revision === currentStateRevision,
  );
  if (nextIndex >= 0) {
    represented.push(...transactions.slice(0, nextIndex + 1));
    nextIndex += 1;
  } else {
    nextIndex = transactions.findIndex(
      (transaction) => transaction.previous_state_revision === currentStateRevision,
    );
    if (nextIndex < 0) return { apply, represented, gap: transactions[0] };
    // Agent events are a single ordered server log. Earlier unseen entries are
    // already represented when a later transaction starts at our exact state.
    represented.push(...transactions.slice(0, nextIndex));
  }

  let revision = currentStateRevision;
  for (const transaction of transactions.slice(nextIndex)) {
    if (transaction.state_revision === revision) {
      represented.push(transaction);
      continue;
    }
    if (transaction.previous_state_revision !== revision) {
      return { apply, represented, gap: transaction };
    }
    apply.push(transaction);
    revision = transaction.state_revision;
  }
  return { apply, represented, gap: null };
}
