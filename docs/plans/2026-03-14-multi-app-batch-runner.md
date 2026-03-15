# Multi-App Batch Runner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Abstract the batch runner to support both Illustrator and Photoshop (and future apps), then integrate the existing Photoshop `batch-shop-exports.jsx` script as a second app target.

**Architecture:** Introduce an `app` field per script config that selects how the runner opens files and executes scripts. The core flow (prompts, slug discovery, batch-args, error handling) stays untouched. App-specific behavior is isolated into small executor functions selected by a dispatcher. The Photoshop script gets a batch-args bypass block and switches from self-managed folder scanning to receiving `slug`/`slugFolder` from the runner.

**Tech Stack:** Node.js, osascript (AppleScript), Illustrator JSX, Photoshop JSX

---

## Analysis: What's Already Generic vs What Needs Abstraction

### Already generic (no changes needed)
- Config loading
- All interactive prompts (promptChoice, promptText, promptYesNo)
- Slug discovery, filtering, folder creation
- batch-args.json write/cleanup
- Run scope, confirmation, summary
- Template copy → batch-template (file system level)
- Override detection

### Illustrator-specific (needs abstraction)
- `openInIllustrator(filePath)` — opens .ai file via osascript + AppleScript targeting Illustrator
- `runIllustratorScript(scriptPath)` — runs .jsx via `$.evalFile` in Illustrator context
- The AppleScript string: `tell application "Adobe Illustrator" to do javascript ...`

### What the Photoshop script currently does that the runner would take over
- Folder selection dialog → replaced by runner's root folder prompt
- Subfolder scanning → replaced by runner's slug discovery
- Template file lookup → replaced by runner's `templatePath` config
- The Photoshop script currently opens the template itself inside `exportOne()`. Under the runner, the runner opens the template, then the script operates on the active document.

### Key difference: Photoshop invocation
- Illustrator: `tell application "Adobe Illustrator" to do javascript "code"`
- Photoshop: `tell application "Adobe Photoshop 2026" to do javascript "code"` (same pattern, different app name)

This is the critical insight — **both apps use the same osascript `do javascript` mechanism**. The abstraction is just the app name string.

---

## Task 1: Add `app` field to config and app dispatcher in run.js

**Files:**
- Modify: `config.json`
- Modify: `run.js`

### Step 1: Update config.json schema

Add an `app` field to each script config. Valid values: `"illustrator"` or `"photoshop"`.

```json
{
  "name": "Airport Diagram Export",
  "app": "illustrator",
  "scriptPath": "...",
  ...
}
```

For the existing two Illustrator scripts, add `"app": "illustrator"` to each.

### Step 2: Add app configuration map in run.js

Replace the hardcoded Illustrator app name with a lookup. Add this near the top of run.js after the config loading section:

```javascript
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
```

### Step 3: Refactor openInIllustrator → openInApp and runIllustratorScript → runScript

Replace the two Illustrator-specific functions:

```javascript
function openInApp(appConfig, filePath) {
  var jsCode = appConfig.openArgs(filePath);
  var script = 'tell application "' + appConfig.appName + '" to do javascript ' +
    JSON.stringify(jsCode);
  execOsascript(script);
}

function runScript(appConfig, scriptPath) {
  var jsCode = appConfig.runArgs(scriptPath);
  var script = 'tell application "' + appConfig.appName + '" to do javascript ' +
    JSON.stringify(jsCode);
  return execOsascript(script);
}
```

### Step 4: Update main() to resolve app config

After script selection, resolve the app config:

```javascript
var appKey = scriptConfig.app || "illustrator";  // default for backwards compat
var appConfig = APP_CONFIG[appKey];
if (!appConfig) {
  rl.close();
  die("Unknown app \"" + appKey + "\" in script config. Valid: " + Object.keys(APP_CONFIG).join(", "));
}
```

### Step 5: Update the job loop to use the generic functions

Replace:
```javascript
openInIllustrator(fileToOpen);
// ...
var result = runIllustratorScript(scriptPath);
```

With:
```javascript
openInApp(appConfig, fileToOpen);
// ...
var result = runScript(appConfig, scriptPath);
```

### Step 6: Update config.json comment and README

Add `"app"` to the top-level `_comment` and to the README's config reference table.

### Step 7: Verify nothing is broken

Run: `node run.js` — select an Illustrator script, do a dry run, confirm the flow still works.

