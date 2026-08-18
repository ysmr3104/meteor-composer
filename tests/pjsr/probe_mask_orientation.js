#engine v8

//============================================================================
// probe_mask_orientation.js - Does a painted mask land where it was painted?
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_mask_orientation.js
//   ssh mbp4ysmr cat /tmp/probe_mask_orientation.txt
//
// The operator painted a mask as a JPEG and reported that the excluded region
// came out somewhere other than where they painted it. Their guess was that the
// file needed rotating.
//
// Before adding a rotation control - which would be a workaround if the
// pipeline is the thing that is wrong - this asks where the black actually ends
// up, at three points:
//
//   1. straight out of PixInsight's reader, before anything of ours touches it
//   2. after loadMaskLuminance() resamples it
//   3. after maskFromLuminance() puts it on the detection grid
//
// and prints the same quadrant breakdown for the frame's own no-data wedge, so
// the two can be read against each other.
//
// A quadrant breakdown rather than a picture, because the question is only
// "which corner", and a number can be compared without opening anything.
//============================================================================

#include "../../javascript/mask_geometry.js"

#define OUT "/tmp/probe_mask_orientation.txt"

var MASK = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/mask_file.jpg";
var FRAMES = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/registered/"
           + "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";

var lines = [];

function say(text) {
   lines.push(text);
   File.writeTextFile(OUT, lines.join("\n") + "\n");
   console.writeln(text);
}

function pad(s, n) {
   s = "" + s;
   while (s.length < n) {
      s = " " + s;
   }
   return s;
}

// What fraction of each quadrant satisfies `isDark`. Quadrants, not a full
// picture, because the only question is which corner the region sits in.
function quadrants(width, height, isDark) {
   var counts = [0, 0, 0, 0];
   var totals = [0, 0, 0, 0];
   var halfX = width / 2;
   var halfY = height / 2;
   for (var y = 0; y < height; ++y) {
      for (var x = 0; x < width; ++x) {
         var q = (y < halfY ? 0 : 2) + (x < halfX ? 0 : 1);
         ++totals[q];
         if (isDark(x, y)) {
            ++counts[q];
         }
      }
   }
   var out = [];
   for (var i = 0; i < 4; ++i) {
      out.push(totals[i] === 0 ? 0 : counts[i] / totals[i]);
   }
   return out;
}

function report(label, q) {
   say("  " + label);
   say("      top-left " + pad((q[0] * 100).toFixed(1), 6) + "%"
       + "     top-right " + pad((q[1] * 100).toFixed(1), 6) + "%");
   say("   bottom-left " + pad((q[2] * 100).toFixed(1), 6) + "%"
       + "  bottom-right " + pad((q[3] * 100).toFixed(1), 6) + "%");
}

say("probe_mask_orientation.js");
say("");
say("mask   " + MASK);
say("frames " + FRAMES);
say("");

//----------------------------------------------------------------------------
// 1. Straight out of the reader
//----------------------------------------------------------------------------

say("==== 1. As PixInsight reads the JPEG ====");
say("");

var lumFull = null;
try {
   var windows = ImageWindow.open(MASK);
   if (!windows || windows.length === 0) {
      say("  ERROR: could not open the mask");
   } else {
      var win = windows[0];
      try {
         var img = win.mainView.image;
         say("  opened at " + img.width + "x" + img.height
             + "   channels " + img.numberOfChannels);
         var Y = new Image();
         img.getLuminance(Y);
         // Sampled directly, so nothing of ours has touched the ordering yet.
         // image.sample(x, y) with y = 0 is the row PixInsight calls the first.
         var q = quadrants(60, 40, function (x, y) {
            return Y.sample(Math.floor((x + 0.5) * Y.width / 60),
                            Math.floor((y + 0.5) * Y.height / 40)) < 0.5;
         });
         report("black, sampled through Image.sample() on a 60x40 grid:", q);
         say("");
         say("  corner samples (0,0) top-left     = "
             + Y.sample(2, 2).toFixed(3));
         say("                 (w-1,0) top-right  = "
             + Y.sample(Y.width - 3, 2).toFixed(3));
         say("                 (0,h-1) bottom-left  = "
             + Y.sample(2, Y.height - 3).toFixed(3));
         say("                 (w-1,h-1) bottom-right = "
             + Y.sample(Y.width - 3, Y.height - 3).toFixed(3));
      } finally {
         win.forceClose();
      }
   }
} catch (e) {
   say("  ERROR: " + e);
}

//----------------------------------------------------------------------------
// 2. After loadMaskLuminance, which is what the dialog calls
//----------------------------------------------------------------------------

say("");
say("==== 2. After loadMaskLuminance() ====");
say("");

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

var lum = null;
try {
   lum = loadMaskLuminance(MASK, 1024);
   if (lum === null) {
      say("  ERROR: returned null");
   } else {
      say("  resampled to " + lum.width + "x" + lum.height);
      var qq = quadrants(lum.width, lum.height, function (x, y) {
         return lum.data[y * lum.width + x] < 0.5;
      });
      report("black, indexing data as row-major with row 0 first:", qq);
   }
} catch (e) {
   say("  ERROR: " + e);
}

//----------------------------------------------------------------------------
// 3. On the detection grid, which is what detection and the overlay both use
//----------------------------------------------------------------------------

say("");
say("==== 3. After maskFromLuminance() onto the detection grid ====");
say("");

try {
   if (lum !== null) {
      var fw = 753, fh = 503;
      var mask = maskFromLuminance(lum.data, lum.width, lum.height, fw, fh);
      var qm = quadrants(fw, fh, function (x, y) {
         return mask[y * fw + x] === 0;
      });
      report("excluded (mask === 0):", qm);
      say("");
      say("  total excluded " + (maskExcludedFraction(mask) * 100).toFixed(1) + "%");
      var runs = maskRuns(mask, fw, fh);
      say("  overlay runs " + runs.length
          + ", first run at row " + (runs.length > 0 ? runs[0].y : -1)
          + ", last at row " + (runs.length > 0 ? runs[runs.length - 1].y : -1));
      say("  (the overlay bitmap is filled from these, row 0 at the top)");
   }
} catch (e) {
   say("  ERROR: " + e);
}

//----------------------------------------------------------------------------
// 4. The frame's own no-data wedge, for comparison
//----------------------------------------------------------------------------

say("");
say("==== 4. The first frame's no-data region ====");
say("");

try {
   var find = new FileFind;
   var names = [];
   if (find.begin(FRAMES + "/*.xisf")) {
      do {
         if (!find.isDirectory) {
            names.push(find.name);
         }
      } while (find.next());
   }
   names.sort();
   if (names.length === 0) {
      say("  no frames found");
   } else {
      say("  " + names[0]);
      var fwin = ImageWindow.open(FRAMES + "/" + names[0])[0];
      try {
         var FY = new Image();
         fwin.mainView.image.getLuminance(FY);
         FY.resample(1.0 / 8);
         var fm = FY.toMatrix();
         var fdata = fm.toArray();
         say("  field " + FY.width + "x" + FY.height);
         var qf = quadrants(FY.width, FY.height, function (x, y) {
            var v = fdata[y * FY.width + x];
            return v === 0 || !isFinite(v);
         });
         report("no data (exactly zero), same indexing:", qf);
      } finally {
         fwin.forceClose();
      }
   }
} catch (e) {
   say("  ERROR: " + e);
}

say("");
say("written to " + OUT);
