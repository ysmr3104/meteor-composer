#engine v8

//============================================================================
// probe_layout.js - How wide do these controls actually come out?
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_layout.js
//   ssh mbp4ysmr cat /tmp/probe_layout.txt
//
// Layout has been guessed at three times in this project and reported broken by
// the operator three times: a PushButton row that pushed a checkbox off the
// edge, list columns that met a scrollbar before the Score column, and now a
// toolbar of one-to-three character buttons taking about ninety pixels each
// while a Clear button next to a stretching Edit gets clipped to "Clea".
//
// Screenshots say something is wrong but not why, and the dialog cannot be
// opened from here. Control.adjustToContents() and ensureLayoutUpdated() can:
// a Control holding a real sizer will lay itself out with no window involved,
// and every child's `width` can then be read. That is a measurement, not a
// guess.
//
// Questions:
//   1. What does font.width() return, and in what units?
//   2. What does a PushButton actually come out at when setFixedWidth() asks
//      for 30? Is there a minimum underneath it?
//   3. Is ToolButton narrower for the same text?
//   4. In the mask's file row, who eats the width - and does the Clear button
//      get less than it asked for?
//   5. How wide is a SpinBox with a suffix, and does autoAdjustWidth help?
//============================================================================

#define OUT "/tmp/probe_layout.txt"

var lines = [];

function say(text) {
   lines.push(text);
   File.writeTextFile(OUT, lines.join("\n") + "\n");
   console.writeln(text);
}

function pad(s, n) {
   s = "" + s;
   while (s.length < n) {
      s += " ";
   }
   return s;
}

// A Control that owns a sizer will lay out when asked, with no window.
function layout(host, width) {
   host.adjustToContents();
   if (width > 0) {
      host.setFixedWidth(width);
   }
   host.ensureLayoutUpdated();
}

say("probe_layout.js");
say("");

var probe = new Control;
say("displayPixelRatio   " + probe.displayPixelRatio);
say("resourcePixelRatio  " + probe.resourcePixelRatio);
say("logicalPixelsToPhysical(100) = " + probe.logicalPixelsToPhysical(100));
say("font                " + probe.font.family + " " + probe.font.pointSize + "pt");
say("");

//----------------------------------------------------------------------------
// 1. font.width
//----------------------------------------------------------------------------

say("==== 1. font.width ====");
var strings = ["Fit", "1:1", "+", "-", "Clear", "Browse...", "Bottom:", "tilt:",
               "%", "deg", "Edges", "Image", "Excluded: 100.0% of the frame",
               "0", "000", "00000", "Reset"];
for (var i = 0; i < strings.length; ++i) {
   say("  " + pad('"' + strings[i] + '"', 34) + probe.font.width(strings[i]));
}
say("");

//----------------------------------------------------------------------------
// 2-3. PushButton against ToolButton
//----------------------------------------------------------------------------

say("==== 2-3. Buttons: asked for, got ====");

function measureButtons(kind) {
   var host = new Control;
   var labels = ["Fit", "1:1", "+", "-", "Clear", "Browse..."];
   var made = [];
   var sizer = new HorizontalSizer;
   sizer.spacing = 4;
   for (var j = 0; j < labels.length; ++j) {
      var b = (kind === "tool") ? new ToolButton(host) : new PushButton(host);
      b.text = labels[j];
      made.push(b);
      sizer.add(b);
   }
   sizer.addStretch();
   host.sizer = sizer;
   layout(host, 900);

   say("  " + kind + ", no width set:");
   for (j = 0; j < made.length; ++j) {
      say("    " + pad('"' + labels[j] + '"', 14) + "width " + made[j].width);
   }

   // Now ask for something narrow.
   for (j = 0; j < made.length; ++j) {
      var want = Math.max(24, host.font.width(labels[j]) + 12);
      made[j].setFixedWidth(want);
   }
   host.ensureLayoutUpdated();
   say("  " + kind + ", setFixedWidth(font.width + 12):");
   for (j = 0; j < made.length; ++j) {
      var asked = Math.max(24, host.font.width(labels[j]) + 12);
      say("    " + pad('"' + labels[j] + '"', 14) + "asked " + pad(asked, 5)
          + "got " + pad(made[j].width, 5)
          + "min " + pad(made[j].minWidth, 5) + "max " + made[j].maxWidth);
   }
}

