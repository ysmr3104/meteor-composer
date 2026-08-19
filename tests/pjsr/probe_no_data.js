#engine v8

//============================================================================
// probe_no_data.js - What is next to the candidates that hug the frame's edge?
//
// Sixty-one of 411 candidates sit within five samples of the image border, in
// 59 different frames. Six were reported by the operator as obviously not
// meteors, and they share a shape: one sample wide, and running parallel to an
// edge - either the frame's own border or the boundary of a large black wedge
// that registration left behind.
//
// The explanation on offer is that a line detector is finding the boundary
// between data and no data, which is a genuinely straight, high-contrast line.
// Before anything is built on that, it has to be true, so this measures it:
//
//   1. How much of each frame has no data at all, and where.
//   2. For each reported candidate, what fraction of its own extent is next to
//      a sample with no data. A boundary artefact should hug it along its whole
//      length; a meteor that merely reaches the edge should touch it at a tip.
//   3. The same for the meteors in the ground truth, because THE OBVIOUS FIX IS
//      WRONG. A visual meteor comes within 4 px of the border, so excluding a
//      band along the edge would take the recall gate with it. Whatever is
//      built has to separate "along the boundary" from "near it".
//
// Also measures what the black region does to the statistics. A frame that is
// 30% black has its median and MAD dragged down, and the threshold with them,
// which would raise the detection count over the WHOLE frame - not just at the
// edge.
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_no_data.js
//============================================================================

#include "../../javascript/paths.js"
#include "../../javascript/detection_core.js"
// detection_core.js merges collinear fragments through candidate_ops.js. Under
// PJSR that has to be included here: the fallback it would otherwise take is
// `require`, which does not exist.
#include "../../javascript/candidate_ops.js"

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var REGISTERED_DIR = DATA_ROOT + "/registered/" + GROUP;
var RESULTS_PATH = DATA_ROOT + "/detection_results.json";
var LOG_PATH = DATA_ROOT + "/probe_no_data.log";

var SCREEN_FACTOR = 8;

// The frames the operator named, plus ones with edge candidates, plus meteors
// that reach the edge - the last so that a rule can be checked against what it
// must NOT reject.
var FRAMES = [
   { tag: "DSC04912", why: "reported: black wedge edge" },
   { tag: "DSC04913", why: "reported: black wedge edge" },
   { tag: "DSC04932", why: "reported: no length as a line" },
   { tag: "DSC04933", why: "reported: no length as a line" },
   { tag: "DSC04944", why: "reported: no length as a line" },
   { tag: "DSC04981", why: "edge candidate, elongation 30" },
   { tag: "DSC05001", why: "MUST KEEP: visual meteor, 4 px from the border" },
   { tag: "DSC05032", why: "MUST KEEP: visual meteor, 44 px from the border" },
   { tag: "DSC05281", why: "MUST KEEP: meteor, 4 px from the border" },
   { tag: "DSC05542", why: "MUST KEEP: meteor, well clear of any edge" }
];

// How far from a sample with no data still counts as "next to" it.
var ADJACENCY = 2;

var _log = [];
var _logPath = null;

function flushLog() {
   var text = _log.join("\n") + "\n";
   var candidates = _logPath !== null
      ? [_logPath] : [LOG_PATH, File.systemTempDirectory + "/probe_no_data.log"];
   for (var i = 0; i < candidates.length; ++i) {
      try {
         File.writeTextFile(candidates[i], text);
         _logPath = candidates[i];
         return;
      } catch (e) {
      }
   }
}

function log(line) {
   _log.push(line);
   console.writeln(line);
   flushLog();
}

function section(title) {
   log("");
   log("==== " + title + " ====");
}

function pad(s, n) {
   s = String(s);
   while (s.length < n) {
      s = " " + s;
   }
   return s;
}

// The luminance field at 1/8. Copied from MeteorComposer.js's loadField rather
// than written afresh: a probe that reads the frames differently from the
// detector measures a different field, and the numbers would not transfer.
function loadField(path, factor) {
   var windows = ImageWindow.open(path);
   if (!windows || windows.length === 0) {
      return null;
   }
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

// Samples with no data. Registration leaves them at exactly zero, or not
// finite; the downsample averages 64 pixels, so a sample straddling the
// boundary comes out small but positive and is NOT flagged here. That is why
// adjacency, not equality, is the test used below.
function findNoData(field) {
   var flags = new Uint8Array(field.data.length);
   var count = 0;
   for (var i = 0; i < field.data.length; ++i) {
      var v = field.data[i];
      if (!(v > 0)) {
         flags[i] = 1;
         ++count;
      }
   }
   return { flags: flags, count: count };
}

// Is (x, y) within ADJACENCY samples of no data, or of the field's own border?
// Beyond the array there is no data either, and a candidate lying along the
// outermost column is the same finding as one lying along a black wedge.
function nearNoData(noData, width, height, x, y) {
   for (var dy = -ADJACENCY; dy <= ADJACENCY; ++dy) {
      for (var dx = -ADJACENCY; dx <= ADJACENCY; ++dx) {
         var nx = x + dx, ny = y + dy;
         if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            return true;
         }
         if (noData.flags[ny * width + nx]) {
            return true;
         }
      }
   }
   return false;
}

// What fraction of the candidate's own axis lies next to no data.
//
// Sampled along the segment between its endpoints rather than over its pixels,
// because the results file records the endpoints and not the component. Twenty
// steps is finer than the sample grid over any of these lengths.
function edgeFraction(candidate, noData, width, height) {
   var steps = 40;
   var touching = 0;
   for (var i = 0; i <= steps; ++i) {
      var t = i / steps;
      var x = Math.round(candidate.x0 + (candidate.x1 - candidate.x0) * t);
      var y = Math.round(candidate.y0 + (candidate.y1 - candidate.y0) * t);
      if (nearNoData(noData, width, height, x, y)) {
         ++touching;
      }
   }
   return touching / (steps + 1);
}

