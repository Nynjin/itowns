import { Color, Euler, Quaternion, Vector2, Vector3 } from 'three';
import { GlyphInstance } from './Shaping/GlyphRun';

export enum TextAnchorX {
    Left   = 0,
    Center = 1,
    Right  = 2,
}

export enum TextAnchorY {
    Top      = 0,
    Middle   = 1,
    Bottom   = 2,
    Baseline = 3,
}

export enum TextAlign {
    Auto    = 0,
    Left    = 1,
    Center  = 2,
    Right   = 3,
    Justify = 4,
}

export enum TextTransform {
    None       = 0,
    Uppercase  = 1,
    Lowercase  = 2,
    Capitalize = 3,
}

export enum RotationAlignment {
    Map      = 0,
    Viewport = 1,
}

export enum SymbolPlacement {
    Point         = 0,
    Line          = 1,
    'Line-Center' = 2,
}

export const LabelChangeType = {
    None:       0,
    Font:       1 << 0,
    Text:       1 << 1,
    Layout:     1 << 2,
    Style:      1 << 3,
    Transform:  1 << 4,
    Visibility: 1 << 5,
    Dispose:    1 << 6,
} as const;

/** Accumulated bitmask of LabelChangeType flags passed to onChange listeners. */
export type LabelChangeMask = number;

export interface TextPadding {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export interface LabelBounds {
    width: number;
    height: number;
}

export type LabelChangeListener = (changes: LabelChangeMask) => void;

export interface LabelOptions {
    text: string;

    position?: [number, number, number] | Vector3;
    rotation?: [number, number, number] | Euler | Quaternion;
    offset?:   [number, number] | Vector2;

    font?:          string;
    fontSize?:      number;
    fontWeight?:    string;
    fontStyle?:     string;
    letterSpacing?: number;
    lineHeight?:    number;

    maxWidth?:  number;
    textAlign?: TextAlign;
    anchorX?:   TextAnchorX;
    anchorY?:   TextAnchorY;
    padding?:   TextPadding | number | [number, number, number, number];

    color?:   string | number | Color | Vector3;
    opacity?: number;

    haloColor?:   string | number | Color | Vector3;
    haloWidth?:   number;
    haloBlur?:    number;
    haloOpacity?: number;

    rotationAlignment?: RotationAlignment;
    symbolPlacement?:   SymbolPlacement;

    textTransform?: TextTransform;
    visible?:       boolean;

    /** Passed by clone() to restore layout results without re-running layoutText. */
    bounds?: LabelBounds;
    /** Passed by clone() to restore layout results without re-running layoutText. */
    glyphs?: GlyphInstance[];
}

export class Label {
    // Reactive private backing fields
    private readonly _id: string;
    private _text             = '';
    private _textTransform: TextTransform  = TextTransform.None;
    private _position: Vector3             = new Vector3();
    private _rotation: Quaternion          = new Quaternion();
    private _offset: Vector2               = new Vector2();
    private _font                          = 'Arial';
    private _fontSize                      = 20;
    private _fontWeight                    = 'normal';
    private _fontStyle                     = 'normal';
    private _letterSpacing                 = 0;
    private _lineHeight                    = 1.2;
    private _maxWidth                      = Infinity;
    private _textAlign: TextAlign          = TextAlign.Auto;
    private _anchorX: TextAnchorX          = TextAnchorX.Left;
    private _anchorY: TextAnchorY          = TextAnchorY.Top;
    private _padding: TextPadding          = { top: 20, right: 20, bottom: 20, left: 20 };
    private _color: Color                  = new Color();
    private _opacity                       = 1;
    private _haloColor: Color              = new Color();
    private _haloWidth                     = 0;
    private _haloBlur                      = 0;
    private _haloOpacity                   = 1;
    private _rotationAlignment: RotationAlignment = RotationAlignment.Map;
    private _symbolPlacement: SymbolPlacement     = SymbolPlacement.Point;
    private _visible                       = true;
    private _listeners                     = new Set<LabelChangeListener>();

