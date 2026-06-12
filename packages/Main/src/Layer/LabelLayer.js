import * as THREE from 'three';
import LayerUpdateState from 'Layer/LayerUpdateState';
import ObjectRemovalHelper from 'Process/ObjectRemovalHelper';
import GeometryLayer from 'Layer/GeometryLayer';
import { Coordinates, Extent } from '@itowns/geographic';
import Label from 'Core/Label';
import Style, { readExpression, StyleContext } from 'Core/Style';
import { ScreenGrid } from 'Renderer/Label2DRenderer';
import { Label as InstancedLabel, TextAnchorX, TextAnchorY, RotationAlignment, SymbolPlacement } from '@itowns/labels';

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
        padding: resolveTextProperty(context, geometryText.padding, featureText.padding, layerText.padding) || 20,
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
                    padding: label.padding || 20,
                    visible: label.visible,
                    rotationAlignment: textStyle.rotationAlignment || RotationAlignment.Map,
                    symbolPlacement: textStyle.symbolPlacement || SymbolPlacement.Point,
                });

                this.instancedLabels.set(label, instancedLabel);
                this.instancedLabelManager.addLabel(instancedLabel);
            }
            return;
        }

        // add 3d object
        this.add(label);

        // add dom label
        this.domElements.labels.dom.append(label.content);

        // Batch update the dimensions of labels all at once to avoid
        // redraw for at least this tile.
        label.initDimensions();

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
        if (this.isInstanced) {
            const instancedLabel = this.instancedLabels.get(label);
            if (instancedLabel && this.instancedLabelManager) {
                this.instancedLabelManager.removeLabel(instancedLabel);
                this.instancedLabels.delete(label);
            }
            return;
        }

        // remove 3d object
        this.remove(label);

        // remove dom label
        this.domElements.labels.dom.removeChild(label.content);
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

    constructor(id, config = {}) {
        const {
            domElement,
            performance = true,
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
                    label.padding = 20;

                    labels.push(label);
                });
            });
        });

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

    // Remove all labels invisible with pre-culling with screen grid.
    // Only called for DOM mode — instanced labels are culled by the collision engine.
    #removeCulledLabels(node) {
        const labels = node.children.slice();

        // reset filter
        this.#filterGrid.reset();

        // sort labels by order
        labels.sort((a, b) => b.order - a.order);

        labels.forEach((label) => {
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

                // Pre-cull only makes sense for DOM mode: instanced collision runs
                // in a worker and handles the full label pool itself.
                if (this.performance && !labelsNode.isInstanced) {
                    this.#removeCulledLabels(labelsNode);
                }
            }

            node.layerUpdateState[this.id].noMoreUpdatePossible();
        });
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
        if (node.link[this.id]?.isInstanced) {
            node.link[this.id].instancedLabels.forEach((instancedLabel) => {
                if (node.link[this.id].instancedLabelManager) {
                    node.link[this.id].instancedLabelManager.removeLabel(instancedLabel);
                }
            });
            node.link[this.id].instancedLabels.clear();
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
        this.domElement.dom.parentElement.removeChild(this.domElement.dom);

        this.parent.level0Nodes.forEach(obj => this.removeLabelsFromNodeRecursive(obj));
    }
}

export default LabelLayer;
