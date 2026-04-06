export const PHASE_REACTION_BY_PHASE = {
  received: 'OnIt',
  enriching: 'Eye',
  queued: 'Hourglass',
  executing: 'Runner',
  cancelled: null,
  completed: null,
} as const;

export type LarkTaskPhase = keyof typeof PHASE_REACTION_BY_PHASE;

export function isLarkTaskPhase(value: unknown): value is LarkTaskPhase {
  return typeof value === 'string' && value in PHASE_REACTION_BY_PHASE;
}

export function getReactionForPhase(phase: LarkTaskPhase): string | null {
  return PHASE_REACTION_BY_PHASE[phase];
}

export function getPhaseReactionTypes(): string[] {
  const values = Object.values(PHASE_REACTION_BY_PHASE);
  const reactionTypes: string[] = [];

  for (const value of values) {
    if (typeof value === 'string') {
      reactionTypes.push(value);
    }
  }

  return Array.from(new Set(reactionTypes));
}

const PHASE_ORDER: Readonly<Record<LarkTaskPhase, number>> = {
  received: 0,
  enriching: 1,
  queued: 2,
  executing: 3,
  cancelled: 4,
  completed: 5,
};

export function compareLarkTaskPhases(a: LarkTaskPhase, b: LarkTaskPhase): number {
  return PHASE_ORDER[a] - PHASE_ORDER[b];
}
