# Windows 11 COM2 を WSL2 Ubuntu 24 のシリアルデバイスとして使う

## Q1: windows11 COM2をwsl2 ubuntu24のシリアルデバイスとして使うには？

まず「COM2が何なのか」で方法が変わります。ここが重要です。

### ケース1: COM2がUSB-シリアル変換器（FTDI, CH340, CP210xなど）

usbipd-win で WSL2 にパススルーできます。

Windows側（PowerShell管理者権限）:

```powershell
winget install --exact dorssel.usbipd-win
usbipd list                     # BUSIDを確認（COM番号ではなくUSBデバイスとして表示される）
usbipd bind --busid <BUSID>     # 共有（初回のみ、管理者）
usbipd attach --wsl --busid <BUSID>
```

WSL2側:

```bash
lsusb
ls /dev/ttyUSB* /dev/ttyACM*    # ここに出てくる
```

注意点:

- WSL2を起動した状態でattachする
- `wsl --shutdown` や再起動のたびに attach し直し
- `.wslconfig` で networkingMode=bridged にしていると動きません。mirrored か既定に
- ファイアウォールでTCP 3240を許可（プライベートネットワーク扱いにするのが確実）

### ケース2: COM2がマザーボード/PCIeカードのネイティブ16550 UART

**usbipdは使えません**（USB/IP経由なのでUSBデバイス限定）。WSL2は軽量VMで、ホストの物理シリアルは直接見えない。回避策は以下のいずれか:

- **TCPブリッジ**: Windows側で `hub4com` や HW VSP、`com2tcp` で COM2 を TCPポートに公開 → WSL2側で `socat pty,link=/dev/ttyV0,raw,echo=0 tcp:<host>:<port>` で PTY を作る
- **WSL1 を使う**: WSL1なら `/dev/ttyS2` が見えます（`wsl --set-version <Distro> 1`）
- **USB-シリアルに差し替える**: ケース1で素直に解決

---

## Q2: 1、2を調べるには？

Windows側でデバイスマネージャーかPowerShellで確認できます。

### GUI: デバイスマネージャー

1. `Win + X` → デバイスマネージャー
2. 「ポート (COM と LPT)」を展開
3. **COM2** の項目を右クリック → プロパティ → 「詳細」タブ
4. プロパティのドロップダウンで「ハードウェア ID」を選択

判別基準:

- `USB\VID_xxxx&PID_xxxx` → **ケース1（USBシリアル）**。VID/PIDをメモ（usbipdで使う）
- `ACPI\PNP0501` や `PCI\VEN_xxxx` → **ケース2（ネイティブUART）**

### CLI: PowerShell（1行で判別）

```powershell
Get-PnpDevice -Class Ports | Where-Object FriendlyName -like "*COM2*" |
  Select-Object FriendlyName, InstanceId, Manufacturer
```

`InstanceId` の先頭を見ます:

- `USB\...` → ケース1
- `ACPI\...` または `PCI\...` → ケース2

より詳細に見るなら:

```powershell
Get-PnpDevice -Class Ports | Where-Object FriendlyName -like "*COM2*" |
  Get-PnpDeviceProperty -KeyName DEVPKEY_Device_BusReportedDeviceDesc,
                                  DEVPKEY_Device_EnumeratorName
```

`EnumeratorName` が `USB` ならケース1確定です。

### usbipd側からも確認可能

管理者PowerShellで:

```powershell
usbipd list
```

ここに COM2 を持つUSBデバイスが出てくればケース1。出てこなければケース2（またはUSBだがusbipd未認識）。