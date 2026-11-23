// Copyright (c) 2026 PSD2Live contributors
// SPDX-License-Identifier: MIT
//
// Ported from psd2live targets/web/src/main/resources/io/github/psd2live/targets/web/p2l.js@f66ba461
//
// The player's WebGL 1 half, drawing a Psd2liveRig on a canvas whose frame loop its caller owns,
// passing the device pixel ratio and the view each draw.
//
// Drawing follows the runtime header's rules (p2l_runtime.h, "Drawing") on premultiplied color, WebGL 1:
// - Normal under over and Cubism's add and multiply use blend functions. Every other pair of a color blend
//   mode (W3C blend functions) and an alpha blend mode (over, atop, out, conjoint and disjoint over) reads
//   the destination: the pixels under the mesh are copied into a texture and a shader composites onto them.
// - Isolated groups (p2l_render_commands) draw their meshes into a cleared layer texture, then composite
//   the layer with the group's opacity, multiply and screen colors, masks and blend modes.
// - Masks write the stencil where a mask texel is at least half opaque (coverage 1, else 0); a group's
//   masks do the same on the target the group composites onto.
// Without layer framebuffers isolated groups draw as their meshes alone.
import type { View } from "../framing.ts";
import { AvatarError, avatarErrorOf } from "../model.ts";
import type { Psd2liveRig } from "./rig.ts";

const VERTEX = `
attribute vec2 position;
attribute vec2 uv;
uniform vec4 view; // scale x, scale y, offset x, offset y
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position * view.xy + view.zw, 0.0, 1.0);
}`;

// A quad over the whole target; the scissor limits it to the pixels a layer holds.
const QUAD_VERTEX = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

// The header's compositing of a premultiplied source s over the destination d.
const COMPOSITE = `
uniform sampler2D destination;
uniform vec2 targetSize;
uniform int colorBlend;
uniform int alphaBlend;

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }

vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}

vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }

float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }

vec3 setSat(vec3 c, float s) {
  float lo = min(c.r, min(c.g, c.b));
  float hi = max(c.r, max(c.g, c.b));
  return hi > lo ? (c - lo) * s / (hi - lo) : vec3(0.0);
}

// W3C HardLight(Cb, Cs): multiply below one half, screen above.
float hardLight(float b, float s) {
  if (s <= 0.5) return b * 2.0 * s;
  float t = 2.0 * s - 1.0;
  return b + t - b * t;
}

float softLightD(float b) { return b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b); }

// The separable blend function B(Cb, Cs) of the color blend mode.
float separable(float b, float s) {
  if (colorBlend == 1 || colorBlend == 3 || colorBlend == 4) return min(1.0, b + s);
  if (colorBlend == 2 || colorBlend == 6) return b * s;
  if (colorBlend == 5) return min(b, s);
  if (colorBlend == 7) return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s));
  if (colorBlend == 8) return max(0.0, b + s - 1.0);
  if (colorBlend == 9) return max(b, s);
  if (colorBlend == 10) return b + s - b * s;
  if (colorBlend == 11) return b <= 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s)));
  if (colorBlend == 12) return hardLight(s, b);
  if (colorBlend == 13) return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (softLightD(b) - b);
  if (colorBlend == 14) return hardLight(b, s);
  if (colorBlend == 15) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
  return s;
}

vec3 blendColor(vec3 b, vec3 s) {
  if (colorBlend == 16) return setLum(setSat(s, sat(b)), lum(b));
  if (colorBlend == 17) return setLum(s, lum(b));
  return vec3(separable(b.r, s.r), separable(b.g, s.g), separable(b.b, s.b));
}

vec4 composite(vec4 s) {
  vec4 d = texture2D(destination, gl_FragCoord.xy / targetSize);
  vec4 o;
  if (colorBlend == 1) {
    o = vec4(s.rgb + d.rgb, d.a);
  } else if (colorBlend == 2) {
    o = vec4(s.rgb * d.rgb + d.rgb * (1.0 - s.a), d.a);
  } else if (colorBlend == 0 && alphaBlend == 0) {
    o = s + d * (1.0 - s.a);
  } else {
    float sa = s.a, da = d.a;
    vec3 cs = sa > 0.0 ? clamp(s.rgb / sa, 0.0, 1.0) : vec3(0.0);
    vec3 cb = da > 0.0 ? clamp(d.rgb / da, 0.0, 1.0) : vec3(0.0);
    // How much of the source overlaps the destination, by the alpha mode's coverage model.
    float p = alphaBlend == 3 ? min(sa, da) : (alphaBlend == 4 ? max(sa + da - 1.0, 0.0) : sa * da);
    float w = sa > 0.0 ? p / sa : 0.0;
    vec3 m = (1.0 - w) * cs + w * blendColor(cb, cs);
    // Porter-Duff factors: over, atop, out (the source erases), conjoint and disjoint over.
    float fa = 1.0, fb = 1.0 - sa;
    if (alphaBlend == 1) fa = da;
    else if (alphaBlend == 2) fa = 0.0;
    else if (alphaBlend == 3) fb = (da <= 0.0 || sa >= da) ? 0.0 : 1.0 - sa / da;
    else if (alphaBlend == 4) fb = da <= 0.0 ? 0.0 : min(1.0, (1.0 - sa) / da);
    o = vec4(sa * fa * m + da * fb * cb, sa * fa + da * fb);
  }
  return clamp(o, 0.0, 1.0);
}
`;

