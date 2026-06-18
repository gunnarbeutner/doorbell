import { Component } from './Component.js';
// Fallback for parts with no model (real ICs: ESP32, codec). Rendered red in the UI.
export default class Unmodeled extends Component {
  static kind = 'unknown';
  static compatible() { return false; } // never auto-matches; used as the explicit fallback
  get modeled() { return false; }
}
