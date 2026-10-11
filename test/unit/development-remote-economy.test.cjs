const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

const costs = { work: 100, carry: 50, move: 50, claim: 600 };
const position = (x, y, roomName) => ({ x, y, roomName });
const approximately = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

function world({ automatic = false, sources = 1, reserveRequired = true, trip = 100 } = {}) {
    const home = { name: 'W1N1', energyCapacityAvailable: 2200, controller: { my: true, level: 6, owner: { username: 'ours' } },
        memory: { creepConfig: {}, remoteCommissioning: { rooms: {} },
            developmentRemotes: { selectedRooms: automatic ? ['W1N2'] : [], intel: {} } } };
    const remote = { name: 'W1N2', containers: [], links: [], controller: { reservation: { username: 'ours', ticksToEnd: 2000 } }, enemies: [] };
    const spawn = { id: 'spawn', pos: position(20, 20, home.name) };
    const objects = new Map([[spawn.id, spawn]]), previews = [], creeps = [];
    const game = { time: 100, shard: { name: 'shard1' }, rooms: { [home.name]: home, [remote.name]: remote }, flags: {}, creeps: {},
        map: { findRoute() { throw Error('population accounting must not find routes'); } }, getObjectById: id => objects.get(id) || null };
    if (!automatic) game.flags.W1N1_OUT0 = { pos: position(1, 0, remote.name) };
    const record = home.memory.remoteCommissioning.rooms[remote.name] = { kind: automatic ? 'automatic' : 'manual', reserveRequired, sources: {} };
    const intel = home.memory.developmentRemotes.intel[remote.name] = { seenAt: 100, status: 'safe', sources: [] };
    const metadata = (kind, source) => automatic ? { developmentRemote: { homeRoom: home.name, targetRoom: remote.name, kind,
        homePosition: { x: 20, y: 20 }, source: source && { id: source.id, x: source.pos.x, y: source.pos.y, travelTicks: trip } } } : {};
    const worker = (role, source, { name = `${role}-${source?.id || 'room'}`, work = role === 'rHarvester' ? 5 : 0,
        carry = role === 'rFiller' ? 20 : 1, move = role === 'rFiller' ? 20 : 1, x = source?.pos.x || 10, y = source?.pos.y || 10,
        roomName = remote.name, energy = 0 } = {}) => {
        const data = { ...metadata(role === 'rHarvester' ? 'harvester' : role === 'rFiller' ? 'hauler' : 'reserver', source),
            ...(role === 'rHarvester' ? { sourceId: source.id, targetRoom: remote.name } :
                role === 'rFiller' ? { sourceFlag: source.id, targetFlag: spawn.id } : { targetRoom: remote.name }) };
        const creep = { name, id: `${name}-id`, spawning: false, ticksToLive: 1000,
            pos: position(x, y, roomName), room: game.rooms[roomName], memory: { name, role, spawnRoom: home.name, data },
            store: { energy, getCapacity: () => carry * 50 },
            body: [...Array(work).fill({ type: 'work', hits: 100 }), ...Array(carry).fill({ type: 'carry', hits: 100 }), ...Array(move).fill({ type: 'move', hits: 100 })],
            getActiveBodyparts: part => creep.body.filter(value => value.type === part && value.hits > 0).length };
        creeps.push(creep); game.creeps[name] = creep;
        return creep;
    };
    const mines = [];
    for (let index = 0; index < sources; index++) {
        const source = { id: `source${index}`, pos: position(10 + index * 10, 10, remote.name), energyCapacity: 3000, room: remote };
        objects.set(source.id, source); record.sources[source.id] = { id: source.id, x: source.pos.x, y: source.pos.y, haulersSeen: {} };
        intel.sources.push({ id: source.id, x: source.pos.x, y: source.pos.y, travelTicks: trip }); mines.push(source);
    }
    const loader = createSourceLoader({ globals: { ...nativeBodies.globals, Game: game, WORK: 'work', CARRY: 'carry', MOVE: 'move', RESOURCE_ENERGY: 'energy',
        HARVEST_POWER: 2, CARRY_CAPACITY: 50, ENERGY_REGEN_TIME: 300, CREEP_LIFE_TIME: 1500, CREEP_CLAIM_LIFE_TIME: 600,
        BODYPART_COST: costs, BOOSTS: { move: { XZHO2: { fatigue: 4 } } } },
        modules: { ...nativeBodies.modules, './bodySelection': { previewBodySelection(room, config, tier) {
            assert.equal(tier, 0, 'accounting cannot prepare or reserve boosts');
            previews.push({ role: config.role, data: config.data });
            const limit = config.bodyProfile?.maximumCost;
            if (limit === 200) return { body: ['work', 'carry', 'move'] };
            if (config.role === 'rHarvester') return { body: [...Array(13).fill('work'), ...Array(13).fill('carry'), ...Array(3).fill('move')] };
            if (config.role === 'rFiller') return { body: [...Array(22).fill('carry'), ...Array(22).fill('move')] };
            return loader.load('creep/bodySelection').previewBodySelection(room, config, tier);
        } } } });
    const economy = loader.load('creep/developmentRemoteEconomy').getDevelopmentRemoteEconomy;
    return { home, remote, game, objects, creeps, mines, record, intel, worker, previews, loader,
        economy: () => economy(home, creeps), fleet() {
            return mines.map(source => ({ source, miner: worker('rHarvester', source), hauler: worker('rFiller', source) }));
        } };
}

