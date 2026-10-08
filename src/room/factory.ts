import { basicMinerals, compressedMinerals, ordinaryResourceKeep, resourcePolicy } from 'settings/resourcePolicy'
import { getGlobalResourceAmount, getOutgoingResourceAmount, getTerminalResourceAmount, isWarehouseRoom,
    recordTerminalWithdrawal } from './resourceNetwork'
import { isRoomEvacuating } from './evacuationState'
import { getEvacuationIncomingCapacity, reserveEvacuationIncoming } from './evacuation'

type FactoryResource = Parameters<StructureFactory['produce']>[0]
type Recipe = typeof COMMODITIES[FactoryResource]
type Stock = StructureStorage | StructureTerminal
type Component = [ResourceConstant, number]
interface RecipeData { source: Recipe['components']; components: Component[]; inputAmount: number }
interface PlanningStock {
    capacity: number
    local(resource: ResourceConstant): number
    available(resource: ResourceConstant): number
    global(resource: ResourceConstant): number
    cycles(recipe: Recipe): number
}

export interface FactoryProductionState {
    resourceType: FactoryResource
    mode: 'commodity' | 'compression'
    remaining: number
    inputs: Record<string, number>
    createdAt: number
}
export interface FactoryLogisticsTask {
    factoryId: string
    sourceId: string
    targetId: string
    resourceType: ResourceConstant
    amount: number
    phase: 'withdraw' | 'transfer'
}
declare global {
    interface RoomMemory { factoryProduction?: FactoryProductionState }
    interface CreepMemory { factoryLogistics?: FactoryLogisticsTask }
}

const maximumBatchCycles = 20
const batchProductionTicks = 500
const outputHeadroom = 1000
let productionTick = -1
let consumed = new Map<string, Record<string, number>>()
let carrierTick = -1
let roomCarriers = new Map<string, Creep[]>()
let commodities: FactoryResource[] | undefined
let commodityIntermediates: Set<string> | undefined
let commodityTable: typeof COMMODITIES | undefined
const recipeData = new WeakMap<Recipe, RecipeData>()
const commoditiesByLevel = new Map<number, FactoryResource[]>()
const reserveByLevel = new Map<number, Component[]>()
let transferTick = -1
let delivered = new Map<string, Record<string, number>>()

function parsedRecipe(recipe: Recipe): RecipeData {
    const source = recipe.components, previous = recipeData.get(recipe)
    if (previous?.source === source) return previous
    if (previous) reserveByLevel.clear()
    const components = Object.entries(source) as Component[]
    const result = { source, components, inputAmount: components.reduce((sum, [, amount]) => sum + amount, 0) }
    recipeData.set(recipe, result)
    return result
}
function components(recipe: Recipe): Component[] {
    return parsedRecipe(recipe).components
}
function recipeInputAmount(recipe: Recipe): number {
    return parsedRecipe(recipe).inputAmount
}
function batchInputs(recipe: Recipe, cycles: number): Record<string, number> {
    const result: Record<string, number> = {}
    for (const [resource, amount] of components(recipe)) result[resource] = amount * cycles
    return result
}
function factoryAmount(factory: StructureFactory | undefined, resource: ResourceConstant): number {
    if (!factory) return 0
    return Math.max(0, (factory.store[resource] || 0) -
        (productionTick === Game.time ? consumed.get(factory.id)?.[resource] || 0 : 0))
}
function carriers(room: Room): readonly Creep[] {
    if (carrierTick !== Game.time) {
        carrierTick = Game.time; roomCarriers = new Map()
        for (const creep of Object.values(Game.creeps || {})) {
            if (!creep.room || !['manager', 'processer'].includes(creep.memory.role)) continue
            const list = roomCarriers.get(creep.room.name) || []
            list.push(creep); roomCarriers.set(creep.room.name, list)
        }
    }
    return roomCarriers.get(room.name) || []
}
function activePower(factory: StructureFactory): { level?: number; ticksRemaining: number } | undefined {
    return (factory.effects || []).find(effect => effect.effect === PWR_OPERATE_FACTORY && effect.ticksRemaining > 0)
}
function matchingLevel(factory: StructureFactory, recipe: Recipe): boolean {
    return !recipe.level || recipe.level === factory.level
}
/** Leveled recipes need both the permanent level and a live matching operate effect. */
export function canProduceFactoryRecipe(factory: StructureFactory, resource: FactoryResource): boolean {
    const recipe = COMMODITIES[resource]
    if (!recipe || !matchingLevel(factory, recipe)) return false
    const effect = activePower(factory)
    if (effect && effect.level !== factory.level) return false
    return !recipe.level || effect?.level === recipe.level
}
function factoryCargo(room: Room, resource: ResourceConstant): number {
    let amount = 0
    for (const creep of carriers(room)) {
        if (creep.room?.name === room.name && creep.memory.factoryLogistics &&
            creep.memory.factoryLogistics.targetId === room.factory?.id) amount += creep.store[resource] || 0
    }
    return amount
}
function localAmount(room: Room, resource: ResourceConstant): number {
    return (room.storage?.store[resource] || 0) + getTerminalResourceAmount(room, resource) +
        factoryAmount(room.factory, resource) + factoryCargo(room, resource)
}
/** Factories preserve raw lab feedstock in warehouses as well as ordinary rooms.
 * This is a factory spending limit, not a production reservation, so labs can use it. */
