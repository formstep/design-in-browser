// Alternatives as an agent would write them: the original first, then versions with tweaks.
import { Variant, Variants } from 'design-in-browser/react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'

/** A version with its own state, to prove switching versions never throws. */
function Counter() {
  const [clicks, setClicks] = useState(0)
  return (
    <button className="counter" type="button" onClick={() => setClicks((n) => n + 1)}>
      Clicked {clicks}
    </button>
  )
}

function Page() {
  return (
    <main>
      <Variants group="hero">
        <Variant label="Before">
          <section className="hero" data-testid="hero">
            <h1>Simple pricing</h1>
            <p className="lede">One plan for every team.</p>
          </section>
        </Variant>
        <Variant
          label="Tinted card"
          tweaks={{
            padding: { kind: 'range', label: 'Padding', min: 16, max: 96, step: 8, default: 48, unit: 'px' },
            badge: { kind: 'toggle', label: 'New badge', default: true },
            align: { kind: 'choice', label: 'Align', options: ['left', 'center'], default: 'left' },
          }}
        >
          {(t) => (
            <section
              className="hero hero-tinted"
              data-testid="hero"
              style={{ padding: t.padding, textAlign: t.align === 'center' ? 'center' : 'left' }}
            >
              {t.badge && (
                <span className="badge" data-testid="badge">
                  New
                </span>
              )}
              <h1>Pricing that grows with you</h1>
              <Counter />
            </section>
          )}
        </Variant>
        <Variant label="Compact">
          <section className="hero hero-compact" data-testid="hero">
            <h1>Pricing</h1>
          </section>
        </Variant>
      </Variants>
      <div className="plans">
        {['Starter', 'Team'].map((plan) => (
          <article className="plan" key={plan}>
            <h2>{plan}</h2>
            {/* The same group rendered twice: both switch together, with one switcher. */}
            <Variants group="plan-cta">
              <Variant label="Before">
                <button className="cta" type="button">
                  Choose
                </button>
              </Variant>
              <Variant label="Outline">
                <button className="cta cta-outline" type="button">
                  Choose
                </button>
              </Variant>
            </Variants>
          </article>
        ))}
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Page />)
