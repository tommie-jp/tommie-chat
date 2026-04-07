export const ja = {
    // --- ログイン ---
    "login.label": "ユーザID",
    "login.placeholder": "ユーザIDを入力",
    "login.btn": "ログイン",
    "login.connecting": "接続中…",
    "login.success": "✓ログイン成功しました",
    "login.failed": "✗ログイン失敗: ",
    "login.validation.short": "名前(6文字以上)を入力して下さい",
    "login.validation.chars": "✗ 使えない文字が含まれています。使える文字: 英数字と . _ @ + -（6〜128文字）",

    // --- ログアウト ---
    "logout": "ログアウト",
    "logout.confirm": "ログアウトしますか？",
    "logout.btn": "ログアウト",
    "logout.cancel": "キャンセル",
    "logout.done": "ログアウトしました",

    // --- チャット ---
    "chat.placeholder": "セリフ",
    "chat.send": "送信",

    // --- 表示名 ---
    "displayname.title": "表示名設定",
    "displayname.label": "ユーザID",
    "displayname.placeholder.disabled": "ログイン後に入力",
    "displayname.placeholder.enabled": "表示名を入力して下さい！",
    "displayname.btn": "変更",
    "displayname.maxlen": "表示名は20文字以内です。",
    "displayname.control_char": "✗ 制御文字は使えません",
    "displayname.need_login": "先にログインしてください",
    "displayname.success": "✓ 表示名変更しました！",

    // --- メニュー ---
    "menu.serversettings": "サーバ設定",
    "menu.serverlog": "サーバ接続ログ",
    "menu.userlist": "プレイヤーリスト",
    "menu.chathistory": "チャット履歴",
    "menu.chatsettings": "チャット設定",
    "menu.bookmarks": "ブックマーク",
    "menu.rooms": "部屋一覧",
    "menu.ping": "Ping グラフ",
    "menu.ccu": "同接グラフ",
    "menu.minimap": "ミニマップ",
    "menu.about": "tommieChatについて",
    "menu.debug": "デバッグツール",
    "menu.cookie_reset": "全パネル非表示（クッキー初期化）",
    "menu.displayname": "表示名設定",

    // --- サーバ設定 ---
    "server.title": "サーバ設定",
    "server.info": "サーバ情報",
    "server.http_ping": "HTTP応答",
    "server.rpc_ping": "RPC応答",

    // --- サーバ接続ログ ---
    "serverlog.title": "サーバ接続ログ",

    // --- プレイヤーリスト ---
    "userlist.title": "プレイヤーリスト",
    "userlist.th.user": "ユーザID",
    "userlist.th.dname": "表示名",
    "userlist.th.uuid": "アカウントID",
    "userlist.th.channel": "チャンネル",
    "userlist.th.login_elapsed": "ログイン時間",
    "userlist.th.login_time": "ログイン時刻",

    // --- チャット履歴 ---
    "chathistory.title": "チャット履歴",

    // --- Ping / CCU ---
    "ping.title": "Ping グラフ",
    "ccu.title": "同接グラフ",

    // --- About パネル ---
    "about.title": "tommieChatについて",
    "about.date_label": "更新日",
    "about.controls": "操作方法",
    "about.move": "移動:",
    "about.camera_rotate": "カメラ回転:",
    "about.camera_pan": "カメラパン:",
    "about.zoom": "ズーム:",
    "about.send_msg": "セリフ送信:",
    "about.newline": "セリフ改行:",
    "about.pc.move": "地面を左クリック",
    "about.pc.camera_rotate": "左ドラッグ",
    "about.pc.camera_pan": "右ドラッグ",
    "about.pc.zoom": "マウスホイール",
    "about.sp.move": "地面をタップ",
    "about.sp.camera_rotate": "1本指ドラッグ",
    "about.sp.zoom": "ピンチイン/アウト",
    "about.send_key": "Enter",
    "about.send_key_sp": "Enter / 送信ボタン",
    "about.newline_key": "Shift+Enter",
    "about.email_label": "メール",
    "about.disclaimer": "本ソフトウェアは現状のまま（AS IS）提供され、一切の保証はありません。<br>本ソフトウェアの使用により生じたいかなる損害についても、作者は責任を負いません。",
    "about.support": "このプロジェクトの開発を支援していただける方を募集しています。<br>We are looking for contributors to support the development of this project.<br>☕ 開発支援（準備中）",

    // --- 接続状態 ---
    "connection.lost": "サーバに接続できません — 再接続を試みています…",
    "connection.restored": "✓回線復帰",
    "connection.disconnected": "✗回線切断",

    // --- サーバログラベル ---
    "log.login_success": "ログイン成功",
    "log.login_failed": "ログイン失敗",
    "log.logout": "ログアウト",
    "log.match_disconnect": "マッチ切断",
    "log.match_disconnect.detail": "WebSocket切断 — 自動再接続中…",
    "log.match_reconnect": "マッチ再接続",
    "log.match_reconnect.detail": "WebSocket復帰",
    "log.network_disconnect": "回線切断",
    "log.network_disconnect.detail": "ネットワーク障害またはサーバ停止により切断されました",
    "log.network_restored": "回線復帰",
    "log.displayname_change": "表示名変更",
    "log.displayname_set": "表示名を「{name}」に設定しました",
    "log.displayname_failed": "表示名変更失敗",
    "log.http_testing": "HTTP応答を実行中…",
    "log.http_success": "サーバへ接続成功しました。 HTTP応答: {ms}ms",
    "log.rpc_testing": "RPC応答を実行中…",
    "log.rpc_success": "NakamaサーバへPing(RPC)が成功しました。 RPC応答: {ms}ms",

    // --- エラーヒント ---
    "error.not_found": "サーバに接続できません。サーバが動いていないか、URLかポート番号が間違っている可能性があります。",
    "error.bad_url": "URLの形式が違います。",
    "error.fetch_failed": "サーバが稼働していないか、サーバが停止している可能性があります。",
    "error.username_conflict": "この名前は既に別の認証方式で使用されています。別の名前を試してください。",
    "error.too_many_logins": "サーバが混雑しています。しばらく待ってから再接続してください。",

    // --- システムメッセージ ---
    "system.user_joined": "{username}がログインしました。",
    "system.user_left": "{username}がログアウトしました。",
    "system.user_world_move": "{username}が退室しました。",
    "system.user_world_enter": "{username}が入室しました。",

    // --- ビルドモード ---
    "buildmode.indicator": "🔨 ビルドモード（B/ESCキーで解除）",
    "buildmode.indicator.click": "🔨 ビルドモード（B/ESC/クリックで解除）",

    // --- デバッグツール ラベル ---
    "dbg.02c": "1.表示行数",
    "dbg.02d": "2.背景",
    "dbg.02e": "3.文字",
    "dbg.02e2": "4.時刻色",
    "dbg.02e3": "5.自分の名前色",
    "dbg.02f": "6.折返",
    "dbg.28e": "28e.AOI表示",
    "dbg.aw.start": "始点",
    "dbg.aw.size": "サイズ",
    // テーマ
    "dbg.theme.pop1": "ポップ１",
    "dbg.theme.dark": "背景黒",
    // 行数 option
    "dbg.ol.0": "0 (非表示)",
    "dbg.ol.3": "3行",
    "dbg.ol.5": "5行",
    "dbg.ol.8": "8行",
    "dbg.ol.10": "10行",
    "dbg.ol.15": "15行",
    "dbg.ol.20": "20行",
    // フォントサイズ option
    "dbg.font.9": "すごく小さい",
    "dbg.font.11": "小さい",
    "dbg.font.12": "少し小さい",
    "dbg.font.13": "普通",
    "dbg.font.15": "少し大きい",
    "dbg.font.18": "大きい",
    "dbg.font.22": "すごく大きい",
    // Scale option
    "dbg.scale.050": "0.50 Retina/4K クッキリ",
    "dbg.scale.100": "1.00 通常モニター",
    "dbg.scale.200": "2.00 解像度50%",
    // AOI
    "dbg.aoi.256": "256 (全域)",

    // プロファイル
    "dbg.profiling": "計測中",

    // --- Ping グラフ ---
    "ping.disconnected": "回線切断中",

    // --- 言語 ---
    "lang.label": "言語",
} as const;
