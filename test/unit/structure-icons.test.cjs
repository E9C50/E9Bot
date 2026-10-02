const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const types = ['spawn', 'extension', 'road', 'constructedWall', 'rampart', 'link', 'storage', 'tower',
    'observer', 'powerSpawn', 'extractor', 'lab', 'terminal', 'container', 'nuker', 'factory'];

function visual() {
    const calls = [];
    const result = { calls };
    for (const method of ['circle', 'rect', 'poly', 'line']) {
        result[method] = (...args) => { calls.push({ method, args }); return result; };
    }
    return result;
}

test('each buildable icon uses bounded finite native geometry and carries the requested opacity', () => {
    const { drawStructureIcon } = createSourceLoader().load('planning/structureIcons');
    for (const type of types) {
        const v = visual(), x = 25, y = 24, opacity = 0.65;
        drawStructureIcon(v, type, x, y, opacity);
        assert.ok(v.calls.length > 0 && v.calls.length <= 8, `${type} has a bounded primitive count`);
        const coordinate = (value, center) => {
            assert.ok(Number.isFinite(value));
            assert.ok(Math.abs(value - center) <= 0.5, `${type} stays within its tile`);
        };
        for (const { method, args } of v.calls) {
            const style = args.at(-1);
            assert.equal(style.opacity, opacity);
            if (method === 'poly') {
                assert.ok(args[0].length >= 4 && args[0].length <= 33);
                for (const [px, py] of args[0]) { coordinate(px, x); coordinate(py, y); }
            } else {
                coordinate(args[0], x); coordinate(args[1], y);
                if (method === 'circle') {
                    assert.ok(Number.isFinite(style.radius) && style.radius > 0);
                    coordinate(args[0] - style.radius, x); coordinate(args[0] + style.radius, x);
                    coordinate(args[1] - style.radius, y); coordinate(args[1] + style.radius, y);
                } else if (method === 'rect') {
                    assert.ok(args[2] > 0 && args[3] > 0);
                    coordinate(args[0] + args[2], x); coordinate(args[1] + args[3], y);
                } else { coordinate(args[2], x); coordinate(args[3], y); }
            }
            const width = style.width ?? style.strokeWidth;
            assert.ok(Number.isFinite(width) && width >= 0 && width <= 0.1);
        }
    }
});

test('unknown structures and invalid positions are ignored, and opacity is bounded', () => {
    const { drawStructureIcon } = createSourceLoader().load('planning/structureIcons');
    const v = visual();
    for (const [type, x, y, opacity] of [['unknown', 25, 25, 1], ['spawn', NaN, 25, 1],
        ['spawn', 25, Infinity, 1], ['spawn', 25, 25, NaN], ['spawn', 25, 25, 0], ['spawn', 25, 25, -1]]) {
        assert.doesNotThrow(() => drawStructureIcon(v, type, x, y, opacity));
    }
    assert.equal(v.calls.length, 0);
    drawStructureIcon(v, 'spawn', 25, 25, 2);
    assert.ok(v.calls.every(call => call.args.at(-1).opacity === 1));
});
