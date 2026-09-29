import { DeepZoomManager } from '../deepZoom.js';
import { repairMetrics } from '../render/metric.js';
const manager = new DeepZoomManager();
self.onmessage = async ({ data: { id, type, payload } }) => {
	try {
		await manager.initialize();
		const started = performance.now();
		let result, transfer;
		if (type === 'reference') {
			await manager.ensureReference(payload);
			result = {
				referenceState: manager.referenceState,
				referenceData: { orbitLength: manager.getReferenceOrbitLength() },
				orbitTextureData: manager.orbitTextureData,
				blaTableData: manager.blaTableData,
				visualPrefixTextureData: manager.visualPrefixTextureData,
			};
			transfer = [result.orbitTextureData, result.blaTableData, result.visualPrefixTextureData]
				.filter(Boolean)
				.map(array => array.buffer);
			result.textureBytes = transfer.reduce((total, buffer) => total + buffer.byteLength, 0);
		} else if (type === 'repairBatch') {
			const { pixels, pixelIndices, width, height, state } = payload;
			let lastUpdate = performance.now();
			const repairedPixels = repairMetrics(
				manager.gmp,
				pixels,
				state,
				width,
				height,
				(_index, repairedPixels) => {
					if (performance.now() - lastUpdate < 100) return;
					self.postMessage({ id, progress: { repairedPixels } });
					lastUpdate = performance.now();
				},
				{ adaptive: true, pixelIndices },
			);
			result = { pixels, pixelIndices, repairedPixels };
			transfer = [pixels.buffer, pixelIndices.buffer];
		} else throw Error(`Unknown worker job ${type}`);
		result.workerDurationMs = performance.now() - started;
		self.postMessage({ id, result }, transfer);
		manager.invalidate();
	} catch (error) {
		self.postMessage({ id, error: error.message });
	}
};
