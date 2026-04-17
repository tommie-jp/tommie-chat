#!/usr/bin/env bash
# Usage: ./doLog-tail-f.sh [--short]
#   --short: RPC/WebSocket のみ簡素表示

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  cat <<'HELP'
Nakama ログ tail

Usage: ./doLog-tail-f.sh [OPTIONS]

Options:
  (なし)     docker compose logs をそのまま表示（JSON 全量）
  --short    RPC / WebSocket のみ簡素表示

--short 出力形式:
  HH:MM:SS rcv <表示名> <devId8> RPC:<名前> <payload≤120字>
  HH:MM:SS snd <表示名> <devId8> RPC:<名前> <payload≤120字>
  HH:MM:SS rcv <表示名> <devId8> WS:<opcode名> <payload≤120字>
  HH:MM:SS snd|rcv|othello ... <Go logf メッセージ>
  HH:MM:SS info|warn <Go logger メッセージ>

  表示名・devId8 は MatchJoin / InitPos / registerDeviceInfo から自動学習。
  未学習時は "?" を表示。

opcode名: InitPos(1) MoveTarget(2) AvatarChange(3) BlockUpdate(4)
          AOIUpdate(5) AOIEnter(6) AOILeave(7) DisplayName(8)
          ProfileReq(9) ProfileResp(10) PlayersAOIReq(11) PlayersAOIResp(12)
          Chat(13) SystemMsg(14) Jump(15) PlayerListSub(16)
          PlayerListData(17) OthelloUpdate(18) OthelloSub(19)
HELP
  exit 0
fi

