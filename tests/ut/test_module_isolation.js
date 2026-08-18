//============================================================================
// test_module_isolation.js - Guard against name collisions between modules
//
// Run: node tests/ut/test_module_isolation.js
//
// Under Node.js every module has its own scope, so two modules can both
// declare `function mergeOptions` and nothing goes wrong. PJSR has no module
// system: `#include` is textual, every file is concatenated into one global
// scope, and the last declaration of a name silently wins.
//
// MeteorComposer.js includes all of these files together, so a collision
// there is a real defect that no other test can see. This one is a static
// check over the sources rather than a test of behaviour.
//
// It caught a live example: detection_core.js declared
//   function mergeOptions(options)
// and candidate_ops.js declared
//   function mergeOptions(defaults, options)
// Including both left the two-argument version in place. detectCandidates
// calls it with one argument, so `defaults` received the caller's options and
// `options` was undefined - the returned object carried only the keys the
// caller passed and none of the defaults. Every threshold then compared
// against undefined, and `x < undefined` is false, so minPixels, minLength
// and minElongation were all silently disabled and every connected component
// became a candidate.
//============================================================================

var fs = require("fs");
var path = require("path");

var passed = 0;
var failed = 0;
var failures = [];

function ok(condition, message) {
   if (condition) {
      ++passed;
   } else {
      ++failed;
      failures.push(message);
      console.log("  FAIL: " + message);
   }
}

function suite(name, fn) {
   console.log("\n=== " + name + " ===");
   fn();
}

var JS_DIR = path.join(__dirname, "..", "..", "javascript");

// The pure modules that MeteorComposer.js pulls in with #include.
var MODULES = [
   "paths.js",
   "detection_core.js",
   "candidate_ops.js",
   "mask_geometry.js",
   "preview_geometry.js",
   "session_model.js",
   "classifier.js",
   "trail_mask.js",
   "composition.js"
];

// Top-level declarations only. Nested functions live inside a function scope
// even after concatenation, so they cannot collide.
function topLevelNames(source) {
   var names = [];
   var lines = source.split("\n");
   for (var i = 0; i < lines.length; ++i) {
      var line = lines[i];
      var fn = /^function\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line);
      if (fn !== null) {
         names.push({ name: fn[1], kind: "function", line: i + 1 });
         continue;
      }
      var v = /^var\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line);
      if (v !== null) {
         names.push({ name: v[1], kind: "var", line: i + 1 });
      }
   }
   return names;
}

//----------------------------------------------------------------------------

suite("every module is readable and declares something", function () {
   for (var i = 0; i < MODULES.length; ++i) {
      var p = path.join(JS_DIR, MODULES[i]);
      ok(fs.existsSync(p), MODULES[i] + " exists");
      var names = topLevelNames(fs.readFileSync(p, "utf8"));
      ok(names.length > 0, MODULES[i] + " declares at least one top-level name");
   }
});

suite("no top-level name is declared by two modules", function () {
   var owners = {};
   var i, j;

   for (i = 0; i < MODULES.length; ++i) {
      var source = fs.readFileSync(path.join(JS_DIR, MODULES[i]), "utf8");
      var names = topLevelNames(source);
      for (j = 0; j < names.length; ++j) {
         var entry = names[j];
         if (owners[entry.name] === undefined) {
            owners[entry.name] = [];
         }
         owners[entry.name].push(MODULES[i] + ":" + entry.line);
      }
   }

   var clashes = [];
   for (var name in owners) {
      // A name declared twice inside one file is that file's own business
      // (and would be a syntax concern, not a collision), so only count a
      // name owned by more than one distinct module.
      var files = {};
      for (i = 0; i < owners[name].length; ++i) {
         files[owners[name][i].split(":")[0]] = true;
      }
      if (Object.keys(files).length > 1) {
         clashes.push(name + " declared in " + owners[name].join(", "));
      }
   }

   ok(clashes.length === 0,
      "no name is declared by two modules"
      + (clashes.length > 0 ? "\n        " + clashes.join("\n        ") : ""));

   // The specific pair that bit, kept as a named assertion so a future
   // reintroduction reads clearly in the output.
   ok(owners["mergeOptions"] === undefined,
      "the ambiguous name `mergeOptions` is gone from every module");
});

