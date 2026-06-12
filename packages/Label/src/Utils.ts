import { Camera, OrthographicCamera, PerspectiveCamera, Vector2, WebGLRenderer } from 'three';

/**
 * Compute the pxPerUnit value for CSS-accurate label sizing.
 *
 * For a viewport-aligned label the vertex shader produces:
 *   screen_px = (fontSize / baseFontSize) / pxPerUnit * screenHeight / (2*tan(fovY/2))
 *
 * Setting pxPerUnit to this return value makes that ratio 1, so a label with
 * fontSize === baseFontSize renders exactly baseFontSize CSS pixels tall.
 *
 * Pass the result to manager.updatePxPerUnit() or as config.pxPerUnit.
 * Re-call on viewport resize or FOV/zoom change.
 *
 * @param camera - the active scene camera (Perspective or Orthographic)
 * @param renderer - the WebGL renderer
 * @returns pxPerUnit for CSS-accurate label sizing
 */
export function computePxPerUnit(camera: Camera, renderer: WebGLRenderer): number {
    const size = renderer.getSize(new Vector2());

    if (camera instanceof PerspectiveCamera) {
        // screenHeight = pxPerUnit * 2 * tan(fovY/2)  =>  solve for pxPerUnit
        return size.y / (2 * Math.tan((camera.fov * Math.PI / 180) / 2));
    }

    if (camera instanceof OrthographicCamera) {
        // world height visible = (top - bottom) / zoom; maps to size.y px
        const worldH = (camera.top - camera.bottom) / camera.zoom;
        return worldH > 0 ? size.y / worldH : size.y;
    }

    // Unknown camera type — fall back to screen height (reasonable default)
    return size.y * 2;
}