if [[ "$1" == "--short" ]]; then
  docker compose logs -f --tail 0 nakama 2>&1 \
    | sed 's/^nakama-[0-9]* *| *//' \
    | jq -Rr --unbuffered '
      # opcode名マッピング
      def op_name:
        { "1":"InitPos", "2":"MoveTarget", "3":"AvatarChange",
          "4":"BlockUpdate", "5":"AOIUpdate", "6":"AOIEnter",
          "7":"AOILeave", "8":"DisplayName", "9":"ProfileReq",
          "10":"ProfileResp", "11":"PlayersAOIReq", "12":"PlayersAOIResp",
          "13":"Chat", "14":"SystemMsg", "15":"Jump",
          "16":"PlayerListSub", "17":"PlayerListData",
          "18":"OthelloUpdate", "19":"OthelloSub" };

      def short8: .[0:8];
      def trunc(n): if length > n then .[0:n] + "..." else . end;

      def ts_hms:
        split("T")[1] | split(".")
        | .[1][0:1] as $frac
        | .[0] | split(":") | map(tonumber)
        | .[0] = .[0] + 9 | if .[0] >= 24 then .[0] = .[0] - 24 else . end
        | map(tostring | if length < 2 then "0" + . else . end)
        | join(":") + "." + $frac;

      def envelope_rpc_id:
        capture("rpc:\\{id:\"(?<id>[^\"]+)\"") | .id;

      def envelope_payload:
        capture("payload:\"(?<p>(?:[^\"\\\\]|\\\\.)*)\"")
        | .p | gsub("\\\\\""; "\"");

      def ukey: "__U:" + (.uid | short8) + "__";

      # ── plain text 行 (logf 出力) ──
      if startswith("{") then . else
        # DBG 行は除外、snd/rcv/othello 行はそのまま通す
        if test(" DBG ") then empty
        elif test("^\\s*[0-9]{2}:[0-9]{2}:[0-9]{2}") then "__LOG__" + .
        else empty end
      end
      |
      # JSON 行のみパース
      if startswith("{") then (fromjson |

      # ── マッピング情報を __MAP__ 行として出力 ──

      # registerDeviceInfo → デバイスID
      if .msg == "Received *rtapi.Envelope_Rpc message"
         and .message.Rpc.id == "registerDeviceInfo" then
        ( (.message.Rpc.payload // "{}") | fromjson? // {} ) as $p |
        "__MAPD__\t" + (.uid | short8) + "\t" + (($p.deviceId // "") | short8),
        (.ts | ts_hms) + " rcv " + ukey + " "
        + "RPC:registerDeviceInfo "
        + ((.message.Rpc.payload // "") | trunc(120))

      # MatchJoin → 表示名
      elif .msg == "Received *rtapi.Envelope_MatchJoin message" then
        "__MAPN__\t" + (.uid | short8) + "\t" + (.message.MatchJoin.metadata.dn // ""),
        (.ts | ts_hms) + " rcv " + ukey + " WS:MatchJoin"

      # InitPos (op=1) → 表示名
      elif .msg == "Received *rtapi.Envelope_MatchDataSend message"
           and .message.MatchDataSend.op_code == 1 then
        ( (.message.MatchDataSend.data // "" | if . != "" then @base64d | fromjson? // {} else {} end) ) as $init |
        "__MAPN__\t" + (.uid | short8) + "\t" + ($init.dn // ""),
        (.ts | ts_hms) + " rcv " + ukey + " "
        + "WS:InitPos "
        + ((.message.MatchDataSend.data // "")
            | if . != "" then (. | @base64d | trunc(120)) else "" end)

      # ── Received RPC (ping除外, registerDeviceInfo は上で処理済み) ──
      elif .msg == "Received *rtapi.Envelope_Rpc message" then
        if .message.Rpc.id == "ping" then empty
        else
          (.ts | ts_hms) + " rcv " + ukey + " "
          + "RPC:" + .message.Rpc.id + " "
          + ((.message.Rpc.payload // "") | trunc(120))
        end

      # ── Sending RPC ──
      elif .msg == "Sending *rtapi.Envelope_Rpc message" then
        if (.envelope | test("id:\"ping\"")) then empty
        else
          (.ts | ts_hms) + " snd " + ukey + " "
          + "RPC:" + ((.envelope | envelope_rpc_id) // "?") + " "
          + (((.envelope | envelope_payload) // "") | trunc(120))
        end

      # ── Received MatchDataSend (WS) — InitPos は上で処理済み ──
      elif .msg == "Received *rtapi.Envelope_MatchDataSend message" then
        (.ts | ts_hms) + " rcv " + ukey + " "
        + "WS:" + (
            (.message.MatchDataSend.op_code | tostring) as $op
            | (op_name[$op] // ("op" + $op))
          ) + " "
        + ((.message.MatchDataSend.data // "")
            | if . != "" then (. | @base64d | trunc(120)) else "" end)

      # ── Sending Match (join応答) ──
      elif .msg | test("Sending \\*rtapi\\.Envelope_Match ") then
        (.ts | ts_hms) + " snd " + ukey + " WS:MatchJoined"

      # ── Go logger (info/warn) ──
      elif (.caller | test("go_src|modules")) and (.level == "info" or .level == "warn") then
        (.ts | ts_hms) + " " + .level + " " + .msg

      else empty end

      ) else . end
    ' \
    | awk -F'\t' '
      /^__MAPN__\t/ { name[$2] = $3; next }
      /^__MAPD__\t/ { dev[$2]  = $3; next }
      {
        # __LOG__ プレフィクスの logf 行はそのまま表示
        if (sub(/^__LOG__/, "")) { print; next }
        # __U:xxxxxxxx__ を "表示名 devId8" に置換
        if (match($0, /__U:([a-f0-9]{8})__/, arr)) {
          u = arr[1]
          nm = (u in name) ? name[u] : "?"
          dv = (u in dev)  ? dev[u]  : "?"
          sub(/__U:[a-f0-9]{8}__/, nm " " dv)
        }
        print
      }
    ' \
    | sed 's/\([0-9a-f]\{8\}\)-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}/\1/g'
else
  docker compose logs -f --tail 0 nakama
fi
