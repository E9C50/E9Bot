import { structurePolicy } from 'settings/structures'
import { creepWhiteList, STRUCTURE_MEMORYKEY_PERFIX, STRUCTURE_PRIVATEKEY_PERFIX } from "settings/settings";
import { generateCostMatrix } from "utils/CostMatrix";
import { getDistance } from "utils";
import { getRoomProcessors } from 'runtime/creepIndex'
import { isRoomEvacuating } from 'room/evacuationState'
import { updateResourceJob } from 'room/resourceNetwork'

export default class RoomExtension extends Room {
    private structureGroups?: Map<string, Structure[]>
    private coveredRampartPositions?: Set<number>

    private getCoveredRampartPositions(): Set<number> {
        if (this.coveredRampartPositions !== undefined) return this.coveredRampartPositions
        const positions = new Set<number>()
        for (const [type, structures] of this.getStructureGroups()) {
            if (type === STRUCTURE_ROAD || type === STRUCTURE_RAMPART) continue
            for (const structure of structures) positions.add(structure.pos.x * 50 + structure.pos.y)
        }
        this.coveredRampartPositions = positions
        return positions
    }

    private getStructureGroups(): Map<string, Structure[]> {
        if (this.structureGroups !== undefined) return this.structureGroups
        const groups = new Map<string, Structure[]>()
        for (const structure of this.structures) {
            const type = structure.structureType
            const group = groups.get(type)
            if (group === undefined) groups.set(type, [structure])
            else group.push(structure)
        }
        this.structureGroups = groups
        return groups
    }

    private getStructure<T extends Structure>(structureType: string, privateKey: string, memoryKey: string): T | undefined {
        if (Object.prototype.hasOwnProperty.call(this, privateKey)) return this[privateKey]
        const structure = this.getStructureGroups().get(structureType)?.[0] as T | undefined
        this[privateKey] = structure
        global[this.name].structureIdList[memoryKey] = structure?.id
        return structure
    }

    private getStructures<T extends Structure>(structureType: string, privateKey: string, memoryKey: string): T[] {
        if (this[privateKey] != undefined) return this[privateKey]
        // ID 列表仅作为最新快照；跨 tick 新建和摧毁都以当前房间 find 结果为准。
        // Give callers their own sortable array, as the previous filter did.
        const structures = (this.getStructureGroups().get(structureType) ?? []).slice() as T[]
        this[privateKey] = structures
        global[this.name].structureIdList[memoryKey] = structures.map(structure => structure.id)
        return structures
    }

    // Room基础属性
    public myGetter(): boolean {
        return this.controller != null && this.controller.my
    }

    public levelGetter(): number {
        return this.controller?.level || this.invaderCore?.level || 0
    }

    // 矿物资源缓存
    public sourcesGetter(): Source[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'SOURCES'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'SOURCES'
        if (this[privateKey]) return this[privateKey]

        const sources: Source[] = global[this.name].structureIdList[memoryKey] == undefined ? [] :
            global[this.name].structureIdList[memoryKey]
                .map(sourceId => Game.getObjectById(sourceId))
                .filter(source => source != undefined)
        if (sources.length > 0) {
            this[privateKey] = sources;
            return sources
        } else {
            const sources: Source[] = this.find(FIND_SOURCES)
            global[this.name].structureIdList[memoryKey] = sources.map(source => source.id)
            return sources
        }
    }
    public mineralGetter(): Mineral | undefined {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'MINERAL'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'MINERAL'
        if (this[privateKey]) return this[privateKey]

        const mineral: Mineral = Game.getObjectById(global[this.name].structureIdList[memoryKey]) as Mineral
        if (mineral != undefined) {
            this[privateKey] = mineral;
            return mineral
        } else {
            const minerals: Mineral[] = this.find(FIND_MINERALS)
            if (minerals.length == 0) return undefined
            global[this.name].structureIdList[memoryKey] = minerals[0].id
            return minerals[0]
        }
    }

