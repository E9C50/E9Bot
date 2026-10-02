/** RoomVisual equivalents of the game's silhouettes, sized to one blueprint tile. */
const palette = {
    shell: '#181A1D', edge: '#8F969F', light: '#C4CBD3', inset: '#34383E',
    energy: '#FFE56D', cyan: '#68D6D9', green: '#49B96B',
    power: '#C84958', container: '#AF986F', white: '#EDF2F6',
}

export function drawStructureIcon(visual: RoomVisual, type: BuildableStructureConstant,
    x: number, y: number, opacity: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(opacity) || opacity <= 0) return
    const alpha = Math.min(1, opacity)
    const style = (fill: string, stroke: string = palette.edge, strokeWidth = 0.04): PolyStyle =>
        ({ fill, stroke, strokeWidth, opacity: alpha })
    const circle = (dx: number, dy: number, radius: number, fill: string,
        stroke: string = palette.edge, strokeWidth = 0.04): void => {
        visual.circle(x + dx, y + dy, { ...style(fill, stroke, strokeWidth), radius })
    }
    const rect = (dx: number, dy: number, width: number, height: number, fill: string,
        stroke: string = palette.edge, strokeWidth = 0.04): void => {
        visual.rect(x + dx, y + dy, width, height, style(fill, stroke, strokeWidth))
    }
    const poly = (points: [number, number][], fill: string,
        stroke: string = palette.edge, strokeWidth = 0.04): void => {
        const translated: [number, number][] = points.map(([dx, dy]) => [x + dx, y + dy])
        translated.push([...translated[0]])
        visual.poly(translated, style(fill, stroke, strokeWidth))
    }
    const line = (x1: number, y1: number, x2: number, y2: number,
        color: string = palette.edge, width = 0.035): void => {
        visual.line(x + x1, y + y1, x + x2, y + y2, { color, width, opacity: alpha })
    }

    switch (type) {
        case 'spawn':
            circle(0, 0, 0.43, palette.shell, palette.light, 0.055)
            circle(0, 0, 0.30, palette.energy, palette.inset, 0.035)
            circle(0, 0, 0.12, palette.shell, palette.shell, 0.015)
            return
        case 'extension':
            circle(0, 0, 0.33, palette.shell, palette.edge, 0.045)
            circle(0, 0, 0.23, palette.energy, palette.inset, 0.02)
            return
        case 'road':
            // Connections are drawn by the room preview, below its structure icons.
            circle(0, 0, 0.10, palette.container, palette.shell, 0.025)
            return
        case 'constructedWall':
            poly([[-0.34, -0.22], [-0.17, -0.38], [0.15, -0.36], [0.36, -0.14],
                [0.33, 0.23], [0.13, 0.37], [-0.20, 0.33], [-0.37, 0.12]], palette.inset, palette.edge, 0.055)
            line(-0.29, -0.08, 0.08, 0.05, palette.shell, 0.045)
            line(0.08, 0.05, 0.20, 0.29, palette.shell, 0.045)
            line(0.08, 0.05, 0.25, -0.24, palette.shell, 0.045)
            return
        case 'rampart':
            poly([[-0.34, -0.41], [0.34, -0.41], [0.41, -0.34], [0.41, 0.34],
                [0.34, 0.41], [-0.34, 0.41], [-0.41, 0.34], [-0.41, -0.34]], 'transparent', palette.green)
            rect(-0.28, -0.28, 0.56, 0.56, 'transparent', palette.green, 0.025)
            return
        case 'link':
            poly([[0, -0.42], [0.36, 0], [0, 0.42], [-0.36, 0]], palette.shell, palette.light, 0.045)
            poly([[0, -0.27], [0.22, 0], [0, 0.27], [-0.22, 0]], palette.energy, palette.inset, 0.025)
            return
        case 'storage':
            poly([[-0.26, -0.41], [0.26, -0.41], [0.34, -0.28], [0.34, 0.28],
                [0.26, 0.41], [-0.26, 0.41], [-0.34, 0.28], [-0.34, -0.28]], palette.shell, palette.light, 0.045)
            rect(-0.22, -0.29, 0.44, 0.58, palette.energy, palette.inset, 0.025)
            line(-0.20, -0.10, 0.20, -0.10, palette.inset, 0.025)
            line(-0.20, 0.10, 0.20, 0.10, palette.inset, 0.025)
            return
        case 'tower':
            circle(0, 0.10, 0.32, palette.shell, palette.edge, 0.045)
            rect(-0.20, -0.28, 0.40, 0.51, palette.inset, palette.light, 0.035)
            rect(-0.14, 0.08, 0.28, 0.13, palette.energy, palette.inset, 0.02)
            rect(-0.075, -0.43, 0.15, 0.33, palette.light, palette.shell, 0.025)
            return
        case 'observer':
            circle(0, 0, 0.39, palette.shell, palette.edge, 0.045)
            circle(0.09, -0.08, 0.21, palette.light, palette.inset, 0.035)
            circle(0.12, -0.10, 0.11, palette.shell, palette.white, 0.025)
            return
        case 'powerSpawn':
            circle(0, 0, 0.43, palette.shell, palette.power, 0.06)
            circle(0, 0, 0.29, palette.inset, palette.edge, 0.04)
            circle(0, 0, 0.17, palette.energy, palette.shell, 0.035)
            return
        case 'extractor':
            circle(0, 0, 0.36, 'transparent', palette.light, 0.055)
            circle(0, 0, 0.21, 'transparent', palette.edge, 0.025)
            for (let index = 0; index < 3; index++) {
                const angle = index * Math.PI * 2 / 3 - Math.PI / 2
                line(Math.cos(angle) * 0.25, Math.sin(angle) * 0.25,
                    Math.cos(angle) * 0.43, Math.sin(angle) * 0.43, palette.light, 0.07)
            }
            return
        case 'lab':
            circle(0, 0.07, 0.31, palette.shell, palette.light, 0.045)
            circle(0, 0.07, 0.21, palette.white, palette.inset, 0.025)
            rect(-0.105, -0.40, 0.21, 0.22, palette.white, palette.edge, 0.035)
            rect(-0.16, 0.27, 0.32, 0.10, palette.energy, palette.shell, 0.02)
            return
        case 'terminal':
            poly([[-0.23, -0.41], [0.23, -0.41], [0.41, -0.23], [0.41, 0.23],
                [0.23, 0.41], [-0.23, 0.41], [-0.41, 0.23], [-0.41, -0.23]], palette.shell, palette.light, 0.045)
            poly([[-0.15, -0.27], [0.15, -0.27], [0.27, -0.15], [0.27, 0.15],
                [0.15, 0.27], [-0.15, 0.27], [-0.27, 0.15], [-0.27, -0.15]], palette.cyan, palette.inset, 0.025)
            line(-0.18, 0, 0.18, 0, palette.inset, 0.03)
            return
        case 'container':
            rect(-0.30, -0.32, 0.60, 0.64, palette.shell, palette.container, 0.05)
            rect(-0.20, -0.22, 0.40, 0.44, palette.energy, palette.inset, 0.02)
            line(-0.19, -0.06, 0.19, -0.06, palette.inset, 0.04)
            line(-0.19, 0.08, 0.19, 0.08, palette.inset, 0.04)
            return
        case 'nuker':
            poly([[-0.31, 0.38], [-0.17, 0.10], [-0.17, -0.14], [0, -0.43],
                [0.17, -0.14], [0.17, 0.10], [0.31, 0.38], [0.10, 0.29], [-0.10, 0.29]], palette.light, palette.shell, 0.045)
            rect(-0.09, -0.03, 0.18, 0.23, palette.energy, palette.inset, 0.025)
            return
        case 'factory': {
            const gear: [number, number][] = []
            for (let index = 0; index < 32; index++) {
                const radius = index % 4 < 2 ? 0.42 : 0.35
                const angle = index * Math.PI / 16
                gear.push([Math.cos(angle) * radius, Math.sin(angle) * radius])
            }
            poly(gear, palette.edge, palette.shell, 0.035)
            circle(0, 0, 0.27, palette.inset, palette.light, 0.025)
            poly([[0, -0.17], [0.15, -0.085], [0.15, 0.085], [0, 0.17],
                [-0.15, 0.085], [-0.15, -0.085]], palette.energy, palette.shell, 0.025)
            line(0, 0, 0, 0.16, palette.inset, 0.025)
            line(0, 0, -0.14, -0.08, palette.inset, 0.025)
            line(0, 0, 0.14, -0.08, palette.inset, 0.025)
            return
        }
    }
}
