// @ts-nocheck
/**
 * 63bot manor planner, adapted from 63bot/default/manager_planner.js in this workspace.
 * Original: 超级抠位置自动布局；原作者提醒单次计算需要超过 100 CPU 的可运行余量。
 * The local source snapshot has no separate LICENSE file; upstream attribution is retained.
 *
 * Port changes: function-local state, typed local grid/heap/union-find helpers,
 * Object.keys instead of lodash, explicit options instead of flags/global.minPlaneCnt,
 * no visualization, and resource routes start at the selected integer storage center.
 * The block partitioning, lab model and building placement are upstream; optional resource-distance
 * scoring selects the base anchor before the single building-placement pass.
 */
import { RoomArray } from './RoomArray'
import { PriorityQueue, NewNode } from './PriorityQueue'
import { UnionFind } from './UnionFind'
import { PlanningBudgetExceeded } from './PlanningBudgetExceeded'
import { selectControllerContainer } from '../controllerContainer'
import { controllerLayoutPolicy } from 'settings/controllerLayout'
import { resourceAccessScores } from '../resourceDistances'

export function computeManor63(roomName, points, options) {
    const started = Game.cpu.getUsed()
    const maximumCpu = options.maximumCpu ?? Infinity
    const checkBudget = () => {
        if (Number.isFinite(maximumCpu) && Game.cpu.getUsed() - started >= maximumCpu) {
            throw new PlanningBudgetExceeded(maximumCpu)
        }
    }
    const preferredStorage = options.storagePosition
    const minPlaneCnt = options.minimumPlaneCount;
    let visited = new RoomArray(checkBudget);
    let roomWalkable = new RoomArray(checkBudget);
    let nearWall = new RoomArray(checkBudget);
    let routeDistance = new RoomArray(checkBudget);
    let roomObjectCache = new RoomArray(checkBudget);
    let nearWallWithInterpolation = new RoomArray(checkBudget);
    let interpolation = new RoomArray(checkBudget);
    let queMin = new PriorityQueue(true, checkBudget);
    let queMin2 = new PriorityQueue(true, checkBudget);
    let startPoint = new PriorityQueue(true, checkBudget);
    let unionFind = new UnionFind(50 * 50);
    let objects = [];
    let pro = {
        init() {
            visited = new RoomArray(checkBudget);
            roomWalkable = new RoomArray(checkBudget);
            nearWall = new RoomArray(checkBudget);
            routeDistance = new RoomArray(checkBudget);
            nearWallWithInterpolation = new RoomArray(checkBudget);
            interpolation = new RoomArray(checkBudget);
            roomObjectCache = new RoomArray(checkBudget);
            queMin = new PriorityQueue(true, checkBudget);
            queMin2 = new PriorityQueue(true, checkBudget);
            startPoint = new PriorityQueue(true, checkBudget);
            unionFind = new UnionFind(50 * 50);
            visited.init();
            nearWall.init();
            routeDistance.init();
            roomWalkable.init();
            nearWallWithInterpolation.init();
            interpolation.init();
            roomObjectCache.init();
            unionFind.init();
            queMin.clear();
            queMin2.clear();
            startPoint.clear();
        },
        dismiss() {
            visited = null;
            roomWalkable = null;
            nearWall = null;
            routeDistance = null;
            roomObjectCache = null;
            nearWallWithInterpolation = null;
            interpolation = null;
            queMin = null;
            queMin2 = null;
            startPoint = null;
            unionFind = null;
            objects = [];
        },
        getBlockPutAbleCnt(roomWalkable, visited, queMin, unionFind, tarRoot, putAbleCacheMap, AllCacheMap) {
            if (putAbleCacheMap[tarRoot])
                return [putAbleCacheMap[tarRoot], AllCacheMap[tarRoot]];
            let roomManor = routeDistance;
            roomManor.init();
            roomManor.forEach((x, y, val) => { if (tarRoot == unionFind.find(x * 50 + y)) {
                roomManor.set(x, y, 1);
            } });
            roomManor.forEach((x, y, val) => {
                if (val) {
                    let manorCnt = 0;
                    let wallCnt = 0;
                    roomManor.for4Direction((x1, y1, val1) => {
                        if (val1)
                            manorCnt += 1;
                        if (!roomWalkable.get(x1, y1))
                            wallCnt += 1;
                    }, x, y);
                    if (manorCnt == 1 && wallCnt == 0)
                        roomManor.set(x, y, 0);
                }
            });
            let dfsMoreManor = function (x, y, val) {
                if (!val && roomWalkable.get(x, y)) {
                    let manorCnt = 0;
                    let wallCnt = 0;
                    roomManor.for4Direction((x1, y1, val1) => {
                        if (val1)
                            manorCnt += 1;
                        if (!roomWalkable.get(x1, y1))
                            wallCnt += 1;
                    }, x, y);
                    if (manorCnt >= 2 || manorCnt == 1 && wallCnt >= 2) {
                        roomManor.set(x, y, 1);
                        roomManor.for4Direction((x1, y1, val1) => {
                            dfsMoreManor(x1, y1, val1);
                        }, x, y);
                    }
                }
            };
            roomManor.forEach((x, y, val) => { dfsMoreManor(x, y, val); });
            roomWalkable.forBorder((x, y, val) => {
                if (val) {
                    roomManor.forNear((x, y, val) => {
                        roomManor.set(x, y, 0);
                    }, x, y);
                    roomManor.set(x, y, 0);
                }
            });
            let innerPutAbleList = [];
            let AllCacheList = [];
            visited.init();
            roomWalkable.forEach((x, y, val) => {
                if (!roomManor.get(x, y)) {
                    queMin.push(NewNode(val ? -4 : -1, x, y));
                }
            });
            queMin.whileNoEmpty(nd => {
                let func = function (x, y, val) {
                    let item = NewNode(nd.k + 2, x, y);
                    if (!visited.exec(x, y, 1)) {
                        queMin.push(NewNode(nd.k + 1, x, y));
                        if (roomManor.get(x, y)) {
                            if (nd.k + 1 >= 0 && val) {
                                innerPutAbleList.push(item);
                            }
                            if (val)
                                AllCacheList.push(item);
                        }
                    }
                };
                visited.set(nd.x, nd.y, 1);
                if (nd.k >= -1)
                    roomWalkable.for4Direction(func, nd.x, nd.y);
                else
                    roomWalkable.forNear(func, nd.x, nd.y);
            });
            putAbleCacheMap[tarRoot] = innerPutAbleList;
            AllCacheMap[tarRoot] = AllCacheList;
            return [putAbleCacheMap[tarRoot], AllCacheMap[tarRoot]];
        },
        computeBlock(roomName, blocked) {
            roomWalkable.initRoomTerrainWalkAble(roomName);
            roomWalkable.forEach((x, y, val) => { if (!val) {
                queMin.push(NewNode(0, x, y));
                visited.set(x, y, 1);
            } });
            queMin.whileNoEmpty(nd => {
                roomWalkable.for4Direction((x, y, val) => {
                    if (!visited.exec(x, y, 1) && val) {
                        queMin.push(NewNode(nd.k + 1, x, y));
                    }
                }, nd.x, nd.y);
                nearWall.exec(nd.x, nd.y, nd.k);
            });
            roomWalkable.forBorder((x, y, val) => {
                if (val) {
                    roomWalkable.forNear((x, y, val) => {
                        if (val) {
                            nearWall.set(x, y, 50);
                            queMin.push(NewNode(0, x, y));
                        }
                    }, x, y);
                    queMin.push(NewNode(0, x, y));
                    nearWall.set(x, y, 50);
                }
            });
            let roomPutAble = routeDistance;
            roomPutAble.initRoomTerrainWalkAble(roomName);
            roomWalkable.forBorder((x, y, val) => {
                if (val) {
                    roomWalkable.forNear((x, y, val) => {
                        if (val) {
                            roomPutAble.set(x, y, 0);
                        }
                    }, x, y);
                    roomPutAble.set(x, y, 0);
                }
            });
            let getObjectPos = function (x, y, struct) {
                let put = false;
                let finalX = 0;
                let finalY = 0;
                roomPutAble.for4Direction((x, y, val) => {
                    if (val && !put && !roomObjectCache.get(x, y)) {
                        finalX = x;
                        finalY = y;
                        put = true;
                    }
                }, x, y);
                roomPutAble.forNear((x, y, val) => {
                    if (val && !put && !roomObjectCache.get(x, y)) {
                        finalX = x;
                        finalY = y;
                        put = true;
                    }
                }, x, y);
                roomObjectCache.set(finalX, finalY, struct);
                return [finalX, finalY];
            };
            for (let i = 0; i < objects.length; i++) {
                let pos = objects[i];
                let p = getObjectPos(pos.x, pos.y, "container");
                if (i === 0) roomObjectCache.controllerContainer = p;
                if (i != 1) {
                    let linkPos = getObjectPos(p[0], p[1], "link");
                    roomObjectCache.link = roomObjectCache.link || [];
                    roomObjectCache.link.push(linkPos);
                }
                else {
                    roomObjectCache.extractor = [[pos.x, pos.y]];
                }
                roomObjectCache.container = roomObjectCache.container || [];
                if (i != 1)
                    roomObjectCache.container.unshift(p);
                else
                    roomObjectCache.container.push(p);
            }
            nearWall.forEach((x, y, val) => {
                let value = -4 * val;
                nearWall.for4Direction((x, y, val) => {
                    value += val;
                }, x, y);
                interpolation.set(x, y, value);
                if (value > 0)
                    value = 0;
                if (val && roomWalkable.get(x, y))
                    nearWallWithInterpolation.set(x, y, val + value * 0.1);
            });
            if (blocked) {
                blocked.forEach((x, y, val) => {
                    if (val)
                        nearWallWithInterpolation.set(x, y, 0);
                });
            }
            visited.init();
            routeDistance.init();
            queMin.whileNoEmpty(nd => {
                roomWalkable.forNear((x, y, val) => {
                    if (!visited.exec(x, y, 1) && val) {
                        queMin.push(NewNode(nd.k + 1, x, y));
                    }
                }, nd.x, nd.y);
                routeDistance.set(nd.x, nd.y, nd.k);
            });
            routeDistance.forEach((x, y, val) => {
                if (!roomWalkable.get(x, y))
                    return;
                if (val)
                    startPoint.push(NewNode(-val, x, y));
            });
            let sizeMap = {};
            let posSeqMap = {};
            visited.init();
            for (let i = 0; i < 2500; i++) {
                if (startPoint.isEmpty())
                    break;
                let cnt = 0;
                let nd = startPoint.pop();
                let currentPos = nd.x * 50 + nd.y;
                if (blocked && blocked.get(nd.x, nd.y)) {
                    unionFind.union(currentPos, 0);
                    continue;
                }
                let posSeq = [];
                let dfsFindDown = function (roomArray, x, y) {
                    let currentValue = roomArray.get(x, y);
                    if (!visited.exec(x, y, 1)) {
                        roomArray.for4Direction((x1, y1, val) => {
                            if (val && (x1 == x || y1 == y) && val < currentValue) {
                                dfsFindDown(roomArray, x1, y1);
                            }
                        }, x, y);
                        let pos = x * 50 + y;
                        if (unionFind.find(pos) && unionFind.find(currentPos) && (!blocked || !blocked.get(x, y))) {
                            unionFind.union(currentPos, pos);
                            posSeq.push(pos);
                            cnt++;
                        }
                        else if (blocked)
                            unionFind.union(pos, 0);
                    }
                };
                let dfsFindUp = function (roomArray, x, y) {
                    let currentValue = roomArray.get(x, y);
                    if (!visited.exec(x, y, 1)) {
                        roomArray.forNear((x1, y1, val) => {
                            if (val > currentValue && currentValue < 6) {
                                dfsFindUp(roomArray, x1, y1);
                            }
                            else if (val && val < currentValue) {
                                dfsFindDown(roomArray, x1, y1);
                            }
                        }, x, y);
                        let pos = x * 50 + y;
                        if (unionFind.find(pos) && unionFind.find(currentPos) && (!blocked || !blocked.get(x, y))) {
                            unionFind.union(currentPos, pos);
                            posSeq.push(pos);
                            cnt++;
                        }
                        else if (blocked)
                            unionFind.union(pos, 0);
                    }
                };
                dfsFindUp(nearWallWithInterpolation, nd.x, nd.y);
                if (cnt > 0) {
                    let pos = unionFind.find(currentPos);
                    queMin.push(NewNode(cnt, 0, 0, pos));
                    sizeMap[pos] = cnt;
                    posSeqMap[pos] = posSeq;
                }
            }
            roomWalkable.forBorder((x, y, val) => {
                if (val) {
                    roomWalkable.forNear((x, y, val) => {
                        if (val) {
                            let pos = unionFind.find(x * 50 + y);
                            if (sizeMap[pos])
                                delete sizeMap[pos];
                        }
                    }, x, y);
                    let pos = unionFind.find(x * 50 + y);
                    if (sizeMap[pos])
                        delete sizeMap[pos];
                }
            });
            delete sizeMap[0];
            let putAbleCacheMap = {};
            let allCacheMap = {};
            queMin.whileNoEmpty(nd => {
                let pos = nd.v;
                if (nd.k != sizeMap[pos])
                    return;
                visited.init();
                let nearCntMap = {};
                let allNearCnt = 0;
                posSeqMap[pos].forEach(e => {
                    let y = e % 50;
                    let x = ((e - y) / 50);
                    roomWalkable.forNear((x, y, val) => {
                        if (val && !visited.exec(x, y, 1)) {
                            let currentPos = unionFind.find(x * 50 + y);
                            if (currentPos == pos)
                                return;
                            allNearCnt += 1;
                            let currentSize = sizeMap[currentPos];
                            if (currentSize < 300) {
                                nearCntMap[currentPos] = (nearCntMap[currentPos] || 0) + 1;
                            }
                        }
                    }, x, y);
                });
                let targetPos = undefined;
                let nearCnt = 0;
                let maxRatio = 0;
                Object.keys(nearCntMap).forEach(currentPos => {
                    let currentRatio = nearCntMap[currentPos] / Math.sqrt(Math.min(sizeMap[currentPos], nd.k));
                    if (currentRatio == maxRatio ? sizeMap[currentPos] < sizeMap[targetPos] : currentRatio > maxRatio) {
                        targetPos = currentPos;
                        maxRatio = currentRatio;
                        nearCnt = nearCntMap[currentPos];
                    }
                });
                Object.keys(nearCntMap).forEach(currentPos => {
                    if (nearCnt < nearCntMap[currentPos]) {
                        targetPos = currentPos;
                        nearCnt = nearCntMap[currentPos];
                    }
                });
                let minSize = sizeMap[targetPos];
                let cnt = nd.k + minSize;
                let targetBlockPutAbleCnt = 0;
                let ndkBlockPutAbleCnt = 0;
                if (minSize > minPlaneCnt)
                    targetBlockPutAbleCnt = pro.getBlockPutAbleCnt(roomWalkable, visited, queMin2, unionFind, targetPos, putAbleCacheMap, allCacheMap)[0].length;
                if (nd.k > minPlaneCnt)
                    ndkBlockPutAbleCnt = pro.getBlockPutAbleCnt(roomWalkable, visited, queMin2, unionFind, nd.v, putAbleCacheMap, allCacheMap)[0].length;
                if (targetPos && Math.max(targetBlockPutAbleCnt, ndkBlockPutAbleCnt) < minPlaneCnt) {
                    unionFind.union(pos, targetPos);
                    nd.v = unionFind.find(pos);
                    if (pos != nd.v)
                        delete sizeMap[pos];
                    else
                        delete sizeMap[targetPos];
                    nd.k = cnt;
                    sizeMap[nd.v] = cnt;
                    posSeqMap[nd.v] = posSeqMap[targetPos].concat(posSeqMap[pos]);
                    delete putAbleCacheMap[nd.v];
                    delete putAbleCacheMap[targetPos];
                    if (pos != nd.v)
                        delete posSeqMap[pos];
                    else
                        delete posSeqMap[targetPos];
                    queMin.push(NewNode(nd.k, nd.x, nd.y, nd.v));
                }
            });
            return [unionFind, sizeMap, roomWalkable, nearWall, putAbleCacheMap, allCacheMap];
        },
        computeManor(roomName, points, blocked) {
            pro.init();
            for (let p of points) {
                if (p.pos && p.pos.roomName == roomName)
                    objects.push(p.pos);
            }
            const resourceScores = options.optimizeResourceAccess ? resourceAccessScores(new Room.Terrain(roomName),
                objects.map((pos, index) => ({ pos, kind: index === 0 ? 'controller' : index === 1 ? 'mineral' : 'source' })),
                options.resourceAccessWeights, checkBudget) : undefined;
            const reservedResources = new Set(objects.map(pos => pos.x * 50 + pos.y));
            let blockArray = pro.computeBlock(roomName, blocked);
            let unionFind = blockArray[0];
            let sizeMap = blockArray[1];
            let wallMap = {};
            let roomWalkable = blockArray[2];
            let nearWall = blockArray[3];
            let putAbleCacheMap = blockArray[4];
            let allCacheMap = blockArray[5];
            let roomManor = interpolation;
            let roomStructs = nearWallWithInterpolation;
            roomManor.init();
            roomStructs.init();
            nearWall.init();
            queMin.clear();
            let finalPos = undefined;
            let wallCnt = 1e9;
            let putAbleList = [];
            let innerPutAbleList = [];
            let centerX = undefined;
            let centerY = undefined;
            let selectedAnchor = undefined;
            let selectedLab = undefined;
            let selectedResourceScore = Infinity;
            Object.keys(sizeMap).forEach(pos => {
                checkBudget();
                pro.getBlockPutAbleCnt(roomWalkable, visited, queMin, unionFind, pos, putAbleCacheMap, allCacheMap);
                let currentPutAbleList = putAbleCacheMap[pos];
                let allList = allCacheMap[pos];
                if (currentPutAbleList.length < minPlaneCnt)
                    return;
                if (preferredStorage && !currentPutAbleList.find(e => e.x == preferredStorage.x && e.y == preferredStorage.y))
                    return;
                wallMap[pos] = [];
                visited.init();
                roomWalkable.forBorder((x, y, val) => { if (val) {
                    queMin.push(NewNode(0, x, y));
                    visited.set(x, y, 1);
                } });
                let roomManor = routeDistance;
                roomManor.init();
                allList.forEach(e => {
                    roomManor.set(e.x, e.y, 1);
                });
                queMin.whileNoEmpty(nd => {
                    if (!roomManor.get(nd.x, nd.y))
                        roomWalkable.forNear((x, y, val) => {
                            if (!visited.exec(x, y, 1) && val) {
                                if (!roomManor.get(x, y))
                                    queMin.push(NewNode(nd.k + 1, x, y));
                                else {
                                    wallMap[pos].push(NewNode(0, x, y));
                                }
                            }
                        }, nd.x, nd.y);
                });
                let currentInnerPutAbleList = currentPutAbleList;
                let maxDist = 0;
                let filter2 = currentInnerPutAbleList.filter(e => e.k > 2);
                if (filter2.length < 30) {
                    filter2.forEach(a => {
                        filter2.forEach(b => {
                            maxDist = Math.max(maxDist, Math.abs(a.x - b.x) + Math.abs(a.y - b.y));
                        });
                    });
                }
                let currentWallCnt = wallMap[pos].length;
                if (!(minPlaneCnt < currentPutAbleList.length && (currentInnerPutAbleList.filter(e => e.k > 1).length > 30 || maxDist > 5)))
                    return;
                let currentAnchor = undefined;
                let currentLab = undefined;
                let currentResourceScore = Infinity;
                if (resourceScores) {
                    const depth = new Int16Array(2500);
                    currentPutAbleList.forEach(e => depth[e.x * 50 + e.y] = e.k);
                    const isAvailable = (x, y) => x > 0 && y > 0 && x < 49 && y < 49
                        && Number.isFinite(resourceScores[x * 50 + y]) && roomWalkable.get(x, y)
                        && !reservedResources.has(x * 50 + y) && !roomObjectCache.get(x, y);
                    // All anchors share the same viable lab rectangles within this block.
                    const labCandidates = [];
                    for (let y = 1; y <= 45; y++) {
                        checkBudget();
                        for (let x = 1; x <= 45; x++) {
                            if (depth[x * 50 + y] < 2) continue;
                            let available = true;
                            for (let i = 0; i < 4 && available; i++) for (let j = 0; j < 4; j++) {
                                if (depth[(x + i) * 50 + y + j] <= 0 || !isAvailable(x + i, y + j)) {
                                    available = false;
                                    break;
                                }
                            }
                            if (available) labCandidates.push({ x, y });
                        }
                    }
                    const anchors = preferredStorage ? currentPutAbleList.filter(e => e.x === preferredStorage.x && e.y === preferredStorage.y) : filter2;
                    anchors.forEach((anchor, index) => {
                        if (index % 16 === 0) checkBudget();
                        const score = resourceScores[anchor.x * 50 + anchor.y];
                        if (!Number.isFinite(score) || score > currentResourceScore
                            || score === currentResourceScore && currentAnchor && anchor.k <= currentAnchor.k) return;
                        // The four fixed core structures and surrounding road diamond must be buildable.
                        for (const [dx, dy] of [[0, 0], [-1, 0], [0, 1], [1, 0], [0, -1], [-2, 0], [-1, -1],
                            [0, -2], [-1, 1], [1, -1], [0, 2], [1, 1], [2, 0]]) {
                            if (!isAvailable(anchor.x + dx, anchor.y + dy)) return;
                        }
                        let bestLab = undefined;
                        let labDistance = Infinity;
                        labCandidates.forEach((lab, index) => {
                            if (index % 64 === 0) checkBudget();
                            const distance = Math.pow(anchor.x - lab.x - 1.5, 2) + Math.pow(anchor.y - lab.y - 1.5, 2);
                            if (distance >= labDistance) return;
                            for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
                                if (Math.abs(lab.x + i - anchor.x) + Math.abs(lab.y + j - anchor.y) <= 2) return;
                            }
                            bestLab = lab;
                            labDistance = distance;
                        });
                        if (!bestLab) return;
                        currentAnchor = anchor;
                        currentLab = bestLab;
                        currentResourceScore = score;
                    });
                    if (!currentAnchor) return;
                }
                if (resourceScores ? currentResourceScore < selectedResourceScore
                    || currentResourceScore === selectedResourceScore && (currentWallCnt < wallCnt
                        || currentWallCnt === wallCnt && currentAnchor.k > (selectedAnchor?.k ?? -Infinity)) : wallCnt > currentWallCnt) {
                    putAbleList = currentPutAbleList;
                    innerPutAbleList = currentInnerPutAbleList;
                    wallCnt = currentWallCnt;
                    finalPos = pos;
                    selectedAnchor = currentAnchor;
                    selectedLab = currentLab;
                    selectedResourceScore = currentResourceScore;
                    if (preferredStorage) {
                        centerX = preferredStorage.x;
                        centerY = preferredStorage.y;
                    }
                    else {
                        centerX = currentPutAbleList.map(e => e.x).reduce((a, b) => a + b) / currentPutAbleList.length;
                        centerY = currentPutAbleList.map(e => e.y).reduce((a, b) => a + b) / currentPutAbleList.length;
                    }
                }
            });
            if (!putAbleCacheMap[finalPos])
                return;
            let walls = wallMap[finalPos];
            roomManor.init();
            allCacheMap[finalPos].forEach(e => {
                roomManor.set(e.x, e.y, -1);
            });
            innerPutAbleList.forEach(e => {
                roomManor.set(e.x, e.y, e.k);
            });
            let storageX = 0;
            let storageY = 0;
            let storageDistance = 100;
            if (selectedAnchor) {
                storageX = selectedAnchor.x;
                storageY = selectedAnchor.y;
            }
            else innerPutAbleList.filter(e => e.k > 2).forEach(e => {
                let x = e.x;
                let y = e.y;
                let detX = centerX - x;
                let detY = centerY - y;
                let distance = Math.sqrt(detX * detX + detY * detY);
                if (storageDistance > distance) {
                    storageDistance = distance;
                    storageX = x;
                    storageY = y;
                }
            });
            if (preferredStorage) {
                storageX = preferredStorage.x;
                storageY = preferredStorage.y;
            }
            let labX = 0;
            let labY = 0;
            let labDistance = 1e5;
            if (selectedLab) {
                labX = selectedLab.x;
                labY = selectedLab.y;
            }
            else roomManor.forEach((x, y, val) => {
                if (val >= 2) {
                    let distance = Math.sqrt(Math.pow(storageX - x - 1.5, 2) + Math.pow(storageY - y - 1.5, 2));
                    if (labDistance <= distance)
                        return;
                    let checkCnt = 0;
                    let check = function (x, y) {
                        if (roomManor.get(x, y) > 0 && Math.abs(x - storageX) + Math.abs(y - storageY) > 2) {
                            checkCnt += 1;
                        }
                    };
                    for (let i = 0; i < 4; i++)
                        for (let j = 0; j < 4; j++)
                            check(x + i, y + j);
                    if (checkCnt == 16) {
                        labDistance = distance;
                        labX = x;
                        labY = y;
                    }
                }
            });
            labX += 1;
            labY += 1;
            let structMap = {};
            Object.keys(CONTROLLER_STRUCTURES).forEach(e => structMap[e] = []);
            structMap["link"] = roomObjectCache.link;
            structMap["container"] = roomObjectCache.container;
            structMap["extractor"] = roomObjectCache.extractor;
            structMap["storage"].push([storageX - 1, storageY]);
            structMap["terminal"].push([storageX, storageY + 1]);
            structMap["factory"].push([storageX + 1, storageY]);
            structMap["link"].push([storageX, storageY - 1]);
            for (let i = -1; i <= 1; i++) {
                for (let j = -1; j <= 1; j++) {
                    structMap["road"].push([storageX + i + j, storageY + i - j]);
                }
            }
            let labs = [
                "☢☢-☢",
                "☢-☢-",
                "-☢-☢",
                "☢-☢☢"
            ];
            let labChangeDirection = false;
            if ((storageX - labX) * (storageY - labY) < 0) {
                labChangeDirection = true;
            }
            let vis = {};
            for (let i = 0; i < 2; i++) {
                for (let j = 0; j < 2; j++) {
                    vis[i + "_" + j] = 1;
                    let jj = labChangeDirection ? j : 1 - j;
                    let structs = labs[i + 1].charAt(j + 1);
                    if (structs == '☢')
                        structMap["lab"].push([labX + i, labY + jj]);
                    else
                        structMap["road"].push([labX + i, labY + jj]);
                }
            }
            for (let i = -1; i < 3; i++) {
                for (let j = -1; j < 3; j++) {
                    if (vis[i + "_" + j])
                        continue;
                    let jj = labChangeDirection ? j : 1 - j;
                    let structs = labs[i + 1].charAt(j + 1);
                    if (structs == '☢')
                        structMap["lab"].push([labX + i, labY + jj]);
                    else
                        structMap["road"].push([labX + i, labY + jj]);
                }
            }
            walls.forEach(e => structMap["rampart"].push([e.x, e.y]));
            Object.keys(CONTROLLER_STRUCTURES).forEach(struct => structMap[struct].forEach(e => roomStructs.set(e[0], e[1], struct)));
            structMap["road"].forEach(e => roomStructs.set(e[0], e[1], 1));
            let setModel = function (xx, yy) {
                let checkAble = (x, y) => (x >= 0 && y >= 0 && x <= 49 && y <= 49) && roomManor.get(x, y) > 0 && !roomStructs.get(x, y);
                for (let i = -1; i <= 1; i++) {
                    for (let j = -1; j <= 1; j++) {
                        let x = xx + i + j;
                        let y = yy + i - j;
                        if (checkAble(x, y)) {
                            if (i || j) {
                                roomStructs.set(x, y, 1);
                            }
                            else {
                                roomStructs.set(x, y, 12);
                            }
                        }
                    }
                }
                for (let e of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    let x = xx + e[0];
                    let y = yy + e[1];
                    if (checkAble(x, y)) {
                        roomStructs.set(x, y, 8);
                    }
                }
            };
            for (let i = 0; i < 50; i += 4) {
                for (let j = 0; j < 50; j += 4) {
                    let x = storageX % 4 + i;
                    let y = storageY % 4 + j;
                    setModel(x, y);
                    setModel(x + 2, y + 2);
                }
            }
            visited.init();
            visited.set(storageX, storageY, 1);
            queMin.push(NewNode(1, storageX, storageY));
            let costRoad = routeDistance;
            costRoad.init();
            queMin.whileNoEmpty(nd => {
                roomStructs.forNear((x, y, val) => {
                    if (!visited.exec(x, y, 1) && val > 0) {
                        queMin.push(NewNode(nd.k + val, x, y));
                    }
                }, nd.x, nd.y);
                costRoad.set(nd.x, nd.y, nd.k);
            });
            structMap["road"].forEach(e => roomStructs.set(e[0], e[1], "road"));
            costRoad.forEach((x, y, val) => {
                if (!val)
                    return;
                let minVal = 50;
                costRoad.forNear((x1, y1, val) => {
                    if (minVal > val && val > 0) {
                        minVal = val;
                    }
                }, x, y);
                costRoad.forNear((x1, y1, val) => {
                    if (minVal == val && val > 0) {
                        roomStructs.set(x1, y1, "road");
                    }
                }, x, y);
            });
            let spawnPos = [];
            let extensionPos = [];
            roomStructs.forEach((x, y, val) => {
                if (val > 0) {
                    let dist = 100;
                    costRoad.forNear((x, y, val) => {
                        if (val)
                            dist = Math.min(dist, val);
                    }, x, y);
                    if (val == 12) {
                        spawnPos.push([x, y, dist]);
                    }
                    else {
                        extensionPos.push([x, y, dist]);
                    }
                }
            });
            let cmpFunc = (a, b) => a[2] == b[2] ? (a[1] == b[1] ? a[0] - b[0] : a[1] - b[1]) : a[2] - b[2];
            spawnPos = spawnPos.sort(cmpFunc);
            extensionPos = extensionPos.sort(cmpFunc);
            let oriStruct = [];
            let putList = [];
            ["spawn", "nuker", "powerSpawn", "tower", "observer"].forEach(struct => {
                for (let i = 0; i < CONTROLLER_STRUCTURES[struct][8]; i++) {
                    oriStruct.push(struct);
                }
            });
            oriStruct.forEach(struct => {
                let e = spawnPos.shift();
                if (!e)
                    e = extensionPos.shift();
                structMap[struct].push([e[0], e[1]]);
                putList.push([e[0], e[1], struct]);
            });
            extensionPos.push(...spawnPos);
            extensionPos = extensionPos.sort(cmpFunc);
            let extCnt = 60;
            extensionPos.forEach(e => {
                if (extCnt > 0) {
                    structMap["extension"].push([e[0], e[1]]);
                    putList.push([e[0], e[1], "extension"]);
                    extCnt -= 1;
                }
            });
            roomStructs.init();
            Object.keys(CONTROLLER_STRUCTURES).forEach(struct => structMap[struct].forEach(e => roomStructs.set(e[0], e[1], struct)));
            visited.init();
            structMap["road"].forEach(e => visited.set(e[0], e[1], 1));
            putList.forEach(e => {
                let x = e[0];
                let y = e[1];
                let minVal = 50;
                costRoad.forNear((x1, y1, val) => {
                    if (minVal > val && val > 0) {
                        minVal = val;
                    }
                }, x, y);
                costRoad.forNear((x1, y1, val) => {
                    if (minVal == val && val > 0) {
                        roomStructs.set(x1, y1, "road");
                    }
                }, x, y);
            });
            roomStructs.forEach((x, y, val) => {
                if (val == 'link' || val == 'container')
                    return;
                if (!val instanceof String || val > -1)
                    return;
                let minVal = 50;
                costRoad.forNear((x1, y1, val) => {
                    if (minVal > val && val > 0) {
                        minVal = val;
                    }
                }, x, y);
                costRoad.forNear((x1, y1, val) => {
                    if (minVal == val && val > 0) {
                        if (!visited.exec(x1, y1, 1))
                            structMap["road"].push([x1, y1]);
                    }
                }, x, y);
            });
            let terrain = new Room.Terrain(roomName);
            const naturalPositions = new Set(objects.map(pos => `${pos.x},${pos.y}`));
            // Upstream road gradients can cross a later building placement on irregular terrain.
            // Remove those proposals before roads lower PathFinder costs on obstacle tiles.
            const blockedRoadTiles = new Set(naturalPositions);
            for (const type of OBSTACLE_OBJECT_TYPES) {
                for (const [x, y] of structMap[type] || []) blockedRoadTiles.add(`${x},${y}`);
            }
            structMap.road = structMap.road.filter(([x, y]) => !blockedRoadTiles.has(`${x},${y}`));
            const occupants = new Map();
            for (const [type, positions] of Object.entries(structMap)) {
                for (const [x, y] of positions) {
                    const key = `${x},${y}`, present = occupants.get(key) || [];
                    present.push(type); occupants.set(key, present);
                }
            }
            const canWalk = (x, y) => terrain.get(x, y) !== TERRAIN_MASK_WALL &&
                !naturalPositions.has(`${x},${y}`) && !(occupants.get(`${x},${y}`) || []).some(type => OBSTACLE_OBJECT_TYPES.includes(type));
            const canBuild = (x, y) => canWalk(x, y) && (occupants.get(`${x},${y}`) || []).every(type => type === 'road' || type === 'rampart');
            checkBudget();
            const controllerContainer = selectControllerContainer(objects[0], canWalk, canBuild, { x: storageX, y: storageY });
            checkBudget();
            if (controllerContainer === undefined) throw new Error(`63 planner found no viable controller container at range 3 in ${roomName}`);
            // Only move the planned controller container. Preserve its original inner Link and every resource container.
            structMap.container = structMap.container.filter(position => position !== roomObjectCache.controllerContainer);
            structMap.container.push(controllerContainer);
            let costs = new PathFinder.CostMatrix;
            for (let i = 0; i < 50; i++) {
                for (let j = 0; j < 50; j++) {
                    let te = terrain.get(i, j);
                    costs.set(i, j, te == TERRAIN_MASK_WALL ? 255 : (te == TERRAIN_MASK_SWAMP ? 4 : 2));
                }
            }
            for (let struct of OBSTACLE_OBJECT_TYPES) {
                if (structMap[struct]) {
                    structMap[struct].forEach(e => {
                        costs.set(e[0], e[1], 255);
                    });
                }
            }
            structMap["road"].forEach(e => {
                costs.set(e[0], e[1], 1);
            });
            // Native Sources, Minerals and Controllers are not traversable even on plain terrain.
            objects.forEach(pos => costs.set(pos.x, pos.y, 255));
            structMap["container"].sort(e => Math.sqrt((e[0] - storageX) * (e[0] - storageX) + (e[1] - storageY) * (e[1] - storageY)));
            structMap["container"].forEach(e => {
                checkBudget();
                const isController = e[0] === controllerContainer[0] && e[1] === controllerContainer[1];
                let goals = { pos: new RoomPosition(e[0], e[1], roomName), range: 1 };
                if (isController) {
                    goals = [];
                    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                        const x = e[0] + dx, y = e[1] + dy;
                        if (!(dx || dy) || x <= 0 || y <= 0 || x >= 49 || y >= 49 || !canWalk(x, y) ||
                            Math.max(Math.abs(x - objects[0].x), Math.abs(y - objects[0].y)) <= controllerLayoutPolicy.containerRange) continue;
                        goals.push({ pos: new RoomPosition(x, y, roomName), range: 0 });
                    }
                }
                let ret = PathFinder.search(new RoomPosition(storageX, storageY, roomName), goals, {
                    roomCallback: () => { return costs; },
                    maxRooms: 1
                });
                checkBudget();
                if (ret.incomplete) throw new Error(`63 planner could not connect a resource route in ${roomName}`);
                ret.path.forEach(pos => {
                    if (costs.get(pos.x, pos.y) != 1) {
                        structMap['road'].push([pos.x, pos.y]);
                        costs.set(pos.x, pos.y, 1);
                    }
                });
            });
            return { roomName, storagePos: { x: storageX, y: storageY }, labPos: { x: labX, y: labY }, controllerContainer, structMap };
        },
    };

    try {
        checkBudget()
        return pro.computeManor(roomName, points)
    } finally {
        // Includes early-return and exceptional paths; no working grids escape this call.
        pro.dismiss()
    }
}