    // 敌人缓存
    public enemiesGetter(): (Creep | PowerCreep)[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'ENEMIES'
        if (this[privateKey]) {
            return this[privateKey]
        }
        const enemieCreeps: Creep[] = this.find(FIND_HOSTILE_CREEPS)
            .filter(creep => !creepWhiteList.includes(creep.owner.username))
        const enemiePcs: PowerCreep[] = this.find(FIND_HOSTILE_POWER_CREEPS)
            .filter(creep => !creepWhiteList.includes(creep.owner.username))

        const enemies = [...enemieCreeps, ...enemiePcs]
        this[privateKey] = enemies
        return enemies
    }

    // 废墟、墓碑和掉落资源缓存
    public ruinsGetter(): Ruin[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'RUINS'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'RUINS'
        if (this[privateKey]) return this[privateKey]

        const ruins: Ruin[] = this.find(FIND_RUINS)
        this[privateKey] = ruins
        return ruins
    }

    public tombstonesGetter(): Tombstone[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'TOMBSTONES'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'TOMBSTONES'
        if (this[privateKey]) return this[privateKey]

        const tombstones: Tombstone[] = this.find(FIND_TOMBSTONES)
        this[privateKey] = tombstones
        return tombstones
    }

    public droppedResourceGetter(): Resource[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'DROPPED_RESOURCE'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'DROPPED_RESOURCE'
        if (this[privateKey]) return this[privateKey]

        const droppedResources: Resource[] = this.find(FIND_DROPPED_RESOURCES)
        this[privateKey] = droppedResources
        return droppedResources
    }

    // 需要修复的墙缓存
    public wallsNeedRepairGetter(): Structure[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'WALLS_NEED_REPAIR'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'WALLS_NEED_REPAIR'
        if (this[privateKey]) return this[privateKey]

        const walls: Structure[] = []
        const targetHits = structurePolicy.defense.wallTargetHits
        for (const rampart of this.ramparts) {
            if (rampart.hits >= rampart.hitsMax) continue
            if (rampart.hits < targetHits || !this.getCoveredRampartPositions().has(rampart.pos.x * 50 + rampart.pos.y)) walls.push(rampart)
        }
        for (const wall of this.walls) if (wall.hits < wall.hitsMax && wall.hits < targetHits) walls.push(wall)

        this[privateKey] = walls
        return walls
    }

    // 需要维修的建筑缓存
    public structuresNeedRepairGetter(): Structure[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURES_NEED_REPAIR'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURES_NEED_REPAIR'
        if (this[privateKey]) return this[privateKey]

        let structures: Structure[] = [
            ...this.roads, ...this.extensions, ...this.spawns, ...this.towers,
            ...this.labs, ...this.containers, ...this.links
        ]
        if (this.nuker != undefined) structures.push(this.nuker)
        if (this.storage != undefined) structures.push(this.storage)
        if (this.factory != undefined) structures.push(this.factory)
        if (this.terminal != undefined) structures.push(this.terminal)
        if (this.observer != undefined) structures.push(this.observer)
        if (this.extractor != undefined) structures.push(this.extractor)
        if (this.powerSpawn != undefined) structures.push(this.powerSpawn)

        structures = structures.filter(structure =>
            structure.hits < structure.hitsMax
        )

        this[privateKey] = structures
        return structures
    }

    // 全局建筑缓存
    public structuresGetter(): Structure[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE'
        if (this[privateKey]) return this[privateKey]

        const structures: Structure[] = this.find(FIND_STRUCTURES)
        this[privateKey] = structures
        return structures
    }

    public constructionSitesGetter(): ConstructionSite[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'CONSTRUCTION_SITE'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'CONSTRUCTION_SITE'
        if (this[privateKey] != undefined) return this[privateKey]

        // 工地新建/完成很频繁；只复用当 tick 的 Room 对象缓存，避免跨 tick ID 漏掉新工地。
        const constructionSites: ConstructionSite[] = this.find(FIND_MY_CONSTRUCTION_SITES)
        this[privateKey] = constructionSites
        global[this.name].structureIdList[memoryKey] = constructionSites.map(site => site.id)
        return constructionSites
    }

