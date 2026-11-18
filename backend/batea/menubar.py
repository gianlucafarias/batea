"""Ícono de Batea en la barra de arriba: qué suena en tu programa de DJ y qué poner después.

    python -m batea.menubar --parent <pid de Batea>

Proceso aparte (la ventana de Batea sigue siendo de pywebview). Le pregunta a la Batea abierta
por `/api/nowplaying`. Cada recomendación se puede arrastrar a un deck (se entrega
el archivo, igual que desde el Finder). Doble click: abre el tema en Batea.
"""
from __future__ import annotations

import os
import sys
import threading
import urllib.request
import json

import objc
from AppKit import (
    NSApplication, NSApplicationActivationPolicyAccessory, NSBezelStyleRounded, NSButton, NSColor,
    NSDragOperationEvery, NSFilenamesPboardType, NSFont, NSImage, NSLineBreakByTruncatingTail, NSMakeRect, NSPopover,
    NSPasteboardTypeFileURL, NSPasteboardTypeString, NSPopoverBehaviorSemitransient, NSRectEdgeMinY, NSScrollView, NSStatusBar, NSTableCellView,
    NSTableColumn, NSTableView, NSTableViewStyleFullWidth, NSTextField, NSView, NSViewController,
    NSVariableStatusItemLength,
)
from Foundation import NSObject, NSTimer, NSURL
from PyObjCTools import AppHelper

from . import links

W, H = 400, 560
KIND_NOTE = {"copia": "  · otra carpeta: rekordbox puede tomarlo como nuevo", "nuevo": "  · no está en rekordbox"}


def _fetch() -> dict | None:
    info = links.running()
    if not info:
        return None
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{info['port']}/api/nowplaying", timeout=8) as r:
            return json.loads(r.read())
    except (OSError, ValueError):
        return None


def _label(frame, size=12.0, bold=False, color=None) -> NSTextField:
    t = NSTextField.labelWithString_("")
    t.setFrame_(frame)
    t.setFont_(NSFont.boldSystemFontOfSize_(size) if bold else NSFont.systemFontOfSize_(size))
    t.setLineBreakMode_(NSLineBreakByTruncatingTail)
    if color is not None:
        t.setTextColor_(color)
    return t


def _meta(t: dict) -> str:
    bits = [t.get("artist") or ""]
    if t.get("bpm"):
        bits.append(f"{t['bpm']:.1f}".rstrip("0").rstrip(".") + " BPM")
    if t.get("key"):
        bits.append(t["key"])
    if t.get("energy"):
        bits.append(f"energía {t['energy']}")
    return " · ".join(b for b in bits if b)


