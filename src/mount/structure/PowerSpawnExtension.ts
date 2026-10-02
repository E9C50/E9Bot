import { structurePolicy } from 'settings/structures'
export default class PowerSpawnExtension extends StructurePowerSpawn {
    public init(): void {
        if (!this.room.memory.roomFillJob.powerSpawnEnergy && this.store.getFreeCapacity(RESOURCE_ENERGY) > structurePolicy.powerSpawn.refillEnergyFreeCapacity) {
            this.room.memory.roomFillJob.powerSpawnEnergy = true
        }
        if (!this.room.memory.roomFillJob.powerSpawnPower && this.store.getFreeCapacity(RESOURCE_POWER) > structurePolicy.powerSpawn.refillPowerFreeCapacity) {
            this.room.memory.roomFillJob.powerSpawnPower = true
        }
    }
    public doWork(): void {
        if (this.room.storage != undefined && this.room.storage.store[RESOURCE_ENERGY] > structurePolicy.powerSpawn.minimumStorageEnergy &&
            this.store[RESOURCE_ENERGY] >= POWER_SPAWN_ENERGY_RATIO && this.store[RESOURCE_POWER] >= 1) {
            this.processPower()
        }
    }
}
