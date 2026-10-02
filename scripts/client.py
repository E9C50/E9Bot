"""Create a helper API client only when an entry point explicitly requests it."""

import json

if __package__:
    from .policy import SCREEPS_CONFIG_PATH
else:
    from policy import SCREEPS_CONFIG_PATH


def create_api(profile, config_path=SCREEPS_CONFIG_PATH):
    # Keep optional HTTP/WebSocket dependencies out of pure algorithm imports.
    if __package__:
        from . import screepsapi
    else:
        import screepsapi

    with open(config_path, "r") as config_file:
        account = json.load(config_file)[profile]
    return screepsapi.API(u=account["email"], p=account["password"])
