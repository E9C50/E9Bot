"""Local helper policies. Credentials remain in the existing screeps.json file.

The default configuration path is relative to the current working directory,
matching the original scripts. Room size and terrain encodings are game rules,
not tuning parameters.
"""

SCREEPS_CONFIG_PATH = "./screeps.json"
ROOM_SIZE = 50
FLOOD_FILL_RECURSION_LIMIT = 10000

AUTO_BUY_POLICY = {
    "profile": "main",
    "shard": "shard3",
    "order_amount": 50000,
    "max_price_deviation": 0.2,
    "price_sample_volume": 1000000,
    "room_resources": {"E35N1": {"energy": 800000}},
}

DEFENDER_POLICY = {
    "wall_buffer_radius": 2,
    "targets": [
        {
            "profile": "main",
            "shard": "shard3",
            "rooms": ["E35N1", "E35N3", "E34N3", "E36N2", "E37N7", "E41N8", "E41N7"],
        },
        {
            "profile": "pserver",
            "shard": "shard3",
            "rooms": ["E5S1", "E12N6", "E15N8"],
        },
    ],
}

SEGMENT_POLICY = {
    "profile": "main",
    "shard": "shard3",
    "rooms": ["E5S1"],
    "center_exclusion_radius": 3,
}
