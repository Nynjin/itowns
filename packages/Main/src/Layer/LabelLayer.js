import * as THREE from 'three';
import LayerUpdateState from 'Layer/LayerUpdateState';
import ObjectRemovalHelper from 'Process/ObjectRemovalHelper';
import GeometryLayer from 'Layer/GeometryLayer';
import { Coordinates, Extent } from '@itowns/geographic';
import Label from 'Core/Label';
import Style, { readExpression, StyleContext } from 'Core/Style';
import { ScreenGrid } from 'Renderer/Label2DRenderer';
import { Label as InstancedLabel, TextAnchorX, TextAnchorY, RotationAlignment, SymbolPlacement, LabelProfiler, TieredLabelCache } from '@itowns/labels';
import { enqueueBudgeted } from 'Core/Scheduler/FrameBudget';

const context = new StyleContext();

const coord = new Coordinates('EPSG:4326', 0, 0, 0);

const _extent = new Extent('EPSG:4326', 0, 0, 0, 0);

const nodeDimensions = new THREE.Vector2();
const westNorthNode = new THREE.Vector2();
const labelPosition = new THREE.Vector2();
const instancedPosition = new THREE.Vector3();

function mapAnchorX(anchor) {
    if (anchor[0] >= -0.25) {
        return TextAnchorX.Left;
    }
    if (anchor[0] <= -0.75) {
        return TextAnchorX.Right;
    }
    return TextAnchorX.Center;
}

function mapAnchorY(anchor) {
    if (anchor[1] >= -0.25) {
        return TextAnchorY.Top;
    }
    if (anchor[1] <= -0.75) {
        return TextAnchorY.Bottom;
    }
    return TextAnchorY.Middle;
}

function toInstancedTextContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    return content?.textContent || '';
}

function getTerrainLift(label, pxPerUnit) {
    const textStyle = label.instancedTextStyle || {};
    const fontSize = textStyle.size || 20;
    const anchor = Array.isArray(label.anchor) ? label.anchor : [0, 0];
    const labelHeight = fontSize / pxPerUnit;
    const anchorFactor = Math.max(0, 1 + anchor[1]);
    return Math.max(2, labelHeight * anchorFactor);
}

// Average glyph advance as a fraction of the font size — used to estimate a
// label's on-screen width without a DOM box. ~0.55 matches typical proportional
// Latin fonts closely enough for overlap testing.
const GLYPH_ADVANCE_RATIO = 0.55;

// Instanced labels never go through the DOM, so they never get the `offset`
// (and thus `boundaries`) that `Label.initDimensions()` derives from
// `getBoundingClientRect()`. The screen-grid pre-filter needs those bounds, so
// synthesize an equivalent box from the instanced text metrics. Mirrors the
// structure produced by `Label.initDimensions()`.
function ensureInstancedLabelOffset(label) {
    if (label.offset) { return; }

    const textStyle = label.instancedTextStyle || {};
    const fontSize = textStyle.size || 16;
    const text = toInstancedTextContent(label.instancedTextContent || label.content) || '';
    const longestLine = text.split('\n').reduce((m, l) => Math.max(m, l.length), 0);

    const width = Math.max(fontSize, longestLine * fontSize * GLYPH_ADVANCE_RATIO);
    const height = fontSize * 1.2;

    const anchor = Array.isArray(label.anchor) ? label.anchor : [0, 0];
    const styleOffset = Array.isArray(label.styleOffset) ? label.styleOffset : [0, 0];
    const left = width * anchor[0] + styleOffset[0];
    const top = height * anchor[1] + styleOffset[1];

    label.offset = { left, top, right: left + width, bottom: top + height };
}

function resolveTextProperty(context, ...sources) {
    for (const source of sources) {
        if (source == undefined) {
            continue;
        }
        const value = readExpression(source, context);
        if (value != undefined) {
            return value;
        }
    }
    return undefined;
}

