import { resourcePolicy } from 'settings/resourcePolicy'

let tick = -1, shard = ''
const withdrawn = new Map<string | AnyStoreStructure, number>()
function reservations(): Map<string | AnyStoreStructure, number> {
    const currentShard = Game.shard?.name || ''
    if (tick !== Game.time || shard !== currentShard) {
        tick = Game.time; shard = currentShard; withdrawn.clear()
    }
    return withdrawn
}

/** Native sends, transaction fees and local withdrawals share one pending energy debit. */
export function committedTerminalEnergy(terminal: AnyStoreStructure): number {
    return reservations().get(terminal.id || terminal) || 0
}

/** Every local carrier shares successful native intents before Store changes next tick. */
export function availableTerminalEnergy(terminal: AnyStoreStructure): number {
    return Math.max(0, (terminal.store[RESOURCE_ENERGY] || 0) - resourcePolicy.terminalEnergyReserve - committedTerminalEnergy(terminal))
}

export function recordTerminalEnergyWithdrawal(terminal: AnyStoreStructure, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return
    const ledger = reservations()
    const key = terminal.id || terminal
    ledger.set(key, (ledger.get(key) || 0) + amount)
}
