const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function store(resources = {}, capacity = 300000) {
    const values = { ...resources };
    Object.defineProperties(values, {
        getUsedCapacity: { value: resource => resource ? values[resource] || 0 :
            Object.values(values).reduce((total, amount) => total + amount, 0) },
        getFreeCapacity: { value: () => Math.max(0, capacity - values.getUsedCapacity()) },
        getCapacity: { value: () => capacity }
    });
    return values;
}

function world({ terminal = {}, storage = { energy: 200000 }, goals = {}, carried = {},
    terminalCapacity = 300000, storageCapacity = 1000000, link, factory = () => false,
    incoming = 0, terminalDebits = {}, sources, energyCapacity = 12300, creepCapacity = 2450, ticksToLive = 1400 } = {}) {
    const calls = [], factoryCalls = [];
    const room = { name: 'W1N1', memory: { terminalAmount: { ...goals } }, energyCapacityAvailable: energyCapacity,
        ...(sources === undefined ? {} : { sources }),
        storage: { id: 'storage', store: store(storage, storageCapacity) },
        terminal: { id: 'terminal', store: store(terminal, terminalCapacity) },
        ...(link === undefined ? {} : { centerLink: { id: 'link', store: store({ energy: link }, 800) } }) };
    const creep = { name: 'manager', room, memory: {}, ticksToLive, store: store(carried, creepCapacity),
        withdraw: (source, resource, amount) => { calls.push({ action: 'withdraw', id: source.id, resource, amount }); return 0; },
        transfer: (target, resource, amount) => { calls.push({ action: 'transfer', id: target.id, resource, amount }); return 0; } };
    const behavior = createSourceLoader({ globals: { RESOURCE_ENERGY: 'energy', OK: 0 }, modules: {
        utils: { getDistance: () => 1 },
        'settings/resourcePolicy': { resourcePolicy: { terminalEnergyReserve: 50000 } },
        'room/factory': { runFactoryLogistics: (unit, stationary) => {
            factoryCalls.push(stationary); return factory(unit);
        } },
        'room/evacuation': { getEvacuationIncomingCapacity: () => room.terminal.store.getFreeCapacity() - incoming,
            reserveEvacuationIncoming: (_room, amount) => { incoming += amount; } },
        'room/resourceNetwork': {
            getTerminalResourceAmount: (_room, resource) => Math.max(0,
                (room.terminal.store[resource] || 0) - (terminalDebits[resource] || 0)),
            recordTerminalWithdrawal: (_room, resource, amount) => {
                terminalDebits[resource] = (terminalDebits[resource] || 0) + amount;
            }
        }
    } }).load('role/adv/RoleAdvManager').default({});
    return { behavior, creep, room, calls, factoryCalls, run: () => behavior.target(creep) };
}

test('manager repairs a missing or obsolete terminal energy target before mineral preparation', () => {
    const w = world({ terminal: { energy: 49000 }, goals: { energy: 1000, XUH2O: 20000 },
        storage: { energy: 200000, XUH2O: 20000 } });
    w.run();
    assert.equal(w.room.memory.terminalAmount.energy, 50000);
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'storage', resource: 'energy', amount: 1000 }]);
});

test('terminal transfer fees raise the refill target above its permanent 50000 energy reserve', () => {
    const w = world({ terminal: { energy: 50000 }, goals: { energy: 57000 } });
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'storage', resource: 'energy', amount: 2450 }]);
});

test('manager uses center link energy first but withdraws only the terminal energy deficit', () => {
    const w = world({ terminal: { energy: 49999 }, link: 776 });
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'link', resource: 'energy', amount: 1 }]);
});

test('a full terminal first frees surplus mineral capacity so its energy reserve can be restored', () => {
    const w = world({ terminal: { energy: 49000, H: 251000 }, goals: { H: 20000 } });
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'terminal', resource: 'H', amount: 2450 }]);
});

test('surplus cleanup never withdraws more than storage can receive or the 50000 energy reserve', () => {
    const w = world({ terminal: { energy: 50000, H: 1000 }, storage: { energy: 999900 } });
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'terminal', resource: 'H', amount: 100 }]);
});

