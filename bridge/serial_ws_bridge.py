#!/usr/bin/env python3
"""serial_ws_bridge.py — シリアルポート ⇔ WebSocket ブリッジ

CPU → UART → USB → このスクリプト → WebSocket → ブラウザ(tommieChat)

依存: pip install pyserial websockets

使い方:
    python serial_ws_bridge.py --list                    # ポート一覧
    python serial_ws_bridge.py --port COM3               # Windows
    python serial_ws_bridge.py --port /dev/ttyACM0       # Linux
    python serial_ws_bridge.py --port /dev/cu.usbmodem*  # Mac
    python serial_ws_bridge.py --port COM3 --baud 115200 --ws-port 8765

ブラウザ側（HTTPSページからでも ws://localhost は許可される）:
    const ws = new WebSocket('ws://localhost:8765');
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => console.log(new TextDecoder().decode(e.data));
    ws.send('Hello\\r\\n');
"""

import argparse
import asyncio
import sys

import serial
import serial.tools.list_ports
import websockets


def list_ports():
    print('利用可能なシリアルポート:')
    ports = list(serial.tools.list_ports.comports())
    if not ports:
        print('  （見つかりません）')
        return
    for p in ports:
        print(f'  {p.device:25}  {p.description}')


async def serial_to_ws(ser, ws):
    loop = asyncio.get_event_loop()
    while True:
        # ser.read は timeout=0.1 で 0〜N バイト返る（空ならポーリング扱い）
        data = await loop.run_in_executor(None, ser.read, 1024)
        if not data:
            await asyncio.sleep(0)
            continue
        await ws.send(data)
        print(f'[RX→WS] {len(data)} bytes')


async def ws_to_serial(ws, ser):
    async for message in ws:
        data = message.encode('utf-8') if isinstance(message, str) else message
        ser.write(data)
        print(f'[WS→TX] {len(data)} bytes: {data!r}')


async def handle_client(ser, ws):
    print(f'[CLIENT] 接続: {ws.remote_address}')
    rx_task = asyncio.create_task(serial_to_ws(ser, ws))
    tx_task = asyncio.create_task(ws_to_serial(ws, ser))
    try:
        done, pending = await asyncio.wait(
            [rx_task, tx_task],
            return_when=asyncio.FIRST_EXCEPTION,
        )
        for t in pending:
            t.cancel()
        for t in done:
            exc = t.exception()
            if exc and not isinstance(exc, websockets.ConnectionClosed):
                print(f'[CLIENT] エラー: {exc!r}')
    finally:
        print('[CLIENT] 切断')


async def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--port', help='シリアルポート (例: COM3, /dev/ttyACM0)')
    parser.add_argument('--baud', type=int, default=115200, help='ボーレート (default: 115200)')
    parser.add_argument('--ws-port', type=int, default=8765, help='WebSocket ポート (default: 8765)')
    parser.add_argument('--list', action='store_true', help='シリアルポート一覧を表示して終了')
    args = parser.parse_args()

    if args.list:
        list_ports()
        return

    if not args.port:
        list_ports()
        print('\n--port を指定してください')
        sys.exit(1)

    ser = serial.Serial(args.port, args.baud, timeout=0.1)
    print(f'[SERIAL] {args.port} @ {args.baud} baud で開きました')

    async def handler(ws):
        await handle_client(ser, ws)

    async with websockets.serve(handler, '127.0.0.1', args.ws_port):
        print(f'[WS] ws://127.0.0.1:{args.ws_port} で待機中（Ctrl+C で終了）')
        await asyncio.Future()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print('\n終了')
