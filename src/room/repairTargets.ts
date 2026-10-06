/** Repair demand and retirement share the same native ownership test. */
export function hasOwnedRamparts(room: Room): boolean {
    return room.ramparts?.some(rampart => rampart.my !== false) === true
}
