/**
 * Fallback length of turn 0 (seconds) for setups created before
 * `firstTurnTime` existed. The first turn is longer than the rest so players
 * and bots have time to arrive; every other turn uses `setup.maxTurnTime`.
 */
export const FirstMoveTimeoutSeconds = 60