suite("the modules still work after the rename", function () {
   var core = require("../../javascript/detection_core.js");
   var ops = require("../../javascript/candidate_ops.js");

   // detectCandidates must still fill in its defaults. The collision turned
   // this into a silent no-op, so assert the defaults actually apply: a
   // 2-pixel blob is below minPixels (12) and must be rejected.
   var field = core.makeField(20, 20);
   field.data[5 * 20 + 5] = 1.0;
   field.data[5 * 20 + 6] = 1.0;
   var r = core.detectCandidates(field, { k: 5.0 }, null);
   ok(r.candidates.length === 0,
      "a 2-pixel blob is rejected, so minPixels default is in force");

   ok(core.DEFAULT_OPTIONS.minPixels === 12, "detection defaults are intact");

   // candidate_ops' own defaults must still apply too.
   var tracks = ops.matchAcrossFrames([{ file: "a", candidates: [] }], null);
   ok(Array.isArray(tracks), "matchAcrossFrames still returns a list");
});

//----------------------------------------------------------------------------
// MeteorComposer.js cannot be loaded here: it is full of PJSR objects and
// preprocessor directives. But the calls it makes into the pure modules can
// still be checked statically, and they need to be. A misspelled call is a
// runtime error in PJSR, and PJSR reports those only in the Process Console -
// from the outside the script just does nothing.
//----------------------------------------------------------------------------

//----------------------------------------------------------------------------
// PixInsight preprocesses these files before V8 ever sees them, and its
// preprocessor does not read JavaScript. What it accepts is a narrower
// language, and the difference is invisible to `node --check`.
//----------------------------------------------------------------------------

suite("the PixInsight preprocessor can read every file", function () {
   // A "/*" inside a // comment. The preprocessor takes it for the start of a
   // block comment, never finds the close, and refuses the file:
   //
   //   *** Error: .../paths.js, line 44: Unterminated block comment.
   //
   // The script then does not start at all. It cost a session: the comment in
   // question described a directory layout and wrote a glob, "<group>" followed
   // by a slash and a star, which is the most natural way to write one.
   //
   // The same characters inside a string literal are fine - FileFind is given
   // exactly that pattern all over this codebase - so strings are removed
   // before looking.
   var files = MODULES.concat(["MeteorComposer.js"]);
   var offenders = [];
   for (var i = 0; i < files.length; ++i) {
      var full = path.join(JS_DIR, files[i]);
      if (!fs.existsSync(full)) {
         continue;
      }
      var lines = fs.readFileSync(full, "utf8").split("\n");
      for (var j = 0; j < lines.length; ++j) {
         var line = lines[j]
            .replace(/"(?:[^"\\]|\\.)*"/g, '""')
            .replace(/'(?:[^'\\]|\\.)*'/g, "''");
         var comment = line.indexOf("//");
         if (comment >= 0 && line.indexOf("/*", comment) >= 0) {
            offenders.push(files[i] + ":" + (j + 1));
         }
      }
   }
   ok(offenders.length === 0,
      "no line comment contains the start of a block comment"
      + (offenders.length > 0 ? ": " + offenders.join(", ") : ""));
});

//----------------------------------------------------------------------------

var MAIN = path.join(JS_DIR, "MeteorComposer.js");

// Globals supplied by the JavaScript language or by PixInsight itself. A bare
// call to any of these is not our concern.
var AMBIENT = [
   "parseInt", "parseFloat", "isNaN", "isFinite", "String", "Number", "Boolean",
   "Array", "Object", "Math", "JSON", "Date", "RegExp", "Error", "encodeURI",
   "decodeURI", "encodeURIComponent", "decodeURIComponent", "require",
   "format", "print"
];

