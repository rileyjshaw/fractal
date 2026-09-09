import { validateStatePatch, reconcileCamera } from './viewState.js';
export function stateFromHash(hash, current, shortKeys, parsers, paletteIds) {
	const patch = {};
	for (const part of hash.replace(/^#/, '').split('_')) {
		const split = part.indexOf('=');
		if (split < 0) continue;
		const short = part.slice(0, split);
		const key = short === 'V' ? 'stripeAverage' : Object.keys(shortKeys).find(key => shortKeys[key] === short);
		if (!key) continue;
		try {
			patch[key] = parsers[key](decodeURIComponent(part.slice(split + 1)));
		} catch {
			/* Ignore a malformed field without discarding the other valid fields. */
		}
	}
	const valid = validateStatePatch(patch, current, paletteIds);
	return { state: reconcileCamera(current, valid), count: Object.keys(valid).length };
}
