import { roomPolicy } from 'settings/roomPolicy'
import { populationPolicy } from 'settings/population'
import { remoteRoadPolicy } from 'settings/remoteRoads'
import { runtimePolicy } from 'settings/runtime'
import { interShardPolicy } from 'settings/interShard'
import { combatPolicy } from 'settings/combat'
import { haulerRelayPolicy } from 'settings/haulerRelay'
import { spawnPriority } from 'settings/creep'

export interface HelpEntry {
    /** Exact mounted name, or a flag/configuration pattern. */
    name: string
    signature: string
    summary: string
    details?: string[]
    examples?: string[]
    aliases?: string[]
    /** Match a concrete user-created flag name, using normalized lower-case input. */
    pattern?: RegExp
}

export interface HelpSection {
    topic: string
    title: string
    aliases: string[]
    notes?: string[]
    entries: HelpEntry[]
}

const flags = roomPolicy.flags
const remoteLast = populationPolicy.maximumRemoteRooms - 1
const jobLast = populationPolicy.maximumJobFlags - 1

/** A single inventory for the overview, topic pages and individual-command lookup.
 * Rendering never executes examples or reads Game/Memory; opening help issues no intents.
 */
export const helpSections: HelpSection[] = [
    {
        topic: 'overview', title: '帮助与总览', aliases: ['help', '总览', '帮助'],
        entries: [
            { name: 'help', signature: 'help(topic?, format?)', summary: '全部操作总览；按分类或指令名查询；all 显示完整手册。',
                details: ['format 默认 html，适合游戏控制台；text 返回纯文本。帮助只展示说明，不执行任何操作。',
                    '分类：overview / shard / combat / body / cpu / resources / room / flags / config / movement / power。'],
                examples: ['help()', 'help("flags")', 'help("shardTask")', 'help("all")', 'console.log(help("flags", "text"))'] },
            { name: 'info', signature: 'info()', summary: '当前 shard 可见自有房的运营、Lab、墙厚和资源 HTML 总表。',
                details: ['房间须已经过 bot 初始化；只读。'], examples: ['info()'] },
            { name: 'res', signature: 'res()', summary: '当前 shard 可见自有房的资源总表；等同 HelperRoomResource.showAllRes()。',
                details: ['有 Storage 或 Terminal 的自有房参与合计；实际统计 Storage、Terminal、Factory、Lab，不含 Container、地面或爬。'],
                examples: ['res()'] },
            { name: 'HelperRoomResource.showAllRes', signature: 'HelperRoomResource.showAllRes()', summary: '返回所有参与统计房间的资源 HTML 总表。',
                aliases: ['showAllRes'], examples: ['HelperRoomResource.showAllRes()'] },
            { name: 'HelperRoomResource.showRoomRes', signature: 'HelperRoomResource.showRoomRes()', summary: '输出所有可见自有房的图形资源表，并返回本次 CPU 耗时。',
                details: ['无 roomName 过滤参数；图形依赖外部 ECharts 脚本。'], aliases: ['showRoomRes'],
                examples: ['HelperRoomResource.showRoomRes()'] },
            { name: 'HelperRoomResource.getStorageTerminalRes', signature: 'HelperRoomResource.getStorageTerminalRes(room)', summary: '内部只读聚合：房间 Storage、Terminal、Factory、Lab 的资源量对象。',
                aliases: ['getStorageTerminalRes'], examples: ['HelperRoomResource.getStorageTerminalRes(Game.rooms.E31N2)'] },
            { name: 'HelperRoomResource.addStore', signature: 'HelperRoomResource.addStore(accumulator, store)', summary: '内部聚合：把 store 中正数原地累加到 accumulator，并返回 accumulator。',
                aliases: ['addStore'], details: ['仅用于资源统计，不执行原生资源搬运。'], examples: ['HelperRoomResource.addStore({}, Game.rooms.E31N2.storage.store)'] },
        ],
    },
    {
        topic: 'shard', title: '跨 shard 开房、援建与运能', aliases: ['shards', '跨服', '跨shard', '援建'],
        notes: ['在起点 shard 的控制台发布。中转 shard 可以没有房间，但沿途 shard 均须运行本 bot 并分配 CPU。'],
        entries: [
            { name: 'shardTask', signature: 'shardTask(sourceRoom, "shard/targetRoom", options?) / shardTask(config)', summary: '指定起终房间，自动探门、规划并实地验证后派工作爬。',
                details: [
                    '起点必须是当前 shard 可见自有且有 Spawn 的房间；claim=true 时能量容量至少 650。对象形式必须含 sourceRoom、targetShard、targetRoom。',
                    `默认 claim=true、builders=2、haulers=0、targetLevel=${interShardPolicy.defaultTargetLevel}、energyAmount=0、homeEnergyReserve=${interShardPolicy.minimumHomeEnergyReserve}。`,
                    `builders/haulers 为非负整数；builders+haulers+(claim?1:0) ≤ ${interShardPolicy.maximumUnitsPerTask}；targetLevel 为 1..8。`,
                    '建设目标（targetLevel 且已有 Spawn）和运能目标均达到后任务自动结束；energyAmount=0 持续运能，会保持任务及建筑工配额，正整数以已确认送达量计。仅运能应设 claim:false, builders:0。',
                    '省略 route 自动观察 Portal（不要传空数组）；缺情报默认主动探门，scout 先走最近的合适入口逐段验证。已发现 Portal 和验证路线持久保存，满足有效性条件时新任务复用。',
                    'verifyRoute / explorePortals：自动去程或自动返程默认 true。固定路线可开启 verifyRoute 验证；主动探门只对自动规划段有效，固定去返程单独设 explorePortals:true 不会探门。自动路线有 haulers 时默认往返，roundTrip:false 改单程。',
                    '固定 route 默认单程；roundTrip:true 才自动规划返程，也可指定 returnRoute。显式 returnRoute 会用于往返，roundTrip:false 不会取消它。',
                    `往返搬运工卸空并确认送达后，寿命不足以返程、重装和再次送达（含 ${interShardPolicy.haulerLifetime.safetyTicks} tick 安全余量）时在目标房自杀并按名额补派；退休通知发布失败原地重试。`,
                    'route/returnRoute 为 PortalHop[]：每跳 {shard,roomName,x,y,destinationShard,destinationRoom?}，出发 shard 连续衔接，去程到目标、返程回起点。',
                    'sourceEnergyId / targetEnergyId：可选取能/存能建筑 ID；homeEnergyReserve 为起点保留能量整数。',
                    'id 可选；默认 auto_起点房_目标shard_目标房。已存在的 id（含完成任务）不能覆盖；再次发布用新的 id。状态操作须在任务起点 shard 执行，可用短 id 或 shard:id，不能借前缀在其它 shard 远控。',
                    '全部选项：id, sourceRoom, targetShard, targetRoom, route, returnRoute, roundTrip, verifyRoute, explorePortals, claim, builders, haulers, targetLevel, energyAmount, sourceEnergyId, targetEnergyId, homeEnergyReserve。',
                ], examples: [
                    'shardTask("E31N2", "shard1/E39N5")',
                    'shardTask("E31N2", "shard1/E39N5", {id:"aid1", builders:2, haulers:2, targetLevel:8})',
                    'shardTask({id:"energy1", sourceRoom:"E31N2", targetShard:"shard1", targetRoom:"E39N5", claim:false, builders:0, haulers:2, energyAmount:50000})',
                ] },
            { name: 'shardTasks', signature: 'shardTasks()', summary: '全部跨 shard 任务：状态、路由、侦察、在途单位和已送达能量。', examples: ['shardTasks()'] },
            { name: 'shardPortals', signature: 'shardPortals()', summary: '已知 Portal 与探门情报、有效性状态。', examples: ['shardPortals()'] },
            { name: 'shardTaskPause', signature: 'shardTaskPause(id)', summary: '停止续派及起点新一轮装载，撤出生队列并广播暂停状态。',
                details: ['在任务起点 shard 操作；在途/目的地 Builder、outbound 运能爬可能继续当前工作或交付。不会统一冻结或瞬间传回起点。'], examples: ['shardTaskPause("aid1")'] },
            { name: 'shardTaskResume', signature: 'shardTaskResume(id)', summary: '恢复已暂停的任务。', examples: ['shardTaskResume("aid1")'] },
            { name: 'shardTaskCancel', signature: 'shardTaskCancel(id)', summary: '取消任务、停止续派和起点新装载并广播状态。',
                details: ['在任务起点 shard 操作；不统一撤回全部工作爬，目的地 Builder 仍可能继续工作，运能爬回源后才结束回收。'], examples: ['shardTaskCancel("shard3:aid1")'] },
            { name: 'dismantleTask', signature: 'dismantleTask(home, flagName, options?)', summary: '创建通用黄球任务，随目标 shard 的指定旗移动调整拆迁位置。',
                details: ['home 为当前 shard 的自有出生房；flagName 为目标 shard 上的旗名，旗颜色不限。options：id、targetShard、route、maxEnergy、workParts、boostTier。',
                    'targetShard 默认当前 shard，同 shard 不需要 route；跨 shard 必须提供明确逐跳 Portal 路线，沿途运行本 bot。',
                    '只拆旗子所在一格的合法敌方建筑，优先 Rampart，再 Wall，再其他建筑；不拆邻格。移动旗立即切换位置，空格或删旗则让路等待，重放旗可继续。',
                    'boostTier 为 0..3，默认 T3；workParts 可指定 WORK 数，MOVE 按平原速度和强化计算，省略时按房间能量容量选最大身体。等待完整出生能量和所需强化，不随当前能量缩小。',
                    '只保留一个单位名额，确认死亡后补派；跨 shard 失联不释放名额。maxEnergy 默认 180000，仅实际出生成功记账，耗尽可用 dismantleResume 增加预算。',
                    '无视野的旗位可先派单位取视野；已确认空格不会因随后失去视野而反复派兵。命令创建后才派兵，不扫描所有旗自动建任务。'],
                examples: ['dismantleTask("W1N1", "yellow", {id:"yellow1", boostTier:0, workParts:5})', 'dismantleTasks("yellow1")'] },
            { name: 'dismantleTasks', signature: 'dismantleTasks(id?)', summary: '查看全部或单个黄球任务的旗位置、名额、已花费能量、预算和等待原因。', examples: ['dismantleTasks()', 'dismantleTasks("yellow1")'] },
            { name: 'dismantlePause', signature: 'dismantlePause(id)', summary: '暂停黄球移动、强化、拆除及后继补派，保留现有名额。', examples: ['dismantlePause("yellow1")'] },
            { name: 'dismantleResume', signature: 'dismantleResume(id, options?)', summary: '恢复黄球任务，可用 options.maxEnergy 调整出生能量总预算。',
                details: ['maxEnergy 不能低于已花费能量。恢复不会清空跨 shard 名额，也不会强制重复派兵；已有强化失败单位仍停止工作。'], examples: ['dismantleResume("yellow1")', 'dismantleResume("yellow1", {maxEnergy:360000})'] },
            { name: 'dismantleCancel', signature: 'dismantleCancel(id)', summary: '取消黄球任务，停止后继补派并通知存活单位让出通道。', examples: ['dismantleCancel("yellow1")'] },
            { name: 'shardDismantleTask', signature: 'shardDismantleTask(id, config)', summary: '兼容配置入口：旗模式或旧有限目标列表模式。',
                details: ['config：sourceRoom、targetShard、targetRoom、route、flagName、targets、controller、maxEnergy、workParts、boostTier。',
                    'flagName 模式无需 targets/controller/targetRoom；旗位置实时决定工作点。targetShard 默认当前 shard，同 shard 可省略 route。',
                    '旧 targets 含 id/x/y/type，最多 8 个；type 为 rampart 或 constructedWall。旧列表和 controller 完成条件继续兼容。'], examples: ['help("dismantleTask")'] },
            { name: 'shardDismantleTasks', signature: 'shardDismantleTasks(id?)', summary: '兼容拆除任务查询，等同 dismantleTasks。', examples: ['shardDismantleTasks()'] },
            { name: 'shardDismantlePause', signature: 'shardDismantlePause(id)', summary: '兼容拆除任务暂停，等同 dismantlePause。', examples: ['shardDismantlePause("yellow1")'] },
            { name: 'shardDismantleResume', signature: 'shardDismantleResume(id, options?)', summary: '兼容拆除任务恢复及预算调整，等同 dismantleResume。', examples: ['shardDismantleResume("yellow1")'] },
            { name: 'shardDismantleCancel', signature: 'shardDismantleCancel(id)', summary: '在起点 shard 取消精确拆除任务，停止续派并让远端单位让出通道。', examples: ['shardDismantleCancel("open_controller")'] },
        ],
    },
    {
        topic: 'combat', title: '战斗任务', aliases: ['war', '战斗', '进攻', '驻守'],
        notes: ['同 shard 操作；起点防御优先。旧进攻旗已停用，使用任务发布。'],
        entries: [
            { name: 'combatTask', signature: 'combatTask(home, target, options?)', summary: '自动侦察敌情，规划一体机、二人或四人编队执行进攻/驻守。',
                details: [
                    'home 是当前 shard 可见自有且有 Spawn 的房；target 是房名。不能攻击自己或白名单玩家。Observer/scout 侦察后按算伤结果规划，资源/CPU/寿命等不足时等待。',
                    'mode:"attack"（默认）或 "hold"；formation:"auto"（默认）/"solo"/"duo"/"quad"。',
                    'boostTier:"auto"（默认）或 0/1/2/3；auto 选择能满足战斗要求且综合成本最低的配置。',
                    `timeoutTicks：attack 默认 ${combatPolicy.defaultTimeoutTicks}，hold 默认无超时；holdTicks 省略则持续驻守，指定后从真正到达目标开始计时。`,
                    `maxWaves 默认 ${combatPolicy.maximumWaves}；maxEnergy 默认 ${combatPolicy.maximumTaskEnergy}，为任务真实孵化能量预算，包含支援单位。`,
                    'controllerAttack/loot 默认 true；attack 清场后，玩家目标自动派控制器攻击爬，NPC 目标搬战利品，最终完成释放任务；hold 不自动走进攻收尾。',
                    'id 可选。全部选项：id, mode, formation, boostTier, timeoutTicks, holdTicks, maxWaves, maxEnergy, controllerAttack, loot。',
                ], examples: [
                    'combatTask("E31N2", "E32N2", {id:"raid1", mode:"attack", formation:"auto"})',
                    'combatTask("E31N2", "E32N2", {id:"guard1", mode:"hold", holdTicks:1500, boostTier:2})',
                ] },
            { name: 'combatTasks', signature: 'combatTasks(id?)', summary: '全部任务摘要；传 id 查看单任务侦察、编队、预算和错误详情。', examples: ['combatTasks()', 'combatTasks("raid1")'] },
            { name: 'combatTaskCancel', signature: 'combatTaskCancel(id)', summary: '取消任务、撤出生队列，现存单位携货返家回收。', examples: ['combatTaskCancel("raid1")'] },
        ],
    },
    {
        topic: 'body', title: '身体配置与强化', aliases: ['bodies', '身体', '强化', 'boost'],
        entries: [
            { name: 'bodyPreview', signature: 'bodyPreview(room, role)', summary: '只读预览 T0/T1/T2/T3 身体、部件、能耗、药量和 canPrepare。',
                details: ['房间需可见自有。预览会显示当前无法准备的配方，不保证马上能孵化或强化。',
                    `有效角色（区分大小写）：${Object.keys(spawnPriority).filter(role => role != 'rAttacker').join(', ')}。`,
                    'processer / rdefender 保持现有拼写；rAttacker 已停用，team 不支持此入口。'], examples: ['bodyPreview("E39N5", "upgrader")'] },
            { name: 'bodyConfig', signature: 'bodyConfig(room, role, profile?)', summary: '省略配置只读；对象合并角色覆盖；null 恢复默认。',
                details: [
                    '只影响后续出生，不增加人口、不改变已出生的 body；任务专属 bodyProfile 及发展期预算可优先于房间覆盖。',
                    '字段：boostTier:0|1|2|3，terrain:"road"|"plain"|"swamp"，boostFallback:"unboosted"|"wait"，stationary:boolean。',
                    'workParts/carryParts/combatPrimaryParts：整数 1..50；combatHealParts/combatToughParts：整数 0..50；maximumCost：整数 ≥0。未知字段拒绝。',
                    'carryParts 表示未强化 50 容量等价目标，强化后实际 CARRY 数可减少；配置不能突破 50 部件与房间孵化预算。',
                    '显式 boostTier 缺药默认退回 T0；boostFallback:"wait" 才等待。经济角色默认 T0；不指定等级的 attacker/healer/dismantler/integrate 自动尝试 T3→T2→T1→T0。实际准备情况用 bodyPreview 检查。',
                ], examples: ['bodyConfig("E39N5", "upgrader")',
                    'bodyConfig("E39N5", "upgrader", {boostTier:2, terrain:"plain", boostFallback:"wait", workParts:20})',
                    'bodyConfig("E39N5", "upgrader", null)'] },
        ],
    },
    {
        topic: 'cpu', title: 'CPU 与运输交接统计', aliases: ['profile', '性能', '统计'],
        entries: [
            { name: 'cpuProfile', signature: 'cpuProfile(enabled?, limit?)', summary: `最近 ${runtimePolicy.profiling.windowSize} tick 各模块 CPU 滚动平均、峰值和当前值。`,
                details: [`日志默认每 ${runtimePolicy.profiling.logInterval} tick 输出。未运行的 tick 按零计入；子模块已包含于顶层耗时，不能重复相加。`,
                    'enabled 省略只读，true/false 开关；limit 限制返回的阶段条数，0 返回空列表。开关仅改当前 heap 配置，全局重置后回到 settings/runtime.ts 默认值。'],
                examples: ['cpuProfile()', 'cpuProfile(undefined, 100)', 'cpuProfile(true, 30)', 'cpuProfile(false)'] },
            { name: 'cpuReset', signature: 'cpuReset()', summary: '清空 CPU 统计，重新积累窗口。', examples: ['cpuReset()'] },
            { name: 'haulRelay', signature: 'haulRelay()', summary: `最近 ${haulerRelayPolicy.statisticsWindow} tick 搬运交接候选、检查、成功配对及交接能量。`,
                details: ['统计保存在 heap，全局重置后重新开始；不改变物流任务。'], examples: ['haulRelay()'] },
        ],
    },
    {
        topic: 'resources', title: '终端任务与资源归集', aliases: ['resource', '资源', '终端'],
        notes: ['发送是排队操作。实际发货考虑冷却、目标容量和手续费，并保留终端 50000 能量。自动调度识别启用 Power 的 8M Storage 仓库；普通房常备 T3 20000、基础矿/G 10000、OPS 5000。collectTypeResource / collectRoomResource 人工命令仍依赖 Memory.centerStorage，collectResourceSend 使用显式目标房。'],
        entries: [
            { name: 'evacuateRoom', signature: 'evacuateRoom(sourceRoom, targetRoom)', summary: '撤房清仓：持续归集全部可搬资源，分批经终端送往指定房间。',
                details: ['在起点所在 shard 执行，起终点须为不同的可见自有房，且都有可用 Terminal；目标不能也在撤离。相同起终点重复调用不会重建任务，改目标须先取消。',
                    '暂停源房采集、建设、升级、生产、交易和普通资源补给，复用搬运爬清空仓库、工厂、Lab、Container、Link、其它可取货建筑以及地面、墓碑和废墟；已有经济爬先卸货，缺搬运工时自动补充。',
                    '先送非能量资源，保留其交易费，最后发送扣除运费后的剩余能量。终端冷却、目标满或费用不足时等待，不会把入队当作送达。',
                    'Nuker 内的资源原生不能取出，末尾可能剩下不足运费的微量能量；状态会单列这些余量，不会自动拆建筑。',
                    'Spawn 原有能量先清空，随后原生被动再生的尾能量单列 passiveGeneration，不会让任务永远等不到零库存；新补入的库存会重新归集。',
                    '任务和暂停状态保存在 Memory，全局重置后继续；完成后保持暂停，直到取消或手动 unclaim。此命令不会自动 unclaim。'],
                examples: ['evacuateRoom("E31N2", "E41N8")', 'evacuationStatus("E31N2")'] },
            { name: 'evacuationStatus', signature: 'evacuationStatus(sourceRoom?)', summary: '查看单房或全部撤房任务的剩余资源、已发送量和等待原因。',
                details: ['确认 readyToUnclaim 为 true，并核对 nonWithdrawable、energyDust 和 passiveGeneration 后再手动 unclaim；仍有携货爬或原有可搬资源时继续清仓。'],
                examples: ['evacuationStatus()', 'evacuationStatus("E31N2")'] },
            { name: 'evacuationCancel', signature: 'evacuationCancel(sourceRoom)', summary: '取消指定房间清仓并恢复原运营策略。',
                details: ['已发送的资源不自动退回；本 tick 已提交的原生动作仍可能执行。',
                    '被接管的经济爬先卸空已携资源，再恢复原角色；仓库和终端满时保留货物等待。'], examples: ['evacuationCancel("E31N2")'] },
            { name: 'Game.rooms[room].sendResource', signature: 'Game.rooms[room].sendResource(targetRoom, resourceType, amount)', summary: '给该房添加终端发送任务；相同来源/目标/资源重复调用覆盖数量。',
                aliases: ['sendResource'], details: ['需要可见且已初始化的房间；拒绝非正数/非有限数量、同房发送与撤离房。返回 true 仅表示入队，未验证目标是否有可用终端。'],
                examples: ['Game.rooms.E31N2.sendResource("E32N2", RESOURCE_ENERGY, 10000)'] },
            { name: 'Game.rooms[room].getResource', signature: 'Game.rooms[room].getResource(type, storage?, terminal?, lab?, processer?)', summary: '只读资源合计；默认仅 Storage，可选 Terminal/Lab/processer。',
                aliases: ['getResource'], details: ['布尔参数默认 true,false,false,false；不包含 Container、地面资源或普通采运工。'],
                examples: ['Game.rooms.E31N2.getResource(RESOURCE_ENERGY, true, true, false, false)'] },
            { name: 'collectTypeResource', signature: 'collectTypeResource(resourceType)', summary: '所有可见自有房 Storage+Terminal 的指定资源排队送中央仓库。',
                details: ['同房发送会被拒绝；普通终端发送仍保护常备库存，完整清仓请使用 evacuateRoom。返回 true 只表示调用完成。'], examples: ['collectTypeResource(RESOURCE_POWER)'] },
            { name: 'collectResourceSend', signature: 'collectResourceSend(resourceType, roomName)', summary: '所有其它可见自有房归集指定资源到 roomName，同时排出非原料 Lab 矿物。',
                details: ['合计 Storage、Terminal、Lab、processer。所有自有房的非原料 Lab 都可能加入 labOut，不局限于指定矿物；包含目标房的 Lab 清理。'],
                examples: ['collectResourceSend(RESOURCE_CATALYZED_GHODIUM_ACID, "E31N2")'] },
            { name: 'collectRoomResource', signature: 'collectRoomResource(roomName)', summary: '该房 Storage/Terminal 的非能量资源排队送中央仓库。',
                details: ['房间须可见自有，未见房间会报错；不搬能量。同种资源在两个建筑都有时发送队列数量按最后一次写入覆盖。'],
                examples: ['collectRoomResource("E32N2")'] },
            { name: 'clearSendJobs', signature: 'clearSendJobs()', summary: '清空全部可见自有房的终端发送队列。',
                details: ['自动资源平衡随后仍可创建新的发送任务。单任务可删除 terminalSendJob 中对应的 来源_目标_资源 key。'],
                examples: ['clearSendJobs()', 'delete Game.rooms.E31N2.memory.terminalSendJob["E31N2_E32N2_energy"]'] },
            { name: 'resetReactionConfig', signature: 'resetReactionConfig()', summary: '全部可见自有房清 Lab 反应配置与 labInMineral 补给队列。',
                details: ['不会物理清空 Lab，也不是永久停合成；自动调度会再次分配。'], examples: ['resetReactionConfig()'] },
        ],
    },
    {
        topic: 'room', title: '房间建设与管理工具', aliases: ['房间', '建设', '布局'],
        notes: ['新自有 RCL1–7 首次自动规划；RCL8 首次保存当前布局，此后按持久蓝图补建。layout 预览、planRoomStructure 仅强制补建。'],
        entries: [
            { name: 'buildRoad', signature: 'buildRoad(x1, y1, x2, y2, roomName)', summary: 'PathFinder 路径沿线在可见房间尝试创建道路工地。',
                details: ['不会修改持久蓝图；受地形、已有建筑及全局工地上限影响，返回路径不代表每个工地都建成。'],
                examples: ['buildRoad(10, 10, 25, 25, "E31N2")'] },
            { name: 'removeConstructionSites', signature: 'removeConstructionSites(roomName)', summary: '删除可见房间 progress==0 的工地，已开工的保留。',
                details: ['自动建设可能再次补出蓝图工地；需暂停补建可设 autoLaylout=false。'], examples: ['removeConstructionSites("E31N2")'] },
            { name: 'removeWalls', signature: 'removeWalls(roomName)', summary: '拆除：对可见房全部 constructedWall 执行 destroy，不包含 Rampart。',
                details: ['原生规则仍可能阻止拆除；拆除不可回滚，蓝图补建可能重新创建墙工地。'], examples: ['removeWalls("E31N2")'] },
            { name: 'Game.rooms[room].launchNuke', signature: 'Game.rooms[room].launchNuke()', summary: '发射：读取 nuke 旗的精确位置，尝试发射该房核弹。',
                aliases: ['launchNuke'], details: ['须自有房 Nuker 满能量/满 Ghodium 且冷却为零；消耗核弹资源。插 nuke 旗不会自动发射。',
                    '原生返回码输出到日志；包装返回 true 不等于原生发射成功。旗不删除。类型声明中的 lunchNuker 是旧错拼，运行时不存在。'],
                examples: ['Game.rooms.E31N2.launchNuke()'] },
        ],
    },
    {
        topic: 'flags', title: '旗子操作（全部有效消费者与历史兼容）', aliases: ['flag', '旗子', '旗帜'],
        notes: [
            '名称区分大小写，固定名字在同一 shard 只能有一面；<home> 是派出房名，i 是索引。未另注明则颜色无要求。',
            `人口任务默认每 ${populationPolicy.refreshInterval} tick 刷新；删除任务旗通常只停止续派，已有人工爬不会立即撤回。跨 shard 援建用 shardTask，进攻/驻守用 combatTask。`,
            `创建示例：new RoomPosition(25,25,"E39N5").createFlag("${flags.layoutPreview}")；移动：Game.flags["${flags.layoutPreview}"].setPosition(new RoomPosition(25,25,"E31N2"))；删除：Game.flags["${flags.layoutPreview}"].remove()。`,
        ], entries: [
            { name: flags.layoutPreview, signature: flags.layoutPreview, summary: '目标房任意位置：以建筑图标预览保存的蓝图；保留显示，删旗关闭。',
                details: ['无需当前视野，但需 Memory.rooms 中已有蓝图；只预览，不触发规划或建设。'],
                examples: [`new RoomPosition(25,25,"E39N5").createFlag("${flags.layoutPreview}")`] },
            { name: flags.planStructures, signature: flags.planStructures, summary: '自有房任意位置：强制蓝图补建检查；不重新规划，不自动删旗。',
                details: ['仍受 construction 开关、autoLaylout、CPU 规划门槛及建设预算限制；用完手动删旗，避免持续强制巡检。'] },
            { name: flags.updateCache, signature: flags.updateCache, summary: '可见房任意位置：刷新建筑 ID 和该房路径缓存；处理后自动删旗。' },
            { name: flags.managerPosition, signature: flags.managerPosition, summary: '期望 Manager 座位：保存后自动删旗，Manager 持续采用。',
                details: ['座位需可走并能服务实际 Storage/Link/Terminal；代码不验证物流邻接。'] },
            { name: flags.sourceLab1, signature: flags.sourceLab1, summary: '放在第一座原料 Lab 上：保存建筑 ID，成功后自动删旗。',
                details: ['与 lab2 应是两座不同 Lab，输出 Lab 需在两者反应范围内；不是 Boost 专用旗。'] },
            { name: flags.sourceLab2, signature: flags.sourceLab2, summary: '放在第二座原料 Lab 上：保存建筑 ID，成功后自动删旗。' },
            { name: 'SV', signature: 'SV', summary: '自有房：显示人口需求、孵化、升级、Container 和 Lab 状态；删旗关闭。' },
            { name: 'SCM', signature: 'SCM', summary: '自有房：绘制防御 CostMatrix；保留会持续绘制全房，删旗关闭。',
                details: ['CPU 和视觉输出成本较高，仅排查时使用。'] },
            { name: '<home>_SCOUT', signature: '<home>_SCOUT', summary: '放目标侦察位置：派 Scout；无该旗时可巡视人工 OUT 外矿。',
                aliases: ['SCOUT'], pattern: /^[we]\d+[ns]\d+_scout$/, details: ['放在 Controller 上时可能签名。删除旗停止直接任务续派，已有 Scout 仍可巡视 OUT。'] },
            { name: '<home>_OUT<i>', signature: `<home>_OUT<i> (i=0..${remoteLast})`, summary: '放外矿房：按数字顺序逐矿完成预订、开采与首次能量回送，再启动下一矿。',
                aliases: ['OUT'], pattern: /^[we]\d+[ns]\d+_out\d+$/, details: [`起点须自有、有 Spawn；同一目标房重复旗只算一矿。RCL>2 先派预订工，出生容量至少 ${populationPolicy.remote.minimumReserveCapacity}；无视野也发布预订工和跟随当前旗的专用 Scout。`,
                    `实际预订并抵达 Controller 后派矿工；全部矿工到矿点后派搬运工；所需搬运工部署且每个矿点成功回送能量后才启动下一矿。搬运阶段开始自动修路，每主房一名修路工维护工地和低于 ${remoteRoadPolicy.repairRatio * 100}% 血量的道路，优先级 ${remoteRoadPolicy.builderPriority}。`,
                    '已运行外矿持续补员，补员先于扩张；紧急 NPC 防守独立派兵。Memory.rooms[home].remoteCommissioning 可查看 current、phase 和 reason。入口被墙封住时须先开口。',
                    '删除旗停止续派并释放启动位，已有 Source ID 导航单位仍可继续。不要使用索引范围之外的 OUT 旗：虽不发布人工任务，仍可能占自动外矿名额。'],
                examples: ['new RoomPosition(25,25,"E32N2").createFlag("E31N2_OUT0")'] },
            { name: '<home>_RF_S<i> + <home>_RF_T<i>', signature: `<home>_RF_S<i> + <home>_RF_T<i> (i=0..${jobLast})`, summary: '配对放来源房和收货房：发布人工远程资源搬运工。',
                aliases: ['RF'], pattern: /^[we]\d+[ns]\d+_rf_[st]\d+$/, details: ['需强化准备；旗指定房间，不严格绑定旗格建筑。可搬多种资源，非能量优先入目标 Storage；删除任一旗停止续派。'] },
            { name: '<home>_RB_S<i> + <home>_RB_T<i>', signature: `<home>_RB_S<i> + <home>_RB_T<i> (i=0..${jobLast})`, summary: '来源取能位/Source 附近 + 目标房：发布人工远程 Builder。',
                aliases: ['RB'], pattern: /^[we]\d+[ns]\d+_rb_[st]\d+$/, details: ['需普通强化准备；来源取房间能量或距 S 小于3格的 Source；目标有工地则建，无工地且自有 RCL<8 则升级。删任一旗停止续派。',
                    'RF/RB 旧旗不提供可靠的跨 shard 任务交接，跨 shard 请使用 shardTask。'] },
            { name: '<home>_CLAIM', signature: '<home>_CLAIM', summary: '放目标房：占领，必要时 attackController；紫色额外更新签名。',
                aliases: ['CLAIM'], pattern: /^[we]\d+[ns]\d+_claim$/, details: ['所有颜色均会尝试占领或攻击控制器。占领成功停止续派但旗保留，新自有房交给自动布局/建设及缺 Spawn 援建流程。'] },
            { name: '<upgrader.name>', signature: '与升级爬的实际 creep.name 完全相同', summary: '指定升级工站位；不生新爬，发展期升级工不使用此旗。',
                aliases: ['upgraderFlag'], details: ['stationary 分支要求控制器距离≤3、供能建筑距离≤1；名字是实际哈希名，不是显示任务名。删旗恢复自动位置。'] },
            { name: 'PC_<powerCreep.name>', signature: 'PC_<powerCreep.name>', summary: '启用对应 PowerCreep 自动操作；在目标房或指定等待位置放置。',
                aliases: ['PC'], pattern: /^pc_.+$/, details: ['未出生时在旗房 PowerSpawn 出生；放 Controller 可 enableRoom，放 Factory 可操作 Factory。',
                    '主色红色会限制部分后续操作并赴旗位，产 OPS、续命及部分优先动作仍可执行，并非完全暂停。删除旗停止自动调度。'] },
            { name: '<room>_OPSPAWN', signature: '<room>_OPSPAWN (主色 COLOR_GREEN)', summary: '开启该房 PowerCreep 的 Spawn 加速和 Extension 能量填充。',
                aliases: ['OPSPAWN'], pattern: /^[we]\d+[ns]\d+_opspawn$/, details: ['需 PC_<name> 旗启用、有相应技能、未被优先动作或红 PC 旗截断；名字指定当前操作房，旗实际位置不参与判断。改色或删旗停止。'] },
            { name: 'nuke', signature: 'nuke', summary: '放目标精确坐标；仅供 launchNuke() 读取，插旗不会自动发射。',
                details: ['手动 Game.rooms[发射房].launchNuke()；旗不自动删除，实际发射结果看原生返回码。'] },
            { name: flags.planCenter, signature: `${flags.planCenter} [旧调试]`, summary: '自有房任意位置：显示旧布局候选中心，不保存、不改变 63bot 蓝图；需手动删旗。',
                details: ['保留会每 tick 全房扫描，CPU 成本较高。'] },
            { name: flags.centerPosition, signature: `${flags.centerPosition} [历史兼容]`, summary: '保存旧 centerPos 字段并删旗；当前不改变蓝图中心或物流。' },
            { name: flags.repairTower, signature: `${flags.repairTower} [历史兼容]`, summary: '放 Tower 上保存旧 ID 并删旗；当前不改变实际维修塔选择。' },
            { name: 'legacyWarFlags', signature: '<home>_ATT<i> / _INTE<i> / _DIS<i> / _CA<i> / _T2INTE_<i> / _T2ATT_<i> / _T2DIS_<i> [已停用]',
                summary: '旧攻击旗、旗控 Duo/Quad 不再发布进攻；旧战斗爬/队伍撤回，改用 combatTask。',
                aliases: ['ATT', 'INTE', 'DIS', 'CA', 'T2INTE', 'T2ATT', 'T2DIS', '旧旗'],
                pattern: /^[we]\d+[ns]\d+_(?:(?:att|inte|dis|ca)\d+|t2(?:inte|att|dis)_\d+)$/ },
            { name: 'unsupportedFlagNames', signature: 'MANAGER / CENTER / Lab [无消费者]', summary: '这些名字没有效果；有效配置旗为精确的 managerPos / centerPos / lab1 / lab2。',
                aliases: ['MANAGER', 'CENTER', 'Lab'] },
        ],
    },
    {
        topic: 'config', title: '持久房间配置（无专用命令的开关）', aliases: ['configuration', '配置', 'memory'],
        notes: ['示例房间须已存在于 Memory.rooms；Game.rooms 示例另需当前可见且经过 bot 初始化。直接修改 Memory 的配置会持久保存。派生的 creepConfig、孵化队列、强化分配不能作为持久手工任务接口。'],
        entries: [
            { name: 'Memory.centerStorage', signature: 'Memory.centerStorage = roomName', summary: '当前 shard 中央仓库房，用于自动平衡、中央出售和 collect*。',
                details: ['选可见自有且有 Terminal 的房间。'], examples: ['Memory.centerStorage = "E31N2"'] },
            { name: 'fastUpgrade', signature: 'Memory.rooms[room].fastUpgrade = false / true', summary: '关闭/恢复该房 RCL1–7 发展期采运、升级策略；RCL8 保持成熟房思路。',
                details: ['false 回到原有人口/角色分支；删除字段也恢复默认。已出生的升级工不会因此提前退役。'],
                examples: ['Memory.rooms.E39N5.fastUpgrade = false', 'delete Memory.rooms.E39N5.fastUpgrade'] },
            { name: 'developmentRemotes', signature: 'Memory.rooms[room].developmentRemotes.enabled = false / true', summary: '关闭/恢复自动发展外矿，关闭后自动外矿单位撤回；人工 OUT 不受影响。',
                details: ['需有 Spawn、处于发展阶段并满足安全等条件。修改 enabled 时保留既有外矿状态。'],
                examples: ['var m = Memory.rooms.E39N5; (m.developmentRemotes || (m.developmentRemotes = {})).enabled = false',
                    'var m = Memory.rooms.E39N5; (m.developmentRemotes || (m.developmentRemotes = {})).enabled = true'] },
            { name: 'autoLaylout', signature: 'Memory.rooms[room].autoLaylout = false / true', summary: '暂停/恢复自动规划与补建；拼写确实是 autoLaylout。',
                details: ['不取消已存在工地、不删除蓝图。删除该字段也恢复默认。'],
                examples: ['Memory.rooms.E39N5.autoLaylout = false', 'Memory.rooms.E39N5.autoLaylout = true'] },
            { name: 'roomBlueprint', signature: 'JSON.stringify(Memory.rooms[room].roomBlueprint)', summary: '只读持久蓝图；layout 旗预览，planRoomStructure 强制补建。',
                details: ['没有公开重规划命令；不要把删蓝图当作补建。RCL8 删蓝图仅重新快照实物，会丢失已经消失建筑的恢复信息。'],
                examples: ['JSON.stringify(Memory.rooms.E39N5.roomBlueprint)'] },
            { name: 'roomPosition.managerPos', signature: 'Game.rooms[room].memory.roomPosition.managerPos = {x,y,roomName}', summary: '指定经理座位；也可用 managerPos 一次性旗。',
                examples: ['Game.rooms.E31N2.memory.roomPosition.managerPos = {x:25,y:25,roomName:"E31N2"}'] },
            { name: 'roomLabConfig.sourceLab1/sourceLab2', signature: 'Game.rooms[room].memory.roomLabConfig.sourceLab1 / sourceLab2 = labId', summary: '指定两座底物 Lab；也可在建筑上放 lab1/lab2 旗。',
                aliases: ['sourceLab1', 'sourceLab2'], details: ['需同房、自有、不同 Lab 并满足输出反应范围。反应配方是自动派生，直接手改 labReactionConfig 可能在周期调度时被覆盖。'],
                examples: ['Game.rooms.E31N2.memory.roomLabConfig.sourceLab1 = "LAB_ID_1"', 'Game.rooms.E31N2.memory.roomLabConfig.sourceLab2 = "LAB_ID_2"'] },
        ],
    },
    {
        topic: 'movement', title: 'BetterMove 寻路诊断与低级工具', aliases: ['bettermove', 'move', '寻路', '移动'],
        notes: ['这些配置/缓存只在当前 heap 有效，重置会恢复默认。clear() 是空实现；禁出口的接口当前未接入寻路。'],
        entries: [
            { name: 'BetterMove.print', signature: 'BetterMove.print()', summary: '累计移动耗时、缓存命中、对穿和绕路统计；不是 CPU 滚动窗口。',
                details: ['无调用样本时部分指标可显示 NaN。'], examples: ['BetterMove.print()'] },
            { name: 'BetterMove.deletePathInRoom', signature: 'BetterMove.deletePathInRoom(roomName)', summary: '清房间 CostMatrix 及起终点均在该房的缓存路径。',
                details: ['不会清理所有穿过该房的跨房路径。'], examples: ['BetterMove.deletePathInRoom("E31N2")'] },
            { name: 'BetterMove.deleteCostMatrix', signature: 'BetterMove.deleteCostMatrix(roomName)', summary: '删除单房 CostMatrix 缓存，后续按需重算。', examples: ['BetterMove.deleteCostMatrix("E31N2")'] },
            { name: 'BetterMove.getAvoidRoomsMap', signature: 'BetterMove.getAvoidRoomsMap()', summary: '查询当前避让房间表；返回实际可变引用。', examples: ['BetterMove.getAvoidRoomsMap()'] },
            { name: 'BetterMove.addAvoidRooms', signature: 'BetterMove.addAvoidRooms(roomName)', summary: '把合法房名加入避让表。', examples: ['BetterMove.addAvoidRooms("E32N2")'] },
            { name: 'BetterMove.deleteAvoidRooms', signature: 'BetterMove.deleteAvoidRooms(roomName)', summary: '从避让表移除已存在的合法房名。', examples: ['BetterMove.deleteAvoidRooms("E32N2")'] },
            { name: 'BetterMove.setPathClearDelay', signature: 'BetterMove.setPathClearDelay(ticks?)', summary: '设置全局路径缓存寿命；正数向上取整。',
                details: ['传 undefined 实际关闭过期清理，但现有实现返回 ERR_INVALID_ARGS；长期关闭清理会保留更多缓存。'], examples: ['BetterMove.setPathClearDelay(5000)'] },
            { name: 'BetterMove.setHostileCostMatrixClearDelay', signature: 'BetterMove.setHostileCostMatrixClearDelay(ticks?)', summary: '敌对房 CostMatrix 缓存寿命；正数向上取整，undefined 禁用过期清理。',
                examples: ['BetterMove.setHostileCostMatrixClearDelay(500)'] },
            { name: 'BetterMove.setChangeMoveTo', signature: 'BetterMove.setChangeMoveTo(enabled)', summary: '同时替换 Creep/PowerCreep 的 moveTo，并重置移动统计。',
                details: ['true 开优化，false 恢复原生；属于低级诊断开关，会影响自动物流/对穿。'], examples: ['BetterMove.setChangeMoveTo(true)'] },
            { name: 'BetterMove.getNextCachedStep', signature: 'BetterMove.getNextCachedStep(creep)', summary: '内部只读辅助：有效已缓存路径的下一格，可能 undefined。',
                details: ['供搬运交接预判使用，不会进行寻路或移动。'], examples: ['BetterMove.getNextCachedStep(Game.creeps["实际爬名"])'] },
            { name: 'BetterMove.setChangeMove', signature: 'BetterMove.setChangeMove(enabled) [兼容]', summary: '仅重置 move 统计；真正的 move 替换已注释，不切换移动实现。' },
            { name: 'BetterMove.setChangeFindClostestByPath', signature: 'BetterMove.setChangeFindClostestByPath(enabled) [兼容]', summary: '仅重置统计；不切换 findClosestByPath，名称保留旧拼写。' },
            { name: 'BetterMove.addAvoidExits', signature: 'BetterMove.addAvoidExits(fromRoom, toRoom) [未启用]', summary: '只写退出避让数据，当前不会影响寻路。' },
            { name: 'BetterMove.deleteAvoidExits', signature: 'BetterMove.deleteAvoidExits(fromRoom, toRoom) [未启用]', summary: '删除未启用的退出避让数据。' },
            { name: 'BetterMove.clear', signature: 'BetterMove.clear() [空实现]', summary: '当前没有任何清理效果；按房清缓存用 deletePathInRoom/deleteCostMatrix。' },
        ],
    },
    {
        topic: 'power', title: 'PowerCreep 旗与原型辅助', aliases: ['超能', 'powercreep'],
        notes: ['持久自动调度通过 PC_<name> 与绿色 <room>_OPSPAWN 旗启用，详见 help("flags")。以下辅助需对应 PC 已出生；一次动作可能被后续自动角色动作覆盖。'],
        entries: [
            { name: 'Game.powerCreeps[name].takeOps', signature: 'Game.powerCreeps[name].takeOps()', summary: '尝试从当前房 Storage/Terminal 取剩余仓位一半的 OPS，优先 Terminal。',
                aliases: ['takeOps'], examples: ['Game.powerCreeps["PC1"].takeOps()'] },
            { name: 'Game.powerCreeps[name].saveOps', signature: 'Game.powerCreeps[name].saveOps()', summary: '尝试把携带 OPS 的一半存入当前房 Storage。',
                aliases: ['saveOps'], examples: ['Game.powerCreeps["PC1"].saveOps()'] },
            { name: 'Game.powerCreeps[name].isPowerAvailable', signature: 'Game.powerCreeps[name].isPowerAvailable(power)', summary: '检查房间启用 Power、技能等级及冷却；不检查 OPS、距离或目标。',
                aliases: ['isPowerAvailable'], examples: ['Game.powerCreeps["PC1"].isPowerAvailable(PWR_REGEN_SOURCE)'] },
            { name: 'Game.powerCreeps[name].isRoomHaveOps', signature: 'Game.powerCreeps[name].isRoomHaveOps()', summary: '只读检查当前房 Storage/Terminal 是否有 OPS。',
                aliases: ['isRoomHaveOps'], examples: ['Game.powerCreeps["PC1"].isRoomHaveOps()'] },
            { name: 'Game.powerCreeps[name].memory.needRenew', signature: 'Game.powerCreeps[name].memory.needRenew = true', summary: '请求自动续命；仍需 PC 旗和有效 PowerSpawn/PowerBank。',
                aliases: ['needRenew'], examples: ['Game.powerCreeps["PC1"].memory.needRenew = true'] },
        ],
    },
]

