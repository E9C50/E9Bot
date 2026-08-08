import { reactionSource } from "settings/labs";

export default class ConsoleExtension {
    public help(): string {
        return 'Hello World'
    }

    /**
     * 显示房间信息
     */
    public info(): string {
        const resourceTypes = [
            RESOURCE_ENERGY, RESOURCE_OPS, RESOURCE_POWER, RESOURCE_GHODIUM,
            RESOURCE_CATALYZED_GHODIUM_ACID, RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
            RESOURCE_CATALYZED_LEMERGIUM_ACID, RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
            RESOURCE_CATALYZED_KEANIUM_ACID, RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
            RESOURCE_CATALYZED_UTRIUM_ACID, RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
            RESOURCE_CATALYZED_ZYNTHIUM_ACID, RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,

            RESOURCE_CATALYST,
            RESOURCE_OXYGEN, RESOURCE_HYDROGEN, RESOURCE_UTRIUM,
            RESOURCE_LEMERGIUM, RESOURCE_KEANIUM, RESOURCE_ZYNTHIUM
        ];

        let html = '<html><style>tr,th,td{text-align:center} table{width:120%}</style>';
        html += '<body><table border="1"><thead><tr><th>房间名称</th><th>控制器倒计时</th><th>核弹就绪</th><th>核弹CD</th><th>核弹剩余时间</th><th>Lab配方</th><th>Lab工作状态</th><th>容器占用</th><th>终端占用</th><th>最薄墙壁厚度</th>';

        resourceTypes.forEach(resourceType => {
            html += `<th>${resourceType}</th>`;
        });

        html += '</tr></thead><tbody>';

        Object.values(Game.rooms).sort((a, b) => a.name == Memory.centerStorage ? -1 : 1).forEach(room => {
            if (!room.my) return;

            const storageCapacity = room.storage?.store.getCapacity() || 0
            const storageUsedCapacity = room.storage?.store.getUsedCapacity() || 0
            const storagePercent = ((storageUsedCapacity / storageCapacity) * 100).toFixed(2)

            const terminalCapacity = room.terminal?.store.getCapacity() || 0
            const terminalUsedCapacity = room.terminal?.store.getUsedCapacity() || 0
            const terminalPercent = ((terminalUsedCapacity / terminalCapacity) * 100).toFixed(2)

            const nukerCooldown = room.nuker?.cooldown || 0;
            const nukerLeftTime = ((room.nuker?.cooldown || 0) * 2.5 / 60 / 60).toFixed(2);
            let nukerReady = room.nuker?.cooldown == 0 ? '✅' : '❌';
            if (room.nuker != undefined && (room.nuker.store[RESOURCE_ENERGY] < 300000 || room.nuker.store[RESOURCE_GHODIUM] < 5000)) nukerReady = '🔁';

            const controllerCountdown = room.controller?.ticksToDowngrade || 0;

            let labWorking = false;
            const labConfig = room.memory.roomLabConfig;
            const labReaction = labConfig.labReactionConfig;
            if (labReaction != undefined && labConfig.sourceLab1 != undefined && labConfig.sourceLab2 != undefined) {
                const lab1 = Game.getObjectById<StructureLab>(labConfig.sourceLab1);
                const lab2 = Game.getObjectById<StructureLab>(labConfig.sourceLab2);
                if (lab1 != undefined && lab2 != undefined && lab1.store[reactionSource[labReaction][0]] > 0 && lab2.store[reactionSource[labReaction][1]] > 0) {
                    labWorking = true;
                }
            }

            let minWall: number = Infinity
            room.walls.forEach(ram => minWall = ram.hits < minWall ? ram.hits : minWall)
            room.ramparts.forEach(ram => minWall = ram.hits < minWall ? ram.hits : minWall)

            // 设置 storagePercent 的颜色
            let storageColor = 'yellow'; // 默认黄色
            if (parseFloat(storagePercent) > 90) {
                storageColor = 'red';
            } else if (parseFloat(storagePercent) < 80) {
                storageColor = 'green';
            }

            // 设置 terminalPercent 的颜色
            let terminalColor = 'yellow'; // 默认黄色
            if (parseFloat(terminalPercent) > 90) {
                terminalColor = 'red';
            } else if (parseFloat(terminalPercent) < 80) {
                terminalColor = 'green';
            }

            html += `<tr><td>${room.name}</td><td>${controllerCountdown}</td><td>${nukerReady}</td><td>${nukerCooldown}</td><td>${nukerLeftTime} h</td>`
            html += `<td>${labReaction || '-'}</td><td>${labWorking ? '✅' : '❌'}</td>`
            html += `<td style="color: ${storageColor};">${storagePercent} %</td><td style="color: ${terminalColor};">${terminalPercent} %</td><td>${(minWall / 1000000).toFixed(2)} M</td>`

            // 添加资源数量的单元格，并根据数量设置颜色
            resourceTypes.forEach(resourceType => {
                let color = 'yellow'; // 默认黄色
                const resourceAmount = room.getResource(resourceType, true, true, true, true) || 0;
                if (room.name == Memory.centerStorage) {
                    if (resourceAmount < 10000) {
                        color = 'red';
                    } else if (resourceAmount >= 100000) {
                        color = 'green';
                    }
                } else if (resourceType == RESOURCE_OPS || resourceType == RESOURCE_POWER) {
                    if (resourceAmount < 1000) {
                        color = 'red';
                    } else if (resourceAmount >= 2000) {
                        color = 'green';
                    }
                } else {
                    if (resourceAmount < 5000) {
                        color = 'red'; // 小于3000显示红色
                    } else if (resourceAmount >= 20000) {
                        color = 'green'; // 大于5000显示绿色
                    }
                }
                html += `<td style="color: ${color};">${resourceAmount}</td>`;
            });

            html += '</tr>';
        });

        html += '</tbody></table></body></html>';
        return html;
    }

