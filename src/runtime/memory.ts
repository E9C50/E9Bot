const emptyObjectFields = new Set([
    'creepConfig', 'terminalSendJob', 'terminalAmount', 'roomStructure',
    'restrictedPos', 'roomPosition', 'teamConfig', 'boostNeed',
])
const emptyLabJobs = new Set(['labInMineral', 'labOut', 'labInEnergy'])

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.prototype.toString.call(value) === '[object Object]'
}
function emptyObject(value: unknown): boolean {
    return isObject(value) && Object.keys(value).length === 0
}
function emptyArray(value: unknown): boolean {
    return Array.isArray(value) && value.length === 0 && Object.keys(value).length === 0
}
function onlyInitializedEmptyFields(value: unknown): boolean {
    if (!isObject(value)) return false
    for (const key of Object.keys(value)) {
        const field = value[key]
        if (emptyObjectFields.has(key)) {
            if (!emptyObject(field)) return false
        } else if (key === 'creepSpawnQueue') {
            if (!emptyArray(field)) return false
        } else if (key === 'roomLabConfig') {
            if (!isObject(field) || Object.keys(field).length !== 1 || !emptyObject(field.singleLabConfig)) return false
        } else if (key === 'roomFillJob') {
            if (!isObject(field) || !Object.prototype.hasOwnProperty.call(field, 'labInMineral')) return false
            for (const job of Object.keys(field)) if (!emptyLabJobs.has(job) || !emptyArray(field[job])) return false
        } else return false
    }
    return true
}

/** 原生 Memory 首次解析归入 tick:memory；仅清除不可见、无旗子、只有规范空派生字段的历史房间整条记录。 */
export function loadMemory(): void {
    const rooms = Memory.rooms
    if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms)) return
    const visible = Game.rooms || {}
    const flagged = new Set<string>()
    for (const name in Game.flags || {}) {
        const roomName = Game.flags[name].pos?.roomName
        if (roomName) flagged.add(roomName)
    }
    for (const name in rooms) {
        if (visible[name] || flagged.has(name) || !onlyInitializedEmptyFields(rooms[name])) continue
        delete rooms[name]
    }
}
