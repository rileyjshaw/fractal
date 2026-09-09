import { init } from 'gmp-wasm';
// Independent direct MPFR quadratic iteration: no perturbation, BLA, reference
// search, GPU arithmetic, or production orbit builder participates in this oracle.
export async function sampleMandelbrot(state, px, py) {
	const { getContext } = await init();
	const g = getContext({ precisionBits: 1536 });
	try {
		const span = Math.min(state.width, state.height);
		const cx = g
			.Float(state.centerRealExact)
			.add(g.Float(state.radiusExact).mul((2 * px + 1 - state.width) / span));
		const cy = g
			.Float(state.centerImagExact)
			.add(g.Float(state.radiusExact).mul((2 * py + 1 - state.height) / span));
		let x = g.Float(0),
			y = g.Float(0),
			dx = g.Float(0),
			dy = g.Float(0);
		for (let i = 0; i < state.deepIterations; i++) {
			const ndx = x.mul(dx).sub(y.mul(dy)).mul(2).add(1);
			const ndy = x.mul(dy).add(y.mul(dx)).mul(2);
			const nx = x.mul(x).sub(y.mul(y)).add(cx);
			y = x.mul(y).mul(2).add(cy);
			x = nx;
			dx = ndx;
			dy = ndy;
			const r = Number(x.toString()),
				im = Number(y.toString()),
				mag = Math.hypot(r, im);
			if (mag > state.escapeRadius) {
				const dr = Number(dx.toString()),
					di = Number(dy.toString());
				let normal = Math.atan2(im * dr - r * di, r * dr + im * di);
				if (normal < 0) normal += 2 * Math.PI;
				return { smooth: i + 1 - Math.log2(Math.log(mag) / Math.log(state.escapeRadius)), normal };
			}
		}
		return { smooth: 0, normal: null };
	} finally {
		g.destroy();
	}
}
