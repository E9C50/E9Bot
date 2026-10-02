import sys

if __package__:
    from .client import create_api
    from .policy import DEFENDER_POLICY, FLOOD_FILL_RECURSION_LIMIT, ROOM_SIZE
else:
    from client import create_api
    from policy import DEFENDER_POLICY, FLOOD_FILL_RECURSION_LIMIT, ROOM_SIZE


sys.setrecursionlimit(FLOOD_FILL_RECURSION_LIMIT)


def dfs(matrix, x, y):
    # 边界检查
    if x < 0 or x >= ROOM_SIZE or y < 0 or y >= ROOM_SIZE:
        return
    # 如果当前点是墙壁或城墙，停止搜索
    if matrix[x][y] == "1" or matrix[x][y] == "2":
        return
    # 如果当前点是平地，标记为3
    if matrix[x][y] == "0":
        matrix[x][y] = "3"
        # 向8个方向递归搜索
        dfs(matrix, x + 1, y)  # 向下
        dfs(matrix, x - 1, y)  # 向上
        dfs(matrix, x, y + 1)  # 向右
        dfs(matrix, x, y - 1)  # 向左
        dfs(matrix, x + 1, y + 1)  # 右下
        dfs(matrix, x + 1, y - 1)  # 左下
        dfs(matrix, x - 1, y + 1)  # 右上
        dfs(matrix, x - 1, y - 1)  # 左上


def is_outer_wall(matrix, x, y):
    # 检查是否是外围城墙或外围墙壁
    # 如果当前点是城墙（2）或墙壁（1），并且与标记为3的平地相邻，则是外围
    if matrix[x][y] == "1" or matrix[x][y] == "2":
        for dx in [-1, 0, 1]:
            for dy in [-1, 0, 1]:
                if dx == 0 and dy == 0:
                    continue  # 跳过自身
                nx, ny = x + dx, y + dy
                if 0 <= nx < ROOM_SIZE and 0 <= ny < ROOM_SIZE and matrix[nx][ny] == "3":
                    return True
    return False


def mark_inside_areas(matrix, wall_buffer_radius=DEFENDER_POLICY["wall_buffer_radius"]):
    # 遍历整个矩阵，找到所有外部城墙
    walls = []
    for i in range(ROOM_SIZE):
        for j in range(ROOM_SIZE):
            if matrix[i][j] == "2":
                # 检查是否是外部城墙（是否与标记为3的平地相邻，包括斜向）
                if is_outer_wall(matrix, i, j):
                    walls.append((i, j))

    # 对于每个外部城墙，标记其内部相邻2格范围内的平地为4
    for x, y in walls:
        # 排除外围城墙和外围墙壁内部的墙壁和城墙
        for dx in range(-wall_buffer_radius, wall_buffer_radius + 1):
            for dy in range(-wall_buffer_radius, wall_buffer_radius + 1):
                nx, ny = x + dx, y + dy
                if 0 <= nx < ROOM_SIZE and 0 <= ny < ROOM_SIZE:
                    # 如果当前点是平地且不在外围城墙或外围墙壁内部，则标记为4
                    if matrix[nx][ny] == "0" and not is_outer_wall(matrix, nx, ny):
                        matrix[nx][ny] = "4"


def process_matrix(item_list, wall_buffer_radius=DEFENDER_POLICY["wall_buffer_radius"]):
    # 将字符串转换为 50x50 的矩阵
    matrix = [item_list[i * ROOM_SIZE : (i + 1) * ROOM_SIZE] for i in range(ROOM_SIZE)]

    # 遍历矩阵边缘，找到所有平地点并开始 DFS
    for i in range(ROOM_SIZE):
        # 第一行和最后一行
        if matrix[0][i] == "0":
            dfs(matrix, 0, i)
        if matrix[(ROOM_SIZE - 1)][i] == "0":
            dfs(matrix, (ROOM_SIZE - 1), i)
        # 第一列和最后一列
        if matrix[i][0] == "0":
            dfs(matrix, i, 0)
        if matrix[i][(ROOM_SIZE - 1)] == "0":
            dfs(matrix, i, (ROOM_SIZE - 1))

    # 标记外部城墙内部相邻2格范围内的平地
    mark_inside_areas(matrix, wall_buffer_radius)

    # 将矩阵转换回字符串
    return [item for row in matrix for item in row]


def process_room(room_name, api_client, shard):
    room_objects = api_client.room_objects(room_name, shard)["objects"]
    room_terrain = api_client.room_terrain(room_name, True, shard)["terrain"][0]["terrain"]
    room_terrain = room_terrain.replace("2", "0")
    room_terrain_list = list(room_terrain)

    for structure in room_objects:
        if structure["type"] == "constructedWall" or structure["type"] == "rampart":
            index = structure["y"] * ROOM_SIZE + structure["x"]
            room_terrain_list[index] = "2"

    room_terrain_list = process_matrix(room_terrain_list)
    # 9 墙壁 9 Ram外围 8 危险区 2 城墙内部 0 平路
    room_terrain_list = ["9" if x == "1" else x for x in room_terrain_list]
    room_terrain_list = ["9" if x == "3" else x for x in room_terrain_list]
    room_terrain_list = ["8" if x == "4" else x for x in room_terrain_list]
    room_terrain_list = ["2" if x == "2" else x for x in room_terrain_list]

    memory_text = "".join(map(str, room_terrain_list))
    print(memory_text)
    ### 注意！！！此处为写入内存的路径
    api_client.set_memory(f"rooms.{room_name}.defenderCostMatrix", memory_text, shard)


def main():
    for target in DEFENDER_POLICY["targets"]:
        api_client = create_api(target["profile"])
        for room_name in target["rooms"]:
            process_room(room_name, api_client, target["shard"])


if __name__ == "__main__":
    main()
