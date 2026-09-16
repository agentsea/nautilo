#!/usr/bin/env python3
"""
nwuno — unoserver fork that adds Tier-A document *mutation* over the same
XML-RPC transport (D362 spec R3/R4). Native `info`/`convert`/`compare` behave
exactly as unoserver; the extended methods reuse unoserver's UnoConverter UNO
context (load-from-bytes → mutate → store-to-bytes).

Mechanics verified live in infra/nwuno/proof.py before packaging.
"""
import argparse
import logging
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.uno import Exception as UnoException

from unoserver import comparer, converter
from unoserver.server import API_VERSION, UnoServer, XMLRPCServer, __version__

logger = logging.getLogger("nwuno")
HIDDEN = (PropertyValue(Name="Hidden", Value=True),)


def _rm(path):
    try:
        os.unlink(path)
    except OSError:
        pass


class NwUnoServer(UnoServer):
    """UnoServer + document-mutation endpoints."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # unoserver 3.4's UnoServer has no temp_dir attribute; our helpers use it.
        if not hasattr(self, "temp_dir"):
            self.temp_dir = None

    def _load(self, data, ext):
        suffix = "." + ext.lstrip(".")
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=self.temp_dir) as f:
            f.write(data)
            path = f.name
        url = uno.systemPathToFileUrl(os.path.abspath(path))
        doc = self.conv.desktop.loadComponentFromURL(url, "_default", 0, HIDDEN)
        if doc is None:
            _rm(path)
            raise RuntimeError("nwuno: could not load document")
        return doc, path

    def _store(self, doc, ext):
        suffix = "." + ext.lstrip(".")
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=self.temp_dir) as f:
            outp = f.name
        try:
            url = uno.systemPathToFileUrl(os.path.abspath(outp))
            import_type = converter.get_doc_type(doc)
            export_type = self.conv.type_service.queryTypeByURL(url)
            filtername = self.conv.find_filter(import_type, export_type)
            if not filtername:
                raise RuntimeError(f"nwuno: no export filter {import_type} → {export_type}")
            props = (
                PropertyValue(Name="FilterName", Value=filtername),
                PropertyValue(Name="Overwrite", Value=True),
            )
            doc.storeToURL(url, props)
            with open(outp, "rb") as fh:
                return fh.read()
        finally:
            _rm(outp)

    def serve(self):
        with XMLRPCServer((self.interface, int(self.port)), allow_none=True) as server:
            # Connect the UNO converter/comparer (retry until soffice is up).
            self.conv = None
            attempts = 20
            while attempts > 0:
                try:
                    self.conv = converter.UnoConverter(
                        interface=self.uno_interface, port=self.uno_port
                    )
                    break
                except UnoException as exc:
                    if "Connection refused" in str(exc):
                        time.sleep(2)
                        attempts -= 1
                        continue
                    attempts -= 4
                    time.sleep(5)
            if self.conv is None:
                logger.critical("nwuno: could not reach LibreOffice, exiting.")
                self.libreoffice_process.terminate()
                return
            self.comp = comparer.UnoComparer(interface=self.uno_interface, port=self.uno_port)
            self.xmlrcp_server = server
            server.register_introspection_functions()
            self.number_of_requests = 0
            conv = self.conv
            comp = self.comp
            outer = self

            def stop_after():
                if self.stop_after is None:
                    return
                self.number_of_requests += 1
                if self.number_of_requests == self.stop_after:
                    self.intentional_exit = True
                    self.libreoffice_process.terminate()

            # ---- native (unoserver-compatible) ---------------------------
            @server.register_function
            def info():
                return {
                    "unoserver": __version__,
                    "api": API_VERSION,
                    "import_filters": conv.get_filter_names(conv.get_available_import_filters()),
                    "export_filters": conv.get_filter_names(conv.get_available_export_filters()),
                }

            @server.register_function
            def convert(inpath=None, indata=None, outpath=None, convert_to=None, filtername=None,
                        filter_options=[], update_index=True, infiltername=None):
                if indata is not None:
                    indata = indata.data
                result = conv.convert(inpath, indata, outpath, convert_to, filtername,
                                      filter_options, update_index, infiltername)
                stop_after()
                return result

            @server.register_function
            def compare(oldpath=None, olddata=None, newpath=None, newdata=None, outpath=None, filetype=None):
                if olddata is not None:
                    olddata = olddata.data
                if newdata is not None:
                    newdata = newdata.data
                result = comp.compare(oldpath, olddata, newpath, newdata, outpath, filetype)
                stop_after()
                return result

            # ---- nwuno extended (Tier-A mutation/read) -------------------
            def _replace(doc, search, repl, regex=False):
                d = doc.createReplaceDescriptor()
                d.setSearchString(search)
                d.setReplaceString(repl)
                d.SearchRegularExpression = regex
                return doc.replaceAll(d)

            @server.register_function
            def find_replace(indata, ext, search, replace, regex=False):
                doc, tmp = outer._load(indata.data, ext)
                try:
                    _replace(doc, search, replace, regex)
                    out = outer._store(doc, ext)
                finally:
                    doc.close(True)
                    _rm(tmp)
                stop_after()
                return out

            @server.register_function
            def template_fill(indata, ext, mapping):
                doc, tmp = outer._load(indata.data, ext)
                try:
                    for key, val in mapping.items():
                        _replace(doc, "${" + key + "}", str(val))
                    out = outer._store(doc, ext)
                finally:
                    doc.close(True)
                    _rm(tmp)
                stop_after()
                return out

            @server.register_function
            def insert_text(indata, ext, text, at_end=True):
                doc, tmp = outer._load(indata.data, ext)
                try:
                    body = doc.getText()
                    cur = body.createTextCursorByRange(body.getEnd() if at_end else body.getStart())
                    body.insertString(cur, text, False)
                    out = outer._store(doc, ext)
                finally:
                    doc.close(True)
                    _rm(tmp)
                stop_after()
                return out

            @server.register_function
            def set_cells(indata, ext, cells):
                doc, tmp = outer._load(indata.data, ext)
                try:
                    sheets = doc.getSheets()
                    for c in cells:
                        sheet = sheets.getByIndex(int(c.get("sheet", 0)))
                        rng = sheet.getCellRangeByName(c["cell"])
                        val = c["value"]
                        if isinstance(val, bool):
                            rng.setValue(1.0 if val else 0.0)
                        elif isinstance(val, (int, float)):
                            rng.setValue(float(val))
                        elif isinstance(val, str) and val.startswith("="):
                            rng.setFormula(val)
                        else:
                            rng.setString(str(val))
                    out = outer._store(doc, ext)
                finally:
                    doc.close(True)
                    _rm(tmp)
                stop_after()
                return out

            @server.register_function
            def set_range(indata, ext, sheet, cellrange, rows):
                doc, tmp = outer._load(indata.data, ext)
                try:
                    sh = doc.getSheets().getByIndex(int(sheet))
                    data = tuple(
                        tuple(
                            float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else str(x)
                            for x in row
                        )
                        for row in rows
                    )
                    sh.getCellRangeByName(cellrange).setDataArray(data)
                    out = outer._store(doc, ext)
                finally:
                    doc.close(True)
                    _rm(tmp)
                stop_after()
                return out

            @server.register_function
            def get_meta(indata, ext):
                doc, tmp = outer._load(indata.data, ext)
                try:
                    dp = doc.getDocumentProperties()
                    return {
                        "title": dp.Title or "",
                        "author": dp.Author or "",
                        "subject": dp.Subject or "",
                        "description": dp.Description or "",
                        "keywords": list(dp.Keywords),
                    }
                finally:
                    doc.close(True)
                    _rm(tmp)

            @server.register_function
            def set_meta(indata, ext, meta):
                doc, tmp = outer._load(indata.data, ext)
                try:
                    dp = doc.getDocumentProperties()
                    if "title" in meta:
                        dp.Title = str(meta["title"])
                    if "author" in meta:
                        dp.Author = str(meta["author"])
                    if "subject" in meta:
                        dp.Subject = str(meta["subject"])
                    if "description" in meta:
                        dp.Description = str(meta["description"])
                    if "keywords" in meta:
                        dp.Keywords = tuple(str(k) for k in meta["keywords"])
                    out = outer._store(doc, ext)
                finally:
                    doc.close(True)
                    _rm(tmp)
                stop_after()
                return out

            @server.register_function
            def get_structured(indata, ext):
                doc, tmp = outer._load(indata.data, ext)
                try:
                    names = doc.getSupportedServiceNames()
                    if "com.sun.star.text.TextDocument" in names:
                        blocks = []
                        it = doc.getText().createEnumeration()
                        while it.hasMoreElements():
                            el = it.nextElement()
                            if el.supportsService("com.sun.star.text.Paragraph"):
                                style = getattr(el, "ParaStyleName", "")
                                blocks.append({
                                    "type": "heading" if str(style).startswith("Heading") else "paragraph",
                                    "style": str(style),
                                    "text": el.getString(),
                                })
                            elif el.supportsService("com.sun.star.text.TextTable"):
                                blocks.append({"type": "table", "name": el.getName()})
                        return {"doctype": "text", "blocks": blocks}
                    if "com.sun.star.sheet.SpreadsheetDocument" in names:
                        sheets = []
                        count = doc.getSheets().getCount()
                        for i in range(count):
                            sh = doc.getSheets().getByIndex(i)
                            cur = sh.createCursor()
                            cur.gotoEndOfUsedArea(False)
                            addr = cur.getRangeAddress()
                            data = sh.getCellRangeByPosition(0, 0, addr.EndColumn, addr.EndRow).getDataArray()
                            sheets.append({"name": sh.getName(), "rows": [list(r) for r in data]})
                        return {"doctype": "sheet", "sheets": sheets}
                    if (
                        "com.sun.star.presentation.PresentationDocument" in names
                        or "com.sun.star.drawing.DrawingDocument" in names
                    ):
                        # Impress/Draw: per-slide shape GEOMETRY, the agent's
                        # spatial sense. Positions/sizes are UNO 1/100 mm
                        # (offapi XShape.idl "100/th mm"); /1000 = cm — the
                        # same unit the agent's place_textbox/format_shape
                        # speak, so extract output feeds straight back into
                        # placement calls. Slide bounds from GenericDrawPage
                        # Width/Height (optional properties; guarded).
                        def _cm(v):
                            return round(v / 1000.0, 2)

                        # Speaker-notes readback: an Impress slide exposes its
                        # notes via XPresentationPage.getNotesPage() (offapi
                        # XPresentationPage.idl), which returns the notes
                        # XDrawPage. The notes text lives in that page's
                        # text-frame shapes (the "Notes" placeholder — typically
                        # com.sun.star.presentation.NotesShape, a TextShape
                        # subclass). Iterate them and concatenate getString().
                        # Defensive: not every slide has notes (returns ""), and
                        # any failure degrades to "" without touching the
                        # geometry extraction above.
                        def _notes_text(page):
                            try:
                                notes_page = page.getNotesPage()
                            except Exception:
                                return ""
                            parts = []
                            try:
                                count = notes_page.getCount()
                            except Exception:
                                return ""
                            for k in range(count):
                                try:
                                    nsh = notes_page.getByIndex(k)
                                    if nsh.supportsService("com.sun.star.drawing.Text"):
                                        s = nsh.getString() or ""
                                        if s:
                                            parts.append(s)
                                except Exception:
                                    continue
                            return "\n\n".join(parts)

                        pages = doc.getDrawPages()
                        first = pages.getByIndex(0) if pages.getCount() > 0 else None
                        slide_size = {
                            "widthCm": _cm(getattr(first, "Width", 0)) if first else 0,
                            "heightCm": _cm(getattr(first, "Height", 0)) if first else 0,
                        }
                        slides = []
                        for i in range(pages.getCount()):
                            page = pages.getByIndex(i)
                            shapes = []
                            for j in range(page.getCount()):
                                sh = page.getByIndex(j)
                                pos = sh.getPosition()
                                size = sh.getSize()
                                text = ""
                                try:
                                    if sh.supportsService("com.sun.star.drawing.Text"):
                                        text = sh.getString()
                                except Exception:
                                    pass
                                shapes.append({
                                    "name": getattr(sh, "Name", "") or "",
                                    # e.g. com.sun.star.presentation.TitleTextShape —
                                    # tells the agent WHICH box this is.
                                    "type": sh.getShapeType(),
                                    "xCm": _cm(pos.X),
                                    "yCm": _cm(pos.Y),
                                    "wCm": _cm(size.Width),
                                    "hCm": _cm(size.Height),
                                    "z": int(getattr(sh, "ZOrder", j)),
                                    # Snippet only — identification, not content dump.
                                    "text": (text or "")[:200],
                                })
                            # Per-slide speaker notes (full text, not truncated —
                            # agents need it whole to self-verify set_notes).
                            notes_text = ""
                            try:
                                notes_text = _notes_text(page)
                            except Exception:
                                notes_text = ""
                            slides.append({"index": i, "shapes": shapes, "notes": notes_text})
                        return {"doctype": "slides", "slideSize": slide_size, "slides": slides}
                    return {"doctype": "other", "blocks": []}
                finally:
                    doc.close(True)
                    _rm(tmp)

            logger.info("nwuno started (native + %d extended methods).", 8)
            server.serve_forever()


def main():
    parser = argparse.ArgumentParser("nwuno")
    parser.add_argument("--interface", default="127.0.0.1")
    parser.add_argument("--uno-interface", default="127.0.0.1")
    parser.add_argument("--port", default="2003")
    parser.add_argument("--uno-port", default="2002")
    parser.add_argument("--executable", default=None)
    parser.add_argument("--stop-after", type=int)
    parser.add_argument("--conversion-timeout", type=int)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)

    if args.uno_port == args.port:
        raise RuntimeError("--port and --uno-port must differ")

    with tempfile.TemporaryDirectory() as tmpuserdir:
        user_installation = Path(tmpuserdir).as_uri()
        server = NwUnoServer(
            args.interface, args.port, args.uno_interface, args.uno_port,
            user_installation, args.conversion_timeout, args.stop_after,
        )
        executable = args.executable
        if not executable:
            for name in ("soffice", "libreoffice", "ooffice"):
                executable = shutil.which(name)
                if executable:
                    break
        process = server.start(executable=executable)
        if process is None:
            return 2
        process.wait()
        server.stop()
        return 0


if __name__ == "__main__":
    sys.exit(main())
