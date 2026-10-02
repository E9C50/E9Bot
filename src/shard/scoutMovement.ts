/** 单 MOVE 探路爬无负重，不因道路或沼泽的默认权重绕行；独立缓存选项隔离工作爬路径。 */
export const scoutMovementOptions: MoveToOpts & { ignoreSwamps: boolean } = {
    ignoreSwamps: true,
    plainCost: 1,
    swampCost: 1,
}
