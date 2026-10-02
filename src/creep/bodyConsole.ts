import { spawnPriority } from 'settings/creep'
import { previewBodySelection } from './bodySelection'
import { canPrepareBoosts } from './boosting'

function ownedRoom(name: string): Room {
    const room = Game.rooms[name]
    if (!room || !room.controller?.my) throw new Error(`房间 ${name} 不可见或未归自己所有`)
    return room
}

function supportedRole(role: string): CreepRoleConstant {
    if (!Object.prototype.hasOwnProperty.call(spawnPriority, role) || role === 'rAttacker')
        throw new Error(`不支持的角色 ${role}`)
    return role as CreepRoleConstant
}

function validateProfile(input: CreepBodyProfile): CreepBodyProfile {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是对象')
    const result: CreepBodyProfile = {}
    for (const key of Object.keys(input)) {
        const value = input[key]
        if (key === 'boostTier') {
            if (![0, 1, 2, 3].includes(value)) throw new Error('boostTier 必须是 0、1、2、3')
        } else if (key === 'terrain') {
            if (!['road', 'plain', 'swamp'].includes(value)) throw new Error('terrain 必须是 road、plain、swamp')
        } else if (key === 'boostFallback') {
            if (!['unboosted', 'wait'].includes(value)) throw new Error('boostFallback 必须是 unboosted 或 wait')
        } else if (key === 'stationary') {
            if (typeof value !== 'boolean') throw new Error('stationary 必须是布尔值')
        } else if (['workParts', 'carryParts', 'maximumCost', 'combatPrimaryParts', 'combatHealParts', 'combatToughParts'].includes(key)) {
            if (!Number.isFinite(value) || !Number.isInteger(value) || value < (['maximumCost', 'combatHealParts', 'combatToughParts'].includes(key) ? 0 : 1) ||
                (key !== 'maximumCost' && value > MAX_CREEP_SIZE)) throw new Error(`${key} 超出有效范围`)
        } else throw new Error(`未知配置项 ${key}`)
        result[key] = value
    }
    return result
}

/** Settings survive demand refreshes and affect replacements rather than existing bodies. */
export function configureBody(roomName: string, roleName: string, profile?: CreepBodyProfile | null): string {
    try {
        const room = ownedRoom(roomName), role = supportedRole(roleName)
        if (profile === null) {
            if (room.memory.bodyProfiles) delete room.memory.bodyProfiles[role]
        } else if (profile !== undefined) {
            const validated = validateProfile(profile)
            room.memory.bodyProfiles = room.memory.bodyProfiles || {}
            room.memory.bodyProfiles[role] = { ...room.memory.bodyProfiles[role], ...validated }
        }
        return JSON.stringify({ room: roomName, role, profile: room.memory.bodyProfiles?.[role] || {},
            effect: '后续孵化生效；null 恢复默认' }, null, 2)
    } catch (error) { return String(error) }
}

export function previewBodies(roomName: string, roleName: string): string {
    try {
        const room = ownedRoom(roomName), role = supportedRole(roleName)
        const existing = Object.values(room.memory.creepConfig || {}).find(config => config.role === role)
        const sourceId = role === 'miner' ? room.mineral?.id :
            role === 'upgrader' ? room.controllerLink?.id || room.storage?.id : room.sources?.[0]?.id
        const config: CreepMemory = existing || { role, spawnRoom: room.name, data: { sourceId },
            displayName: 'preview', name: 'preview', ready: false, working: false, spawnPriority: spawnPriority[role] }
        const profiles = ([0, 1, 2, 3] as CreepBoostTier[]).map(tier => {
            const plan = previewBodySelection(room, config, tier)
            const parts: Partial<Record<BodyPartConstant, number>> = {}
            let energy = 0
            for (const part of plan.body) { parts[part] = (parts[part] || 0) + 1; energy += BODYPART_COST[part] }
            return { tier, parts, size: plan.body.length, energy,
                canPrepare: plan.body.length > 0 && canPrepareBoosts(room, plan.boostPlan),
                minerals: plan.boostPlan.steps.map(step => ({ ...step,
                    mineral: step.parts * LAB_BOOST_MINERAL, energy: step.parts * LAB_BOOST_ENERGY })) }
        })
        return JSON.stringify({ room: roomName, role, profiles }, null, 2)
    } catch (error) { return String(error) }
}
