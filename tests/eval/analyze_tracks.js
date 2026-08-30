//============================================================================
// analyze_tracks.js - Measure how much cross-frame matching reduces the
//                     review burden
//
// Run: node tests/eval/analyze_tracks.js [results.json] [ground_truth.json]
//
// The screening pass alone leaves too many frames to review by hand. This
// script quantifies the effect of the strongest discriminator available
// (docs/requirements.md 6.1): satellites and aircraft persist across
// consecutive frames, meteors do not.
//
// It is analysis, not a test. It asserts nothing.
//============================================================================

var fs = require("fs");
var path = require("path");
var ops = require("../../javascript/candidate_ops.js");

var DEFAULT_RESULTS = "/Volumes/Extreme SSD/pi_works/meteor-composer-test/test-sky/detection_results.json";
var DEFAULT_GT = path.join(__dirname, "ground_truth.json");

function main() {
   // Flags must not be mistaken for positional paths.
   var positional = process.argv.slice(2).filter(function (a) { return a.indexOf("-") !== 0; });
   var results = JSON.parse(fs.readFileSync(positional[0] || DEFAULT_RESULTS, "utf8"));
   var gt = JSON.parse(fs.readFileSync(positional[1] || DEFAULT_GT, "utf8"));

   var labelled = {};
   gt.meteors.forEach(function (m) { labelled[m.file] = true; });

   // Frames are named with their capture timestamp, so filename order is
   // capture order.
   var frames = results.frames
      .filter(function (f) { return !f.error; })
      .map(function (f, i) {
         return { index: i, file: f.file, candidates: f.candidates || [] };
      });

   var tracks = ops.matchAcrossFrames(frames);

   var singletonTracks = tracks.filter(function (t) { return t.length === 1; });
   var persistentTracks = tracks.filter(function (t) { return t.length > 1; });

   var candidatesInPersistent = 0;
   persistentTracks.forEach(function (t) { candidatesInPersistent += t.length; });

   console.log("=========================================================");
   console.log(" Cross-frame track analysis");
   console.log("=========================================================");
   console.log("frames:                 " + frames.length);
   console.log("total candidates:       " + countCandidates(frames));
   console.log("");
   console.log("tracks:                 " + tracks.length);
   console.log("  singleton (1 frame):  " + singletonTracks.length);
   console.log("  persistent (>1):      " + persistentTracks.length
               + "  covering " + candidatesInPersistent + " candidates");

   // Tracks that pass through a frame labelled as containing a meteor.
   //
   // IMPORTANT: this does NOT mean the meteor itself is in the track. A
   // labelled frame can hold several candidates, only one of which is the
   // meteor; a satellite crossing the same frames forms its own track. The
   // ground truth currently has no coordinates (x0..y1 are null), so the
   // meteor candidate cannot be identified within a frame. Until coordinates
   // are added, this section is a pointer to frames worth inspecting, not
   // evidence that a meteor would be rejected.
   var meteorTracks = tracks.filter(function (t) {
      return t.members.some(function (m) { return labelled[m.file]; });
   });
   var persistentMeteorTracks = meteorTracks.filter(function (t) { return t.length > 1; });

   console.log("");
   console.log("--- Tracks passing through meteor-labelled frames ---");
   console.log("tracks touching a labelled frame:  " + meteorTracks.length);
   console.log("  of which persistent:             " + persistentMeteorTracks.length);
   console.log("");
   console.log("  NOTE: a labelled frame may hold several candidates. Without");
   console.log("        coordinates in the ground truth we cannot tell which one");
   console.log("        is the meteor, so a persistent track here does NOT prove");
   console.log("        the meteor would be rejected. Add coordinates to");
   console.log("        ground_truth.json to resolve this.");
   persistentMeteorTracks.forEach(function (t) {
      console.log("    track " + t.id + " length " + t.length);
      t.members.forEach(function (m) {
         console.log("      " + (labelled[m.file] ? "*" : " ") + " " + m.file
                     + "  len=" + fmt(m.candidate.length)
                     + " angle=" + fmt(m.candidate.angle)
                     + " c=(" + fmt(m.candidate.cx) + "," + fmt(m.candidate.cy) + ")");
      });
   });

   // The practical question: how many frames would a human still have to look
   // at if persistent tracks were filtered out?
   var reviewFramesBefore = {};
   var reviewFramesAfter = {};
   frames.forEach(function (f) {
      if (f.candidates.length > 0 && !labelled[f.file]) {
         reviewFramesBefore[f.file] = true;
      }
   });
   tracks.forEach(function (t) {
      if (t.length > 1) {
         return;
      }
      t.members.forEach(function (m) {
         if (!labelled[m.file]) {
            reviewFramesAfter[m.file] = true;
         }
      });
   });

   var before = Object.keys(reviewFramesBefore).length;
   var after = Object.keys(reviewFramesAfter).length;

   console.log("");
   console.log("--- Review burden -----------------------------------");
   console.log("frames to review, screening only:        " + before
               + "  (" + pct(before, frames.length) + " of all frames)");
   console.log("frames to review, singletons only:       " + after
               + "  (" + pct(after, frames.length) + " of all frames)");
   console.log("reduction:                               "
               + (before - after) + " frames, "
               + (before > 0 ? ((1 - after / before) * 100).toFixed(1) : "0") + "%");

   console.log("");
   console.log("--- Longest persistent tracks -----------------------");
   persistentTracks
      .slice()
      .sort(function (a, b) { return b.length - a.length; })
      .slice(0, 10)
      .forEach(function (t) {
         var first = t.members[0], last = t.members[t.members.length - 1];
         console.log("  track " + t.id + "  frames=" + t.length
                     + "  angle " + fmt(first.candidate.angle)
                     + " -> " + fmt(last.candidate.angle)
                     + "  " + shortName(first.file) + " .. " + shortName(last.file));
      });
}

function countCandidates(frames) {
   var n = 0;
   frames.forEach(function (f) { n += f.candidates.length; });
   return n;
}

function pct(a, b) {
   return b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "0%";
}

function shortName(f) {
   var m = f.match(/DSC(\d+)/);
   return m ? ("DSC" + m[1]) : f;
}

function fmt(v) {
   if (v === undefined || v === null || !isFinite(v)) {
      return "?";
   }
   return v.toFixed(1);
}

main();
