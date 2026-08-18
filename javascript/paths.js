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

// --- Exports ---------------------------------------------------------------

if (typeof module !== "undefined") {
   module.exports = {
      isRealXisf: isRealXisf,
      baseName: baseName,
      directoryOf: directoryOf,
      defaultOutputDir: defaultOutputDir
   };
}