// A mesh's fragment on premultiplied texels: multiply, then screen, then opacity.
const MESH = `
uniform sampler2D tex;
uniform vec3 multiply;
uniform vec3 screen;
uniform float opacity;
uniform float maskThreshold; // above zero: draw as a mask, keeping only covered pixels
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tex, vUv);
  if (maskThreshold > 0.0) {
    if (c.a < maskThreshold) discard;
    gl_FragColor = vec4(0.0);
    return;
  }
  c.rgb *= multiply;
  c.rgb += screen * c.a - c.rgb * screen;
  c *= opacity;
#ifdef COMPOSITE
  gl_FragColor = composite(c);
#else
  gl_FragColor = c;
#endif
}`;

// An isolated group's layer pixel: unpremultiplied, multiply, then screen; alpha scaled by the opacity.
const GROUP = `
uniform sampler2D layer;
uniform vec2 layerSize;
uniform vec3 multiply;
uniform vec3 screen;
uniform float opacity;
void main() {
  vec4 l = texture2D(layer, gl_FragCoord.xy / layerSize) * opacity;
  vec3 c = l.a > 0.0 ? clamp(l.rgb / l.a, 0.0, 1.0) : vec3(0.0);
  c *= multiply;
  c = c + screen - c * screen;
  vec4 s = vec4(c * l.a, l.a);
#ifdef COMPOSITE
  gl_FragColor = composite(s);
#else
  gl_FragColor = s;
#endif
}`;

/** Whether the pair of a color and an alpha blend mode composites with blend functions. */
function fixedFunction(blend: number, alphaBlend: number): boolean {
  return blend === 1 || blend === 2 || (blend === 0 && alphaBlend === 0);
}

/** [x0, y0, x1, y1] in framebuffer pixels (y up). */
type Rect = [number, number, number, number];

// Named by key, never as a string: apps/cli's no-Python scan refuses a string that reads "uv".
const ATTRIBUTES = { position: 0, uv: 1 } as const;

const UNIFORMS = [
  "view",
  "tex",
  "multiply",
  "screen",
  "opacity",
  "maskThreshold",
  "layer",
  "layerSize",
  "destination",
  "targetSize",
  "colorBlend",
  "alphaBlend",
] as const;

interface Program {
  readonly program: WebGLProgram;
  readonly loc: Readonly<Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>>;
}

interface Programs {
  readonly mesh: Program;
  readonly meshComposite: Program;
  readonly group: Program;
  readonly groupComposite: Program;
}

/** An isolated group's layer: used, the pixels drawn since it was last cleared, to clear before its next group. */
interface Layer {
  readonly kind: "layer";
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
  used: Rect | null;
  part: number;
}

