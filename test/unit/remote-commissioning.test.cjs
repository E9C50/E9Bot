const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const { createCombatWorld } = require('../helpers/combat-world.cjs');

function world({ level = 3, capacity = 800, manual = true } = {}) {
    const combat = createCombatWorld(), game = combat.game;
    game.flags = {};
    const home = combat.room('W1N1', { my: true }); home.controller.level = level; home.energyCapacityAvailable = capacity;
    home.memory.developmentRemotes = { candidates: [], selectedRooms: [], intel: {} };
    const loader = createSourceLoader({ globals: { ...combat.loader.globals, Game: game,
        BODYPART_COST: { claim: 600, move: 50 } } });
    const api = loader.load('creep/remoteCommissioning');
    function target(name = 'W2N1', ids = ['one']) {
        const room = combat.room(name);
        room.sources = ids.map((id, index) => {
            const source = { id, pos: combat.position(10 + index * 10, 10, name) };
            combat.byId.set(id, source); return source;
        });
        return room;
    }
    const first = target(), second = target('W1N2', ['two']);
    if (manual) {
        game.flags.W1N1_OUT0 = { pos: combat.position(25, 25, first.name) };
        game.flags.W1N1_OUT1 = { pos: combat.position(25, 25, second.name) };
    } else home.memory.developmentRemotes.selectedRooms = [first.name, second.name];
    const spec = room => room.sources.map(source => ({ id: source.id, x: source.pos.x, y: source.pos.y }));
    function decide(room = first, options = {}, ...sourceArgs) {
        const sources = sourceArgs.length ? sourceArgs[0] : spec(room);
        return api.remoteCommissioningDecision(home, room.name, sources,
            { kind: manual ? 'manual' : 'automatic', reserveRequired: level >= 3, planningComplete: true, ...options });
    }
    function unit(role, room = first, source = room.sources[0], overrides = {}) {
        const body = role === 'reserver' ? ['claim', 'move'] : role === 'rHarvester' ? ['work', 'carry', 'move'] : ['carry', 'move'];
        const name = overrides.name || `${role}-${source.id}-${Object.keys(game.creeps).length}`;
        const pos = role === 'reserver' ? { x: 40, y: 39 } : { x: source.pos.x, y: source.pos.y - 1 };
        const creep = combat.unit(name, body, { roomName: room.name, ...pos, ...overrides });
        creep.memory = { role, spawnRoom: home.name, working: false,
            boostPlan: { tier: 0, steps: [], completed: true },
            data: role === 'reserver' ? { targetRoom: room.name } : role === 'rHarvester' ?
                { targetRoom: room.name, sourceId: source.id } : { sourceFlag: source.id, targetFlag: 'spawn' } };
        creep.store = { energy: 0 };
        creep.getActiveBodyparts = type => creep.body.filter(part => part.type === type && part.hits > 0).length;
        return creep;
    }
    function step() { game.time++; }
    function reserve(room = first) { room.controller.reservation = { username: 'me', ticksToEnd: 2000 }; return unit('reserver', room); }
    function deliver(creep, amount = 50) {
        creep.pos = combat.position(15, 15, home.name); creep.store.energy = 0; creep.memory.working = true;
        api.recordRemoteEnergyDelivery(creep, amount);
    }
    function commission(room = first, options = {}) {
        decide(room, options);
        if (level >= 3) reserve(room);
        const miners = room.sources.map(source => unit('rHarvester', room, source));
        const haulers = room.sources.map(source => unit('rFiller', room, source));
        step(); decide(room, options);
        for (const hauler of haulers) deliver(hauler);
        step(); const result = decide(room, options);
        return { result, miners, haulers };
    }
    return { ...combat, api, game, home, first, second, target, spec, decide, unit, step, reserve, deliver, commission };
}

test('manual OUT mines commission one at a time through reserver, all miners, hauling and first real delivery', () => {
    const w = world();
    assert.equal(w.decide().phase, 'reserving'); assert.equal(w.decide(w.second).admitted, false);
    w.reserve(); w.step(); assert.equal(w.decide().phase, 'mining');
    w.unit('rHarvester'); w.step(); assert.equal(w.decide().phase, 'hauling');
    const hauler = w.unit('rFiller'); w.step(); assert.match(w.decide().reason, /first successful energy delivery/);
    assert.equal(w.decide(w.second).admitted, false);
    w.deliver(hauler); w.step(); assert.equal(w.decide().phase, 'ready');
    assert.equal(w.home.memory.remoteCommissioning.current, undefined);
    assert.equal(w.decide(w.second).admitted, true); assert.equal(w.home.memory.remoteCommissioning.current, w.second.name);
});

