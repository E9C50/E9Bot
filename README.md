# ecbot

战斗任务和分组防御已重构，控制台用法、策略与限制见 [战斗说明](docs/combat.md)。

Screeps TypeScript Bot。采用按 tick 编排、按业务领域拆分的控制器，并保留现有角色、旗帜和 Memory 协议。

完整运行流程、角色职责、状态生命周期、旗帜协议和扩展步骤见 [项目逻辑与架构](docs/architecture.md)。

多仓库资源调度、终端 50000 能量底线、T3 常备量及 Lab/Factory 批量生产见 [资源调度与生产](docs/resources.md)。

源 Link 与容器供能切换、外矿 NPC 防守、手动外矿旗及旗控制的黄球拆迁指令见 [外矿供能与防守](docs/remotes.md)。

## 开发与验证

使用 Node.js 18 或以上版本，在项目根目录执行：

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`build` 仅生成 `dist/main.js` 和 source map，即使环境中已有 `DEST`，也不会上传或复制到游戏目录。`test` 使用 Node 内置测试框架，覆盖初始化、持久化兼容、执行顺序、故障隔离、孵化优先级及关键运行边界；测试通过隔离的 Game/Memory 模拟运行，不连接游戏服务器。

已移除旧 ESLint 配置中失效的 `prettier/@typescript-eslint` 引用，恢复 lint 启动。完整 lint 仍报告大量格式及类型安全规则问题，包含旧代码和第三方模块，本次未做全仓格式/类型迁移，也未把 lint 记为通过。类型检查、回归测试和构建独立验证。

## 自动房间布局与建设

拥有的新房默认自动调用 63bot 的布局算法，保存完整蓝图，再按 RCL 解锁建筑并分批放置工地。第一次运行时已经 RCL8 的房间保存当前建筑和自有工地的绝对坐标；后续建筑损毁会在原坐标补建。已有蓝图不会因升级、降级、重启或建筑损毁重新规划，也不会自动拆建筑。

控制器 Container 规划在距 Controller 恰好 3 格的位置，保留至少 2 个内侧升级位、1 个外侧搬运位，并规划到外侧的运输道路。发展期升级工优先使用三格容器及其内侧站位。已有 RCL1–7 的 63bot 蓝图会单独修正旧控制器容器；仅取消零进度自有容器工地，已有建筑和投入过建设进度的工地保留，源/矿容器、控制器 Link 和 RCL8 快照位置不变。相关几何、迁移冷却和 CPU 预算在 `settings/controllerLayout.ts`。

无 Spawn 的自有房会从最近的可用房派出自采能建造工（默认距离最多 5 个房间），优先建设第一个 Spawn；有 Spawn、尚无物流容器/Storage 的房间会发布本地自采能 builder。支援工使用可支付的 worker 身体并跳过强化，完成起建后不再续派；存活支援工继续建设或升级。

施工取能时，援建工优先回收足量的地面能量，再取容器库存，避免矿旁每 tick 的几单位碎屑阻止大背包装载。已有能量达到 80% 容量或继续取能等待 25 tick 后开始施工，用完再补给；取能或移动失败会换目标，持续没有位置/能量进展的目标暂时冷却。无工地升级时使用下面的稳定席位与连续补能规则。策略在 `settings/aidBuilder.ts`，只读现场检查可用 `node scripts/aid-builder-diagnostics.cjs shard1 E39N5`，短期运行观察可用 `node scripts/development-monitor.cjs shard1 --builders`。

策略入口为 `constructionPolicy`：默认 bucket 至少 2000、剩余 tick CPU 至少 150 时才规划，每 tick 最多尝试 1 房，失败冷却 100 tick；单次 CPU 预算最多 300，并为后续阶段预留 50。普通补建每 10 tick 检查，每房每 tick 最多新建 5 个工地、同时最多 10 个；另受原生 RCL 配额和全局工地上限约束。CPU 不足时等待，已保存布局的补建无需重新运行规划算法。

持久数据在 `Memory.rooms[roomName].roomBlueprint`，进度和失败原因在 `roomBlueprintState`。设置 `Memory.rooms[roomName].autoLaylout = false` 可关闭该房自动规划与补建（保留旧字段拼写），全局开关在 `constructionPolicy.enabled`；支援建造人数、距离及开关在 `populationPolicy.bootstrap`。`planRoomStructure` 旗帜现在触发已有蓝图的即时补建，自动流程无需放旗帜。

矿物可能位于天然墙格，规划与补建允许在实际矿物坐标放置 Extractor，RCL6 解锁后创建工地。可执行 `node scripts/layout-diagnostics.cjs shard1 E39N5` 只读查看官服房间的规划状态、蓝图数量、工地进度和现场工人；凭据使用 `screeps.json` 的 `main` 配置，不输出认证信息。

在房间里放置名为 `layout` 的旗帜，即可显示该房保存的完整布局，包括后续等级解锁的建筑；RCL8 房显示保存的当前布局快照。旗帜颜色不限，位置只用于选择房间，移动到其他房间会切换预览，删除后停止显示。图标覆盖全部 16 类建筑，采用接近原版的轮廓和配色，道路连接相邻节点，Rampart 使用透明绿色边框保留同格建筑。无需 `SV` 旗帜；尚未保存蓝图时显示提示。

