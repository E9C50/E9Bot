/** BetterMove 的可调参数；寻路内部坐标编码和 CostMatrix 协议保持原实现。 */
export const navigationPolicy = {
    initialization: {
        地图房号最大数字超过100: false,
        changeMove: true,
        changeMoveTo: true,
        changeFindClostestByPath: true,
        autoVisual: true,
        enableFlee: false,
    },
    pathClearDelay: 3000,
    hostileCostMatrixClearDelay: 500,
    coreLayoutRange: 3,
    baseMaxOps: 4000,
    routeMaxOpsFactor: 100,
    estimatedTickMilliseconds: 10000,
}