try {
   measureButtons("push");
} catch (e) {
   say("  ERROR push: " + e);
}
say("");
try {
   measureButtons("tool");
} catch (e) {
   say("  ERROR tool: " + e);
}
say("");

//----------------------------------------------------------------------------
// 4. The mask's file row: who eats the width?
//----------------------------------------------------------------------------

say("==== 4. The file row ====");

try {
   var host = new Control;
   var spacerL = new Label(host);
   spacerL.text = "";
   spacerL.setFixedWidth(58);
   var radio = new RadioButton(host);
   radio.text = "Image";
   radio.setFixedWidth(host.font.width("Image") + 30);
   var edit = new Edit(host);
   edit.readOnly = true;
   var browse = new PushButton(host);
   browse.text = "Browse...";
   var clear = new PushButton(host);
   clear.text = "Clear";
   clear.setFixedWidth(host.font.width("Clear") + 20);
   var readout = new Label(host);
   readout.text = "Excluded: 100.0% of the frame";

   var row = new HorizontalSizer;
   row.spacing = 6;
   row.add(spacerL);
   row.add(radio);
   row.add(edit, 100);
   row.add(browse);
   row.addSpacing(10);
   row.add(clear);
   row.addSpacing(10);
   row.add(readout);
   host.sizer = row;
   layout(host, 1780);

   say("  container 1780");
   say("    spacer   " + spacerL.width);
   say("    radio    " + radio.width);
   say("    edit     " + edit.width);
   say("    browse   " + browse.width);
   say("    clear    " + clear.width + "   (asked "
       + (host.font.width("Clear") + 20) + ", min " + clear.minWidth
       + ", max " + clear.maxWidth + ")");
   say("    readout  " + readout.width + "   (needs "
       + host.font.width(readout.text) + ")");
   var total = spacerL.width + radio.width + edit.width + browse.width
             + clear.width + readout.width;
   say("    sum of children " + total + " + spacing");

   // And squeezed, which is what the initial window does.
   host.setFixedWidth(1100);
   host.ensureLayoutUpdated();
   say("  container 1100");
   say("    edit " + edit.width + "  browse " + browse.width
       + "  clear " + clear.width + "  readout " + readout.width);
} catch (e) {
   say("  ERROR: " + e);
}
say("");

//----------------------------------------------------------------------------
// 5. SpinBox with a suffix
//
// The operator asked for up/down buttons stepping by one instead of a plain
// text field. SpinBox is integer-only, so this also decides whether the mask's
// numbers can stay as they are.
//----------------------------------------------------------------------------

say("==== 5. SpinBox ====");

try {
   var host2 = new Control;
   var row2 = new HorizontalSizer;
   row2.spacing = 4;

   var pct = new SpinBox(host2);
   pct.minValue = 0;
   pct.maxValue = 100;
   pct.stepSize = 1;
   pct.suffix = " %";
   pct.value = 100;
   pct.onValueUpdated = function (value) { };
   row2.add(pct);

   var deg = new SpinBox(host2);
   deg.minValue = -45;
   deg.maxValue = 45;
   deg.stepSize = 1;
   deg.suffix = " deg";
   deg.value = -45;
   row2.add(deg);

   var degAuto = new SpinBox(host2);
   degAuto.minValue = -45;
   degAuto.maxValue = 45;
   degAuto.suffix = " deg";
   degAuto.autoAdjustWidth = true;
   degAuto.value = -45;
   row2.add(degAuto);

   row2.addStretch();
   host2.sizer = row2;
   layout(host2, 900);

   say("  percent SpinBox   width " + pct.width + "   value " + pct.value
       + "   suffix \"" + pct.suffix + "\"");
   say("  degree  SpinBox   width " + deg.width + "   value " + deg.value);
   say("  degree  autoAdjustWidth  width " + degAuto.width);
   pct.value = 7;
   say("  setting value to 7 reads back " + pct.value);
   pct.value = 250;
   say("  setting 250 with maxValue 100 reads back " + pct.value);
   pct.value = -3;
   say("  setting -3 with minValue 0 reads back " + pct.value);
} catch (e) {
   say("  ERROR: " + e);
}
say("");
//----------------------------------------------------------------------------
// 6. The mask row as built: four edges of two spin boxes each, on ONE row
//
// This mirrors buildMaskRows() exactly. If the numbers fit at the dialog's
// minimum width the row fits; if they do not, it is clipped in the window and
// only a screenshot would say so.
//----------------------------------------------------------------------------

