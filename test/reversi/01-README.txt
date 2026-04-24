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

reversi_cpu.py (doTest1.ps1) を停止する手段
・ブラウザのシリアルテストパネル｜送信文字列に "QT" を送る (LF)
    → reversi_cpu.py だけ終了。同じ PowerShell 窓でプロンプトが戻る。
    (参考実装限定の開発支援コマンド。仕様 61-UART には載らない。実機 CPU は ER01 で弾く)
・Ctrl+C
    → doTest1.ps1 は Tee-Object を Start-Transcript に置換済なので Ctrl+C が py へ直接届く。
    ブラウザが接続されてない / フリーズ時のフォールバック。

KILLするコマンド (最終手段: 別窓から全 py を一律キル)
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