function snapshotInstancedTextStyle(context, geometryStyle, featureStyle, layerStyle, defaultFonts) {
    const geometryText = geometryStyle?.text || {};
    const featureText = featureStyle?.text || {};
    const layerText = layerStyle?.text || {};
    return {
        font: resolveTextProperty(context, geometryText.font, featureText.font, layerText.font) || defaultFonts,
        size: resolveTextProperty(context, geometryText.size, featureText.size, layerText.size) || 16,
        color: resolveTextProperty(context, geometryText.color, featureText.color, layerText.color) || '#000000',
        opacity: resolveTextProperty(context, geometryText.opacity, featureText.opacity, layerText.opacity) ?? 1,
        haloColor: resolveTextProperty(context, geometryText.haloColor, featureText.haloColor, layerText.haloColor) || '#000000',
        haloWidth: resolveTextProperty(context, geometryText.haloWidth, featureText.haloWidth, layerText.haloWidth) || 0,
        haloOpacity: resolveTextProperty(context, geometryText.haloOpacity, featureText.haloOpacity, layerText.haloOpacity) ?? 1,
        rotationAlignment: RotationAlignment.Viewport,

        symbolPlacement: resolveTextProperty(context, geometryText.placement, featureText.placement, layerText.placement) === 'line'
            ? SymbolPlacement.Line
            : SymbolPlacement.Point,
        offset: resolveTextProperty(context, geometryText.offset, featureText.offset, layerText.offset) || [0, 0],
        // Fallback when the style genuinely has no text-padding: MapLibre's own
        // spec default is 2 (px), not 20 — see the note at the addLabel() padding
        // read-site for how 20 leaked in here.
        padding: resolveTextProperty(context, geometryText.padding, featureText.padding, layerText.padding) ?? 2,
    };
}

function resolveInstancedLabelContent(context, geometryStyle, featureStyle, layerStyle) {
    const geometryText = geometryStyle?.text || {};
    const featureText = featureStyle?.text || {};
    const layerText = layerStyle?.text || {};
    return resolveTextProperty(context, geometryText.field, featureText.field, layerText.field);
}

/**
 * DomNode is a node in the tree data structure of labels divs.
 *
 * @class DomNode
 */
class DomNode {
    #domVisibility = false;

    constructor() {
        this.dom = document.createElement('div');
        this.dom.style.display = 'none';
        this.visible = true;
    }

    get visible() { return this.#domVisibility; }

    set visible(v) {
        if (v !== this.#domVisibility) {
            this.#domVisibility = v;
            this.dom.style.display = v ? 'block' : 'none';
        }
    }

    hide() { this.visible = false; }
    show() { this.visible = true; }

    add(node) {
        this.dom.append(node.dom);
    }
}

/**
 * LabelsNode is node of tree data structure for LabelLayer.
 * the node is made of dom elements and 3D labels.
 *
 * @class      LabelsNode
 */
class LabelsNode extends THREE.Group {
    constructor(node, view, isInstanced, isAsync = false) {
        super();
        this.nodeParent = node;
        this.isInstanced = isInstanced;
        this.instancedLabelManager = isAsync
            ? view?.instancedLabelManagerAsync
            : view?.instancedLabelManager;
        this.instancedLabels = new Map();

        // When this is set, it calculates the position in that frame and resets this property to false.
        this.needsUpdate = true;
    }

    // instantiate dom elements
    initializeDom() {
        if (this.isInstanced) return;

        // create root dom
        this.domElements = new DomNode();
        // create labels container dom
        this.domElements.labels = new DomNode();

        this.domElements.add(this.domElements.labels);
        this.domElements.labels.dom.style.opacity = '0';
    }

