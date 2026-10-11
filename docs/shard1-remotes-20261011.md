# shard1 下方 OUT 外矿未启动

2026-10-11 官服 tick 74256877–74256918，只读检查 shard1/E39N5：

- `E39N5_OUT0` 指向 E39N6，已完成预订、开采及回款，当前正常维护。
- `E39N5_OUT1` 指向 E39N4，位置 `(1,0)`；调度停在 scouting，已派 Scout 与 Reserver，但二者在主房停住。
- `E39N5_OUT2` 指向 E39N3，同样位于 `(1,0)`；按逐矿启动规则等待 E39N4。
- 主房出生池 2050/2200、Storage 8860、Terminal 50000，本地两矿采运与 Manager 齐全，不是出生资金或本地经济门槛阻塞。

## 根因与修复

1. 旧的 `findPathAvoidRooms` 将 shard3 的配置应用到所有 shard，其中包含 E39N4。官服原生地图路线为一步向南，带实际避让表则返回 `ERR_NO_PATH`。改为按 shard 独立配置，原有 E39N4、E38N1、E39N1、E32N2、E33N5 完整保留在 shard3，shard0/1/2 初始为空。普通移动、战斗路线及跨 shard Portal 规划统一读取对应 shard；Portal 入口和落点分别检查，路线缓存纳入配置签名。
2. OUT Scout 直接寻找旗子 range1；E39N4 旗子附近 `(0..2,0..1)` 全为地形墙。只读地形搜索到旗子不完整，到房间中心 range20 则完整可达。现在 OUT Scout 按旗子所在房间进入可达内区保留视野，不再要求旗子格子可走；普通 SCOUT 精确标点行为保留。

保留既有逐矿启动顺序：E39N4 须完成预订、各 Source 开采与首次回款，随后才启动 E39N3。

## 验证

`npm run typecheck`、`npm run build` 通过，全量单测 2256/2256 通过。回归覆盖真实 BetterMove 在 shard1/shard3 对 E39N4 的不同处理、OUT 墙上旗子的房间内区导航、Portal 两端所属 shard 检查、低 Bucket 规划、路线缓存和已就绪任务的配置迁移。
