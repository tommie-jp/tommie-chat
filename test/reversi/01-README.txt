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
Stop-Process -Name pytest -Force

・WSL2 Ubuntu24
powershell.exe -Command "Stop-Process -Name py -Force"


CPUテスト
cpu_tester

・CPUテストのシリアルCOM構成
CPUテスト（相手はreversi_cpu.py)
COM1 --- COM2
COM1: reversi_cpu.py
COM2: pytest

・通常実行 (2ターミナル)
  ターミナルA: py reversi_cpu.py --port COM1 --baud 115200
  ターミナルB: .venv\Scripts\pytest --port COM2 -v

・セルフテスト一発起動 (reversi_cpu.py を別窓で自動起動 + pytest 実行 + 終了時 kill)
  cd cpu_tester
  .\doTest-selftest.ps1                       # COM1/COM2 デフォルト
  .\doTest-selftest.ps1 -CpuPort COM5 -TesterPort COM6  # ポート指定
  .\doTest-selftest.ps1 -Baud 9600            # ボーレート変更