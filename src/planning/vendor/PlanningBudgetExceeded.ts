/** Recoverable planner stop, distinct from a broken blueprint or unexpected algorithm failure. */
export class PlanningBudgetExceeded extends Error {
    public constructor(public readonly maximumCpu: number) {
        super(`63 planner exceeded its ${maximumCpu} CPU budget`)
        this.name = 'PlanningBudgetExceeded'
    }
}
