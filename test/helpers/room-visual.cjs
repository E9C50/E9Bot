// Like the engine, all RoomVisual instances with the same roomName share one tick buffer.
function createVisualRuntime() {
    const buffers = new Map(), calls = { constructors: 0, primitives: 0, imports: 0 };
    class RoomVisual {
        constructor(roomName) { this.roomName = roomName; calls.constructors++; }
        export() { return JSON.stringify(buffers.get(this.roomName) || []); }
        import(data) {
            calls.imports++;
            const buffer = buffers.get(this.roomName) || [];
            buffer.push(...JSON.parse(data)); buffers.set(this.roomName, buffer);
            return this;
        }
        clear() { buffers.delete(this.roomName); return this; }
        getSize() { return Buffer.byteLength(this.export()); }
    }
    for (const method of ['circle', 'rect', 'poly', 'line', 'text']) {
        RoomVisual.prototype[method] = function (...args) {
            calls.primitives++;
            const buffer = buffers.get(this.roomName) || [];
            buffer.push({ method, args }); buffers.set(this.roomName, buffer);
            return this;
        };
    }
    return { RoomVisual, calls, nextTick: () => buffers.clear(),
        commands: roomName => JSON.parse(JSON.stringify(buffers.get(roomName) || [])) };
}

module.exports = { createVisualRuntime };
