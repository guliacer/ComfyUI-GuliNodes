# -*- coding: utf-8 -*-
import io, re, sys

def read(p):
    return io.open(p, encoding="utf-8").read()

def write(p, s):
    io.open(p, "w", encoding="utf-8", newline="").write(s)

def sub1(s, old, new, label):
    n = s.count(old)
    if n != 1:
        print("FAIL", label, "count=", n)
        sys.exit(1)
    return s.replace(old, new)

# ---------------- gg-ui-icons.js ----------------
p = "web/gg-ui-icons.js"
s = read(p)

# 1) 单一路径描边：取消一切实心填充
s = s.replace(' class="gg-ui-fill"', "")
s = sub1(s, "stroke-width: 2.15;", "stroke-width: 2;", "icon stroke")
s = sub1(s, """        .gg-ui-icon .gg-ui-fill {
            fill: currentColor;
            stroke: none;
        }
""", "", "remove fill rule")

# 2) 新增图标（工作流 / 模式卡 / 效果池）
anchor = "    folder: '"
new_icons = """    subworkflow: '<rect x="3" y="5" width="10.5" height="9" rx="2"/><path d="M14 9.5h3.2"/><path d="M16 7.2v4.6"/><path d="M19.6 9.5h1.4"/><path d="M6.5 8.5h4"/><path d="M6.5 11h2.6"/><path d="M17.4 15.6l2.6 2.6"/><path d="M20 15.6l-2.6 2.6"/>',
    modeAuto: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M18.5 16.2l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8.8-2.1z"/>',
    modeManual: '<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 12h4"/><path d="M12 12h8"/><circle cx="10" cy="12" r="2"/><path d="M4 17h8"/><path d="M16 17h4"/><circle cx="14" cy="17" r="2"/>',
    modeRandom: '<rect x="3.5" y="4.5" width="17" height="15" rx="3.5"/><circle cx="8.4" cy="9.2" r="1.25"/><circle cx="15.6" cy="9.2" r="1.25"/><circle cx="12" cy="12.1" r="1.25"/><circle cx="8.4" cy="14.9" r="1.25"/><circle cx="15.6" cy="14.9" r="1.25"/>',
    effectPool: '<path d="M6.2 4.5v5.4"/><path d="M3.5 7.2h5.4"/><path d="M17.4 13.4v5.2"/><path d="M14.8 16h5.2"/><circle cx="6.2" cy="18" r="1.2"/><circle cx="18" cy="6" r="1.2"/>',
"""
s = sub1(s, anchor, new_icons + anchor, "add icons")
write(p, s)
print("ok gg-ui-icons.js")
