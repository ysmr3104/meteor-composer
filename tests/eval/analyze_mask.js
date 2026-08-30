//============================================================================
// analyze_mask.js - How big are the masks we are actually building?
//
// Run: node tests/eval/analyze_mask.js [results.json] [session.json]
//
// The composited meteors sit in visibly altered patches of sky, and the two
// frames of a meteor that spanned an exposure boundary came out with a black
// gouge in them. Both point at the mask geometry, so this reports the geometry
// itself - no image data needed, only the candidate measurements and the
// screening verdicts.
//
// Two questions:
//
//   1. How wide is each mask compared with the trail it is supposed to cover?
//      DEFAULT_MASK_OPTIONS puts the solid core at coreScale times the
//      measured half-width and then adds featherWidth on top, so a trail a few
//      pixels wide can end up inside a capsule a hundred pixels across. If it
//      does, that is the "the mask is far too large" report, measured.
//
//   2. Do masks from different frames overlap? They must, for a meteor that
//      crossed an exposure boundary: the two trails are consecutive stretches
//      of one path, so their capsules meet. That matters because the composite
//      is accumulated - each frame is fitted against a master that already
//      contains the previous frame's meteor - so in the overlap the second
//      frame's residual is the NEGATIVE of the first frame's light. That is
//      the mechanism that digs a hole, and this tells us whether the geometry
//      allows it.
//
// This is evaluation, not a test: it measures the current configuration and
// reports it. Nothing here asserts.
//============================================================================

var fs = require("fs");
var path = require("path");

var DEFAULT_RESULTS = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-sky/detection_results.json";
var DEFAULT_SESSION = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-sky/meteor_session.json";

var SCREEN_FACTOR = 8;

// What tests/pjsr/run_composite.js used for the composite under inspection.
var MASK_OPTIONS = {
   coreRadius: 8,
   coreScale: 2.5,
   featherWidth: 32,
   endExtension: 16
};

var trailMask = require(path.join(__dirname, "..", "..", "javascript", "trail_mask.js"));

function sampleCentreToImage(n, scale) {
   return (n + 0.5) * scale - 0.5;
}

function segmentLength(t) {
   var dx = t.x1 - t.x0;
   var dy = t.y1 - t.y0;
   return Math.sqrt(dx * dx + dy * dy);
}

// Smallest distance between two segments, by sampling. Exact to within the
// sampling step, which is far finer than the tens of pixels that decide
// whether two capsules touch.
function segmentDistance(a, b) {
   var best = Infinity;
   var steps = 200;
   var i, t, px, py, d;
   for (i = 0; i <= steps; ++i) {
      t = i / steps;
      px = a.x0 + (a.x1 - a.x0) * t;
      py = a.y0 + (a.y1 - a.y0) * t;
      d = trailMask.distanceToSegment(px, py, b.x0, b.y0, b.x1, b.y1);
      if (d < best) {
         best = d;
      }
   }
   for (i = 0; i <= steps; ++i) {
      t = i / steps;
      px = b.x0 + (b.x1 - b.x0) * t;
      py = b.y0 + (b.y1 - b.y0) * t;
      d = trailMask.distanceToSegment(px, py, a.x0, a.y0, a.x1, a.y1);
      if (d < best) {
         best = d;
      }
   }
   return best;
}

// Area of a capsule: the rectangle along the axis plus the two half-discs.
function capsuleArea(length, reach) {
   return length * 2 * reach + Math.PI * reach * reach;
}

