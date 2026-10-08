/** Only a room with no ordinary owned creep may restart using a partial Spawn energy pool. */
export function needsEmergencyBody(room: Room, _role?: CreepRoleConstant): boolean {
    for (const name in Game.creeps) {
        const creep = Game.creeps[name]
        if (creep.room && creep.room.name === room.name) return false
    }
    return true
}