test('manual OUT income reaches the development budget even with no automatic selected rooms', () => {
    const w = world({ sources: 2 }); w.fleet();
    const result = w.economy();
    assert.equal(result.income, 20);
    approximately(result.upkeep, (2100 + 2200) * 2 / 1500 + 1300 / 600);
    assert.deepEqual(w.previews.map(value => value.role).sort(), ['rFiller', 'rHarvester', 'reserver'],
        'equivalent bodies from multiple mines reuse a price preview');
});

test('automatic income retains selection and fresh safe intel requirements', () => {
    const w = world({ automatic: true }); w.fleet();
    assert.equal(w.economy().income, 10);
    for (const state of ['blocked', 'unreachable', 'unknown']) {
        w.intel.status = state; assert.equal(w.economy().income, 0);
    }
    w.intel.status = 'safe'; w.game.time = 1600;
    assert.equal(w.economy().income, 0, 'stale intel cannot fund new consumers');
    w.game.time = 99; assert.equal(w.economy().income, 0, 'future intel is invalid');
    w.game.time = 100; w.home.memory.developmentRemotes.selectedRooms = [];
    assert.equal(w.economy().income, 0);
});

test('queued, travelling, spawning, boosted-preparing, unsafe and invisible mines promise no income or upkeep', () => {
    for (const change of [w => {}, w => { w.worker('rHarvester', w.mines[0]).spawning = true; },
        w => { const creep = w.worker('rHarvester', w.mines[0]); creep.pos.roomName = w.home.name; },
        w => { w.worker('rHarvester', w.mines[0]).memory.boostPlan = { steps: [{}], completed: false }; },
        w => { w.worker('rHarvester', w.mines[0]); w.remote.enemies.push({}); },
        w => { w.worker('rHarvester', w.mines[0]); w.objects.delete(w.mines[0].id); }]) {
        const w = world(); w.worker('rFiller', w.mines[0]); change(w);
        assert.equal(w.economy().income, 0); assert.equal(w.economy().upkeep, 0);
    }
});

test('hauling must have reached its mine; an empty proved returner stays operational', () => {
    const w = world(); const [{ source, hauler }] = w.fleet();
    hauler.pos = position(20, 20, w.home.name); w.record.sources[source.id].delivered = true;
    assert.equal(w.economy().income, 0, 'a historical delivery cannot qualify a new unit waiting at Spawn');
    w.record.sources[source.id].haulersSeen[hauler.id] = true;
    assert.equal(w.economy().income, 10, 'the same commissioned carrier can be empty on its return leg');
    delete w.record.sources[source.id].haulersSeen[hauler.id]; hauler.memory.working = true; hauler.store.energy = 100;
    assert.equal(w.economy().income, 10, 'loaded delivery is evidence the carrier reached its mine');
});

test('real carry capacity, MOVE fatigue and completed movement boosts bound transport income', () => {
    const w = world(); const source = w.mines[0]; w.worker('rHarvester', source);
    const hauler = w.worker('rFiller', source, { carry: 10, move: 5 });
    approximately(w.economy().income, 500 / 150);
    for (const part of hauler.body) if (part.type === 'move') part.boost = 'XZHO2';
    assert.equal(w.economy().income, 5);
    hauler.store.getCapacity = () => 1000;
    assert.equal(w.economy().income, 10, 'actual boosted storage capacity is authoritative');
    hauler.body.forEach(part => { if (part.type === 'move') part.hits = 0; });
    assert.equal(w.economy().income, 0);
});

