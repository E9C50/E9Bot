/** Adapted from the UnionFind in 63bot/default/algo_algorithm.js. */
export class UnionFind {
    private readonly parent: Int32Array

    public constructor(private readonly size: number) {
        this.parent = new Int32Array(size)
    }

    public init(): void {
        for (let index = 0; index < this.size; index++) this.parent[index] = index
    }

    public find(index: number): number {
        let root = index
        while (this.parent[root] !== root) root = this.parent[root]
        while (this.parent[index] !== index) {
            const next = this.parent[index]
            this.parent[index] = root
            index = next
        }
        return root
    }

    public union(first: number, second: number): void {
        const firstRoot = this.find(first)
        const secondRoot = this.find(second)
        if (firstRoot > secondRoot) this.parent[firstRoot] = secondRoot
        else if (firstRoot !== secondRoot) this.parent[secondRoot] = firstRoot
    }

    public same(first: number, second: number): boolean {
        return this.find(first) === this.find(second)
    }
}
