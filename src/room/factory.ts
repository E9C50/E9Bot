import { basicMinerals, compressedMinerals, ordinaryResourceKeep, resourcePolicy } from 'settings/resourcePolicy'
import { getGlobalResourceAmount, getOutgoingResourceAmount, getTerminalResourceAmount, isWarehouseRoom,
    recordTerminalWithdrawal } from './resourceNetwork'
import { isRoomEvacuating } from './evacuationState'
import { getEvacuationIncomingCapacity, reserveEvacuationIncoming } from './evacuation'

type FactoryResource = Parameters<StructureFactory['produce']>[0]
type Recipe = typeof COMMODITIES[FactoryResource]
type Stock = StructureStorage | StructureTerminal

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
let transferTick = -1
let delivered = new Map<string, Record<string, number>>()

function components(recipe: Recipe): [ResourceConstant, number][] {
    return Object.entries(recipe.components) as [ResourceConstant, number][]
}
function recipeInputAmount(recipe: Recipe): number {
    return components(recipe).reduce((sum, [, amount]) => sum + amount, 0)
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
function availableIngredient(room: Room, resource: ResourceConstant): number {
    const keep = resource === RESOURCE_ENERGY ? resourcePolicy.terminalEnergyReserve :
        isWarehouseRoom(room) ? 0 : Math.max(ordinaryResourceKeep(resource), room.memory.boostNeed?.[resource] || 0)
    return Math.max(0, localAmount(room, resource) - keep - (room.memory.productionReserve?.lab?.[resource] || 0) -
        getOutgoingResourceAmount(room.name, resource))
}
function possibleCycles(factory: StructureFactory, recipe: Recipe): number {
    const capacity = factory.store.getCapacity() || 0
    const inputAmount = recipeInputAmount(recipe)
    if (Math.max(inputAmount, recipe.amount) > capacity || inputAmount <= 0) return 0
    const available = Math.min(...components(recipe).map(([resource, amount]) =>
        Math.floor(availableIngredient(factory.room, resource) / amount)))
    const fit = Math.max(1, Math.floor((capacity - Math.max(outputHeadroom, recipe.amount)) / inputAmount))
    return Math.max(0, Math.min(available, fit, maximumBatchCycles, Math.ceil(batchProductionTicks / recipe.cooldown)))
}
function commodityResources(): FactoryResource[] {
    if (commodities) return commodities
    const excluded = new Set<string>([RESOURCE_ENERGY, RESOURCE_BATTERY, RESOURCE_GHODIUM,
        ...basicMinerals, ...Object.values(compressedMinerals)])
    commodities = (Object.keys(COMMODITIES) as FactoryResource[]).filter(resource => !excluded.has(resource))
    return commodities
}
function chooseCommodity(factory: StructureFactory): FactoryResource | undefined {
    return commodityResources().filter(resource => canProduceFactoryRecipe(factory, resource) &&
        possibleCycles(factory, COMMODITIES[resource]) > 0).sort((a, b) =>
        (COMMODITIES[b].level || 0) - (COMMODITIES[a].level || 0) ||
        getGlobalResourceAmount(a) / COMMODITIES[a].amount - getGlobalResourceAmount(b) / COMMODITIES[b].amount ||
        a.localeCompare(b))[0]
}
function makePlan(factory: StructureFactory, resource: FactoryResource, mode: FactoryProductionState['mode']): FactoryProductionState {
    const recipe = COMMODITIES[resource]
    const remaining = possibleCycles(factory, recipe)
    return { resourceType: resource, mode, remaining, createdAt: Game.time,
        inputs: batchInputs(recipe, remaining) }
}
function updateReserve(factory: StructureFactory): void {
    const room = factory.room, state = room.memory.factoryProduction
    const reserve: Record<string, number> = { ...state?.inputs }
    // Keep one batch of existing commodity precursors for this factory's next recipe,
    // including while its power effect is being refreshed. Export everything beyond it.
    const intermediates = commodityIntermediates || (commodityIntermediates =
        new Set<string>([...commodityResources(), ...Object.values(compressedMinerals)]))
    for (const resource of commodityResources()) {
        const recipe = COMMODITIES[resource]
        if (!matchingLevel(factory, recipe)) continue
        for (const [component, amount] of components(recipe)) if (intermediates.has(component))
            reserve[component] = Math.max(reserve[component] || 0, Math.min(localAmount(room, component), amount))
    }
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
    let state = room.memory.factoryProduction
    if (state && (state.remaining <= 0 || !canProduceFactoryRecipe(factory, state.resourceType) ||
        possibleCycles(factory, COMMODITIES[state.resourceType]) === 0)) state = undefined
    // A newly available commodity preempts mineral compression immediately.
    const commodity = !state || state.mode === 'compression' ? chooseCommodity(factory) : undefined
    if (commodity) state = makePlan(factory, commodity, 'commodity')
    if (!state) {
        const mineral = room.mineral?.mineralType
        const compressed = mineral && compressedMinerals[mineral] as FactoryResource | undefined
        if (compressed && canProduceFactoryRecipe(factory, compressed) && possibleCycles(factory, COMMODITIES[compressed]) > 0)
            state = makePlan(factory, compressed, 'compression')
    }
    if (state) {
        state.remaining = Math.min(state.remaining, possibleCycles(factory, COMMODITIES[state.resourceType]))
        state.inputs = batchInputs(COMMODITIES[state.resourceType], state.remaining)
        room.memory.factoryProduction = state
    } else delete room.memory.factoryProduction
    updateReserve(factory)
}

export function runFactoryProduction(factory: StructureFactory): void {
    const state = factory.room.memory.factoryProduction
    if (!state || isRoomEvacuating(factory.room) || factory.cooldown > 0 ||
        productionTick === Game.time && consumed.has(factory.id) ||
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
    const amount = Math.min(held, receivingCapacity(creep.room, target as Stock | StructureFactory), task.amount)
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
    const deposit = destination(creep, stationary)
    // Clear finished goods and obsolete ingredients before filling a new batch.
    if (deposit) for (const resource of Object.keys(factory.store) as ResourceConstant[]) {
        const amount = Math.min(creep.store.getFreeCapacity(), receivingCapacity(room, deposit),
            factoryAmount(factory, resource) - (inputs[resource] || 0) - pendingAmount(room, resource, 'drain', creep.name))
        if (amount <= 0) continue
        creep.memory.factoryLogistics = { factoryId: factory.id, sourceId: factory.id, targetId: deposit.id,
            resourceType: resource, amount, phase: 'withdraw' }
        return executeTask(creep, stationary)
    }
    if (!state || factory.store.getFreeCapacity() <= 0) return false
    for (const resource of Object.keys(inputs) as ResourceConstant[]) {
        const deficit = inputs[resource] - factoryAmount(factory, resource) - pendingAmount(room, resource, 'fill', creep.name)
        if (deficit <= 0) continue
        const stock = stocks(room).find(item => sourceAmount(room, item, resource) > 0 && (!stationary || near(creep, item)))
        if (!stock) continue
        const amount = Math.min(deficit, sourceAmount(room, stock, resource), creep.store.getFreeCapacity(), factory.store.getFreeCapacity())
        if (amount <= 0) continue
        creep.memory.factoryLogistics = { factoryId: factory.id, sourceId: stock.id, targetId: factory.id,
            resourceType: resource, amount, phase: 'withdraw' }
        return executeTask(creep, stationary)
    }
    return false
}
