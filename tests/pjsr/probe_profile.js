#engine v8

//============================================================================
// probe_profile.js - Does brightness along the trail separate meteors from
// satellites?
//
// Run:
//   tools/run-remote.sh --pjsr tests/pjsr/probe_profile.js
//   ssh mbp4ysmr cat /tmp/probe_profile.txt
//
// The strict list is 62 rows, 30 labelled meteors and 31 labelled not-meteors,
// and nothing measured so far separates them: length, elongation, pixel count,
// width, edge contact, angle and track length all overlap, and colour helps the
// ORDER but cannot cut (docs/requirements.md 6.1.6).
//
// One physical difference has never been measured. A meteor is a brief event:
// it brightens, peaks and fades within a fraction of the exposure, so its trail
// has a profile. A satellite is lit for the whole thirteen seconds at a roughly
// constant brightness, so its trail is flat. An aircraft's anti-collision light
// flashes, so its trail is periodic.
//
// This measures the profile along every candidate and reports, per labelled
// class:
//
//   peakRatio     peak / mean               - a peaked trail scores high
//   endRatio      mean of the ends / peak   - a meteor fades at least one end
//   flatness      standard deviation / mean - a flat trail scores low
//   asymmetry     where the peak sits, 0 to 1 - a meteor peaks off-centre
//   zeroRuns      how much of the trail is at or below the background
//
// It asserts nothing. If a feature separates the two classes it will show in
// the quartiles, and only then is it worth building on.
//============================================================================

#include "../../javascript/detection_core.js"
#include "../../javascript/candidate_ops.js"
#include "../../javascript/trail_colour.js"

#define OUT "/tmp/probe_profile.txt"

var DATA = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-sky";
var GROUP = "Light_BIN-1_6024x4024_EXPOSURE-13.00s_FILTER-NoFilter_RGB";
var RESULTS = DATA + "/detection_results.json";
var GT = DATA + "/../../../Users/ysmr/projects/pixinsight/meteor-composer/tests/eval/ground_truth.json";
var SCREEN_FACTOR = 8;

// Along the trail. Enough to see a shape without averaging it away.
var SAMPLES = 40;
// Across it, to find the light: the axis is off by up to a dozen pixels.
var SEARCH = 6;
var BACKGROUND = 24;

var lines = [];
function say(t) { lines.push(t); File.writeTextFile(OUT, lines.join("\n") + "\n"); console.writeln(t); }
function pad(s, n) { s = "" + s; while (s.length < n) { s = " " + s; } return s; }

// Brightness along the trail, background subtracted, as an array.
function profileOf(image, candidate) {
   var x0 = sampleCentreToImagePosition(candidate.x0, SCREEN_FACTOR);
   var y0 = sampleCentreToImagePosition(candidate.y0, SCREEN_FACTOR);
   var x1 = sampleCentreToImagePosition(candidate.x1, SCREEN_FACTOR);
   var y1 = sampleCentreToImagePosition(candidate.y1, SCREEN_FACTOR);
   var dx = x1 - x0, dy = y1 - y0;
   var len = Math.sqrt(dx * dx + dy * dy);
   if (!(len >= 1)) {
      return null;
   }
   var ux = dx / len, uy = dy / len;
   var px = -uy, py = ux;
   var w = image.width, h = image.height;
   var out = [];

   for (var s = 0; s <= SAMPLES; ++s) {
      var f = s / SAMPLES;
      var cx = x0 + dx * f, cy = y0 + dy * f;
      var best = -Infinity;
      for (var r = -SEARCH; r <= SEARCH; ++r) {
         var sx = Math.round(cx + px * r), sy = Math.round(cy + py * r);
         if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
            continue;
         }
         var v = image.sample(sx, sy, 0) + image.sample(sx, sy, 1)
               + image.sample(sx, sy, 2);
         if (v > best) {
            best = v;
         }
      }
      if (best === -Infinity) {
         continue;
      }
      var b1x = Math.max(0, Math.min(w - 1, Math.round(cx + px * BACKGROUND)));
      var b1y = Math.max(0, Math.min(h - 1, Math.round(cy + py * BACKGROUND)));
      var b2x = Math.max(0, Math.min(w - 1, Math.round(cx - px * BACKGROUND)));
      var b2y = Math.max(0, Math.min(h - 1, Math.round(cy - py * BACKGROUND)));
      var bg = 0;
      for (var c = 0; c < 3; ++c) {
         bg += (image.sample(b1x, b1y, c) + image.sample(b2x, b2y, c)) / 2;
      }
      out.push(best - bg);
   }
   return out.length >= 5 ? out : null;
}