    // add node label
    // add label 3d and dom label
    addLabel(label) {
        if (this.isInstanced) {
            if (!this.instancedLabels.has(label) && this.instancedLabelManager) {
                coord.copy(label.coordinates);
                coord.z = (coord.z || 0) + getTerrainLift(label, this.instancedLabelManager.config.pxPerUnit);
                coord.as(this.nodeParent.layer.crs, coord).toVector3(instancedPosition);

                const textStyle = label.instancedTextStyle || {};
                const fontSize = textStyle.size || 20;
                const offset = Array.isArray(textStyle.offset) ? textStyle.offset : [0, 0];
                const anchor = label.anchor || [0, 0];

                const instancedLabel = new InstancedLabel({
                    text: toInstancedTextContent(label.instancedTextContent || label.content),
                    position: instancedPosition.clone(),
                    font: Array.isArray(textStyle.font) ? textStyle.font.join(',') : 'sans-serif',
                    fontSize,
                    offset: [offset[0] / fontSize, offset[1] / fontSize],
                    color: textStyle.color || '#ffffff',
                    opacity: textStyle.opacity == undefined ? 1 : textStyle.opacity,
                    haloColor: textStyle.haloColor || '#000000',
                    haloWidth: textStyle.haloWidth || 0,
                    haloOpacity: textStyle.haloOpacity == undefined ? 1 : textStyle.haloOpacity,
                    anchorX: mapAnchorX(anchor),
                    anchorY: mapAnchorY(anchor),
                    // Unlike every other instanced-text property above, this used
                    // to read `label.padding` — the OUTER Core/Label's own field,
                    // whose sane class default (2, Core/Label.js) was unconditionally
                    // stomped to 20 in convert() below. Read the resolved style
                    // value instead, same as color/haloColor/offset/etc. above.
                    padding: textStyle.padding ?? 2,
                    visible: label.visible,
                    rotationAlignment: textStyle.rotationAlignment || RotationAlignment.Map,
                    symbolPlacement: textStyle.symbolPlacement || SymbolPlacement.Point,
                });

                this.instancedLabels.set(label, instancedLabel);
                this.instancedLabelManager.addLabel(instancedLabel);
            }
            return;
        }

        // Register (DOM): attach the element to the tree.
        const _pReg = LabelProfiler.begin();
        // add 3d object
        this.add(label);
        // add dom label
        this.domElements.labels.dom.append(label.content);
        LabelProfiler.end('register', _pReg);

        // Layout (DOM): initDimensions() reads getBoundingClientRect — the browser
        // reflow that measures the label (analog of instanced layoutText).
        const _pLayout = LabelProfiler.begin();
        // Batch update the dimensions of labels all at once to avoid
        // redraw for at least this tile.
        label.initDimensions();
        LabelProfiler.end('layout', _pLayout);

        // add horizon culling point if it's necessary
        // the horizon culling is applied to nodes that trace the horizon which
        // corresponds to the low zoom node, that's why the culling is done for a zoom lower than 4.
        if (this.nodeParent.layer.isGlobeLayer && this.nodeParent.level < 4) {
            label.horizonCullingPoint = new THREE.Vector3();
        }
    }

    // remove node label
    // remove label 3d and dom label
    removeLabel(label) {
        const _pDel = LabelProfiler.begin();
        if (this.isInstanced) {
            const instancedLabel = this.instancedLabels.get(label);
            if (instancedLabel && this.instancedLabelManager) {
                this.instancedLabelManager.removeLabel(instancedLabel);
                this.instancedLabels.delete(label);
            }
        } else {
            // remove 3d object
            this.remove(label);
            // remove dom label
            this.domElements.labels.dom.removeChild(label.content);
        }
        LabelProfiler.end('delete', _pDel);
    }

    // update position if it's necessary
    updatePosition(label) {
        if (this.needsUpdate) {
            // update elevation from elevation layer.
            if (this.needsAltitude) {
                label.updateElevationFromLayer(this.nodeParent.layer, [this.nodeParent]);
            }

            // update elevation label
            label.update3dPosition(this.nodeParent.layer.crs);

            if (this.isInstanced) {
                const instancedLabel = this.instancedLabels.get(label);
                if (instancedLabel && this.instancedLabelManager) {
                    coord.copy(label.coordinates);
                    coord.z = (coord.z || 0) + getTerrainLift(label, this.instancedLabelManager.config.pxPerUnit);
                    coord.as(this.nodeParent.layer.crs, coord).toVector3(instancedPosition);
                    instancedLabel.position = instancedPosition;
                    instancedLabel.visible = label.visible;
                }
            }

            // update horizon culling
            label.updateHorizonCullingPoint();
        }
    }

    // return labels count
    count() {
        return this.isInstanced ? this.instancedLabels.size : this.children.length;
    }

    get labels() {
        return this.children;
    }
}

/**
 * A layer to handle a bunch of `Label`. This layer can be created on its own,
 * but it is better to use the option `addLabelLayer` on another `Layer` to let
 * it work with it (see the `vector_tile_raster_2d` example). Supported for Points features, not yet
 * for Lines and Polygons features.
 */
class LabelLayer extends GeometryLayer {
    #filterGrid = new ScreenGrid();

    // Warm label cache. When an instanced tile is unloaded, its label GPU slots
    // are kept registered (hidden) instead of destroyed, keyed by tile, so
    // revisiting the tile (orbit/zoom churn) restores them cheaply instead of a
    // full rebuild + re-upload. The tiered hot/cold/delete policy + storage live
    // in the generic TieredLabelCache; this layer owns only the tile↔label side
    // (the tile key, and when to park/restore). Null when caching is disabled.
    #labelCache = null;
    #labelManager = null;

