import { structurePolicy } from 'settings/structures'
import { isDevelopingRoom } from 'creep/development'
import { controllerEnergyBuffer } from 'creep/developmentLogistics'
import { developmentPolicy } from 'settings/development'
export default class LinkExtension extends StructureLink {
    private isSideLink(): boolean {
        return this.pos.x <= structurePolicy.link.edgeMargin || this.pos.x >= 50 - structurePolicy.link.edgeMargin || this.pos.y <= structurePolicy.link.edgeMargin || this.pos.y >= 50 - structurePolicy.link.edgeMargin
    }
    public doWork(): void {
        // Transfer is the only action here. Cooling or empty links cannot supply either receiver.
        if (this.cooldown > 0 || !(this.store[RESOURCE_ENERGY] > 0)) return
        if (isDevelopingRoom(this.room) && this.cooldown === 0 && this.store[RESOURCE_ENERGY] > 0 &&
            this.room.energyAvailable >= Math.min(this.room.energyCapacityAvailable, developmentPolicy.logistics.emergencySpawnEnergy)) {
            const buffer = controllerEnergyBuffer(this.room)
            if (buffer?.structureType === STRUCTURE_LINK && buffer.id !== this.id &&
                buffer.store.getFreeCapacity(RESOURCE_ENERGY) > structurePolicy.link.minimumTargetFreeCapacity &&
                this.transferEnergy(buffer as StructureLink) === OK) return
        }
        const centerLink = this.room.centerLink
        const controllerLink = this.room.controllerLink
        if (centerLink == undefined) return

        // 处理CenterLink的逻辑
        if (this.id == centerLink.id) {
            return
        }

        // 处理ControllerLink的逻辑
        if (controllerLink && this.id == controllerLink.id) {
            return
        }

        // 符合条件就发送能量
        if (centerLink && centerLink.store.getFreeCapacity(RESOURCE_ENERGY) > structurePolicy.link.minimumTargetFreeCapacity) {
            if (this.isSideLink()) {
                if (this.store[RESOURCE_ENERGY] > 0) {
                    this.transferEnergy(centerLink)
                }
            } else {
                if (this.store.getFreeCapacity(RESOURCE_ENERGY) == 0) {
                    this.transferEnergy(centerLink)
                }
            }
        }
    }
}
