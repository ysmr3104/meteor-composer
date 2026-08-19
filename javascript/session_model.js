//============================================================================
// session_model.js - Screening session state for the Stage 2 UI
//
// Pure JavaScript, no PJSR dependency. The UI holds one Session; every
// operation the user performs is a call into this module, so the rules that
// matter for evaluation (what counts as reviewed, what goes into the ground
// truth, what the two modes are allowed to show) are testable under Node.js
// rather than buried in dialog callbacks.
//
// See docs/requirements.md 7.1 and docs/tests.md 5-2 / 5-4.
//============================================================================

// --- Verdicts ---------------------------------------------------------------

// Four states, not a checkbox. docs/tests.md 5-4 requires that frames the
// operator could not judge are separated and dropped from the denominator;
// a two-state checkbox cannot express "I looked and I do not know", and
// folding those into either bucket destabilises the baseline.
var VERDICT = {
   UNREVIEWED: "unreviewed",
   METEOR: "meteor",
   NOT_METEOR: "not-meteor",
   UNCERTAIN: "uncertain"
};

var VERDICT_ORDER = [
   VERDICT.UNREVIEWED, VERDICT.METEOR, VERDICT.NOT_METEOR, VERDICT.UNCERTAIN
];

function isValidVerdict(v) {
   for (var i = 0; i < VERDICT_ORDER.length; ++i) {
      if (VERDICT_ORDER[i] === v) {
         return true;
      }
   }
   return false;
}

// --- Modes ------------------------------------------------------------------

// Chosen when the dialog opens and fixed for its lifetime
// (docs/requirements.md 7.1). In GROUND_TRUTH mode the score and
// classification columns do not exist at all, rather than being hidden behind
// a toggle the operator could flip mid-session.
var MODE = {
   SCREENING: "screening",
   GROUND_TRUTH: "ground-truth"
};

function modeShowsScores(mode) {
   return mode === MODE.SCREENING;
}

// Whether the mode may narrow the list using the CLASSIFIER's output -
// scores, the persistent-track flag, anything the machine decided.
//
// This is not a blanket ban on filtering. docs/tests.md 5-2 objects to
// building the evaluation set out of whatever the operational settings
// surfaced, because then recall only measures what the detector already
// found. Filtering by the operator's OWN verdict does not do that: it hides
// nothing the operator has not already looked at, and it cannot steer them
// toward the classifier's opinion. Revisiting one's own calls is
// specifically useful, so that stays available in both modes.
function modeAllowsClassifierFiltering(mode) {
   return mode === MODE.SCREENING;
}

function defaultSortKey(mode) {
   // Sorting by score in ground-truth mode would make the presentation order
   // itself a nudge (docs/tests.md 5-2), so that mode goes in capture order.
   return mode === MODE.SCREENING ? "score" : "frameIndex";
}

// --- Building the list ------------------------------------------------------

// Flatten the detection results into one row per candidate.
//
// One row per candidate rather than per frame: several candidates in a frame
// is normal (up to 5 were measured in the real session) and the judgement is
// made per candidate. A frame -> candidate tree would confine sorting to
// within a frame, which defeats "work through the longest ones first".
//
// `results` is the detection_results.json payload: { frames: [...] }.
function buildRows(results) {
   var rows = [];
   var frames = results.frames || [];
   for (var i = 0; i < frames.length; ++i) {
      var frame = frames[i];
      var candidates = frame.candidates || [];
      for (var j = 0; j < candidates.length; ++j) {
         rows.push({
            id: rows.length,
            file: frame.file,
            frameIndex: i,
            indexInFrame: j,
            candidate: candidates[j],
            // Lifted out of the candidate because the classifier reads
            // row.colour. Left undefined when the frame carried no measurement
            // - an older results file, or a trail the walk could not find -
            // and scoreCandidate then simply omits the term.
            colour: candidates[j].colour,
            verdict: VERDICT.UNREVIEWED,
            trackId: null,
            trackLength: 1,
            persistent: false
         });
      }
   }
   return rows;
}

// Attach cross-frame track information from candidate_ops.matchAcrossFrames.
//
// Members are matched by candidate object identity, not by frame index.
// matchAcrossFrames numbers frames by their position in the array it was
// given, which only agrees with the position in results.frames if the caller
// passed every frame including the ones with no candidates. Keying on
// identity removes that trap: both sides hold the same candidate objects.
function applyTracks(rows, tracks) {
   var i, j;
   for (i = 0; i < tracks.length; ++i) {
      var track = tracks[i];
      for (j = 0; j < track.members.length; ++j) {
         var member = track.members[j];
         var row = findRowForCandidate(rows, member);
         if (row !== null) {
            row.trackId = track.id;
            row.trackLength = track.length;
            row.persistent = track.persistent;
         }
      }
   }
   return rows;
}

function findRowForCandidate(rows, member) {
   for (var i = 0; i < rows.length; ++i) {
      if (rows[i].candidate === member.candidate) {
         return rows[i];
      }
   }
   return null;
}

// --- Session ----------------------------------------------------------------