    public centerLinkGetter(): StructureLink | undefined {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_CENTER_LINK'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_CENTER_LINK'
        if (Object.prototype.hasOwnProperty.call(this, privateKey)) return this[privateKey]

        const cachedId = global[this.name].structureIdList[memoryKey]
        const link = cachedId == undefined ? undefined : Game.getObjectById<StructureLink>(cachedId)
        if (link != undefined) {
            this[privateKey] = link;
            return link
        } else {
            const storage = this.storage
            const link = storage == undefined ? undefined : this.links.find(link => getDistance(storage.pos, link.pos) <= 2)
            global[this.name].structureIdList[memoryKey] = link?.id
            this[privateKey] = link;
            return link
        }
    }

    public controllerLinkGetter(): StructureLink | undefined {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_CONTROLLER_LINK'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_CONTROLLER_LINK'
        if (Object.prototype.hasOwnProperty.call(this, privateKey)) return this[privateKey]

        const cachedId = global[this.name].structureIdList[memoryKey]
        const link = cachedId == undefined ? undefined : Game.getObjectById<StructureLink>(cachedId)
        if (link != undefined) {
            this[privateKey] = link;
            return link
        } else {
            const controller = this.controller
            const link = controller == undefined ? undefined : this.links.find(link => getDistance(controller.pos, link.pos) <= 2)
            global[this.name].structureIdList[memoryKey] = link?.id
            this[privateKey] = link;
            return link
        }
    }

    // 单个建筑缓存
    public nukerGetter(): StructureNuker | undefined {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_NUKER'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_NUKER'
        return this.getStructure<StructureNuker>(STRUCTURE_NUKER, privateKey, memoryKey)
    }
    public extractorGetter(): StructureExtractor | undefined {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_EXTRACTOR'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_EXTRACTOR'
        return this.getStructure<StructureExtractor>(STRUCTURE_EXTRACTOR, privateKey, memoryKey)
    }
    public factoryGetter(): StructureFactory | undefined {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_FACTORY'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_FACTORY'
        return this.getStructure<StructureFactory>(STRUCTURE_FACTORY, privateKey, memoryKey)
    }
    public observerGetter(): StructureObserver | undefined {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_OBSERVER'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_OBSERVER'
        return this.getStructure<StructureObserver>(STRUCTURE_OBSERVER, privateKey, memoryKey)
    }
    public powerSpawnGetter(): StructurePowerSpawn | undefined {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_POWER_SPAWN'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_POWER_SPAWN'
        return this.getStructure<StructurePowerSpawn>(STRUCTURE_POWER_SPAWN, privateKey, memoryKey)
    }
    public invaderCoreGetter(): StructureInvaderCore | undefined {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_INVADER_CORE'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_INVADER_CORE'
        return this.getStructure<StructureInvaderCore>(STRUCTURE_INVADER_CORE, privateKey, memoryKey)
    }

    // 多个建筑缓存
    public spawnsGetter(): StructureSpawn[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_SPAWN'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_SPAWN'
        return this.getStructures<StructureSpawn>(STRUCTURE_SPAWN, privateKey, memoryKey)
    }
    public extensionsGetter(): StructureExtension[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_EXTENSION'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_EXTENSION'
        return this.getStructures<StructureExtension>(STRUCTURE_EXTENSION, privateKey, memoryKey)
    }
    public towersGetter(): StructureTower[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_TOWER'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_TOWER'
        return this.getStructures<StructureTower>(STRUCTURE_TOWER, privateKey, memoryKey)
    }
    public containersGetter(): StructureContainer[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_CONTAINER'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_CONTAINER'
        return this.getStructures<StructureContainer>(STRUCTURE_CONTAINER, privateKey, memoryKey)
    }
    public linksGetter(): StructureLink[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_LINK'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_LINK'
        return this.getStructures<StructureLink>(STRUCTURE_LINK, privateKey, memoryKey)
    }
    public labsGetter(): StructureLab[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_LAB'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_LAB'
        return this.getStructures<StructureLab>(STRUCTURE_LAB, privateKey, memoryKey)
    }
    public roadsGetter(): StructureRoad[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_ROAD'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_ROAD'
        return this.getStructures<StructureRoad>(STRUCTURE_ROAD, privateKey, memoryKey)
    }
    public wallsGetter(): StructureWall[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_WALL'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_WALL'
        return this.getStructures<StructureWall>(STRUCTURE_WALL, privateKey, memoryKey)
    }
    public rampartsGetter(): StructureRampart[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_RAMPART'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_RAMPART'
        return this.getStructures<StructureRampart>(STRUCTURE_RAMPART, privateKey, memoryKey)
    }
    public keeperLairsGetter(): StructureKeeperLair[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_KEEPER_LAIR'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_KEEPER_LAIR'
        return this.getStructures<StructureKeeperLair>(STRUCTURE_KEEPER_LAIR, privateKey, memoryKey)
    }
    public portalsGetter(): StructurePortal[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_PORTAL'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_PORTAL'
        return this.getStructures<StructurePortal>(STRUCTURE_PORTAL, privateKey, memoryKey)
    }
    public powerBanksGetter(): StructurePowerBank[] {
        const privateKey = STRUCTURE_PRIVATEKEY_PERFIX + 'STRUCTURE_POWER_BANK'
        const memoryKey = STRUCTURE_MEMORYKEY_PERFIX + 'STRUCTURE_POWER_BANK'
        return this.getStructures<StructurePowerBank>(STRUCTURE_POWER_BANK, privateKey, memoryKey)
    }

