export interface RoomEvacuationTask {
    targetRoom: string
    status: 'draining' | 'waiting' | 'complete'
    createdAt: number
    updatedAt: number
    lastMessage: string
    sent: { [resource: string]: number }
    energySpent: number
    carriers: string[]
    lastSentTick?: number
    emptySince?: number
    blocked: { id: string; until: number }[]
    pending?: { tick: number; description: string; resource: ResourceConstant; requestedAmount: number; energyMultiplier: number }
    staging?: { [creep: string]: boolean }
    helperDemands?: { logicalName: string; name: string }[]
    nextHelper?: number
    spawnPoolDrain?: { tick: number; spawnIds: string[]; observedAt?: number; energy?: number }
}

/** A completed evacuation stays frozen until cancelled or unclaimed. */
export function isRoomEvacuating(room: Room | string | undefined): boolean {
    if (room === undefined) return false
    const memory = typeof room === 'string' ? typeof Memory === 'undefined' ? undefined : Memory.rooms?.[room] : room.memory
    return memory?.evacuation !== undefined
}
