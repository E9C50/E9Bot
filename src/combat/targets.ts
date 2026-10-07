import { CombatSnapshot, CombatUnit, combatPower, combatRange, isCombatHostile, isInvulnerable } from './intelligence'
import { CombatFormation, squadBreachTarget } from './squadMovement'
import { combatTacticsPolicy } from 'settings/combatTactics'
import { creepWhiteList } from 'settings/settings'

export type CombatTarget = CombatUnit | AnyStructure

export function isCombatBarrier(structure: Structure): boolean {
    return structure.structureType === STRUCTURE_WALL || structure.structureType === STRUCTURE_RAMPART
}

/** Barriers are access obstacles, rather than objectives that keep a cleared room alive. */
export function isCombatStructureObjective(structure: Structure, room: Room): boolean {
    if (structure.hits === undefined || structure.hits <= 0 || structure.structureType === STRUCTURE_CONTROLLER ||
        structure.structureType === 'keeperLair' || structure.structureType === 'portal' ||
        isCombatBarrier(structure) || room.controller?.my || room.controller?.owner &&
            creepWhiteList.includes(room.controller.owner.username)) return false
    const owned = structure as Structure & { my?: boolean; owner?: Owner }
    // An explicit room-clearing order also removes unowned roads and containers. General hostility stays unchanged.
    return owned.owner ? isCombatHostile(structure, room) : owned.my !== true
}

/** Every hostile unit belongs to the first stage, including workers and PowerCreeps. */
export function combatAttackObjectives(snapshot: CombatSnapshot, mode: 'attack' | 'hold', room?: Room): CombatTarget[] {
    const enemies = snapshot.enemies.filter(enemy => enemy.hits > 0)
    const remainingEnemies = room ? room.enemies.some(enemy => enemy.hits > 0 && isCombatHostile(enemy, room)) : enemies.length > 0
    if (remainingEnemies) return enemies
    if (mode !== 'attack') return []
    return room ? (room.structures || room.find(FIND_STRUCTURES)).filter(object =>
        isCombatStructureObjective(object, room) && !isInvulnerable(object)) as AnyStructure[] :
        snapshot.structures.filter(object => !isCombatBarrier(object) && object.structureType !== STRUCTURE_CONTROLLER)
}

export function combatProtectedTarget(target: CombatTarget, snapshot: CombatSnapshot): CombatTarget {
    return snapshot.structures.find(candidate => candidate.structureType === STRUCTURE_RAMPART &&
        combatRange(candidate.pos, target.pos) === 0) || target
}

/** These preferences only compare objects within the current clearing stage. */
export function combatTargetPriority(target: CombatTarget): number {
    const policy = combatTacticsPolicy.targeting
    if (!('structureType' in target)) {
        const power = combatPower(target)
        return power.heal > 0 ? policy.healer : power.attack + power.ranged > 0 ? policy.fighter : policy.civilian
    }
    if (target.structureType === STRUCTURE_TOWER) return policy.tower
    if (target.structureType === STRUCTURE_SPAWN || target.structureType === STRUCTURE_INVADER_CORE) return policy.spawnOrCore
    if (isCombatBarrier(target)) return policy.barrier
    return policy.otherStructure
}

/** Follow one route to a real objective; an existing passage always takes precedence over demolition. */
export function selectCombatTarget(members: readonly Creep[], snapshot: CombatSnapshot, mode: 'attack' | 'hold',
    formation: CombatFormation, attackRange: number): CombatTarget | undefined {
    const leader = members[0]
    if (!leader) return undefined
    let selected: CombatTarget | undefined, best = Infinity
    for (const candidate of combatAttackObjectives(snapshot, mode, leader.room)) {
        const protectedCandidate = combatProtectedTarget(candidate, snapshot)
        const score = combatTargetPriority(candidate) * combatTacticsPolicy.targeting.priorityWeight +
            combatRange(leader.pos, candidate.pos) * combatTacticsPolicy.targeting.rangeWeight +
            Math.min(combatTacticsPolicy.targeting.maximumHitsPenalty,
                protectedCandidate.hits / combatTacticsPolicy.targeting.hitsScale)
        if (score < best) { selected = protectedCandidate; best = score }
    }
    if (!selected || mode !== 'attack') return selected
    return squadBreachTarget(members, selected.pos, attackRange, formation) || selected
}
