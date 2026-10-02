/** Local, module-scoped equivalent of 63bot/default/class_RoomArray.js. */
export class RoomArray {
    public arr: Array<number | string> = new Array(50 * 50).fill(0)

    public constructor(private readonly checkWork?: () => void) {}

    public init(): this {
        this.arr.fill(0)
        return this
    }

    public get(x: number, y: number): number | string | undefined {
        if (x < 0 || y < 0 || x >= 50 || y >= 50) return undefined
        return this.arr[x * 50 + y]
    }

    public set(x: number, y: number, value: number | string): void {
        if (x >= 0 && y >= 0 && x < 50 && y < 50) this.arr[x * 50 + y] = value
    }

    public exec(x: number, y: number, value: number | string): number | string | undefined {
        const previous = this.get(x, y)
        this.set(x, y, value)
        return previous
    }

    public forEach(callback: (x: number, y: number, value: number | string | undefined) => void): void {
        this.checkWork?.()
        for (let y = 0; y < 50; y++) {
            for (let x = 0; x < 50; x++) callback(x, y, this.get(x, y))
        }
        this.checkWork?.()
    }

    public for4Direction(callback: (x: number, y: number, value: number | string | undefined) => void,
        x: number, y: number): void {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx
            const ny = y + dy
            if (nx >= 0 && ny >= 0 && nx < 50 && ny < 50) callback(nx, ny, this.get(nx, ny))
        }
    }

    public forNear(callback: (x: number, y: number, value: number | string | undefined) => void,
        x: number, y: number, range = 1): void {
        for (let dx = -range; dx <= range; dx++) {
            for (let dy = -range; dy <= range; dy++) {
                const nx = x + dx
                const ny = y + dy
                if ((dx || dy) && nx >= 0 && ny >= 0 && nx < 50 && ny < 50) callback(nx, ny, this.get(nx, ny))
            }
        }
    }

    public forBorder(callback: (x: number, y: number, value: number | string | undefined) => void): void {
        for (let y = 0; y < 50; y++) {
            callback(0, y, this.get(0, y))
            callback(49, y, this.get(49, y))
        }
        for (let x = 1; x < 49; x++) {
            callback(x, 0, this.get(x, 0))
            callback(x, 49, this.get(x, 49))
        }
    }

    public initRoomTerrainWalkAble(roomName: string): void {
        const terrain = new Room.Terrain(roomName)
        this.forEach((x, y) => {
            const tile = terrain.get(x, y)
            this.set(x, y, tile === TERRAIN_MASK_WALL ? 0 : tile === TERRAIN_MASK_SWAMP ? 2 : 1)
        })
    }
}