function ingredientKeep(room: Room, resource: ResourceConstant, warehouse = isWarehouseRoom(room)): number {
    if (resource === RESOURCE_ENERGY) return resourcePolicy.terminalEnergyReserve
    const rawMineral = basicMinerals.includes(resource) || resource === RESOURCE_GHODIUM
    const minimum = warehouse ? rawMineral ? resourcePolicy.warehouseRawMineralReserve : 0 : ordinaryResourceKeep(resource)
    return Math.max(minimum, room.memory.boostNeed?.[resource] || 0)
}
function availableIngredient(room: Room, resource: ResourceConstant): number {
    const keep = ingredientKeep(room, resource)
    return Math.max(0, localAmount(room, resource) - keep - (room.memory.productionReserve?.lab?.[resource] || 0) -
        getOutgoingResourceAmount(room.name, resource))
}

/** Scope stock to one synchronous planning pass; later calls still observe new reservations and native intents. */
function planningStock(factory: StructureFactory): PlanningStock {
    const room = factory.room, warehouse = isWarehouseRoom(room)
    const amounts = new Map<ResourceConstant, number>(), available = new Map<ResourceConstant, number>()
    const globals = new Map<ResourceConstant, number>(), cycles = new Map<Recipe, number>()
    const cargo: Partial<Record<ResourceConstant, number>> = {}
    for (const creep of carriers(room)) {
        if (creep.room?.name !== room.name || creep.memory.factoryLogistics?.targetId !== factory.id) continue
        for (const resource of Object.keys(creep.store) as ResourceConstant[])
            cargo[resource] = (cargo[resource] || 0) + (creep.store[resource] || 0)
    }
    const stock: PlanningStock = {
        capacity: factory.store.getCapacity() || 0,
        local(resource) {
            if (!amounts.has(resource)) amounts.set(resource, (room.storage?.store[resource] || 0) +
                getTerminalResourceAmount(room, resource) + factoryAmount(factory, resource) + (cargo[resource] || 0))
            return amounts.get(resource)!
        },
        available(resource) {
            if (!available.has(resource)) {
                const keep = ingredientKeep(room, resource, warehouse)
                available.set(resource, Math.max(0, stock.local(resource) - keep -
                    (room.memory.productionReserve?.lab?.[resource] || 0) - getOutgoingResourceAmount(room.name, resource)))
            }
            return available.get(resource)!
        },
        global(resource) {
            if (!globals.has(resource)) globals.set(resource, getGlobalResourceAmount(resource))
            return globals.get(resource)!
        },
        cycles(recipe) {
            if (!cycles.has(recipe)) cycles.set(recipe, possibleCycles(factory, recipe, stock))
            return cycles.get(recipe)!
        },
    }
    return stock
}

