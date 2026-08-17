//============================================================================
// evaluate_classifier.js - How well does the score order the real session?
//
// Run: node tests/eval/evaluate_classifier.js
//
// This is an evaluation, not a test (docs/tests.md 5-1). Thresholds cannot be
// settled by assertion; they are chosen by looking at what they cost.
//
// The question the numbers have to answer is not "how accurate is it" but
// "how much of the list can be put aside before a meteor is lost". Because a
// human screens everything afterwards, the only expensive mistake is losing a
// meteor (docs/requirements.md 6.2), so the useful figure is: at the cutoff
// where all 31 labelled meteors still survive, how many of the 380
// not-a-meteor candidates fall below it?
//
// Inputs, all produced earlier:
//   detection_results.json  the candidates
//   meteor_session.json     the verdicts for all 411
//   colour_samples.json     the colour measurement (optional)
//============================================================================

var fs = require("fs");

var DATA_ROOT = "/Volumes/Extreme SSD/pi_works/meteor-composer-test";
var RESULTS = DATA_ROOT + "/detection_results.json";
var SESSION = DATA_ROOT + "/meteor_session.json";
var COLOUR = DATA_ROOT + "/colour_samples.json";

var ops = require("../../javascript/candidate_ops.js");
var clf = require("../../javascript/classifier.js");

function pad(s, n) {
   s = "" + s;
   while (s.length < n) {
      s += " ";
   }
   return s;
}

function fmt(v, d) {
   return v.toFixed(d === undefined ? 3 : d);
}

function build() {
   var results = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
   var session = JSON.parse(fs.readFileSync(SESSION, "utf8"));

   var verdicts = {};
   session.verdicts.forEach(function (v) {
      verdicts[v.file + ":" + v.indexInFrame] = v.verdict;
   });

   var colour = {};
   var haveColour = false;
   if (fs.existsSync(COLOUR)) {
      var c = JSON.parse(fs.readFileSync(COLOUR, "utf8"));
      c.rows.forEach(function (r) {
         colour[r.file + ":" + r.indexInFrame] = { r: r.r, g: r.g, b: r.b };
      });
      haveColour = true;
   }

   // Every frame in capture order, including the empty ones, so the track
   // numbering lines up with the run.
   var forMatching = results.frames.map(function (f) {
      return { file: f.file, candidates: f.candidates || [] };
   });
   var tracks = ops.matchAcrossFrames(forMatching, null);
   var analyzed = clf.analyzeTracks(tracks, null);

   // Which track each candidate belongs to, by object identity.
   var trackOf = {};
   tracks.forEach(function (t, ti) {
      t.members.forEach(function (m) {
         trackOf[m.file + ":" + m.candidate.cx + ":" + m.candidate.cy] = analyzed[ti];
      });
   });

   var rows = [];
   results.frames.forEach(function (f) {
      (f.candidates || []).forEach(function (cand, i) {
         var key = f.file + ":" + i;
         var t = trackOf[f.file + ":" + cand.cx + ":" + cand.cy];
         rows.push({
            file: f.file,
            indexInFrame: i,
            candidate: cand,
            verdict: verdicts[key] || "unreviewed",
            trackLength: t ? t.length : 1,
            // stationary is filled in below by markFixedStructures, which
            // works over the whole session rather than through the linker.
            stationary: false,
            persistent: t ? t.persistent : false,
            colour: colour[key] || null
         });
      });
   });

   // A fixed structure does not respect the linker's frame-gap limit, so it
   // is found across the whole session independently.
   var fixed = clf.markFixedStructures(rows, null);

   // A candidate cannot be both. Reporting a fixed structure as persistent
   // would tell the operator it is a satellite, which is not what it is.
   for (var i = 0; i < rows.length; ++i) {
      if (rows[i].stationary) {
         rows[i].persistent = false;
      }
   }

   return { rows: rows, haveColour: haveColour, analyzed: analyzed, fixed: fixed };
}