function statistics(values) {
   var usable = [];
   for (var i = 0; i < values.length; ++i) {
      if (isFinite(values[i])) {
         usable.push(values[i]);
      }
   }
   usable.sort(function (a, b) { return a - b; });
   if (usable.length === 0) {
      return { median: 0, mad: 0 };
   }
   var mid = usable.length >> 1;
   var med = usable.length % 2 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2;
   var dev = [];
   for (i = 0; i < usable.length; ++i) {
      dev.push(Math.abs(usable[i] - med));
   }
   dev.sort(function (a, b) { return a - b; });
   var dmid = dev.length >> 1;
   return { median: med,
            mad: dev.length % 2 ? dev[dmid] : (dev[dmid - 1] + dev[dmid]) / 2 };
}

function main() {
   log("MeteorComposer: what is next to the candidates at the frame's edge");
   log("started: " + (new Date()).toISOString());

   var results;
   try {
      results = JSON.parse(File.readTextFile(RESULTS_PATH));
   } catch (e) {
      log("[FAIL] could not read " + RESULTS_PATH + ": " + e);
      return;
   }

   var byTag = {};
   for (var f = 0; f < results.frames.length; ++f) {
      var m = results.frames[f].file.match(/DSC[0-9]+/);
      if (m !== null) {
         byTag[m[0]] = results.frames[f];
      }
   }

   section("1. How much of each frame has no data");
   log("  frame      why                                   no data   statistics");
   log("                                                            all / usable");

   var rows = [];
   for (var i = 0; i < FRAMES.length; ++i) {
      var entry = FRAMES[i];
      var record = byTag[entry.tag];
      if (record === undefined) {
         log("  " + entry.tag + "  not in the results file");
         continue;
      }
      var field = loadField(REGISTERED_DIR + "/" + record.file, SCREEN_FACTOR);
      if (field === null) {
         log("  " + entry.tag + "  could not be opened");
         continue;
      }
      var noData = findNoData(field);
      var fraction = noData.count / field.data.length;

      // The statistics as the detector computes them now - over everything -
      // against what they would be with the no-data samples left out.
      var all = statistics(field.data);
      var usableValues = [];
      for (var k = 0; k < field.data.length; ++k) {
         if (!noData.flags[k]) {
            usableValues.push(field.data[k]);
         }
      }
      var usable = statistics(usableValues);

      log("  " + entry.tag + "  " + entry.why.substring(0, 36)
          + pad("", Math.max(0, 36 - entry.why.length))
          + "  " + pad((fraction * 100).toFixed(1) + "%", 7)
          + "   median " + all.median.toExponential(2) + " / "
          + usable.median.toExponential(2)
          + "   MAD " + all.mad.toExponential(2) + " / " + usable.mad.toExponential(2));

      rows.push({ entry: entry, record: record, field: field, noData: noData,
                  fraction: fraction, all: all, usable: usable });
      CoreApplication.processEvents();
   }

   section("2. Does the threshold move when no data is excluded?");
   log("  A threshold is median + k * 1.4826 * MAD. Excluding the black region");
   log("  raises both, so the threshold rises and the frame stops being over-");
   log("  sensitive. k = 5.");
   log("");
   log("  frame      threshold now   threshold excluded   ratio");
   for (i = 0; i < rows.length; ++i) {
      var r = rows[i];
      var now = r.all.median + 5 * 1.4826 * r.all.mad;
      var fixed = r.usable.median + 5 * 1.4826 * r.usable.mad;
      log("  " + r.entry.tag + "  " + pad(now.toExponential(3), 13)
          + "   " + pad(fixed.toExponential(3), 18)
          + "   " + pad((now > 0 ? fixed / now : 0).toFixed(3), 6));
   }

   section("3. Does each candidate lie ALONG the boundary, or merely near it?");
   log("  edge = the fraction of the candidate's own axis that is within "
       + ADJACENCY + " samples");
   log("  of a sample with no data, or of the field's border.");
   log("");
   log("  frame      cand  len   elong  minor  angle    edge   verdict wanted");
   for (i = 0; i < rows.length; ++i) {
      var row = rows[i];
      var cands = row.record.candidates || [];
      if (cands.length === 0) {
         log("  " + row.entry.tag + "  (no candidates recorded)");
         continue;
      }
      for (var c = 0; c < cands.length; ++c) {
         var cand = cands[c];
         var frac = edgeFraction(cand, row.noData, row.field.width, row.field.height);
         var wanted = row.entry.why.indexOf("MUST KEEP") === 0 ? "KEEP" : "reject";
         log("  " + row.entry.tag + "  " + pad(c, 4)
             + "  " + pad((cand.majorLength || 0).toFixed(0), 4)
             + "  " + pad((cand.elongation || 0).toFixed(1), 5)
             + "  " + pad((cand.minorLength || 0).toFixed(2), 5)
             + "  " + pad((cand.angle || 0).toFixed(1), 6)
             + "   " + pad((frac * 100).toFixed(0) + "%", 5)
             + "   " + wanted);
      }
   }

   section("Conclusion to read off this");
   log("  If the candidates to reject come out near 100% and the meteors to");
   log("  keep come out low, then \"lies along the boundary\" separates them and");
   log("  \"near an edge\" does not. That is the difference between a rule that");
   log("  can be used and one that would delete a meteor from the recall gate.");

   section("Done");
   log("finished: " + (new Date()).toISOString());
   flushLog();
}

main();
