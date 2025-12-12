import { Text } from 'Types/Text';
import { createPointLabelMaterial } from 'Materials/PointLabelMaterial';

import { Coordinates } from '@itowns/geographic';
import Style from 'Core/Style';
import * as THREE from 'three';
import { BillboardMode, type LabelMaterial, type TextStyleType } from 'Types/LabelTypes';

// Define the material once for all Label3D instances
const labelMaterial = createPointLabelMaterial(new THREE.MeshBasicMaterial(), {});
// Deactivate material depthTest so it is always rendered
// upfront (to avoid terrain collision for instance
labelMaterial.depthTest = false;

/* TODO: gérer le sync:
   * faire un sync à chaque appel de méthode de la classe?
   * mettre un param sync dans les méthodes?
   * appeler sync manuellement tout le temps?
   * quid de l'interaction avec view.notifyChange()?
* */
/**
 * A 3D label based on troika-three.
 * Can be customized either by applying an itowns style
 * configuration or directly
 * by updating troika-three Text attributes directly.
 * Note that Text extends THREE.Mesh
 */
export class Label3D extends Text {
    readonly isLabel3D: boolean;

    // Scaling factors to convert from iTowns style units to troika units
    static fontScale: number = 0.04;
    static spacingScale: number = 1.0;
    static haloScale: number = 1.5;
    static widthScale: number = 0.5;
    static heightScale: number = 1.0;

    constructor() {
        super();
        this.isLabel3D = true;

        // by default, troika text faces the center of the scene,
        // need to make it face away in order to be visible on globe
        this.scale.z = -1;
        this.rotation.x = Math.PI;

        this.material = labelMaterial;
    }

    // setContent(content: string) {
    //     this.text = content;
    // }

    /**
     * Applies iTowns Style to this Label.
     * Don't forget to call view.notifyChange to update the view.
     * @param style - iTowns Style
     */
    setStyle(style: Style): void {
        const textStyle = style.text as TextStyleType;

        // color
        this.color = textStyle.color;

        // alignment and box
        this.textAlign = textStyle.justify;
        this.fontSize = textStyle.size;
        this.letterSpacing = textStyle.spacing * Label3D.spacingScale;
        this.maxWidth = textStyle.wrap * Label3D.widthScale;
        this.lineHeight = textStyle.lineHeight * Label3D.heightScale;

        // opacity
        this.fillOpacity = textStyle.opacity;
        this.strokeOpacity = textStyle.opacity;
        this.outlineOpacity = textStyle.opacity;

        // halo
        this.outlineColor = textStyle.haloColor ?? new THREE.Color(0x000000);
        this.outlineWidth = (textStyle.haloWidth ?? 0) * Label3D.haloScale;
        this.outlineBlur = (textStyle.haloBlur ?? 0) * Label3D.haloScale;

        // text content with transform
        if (textStyle.transform === 'uppercase') {
            this.text = textStyle.field.toUpperCase();
        } else if (textStyle.transform === 'lowercase') {
            this.text = textStyle.field.toLowerCase();
        } else {
            this.text = textStyle.field;
        }

        // convert anchor to troika format
        // since text is mirrored (negative z-scale),
        // left becomes right and vice versa
        if (textStyle.anchor.includes('left')) {
            this.anchorX = 'right';
        } else if (textStyle.anchor.includes('right')) {
            this.anchorX = 'left';
        } else {
            this.anchorX = 'center';
        }
        if (textStyle.anchor.includes('top')) {
            this.anchorY = 'bottom';
        } else if (textStyle.anchor.includes('bottom')) {
            this.anchorY = 'top';
        } else {
            this.anchorY = 'middle';
        }

        // material configuration
        let u: LabelMaterial['uniforms'];

        // outline creates a second material, unsure if other properties do too
        if (this.material instanceof Array === true && this.material.length === 2) {
            u = ((this.material as THREE.Material[])[1] as LabelMaterial).uniforms;
        } else {
            u = (this.material as unknown as LabelMaterial).uniforms;
        }

        // font size
        u.uFontSize.value = this.fontSize * Label3D.fontScale;

        // rotation-alignment
        if (textStyle.rotation === 'viewport') {
            u.uBillboardMode.value = BillboardMode.Viewport;
        } else if (textStyle.rotation === 'map') {
            u.uBillboardMode.value = BillboardMode.Map;
        // Similar to 'auto' in MapLibre
        } else if (textStyle.rotation === 'auto') {
            if (textStyle.placement === 'point') {
                u.uBillboardMode.value = BillboardMode.Viewport;
            } else {
                u.uBillboardMode.value = BillboardMode.Map;
            }
        }
    }

    /**
     * Places the label at the given position
     * @param position - position in view CRS
     */
    setPosition(position: Coordinates): void {
        this.position.set(position.x, position.y, position.z);
    }
}
