// Captured from the Python runtime (image_generation.py, voice_switching.py) at fixed clocks and
// inputs, so a drift in any prompt or tool text fails a test.

export const VOICE_SCHEMA_WIRE =
  '[{"type": "function", "function": {"name": "change_voice_style", "description": "切换主播声线风格。**只在奶糖花明确要求换声音时调用** —— 例如『声音温柔一点』『换个活泼的』『换回原来的声音』。不要主动切换，不要在打招呼时切换；只在用户表达想换声音时调用。切换后用一两句话自然回应（『嗯，这样可以嘛』），不要照念工具名。", "parameters": {"type": "object", "properties": {"style": {"type": "string", "description": "声线名称。`default` (默认/原来的/正常的声音); `gentle` (温柔/温和/轻柔/温暖/柔一点); `lively` (活泼/精神/有活力/欢快/明亮/营业声线); `nai_hei` (nai_hei)。", "enum": ["default", "gentle", "lively", "nai_hei"]}}, "required": ["style"]}}}]';

export const VOICE_SCHEMA_WIRE_UNHINTED =
  '[{"type": "function", "function": {"name": "change_voice_style", "description": "切换主播声线风格。**只在奶糖花明确要求换声音时调用** —— 例如『声音温柔一点』『换个活泼的』『换回原来的声音』。不要主动切换，不要在打招呼时切换；只在用户表达想换声音时调用。切换后用一两句话自然回应（『嗯，这样可以嘛』），不要照念工具名。", "parameters": {"type": "object", "properties": {"style": {"type": "string", "description": "声线名称。`Z` (Z); `calm` (平静/冷静/沉稳); `constructor` (constructor); `default` (默认/原来的/正常的声音)。", "enum": ["Z", "calm", "constructor", "default"]}}, "required": ["style"]}}}]';

export const SELFIE_SCHEMA_WIRE =
  '[{"type": "function", "function": {"name": "take_selfie", "description": "给奶糖花拍一张自拍照，直接发到她屏幕上。奶糖花要看照片、要自拍、说想看看你的时候就调用 —— 例如『发张自拍』『拍张照片』『让我看看你』。**这是唯一能把照片发出去的方式，被要求了就不要拒绝，也不要说自己拍不了、走不开、没相机。**可以一边调侃一边答应（『就知道你想看』），但必须真的调用。她没提照片的时候不要主动调用。拍一张要十几秒，调用后先自然地说一句『等我一下』之类的；不要照念工具名，也不要念出链接或文件名。", "parameters": {"type": "object", "properties": {}, "required": []}}}]';

export const SELFIE_SCHEMA_WIRE_FRIEND =
  '[{"type": "function", "function": {"name": "take_selfie", "description": "给奶糖花拍一张自拍照，直接发到她屏幕上。奶糖花要看照片、要自拍、说想看看你的时候就调用 —— 例如『发张自拍』『拍张照片』『让我看看你』。**这是唯一能把照片发出去的方式，被要求了就不要拒绝，也不要说自己拍不了、走不开、没相机。**可以一边调侃一边答应（『就知道你想看』），但必须真的调用。她没提照片的时候不要主动调用。拍一张要十几秒，调用后先自然地说一句『等我一下』之类的；不要照念工具名，也不要念出链接或文件名。", "parameters": {"type": "object", "properties": {"with_friends": {"type": "array", "items": {"type": "string", "enum": ["七海Nana7mi"]}, "description": "同框的朋友。**只有当你确实知道自己正和她们在外面时才填** —— 比如记忆或刚才的对话里提到今天一起出门、正在逛街吃饭。不确定、只是聊到过这个人、或者你在家，就留空。填了就会画成在外面的合照。"}}, "required": []}}}]';

export const VOICE_HINT =
  "如果奶糖花明确要求换声音（『温柔一点』『换个声音』『换回原来的』之类），调用 change_voice_style 工具，参数 style 可选：default、gentle、lively、nai_hei。不要主动切换；平时保持默认声线。";

export const VOICE_HINT_WITHOUT_DEFAULT =
  "如果奶糖花明确要求换声音（『温柔一点』『换个声音』『换回原来的』之类），调用 change_voice_style 工具，参数 style 可选：default、calm、gentle。不要主动切换；平时保持默认声线。";

export const SELFIE_HINT_FRIEND =
  "奶糖花要看照片 / 要自拍 / 说想看看你（『发张自拍』『让我看看你』『来张照片』之类），一定要调用 take_selfie 工具，这是唯一能把照片发出去的方式。你可以一边调侃一边拍（『就知道你想看』『只此一张啊』），但不能用『想得美』『不给看』之类的话搪塞过去，也不能说自己拍不了或者走不开。拍照要十几秒，调用后先说一句让对方等一下，照片会自动出现在对方屏幕上。她没提照片时不要主动拍，也不要念出图片链接或文件名。\n如果你记得或者刚才聊到今天正和朋友在外面（一起逛街、吃饭、出门玩），拍照时把她们填进 with_friends 参数，可选：七海Nana7mi，拍出来就是在外面的合照。不确定、或者你人在家，就不要填。";

/** [arguments, events] with styles {default: refdefault0000, gentle: refgentle0000} */
export const VOICE_ROWS: [Record<string, unknown>, unknown[][]][] = [
  [
    { style: " Gentle " },
    [
      ["push", "TTSUpdateSettingsFrame", "refgentle0000"],
      ["result", { ok: true, style: "gentle" }],
    ],
  ],
  [
    { style: "xyz" },
    [["result", { ok: false, error: "unknown style 'xyz'", available: ["default", "gentle"] }]],
  ],
  [{}, [["result", { ok: false, error: "unknown style None", available: ["default", "gentle"] }]]],
  [
    { style: null },
    [["result", { ok: false, error: "unknown style None", available: ["default", "gentle"] }]],
  ],
  [
    { style: 5 },
    [["result", { ok: false, error: "unknown style 5", available: ["default", "gentle"] }]],
  ],
  [
    { style: "it's" },
    [["result", { ok: false, error: 'unknown style "it\'s"', available: ["default", "gentle"] }]],
  ],
  [
    { style: ["gentle"] },
    [
      [
        "result",
        { ok: false, error: "unknown style ['gentle']", available: ["default", "gentle"] },
      ],
    ],
  ],
  [
    { style: true },
    [["result", { ok: false, error: "unknown style True", available: ["default", "gentle"] }]],
  ],
  [
    { style: { a: 1 } },
    [["result", { ok: false, error: "unknown style {'a': 1}", available: ["default", "gentle"] }]],
  ],
  [
    { style: "default" },
    [
      ["push", "TTSUpdateSettingsFrame", "refdefault0000"],
      ["result", { ok: true, style: "default" }],
    ],
  ],
  [
    { style: "　GENTLE\u001c" },
    [
      ["push", "TTSUpdateSettingsFrame", "refgentle0000"],
      ["result", { ok: true, style: "gentle" }],
    ],
  ],
  [
    { style: 'say "hi"' },
    [
      [
        "result",
        { ok: false, error: "unknown style 'say \"hi\"'", available: ["default", "gentle"] },
      ],
    ],
  ],
  [
    { style: "both ' and \"" },
    [
      [
        "result",
        { ok: false, error: "unknown style 'both \\' and \"'", available: ["default", "gentle"] },
      ],
    ],
  ],
];
