# 外矿供能与防守

源 Container 仅在同一房间已有可用的源 Link 和中央 Link 时拆除。Controller Link 单独存在时，矿工继续向 Container 存能、保留矿区搬运工。旧版本删掉源容器及蓝图坐标的房间，会按现有容器、工地或矿工站位恢复蓝图，再由正常施工流程补建；不会为恢复容器拆其他建筑。

外矿发现 `Invader` 后，每 tick 检查并立即发布高优先级远程防守需求，不等待人口刷新周期。身体按活体部件及强化计算 NPC 的治疗、远程伤害和 TOUGH 减伤，等足够能量孵化能打过的未强化远程攻击/治疗身体；本房能量容量不足时选同 shard 最近且有正常出生物流的可用自有房支援，仍无可用房时在 `Memory.rooms[主房].remoteInvaderThreats` 记录等待原因。紧急经济恢复先于外矿防守。此防守只清理 NPC creeps，目标清空后回收。

## 外矿出生优先级

发展期 RCL1–7 出生容量至少 550，且一处本地 Source 有实际到岗、有效 WORK 的矿工，以及服务该矿点的有效 CARRY/MOVE 搬运工，就可以启动人工或自动外矿。出生中的、仍在强化的单位不算已就绪；不必等所有 Source 满编、Storage 储能达标或出生池补满。已有源 Link 和中央 Link 的实际供能链时，Storage 搬运工也可承担对应矿源的运输。人口发布和 Spawn 出生检查使用相同条件；本地恢复期间已经出生的外矿单位继续工作。

出生优先级数值越小越优先：

| 需求 | 优先级 |
| --- | --- |
| 本地空矿点恢复或濒死矿工接班 | 1 |
| Controller 剩余退级时间不超过 2000 tick 的首个救援升级工 | 1.5 |
| 本地矿点首只搬运工、Storage 补能搬运工 | 2 |
| 外矿 NPC 防守 | 2.5 |
| 已运行外矿补员 | 2.6 |
| 新外矿预订 / 采集 / 搬运 / 侦察 | 2.7 / 2.8 / 2.9 / 2.95 |
| 健康本地矿工升级身体、已有运输矿点的搬运扩容 | 3.1 / 3.2 |
| 外矿道路建造 / 维修 | 4.5 |
| 普通建造 / 升级 | 4 / 5 |

Storage 有足够回收本次出生成本的能量、本地采运已经工作，但没有可用或正在出生的 Storage 搬运工，且出生池尚未补满时，能立即支付的首只 Storage 搬运工提前出生，避免队首大身体一直等能量却无人取出 Storage 库存。已有可用搬运工时不提升额外 Storage 搬运需求。普通升级工保持完整预算身体；临退级救援使用不强化的 1 WORK + 1 CARRY + 1 MOVE，只需 200 能量且没有额外出生储备。本地采运已经工作且能支付时，临退级救援优先于第二矿点的大矿工及 Storage 恢复，避免等出生能量期间退级。无 Spawn 或早期缺少物流设施时，起建援助仍按原有启动策略执行。

2026-10-09 只读检查 shard1/E39N5：一处 Source 有 4 WORK 矿工及搬运工，另一处空缺，Storage 约 5.5k、出生池 500/2150。旧队列先等健康矿工升级的 700 能量身体，400 能量 Storage 搬运工和外矿补员排在后面；新的排序先恢复库存补能、补齐空矿点，再优先外矿收入。此快照用于解释改动，不代表代码已经上传或线上恢复。

## 外矿道路

RCL3 起，手动 OUT 和自动外矿进入搬运阶段后，自动规划主房 Storage（没有时用 Spawn）到各 Source 的搬运道路；矿点已有 Container 时直接接到容器。人工 OUT 和自动搬运工返程都朝主房 Storage 走，无 Storage 时沿用 Spawn 目标；手动 RF 旗子仍保留指定目标。道路复用已有路线、避开蓝图的未来建筑、私有 Rampart 和障碍，允许与 Container、自有 Rampart 叠加，房间边界不放工地。跨多房路线须在规划时能看到途经房，最多经过四个房间。

每主房共用一名不强化的修路工，优先级 4.5、出生能量最多 800；本房采运、外矿采运和防守先出生，道路不参与逐矿启动的完成条件。工人维护整条路线的工地和低于 50% 血量的道路，也接手外矿现有工地；优先取附近掉落能量、容器库存，缺少库存时自采。没有工作时回主房待命并保持可推，避免堵住外矿通道。任务取消、战争或线路房间出现敌人后暂停铺路和补派，现有工人撤回主房；出生前重新检查，完工后的旧队列不会多生一只。

路线持久缓存 2500 tick，失败后至少等待 100 tick 重试；新增容器或主房卸货点变更会触发重规划。全局每 tick 最多一次道路寻路，Bucket 低于 1000 或 CPU 余量小于 10 时停止规划和新增工地，已有工人继续维护。每主房每 25 tick 检查一次铺路，全局每 tick 最多新增三个道路工地，沿用本房施工的每房活跃/新增上限，并共同记录同 tick 尚未显示的成功工地意图；额外为本房经济建筑留出 20 个全局工地名额。增量建造保留搬运路径缓存，只在工地实际完成后刷新房间建筑缓存。参数在 `settings/remoteRoads.ts`，路线在 `Memory.rooms[主房].remoteRoads.routes`。