    // Non-reactive fields — written directly by layout / rendering subsystems.
    // Assigning these does NOT fire onChange listeners.
    occlusionFade  = 1;
    isCandidate    = false;
    shouldRender   = false;
    isRendered     = false;
    bounds: LabelBounds     = { width: 0, height: 0 };
    glyphs: GlyphInstance[] = [];
    /** Scratch value written each frame by the collision engine for bucket sorting. */
    score = 0;
    /**
     * Set to false by an external group manager (e.g. LabelsNode) when the
     * tile owning this label is not currently active. The collision engine
     * skips the label entirely — no projection math — when this is false.
     */
    groupVisible = true;

    constructor(options: LabelOptions) {
        this._id = crypto.randomUUID();
        this.set(options, true);
    }

    // Identity

    get id(): string { return this._id; }

    // Content

    get text(): string { return this._text; }
    set text(value: string) { this._text = value; this._emit(LabelChangeType.Text); }

    get textTransform(): TextTransform { return this._textTransform; }
    set textTransform(value: TextTransform) { this._textTransform = value; this._emit(LabelChangeType.Text); }

    getDisplayText(): string {
        switch (this._textTransform) {
            case TextTransform.Uppercase:  return this._text.toUpperCase();
            case TextTransform.Lowercase:  return this._text.toLowerCase();
            case TextTransform.Capitalize: return this._text.replace(/\b\w/g, c => c.toUpperCase());
            default:                       return this._text;
        }
    }

    // Transform

    get position(): Vector3 { return this._position; }
    set position(value: Vector3 | [number, number, number]) {
        this._position = toVector3(value);
        this._emit(LabelChangeType.Transform);
    }

    get rotation(): Quaternion { return this._rotation; }
    set rotation(value: [number, number, number] | Euler | Quaternion) {
        this._rotation = toQuaternion(value);
        this._emit(LabelChangeType.Transform);
    }

    get offset(): Vector2 { return this._offset; }
    set offset(value: Vector2 | [number, number]) {
        this._offset = toVector2(value);
        this._emit(LabelChangeType.Layout);
    }

    // Font

    get font(): string { return this._font; }
    set font(value: string) { this._font = value; this._emit(LabelChangeType.Font); }

    get fontSize(): number { return this._fontSize; }
    set fontSize(value: number) { this._fontSize = value; this._emit(LabelChangeType.Font); }

    get fontWeight(): string { return this._fontWeight; }
    set fontWeight(value: string) { this._fontWeight = value; this._emit(LabelChangeType.Font); }

    get fontStyle(): string { return this._fontStyle; }
    set fontStyle(value: string) { this._fontStyle = value; this._emit(LabelChangeType.Font); }

    // Layout

    get letterSpacing(): number { return this._letterSpacing; }
    set letterSpacing(value: number) { this._letterSpacing = value; this._emit(LabelChangeType.Layout); }

    get lineHeight(): number { return this._lineHeight; }
    set lineHeight(value: number) { this._lineHeight = value; this._emit(LabelChangeType.Layout); }

    get maxWidth(): number { return this._maxWidth; }
    set maxWidth(value: number) { this._maxWidth = value; this._emit(LabelChangeType.Layout); }

    get textAlign(): TextAlign { return this._textAlign; }
    set textAlign(value: TextAlign) { this._textAlign = value; this._emit(LabelChangeType.Layout); }

    get anchorX(): TextAnchorX { return this._anchorX; }
    set anchorX(value: TextAnchorX) { this._anchorX = value; this._emit(LabelChangeType.Layout); }

    get anchorY(): TextAnchorY { return this._anchorY; }
    set anchorY(value: TextAnchorY) { this._anchorY = value; this._emit(LabelChangeType.Layout); }

    get padding(): TextPadding { return this._padding; }
    set padding(value: TextPadding | number | [number, number, number, number]) {
        this._padding = this._parsePadding(value);
        this._emit(LabelChangeType.Layout);
    }

    // Fill

    get color(): Color { return this._color; }
    set color(value: string | number | Color | Vector3) {
        this._color = toColor(value);
        this._emit(LabelChangeType.Style);
    }

    get opacity(): number { return this._opacity; }
    set opacity(value: number) { this._opacity = value; this._emit(LabelChangeType.Style); }

    // Halo

    get haloColor(): Color { return this._haloColor; }
    set haloColor(value: string | number | Color | Vector3) {
        this._haloColor = toColor(value);
        this._emit(LabelChangeType.Style);
    }