预览使用 heap 缓存复用绘图，蓝图坐标或样式修改后立即刷新，不重新规划、放置工地或写入 Memory。开关、透明度、道路样式及绘图预算在 `layoutPreviewPolicy`，旗帜名称在 `roomPolicy.flags.layoutPreview`。例如可在 shard1 控制台执行 `Game.rooms.E39N5.createFlag(25, 25, 'layout')` 创建预览旗帜。

快照只能记录首次启用时存在的建筑及工地，无法推断之前已经消失的建筑。已有人工建筑保留并优先计入配额，若其位置挡住其他蓝图目标，该目标会等待空位，需按实际情况调整蓝图。规划算法的来源、模块职责及验证边界见 [项目逻辑与架构](docs/architecture.md)。

## RCL1–7 快速发展

默认在已有布局上启用发展策略：按 Source 的实际 WORK 缺口配矿工，以运距和产量配搬运容量，出生补能优先于 Controller 供能。普通源的默认未强化矿工在 550 能量容量时合并为 4 WORK + 1 WORK，700 时由单只 5 WORK 覆盖。旧发展矿工等接班者到达矿旁、覆盖本轮发布且可实现的 WORK 配额后才交班，合并身体不会提前撤走原有产能。

矿工支持同 tick 采集和卸载。缓冲已满时，有 CARRY 的矿工保留背包批次，背包满后暂停采集；零 CARRY 矿工必须站在源容器本格，容器满时暂停，避免溢出堆在地上。控制器旁有 Container/Link 后，升级工原地连续取能与升级；可用 Link 优先给 Controller 送能，但保留出生补能余量。

本地搬运工固定服务各自矿点，足量的地面溢出能量优先于源容器，小堆能量不会抢占满载目标。默认装满后运送；该矿断供且连续 10 tick 无新增能量时，送出已有的部分载荷，近 Spawn 且能量紧缺时允许至少 50 能量应急补给。一次运送会持续到空载，多个搬运工通过本 tick 取能预约避免重复争抢一批能量。旧单位自动恢复矿点身份，RCL8 沿用原有物流。装载阈值与等待时间在 `settings/development.ts`，可用 `node scripts/hauler-diagnostics.cjs shard1 E39N5` 或 `node scripts/development-monitor.cjs shard1 --haulers E39N5 --seconds 120` 只读检查。

升级预算取已到岗产量与活搬运工按运距估计的运力两者较小值，自动外矿还须有有效安全情报和配套运工；默认使用收入的 85%，存在工地时为 65%。可运输的矿点积压、控制器缓冲余量及 Storage 超过 10000 的部分可追加有限预算。已经在位执行升级任务的援建 WORK 先从预算中扣除，其占用的供能席位也扣除，避免重复孵化。`upgrading.maximumCreeps = 8` 只是人数上限，实际还受静态合法席位限制；满站时通过替换旧小身体扩大 WORK，不继续增加无座位升级工。控制器缓冲至少有 300 能量时，升级身体的额外出生预留降为 0，可在 WORK 与成本预算内使用更大身体；供能不足时恢复启动余量。

援建工在已经能升级的位置保持不动，同 tick 预约避免争抢席位；相邻真实 Container/Link 时可同 tick 升级、取能，空载时只取能，下一 tick 观察真实 Store 后再升级。不会为了补能把合法远席搬到容器旁。施工时，跨 shard 援建工以及发展期本地/远程建造工保持已经能施工的工作位，赴工地时避让占用；取能、空载或切换维修时释放位置保护，避免两个工人反复对穿、轮流工作。按活爬实际 WORK 补工，避免把早期小爬当作已经升级的大身体；建造工最多 2 只，其 WORK 按剩余收入和原生建造能耗限制。采矿和首个搬运先保障，首个升级工先于普通建造需求。没有 Spawn 时仍由支援工完成起建，有 Spawn 后才启用本地生产链。

自动侦察相邻普通房并选取最多 2 个外矿，包含人工 `_OUT` 占用的名额；无需新建旗帜。现场检查归属、预定、敌对单位与建筑，并确认两房内真实 Source 路径。每个主房逐矿完成实际预订、矿工部署和首次能量回送，再启动下一矿；已有外矿持续补员，人工 `_OUT` 按数字顺序优先启动。定点矿工和按往返路程拆分的搬运工等待完整身体出生，预订工先于新增采运单位。相同 Source 数量时优先较短运距，保留正在启动及已经投入人员的外矿；危险、失效或战争期间停止派工，自动单位返回。路径与安全情报持久化，低 bucket 暂停新的规划，已知情报在期限内复用。进度与等待原因见 `Memory.rooms[roomName].remoteCommissioning`。

RCL8 继续使用原有人口需求与 Link 策略，不新增发展期自动外矿需求；新孵化身体使用下面的统一身体规划。新采能工在既有采矿站连续采能、卸能，新升级工在已有控制器供能站同时升级、补能。过渡时多余发展工归还能源并回收；采矿和运输单位先等正常运营的替代者到岗，避免供能中断。已经 RCL8 的旧单位不走发展工退役逻辑。

参数集中在 `src/settings/development.ts` 和 `src/settings/developmentRemotes.ts`，包括 WORK/人数、升级收入比例、储能保留、替补提前量、外矿数量、侦察周期与 CPU 预算。某房可设置 `Memory.rooms.E39N5.fastUpgrade = false` 恢复原策略；只关闭自动外矿可设置 `Memory.rooms.E39N5.developmentRemotes.enabled = false`（状态尚未创建时先初始化为 `{ enabled: false }`）。RCL8 的退出不需要手动配置。

