# 外矿供能与防守

源 Container 仅在同一房间已有可用的源 Link 和中央 Link 时拆除。Controller Link 单独存在时，矿工继续向 Container 存能、保留矿区搬运工。旧版本删掉源容器及蓝图坐标的房间，会按现有容器、工地或矿工站位恢复蓝图，再由正常施工流程补建；不会为恢复容器拆其他建筑。

外矿发现 `Invader` 后，每 tick 检查并立即发布高优先级远程防守需求，不等待人口刷新周期。身体按活体部件及强化计算 NPC 的治疗、远程伤害和 TOUGH 减伤，等足够能量孵化能打过的未强化远程攻击/治疗身体；本房能量容量不足时选同 shard 最近且有正常出生物流的可用自有房支援，仍无可用房时在 `Memory.rooms[主房].remoteInvaderThreats` 记录等待原因。紧急经济恢复先于外矿防守。此防守只清理 NPC creeps，目标清空后回收。

## 手动添加外矿

在主房所在 shard 的控制台执行，选择未使用的 `OUT0` 到 `OUT9`：

```js
new RoomPosition(25, 25, 'E41N5').createFlag('E41N6_OUT0')
```

上例将 `E41N5` 设为 `E41N6` 的手动外矿。主房须自有、有 Spawn 且 RCL 至少 3。手动旗优先于自动外矿；旗所在房间就是目标，不用把旗放在 Source 上。删除该旗停止发布对应外矿需求。

## 旗子控制的黄球拆迁

黄球跟随指定旗子，只拆旗子所在一格的合法敌方建筑：优先 Rampart，其次 Wall，再拆同格其他建筑。移动旗子就调整位置，可以换到另一个房间；不会拆邻格或清理整房围墙。旗颜色不限，旗名可以用中文。创建任务前只放旗不会自动派兵。

同 shard 示例，在需要拆迁的建筑上创建旗，然后从自有出生房发布任务：

```js
new RoomPosition(15, 20, 'W2N1').createFlag('yellow')
dismantleTask('W1N1', 'yellow', {
    id: 'yellow1', boostTier: 0, workParts: 5, maxEnergy: 15000
})
```

房名和坐标换成实际目标。上例每次出生 5 WORK + 5 MOVE，750 能量，不需要药剂。省略 `workParts` 时，按出生房的能量容量选择最大可用身体；`boostTier` 为 0..3，默认 T3。MOVE 数按平原速度和移动强化计算。孵化等完整身体能量和所需强化就绪，不因当前出生能量少而改为小身体；更高优先级的经济救援、NPC 防守先出生。

在目标 shard 控制台移动或删除旗：

```js
Game.flags.yellow.setPosition(new RoomPosition(16, 21, 'W2N1'))
Game.flags.yellow.setPosition(new RoomPosition(12, 10, 'W2N2'))
Game.flags.yellow.remove()
```

旗格清空或旗被删除时，黄球让路等待，任务保留且不补派无事可干的单位；移动或重放旗后可继续。无视野的旗位可先派黄球前往查看，但已确认空格的同一位置不会因后来失去视野而反复派兵。自己和白名单建筑、Controller、Portal、PowerBank、KeeperLair、InvaderCore 不拆，敌方安全模式或无敌效果期间等待。

跨 shard 时，旗放在目标 shard，创建任务的指令在出生房所在 shard 执行。例如已有实际可用的 `route` 后：

```js
// 在目标 shard 放旗
new RoomPosition(15, 20, 'W2N1').createFlag('yellow')

// 在出生 shard 发布；route 为 shardPortals() 查到并核对过的逐跳 Portal 数组
dismantleTask('W1N1', 'yellow', {
    id: 'yellow1', targetShard: 'shard2', route,
    boostTier: 3, maxEnergy: 180000
})
```

跨 shard 单位通过 InterShardMemory 共享存活状态和目标旗位置，沿途 shard 均需运行此版本。同 shard 不需要 Portal 路线或跨 shard 通信。整个任务始终保留一个单位名额，确认死亡后持续补派；起点查不到跨出的单位不代表死亡。无法确认存活/死亡时保留名额并暂停，恢复指令不会强行清空名额或多派兵。

```js
dismantleTasks()
dismantleTasks('yellow1')
dismantlePause('yellow1')
dismantleResume('yellow1')
dismantleResume('yellow1', { maxEnergy: 360000 })
dismantleCancel('yellow1')
help('dismantleTask')
```

`maxEnergy` 是整个任务的实际出生能量预算，默认 180000，只在原生 `spawnCreep` 成功后记账。增加预算不会增加名额；不能将预算设得低于已花费量。手动暂停会停止行进、强化、拆除和后继补派，让现有黄球就近让路；取消停止后继补派并通知存活黄球让路。暂停或取消的单位不再占用 Lab 强化请求，暂停时间不计入强化超时。已发生强化失败的单位仍需处理失败原因，恢复任务不会绕过精确强化检查。

旧 `shardDismantleTask(id, config)` 的有限目标列表仍兼容，也可以传 `flagName` 使用旗模式；旧的 `shardDismantleTasks/Pause/Resume/Cancel` 是相应控制指令的兼容入口。运行代码没有特定房间、障碍 ID 或 Portal 坐标；所有任务都由控制台发布。