function createSession(results, mode, meta) {
   return {
      mode: mode || MODE.SCREENING,
      group: results.group || null,
      screenFactor: results.screenFactor || 1,
      options: results.options || null,
      meta: meta || {},
      rows: buildRows(results)
   };
}

function rowById(session, id) {
   for (var i = 0; i < session.rows.length; ++i) {
      if (session.rows[i].id === id) {
         return session.rows[i];
      }
   }
   return null;
}

function setVerdict(session, id, verdict) {
   if (!isValidVerdict(verdict)) {
      throw new Error("unknown verdict: " + verdict);
   }
   var row = rowById(session, id);
   if (row === null) {
      return false;
   }
   row.verdict = verdict;
   return true;
}

// Summary for the progress display. `reviewed` deliberately counts uncertain:
// the operator has looked at it and moved on, so it is done as far as the
// work queue is concerned, even though evaluation drops it later.
function summarize(session) {
   var counts = {};
   for (var i = 0; i < VERDICT_ORDER.length; ++i) {
      counts[VERDICT_ORDER[i]] = 0;
   }
   for (var j = 0; j < session.rows.length; ++j) {
      counts[session.rows[j].verdict] += 1;
   }
   return {
      total: session.rows.length,
      counts: counts,
      reviewed: session.rows.length - counts[VERDICT.UNREVIEWED]
   };
}

// Where a row went after the list was rebuilt.
//
// The displayed list is filtered and sorted, so a position in it means nothing
// once the filter changes: row 40 of 411 is a different candidate from row 40
// of 92, and may not exist at all. Rows carry an id, which does survive, so the
// selection follows the candidate rather than the position.
//
// Returns -1 when the row is no longer displayed - it was filtered out, and
// there is nothing to follow.
function indexOfRowId(displayed, id) {
   if (id === undefined || id === null) {
      return -1;
   }
   for (var i = 0; i < displayed.length; ++i) {
      if (displayed[i].id === id) {
         return i;
      }
   }
   return -1;
}

// --- Navigation -------------------------------------------------------------

// The next row still to be judged, at or after `fromIndex`. Returns an index
// into `rows`, or -1. `rows` is the displayed (filtered and sorted) list, so
// navigation follows what the operator sees.
function nextUnreviewed(rows, fromIndex) {
   for (var i = Math.max(0, fromIndex); i < rows.length; ++i) {
      if (rows[i].verdict === VERDICT.UNREVIEWED) {
         return i;
      }
   }
   return -1;
}

// Step to the next row, stopping at the end rather than wrapping. Wrapping
// would silently send the operator back to the top mid-pass.
function step(rows, fromIndex, delta) {
   var next = fromIndex + delta;
   if (next < 0) {
      return 0;
   }
   if (next >= rows.length) {
      return rows.length === 0 ? -1 : rows.length - 1;
   }
   return next;
}

// --- Filtering and sorting --------------------------------------------------

// `filter` is { hidePersistent, verdicts }.
//
// In ground-truth mode no filtering is applied at all, whatever is asked for:
// docs/tests.md 5-2 requires every candidate to be shown, because building
// the ground truth from what the operational settings happened to surface
// makes recall a tautology.
function filterRows(session, filter) {
   var rows = session.rows;
   if (!filter) {
      return rows.slice();
   }
   var classifierAllowed = modeAllowsClassifierFiltering(session.mode);
   var out = [];
   for (var i = 0; i < rows.length; ++i) {
      var row = rows[i];
      // Classifier-derived, so ground-truth mode ignores it even if asked.
      if (classifierAllowed && filter.hidePersistent && row.persistent) {
         continue;
      }
      // The operator's own verdict, so honoured in every mode.
      if (filter.verdicts && !contains(filter.verdicts, row.verdict)) {
         continue;
      }
      out.push(row);
   }
   return out;
}

function contains(list, value) {
   for (var i = 0; i < list.length; ++i) {
      if (list[i] === value) {
         return true;
      }
   }
   return false;
}

// Sort keys map to what the TreeBox columns show. `score` is only meaningful
// in screening mode; asking for it in ground-truth mode falls back to capture
// order rather than throwing, so the caller cannot accidentally reintroduce
// score ordering there.
function sortKeyValue(row, key) {
   switch (key) {
      case "frameIndex": return row.frameIndex * 1000 + row.indexInFrame;
      case "file":       return row.file;
      case "length":     return row.candidate.length;
      case "angle":      return row.candidate.angle;
      case "elongation": return row.candidate.elongation;
      case "pixelCount": return row.candidate.pixelCount;
      case "trackLength": return row.trackLength;
      case "verdict":    return row.verdict;
      case "score":      return row.score === undefined ? 0 : row.score;
      default:           return row.id;
   }
}

function sortRows(session, rows, key, ascending) {
   var effectiveKey = key;
   if (key === "score" && !modeShowsScores(session.mode)) {
      effectiveKey = "frameIndex";
   }
   var dir = (ascending === false) ? -1 : 1;
   var sorted = rows.slice();
   sorted.sort(function (a, b) {
      var va = sortKeyValue(a, effectiveKey);
      var vb = sortKeyValue(b, effectiveKey);
      if (va < vb) {
         return -dir;
      }
      if (va > vb) {
         return dir;
      }
      // Stable tiebreak on id so repeated sorts do not reshuffle rows.
      return a.id - b.id;
   });
   return sorted;
}