function possibleCycles(factory: StructureFactory, recipe: Recipe, stock?: PlanningStock): number {
    const capacity = stock?.capacity ?? (factory.store.getCapacity() || 0)
    const data = parsedRecipe(recipe), inputAmount = data.inputAmount
    if (Math.max(inputAmount, recipe.amount) > capacity || inputAmount <= 0) return 0
    const fit = Math.max(1, Math.floor((capacity - Math.max(outputHeadroom, recipe.amount)) / inputAmount))
    let result = Math.min(fit, maximumBatchCycles, Math.ceil(batchProductionTicks / recipe.cooldown))
    for (const [resource, amount] of data.components) {
        result = Math.min(result, Math.floor((stock ? stock.available(resource) : availableIngredient(factory.room, resource)) / amount))
        if (result <= 0) return 0
    }
    return Math.max(0, result)
}
function commodityResources(): FactoryResource[] {
    if (commodityTable !== COMMODITIES) {
        commodityTable = COMMODITIES
        commodities = undefined; commodityIntermediates = undefined
        commoditiesByLevel.clear(); reserveByLevel.clear()
    }
    if (commodities) return commodities
    const excluded = new Set<string>([RESOURCE_ENERGY, RESOURCE_BATTERY, RESOURCE_GHODIUM,
        ...basicMinerals, ...Object.values(compressedMinerals)])
    commodities = (Object.keys(COMMODITIES) as FactoryResource[]).filter(resource => !excluded.has(resource))
    return commodities
}
function levelCommodities(level: number | undefined): readonly FactoryResource[] {
    const resources = commodityResources(), key = level || 0, previous = commoditiesByLevel.get(key)
    if (previous) return previous
    const result = resources.filter(resource => !COMMODITIES[resource].level || COMMODITIES[resource].level === level)
        .sort((a, b) => (COMMODITIES[b].level || 0) - (COMMODITIES[a].level || 0))
    commoditiesByLevel.set(key, result)
    return result
}
function chooseCommodity(factory: StructureFactory, stock: PlanningStock): FactoryResource | undefined {
    let selected: FactoryResource | undefined
    for (const resource of levelCommodities(factory.level)) {
        const recipe = COMMODITIES[resource]
        if (selected && (COMMODITIES[selected].level || 0) > (recipe.level || 0)) break
        if (!canProduceFactoryRecipe(factory, resource) || stock.cycles(recipe) <= 0) continue
        if (!selected) { selected = resource; continue }
        const difference = stock.global(resource) / recipe.amount - stock.global(selected) / COMMODITIES[selected].amount
        if (difference < 0 || difference === 0 && resource.localeCompare(selected) < 0) selected = resource
    }
    return selected
}
function compressionAllowed(room: Room, resource: FactoryResource): boolean {
    return isWarehouseRoom(room) ? Object.values(compressedMinerals).includes(resource) :
        !!room.mineral && compressedMinerals[room.mineral.mineralType] === resource
}
function chooseCompression(factory: StructureFactory, stock: PlanningStock): FactoryResource | undefined {
    const room = factory.room
    const minerals = isWarehouseRoom(room) ? [...basicMinerals, RESOURCE_GHODIUM] :
        room.mineral ? [room.mineral.mineralType] : []
    let selected: FactoryResource | undefined, selectedSurplus = -1
    for (const mineral of minerals) {
        const compressed = compressedMinerals[mineral] as FactoryResource | undefined
        if (!compressed || !canProduceFactoryRecipe(factory, compressed) || stock.cycles(COMMODITIES[compressed]) <= 0) continue
        const surplus = stock.available(mineral)
        if (!selected || surplus > selectedSurplus || surplus === selectedSurplus && compressed.localeCompare(selected) < 0) {
            selected = compressed; selectedSurplus = surplus
        }
    }
    return selected
}
function makePlan(factory: StructureFactory, resource: FactoryResource, mode: FactoryProductionState['mode'], stock: PlanningStock): FactoryProductionState {
    const recipe = COMMODITIES[resource]
    const remaining = stock.cycles(recipe)
    return { resourceType: resource, mode, remaining, createdAt: Game.time,
        inputs: batchInputs(recipe, remaining) }
}
function reserveComponents(level: number | undefined): readonly Component[] {
    const resources = levelCommodities(level), key = level || 0, previous = reserveByLevel.get(key)
    if (previous) return previous
    const intermediates = commodityIntermediates || (commodityIntermediates =
        new Set<string>([...commodityResources(), ...Object.values(compressedMinerals)]))
    const amounts = new Map<ResourceConstant, number>()
    for (const resource of resources) for (const [component, amount] of components(COMMODITIES[resource])) {
        if (intermediates.has(component)) amounts.set(component, Math.max(amounts.get(component) || 0, amount))
    }
    const result = [...amounts] as Component[]
    reserveByLevel.set(key, result)
    return result
}
function updateReserve(factory: StructureFactory, stock?: PlanningStock): void {
    const room = factory.room, state = room.memory.factoryProduction
    const reserve: Record<string, number> = { ...state?.inputs }
    // Keep one batch of existing commodity precursors for this factory's next recipe,
    // including while its power effect is being refreshed. Export everything beyond it.
    for (const [component, amount] of reserveComponents(factory.level))
        reserve[component] = Math.max(reserve[component] || 0, Math.min(stock ? stock.local(component) : localAmount(room, component), amount))
    room.memory.productionReserve ||= {}
    room.memory.productionReserve.factory = reserve
}