function report(rows, label) {
   clf.scoreAll(rows, null);

   var meteors = rows.filter(function (r) { return r.verdict === "meteor"; });
   var others = rows.filter(function (r) { return r.verdict === "not-meteor"; });

   console.log("");
   console.log("--- " + label + " " + new Array(Math.max(2, 54 - label.length)).join("-"));
   console.log("  meteors " + meteors.length + "   not-meteor " + others.length);

   // The cutoff that still keeps every meteor. Anything at or below this is
   // free suppression: nothing labelled a meteor is lost.
   var lowestMeteor = Math.min.apply(null, meteors.map(function (r) { return r.score; }));
   var suppressed = others.filter(function (r) { return r.score < lowestMeteor; }).length;

   console.log("");
   console.log("  Lowest-scoring meteor: " + fmt(lowestMeteor, 4));
   console.log("  Cutting below that removes " + suppressed + " of " + others.length
               + " non-meteors (" + fmt(100 * suppressed / others.length, 1) + "%)"
               + " and loses none of the " + meteors.length + " meteors.");

   console.log("");
   console.log("  " + pad("cutoff", 10) + pad("meteors kept", 16)
               + pad("non-meteors kept", 20) + "list shrinks to");
   [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5].forEach(function (cut) {
      var mk = meteors.filter(function (r) { return r.score >= cut; }).length;
      var ok2 = others.filter(function (r) { return r.score >= cut; }).length;
      var flag = mk < meteors.length ? "   <- loses meteors" : "";
      console.log("  " + pad(fmt(cut, 2), 10)
                  + pad(mk + " / " + meteors.length, 16)
                  + pad(ok2 + " / " + others.length, 20)
                  + (mk + ok2) + " / " + rows.length + flag);
   });

   // Where the labelled meteors sit once the list is sorted by score. If the
   // ordering is worth anything, they cluster near the top.
   var sorted = rows.slice().sort(function (a, b) { return b.score - a.score; });
   var positions = [];
   sorted.forEach(function (r, i) {
      if (r.verdict === "meteor") {
         positions.push(i + 1);
      }
   });
   positions.sort(function (a, b) { return a - b; });
   var median = positions[Math.floor(positions.length / 2)];
   console.log("");
   console.log("  Sorted by score, the meteors sit at positions "
               + positions[0] + " to " + positions[positions.length - 1]
               + " of " + rows.length + " (median " + median + ").");
   var top50 = positions.filter(function (p) { return p <= 50; }).length;
   console.log("  " + top50 + " of " + meteors.length
               + " meteors are in the top 50 rows.");

   return { lowestMeteor: lowestMeteor, suppressed: suppressed,
            total: others.length, positions: positions };
}

function main() {
   if (!fs.existsSync(RESULTS) || !fs.existsSync(SESSION)) {
      console.error("inputs not found under " + DATA_ROOT);
      process.exit(2);
   }
   var built = build();

   console.log("=========================================================");
   console.log(" Classifier evaluation");
   console.log("=========================================================");
   console.log("candidates:  " + built.rows.length);
   var stationaryRows = built.rows.filter(function (r) { return r.stationary; });
   var persistentRows = built.rows.filter(function (r) { return r.persistent; });
   console.log("stationary:  " + stationaryRows.length
               + "   persistent: " + persistentRows.length);
   console.log("fixed structures found: " + built.fixed.length);
   built.fixed.forEach(function (f) {
      console.log("    (" + f.cx.toFixed(1) + ", " + f.cy.toFixed(1) + ")"
                  + "  x" + f.count
                  + "  spread " + f.positionSpread.toFixed(2)
                  + "  length spread " + (f.lengthSpread * 100).toFixed(1) + "%");
   });

   // Whether the stationary rule is safe matters more than whether it is
   // effective: a rule that suppresses a meteor is unusable no matter how
   // much else it removes.
   var stationaryMeteors = stationaryRows.filter(function (r) {
      return r.verdict === "meteor";
   });
   console.log("stationary candidates that are labelled meteors: "
               + stationaryMeteors.length
               + (stationaryMeteors.length === 0
                  ? "   (the rule costs nothing here)"
                  : "   <- THE RULE WOULD LOSE THESE"));
   stationaryMeteors.forEach(function (r) {
      console.log("    - " + r.file + " #" + r.indexInFrame);
   });
   var persistentMeteors = persistentRows.filter(function (r) {
      return r.verdict === "meteor";
   });
   console.log("persistent candidates that are labelled meteors: "
               + persistentMeteors.length);
   persistentMeteors.forEach(function (r) {
      console.log("    - " + r.file + " #" + r.indexInFrame
                  + "  track=" + r.trackLength);
   });

   // Without colour first, so the contribution of the colour pass is visible
   // rather than assumed.
   var withoutColour = built.rows.map(function (r) {
      var copy = {};
      for (var k in r) {
         copy[k] = r[k];
      }
      copy.colour = null;
      return copy;
   });
   report(withoutColour, "Geometry only (no colour pass)");

   if (built.haveColour) {
      report(built.rows, "Geometry + colour");
   } else {
      console.log("");
      console.log("colour_samples.json not found - run probe_colour.js to");
      console.log("measure the colour contribution.");
   }
}

main();
