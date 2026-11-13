# -*- coding: utf-8 -*-
import io, sys
def read(p): return io.open(p, encoding="utf-8").read()
def write(p, s): io.open(p, "w", encoding="utf-8", newline="").write(s)
def sub1(s, old, new, label):
    n = s.count(old)
    if n != 1:
        print("FAIL", label, "count=", n); sys.exit(1)
    return s.replace(old, new)

p = "web/gg-ui-design.js"
s = read(p)

# 1) 令牌：关闭态中性色（设计稿第 2 页 ·02/·03）
s = sub1(s, "    pressBg: \"#1A2130\",\n  },", "    pressBg: \"#1A2130\",\n    idle: \"#9BA8BC\",\n  },", "dark idle")
s = sub1(s, "    pressBg: \"#DCE5F1\",\n  },", "    pressBg: \"#DCE5F1\",\n    idle: \"#5B6A82\",\n  },", "light idle")
s = sub1(s, "  pressBg: \"--gg-ui-press-bg\",\n};", "  pressBg: \"--gg-ui-press-bg\",\n  idle: \"--gg-idle\",\n};", "var name")

# 2) 弹层外壳：阴影 / 最大高度 / 滚动条 / 入场动效（设计稿第 5 页 ·07）
s = sub1(s, "  max-height: min(82vh, 700px);", "  max-height: min(calc(100vh - 120px), 700px);", "max-height")
s = sub1(s, "  box-shadow: 0 18px 44px rgba(15, 23, 42, .28);", "  box-shadow: 0 20px 48px -12px rgba(0, 0, 0, .62);", "shadow")
s = sub1(s, """.gg-surface ::-webkit-scrollbar { width: 8px; height: 8px; }""",
""".gg-surface ::-webkit-scrollbar { width: 6px; height: 6px; }""", "scrollbar size")
s = sub1(s, """.gg-surface ::-webkit-scrollbar-track { background: transparent; }""",
""".gg-surface ::-webkit-scrollbar-track { background: transparent; }
/* 上下两端 12px 渐隐：滚动区域边缘不硬切 */
.gg-surface ::-webkit-scrollbar-button:single-button { height: 12px; background: transparent; }""", "scrollbar fade")

# 3) 开关四态：关=idle 中性，开=accent 底 + 右上 5px 状态点，禁用 34%
s = sub1(s, """  border: 1px solid var(--gg-divider); border-radius: 8px;
  background: transparent; color: var(--gg-muted);
  cursor: pointer;""",
"""  position: relative;
  border: 1px solid var(--gg-divider); border-radius: 8px;
  background: transparent; color: var(--gg-idle, var(--gg-muted));
  cursor: pointer;""", "switch idle")
s = sub1(s, """.gg-switch.is-on,
.gg-switch.gg-state-on,
.gg-switch.active,
.gg-switch[aria-pressed="true"] {
  color: var(--gg-accent);
  background: color-mix(in srgb, var(--gg-accent) 16%, transparent);
  border-color: color-mix(in srgb, var(--gg-accent) 55%, transparent);
}""",
""".gg-switch.is-on,
.gg-switch.gg-state-on,
.gg-switch.active,
.gg-switch[aria-pressed="true"],
.gg-switch[data-on="true"] {
  color: var(--gg-accent);
  background: color-mix(in srgb, var(--gg-accent) 16%, transparent);
  border-color: color-mix(in srgb, var(--gg-accent) 55%, transparent);
}
/* 开启的第三个信号：右上角 5px 状态点。只靠底色时深浅两套都不够一眼 */
.gg-switch.is-on::after,
.gg-switch.gg-state-on::after,
.gg-switch.active::after,
.gg-switch[aria-pressed="true"]::after,
.gg-switch[data-on="true"]::after {
  content: "";
  position: absolute;
  top: 3px; right: 3px;
  width: 5px; height: 5px;
  border-radius: 50%;
  background: var(--gg-accent);
  box-shadow: 0 0 0 1.5px var(--gg-panel);
  pointer-events: none;
}""", "switch on")
s = sub1(s, """.gg-switch.gg-state-off { color: var(--gg-muted); background: transparent; border-color: var(--gg-divider); }""",
""".gg-switch.gg-state-off { color: var(--gg-idle, var(--gg-muted)); background: transparent; border-color: var(--gg-divider); }""", "switch off")
s = sub1(s, """.gg-switch:disabled { opacity: .42; cursor: default; }
.gg-switch:disabled:hover { color: var(--gg-muted); background: transparent; }""",
""".gg-switch:disabled { opacity: .34; cursor: default; }
.gg-switch:disabled:hover { color: var(--gg-idle, var(--gg-muted)); background: transparent; }
.gg-switch:disabled::after { display: none; }
/* 键盘焦点：与「开启」共用 accent，但只描环不换底（设计稿第 2 页 ·06） */
.gg-switch:focus-visible { outline: 2px solid var(--gg-accent); outline-offset: 2px; }""", "switch disabled")

# 4) 弹层入场：120ms opacity + translateY
s = sub1(s, """  font-size: 12px;
}
/* 设计稿 18:2124 规格表：菜单类面板统一 320 宽""",
"""  font-size: 12px;
  animation: gg-popover-in .12s ease-out;
}
@keyframes gg-popover-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .gg-popover { animation: none; }
}
/* 设计稿 18:2124 规格表：菜单类面板统一 320 宽""", "popover anim")

write(p, s)
print("ok gg-ui-design.js")
