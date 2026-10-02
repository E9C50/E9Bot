if __package__:
    from .client import create_api
    from .policy import AUTO_BUY_POLICY
else:
    from client import create_api
    from policy import AUTO_BUY_POLICY


def new_order(room_name, resource_type, order_price):
    print(
        f"下单：room_name[{room_name}] resource_type[{resource_type}] order_price[{order_price}]"
    )

    command = (
        "Game.market.createOrder({ type: ORDER_BUY, resourceType: '"
        + resource_type
        + "', price: "
        + str(order_price)
        + ", totalAmount: "
        + str(AUTO_BUY_POLICY["order_amount"])
        + ", roomName: '"
        + room_name
        + "' });"
    )
    api.console(command, AUTO_BUY_POLICY["shard"])


def modify_price(room_name, order_id, order_price, old_price):
    print(
        f"改价：room_name[{room_name}] order_id[{order_id}] old_price[{old_price}] order_price[{order_price}]"
    )
    command = (
        "Game.market.changeOrderPrice('" + order_id + "', " + str(order_price) + ");"
    )
    api.console(command, AUTO_BUY_POLICY["shard"])


def order_resource(room_name, resource_type):
    order_price = compute_buy_price(resource_type)
    exists = False
    # 如果已经有订单了，就修改价格保持竞争力
    for order in my_orders:
        if (
            order["roomName"] == room_name
            and order["resourceType"] == resource_type
            and order["remainingAmount"] > 0
            and order["type"] == "buy"
        ):
            exists = True
            if order["price"] < order_price:
                modify_price(room_name, order["_id"], order_price, order["price"])

    # 没有订单就下单
    if not exists:
        new_order(room_name, resource_type, order_price)


def cancel_order():
    for order in my_orders:
        if order["remainingAmount"] == 0:
            command = f"Game.market.cancelOrder('{order["_id"]}')"
            api.console(command, AUTO_BUY_POLICY["shard"])
            print(f"删除空订单 {order['roomName']}")


def get_resource_by_type(room_name, resource_type, room_objects):
    amount = 0
    for object in room_objects:
        if object["type"] == "storage" or object["type"] == "terminal":
            amount += object["store"][resource_type]
    print(f"room[{room_name}] type[{resource_type}] amount[{amount}]")
    return amount


# def compute_buy_price(resource_type):
#     all_orders = api.market_order_by_type(resource_type, AUTO_BUY_POLICY["shard"])["list"]
#     all_buy_orders = [
#         order
#         for order in all_orders
#         if (
#             order["type"] == "buy"
#             and order["roomName"] not in list(room_resource_config.keys())
#         )
#     ]
#     max_buy_price = max(all_buy_orders, key=lambda order: order["price"])
#     return max_buy_price["price"] if resource_type == 'energy' else max_buy_price["price"] * 1.1


def compute_buy_price(resource_type, max_deviation=AUTO_BUY_POLICY["max_price_deviation"]):
    # 获取所有订单
    all_orders = api.market_order_by_type(resource_type, AUTO_BUY_POLICY["shard"])["list"]

    # 过滤出符合条件的买单
    all_buy_orders = [
        order
        for order in all_orders
        if (
            order["type"] == "buy"
            and order["roomName"] not in list(room_resource_config.keys())
        )
    ]

    # 按价格从高到低排序
    sorted_buy_orders = sorted(
        all_buy_orders, key=lambda order: order["price"], reverse=True
    )

    total_amount = 0
    total_price = 0
    selected_orders = []

    # 累加订单数量，直到总量达到或超过1000000
    for order in sorted_buy_orders:
        if total_amount >= AUTO_BUY_POLICY["price_sample_volume"]:
            break
        selected_orders.append(order)
        total_amount += order["amount"]
        total_price += order["price"] * order["amount"]

    # 计算均价
    if total_amount > 0:
        average_price = total_price / total_amount
    else:
        average_price = 0

    # 过滤离均差较大的订单
    filtered_orders = [
        order
        for order in selected_orders
        if abs(order["price"] - average_price) / average_price <= max_deviation
    ]

    # 取剩下订单的最高价
    if filtered_orders:
        max_price = max(filtered_orders, key=lambda order: order["price"])["price"]
    else:
        max_price = 0

    return max_price


def process_room(room_name):
    room_objects = api.room_objects(room_name, AUTO_BUY_POLICY["shard"])["objects"]

    for resource_type in room_resource_config[room_name]:
        amount = get_resource_by_type(room_name, resource_type, room_objects)
        if amount < room_resource_config[room_name][resource_type]:
            order_resource(room_name, resource_type)


room_resource_config = AUTO_BUY_POLICY["room_resources"]


def main():
    global api, my_orders
    api = create_api(AUTO_BUY_POLICY["profile"])
    shard = AUTO_BUY_POLICY["shard"]
    my_orders = api.my_orders(shard)["shards"][shard]
    cancel_order()
    for room_name in room_resource_config:
        process_room(room_name)


if __name__ == "__main__":
    main()
