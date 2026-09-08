import { Link } from 'react-router-dom'
import { ART } from '../../assets/art'
import { SITE } from '../../config/site'
import { SettingsButton } from '../settings/SettingsButton'
import './SiteHeader.css'

export const SiteHeader = () => (
  <header className="site-header">
    <Link to="/" className="site-header__brand" aria-label={`${SITE.name} home`}>
      <img src={ART.mascot} alt="" width={44} height={44} />
      <span className="site-header__name">{SITE.name}</span>
      <span className="site-header__tagline">{SITE.tagline}</span>
    </Link>
    <nav className="site-header__nav" aria-label="Main">
      <Link to="/" className="site-header__link">
        Games
      </Link>
      <Link to="/parents" className="site-header__link">
        For grown-ups
      </Link>
      <Link to="/about" className="site-header__link">
        About
      </Link>
      <SettingsButton className="site-header__link" />
    </nav>
  </header>
)

export const SiteFooter = () => (
  <footer className="site-footer">
    <p>
      {SITE.name} is free and open source.{' '}
      <a href={SITE.repo} rel="noreferrer" target="_blank">
        View on GitHub
      </a>
      . Created by {SITE.author}, a parent, in a kid-friendly manner.{' '}
      <Link to="/about">About {SITE.name}</Link>
    </p>
  </footer>
)