    /**
     * 在两个点之间放置road工地
     * @param x1
     * @param y1
     * @param x2
     * @param y2
     * @param roomName
     * @returns
     */
    public buildRoad(x1: number, y1: number, x2: number, y2: number, roomName: string): string {
        const source: RoomPosition = new RoomPosition(x1, y1, roomName)
        const target: RoomPosition = new RoomPosition(x2, y2, roomName)
        let pathFind = PathFinder.search(source, target, { swampCost: 1 });

        const room = Game.rooms[roomName]
        if (room != undefined) {
            pathFind.path.forEach(pos => {
                room.createConstructionSite(pos, STRUCTURE_ROAD)
            });
            return pathFind.path.toString()
        } else {
            return '房间不可见'
        }
    }

    /**
     * 移除所有的工地
     * @param roomName
     */
    public removeConstructionSites(roomName: string): string {
        const room = Game.rooms[roomName]
        if (room != undefined) {
            room.constructionSites.forEach(constructionSite => {
                if (constructionSite.progress == 0) {
                    constructionSite.remove()
                }
            })
            return '已移除所有建筑工地'
        } else {
            return '房间不可见'
        }
    }

    /**
     * 移除所有的Wall
     * @param roomName
     */
    public removeWalls(roomName: string): string {
        const room = Game.rooms[roomName]
        if (room != undefined) {
            room.walls.forEach(wall => { wall.destroy() })
            return '已移除所有Wall'
        } else {
            return '房间不可见'
        }
    }

    /**
     * 重置合成配置
     */
    public resetReactionConfig(): boolean {
        Object.values(Game.rooms).forEach(room => {
            if (!room.my) return
            room.memory.roomLabConfig.labReactionConfig = undefined
            room.memory.roomFillJob.labInMineral = []
        })
        return true
    }

    /**
     * 清除终端发送任务
     */
    public clearSendJobs(): boolean {
        Object.values(Game.rooms).forEach(room => {
            if (!room.my) return
            room.memory.terminalSendJob = {}
        })
        return true
    }

    /**
     * 将指定资源资源全部发往中央仓库
     */
    public collectTypeResource(resourceType: ResourceConstant): boolean {
        Object.values(Game.rooms).forEach(room => {
            if (!room.my) return
            const resourceAmount = room.getResource(resourceType, true, true)
            if (resourceAmount > 0) {
                room.sendResource(Memory.centerStorage, resourceType, resourceAmount)
            }
        })
        return true
    }

    /**
     * 将指定资源资源全部收集发到指定房间
     */
    public collectResourceSend(resourceType: ResourceConstant, roomName: string): boolean {
        Object.values(Game.rooms).forEach(room => {
            if (!room.my) return

            room.labs.forEach(lab => {
                if (lab.id != room.memory.roomLabConfig.sourceLab1 && lab.id != room.memory.roomLabConfig.sourceLab2
                    && room.memory.roomFillJob.labOut != undefined && !room.memory.roomFillJob.labOut.includes(lab.id)) {
                    room.memory.roomFillJob.labOut.push(lab.id)
                }
            })

            if (room.name != roomName) {
                const resourceAmount = room.getResource(resourceType, true, true, true, true)
                if (resourceAmount > 0) {
                    room.sendResource(roomName, resourceType, resourceAmount)
                    console.log(room.name, roomName, resourceAmount)
                }
            }
        })
        return true
    }

    /**
     * 将房间资源全部发往中央仓库
     */
    public collectRoomResource(roomName: string): boolean {
        const room = Game.rooms[roomName]
        if (!room.my) return true

        if (room.terminal != undefined) {
            Object.keys(room.terminal.store).forEach(resourceType => {
                if (resourceType != RESOURCE_ENERGY) {
                    room.sendResource(Memory.centerStorage, resourceType as ResourceConstant, room.terminal?.store[resourceType])
                }
            })
        }

        if (room.storage != undefined) {
            Object.keys(room.storage.store).forEach(resourceType => {
                if (resourceType != RESOURCE_ENERGY) {
                    room.sendResource(Memory.centerStorage, resourceType as ResourceConstant, room.storage?.store[resourceType])
                }
            })
        }

        return true
    }
}
