import '@testing-library/jest-dom'

class ResizeObserverMock implements ResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

globalThis.ResizeObserver = ResizeObserverMock

if (Element.prototype.getAnimations === undefined) {
	Element.prototype.getAnimations = () => []
}