test('RCL2 starts mining without reservation while insufficient RCL3 reservation capacity cannot start miners', () => {
    const low = world({ level: 2, capacity: 550 }); assert.equal(low.decide().phase, 'mining');
    assert.equal(low.commission().result.phase, 'ready');
    const insufficient = world({ capacity: 550 }); const wait = insufficient.decide();
    assert.equal(wait.admitted, true); assert.equal(wait.phase, 'waiting'); assert.match(wait.reason, /650/);
    assert.equal(insufficient.api.remoteSpawnAllowed(insufficient.home,
        { role: 'rHarvester', data: { sourceId: 'one', targetRoom: insufficient.first.name } }), false);
});

test('pending, spawning, dead-body or misplaced reservers and miners are not operational', () => {
    for (const invalid of ['spawning', 'body', 'boost', 'position', 'retiring']) {
        const w = world(); w.decide(); const reserver = w.reserve();
        if (invalid === 'spawning') reserver.spawning = true;
        if (invalid === 'body') reserver.body.find(part => part.type === 'claim').hits = 0;
        if (invalid === 'boost') reserver.memory.boostPlan = { tier: 3, steps: [{ type: 'boostMove', resource: 'XZHO2', parts: 1 }] };
        if (invalid === 'position') reserver.pos = w.position(5, 5, w.first.name);
        if (invalid === 'retiring') reserver.memory.data.developmentRemote = { targetRoom: w.first.name, retiring: true };
        w.step(); assert.equal(w.decide().phase, 'reserving', invalid); assert.equal(w.decide().maintenance, false);
    }
    for (const invalid of ['spawning', 'body', 'boost', 'position', 'retiring']) {
        const w = world(); w.decide(); w.reserve(); const miner = w.unit('rHarvester');
        if (invalid === 'spawning') miner.spawning = true;
        if (invalid === 'body') miner.body.find(part => part.type === 'work').hits = 0;
        if (invalid === 'boost') miner.memory.boostPlan = { tier: 3, steps: [{ type: 'boostHarvest', resource: 'XUHO2', parts: 1 }] };
        if (invalid === 'position') miner.pos = w.position(5, 5, w.home.name);
        if (invalid === 'retiring') miner.memory.data.developmentRemote = { targetRoom: w.first.name, retiring: true };
        w.step(); assert.equal(w.decide().phase, 'mining', invalid);
    }
});

test('all planned hauler slots must deploy and every Source must prove its first accepted delivery', () => {
    const w = world(); w.target(w.first.name, ['one', 'other']);
    const options = { haulerCounts: { one: 2, other: 1 } };
    w.decide(w.first, options); w.reserve();
    for (const source of w.first.sources) w.unit('rHarvester', w.first, source);
    const first = w.unit('rFiller'), second = w.unit('rFiller');
    second.spawning = true; const other = w.unit('rFiller', w.first, w.first.sources[1]);
    w.step(); assert.match(w.decide(w.first, options).reason, /1\/2/);
    w.deliver(first); w.deliver(other); second.spawning = false; w.step();
    assert.equal(w.decide(w.first, options).phase, 'ready');
    assert.equal(w.home.memory.remoteCommissioning.rooms[w.first.name].sources.other.delivered, true);
});

test('delivery evidence ignores zero, rejected, wrong-role, wrong-home and unregistered-source transfers', () => {
    const w = world(); w.decide(); const hauler = w.unit('rFiller');
    w.api.recordRemoteEnergyDelivery(hauler, 50); // Still in the mine, not delivering to its home.
    w.deliver(hauler, 0); w.api.recordRemoteEnergyDelivery(hauler, -1); w.api.recordRemoteEnergyDelivery(hauler, NaN);
    hauler.memory.role = 'filler'; w.api.recordRemoteEnergyDelivery(hauler, 50);
    hauler.memory.role = 'rFiller'; hauler.memory.data.sourceFlag = 'unregistered'; w.api.recordRemoteEnergyDelivery(hauler, 50);
    assert.equal(w.home.memory.remoteCommissioning.rooms[w.first.name].sources.one.delivered, undefined);
    hauler.memory.data.sourceFlag = 'one'; w.api.recordRemoteEnergyDelivery(hauler, 50);
    assert.equal(w.home.memory.remoteCommissioning.rooms[w.first.name].sources.one.delivered, true);
});