    get haloWidth(): number { return this._haloWidth; }
    set haloWidth(value: number) {
        this._haloWidth = this._clampHaloWidth(value);
        this._emit(LabelChangeType.Style);
    }

    get haloBlur(): number { return this._haloBlur; }
    set haloBlur(value: number) {
        this._haloBlur = this._clampHaloBlur(value);
        this._emit(LabelChangeType.Style);
    }

    get haloOpacity(): number { return this._haloOpacity; }
    set haloOpacity(value: number) { this._haloOpacity = value; this._emit(LabelChangeType.Style); }

    hasHalo(): boolean { return this._haloWidth > 0 && this._haloOpacity > 0; }
    getDisplayedHaloOpacity(): number { return this.hasHalo() ? this._haloOpacity * this._opacity : 0; }

    // Rendering

    get rotationAlignment(): RotationAlignment { return this._rotationAlignment; }
    set rotationAlignment(value: RotationAlignment) { this._rotationAlignment = value; this._emit(LabelChangeType.Style); }

    get symbolPlacement(): SymbolPlacement { return this._symbolPlacement; }
    set symbolPlacement(value: SymbolPlacement) { this._symbolPlacement = value; this._emit(LabelChangeType.Style); }

    get visible(): boolean { return this._visible && this._opacity > 0; }
    set visible(value: boolean) { this._visible = value; this._emit(LabelChangeType.Visibility); }

    // Lifecycle

    set(options: Partial<LabelOptions>, silent = false): this {
        let changes = LabelChangeType.None;

        if (options.position      !== undefined) { this._position      = toVector3(options.position);    changes |= LabelChangeType.Transform; }
        if (options.rotation      !== undefined) { this._rotation      = toQuaternion(options.rotation); changes |= LabelChangeType.Transform; }
        if (options.offset        !== undefined) { this._offset        = toVector2(options.offset);      changes |= LabelChangeType.Layout;    }

        if (options.font          !== undefined) { this._font          = options.font;          changes |= LabelChangeType.Font;   }
        if (options.fontSize      !== undefined) { this._fontSize      = options.fontSize;      changes |= LabelChangeType.Font;   }
        if (options.fontWeight    !== undefined) { this._fontWeight    = options.fontWeight;    changes |= LabelChangeType.Font;   }
        if (options.fontStyle     !== undefined) { this._fontStyle     = options.fontStyle;     changes |= LabelChangeType.Font;   }

        if (options.text          !== undefined) { this._text          = options.text;          changes |= LabelChangeType.Text;   }
        if (options.textTransform !== undefined) { this._textTransform = options.textTransform; changes |= LabelChangeType.Text;   }

        if (options.letterSpacing !== undefined) { this._letterSpacing = options.letterSpacing; changes |= LabelChangeType.Layout; }
        if (options.lineHeight    !== undefined) { this._lineHeight    = options.lineHeight;    changes |= LabelChangeType.Layout; }
        if (options.maxWidth      !== undefined) { this._maxWidth      = options.maxWidth;      changes |= LabelChangeType.Layout; }
        if (options.textAlign     !== undefined) { this._textAlign     = options.textAlign;     changes |= LabelChangeType.Layout; }
        if (options.anchorX       !== undefined) { this._anchorX       = options.anchorX;       changes |= LabelChangeType.Layout; }
        if (options.anchorY       !== undefined) { this._anchorY       = options.anchorY;       changes |= LabelChangeType.Layout; }
        if (options.padding       !== undefined) { this._padding       = this._parsePadding(options.padding); changes |= LabelChangeType.Layout; }

        if (options.color         !== undefined) { this._color       = toColor(options.color);                      changes |= LabelChangeType.Style; }
        if (options.opacity       !== undefined) { this._opacity     = options.opacity;                             changes |= LabelChangeType.Style; }
        if (options.haloColor     !== undefined) { this._haloColor   = toColor(options.haloColor);                  changes |= LabelChangeType.Style; }
        if (options.haloWidth     !== undefined) { this._haloWidth   = this._clampHaloWidth(options.haloWidth);     changes |= LabelChangeType.Style; }
        if (options.haloBlur      !== undefined) { this._haloBlur    = this._clampHaloBlur(options.haloBlur);       changes |= LabelChangeType.Style; }
        if (options.haloOpacity   !== undefined) { this._haloOpacity = options.haloOpacity;                         changes |= LabelChangeType.Style; }

        if (options.rotationAlignment !== undefined) { this._rotationAlignment = options.rotationAlignment; changes |= LabelChangeType.Style; }
        if (options.symbolPlacement   !== undefined) { this._symbolPlacement   = options.symbolPlacement;   changes |= LabelChangeType.Style; }

        if (options.visible       !== undefined) { this._visible = options.visible; changes |= LabelChangeType.Visibility; }

        if (options.bounds !== undefined) this.bounds = options.bounds;
        if (options.glyphs !== undefined) this.glyphs = options.glyphs;

        if (!silent) this._emit(changes);
        return this;
    }

