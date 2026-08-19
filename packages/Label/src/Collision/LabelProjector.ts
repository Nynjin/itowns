import { Matrix4, Quaternion, Vector3 } from 'three';
import { Label, RotationAlignment, TextAnchorX, TextAnchorY } from '../Label';
import { LabelManagerConfig } from '../Types/LabelConfig';

export interface ScreenAABB {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    /**
     * Area (in px) of the label's box BEFORE clamping to the viewport. Equals
     * the on-screen area when fully visible, larger when part of the label is
     * clipped by a screen edge. Lets callers compute the off-screen fraction
     * `(fullArea − onScreenArea) / fullArea` to cull mostly-clipped labels. Not
     * used by the collision placement decision — purely informational.
     */
    fullArea: number;
}

/**
 * Projects a Label's 4 corners through view/projection matrices into
 * **full-resolution screen pixels** — either an axis-aligned bounding box
 * ({@link project}) or the 4 raw corners of the rotated quad ({@link projectQuad}).
 * Each {@link Occupancy} applies its own downscale/cell size internally, so the
 * projector is resolution-agnostic.
 *
 * Used by the collision core to determine label occlusion.
 */
export class LabelProjector {
    private readonly _view   = new Matrix4();
    private readonly _proj   = new Matrix4();
    private _targetW = 1;
    private _targetH = 1;
    private _near  = 0.1;
    private _far   = 1e7;
    private readonly _config: LabelManagerConfig;

    private readonly _q = new Quaternion();
    private readonly _v3 = new Vector3();
    /** Scratch: projected screen-px corners (full-res), corner order matches project loop. */
    private readonly _cpx = new Float64Array(4);
    private readonly _cpy = new Float64Array(4);

    constructor(config: LabelManagerConfig) {
        this._config = config;
    }

    /**
     * @param view    camera world-inverse matrix
     * @param proj    camera projection matrix
     * @param targetW viewport width in **full-resolution screen pixels**
     * @param targetH viewport height in full-resolution screen pixels
     * @param near    camera near plane
     * @param far     camera far plane
     */
    setFrame(
        view: Matrix4,
        proj: Matrix4,
        targetW: number,
        targetH: number,
        near = 0.1,
        far  = 1e7,
    ): void {
        this._view.copy(view);
        this._proj.copy(proj);
        this._targetW = targetW;
        this._targetH = targetH;
        this._near  = near;
        this._far   = far;
    }

    checkVisible(label: Label): boolean {
        const bw = label.bounds.width;
        const bh = label.bounds.height;
        if (bw === 0 || bh === 0) { return false; }

        const ve = this._view.elements;
        const pe = this._proj.elements;
        const p = label.position;

        const cvx = ve[0] * p.x + ve[4] * p.y + ve[8]  * p.z + ve[12];
        const cvy = ve[1] * p.x + ve[5] * p.y + ve[9]  * p.z + ve[13];
        const cvz = ve[2] * p.x + ve[6] * p.y + ve[10] * p.z + ve[14];
        if (cvz >= 0) { return false; }
        if (cvz < -this._far * 0.1) { return false; }

        const ccx = pe[0] * cvx + pe[4] * cvy + pe[8]  * cvz + pe[12];
        const ccy = pe[1] * cvx + pe[5] * cvy + pe[9]  * cvz + pe[13];
        const ccw = pe[3] * cvx + pe[7] * cvy + pe[11] * cvz + pe[15];
        if (ccw <= 0) { return false; }

        const ndcCx = ccx / ccw;
        const ndcCy = ccy / ccw;

        // Convert font-pixel bounds to world units for NDC margin estimation
        const worldScale = (label.fontSize / this._config.baseFontSize) / this._config.pxPerUnit;
        const maxBound = Math.max(bw, bh) * worldScale;
        const marginNDC = (maxBound * pe[0]) / ccw + this._config.ndcCullMargin;

        if (Math.abs(ndcCx) > 1 + marginNDC || Math.abs(ndcCy) > 1 + marginNDC) { return false; }

        return true;
    }

    /**
     * Project the label's 4 corners to full-resolution screen pixels into the
     * projector's scratch corner buffers.
     * @returns false if any corner is behind the camera.
     */
    private _projectCorners(label: Label): boolean {
        const ve = this._view.elements;
        const pe = this._proj.elements;
        const p = label.position;

        const cvx = ve[0] * p.x + ve[4] * p.y + ve[8]  * p.z + ve[12];
        const cvy = ve[1] * p.x + ve[5] * p.y + ve[9]  * p.z + ve[13];
        const cvz = ve[2] * p.x + ve[6] * p.y + ve[10] * p.z + ve[14];

        const local = this._localCornersOf(label);

        const viewDepth = Math.sqrt(cvx * cvx + cvy * cvy + cvz * cvz);
        const isViewport = label.rotationAlignment === RotationAlignment.Viewport;
        const q = isViewport
            ? null
            : this._q.set(label.rotation.x, label.rotation.y, label.rotation.z, label.rotation.w);

        const W = this._targetW;
        const H = this._targetH;

        for (let i = 0; i < 4; i++) {
            const localX = local[i * 2]     * viewDepth;
            const localY = local[i * 2 + 1] * viewDepth;

            let vx = cvx, vy = cvy, vz = cvz;
            if (isViewport) {
                vx = cvx + localX;
                vy = cvy + localY;
                vz = cvz;
            } else if (q) {
                this._v3.set(localX, localY, 0).applyQuaternion(q);
                const wx = p.x + this._v3.x;
                const wy = p.y + this._v3.y;
                const wz = p.z + this._v3.z;
                vx = ve[0] * wx + ve[4] * wy + ve[8]  * wz + ve[12];
                vy = ve[1] * wx + ve[5] * wy + ve[9]  * wz + ve[13];
                vz = ve[2] * wx + ve[6] * wy + ve[10] * wz + ve[14];
            }

            const cx = pe[0] * vx + pe[4] * vy + pe[8]  * vz + pe[12];
            const cy = pe[1] * vx + pe[5] * vy + pe[9]  * vz + pe[13];
            const cw = pe[3] * vx + pe[7] * vy + pe[11] * vz + pe[15];
            if (cw <= 0) { return false; }

            const ndcX = cx / cw;
            const ndcY = cy / cw;
            this._cpx[i] = (ndcX *  0.5 + 0.5) * W;
            this._cpy[i] = (ndcY * -0.5 + 0.5) * H;
        }
        return true;
    }

