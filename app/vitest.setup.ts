// Global Vitest setup. Registers the @testing-library/jest-dom matchers
// (toBeInTheDocument, toHaveTextContent, …) on Vitest's `expect`. This is a
// no-op for the Node-env solver suites — it only augments the matcher set, it
// does not require a DOM — so it is safe to load for every environment.
import '@testing-library/jest-dom/vitest'
