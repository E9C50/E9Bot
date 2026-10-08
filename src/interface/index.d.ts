declare module NodeJS {
    // 全局对象
    interface Global {
        BetterMove: {
            deletePathInRoom: (roomName: string) => boolean
            creepPathCache?: Record<string, import('../utils/cachedMovement').CachedMovementPath>
            getNextCachedStep?: (creep: Creep) => import('../utils/cachedMovement').CachedMovementStep | undefined
        }
    }
}

interface Memory {
    centerStorage: string
    warMode: { [room: string]: boolean }
}

interface Structure {
    init(): void
    doWork(): void
}

interface StructureLab {
    init(boostPaused?: boolean): void
    doWork(boostPaused?: boolean): void
}