    /**
     * Project a label to a screen-space axis-aligned bounding box (full-res px),
     * clamped to the viewport, written into `out`.
     * @returns false if any corner is behind the camera or the box is off-screen.
     */
    project(label: Label, out: ScreenAABB): boolean {
        const bw = label.bounds.width;
        const bh = label.bounds.height;
        if (bw === 0 || bh === 0) { return false; }
        if (!this._projectCorners(label)) { return false; }

        const cpx = this._cpx, cpy = this._cpy;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < 4; i++) {
            const px = cpx[i], py = cpy[i];
            if (px < minX) { minX = px; }
            if (px > maxX) { maxX = px; }
            if (py < minY) { minY = py; }
            if (py > maxY) { maxY = py; }
        }

        const W = this._targetW, H = this._targetH;
        const ux0 = Math.floor(minX), ux1 = Math.ceil(maxX);
        const uy0 = Math.floor(minY), uy1 = Math.ceil(maxY);
        const x0 = Math.max(0, ux0);
        const x1 = Math.min(W - 1, ux1);
        const y0 = Math.max(0, uy0);
        const y1 = Math.min(H - 1, uy1);
        if (x0 > x1 || y0 > y1) { return false; }

        out.x0 = x0;
        out.y0 = y0;
        out.x1 = x1;
        out.y1 = y1;
        out.fullArea = (ux1 - ux0 + 1) * (uy1 - uy0 + 1);
        return true;
    }

    /**
     * Project a label's exact rotated quad to full-resolution screen pixels,
     * writing the 4 corners into `outQx`/`outQy` (length ≥ 4). Corners are NOT
     * clamped — the occupancy clamps per scanline. See {@link Occupancy}.
     * @returns false if any corner is behind the camera or the quad is fully off-screen.
     */
    projectQuad(label: Label, outQx: Float32Array, outQy: Float32Array): boolean {
        const bw = label.bounds.width;
        const bh = label.bounds.height;
        if (bw === 0 || bh === 0) { return false; }
        if (!this._projectCorners(label)) { return false; }

        const cpx = this._cpx, cpy = this._cpy;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < 4; i++) {
            const px = cpx[i], py = cpy[i];
            outQx[i] = px; outQy[i] = py;
            if (px < minX) { minX = px; }
            if (px > maxX) { maxX = px; }
            if (py < minY) { minY = py; }
            if (py > maxY) { maxY = py; }
        }
        // reject only when the whole quad is off-screen (occupancy clamps the rest)
        if (maxX < 0 || maxY < 0 || minX > this._targetW || minY > this._targetH) { return false; }
        return true;
    }

    /**
     * Camera-independent local-space box corners (world units, before viewDepth
     * scaling), cached on the label and invalidated on Font/Layout/Text changes.
     * Keyed by pxPerUnit so a runtime pxPerUnit change recomputes them.
     */
    private _localCornersOf(label: Label): Float32Array {
        const px = this._config.pxPerUnit;
        const cached = label._localCorners;
        if (cached && label._localCornersKey === px) { return cached; }

        const worldScale = (label.fontSize / this._config.baseFontSize) / px;
        const scaledBw = label.bounds.width  * worldScale;
        const scaledBh = label.bounds.height * worldScale;
        // label.offset is in em units (× fontSize); convert to world units
        const offsetX = label.offset.x * label.fontSize * worldScale;
        const offsetY = label.offset.y * label.fontSize * worldScale;
        const ax = anchorOffsetX(label, scaledBw) + offsetX;
        const ay = anchorOffsetY(label, scaledBh) - offsetY;

        const c = cached ?? new Float32Array(8);
        for (let i = 0; i < 4; i++) {
            const ux = i === 1 || i === 2 ? 1 : 0;
            const uy = i === 2 || i === 3 ? 1 : 0;
            c[i * 2]     = ux * scaledBw + ax;
            c[i * 2 + 1] = uy * scaledBh + ay;
        }
        label._localCorners = c;
        label._localCornersKey = px;
        return c;
    }
}

function anchorOffsetX(label: Label, bw: number): number {
    switch (label.anchorX) {
        case TextAnchorX.Left:  return 0;
        case TextAnchorX.Right: return -bw;
        default:                return -bw * 0.5;
    }
}

function anchorOffsetY(label: Label, bh: number): number {
    switch (label.anchorY) {
        case TextAnchorY.Top:    return -bh;
        case TextAnchorY.Bottom: return 0;
        default:                 return -bh * 0.5;
    }
}