test('same-tick terminal transaction fees are deducted before manager can clear surplus energy', () => {
    const w = world({ terminal: { energy: 60000 }, terminalDebits: { energy: 10000 } });
    w.run();
    assert.deepEqual(w.calls, [], 'the remaining effective 50000 energy must never be withdrawn');
});

test('terminal cargo already dispatched in this tick is not mistaken for a surplus to withdraw', () => {
    const w = world({ terminal: { energy: 60000, wire: 10000 }, goals: { wire: 3000 },
        terminalDebits: { energy: 10000, wire: 10000 }, storage: { energy: 200000, wire: 5000 } });
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'storage', resource: 'wire', amount: 2450 }]);
});

test('successful terminal cleanup records its withdrawal so other logistics cannot claim the same surplus', () => {
    const w = world({ terminal: { energy: 50000, H: 1000 } });
    w.run();
    w.calls.length = 0;
    w.run();
    assert.deepEqual(w.calls, []);
});

test('scheduled terminal cargo is picked up in the exact missing amount', () => {
    const w = world({ terminal: { energy: 50000, H: 19950 }, goals: { H: 20000 },
        storage: { energy: 200000, H: 50000 } });
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'storage', resource: 'H', amount: 50 }]);
});

test('scheduled cargo also respects terminal shared capacity and available source stock', () => {
    const w = world({ terminal: { energy: 50000, H: 249900 }, goals: { H: 250000 },
        storage: { energy: 200000, H: 20 } });
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'storage', resource: 'H', amount: 20 }]);
});

test('held minerals transfer only the remaining target gap instead of overshooting and shuttling back', () => {
    const w = world({ terminal: { energy: 50000, H: 19990 }, goals: { H: 20000 }, carried: { H: 2450 } });
    w.run();
    assert.deepEqual(w.calls, [{ action: 'transfer', id: 'terminal', resource: 'H', amount: 10 }]);
});

test('held energy respects both target deficit and remaining terminal capacity', () => {
    const w = world({ terminal: { energy: 49000, H: 250900 }, carried: { energy: 2450 } });
    w.run();
    assert.deepEqual(w.calls, [{ action: 'transfer', id: 'terminal', resource: 'energy', amount: 100 }]);
});

test('manager terminal deliveries share capacity with resources received from other rooms in the same tick', () => {
    const w = world({ terminal: { energy: 49000, H: 250000 }, carried: { energy: 2450 }, incoming: 900 });
    w.run();
    assert.deepEqual(w.calls, [{ action: 'transfer', id: 'terminal', resource: 'energy', amount: 100 }]);
    w.calls.length = 0;
    w.run();
    assert.deepEqual(w.calls, [{ action: 'transfer', id: 'storage', resource: 'energy', amount: 2450 }]);
});

test('small link arrivals do not starve terminal loading, while near-full link batches keep mining flowing', () => {
    const w = world({ terminal: { energy: 50000 }, goals: { H: 20000 },
        storage: { energy: 200000, H: 20000 }, link: 100 });
    w.run();
    assert.equal(w.calls[0].resource, 'H');
    w.calls.length = 0;
    w.room.centerLink.store.energy = 776;
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'link', resource: 'energy', amount: 776 }]);
});

test('manager finishes pending factory cargo before ordinary storage delivery and stays stationary', () => {
    const w = world({ terminal: { energy: 50000 }, carried: { H: 100 }, factory: () => true });
    w.creep.memory.factoryLogistics = { resourceType: 'H' };
    w.run();
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.factoryCalls, [true]);
});

test('idle manager accepts adjacent factory work after terminal needs are satisfied', () => {
    const w = world({ terminal: { energy: 50000 }, factory: () => true });
    w.run();
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.factoryCalls, [true]);
});

