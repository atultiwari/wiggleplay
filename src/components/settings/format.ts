export const formatPercent = (value: number): string => `${Math.round(value * 100)}%`
export const formatSeconds = (value: number): string => `${value.toFixed(1)} s`
export const formatTimes = (value: number): string => `×${value.toFixed(1)}`
export const formatCount = (value: number): string => `${Math.round(value)}`
export const formatMinutes = (value: number): string => `${Math.round(value)} min`
export const formatPixels = (value: number): string => `${Math.round(value)} px`
