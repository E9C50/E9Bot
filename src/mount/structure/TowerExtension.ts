import { structurePolicy } from 'settings/structures'
import { runRoomTowerDefense } from 'combat/towers'
export default class TowerExtension extends StructureTower {
    public init(): void {
        const jobs = this.room.memory.roomFillJob
        const queued = jobs.tower || (jobs.tower = [])
        if (queued.includes(this.id)) return
        // Native scalar aliases avoid constructing a Store/Proxy for every full
        // peaceful tower. Use its actual capacity, including private-server values.
        const energy = this.energy, capacity = this.energyCapacity
        const free = typeof energy === 'number' && typeof capacity === 'number' ?
            capacity - energy : this.store.getFreeCapacity(RESOURCE_ENERGY)
        if (free > structurePolicy.tower.refillFreeCapacity) queued.push(this.id)
    }

    public doWork(): void {
        runRoomTowerDefense(this.room)
    }
}
