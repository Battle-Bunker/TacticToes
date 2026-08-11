/**
 * Fallback length of turn 0 (seconds) when a setup has no `firstTurnTime`.
 * The first turn is longer than the rest so centaurs have time to arrive;
 * every other turn uses `setup.maxTurnTime`.
 */
export const FirstMoveTimeoutSeconds = 60
