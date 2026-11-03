import { installReactPerformanceGuard } from './reactPerformanceGuard'

// This side-effect module must be the FIRST import of main.tsx. ES module dependencies are
// evaluated before main's body; installing later would let react-dom capture the unguarded API.
if (import.meta.env.DEV) installReactPerformanceGuard(performance)
