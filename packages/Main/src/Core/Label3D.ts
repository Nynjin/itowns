import { Text } from 'Types/Text';
import { createLabelMaterial } from 'Utils/LabelUtils';

import { Coordinates } from '@itowns/geographic';
import Style from 'Core/Style';
import * as THREE from 'three';

// Define the material once for all Label3D instances
const lookAtCameraMaterial = createLabelMaterial(new THREE.MeshBasicMaterial(), {});
// Deactivate material depthTest so it is always rendered
// upfront (to avoid terrain collision for instance
lookAtCameraMaterial.depthTest = false;

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
    static fontScale: number = 20;

    constructor() {
        super();
        this.isLabel3D = true;
        // Set shared style properties
        // Set position to the middle so label positioning is
        // relative to its center which is commonly used for geospatial
        // labels. This can be changed by the user later on.
        this.anchorX = 'center';
        this.anchorY = 'middle';
        // by default, troika text faces the center of the scene,
        // need to make it face away in order to be visible on globe
        this.scale.z = -1;
        this.rotation.x = Math.PI;

        this.material = lookAtCameraMaterial;
    }

    setContent(content: string) {
        this.text = content;
    }

    /**
     * Applies iTowns Style to this Label.
     * Don't forget to call view.notifyChange to update the view.
     * @param style - iTowns Style
     */
    setStyle(style: Style): void {
        const textStyle = style.text as {
            field: string;
            fontSize: number;
            color: number | string | THREE.Color;
            rotation: 'map' | 'viewport' | 'auto';
            placement: 'point' | 'line' | 'line-center';
        };
        this.setContent(textStyle.field);

        // Rotation: TODO: see if it stays here or not
        // text-rotation-alignment -> style.text.rotation
        // symbol-placement -> style.text.placement
        if (textStyle.rotation === 'map') {
            if (textStyle.placement === 'point') {
                // text should align east - west
            } else if (textStyle.placement === 'line' || textStyle.placement === 'line-center') {
                // aligns text x-axes with the line.
            }
        } else if (textStyle.rotation === 'viewport') {
            // Produces glyphs whose x-axes are aligned
            // with the x-axis of the viewport,
            // regardless of the value of symbol-placement
        } else if (textStyle.rotation === 'auto') {
            // TODO: understand the spec :grin:
            // this.material = lookAtCameraMaterial;
        }

        // TODO: temp
        const material = this.material as typeof lookAtCameraMaterial;

        const px = textStyle.fontSize ?? 50;
        const u = material.uniforms;
        u.fontSize.value = px * Label3D.fontScale;
        this.color = textStyle.color;
    }

    /**
     * Places the label at the given position
     * @param position - position in view CRS
     */
    setPosition(position: Coordinates): void {
        this.position.set(position.x, position.y, position.z);
    }
}