    constructor(id, config = {}) {
        const {
            domElement,
            performance = true,
            forceLabelCount = 0,
            instanced = false,
            async: useAsync = false,
            forceClampToTerrain = false,
            defaultFonts = ['Open Sans Regular', 'Arial Unicode MS Regular', 'sans-serif'],
            margin,
            style = {},
            ...geometryConfig
        } = config;
        super(id, config.object3d || new THREE.Group(), geometryConfig);

        this.isLabelLayer = true;
        this.style = style instanceof Style ? style : new Style(style);

        this.isInstanced = instanced;
        this.useAsync = useAsync;
        // Label2DRenderer.render() filters layers with !l.useInstancedLabels to skip
        // DOM processing for instanced layers. Keep it in sync with isInstanced.
        this.useInstancedLabels = instanced;
        this.domElement = new DomNode();
        this.domElement.show();
        this.domElement.dom.id = `itowns-label-${this.id}`;
        this.buildExtent = true;
        this.crs = config.source.crs;
        this.performance = performance;
        // Keep an unloaded tile's instanced labels warm and restore them on
        // revisit instead of re-uploading. Two tiers: HOT keeps them resident and
        // hidden via `groupVisible = false` (restore = a visibility flip, zero GPU
        // work); COLD frees their GPU slots but keeps the objects (restore =
        // re-register, one upload, no re-shape). Only safe with the SYNC instanced
        // manager: `groupVisible` is honoured by the main-thread collision engine,
        // but the async manager collides in a worker whose copy wouldn't get the
        // flip, so a parked (not REMOVE_LABELS'd) label would ghost. Hence
        // `instanced && !async`; DOM labels don't have this GPU cost either.
        // Disable with `cacheUnloadedLabels: false`. The hot/cold sizes are label
        // GPU tuning and live in the manager's config (`hotLabelCacheSize` /
        // `coldLabelCacheSize`); the cache is built lazily in #ensureLabelCache
        // once the manager (and its config) is attached from the view.
        this.cacheUnloadedLabels = instanced && !useAsync && (config.cacheUnloadedLabels ?? true);
        // Forced label count, applied PER TILE at the source in convert() (0 =
        // off): each tile builds at most N labels (first-N in feature order, no
        // sort), before the per-feature style/geometry work. This mirrors
        // MapLibre's per-tile worker cap (SymbolBucket.populate early-break) so
        // both engines build and process a matched ~N-per-tile label workload —
        // the fair basis for the label-rendering benchmark. Scene total is
        // N × visible tiles, by design (MapLibre caps per tile too, not globally).
        this.forceLabelCount = forceLabelCount;
        this.forceClampToTerrain = forceClampToTerrain;
        this.margin = margin;
        this.defaultFonts = Array.isArray(defaultFonts) && defaultFonts.length
            ? defaultFonts
            : [defaultFonts || 'sans-serif'];

        this.toHide = new THREE.Group();
        this.labelDomelement = domElement;
    }

    get visible() {
        return super.visible;
    }

    set visible(value) {
        super.visible = value;
        if (value) {
            this.domElement?.show();
        } else {
            this.domElement?.hide();
        }
    }

    get submittedLabelNodes() {
        return this.object3d.children;
    }