test('idle manager coalesces small link arrivals while checking every tick', () => {
    const w = world({ terminal: { energy: 50000 }, link: 100, sources: [{ energy: 2000 }] });
    for (const energy of [100, 200, 300, 400, 500]) {
        w.room.centerLink.store.energy = energy;
        w.run();
    }
    assert.deepEqual(w.calls, [], 'five small arrivals need no successful native carry intents');
    w.room.centerLink.store.energy = 600;
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'link', resource: 'energy', amount: 600 }]);
    w.calls.length = 0;
    w.creep.store.energy = 600;
    w.room.centerLink.store.energy = 0;
    w.run();
    assert.deepEqual(w.calls, [{ action: 'transfer', id: 'storage', resource: 'energy', amount: 600 }]);
});

test('low local reserves release small idle link batches immediately', () => {
    for (const [energyCapacity, energy] of [[300, 9999], [12300, 12000]]) {
        const w = world({ terminal: { energy: 50000 }, link: 100, sources: [{ energy: 2000 }],
            storage: { energy }, energyCapacity });
        w.run();
        assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'link', resource: 'energy', amount: 100 }]);
    }
});

test('depleted sources and expiring managers flush partial final link batches', () => {
    for (const option of [{ sources: [{ energy: 0 }, { energy: 0 }] }, { ticksToLive: 2 }]) {
        const w = world({ terminal: { energy: 50000 }, link: 100, ...option });
        w.run();
        assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'link', resource: 'energy', amount: 100 }]);
    }
});

test('small manager bodies drain when an arrival fills their own capacity', () => {
    const w = world({ terminal: { energy: 50000 }, link: 100, creepCapacity: 100,
        sources: [{ energy: 2000 }] });
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'link', resource: 'energy', amount: 100 }]);
});

test('small link arrivals cannot delay exact terminal or factory logistics', () => {
    const energy = world({ terminal: { energy: 49999 }, link: 100, sources: [{ energy: 2000 }] });
    energy.run();
    assert.deepEqual(energy.calls, [{ action: 'withdraw', id: 'link', resource: 'energy', amount: 1 }]);
    const mineral = world({ terminal: { energy: 50000, XUH2O: 99 }, goals: { XUH2O: 100 }, link: 100,
        storage: { energy: 200000, XUH2O: 100 }, sources: [{ energy: 2000 }] });
    mineral.run();
    assert.deepEqual(mineral.calls, [{ action: 'withdraw', id: 'storage', resource: 'XUH2O', amount: 1 }]);
    const factory = world({ terminal: { energy: 50000 }, link: 100, sources: [{ energy: 2000 }], factory: () => true });
    factory.run();
    assert.deepEqual(factory.calls, []);
    assert.deepEqual(factory.factoryCalls, [true]);
});

test('twelve small arrivals deliver the same 1200 energy in four successful carry actions', () => {
    const w = world({ terminal: { energy: 50000 }, link: 0, sources: [{ energy: 2000 }] });
    const initial = w.room.storage.store.energy;
    let maximumLink = 0;
    function tick(arrival) {
        w.room.centerLink.store.energy += arrival;
        maximumLink = Math.max(maximumLink, w.room.centerLink.store.energy);
        const start = w.calls.length;
        w.run();
        // Native actions commit after role logic and cannot alter this tick's snapshots.
        for (const action of w.calls.slice(start)) {
            if (action.action === 'withdraw') {
                w.room.centerLink.store.energy -= action.amount;
                w.creep.store.energy = (w.creep.store.energy || 0) + action.amount;
            } else {
                w.creep.store.energy -= action.amount;
                w.room.storage.store.energy += action.amount;
            }
        }
    }
    for (let i = 0; i < 12; i++) tick(100);
    w.room.sources[0].energy = 0;
    tick(0);
    tick(0);
    assert.equal(w.room.storage.store.energy - initial, 1200);
    assert.equal(w.room.centerLink.store.energy, 0);
    assert.equal(w.creep.store.energy, 0);
    assert.equal(maximumLink, 600, '200 Link capacity remains for further arrivals');
    assert.equal(w.calls.filter(action => action.action === 'withdraw').length, 2);
    assert.equal(w.calls.filter(action => action.action === 'transfer').length, 2);
});
