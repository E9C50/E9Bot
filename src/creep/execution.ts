import { createRoleBehavior } from 'role'
import teams from 'squard'
import { warModeRole } from 'settings/creep'
import { runtimePolicy } from 'settings/runtime'
import { isCpuProfilingEnabled, recordCpuSample } from 'runtime/profiling'
import { isDevelopmentRemoteData } from './developmentRemotes'
import { retireDevelopmentCreep } from './developmentRetirement'
import { runCombatUnits } from 'combat/missions'
import { requestTowerSupport } from 'combat/defense'

function reportFailure(name: string, error: unknown): void {
    console.log(
        `[unit:${name}] ${
            error instanceof Error
                ? error.stack || error.message
                : String(error)
        }`
    )
}

/** 每个单位隔离失败，后续单位和建筑仍可执行。 */
export function creepWorkController(): void {
    const profile = runtimePolicy.profiling
    const profilingEnabled = isCpuProfilingEnabled()
    const profiling = profilingEnabled && profile.creepDetails
    const roleProfiling = profilingEnabled && profile.roleDetails
    const samples: [string, number][] | undefined = profiling ? [] : undefined
    const warModes = Memory.warMode || {}
    const empireAtWar = runtimePolicy.warModeScope === 'empire' && Object.values(warModes).some(Boolean)

    for (const name in Game.creeps) {
        const creep = Game.creeps[name]
        if (creep.spawning || creep.memory.isTeam || creep.memory.combatTaskId) continue
        const atWar =
            runtimePolicy.warModeScope === 'empire'
                ? empireAtWar
                : warModes[creep.room.name]
        const automaticRemote = isDevelopmentRemoteData(creep.memory.data)
        // Automatic remotes must reach prepare even during war so their safety wrapper can evacuate them.
        if (atWar && !warModeRole.includes(creep.memory.role) && !automaticRemote) continue
        const roleStarted = roleProfiling ? Game.cpu.getUsed() : 0
        try {
            if (!automaticRemote && retireDevelopmentCreep(creep)) continue
            // Some economy roles deliberately skip their legacy prepare boost hook.
            // Every newly spawned compound-dependent body completes its exact plan before leaving home.
            if (creep.memory.boostPlan?.steps.length && !creep.memory.boostPlan.completed && !creep.goBoost()) continue
            const behavior = createRoleBehavior(
                creep.memory.role,
                creep.memory.data
            )
            if (!behavior) continue
            let started = profiling ? Game.cpu.getUsed() : 0
            const prepared = behavior.prepare(creep)
            if (samples)
                samples.push([
                    creep.name + ' prepare',
                    Game.cpu.getUsed() - started,
                ])
            if (!prepared) continue
            if (creep.room.my && creep.hits < creep.hitsMax)
                requestTowerSupport(creep, { healFriendly: true })
            started = profiling ? Game.cpu.getUsed() : 0
            const phase = creep.memory.working ? 'target' : 'source'
            behavior[phase](creep)
            if (samples)
                samples.push([
                    creep.name + ' ' + phase,
                    Game.cpu.getUsed() - started,
                ])
        } catch (error) {
            reportFailure(creep.name, error)
        } finally {
            // 按固定角色名聚合，避免把每只 creep 名字写入统计目录。
            if (roleProfiling) {
                try { recordCpuSample('creep:' + creep.memory.role, Game.cpu.getUsed() - roleStarted) } catch (_) {}
            }
        }
    }
    if (samples) {
        for (const [name, cpu] of samples.sort((a, b) => b[1] - a[1])) {
            if (cpu > profile.creepWarningCpu) console.log(cpu, name)
        }
    }
}

export function teamWorkController(): void {
    runCombatUnits()
    for (const room of Object.values(Game.rooms)) {
        if (!room.my) continue
        for (const config of Object.values(room.memory.teamConfig || {})) {
            try {
                if (
                    !Object.prototype.hasOwnProperty.call(
                        teams,
                        config.teamType
                    )
                )
                    continue
                const behavior = teams[config.teamType](config)
                if (behavior.prepare()) behavior.doWork()
            } catch (error) {
                reportFailure(config.teamFlag, error)
            }
        }
    }
}
