import { sha1String } from 'utils'
import { spawnPriority, warModeRole } from 'settings/creep'
import { isRoleSupported } from 'role'
import { populationPolicy } from 'settings/population'

// Demand refreshes reuse the same names; retain only immutable hashes, never live Creep objects.
const names = new Map<string, string>()

export function createCreepName(role: CreepRoleConstant, name: string): string {
    const configured = populationPolicy.maximumNameCacheEntries
    const maximum = Number.isSafeInteger(configured) && configured > 0 ? configured : 0
    while (names.size > maximum) names.delete(names.keys().next().value!)
    const key = `${role}\0${name}`
    const previous = names.get(key)
    if (previous !== undefined) return previous
    const result = role.toUpperCase() + '_' + sha1String(name)
    if (maximum > 0) {
        if (names.size >= maximum) names.delete(names.keys().next().value!)
        names.set(key, result)
    }
    return result
}

/**
 *  添加需求配置
 * @param room
 * @param creepRole
 * @param creepName
 * @param creepMemory
 * @returns
 */
export function addCreepConfig(
    room: Room,
    creepRole: CreepRoleConstant,
    creepName: string,
    creepData: CreepData = {},
    isTeam: boolean = false
): string {
    if (Memory.warMode?.[room.name] && !warModeRole.includes(creepRole))
        return ''
    if (!isRoleSupported(creepRole)) return ''
    const creepNameHash = createCreepName(creepRole, creepName)
    const priority = spawnPriority[creepRole]
    room.memory.creepConfig[creepNameHash] = {
        displayName: creepNameHash,
        name: creepName,
        role: creepRole,
        isTeam: isTeam,
        working: false,
        ready: false,
        spawnRoom: room.name,
        spawnPriority: priority,
        data: creepData,
    }
    return creepNameHash
}
