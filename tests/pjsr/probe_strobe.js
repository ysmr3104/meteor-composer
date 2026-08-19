#engine v8

//============================================================================
// probe_strobe.js - Why is a strobing aircraft detected in one frame and not
// the next?
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_strobe.js
//   ssh mbp4ysmr cat /tmp/probe_strobe.txt
//
// An aircraft's anti-collision light flashes, so its trail is a row of dashes
// rather than a line. In DSC05337 it came back as one component 25 samples
// long; in DSC05338, where the image shows it clearly and longer, nothing was
// reported at all.
//
// That is either a threshold problem (the dashes are below it) or a filter
// problem (each dash is its own component and too small to pass minPixels /
// minLength / minElongation on its own). The two want completely different
// fixes, so this measures which it is rather than guessing:
//
//   1. what the operational settings find
//   2. what components exist in the region of the trail, at what size
//   3. what a lower threshold finds
//   4. what merging the small components first would produce
//============================================================================

#include "../../javascript/detection_core.js"
#include "../../javascript/candidate_ops.js"

#define OUT "/tmp/probe_strobe.txt"

var DATA = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var FRAMES = [5337, 5338, 5339, 5340, 5341];

// Where the aircraft's trail is, in 1/8 samples, per frame. Read off the crops
// in /tmp/crops: it runs along y ~ 90-100, moving right.
var BAND = { y0: 80, y1: 115 };

var lines = [];
function say(t) { lines.push(t); File.writeTextFile(OUT, lines.join("\n") + "\n"); console.writeln(t); }
function pad(s, n) { s = "" + s; while (s.length < n) { s = " " + s; } return s; }

function loadField(path, factor) {
   var windows = ImageWindow.open(path);
   if (!windows || windows.length === 0) { return null; }
   var win = windows[0];
   try {
      var Y = new Image();
      win.mainView.image.getLuminance(Y);
      Y.resample(1.0 / factor);
      var m = Y.toMatrix();
      return { data: m.toArray(), width: Y.width, height: Y.height };
   } finally {
      win.forceClose();
   }
}

var find = new FileFind;
var names = [];
if (find.begin(DATA + "/registered/" + GROUP + "/*.xisf")) {
   do { if (!find.isDirectory) { names.push(find.name); } } while (find.next());
}
names.sort();

say("probe_strobe.js");
say("band of interest: y " + BAND.y0 + " to " + BAND.y1 + " (1/8 samples)");
say("");

for (var fi = 0; fi < FRAMES.length; ++fi) {
   var n = FRAMES[fi];
   var file = null;
   for (var i = 0; i < names.length; ++i) {
      if (names[i].indexOf("DSC0" + n) >= 0) { file = names[i]; break; }
   }
   if (file === null) { say(n + ": not found"); continue; }

   var field = loadField(DATA + "/registered/" + GROUP + "/" + file, 8);
   if (field === null) { say(n + ": could not open"); continue; }

   say("==== DSC0" + n + "  field " + field.width + "x" + field.height + " ====");

   // 1. The operational settings.
   var op = detectCandidates(field, { k: 5.0, minPixels: 12, minElongation: 6.0,
                                      minLength: 10.0 });
   var inBand = [];
   for (i = 0; i < op.candidates.length; ++i) {
      var c = op.candidates[i];
      if (c.cy >= BAND.y0 && c.cy <= BAND.y1) { inBand.push(c); }
   }
   say("  operational: " + op.candidates.length + " candidates, "
       + inBand.length + " in the band"
       + "   sigma " + op.sigma.toExponential(2) + "  level " + op.level.toExponential(2));
   for (i = 0; i < inBand.length; ++i) {
      say("      (" + inBand[i].x0.toFixed(0) + "," + inBand[i].y0.toFixed(0) + ")-("
          + inBand[i].x1.toFixed(0) + "," + inBand[i].y1.toFixed(0) + ")"
          + "  len " + inBand[i].length.toFixed(1) + "  px " + inBand[i].pixelCount);
   }

   // 2-4. The same field with the filters removed, so every component in the
   // band is visible with its size. minPixels 1 keeps everything the threshold
   // found; elongation and length are dropped to zero.
   var all = detectCandidates(field, { k: 5.0, minPixels: 1, minElongation: 0,
                                       minLength: 0 });
   var band = [];
   for (i = 0; i < all.candidates.length; ++i) {
      var a = all.candidates[i];
      if (a.cy >= BAND.y0 && a.cy <= BAND.y1) { band.push(a); }
   }
   band.sort(function (p, q) { return p.cx - q.cx; });
   say("  unfiltered:  " + all.candidates.length + " components, "
       + band.length + " in the band");

   // How they are distributed by size, which is what decides whether a relaxed
   // pre-filter is affordable.
   var buckets = [1, 2, 3, 4, 6, 8, 12];
   var counts = [];
   for (var b = 0; b < buckets.length; ++b) {
      var k = 0;
      for (i = 0; i < all.candidates.length; ++i) {
         if (all.candidates[i].pixelCount >= buckets[b]) { ++k; }
      }
      counts.push(buckets[b] + "px:" + k);
   }
   say("  whole frame, components at least N pixels:  " + counts.join("  "));

   // The pieces along the trail, left to right.
   var shown = 0;
   for (i = 0; i < band.length && shown < 14; ++i) {
      var p = band[i];
      say("      x " + pad(p.cx.toFixed(0), 4) + "  y " + pad(p.cy.toFixed(0), 4)
          + "  px " + pad(p.pixelCount, 3)
          + "  len " + pad(p.length.toFixed(1), 5)
          + "  elong " + pad(p.elongation.toFixed(1), 5));
      ++shown;
   }
   if (band.length > shown) { say("      ... and " + (band.length - shown) + " more"); }

   say("");
}

say("written to " + OUT);
