import { ART } from '../assets/art'
import { SiteFooter, SiteHeader } from '../components/layout/SiteHeader'
import { SITE } from '../config/site'
import './ParentsPage.css'

export const AboutPage = () => (
  <div className="parents">
    <SiteHeader />
    <main className="parents__main">
      <img src={ART.mascot} alt="" width={120} height={120} style={{ alignSelf: 'flex-start' }} />
      <h1>About {SITE.name}</h1>
      <p className="parents__lead">
        {SITE.name} was created by <strong>{SITE.author}</strong>, a parent, for his own toddler. It is built in a
        kid-friendly manner from the ground up: no keyboard, no mouse, no wrong answers and nothing to lose.
      </p>

      <section>
        <h2>Why it exists</h2>
        <p>
          Little children end up watching a lot of cartoons. If screen time cannot always be avoided, it can at least be
          active. {SITE.name} turns the screen into something a child moves in front of, waves at, and talks back to,
          so a few minutes in front of a screen become a few minutes of wiggling, naming colours and counting stars.
        </p>
      </section>

      <section>
        <h2>Kid-friendly by design</h2>
        <ul>
          <li>Made for children from about {SITE.minAgeYears} years old, who cannot point precisely yet. Whole-body play means every wiggle counts.</li>
          <li>Scores are shown but never matter. There is no failing, no timer to beat and no game over.</li>
          <li>Every action gets an instant reward: a sound, a sparkle and a friendly voice naming what happened.</li>
          <li>Grown-up controls are hidden behind press-and-hold buttons, so a curious tap never leaves the game.</li>
          <li>Loud, cheerful sound effects (with a limiter) because toddlers love loud.</li>
          <li>Private: the camera is processed on your device and nothing is recorded or uploaded.</li>
        </ul>
      </section>

      <section>
        <h2>Open source</h2>
        <p>
          The whole project is free and open source under the MIT licence. Ideas, bug reports and new games are welcome
          at{' '}
          <a href={SITE.repo} target="_blank" rel="noreferrer">
            github.com/atultiwari/wiggleplay
          </a>
          . Character and fruit artwork was generated with AI and packed into the app; sounds are synthesised in the
          browser.
        </p>
      </section>
    </main>
    <SiteFooter />
  </div>
)