function median(values) {
   if (values.length === 0) {
      return 0;
   }
   var s = values.slice().sort(function (a, b) { return a - b; });
   var mid = s.length >> 1;
   return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function main() {
   var positional = process.argv.slice(2).filter(function (a) {
      return a.indexOf("-") !== 0;
   });
   var resultsPath = positional[0] || DEFAULT_RESULTS;
   var sessionPath = positional[1] || DEFAULT_SESSION;

   if (!fs.existsSync(resultsPath) || !fs.existsSync(sessionPath)) {
      console.error("inputs not found:");
      console.error("  " + resultsPath);
      console.error("  " + sessionPath);
      process.exit(2);
   }

   var results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
   var session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));

   var candidatesByFile = {};
   results.frames.forEach(function (frame) {
      candidatesByFile[frame.file] = frame.candidates || [];
   });

   var trails = [];
   (session.verdicts || []).forEach(function (v) {
      if (v.verdict !== "meteor") {
         return;
      }
      var cands = candidatesByFile[v.file];
      if (!cands) {
         return;
      }
      var c = cands[v.indexInFrame];
      if (!c) {
         return;
      }
      trails.push({
         file: v.file,
         x0: sampleCentreToImage(c.x0, SCREEN_FACTOR),
         y0: sampleCentreToImage(c.y0, SCREEN_FACTOR),
         x1: sampleCentreToImage(c.x1, SCREEN_FACTOR),
         y1: sampleCentreToImage(c.y1, SCREEN_FACTOR),
         width: (c.minorLength || 0) * SCREEN_FACTOR,
         minorLength: c.minorLength || 0,
         majorLength: c.majorLength || 0
      });
   });

   trails.sort(function (a, b) { return a.file < b.file ? -1 : 1; });

   var frameWidth = (results.options && results.options.imageWidth) || 6024;
   var frameHeight = (results.options && results.options.imageHeight) || 4024;
   var framePixels = frameWidth * frameHeight;

   console.log("MeteorComposer mask geometry");
   console.log("");
   console.log("results: " + resultsPath);
   console.log("session: " + sessionPath);
   console.log("accepted trails: " + trails.length);
   console.log("mask options: coreRadius " + MASK_OPTIONS.coreRadius
               + "  coreScale " + MASK_OPTIONS.coreScale
               + "  featherWidth " + MASK_OPTIONS.featherWidth
               + "  endExtension " + MASK_OPTIONS.endExtension);
   console.log("");

   console.log("==== 1. Mask width against trail width ====");
   console.log("");
   console.log("file                                          len   trail_w  core   reach  reach/half_w   area%");

   var reaches = [];
   var ratios = [];
   var areaSum = 0;
   trails.forEach(function (t) {
      var len = segmentLength(t);
      var core = trailMask.coreRadiusFor(t, MASK_OPTIONS);
      var reach = core + MASK_OPTIONS.featherWidth;
      var area = capsuleArea(len + 2 * MASK_OPTIONS.endExtension, reach);
      var halfWidth = t.width > 0 ? t.width / 2 : 0.5;
      reaches.push(reach);
      ratios.push(reach / halfWidth);
      areaSum += area;
      console.log("  " + t.file.substring(0, 42)
                  + "  " + pad(len.toFixed(0), 5)
                  + "  " + pad(t.width.toFixed(1), 7)
                  + "  " + pad(core.toFixed(1), 5)
                  + "  " + pad(reach.toFixed(1), 6)
                  + "  " + pad((reach / halfWidth).toFixed(1), 10)
                  + "  " + pad((area / framePixels * 100).toFixed(3), 6));
   });

   console.log("");
   console.log("  median reach:            " + median(reaches).toFixed(1) + " px from the axis");
   console.log("  median reach / half-width: " + median(ratios).toFixed(1) + "x");
   console.log("  total capsule area:      " + (areaSum / framePixels * 100).toFixed(2)
               + "% of the frame");
   console.log("");
   console.log("  The mask has to cover the trail's own light, which spreads");
   console.log("  further than the pixels that crossed the detection threshold.");
   console.log("  How much further is a measurement, not a guess: see");
   console.log("  tests/pjsr/probe_trail_profile.js. This table only says how");
   console.log("  wide the current settings make it.");

   console.log("");
   console.log("==== 2. Masks that overlap across frames ====");
   console.log("");
   console.log("  In an overlap the second frame is fitted against a master");
   console.log("  that already contains the first frame's meteor, so its");
   console.log("  residual there is that light with a minus sign.");
   console.log("");

   var overlaps = 0;
   var i, j;
   for (i = 0; i < trails.length; ++i) {
      for (j = i + 1; j < trails.length; ++j) {
         if (trails[i].file === trails[j].file) {
            continue;
         }
         var d = segmentDistance(trails[i], trails[j]);
         var reachSum = reaches[i] + reaches[j];
         if (d < reachSum) {
            ++overlaps;
            console.log("  " + trails[i].file.substring(0, 40));
            console.log("  " + trails[j].file.substring(0, 40));
            console.log("     segment distance " + d.toFixed(1)
                        + " px  <  combined reach " + reachSum.toFixed(1) + " px"
                        + "   OVERLAP");
            // How tight the mask would have to be for these two to stop
            // touching, which is a lower bound on "just shrink the mask".
            console.log("     they would stop touching below a reach of "
                        + (d / 2).toFixed(1) + " px each");
            console.log("");
         }
      }
   }
   if (overlaps === 0) {
      console.log("  none at the current reach.");
      console.log("");
      console.log("  That does not clear the accumulation: a frame is still");
      console.log("  fitted against a master carrying earlier meteors, and the");
      console.log("  fit is global. It only means no mask sits on top of one.");
   } else {
      console.log("  " + overlaps + " overlapping pair(s).");
   }

   console.log("");
   console.log("==== 3. Same-frame trails ====");
   var byFile = {};
   trails.forEach(function (t) {
      byFile[t.file] = (byFile[t.file] || 0) + 1;
   });
   var multi = Object.keys(byFile).filter(function (f) { return byFile[f] > 1; });
   console.log("  frames with more than one accepted trail: " + multi.length);
   multi.forEach(function (f) {
      console.log("    " + f + "  (" + byFile[f] + ")");
   });
   console.log("");
   console.log("  Trails in the same frame share one mask and one residual, so");
   console.log("  they cannot dig into each other. Only cross-frame overlaps do.");
}

function pad(s, n) {
   s = String(s);
   while (s.length < n) {
      s = " " + s;
   }
   return s;
}

main();