## 手动添加外矿

在主房所在 shard 的控制台执行，选择未使用的 `OUT0` 到 `OUT9`：

```js
new RoomPosition(25, 25, 'E41N5').createFlag('E41N6_OUT0')
```

上例将 `E41N5` 设为 `E41N6` 的手动外矿。主房须自有且有 Spawn；旗所在房间就是目标，不用把旗放在 Source 上。同一主房按 `OUT0`、`OUT1` 的数字顺序逐矿启动，指向同一房间的重复旗只算一处外矿。手动外矿的启动链先于自动外矿。

OUT 旗可以放在墙上或边界；专用 Scout 进入目标房间可达内区取得视野，不会追逐旗子具体格子。普通 SCOUT 标点仍按指定位置移动。目标房若被寻路避让表禁止进入，预订与侦察都会被阻挡；可用 `BetterMove.getAvoidRoomsMap()` 查询当前 shard 的运行时避让表。持久默认配置在 `src/settings/settings.ts` 的 `findPathAvoidRooms`，按 `shard0`、`shard1`、`shard2`、`shard3` 分别设置房间数组；同名房不会互相影响。原有五房配置仅属于 shard3。跨 shard 路线按 Portal 入口和落点各自所在 shard 检查，配置变更使旧缓存失效。

每处新外矿依次完成以下阶段，完成后才发布下一处外矿的出生需求：

1. 侦察并预订：RCL3 起先派完整预订工，最低出生容量为 650 能量；目标无视野时也能发布预订工，并由专用 Scout 跟随当前 OUT 旗。须看到自己的预订且预订工已抵达 Controller，才进入开采。RCL2 跳过预订阶段；RCL3 容量不足 650 时等待容量提升。
2. 开采：为目标各 Source 配矿工，等待矿工结束出生、实际抵达矿点并具有有效 WORK。
3. 搬运：等待各矿点所需搬运工完成部署，并且每个矿点至少成功回送一次能量到主房。只发布配置、正在出生或还在路上，都不算完成。

已经运行的外矿继续补员，补员优先于新增外矿。新外矿预订、开采、搬运的出生优先级依次降低，并先于健康本地矿工升级身体、搬运扩容、常规建设和升级；紧急 NPC 防守与主房基础经济仍优先。观察者暂时失去视野时保留已知矿点；删除或移动当前 OUT 旗会释放对应启动位。预订入口被 Wall/Rampart 封住时会停留在预订阶段，可用旗子控制的黄球任务开口后继续。

查询当前启动房间和各矿进度，在主房所在 shard 控制台执行：

```js
Memory.rooms['E41N6'].remoteCommissioning.current
Memory.rooms['E41N6'].remoteCommissioning.rooms
```

`phase` 为 `scouting`、`reserving`、`mining`、`hauling`、`ready` 或 `waiting`；`reason` 记录等待原因。`ready` 记录该矿曾完成启动，`operational` 表示当前人员是否仍满足运行条件。

## 独立预定旗

将 `主房_RESERVE0` 到 `主房_RESERVE19` 放到要持续预订的普通房间，旗子颜色和具体格子不限，只看所在房间。在主房所在 shard 控制台执行：

```js
new RoomPosition(25, 25, 'E41N5').createFlag('E41N6_RESERVE0')
```

上例由 `E41N6` 持续预订 `E41N5`，目标无视野也会派兵，不必添加 OUT 旗，也不受逐矿启动顺序限制。主房须自有、有 Spawn、出生容量至少 650；发展期先有本地矿工和搬运工。容量达到 1300 时等待完整的 2 CLAIM + 2 MOVE；650–1299 时等待 1 CLAIM + 1 MOVE，不强化，优先级 2.7。

每旗稳定使用两个轮换名额，通常一只在役；旧工寿命不足以覆盖预计路程、出生时间及余量时提前派继任者，交接期间允许重叠。双 CLAIM 会积累预订时间缓冲，单 CLAIM 依靠提前交接维持；实际路程过长、缺出生能量、被堵或遇敌仍可能中断。同主房多个旗指向同一房间时，只使用编号最小的旗；与 OUT 或自动外矿共用预订需求，已有健康预定工先工作到接班期。

移动旗子让现有旗预定工跟随新房间，删除旗子后停止续派，现有旗单位回出生房待命；仍存在的 OUT 或自动外矿会恢复自己的预定工发布：

```js
Game.flags.E41N6_RESERVE0.setPosition(new RoomPosition(25, 25, 'E42N6'))
Game.flags.E41N6_RESERVE0.remove()
help('RESERVE')
```

该任务只在同 shard 普通控制器房运行，拒绝本房、Highway/Keeper 房、无 Controller 或已占领房；外人预订先清除再预订。战争、疏散、敌方 creep、入侵核心或敌方 Tower 会暂停补派并撤回现有旗单位。

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

完成、取消的拆迁任务立即从 `dismantleTasks()`、`shardDismantleTasks()` 及活动记录中移除，可用同一 id 新建独立实例。只短期保留原实例的停止广播，通信失败后自动重试；旧单位保持终态，跨门恢复所需的 transfer/ACK 保留。目标房间已知时，传送门候选路线另存通用缓存，门户情报也独立保留。旗所在位置已经清空、正在等待移动旗子的任务仍为活动任务，继续保留。
