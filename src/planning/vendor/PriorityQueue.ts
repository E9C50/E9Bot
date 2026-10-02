/** Pure TypeScript heap replacing 63bot's Scorpior-based WASM queue dependency. */
export interface PlannerNode {
    k: number
    x: number
    y: number
    v?: number | string
}

export function NewNode(k: number, x: number, y: number, v?: number | string): PlannerNode {
    // No shared node pool: nodes retained by block caches must not be recycled.
    return { k, x, y, v }
}

interface QueueEntry<T> {
    node: T
    priority: number
    order: number
}

export class PriorityQueue<T extends { k: number } = PlannerNode> {
    private readonly heap: QueueEntry<T>[] = []
    private sequence = 0
    private pops = 0

    public constructor(private readonly minimumRoot = false, private readonly checkWork?: () => void) {}

    private precedes(first: QueueEntry<T>, second: QueueEntry<T>): boolean {
        if (first.priority === second.priority) return first.order < second.order
        return this.minimumRoot ? first.priority < second.priority : first.priority > second.priority
    }

    public push(node: T): void {
        const entry = { node, priority: node.k, order: this.sequence++ }
        let index = this.heap.length
        this.heap.push(entry)
        while (index > 0) {
            const parent = (index - 1) >> 1
            if (!this.precedes(entry, this.heap[parent])) break
            this.heap[index] = this.heap[parent]
            index = parent
        }
        this.heap[index] = entry
    }

    public pop(): T | undefined {
        if (this.heap.length === 0) return undefined
        if (++this.pops % 256 === 0) this.checkWork?.()
        const top = this.heap[0].node
        const last = this.heap.pop()!
        if (this.heap.length > 0) {
            let index = 0
            while (index * 2 + 1 < this.heap.length) {
                let child = index * 2 + 1
                if (child + 1 < this.heap.length && this.precedes(this.heap[child + 1], this.heap[child])) child++
                if (!this.precedes(this.heap[child], last)) break
                this.heap[index] = this.heap[child]
                index = child
            }
            this.heap[index] = last
        }
        return top
    }

    public top(): T | undefined { return this.heap[0]?.node }
    public size(): number { return this.heap.length }
    public isEmpty(): boolean { return this.heap.length === 0 }
    public clear(): void { this.heap.length = 0; this.sequence = 0; this.pops = 0 }

    public whileNoEmpty(callback: (node: T) => void): void {
        while (!this.isEmpty()) callback(this.pop()!)
    }
}
