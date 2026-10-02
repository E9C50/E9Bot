import { controllerLayoutPolicy } from 'settings/controllerLayout'

type Coordinate = { x: number; y: number }

function range(first: Coordinate, second: Coordinate): number {
    return Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y))
}

function interior(x: number, y: number): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && x > 0 && y > 0 && x < 49 && y < 49
}

/** Keep upgrading seats inside the three-tile ring and a free delivery seat outside it. */
export function selectControllerContainer(controller: Coordinate, canWalk: (x: number, y: number) => boolean,
    canBuild: (x: number, y: number) => boolean, anchor?: Coordinate): [number, number] | undefined {
    if (!interior(controller.x, controller.y)) return undefined
    const policy = controllerLayoutPolicy
    let selected: [number, number] | undefined, bestInner = -1, bestHauler = -1, bestDistance = Infinity
    for (let x = controller.x - policy.containerRange; x <= controller.x + policy.containerRange; x++) {
        for (let y = controller.y - policy.containerRange; y <= controller.y + policy.containerRange; y++) {
            if (!interior(x, y) || range(controller, { x, y }) !== policy.containerRange || !canWalk(x, y) || !canBuild(x, y)) continue
            let inner = 0, hauler = 0
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                const seatX = x + dx, seatY = y + dy
                if (!(dx || dy) || !interior(seatX, seatY) || !canWalk(seatX, seatY)) continue
                const distance = range(controller, { x: seatX, y: seatY })
                if (distance < policy.containerRange) inner++
                else if (distance > policy.containerRange) hauler++
            }
            if (inner < policy.minimumInnerSeats || hauler < policy.minimumHaulerSeats) continue
            const distance = anchor ? range({ x, y }, anchor) : 0
            if (inner > bestInner || inner === bestInner && (hauler > bestHauler || hauler === bestHauler && distance < bestDistance)) {
                selected = [x, y]; bestInner = inner; bestHauler = hauler; bestDistance = distance
            }
        }
    }
    return selected
}
