#!/usr/bin/env node
/**
 * =============================================================================
 * BATCH RUNNER
 * =============================================================================
 *
 * Interactive batch runner for Adobe Illustrator and Photoshop scripts.
 * Runs a configured script against every slug folder under a root
 * directory, processing slugs sequentially (one at a time).
 *
 * Each script config specifies an "app" field ("illustrator" or
 * "photoshop") that selects which Adobe application to drive via
 * osascript. Defaults to "illustrator" for backwards compatibility.
 *
 * A "slug" is a folder name that identifies the project — an airport code
 * like "jfk", a city name like "chicago", etc.
 *
 * USAGE
 * ─────
 *   node run.js
 *
 *   The runner will prompt you for:
 *     1. Which script to run (from config.json)
 *     2. Script options (defined per-script in config.json)
 *     3. Root folder to scan
 *     4. Slug (or blank for all)
 *     5. Run scope: dry run / first only / entire list
 *     6. Confirmation before executing
 *
 * TEMPLATE HANDLING
 * ─────────────────
 *   Each script config points to a single template.ai file via templatePath.
 *   Before execution the runner copies it to batch-template.ai (same
 *   directory) and opens that copy in Illustrator for each slug. The copy
 *   is left open and unsaved after the run so you can inspect the result
 *   without risking the original template.
 *
 * HOW DIALOG BYPASS WORKS
 * ───────────────────────
 *   Before each run this script writes a small JSON file (batch-args.json)
 *   next to the configured Illustrator script. The JSON includes the slug
 *   name, slug folder path, and all option values. The Illustrator script
 *   checks for this file on startup; if found it reads the values and skips
 *   its interactive prompts. The file is deleted by the Illustrator script
 *   immediately after reading, so it never affects manual runs.
 *
 *   See README.md for how to add bypass support to an Illustrator script.
 *
 * ERROR HANDLING
 * ──────────────
 *   If the Illustrator script returns a string starting with "ERROR:" the
 *   batch runner treats that slug as failed and displays the message.
 *
 * REQUIREMENTS
 * ────────────
 *   - macOS (uses osascript to drive Adobe apps)
 *   - Node.js >= 14
 *   - The target Adobe application must be installed
 * =============================================================================
 */

"use strict";

var fs           = require("fs");
var path         = require("path");
var readline     = require("readline");
var childProcess = require("child_process");


// =============================================================================
// CONFIGURATION
//

var CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    die("config.json not found at: " + CONFIG_PATH);
  }
  var config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    die("Could not parse config.json: " + e.message);
  }
  if (!config.scripts || !Array.isArray(config.scripts) || config.scripts.length === 0) {
    die("config.json must contain a non-empty \"scripts\" array. See README.md.");
  }
  return config;
}


// =============================================================================
// APP CONFIGURATION
//
// Maps the "app" field in each script config to the application name and
// the JavaScript snippets needed to open files and run scripts.
//

var APP_CONFIG = {
  illustrator: {
    appName: "Adobe Illustrator",
    openArgs: function(filePath) {
      return [
        "app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;",
        "app.open(File(" + JSON.stringify(filePath) + "));",
        "app.userInteractionLevel = UserInteractionLevel.DISPLAYALERTS;"
      ].join(" ");
    },
    runArgs: function(scriptPath) {
      return "$.evalFile(" + JSON.stringify(scriptPath) + ")";
    }
  },
  photoshop: {
    appName: "Adobe Photoshop 2026",
    openArgs: function(filePath) {
      return [
        "app.displayDialogs = DialogModes.NO;",
        "app.open(File(" + JSON.stringify(filePath) + "));",
        "app.displayDialogs = DialogModes.ALL;"
      ].join(" ");
    },
    runArgs: function(scriptPath) {
      return "$.evalFile(" + JSON.stringify(scriptPath) + ")";
    }
  }
};


// =============================================================================
// INTERACTIVE PROMPTS
//

function createRL() {
  return readline.createInterface({
    input:  process.stdin,
    output: process.stdout
  });
}