say("==== 6. The mask row: depth, tilt and direction per edge ====");

// One row of four cells was measured at 1203-1235 px against the 1152 available
// at the dialog's minimum width, so the edges take two rows of two. Both are
// measured here: the one-row figure so the decision stays checkable, and the
// two-row figure so a change that overflows it fails visibly.
function maskCell(host, name) {
   var nameLabel = new Label(host);
   nameLabel.text = name + ":";
   nameLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
   nameLabel.setFixedWidth(host.font.width("Bottom:") + 6);

   var percent = new SpinBox(host);
   percent.setRange(0, 100);
   percent.suffix = " %";
   percent.value = 100;

   var tilt = new SpinBox(host);
   tilt.setRange(0, 45);
   tilt.suffix = " deg";
   tilt.value = 45;

   var ccw = new CheckBox(host);
   ccw.text = "CCW";

   var cell = new HorizontalSizer;
   cell.spacing = 2;
   cell.add(nameLabel);
   cell.add(percent);
   cell.add(tilt);
   cell.add(ccw);
   return { sizer: cell, parts: [nameLabel, percent, tilt, ccw] };
}

function maskRowWidth(host, names, withLabel, withReadout) {
   var row = new HorizontalSizer;
   row.spacing = 6;
   var items = [];
   var lab = new Label(host);
   lab.text = withLabel ? "Mask:" : "";
   lab.setFixedWidth(58);
   row.add(lab);
   items.push(lab);
   var radioW = Math.max(host.font.width("Edges"), host.font.width("Image")) + 30;
   var rb = new RadioButton(host);
   rb.text = "Edges";
   rb.setFixedWidth(radioW);
   row.add(rb);
   items.push(rb);
   var cells = [];
   for (var i = 0; i < names.length; ++i) {
      var c = maskCell(host, names[i]);
      cells.push(c);
      row.add(c.sizer);
      if (i < names.length - 1) {
         row.addSpacing(14);
      }
   }
   row.addStretch();
   var readout = null;
   if (withReadout) {
      readout = new Label(host);
      readout.text = "Excluded: 100.0% of the frame";
      readout.setFixedWidth(host.font.width(readout.text) + 8);
      row.add(readout);
      items.push(readout);
   }
   host.sizer = row;
   layout(host, 1780);

   var used = 0;
   for (i = 0; i < items.length; ++i) {
      used += items[i].width;
   }
   for (i = 0; i < cells.length; ++i) {
      for (var j = 0; j < cells[i].parts.length; ++j) {
         used += cells[i].parts[j].width;
      }
   }
   var spacing = 6 * (2 + cells.length + (withReadout ? 1 : 0))
               + 14 * (cells.length - 1) + 2 * 3 * cells.length;
   return { used: used, total: used + spacing, cell: cells[0] };
}

