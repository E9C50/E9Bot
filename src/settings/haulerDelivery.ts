/** Mine imports finish at Storage; local distribution owns the consumption route. */
export const haulerDeliveryPolicy = {
    // Waypoints must already be adjacent, so carriers never search a detour to service them.
    fillAdjacentOnStorageRoute: true,
    minimumWaypointEnergy: 50,
    controllerRange: 3,
    deliveryRange: 1,
}