// The shape features, from the profile.
function featuresOf(p) {
   var n = p.length;
   var sum = 0, peak = -Infinity, peakAt = 0;
   var i;
   for (i = 0; i < n; ++i) {
      sum += p[i];
      if (p[i] > peak) { peak = p[i]; peakAt = i; }
   }
   var mean = sum / n;
   if (!(mean > 0) || !(peak > 0)) {
      return null;
   }
   var varSum = 0;
   for (i = 0; i < n; ++i) {
      varSum += (p[i] - mean) * (p[i] - mean);
   }
   var sd = Math.sqrt(varSum / n);

   // The ends: a meteor fades into at least one of them.
   var edge = Math.max(1, Math.round(n * 0.15));
   var endSum = 0, endN = 0;
   for (i = 0; i < edge; ++i) { endSum += p[i]; ++endN; }
   for (i = n - edge; i < n; ++i) { endSum += p[i]; ++endN; }

   var atOrBelow = 0;
   for (i = 0; i < n; ++i) {
      if (p[i] <= 0) { ++atOrBelow; }
   }

   return {
      peakRatio: peak / mean,
      endRatio: (endSum / endN) / peak,
      flatness: sd / mean,
      asymmetry: Math.abs(peakAt / (n - 1) - 0.5) * 2,
      zeroFraction: atOrBelow / n
   };
}

function loadJSON(path) {
   return JSON.parse(File.readTextFile(path));
}

say("probe_profile.js");
say("");

var results = loadJSON(RESULTS);
var gt = loadJSON("/Users/ysmr/projects/pixinsight/meteor-composer/tests/eval/ground_truth.json");

function centre(entry) {
   return { x: (entry.x0 + entry.x1) / 2, y: (entry.y0 + entry.y1) / 2 };
}
function toImage(n) { return (n + 0.5) * SCREEN_FACTOR - 0.5; }

// Label every candidate by matching position, the same way the evaluation does.
var labelled = {};
function assign(list, name) {
   for (var i = 0; i < list.length; ++i) {
      var g = centre(list[i]);
      var best = null, bd = Infinity;
      for (var f = 0; f < results.frames.length; ++f) {
         if (results.frames[f].file !== list[i].file) { continue; }
         var cs = results.frames[f].candidates || [];
         for (var c = 0; c < cs.length; ++c) {
            var d = Math.sqrt(Math.pow(toImage(cs[c].cx) - g.x, 2)
                            + Math.pow(toImage(cs[c].cy) - g.y, 2));
            if (d < bd) { bd = d; best = list[i].file + ":" + c; }
         }
      }
      if (best !== null && bd <= 120 && labelled[best] === undefined) {
         labelled[best] = name;
      }
   }
}
assign(gt.meteors.filter(function (m) { return m.labelled_by !== "screening"; }), "visual");
assign(gt.meteors.filter(function (m) { return m.labelled_by === "screening"; }), "screening");
assign(gt.known_false_positives || [], "not-meteor");

var counts = {};
for (var k in labelled) { counts[labelled[k]] = (counts[labelled[k]] || 0) + 1; }
say("labelled: " + JSON.stringify(counts));
say("");

// Only frames that hold a labelled candidate are worth opening.
var wanted = {};
for (k in labelled) { wanted[k.split(":")[0]] = true; }
var frameCount = 0;
for (k in wanted) { ++frameCount; }
say("opening " + frameCount + " frames");
say("");

