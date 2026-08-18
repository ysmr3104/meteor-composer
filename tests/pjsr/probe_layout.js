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

say("==== 6. The mask row, one row of four edges ====");

try {
   var host3 = new Control;
   var row3 = new HorizontalSizer;
   row3.spacing = 6;

   var lab = new Label(host3);
   lab.text = "Mask:";
   lab.setFixedWidth(58);
   row3.add(lab);

   var radioW = Math.max(host3.font.width("Edges"), host3.font.width("Image")) + 30;
   var rb = new RadioButton(host3);
   rb.text = "Edges";
   rb.setFixedWidth(radioW);
   row3.add(rb);

   var names = ["Top", "Bottom", "Left", "Right"];
   var cells = [];
   for (i = 0; i < names.length; ++i) {
      var nameLabel = new Label(host3);
      nameLabel.text = names[i] + ":";
      nameLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      nameLabel.setFixedWidth(host3.font.width("Bottom:") + 6);

      var sa = new SpinBox(host3);
      sa.setRange(0, 100);
      sa.value = 100;
      var sb = new SpinBox(host3);
      sb.setRange(0, 100);
      sb.value = 100;

      var pcLabel = new Label(host3);
      pcLabel.text = "%";
      pcLabel.setFixedWidth(host3.font.width("%") + 4);

      var cell = new HorizontalSizer;
      cell.spacing = 2;
      cell.add(nameLabel);
      cell.add(sa);
      cell.add(sb);
      cell.add(pcLabel);
      row3.add(cell);
      if (i < names.length - 1) {
         row3.addSpacing(8);
      }
      cells.push({ nameLabel: nameLabel, a: sa, b: sb, pcLabel: pcLabel });
   }
   row3.addStretch();
   var readout2 = new Label(host3);
   readout2.text = "Excluded: 100.0%";
   readout2.setFixedWidth(host3.font.width("Excluded: 100.0%") + 8);
   row3.add(readout2);

   host3.sizer = row3;
   layout(host3, 1780);

   var used = lab.width + rb.width + readout2.width;
   for (i = 0; i < cells.length; ++i) {
      used += cells[i].nameLabel.width + cells[i].a.width + cells[i].b.width
            + cells[i].pcLabel.width;
      say("  " + pad(names[i], 8) + "label " + pad(cells[i].nameLabel.width, 5)
          + "spin " + pad(cells[i].a.width, 5) + "spin " + pad(cells[i].b.width, 5)
          + "unit " + cells[i].pcLabel.width);
   }
   say("  label " + lab.width + "  radio " + rb.width
       + "  readout " + readout2.width);
   var spacing = 6 * 6 + 8 * 3 + 2 * 3 * 4;
   say("  children " + used + " + spacing " + spacing + " = " + (used + spacing));
   say("  available at the dialog minimum: 1152");
   say((used + spacing <= 1152) ? "  PASS  the row fits at the minimum width"
                                : "  FAIL  the row does NOT fit at the minimum width");

   host3.setFixedWidth(1152);
   host3.ensureLayoutUpdated();
   say("  at 1152: readout " + readout2.width
       + "  Right spins " + cells[3].a.width + "/" + cells[3].b.width
       + "  (unchanged means nothing was squeezed)");
} catch (e) {
   say("  ERROR: " + e);
}

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

   var row4 = new HorizontalSizer;
   row4.spacing = 6;
   row4.add(sp);
   row4.add(radio2);
   row4.add(edit2, 100);
   row4.add(browse2);
   host4.sizer = row4;
   layout(host4, 1152);
   say("  at 1152: spacer " + sp.width + "  radio " + radio2.width
       + "  edit " + edit2.width + "  browse " + browse2.width);
   var sum4 = sp.width + radio2.width + edit2.width + browse2.width + 18;
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

say("");
say("written to " + OUT);