    /**
     * 添加资源发送任务
     * @param targetRoom
     * @param resourceType
     * @param amount
     * @returns
     */
    public sendResource(targetRoom: string, resourceType: ResourceConstant, amount: number): boolean {
        if (isRoomEvacuating(this) || isRoomEvacuating(targetRoom) || targetRoom === this.name ||
            !Number.isFinite(amount) || amount <= 0) return false
        const jobId = this.name + '_' + targetRoom + '_' + resourceType
        updateResourceJob(this, jobId, {
            targetRoom: targetRoom,
            resourceType: resourceType,
            amount: Math.floor(amount), createdAt: Game.time
        })
        return true
    }

    /**
     * 获取房间内的资源数量
     * @param resType
     * @param storage
     * @param terminal
     * @param lab
     * @param processer
     */
    public getResource(resType: ResourceConstant, storage?: boolean, terminal?: boolean, lab?: boolean, processer?: boolean): number {
        if (storage == undefined) storage = true
        if (terminal == undefined) terminal = false
        if (processer == undefined) processer = false
        if (lab == undefined) lab = false

        let totalAmount = 0
        const storageStructure = storage ? this.storage : undefined
        const terminalStructure = terminal ? this.terminal : undefined
        if (storageStructure != undefined) {
            totalAmount += storageStructure.store[resType]
        }

        if (terminalStructure != undefined) {
            totalAmount += terminalStructure.store[resType]
        }

        if (lab) {
            for (const labStructure of this.labs) totalAmount += labStructure.store[resType]
        }

        if (processer) {
            for (const creep of getRoomProcessors(this.name)) {
                totalAmount += creep.store[resType]
            }
        }
        return totalAmount
    }

    /**
     * 获取并转换CostMatrix
     */
    public getDefenderCostMatrix(): CostMatrix {
        const cache = global[this.name]
        const builtAt = cache.defenderCostMatrixTick
        const refreshDue = builtAt == undefined ||
            Game.time - builtAt >= structurePolicy.defense.costMatrixInterval ||
            Game.time % structurePolicy.defense.costMatrixInterval == 0
        if (cache.defenderCostMatrix == undefined || refreshDue && builtAt !== Game.time) {
            if (Game.cpu.bucket < structurePolicy.defense.minimumBucket) return new PathFinder.CostMatrix();
            cache.defenderCostMatrix = generateCostMatrix(this.name)
            // The heap stamp also serves other Room wrappers and consumers in this tick.
            cache.defenderCostMatrixTick = Game.time
        }
        return cache.defenderCostMatrix
    }

    /**
     * 发射核弹
     */
    public launchNuke(): boolean {
        const nukeFlag = Game.flags['nuke']
        if (!this.my || this.nuker == undefined || nukeFlag == undefined) return false
        if (this.nuker.cooldown != 0 || this.nuker.store.getFreeCapacity(RESOURCE_GHODIUM) > 0 || this.nuker.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return false

        console.log(this.nuker.launchNuke(nukeFlag.pos))
        return true
    }
}
