import { populationPolicy } from 'settings/population'

/** 连通分组：每个敌人恰好属于一个组，桥接敌人能合并已有分组。 */
export function groupEnemies(enemies: Creep[]): Creep[][] {
    const groups: Creep[][] = []
    const remaining = new Set(enemies)
    for (const enemy of enemies) {
        if (!remaining.delete(enemy)) continue
        const group = [enemy]
        for (let index = 0; index < group.length; index++) {
            for (const candidate of remaining) {
                if (
                    group[index].pos.getRangeTo(candidate) <=
                    populationPolicy.defense.enemyGroupRange
                ) {
                    remaining.delete(candidate)
                    group.push(candidate)
                }
            }
        }
        groups.push(group)
    }
    return groups
}
