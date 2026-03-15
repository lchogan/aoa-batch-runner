/**
 * Photoshop JSX: Batch "ASeries" PNGs or PDFs into template smart object and export web JPEGs.
 *
 * Behavior:
 * - Prompts for a root folder X
 * - Finds product-image-template.psd in X
 * - For each immediate subfolder Y in X:
 *     - Checks for Y/exports/pdf first, falls back to Y/exports/png if not found
 *     - For each file in that folder ending with "ASeries.pdf" or "ASeries.png":
 *         - Opens the template PSD
 *         - Opens smart object layer named "Drop Here"
 *         - Replaces smart object contents with the PDF/PNG, scaled to FILL canvas and centered
 *         - Exports a 2048x2048 JPEG (Save for Web) quality 60 to Y/shop-exports
 *         - Output name: <original base name>-shop.jpg
 *         - Overwrites existing files
 */

#target photoshop
app.bringToFront();

(function main() {
    if (!documentsSupported()) return;

    var root = Folder.selectDialog("Select the root folder (X) containing product-image-template.psd and subfolders to process:");
    if (!root) return;

    var templateFile = File(root.fsName + "/product-image-template.psd");
    if (!templateFile.exists) {
        alert("Template not found:\n" + templateFile.fsName + "\n\nExpected: product-image-template.psd in the selected folder.");
        return;
    }

    var subfolders = root.getFiles(function (f) { return f instanceof Folder; });
    if (!subfolders || subfolders.length === 0) {
        alert("No subfolders found in:\n" + root.fsName);
        return;
    }

    var processedCount = 0;
    var exportedCount = 0;
    var skippedFolders = 0;

    for (var i = 0; i < subfolders.length; i++) {
        var y = subfolders[i];

        // Check for PDF folder first, fall back to PNG folder
        var pdfFolder = Folder(y.fsName + "/exports/pdf");
        var pngFolder = Folder(y.fsName + "/exports/png");
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
            skippedFolders++;
            continue;
        }

        // Match only files that include the ASeries token and optionally any suffix
        // (e.g. timestamp) before the extension.
        var pngs = sourceFolder.getFiles(function (f) {
            if (!(f instanceof File)) return false;
            var pattern = new RegExp("ASeries(?:[-_].*)?\\." + fileExtension + "$", "i");
            return pattern.test(f.name);
        });

        if (!pngs || pngs.length === 0) {
            continue;
        }

        // Ensure shop-exports folder exists inside Y
        var shopExports = Folder(y.fsName + "/shop-exports");
        if (!shopExports.exists) shopExports.create();

        // Delete all existing files in shop-exports to ensure a fresh set
        var existingFiles = shopExports.getFiles(function (f) { return f instanceof File; });
        if (existingFiles && existingFiles.length > 0) {
            for (var k = 0; k < existingFiles.length; k++) {
                existingFiles[k].remove();
            }
        }

        for (var j = 0; j < pngs.length; j++) {
            var pngFile = pngs[j];
            processedCount++;

            try {
                exportOne(templateFile, pngFile, shopExports);
                exportedCount++;
            } catch (e) {
                // Continue processing other files; surface which file failed.
                alert("Failed on:\n" + pngFile.fsName + "\n\nReason:\n" + e.toString());
            }
        }
    }

    alert(
        "Done.\n\n" +
        "Subfolders scanned: " + subfolders.length + "\n" +
        "Folders without exports/pdf or exports/png: " + skippedFolders + "\n" +
        "ASeries files found: " + processedCount + "\n" +
        "JPEGs exported: " + exportedCount
    );

    // -------- Helpers --------

    function exportOne(templatePsd, pngFile, shopExportsFolder) {
        var originalRulerUnits = app.preferences.rulerUnits;
        var originalDisplayDialogs = app.displayDialogs;
        app.preferences.rulerUnits = Units.PIXELS;
        app.displayDialogs = DialogModes.NO;

        var templateDoc = app.open(templatePsd);

        try {
            var dropLayer = findLayerByName(templateDoc, "Drop Here");
            if (!dropLayer) throw new Error('Layer named "Drop Here" not found in template.');

            // Activate and ensure it is a smart object layer
            templateDoc.activeLayer = dropLayer;
            if (dropLayer.kind !== LayerKind.SMARTOBJECT) {
                throw new Error('Layer "Drop Here" is not a Smart Object layer.');
            }

            // Edit the smart object contents (opens PSB)
            editSmartObjectContents();

            // Now activeDocument is the smart object document
            var soDoc = app.activeDocument;

            // Remove existing contents (layers and groups)
            removeAllLayers(soDoc);

            // Bring in the PNG as a new layer
            var placedLayer = placePngAsLayerIntoDoc(pngFile, soDoc);

            // Scale to fill canvas and center
            scaleLayerToFillAndCenter(placedLayer, soDoc);

            // Save and close smart object to update template
            soDoc.save();
            soDoc.close(SaveOptions.SAVECHANGES);

            // Back to template doc (should be active again)
            templateDoc = app.activeDocument;

            // Duplicate for export so we don't touch the original template doc state
            var exportDoc = templateDoc.duplicate("TEMP_EXPORT", false);

            // Ensure 2048x2048 output
            exportDoc.resizeImage(UnitValue(2048, "px"), UnitValue(2048, "px"), null, ResampleMethod.BICUBICSHARPER);

            // Save for Web JPEG quality 60
            var outName = getBaseName(pngFile.name) + "-shop.jpg";
            var outFile = File(shopExportsFolder.fsName + "/" + outName);

            saveForWebJpeg(exportDoc, outFile, 60);

            // Close export doc without saving changes
            exportDoc.close(SaveOptions.DONOTSAVECHANGES);

        } finally {
            // Close template without saving
            if (templateDoc && templateDoc.saved !== undefined) {
                templateDoc.close(SaveOptions.DONOTSAVECHANGES);
            }
            app.preferences.rulerUnits = originalRulerUnits;
            app.displayDialogs = originalDisplayDialogs;
        }
    }

    function documentsSupported() {
        if (app.name !== "Adobe Photoshop") return false;
        return true;
    }

    function getBaseName(filename) {
        return filename.replace(/\.[^\.]+$/, ""); // strip last extension
    }

    function findLayerByName(doc, name) {
        // Search recursively in layer sets
        for (var i = 0; i < doc.layers.length; i++) {
            var found = findLayerInContainer(doc.layers[i], name);
            if (found) return found;
        }
        return null;

        function findLayerInContainer(layer, targetName) {
            if (layer.name === targetName) return layer;

            if (layer.typename === "LayerSet") {
                for (var j = 0; j < layer.layers.length; j++) {
                    var inner = findLayerInContainer(layer.layers[j], targetName);
                    if (inner) return inner;
                }
            }
            return null;
        }
    }

    function editSmartObjectContents() {
        var id = stringIDToTypeID("placedLayerEditContents");
        executeAction(id, new ActionDescriptor(), DialogModes.NO);
    }

    function removeAllLayers(doc) {
        // Delete all art layers and layer sets, including hidden/locked where possible
        // Note: Background layers can be tricky; convert if needed by deleting everything else.
        // We'll iterate from top to bottom to avoid index issues.
        for (var i = doc.layers.length - 1; i >= 0; i--) {
            safeRemoveLayer(doc.layers[i]);
        }

        function safeRemoveLayer(layer) {
            try {
                // Unlock if possible
                if (layer.allLocked) layer.allLocked = false;
                if (layer.pixelsLocked) layer.pixelsLocked = false;
                layer.remove();
            } catch (e) {
                // If it's a background layer or non-removable, try to make it normal
                try {
                    if (layer.isBackgroundLayer) {
                        layer.isBackgroundLayer = false;
                        layer.remove();
                    }
                } catch (e2) {
                    // If we can't remove, just hide it as last resort
                    try { layer.visible = false; } catch (e3) {}
                }
            }
        }
    }

    function placePngAsLayerIntoDoc(pngFile, targetDoc) {
        // Open PNG or PDF, duplicate its sole layer into targetDoc, close source doc
        var sourceDoc;
        var newLayer;

        // Check if it's a PDF and use appropriate open options
        var isPdf = /\.pdf$/i.test(pngFile.name);

        if (isPdf) {
            // For PDFs, use placeFile to preserve aspect ratio and quality
            app.activeDocument = targetDoc;

            try {
                // Use Place Embedded command via Action Manager
                var idPlc = charIDToTypeID("Plc ");
                var desc = new ActionDescriptor();
                desc.putPath(charIDToTypeID("null"), new File(pngFile));
                desc.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("Qcsa"));
                desc.putUnitDouble(charIDToTypeID("Wdth"), charIDToTypeID("#Prc"), 100.0);
                desc.putUnitDouble(charIDToTypeID("Hght"), charIDToTypeID("#Prc"), 100.0);
                desc.putBoolean(charIDToTypeID("AntA"), true);
                executeAction(idPlc, desc, DialogModes.NO);

                newLayer = targetDoc.activeLayer;

                // Rasterize the placed layer since it comes in as a smart object
                if (newLayer.kind === LayerKind.SMARTOBJECT) {
                    newLayer.rasterize(RasterizeType.ENTIRELAYER);
                }
            } catch (e) {
                // Fallback: open PDF as document with specified resolution
                var pdfOptions = new PDFOpenOptions();
                pdfOptions.antiAlias = true;
                pdfOptions.mode = OpenDocumentMode.RGB;
                pdfOptions.resolution = 300;
                pdfOptions.suppressWarnings = true;
                pdfOptions.usePageNumber = true;
                pdfOptions.page = 1;
                pdfOptions.constrainProportions = true;

                sourceDoc = app.open(pngFile, pdfOptions);

                try {
                    if (sourceDoc.layers.length > 1) {
                        sourceDoc.flatten();
                    }
                    newLayer = sourceDoc.activeLayer.duplicate(targetDoc, ElementPlacement.PLACEATBEGINNING);
                } finally {
                    sourceDoc.close(SaveOptions.DONOTSAVECHANGES);
                }

                app.activeDocument = targetDoc;
                targetDoc.activeLayer = newLayer;
            }
        } else {
            // For PNGs, use the original method
            sourceDoc = app.open(pngFile);

            try {
                if (sourceDoc.layers.length > 1) {
                    sourceDoc.flatten();
                }
                newLayer = sourceDoc.activeLayer.duplicate(targetDoc, ElementPlacement.PLACEATBEGINNING);
            } finally {
                sourceDoc.close(SaveOptions.DONOTSAVECHANGES);
            }

            app.activeDocument = targetDoc;
            targetDoc.activeLayer = newLayer;
        }

        return newLayer;
    }

    function scaleLayerToFillAndCenter(layer, doc) {
        // Compute scale factor so layer fills the entire canvas (cover), then center it.
        var docW = doc.width.as("px");
        var docH = doc.height.as("px");

        var b = layer.bounds; // [L, T, R, B]
        var layerW = (b[2].as("px") - b[0].as("px"));
        var layerH = (b[3].as("px") - b[1].as("px"));

        if (layerW <= 0 || layerH <= 0) throw new Error("Placed layer has invalid bounds.");

        var scale = Math.max(docW / layerW, docH / layerH) * 100.0;

        layer.resize(scale, scale, AnchorPosition.MIDDLECENTER);

        // Recompute bounds after resize
        b = layer.bounds;
        var left = b[0].as("px");
        var top = b[1].as("px");
        var right = b[2].as("px");
        var bottom = b[3].as("px");

        var layerCX = (left + right) / 2.0;
        var layerCY = (top + bottom) / 2.0;

        var docCX = docW / 2.0;
        var docCY = docH / 2.0;

        var dx = docCX - layerCX;
        var dy = docCY - layerCY;

        layer.translate(dx, dy);
    }

    function saveForWebJpeg(doc, outFile, quality) {
        var opts = new ExportOptionsSaveForWeb();
        opts.format = SaveDocumentType.JPEG;
        opts.includeProfile = false;
        opts.interlaced = false;
        opts.optimized = true;
        opts.quality = quality; // 0-100
        opts.blur = 0;
        opts.matte = MatteType.NONE;
        opts.webSnap = 0;
        opts.progressive = true;

        doc.exportDocument(outFile, ExportType.SAVEFORWEB, opts);
    }

})();
