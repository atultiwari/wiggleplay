export interface HudBadge {
  readonly id: string
  readonly text: string
  readonly accent?: boolean
}

export const Hud = ({ badges }: { readonly badges: readonly HudBadge[] }) => (
  <div className="hud" aria-live="polite">
    {badges.map((badge) => (
      <span key={badge.id} className={`hud__badge ${badge.accent ? 'hud__badge--accent' : ''}`}>
        {badge.text}
      </span>
    ))}
  </div>
)
