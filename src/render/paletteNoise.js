// Stable palette extension: reloads and regression captures must not recolor a
// saved view merely because Math.random() ran again.
export function paletteNoise(paletteId, index, component) {
	let hash = 2166136261;
	for (const char of `${paletteId}:${index}:${component}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	return ((hash >>> 0) / 4294967295) * 0.1 - 0.05;
}
