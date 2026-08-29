//============================================================================
// coordinate_system.js - Which coordinate system a session is closed in
//
// Pure JavaScript, no PJSR dependency.
//
// docs/requirements.md 3.4 settles the policy: a fixed-tripod session is not a
// tracked session with worse alignment, it is a session that has to choose a
// coordinate system and close every stage in it.
//
//   sky      detection reads `registered` frames, the composite's background
//            is the master light. The meteors land where they were against the
//            stars.
//   ground   detection reads `debayered` frames, the composite's background is
//            one of those frames. The meteors land where they were against the
//            landscape.
//
// The two never mix, so nothing here converts between them. That is the point
// of choosing: the detections and the background come out of the same files,
// so no transform is needed and none can be got wrong.
//
// Measured on a 4h13m fixed-tripod session (NIKON ZR, 24mm, 13s x 1045),
// provided by mave. Registration lost 327 of 1045 frames and left an average
// of 36.5% of each surviving frame with no data in it; the same frames read
// straight from `debayered` lost none and had no empty area at all. See
// requirements 3.4 for the paired table.
//============================================================================

var SKY_REFERENCED = "sky";
var GROUND_REFERENCED = "ground";

var COORDINATE_SYSTEMS = [SKY_REFERENCED, GROUND_REFERENCED];

// Anything unrecognised becomes sky-referenced, which is what every session
// before this existed was. A results file written by an older version has no
// coordinate system in it at all, and that is not an error.
function normaliseCoordinateSystem(name) {
   return name === GROUND_REFERENCED ? GROUND_REFERENCED : SKY_REFERENCED;
}

function isGroundReferenced(name) {
   return normaliseCoordinateSystem(name) === GROUND_REFERENCED;
}

// --- What the operator is shown ---------------------------------------------

function coordinateLabel(name) {
   return isGroundReferenced(name) ? "Ground-referenced" : "Sky-referenced";
}

// The caption of the directory browser. It names the directory WBPP writes,
// because that is what the operator is looking at in the file dialog.
function framesDialogCaption(name) {
   return isGroundReferenced(name)
      ? "Debayered frames directory"
      : "Registered frames directory";
}

// The label in front of the background field in the compose dialog. In a
// ground-referenced composite the background is not a master light and calling
// it one would be a lie: it is a single frame, or a stack of frames that were
// never aligned.
function backgroundLabel(name) {
   return isGroundReferenced(name) ? "Background:" : "Master light:";
}

// --- Which directory belongs to which system --------------------------------

// The directory name WBPP uses for this system's frames.
function expectedDirectoryName(name) {
   return isGroundReferenced(name) ? "debayered" : "registered";
}

// What the chosen directory says about itself, or null when it says nothing.
//
// WBPP lays frames out under <root>/<stage>/<group>, so the answer is in the
// directory's own name or its parent's. Deliberately narrow: only the two
// names WBPP actually writes are recognised. `calibrated` is not among them -
// for a one-shot-colour camera those frames are still a mosaic, and guessing
// that they are ground-referenced would be guessing about debayering as well.
function directorySuggests(dir) {
   if (typeof dir !== "string" || dir.length === 0) {
      return null;
   }
   var trimmed = dir.replace(/[\/\\]+$/, "");
   var parts = trimmed.split(/[\/\\]/);
   for (var i = parts.length - 1; i >= 0 && i >= parts.length - 2; --i) {
      var part = parts[i].toLowerCase();
      if (part === "registered") {
         return SKY_REFERENCED;
      }
      if (part === "debayered") {
         return GROUND_REFERENCED;
      }
   }
   return null;
}

// Returns a sentence when the directory disagrees with the chosen system, and
// null when it agrees or has nothing to say.
//
// A warning and not a veto. The directory name is a guess about the operator's
// layout, and being told "that is not what this directory is called" when it
// is in fact the right directory would be worse than useless. But the two ways
// of getting this wrong both produce a composite that looks finished and is
// wrong, so neither may pass in silence.
function coordinateMismatch(name, dir) {
   var suggested = directorySuggests(dir);
   if (suggested === null || suggested === normaliseCoordinateSystem(name)) {
      return null;
   }
   if (isGroundReferenced(name)) {
      return "This directory is named `registered`, so these frames have "
           + "already been aligned to the stars. A ground-referenced composite "
           + "built from them would put the meteors in the right place and "
           + "draw the landscape as an arc, because in these frames the "
           + "landscape is what moves.";
   }
   return "This directory is named `debayered`, so these frames have not been "
        + "aligned. A sky-referenced composite built from them would place "
        + "each meteor by the pixel it happened to land on rather than by "
        + "where it was among the stars.";
}

// --- The background a ground-referenced composite starts from ---------------

// Which frame to offer as the background, given the session's frames in the
// order they were shot.
//
// The middle one. Not the first: the operator is choosing a photograph, and
// the ends of a night are where the sky is brightest and where somebody is
// still walking around with a torch. The middle is only a starting point - it
// is offered in a field the operator can change, which is the difference
// between a default and a decision made for them.
function middleFrame(names) {
   if (!names || names.length === 0) {
      return null;
   }
   return names[Math.floor((names.length - 1) / 2)];
}