test('same-name replacement haulers need a new native-id deployment instead of inheriting the previous body evidence', () => {
    const w = world({ level: 2 }); const { haulers } = w.commission();
    const old = haulers[0]; delete w.game.creeps[old.name]; w.step();
    assert.equal(w.decide().phase, 'hauling');
    const replacement = w.unit('rFiller', w.first, undefined, { name: old.name, roomName: w.home.name, x: 15, y: 15 });
    replacement.id = 'replacement-native-id'; w.step(); assert.equal(w.decide().phase, 'hauling');
    replacement.pos = w.position(10, 9, w.first.name); w.step(); assert.equal(w.decide().phase, 'ready');
});

test('commissioned mines retain all maintenance demands while another mine starts and while room visibility is absent', () => {
    const w = world(); assert.equal(w.commission().result.phase, 'ready');
    assert.equal(w.decide(w.second).admitted, true);
    delete w.game.rooms[w.first.name]; w.step();
    const unseen = w.decide(w.first, {}, undefined);
    assert.equal(unseen.maintenance, true); assert.equal(unseen.admitted, true); assert.equal(unseen.phase, 'ready');
    assert.equal(w.api.getRemoteCommissioningSources(w.home, w.first.name).length, 1);
    const miner = Object.values(w.game.creeps).find(creep => creep.memory.role === 'rHarvester');
    delete w.game.creeps[miner.name]; w.step();
    const repair = w.decide(w.first, {}, undefined);
    assert.equal(repair.maintenance, true); assert.equal(repair.admitted, true); assert.equal(repair.phase, 'mining');
    assert.equal(w.home.memory.remoteCommissioning.current, w.second.name);
});

test('a preexisting paid fleet is maintenance migration proof, while a lone paid reserver cannot bypass mining stages', () => {
    const fleet = world(); fleet.unit('rHarvester'); const legacy = fleet.decide();
    assert.equal(legacy.maintenance, true); assert.equal(legacy.phase, 'reserving');
    assert.equal(fleet.home.memory.remoteCommissioning.rooms[fleet.first.name].ready, false);
    const lone = world(); lone.reserve(); const normal = lone.decide();
    assert.equal(normal.maintenance, false); assert.equal(normal.phase, 'mining');
});

test('manual flag order gates automatic admission and deleting or moving a flag releases the current manual slot', () => {
    const w = world(); w.home.memory.developmentRemotes.selectedRooms = ['W3N1'];
    const automatic = w.target('W3N1', ['automatic']);
    const blocked = w.decide(automatic, { kind: 'automatic' }); assert.equal(blocked.admitted, false); assert.match(blocked.reason, /manual OUT/);
    assert.equal(w.decide(w.second).admitted, false); assert.equal(w.decide().admitted, true);
    delete w.game.flags.W1N1_OUT0;
    assert.equal(w.decide(w.second).admitted, true); assert.equal(w.home.memory.remoteCommissioning.current, w.second.name);
    w.game.flags.W1N1_OUT1.pos = w.position(25, 25, automatic.name);
    const moved = w.decide(automatic, { kind: 'manual' }); assert.equal(moved.admitted, true);
    assert.equal(w.home.memory.remoteCommissioning.current, automatic.name);
});

test('incomplete or incrementally discovered Source plans cannot finish commissioning early', () => {
    const w = world({ level: 2 });
    assert.equal(w.commission(w.first, { planningComplete: false }).result.phase, 'hauling');
    assert.equal(w.decide(w.second).admitted, false);
    w.target(w.first.name, ['one', 'new']);
    assert.equal(w.decide(w.first, { planningComplete: false }).phase, 'mining');
    const source = w.first.sources[1]; w.unit('rHarvester', w.first, source); const hauler = w.unit('rFiller', w.first, source);
    w.step(); w.decide(w.first, { planningComplete: false }); w.deliver(hauler); w.step();
    assert.equal(w.decide(w.first, { planningComplete: false }).phase, 'hauling');
    assert.equal(w.decide(w.first, { planningComplete: true }).phase, 'ready');
});