try {
   var one = maskRowWidth(new Control, ["Top", "Bottom", "Left", "Right"], true, true);
   var cellWidth = 0;
   for (var pi = 0; pi < one.cell.parts.length; ++pi) {
      cellWidth += one.cell.parts[pi].width;
   }
   say("  one cell (label + depth + tilt + CCW) = " + cellWidth);
   say("  four cells on one row = " + one.total
       + (one.total <= 1152 ? "   fits" : "   OVER by " + (one.total - 1152)
          + ", which is why the edges take two rows"));

   var top = maskRowWidth(new Control, ["Top", "Left"], true, false);
   var bottom = maskRowWidth(new Control, ["Bottom", "Right"], false, true);
   say("  two rows: top " + top.total + ", bottom " + bottom.total
       + "  (budget 1152)");
   say((top.total <= 1152 && bottom.total <= 1152)
       ? "  PASS  both rows fit at the minimum width"
       : "  FAIL  a row does not fit at the minimum width");
} catch (e) {
   say("  ERROR: " + e);
}

say("");
//----------------------------------------------------------------------------
// 7. The file row, with Clear gone and the readout moved to the edges row
//----------------------------------------------------------------------------

say("");
say("==== 7. The file row as built ====");

try {
   var host4 = new Control;
   var sp = new Label(host4);
   sp.text = "";
   sp.setFixedWidth(58);
   var radioW2 = Math.max(host4.font.width("Edges"), host4.font.width("Image")) + 30;
   var radio2 = new RadioButton(host4);
   radio2.text = "Image";
   radio2.setFixedWidth(radioW2);
   var edit2 = new Edit(host4);
   edit2.readOnly = true;
   var browse2 = new PushButton(host4);
   browse2.text = "Browse...";

   var turnLabel = new Label(host4);
   turnLabel.text = "Turn:";
   var turnCombo = new ComboBox(host4);
   turnCombo.addItem("0 deg");
   turnCombo.addItem("90 deg");
   turnCombo.addItem("180 deg");
   turnCombo.addItem("270 deg");

   var row4 = new HorizontalSizer;
   row4.spacing = 6;
   row4.add(sp);
   row4.add(radio2);
   row4.add(edit2, 100);
   row4.add(browse2);
   row4.addSpacing(10);
   row4.add(turnLabel);
   row4.add(turnCombo);
   host4.sizer = row4;
   layout(host4, 1152);
   say("  at 1152: spacer " + sp.width + "  radio " + radio2.width
       + "  edit " + edit2.width + "  browse " + browse2.width
       + "  turn label " + turnLabel.width + "  turn combo " + turnCombo.width);
   var sum4 = sp.width + radio2.width + edit2.width + browse2.width
            + turnLabel.width + turnCombo.width + 40;
   say((sum4 <= 1154) ? "  PASS  nothing overflows"
                      : "  FAIL  overflow by " + (sum4 - 1152));
} catch (e) {
   say("  ERROR: " + e);
}

//----------------------------------------------------------------------------
// 8. The preview toolbar, as ToolButtons
//----------------------------------------------------------------------------

say("");
say("==== 8. The preview toolbar ====");

try {
   var host5 = new Control;
   var texts = ["Fit", "1:1", "+", "-", "↶", "↷"];
   var widest = 0;
   for (i = 0; i < texts.length; ++i) {
      widest = Math.max(widest, host5.font.width(texts[i]));
   }
   var row5 = new HorizontalSizer;
   row5.spacing = 4;
   var buttons = [];
   for (i = 0; i < texts.length; ++i) {
      var tbtn = new ToolButton(host5);
      tbtn.text = texts[i];
      tbtn.setFixedWidth(widest + 16);
      buttons.push(tbtn);
      row5.add(tbtn);
   }
   row5.addSpacing(10);
   var lock = new CheckBox(host5);
   lock.text = "Lock stretch";
   row5.add(lock);
   row5.addSpacing(10);
   var frameLabel = new Label(host5);
   frameLabel.text = "pct-2026-08-12_005232_ILCE-7M3_DSC04904_d_r.xisf   6024x4024   (first frame)";
   row5.add(frameLabel, 100);
   host5.sizer = row5;
   layout(host5, 700);

   var tsum = 0;
   for (i = 0; i < buttons.length; ++i) {
      tsum += buttons[i].width;
   }
   say("  each ToolButton " + buttons[0].width + ", six total " + tsum
       + " (as PushButtons it was 6 x 102 = 612)");
   say("  lock stretch " + lock.width + " (its text needs "
       + host5.font.width("Lock stretch") + ")");
   say("  frame label " + frameLabel.width + " (its text needs "
       + host5.font.width(frameLabel.text) + ")");
   say("  saved " + (612 - tsum) + " px, which is what was clipping the label");
} catch (e) {
   say("  ERROR: " + e);
}