// --- Persistence ------------------------------------------------------------

// Only the verdicts are stored, keyed by frame and position within the frame.
// Storing them by row id would break as soon as the detection is rerun with
// different parameters and the ids shift.
function toSessionJSON(session) {
   var verdicts = [];
   for (var i = 0; i < session.rows.length; ++i) {
      var row = session.rows[i];
      if (row.verdict === VERDICT.UNREVIEWED) {
         continue;
      }
      verdicts.push({
         file: row.file,
         indexInFrame: row.indexInFrame,
         verdict: row.verdict
      });
   }
   return {
      version: 1,
      mode: session.mode,
      group: session.group,
      screenFactor: session.screenFactor,
      options: session.options,
      meta: session.meta,
      verdicts: verdicts
   };
}

// Restore verdicts onto an existing session. Entries that no longer match a
// candidate are returned as `orphans` rather than dropped silently: after a
// rerun with different parameters that count is how the operator learns how
// much of their work no longer applies.
function applySessionJSON(session, saved) {
   var index = {};
   var i;
   for (i = 0; i < session.rows.length; ++i) {
      var row = session.rows[i];
      index[row.file + ":" + row.indexInFrame] = row;
   }
   var restored = 0;
   var orphans = [];
   var entries = (saved && saved.verdicts) || [];
   for (i = 0; i < entries.length; ++i) {
      var entry = entries[i];
      var target = index[entry.file + ":" + entry.indexInFrame];
      if (target === undefined || !isValidVerdict(entry.verdict)) {
         orphans.push(entry);
         continue;
      }
      target.verdict = entry.verdict;
      ++restored;
   }
   return { restored: restored, orphans: orphans };
}

// --- Ground truth export ----------------------------------------------------

// Produce the tests/eval/ground_truth.json shape.
//
// Unlike the hand-made 2026-08-12 file, coordinates can be filled in here:
// the operator supplies only "which of these is a meteor", and the candidate
// already carries where it is (docs/requirements.md 7.1). `scaleX`/`scaleY`
// convert detection samples to full-resolution pixels; pass 1 to keep
// detection coordinates.
//
// A row is emitted per candidate, so a frame with two judged candidates
// appears twice. evaluate.js keys on `file`, which tolerates that.
function toGroundTruth(session, meta, scaleX, scaleY) {
   var sx = scaleX === undefined ? 1 : scaleX;
   var sy = scaleY === undefined ? 1 : scaleY;

   var meteors = [];
   var falsePositives = [];
   var uncertain = [];

   for (var i = 0; i < session.rows.length; ++i) {
      var row = session.rows[i];
      var entry = groundTruthEntry(row, sx, sy);
      if (row.verdict === VERDICT.METEOR) {
         meteors.push(entry);
      } else if (row.verdict === VERDICT.NOT_METEOR) {
         falsePositives.push(entry);
      } else if (row.verdict === VERDICT.UNCERTAIN) {
         uncertain.push(entry);
      }
   }

   var out = {
      session: (meta && meta.session) || null,
      registered_group: session.group,
      frame_count: (meta && meta.frameCount) || null,
      note: (meta && meta.note)
         || "Produced by MeteorComposer's ground-truth mode. Coordinates are"
          + " full-resolution pixels taken from the detected candidate;"
          + " the operator judged only which candidates are meteors.",
      meteors: meteors,
      known_false_positives: falsePositives,
      uncertain: uncertain
   };
   return out;
}

function groundTruthEntry(row, sx, sy) {
   var c = row.candidate;
   return {
      file: row.file,
      indexInFrame: row.indexInFrame,
      x0: centre(c.x0, sx),
      y0: centre(c.y0, sy),
      x1: centre(c.x1, sx),
      y1: centre(c.y1, sy)
   };
}

// Same centre mapping as preview_geometry.sampleCentreToImage. Duplicated
// rather than imported so this module stays free of dependencies; the two are
// pinned together by tests.
function centre(n, scale) {
   return (n + 0.5) * scale - 0.5;
}

// --- Exports ---------------------------------------------------------------

if (typeof module !== "undefined") {
   module.exports = {
      VERDICT: VERDICT,
      VERDICT_ORDER: VERDICT_ORDER,
      MODE: MODE,
      isValidVerdict: isValidVerdict,
      modeShowsScores: modeShowsScores,
      modeAllowsClassifierFiltering: modeAllowsClassifierFiltering,
      defaultSortKey: defaultSortKey,
      buildRows: buildRows,
      applyTracks: applyTracks,
      createSession: createSession,
      rowById: rowById,
      setVerdict: setVerdict,
      summarize: summarize,
      indexOfRowId: indexOfRowId,
      nextUnreviewed: nextUnreviewed,
      step: step,
      filterRows: filterRows,
      sortRows: sortRows,
      toSessionJSON: toSessionJSON,
      applySessionJSON: applySessionJSON,
      toGroundTruth: toGroundTruth
   };
}