test('a proven unreachable automatic remote releases only its pending slot and keeps its diagnostic state', () => {
    const w = world({ manual: false }); assert.equal(w.decide().admitted, true);
    w.api.releaseRemoteCommissioning(w.home, w.first.name, 'No source route');
    assert.equal(w.home.memory.remoteCommissioning.current, undefined);
    assert.equal(w.home.memory.remoteCommissioning.rooms[w.first.name].reason, 'No source route');
    assert.equal(w.decide(w.second).admitted, true);
});

test('current-tick spawn guard rejects stale later-mine or deleted-flag births while preserving unrelated jobs', () => {
    const w = world(); w.decide(); w.decide(w.second);
    const config = (role, room = w.first, source = room.sources[0]) => ({ role, data: role === 'reserver' ?
        { targetRoom: room.name } : role === 'rHarvester' ? { targetRoom: room.name, sourceId: source.id } : { sourceFlag: source.id } });
    assert.equal(w.api.remoteSpawnAllowed(w.home, config('reserver')), true);
    assert.equal(w.api.remoteSpawnAllowed(w.home, config('reserver', w.second)), false);
    assert.equal(w.api.remoteSpawnAllowed(w.home, config('rHarvester')), false);
    w.reserve(); w.step(); w.decide(); assert.equal(w.api.remoteSpawnAllowed(w.home, config('rHarvester')), true);
    assert.equal(w.api.remoteSpawnAllowed(w.home, config('rFiller')), false);
    delete w.game.flags.W1N1_OUT0;
    assert.equal(w.api.remoteSpawnAllowed(w.home, config('reserver')), false);
    assert.equal(w.api.remoteSpawnAllowed(w.home, { role: 'scout', data: { targetFlag: 'W1N1_OUT0' } }), false);
    for (const role of ['builder', 'harvester', 'filler', 'rFiller', 'rBuilder']) {
        const data = role === 'rFiller' ? { sourceFlag: 'W1N1_RF_S0', targetFlag: 'W1N1_RF_T0' } : {};
        assert.equal(w.api.remoteSpawnAllowed(w.home, { role, data }), true, role);
    }
});

test('maintenance fleet health gates only first admission of another mine, preserving a previously admitted current mine', () => {
    const w = world(); const { miners, haulers } = w.commission();
    const established = w.home.memory.remoteCommissioning.rooms[w.first.name];
    delete w.game.creeps[miners[0].name]; w.step(); w.decide();
    assert.equal(established.ready, true); assert.equal(established.operational, false);
    assert.equal(w.home.memory.remoteCommissioning.current, undefined, 'repairing an established mine does not become another startup slot');
    const wait = w.decide(w.second); assert.equal(wait.admitted, false); assert.match(wait.reason, /restore commissioned/);
    w.unit('rHarvester'); w.step(); assert.equal(w.decide().phase, 'ready'); assert.equal(w.decide(w.second).admitted, true);
    haulers[0].body.find(part => part.type === 'move').hits = 0; w.step();
    assert.equal(w.decide().phase, 'hauling'); assert.equal(w.decide(w.second).admitted, true);
    assert.equal(w.home.memory.remoteCommissioning.current, w.second.name);
});

test('invalid manual flags cannot reserve the startup slot before a valid later OUT mine', () => {
    for (const invalid of ['owned', 'no-controller', 'no-source', 'home']) {
        const w = world();
        let target = w.first;
        if (invalid === 'owned') w.first.controller.owner = { username: 'enemy' };
        if (invalid === 'no-controller') delete w.first.controller;
        if (invalid === 'no-source') w.first.sources = [];
        if (invalid === 'home') { target = w.home; w.game.flags.W1N1_OUT0.pos = w.position(25, 25, w.home.name); }
        const rejected = w.decide(target); assert.equal(rejected.admitted, false, invalid);
        assert.equal(w.home.memory.remoteCommissioning.current, undefined);
        assert.equal(w.decide(w.second).admitted, true, invalid);
    }
});

test('automatic unknown scouts are guarded by scoutTarget instead of the mined selectedRooms list', () => {
    const w = world({ manual: false }); const unknown = w.target('W3N1', ['unknown']);
    w.home.memory.developmentRemotes.scoutTarget = unknown.name;
    const decision = w.decide(unknown, {}, undefined); assert.equal(decision.admitted, true); assert.equal(decision.phase, 'scouting');
    const config = { role: 'scout', data: { developmentRemote: { targetRoom: unknown.name, kind: 'scout' } } };
    assert.equal(w.api.remoteSpawnAllowed(w.home, config), true);
    w.home.memory.developmentRemotes.scoutTarget = w.second.name;
    assert.equal(w.api.remoteSpawnAllowed(w.home, config), false);
});

