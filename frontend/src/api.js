// Falls back to the Vite proxy (/api) for local dev.
// Set VITE_API_URL in .env.production or .env.capacitor for deployed builds.
const API = import.meta.env.VITE_API_URL || '/api'
export default API
