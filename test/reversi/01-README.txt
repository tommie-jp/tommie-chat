シリアルテストプログラムのメモ

テスト方法

py -m pip install pyserial
py reversi_cpu.py --port COM2 --baud 115200


PowerShell
# カレントフォルダ名だけ
function prompt { "$(Split-Path -Leaf $PWD)> " }
