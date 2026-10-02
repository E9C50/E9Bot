// 小队类型
type TeamTypeDuo = 'duo'
type TeamTypeQuad = 'quad'
type TeamTypeConstant = TeamTypeDuo | TeamTypeQuad

type TeamWork = { [role in TeamTypeConstant]: (data: TeamConfig) => ITeamConfig }


// 小队基本工作接口定义
interface ITeamConfig {
    prepare: () => boolean
    doWork: () => boolean
}

interface TeamConfig {
    taskId?: string
    targetRoom?: string
    teamFlag: string
    teamType: TeamTypeConstant
    creepNameList: string[]

    healTarget?: string
    attackTarget?: string
    dismantleTarget?: string
}