// --- Stacking the background ------------------------------------------------

// A median of a few frames, none of them aligned, is the other thing the
// background can be. The tripod did not move, so the landscape stays sharp; a
// median drops anything in fewer than half the frames, so the meteors and
// satellites go; and the noise falls. What it costs is the stars, which are
// the one thing in the picture that does move.
//
// Measured on mave's data (6064x4040 RGB, 13 s frames, probe_median_background):
//
//   frames   noise vs one frame   ideal (1.253/sqrt N)   sky turned   time
//        5               0.5863                 0.5604       0.23 deg    3 s
//       15               0.3673                 0.3235       0.82 deg   25 s
//       31               0.2712                 0.2250       1.75 deg   37 s
//
// 15 is where the two curves cross over: most of the noise that stacking can
// remove is gone, and the trail is still under a degree. It is a default, not
// a recommendation - how long a star trail should be is the whole question and
// it is not ours to answer.
var DEFAULT_STACK_FRAMES = 15;

// A median of two frames is their mean. Below three the word means nothing.
var MIN_STACK_FRAMES = 3;

// Which frames go into the stack: consecutive, centred on the chosen one.
//
// Consecutive, not spread across the night. Spreading would put the same
// number of frames over four hours and draw the stars as dashes across 63
// degrees; consecutive draws one short trail. The window is clamped to the
// ends of the night rather than shortened, so the count the operator asked for
// is the count they get.
function medianStackFrames(names, centreName, count) {
   if (!names || names.length === 0) {
      return [];
   }
   var n = Math.max(1, Math.floor(count));
   if (n >= names.length) {
      return names.slice(0);
   }
   var centre = names.indexOf(centreName);
   if (centre < 0) {
      centre = Math.floor((names.length - 1) / 2);
   }
   var half = Math.floor((n - 1) / 2);
   var from = Math.max(0, Math.min(centre - half, names.length - n));
   return names.slice(from, from + n);
}

// How long a star trail the stack will draw, in the operator's terms.
//
// Returns "" when the interval is not known, because a made-up number here
// would be worse than none: this is the figure the choice is made on.
function stackTrailEstimate(count, secondsPerFrame) {
   if (!(secondsPerFrame > 0) || !(count > 1)) {
      return "";
   }
   var span = (count - 1) * secondsPerFrame;
   var degrees = span * 15 / 3600;
   var minutes = span / 60;
   return (minutes < 1 ? span.toFixed(0) + " s" : minutes.toFixed(1) + " min")
        + " of sky rotation (" + degrees.toFixed(2) + " deg of trail)";
}

// The seconds between one frame and the next, from the first and last frames'
// DATE-OBS.
//
// A night crosses midnight - mave's ran from 23:25:20 to 03:38:04 - so the
// last stamp is routinely smaller than the first. Subtracting them without
// allowing for that gives a negative interval and, taken at face value, a
// star trail measured in negative degrees.
//
// Only the time of day is read. The date is there in the stamp, but a session
// spanning more than one night is not a thing this measures, and parsing dates
// properly is a larger promise than this needs to make.
function observationSeconds(stamp) {
   if (typeof stamp !== "string") {
      return null;
   }
   var m = /T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stamp);
   if (m === null) {
      return null;
   }
   return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// Returns 0 when it cannot be worked out, which stackTrailEstimate reads as
// "say nothing".
function frameIntervalSeconds(firstStamp, lastStamp, frameCount) {
   var t0 = observationSeconds(firstStamp);
   var t1 = observationSeconds(lastStamp);
   if (t0 === null || t1 === null || !(frameCount > 1)) {
      return 0;
   }
   var span = t1 - t0;
   if (span < 0) {
      span += 24 * 3600;
   }
   return span / (frameCount - 1);
}

// --- Exports ----------------------------------------------------------------

if (typeof module !== "undefined") {
   module.exports = {
      SKY_REFERENCED: SKY_REFERENCED,
      GROUND_REFERENCED: GROUND_REFERENCED,
      COORDINATE_SYSTEMS: COORDINATE_SYSTEMS,
      normaliseCoordinateSystem: normaliseCoordinateSystem,
      isGroundReferenced: isGroundReferenced,
      coordinateLabel: coordinateLabel,
      framesDialogCaption: framesDialogCaption,
      backgroundLabel: backgroundLabel,
      expectedDirectoryName: expectedDirectoryName,
      directorySuggests: directorySuggests,
      coordinateMismatch: coordinateMismatch,
      middleFrame: middleFrame,
      DEFAULT_STACK_FRAMES: DEFAULT_STACK_FRAMES,
      MIN_STACK_FRAMES: MIN_STACK_FRAMES,
      medianStackFrames: medianStackFrames,
      stackTrailEstimate: stackTrailEstimate,
      observationSeconds: observationSeconds,
      frameIntervalSeconds: frameIntervalSeconds
   };
}
