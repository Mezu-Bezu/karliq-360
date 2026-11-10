const viewer = document.getElementById('viewer');
const canvas = document.getElementById('view');
const panorama = document.getElementById('panorama');
const fullscreen = document.getElementById('fullscreen');
const help = document.getElementById('fullscreen-help');
const radians = Math.PI / 180;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const pointers = new Map();
let yaw = 138 * radians;
let pitch = -27 * radians;
let fov = innerWidth < innerHeight ? 82 : 65;
let drawFrame;
let pending = false;

// The same equirectangular mapping as the Karliq tour viewer, applied to a
// camera ray for each screen pixel.
const vertexSource = `#version 300 es
out vec2 screenPoint;
void main() {
  vec2 corners[3] = vec2[3](vec2(-1., -1.), vec2(3., -1.), vec2(-1., 3.));
  screenPoint = corners[gl_VertexID];
  gl_Position = vec4(screenPoint, 0., 1.);
}`;

const fragmentSource = `#version 300 es
precision highp float;
in vec2 screenPoint;
out vec4 color;
uniform sampler2D panorama;
uniform vec3 forward, right, up;
uniform vec2 field;
void main() {
  vec3 ray = normalize(forward + right * screenPoint.x * field.x + up * screenPoint.y * field.y);
  vec2 uv = vec2(atan(ray.x, -ray.z) / 6.28318530718 + .5,
                 asin(clamp(ray.y, -1., 1.)) / 3.14159265359 + .5);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  dx.x -= round(dx.x);
  dy.x -= round(dy.x);
  color = textureGrad(panorama, uv, dx, dy);
}`;

function createRenderer() {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
  if (!gl) return null;
  const shader = (kind, source) => {
    const stage = gl.createShader(kind);
    gl.shaderSource(stage, source);
    gl.compileShader(stage);
    if (!gl.getShaderParameter(stage, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(stage));
    return stage;
  };
  const vertex = shader(gl.VERTEX_SHADER, vertexSource);
  const fragment = shader(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, panorama);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D);
  const forward = gl.getUniformLocation(program, 'forward');
  const right = gl.getUniformLocation(program, 'right');
  const up = gl.getUniformLocation(program, 'up');
  const field = gl.getUniformLocation(program, 'field');

  return () => {
    const ratio = Math.min(devicePixelRatio, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    gl.viewport(0, 0, width, height);
    const sin = Math.sin(pitch);
    const cos = Math.cos(pitch);
    const half = Math.tan(fov * radians / 2);
    gl.uniform3f(forward, Math.sin(yaw) * cos, sin, -Math.cos(yaw) * cos);
    gl.uniform3f(right, Math.cos(yaw), 0, Math.sin(yaw));
    gl.uniform3f(up, -Math.sin(yaw) * sin, cos, Math.cos(yaw) * sin);
    gl.uniform2f(field, half * width / height, half);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}

function paint() {
  if (pending || !drawFrame) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    drawFrame?.();
  });
}

function start() {
  try {
    drawFrame = createRenderer();
    if (!drawFrame) return;
    canvas.hidden = false;
    panorama.hidden = true;
    paint();
  } catch (error) {
    console.error(error);
  }
}

function turn(horizontal, vertical) {
  yaw += horizontal;
  pitch = clamp(pitch + vertical, -89 * radians, 89 * radians);
  paint();
}

function zoom(factor) {
  fov = clamp(2 * Math.atan(Math.tan(fov * radians / 2) * factor) / radians, 30, 96);
  paint();
}

canvas.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  pointers.set(event.pointerId, [event.clientX, event.clientY]);
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', event => {
  const old = pointers.get(event.pointerId);
  if (!old) return;
  const point = [event.clientX, event.clientY];
  pointers.set(event.pointerId, point);
  if (pointers.size > 1) {
    const pair = [...pointers.entries()].slice(0, 2);
    if (!pair.some(([id]) => id === event.pointerId)) return;
    const other = pair.find(([id]) => id !== event.pointerId)[1];
    const distance = Math.hypot(point[0] - other[0], point[1] - other[1]);
    const previous = Math.hypot(old[0] - other[0], old[1] - other[1]);
    if (distance > 8 && previous > 8) zoom(previous / distance);
    return;
  }
  const sensitivity = fov * radians / Math.max(canvas.clientHeight, 1);
  turn((old[0] - point[0]) * sensitivity, (point[1] - old[1]) * sensitivity);
});

for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  canvas.addEventListener(name, event => pointers.delete(event.pointerId));
}

canvas.addEventListener('wheel', event => {
  event.preventDefault();
  if (event.deltaY) zoom(event.deltaY > 0 ? 1.08 : 1 / 1.08);
}, { passive: false });

canvas.addEventListener('keydown', event => {
  const moves = { ArrowLeft: [-.12, 0], ArrowRight: [.12, 0], ArrowUp: [0, .12], ArrowDown: [0, -.12] };
  if (moves[event.key]) turn(...moves[event.key]);
  else if (event.key === '+') zoom(1 / 1.12);
  else if (event.key === '-') zoom(1.12);
  else return;
  event.preventDefault();
});

canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  drawFrame = null;
  canvas.hidden = true;
  panorama.hidden = false;
  pointers.clear();
});
canvas.addEventListener('webglcontextrestored', start);
new ResizeObserver(paint).observe(viewer);

const activeFullscreen = () => document.fullscreenElement || document.webkitFullscreenElement;
const installed = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
fullscreen.hidden = Boolean(installed);

function updateFullscreen() {
  const active = Boolean(activeFullscreen());
  const label = active ? 'Avsluta helskärm' : 'Helskärm';
  fullscreen.setAttribute('aria-label', label);
  fullscreen.title = label;
  document.getElementById('expand').toggleAttribute('hidden', active);
  document.getElementById('contract').toggleAttribute('hidden', !active);
  paint();
}

function showFullscreenHelp() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  document.getElementById('fullscreen-message').textContent = ios
    ? 'För helskärm på iPhone, öppna sidan i Safari. Välj Dela → Lägg till på hemskärmen och slå på Öppna som webbapp.'
    : 'Öppna länken direkt i din webbläsare för att använda helskärm.';
  if (!help.open) help.showModal();
}

fullscreen.addEventListener('click', async () => {
  try {
    if (activeFullscreen()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      await exit.call(document);
    } else if (viewer.requestFullscreen) {
      await viewer.requestFullscreen({ navigationUI: 'hide' });
    } else if (viewer.webkitRequestFullscreen) {
      viewer.webkitRequestFullscreen();
    } else {
      showFullscreenHelp();
    }
  } catch {
    showFullscreenHelp();
  }
});

document.addEventListener('fullscreenchange', updateFullscreen);
document.addEventListener('webkitfullscreenchange', updateFullscreen);
panorama.decode().then(start).catch(() => {});
