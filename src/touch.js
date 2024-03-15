export default function handleTouch(element, handler, { threshold = 12 } = {}) {
	let latestTouchId = null;
	const prevTouchCoordinates = {};

	function handleTouchStart(e) {
		const latestTouch = e.changedTouches[0];
		latestTouchId = latestTouch?.identifier;
		if (!latestTouch) return;
		prevTouchCoordinates[latestTouchId] = {
			x: latestTouch.clientX,
			y: latestTouch.clientY,
		};
	}

	function handleTouchMove(e) {
		e.preventDefault();

		const touch = Array.from(e.changedTouches).find(touch => touch.identifier === latestTouchId);
		if (!touch) return;

		let { x, y, direction } = prevTouchCoordinates[latestTouchId];

		const diffX = touch.clientX - x;
		const diffY = touch.clientY - y;

		if (!direction && (Math.abs(diffX) > threshold || Math.abs(diffY) > threshold)) {
			direction = Math.abs(diffX) > Math.abs(diffY) ? 'x' : 'y';
			prevTouchCoordinates[latestTouchId].direction = direction;
		}
		if (!direction) return;

		const result = handler(direction, direction === 'x' ? diffX : diffY, e.touches.length - 1, e);
		if (result?.skip) return;

		Object.assign(prevTouchCoordinates[latestTouchId], { x: touch.clientX, y: touch.clientY });
	}

	function handleTouchEnd(e) {
		Array.from(e.changedTouches).forEach(touch => {
			delete prevTouchCoordinates[touch.identifier];
		});
	}

	element.addEventListener('touchstart', handleTouchStart, false);
	element.addEventListener('touchmove', handleTouchMove, { passive: false });
	element.addEventListener('touchend', handleTouchEnd, false);

	return () => {
		element.removeEventListener('touchstart', handleTouchStart, false);
		element.removeEventListener('touchmove', handleTouchMove, { passive: false });
		element.removeEventListener('touchend', handleTouchEnd, false);
	};
}
