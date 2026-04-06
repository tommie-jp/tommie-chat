/** 34.AutoChat で使用するメッセージ一覧 */
export const autoChatMessages: { text: string; aa?: boolean }[] = [
    // 1行 短め
    { text: "こんにちは！⭐️" }, { text: "今日もいい天気だね。" }, { text: "何か面白いことある？" },
    { text: "ここは好きな場所だよ。" }, { text: "また会えたね！" }, { text: "ちょっと疲れたな〜" },
    { text: "このあたりは静かでいいね。" }, { text: "どこから来たの？" }, { text: "冒険に出かけようよ！" },
    { text: "今日のランチは何だろう？" }, { text: "やっほー！" }, { text: "w" }, { text: "おつ" },
    { text: "よろしく！" }, { text: "なるほど〜" }, { text: "それな" }, { text: "うける" },
    // 1行 長め
    { text: "今日はとても良い天気で散歩日和ですね！みんなでピクニックに行きませんか？" },
    { text: "このワールドは広くて色々な場所があるから探検するのが楽しいよね！！" },
    { text: "あのさあ、昨日見つけた秘密の場所に案内してあげようか？すごく景色がいいところなんだよ" },
    { text: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn" },
    // 2行
    { text: "おはよう！\n今日も一日がんばろう！" },
    { text: "ねえねえ、聞いて！\nさっき面白いもの見つけたよ！" },
    { text: "お腹すいた〜\nどこかにレストランないかな？" },
    // 3行
    { text: "今日の予定：\n午前：探検\n午後：建築" },
    { text: "やあ！元気？\n最近どうしてた？\nまた一緒に遊ぼうよ！" },
    { text: "注意事項\nここから先は危険地帯です\n十分気をつけてください" },
    // 最大行（5行）
    { text: "本日のお知らせ\n新しいエリアが追加されました\n東の森の奥に洞窟があります\n宝箱が隠されているらしい\nみんなで探しに行こう！" },
    { text: "第1回チャット大会\n日時：今日の15時〜\n場所：中央広場\n参加費：無料\nたくさんの参加お待ちしてます！" },
    // 英文
    { text: "Hi!" }, { text: "Hello there!" }, { text: "GG" }, { text: "lol" }, { text: "brb" },
    { text: "Nice to meet you! Welcome to the world!" },
    { text: "What a beautiful day for an adventure, don't you think?" },
    { text: "Hey, have you seen the new area?\nIt's really cool!" },
    { text: "Pro tip:\nDon't forget to save\nbefore you explore!" },
    { text: "Welcome to tommieChat!\nFeel free to look around\nMeet new friends\nBuild something cool\nHave fun!" },
    // 顔文字・エモーション
    { text: "(´・ω・｀)" }, { text: "ｷﾀ━━━(ﾟ∀ﾟ)━━━!!" }, { text: "(；´Д｀)" }, { text: "( ﾟДﾟ)ﾊｧ?" },
    { text: "ﾜﾛﾀwww" }, { text: "(´;ω;｀)ﾌﾞﾜｯ" }, { text: "( ´∀｀)σ)∀`)" }, { text: "m9(^Д^)ﾌﾟｷﾞｬｰ" },
    { text: "orz" }, { text: "(ノ∀`)ｱﾁｬｰ" }, { text: "( ^ω^)おっ" }, { text: "＼(^o^)／ｵﾜﾀ" },
    { text: "ちょwwおまwww" }, { text: "ぬるぽ" }, { text: "ｶﾞｯ" },
    { text: "草" }, { text: "草生える🌱" }, { text: "まじかよ😂" }, { text: "つらい😭" },
    { text: "やば〜〜〜✨✨✨" }, { text: "かわいい💕" }, { text: "それめっちゃわかる🥺" },
    { text: "神ゲーすぎん？🔥🔥" }, { text: "え、待って待って😳" }, { text: "うぇーい🍻" },
    { text: "おけまる⭕" }, { text: "りょ👍" }, { text: "あざます🙏" },
    { text: "今日も推しが尊い🙏✨" }, { text: "ガチで草なんだがwww" },
    { text: "は？ﾏｼﾞ？\nまじだった(´・ω・｀)" },
    { text: "速報🚨\nワイ、ログインに成功🎉\nなお何もすることがない模様😇" },
    // 境界値テスト
    { text: "a" },                                                    // 1文字（最小幅）
    { text: "1234567890123456789012345678901234567890" },              // 40文字ちょうど（MAX_CHARS境界）
    { text: "12345678901234567890123456789012345678901" },             // 41文字（...切り詰め確認）
    { text: " " },                                                    // 空白のみ（非表示になるか）
    { text: "1234567890123456789012345678901234567890\n1234567890123456789012345678901234567890\n1234567890123456789012345678901234567890\n1234567890123456789012345678901234567890\n1234567890123456789012345678901234567890" },  // 5行×40文字（最大面積）
    // レンダリング確認
    { text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz" }, // 半角英数長文
    { text: "■□●○◆◇★☆♪♫〒〶※†‡§¶" },                                // 全角記号
    { text: "🏴\u200D☠️👨\u200D👩\u200D👧\u200D👦🇯🇵🏳️\u200D🌈" },                          // サロゲートペア・複合絵文字
    { text: "Hello世界🌍123！mixed混在テスト" },                       // 混在テスト
    { text: "https://example.com/very/long/path/to/page?q=test" },    // URL
    { text: "wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww" },            // 連続記号
    // AA（アスキーアート）
    { text: "　 ∧＿∧\n（　´∀｀）\n（　　　　）\n｜ ｜　|\n（＿_)＿)", aa: true },
    // 多言語テスト — 中国語（簡体）
    { text: "(Chinese)你好！" }, { text: "(Chinese)欢迎来到这个世界！大家一起玩吧～" },
    { text: "(Chinese)今天天气真好\n我们去探险吧！" },
    // 韓国語
    { text: "(Korean)안녕하세요!" }, { text: "(Korean)여기 정말 재미있어요! 같이 놀아요～" },
    { text: "(Korean)오늘의 공지\n새로운 지역이 추가되었습니다\n많은 참여 부탁드립니다!" },
    // タイ語（結合文字テスト）
    { text: "(Thai)สวัสดีครับ!" }, { text: "(Thai)ยินดีต้อนรับสู่โลกนี้!" },
    { text: "(Thai)วันนี้อากาศดีมาก\nไปผจญภัยกันเถอะ!" },
    // アラビア語（RTLテスト）
    { text: "(Arabic)مرحبا!" }, { text: "(Arabic)أهلاً وسهلاً بكم في هذا العالم!" },
    { text: "(Arabic)إعلان مهم\nتم إضافة منطقة جديدة\nاستمتعوا!" },
    // ヒンディー語（デーヴァナーガリー・リガチャテスト）
    { text: "(Hindi)नमस्ते!" }, { text: "(Hindi)इस दुनिया में आपका स्वागत है!" },
    { text: "(Hindi)आज का मौसम बहुत अच्छा है\nचलो साहसिक यात्रा पर चलते हैं!" },
];