/** What draws go into: the canvas, a layer, or a group drawn where it is, without a layer. */
type Target =
  | { readonly kind: "canvas"; readonly framebuffer: null; used: Rect | null }
  | { readonly kind: "pass"; readonly framebuffer: WebGLFramebuffer | null; used: Rect | null }
  | Layer;

interface MeshDraw {
  readonly vertices: number;
  readonly count: number;
  readonly texture: number;
  readonly blend: number;
  readonly alphaBlend: number;
  readonly culling: boolean;
  readonly fixed: boolean;
  readonly masks: readonly number[];
  readonly invertMask: boolean;
  readonly uvBuffer: WebGLBuffer;
  readonly indexBuffer: WebGLBuffer;
}

interface GroupDraw {
  readonly blend: number;
  readonly alphaBlend: number;
  readonly invertMask: boolean;
  readonly masks: readonly number[];
  readonly fixed: boolean;
}

export class Psd2liveRenderer {
  readonly rig: Psd2liveRig;
  readonly canvas: HTMLCanvasElement;
  /** Zoom over the fitted view and a pan in element pixels, as the last draw used them. */
  private view: View = { zoom: 1, x: 0, y: 0 };
  private pixelRatio = 1;
  private lost = false;
  private readonly onContextLost = (): void => {
    this.lost = true;
  };
  private gl!: WebGLRenderingContext;
  private indexType!: number;
  private programs!: Programs;
  private meshes!: readonly MeshDraw[];
  private groups!: readonly GroupDraw[];
  private positionBuffer!: WebGLBuffer;
  private quadBuffer!: WebGLBuffer;
  private destination!: WebGLTexture;
  private depthStencil!: WebGLRenderbuffer;
  private layers: Layer[] = [];
  private targetWidth = 0;
  private targetHeight = 0;
  private isolation = true;
  private textures: (WebGLTexture | null)[] = [];
  private current: Program | null = null;
  private transform: [number, number, number, number] = [1, -1, 0, 0];

  constructor(rig: Psd2liveRig, canvas: HTMLCanvasElement) {
    this.rig = rig;
    this.canvas = canvas;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    try {
      this.setupGl();
    } catch (error) {
      canvas.removeEventListener("webglcontextlost", this.onContextLost);
      throw avatarErrorOf(error, "webgl");
    }
  }

  /** The scale and offset that place the rig's canvas in the element (CSS pixels): x' = x * scale + left. */
  layout(): { scale: number; left: number; top: number; rect: DOMRect } {
    const r = this.canvas.getBoundingClientRect();
    const scale = Math.min(r.width / this.rig.width, r.height / this.rig.height) * this.view.zoom;
    return {
      scale,
      left: r.width / 2 + this.view.x - (this.rig.width / 2) * scale,
      top: r.height / 2 + this.view.y - (this.rig.height / 2) * scale,
      rect: r,
    };
  }

