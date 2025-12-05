import { Text } from 'Types/Text';
import { createPointLabelMaterial } from 'Materials/PointLabelMaterial';

import { Coordinates } from '@itowns/geographic';
import Style from 'Core/Style';
import * as THREE from 'three';
import { BillboardMode, LabelMaterial } from 'Types/LabelTypes';

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
    static fontScale: number = 20;
    material: LabelMaterial;

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

        this.material = labelMaterial;
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
            size: number;
            color: number | string | THREE.Color;
            rotation: 'map' | 'viewport' | 'auto';
            placement: 'point' | 'line' | 'line-center';
        };
        this.setContent(textStyle.field);

        const u = this.material.uniforms;
        u.fontSize.value = textStyle.size * Label3D.fontScale;
        if (textStyle.rotation === 'viewport') {
            u.billboardMode.value = BillboardMode.Viewport;
        } else if (textStyle.rotation === 'map') {
            u.billboardMode.value = BillboardMode.Map;
        // Similar to 'auto' in MapLibre
        } else if (textStyle.rotation === 'auto') {
            if (textStyle.placement === 'point') {
                u.billboardMode.value = BillboardMode.Viewport;
            } else {
                u.billboardMode.value = BillboardMode.Map;
            }
        }
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