//----------------------------------------------------------------------------
// 6. The preview toolbar has to grow: where does an STF mode control fit?
//
// The preview pane has a minimum width of 420 (setScaledMinSize). Anything the
// toolbar needs beyond that forces the whole dialog wider, or squeezes a
// control until its own label is cut - which is exactly how the "h" of "Lock
// stretch" went missing once already. So measure the row's required width with
// each candidate control before choosing one.
//----------------------------------------------------------------------------

say("");
say("6. Adding an STF mode control to the preview toolbar");
say("");

function previewToolbar(host, extra, lockText) {
   var row = new HorizontalSizer;
   row.spacing = 4;

   var labels = ["Fit", "1:1", "+", "-", "\u21b6", "\u21b7"];
   var widest = 0;
   var i;
   for (i = 0; i < labels.length; ++i) {
      widest = Math.max(widest, host.font.width(labels[i]));
   }
   for (i = 0; i < labels.length; ++i) {
      var tb = new ToolButton(host);
      tb.text = labels[i];
      tb.setFixedWidth(widest + 16);
      row.add(tb);
      if (i === 3) {
         row.addSpacing(8);
      }
   }
   row.addSpacing(10);

   var added = 0;
   if (extra === "combo") {
      var stfLabel = new Label(host);
      stfLabel.text = "STF:";
      row.add(stfLabel);
      var combo = new ComboBox(host);
      combo.addItem("None");
      combo.addItem("Linked");
      combo.addItem("Unlinked");
      combo.adjustToContents();
      row.add(combo);
      row.addSpacing(10);
      added = stfLabel.width + combo.width;
   } else if (extra === "buttons") {
      var names = ["None", "Linked", "Unlinked"];
      var w = 0;
      for (i = 0; i < names.length; ++i) {
         w = Math.max(w, host.font.width(names[i]));
      }
      for (i = 0; i < names.length; ++i) {
         var sb = new ToolButton(host);
         sb.text = names[i];
         sb.setFixedWidth(w + 16);
         row.add(sb);
         added += sb.width;
      }
      row.addSpacing(10);
   }

   var lock = new CheckBox(host);
   lock.text = lockText;
   lock.minWidth = host.font.width(lockText) + 20;
   row.add(lock);
   row.addSpacing(10);

   var frameLabel = new Label(host);
   frameLabel.text = "pct-2026-08-12_005232_ILCE-7M3_DSC04904_d_r.xisf   6024x4024";
   row.add(frameLabel, 100);

   host.sizer = row;
   host.adjustToContents();
   host.ensureLayoutUpdated();
   return { needed: host.width, added: added, lock: lock, label: frameLabel };
}