/** Select from local stock; labs and undelivered terminal requests are not ingredients. */
export function planFactoryProduction(factory: StructureFactory): void {
    const room = factory.room
    if (isRoomEvacuating(room) || !room.storage || !room.terminal || factory.my === false ||
        (typeof factory.isActive === 'function' && !factory.isActive())) {
        delete room.memory.factoryProduction
        if (room.memory.productionReserve) delete room.memory.productionReserve.factory
        return
    }
    const stock = planningStock(factory)
    let state = room.memory.factoryProduction
    if (state && (state.remaining <= 0 || !canProduceFactoryRecipe(factory, state.resourceType) ||
        state.mode === 'compression' && !compressionAllowed(room, state.resourceType) ||
        stock.cycles(COMMODITIES[state.resourceType]) === 0)) state = undefined
    // A newly available commodity preempts mineral compression immediately.
    const commodity = !state || state.mode === 'compression' ? chooseCommodity(factory, stock) : undefined
    if (commodity) state = makePlan(factory, commodity, 'commodity', stock)
    if (!state) {
        const compressed = chooseCompression(factory, stock)
        if (compressed) state = makePlan(factory, compressed, 'compression', stock)
    }
    if (state) {
        state.remaining = Math.min(state.remaining, stock.cycles(COMMODITIES[state.resourceType]))
        state.inputs = batchInputs(COMMODITIES[state.resourceType], state.remaining)
        room.memory.factoryProduction = state
    } else delete room.memory.factoryProduction
    updateReserve(factory, stock)
}

export function runFactoryProduction(factory: StructureFactory): void {
    const state = factory.room.memory.factoryProduction
    if (!state || isRoomEvacuating(factory.room) || factory.cooldown > 0 ||
        productionTick === Game.time && consumed.has(factory.id) ||
        state.mode === 'compression' && !compressionAllowed(factory.room, state.resourceType) ||
        !canProduceFactoryRecipe(factory, state.resourceType)) return
    const recipe = COMMODITIES[state.resourceType]
    if (!components(recipe).every(([resource, amount]) => factory.store[resource] >= amount &&
        availableIngredient(factory.room, resource) >= amount)) return
    // Ingredients are consumed first, so a full factory can produce a shrinking recipe.
    if ((factory.store.getFreeCapacity() || 0) + recipeInputAmount(recipe) < recipe.amount) return
    if (factory.produce(state.resourceType) === OK) {
        if (productionTick !== Game.time) { productionTick = Game.time; consumed = new Map() }
        consumed.set(factory.id, batchInputs(recipe, 1))
        state.remaining--
        state.inputs = batchInputs(recipe, state.remaining)
        if (state.remaining <= 0) delete factory.room.memory.factoryProduction
        updateReserve(factory)
    }
}

