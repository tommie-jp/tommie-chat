# WSL2 から Windows の COM3 を使う

WSL2 は Hyper-V 上の Linux VM なので、Windows の `COM3` に直接アクセスできない。
**usbipd-win** で USB デバイス自体を WSL2 に付け替える方法が定番（COM3 が USB シリアル変換の場合）。

## 手順

### 1. Windows 側で usbipd をインストール（管理者 PowerShell）

```powershell
winget install usbipd
```

### 2. デバイス確認（Windows 側）

```powershell
usbipd list
```

`BUSID` を控える（例: `2-3`）。COM3 に対応する USB シリアルデバイスを探す。

### 3. 共有 → WSL にアタッチ（Windows 側、管理者）

```powershell
usbipd bind --busid 2-3        # 初回のみ
usbipd attach --wsl --busid 2-3
```

### 4. WSL2 側で確認

```bash
lsusb
dmesg | tail        # ttyUSB0 or ttyACM0 が出るはず
ls /dev/ttyUSB*
```

Linux 側では `/dev/ttyUSB0`（FTDI/CH340系）や `/dev/ttyACM0`（CDC系）として見える。
COM3 という名前は引き継がれない。

### 5. 権限

```bash
sudo usermod -aG dialout $USER
# 再ログイン後に使える
```

## 注意点

- **ネイティブ COM ポート（マザボの物理シリアル）は共有不可**。USB シリアル変換なら OK。
- WSL 再起動や USB 抜き差しで都度 `usbipd attach` が必要。
- カーネルにドライバが入っていない場合は `WSL2-Linux-Kernel` をビルドし直す必要あり（Ubuntu 24.04 の標準カーネルは FTDI/CH340/CDC-ACM は入っている）。

## 本プロジェクトでの使い分け

- **Web Serial API でのテスト用途**なら、ブラウザ直結なので WSL を経由せず Windows 側 Chrome で直接 COM3 にアクセスできる。
- **Linux 側のスクリプトから実機シリアルを叩きたい**場合のみ usbipd を使う。

## 関連ドキュメント

- [59-設計-外部CPU接続.md](../59-設計-外部CPU接続.md)
- [62-デバッグ-シリアル疑似デバイス.md](../62-デバッグ-シリアル疑似デバイス.md)
