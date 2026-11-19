// Entry for the in-page client the Vite plugin serves. The overlay goes in first, then the dock above it.
// Both follow the plugin's state through store.ts and the overlay's picking state through overlay/mode.ts.
import './overlay/overlay.ts'
import './dock/dock.ts'