    convert(data, extentOrTile) {
        // Parse + style-extraction + Label creation for one tile/extent.
        const _pConvert = LabelProfiler.begin();
        const labels = [];

        // Converting the extent now is faster for further operation
        if (extentOrTile.isExtent) {
            extentOrTile.as(data.crs, _extent);
        } else {
            extentOrTile.toExtent(data.crs, _extent);
        }
        coord.crs = data.crs;

        context.setZoom(extentOrTile.zoom);

        data.features.forEach((f) => {
            // Per-tile forced label cap (0 = off): once this tile has produced N
            // labels, stop — before the per-feature style/geometry/Label work runs
            // on the rest. This mirrors MapLibre's worker-side SymbolBucket.populate
            // early-break (per tile/bucket), so both engines build ~N labels per
            // tile and the label pipeline processes a matched workload. First-N in
            // feature order, no sort — same as MapLibre.
            if (this.forceLabelCount > 0 && labels.length >= this.forceLabelCount) { return; }

            // Per-feature zoom gate: `f.style` is the MATCHED vector-tile style
            // rule (VectorTileParser sets it to options.in.styles[feature.id]),
            // which carries that rule's own minzoom/maxzoom
            // (StyleOptions.setFromVectorTileLayer). This is what a Mapbox/MapLibre
            // style JSON actually uses to stage labels in progressively by zoom
            // (e.g. hamlet names from z12, major roads only below z14) — distinct
            // from `this.style.zoom` checked further down, which is the LabelLayer's
            // own top-level override and does not vary per matched rule. Without
            // this, every style rule whose `filter` matched was treated as a label
            // candidate at every zoom, since `filter` and `minzoom`/`maxzoom` are
            // independent properties in the style spec — for a style with many
            // zoom-staged layers this multiplies the candidate count severalfold.
            // Guarded: `f.style` is the unresolved default (the
            // StyleOptions.setFromProperties function) for non-vector-tile
            // sources, which carries no `.zoom` — those are unaffected.
            const fZoom = f.style && f.style.zoom;
            if (fZoom && (fZoom.min > extentOrTile.zoom || fZoom.max <= extentOrTile.zoom)) { return; }

            if (f.style.text) {
                if (Object.keys(f.style.text).length === 0) {
                    return;
                }
            }

            context.setFeature(f);

            const featureField = f.style?.text?.field;

            // determine if altitude style is specified by the user
            const altitudeStyle = f.style?.point?.base_altitude;
            const isDefaultElevationStyle = altitudeStyle instanceof Function && altitudeStyle.name == 'baseAltitudeDefault';

            // determine if the altitude needs update with ElevationLayer
            labels.needsAltitude = labels.needsAltitude || this.forceClampToTerrain === true || (isDefaultElevationStyle && !f.hasRawElevationData);

            f.geometries.forEach((g) => {
                context.setGeometry(g);
                this.style.setContext(context);
                const layerField = this.style.text && this.style.text.field;
                const geometryField = g.properties.style && g.properties.style.text && g.properties.style.text.field;
                let content;

                if (this.isInstanced) {
                    content = resolveInstancedLabelContent(
                        context,
                        g.properties.style,
                        f.style,
                        this.style,
                    );
                    // Instanced labels are text-only. Skip text-less features so
                    // we don't register phantom empty labels — this mirrors the
                    // DOM branch below (which skips when there's no field/icon)
                    // and keeps the instanced label count comparable to DOM.
                    if (content == null || content === '') {
                        return;
                    }
                } else if (this.labelDomelement) {
                    content = readExpression(this.labelDomelement, context);
                } else if (!geometryField && !featureField && !layerField) {
                    // Check if there is an icon, with no text
                    if (!(g.properties.style && (g.properties.style.icon.source || g.properties.style.icon.key))
                        && !(f.style && f.style.icon && (f.style.icon.source || f.style.icon.key))
                        && !(this.style.icon && (this.style.icon.source || this.style.icon.key))) {
                        return;
                    }
                }

                if (this.style.zoom.min > this.style.context.zoom || this.style.zoom.max <= this.style.context.zoom) {
                    return;
                }

                // NOTE: this only works fine for POINT.
                // It needs more work for LINE and POLYGON as we currently only use the first point of the entity

                g.indices.forEach((i) => {
                    // Strict per-tile cap: a single feature can emit several labels
                    // (multi-point geometry), so re-check the budget before each.
                    if (this.forceLabelCount > 0 && labels.length >= this.forceLabelCount) { return; }

                    coord.setFromArray(f.vertices, g.size * i.offset);
                    // Transform coordinate to data.crs projection
                    coord.applyMatrix4(data.matrixWorld);

                    if (!_extent.isPointInside(coord)) { return; }

                    const label = new Label(content, coord.clone(), this.style);
                    label.instancedTextContent = content;
                    label.instancedTextStyle = snapshotInstancedTextStyle(
                        context,
                        g.properties.style,
                        f.style,
                        this.style,
                        this.defaultFonts,
                    );

                    label.layerId = this.id;
                    label.order = f.order;
                    // Do NOT set label.padding here: Core/Label's own constructor
                    // already sets a sane default (2, matching MapLibre's
                    // text-padding spec default — see Core/Label.js). This used to
                    // unconditionally overwrite that with 20, inflating every DOM
                    // label's overlap boundaries ~10x; the instanced path has its
                    // own correctly-resolved padding via instancedTextStyle above.

                    labels.push(label);
                });
            });
        });

        LabelProfiler.end('parse', _pConvert);
        // labelsCreated: summed per frame by the benchmark (a frame can run many
        //   convert() calls when cached tiles resolve together).
        // labelBatchMax: largest batch from ONE convert() over the run — i.e. the
        //   biggest single tile. Distinguishes "one huge tile" (overzoom) from
        //   "many tiles in one frame" (churn).
        LabelProfiler.count('labelsCreated', labels.length);
        LabelProfiler.max('labelBatchMax', labels.length);
        return labels;
    }

