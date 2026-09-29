// One replaceable job per lane. Terminating a superseded worker also interrupts
// synchronous WASM loops, which cannot observe queued cancellation messages.
export class LatestWorker {
	constructor(createWorker) {
		this.createWorker = createWorker;
		this.sequence = 0;
		this.worker = null;
		this.pending = null;
	}
	request(type, payload, transfer = [], onProgress) {
		if (this.pending) this.cancel();
		if (!this.worker) this.worker = this.createWorker();
		const worker = this.worker,
			id = ++this.sequence;
		return new Promise((resolve, reject) => {
			this.pending = { id, resolve, reject };
			worker.onmessage = ({ data }) => {
				if (this.worker !== worker || this.pending?.id !== data.id) return;
				if (data.progress) {
					onProgress?.(data.progress);
					return;
				}
				this.pending = null;
				if (data.error) reject(new Error(data.error));
				else resolve(data.result);
			};
			worker.onerror = event => {
				if (this.worker !== worker) return;
				const pending = this.pending;
				this.pending = null;
				worker.terminate();
				this.worker = null;
				pending?.reject(new Error(event.message || 'Reference worker failed'));
			};
			worker.postMessage({ id, type, payload }, transfer);
		});
	}
	cancel() {
		this.worker?.terminate();
		this.worker = null;
		const pending = this.pending;
		this.pending = null;
		pending?.reject(new DOMException('Superseded render job', 'AbortError'));
	}
}
