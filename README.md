# Batch Runner

Interactive batch runner for Adobe Illustrator and Photoshop scripts. Runs a configured script against every slug folder under a root directory, processing slugs sequentially.

A "slug" is a folder name that identifies the project — an airport code like `jfk`, a city name like `chicago`, etc.

## Requirements

- macOS (uses `osascript` to drive Adobe apps)
- Node.js >= 14
- The target Adobe application must be installed (Illustrator and/or Photoshop)

## Quick Start

```
node run.js
```

The runner will prompt you through:

1. **Script selection** — pick which script to run (if more than one is configured)
2. **Options** — answer each option defined for that script
3. **Root folder** — path to scan (a default is shown; press Enter to accept)
4. **Slug** — enter a specific slug, or leave blank for all
5. **Run scope** — dry run / first slug only / entire list
6. **Confirmation** — review a summary then confirm before anything executes

---

## config.json Reference

```json
{
  "scripts": [ ... ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `scripts` | Yes | Array of script configurations (see below) |

### Script object

```json
{
  "name": "My Script",
  "app": "illustrator",
  "scriptPath": "/path/to/my-script.jsx",
  "templatePath": "/path/to/collection/template.ai",
  "timeoutSeconds": 600,
  "defaultFolder": "/path/to/collection",
  "slugs": [],
  "excludedSlugs": [],
  "options": [ ... ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Display label shown in the script-selection prompt |
| `app` | No | Target application: `"illustrator"` (default) or `"photoshop"` |
| `scriptPath` | Yes | Absolute path to the `.jsx` script |
| `templatePath` | Yes | Absolute path to the `template.ai` file. This single template is used for every slug (unless an override exists — see below) |
| `timeoutSeconds` | No | Seconds to wait per slug before treating it as a timeout error |
| `defaultFolder` | No | Pre-filled default in the folder prompt |
| `slugs` | No | Array of slug names to process (case-insensitive). Empty array means discover all subdirectories under the root folder. Missing slug folders are created automatically |
| `excludedSlugs` | No | Slugs to skip (case-insensitive). Applied after slug discovery. Ignored when a specific slug is entered at the prompt |
| `options` | No | Array of option definitions (see below) |

### Option object

```json
{
  "key": "format",
  "label": "Export format",
  "choices": [
    { "value": "1", "label": "PNG" },
    { "value": "2", "label": "PDF" }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `key` | Yes | The key written to `batch-args.json` (read by the target script) |
| `label` | Yes | Heading shown above the choice list in the prompt |
| `choices` | Yes | Array of `{ value, label }` objects. `value` is written to `batch-args.json`; `label` is shown to the user |

---

## Template Handling

Each script config points to a single template file via `templatePath`. Before execution the runner copies it to `batch-template.ai` in the same directory and opens that copy in the target app for each slug. The copy is left open and unsaved after the run so you can inspect the result without risking the original template.

### Template Overrides

If a slug needs a custom template, place it in an `overrides` folder next to `template.ai`:

```
/path/to/collection/
  template.ai
  overrides/
    jfk-template.ai
    chicago-template.ai
```

When processing a slug, the runner checks for `overrides/{slug}-template.ai`. If found, it opens that file directly instead of `batch-template.ai`. Override files are opened as-is (not copied) so you can edit and save them.

If the `overrides` folder doesn't exist, the runner silently continues with the default template.

---

## Slug Discovery

When you run the batch runner, slug discovery follows this priority:

1. **Slug entered at prompt** — if you type a slug name, only that slug is processed
2. **`slugs` array in config** — if non-empty and no slug was entered, these slugs are used
3. **Directory scan** — if both are empty, all subdirectories under the root folder are used

After discovery, `excludedSlugs` are filtered out.

**Missing folders are created automatically.** If you add 100 slugs to the config array and those folders don't exist yet, the runner creates them before processing.

### Examples

**Process a single slug at runtime:**
```
Slug (blank for all): jfk
```

**Process specific slugs from config:**
```json
"slugs": ["jfk", "lax", "ord"],
"excludedSlugs": []
```

**Process everything except certain slugs:**
```json
"slugs": [],
"excludedSlugs": ["bur", "sna"]
```

**Process all discovered folders:**
```json
"slugs": [],
"excludedSlugs": []
```

---

## Adding a New Script

1. Open `config.json`.
2. Add a new object to the `scripts` array:

```json
{
  "name": "My New Script",
  "scriptPath": "/path/to/my-new-script.jsx",
  "templatePath": "/path/to/collection/template.ai",
  "defaultFolder": "/path/to/collection",
  "slugs": [],
  "excludedSlugs": [],
  "options": [
    {
      "key": "outputSize",
      "label": "Output size",
      "choices": [
        { "value": "small", "label": "Small (800px)" },
        { "value": "large", "label": "Large (2400px)" }
      ]
    }
  ]
}
```

3. Add the bypass block to your script (see below).
4. Run `node run.js` — your new script will appear in the selection list.

---

## How the Dialog Bypass Works

Before each slug is processed, the batch runner writes a file called `batch-args.json` directly next to the configured script. The file contains the slug name, slug folder path, and all user-chosen option values:

```json
{
  "slug": "jfk",
  "slugFolder": "/path/to/collection/jfk",
  "mode": "2",
  "format": "1"
}
```

The script checks for this file when it starts. If found, it reads the values and **skips its interactive dialogs**. The file is deleted immediately after reading, so it has no effect on manual runs.

After the script finishes (or if it crashes), the batch runner also performs a safety cleanup to ensure the file is removed.

---

## Error Handling

If the script returns a string starting with `ERROR:`, the batch runner treats that slug as failed and displays the error message. This lets your scripts validate the slug and report problems back to the runner.

Example in your script:

```javascript
if (!isValidSlug(batchArgs.slug)) {
  "ERROR: slug '" + batchArgs.slug + "' is not recognized";  // return value
} else {
  // ... normal processing ...
  "OK";
}
```

The runner also catches crashes and non-zero exits from `osascript` as failures.

---

## Adding the Bypass to Your Script

Add the following block at the very top of your `.jsx` script, before any dialog code:

```javascript
// =============================================================================
// BATCH RUNNER BYPASS
// Reads batch-args.json if present and skips interactive prompts.
// This file is written by run.js and deleted immediately after reading.
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

Then use `batchArgs` wherever you would otherwise show a dialog. If `batchArgs` is `null` the script is running manually and should show its normal UI:

```javascript
// Example: reading the slug
var slug = batchArgs ? batchArgs.slug : promptForSlug();
var slugFolder = batchArgs ? batchArgs.slugFolder : promptForFolder();

// Example: reading a "mode" option
var mode;
if (batchArgs && batchArgs.mode !== undefined) {
  mode = batchArgs.mode;           // batch run — use value from config
} else {
  mode = showModeDialog();         // manual run — show dialog as normal
}
```

The keys (`slug`, `slugFolder`, `mode`, `format`, etc.) correspond to `slug` and `slugFolder` (always present) plus the `key` fields in the `options` array of your script's config entry.
