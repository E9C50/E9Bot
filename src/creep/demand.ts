import { sha1String } from 'utils'
import { spawnPriority, warModeRole } from 'settings/creep'
import { isRoleSupported } from 'role'

export function createCreepName(role: CreepRoleConstant, name: string): string {
    return role.toUpperCase() + '_' + sha1String(name)
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
