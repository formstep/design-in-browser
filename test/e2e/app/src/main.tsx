import { useState } from 'react'
import { createRoot } from 'react-dom/client'

function Pricing() {
  const [clicks, setClicks] = useState(0)
  return (
    <main>
      <section className="hero">
        <h1>Simple pricing</h1>
        <p className="lede">One plan for every team.</p>
      </section>
      <div className="plans">
        <article className="plan">
          <h2>Starter</h2>
          <p>$0</p>
          <button className="cta" data-testid="starter-cta" onClick={() => setClicks((n) => n + 1)}>
            Start free
          </button>
        </article>
        <article className="plan">
          <h2>Team</h2>
          <p>$29</p>
          <button className="cta" onClick={() => setClicks((n) => n + 1)}>
            Choose Team
          </button>
        </article>
      </div>
      <p>
        Button clicks: <output id="clicks">{clicks}</output>
      </p>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Pricing />)
