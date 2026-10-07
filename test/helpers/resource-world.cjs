const { createSourceLoader } = require('./load-typescript.cjs');

function store(values = {}, capacity = 1000000) {
    const result = { ...values };
    Object.defineProperties(result, {
        getCapacity: { value: () => capacity },
        getUsedCapacity: { value: resource => resource ? result[resource] || 0 :
            Object.values(result).reduce((a, b) => a + b, 0) },
        getFreeCapacity: { value: () => Math.max(0, capacity - result.getUsedCapacity()) },
    });
    return result;
}

function world(time = 30, policyOverrides = {}) {
    const game = { time, shard: { name: 'shard3' }, rooms: {}, creeps: {},
        market: { calcTransactionCost: amount => Math.ceil(amount * 0.1) } };
    const incoming = new Map(), sends = [], logs = [];
    let incomingTick = time;
    function currentIncoming() {
        if (incomingTick !== game.time) { incomingTick = game.time; incoming.clear(); }
        return incoming;
    }
    const globals = { Game: game, Memory: { rooms: {} }, OK: 0, RESOURCE_ENERGY: 'energy',
        console: { log: line => logs.push(line) } };
    const modules = {
        'room/evacuation': {
            getEvacuationIncomingCapacity: room => Math.max(0,
                room.terminal.store.getFreeCapacity() - (currentIncoming().get(room.name) || 0)),
            reserveEvacuationIncoming: (room, amount) => {
                const values = currentIncoming(); values.set(room.name, (values.get(room.name) || 0) + amount);
            },
        },
    };
    function room(name, values = {}, { warehouse = false, terminal = { energy: 50000 }, terminalCapacity = 300000,
        storageCapacity = warehouse ? 8000000 : 1000000, cooldown = 1 } = {}) {
        const result = { name, my: true, level: 8, controller: { my: true, level: 8, isPowerEnabled: warehouse },
            storage: { id: `${name}:storage`, store: store({ energy: 350000, ...values }, storageCapacity) },
            terminal: { id: `${name}:terminal`, my: true, cooldown, store: store(terminal, terminalCapacity),
                send(resource, amount, target) { sends.push({ from: name, resource, amount, target }); return 0; } },
            labs: [], memory: { terminalAmount: {}, terminalSendJob: {}, boostNeed: {} } };
        game.rooms[name] = result;
        return result;
    }
    const result = { game, sends, logs, room,
        jobs: () => Object.values(game.rooms).flatMap(candidate => Object.entries(candidate.memory.terminalSendJob)
            .map(([id, job]) => ({ from: candidate.name, id, ...job }))) };
    function reload() {
        const loader = createSourceLoader({ globals, modules });
        const policy = loader.load('settings/resourcePolicy');
        Object.assign(policy.resourcePolicy, policyOverrides);
        Object.assign(result, { loader }, policy, loader.load('room/resourceNetwork'), loader.load('room/terminal'));
    }
    result.reload = reload;
    reload();
    return result;
}

module.exports = { store, world };
