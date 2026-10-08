# 外矿供能与防守

源 Container 仅在同一房间已有可用的源 Link 和中央 Link 时拆除。Controller Link 单独存在时，矿工继续向 Container 存能、保留矿区搬运工。旧版本删掉源容器及蓝图坐标的房间，会按现有容器、工地或矿工站位恢复蓝图，再由正常施工流程补建；不会为恢复容器拆其他建筑。

外矿发现 `Invader` 后，每 tick 检查并立即发布高优先级远程防守需求，不等待人口刷新周期。身体按活体部件及强化计算 NPC 的治疗、远程伤害和 TOUGH 减伤，等足够能量孵化能打过的未强化远程攻击/治疗身体；本房能量容量不足时选同 shard 最近且有正常出生物流的可用自有房支援，仍无可用房时在 `Memory.rooms[主房].remoteInvaderThreats` 记录等待原因。紧急经济恢复先于外矿防守。此防守只清理 NPC creeps，目标清空后回收。

## 手动添加外矿

在主房所在 shard 的控制台执行，选择未使用的 `OUT0` 到 `OUT9`：

```js
new RoomPosition(25, 25, 'E41N5').createFlag('E41N6_OUT0')
```

上例将 `E41N5` 设为 `E41N6` 的手动外矿。主房须自有、有 Spawn 且 RCL 至少 3。手动旗优先于自动外矿；旗所在房间就是目标，不用把旗放在 Source 上。删除该旗停止发布对应外矿需求。

## 跨 shard 精确拆除

在起点 shard 使用 `shardDismantleTask(id, config)`。需要明确的 Portal 路线，以及有限的 wall/rampart ID、坐标和类型；只拆所列目标。单位为 40 WORK + 10 MOVE，使用 T3 拆解、移动强化，每次出生 4500 能量、1200 XZH2O 和 300 XZHO2。起点先等能量、实际强化库存及服务条件充足再出生；不影响经济救援或更高优先级防守。

始终保留一个名额。跨 shard 存活报告和入境确认用于判断死亡，不能因起点 `Game.creeps` 查不到单位就补派。确认死亡后继续补派，拆完指定障碍并确认能走到 Controller 一格范围后停止续派，存活黄球移到旁边空位让路。失联且无法确认死亡、强化失败或能量预算耗尽时暂停，并显示原因。

2026-10-08 现场确认的 E41N5 控制器入口配置如下。Portal 位置和障碍 ID 对应当时现场，应在重新发布新任务前核对：

```js
shardDismantleTask('open_E41N5_controller', {
    sourceRoom: 'E41N8',
    targetShard: 'shard2',
    targetRoom: 'E41N5',
    route: [{ shard: 'shard3', roomName: 'E40N10', x: 34, y: 39,
        destinationShard: 'shard2', destinationRoom: 'E40N10' }],
    targets: [
        { id: '61bc0fe9558126265a37317f', x: 10, y: 35, type: 'rampart' },
        { id: '61ba63d87328afc39f5048b5', x: 11, y: 36, type: 'rampart' }
    ],
    controller: { x: 10, y: 37 },
    maxEnergy: 180000
})
```

这两道相邻障碍形成同一个通道，不拆其他围墙。现场外层约 2.44 亿、内层约 421 万血，需要多次补派。`maxEnergy` 是实际出生能量预算，上例最多 40 次出生；只在原生 `spawnCreep` 成功后记账。

```js
shardDismantleTasks()
shardDismantleCancel('open_E41N5_controller')
help('shardDismantleTask')
```

同 id 重复创建会返回已有任务，不重复派兵。取消会停止续派，并通过 InterShardMemory 通知远端单位停止拆除、让出通道。沿途 shard 均需运行此版本的代码。
