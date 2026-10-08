/** Invader clearing belongs to remote mining; player expeditions remain explicit combat tasks. */
export const remoteDefensePolicy = {
    enabled: true,
    spawnPriority: 2.5,
    minimumEnergy: 500,
    maximumEnergy: 7500,
    // Extra healing preference; threat-required HEAL may exceed this.
    maximumHealParts: 3,
    intelLifetime: 1500,
    retreatHealthRatio: 0.4,
}
