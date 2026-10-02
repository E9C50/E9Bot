interface Memory {
    shardMissions?: Record<string, import('../shard/missions').ShardMission>
    shardArrivals?: Record<string, import('../shard/missions').ShardArrivalRecord>
    shardPortalIntel?: import('../shard/portalTypes').PortalDiscoveryMemory
}