test('new manual OUT flags take the automatic scouting slot even when its paid scout loses scoutTarget', () => {
    const w = world({ manual: false }); const unknown = w.target('W3N1', ['unknown']);
    w.home.memory.developmentRemotes.scoutTarget = unknown.name;
    assert.equal(w.decide(unknown, {}, undefined).phase, 'scouting');
    const scout = w.unit('scout', unknown);
    scout.memory.data = { developmentRemote: { targetRoom: unknown.name, kind: 'scout' } };
    w.game.flags.W1N1_OUT0 = { pos: w.position(25, 25, w.first.name) };
    w.game.flags.W1N1_OUT1 = { pos: w.position(25, 25, w.second.name) };
    delete w.home.memory.developmentRemotes.scoutTarget;
    assert.equal(w.decide(w.second, { kind: 'manual' }).admitted, false, 'OUT order still chooses the first manual mine');
    const decision = w.decide(w.first, { kind: 'manual' });
    assert.equal(decision.admitted, true); assert.equal(decision.phase, 'reserving');
    assert.equal(w.home.memory.remoteCommissioning.current, w.first.name);
    assert.equal(w.home.memory.remoteCommissioning.rooms[unknown.name].admitted, false);
    assert.ok(w.game.creeps[scout.name], 'the paid scout is not deleted or retired');
    assert.equal(w.decide(unknown, {}, undefined).admitted, false);
});

test('manual OUT flags cannot preempt automatic reservation, mining, hauling or an already paid mining fleet', () => {
    for (const stage of ['reserving', 'mining', 'hauling', 'maintenance', 'new-paid-miner', 'new-paid-hauler']) {
        const w = world({ manual: false });
        if (stage === 'maintenance') w.unit('rHarvester');
        if (['maintenance', 'new-paid-miner', 'new-paid-hauler'].includes(stage)) w.decide(w.first, {}, undefined);
        else w.decide();
        if (stage === 'mining' || stage === 'hauling') { w.reserve(); w.step(); w.decide(); }
        if (stage === 'hauling') { w.unit('rHarvester'); w.step(); w.decide(); }
        if (stage === 'new-paid-miner') { w.unit('rHarvester'); w.step(); }
        if (stage === 'new-paid-hauler') {
            const hauler = w.unit('rFiller'); hauler.memory.data.developmentRemote = { targetRoom: w.first.name };
            w.step();
        }
        w.game.flags.W1N1_OUT0 = { pos: w.position(25, 25, w.second.name) };
        const decision = w.decide(w.second, { kind: 'manual' });
        assert.equal(decision.admitted, false, stage);
        assert.equal(w.home.memory.remoteCommissioning.current, w.first.name, stage);
    }
});

test('bootstrap assistance and independent RF/RB flags stay outside historical OUT commissioning guards', () => {
    const w = world(); w.decide();
    w.first.controller.owner = { username: 'me' }; w.first.controller.my = true;
    const bootstrap = { role: 'rBuilder', data: { bootstrap: true, sourceFlag: 'one', targetFlag: 'one' } };
    assert.equal(w.api.remoteSpawnAllowed(w.home, bootstrap), true);
    for (const [role, prefix] of [['rFiller', 'RF'], ['rBuilder', 'RB']]) {
        const sourceFlag = `W1N1_${prefix}_S0`, targetFlag = `W1N1_${prefix}_T0`;
        w.game.flags[sourceFlag] = { pos: w.position(10, 10, w.first.name) };
        w.game.flags[targetFlag] = { pos: w.position(20, 20, w.second.name) };
        assert.equal(w.api.remoteSpawnAllowed(w.home, { role, data: { sourceFlag, targetFlag } }), true);
    }
});

test('stale OUT construction queues wait until hauling starts and do not bypass a return to mining', () => {
    const w = world(); w.decide(); w.reserve(); w.step(); w.decide();
    const builder = { role: 'rBuilder', data: { sourceFlag: 'one', targetFlag: 'one' } };
    assert.equal(w.api.remoteSpawnAllowed(w.home, builder), false);
    const miner = w.unit('rHarvester'); w.step(); w.decide();
    assert.equal(w.api.remoteSpawnAllowed(w.home, builder), true);
    delete w.game.creeps[miner.name]; w.step(); w.decide();
    assert.equal(w.api.remoteSpawnAllowed(w.home, builder), false);
});
