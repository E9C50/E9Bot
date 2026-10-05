import { plannedRoomBlueprint, snapshotRoomBlueprint, synchronizeBlueprintMetadata } from 'planning/blueprint'
import { buildMissingStructures, ConstructionBudget } from 'planning/construction'
import { computeRoomBlueprint } from 'planning/planner63'
import { constructionPolicy } from 'settings/construction'
import { roomPolicy } from 'settings/roomPolicy'
import { migrateControllerContainer } from './controllerContainerMigration'
import { roomWorkDue } from 'runtime/roomSchedule'
import { cleanupSourceLinkContainers } from './sourceLinkContainers'

let tick = -1
let planningAttempts = 0
let constructionBudget: ConstructionBudget | undefined

function prepareTick(): void {
    if (tick == Game.time) return
    tick = Game.time
    planningAttempts = 0
    constructionBudget = undefined
}

/** 已占领房间首次规划/快照，此后只消费持久蓝图，升级及建筑损毁不触发重规划。 */
export function runAutomaticLayout(room: Room): void {
    if (!constructionPolicy.enabled || !room.controller?.my || room.memory.autoLaylout === false) return
    prepareTick()
    const state = room.memory.roomBlueprintState || (room.memory.roomBlueprintState = {})
    if (state.ownedSince == undefined) state.ownedSince = Game.time
    let blueprint = room.memory.roomBlueprint
    const fresh = blueprint == undefined
    if (blueprint == undefined && room.controller.level == 8) {
        blueprint = snapshotRoomBlueprint(room)
        room.memory.roomBlueprint = blueprint
    }
    if (blueprint == undefined) {
        const policy = constructionPolicy.planning
        if (planningAttempts >= policy.maximumRoomsPerTick || Game.cpu.bucket < policy.minimumBucket ||
            (state.lastPlanAttempt != undefined && Game.time - state.lastPlanAttempt < policy.retryInterval)) return
        const headroom = Game.cpu.tickLimit - Game.cpu.getUsed()
        if (headroom < policy.minimumCpuHeadroom) return
        planningAttempts++
        state.lastPlanAttempt = Game.time
        try {
            const existingStorage = room.find(FIND_MY_STRUCTURES).find((item) => item.structureType == STRUCTURE_STORAGE)
            const result = computeRoomBlueprint(room, {
                minimumPlaneCount: policy.minimumPlaneCount,
                maximumCpu: Math.min(policy.maximumCpu, headroom - policy.cpuReserve),
                storagePosition: existingStorage == undefined ? undefined : {
                    x: existingStorage.pos.x + 1, y: existingStorage.pos.y,
                },
            })
            if (result != undefined) blueprint = plannedRoomBlueprint(room, result)
            if (blueprint == undefined) {
                state.lastError = '63bot planner found no viable layout'
                return
            }
            room.memory.roomBlueprint = blueprint
            delete state.lastError
        } catch (error) {
            state.lastError = error instanceof Error ? error.message : String(error)
            console.log(`[layout] ${room.name}: ${state.lastError}`)
            return
        }
    }
    const flag = Game.flags[roomPolicy.flags.planStructures]
    const forced = flag != undefined && flag.pos.roomName == room.name
    const levelChanged = state.lastLevel != room.controller.level
    const noSpawn = (room.spawns?.length ?? room.find(FIND_MY_SPAWNS).length) == 0
    const matureInspection = !fresh && room.controller.level == 8 && !levelChanged && !forced && !noSpawn
    // Peaceful mature rooms retain their snapshot; defer optional inspections while recovering CPU.
    if (matureInspection && state.lastBuildTick != undefined) {
        const policy = constructionPolicy.building
        const low = policy.lowBucketInspection
        const interval = low != undefined && Game.cpu.bucket < low.minimumBucket &&
            !Memory.warMode?.[room.name] && (room.enemies?.length ?? 0) == 0 ? Math.max(policy.interval, low.interval) : policy.interval
        const elapsed = Game.time - state.lastBuildTick
        const phaseDue = policy.staggerMatureInspections === true && roomWorkDue(room.name, interval)
        const minimumDelay = interval == policy.interval && policy.staggerMatureInspections === true ? 1 : policy.interval
        // Allow the first phase to align early, then keep a bounded interval even after missed ticks.
        if (elapsed < minimumDelay || (elapsed < interval && !phaseDue)) return
    }
    let controllerChanged = false
    try {
        controllerChanged = migrateControllerContainer(room, blueprint)
        if (controllerChanged) delete state.lastError
    } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error)
        console.log(`[layout] ${room.name}: controller container migration: ${state.lastError}`)
    }
    synchronizeBlueprintMetadata(room, blueprint)
    if (!matureInspection && !fresh && !controllerChanged && !levelChanged && !forced && !noSpawn && state.lastBuildTick != undefined &&
        Game.time - state.lastBuildTick < constructionPolicy.building.interval) return
    cleanupSourceLinkContainers(room)
    if (constructionBudget == undefined) constructionBudget = {
        remaining: Math.max(0, MAX_CONSTRUCTION_SITES - Object.keys(Game.constructionSites).length),
        intents: new Map(),
    }
    buildMissingStructures(room, blueprint, constructionBudget)
    state.lastBuildTick = Game.time
    state.lastLevel = room.controller.level
}