参考本地 upgrade-bot 的采矿、搬运预算和控制器缓冲思路；继续使用 ecbot 的持久布局与跨 shard 起建协议。建造预算按 [Screeps 原生引擎](https://github.com/screeps/engine/blob/master/src/processor/intents/creeps/build.js) 的 WORK、BUILD_POWER 和 Store 限制计算。测试验证角色意图、配额、故障与满级隔离；实际升级耗时和长期外矿收益仍需在官服运行中观察。`node scripts/development-diagnostics.cjs shard1` 可只读检查房间需求、自动外矿情报和 CPU；报告包含 Memory 中保存的房间统计，旧房间条目可能是历史记录。

## 身体规划与不同等级强化

所有已实现角色统一根据可支付能量、任务、地形、工作产量和实际强化资源生成身体。参考了本地 Harabi、Tigga、63bot、upgrade-bot、autonomous-bot 的驻点、运输和移动工设计，没有直接复制依赖其它布局或调度器的配方。部件总数不超过 50；缺能量时正常需求等待，生产链恢复和起建援助可使用当前能量生成小身体。

```js
bodyPreview("E41N8", "harvester") // 只读：列出未强化/T1/T2/T3的部件、能量、用药及可准备状态
bodyPreview("E41N8", "sHauler")
bodyConfig("E41N8", "upgrader", {boostTier: 3})
bodyConfig("E41N8", "rFiller", {terrain: "plain", boostTier: 2})
bodyConfig("E41N8", "builder", {maximumCost: 1300, workParts: 4})
bodyConfig("E41N8", "upgrader", {boostTier: 3, boostFallback: "wait"})
bodyConfig("E41N8", "upgrader", null) // 恢复默认
```

配置保存到房间 Memory，人口需求刷新后保留，对后续孵化生效。优先级为单条需求 `bodyProfile`、房间角色 `bodyConfig`、`bodyPolicy.profiles`。`boostTier` 为 0/1/2/3；`workParts` 是实际 WORK 上限；`carryParts` 是按未强化 50 容量计算的 CARRY 等价目标，强化后可用更少 CARRY 满足相同运量。`maximumCost` 限制身体能量成本；`terrain` 可选 `road`、`plain`、`swamp`。发展期的收入与能量预留继续约束自定义身体，设置更大身体不会突破既有发展预算。

| 任务 | 默认身体思路 |
| --- | --- |
| 本地/远程采能 | 按 Source 再生产量计算 WORK，计入当前 `PWR_REGEN_SOURCE`；真实驻点配置小 CARRY，容纳前后两个采能批次 |
| 升级 | 已确认供能站使用小 CARRY；移动升级工按约 50 tick 消耗配仓位；RCL8 基础 WORK 至多 15，强化继续增加升级进度 |
| 建造/维修/援建 | 移动工作身体配合用能周期的 CARRY；远程/跨 shard 无已确认道路时按平原满载移动 |
| 矿物开采 | 矿物工自己运回 Storage，按 Extractor 冷却、往返距离和强化效果比较可支付方案的交付产量 |
| 搬运/填充/实验室运输 | 根据所需等价容量和地形配 MOVE；满载道路约 2 CARRY : 1 MOVE，平原约 1 : 1，强化后使用原生疲劳倍率 |
| 中央 manager | 成熟房默认 49 CARRY + 1 MOVE，等待 2500 能量再孵化；发展期按预算配置小身体，固定站位保持一个经理 |
| Scout/Claim/Reserver | Scout 单 MOVE；普通 Claim 单 CLAIM；预定默认单 CLAIM，已知友军预定将到期时可用双 CLAIM，不再默认堆五个 |
| 攻击/拆迁/治疗/一体机/防守 | 按可支付的火力、治疗、护甲组合生成身体，并按地形与 MOVE 强化计算移动部件；TOUGH 前置，HEAL 后置 |

经济与本地防守默认未强化；进攻、拆迁、治疗及一体机在有真实供药条件时选择最高可准备的 T3/T2/T1，资源不足重新生成未强化身体。显式指定强化等级时默认缺药回退未强化，`boostFallback: "wait"` 则保留需求等待指定等级。单 MOVE Scout、单 CLAIM 且原生移动已够用的单位不浪费强化药；普通源 T3 驻点矿工可只需 XUHO2，不强制附加没有身体收益的移动/容量强化。

孵化前检查准确化合物、库存、实验室及实际搬运能力，并扣除活单位和本 tick 已接受孵化的预约，避免多个 Spawn 重复分配一批药。每只新单位保存自己的确切用药方案；实验室按资源名称分配，支持同一强化种类的不同等级同时服务。发展期配置经济强化且已有 Lab 和库存建筑时，会补一个未强化 processer 保障供药，避免它等待自己的强化而无人送药；矿物可从 Storage 或 Terminal 取用。

强化完成以实际 body 为准；已完成的战斗单位受伤后继续作战。孵化后意外缺药或实验室失效，默认等待最多 300 tick，然后记录一次原因并回收，后续重新评估身体；不会让依赖强化的小 MOVE 身体直接出征。普通新身体逐步替换存量单位，人口数量和旧单位任务保持现有调度。

默认 RCL8 本地经济移动按已有道路估计；无道路或必须穿沼泽的任务请明确设置 `terrain`。矿物距离是估计值，不能保证每种地图的全局最优。身体、比例、强化超时等参数集中在 `src/settings/bodyPolicy.ts`。倍率采用游戏原生 [BOOSTS](https://github.com/screeps/common/blob/master/lib/constants.js)，RCL8 能耗与强化进度语义依照[官方升级处理逻辑](https://github.com/screeps/engine/blob/master/src/processor/intents/creeps/upgradeController.js)。`rAttacker` 仍是未实现角色，不会发布或孵化空身体。

## 跨 shard 开房、援建和能量运输

在起点 shard 的游戏控制台指定两个端点即可；起点默认当前 shard，终点用 `shard/房间` 区分同名房间。任务 id 自动生成，Portal 坐标和去返程路线无需填写：

```js
shardTask('W1N1', 'shard1/W2N2')
// 默认自动探门、规划并实地验证，再占领、自采能建设：1 claimer、2 builder，目标 RCL4 且拥有 Spawn。

shardTask('W1N1', 'shard1/W2N2', {
    id: 'settle-east', haulers: 2, energyAmount: 50000
})
// 自动规划去程和返程，援建并往返运送能量。
```

各 shard 自动发现自有且可用的 Observer，在范围内轮询高速路交叉房（两坐标均为 10 的倍数）及已知入口，同时收集普通可视房间的 Portal。跨 shard 门的交叉房生成规则见[官方开发公告](https://screeps.com/forum/topic/41/ptr-changelog-2017-07-20-world-shards/2)。观察结果在下一 tick 入库并通过 InterShardMemory 共享。自动路线默认逐段选择最近可达入口：例如 shard3 → shard1，先选最近的 shard3 → shard2 门，再从实际落地点选择 shard2 → shard1 门；当前选门只比较到入口的距离，后续路程和最终落地点不会让 scout 绕去远门。探门每次只预选一座门，跨越后重新本地择近；完整候选路线也使用逐段最近策略，随后由验证 scout 实走。源端可查询本 shard 原生地图，中转段在源端先按落地房间坐标估距。返程独立计算，不能直接反转去程。`portalRouting.strategy` 默认为 `nearestHop`，也可配置 `totalCost` 使用全程预估成本策略；策略变化会使已有自动任务重新规划并重新验证。Portal 消失、目的地改变或入口不可达时，源任务自动重规划并重新派 scout；在途工作单位保留货物，等待新路线验证后采用当前 shard 的剩余行程。

自动路线就绪后，先孵化一个仅有 `[MOVE]`、耗能 50 的 `sScout` 实地走完整去程，记录真实到达位置与目标现场状态；任务有返程时再验证返程。当前路线版本的所需证明全部通过后，才发布 claimer、builder 和 hauler。`shardTasks()` 中 `scouting.status` 显示 `pending / scouting / verified / failed`，失败原因与等待重试时间随状态保留。路线变化、侦察兵死亡、验证失败或证明过期都会要求重新验证。

普通 Observer 范围为 10 个房间，不能隔着 shard 观察，也不会递归扩大视野。自动任务缺少完整去程或所需返程时，`routing.status` 保持 `waiting`，默认先派一个单 MOVE 的探门 `sScout`：沿已发现的部分路线进入下一 shard，再实际走访高速路交叉房，将真实视野里的入口共享回来。中间 shard 无自有房、Spawn 或 Observer 时也能执行探门。完整路线出现后撤回探门需求，另派验证侦察兵走完整行程；探索完成本身不会放行援建或运输。`shardTasks()` 的 `exploration` 显示进展及失败原因。

每次选择新的探索目标，优先从 scout 当前房间前往最近可达、尚未访问的十字路口（房名横纵数字均为 10 的倍数，例如 `W10N20`），按原生地图路径长度排序；已选目标在途中保持稳定，抵达、无路、超时或被其他视野扫描后再选下一个，避免围绕最初落地房间反复折返。已访问、已扫描、暂避及不可达房间会跳过；已知真实 Portal 仍可前往。确定最近候选后停止追加原生查询，候选范围仍受探索半径和 CPU 预算限制。单 MOVE 的 `sScout` 使用相同的道路、平原和沼泽寻路成本，避免为贴道路或避沼泽绕远。

路线涉及的全部 shard 都需运行这一版本的 Bot 并分配足够 CPU，包括尚无自有房间的中间 shard；例如从 shard3 经 shard2 到 shard1，三处都需要启用脚本。没有运行脚本的 shard 无法恢复迁移 Memory、继续移动或共享新情报。私服 shard 名加入 `interShardPolicy.peers`，并按实际拓扑配置 `portalExploration.shardConnections`；连接表只决定搜索优先级，不能代替真实 Portal。没有可走入口、区域不可达、CPU 不足或探索超出预算时保留任务并退避重试。设置任务 `explorePortals: false` 可只等待现有视野/Observer 情报；全局开关为 `portalExploration.enabled`。手写固定路线默认不主动探门，自动去程或自动返程默认开启。

扫描默认每 5 tick 最多预约 2 个 Observer，已扫描房间每 500 tick 复查，低 bucket 暂停新观察。与 BetterMove 共享每 Observer 每 tick 的预约，避免覆盖寻路观察；其它 tick 仍可用于原有寻路。私服有特殊生成规则时可用 `portalDiscovery.includeSectorCenters: true` 额外扫描扇区中心。自动图规划默认每 tick 最多 2 次、bucket 至少 1000、单次 CPU 预算 20，并保留 tick CPU 余量；等待任务每 50 tick 重试，预算排队顺延下一 tick。目录和图搜索容量、情报有效期、重试及原生地图查询预算都在 `interShardPolicy.portalDiscovery/portalRouting`。本地临时门按本地剩余 tick 过滤，对外只分享稳定门，不把不同 shard 的 tick 当作同一时钟。

主动探门策略在 `interShardPolicy.portalExploration`：默认 bucket 至少 1000，源端每 tick 最多创建 2 个入口计划，选门和选搜索房共用 5 CPU 的查询预算，并保留 tick CPU 余量；搜索半径 20 房、最多 64 候选/128 已访房，每个辅助规划调用最多 12 次原生地图查询。单次原生寻路无法中断，预算耗尽后停止追加查询，等下一 tick 继续。探索单位最多运行 1200 tick、低于 50 tick 剩余寿命停止；前往某房连续 150 tick 无跨房进展时暂时跳过，失败重试 60 秒，整个等待上限 30 分钟。已访问房、危险房和超时入口受容量与期限限制，不无限遍历地图；探索报告独立于验证证明。

已选入口、探索房间和终点的移动不受 bucket 1000 的新规划门槛限制。`interShardPolicy.scoutSafety` 控制实际威胁距离：默认近战 2 格、远程 4 格，包含对手移动一步的缓冲；远处其他玩家的打 PB 单位不会让整房侦察失败。受伤及可攻击敌塔仍会阻止验证。经过房间的威胁不会封禁尚未到达的 Portal。失败冷却结束后，优先原位复用本 shard 仍存活、健康且寿命足够的探门 scout；旧失败报告不能覆盖新一次尝试。已取消或被替换的 scout 前往本 shard Spawn 回收，空 shard 的退役单位先离开出口，避免长期卡住边缘。

也支持对象形式省略 `id` 和 `route`；原有手写 `route` 仍可用于固定路线。例如：

```js
shardTask({
    id: 'settle-east',
    sourceRoom: 'W1N1',
    targetShard: 'shard1',
    targetRoom: 'W2N2',
    claim: true,
    builders: 2,
    haulers: 2,
    targetLevel: 4,
    energyAmount: 50000,
    homeEnergyReserve: 10000
})
```

自动图路由的房间移动费用为估算值；当前 shard 用原生 `Game.map.findRoute` 验证房间连通并避开配置的禁行房和非普通区域，远端地图只能根据共享落地房间估算，不能用本 shard 地图代替远端地形。具体格子移动仍由 BetterMove 执行。Claim 身体寿命只有 600 tick，图费用不能保证实际寿命内抵达；GCL 不足、他人占领/预定、Portal 缺失等原因会显示在任务状态中。

实地侦察验证当时的连通性和现场条件，单 MOVE 的速度、沼泽疲劳与寿命不能代表满载运输工或 CLAIM 身体，也不能保证道路随后仍安全。实际工作单位继续检查入口与目标状态；需要改变路线时先停下等待新路线验证。自动路线默认 `verifyRoute: true`，手写固定路线保留默认 `false`，也可显式设置 `true`；`verifyRoute: false` 表示有意跳过这一步。同一候选路线的验证证明默认有效 6 小时，避免长途援建每 20 分钟陷入重新侦察的补员空窗；路线变更、真实 Portal 失效及新的失败报告仍立即失效。失败重试 60 秒，失败入口暂避 5 分钟，单次侦察总等待上限 30 分钟；这些策略在 `interShardPolicy.routeScouting`。已经开始的新一轮验证继续完成，不使用被旧版本丢弃的历史证明绕过身份与版本校验。

手写 `route` 的第一跳必须在当前 shard，每一跳接上下一跳；最后一跳到 `targetShard`，落地后自行前往 `targetRoom`。两种模式进门前均校验实际坐标及目的地。`sClaimer` 占领后停止续派；`sBuilder` 跳过 boost，在目标自采能或取现有能量，优先 Spawn，保持 Controller 不降级，之后继续建设及升级。占领后的规划和建设由持久蓝图服务执行。

`sHauler` 从起点的 Storage/Terminal/Container 装载，保留指定库存；多个运输工共用当 tick 取能预算。到达目标后先补 Spawn/Extension，再补仓储/Container；没有建筑时可以交给有空余容量的建造工，暂时没有接收者则保留 cargo 等待。目标尚未占领时等待，不向敌方建筑送能量。可指定 `sourceEnergyId` / `targetEnergyId` 作为优先物流建筑。

自动规划的运能任务默认往返，去返路线齐全后才开始派工；设置 `roundTrip: false` 可改单程，送完在目标 Spawn 回收并按任务续派。手写去程保持旧行为：未设置 `returnRoute` 为单程，提供则逐跳返程；也可设置 `roundTrip: true` 自动寻找返程。手写 Portal 坐标需替换为真实观察结果，例如：

```js
returnRoute: [
    { shard: 'shard1', roomName: 'W0N0', x: 20, y: 20,
      destinationShard: 'shard0', destinationRoom: 'W0N0' }
]
```

只运输到已占领房时设置 `claim: false, builders: 0, haulers: 2`。`energyAmount > 0` 在确认送达至少该量后停止续派和返程新一轮装载；`energyAmount: 0` 表示持续运输。建设任务还需目标自有房达到 `targetLevel` 且有 Spawn 才完成。送达量在后续 tick 看到 cargo 确实减少后累计，避免将被接收容量阻挡的成功意图误记；并发在途运输可使最终数量超过目标。

```js
shardTasks()                         // id、规划/侦察状态、去返程、单位、等级、送达量、错误
shardPortals()                       // Observer 数量、扫描状态、本地/远端已知 Portal
shardTaskPause('settle-east')         // 清除待孵化需求，停止续派和起点新一轮装载
shardTaskResume('settle-east')        // 恢复任务
shardTaskCancel('settle-east')        // 停止续派、新一轮装载及尚未执行的 claim
```

暂停/取消通过通信阻止目的地的 claim；在途运输可完成交付，已在目标的建造工继续维护自有房。任务保存到 `Memory.shardMissions`，目的地的送达记录保存到 `Memory.shardArrivals`。迁移使用 `InterShardMemory.ecbotShard` 信封并保留其它命名空间，提前发布完整 CreepMemory、下一跳、确认回执、毫秒 TTL 和租约；跨出起点的单位不会被当作死亡立即补派。坏 JSON、满容量或写入失败时不踏入 Portal；确认入境后消失的单位会在宽限期后补员，失联单位则在租约超时后补员。

## CPU 检查与优化

默认开启模块 CPU 统计，累计 100 tick 后输出首份报告，此后每 100 tick 输出一次。报告按最近 100 tick 的平均 CPU 降序列出全部主循环模块，以及房间、跨 shard 和 Creep 角色的细项；包含均值、单 tick 峰值及当前 tick 消耗。游戏控制台可随时查询：

```js
cpuProfile()                 // 按 rollingAverage 排序，默认前 10 项
cpuProfile(undefined, 100)   // 查看全部模块和细项
cpuProfile(false)
cpuProfile(true)
cpuReset()
```

`rollingAverage` 是最近 100 个游戏 tick 的平均值，`rollingTotal` 为窗口总量，`rollingMax` 为窗口内单 tick 峰值，`current` 为当前 tick 消耗，`windowTicks` 为实际覆盖的 tick 数。预热不足 100 tick 时按已覆盖 tick 数计算；同一模块在一个 tick 内的多次调用相加，未运行的 tick 按 0 计入，因此周期任务不会被误算为每 tick 都执行。旧的 `average`、`total`、`max`、`count` 和 `ema` 字段保留为本次 VM 生命周期的累计/采样统计。

`tick:*` 为主循环阶段，`room:*` 为所有自有房间同一业务的合计，`shard:*` 为跨 shard 子流程，`creep:*` 为同类角色所有单位的执行合计。细项已包含在对应主循环阶段中，不能与主循环消耗相加；日志将两组分开。统计不包含主循环外的 VM 初始化及日志输出本身。

首阶段 `tick:memory` 只触碰原生 Memory，把首次访问的解析成本单独记录，不改持久数据。此前这项开销会计入最先访问 Memory 的 Portal 发现阶段；因此新旧 `shard:portalDiscovery` 数字不能直接当作优化降幅，应同时比较主阶段总量和 `tick:memory`。[官方文档](https://docs.screeps.com/global-objects.html#Serialization)说明首次访问的 JSON 解析计入脚本 CPU。

配置在 `src/settings/runtime.ts` 的 `runtimePolicy.profiling`：`enabled` 总开关、`windowSize` 滚动窗口（默认 100）、`logInterval` 输出周期（默认 100）、`logEnabled` 自动日志、`logDetails` 日志细项、`roleDetails` 角色聚合、`shards` 测量范围、`maximumEntries` 聚合容量和 `topCount` 控制台默认条数。原来的逐只 Creep 慢操作提示由 `creepDetails` 控制，默认关闭，避免每 tick 排序和刷屏；房间单次提示仍由 `roomPolicy.profiling` 独立控制。关闭统计后不增加阶段 CPU 查询或排序。

数据保存在当前 VM 的有界环形窗口中，不逐 tick 写入 Memory。VM reset 或 `cpuReset()` 后重新预热；控制台开关仅作用于当前 VM，持久默认值需修改配置并构建上传。

本次性能改动减少重复 JS 遍历：全局旗帜每 tick 只处理一次，建筑一次分组，processer 共享当 tick 房间索引，Lab 缓存本次调用的资源量并单遍计数身体，终端任务建立索引，选择最低能量房用单遍比较，跨 shard 报告也按任务一次分组。未解锁 Lab 的房间跳过蓝图 Lab 匹配，工地全局预算只在实际巡检时统计。现存 Store、单位位置、建筑和工地仍按当前 tick 读取。

本地相同快照的访问次数对比（不等同实服 CPU 百分比）：

| 工作负载 | 原访问次数 | 优化后 |
| --- | ---: | ---: |
| 10 个 Lab 初始化底物查询 | 20 | 2 |
| 多候选反应的 Creep 枚举 | 16 | 1 |
| 40 种资源检查 100 个终端任务 | 4000 | 100 |
| 120 建筑、多类型 getter 的类型读取 | 1002 | 120 |
| 5000 建筑、20 Observer、25 tick 的发现索引：建筑属性读取 | 125000 | 5500 |
| 11 房间各 300 道路、首条需维修：hits 查询 | 3300 | 11 |
| 高血量/满血 Rampart 的覆盖测试：逐点 lookFor | 4 | 0 |

根据实服热点追加了 Observer ID 索引（默认每 25 tick 刷新）、连续可见空十字房短周期重扫（默认 25 tick），以及同 tick 的房间状态缓存和候选单遍选择。新视野立即检查，已知门所在房间每 tick 检查，门消失/改变/临时门安全寿命照常确认；已缓存 Observer 的销毁或失活立即生效，新建 Observer 最多等待一个索引刷新周期。这两个周期在 `interShardPolicy.portalDiscovery` 中配置。

房间维修按结构组优先选择首个符合条件的目标；道路微伤默认攒至按塔距离计算的一次维修量，至少达到 `min(200, hitsMax×5%)`，已发现血量≤50%的道路立即修，其他建筑仍即时维修。和平自有 RCL8 且 bucket＜1000 时，道路完整巡检每 10 tick 按房名错峰；仅缓存达到维修条件的道路 ID，每 tick 读取当前对象，满血/消失时移除，微伤道路留到下次巡检判断。新达阈值或危急道路最多一个巡检周期后发现，敌情、战争及敌人离开后的保护期恢复完整扫描，bucket 恢复也回到每 tick。参数在 `roomPolicy.defense`。初始化直接补齐缺失的维修塔 ID，人工旗帜仍可覆盖，避免多房争用同一个全局旗帜。终端矿物分发仍每房每 30 tick 一次，默认按稳定房名错峰；`roomPolicy.terminal.staggerDistribution=false` 可恢复原同步周期，`logTransfers=true` 可恢复逐笔排队日志。终端索引只缓存当前 tick 的成员和队列关系，Store 数量实时读取。

持续超时后的追加优化：采矿工根据实际有效 WORK/boost 和 CARRY 容量攒批转移，5WORK/1CARRY 保持每 tick 采集 10 能量、稳定每 4 tick 卸载一次，不同单位错峰。工作位几何仅在本 tick 复用，远处 Link 不调用活性检查，健康身体的有效产量在 RAM 缓存；采集统计按真实快照容量/剩余源能量估算，不重复扫描身体。

和平时 bucket＜1000，高血屏障的维修工每 5 tick 执行一次并错峰；≤100,000 血量、刚建成的低血屏障、有敌情或战争时立即维修，取能和无屏障时的控制器维护仍正常执行。参数在 `rolePolicy.repairer.cpuMaintenance`。和平房不预热防御矩阵，按需且同 tick 只生成一次。实验室配置保持每房 10 tick 周期并错峰，boost 需求仍每 tick 汇总；能量补给队列同 Lab 不重复入队，旧重复项原地清理。同房反应 Lab 共用本 tick、同底物 ID 的对象查找，各自仍读取实际库存/冷却并发布反应。市场自动出售默认每房 25 tick 查询一次并错峰，中央终端储量配置继续即时更新，手动调用出售函数仍即时。

成熟房间的蓝图巡检错峰；和平 RCL8 且 bucket＜1000 时改为每 100 tick 巡检，平时为 10 tick。首次保存、升级、强制规划及最后一个 Spawn 丢失时仍立即检查，未到期时跳过元数据/占位扫描。参数在 `constructionPolicy.building.lowBucketInspection/staggerMatureInspections`。正常房间状态默认缓存 100 tick，异常下一 tick 重试；Portal 寿命/实际消失/新视野仍立即确认，稳定扫描历史每 25 tick 维护。参数分别在 `roomPolicy.labs/market/defense`、`interShardPolicy.portalDiscovery`。

`cpuProfile()` 的 `sampledTicks`/`sampledAverage` 显示实际采样 tick 数及这些 tick 的平均消耗；自动日志显示末阶段覆盖数。硬超时可能使未完成及后续阶段缺样，缺样窗口的 `rollingAverage` 会低估消耗，应结合 bucket、配额和覆盖数判断。`node scripts/development-monitor.cjs shard3 --cpu` 可只读采样，`--miners` 查看矿工身体/采集状态；`node scripts/cpu-maintenance-diagnostics.cjs shard3 E31N2 E41N8` 可只读检查道路损伤、屏障和 PowerSpawn。

repairer 单遍选最低血墙并立即使用新目标；harvester 复用就绪状态及脚下工地，单遍选容器；filler 复用有效目标，单遍检查补给任务，跳过已失效或满的 Lab/Tower。公共拾取找到首个可取资源即停止，每 tick 只发布一次拾取/取出意图；不会让无可取矿物的废墟挡住后面的能量。

授权读取官服时，可运行 `node scripts/cpu-baseline.cjs shard3 --listen=120`：从现有 `main` 配置认证，只读获取 Memory 大小、统计 CPU、角色记录数量及后续模块 CPU 日志。凭据仅保留在进程中，不打印、不复制到报告；此脚本不上传代码、不执行游戏控制台或写 Memory。采集的优化前数据见 [实服 CPU 基线](docs/cpu-baseline.md)。

Scout 排查可用 `node scripts/scout-diagnostics.cjs` 读取各 shard 的任务和单位记录，或 `node scripts/scout-monitor.cjs shard3 --watch=120` 每 20 秒提交只读控制台表达式，观察实际单位位置和任务代际。正式上传先执行 `npm run build`，再执行 `node scripts/official-upload.cjs --upload`；不带 `--upload` 仅比较散列。上传脚本使用配置的官服分支、保留其他模块，并回读验证两个构建模块完全一致，账号凭据不输出。

测试包含意图延迟、不同 shard 时钟和真实跨 shard 模块的双 shard 模拟。已读取官服优化前 CPU 与规模基线；本地访问次数对比不能代表实服 CPU 降幅，优化后的数值仍需部署后采满 100 tick 对比。

## 配置入口

业务配置集中在 `src/settings/`，编辑后重新构建并选择上传目标。周期单位为 tick，距离单位为房间格，库存和批次数量单位为资源量；周期应为正整数，比例通常应在 0..1 内。默认阈值沿用原策略。

| 文件 | 负责配置 |
| --- | --- |
| `runtime.ts` | Pixel、私服补能、CPU 采样/性能日志、战争暂停范围 |
| `population.ts` | 需求刷新周期、外矿/任务旗帜数量、人数与库存关系、防御需求阈值 |
| `construction.ts` | 63bot 规划 CPU/重试预算、补建周期、工地限额、建筑阶段和优先级 |
| `interShard.ts` | 通信命名空间/peer、TTL、租约/报告、库存/人数、Observer/Portal 目录、图路由预算、主动探门预算和实地侦察验证 |
| `roomPolicy.ts` | 布局、实验室、终端调度、防御扫描、出售规则、房间旗帜名称 |
| `rolePolicy.ts` | 各角色拾取距离、维修、预定、战斗、双人队与 PowerCreep 策略 |
| `structures.ts` | 建筑补给、Power 处理、Link、Lab、墙血量、缓存与资源显示阈值 |
| `navigation.ts` | BetterMove 初始化选项、缓存期限、寻路预算与 tick 时间估值 |
| `controllerLayout.ts` | 控制器三格容器、升级/搬运站位、旧蓝图迁移预算 |
| `aidBuilder.ts` | 援建有效拾取量、部分载荷等待、阻塞重试与候选预算 |
| `creep.ts` | 角色枚举、身体模板、孵化优先级及战争允许角色 |
| `bodyPolicy.ts` | 按任务生成身体、路况、WORK/CARRY 目标、战斗比例、强化选择与超时 |
| `room.ts` | 签名文本、预定签名及资源库存目标 |
| `boost.ts` / `labs.ts` | 角色强化资源、反应配方与合成目标 |
| `layout.ts` | 保留的旧固定布局数据；默认建设使用房间持久蓝图 |
| `settings.ts` | 友军名单、避让房间、Observer 寻路配置、缓存键前缀与颜色 |
| `scripts/policy.py` | Python 辅助工具的目标环境、采购批量/价格策略和墙体分析半径 |

例如，将需求刷新从 5 tick 改为 10 tick，修改 `populationPolicy.refreshInterval`；调整升级工数量，修改 `populationPolicy.base.energyPerUpgrader` 和 `maximumUpgraders`。修改外矿数量只需改 `maximumRemoteRooms`，Scout 与需求发布会共同使用该值。

`runtimePolicy.warModeScope` 默认是 `empire`，保持原有任意房间进入战争后全帝国暂停非战争角色的策略；设置为 `room` 时仅暂停受攻击房间的相关角色。

以下数值没有机械地提成可调参数：0/1 控制值、固定交互距离、房间坐标编码、CostMatrix 的 255 阻塞值、身体/布局数据表和第三方工具内部算法常量。已有游戏 API 常量可直接复用，例如 `LAB_BOOST_MINERAL`、`POWER_SPAWN_ENERGY_RATIO`；建筑实际容量用 Store API 查询。旗帜和 Memory 字段属于持久协议，修改名字前需要考虑旧数据。

## 上传与本地复制

原有 `push-*` / `watch-*` 保留，目标仍从不入库的 `screeps.json` 读取；可参考 `screeps.sample.json`。执行这些命令会上传到相应目标。

```sh
npm run push-main
npm run push-local
```

如果通过桌面客户端的脚本目录加载代码，使用 PowerShell 显式指定目标：

```powershell
$env:SCREEPS_LOCAL_SCRIPTS = '你的 Screeps 脚本目录'
npm run copy-local
```

该命令复制 bundle 与可加载的 `main.js.map.js`。没有配置路径时直接报错，项目不再包含某个开发者的绝对脚本目录。

## 本次兼容性处理

`module/CreepController.ts` 和 `module/RoomController.ts` 保留原公开入口，原型挂载、角色名称、`processer` / `squard` 的旧拼写、Creep 名称哈希及 Memory 字段继续兼容。业务职责从大控制器迁移到 `creep/` 与 `room/`；角色和编队的错误按单位隔离，前置 tick 阶段出错仍由 ErrorMapper 兜底。

同时处理首次运行内存缺项、旧孵化队列、无塔治疗、未知/未实现角色、双人队第一成员死亡、PowerCreep 缺少房间视野/续命建筑、旗帜位置无对应建筑、中央仓库缺失和安全模式无冷却字段等边界。私服补能计算包含终端已有能量，并限制库存需求、批次、终端容量、余额及传输费用；一个房间每 tick 最多一次成功成交。

验证属于本地类型、构建和模拟回归；游戏内 CPU、实际经济收益和跨房间长期表现仍需在自己的服务器运行观察。