function near(creep: Creep, target: Structure): boolean {
    return creep.pos.roomName === target.pos.roomName &&
        Math.max(Math.abs(creep.pos.x - target.pos.x), Math.abs(creep.pos.y - target.pos.y)) <= 1
}
function stocks(room: Room): Stock[] { return [room.storage, room.terminal].filter((item): item is Stock => !!item) }
function sourceAmount(room: Room, stock: Stock, resource: ResourceConstant): number {
    if (stock.structureType !== STRUCTURE_TERMINAL) return stock.store[resource] || 0
    return Math.max(0, getTerminalResourceAmount(room, resource) -
        (resource === RESOURCE_ENERGY ? resourcePolicy.terminalEnergyReserve : 0))
}
function receivingCapacity(room: Room, target: Stock | StructureFactory): number {
    return target.structureType === STRUCTURE_TERMINAL
        ? getEvacuationIncomingCapacity(room) : target.store.getFreeCapacity()
}
function pendingAmount(room: Room, resource: ResourceConstant, direction: 'fill' | 'drain', except: string): number {
    const transferIntent = direction === 'fill' && transferTick === Game.time ? delivered.get(room.factory!.id)?.[resource] || 0 : 0
    return carriers(room).reduce((sum, creep) => {
        const task = creep.memory.factoryLogistics
        if (creep.name === except || creep.room?.name !== room.name || task?.resourceType !== resource) return sum
        const matches = direction === 'fill' ? task.targetId === room.factory?.id : task.sourceId === room.factory?.id
        return sum + (matches ? task.amount : 0)
    }, transferIntent)
}
function factoryReceivingCapacity(factory: StructureFactory, except: string): number {
    const transferred = transferTick === Game.time ? Object.values(delivered.get(factory.id) || {}).reduce((sum, amount) => sum + amount, 0) : 0
    const pending = carriers(factory.room).reduce((sum, creep) => {
        const task = creep.memory.factoryLogistics
        return sum + (creep.name !== except && task?.targetId === factory.id ? task.amount : 0)
    }, transferred)
    return Math.max(0, factory.store.getFreeCapacity() - pending)
}
function destination(creep: Creep, stationary: boolean): Stock | undefined {
    return stocks(creep.room).reverse().find(stock => receivingCapacity(creep.room, stock) > 0 && (!stationary || near(creep, stock)))
}
function executeTask(creep: Creep, stationary: boolean): boolean {
    const task = creep.memory.factoryLogistics!
    const target = Game.getObjectById<Structure>(task.phase === 'withdraw' ? task.sourceId : task.targetId)
    if (!target || !('store' in target)) { delete creep.memory.factoryLogistics; return false }
    if (!near(creep, target)) {
        if (stationary) { delete creep.memory.factoryLogistics; return false }
        creep.moveTo(target); return true
    }
    if (task.phase === 'withdraw') {
        const available = target.structureType === STRUCTURE_TERMINAL
            ? sourceAmount(creep.room, target as StructureTerminal, task.resourceType) : (target as StructureFactory).store[task.resourceType] || 0
        const amount = Math.min(task.amount, available, creep.store.getFreeCapacity())
        if (amount <= 0) { delete creep.memory.factoryLogistics; return false }
        if (creep.withdraw(target as Stock | StructureFactory, task.resourceType, amount) === OK) {
            if (target.structureType === STRUCTURE_TERMINAL) recordTerminalWithdrawal(creep.room, task.resourceType, amount)
            task.amount = amount; task.phase = 'transfer'; creep.memory.working = true
        } else delete creep.memory.factoryLogistics
        return true
    }
    const held = creep.store[task.resourceType] || 0
    if (held <= 0) { delete creep.memory.factoryLogistics; creep.memory.working = false; return false }
    const capacity = target.id === task.factoryId
        ? factoryReceivingCapacity(target as StructureFactory, creep.name)
        : receivingCapacity(creep.room, target as Stock | StructureFactory)
    const amount = Math.min(held, capacity, task.amount)
    if (amount <= 0) { delete creep.memory.factoryLogistics; return false }
    if (creep.transfer(target, task.resourceType, amount) === OK) {
        if (target.structureType === STRUCTURE_TERMINAL) reserveEvacuationIncoming(creep.room, amount)
        if (target.id === task.factoryId) {
            if (transferTick !== Game.time) { transferTick = Game.time; delivered = new Map() }
            const amounts = delivered.get(task.factoryId) || {}
            amounts[task.resourceType] = (amounts[task.resourceType] || 0) + amount
            delivered.set(task.factoryId, amounts)
        }
        delete creep.memory.factoryLogistics; creep.memory.working = false
    }
    return true
}

