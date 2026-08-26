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

export function unseenAgentTransactions(events: AgentEvent[], applied: ReadonlySet<string>): AgentTransaction[] {
  return events
    .slice()
    .sort((left, right) => left.cursor - right.cursor)
    .flatMap((event) => event.transaction ? [event.transaction] : [])
    .filter((transaction) => !applied.has(transaction.transaction_id));
}
