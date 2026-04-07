import type { ja } from "./ja";

export const en: Record<keyof typeof ja, string> = {
    // --- Login ---
    "login.label": "User ID",
    "login.placeholder": "Enter User ID",
    "login.btn": "Login",
    "login.connecting": "Connecting…",
    "login.success": "✓ Login successful",
    "login.failed": "✗ Login failed: ",
    "login.validation.short": "Enter a name (6+ characters)",
    "login.validation.chars": "✗ Invalid characters. Allowed: alphanumeric, . _ @ + - (6–128 chars)",

    // --- Logout ---
    "logout": "Logout",
    "logout.confirm": "Are you sure you want to logout?",
    "logout.btn": "Logout",
    "logout.cancel": "Cancel",
    "logout.done": "Logged out",

    // --- Chat ---
    "chat.placeholder": "Message",
    "chat.send": "Send",

    // --- Display Name ---
    "displayname.title": "Display Name",
    "displayname.label": "User ID",
    "displayname.placeholder.disabled": "Login first",
    "displayname.placeholder.enabled": "Enter display name",
    "displayname.btn": "Change",
    "displayname.maxlen": "Display name must be 20 characters or less.",
    "displayname.control_char": "✗ Control characters are not allowed",
    "displayname.need_login": "Please login first",
    "displayname.success": "✓ Display name changed!",

    // --- Menu ---
    "menu.serversettings": "Server Settings",
    "menu.serverlog": "Server Log",
    "menu.userlist": "Player List",
    "menu.chathistory": "Chat History",
    "menu.chatsettings": "Chat Settings",
    "menu.bookmarks": "Bookmarks",
    "menu.rooms": "Rooms",
    "menu.ping": "Ping Graph",
    "menu.ccu": "CCU Graph",
    "menu.minimap": "Minimap",
    "menu.about": "About tommieChat",
    "menu.debug": "Debug Tools",
    "menu.cookie_reset": "Hide all panels (reset cookies)",
    "menu.displayname": "Display Name",

    // --- Server Settings ---
    "server.title": "Server Settings",
    "server.info": "Server Info",
    "server.http_ping": "HTTP Ping",
    "server.rpc_ping": "RPC Ping",

    // --- Server Log ---
    "serverlog.title": "Server Log",

    // --- Player List ---
    "userlist.title": "Player List",
    "userlist.th.user": "User ID",
    "userlist.th.dname": "Display Name",
    "userlist.th.uuid": "Account ID",
    "userlist.th.channel": "Channel",
    "userlist.th.login_elapsed": "Uptime",
    "userlist.th.login_time": "Login Time",

    // --- Chat History ---
    "chathistory.title": "Chat History",

    // --- Ping / CCU ---
    "ping.title": "Ping Graph",
    "ccu.title": "CCU Graph",

    // --- About Panel ---
    "about.title": "About tommieChat",
    "about.date_label": "Updated",
    "about.controls": "Controls",
    "about.move": "Move:",
    "about.camera_rotate": "Camera Rotate:",
    "about.camera_pan": "Camera Pan:",
    "about.zoom": "Zoom:",
    "about.send_msg": "Send Message:",
    "about.newline": "New Line:",
    "about.pc.move": "Left-click on ground",
    "about.pc.camera_rotate": "Left drag",
    "about.pc.camera_pan": "Right drag",
    "about.pc.zoom": "Mouse wheel",
    "about.sp.move": "Tap on ground",
    "about.sp.camera_rotate": "1-finger drag",
    "about.sp.zoom": "Pinch in/out",
    "about.send_key": "Enter",
    "about.send_key_sp": "Enter / Send button",
    "about.newline_key": "Shift+Enter",
    "about.email_label": "Email",
    "about.disclaimer": "This software is provided \"AS IS\" without warranty of any kind.<br>The author is not liable for any damages arising from the use of this software.",
    "about.support": "We are looking for contributors to support the development of this project.<br>☕ Support development (coming soon)",

    // --- Connection ---
    "connection.lost": "Cannot connect to server — retrying…",
    "connection.restored": "✓ Reconnected",
    "connection.disconnected": "✗ Disconnected",

    // --- Server Log Labels ---
    "log.login_success": "Login OK",
    "log.login_failed": "Login Failed",
    "log.logout": "Logout",
    "log.match_disconnect": "Match Lost",
    "log.match_disconnect.detail": "WebSocket disconnected — auto-reconnecting…",
    "log.match_reconnect": "Match Reconnect",
    "log.match_reconnect.detail": "WebSocket restored",
    "log.network_disconnect": "Network Lost",
    "log.network_disconnect.detail": "Disconnected due to network failure or server shutdown",
    "log.network_restored": "Network Restored",
    "log.displayname_change": "Name Changed",
    "log.displayname_set": "Display name set to \"{name}\"",
    "log.displayname_failed": "Name Change Failed",
    "log.http_testing": "Testing HTTP…",
    "log.http_success": "Server connected. HTTP response: {ms}ms",
    "log.rpc_testing": "Testing RPC…",
    "log.rpc_success": "Nakama RPC ping succeeded. Response: {ms}ms",

    // --- Error Hints ---
    "error.not_found": "Cannot connect to server. The server may be down or the URL/port may be wrong.",
    "error.bad_url": "Invalid URL format.",
    "error.fetch_failed": "Server may not be running or is currently down.",
    "error.username_conflict": "This name is already used with a different auth method. Please try another name.",
    "error.too_many_logins": "Server is busy. Please wait and try again.",

    // --- System Messages ---
    "system.user_joined": "{username} joined.",
    "system.user_left": "{username} left.",
    "system.user_world_move": "{username} left the room.",
    "system.user_world_enter": "{username} entered the room.",

    // --- Build Mode ---
    "buildmode.indicator": "🔨 Build Mode (B/ESC to exit)",
    "buildmode.indicator.click": "🔨 Build Mode (B/ESC/click to exit)",

    // --- Debug Tool Labels ---
    "dbg.02c": "1.Display Lines",
    "dbg.02d": "2.BG",
    "dbg.02e": "3.Font",
    "dbg.02e2": "4.Time",
    "dbg.02e3": "5.My Name Color",
    "dbg.02f": "6.Wrap",
    "dbg.28e": "28e.AOI Vis",
    "dbg.aw.start": "Start",
    "dbg.aw.size": "Size",
    // Theme
    "dbg.theme.pop1": "Pop 1",
    "dbg.theme.dark": "Dark",
    // Lines option
    "dbg.ol.0": "0 (hidden)",
    "dbg.ol.3": "3 lines",
    "dbg.ol.5": "5 lines",
    "dbg.ol.8": "8 lines",
    "dbg.ol.10": "10 lines",
    "dbg.ol.15": "15 lines",
    "dbg.ol.20": "20 lines",
    // Font size option
    "dbg.font.9": "Tiny",
    "dbg.font.11": "Small",
    "dbg.font.12": "Slightly small",
    "dbg.font.13": "Normal",
    "dbg.font.15": "Slightly large",
    "dbg.font.18": "Large",
    "dbg.font.22": "Huge",
    // Scale option
    "dbg.scale.050": "0.50 Retina/4K crisp",
    "dbg.scale.100": "1.00 Standard",
    "dbg.scale.200": "2.00 Half res",
    // AOI
    "dbg.aoi.256": "256 (Full)",

    // Profile
    "dbg.profiling": "Profiling",

    // --- Ping Graph ---
    "ping.disconnected": "Disconnected",

    // --- Language ---
    "lang.label": "Language",
} as const;