/** Mobile processors cover factories outside the manager's fixed seat. */
export function runFactoryLogistics(creep: Creep, stationary = false): boolean {
    const room = creep.room, factory = room.factory
    if (!factory || isRoomEvacuating(room)) { delete creep.memory.factoryLogistics; return false }
    if (creep.memory.factoryLogistics) {
        const task = creep.memory.factoryLogistics
        if (task.factoryId !== factory.id) { delete creep.memory.factoryLogistics; return false }
        // Cancel obsolete input deliveries, returning already carried goods to inventory.
        if (task.targetId === factory.id && !((room.memory.factoryProduction?.inputs[task.resourceType] || 0) > 0)) {
            if ((creep.store[task.resourceType] || 0) > 0) {
                const stock = destination(creep, stationary)
                if (!stock) { delete creep.memory.factoryLogistics; return false }
                task.targetId = stock.id; task.phase = 'transfer'
            } else { delete creep.memory.factoryLogistics; return false }
        }
        return executeTask(creep, stationary)
    }
    if (creep.store.getUsedCapacity() > 0 || stationary && !near(creep, factory)) return false
    const state = room.memory.factoryProduction, inputs = state?.inputs || {}
    const recipe = state && COMMODITIES[state.resourceType]
    const needed = (Object.keys(inputs) as ResourceConstant[]).map(resource => {
        const current = factoryAmount(factory, resource) + pendingAmount(room, resource, 'fill', creep.name)
        return { resource, deficit: inputs[resource] - current,
            nextCycle: Math.max(0, Math.min(inputs[resource], recipe?.components[resource] || 0) - current) }
    })
    const nextCycleCapacity = needed.reduce((sum, item) => sum + item.nextCycle, 0)
    const capacity = factoryReceivingCapacity(factory, creep.name)
    // Complete one reaction before filling the rest of the batch. Extra fuel already
    // in the factory can be used immediately instead of being hauled out first.
    for (const { resource, deficit, nextCycle } of needed.sort((a, b) => Number(b.nextCycle > 0) - Number(a.nextCycle > 0))) {
        if (deficit <= 0) continue
        const stock = stocks(room).find(item => sourceAmount(room, item, resource) > 0 && (!stationary || near(creep, item)))
        if (!stock) continue
        const otherInputs = nextCycleCapacity - nextCycle
        const amount = Math.min(deficit, sourceAmount(room, stock, resource), creep.store.getFreeCapacity(), capacity - otherInputs)
        if (amount <= 0) continue
        creep.memory.factoryLogistics = { factoryId: factory.id, sourceId: stock.id, targetId: factory.id,
            resourceType: resource, amount, phase: 'withdraw' }
        return executeTask(creep, stationary)
    }
    const deposit = destination(creep, stationary)
    if (deposit) for (const resource of Object.keys(factory.store) as ResourceConstant[]) {
        // Drain finished goods and obsolete inputs normally, but keep useful excess
        // components unless they occupy capacity needed by the next reaction.
        const excessLimit = inputs[resource] ? Math.max(0, nextCycleCapacity - capacity) : Infinity
        const amount = Math.min(creep.store.getFreeCapacity(), receivingCapacity(room, deposit), excessLimit,
            factoryAmount(factory, resource) - (inputs[resource] || 0) - pendingAmount(room, resource, 'drain', creep.name))
        if (amount <= 0) continue
        creep.memory.factoryLogistics = { factoryId: factory.id, sourceId: factory.id, targetId: deposit.id,
            resourceType: resource, amount, phase: 'withdraw' }
        return executeTask(creep, stationary)
    }
    return false
}
