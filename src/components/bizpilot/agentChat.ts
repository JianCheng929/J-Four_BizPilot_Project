import { useBizPilot } from '@/lib/store';
import type { AgentTask } from '@/lib/db/types';

export const ACTIVE: AgentTask['status'][] = ['starting', 'running', 'waiting_permission'];

/** Open a chat in Command Centre from any page (App listens for this). */
export function openAgentChat(conversationId: string) {
  try { sessionStorage.setItem('bp.openChat', conversationId); } catch { /* optional */ }
  window.dispatchEvent(new CustomEvent('bizpilot:open-chat', { detail: conversationId }));
}

/** The chat BizPilot is working in right now, if any. */
export function useActiveAgentTask() {
  const { db } = useBizPilot();
  return db.agentTasks.find((t) => ACTIVE.includes(t.status)) ?? null;
}