try {
   var variants = [
      ["no STF control (today)", "none", "Lock stretch"],
      ["label + ComboBox", "combo", "Lock stretch"],
      ["three ToolButtons", "buttons", "Lock stretch"],
      ["label + ComboBox, lock shortened to \"Lock\"", "combo", "Lock"]
   ];
   say("  the preview pane's minimum width is 420");
   say("");
   for (var v = 0; v < variants.length; ++v) {
      var h = new Control;
      var r = previewToolbar(h, variants[v][1], variants[v][2]);
      say("  " + pad(variants[v][0], 46)
          + " needs " + pad(r.needed, 5)
          + " (control adds " + pad(r.added, 4)
          + ", over the 420 minimum by " + (r.needed - 420) + ")");
   }
   say("");
   say("  Those are the widths the row would like. What decides the question is");
   say("  what survives when the row is forced into the 420 the pane can");
   say("  promise, so force it and read every control back.");
   say("");

   for (v = 0; v < variants.length; ++v) {
      var h2 = new Control;
      var r2 = previewToolbar(h2, variants[v][1], variants[v][2]);
      h2.setFixedWidth(420);
      h2.ensureLayoutUpdated();
      var lockWant = h2.font.width(variants[v][2]) + 20;
      var lockGot = r2.lock.width;
      say("  " + pad(variants[v][0], 46)
          + " at 420: lock " + pad(lockGot, 4) + "/" + pad(lockWant, 4)
          + (lockGot < lockWant ? "  CLIPPED" : "  ok")
          + "   frame label " + r2.label.width);
   }
} catch (e) {
   say("  ERROR: " + e);
}

//----------------------------------------------------------------------------
// 7. How wide is an unconstrained ComboBox, and does the real toolbar fit?
//
// Stage 6 called adjustToContents() on the ComboBox before measuring. The
// dialog does not. If an unconstrained ComboBox is much wider than its items
// need, that alone would explain a toolbar the operator reports as overlapping
// at the initial window size - which is worse than clipping.
//
// The width the preview pane actually gets at the minimum window size:
//   1180 dialog - 16 margin - 380 list - 7 - 280 detail - 7 = 490
//----------------------------------------------------------------------------

say("");
say("7. The real toolbar at the width the preview pane actually gets");
say("");

try {
   var hc = new Control;
   var rowc = new HorizontalSizer;
   var cbBare = new ComboBox(hc);
   cbBare.addItem("None");
   cbBare.addItem("Linked");
   cbBare.addItem("Unlinked");
   rowc.add(cbBare);
   var cbFit = new ComboBox(hc);
   cbFit.addItem("None");
   cbFit.addItem("Linked");
   cbFit.addItem("Unlinked");
   cbFit.adjustToContents();
   rowc.add(cbFit);
   hc.sizer = rowc;
   hc.adjustToContents();
   hc.ensureLayoutUpdated();
   say("  ComboBox bare               " + cbBare.width
       + "   minWidth " + cbBare.minWidth);
   say("  ComboBox adjustToContents   " + cbFit.width
       + "   minWidth " + cbFit.minWidth);
   say("  its widest item needs       " + hc.font.width("Unlinked"));
   say("");

   // The toolbar as the dialog builds it, laid out at 490 and at 420.
   var widths = [490, 420];
   for (var w = 0; w < widths.length; ++w) {
      var h = new Control;
      var row = new HorizontalSizer;
      row.spacing = 4;
      var labels = ["Fit", "1:1", "+", "-", "\u21b6", "\u21b7"];
      var widest = 0;
      var i;
      for (i = 0; i < labels.length; ++i) {
         widest = Math.max(widest, h.font.width(labels[i]));
      }
      var tbs = [];
      for (i = 0; i < labels.length; ++i) {
         var tb = new ToolButton(h);
         tb.text = labels[i];
         tb.setFixedWidth(widest + 16);
         tbs.push(tb);
         row.add(tb);
         if (i === 3) {
            row.addSpacing(8);
         }
      }
      row.addSpacing(10);
      var stfLabel = new Label(h);
      stfLabel.text = "STF:";
      row.add(stfLabel);
      var combo = new ComboBox(h);
      combo.addItem("None");
      combo.addItem("Linked");
      combo.addItem("Unlinked");
      row.add(combo);
      row.addSpacing(10);
      var lock = new CheckBox(h);
      lock.text = "Lock stretch";
      lock.minWidth = h.font.width(lock.text) + 20;
      row.add(lock);
      row.addSpacing(10);
      var fl = new Label(h);
      fl.text = "pct-2026-08-12_005232_ILCE-7M3_DSC04904_d_r.xisf   6024x4024";
      row.add(fl, 100);
      h.sizer = row;
      h.adjustToContents();
      var wants = h.width;
      h.setFixedWidth(widths[w]);
      h.ensureLayoutUpdated();

      var fixed = 6 * (widest + 16) + stfLabel.width + combo.width + lock.width;
      say("  at " + widths[w] + ": wants " + wants
          + "   buttons " + (6 * (widest + 16))
          + "   STF label " + stfLabel.width
          + "   combo " + combo.width
          + "   lock " + lock.width
          + "   frame label " + fl.width);
      say("        fixed parts total " + fixed + " + spacing 46 = "
          + (fixed + 46)
          + (fixed + 46 > widths[w] ? "   OVER by " + (fixed + 46 - widths[w])
                                    : "   fits, with "
                                      + (widths[w] - fixed - 46) + " for the name"));
   }
} catch (e) {
   say("  ERROR: " + e);
}

