#engine v8

//============================================================================
// probe_mask.js - Do the PJSR assumptions the Mask row rests on hold?
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_mask.js
//
// The geometry and the black-is-excluded threshold have Small tests. What those
// cannot reach is everything the mask touches in PixInsight itself, and that is
// where this project has lost the most time: an argument whose meaning was
// assumed, a class that does not exist, a call that returns without doing
// anything and without complaining.
//
// Five questions, each of which would otherwise only be answered by an
// operator noticing that the shading is in the wrong place:
//
//   1. Are Bitmap.fill()'s x1/y1 inclusive or exclusive? The overlay is drawn
//      run by run, so being wrong here shifts or truncates every band.
//   2. Does a Bitmap keep the alpha it is filled with? The overlay is only
//      readable if it is translucent.
//   3. Does an alpha-bearing bitmap composite when drawn, or paint over?
//   4. Does loadMaskLuminance() read an ordinary image file, and does black
//      come back low - all the way through PixInsight's own reader?
//   5. Do the controls the Mask row is built from accept the properties and
//      methods it sets? NumericEdit and RadioButton have never been
//      constructed by this script.
//
// Results go to a file: console.writeln does not reach the terminal, and they
// are written as they are found, because touching an unsupported API throws
// and would otherwise take every earlier result with it.
//============================================================================

#include "../../javascript/mask_geometry.js"

#define OUT "/tmp/probe_mask.txt"

var lines = [];

function say(text) {
   lines.push(text);
   File.writeTextFile(OUT, lines.join("\n") + "\n");
   console.writeln(text);
}

function check(label, condition, detail) {
   say((condition ? "  PASS  " : "  FAIL  ") + label
       + (detail === undefined ? "" : "   [" + detail + "]"));
}

function attempt(label, fn) {
   try {
      fn();
   } catch (e) {
      say("  ERROR " + label + "   [" + e + "]");
   }
}

say("probe_mask.js");
say("PixInsight " + CoreApplication.versionString);
say("");

//----------------------------------------------------------------------------
// 1-2. Bitmap.fill: argument sense, and whether alpha survives
//----------------------------------------------------------------------------

say("==== 1-2. Bitmap.fill ====");

attempt("Bitmap.fill", function () {
   var bmp = new Bitmap(8, 4);
   bmp.fill(0x00000000);
   // The overlay fills one run as fill(x0, y, x1 + 1, y + 1, colour), on the
   // assumption that the far edges are exclusive - the sense PJSR's Rect uses.
   bmp.fill(2, 1, 5, 2, 0x5AA050FF);

   var inside = bmp.pixel(2, 1);
   var lastWanted = bmp.pixel(4, 1);
   var pastEnd = bmp.pixel(5, 1);
   var rowBelow = bmp.pixel(2, 2);
   var untouched = bmp.pixel(0, 0);

   say("    pixel(2,1) = 0x" + inside.toString(16)
       + "   pixel(4,1) = 0x" + lastWanted.toString(16)
       + "   pixel(5,1) = 0x" + pastEnd.toString(16)
       + "   pixel(2,2) = 0x" + rowBelow.toString(16));

   check("x1 and y1 are exclusive, so a run of x0..x1 is fill(x0, y, x1+1, y+1)",
         inside !== 0 && lastWanted !== 0 && pastEnd === 0 && rowBelow === 0);
   check("the rest of the bitmap is left transparent", untouched === 0,
         "0x" + untouched.toString(16));

   var alpha = (inside >> 24) & 0xFF;
   check("the alpha channel survives the fill", alpha > 0 && alpha < 0xFF,
         "alpha = " + alpha);
});

//----------------------------------------------------------------------------
// 3. Does the tint composite when drawn over the frame?
//
// If it paints over instead, the overlay hides the sky rather than shading it,
// and the whole point of shading - seeing what is underneath - is lost.
//----------------------------------------------------------------------------

say("");
say("==== 3. Drawing a translucent bitmap over another ====");

attempt("drawScaledBitmap with alpha", function () {
   var under = new Bitmap(4, 4);
   under.fill(0xFF204080);          // opaque, a recognisable colour

   var tint = new Bitmap(2, 2);
   tint.fill(0x5AA050FF);           // the overlay's tint

   var g = new Graphics(under);
   try {
      g.drawScaledBitmap(new Rect(0, 0, 4, 4), tint);
   } finally {
      g.end();
   }

   var mixed = under.pixel(1, 1);
   say("    under 0xff204080 + tint 0x5aa050ff -> 0x" + mixed.toString(16));
   check("the result is neither the sky nor the tint alone",
         mixed !== 0xFF204080 && (mixed & 0xFFFFFF) !== 0xA050FF,
         "0x" + mixed.toString(16));
   check("the result stays opaque", ((mixed >> 24) & 0xFF) === 0xFF);
});

//----------------------------------------------------------------------------
// 4. A painted mask, through PixInsight's own reader
//
// Written here rather than committed, so the probe does not depend on a
// fixture: half black and half white, saved, read back, thresholded.
//----------------------------------------------------------------------------

say("");
say("==== 4. Reading a painted mask ====");

