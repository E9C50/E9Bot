import { combatSnapshot, combatPower } from './intelligence'
import { populationPolicy } from 'settings/population'
import { roomPolicy } from 'settings/roomPolicy'
import { combatDefensePolicy } from 'settings/combatDefense'

type CombatUnit = Creep | PowerCreep
export interface DefenseGroup { key: string; enemies: CombatUnit[]; target: CombatUnit; damage: number; ranged: number; claim: number }
interface PreviousGroup { key: string; ids: Set<string>; target: string }
const previous = new Map<string, { tick: number; groups: PreviousGroup[] }>()
let cachedTick: number | undefined, cachedShard: string | undefined
let cache = new WeakMap<Room, DefenseGroup[]>()

function connectedGroups(enemies: CombatUnit[]): CombatUnit[][] {
    if (enemies.length <= 1) return enemies.map(enemy => [enemy])
    const radius = Math.max(0, Math.floor(populationPolicy.defense.enemyGroupRange))
    if (enemies.length === 2) return Math.max(Math.abs(enemies[0].pos.x - enemies[1].pos.x), Math.abs(enemies[0].pos.y - enemies[1].pos.y)) <= radius ?
        [enemies.slice()] : enemies.map(enemy => [enemy])
    const tiles = new Map<number, CombatUnit[]>(), claimed = new Set<CombatUnit>(), result: CombatUnit[][] = []
    for (const enemy of enemies) {
        const key = enemy.pos.y * 50 + enemy.pos.x
        const occupants = tiles.get(key)
        if (occupants == undefined) tiles.set(key, [enemy])
        else occupants.push(enemy)
    }
    for (const enemy of enemies) {
        if (claimed.has(enemy)) continue
        const group = [enemy]; claimed.add(enemy)
        for (let index = 0; index < group.length; index++) {
            const pos = group[index].pos
            for (let x = Math.max(0, pos.x - radius); x <= Math.min(49, pos.x + radius); x++) {
                for (let y = Math.max(0, pos.y - radius); y <= Math.min(49, pos.y + radius); y++) {
                    const key = y * 50 + x, occupants = tiles.get(key)
                    if (occupants == undefined) continue
                    tiles.delete(key)
                    for (const candidate of occupants) if (!claimed.has(candidate)) { claimed.add(candidate); group.push(candidate) }
                }
            }
        }
        result.push(group)
    }
    return result
}

/** Connected enemies retain identity through movement, deaths and input-order changes. */
export function defenseGroups(room: Room): DefenseGroup[] {
    if (cachedTick !== Game.time || cachedShard !== Game.shard?.name) {
        cachedTick = Game.time; cachedShard = Game.shard?.name; cache = new WeakMap()
        for (const [key, value] of previous) if (Game.time - value.tick > combatDefensePolicy.guards.groupMemoryTicks) previous.delete(key)
    }
    const cached = cache.get(room)
    if (cached != undefined) return cached
    const enemies = combatSnapshot(room).enemies.filter(enemy => !roomPolicy.defense.npcOwners.includes(enemy.owner.username))
    const old = previous.get(`${cachedShard}:${room.name}`)?.groups || []
    const occupied = new Set<string>(), result: DefenseGroup[] = []
    for (const group of connectedGroups(enemies)) {
        let selected: PreviousGroup | undefined, maximum = 0
        for (const candidate of old) {
            if (occupied.has(candidate.key)) continue
            let matches = 0
            for (const enemy of group) if (candidate.ids.has(enemy.id)) matches++
            if (matches > maximum) { maximum = matches; selected = candidate }
        }
        let key = selected?.key || group.reduce((first, enemy) => enemy.id < first ? enemy.id : first, group[0].id)
        if (occupied.has(key)) key += ':' + group[0].id
        occupied.add(key)
        let target = group.find(enemy => enemy.id === selected?.target) || group[0]
        let damage = 0, ranged = 0, claim = 0, highest = -1
        for (const enemy of group) {
            const power = combatPower(enemy)
            damage += power.attack + power.ranged + power.dismantle
            ranged += power.ranged; claim += power.claim
            const threat = power.attack + power.ranged + power.dismantle + power.claim * combatDefensePolicy.threat.claimWeight
            if (selected == undefined && threat > highest) { highest = threat; target = enemy }
        }
        if (damage > 0 || claim > 0) result.push({ key, enemies: group, target, damage, ranged, claim })
    }
    previous.set(`${cachedShard}:${room.name}`, { tick: Game.time, groups: result.map(group => ({ key: group.key, ids: new Set(group.enemies.map(enemy => enemy.id)), target: group.target.id })) })
    cache.set(room, result)
    return result
}
