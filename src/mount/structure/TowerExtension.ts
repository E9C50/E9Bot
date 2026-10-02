import { structurePolicy } from 'settings/structures'
import { runRoomTowerDefense } from 'combat/towers'
export default class TowerExtension extends StructureTower {
    public init(): void {
        if (!this.room.memory.roomFillJob.tower) this.room.memory.roomFillJob.tower = []
        if (this.store.getFreeCapacity(RESOURCE_ENERGY) > structurePolicy.tower.refillFreeCapacity && !this.room.memory.roomFillJob.tower.includes(this.id)) {
            this.room.memory.roomFillJob.tower.push(this.id)
        }
    }

    public doWork(): void {
        runRoomTowerDefense(this.room)
    }
}
