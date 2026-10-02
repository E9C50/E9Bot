import { getDistance } from "utils";
import { rolePolicy } from 'settings/rolePolicy'

export default class PowerCreepExtension extends PowerCreep {
    /**
     * 拿取OPS
     */
    public takeOps(): void {
        var takeTarget: AnyStoreStructure | undefined = undefined
        if (this.room == undefined) return
        if (this.room.storage != undefined && this.room.storage.store[RESOURCE_OPS] > 0) {
            takeTarget = this.room.storage
        }
        if (this.room.terminal != undefined && this.room.terminal.store[RESOURCE_OPS] > 0) {
            takeTarget = this.room.terminal
        }

        if (takeTarget == undefined) return
        if (getDistance(this.pos, takeTarget.pos) <= 1) {
            const amount = this.store.getFreeCapacity() * rolePolicy.powerCreep.takeOpsFreeCapacityRatio
            this.withdraw(takeTarget, RESOURCE_OPS, amount)
        } else {
            this.moveTo(takeTarget)
        }
    }

    /**
     * 存放OPS
     */
    public saveOps(): void {
        if (this.room == undefined || this.room.storage == undefined) return
        if (getDistance(this.pos, this.room.storage.pos) <= 1) {
            const amount = this.store[RESOURCE_OPS] * rolePolicy.powerCreep.saveOpsAmountRatio
            this.transfer(this.room.storage, RESOURCE_OPS, amount)
        } else {
            this.moveTo(this.room.storage)
        }
    }

    /**
     * 技能是否可用
     * @param power
     * @returns
     */
    public isPowerAvailable(power: PowerConstant): boolean {
        return this.room != undefined && this.room.controller != undefined && this.room.controller.isPowerEnabled
            && this.powers[power] != undefined && this.powers[power].level > 0 && this.powers[power].cooldown == 0
    }

    /**
     * 房间内是否有可用的OPS
     * @returns
     */
    public isRoomHaveOps(): boolean {
        return this.room != undefined && (
            (this.room.storage != undefined && this.room.storage.store[RESOURCE_OPS] > 0)
            || (this.room.terminal != undefined && this.room.terminal.store[RESOURCE_OPS] > 0)
        )
    }
}
