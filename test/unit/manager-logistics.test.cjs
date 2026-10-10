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

test('idle managers skip capacity and storage-stock queries for already satisfied terminal goals', () => {
    const terminal = { energy: 50000 }, goals = { energy: 50000 }, storage = { energy: 200000 };
    for (let index = 0; index < 20; index++) {
        terminal[`mineral${index}`] = goals[`mineral${index}`] = 1000;
        storage[`mineral${index}`] = 10000;
    }
    const w = world({ terminal, storage, goals, link: 0 });
    let storageFreeReads = 0, terminalFreeReads = 0, storageStockReads = 0;
    for (const [stock, location] of [[w.room.storage, 'storage'], [w.room.terminal, 'terminal']]) {
        stock.store = new Proxy(stock.store, { get(target, key) {
            if (key === 'getFreeCapacity') {
                if (location === 'storage') storageFreeReads++;
                else terminalFreeReads++;
            } else if (location === 'storage' && typeof target[key] === 'number') storageStockReads++;
            return target[key];
        } });
    }
    for (let index = 0; index < 25; index++) w.run();
    assert.deepEqual(w.calls, []);
    assert.equal(storageFreeReads, 0, 'satisfied goals avoid all 550 storage capacity queries');
    assert.equal(terminalFreeReads, 0, 'satisfied demands avoid all 525 terminal capacity queries');
    assert.equal(storageStockReads, 0, 'satisfied demands never read source inventory');
    w.room.memory.terminalAmount.mineral0 = 2000;
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'storage', resource: 'mineral0', amount: 1000 }],
        'a new goal is serviced immediately, even within the same tick');
    assert.equal(storageFreeReads, 0, 'an input deficit alone does not need storage receiving capacity');
    assert.equal(terminalFreeReads, 1);
    assert.equal(storageStockReads, 1);
});

test('terminal cleanup rechecks storage capacity and intent debits on each same-tick work call', () => {
    const w = world({ terminal: { energy: 50000, H: 1000 }, goals: { H: 1000 },
        storage: { energy: 999900 } });
    let capacityReads = 0;
    w.room.storage.store = new Proxy(w.room.storage.store, { get(target, key) {
        if (key === 'getFreeCapacity') capacityReads++;
        return target[key];
    } });
    w.run();
    assert.deepEqual(w.calls, []);
    assert.equal(capacityReads, 0, 'without surplus there is no receiving-capacity check');
    w.room.memory.terminalAmount.H = 900;
    w.room.storage.store.energy = 1000000;
    w.run();
    assert.deepEqual(w.calls, [], 'a newly full Storage must not reuse earlier capacity');
    assert.equal(capacityReads, 1, 'even zero capacity is read only for a real surplus');
    w.room.storage.store.energy = 999950;
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'terminal', resource: 'H', amount: 50 }]);
    assert.equal(capacityReads, 2, 'the next work call immediately reads released receiving capacity');
    w.calls.length = 0;
    w.room.memory.terminalAmount.H = 950;
    w.room.storage.store.energy = 999900;
    w.run();
    assert.deepEqual(w.calls, [], 'accepted withdrawals are deducted even while native Terminal stock remains unchanged');
    assert.equal(capacityReads, 2, 'intent debits remove surplus before any capacity query');
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


test('Terminal refill preserves one complete birth in Storage even with a full Spawn pool', () => {
    for (const energy of [0, 2199, 2200]) {
        const w = world({ terminal: { energy: 8509 }, storage: { energy }, energyCapacity: 2200 });
        w.room.energyAvailable = 2200;
        w.run();
        assert.deepEqual(w.calls, [], 'neither the energy refill branch nor the generic resource loop may spend the birth reserve');
        assert.equal(w.room.memory.terminalAmount.energy, 50000);
    }
});

test('Terminal refill withdraws only Storage energy above the complete birth reserve', () => {
    const w = world({ terminal: { energy: 8509 }, storage: { energy: 2300 }, energyCapacity: 2200 });
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'storage', resource: 'energy', amount: 100 }]);
});

test('a depleted Storage receives Link energy before Terminal and preserves that destination across ticks', () => {
    const w = world({ terminal: { energy: 8509 }, storage: { energy: 2100 }, energyCapacity: 2200, link: 300 });
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'link', resource: 'energy', amount: 300 }]);
    w.calls.length = 0;
    w.room.centerLink.store.energy = 0;
    w.creep.store.energy = 300;
    w.run();
    assert.deepEqual(w.calls, [{ action: 'transfer', id: 'storage', resource: 'energy', amount: 300 }],
        'the next tick must not reroute the protected Link batch to the still-empty Terminal');
    w.calls.length = 0;
    w.creep.store.energy = 0;
    w.room.storage.store.energy = 2400;
    w.run();
    assert.deepEqual(w.calls, [{ action: 'withdraw', id: 'storage', resource: 'energy', amount: 200 }]);
    w.calls.length = 0;
    w.creep.store.energy = 200;
    w.room.storage.store.energy = 2200;
    w.run();
    assert.deepEqual(w.calls, [{ action: 'transfer', id: 'terminal', resource: 'energy', amount: 200 }],
        'once a full birth is held, subsequent surplus continues toward the unchanged Terminal target');
});

test('Terminal cargo already on the Manager can finish while Storage is below the birth reserve', () => {
    const w = world({ terminal: { energy: 8509 }, storage: { energy: 0 }, carried: { energy: 600 }, energyCapacity: 2200 });
    w.run();
    assert.deepEqual(w.calls, [{ action: 'transfer', id: 'terminal', resource: 'energy', amount: 600 }]);
});