### Step 8: Commit

```bash
git add run.js config.json README.md
git commit -m "refactor: abstract app-specific functions behind app config dispatcher"
```

---

## Task 2: Add Photoshop batch-shop-exports to config.json

**Files:**
- Modify: `config.json`

### Step 1: Add the Photoshop script entry

```json
{
  "name": "Product Image Shop Exports",
  "app": "photoshop",
  "scriptPath": "/Users/lukehogan/Documents/startups/aoa/photoshop/batch-shop-exports.jsx",
  "templatePath": "/Users/lukehogan/Documents/startups/aoa/collections/airport-diagrams/product-image-template.psd",
  "defaultFolder": "/Users/lukehogan/Documents/startups/aoa/collections/airport-diagrams",
  "slugs": [],
  "excludedSlugs": [],
  "options": []
}
```

Notes:
- `templatePath` points to the `.psd` template (was previously `product-image-template.psd` in the root folder)
- No options needed — the Photoshop script has no user-configurable choices (quality, size, etc. are hardcoded)
- The `defaultFolder` and `templatePath` will need to be adjusted to real paths once you decide where the template lives

### Step 2: Commit

```bash
git add config.json
git commit -m "feat: add Photoshop shop-exports script to batch runner config"
```

---

## Task 3: Adapt the Photoshop script for batch-runner integration

**Files:**
- Modify: `/Users/lukehogan/Documents/startups/aoa/photoshop/batch-shop-exports.jsx`

This is the biggest task. The existing script does its own folder scanning and template opening. Under the batch runner:
- The runner opens the template (batch-template.psd or override)
- The runner passes `slug` and `slugFolder` via batch-args.json
- The script operates on the already-open document

### Step 1: Add the batch-args bypass block at the top

Add after `#target photoshop` and `app.bringToFront()`:

```javascript
// =============================================================================
// BATCH RUNNER BYPASS
// Reads batch-args.json if present and skips interactive prompts.
// =============================================================================
var batchArgs = null;
(function () {
  var argsFile = new File($.fileName.replace(/[^\/]+$/, "batch-args.json"));
  if (argsFile.exists) {
    argsFile.open("r");
    try { batchArgs = JSON.parse(argsFile.read()); } catch (e) {}
    argsFile.close();
    argsFile.remove();
  }
})();
```

### Step 2: Restructure main() to support both batch and manual modes

The script needs two paths:

**Batch mode** (batchArgs is not null):
- Template is already open as `app.activeDocument`
- `batchArgs.slugFolder` tells us where to find source files and write exports
- Process just this one slug, then return a result string

**Manual mode** (batchArgs is null):
- Current behavior: prompt for root folder, scan subfolders, open template per file

Restructure the main function:

```javascript
(function main() {
    if (!documentsSupported()) return;

    if (batchArgs) {
        // ── Batch mode: runner already opened the template ──
        var slugFolder = new Folder(batchArgs.slugFolder);
        if (!slugFolder.exists) {
            "ERROR: slug folder does not exist: " + batchArgs.slugFolder;
            return;
        }

        var templateDoc = app.activeDocument;
        var result = processOneSlug(templateDoc, slugFolder);

        // Return result string for batch runner to capture
        result;
    } else {
        // ── Manual mode: original interactive behavior ──
        runManual();
    }
})();
```

### Step 3: Extract processOneSlug() from the existing loop body

Pull the inner loop logic (lines 43-101 of the current script) into a standalone function:

```javascript
function processOneSlug(templateDoc, slugFolder) {
    // Check for PDF folder first, fall back to PNG folder
    var pdfFolder = Folder(slugFolder.fsName + "/exports/pdf");
    var pngFolder = Folder(slugFolder.fsName + "/exports/png");
    var sourceFolder = null;
    var fileExtension = "";

    if (pdfFolder.exists) {
        sourceFolder = pdfFolder;
        fileExtension = "pdf";
    } else if (pngFolder.exists) {
        sourceFolder = pngFolder;
        fileExtension = "png";
    }

    if (!sourceFolder) {
        return "ERROR: no exports/pdf or exports/png folder in " + slugFolder.fsName;
    }

    var sourceFiles = sourceFolder.getFiles(function (f) {
        if (!(f instanceof File)) return false;
        var pattern = new RegExp("ASeries(?:[-_].*)?\\." + fileExtension + "$", "i");
        return pattern.test(f.name);
    });

    if (!sourceFiles || sourceFiles.length === 0) {
        return "ERROR: no ASeries files found in " + sourceFolder.fsName;
    }

    var shopExports = Folder(slugFolder.fsName + "/shop-exports");
    if (!shopExports.exists) shopExports.create();

    // Clear existing exports
    var existingFiles = shopExports.getFiles(function (f) { return f instanceof File; });
    if (existingFiles) {
        for (var k = 0; k < existingFiles.length; k++) {
            existingFiles[k].remove();
        }
    }

    var exported = 0;
    for (var j = 0; j < sourceFiles.length; j++) {
        exportOne(templateDoc, sourceFiles[j], shopExports);
        exported++;
    }

    return "OK: exported " + exported + " files";
}
```