function bareCalls(source) {
   var stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");

   var names = {};
   // An identifier followed by "(" that is not preceded by "." (a method) or
   // by "new " (a constructor) or by "function " (a declaration).
   var re = /(^|[^\w$.])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
   var m;
   while ((m = re.exec(stripped)) !== null) {
      var before = stripped.slice(Math.max(0, m.index - 12), m.index + m[1].length);
      if (/\bnew\s+$/.test(before) || /\bfunction\s+$/.test(before)) {
         continue;
      }
      names[m[2]] = true;
   }
   return Object.keys(names);
}

// Reserved words and control-flow keywords also match "identifier(".
var KEYWORDS = ["if", "for", "while", "switch", "catch", "return", "typeof",
                "function", "class", "super", "this", "delete", "in", "of",
                "new", "do", "else", "throw", "case", "void", "instanceof"];

// Parameters are locally bound, so calling one is not a reference to a
// global. Collected coarsely from every parameter list in the file: this only
// ever suppresses reports, never adds them, and a parameter name colliding
// with a genuinely missing global is a narrow enough gap to accept in a
// heuristic guard. The alternative - an allowlist of known callback names -
// would have to grow with every new callback and would quietly stop checking.
function parameterNames(source) {
   var names = {};
   var re = /(?:function\s*[A-Za-z0-9_$]*|[A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*\{/g;
   var m;
   while ((m = re.exec(source)) !== null) {
      var parts = m[1].split(",");
      for (var i = 0; i < parts.length; ++i) {
         var p = parts[i].trim().replace(/=.*$/, "").trim();
         if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p)) {
            names[p] = true;
         }
      }
   }
   return names;
}

suite("MeteorComposer.js only calls things that exist", function () {
   ok(fs.existsSync(MAIN), "MeteorComposer.js exists");
   if (!fs.existsSync(MAIN)) {
      return;
   }
   var mainSource = fs.readFileSync(MAIN, "utf8");

   // Everything declared at the top level anywhere in the concatenation, plus
   // methods declared inside MeteorComposer.js's own classes.
   var declared = {};
   var i, j;
   for (i = 0; i < MODULES.length; ++i) {
      var names = topLevelNames(fs.readFileSync(path.join(JS_DIR, MODULES[i]), "utf8"));
      for (j = 0; j < names.length; ++j) {
         declared[names[j].name] = MODULES[i];
      }
   }
   var own = topLevelNames(mainSource);
   for (j = 0; j < own.length; ++j) {
      declared[own[j].name] = "MeteorComposer.js";
   }
   // Class methods are written as "name(args) {" at an indent.
   var methodRe = /^\s{3}([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{/gm;
   var mm;
   while ((mm = methodRe.exec(mainSource)) !== null) {
      declared[mm[1]] = "MeteorComposer.js (method)";
   }

   var params = parameterNames(mainSource);

   var unknown = [];
   var calls = bareCalls(mainSource);
   for (i = 0; i < calls.length; ++i) {
      var name = calls[i];
      if (KEYWORDS.indexOf(name) >= 0 || AMBIENT.indexOf(name) >= 0) {
         continue;
      }
      if (declared[name] !== undefined || params[name] === true) {
         continue;
      }
      unknown.push(name);
   }

   ok(unknown.length === 0,
      "every bare call resolves to a declaration"
      + (unknown.length > 0 ? "\n        unresolved: " + unknown.join(", ") : ""));

   // The calls that cross the module boundary are the ones worth naming: if a
   // pure module is refactored, these are what breaks.
   var crossings = ["detectCandidates", "matchAcrossFrames", "createSession",
                    "applyTracks", "summarize", "filterRows", "sortRows",
                    "setVerdict", "toSessionJSON", "applySessionJSON",
                    "toGroundTruth", "step", "defaultSortKey", "modeShowsScores",
                    "modeAllowsClassifierFiltering", "layoutOverlay", "hitTest",
                    "viewToImage", "candidateCentroid",
                    "markFixedStructures", "scoreAll", "presetNames"];
   for (i = 0; i < crossings.length; ++i) {
      ok(declared[crossings[i]] !== undefined,
         crossings[i] + " is declared by a pure module");
   }
});

suite("every #include resolves", function () {
   if (!fs.existsSync(MAIN)) {
      return;
   }
   var source = fs.readFileSync(MAIN, "utf8");
   var re = /^#include\s+"([^"]+)"/gm;
   var m;
   var included = [];
   while ((m = re.exec(source)) !== null) {
      included.push(m[1]);
      ok(fs.existsSync(path.join(JS_DIR, m[1])), "#include " + m[1] + " resolves");
   }
   ok(included.length > 0, "MeteorComposer.js includes at least one module");

   // Not every pure module has to be included yet - mask_geometry.js is only
   // needed once the Tier 1 exclusion UI is built, which is a later task
   // (docs/requirements.md 9). What matters is that anything included is a
   // module the collision check above covers, so a file cannot be pulled in
   // without its names being checked against the rest.
   for (var i = 0; i < included.length; ++i) {
      ok(MODULES.indexOf(included[i]) >= 0,
         included[i] + " is covered by the collision check");
   }
});

suite("V8 constant style", function () {
   if (!fs.existsSync(MAIN)) {
      return;
   }
   var source = fs.readFileSync(MAIN, "utf8");

   // The legacy SpiderMonkey globals do not exist under V8, and referencing
   // one throws at runtime - reported only in the Process Console
   // (../CLAUDE.md). Grep for the underscore form.
   var legacy = source.match(/\b(TextAlign|StdIcon|StdButton|StdCursor|FrameStyle|ColorSpace|DataType)_[A-Za-z]+/g);
   ok(legacy === null,
      "no legacy SpiderMonkey constants"
      + (legacy !== null ? ": " + legacy.join(", ") : ""));

   ok(/^#engine v8\s*$/m.test(source.split("\n")[0]),
      "#engine v8 is on line 1");

   // Renaming the underscore away is not enough: the class it belongs to has
   // to be the one that exists. `TextAlign_Right` became `TextAlign.Right`
   // here, and there is no TextAlign object in PJSR at all - the class is
   // TextAlignment, and the flag is VerticalCenter rather than VertCenter.
   // Both throw on construction, and PJSR reports that only in the Process
   // Console, so from the outside the dialog simply does not appear.
   //
   // Checked against the names PJSR actually declares:
   //   /Applications/PixInsight/doc/pjsr/objects/<Object>/<Object>.html
   // There is a directory for TextAlignment and none for TextAlign.
   var WRONG_CLASSES = {
      "TextAlign": "TextAlignment",
      "Align": "TextAlignment",
      "Icon": "StdIcon",
      "Button": "StdButton",
      "Cursor": "StdCursor"
   };
   var wrong = [];
   for (var name in WRONG_CLASSES) {
      // The name as a whole identifier followed by a dot, not as the tail of a
      // longer one: `TextAlignment.` must not match `TextAlign`.
      var re = new RegExp("(^|[^A-Za-z0-9_$.])" + name + "\\.[A-Z]", "g");
      var hit = source.match(re);
      if (hit !== null) {
         wrong.push(name + "." + " (" + hit.length + "x, meant "
                    + WRONG_CLASSES[name] + ")");
      }
   }
   ok(wrong.length === 0,
      "constants use classes that exist"
      + (wrong.length > 0 ? ": " + wrong.join(", ") : ""));

   var vertCenter = source.match(/\bVertCenter\b/g);
   ok(vertCenter === null,
      "the vertical-centre flag is VerticalCenter"
      + (vertCenter !== null ? " (" + vertCenter.length + " uses of VertCenter)" : ""));
});

//----------------------------------------------------------------------------

console.log("\n============================================");
console.log("passed: " + passed + "  failed: " + failed);
if (failed > 0) {
   console.log("\nFailures:");
   failures.forEach(function (f) {
      console.log("  - " + f);
   });
   process.exit(1);
}
console.log("OK");
