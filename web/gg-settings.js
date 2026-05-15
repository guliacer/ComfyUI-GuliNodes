import { app } from "../../scripts/app.js";

const SETTINGS_ID = "GuliNodes";

app.registerExtension({
    name: "ComfyUI.GGNodes.Settings",

    settings: [
        {
            id: `${SETTINGS_ID}.enableToolbar`,
            category: ["GuliNodes", "\u5de5\u5177\u680f"],
            name: "\u5de5\u5177\u680f",
            type: "boolean",
            defaultValue: true,
            tooltip: "\u662f\u5426\u5728\u753b\u5e03\u5e95\u90e8\u663e\u793a\u8282\u70b9\u989c\u8272/\u5c3a\u5bf8/\u5bf9\u9f50\u5de5\u5177\u680f",
            onChange: (value) => { window.__ggApplyToolbar?.(value); },
        },
        {
            id: `${SETTINGS_ID}.enableFloatButtons`,
            category: ["GuliNodes", "\u6587\u672c\u6846\u60ac\u6d6e\u6309\u94ae"],
            name: "\u6587\u672c\u6846\u60ac\u6d6e\u6309\u94ae",
            type: "boolean",
            defaultValue: true,
            tooltip: "\u662f\u5426\u81ea\u52a8\u8bc6\u522b\u753b\u5e03\u4e2d\u6240\u6709\u6587\u672c\u6846\uff0c\u9f20\u6807\u60ac\u6d6e\u65f6\u663e\u793a\u590d\u5236/\u7c98\u8d34/\u6e05\u7a7a\u6309\u94ae",
            onChange: (value) => { window.__ggApplyFloatButtons?.(value); },
        },
    ],
});