    preUpdate(context, sources) {
        if (sources.has(this.parent)) {
            this.object3d.clear();
            this.#filterGrid.width = this.parent.maxScreenSizeNode * 0.5;
            this.#filterGrid.height = this.parent.maxScreenSizeNode * 0.5;
            this.#filterGrid.resize();
        }
    }

    #submitToRendering(labelsNode) {
        this.object3d.add(labelsNode);
    }

    #disallowToRendering(labelsNode) {
        this.toHide.add(labelsNode);
    }

    #findClosestDomElement(node) {
        if (node.parent?.isTileMesh) {
            return node.parent.link[this.id]?.domElements || this.#findClosestDomElement(node.parent);
        } else {
            return this.domElement;
        }
    }

    #hasLabelChildren(object) {
        return object.children.every(c => c.layerUpdateState && c.layerUpdateState[this.id]?.hasFinished());
    }

    // Thin overlapping labels with a per-tile screen grid, so dense tiles don't
    // flood the renderer. Works for both modes: DOM labels live in node.children,
    // instanced labels in node.instancedLabels (and get synthesized bounds since
    // they have no DOM box). Kept labels still go through the regular per-frame
    // culling afterwards (Label2DRenderer for DOM, the collision engine for instanced).
    #removeCulledLabels(node) {
        const _pThin = LabelProfiler.begin();
        const labels = node.isInstanced
            ? [...node.instancedLabels.keys()]
            : node.children.slice();

        // reset filter
        this.#filterGrid.reset();

        // sort labels by order
        labels.sort((a, b) => b.order - a.order);

        labels.forEach((label) => {
            if (node.isInstanced) {
                ensureInstancedLabelOffset(label);
            }

            // get node dimensions
            node.nodeParent.extent.planarDimensions(nodeDimensions);
            coord.crs = node.nodeParent.extent.crs;

            // get west/north node coordinates
            coord.setFromValues(node.nodeParent.extent.west, node.nodeParent.extent.north, 0).toVector3(westNorthNode);

            // get label position
            coord.copy(label.coordinates).as(node.nodeParent.extent.crs, coord).toVector3(labelPosition);

            // transform label position to local node system
            labelPosition.sub(westNorthNode);
            labelPosition.y += nodeDimensions.y;
            labelPosition.divide(nodeDimensions).multiplyScalar(this.#filterGrid.width);

            // update the projected position to transform to local filter grid sytem
            label.updateProjectedPosition(labelPosition.x, labelPosition.y);

            // use screen grid to remove all culled labels
            if (!this.#filterGrid.insert(label)) {
                node.removeLabel(label);
            }
        });
        LabelProfiler.end('thin', _pThin);
    }

    update(context, layer, node, parent) {
        if (!parent && node.link[layer.id]) {
            // if node has been removed dispose three.js resource
            ObjectRemovalHelper.removeChildrenAndCleanupRecursively(this, node);
            return;
        }

        const labelsNode = node.link[layer.id] || new LabelsNode(node, context.view, this.isInstanced, this.useAsync);
        node.link[layer.id] = labelsNode;

        if (this.frozen || !node.visible || !this.visible) {
            return;
        }

        if (!node.material.visible && this.#hasLabelChildren(node)) {
            return this.#disallowToRendering(labelsNode);
        }

        const extentsDestination = node.getExtentsByProjection(this.source.crs) || [node.extent];
        const zoomDest = extentsDestination[0].zoom;

        if (zoomDest < layer.zoom.min || zoomDest > layer.zoom.max) {
            return this.#disallowToRendering(labelsNode);
        }

        if (node.layerUpdateState[this.id] === undefined) {
            node.layerUpdateState[this.id] = new LayerUpdateState();
        }

        if (!extentsDestination.some(e => this.source.hasData(e))) {
            node.layerUpdateState[this.id].noMoreUpdatePossible();
            return;
        } else if (this.#hasLabelChildren(node.parent)) {
            if (!node.material.visible) {
                labelsNode.needsUpdate = true;
            }
            this.#submitToRendering(labelsNode);
            return;
        } else if (!node.layerUpdateState[this.id].canTryUpdate()) {
            return;
        }

        // If this tile's labels were parked on a previous unload, restore them
        // (hot = visibility flip; cold = one re-upload) instead of a full rebuild.
        if (this.cacheUnloadedLabels && labelsNode.isInstanced) {
            const cache = this.#ensureLabelCache(labelsNode.instancedLabelManager);
            const key = cache ? this.#tileKey(node) : null;
            const parked = key ? cache.restore(key) : null;
            if (parked) {
                this.#restoreParkedLabels(node, labelsNode, parked);
                node.layerUpdateState[this.id].noMoreUpdatePossible();
                this.#submitToRendering(labelsNode);
                context.view.notifyChange(node);
                return;
            }
        }

        node.layerUpdateState[this.id].newTry();

        const command = {
            layer: this,
            extentsSource: extentsDestination,
            view: context.view,
            requester: node,
        };

        return context.scheduler.execute(command).then((result) => {
            if (!result) { return; }

            const renderer = context.view.mainLoop.gfxEngine.label2dRenderer;

            labelsNode.initializeDom();
            if (!labelsNode.isInstanced) {
                this.#findClosestDomElement(node).add(labelsNode.domElements);
            }

            // Adding labels is heavy main-thread work (DOM initDimensions reflow;
            // instanced register). Defer it to a budgeted slice so a burst of
            // resolved tiles spreads across frames instead of stalling one, then
            // request a redraw so the deferred labels appear.
            return enqueueBudgeted(() => {
                // NOTE: the forced label count is applied earlier, per tile, in
                // convert() (first-N features), so `result` already holds ≤ N
                // labels for this tile. Nothing to cap here.
                result.forEach((labels) => {
                    // Clean if there isnt' parent
                    if (!node.parent) {
                        labels.forEach((l) => {
                            ObjectRemovalHelper.removeChildrenAndCleanupRecursively(this, l);
                            if (labelsNode.isInstanced) {
                                labelsNode.removeLabel(l);
                            } else {
                                renderer.removeLabelDOM(l);
                            }
                        });
                        return;
                    }

                    labelsNode.needsAltitude = labelsNode.needsAltitude || labels.needsAltitude;

                    // Add all labels for this tile at once to batch it
                    labels.forEach((label) => {
                        if (node.extent.isPointInside(label.coordinates)) {
                            labelsNode.addLabel(label);
                        }
                    });
                });

                if (labelsNode.count()) {
                    if (!labelsNode.isInstanced) {
                        labelsNode.domElements.labels.hide();
                        labelsNode.domElements.labels.dom.style.opacity = '1.0';
                        node.addEventListener('show', () => labelsNode.domElements.labels.show());
                        node.addEventListener('hidden', () => this.#disallowToRendering(labelsNode));
                    } else {
                        this.#attachInstancedShowHide(node, labelsNode);
                    }

                    // Necessary event listener, to remove any Label attached to
                    node.addEventListener('removed', () => this.removeNodeDomElement(node));

                    if (labelsNode.needsAltitude && node.material.getElevationTile()) {
                        node.material.getElevationTile().addEventListener('rasterElevationLevelChanged', () => {
                            labelsNode.needsUpdate = true;
                            if (labelsNode.isInstanced) {
                                labelsNode.labels.forEach(l => labelsNode.updatePosition(l));
                                labelsNode.needsUpdate = false;
                            }
                        });
                    }

                    // With a forced label count, the scene-wide budget is enforced
                    // by admission above (labels past N are never added), so there's
                    // nothing to cull here. Otherwise fall back to screen-grid
                    // overlap thinning in perf mode.
                    if (this.forceLabelCount <= 0 && this.performance) {
                        this.#removeCulledLabels(labelsNode);
                    }
                }

                node.layerUpdateState[this.id].noMoreUpdatePossible();
                // Deferred adds ran off the command-resolution turn → request a
                // redraw so the newly-added labels are rendered.
                context.view.notifyChange(node);
            });
        });
    }

    // ── Warm label cache helpers ─────────────────────────────────────────────

    // Lazily build the tiered cache once the label manager (and thus its config,
    // which owns the hot/cold sizes) is available from the view. The enable state
    // is read LIVE from the manager config every call, so setting both sizes to 0
    // at runtime (e.g. the param-tuning sweep) genuinely disables the cache —
    // and clears any warm entries so parked labels aren't left stuck hidden.
    // Returns the cache, or null when disabled / the manager isn't ready.
    #ensureLabelCache(manager) {
        if (!manager) { return this.#labelCache; }
        const enabled = this.cacheUnloadedLabels
            && (manager.config.hotLabelCacheSize > 0 || manager.config.coldLabelCacheSize > 0);
        if (!enabled) {
            if (this.#labelCache) { this.#labelCache.clear(); this.#labelCache = null; }
            return null;
        }
        if (!this.#labelCache) {
            this.#labelManager = manager;
            const store = {
                addLabels: labels => this.#labelManager.addLabels(labels),
                removeLabels: labels => this.#labelManager.removeLabels(labels),
            };
            this.#labelCache = new TieredLabelCache(
                store,
                map => [...map.values()],   // cached value is a Map<Label, InstancedLabel>
                manager.config.hotLabelCacheSize,
                manager.config.coldLabelCacheSize,
            );
        }
        return this.#labelCache;
    }


    // Stable key for a tile across unload/reload: the source-projection extent
    // bounds are deterministic per tile, so the same geographic tile always maps
    // to the same key. Returns null when no usable extent (→ caching skipped).
    #tileKey(node) {
        const extents = node.getExtentsByProjection?.(this.source.crs)
            || (node.extent ? [node.extent] : null);
        if (!extents || !extents.length) { return null; }
        let key = '';
        for (const e of extents) {
            if (e.zoom === undefined) { return null; }
            key += `${e.zoom}|${e.west}|${e.south}|${e.east}|${e.north};`;
        }
        return key;
    }

    // show/hidden listeners for an instanced node (shared by fresh build + restore).
    #attachInstancedShowHide(node, labelsNode) {
        node.addEventListener('show', () => {
            labelsNode.instancedLabels.forEach((instancedLabel, label) => {
                instancedLabel.visible = label.visible;
                instancedLabel.groupVisible = true;
            });
        });
        node.addEventListener('hidden', () => {
            labelsNode.instancedLabels.forEach((instancedLabel) => {
                instancedLabel.visible = false;
                instancedLabel.groupVisible = false;
            });
        });
    }

    // Reattach a parked label set to a freshly-created node. The InstancedLabels
    // are still registered in the manager (GPU slots retained), so this is just a
    // groupVisible flip — no rebuild, no re-upload.
    #restoreParkedLabels(node, labelsNode, parked) {
        labelsNode.instancedLabels = parked;
        const nodeVisible = node.visible !== false;
        parked.forEach((instancedLabel, label) => {
            instancedLabel.visible = nodeVisible && label.visible;
            instancedLabel.groupVisible = nodeVisible;
        });
        this.#attachInstancedShowHide(node, labelsNode);
        node.addEventListener('removed', () => this.removeNodeDomElement(node));
    }

    #destroyInstancedLabels(labelsNode, manager) {
        labelsNode.instancedLabels.forEach((instancedLabel) => {
            if (manager) { manager.removeLabel(instancedLabel); }
        });
        labelsNode.instancedLabels.clear();
    }

    removeLabelsFromNodeRecursive(node) {
        node.children.forEach((c) => {
            if (c.link[this.id]) {
                delete c.link[this.id];
            }
            this.removeLabelsFromNodeRecursive(c);
        });

        this.removeNodeDomElement(node);
    }

    removeNodeDomElement(node) {
        const labelsNode = node.link[this.id];
        if (labelsNode?.isInstanced) {
            const manager = labelsNode.instancedLabelManager;
            const cache = labelsNode.instancedLabels.size > 0
                ? this.#ensureLabelCache(manager)
                : null;
            const key = cache ? this.#tileKey(node) : null;
            if (key && !cache.has(key)) {
                // Park into the cache: the hot tier hides + keeps them resident;
                // overflow demotes to cold (frees GPU slots). Revisit restores it
                // — see update(). The cache handles hiding (groupVisible).
                cache.park(key, labelsNode.instancedLabels);
                labelsNode.instancedLabels = new Map();
            } else {
                this.#destroyInstancedLabels(labelsNode, manager);
            }
        }

        if (node.link[this.id]?.domElements) {
            const child = node.link[this.id].domElements.dom;
            child.parentElement.removeChild(child);
            delete node.link[this.id].domElements;
        }
    }

    /**
     * All layer's objects and domElements are removed.
     * @param {boolean} [clearCache=false] Whether to clear the layer cache or not
     */
    delete(clearCache) {
        if (clearCache) {
            this.cache.clear();
        }
        // Stop parking and release all warm-cached slots on teardown (disable
        // first so the recursive removal below destroys, not re-parks).
        this.cacheUnloadedLabels = false;
        const labelCache = this.#labelCache;
        this.#labelCache = null;
        labelCache?.clear();
        this.domElement.dom.parentElement.removeChild(this.domElement.dom);

        this.parent.level0Nodes.forEach(obj => this.removeLabelsFromNodeRecursive(obj));
    }
}

export default LabelLayer;
