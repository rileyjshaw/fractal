import { DeepZoomManager } from '../../src/deepZoom.js';
import { generatePerturbationShader } from '../../src/perturbationShader.js';
import { generateStandardShader } from '../../src/standardShader.js';
import { generateDeepDisplayShader } from '../../src/deepDisplayShader.js';

// Exercise the production shaders in a real RGBA32F framebuffer. No animation,
// palette randomness, timing-dependent camera, or screenshot encoding in metrics.
const canvas = document.querySelector('canvas');
const gl = canvas.getContext('webgl2');
if (!gl || !gl.getExtension('EXT_color_buffer_float')) throw Error('RGBA32F WebGL2 unavailable');
const vertex = `#version 300 es
out vec2 v_uv;
void main() {
 vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
 v_uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0, 1);
}`;
function compile(source, type) {
	const shader = gl.createShader(type);
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
	return shader;
}
function program(source) {
	const p = gl.createProgram();
	const shaders = [compile(vertex, gl.VERTEX_SHADER), compile(source, gl.FRAGMENT_SHADER)];
	for (const s of shaders) gl.attachShader(p, s);
	gl.linkProgram(p);
	for (const s of shaders) gl.deleteShader(s);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
	return p;
}
const manager = new DeepZoomManager();
await manager.initialize();
window.renderFixture = async (state, options = {}) => {
	if (options.referenceOffset) {
		const center = manager.translateCenter(
			state.centerRealExact,
			state.centerImagExact,
			state.radiusExact,
			...options.referenceOffset,
		);
		await manager.ensureReference({
			...state,
			centerRealExact: center.centerReal,
			centerImagExact: center.centerImag,
		});
	} else await manager.ensureReference(state);
	const { width, height } = state;
	canvas.width = width;
	canvas.height = height;
	const p = program(generatePerturbationShader({ ...state, ...options }));
	gl.useProgram(p);
	const textures = [];
	let unit = 0;
	function texture(name, source) {
		if (!source) return;
		const t = gl.createTexture();
		textures.push(t);
		gl.activeTexture(gl.TEXTURE0 + unit);
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, source.width, source.height, 0, gl.RGBA, gl.FLOAT, source.data);
		if (name) gl.uniform1i(gl.getUniformLocation(p, name), unit);
		unit++;
		return t;
	}
	texture('u_orbitTexture', manager.getOrbitTextureSource());
	texture('u_blaTable', manager.getBLATextureSource());
	texture('u_visualPrefixTexture', manager.getVisualPrefixTextureSource());
	const output = texture(null, { width, height, data: null });
	const fbo = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output, 0);
	if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Incomplete metric FBO');
	const offset = manager.getReferenceOffsetFor(state);
	const [mantissa, exponent] = manager.decomposeValue(state.radiusExact);
	for (const [name, value] of Object.entries({
		u_iterations: state.deepIterations,
		u_orbitLength: manager.getReferenceOrbitLength(),
		u_radiusExponent: exponent,
	}))
		gl.uniform1i(gl.getUniformLocation(p, name), value);
	for (const [name, value] of Object.entries({
		u_radiusMantissa: mantissa,
		u_escapeRadius: state.escapeRadius,
		u_logEscapeRadius: Math.log(state.escapeRadius),
	}))
		gl.uniform1f(gl.getUniformLocation(p, name), value);
	gl.uniform2f(gl.getUniformLocation(p, 'u_resolution'), width, height);
	gl.uniform2f(gl.getUniformLocation(p, 'u_referenceOffset'), offset.offsetReal, offset.offsetImag);
	gl.viewport(0, 0, width, height);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	const pixels = new Float32Array(width * height * 4);
	gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels);
	const error = gl.getError();
	gl.deleteFramebuffer(fbo);
	for (const t of textures) gl.deleteTexture(t);
	gl.deleteProgram(p);
	if (error !== gl.NO_ERROR) throw Error(`WebGL error ${error}`);
	return { pixels: Array.from(pixels), reference: manager.referenceState };
};
window.compileVariants = () => {
	for (let fractalType = 0; fractalType < 4; fractalType++)
		for (let exponent = 2; exponent <= 16; exponent++) {
			for (const generate of [generateStandardShader, generatePerturbationShader])
				gl.deleteProgram(program(generate({ fractalType, exponent })));
		}
	gl.deleteProgram(program(generateDeepDisplayShader()));
	return 121;
};
window.ready = true;
