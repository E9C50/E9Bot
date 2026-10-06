/**
 * 角色与编队行为策略。修改后重新构建上传即可生效，默认值保持原有行为。
 * 时间单位为 tick，距离单位为房间格，比例范围为 0..1。
 * Memory 字段、角色名和旗帜命名是持久化协议，不在这里重命名。
 */
export const rolePolicy = {
    harvester: {
        workWhenFreeCapacityAtMost: 20,
        stopCreatingContainersAtLevel: 8
    },
    filler: { droppedResourceSearchRange: 40 },
    builder: {
        emergencyRampartHits: 5000,
        emergencyRampartRange: 3
    },
    repairer: {
        minimumRampartWorkers: 1,
        firstRampartWorkerPriority: 3.5,
        rampartWorkerWorkParts: 1,
        minimumStorageEnergy: 10000,
        boostAtLevel: 8,
        cpuMaintenance: { minimumBucket: 1000, interval: 5, criticalHits: 100000 }
    },
    scout: {
        flagApproachRange: 3
    },
    manager: { positionCheckInterval: 10 },
    processer: {
        minimumRoomLevel: 7,
        powerWithdrawBatch: 90
    },
    reserver: { renewBelowTicks: 4800 },
    remoteBuilder: {
        sourceSearchRange: 3,
        stopUpgradingAtLevel: 8
    },
    remoteFiller: {
        droppedResourceSearchRange: 50,
        preferStorageAtLevel: 8,
        powerBankWaitingRange: 5,
        sourceWaitingRange: 3
    },
    combat: {
        towerHealInterval: 10,
        defenderTowerSupportRange: 5,
        integrateEnemySearchRange: 10,
        integrateRetreatRange: 3,
        controllerAttackStopAboveBlockedTicks: 700,
        attacker: { targetUsername: 'Avarice', enemySearchRange: 20 }
    },
    duo: { retreatBelowHealthRatio: 0.6 },
    powerCreep: {
        renewAtOrBelowTicks: 500,
        stopRenewAtOrAboveTicks: 4900,
        effectRefreshBelowTicks: 10,
        takeOpsAtOrBelowAmount: 200,
        saveOpsBelowFreeCapacity: 10,
        takeOpsFreeCapacityRatio: 0.5,
        saveOpsAmountRatio: 0.5,
        refillExtensionsBelowEnergyRatio: 0.6,
        travel: { swampCost: 1, plainCost: 1 }
    }
}