test('overlapping replacement carriers form one fleet slot, including reciprocal predecessor memory', () => {
    const w = world(); const [{ source, miner, hauler }] = w.fleet();
    const next = w.worker('rFiller', source, { name: 'next', carry: 20, move: 20 });
    next.memory.development = { fullBody: true, replacement: { predecessor: hauler.name, deadline: 200 } };
    hauler.memory.development = { fullBody: true, replacement: { predecessor: next.name, deadline: 200 } };
    const second = w.worker('rHarvester', source, { name: 'nextMiner', work: 13 });
    second.memory.development = { fullBody: true, replacement: { predecessor: miner.name, deadline: 200 } };
    const result = w.economy();
    assert.equal(result.income, 10);
    approximately(result.upkeep, (2100 + 2200) / 1500 + 1300 / 600);
});

test('several genuinely necessary small miners and hauling slots retain their fleet upkeep', () => {
    const w = world(); const source = w.mines[0];
    w.worker('rHarvester', source, { name: 'miner1', work: 2 }); w.worker('rHarvester', source, { name: 'miner2', work: 2 });
    w.worker('rFiller', source, { name: 'hauler1', carry: 10, move: 10 }); w.worker('rFiller', source, { name: 'hauler2', carry: 10, move: 10 });
    const result = w.economy(); assert.equal(result.income, 8);
    approximately(result.upkeep, (2100 + 2200) * 2 / 1500 + 1300 / 600);
});

test('expired predecessor memory does not merge distinct reused hauling slots', () => {
    const w = world(); const [{ source, hauler }] = w.fleet();
    const other = w.worker('rFiller', source, { name: 'other', carry: 10, move: 10 });
    hauler.memory.development = { replacement: { predecessor: other.name, deadline: 50 } };
    const result = w.economy();
    approximately(result.upkeep, (2100 + 2200 * 2) / 1500 + 1300 / 600);
});

test('only operating Sources incur fleet cost, and necessary reservation is charged once at CLAIM lifetime', () => {
    const w = world({ sources: 2 }); w.worker('rHarvester', w.mines[0]); w.worker('rFiller', w.mines[0]);
    w.worker('rHarvester', w.mines[1]);
    const first = w.economy(); approximately(first.upkeep, 4300 / 1500 + 1300 / 600);
    w.remote.controller.reservation.ticksToEnd = 500;
    approximately(w.economy().upkeep, 4300 / 1500 + 1300 / 600);
    w.record.reserveRequired = false;
    approximately(w.economy().upkeep, 4300 / 1500);
});

test('removed flags, wrong destinations, wrong homes and retiring units cannot fund local work', () => {
    for (const change of [w => { delete w.game.flags.W1N1_OUT0; },
        (w, fleet) => { fleet.miner.memory.spawnRoom = 'W9N9'; },
        (w, fleet) => { fleet.hauler.memory.data.targetFlag = 'elsewhere'; w.objects.set('elsewhere', { pos: position(20, 20, 'W9N9') }); },
        (w, fleet) => { fleet.hauler.memory.data.developmentRemote = { homeRoom: w.home.name, targetRoom: w.remote.name, kind: 'hauler', source: { id: fleet.source.id }, retiring: true }; }]) {
        const w = world(); const [fleet] = w.fleet(); change(w, fleet); assert.equal(w.economy().income, 0);
    }
});

test('manual mines reuse planned road geometry and conservatively estimate an unplanned multi-room route', () => {
    const w = world(); const [fleet] = w.fleet(); delete w.intel.sources[0].travelTicks;
    fleet.hauler.store.getCapacity = () => 300;
    assert.equal(w.economy().income, 2, 'one room uses the existing conservative 150-tick round trip');
    w.home.memory.remoteRoads = { routes: { 'W1N2/source0': { targetRoom: 'W1N2', sourceId: 'source0', plannedAt: 1,
        rooms: { W1N1: Array(20).fill(0), W1N2: Array(20).fill(0) } } } };
    approximately(w.economy().income, 300 / 86, 'border steps and collection/delivery are included');
});

test('profile changes are reflected without cross-publication price caching', () => {
    const w = world(); const [fleet] = w.fleet();
    const first = w.economy(); fleet.miner.memory.bodyProfile = { maximumCost: 200 };
    const second = w.economy(); assert.ok(second.upkeep < first.upkeep);
    approximately(second.upkeep, (200 + 2200) / 1500 + 1300 / 600);
});

test('automatic reservation fallback prices the native capacity body after its reserver is gone', () => {
    for (const [capacity, cost] of [[650, 650], [1299, 650], [1300, 1300], [2200, 1300]]) {
        for (const reserved of [false, true]) {
            const w = world({ automatic: true }); w.fleet();
            w.home.energyCapacityAvailable = capacity;
            if (!reserved) delete w.remote.controller.reservation;
            w.record.reserveRequired = false;
            const baseline = w.economy().upkeep;
            w.record.reserveRequired = true;
            approximately(w.economy().upkeep - baseline, cost / 600);
        }
    }
});