//----------------------------------------------------------------------------
// 8. With floors, and with one header spanning both previews
//
// Stage 7 found the ComboBox squeezed to 42 px for a control needing 86 - the
// same zero-minWidth trap as the CheckBox, walked into anyway. Two changes
// follow: give the elastic controls a floor, and move the header above both
// previews so it has the detail pane's width as well.
//
//   old: header inside the preview pane            490 px
//   new: header above preview + handle + detail    490 + 7 + 280 = 777 px
//----------------------------------------------------------------------------

say("");
say("8. Floors applied, and the header spanning both previews");
say("");

try {
   var cases = [777, 490, 420];
   for (var w = 0; w < cases.length; ++w) {
      var h = new Control;
      var row = new HorizontalSizer;
      row.spacing = 4;
      var labels = ["Fit", "1:1", "+", "-", "\u21b6", "\u21b7"];
      var widest = 0;
      var i;
      for (i = 0; i < labels.length; ++i) {
         widest = Math.max(widest, h.font.width(labels[i]));
      }
      for (i = 0; i < labels.length; ++i) {
         var tb = new ToolButton(h);
         tb.text = labels[i];
         tb.setFixedWidth(widest + 16);
         row.add(tb);
         if (i === 3) {
            row.addSpacing(8);
         }
      }
      row.addSpacing(10);
      var stfLabel = new Label(h);
      stfLabel.text = "STF:";
      stfLabel.minWidth = h.font.width(stfLabel.text) + 4;
      row.add(stfLabel);
      var combo = new ComboBox(h);
      combo.addItem("None");
      combo.addItem("Linked");
      combo.addItem("Unlinked");
      combo.adjustToContents();
      combo.minWidth = combo.width;
      var comboWanted = combo.width;
      row.add(combo);
      row.addSpacing(10);
      var lock = new CheckBox(h);
      lock.text = "Lock stretch";
      lock.minWidth = h.font.width(lock.text) + 20;
      row.add(lock);
      row.addSpacing(10);
      var fl = new Label(h);
      fl.text = "pct-2026-08-12_005232_ILCE-7M3_DSC04904_d_r.xisf   6024x4024";
      row.add(fl, 100);
      h.sizer = row;
      h.adjustToContents();
      h.setFixedWidth(cases[w]);
      h.ensureLayoutUpdated();

      say("  at " + cases[w] + ": combo " + combo.width + "/" + comboWanted
          + (combo.width < comboWanted ? "  SQUEEZED" : "  ok")
          + "   STF label " + stfLabel.width
          + "   lock " + lock.width
          + "   frame name " + fl.width
          + (fl.width < 40 ? "  (too narrow to read)" : ""));
   }
   say("");
   say("  777 is what the header gets now. 490 was what it had. 420 is the");
   say("  preview pane's own minimum, kept as the floor case.");
} catch (e) {
   say("  ERROR: " + e);
}

say("");
say("written to " + OUT);
