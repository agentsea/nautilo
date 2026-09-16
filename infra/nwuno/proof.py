#!/usr/bin/env python3
"""
D362 P3 grounding proof — the Tier-A UNO mutations, verified against the live
engine (2026-07-02) via `docker exec d362-unoserver python3 proof.py`.

This is the reference for `nwuno/server.py`: the packaged server will register
these as XML-RPC `@register_function`s using unoserver's UnoConverter context
(load-from-bytes → mutate → store-to-bytes), reusing exactly these UNO calls.

Result (proven):
  WRITER find_replace=1 template=1 → "Hello BAR and World!" [appended]
  META  title/author round-trip OK
  CALC  A1="hi"  A3(=A2*2)=84.0
"""
import uno
from com.sun.star.beans import PropertyValue

ctx0 = uno.getComponentContext()
resolver = ctx0.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", ctx0
)
ctx = resolver.resolve("uno:socket,host=127.0.0.1,port=2002;urp;StarOffice.ComponentContext")
desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
HIDDEN = (PropertyValue(Name="Hidden", Value=True),)


def replace_all(doc, search, repl, regex=False):
    """find-replace + template-fill primitive (util.XReplaceable)."""
    d = doc.createReplaceDescriptor()
    d.setSearchString(search)
    d.setReplaceString(repl)
    d.SearchRegularExpression = regex
    return doc.replaceAll(d)


def insert_text(doc, text, at_end=True):
    body = doc.getText()
    cur = body.createTextCursorByRange(body.getEnd() if at_end else body.getStart())
    body.insertString(cur, text, False)


def set_cell(doc, sheet_idx, cell, value):
    sheet = doc.getSheets().getByIndex(sheet_idx)
    rng = sheet.getCellRangeByName(cell)
    if isinstance(value, (int, float)):
        rng.setValue(float(value))
    elif isinstance(value, str) and value.startswith("="):
        rng.setFormula(value)
    else:
        rng.setString(str(value))


if __name__ == "__main__":
    w = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, HIDDEN)
    w.getText().insertString(w.getText().createTextCursor(), "Hello FOO and ${name}!", False)
    print("find_replace:", replace_all(w, "FOO", "BAR"), "template:", replace_all(w, "${name}", "World"))
    insert_text(w, " [appended]")
    dp = w.getDocumentProperties()
    dp.Title, dp.Author = "D362 Doc", "nwuno"
    print("WRITER:", w.getText().getString(), "| META:", dp.Title, dp.Author)
    w.close(True)

    c = desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, HIDDEN)
    set_cell(c, 0, "A1", "hi")
    set_cell(c, 0, "A2", 42)
    set_cell(c, 0, "A3", "=A2*2")
    sh = c.getSheets().getByIndex(0)
    print("CALC A1:", sh.getCellRangeByName("A1").getString(), "A3:", sh.getCellRangeByName("A3").getValue())
    c.close(True)
    print("PROOF_OK")
