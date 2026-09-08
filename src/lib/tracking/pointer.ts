import type { Pointer, PointerKind } from '../../types/pointer'

/**
 * Picks the pointer a game should treat as "the" cursor, trying kinds in order.
 * Falls back to the first pointer of any kind.
 */
export const primaryPointer = (
  pointers: readonly Pointer[],
  prefer: readonly PointerKind[],
): Pointer | undefined => {
  for (const kind of prefer) {
    const match = pointers.find((p) => p.kind === kind)
    if (match) return match
  }
  return pointers[0]
}

/** Every touchable point across all pointers. */
export const allTouchPoints = (pointers: readonly Pointer[]) => pointers.flatMap((p) => p.points)
