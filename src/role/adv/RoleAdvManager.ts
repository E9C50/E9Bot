import { getDistance } from "utils"
import { rolePolicy } from "settings/rolePolicy"
import { resourcePolicy } from "settings/resourcePolicy"
import { runFactoryLogistics } from "room/factory"
import { getEvacuationIncomingCapacity, reserveEvacuationIncoming } from "room/evacuation"
import { getTerminalResourceAmount, recordTerminalWithdrawal } from "room/resourceNetwork"

function terminalGoal(room: Room, resource: ResourceConstant): number {
    const amount = room.memory.terminalAmount?.[resource] || 0
    return resource === RESOURCE_ENERGY ? Math.max(resourcePolicy.terminalEnergyReserve, amount) : amount
}

export default (data: CreepData): ICreepConfig => ({
    isNeed: (room: Room, creepName: string) => {
        return room.storage != undefined && (room.centerLink != undefined || room.terminal != undefined)
    },
    prepare(creep) {
        // 如果不在目标位置则移动
        if (!creep.memory.ready || Game.time % rolePolicy.manager.positionCheckInterval == 0) {
            creep.memory.ready = false
            var managerPos: RoomPosition = creep.room.memory.roomPosition.managerPos as RoomPosition
            if (managerPos != undefined) {
                managerPos = new RoomPosition(managerPos.x, managerPos.y, managerPos.roomName)
                if (!creep.pos.isEqualTo(managerPos)) {
                    creep.moveTo(managerPos)
                    return false
                } else {
                    creep.memory.ready = true
                    return true
                }
            } else {
                if (creep.room.storage != undefined && getDistance(creep.pos, creep.room.storage.pos) > 1) {
                    creep.moveTo(creep.room.storage)
                    return false
                } else if (creep.room.centerLink != undefined && getDistance(creep.pos, creep.room.centerLink.pos) > 1) {
                    creep.moveTo(creep.room.centerLink)
                    return false
                } else if (creep.room.terminal != undefined && getDistance(creep.pos, creep.room.terminal.pos) > 1) {
                    creep.moveTo(creep.room.terminal)
                    return false
                } else {
                    creep.memory.ready = true
                    return true
                }
            }
        } else {
            return true
        }
    },
    source(creep) {
        creep.memory.working = true
        return true
    },
    target(creep) {
        creep.memory.dontPullMe = true;
        if (creep.room.memory.restrictedPos != undefined) {
            creep.room.memory.restrictedPos[creep.name] = creep.pos;
        }

        if (creep.room.storage == undefined) {
            return false
        }

        const room = creep.room
        const storage = room.storage!
        const terminal = room.terminal
        const terminalFree = (): number => terminal ? getEvacuationIncomingCapacity(room) : 0
        if (room.memory.terminalAmount === undefined) room.memory.terminalAmount = {}
        room.memory.terminalAmount[RESOURCE_ENERGY] = terminalGoal(room, RESOURCE_ENERGY)

        // Complete a factory delivery before normal cargo handling can return its reagents to storage.
        if (creep.memory.factoryLogistics && runFactoryLogistics(creep, true)) return true

        if (creep.store.getUsedCapacity() > 0) {
            const resources = Object.keys(creep.store) as ResourceConstant[]
            resources.sort((a, b) => Number(b === RESOURCE_ENERGY) - Number(a === RESOURCE_ENERGY))
            for (const resource of resources) {
                const carried = creep.store[resource] || 0
                if (carried <= 0) continue
                if (terminal) {
                    const amount = Math.min(carried, terminalGoal(room, resource) - getTerminalResourceAmount(room, resource),
                        terminalFree())
                    if (amount > 0) {
                        if (creep.transfer(terminal, resource, amount) === OK) reserveEvacuationIncoming(room, amount)
                        return true
                    }
                }
                const amount = Math.min(carried, storage.store.getFreeCapacity())
                if (amount > 0) { creep.transfer(storage, resource, amount); return true }
            }
            return true
        }

        const capacity = creep.store.getFreeCapacity()
        const clearTerminal = (): boolean => {
            if (!terminal || storage.store.getFreeCapacity() <= 0) return false
            // Free mineral space first when the energy reserve cannot fit in the terminal.
            const resources = Object.keys(terminal.store) as ResourceConstant[]
            resources.sort((a, b) => Number(a === RESOURCE_ENERGY) - Number(b === RESOURCE_ENERGY))
            for (const resource of resources) {
                const amount = Math.min(getTerminalResourceAmount(room, resource) - terminalGoal(room, resource),
                    capacity, storage.store.getFreeCapacity())
                if (amount > 0) {
                    if (creep.withdraw(terminal, resource, amount) === OK) recordTerminalWithdrawal(room, resource, amount)
                    return true
                }
            }
            return false
        }

        if (terminal) {
            const energyDeficit = terminalGoal(room, RESOURCE_ENERGY) - getTerminalResourceAmount(room, RESOURCE_ENERGY)
            if (energyDeficit > 0) {
                if (terminalFree() < Math.min(capacity, energyDeficit) && clearTerminal()) return true
                const source = room.centerLink && room.centerLink.store[RESOURCE_ENERGY] > 0 ? room.centerLink : storage
                const amount = Math.min(energyDeficit, capacity, source.store[RESOURCE_ENERGY] || 0,
                    terminalFree())
                if (amount > 0) { creep.withdraw(source, RESOURCE_ENERGY, amount); return true }
            }
        }

        const drainLink = (): boolean => {
            if (!room.centerLink) return false
            const amount = Math.min(room.centerLink.store[RESOURCE_ENERGY] || 0, capacity, storage.store.getFreeCapacity())
            if (amount <= 0) return false
            creep.withdraw(room.centerLink, RESOURCE_ENERGY, amount)
            return true
        }
        // Batch link intake while keeping almost-full links flowing during long terminal jobs.
        if (room.centerLink && room.centerLink.store[RESOURCE_ENERGY] >=
            room.centerLink.store.getCapacity(RESOURCE_ENERGY) * rolePolicy.manager.linkDrainRatio && drainLink()) return true

        if (clearTerminal()) return true
        if (terminal) {
            for (const resource of Object.keys(room.memory.terminalAmount) as ResourceConstant[]) {
                const amount = Math.min(terminalGoal(room, resource) - getTerminalResourceAmount(room, resource), capacity,
                    storage.store[resource] || 0, terminalFree())
                if (amount > 0) { creep.withdraw(storage, resource, amount); return true }
            }
        }

        if (runFactoryLogistics(creep, true)) return true
        if (drainLink()) return true

        return true
    },
})
