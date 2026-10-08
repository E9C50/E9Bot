/** Controller activation is immutable during a tick; store contents and reservations are not. */
let tick = -1, shard = ''
let results = new WeakMap<object, boolean>()

export function isStructureActive(structure: { isActive?: () => boolean }): boolean {
    if (typeof structure.isActive !== 'function') return true
    const currentShard = Game.shard?.name || ''
    if (tick !== Game.time || shard !== currentShard) {
        tick = Game.time; shard = currentShard; results = new WeakMap()
    }
    const previous = results.get(structure)
    if (previous !== undefined) return previous
    const active = structure.isActive()
    results.set(structure, active)
    return active
}