function askQuestion(rl, prompt) {
  return new Promise(function(resolve) {
    rl.question(prompt, function(answer) {
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt the user to pick from a numbered list of choices.
 *
 * @param {object} rl
 * @param {string} label         Heading shown above the list.
 * @param {Array<{value,label}>} choices
 * @returns {Promise<{value,label}>}
 */
async function promptChoice(rl, label, choices) {
  console.log("\n" + label + ":");
  choices.forEach(function(c, i) {
    console.log("  [" + (i + 1) + "] " + c.label);
  });
  while (true) {
    var answer = await askQuestion(rl, "  Choice [1-" + choices.length + "]: ");
    var n = parseInt(answer, 10);
    if (!isNaN(n) && n >= 1 && n <= choices.length) {
      return choices[n - 1];
    }
    console.log("  Please enter a number between 1 and " + choices.length + ".");
  }
}

/**
 * Prompt the user to enter text, with an optional default.
 *
 * @param {object} rl
 * @param {string} label
 * @param {string} [defaultValue]
 * @returns {Promise<string>}
 */
async function promptText(rl, label, defaultValue) {
  var hint = defaultValue ? " [" + defaultValue + "]" : "";
  while (true) {
    var answer = await askQuestion(rl, "\n" + label + hint + ": ");
    if (answer === "" && defaultValue) { return defaultValue; }
    if (answer !== "") { return answer; }
    console.log("  Please enter a value.");
  }
}

/**
 * Prompt the user for Y/N confirmation.
 *
 * @param {object} rl
 * @param {string} label
 * @returns {Promise<bool>}
 */
async function promptYesNo(rl, label) {
  while (true) {
    var answer = await askQuestion(rl, label + " [y/N]: ");
    if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") { return true; }
    if (answer === "" || answer.toLowerCase() === "n" || answer.toLowerCase() === "no") { return false; }
    console.log("  Please enter y or n.");
  }
}


// =============================================================================
// SLUG DISCOVERY
//

/**
 * Determine the list of slug jobs to process.
 *
 * Priority:
 *   1. If userSlug is provided → just that one slug.
 *   2. Else if configSlugs is non-empty → use those slugs.
 *   3. Else → scan rootPath for all subdirectories.
 *
 * After building the list, excludedSlugs are removed.
 * Missing slug folders are created automatically.
 *
 * @param {string}   rootPath        Absolute path to the root folder.
 * @param {string[]} configSlugs     Include list from config (may be empty).
 * @param {string[]} excludedSlugs   Exclude list from config (may be empty).
 * @param {string}   userSlug        Slug entered at runtime (may be empty).
 * @returns {Array<{slug, folder}>}
 */
function discoverSlugs(rootPath, configSlugs, excludedSlugs, userSlug) {
  var slugs;

  if (userSlug) {
    slugs = [userSlug];
  } else if (configSlugs && configSlugs.length > 0) {
    slugs = configSlugs.slice();
  } else {
    // Scan root folder for all subdirectories
    var entries;
    try {
      entries = fs.readdirSync(rootPath, { withFileTypes: true });
    } catch (e) {
      die("Cannot read folder: " + rootPath + "\n" + e.message);
    }
    slugs = entries
      .filter(function(e) { return e.isDirectory(); })
      .map(function(e) { return e.name; });
  }

  // Filter excluded slugs
  if (excludedSlugs && excludedSlugs.length > 0) {
    var exc = excludedSlugs.map(function(s) { return s.toLowerCase(); });
    slugs = slugs.filter(function(s) {
      return exc.indexOf(s.toLowerCase()) === -1;
    });
  }

  // Build jobs, creating missing folders
  var jobs = [];
  slugs.forEach(function(slug) {
    var folder = path.join(rootPath, slug);
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
      console.log("  Created folder: " + folder);
    }
    jobs.push({ slug: slug, folder: folder });
  });

  return jobs;
}


// =============================================================================
// TEMPLATE HANDLING
//

/**
 * Copy template.ai to batch-template.ai in the same directory.
 * Returns the path to batch-template.ai.
 *
 * @param {string} templatePath  Absolute path to template.ai.
 * @returns {string}             Absolute path to batch-template.ai.
 */
function prepareTemplate(templatePath) {
  if (!fs.existsSync(templatePath)) {
    die("Template not found: " + templatePath + "\nCheck templatePath in config.json.");
  }
  var batchTemplatePath = path.join(path.dirname(templatePath), "batch-template.ai");
  fs.copyFileSync(templatePath, batchTemplatePath);
  return batchTemplatePath;
}


// =============================================================================
// APP INVOCATION
//

/**
 * Write batch-args.json next to the script so the script can read option
 * values without showing interactive prompts.
 *
 * @param {string} scriptPath    Absolute path to the .jsx script.
 * @param {string} slug          The current slug name.
 * @param {string} slugFolder    Absolute path to the slug folder.
 * @param {object} optionValues  Map of option keys to chosen values.
 * @returns {string}             Path to the written batch-args.json.
 */
function writeBatchArgs(scriptPath, slug, slugFolder, optionValues) {
  var args = {};
  args.slug       = slug;
  args.slugFolder = slugFolder;
  var keys = Object.keys(optionValues);
  for (var i = 0; i < keys.length; i++) {
    args[keys[i]] = optionValues[keys[i]];
  }
  var argsPath = path.join(path.dirname(scriptPath), "batch-args.json");
  fs.writeFileSync(argsPath, JSON.stringify(args, null, 2), "utf8");
  return argsPath;
}

/**
 * Remove batch-args.json if it still exists (safety cleanup in case the
 * script failed before consuming the file).
 *
 * @param {string} scriptPath
 */
function cleanupBatchArgs(scriptPath) {
  var argsPath = path.join(path.dirname(scriptPath), "batch-args.json");
  if (fs.existsSync(argsPath)) {
    try { fs.unlinkSync(argsPath); } catch (e) {}
  }
}

/**
 * Open a file in the target Adobe app via osascript.
 * Uses the app-specific dialog suppression code from APP_CONFIG.
 *
 * @param {object} appConfig  Entry from APP_CONFIG.
 * @param {string} filePath
 */
function openInApp(appConfig, filePath) {
  var jsCode = appConfig.openArgs(filePath);
  var script = 'tell application "' + appConfig.appName + '" to do javascript ' +
    JSON.stringify(jsCode);
  execOsascript(script);
}

/**
 * Run a script in the target Adobe app via osascript. Returns the script's
 * result string (the last expression evaluated). If the script returns a
 * string starting with "ERROR:" the caller should treat the run as failed.
 *
 * @param {object} appConfig   Entry from APP_CONFIG.
 * @param {string} scriptPath
 * @returns {string}
 */
function runScript(appConfig, scriptPath) {
  var jsCode = appConfig.runArgs(scriptPath);
  var script = 'tell application "' + appConfig.appName + '" to do javascript ' +
    JSON.stringify(jsCode);
  return execOsascript(script);
}

/**
 * Execute an AppleScript string via osascript. Returns stdout. Throws on
 * non-zero exit.
 *
 * @param {string} appleScript
 * @returns {string}
 */
function execOsascript(appleScript) {
  var buf = childProcess.execSync("osascript -e " + shellQuote(appleScript), {
    stdio: ["ignore", "pipe", "pipe"]
  });
  return buf.toString().trim();
}

/**
 * Shell-quote a string for use as a single argument.
 *
 * @param {string} str
 * @returns {string}
 */
function shellQuote(str) {
  return "'" + str.replace(/'/g, "'\"'\"'") + "'";
}


// =============================================================================
// MAIN
//

(async function main() {
  var config = loadConfig();
  var rl     = createRL();

  // ── 1. Script selection ────────────────────────────────────────────────────
  var scriptConfig;
  if (config.scripts.length === 1) {
    scriptConfig = config.scripts[0];
    console.log("\nScript: " + scriptConfig.name);
  } else {
    var scriptChoices = config.scripts.map(function(s) {
      return { value: s, label: s.name };
    });
    var picked = await promptChoice(rl, "Select script", scriptChoices);
    scriptConfig = picked.value;
  }

  var appKey = scriptConfig.app || "illustrator";
  var appConfig = APP_CONFIG[appKey];
  if (!appConfig) {
    rl.close();
    die("Unknown app \"" + appKey + "\" in script config. Valid: " + Object.keys(APP_CONFIG).join(", "));
  }

  var scriptPath = scriptConfig.scriptPath;
  if (!fs.existsSync(scriptPath)) {
    rl.close();
    die("Script not found: " + scriptPath + "\nCheck scriptPath in config.json.");
  }

  var templatePath = scriptConfig.templatePath;
  if (!templatePath) {
    rl.close();
    die("templatePath is not set for script \"" + scriptConfig.name + "\". Check config.json.");
  }

  // ── 2. Options ─────────────────────────────────────────────────────────────
  var optionValues   = {};
  var optionLabels   = {};  // key -> chosen label (for display)

  var options = scriptConfig.options || [];
  for (var i = 0; i < options.length; i++) {
    var opt    = options[i];
    var picked = await promptChoice(rl, opt.label, opt.choices);
    optionValues[opt.key] = picked.value;
    optionLabels[opt.key] = picked.label;
  }

  // ── 3. Folder ──────────────────────────────────────────────────────────────
  var defaultFolder = scriptConfig.defaultFolder || "";
  var rawFolder     = await promptText(rl, "Root folder", defaultFolder);
  var rootFolder    = rawFolder;
  if (rootFolder.slice(0, 2) === "~/") {
    rootFolder = path.join(process.env.HOME, rootFolder.slice(2));
  }
  if (!fs.existsSync(rootFolder)) {
    rl.close();
    die("Folder not found: " + rootFolder);
  }

  // ── 4. Slug ────────────────────────────────────────────────────────────────
  var userSlug = await askQuestion(rl, "\nSlug (blank for all): ");

  // ── 5. Discover slugs ─────────────────────────────────────────────────────
  var jobs = discoverSlugs(
    rootFolder,
    scriptConfig.slugs || [],
    scriptConfig.excludedSlugs || [],
    userSlug
  );

  if (jobs.length === 0) {
    rl.close();
    console.log("\nNo slugs found in:\n  " + rootFolder);
    process.exit(0);
  }

  // ── 6. Run scope ──────────────────────────────────────────────────────────
  var scopeChoices = [
    { value: "dry",   label: "Dry run (list slugs, no app calls)" },
    { value: "first", label: "First only (" + jobs[0].slug + ")" },
    { value: "all",   label: "Entire list (" + jobs.length + " slug" + (jobs.length !== 1 ? "s" : "") + ")" }
  ];
  var scope = await promptChoice(rl, "Run scope", scopeChoices);
  var dryRun    = scope.value === "dry";
  var firstOnly = scope.value === "first";

  if (firstOnly) { jobs = jobs.slice(0, 1); }

  // ── 7. Confirmation ───────────────────────────────────────────────────────
  var slugNames      = jobs.map(function(j) { return j.slug; });
  var configSlugs    = scriptConfig.slugs         || [];
  var configExcluded = scriptConfig.excludedSlugs  || [];
  var slugsLine;
  if (userSlug) {
    slugsLine = slugNames.join(", ") + "  (entered at prompt)";
  } else if (configSlugs.length > 0) {
    slugsLine = slugNames.join(", ") + "  (from config)";
  } else if (configExcluded.length > 0) {
    slugsLine = slugNames.join(", ") +
      "  (all except: " + configExcluded.map(function(a) { return a; }).join(", ") + ")";
  } else {
    slugsLine = slugNames.join(", ") + "  (all found)";
  }

  var optionLines = options.map(function(opt) {
    return "  " + opt.key + " = " + optionValues[opt.key] + "  (" + optionLabels[opt.key] + ")";
  });

  var divider = "\u2500".repeat(50);
  console.log("\n" + divider);
  console.log("Script   : " + scriptConfig.name);
  console.log("           " + scriptPath);
  console.log("Template : " + templatePath);
  if (optionLines.length > 0) {
    console.log("Options  :");
    optionLines.forEach(function(l) { console.log(l); });
  }
  console.log("Folder   : " + rootFolder);
  console.log("Scope    : " + scope.label);
  console.log("Slugs    : " + slugsLine);
  if (dryRun) { console.log("           (DRY RUN — no app calls)"); }
  console.log(divider);

  var confirmed = await promptYesNo(rl, "\nProceed?");
  rl.close();

  if (!confirmed) {
    console.log("Aborted.");
    process.exit(0);
  }

  // ── 8. Prepare template ───────────────────────────────────────────────────
  var batchTemplatePath = null;
  if (!dryRun) {
    batchTemplatePath = prepareTemplate(templatePath);
    console.log("\nCopied template → " + batchTemplatePath);
  }

  // ── 9. Run jobs ───────────────────────────────────────────────────────────
  console.log("");
  var passed = [];
  var failed = [];

  for (var i = 0; i < jobs.length; i++) {
    var job       = jobs[i];
    var slugName  = job.slug;
    var prefix    = "[" + (i + 1) + "/" + jobs.length + "] " + slugName;

    if (dryRun) {
      var dryOverride = path.join(path.dirname(templatePath), "overrides", slugName + "-template.ai");
      var dryHasOverride = fs.existsSync(dryOverride);
      console.log(prefix + "  (dry-run) folder: " + job.folder + (dryHasOverride ? "  [override]" : ""));
      passed.push(slugName);
      continue;
    }

    var overridePath = path.join(path.dirname(templatePath), "overrides", slugName + "-template.ai");
    var hasOverride  = fs.existsSync(overridePath);
    var fileToOpen   = hasOverride ? overridePath : batchTemplatePath;

    process.stdout.write(prefix + (hasOverride ? "  opening override... " : "  opening template... "));

    var argsFilePath = null;
    try {
      argsFilePath = writeBatchArgs(scriptPath, slugName, job.folder, optionValues);
      openInApp(appConfig, fileToOpen);
      process.stdout.write("running... ");
      var result = runScript(appConfig, scriptPath);

      if (result && /^error:/i.test(result)) {
        console.log("ERROR");
        console.error("  " + result);
        failed.push(slugName);
      } else {
        console.log("done");
        passed.push(slugName);
      }
    } catch (err) {
      console.log("ERROR");
      console.error("  " + err.message);
      failed.push(slugName);
    } finally {
      if (argsFilePath) { cleanupBatchArgs(scriptPath); }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("");
  console.log("\u2550".repeat(40));
  console.log("Done: " + passed.length + " passed, " + failed.length + " failed");
  if (failed.length > 0) {
    console.log("Failed: " + failed.join(", "));
    process.exit(1);
  }
})();


// =============================================================================
// UTILITIES
//

/**
 * Print an error message and exit with code 1.
 *
 * @param {string} message
 */
function die(message) {
  console.error("Error: " + message);
  process.exit(1);
}