var rows = [];
var opened = 0;
for (var fi = 0; fi < results.frames.length; ++fi) {
   var frame = results.frames[fi];
   if (!wanted[frame.file]) { continue; }
   ++opened;
   if (opened % 50 === 0) { say("  ... " + opened + " / " + frameCount); }
   var windows = null;
   try {
      windows = ImageWindow.open(DATA + "/registered/" + GROUP + "/" + frame.file);
   } catch (e) {
      continue;
   }
   if (!windows || windows.length === 0) { continue; }
   var win = windows[0];
   try {
      var image = win.mainView.image;
      var cs = frame.candidates || [];
      for (var c = 0; c < cs.length; ++c) {
         var label = labelled[frame.file + ":" + c];
         if (label === undefined) { continue; }
         var prof = profileOf(image, cs[c]);
         if (prof === null) { continue; }
         var f = featuresOf(prof);
         if (f === null) { continue; }
         f.label = label;
         f.file = frame.file;
         f.length = cs[c].length;
         rows.push(f);
      }
   } catch (e2) {
      say("  [error] " + frame.file + ": " + e2);
   } finally {
      win.forceClose();
   }
}

say("");
say("measured " + rows.length + " labelled candidates");
say("");

var FEATURES = ["peakRatio", "endRatio", "flatness", "asymmetry", "zeroFraction"];
var CLASSES = ["visual", "screening", "not-meteor"];

for (var q = 0; q < FEATURES.length; ++q) {
   var name = FEATURES[q];
   say("==== " + name + " ====");
   for (var cl = 0; cl < CLASSES.length; ++cl) {
      var v = [];
      for (var i = 0; i < rows.length; ++i) {
         if (rows[i].label === CLASSES[cl] && isFinite(rows[i][name])) {
            v.push(rows[i][name]);
         }
      }
      if (v.length === 0) { say("  " + pad(CLASSES[cl], 12) + " none"); continue; }
      v.sort(function (a, b) { return a - b; });
      var pick = function (p) { return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };
      say("  " + pad(CLASSES[cl], 12)
          + " n=" + pad(v.length, 3)
          + "  min " + pad(v[0].toFixed(3), 7)
          + "  p25 " + pad(pick(0.25).toFixed(3), 7)
          + "  med " + pad(pick(0.5).toFixed(3), 7)
          + "  p75 " + pad(pick(0.75).toFixed(3), 7)
          + "  max " + pad(v[v.length - 1].toFixed(3), 7));
   }

   // Best single threshold, by balanced accuracy - the same measure 6.1.0 used,
   // so the two are comparable. Meteors are visual + screening together.
   var pos = [], neg = [];
   for (i = 0; i < rows.length; ++i) {
      if (!isFinite(rows[i][name])) { continue; }
      if (rows[i].label === "not-meteor") { neg.push(rows[i][name]); }
      else { pos.push(rows[i][name]); }
   }
   var bestAcc = 0, bestT = 0, bestDir = ">=";
   var all = pos.concat(neg).slice().sort(function (a, b) { return a - b; });
   for (i = 0; i < all.length; ++i) {
      var t = all[i];
      var tp = 0, fp = 0;
      var j;
      for (j = 0; j < pos.length; ++j) { if (pos[j] >= t) { ++tp; } }
      for (j = 0; j < neg.length; ++j) { if (neg[j] >= t) { ++fp; } }
      var acc = 0.5 * (tp / pos.length) + 0.5 * (1 - fp / neg.length);
      if (acc > bestAcc) { bestAcc = acc; bestT = t; bestDir = ">="; }
      tp = 0; fp = 0;
      for (j = 0; j < pos.length; ++j) { if (pos[j] <= t) { ++tp; } }
      for (j = 0; j < neg.length; ++j) { if (neg[j] <= t) { ++fp; } }
      acc = 0.5 * (tp / pos.length) + 0.5 * (1 - fp / neg.length);
      if (acc > bestAcc) { bestAcc = acc; bestT = t; bestDir = "<="; }
   }
   say("  best single threshold: " + bestDir + " " + bestT.toFixed(3)
       + "   balanced accuracy " + bestAcc.toFixed(3));
   say("");
}

say("for comparison, from 6.1.0: green fraction 0.801, length 0.586, elongation 0.540");
say("");
say("written to " + OUT);