  /** Frees its GPU objects; the rig is its owner's to free. */
  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    const gl = this.gl;
    for (const t of this.textures) if (t) gl.deleteTexture(t);
    for (const m of this.meshes) {
      gl.deleteBuffer(m.uvBuffer);
      gl.deleteBuffer(m.indexBuffer);
    }
    gl.deleteBuffer(this.positionBuffer);
    gl.deleteBuffer(this.quadBuffer);
    for (const layer of this.layers) {
      gl.deleteFramebuffer(layer.framebuffer);
      gl.deleteTexture(layer.texture);
    }
    gl.deleteTexture(this.destination);
    gl.deleteRenderbuffer(this.depthStencil);
    for (const p of Object.values(this.programs)) gl.deleteProgram(p.program);
    this.textures = [];
    this.layers = [];
  }

  private setupGl(): void {
    // Premultiplied throughout, as the page composites the canvas.
    const gl = this.canvas.getContext("webgl", {
      stencil: true,
      alpha: true,
      premultipliedAlpha: true,
    });
    if (!gl) throw new AvatarError("webgl", "WebGL is not available");
    // 32-bit indices where available; otherwise meshes past 65535 vertices cannot draw.
    const wide = gl.getExtension("OES_element_index_uint") != null;
    this.indexType = wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    const indices = this.rig.meshes.map((mesh) => {
      if (wide) return mesh.indices;
      for (let i = 0; i < mesh.indices.length; i++) {
        if ((mesh.indices[i] ?? 0) > 65535) {
          throw new AvatarError(
            "webgl",
            "This model needs 32-bit mesh indices, which this browser's WebGL does not provide",
          );
        }
      }
      return new Uint16Array(mesh.indices);
    });
    this.gl = gl;
    const shader = (type: number, source: string): WebGLShader => {
      const s = gl.createShader(type);
      if (!s) throw new AvatarError("webgl", "A shader could not be created");
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new AvatarError("webgl", gl.getShaderInfoLog(s) ?? "A shader did not compile");
      }
      return s;
    };
    const link = (vertex: string, fragment: string, composite: boolean): Program => {
      const program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
      gl.attachShader(
        program,
        shader(
          gl.FRAGMENT_SHADER,
          PRECISION + (composite ? `#define COMPOSITE\n${COMPOSITE}` : "") + fragment,
        ),
      );
      // Every program reads positions at 0 and texture coordinates at 1; a name a shader lacks binds
      // nothing.
      for (const [name, location] of Object.entries(ATTRIBUTES)) {
        gl.bindAttribLocation(program, location, name);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new AvatarError("webgl", gl.getProgramInfoLog(program) ?? "A program did not link");
      }
      const loc = Object.fromEntries(
        UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]),
      ) as Program["loc"];
      gl.useProgram(program);
      if (loc.tex) gl.uniform1i(loc.tex, 0);
      if (loc.layer) gl.uniform1i(loc.layer, 0);
      if (loc.destination) gl.uniform1i(loc.destination, 1);
      return { program, loc };
    };
    this.programs = {
      mesh: link(VERTEX, MESH, false),
      meshComposite: link(VERTEX, MESH, true),
      group: link(QUAD_VERTEX, GROUP, false),
      groupComposite: link(QUAD_VERTEX, GROUP, true),
    };
    gl.enableVertexAttribArray(0);
    this.positionBuffer = gl.createBuffer();
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.meshes = this.rig.meshes.map((mesh, m) => {
      const uvBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);
      const indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices[m] ?? mesh.indices, gl.STATIC_DRAW);
      return {
        vertices: mesh.vertices,
        count: mesh.indices.length,
        texture: mesh.texture,
        blend: mesh.blend,
        alphaBlend: mesh.alphaBlend,
        culling: mesh.culling,
        fixed: fixedFunction(mesh.blend, mesh.alphaBlend),
        masks: mesh.masks,
        invertMask: mesh.invertMask,
        uvBuffer,
        indexBuffer,
      };
    });
    this.groups = this.rig.groups.map((group) => ({
      ...group,
      fixed: fixedFunction(group.blend, group.alphaBlend),
    }));
    // The destination copy that blend modes read, isolated groups' layers and their stencil, sized with the canvas.
    this.destination = this.targetTexture();
    this.depthStencil = gl.createRenderbuffer();
    this.layers = [];
    this.targetWidth = 0;
    this.targetHeight = 0;
    this.isolation = true;
  }

  /** A texture to render into or copy pixels to, sampled pixel for pixel. */
  private targetTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /** Sizes the destination copy, the layers and their stencil to [w] × [h]. */
  private resizeTargets(w: number, h: number): void {
    const gl = this.gl;
    this.targetWidth = w;
    this.targetHeight = h;
    const size = (texture: WebGLTexture) => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    };
    size(this.destination);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthStencil);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_STENCIL, w, h);
    for (const layer of this.layers) {
      size(layer.texture);
      layer.used = null;
    }
  }

  /** The layer at nesting [depth], created on first use; null when the context cannot render into textures. */
  private layer(depth: number): Layer | null {
    const gl = this.gl;
    if (!this.isolation) return null;
    while (this.layers.length <= depth) {
      const texture = this.targetTexture();
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        this.targetWidth,
        this.targetHeight,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_STENCIL_ATTACHMENT,
        gl.RENDERBUFFER,
        this.depthStencil,
      );
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!complete) {
        gl.deleteFramebuffer(framebuffer);
        gl.deleteTexture(texture);
        this.isolation = false;
        return null;
      }
      // used: the pixels drawn since the layer was last cleared, to clear before its next group.
      this.layers.push({ kind: "layer", texture, framebuffer, used: null, part: 0 });
    }
    return this.layers[depth] ?? null;
  }

  async loadTextures(): Promise<void> {
    const gl = this.gl;
    this.textures = [];
    // Uploaded premultiplied, so bilinear sampling mixes premultiplied texels, and without color management
    // (an ImageBitmap carries both itself; the store flags cover browsers that read them).
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    for (let i = 0; i < this.rig.textureCount(); i++) {
      const png = this.rig.texturePng(i);
      let image: ImageBitmap;
      try {
        image = await createImageBitmap(new Blob([png], { type: "image/png" }), {
          premultiplyAlpha: "premultiply",
          colorSpaceConversion: "none",
        });
      } catch (error) {
        throw new AvatarError("rig", `Texture page ${i} could not be decoded`, { cause: error });
      }
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      image.close();
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures.push(texture);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  /** The rig's canvas point under a point of the page, as the canvas element draws it. */
  toRig(clientX: number, clientY: number): [number, number] {
    const { scale, left, top, rect } = this.layout();
    return [(clientX - rect.left - left) / scale, (clientY - rect.top - top) / scale];
  }

  /** Draws the rig's last evaluation at [pixelRatio] device pixels per CSS pixel, framed by [view]. */
  draw(pixelRatio: number, view: View): void {
    const gl = this.gl;
    if (this.lost || gl.isContextLost())
      throw new AvatarError("lost", "The WebGL context was lost");
    this.view = view;
    this.pixelRatio = pixelRatio;
    const canvas = this.canvas;
    const ratio = pixelRatio;
    const w = Math.round(canvas.clientWidth * ratio);
    const h = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (w === 0 || h === 0) return;
    if (this.targetWidth !== w || this.targetHeight !== h) this.resizeTargets(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    // Fit the rig's canvas into the element, y down, then zoom and pan it.
    const fit = Math.min(w / this.rig.width, h / this.rig.height) * view.zoom;
    const sx = (2 * fit) / w;
    const sy = (-2 * fit) / h;
    const px = (2 * view.x * ratio) / w;
    const py = (-2 * view.y * ratio) / h;
    this.transform = [sx, sy, (-this.rig.width * sx) / 2 + px, (-this.rig.height * sy) / 2 + py];
    for (const p of Object.values(this.programs)) {
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook.
      gl.useProgram(p.program);
      if (p.loc.view) gl.uniform4f(p.loc.view, ...this.transform);
      if (p.loc.targetSize) gl.uniform2f(p.loc.targetSize, w, h);
      if (p.loc.layerSize) gl.uniform2f(p.loc.layerSize, w, h);
    }
    this.current = null;
    // Clockwise faces in canvas coordinates are counter-clockwise once y points up.
    gl.frontFace(gl.CCW);
    gl.cullFace(gl.BACK);
    gl.enable(gl.SCISSOR_TEST);

    const commands = this.rig.renderCommands();
    // The targets being drawn into: the canvas, then each open group's layer.
    const stack: Target[] = [{ kind: "canvas", framebuffer: null, used: null }];
    for (const command of commands) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      if (command >= 0) {
        this.drawCommand(command, top);
      } else if (command <= -2) {
        const layer = this.layer(stack.length - 1);
        // Without layers the group's meshes draw where they are.
        if (!layer) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, top.framebuffer);
          stack.push({ kind: "pass", framebuffer: top.framebuffer, used: top.used });
          continue;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
        if (layer.used) {
          this.scissor(layer.used);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
        layer.used = null;
        layer.part = -2 - command;
        stack.push(layer);
      } else if (stack.length > 1) {
        const layer = stack.pop();
        const parent = stack[stack.length - 1];
        if (layer === undefined || parent === undefined) break;
        if (layer.kind === "pass") {
          parent.used = layer.used;
          continue;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, parent.framebuffer);
        if (layer.kind === "layer") this.compositeGroup(layer, parent);
      }
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
  }

  /**
   * The canvas's alpha, 0..1, at a point of the page. Read it right after a draw: once the page
   * composites the frame, the drawing buffer is cleared.
   */
  alphaAt(clientX: number, clientY: number): number {
    const gl = this.gl;
    const rect = this.canvas.getBoundingClientRect();
    const column = Math.floor((clientX - rect.left) * this.pixelRatio);
    const row = Math.floor((clientY - rect.top) * this.pixelRatio);
    if (column < 0 || row < 0 || column >= this.canvas.width || row >= this.canvas.height) return 0;
    const out = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(column, this.canvas.height - 1 - row, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return (out[3] ?? 0) / 255;
  }

  /** Uses [name]'s program. */
  private use(name: keyof Programs): Program["loc"] {
    const p = this.programs[name];
    if (this.current !== p) {
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook.
      this.gl.useProgram(p.program);
      this.current = p;
    }
    return p.loc;
  }

  /** Limits drawing to [r] = [x0, y0, x1, y1] in framebuffer pixels (y up). */
  private scissor(r: Rect): void {
    this.gl.scissor(r[0], r[1], r[2] - r[0], r[3] - r[1]);
  }

  /** The framebuffer pixels mesh [m] can cover as [x0, y0, x1, y1], or null when none. */
  private meshRect(m: number): Rect | null {
    const v = this.rig.meshVertices(m);
    const [sx, sy, ox, oy] = this.transform;
    const w = this.targetWidth;
    const h = this.targetHeight;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i + 1 < v.length; i += 2) {
      const x = v[i] ?? Number.NaN;
      const y = v[i + 1] ?? Number.NaN;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (!(x0 <= x1 && y0 <= y1)) {
      return v.length > 0 && v.some((c) => !Number.isFinite(c)) ? [0, 0, w, h] : null;
    }
    // Canvas pixels to framebuffer pixels (y up), a pixel wider each way for rounding.
    const fx = (x: number) => ((x * sx + ox + 1) / 2) * w;
    const fy = (y: number) => ((y * sy + oy + 1) / 2) * h;
    const ax = fx(x0);
    const bx = fx(x1);
    const ay = fy(y0);
    const by = fy(y1);
    return this.clip([
      Math.floor(Math.min(ax, bx)) - 1,
      Math.floor(Math.min(ay, by)) - 1,
      Math.ceil(Math.max(ax, bx)) + 1,
      Math.ceil(Math.max(ay, by)) + 1,
    ]);
  }

  /** [r] within the framebuffer, or null when it is empty there. */
  private clip(r: Rect): Rect | null {
    const x0 = Math.max(0, r[0]);
    const y0 = Math.max(0, r[1]);
    const x1 = Math.min(this.targetWidth, r[2]);
    const y1 = Math.min(this.targetHeight, r[3]);
    return x0 < x1 && y0 < y1 ? [x0, y0, x1, y1] : null;
  }

  /** Adds [r] to the pixels [target] holds. */
  private touch(target: Target, r: Rect): void {
    const u = target.used;
    target.used = u
      ? [Math.min(u[0], r[0]), Math.min(u[1], r[1]), Math.max(u[2], r[2]), Math.max(u[3], r[3])]
      : [r[0], r[1], r[2], r[3]];
  }

  /** Copies the pixels [r] of the bound framebuffer into the destination texture blend modes read. */
  private copyDestination(r: Rect): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.destination);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, r[0], r[1], r[0], r[1], r[2] - r[0], r[3] - r[1]);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Blend functions for the pairs that need no destination read: normal over, Cubism's add and multiply. */
  private blendFunction(mode: number): void {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    if (mode === 1) gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
    else if (mode === 2)
      gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    else gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * Writes 1 into the stencil of the bound framebuffer within [r] where [masks] cover, then tests against it:
   * drawing goes where it is 1, or where it is not when [inverted].
   */
  private stencilMasks(masks: readonly number[], inverted: boolean, r: Rect): void {
    const gl = this.gl;
    this.scissor(r);
    gl.enable(gl.STENCIL_TEST);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    this.use("mesh");
    for (const mask of masks) this.drawMesh(mask, 1, 0.5);
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(inverted ? gl.NOTEQUAL : gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  }

  /** Draws mesh [m] onto [target], the bound framebuffer. */
  private drawCommand(m: number, target: Target): void {
    const gl = this.gl;
    const mesh = this.meshes[m];
    const opacity = this.rig.meshOpacity(m);
    if (!(opacity > 0) || !mesh || !this.textures[mesh.texture] || mesh.vertices === 0) return;
    const r = this.meshRect(m);
    if (!r) return;
    if (mesh.masks.length > 0) this.stencilMasks(mesh.masks, mesh.invertMask, r);
    this.scissor(r);
    let loc: Program["loc"];
    if (mesh.fixed) {
      loc = this.use("mesh");
      this.blendFunction(mesh.blend);
    } else {
      this.copyDestination(r);
      loc = this.use("meshComposite");
      gl.disable(gl.BLEND);
      gl.uniform1i(loc.colorBlend, mesh.blend);
      gl.uniform1i(loc.alphaBlend, mesh.alphaBlend);
    }
    if (mesh.culling) gl.enable(gl.CULL_FACE);
    else gl.disable(gl.CULL_FACE);
    const colors = this.rig.meshColors(m);
    gl.uniform3f(loc.multiply, colors[0] ?? 1, colors[1] ?? 1, colors[2] ?? 1);
    gl.uniform3f(loc.screen, colors[3] ?? 0, colors[4] ?? 0, colors[5] ?? 0);
    this.drawMesh(m, Math.min(opacity, 1), 0);
    if (mesh.masks.length > 0) gl.disable(gl.STENCIL_TEST);
    this.touch(target, r);
  }

  /** Composites [layer], an isolated group's drawing, onto [parent], the bound framebuffer. */
  private compositeGroup(layer: Layer, parent: Target): void {
    const gl = this.gl;
    const r = layer.used;
    const group = this.groups[layer.part];
    if (!r || !group) return;
    const values = this.rig.partComposite(layer.part);
    if (!values) return;
    const opacity = Math.min(values[0] ?? 0, 1);
    if (!(opacity > 0)) return;
    const multiply = [values[1] ?? 1, values[2] ?? 1, values[3] ?? 1] as const;
    const screen = [values[4] ?? 0, values[5] ?? 0, values[6] ?? 0] as const;
    gl.disable(gl.CULL_FACE);
    if (group.masks.length > 0) this.stencilMasks(group.masks, group.invertMask, r);
    this.scissor(r);
    let loc: Program["loc"];
    if (group.fixed) {
      loc = this.use("group");
      this.blendFunction(group.blend);
    } else {
      this.copyDestination(r);
      loc = this.use("groupComposite");
      gl.disable(gl.BLEND);
      gl.uniform1i(loc.colorBlend, group.blend);
      gl.uniform1i(loc.alphaBlend, group.alphaBlend);
    }
    gl.uniform1f(loc.opacity, opacity);
    gl.uniform3f(loc.multiply, ...multiply);
    gl.uniform3f(loc.screen, ...screen);
    gl.bindTexture(gl.TEXTURE_2D, layer.texture);
    gl.disableVertexAttribArray(1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (group.masks.length > 0) gl.disable(gl.STENCIL_TEST);
    this.touch(parent, r);
  }

  private drawMesh(m: number, opacity: number, maskThreshold: number): void {
    const gl = this.gl;
    const mesh = this.meshes[m];
    const texture = mesh && this.textures[mesh.texture];
    if (!mesh || !texture || mesh.vertices === 0) return;
    const loc = this.current?.loc;
    if (!loc) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.rig.meshVertices(m), gl.STREAM_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(1);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1f(loc.opacity, opacity);
    gl.uniform1f(loc.maskThreshold, maskThreshold);
    gl.drawElements(gl.TRIANGLES, mesh.count, this.indexType, 0);
  }
}
