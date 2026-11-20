import { useState } from 'react'

export function Counter() {
  const [count, setCount] = useState(0)
  return (
    <div className="counter">
      <p>Cups ordered: {count}</p>
      <button type="button" onClick={() => setCount(count + 1)}>
        Order a cup
      </button>
    </div>
  )
}
