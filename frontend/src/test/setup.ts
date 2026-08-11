import '@testing-library/jest-dom'

class ResizeObserverMock implements ResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

globalThis.ResizeObserver = ResizeObserverMock

class IntersectionObserverMock implements IntersectionObserver {
	readonly root: Element | Document | null = null
	readonly rootMargin: string = '0px'
	readonly thresholds: ReadonlyArray<number> = []
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
	takeRecords(): IntersectionObserverEntry[] {
		return []
	}
}

globalThis.IntersectionObserver = IntersectionObserverMock as unknown as typeof IntersectionObserver

if (Element.prototype.getAnimations === undefined) {
	Element.prototype.getAnimations = () => []
}
