import { cpuRecoveryWorkDue, hasPendingRoomBoost, isCpuRecoveryActive } from 'runtime/cpuRecovery'

function work(structure: Structure | undefined): void {
    if (structure != undefined && typeof structure.doWork === 'function') structure.doWork()
}

export const structureWorkController = function (): void {
    for (const roomName in Game.rooms) {
        const room: Room = Game.rooms[roomName];
        if (!room.my) continue;

        for (const tower of room.towers) work(tower)
        const reactionsDue = !isCpuRecoveryActive() || hasPendingRoomBoost(room) || cpuRecoveryWorkDue(room.name, 'labReaction')
        for (const lab of room.labs) {
            if (reactionsDue || room.memory.roomLabConfig.singleLabConfig[lab.id]?.boostMode === true) work(lab)
        }
        for (const spawn of room.spawns) work(spawn)
        for (const link of room.links) work(link)
        if (cpuRecoveryWorkDue(room.name, 'powerSpawn')) work(room.powerSpawn)
        if (cpuRecoveryWorkDue(room.name, 'factory')) work(room.factory)
    }
}