class Panel(NSObject):
    def init(self):
        self = objc.super(Panel, self).init()
        self.recs = []
        self.now = None
        self.is_rb = False
        self.busy = False
        return self

    # ---------------------------------------------------------------- armado
    @objc.python_method
    def build(self):
        root = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, W, H))
        dim = NSColor.secondaryLabelColor()
        y = H - 30
        self.hdr = _label(NSMakeRect(14, y, W - 28, 16), 10.5, True, dim)
        root.addSubview_(self.hdr)
        y -= 26
        self.nowTitle = _label(NSMakeRect(14, y, W - 28, 22), 15, True)
        root.addSubview_(self.nowTitle)
        y -= 18
        self.nowMeta = _label(NSMakeRect(14, y, W - 28, 16), 11.5, False, dim)
        root.addSubview_(self.nowMeta)
        y -= 18
        self.other = _label(NSMakeRect(14, y, W - 28, 16), 11, False, dim)
        root.addSubview_(self.other)
        y -= 30
        sub = _label(NSMakeRect(14, y, W - 28, 16), 10.5, True, dim)
        sub.setStringValue_("PARA PONER DESPUÉS  ·  arrastrá un tema al deck")
        root.addSubview_(sub)

        list_top = y - 6
        scroll = NSScrollView.alloc().initWithFrame_(NSMakeRect(0, 44, W, list_top - 44))
        scroll.setHasVerticalScroller_(True)
        scroll.setDrawsBackground_(False)
        table = NSTableView.alloc().initWithFrame_(scroll.bounds())
        col = NSTableColumn.alloc().initWithIdentifier_("t")
        col.setWidth_(W - 20)
        table.addTableColumn_(col)
        table.setHeaderView_(None)
        table.setRowHeight_(50)
        table.setBackgroundColor_(NSColor.clearColor())
        try:
            table.setStyle_(NSTableViewStyleFullWidth)
        except AttributeError:
            pass
        table.setDataSource_(self)
        table.setDelegate_(self)
        table.setTarget_(self)
        table.setDoubleAction_("openRow:")
        table.setDraggingSourceOperationMask_forLocal_(NSDragOperationEvery, False)
        scroll.setDocumentView_(table)
        root.addSubview_(scroll)
        self.table = table

        self.empty = _label(NSMakeRect(14, list_top - 60, W - 28, 40), 12, False, dim)
        self.empty.setLineBreakMode_(0)
        root.addSubview_(self.empty)

        self.openBtn = self._button("Abrir en Batea", NSMakeRect(10, 8, 130, 28), "openNow:")
        root.addSubview_(self.openBtn)
        root.addSubview_(self._button("Actualizar", NSMakeRect(146, 8, 100, 28), "refresh:"))
        root.addSubview_(self._button("Cerrar ícono", NSMakeRect(W - 120, 8, 110, 28), "quit:"))

        vc = NSViewController.alloc().init()
        vc.setView_(root)
        pop = NSPopover.alloc().init()
        pop.setContentViewController_(vc)
        pop.setContentSize_((W, H))
        pop.setBehavior_(NSPopoverBehaviorSemitransient)
        self.pop = pop

        item = NSStatusBar.systemStatusBar().statusItemWithLength_(NSVariableStatusItemLength)
        btn = item.button()
        img = NSImage.imageWithSystemSymbolName_accessibilityDescription_("opticaldisc", "Batea")
        if img is not None:
            img.setTemplate_(True)
            btn.setImage_(img)
        else:
            btn.setTitle_("◉")
        btn.setToolTip_("Batea: qué suena y qué poner después")
        btn.setTarget_(self)
        btn.setAction_("toggle:")
        self.item = item
        self.render(None)

    @objc.python_method
    def _button(self, title, frame, action) -> NSButton:
        b = NSButton.alloc().initWithFrame_(frame)
        b.setTitle_(title)
        b.setBezelStyle_(NSBezelStyleRounded)
        b.setTarget_(self)
        b.setAction_(action)
        return b

    # ---------------------------------------------------------------- acciones
    def toggle_(self, sender):
        if self.pop.isShown():
            self.pop.performClose_(sender)
            return
        self.pop.showRelativeToRect_ofView_preferredEdge_(sender.bounds(), sender, NSRectEdgeMinY)
        self.refresh_(None)

    def refresh_(self, sender):
        if self.busy:
            return
        self.busy = True

        def work():
            data = _fetch()
            AppHelper.callAfter(self.render, data)

        threading.Thread(target=work, daemon=True).start()

    def tick_(self, timer):
        if self.pop.isShown():
            self.refresh_(None)

    def watchParent_(self, timer):
        try:
            os.kill(PARENT, 0)
        except ProcessLookupError:
            AppHelper.stopEventLoop()
        except PermissionError:
            pass

    @objc.python_method
    def _open(self, tid):
        threading.Thread(target=lambda: _safe_send(links.track_url(tid)), daemon=True).start()

    def openNow_(self, sender):
        if self.now:
            self._open(self.now["id"])

    def openRow_(self, sender):
        r = self.table.clickedRow()
        if 0 <= r < len(self.recs):
            self._open(self.recs[r]["id"])

    def quit_(self, sender):
        AppHelper.stopEventLoop()

    # ---------------------------------------------------------------- mostrar
    @objc.python_method
    def render(self, data):
        self.busy = False
        self.now = None
        self.recs = []
        other = ""
        label = (data or {}).get("app_label") or "tu programa"
        note = (data or {}).get("note")
        is_rb = (data or {}).get("app") == "rekordbox"
        self.is_rb = is_rb
        if data is None:
            self.hdr.setStringValue_("BATEA")
            self.nowTitle.setStringValue_("No encuentro Batea abierta")
            self.nowMeta.setStringValue_("")
        elif not data.get("app"):
            self.hdr.setStringValue_("SONANDO AHORA")
            self.nowTitle.setStringValue_("No hay ningún programa abierto")
            self.nowMeta.setStringValue_("Abrí rekordbox, Serato o Traktor y cargá un tema")
        elif not data.get("now"):
            self.hdr.setStringValue_(f"{label.upper()}")
            self.nowTitle.setStringValue_("Todavía no detecto ningún tema")
            self.nowMeta.setStringValue_(note or f"Cargá un tema en un deck de {label}")
        else:
            self.now = data["now"]
            self.recs = data.get("recs") or []
            how = {"deck": "cargado en un deck", "aire": f"al aire en {label}"}.get(
                data["source"], f"según el historial de {label}")
            self.hdr.setStringValue_(f"SONANDO AHORA  ·  {how}")
            self.nowTitle.setStringValue_(self.now.get("title") or "Sin título")
            self.nowMeta.setStringValue_(_meta(self.now))
            if data.get("loaded"):
                other = "También cargado: " + " / ".join(t.get("title") or "?" for t in data["loaded"])
            elif note:
                other = note
        self.other.setStringValue_(other)
        self.openBtn.setEnabled_(self.now is not None)
        msg = ""
        if self.now and not self.recs:
            msg = "No encontré recomendaciones para este tema."
        self.empty.setStringValue_(msg)
        self.table.reloadData()

    # ---------------------------------------------------------------- tabla
    def numberOfRowsInTableView_(self, table):
        return len(self.recs)

    def tableView_viewForTableColumn_row_(self, table, col, row):
        r = self.recs[row]
        v = table.makeViewWithIdentifier_owner_("cell", self)
        if v is None:
            v = NSTableCellView.alloc().initWithFrame_(NSMakeRect(0, 0, W - 20, 50))
            v.setIdentifier_("cell")
            a = _label(NSMakeRect(8, 26, W - 40, 18), 12.5, True)
            b = _label(NSMakeRect(8, 8, W - 40, 16), 10.5, False, NSColor.secondaryLabelColor())
            a.setTag_(1)
            b.setTag_(2)
            v.addSubview_(a)
            v.addSubview_(b)
        a, b = v.viewWithTag_(1), v.viewWithTag_(2)
        can = bool(r.get("drag_path"))
        a.setStringValue_(("" if can else "⊘ ") + (r.get("title") or "Sin título"))
        a.setTextColor_(NSColor.labelColor() if can else NSColor.tertiaryLabelColor())
        why = " · ".join((r.get("reasons") or [])[:3])
        line = " · ".join(x for x in (_meta(r), why) if x)
        if not can:
            line = " · ".join(x for x in ("Archivo no disponible (¿SSD desconectado?)", line) if x)
        else:
            if self.is_rb:  # "no está en rekordbox" solo tiene sentido con rekordbox
                line += KIND_NOTE.get(r.get("drag_kind"), "")
        b.setStringValue_(line)
        v.setToolTip_(line)
        return v

    def tableView_writeRowsWithIndexes_toPasteboard_(self, table, rows, pb):
        # Como el Finder: rutas (formato viejo, el que leen muchas apps de DJ) + file URL + texto.
        i = rows.firstIndex()
        p = self.recs[i].get("drag_path") if 0 <= i < len(self.recs) else None
        if not p:
            return False
        url = NSURL.fileURLWithPath_(p).absoluteString()
        pb.declareTypes_owner_([NSFilenamesPboardType, NSPasteboardTypeFileURL, NSPasteboardTypeString], None)
        pb.setPropertyList_forType_([p], NSFilenamesPboardType)
        pb.setString_forType_(url, NSPasteboardTypeFileURL)
        pb.setString_forType_(p, NSPasteboardTypeString)
        return True


def _safe_send(url: str) -> None:
    try:
        links.send(url, launch=False)
    except Exception:  # noqa: BLE001
        pass


PARENT = 0


def main(argv: list[str]) -> int:
    global PARENT
    if "--parent" in argv:
        PARENT = int(argv[argv.index("--parent") + 1])
    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
    panel = Panel.alloc().init()
    panel.build()
    NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(3.0, panel, "tick:", None, True)
    if PARENT:
        NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(5.0, panel, "watchParent:", None, True)
    AppHelper.runEventLoop(installInterrupt=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