### Step 4: Update exportOne() for batch mode

The current `exportOne()` opens and closes the template each time. In batch mode, the template is already open. The key change: **don't open or close the template in batch mode** — work on the already-active document.

The simplest approach: `exportOne` receives the already-open `templateDoc` and operates on it. It should NOT close the template at the end. The existing `finally` block that closes the template needs to be conditional:

```javascript
function exportOne(templateDoc, pngFile, shopExportsFolder, keepOpen) {
    // ... existing smart object logic ...
    // In the finally block:
    if (!keepOpen) {
        templateDoc.close(SaveOptions.DONOTSAVECHANGES);
    }
}
```

In batch mode, call with `keepOpen = true`. In manual mode, call with `keepOpen = false` (preserving current behavior).

**Important nuance:** In batch mode, the runner re-opens batch-template.psd for each slug. So within `processOneSlug`, if there are multiple ASeries files for one slug, `exportOne` should NOT close the template between files — only the runner closes/reopens between slugs.

### Step 5: Wrap the original manual flow in runManual()

Move the existing root-folder-prompt + subfolder-scanning logic into `runManual()` so the top-level `main()` stays clean.

### Step 6: Test manually

Open the script directly in Photoshop (no batch runner) and confirm the manual flow still works exactly as before.

### Step 7: Test via batch runner

Run: `node run.js` — select the Photoshop script, pick a slug, run on one folder.

### Step 8: Commit

```bash
git add /path/to/batch-shop-exports.jsx
git commit -m "feat: adapt Photoshop shop-exports script for batch runner integration"
```

---

## Task 4: Update README for multi-app support

**Files:**
- Modify: `README.md`

### Step 1: Document the `app` field

Add to the script object table:

| Field | Required | Description |
|-------|----------|-------------|
| `app` | No | Application to use: `"illustrator"` (default) or `"photoshop"`. Determines how templates are opened and scripts are executed. |

### Step 2: Add a Photoshop section

Document:
- How the Photoshop script differs (processes source files from `exports/pdf` or `exports/png` within each slug folder)
- That the template is a `.psd` file with a "Drop Here" smart object layer
- The batch-args bypass block is the same pattern as Illustrator

### Step 3: Add a section on adding support for new apps

Document how to add a new app by adding an entry to `APP_CONFIG` in run.js with `appName`, `openArgs`, and `runArgs`.

### Step 4: Commit

```bash
git add README.md
git commit -m "docs: update README for multi-app batch runner support"
```

---

## Open Questions for Luke

1. **Template location for Photoshop:** Where does `product-image-template.psd` live? Currently the Photoshop script expects it in the root folder alongside the slug subfolders. Should it move to a dedicated location, or is having it in the root fine? (The runner's `templatePath` config handles either way.)

2. **Photoshop app name:** Is it `"Adobe Photoshop 2026"` or something else? The osascript `tell application` command needs the exact name. We can check with `osascript -e 'tell application "System Events" to get name of every process'` while Photoshop is running.

3. **Multiple ASeries files per slug:** The current Photoshop script processes ALL matching ASeries files in a slug's exports folder. Under the batch runner, the template is opened once per slug. The adapted script will process all files against that one open template — this should work fine, but worth confirming the intent is to keep this behavior.

4. **Photoshop options:** The current script has no user-configurable options (JPEG quality 60, 2048x2048 are hardcoded). Should any of these become configurable via the batch runner's options system? Easy to add later if needed.

5. **Override templates:** Do Photoshop scripts need the override system (`overrides/{slug}-template.psd`)? The current runner supports this generically so it would work automatically, but worth confirming it's relevant for the Photoshop workflow.
