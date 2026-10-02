import jsSHA from "jssha";
import { colorEnum } from "settings/settings";

/**
 * 把 obj2 的原型合并到 obj1 的原型上
 * 如果原型的键以 Getter 结尾，则将会把其挂载为 getter 属性
 * @param obj1 要挂载到的对象
 * @param obj2 要进行挂载的对象
 */
export const assignPrototype = function (obj1: { [key: string]: any }, obj2: { [key: string]: any }) {
    Object.getOwnPropertyNames(obj2.prototype).forEach(key => {
        if (key.includes('Getter')) {
            Object.defineProperty(obj1.prototype, key.split('Getter')[0], {
                get: obj2.prototype[key],
                enumerable: false,
                configurable: true
            })
        } else if (key.includes('Setter')) {
            Object.defineProperty(obj1.prototype, key.split('Setter')[0], {
                set: obj2.prototype[key],
                enumerable: false,
                configurable: true
            })
        } else obj1.prototype[key] = obj2.prototype[key]
    })
}

/**
 * 挂载到全局
 * @param obj
 */
export const assignGlobal = function (obj: { [key: string]: any }) {
    Object.getOwnPropertyNames(obj.prototype).forEach(key => {
        global[key] = obj.prototype[key]
    })
}

/**
 * 构建BodyPart
 * @param room
 * @param bodyConfigs
 * @param forceSpawn
 * @returns
 */
export const getBodyConfig = function (room: Room, bodyConfigs: BodySet[], forceSpawn: boolean = false): BodyPartConstant[] {
    const energy = forceSpawn ? room.energyAvailable : room.energyCapacityAvailable;

    var bodyConfig: BodyPartConstant[] = [];
    for (let i = bodyConfigs.length - 1; i >= 0; i--) {
        if (!bodyConfigs[i]) continue
        var needEnergy = 0;
        for (let config in bodyConfigs[i]) {
            needEnergy += BODYPART_COST[config] * bodyConfigs[i][config];
        }

        if (needEnergy <= energy) {
            for (let config in bodyConfigs[i]) {
                bodyConfig = bodyConfig.concat(
                    Array.from({ length: bodyConfigs[i][config] }, (k, v) => config as BodyPartConstant)
                );
            }
            break;
        }
    }

    return bodyConfig;
}

/**
 * 获取两个Position的距离（切比雪夫距离）
 * @param pos1
 * @param pos2
 * @returns
 */
export const getDistance = function (pos1: RoomPosition, pos2: RoomPosition): number {
    return Math.max(Math.abs(pos1.x - pos2.x), Math.abs(pos1.y - pos2.y))
}

/**
 * 获取两个Position的距离（直线距离）
 * @param pos1
 * @param pos2
 * @returns
 */
export const getLineDistance = function (pos1: RoomPosition, pos2: RoomPosition): number {
    const dx = pos1.x - pos2.x; // x 方向差值
    const dy = pos1.y - pos2.y; // y 方向差值
    return Math.sqrt(dx * dx + dy * dy); // 欧几里得距离
}

/**
 * 寻找最近的目标（切比雪夫距离）
 * @param source
 * @param targetList
 * @returns
 */
export const getClosestTarget = function <T extends Creep | Structure | ConstructionSite>(source: RoomPosition, targetList: T[]): T {
    let closest: T = targetList[0]
    let minRange: number = Infinity

    for (let index in targetList) {
        let targetRange = getDistance(source, targetList[index].pos)
        if (targetRange < minRange) {
            minRange = targetRange
            closest = targetList[index]
        }
    }

    return closest
}

/**
 * 寻找最近的目标（欧几里得距离）
 * @param source
 * @param targetList
 * @returns
 */
export const getClosestLineTarget = function <T extends Creep | Structure | ConstructionSite>(source: RoomPosition, targetList: T[]): T {
    let closest: T = targetList[0]
    let minRange: number = Infinity

    for (let index in targetList) {
        let targetRange = getLineDistance(source, targetList[index].pos)
        if (targetRange < minRange) {
            minRange = targetRange
            closest = targetList[index]
        }
    }

    return closest
}

/**
 * 以给定中心位置，获取指定位置相对该中心的相反位置
 * @param center
 * @param target
 * @returns
 */
export const getOppositePosition = function (center: RoomPosition, target: RoomPosition): RoomPosition {
    var oppositeX = Math.max(2 * center.x - target.x, 0)
    var oppositeY = Math.max(2 * center.y - target.y, 0)

    if (oppositeX < 0) oppositeX = 0
    if (oppositeY < 0) oppositeY = 0

    if (oppositeX > 49) oppositeX = 49
    if (oppositeY > 49) oppositeY = 49

    return new RoomPosition(oppositeX, oppositeY, center.roomName);
}

/**
* 获取指定方向的相反方向
*
* @param direction 目标方向
*/
export function getOppositeDirection(direction: DirectionConstant): DirectionConstant {
    return <DirectionConstant>((direction + 3) % 8 + 1)
}

/**
 * 对输入的字符串进行拼接并且进行SHA1
 * @param strings 输入的n个字符串
 * @returns
 */
export const sha1String = function (...strings: string[]): string {
    const concatenatedString = strings.join('_')
    const shaObj = new jsSHA("SHA-1", "TEXT", { encoding: "UTF8" })
    shaObj.update(concatenatedString)
    return shaObj.getHash("HEX").toUpperCase().substring(0, 10)
}

/**
 * 给指定文本添加颜色
 *
 * @param content 要添加颜色的文本
 * @param colorName 要添加的颜色常量字符串
 * @param bolder 是否加粗
 */
export function colorful(content: string, colorName: colorEnum, bolder: boolean = false): string {
    const colorStyle = colorName ? `color: ${colorName.valueOf};` : ''
    const bolderStyle = bolder ? 'font-weight: bolder;' : ''

    return `<text style="${[colorStyle, bolderStyle].join(' ')}">${content}</text>`
}

/**
 * 全局日志
 *
 * @param content 日志内容
 * @param prefixes 前缀中包含的内容
 * @param color 日志前缀颜色
 * @param notify 是否发送邮件
 */
export function log(content: string, prefixes: string[] = [], color: colorEnum = colorEnum.GREEN, notify: boolean = false): OK {
    // 有前缀就组装在一起
    let prefix = prefixes.length > 0 ? `【${prefixes.join(' ')}】 ` : ''
    // 指定了颜色
    prefix = colorful(prefix, color, true)

    const logContent = `${prefix}${content}`
    console.log(logContent)
    // 转发到邮箱
    if (notify) Game.notify(logContent)

    return OK
}

/**
 * 压缩 PathFinder 返回的路径数组
 * @param positions
 * @returns
 */
export function serializeMovePath(positions: RoomPosition[]): string {
    if (positions.length == 0) return ''
    return positions.map((pos, index) => {
        // 最后一个位置就不用再移动
        if (index >= positions.length - 1) return null
        // 由于房间边缘地块会有重叠，所以这里筛除掉重叠的步骤
        if (pos.roomName != positions[index + 1].roomName) return null
        // 获取到下个位置的方向
        return pos.getDirectionTo(positions[index + 1])
    }).join('')
}
