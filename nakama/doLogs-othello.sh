#!/bin/bash
# LOG="/tmp/othello_server.log"
# echo "LOG=$LOG"
docker compose logs -f nakama 2>&1 | \
    grep --line-buffered -E 'othelloApplyMove|othelloNewGame|othelloPass|othelloResign' | \
    sed -u 's/^nakama-[0-9]*  *| *//' | \
    tee /tmp/othello_server.log

