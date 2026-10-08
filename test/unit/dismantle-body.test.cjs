const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const native = require('../helpers/native-bodies.cjs');

function world(capacity = 5600, available = 0) {
    const room = { name: 'W1N1', memory: {}, energyCapacityAvailable: capacity, energyAvailable: available };
    const loader = createSourceLoader({ globals: { ...native.globals,
        BODYPART_COST: { work: 100, move: 50, tough: 10, heal: 250 },
        BOOSTS: { move: { ZO: { fatigue: 2 }, ZHO2: { fatigue: 3 }, XZHO2: { fatigue: 4 } },
            work: { ZH: { dismantle: 2 }, ZH2O: { dismantle: 3 }, XZH2O: { dismantle: 4 } } },
    }, modules: { ...native.modules, 'settings/boost': {
        boostTypeEnum: { BoostTypeMove: 'boostMove', BoostTypeDismantle: 'boostDismantle', BoostTypeTough: 'boostTough', BoostTypeHeal: 'boostHeal' },
        boostBodyPart: { boostMove: 'move', boostDismantle: 'work', boostTough: 'tough', boostHeal: 'heal' },
        boostConfig: { boostMove: ['ZO', 'ZHO2', 'XZHO2'], boostDismantle: ['ZH', 'ZH2O', 'XZH2O'] },
    }, 'creep/boosting': { canPrepareBoosts() { throw Error('Body preview must not reserve or check stock'); } } } });
    return options => loader.load('creep/dismantleBody').planDismantleBody(room, options);
}

test('default full yellow body uses capacity even when spawn energy is empty', () => {
    const plan = world()();
    assert.equal(plan.cost, 4500); assert.equal(plan.body.length, 50);
    assert.equal(plan.body.filter(part => part === 'work').length, 40);
    assert.equal(plan.body.filter(part => part === 'move').length, 10);
    assert.deepEqual(JSON.parse(JSON.stringify(plan.boostPlan.steps)), [
        { type: 'boostMove', resource: 'XZHO2', parts: 10 },
        { type: 'boostDismantle', resource: 'XZH2O', parts: 40 },
    ]);
});

test('unboosted and explicitly sized yellow bodies have actual native costs and full plain movement', () => {
    const plan = world(5600, 50)({ boostTier: 0, workParts: 10 });
    assert.equal(plan.cost, 1500); assert.equal(plan.body.length, 20);
    assert.equal(plan.body.filter(part => part === 'move').length, 10);
    assert.deepEqual(JSON.parse(JSON.stringify(plan.boostPlan)), { tier: 0, steps: [] });
    const largest = world(800)({ boostTier: 0 });
    assert.equal(largest.cost, 750); assert.equal(largest.body.filter(part => part === 'work').length, 5);
});

test('lower capacity and intermediate tiers size movement and exact boost parts without changing requested tier', () => {
    for (const tier of [1, 2, 3]) {
        const plan = world(800)({ boostTier: tier });
        assert.ok(plan.cost <= 800 && plan.cost > 0); assert.equal(plan.boostPlan.tier, tier);
        assert.ok(plan.body.length <= 50);
        const work = plan.body.filter(part => part === 'work').length;
        const move = plan.body.filter(part => part === 'move').length;
        assert.equal(move, Math.ceil(work / (tier + 1)));
        assert.equal(plan.boostPlan.steps.find(step => step.type === 'boostDismantle').parts, work);
    }
});

test('invalid or impossible exact bodies return an error rather than a smaller replacement', () => {
    for (const options of [{ boostTier: 4 }, { boostTier: '3' }, { workParts: 0 }, { workParts: 2.5 },
        { workParts: 51 }, { workParts: 40, boostTier: 0 }, { workParts: 50, boostTier: 3 }]) {
        const plan = world()(options); assert.ok(plan.error); assert.equal(plan.body.length, 0);
    }
    assert.ok(world(800)({ workParts: 10, boostTier: 0 }).error);
});
