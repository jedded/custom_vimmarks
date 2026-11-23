#!/usr/bin/env python3
"""Write the built-in key bindings into package.json (contributes.keybindings).

Run after editing this file:  python3 scripts/gen_keybindings.py
"""
import json
import os
import string

root = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
path = os.path.join(root, "package.json")
pkg = json.load(open(path, encoding="utf-8"))

LETTERS = string.ascii_lowercase + string.ascii_uppercase

# Same style as the user's existing ", x" chords: only active in VSCodeVim normal mode.
WHEN_EDITOR = "editorTextFocus && vim.active && vim.mode == 'Normal'"
WHEN_ANY = "vim.active && vim.mode == 'Normal'"
# Ctrl+Alt chords: the first key never types text and is not a Vim key, so they work with
# or without VSCodeVim and in every Vim mode.
WHEN_ALWAYS = "editorTextFocus"


def key_name(letter):
    # VS Code writes upper-case letters as shift+<letter>
    return "shift+" + letter.lower() if letter.isupper() else letter


bindings = []
for l in LETTERS:
    k = key_name(l)
    bindings.append({"key": f"m {k}", "command": "vimMarks.set", "args": l, "when": WHEN_EDITOR})
    bindings.append({"key": f"' {k}", "command": "vimMarks.jump", "args": l, "when": WHEN_EDITOR})
    bindings.append({"key": f"` {k}", "command": "vimMarks.jumpExact", "args": l, "when": WHEN_EDITOR})

bindings.append({"key": ", z", "command": "vimMarks.toggleSort", "when": WHEN_ANY})
bindings.append({"key": ", v", "command": "vimMarks.list.focus", "when": WHEN_ANY})
bindings.append({"key": ", p", "command": "vimMarks.switchProject", "when": WHEN_ANY})

# Without Vim: Ctrl+Alt+K, then the letter (same as m + letter)
for l in LETTERS:
    bindings.append({"key": f"ctrl+alt+k {key_name(l)}", "command": "vimMarks.set", "args": l, "when": WHEN_ALWAYS})

# Without Vim: Ctrl+Alt+J, then the letter (same as ` + letter: back to the exact position)
for l in LETTERS:
    bindings.append({"key": f"ctrl+alt+j {key_name(l)}", "command": "vimMarks.jumpExact", "args": l, "when": WHEN_ALWAYS})

pkg["contributes"]["keybindings"] = bindings
with open(path, "w", encoding="utf-8") as f:
    json.dump(pkg, f, indent=2, ensure_ascii=False)
    f.write("\n")
print("keybindings written:", len(bindings))