function normalize(value: string): string { return value.trim().toLowerCase() }

function matches(value: string, name: string, aliases: string[] = [], pattern?: RegExp): boolean {
    return [name, ...aliases].some(candidate => normalize(candidate) == value) || pattern?.test(value) === true
}

function entryText(entry: HelpEntry, detailed: boolean): string {
    const lines = [`${entry.signature}  — ${entry.summary}`]
    if (detailed) {
        for (const note of entry.details || []) lines.push(`  ${note}`)
        for (const example of entry.examples || []) lines.push(`  > ${example}`)
    }
    return lines.join('\n')
}

function sectionText(section: HelpSection, detailed: boolean): string {
    const lines = [`【${section.title}】 help("${section.topic}")`]
    if (detailed) for (const note of section.notes || []) lines.push(note)
    lines.push(...section.entries.map(entry => entryText(entry, detailed)))
    return lines.join('\n')
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** No reflection/eval and no unbounded per-query cache. HTML is scoped to this result. */
export function renderHelp(topic?: string, format: 'html' | 'text' = 'html'): string {
    const query = typeof topic == 'string' ? normalize(topic) : ''
    const intro = 'ecbot 控制台与旗子手册\nhelp() 总览 | help("all") 全文 | help("flags") 旗子 | help("指令名") 参数/示例\n分类：' +
        helpSections.map(section => section.topic).join(' / ')
    let text: string
    if (!query || query == 'overview' || query == '总览') {
        text = intro + '\n\n' + helpSections.map(section => sectionText(section, false)).join('\n\n')
    } else if (query == 'all' || query == '全部') {
        text = intro + '\n\n' + helpSections.map(section => sectionText(section, true)).join('\n\n')
    } else {
        // Prefer exact entry names: help("help") documents the function, not just a topic.
        const owner = helpSections.find(section => section.entries.some(item => matches(query, item.name, item.aliases, item.pattern)))
        const entry = owner?.entries.find(item => matches(query, item.name, item.aliases, item.pattern))
        const section = helpSections.find(item => matches(query, item.topic, item.aliases))
        text = entry != undefined ? intro + '\n\n' + (owner?.notes?.join('\n') || '') + '\n' + entryText(entry, true) :
            section != undefined ? intro + '\n\n' + sectionText(section, true) :
                intro + '\n\n未找到该分类、指令或旗名；使用 help("all") 查看完整清单。'
    }
    return format == 'text' ? text : `<div style="text-align:left"><pre style="white-space:pre-wrap;word-break:break-word;line-height:1.5">${escapeHtml(text)}</pre></div>`
}
