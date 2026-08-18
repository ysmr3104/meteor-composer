//============================================================================
// paths.js - File and directory names
//
// Pure JavaScript, no PJSR dependency. Lifted out of MeteorComposer.js so that
// the one piece of real reasoning here - where to write - can be tested.
//
// It earned that: the script used to write its detection results nowhere at all
// and its session file into the operator's directory of registered frames.
// Neither was visible anywhere in the UI, so neither could be noticed until
// somebody asked how the paths were decided.
//============================================================================

// External volumes formatted as exFAT carry macOS AppleDouble sidecars named
// "._<name>". They are not images and must be skipped.
function isRealXisf(name) {
   return name.length > 5
       && name.indexOf("._") !== 0
       && name.indexOf(".") !== 0
       && name.toLowerCase().lastIndexOf(".xisf") === name.length - 5;
}

// Trailing separators are stripped first: a directory chosen from the browser
// may or may not carry one, and "a/b/" would otherwise yield an empty name.
function baseName(path) {
   var trimmed = path.replace(/[\/\\]+$/, "");
   var cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
   return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

// The same stripping as baseName, and for the same reason. It was missing here,
// and a small test caught what that costs: GetDirectoryDialog may hand back
// ".../registered/group/", and without the strip the parent of that comes out as
// ".../registered/group" itself. defaultOutputDir then looks at the parent's
// name, does not find "registered", and settles on the frames directory - which
// is precisely the place it exists to avoid writing to.
function directoryOf(path) {
   var trimmed = path.replace(/[\/\\]+$/, "");
   var cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
   return cut > 0 ? trimmed.slice(0, cut) : "";
}

// Where to write, guessed from where the frames are.
//
// WBPP lays the frames out under <root>/registered/<group>, so the group's
// parent is `registered` and the root is one level above that. Writing into
// either the group or `registered` would put generated files among the
// calibrated frames, so the root is the answer when the layout is recognised.
//
// A guess, and a visible one: it lands in a field the operator can read and
// change, which is the difference between a wrong default and a wrong path
// nobody can see.
function defaultOutputDir(framesDir) {
   if (framesDir === null || framesDir.length === 0) {
      return "";
   }
   var parent = directoryOf(framesDir);
   if (parent.length === 0) {
      return framesDir;
   }
   if (baseName(parent).toLowerCase() === "registered") {
      var root = directoryOf(parent);
      if (root.length > 0) {
         return root;
      }
   }
   return parent;
}

// A short name for a frame, for a column that has to hold hundreds of rows.
//
// The frames are named things like
//
//   pct-2026-08-12_005413_ILCE-7M3_DSC04908_d_r.xisf
//
// which is 47 characters of which two matter. Put in a list column it either
// eats the width the other columns need or is cut off in the middle, and both
// happened. What an operator says out loud is "4908".
//
// The rule: the last run of at least three digits, with any letters
// immediately before it. That is the frame counter in every naming scheme met
// so far - the camera's DSC04908, a plain light_0042 - and the digits come last
// because what precedes them is the date, the time and the camera model, which
// are the same for every frame of a session.
//
// Falls back to the whole name when there is nothing that looks like a counter,
// which is better than returning something clever and wrong. The full name is
// never thrown away: it goes in the row's tooltip and above the preview.
function frameTag(fileName) {
   if (fileName === null || fileName === undefined) {
      return "";
   }
   var name = baseName(fileName).replace(/\.[^.]*$/, "");
   var matches = name.match(/[A-Za-z]*[0-9]{3,}/g);
   if (matches === null || matches.length === 0) {
      return name;
   }
   return matches[matches.length - 1];
}

// --- Exports ---------------------------------------------------------------

if (typeof module !== "undefined") {
   module.exports = {
      isRealXisf: isRealXisf,
      baseName: baseName,
      directoryOf: directoryOf,
      defaultOutputDir: defaultOutputDir,
      frameTag: frameTag
   };
}
