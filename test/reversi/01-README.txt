シリアルテストプログラムのメモ

テスト準備
COM1とCOM2をシリアル回線エミュレータでつなげる。以下参照
    doc/reversi/00-COMxとCOMyをつなげる.md

テスト方法
・Windows11 PowerShell
py -m pip install pyserial
py reversi_cpu.py --port COM2 --baud 115200

.\doTest1.ps1 UARTプロトコル向けシリアルテスト用オセロ

PowerShell
# カレントフォルダ名だけ
function prompt { "$(Split-Path -Leaf $PWD)> " }

KILLするコマンド
・PowerShell
Stop-Process -Name py -Force
・WSL2 Ubuntu24
powershell.exe -Command "Stop-Process -Name py -Force"
