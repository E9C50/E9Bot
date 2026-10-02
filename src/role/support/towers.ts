import { requestTowerSupport } from 'combat/towers'
export type { TowerSupportOptions } from 'combat/towers'
/** All role callers share the room decision and its per-tick tower intent ledger. */
export const supportWithTowers = requestTowerSupport