function loadMaskLuminance(path, maxSide) {
   var windows = ImageWindow.open(path);
   if (!windows || windows.length === 0) {
      return null;
   }
   var win = windows[0];
   try {
      var Y = new Image();
      win.mainView.image.getLuminance(Y);
      var longest = Math.max(Y.width, Y.height);
      if (longest > maxSide) {
         Y.resample(maxSide / longest);
      }
      var m = Y.toMatrix();
      return { data: m.toArray(), width: Y.width, height: Y.height };
   } finally {
      win.forceClose();
   }
}

attempt("write, read and threshold a mask image", function () {
   var w = 200, h = 120;
   var painted = new Bitmap(w, h);
   painted.fill(0xFFFFFFFF);
   // The bottom third blacked out, which is what a landscape mask looks like.
   painted.fill(0, 80, w, h, 0xFF000000);
   var path = File.systemTempDirectory + "/probe_mask_painted.png";
   painted.save(path);
   check("the file was written", File.exists(path), path);

   var lum = loadMaskLuminance(path, 1024);
   check("loadMaskLuminance returned a field", lum !== null);
   if (lum === null) {
      return;
   }
   say("    read back at " + lum.width + "x" + lum.height
       + "   samples " + lum.data.length);

   // Sampled onto a detection grid a different size again, as it will be.
   var fw = 75, fh = 45;
   var mask = maskFromLuminance(lum.data, lum.width, lum.height, fw, fh);
   var excluded = maskExcludedFraction(mask);
   say("    excluded " + (excluded * 100).toFixed(1) + "% of the grid");
   check("black is excluded, and it is the third that was painted black",
         Math.abs(excluded - (h - 80) / h) < 0.03,
         "expected " + (((h - 80) / h) * 100).toFixed(1) + "%");

   // Which end is excluded matters as much as how much.
   check("the excluded rows are the bottom ones",
         mask[(fh - 2) * fw + 10] === 0 && mask[2 * fw + 10] === 1);

   // And the runs the overlay is drawn from must account for exactly that.
   var runs = maskRuns(mask, fw, fh);
   var covered = 0;
   for (var i = 0; i < runs.length; ++i) {
      covered += runs[i].x1 - runs[i].x0 + 1;
   }
   check("the overlay runs cover the excluded samples exactly",
         Math.abs(covered / (fw * fh) - excluded) < 1e-9,
         covered + " samples in " + runs.length + " runs");

   attempt("remove the temporary file", function () {
      File.remove(path);
   });
});

//----------------------------------------------------------------------------
// 5. The controls the Mask row is built from
//
// Constructed but never shown. This says nothing about how the row looks - only
// that every property and method it touches exists. That is the class of error
// that has cost the most here, because a control that throws on construction
// leaves the dialog silently absent.
//----------------------------------------------------------------------------

say("");
say("==== 5. Constructing the Mask row's controls ====");

attempt("NumericEdit", function () {
   var host = new Control;
   var ne = new NumericEdit(host);
   ne.label.text = "Bottom:";
   ne.label.setFixedWidth(60);
   ne.setRange(0, 100);
   ne.setReal(true);
   ne.setPrecision(1);
   ne.setValue(12.5);
   ne.edit.setFixedWidth(40);
   ne.toolTip = "<p>x</p>";
   ne.enabled = false;
   var got = ne.value;
   ne.onValueUpdated = function (value) { };
   check("NumericEdit accepts label, range, precision, value and enabled",
         Math.abs(got - 12.5) < 1e-9, "value read back as " + got);

   var angle = new NumericEdit(host);
   angle.setRange(-45, 45);
   angle.setReal(true);
   angle.setPrecision(1);
   angle.setValue(-5.5);
   check("a negative value survives a signed range",
         Math.abs(angle.value + 5.5) < 1e-9, "value read back as " + angle.value);
});

attempt("RadioButton", function () {
   var host = new Control;
   var a = new RadioButton(host);
   a.text = "Edges";
   a.checked = true;
   a.toolTip = "<p>x</p>";
   a.setFixedWidth(80);
   a.onCheck = function (checked) { };

   var b = new RadioButton(host);
   b.text = "Image";
   b.setFixedWidth(80);

   check("two RadioButtons under one parent are exclusive",
         a.checked === true && b.checked === false,
         "a " + a.checked + ", b " + b.checked);

   b.checked = true;
   check("checking the second clears the first",
         a.checked === false && b.checked === true,
         "a " + a.checked + ", b " + b.checked);
});

attempt("the constants the row uses", function () {
   var v = TextAlignment.Left | TextAlignment.VerticalCenter;
   check("TextAlignment.Left | VerticalCenter is a number", isFinite(v), "" + v);
   var c = new Cursor(StdCursor.Wait);
   check("StdCursor.Wait constructs a Cursor", c !== null);
});

//----------------------------------------------------------------------------

say("");
var failures = 0;
for (var i = 0; i < lines.length; ++i) {
   if (lines[i].indexOf("  FAIL") === 0 || lines[i].indexOf("  ERROR") === 0) {
      ++failures;
   }
}
say("failures: " + failures);
say("written to " + OUT);
