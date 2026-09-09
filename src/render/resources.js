import ShaderPad from 'shaderpad';
import { generateStandardShader } from '../standardShader.js';
import { generatePerturbationShader } from '../perturbationShader.js';
import { generateDeepDisplayShader } from '../deepDisplayShader.js';
import { METRIC_TEXTURE_OPTIONS, ORBIT_TEXTURE_OPTIONS, PALETTE_TEXTURE_OPTIONS } from '../config.js';
const options = { allowMissing: true };
function uniforms(renderer, values, initialize) {
	if (initialize)
		for (const [key, [type, value]] of Object.entries(values))
			renderer.initializeUniform(key, type, value, options);
	else
		renderer.updateUniforms(
			Object.fromEntries(Object.entries(values).map(([key, [, value]]) => [key, value])),
			options,
		);
}
// Owns all WebGL resources and their invalidation. The coordinator owns when to
// draw; this class owns how a requested pass is allocated and populated.
export class RenderResources {
	constructor(canvas) {
		this.canvas = canvas;
		this.standard = null;
		this.deep = null;
		this.display = null;
		this.uploadedReference = null;
	}
	standardPass(state) {
		const key = `${state.fractalType}|${state.exponent}`;
		const fresh = !this.standard || this.standardKey !== key;
		if (fresh) {
			this.standard?.destroy();
			this.standard = new ShaderPad(generateStandardShader(state), {
				canvas: this.canvas,
				...METRIC_TEXTURE_OPTIONS,
			});
			this.standardKey = key;
		}
		uniforms(
			this.standard,
			{
				u_center: ['float', [state.xPosition, state.yPosition]],
				u_zoom: ['float', state.zoomScale],
				u_cReal: ['float', state.cReal],
				u_cImaginary: ['float', state.cImaginary],
				u_iterations: ['int', state.iterations],
				u_escapeRadius: ['float', state.escapeRadius],
				u_logEscapeRadius: ['float', state.logEscapeRadius],
			},
			fresh,
		);
		return this.standard;
	}
	deepPass(state, manager) {
		const key = `${state.fractalType}|${state.exponent}`;
		const fresh = !this.deep || this.deepKey !== key;
		if (fresh) {
			this.deep?.destroy();
			this.deep = new ShaderPad(generatePerturbationShader(state), {
				canvas: { width: this.canvas.width, height: this.canvas.height },
				...METRIC_TEXTURE_OPTIONS,
			});
			this.deepKey = key;
			this.uploadedReference = null;
		}
		const [mantissa, exponent] = manager.decomposeValue(state.radiusExact);
		const offset = manager.getReferenceOffsetFor(state);
		uniforms(
			this.deep,
			{
				u_iterations: ['int', state.deepIterations],
				u_orbitLength: ['int', manager.getReferenceOrbitLength()],
				u_radiusMantissa: ['float', mantissa],
				u_radiusExponent: ['int', exponent],
				u_referenceOffset: ['float', [offset.offsetReal, offset.offsetImag]],
				u_escapeRadius: ['float', state.escapeRadius],
				u_logEscapeRadius: ['float', state.logEscapeRadius],
			},
			fresh,
		);
		if (this.uploadedReference !== manager.referenceSignature) {
			const sources = {
				u_orbitTexture: manager.getOrbitTextureSource(),
				u_blaTable: manager.getBLATextureSource(),
				u_visualPrefixTexture: manager.getVisualPrefixTextureSource(),
			};
			const present = Object.fromEntries(Object.entries(sources).filter(([, v]) => v));
			if (this.uploadedReference === null)
				for (const [name, source] of Object.entries(present))
					this.deep.initializeTexture(name, source, ORBIT_TEXTURE_OPTIONS);
			else this.deep.updateTextures(present);
			this.uploadedReference = manager.referenceSignature;
		}
		return this.deep;
	}
	readDeepMetrics() {
		const { width, height } = this.canvas,
			gl = this.deep.gl;
		const data = new Float32Array(width * height * 4);
		gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, data);
		if (gl.getError() !== gl.NO_ERROR) throw Error('Unable to read deep metrics');
		return { data, width, height };
	}
	displayPass(state, source, preview, palette, insideColor, paletteVersion) {
		const fresh = !this.display;
		if (fresh) {
			this.display = new ShaderPad(generateDeepDisplayShader(), { canvas: this.canvas });
			this.display.initializeTexture('u_palette', palette, PALETTE_TEXTURE_OPTIONS);
			this.display.initializeTexture('u_liveMetrics', source, METRIC_TEXTURE_OPTIONS);
		} else if (this.metricSource !== source) this.display.updateTextures({ u_liveMetrics: source });
		this.metricSource = source;
		if (!fresh && paletteVersion !== this.paletteVersion) this.display.updateTextures({ u_palette: palette });
		this.paletteVersion = paletteVersion;
		uniforms(
			this.display,
			{
				u_insideColor: ['float', insideColor],
				u_paletteFrame: ['float', state.paletteFrame],
				u_colorScale: ['float', state.colorScale],
				u_stripeAverage: ['int', state.stripeAverage],
				u_slopeShading: ['int', state.slopeShading],
				u_slopeLightDir: ['float', state.slopeLightDir],
				u_slopeLightHeight: ['float', state.slopeLightHeight],
				u_slopeLightIntensity: ['float', state.slopeLightIntensity],
				u_previewScale: ['float', preview?.scale ?? 1],
				u_previewOffset: ['float', [preview?.offsetReal ?? 0, preview?.offsetImag ?? 0]],
			},
			fresh,
		);
		return this.display;
	}
	resize(width, height) {
		if (this.deep) {
			this.deep.canvas.width = width;
			this.deep.canvas.height = height;
			this.deep.syncRes();
		}
		this.standard?.syncRes();
		this.display?.syncRes();
		this.metricSource = null;
	}
	destroy() {
		this.standard?.destroy();
		this.deep?.destroy();
		this.display?.destroy();
		this.standard = this.deep = this.display = null;
	}
}
