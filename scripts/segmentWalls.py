from collections import deque

if __package__:
    from .client import create_api
    from .policy import SEGMENT_POLICY, ROOM_SIZE
else:
    from client import create_api
    from policy import SEGMENT_POLICY, ROOM_SIZE


rows, cols = ROOM_SIZE, ROOM_SIZE


def find_closed_loop(
    matrix, rows, cols, start_row, start_col,
    center_range=SEGMENT_POLICY["center_exclusion_radius"],
):
    # 将一维数组转换为二维矩阵
    grid = [list(matrix[i * cols : (i + 1) * cols]) for i in range(rows)]

    # 定义四个方向的移动
    directions = [(-1, 0), (1, 0), (0, -1), (0, 1)]

    # 初始化访问标记矩阵
    visited = [[False for _ in range(cols)] for _ in range(rows)]

    # 如果起始位置是墙壁或城墙，直接返回空列表
    if grid[start_row][start_col] == "1" or grid[start_row][start_col] == "6":
        return []

    # 初始化队列和闭环坐标列表
    queue = deque()
    queue.append((start_row, start_col))
    visited[start_row][start_col] = True
    closed_loop_coords = [(start_row, start_col)]

    # 定义中心点周围三格的范围
    min_row = max(0, start_row - center_range)
    max_row = min(rows - 1, start_row + center_range)
    min_col = max(0, start_col - center_range)
    max_col = min(cols - 1, start_col + center_range)

    # BFS
    while queue:
        current_row, current_col = queue.popleft()

        # 遍历四个方向
        for dr, dc in directions:
            new_row, new_col = current_row + dr, current_col + dc

            # 检查新位置是否在矩阵范围内
            if 0 <= new_row < rows and 0 <= new_col < cols:
                # 如果新位置在中心点周围三格内，跳过
                if min_row <= new_row <= max_row and min_col <= new_col <= max_col:
                    continue

                # 如果新位置是墙壁或城墙，跳过
                if grid[new_row][new_col] == "1" or grid[new_row][new_col] == "6":
                    continue

                # 如果新位置未被访问过，加入队列
                if not visited[new_row][new_col]:
                    visited[new_row][new_col] = True
                    queue.append((new_row, new_col))
                    closed_loop_coords.append((new_row, new_col))
            else:
                # 如果新位置超出矩阵范围，说明没有形成闭环
                return []

    # 返回闭环的坐标信息
    return closed_loop_coords


def plot_closed_loop(matrix, rows, cols, closed_loop_coords):
    import matplotlib.pyplot as plt

    # 将一维数组转换为二维矩阵
    grid = [list(matrix[i * cols : (i + 1) * cols]) for i in range(rows)]

    # 创建一个空白画布
    fig, ax = plt.subplots()

    # 绘制矩阵
    for row in range(rows):
        for col in range(cols):
            if grid[row][col] == "1":  # 墙壁
                ax.add_patch(plt.Rectangle((col, rows - 1 - row), 1, 1, color="black"))
            elif grid[row][col] == "6":  # 城墙
                ax.add_patch(plt.Rectangle((col, rows - 1 - row), 1, 1, color="gray"))
            else:  # 其他区域
                ax.add_patch(
                    plt.Rectangle(
                        (col, rows - 1 - row), 1, 1, color="white", edgecolor="black"
                    )
                )

    # 绘制闭环路径
    for row, col in closed_loop_coords:
        ax.add_patch(plt.Rectangle((col, rows - 1 - row), 1, 1, color="red", alpha=0.5))

    # 设置画布属性
    ax.set_xlim(0, cols)
    ax.set_ylim(0, rows)
    ax.set_aspect("equal")
    ax.set_xticks(range(cols + 1))
    ax.set_yticks(range(rows + 1))
    ax.grid(True)

    # 显示图像
    plt.gca().invert_yaxis()  # 反转Y轴以匹配矩阵坐标
    plt.show()


def process_room(room_name, api_client, shard):
    room_objects = api_client.room_objects(room_name, shard)["objects"]
    room_terrain = api_client.room_terrain(room_name, True, shard)["terrain"][0]["terrain"]
    room_terrain_list = list(room_terrain)

    storage = None

    for structure in room_objects:
        if structure["type"] == "constructedWall" or structure["type"] == "rampart":
            index = structure["y"] * ROOM_SIZE + structure["x"]
            room_terrain_list[index] = "6"
        if structure["type"] == "storage":
            storage = structure

    closed_loop_coords = find_closed_loop(
        room_terrain_list, rows, cols, storage["x"], storage["y"]
    )
    plot_closed_loop(room_terrain_list, rows, cols, closed_loop_coords)

    ### 注意！！！此处为写入内存的路径
    # api_client.set_memory(f"rooms.{room_name}.defenderCostMatrix", room_terrain_list, shard)


def main():
    api_client = create_api(SEGMENT_POLICY["profile"])
    for room_name in SEGMENT_POLICY["rooms"]:
        process_room(room_name, api_client, SEGMENT_POLICY["shard"])


if __name__ == "__main__":
    main()
