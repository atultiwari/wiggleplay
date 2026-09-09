import { SiteFooter, SiteHeader } from '../components/layout/SiteHeader'
import { CATEGORIES } from '../config/games'
import { SESSION, SITE } from '../config/site'
import './ParentsPage.css'

/** Rolling release kept current by scripts/publish-android.sh. */
const ANDROID_APK_URL = `${SITE.repo}/releases/download/android-latest/WigglePlay-Android.apk`

export const ParentsPage = () => (
  <div className="parents">
    <SiteHeader />
    <main className="parents__main">
      <h1>For grown-ups</h1>
      <p className="parents__lead">
        {SITE.name} is a free collection of learning games for children from about {SITE.minAgeYears} years old.
        If screen time cannot always be avoided, it can at least be active, playful and educational.
      </p>

      <section>
        <h2>How the camera games work</h2>
        <ul>
          <li>The camera runs entirely inside the browser on your device. No video or images are ever uploaded.</li>
          <li>Body and hand tracking use on-device models (MediaPipe). Once loaded, the games work offline.</li>
          <li>Nothing is recorded. Closing the tab stops the camera immediately.</li>
        </ul>
      </section>

      <section>
        <h2>Choosing how your child plays</h2>
        <p>
          Open ⚙️ Settings (or pick on a game's start screen) and choose an interaction mode. It applies to every game.
        </p>
        <ul>
          <li><strong>🧍 Whole body</strong> (default): hands, head, feet and tummy all count. Best for the youngest, who cannot point yet. Stand about two metres back so the camera sees the whole child.</li>
          <li><strong>🖐️ Wave a hand</strong>: any hand movement works, no pointing needed. Good at a table.</li>
          <li><strong>☝️ Point a finger</strong>: precise fingertip control for older children.</li>
          <li><strong>🙂 Head only</strong>: move the head to play. Handy when sitting or for limited mobility.</li>
        </ul>
      </section>

      <section>
        <h2>Set-up tips</h2>
        <ul>
          <li>Put the tablet or laptop at your child's chest height, about one to two metres away (further for whole-body play).</li>
          <li>Good light on your child, not behind them. A window behind the child confuses the camera.</li>
          <li>Show them once: hold a hand up, wave, and let them copy you. Then let them lead.</li>
          <li>Chrome, Edge or Safari on a recent device works best. Older phones may feel slow.</li>
        </ul>
      </section>

      <section>
        <h2>Designed for tiny hands</h2>
        <ul>
          <li>No wrong answers, no losing, no timers the child can see. Every action is rewarded.</li>
          <li>Buttons that leave a game must be pressed and held, so a curious tap does nothing.</li>
          <li>After about {SESSION.suggestedMinutes} minutes a friendly "bye bye" screen appears to make stopping easy.</li>
          <li>Every game speaks the names of colours, numbers or fruits so play doubles as vocabulary time.</li>
        </ul>
      </section>

      <section>
        <h2>Install the app (plays offline)</h2>
        <p>
          The website always has the newest games. For a phone, tablet or laptop that will be used without Wi-Fi, install the app once:
          everything is inside it, and new games arrive later through Settings → Updates.
        </p>
        <ul>
          <li>
            <strong>📱 Android:</strong>{' '}
            <a href={ANDROID_APK_URL} download>
              download the APK
            </a>{' '}
            on the device, open it, and allow the browser to install it when Android asks (Android 7 or newer).
          </li>
          <li>
            <strong>💻 Windows and macOS:</strong>{' '}
            <a href={`${SITE.repo}/releases`} target="_blank" rel="noreferrer">
              installers on the releases page
            </a>
            .
          </li>
        </ul>
      </section>

      <section>
        <h2>What is coming</h2>
        <ul>
          {Object.values(CATEGORIES).map((category) => (
            <li key={category.label}>
              <strong>
                {category.emoji} {category.label}:
              </strong>{' '}
              {category.blurb}
            </li>
          ))}
        </ul>
        <p>
          The full idea list and roadmap live in the{' '}
          <a href={`${SITE.repo}/blob/main/docs/IDEAS.md`} target="_blank" rel="noreferrer">
            project repository
          </a>
          .
        </p>
      </section>
    </main>
    <SiteFooter />
  </div>
)
