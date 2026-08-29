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
      middleFrame: middleFrame
   };
}