    clone(): Label {
        return new Label({
            text:          this._text,
            position:      this._position.clone(),
            rotation:      this._rotation.clone(),
            offset:        this._offset.clone(),
            font:          this._font,
            fontSize:      this._fontSize,
            fontWeight:    this._fontWeight,
            fontStyle:     this._fontStyle,
            letterSpacing: this._letterSpacing,
            lineHeight:    this._lineHeight,
            maxWidth:      this._maxWidth,
            textAlign:     this._textAlign,
            anchorX:       this._anchorX,
            anchorY:       this._anchorY,
            padding:       { ...this._padding },
            color:         this._color.clone(),
            opacity:       this._opacity,
            haloColor:     this._haloColor.clone(),
            haloWidth:     this._haloWidth,
            haloBlur:      this._haloBlur,
            haloOpacity:   this._haloOpacity,
            rotationAlignment: this._rotationAlignment,
            symbolPlacement:   this._symbolPlacement,
            visible:       this._visible,
            textTransform: this._textTransform,
            bounds: { ...this.bounds },
            glyphs: this.glyphs.map(g => ({
                glyph:    { ...g.glyph },
                offset:   g.offset.clone(),
                rotation: g.rotation?.clone(),
            })),
        });
    }

    dispose(): void {
        this._emit(LabelChangeType.Dispose);
        this._listeners.clear();
    }

    onChange(listener: LabelChangeListener): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    // Private

    private _parsePadding(value: TextPadding | number | [number, number, number, number]): TextPadding {
        if (Array.isArray(value)) return { top: value[0], right: value[1], bottom: value[2], left: value[3] };
        if (typeof value === 'number') return { top: value, right: value, bottom: value, left: value };
        return value;
    }

    private _emit(changes: LabelChangeMask): void {
        if (changes === LabelChangeType.None) return;
        for (const listener of this._listeners) listener(changes);
    }

    private _clampHaloWidth(value: number): number {
        const max = this._fontSize * 4;
        if (value > max) {
            console.warn(`Label.haloWidth ${value} clamped to ${max} (4 × fontSize ${this._fontSize})`);
            return max;
        }
        return value;
    }

    private _clampHaloBlur(value: number): number {
        const max = this._fontSize * 4;
        if (value > max) {
            console.warn(`Label.haloBlur ${value} clamped to ${max} (4 × fontSize ${this._fontSize})`);
            return max;
        }
        return value;
    }
}

// Module-private conversion helpers

function toColor(value: string | number | Color | Vector3): Color {
    if (value instanceof Color)   return value.clone();
    if (value instanceof Vector3) return new Color(value.x, value.y, value.z);
    return new Color(value);
}

function toVector2(value: [number, number] | Vector2): Vector2 {
    if (value instanceof Vector2) return value.clone();
    return new Vector2(...value);
}

function toVector3(value: [number, number, number] | Vector3 | Color): Vector3 {
    if (value instanceof Vector3) return value.clone();
    if (value instanceof Color)   return new Vector3(value.r, value.g, value.b);
    return new Vector3(...value);
}

function toQuaternion(value: [number, number, number] | Euler | Quaternion): Quaternion {
    if (value instanceof Quaternion) return value.clone();
    if (value instanceof Euler)      return new Quaternion().setFromEuler(value);
    return new Quaternion().setFromEuler(new Euler(...value, 'XYZ'));
}
